// ─────────────────────────────────────────────────────────────────────────────
// Codex on Cloudflare — jode remote environment (rehost path; see plan 04).
//
// Serves the REAL Codex webview SPA to the browser, injects the bridge-client +
// real preload, and bridges the renderer's IPC back to the headless Codex main
// process running in the container (bridge.cjs on :8787 over /bridge WS).
//
//   • EVERY request   → Cloudflare Access JWT verified (@jode/auth), incl. WS upgrade
//   • /bridge (WS), /healthz        → container bridge server (DO)
//   • /__bridge/bridge-client.js    → injected browser bridge client
//   • /__bridge/preload.js          → the REAL Codex preload (run under the shim)
//   • /__bridge/boot                → container /boot (sendSync snapshot)
//   • /assets/*, *.js/css/wasm/...  → webview static assets (ASSETS)
//   • everything else (navigation)  → injected index.html
//
// Unlike @jode/claude-code there is no forced upstream tunnel: the CSP is stripped
// at gen-assets time, so the browser reaches OpenAI's backend (chatgpt.com/
// api.openai.com) directly. Add a tunnel later only if CORS/clearance requires it.
// ─────────────────────────────────────────────────────────────────────────────
import { Container } from "@cloudflare/containers";
import { verifyAccessJwt, extractAccessToken, AuthError } from "@jode/auth";
import { INDEX_HTML, BRIDGE_CLIENT_JS, PRELOAD_JS } from "./generated-assets";

const BRIDGE_PORT = 8787;
const STATIC_PREFIXES = ["/assets/", "/static/", "/fonts/", "/images/", "/favicon", "/manifest"];

type Env = {
  ASSETS: Fetcher;
  CODEX_BRIDGE: DurableObjectNamespace;
  WORKSPACE: R2Bucket;
  // ── Cloudflare Access gate (verified by @jode/auth) ──
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  /** Local-dev only: "true" in .dev.vars to skip Access. NEVER in wrangler.toml. */
  ACCESS_DEV_BYPASS?: string;
  // ── Shared filesystem + model config (injected into the container via envVars) ──
  /** S3 creds for the SHARED jode filesystem (one R2 bucket FUSE-mounted at
   *  /workspace by every tool — claude-code, opencode, codex). Secrets. */
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET: string;
  OPENAI_API_KEY?: string;
};

export class CodexBridgeContainer extends Container {
  defaultPort = BRIDGE_PORT;
  requiredPorts = [BRIDGE_PORT];
  // Always-on for predictable latency (single user). Revisit sleep/wake later.
  override async fetch(request: Request): Promise<Response> {
    const env = this.env as Env;
    // Inject secrets/config into the container BEFORE start (Worker secrets only,
    // never baked into the image). No-op once running.
    this.envVars = {
      ...this.envVars,
      CODEX_BOOT_MODE: "bridge",
      R2_ENDPOINT: env.R2_ENDPOINT ?? "",
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      R2_BUCKET: env.R2_BUCKET ?? "",
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    };
    await this.startAndWaitForPorts();
    const url = new URL(request.url);
    // Shared-filesystem diagnostics live on the health server (:8080).
    if (url.pathname === "/mount-status") {
      return this.containerFetch(request, 8080);
    }
    // No bridge key: the DO binding is private and Access-gated upstream, so the
    // bridge accepts the WS/diagnostics directly (matches @jode/claude-code).
    return this.containerFetch(request, BRIDGE_PORT);
  }
}

async function enforceAccess(request: Request, env: Env): Promise<Response | null> {
  if (env.ACCESS_DEV_BYPASS === "true") return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    return new Response("Access not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAIL)", { status: 503 });
  }
  const token = extractAccessToken(request);
  if (!token) return new Response("unauthorized: no Cloudflare Access token", { status: 401 });
  try {
    await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, allowedEmail: env.ALLOWED_EMAIL });
    return null;
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    console.log(`[access] rejected: ${(e as Error).message}`);
    return new Response("forbidden", { status });
  }
}

function bridgeStub(env: Env) {
  const id = env.CODEX_BRIDGE.idFromName("default");
  return env.CODEX_BRIDGE.get(id);
}
function js(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}
function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await enforceAccess(request, env);
    if (denied) return denied;

    const url = new URL(request.url);

    // 1. bridge transport + health → container
    if (url.pathname === "/bridge" || url.pathname === "/healthz") {
      return bridgeStub(env).fetch(request);
    }
    // 2. generated bridge assets
    if (url.pathname === "/__bridge/bridge-client.js") return js(BRIDGE_CLIENT_JS);
    if (url.pathname === "/__bridge/preload.js") return js(PRELOAD_JS);
    if (url.pathname === "/__bridge/boot") {
      const u = new URL(request.url); u.pathname = "/boot"; u.search = "";
      return bridgeStub(env).fetch(new Request(u.toString(), request));
    }
    if (url.pathname === "/__bridge/debug-rpc") {
      const u = new URL(request.url); u.pathname = "/debug-rpc";
      return bridgeStub(env).fetch(new Request(u.toString(), request));
    }
    // Shared-filesystem mount diagnostics (Access-gated like everything else).
    if (url.pathname === "/__bridge/mount-status") {
      const u = new URL(request.url); u.pathname = "/mount-status";
      return bridgeStub(env).fetch(new Request(u.toString(), request));
    }

    // 3. static webview assets → ASSETS (hashed bundle: /assets/*, fonts, wasm, …)
    if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p)) || /\.[a-z0-9]+$/i.test(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // 4. SPA navigation → injected index.html (real webview + bridge-client + preload)
    return html(INDEX_HTML);
  },
} satisfies ExportedHandler<Env>;
