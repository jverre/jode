// ─────────────────────────────────────────────────────────────────────────────
// Claude Desktop UI/Server split — Cloudflare Worker (parallel deployment).
//
// Serves the REAL renderer SPA in the browser, injects the bridge-client, and:
//   • /bridge   (WebSocket) → container bridge server (bridge.cjs on :8787)
//   • /healthz             → container health
//   • /__bridge/*          → generated bridge-client.js + real mainView.js
//   • /api,/v1,/edge-api,/cdn-cgi, non-GET → reverse-proxy to claude.ai (auth)
//   • everything else      → SPA assets / injected index.html
//
// Leaves the existing KasmVNC worker untouched (separate name/binding).
// ─────────────────────────────────────────────────────────────────────────────
import { Container } from "@cloudflare/containers";
import {
  durableObjectStub,
  enforceAccess,
  htmlResponse,
  jsResponse,
  sharedWorkspaceEnv,
  type AccessEnv,
  type WorkspaceMountEnv,
} from "@jode/edge";
import { INDEX_HTML, BRIDGE_CLIENT_JS, MAINVIEW_JS } from "./generated-assets";

const UPSTREAM_ORIGIN = "https://claude.ai";
const BRIDGE_PORT = 8787;
const PROXY_PATH_PREFIXES = ["/api/", "/edge-api/", "/cdn-cgi/", "/v1/", "/ent_api/", "/account_api/"];
const LOCAL_ASSET_PREFIXES = ["/assets/", "/audio/", "/favicon.ico", "/i18n/", "/images/", "/manifest.json", "/robots.txt"];

// Persisted-auth capture cadence: the DO snapshots the bridge's filtered durable
// cookies (sessionKey + lastActiveOrg) to its own storage at most this often, so
// a still-valid login survives the next container recycle without re-login.
const CAPTURE_INTERVAL_MS = 60_000;

type Env = AccessEnv & WorkspaceMountEnv & {
  ASSETS: Fetcher;
  CLAUDE_BRIDGE: DurableObjectNamespace;
};

export class ClaudeBridgeContainer extends Container {
  defaultPort = BRIDGE_PORT;
  requiredPorts = [BRIDGE_PORT];
  private restored = false;
  private lastCaptureAt = 0;

  override async fetch(request: Request): Promise<Response> {
    // Inject the shared-filesystem mount creds into the container BEFORE it
    // starts (set before startAndWaitForPorts — a no-op once running). There is
    // no bridge key: the bridge is reachable only via this Worker's private DO
    // binding, and the Worker verifies Cloudflare Access on every request first.
    const env = this.env as Env;
    this.envVars = {
      ...this.envVars,
      ...sharedWorkspaceEnv(env),
    };

    await this.startAndWaitForPorts();
    // Auth persistence: re-inject the durable login cookies once on a fresh
    // container, then periodically re-snapshot them. Only sessionKey + the org
    // hint are stored — the bridge's /auth-cookies endpoint filters out the
    // IP-bound cf_clearance/Turnstile cookies whose stale re-injection previously
    // crash-looped boot. cf_clearance re-mints per IP on first load (like a
    // browser), so the restored login authenticates without the stale clearance.
    await this.restoreCookiesOnce();
    await this.maybeCaptureCookies();
    return this.containerFetch(request, BRIDGE_PORT);
  }

  /** Re-inject persisted durable login cookies on the first request after a
   *  fresh container start. Best-effort: a missing store or bridge error must
   *  never block serving. */
  private async restoreCookiesOnce(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    try {
      const cookies = (await this.ctx.storage.get("authCookies")) as unknown[] | undefined;
      if (!cookies || !cookies.length) { console.log("[auth-cache] no persisted cookies to restore"); return; }
      const resp = await this.containerFetch(
        new Request("http://bridge/restore-cookies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cookies }),
        }),
        BRIDGE_PORT,
      );
      console.log(`[auth-cache] restore-cookies → ${resp.status}`);
    } catch (e) { console.log(`[auth-cache] restore failed: ${(e as Error).message}`); }
  }

  /** Snapshot the bridge's filtered durable cookies to DO storage, throttled to
   *  CAPTURE_INTERVAL_MS. Container alarms are owned by the base class, so we
   *  capture opportunistically on the request path instead of via setAlarm().
   *  Only overwrites when authed, so a logged-out blip never clobbers a good
   *  snapshot. */
  private async maybeCaptureCookies(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCaptureAt < CAPTURE_INTERVAL_MS) return;
    this.lastCaptureAt = now; // set before await so concurrent requests don't pile up
    try {
      const resp = await this.containerFetch(new Request("http://bridge/auth-cookies"), BRIDGE_PORT);
      if (!resp.ok) return;
      const j = (await resp.json()) as { authed?: boolean; cookies?: unknown[] };
      if (j.authed && j.cookies && j.cookies.length) {
        await this.ctx.storage.put("authCookies", j.cookies);
        console.log(`[auth-cache] captured ${j.cookies.length} durable cookie(s)`);
      }
    } catch (e) { console.log(`[auth-cache] capture failed: ${(e as Error).message}`); }
  }
}

function bridgeStub(env: Env) {
  // Single DO/container (max_instances=1) so WS, HTTP, and diagnostics are always
  // the same instance. The DO is a plain proxy: no auth-cookie persistence (the
  // earlier cache held stale cookies and the onStart restore crash-looped the
  // container — both removed). Bumping this name forces a fresh container/storage;
  // only do that to recover a wedged instance, not as routine iteration.
  return durableObjectStub(env.CLAUDE_BRIDGE, "primary-weur-keyless1", { locationHint: "weur" });
}

// Auth model A: cache the container's claude.ai cookies (incl. cf_clearance +
// session) and attach them to proxied /api/* requests, so the browser inherits
// the container's Turnstile-cleared, authenticated session.
let cookieCache: { header: string; authed: boolean; at: number } | null = null;
async function getContainerCookies(env: Env): Promise<{ header: string; authed: boolean }> {
  const now = Date.now();
  if (cookieCache && now - cookieCache.at < 15000) return cookieCache;
  try {
    const resp = await bridgeStub(env).fetch("https://bridge.internal/session");
    if (resp.ok) {
      const j = (await resp.json()) as { cookieHeader?: string; authed?: boolean };
      cookieCache = { header: j.cookieHeader || "", authed: !!j.authed, at: now };
      return cookieCache;
    }
  } catch (e) { /* fall through */ }
  cookieCache = { header: cookieCache?.header || "", authed: false, at: now };
  return cookieCache;
}
// Stabilize idempotent auth GETs. The renderer's concurrent fetches to these
// endpoints intermittently get a Cloudflare bot-challenge 403 (slow text/html),
// even though the same session returns 200 milliseconds earlier. Each transient
// 403 flips the renderer's account/org state to "logged out"/undefined, causing a
// re-render storm (setAccountDetails undef↔real) that aborts an in-flight chat
// completion before it issues. We cache the last successful 200 per path and serve
// it when the tunnel returns a non-200/empty, so the renderer sees a stable
// authenticated bootstrap and the completion can fire.
const STABILIZE_GET = (p: string): boolean =>
  p === "/edge-api/bootstrap" || p === "/api/bootstrap" ||
  p === "/api/account_profile" || p === "/api/organizations" || p === "/api/account";
const lastGood = new Map<string, { status: number; headers: Record<string, string>; bodyB64: string; at: number }>();
const LAST_GOOD_TTL = 300000; // 5 min — long enough to ride out challenge bursts

function mergeCookies(browser: string | null, container: string): string {
  // container cookies take precedence (cf_clearance/session); keep browser extras
  const out = new Map<string, string>();
  for (const part of (browser || "").split(/;\s*/)) { const i = part.indexOf("="); if (i > 0) out.set(part.slice(0, i), part.slice(i + 1)); }
  for (const part of container.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0) out.set(part.slice(0, i), part.slice(i + 1)); }
  return Array.from(out, ([k, v]) => `${k}=${v}`).join("; ");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 0. AUTH GATE — verify Cloudflare Access identity before ANY routing,
    //    including the /bridge WS upgrade. Nothing below runs for an
    //    unauthenticated or non-allowlisted caller.
    const denied = await enforceAccess(request, env);
    if (denied) return denied;

    const url = canonicalizeChallengeRedirectUrl(new URL(request.url));

    // 1. bridge transport + health → container
    if (url.pathname === "/bridge" || url.pathname === "/healthz") {
      return bridgeStub(env).fetch(request);
    }

    // 2. generated bridge assets
    if (url.pathname === "/__bridge/bridge-client.js") return jsResponse(BRIDGE_CLIENT_JS);
    if (url.pathname === "/__bridge/mainView.js") return jsResponse(MAINVIEW_JS);
    // boot args (real --desktop-* the main passed to the SPA view) from container
    if (url.pathname === "/__bridge/boot") {
      const u = new URL(request.url); u.pathname = "/boot"; u.search = "";
      return bridgeStub(env).fetch(new Request(u.toString(), request));
    }
    // Diagnostics: gated by the Access check above (single allowlisted identity).
    // Maps /__bridge/debug-* → /debug-* on the bridge (reachable only via this
    // Access-gated Worker over the private DO binding).
    {
      const debugMap: Record<string, string> = {
        "/__bridge/debug-rpc": "/debug-rpc",
        "/__bridge/debug-pty": "/debug-pty",
        "/__bridge/debug-session": "/debug-session",
      };
      const target = debugMap[url.pathname];
      if (target) {
        const u = new URL(request.url); u.pathname = target;
        return bridgeStub(env).fetch(new Request(u.toString(), request));
      }
    }

    // 3. challenge-redirect normalization (reused from static worker)
    const cr = maybeHandleChallengeRedirect(request, url);
    if (cr) return cr;

    // 4. some /api/* paths are actually local renderer assets (alias)
    const aliasPath = getLocalAssetAliasPath(url.pathname);
    if (aliasPath) return env.ASSETS.fetch(rewriteAssetRequest(request, url, aliasPath));

    // 5. real API + all non-GET → tunnel through the container's claude.ai
    //    renderer (auth model A): the upstream fetch runs in the Turnstile-cleared,
    //    authenticated session. cf_clearance is IP/UA-bound so a worker-side fetch
    //    can't reuse it — tunneling is the robust path.
    if (shouldProxy(url.pathname, request.method)) {
      return tunnelThroughContainer(request, url, env);
    }

    // 6. static assets (js/css/img/font) → ASSETS
    if (LOCAL_ASSET_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p)) || /\.[a-z0-9]+$/i.test(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // 7. SPA navigation → our injected index.html (real renderer + bridge-client)
    return htmlResponse(INDEX_HTML);
  },
};

// Tunnel an /api/* request through the container's claude.ai renderer.
async function tunnelThroughContainer(request: Request, url: URL, env: Env): Promise<Response> {
  // Forward the app's own request headers. The real desktop completion sends
  // anthropic-device-id / anthropic-client-sha / x-activity-session-id etc. — drop
  // none of the anthropic-*/x-* set (only host/cookie/origin are managed by the
  // renderer fetch). Captured from the real Mac app: completion auth is cookie-only
  // (no Authorization/csrf), so forwarding these app headers is what it needs.
  const fwdHeaders: Record<string, string> = {};
  const fwdExact = new Set(["accept", "content-type", "x-csrf-token", "x-activity-session-id", "x-stainless-os"]);
  request.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk.startsWith("anthropic-") || fwdExact.has(lk)) fwdHeaders[k] = v;
  });
  let bodyB64: string | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = new Uint8Array(await request.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    bodyB64 = btoa(s);
  }
  const spec = { method: request.method, path: url.pathname + url.search, headers: fwdHeaders, bodyB64 };
  const isCompletion = /\/completion(2)?($|\?)|retry_completion/.test(url.pathname);
  if (isCompletion) console.log(`[tunnel] COMPLETION req ${request.method} ${url.pathname} accept=${request.headers.get("accept")} bodyLen=${bodyB64?.length || 0} hdrs=${Object.keys(fwdHeaders).join(",")}`);

  // NOTE: SSE (chat completions) goes through the SAME buffered /proxy path, which
  // runs the fetch in the REAL renderer (passes Cloudflare; a Node-side fetch is
  // 403'd because cf_clearance is bound to the browser's TLS fingerprint). The
  // renderer buffers the full SSE and we relay it with content-type preserved, so
  // fetch-event-source parses it (non-incremental, but functional). Incremental
  // streaming would require the renderer to relay chunks (future work).
  let r: Response;
  try {
    r = await bridgeStub(env).fetch("https://bridge.internal/proxy", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "bridge unreachable", detail: String(e) }), { status: 502, headers: { "content-type": "application/json" } });
  }
  if (!r.ok) { if (isCompletion) console.log(`[tunnel] COMPLETION proxy-http FAILED status=${r.status}`); return new Response(JSON.stringify({ error: "tunnel failed", status: r.status }), { status: 502, headers: { "content-type": "application/json" } }); }
  let j = (await r.json()) as { status?: number; headers?: Record<string, string>; bodyB64?: string; url?: string; error?: string };
  if (isCompletion) console.log(`[tunnel] COMPLETION result upstreamStatus=${j.status} ct=${(j.headers||{})["content-type"]||(j.headers||{})["Content-Type"]} bodyLen=${(j.bodyB64||"").length} err=${j.error||"none"}`);

  // Stabilize idempotent auth GETs against transient Cloudflare-challenge 403s.
  if (request.method === "GET" && STABILIZE_GET(url.pathname)) {
    const ok200 = j.status === 200 && !j.error && (j.bodyB64 || "").length > 0;
    if (ok200) {
      lastGood.set(url.pathname, { status: 200, headers: j.headers || {}, bodyB64: j.bodyB64 || "", at: Date.now() });
    } else {
      const cached = lastGood.get(url.pathname);
      if (cached && Date.now() - cached.at < LAST_GOOD_TTL) {
        console.log(`[stabilize] serving last-good ${url.pathname} (upstream status=${j.status} err=${j.error || "none"}, cached ${Date.now() - cached.at}ms ago)`);
        j = { status: cached.status, headers: cached.headers, bodyB64: cached.bodyB64 };
      }
    }
  }

  if (j.error || typeof j.status !== "number") return new Response(JSON.stringify({ error: j.error || "tunnel error" }), { status: 502, headers: { "content-type": "application/json" } });
  const bin = atob(j.bodyB64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const headers = new Headers();
  const src = j.headers || {};
  for (const k of Object.keys(src)) {
    const lk = k.toLowerCase();
    if (["content-encoding", "content-length", "transfer-encoding", "connection", "content-security-policy", "x-frame-options"].includes(lk)) continue;
    if (lk === "location") { headers.set("location", rewriteLocationHeader(src[k], url)); continue; }
    headers.set(k, src[k]);
  }
  return new Response(bytes, { status: j.status, headers });
}

// ── reused claude.ai proxy helpers (faithful to cloudflare-static) ───────────
function shouldProxy(pathname: string, method: string): boolean {
  if (PROXY_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (method !== "GET" && method !== "HEAD") return true;
  return false;
}
async function proxyToClaude(request: Request, incomingUrl: URL, containerCookies?: string): Promise<Response> {
  const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, UPSTREAM_ORIGIN);
  const init: RequestInit = {
    method: request.method,
    headers: rewriteRequestHeaders(request.headers, containerCookies),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  };
  const upstream = await fetch(upstreamUrl.toString(), init);
  return rewriteResponse(upstream, incomingUrl);
}
function rewriteRequestHeaders(source: Headers, containerCookies?: string): Headers {
  const headers = new Headers(source);
  const u = new URL(UPSTREAM_ORIGIN);
  headers.set("origin", u.origin);
  headers.set("referer", u.origin + "/");
  headers.set("host", u.host);
  if (containerCookies) headers.set("cookie", mergeCookies(headers.get("cookie"), containerCookies));
  return headers;
}
async function rewriteResponse(response: Response, incomingUrl: URL): Promise<Response> {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) headers.set("location", rewriteLocationHeader(location, incomingUrl));
  rewriteSetCookieHeaders(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function rewriteLocationHeader(location: string, incomingUrl: URL): string {
  try {
    const resolved = new URL(location, UPSTREAM_ORIGIN);
    if (resolved.origin === UPSTREAM_ORIGIN) {
      resolved.protocol = incomingUrl.protocol; resolved.host = incomingUrl.host;
      return canonicalizeChallengeRedirectUrl(resolved).toString();
    }
    if (resolved.origin === incomingUrl.origin && resolved.pathname === "/api/challenge_redirect") {
      return canonicalizeChallengeRedirectUrl(resolved).toString();
    }
  } catch { return location; }
  return location;
}
function rewriteSetCookieHeaders(headers: Headers): void {
  const values = getSetCookieValues(headers);
  if (!values.length) return;
  headers.delete("set-cookie");
  for (const c of values) headers.append("set-cookie", rewriteCookie(c));
}
function getSetCookieValues(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}
function rewriteCookie(cookie: string): string {
  return cookie.replace(/;\s*Domain=[^;]+/gi, "").replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
}
function getLocalAssetAliasPath(pathname: string): string | null {
  for (const base of ["/api"]) {
    if (!pathname.startsWith(`${base}/`) && pathname !== base) continue;
    const candidate = pathname.slice(base.length) || "/";
    if (LOCAL_ASSET_PREFIXES.some((p) => candidate === p || candidate.startsWith(p))) return candidate;
  }
  return null;
}
function rewriteAssetRequest(request: Request, incomingUrl: URL, assetPath: string): Request {
  const assetUrl = new URL(incomingUrl.toString());
  assetUrl.pathname = assetPath;
  return new Request(assetUrl.toString(), request);
}
function canonicalizeChallengeRedirectUrl(url: URL): URL {
  if (url.pathname !== "/api/challenge_redirect") return url;
  const target = url.searchParams.get("to");
  if (!target) return url;
  const normalized = unwrapChallengeRedirectTarget(target, url.origin);
  if (!normalized || normalized === target) return url;
  const next = new URL(url.toString());
  next.searchParams.set("to", normalized);
  return next;
}
function maybeHandleChallengeRedirect(request: Request, url: URL): Response | null {
  if (url.pathname !== "/api/challenge_redirect") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const target = url.searchParams.get("to");
  if (!target) return null;
  try {
    const unwrapped = unwrapChallengeRedirectTarget(target, url.origin) ?? target;
    const resolved = new URL(unwrapped, url.origin);
    if (resolved.origin === UPSTREAM_ORIGIN) { resolved.protocol = url.protocol; resolved.host = url.host; return Response.redirect(resolved.toString(), 302); }
    if (resolved.origin === url.origin) return Response.redirect(resolved.toString(), 302);
  } catch { return null; }
  return null;
}
function unwrapChallengeRedirectTarget(target: string, origin: string): string | null {
  let current = target;
  for (let i = 0; i < 10; i += 1) {
    let resolved: URL;
    try { resolved = new URL(current, origin); } catch { return null; }
    if (resolved.pathname !== "/api/challenge_redirect") return resolved.toString();
    const next = resolved.searchParams.get("to");
    if (!next) return resolved.toString();
    current = next;
  }
  return current;
}
