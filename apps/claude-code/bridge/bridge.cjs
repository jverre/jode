// ─────────────────────────────────────────────────────────────────────────────
// Claude Desktop UI/Server split — BRIDGE SERVER (container side)
//
// Runs the REAL Electron main bundle headless, captures the per-webContents
// scoped eipc handlers of the main SPA view, and exposes them over a WebSocket
// RPC transport to the browser-served renderer. See ../ARCHITECTURE.md.
//
// Transport (JSON frames):
//   client→server: {id, t:"invoke",    channel, args}
//                  {id, t:"sendSync",  channel, args}     (server runs the `on`
//                                                          handler, returns
//                                                          captured returnValue)
//                  {   t:"subscribe"}  / {t:"unsubscribe"} (push opt-in; default on)
//                  {   t:"ping"}
//   server→client: {id, t:"result",  ok, value}  | {id, t:"result", ok:false, error}
//                  {   t:"push",      channel, args}        (main→renderer .send)
//                  {   t:"ready",     channels:[...], token-ok}
//                  {   t:"pong"}
//
// Security: this server is reachable ONLY through the Worker's private DO
// binding, and the Worker verifies Cloudflare Access on every request before
// relaying — so there is no separate bridge key (it was redundant defense-in-
// depth, not user auth, and just a failure mode; removed).
// Observability: every boundary logs with a [bridge:*] tag.
// ─────────────────────────────────────────────────────────────────────────────
const path = require("node:path");
const http = require("node:http");
const electron = require("electron");

const REHOST = process.env.REHOST_ROOT
  ? path.resolve(process.env.REHOST_ROOT)
  : path.resolve(__dirname, "..", "..", "linux-rehost");
const WS = require(path.join(REHOST, "app", "node_modules", "ws"));

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_CALL_TIMEOUT_MS || 15000);
const APP_HOST = process.env.BRIDGE_APP_HOST || "claude.ai"; // origin used to id the main view
const SENDER_URL = process.env.BRIDGE_SENDER_URL || "https://claude.ai/";

const t0 = Date.now();
const ms = () => Date.now() - t0;
const log = (...a) => console.log(`[bridge ${ms()}ms]`, ...a);

// ── handler capture ─────────────────────────────────────────────────────────
const wcState = new Map(); // wcId -> { handle:Map, on:Map, wc }
let mainViewId = null;
let bootArgv = null; // the main view's additionalArguments (--desktop-features=…)
let syncSnapshot = {}; // logical sendSync channel -> {error,result} envelope (replayed by the browser)

// the 15 synchronous channels (sendSync) — preload reads {error,result} from them
function isSyncChannel(logical) {
  return /\.\$store\$\.getStateSync$/.test(logical) ||
    /\.(getInitialLocale|isHostLoopModeEnabled|isHostLoopDevOverrideActive|isAvailable)$/.test(logical);
}
const clients = new Set(); // ws connections (for push fan-out)
// GLOBAL ipcMain handlers (the ~13 legacy non-eipc channels like
// list-mcp-servers, connect-to-mcp-server, cu-teach:*) register on the global
// electron.ipcMain — NOT on a webContents — so capture them too when a channel
// isn't in the main view's scoped registry.
const globalHandlers = { handle: new Map(), on: new Map() };
(function patchGlobalIpcMain() {
  const ipc = electron.ipcMain;
  for (const m of ["handle", "handleOnce"]) {
    const o = ipc[m].bind(ipc);
    ipc[m] = (c, f) => { if (typeof c === "string") globalHandlers.handle.set(c, f); try { return o(c, f); } catch {} };
  }
  for (const m of ["on", "once"]) {
    const o = ipc[m].bind(ipc);
    ipc[m] = (c, f) => { if (typeof c === "string") globalHandlers.on.set(c, f); try { return o(c, f); } catch { return ipc; } };
  }
})();

// Web-equivalents for native dialogs (the goal: "web equivalents for … dialogs").
// Native dialog.showOpenDialog/etc. block forever headless → the real handlers
// (browseFolder, etc.) that call them hang. Patch electron.dialog to resolve
// immediately so the REAL handler logic still runs and returns a usable result.
const WORKSPACE = process.env.BRIDGE_WORKSPACE || "/workspace";
try { require("node:fs").mkdirSync(WORKSPACE, { recursive: true }); } catch {}
(function patchDialogs() {
  const d = electron.dialog;
  if (!d) return;
  d.showOpenDialog = async () => ({ canceled: false, filePaths: [WORKSPACE] });
  d.showOpenDialogSync = () => [WORKSPACE];
  d.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  d.showSaveDialogSync = () => undefined;
  d.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  d.showMessageBoxSync = () => 0;
  d.showErrorBox = () => {};
  log(`patched electron.dialog → web-equivalent (workspace=${WORKSPACE})`);
})();

function logicalOf(c) {
  return String(c)
    .replace(/^\$eipc_message\$_[0-9a-f-]+_\$_/, "")
    .replace(/_\$store\$_/g, ".$store$.")
    .replace(/_\$_/g, ".");
}

// ── RPC debug ring buffer ("debug once and for all") ────────────────────────
// Records the last N RPCs with DECODED args + result/error, exposed at
// GET /debug-rpc so failures (esp. arg-validation) are inspectable on
// demand. Also logged to stdout (visible via `wrangler tail`).
const recentRpc = [];
function preview(v) {
  try { const s = JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + "…" : s; }
  catch { return "[unserializable]"; }
}
function recordRpc(msg, ok, value, error, ms) {
  try {
    recentRpc.push({
      at: ms_(), t: msg.t, channel: logicalOf(msg.channel),
      args: (msg.args || []).map((a) => preview(decodeUndef(a))),
      // RAW (pre-decode) args + their JS types — reveals whether the client sent the
      // undefined-sentinel, a literal null (encode didn't run), or a real value.
      argsRaw: (msg.args || []).map((a) => preview(a)),
      argTypes: (msg.args || []).map((a) => (a === null ? "null" : Array.isArray(a) ? "array" : typeof a)),
      ok, ms, error: error || undefined,
      result: ok ? preview(value) : undefined,
    });
    if (recentRpc.length > 80) recentRpc.shift();
    if (!ok) console.log(`[bridge RPC-ERR] ${logicalOf(msg.channel)} args=${preview((msg.args || []).map((a) => decodeUndef(a)))} -> ${error}`);
  } catch {}
}

electron.app.on("web-contents-created", (_e, wc) => {
  const id = wc.id;
  const st = { handle: new Map(), on: new Map(), wc };
  wcState.set(id, st);
  const scoped = wc.ipc;
  if (scoped && typeof scoped.handle === "function") {
    for (const m of ["handle", "handleOnce"]) {
      const o = scoped[m].bind(scoped);
      scoped[m] = (c, f) => { if (typeof c === "string") st.handle.set(c, f); try { return o(c, f); } catch {} };
    }
    for (const m of ["on", "once"]) {
      const o = scoped[m].bind(scoped);
      scoped[m] = (c, f) => { if (typeof c === "string") st.on.set(c, f); try { return o(c, f); } catch { return scoped; } };
    }
  }
  // Intercept main→renderer pushes (webContents.send) for the main view.
  const origSend = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    if (id === mainViewId && typeof channel === "string") fanoutPush(channel, args);
    try { return origSend(channel, ...args); } catch {}
  };

  // Reconstruct the real --desktop-* args by reading the globals the REAL preload
  // exposed into this view's renderer (desktopBootFeatures/EnterpriseConfig/
  // TelemetryConfig/NestLocalUsername). getLastWebPreferences() omits
  // additionalArguments, so we read the exposed values directly.
  const captureBootArgv = async (attempt) => {
    try {
      const json = await wc.executeJavaScript(
        "JSON.stringify({f:(typeof desktopBootFeatures!=='undefined'?desktopBootFeatures:(window.desktopBootFeatures??null)),e:(window.desktopEnterpriseConfig??null),t:(window.desktopTelemetryConfig??null),u:(window.desktopNestLocalUsername??null)})",
        true,
      );
      const o = JSON.parse(json || "{}");
      const args = ["claude"];
      if (o.f) args.push("--desktop-features=" + JSON.stringify(o.f));
      if (o.e) args.push("--desktop-enterprise-config=" + JSON.stringify(o.e));
      if (o.t) args.push("--desktop-telemetry-config=" + JSON.stringify(o.t));
      if (o.u != null) args.push("--desktop-nest-local-username=" + o.u);
      if (args.length > 1 && o.f) {
        bootArgv = args;
        log(`captured boot argv from renderer globals (${args.length - 1} desktop args)`);
        announceReady();
      } else if ((attempt || 0) < 8) {
        setTimeout(() => captureBootArgv((attempt || 0) + 1), 750);
      } else {
        log("boot argv capture: desktop globals never appeared");
      }
    } catch (e) {
      if ((attempt || 0) < 8) setTimeout(() => captureBootArgv((attempt || 0) + 1), 750);
      else log("executeJavaScript boot capture failed:", e && e.message);
    }
  };
  // Build real {error,result} envelopes for the 15 sync channels. For store
  // getStateSync we call the proven async getState HANDLE channel (real value);
  // for the 4 method sync channels we invoke the sync handler. The renderer's
  // sendSync replays these envelopes.
  const buildSyncSnapshot = async () => {
    const snap = {};
    const handleByLogical = new Map();
    for (const k of st.handle.keys()) handleByLogical.set(logicalOf(k), k);
    for (const raw of st.on.keys()) {
      const logical = logicalOf(raw);
      if (!isSyncChannel(logical)) continue;
      try {
        if (/\.\$store\$\.getStateSync$/.test(logical)) {
          const getStateLogical = logical.replace(/\.getStateSync$/, ".getState");
          const hraw = handleByLogical.get(getStateLogical);
          if (hraw && st.handle.has(hraw)) {
            const val = await Promise.resolve(st.handle.get(hraw)(makeEvent()));
            snap[logical] = { error: null, result: val };
          } else {
            snap[logical] = { error: null, result: {} };
          }
        } else {
          let def = /\.getInitialLocale$/.test(logical) ? "en-US" : false;
          const ev = makeEvent();
          let rv;
          Object.defineProperty(ev, "returnValue", { get() { return rv; }, set(v) { rv = v; }, configurable: true });
          const ret = st.on.get(raw)(ev);
          const env = rv !== undefined ? rv : ret;
          snap[logical] = env && typeof env === "object" && "result" in env ? env : { error: null, result: def };
        }
      } catch (e) {
        snap[logical] = { error: null, result: /\.getStateSync$/.test(logical) ? {} : false };
      }
    }
    syncSnapshot = snap;
    const withData = Object.values(snap).filter((e) => e && e.result !== undefined && e.result !== false && JSON.stringify(e.result) !== "{}").length;
    log(`built sync snapshot: ${Object.keys(snap).length} channels (${withData} with non-trivial data)`);
  };
  // Auto-heal main-process auth: the browser's tunneled login sets claude.ai
  // session cookies in THIS renderer's session, but the container app loaded
  // /login and its main-process account store (Ss()) stays empty → local coding
  // sessions fail ("account information is unavailable"). Once an auth cookie
  // appears, navigate the main view to the logged-in app so its SPA bootstraps
  // authenticated → IPC populates the main account store → initializeWithAccount
  // works.
  let navigatedToApp = false;
  const APP_HOME = process.env.BRIDGE_APP_HOME || "https://claude.ai/new";
  const bootstrapMainAccount = async (attempt) => {
    if (process.env.BRIDGE_AUTO_LOGIN !== "1") return; // disabled: rely on the
    // browser renderer calling setAccountDetails (now that args carry undefined
    // correctly) to populate the main account store. Re-enable to navigate the
    // container renderer to the logged-in app instead.
    if (navigatedToApp) return;
    try {
      const cookies = await wc.session.cookies.get({});
      const authed = cookies.some((c) => /(^|\.)(claude\.ai|claude\.com)$/.test(c.domain || "") &&
        /sessionKey|__Secure-|lastActiveOrg|activitySessionId|ajs_user_id/i.test(c.name));
      const url = wc.getURL();
      if (authed && !navigatedToApp) {
        navigatedToApp = true;
        log(`auth cookie detected → navigating main view to logged-in app (${APP_HOME}) to populate main account store`);
        try { await wc.loadURL(APP_HOME); } catch (e) { log("app navigate failed:", e && e.message); }
        return;
      }
    } catch (e) { log("bootstrapMainAccount err:", e && e.message); }
    if ((attempt || 0) < 240) setTimeout(() => bootstrapMainAccount((attempt || 0) + 1), 5000); // ~20min watch
  };
  wc.on("did-finish-load", () => {
    const url = wc.getURL();
    if (url.includes(APP_HOST) && mainViewId !== id) {
      mainViewId = id;
      log(`main SPA view identified: wc#${id} url=${url.slice(0, 50)} handlers=${st.handle.size} on=${st.on.size}`);
      announceReady();
      captureBootArgv(0);
      buildSyncSnapshot().catch((e) => log("sync snapshot failed:", e && e.message));
      bootstrapMainAccount(0);
    } else if (url.includes(APP_HOST) && mainViewId === id && navigatedToApp) {
      // logged-in app finished loading → refresh boot args + sync snapshot (now
      // carrying real account/org state) so the browser sees authed stores.
      log(`logged-in app loaded (${url.slice(0, 40)}) — refreshing boot/sync snapshots`);
      captureBootArgv(0);
      buildSyncSnapshot().catch((e) => log("post-login sync snapshot failed:", e && e.message));
      announceReady();
    }
  });
});

function mainState() { return mainViewId != null ? wcState.get(mainViewId) : null; }

function reverseIndex(st) {
  // logical -> rawChannel, for both handle and on maps
  const idx = new Map();
  for (const k of st.handle.keys()) idx.set(logicalOf(k), { raw: k, kind: "handle" });
  for (const k of st.on.keys()) if (!idx.has(logicalOf(k))) idx.set(logicalOf(k), { raw: k, kind: "on" });
  return idx;
}

function makeEvent() {
  const sender = {
    id: 0x7fff, isDestroyed: () => false,
    getURL: () => SENDER_URL, getType: () => "browserView",
    send: () => {}, postMessage: () => {},
  };
  return { senderFrame: { parent: null, url: SENDER_URL, origin: new URL(SENDER_URL).origin }, sender, frameId: 1, processId: 1 };
}

function fanoutPush(channel, args) {
  const frame = JSON.stringify({ t: "push", channel, logical: logicalOf(channel), args });
  for (const ws of clients) { if (ws.readyState === WS.OPEN && ws.__sub !== false) { try { ws.send(frame); } catch {} } }
}

// Decode the browser's undefined-sentinels back to real `undefined` (the
// bridge-client encodes undefined this way since JSON can't carry it; strict
// eipc validators need real undefined, not null/absent).
const U_SENTINEL = "__BRIDGE_UNDEFINED__";
function decodeUndef(v) {
  if (v === U_SENTINEL) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeUndef);
  const o = {};
  for (const k of Object.keys(v)) o[k] = decodeUndef(v[k]);
  return o;
}

async function invokeChannel(channel, args, { sync } = {}) {
  args = decodeUndef(Array.isArray(args) ? args : []);
  const st = mainState();
  // Resolve the handler: main-view scoped registry first, then GLOBAL ipcMain
  // (legacy non-eipc channels like list-mcp-servers live there).
  let fn = null, kind = "handle";
  if (st) {
    if (channel.startsWith("$eipc_message$_")) {
      if (st.handle.has(channel)) { fn = st.handle.get(channel); kind = "handle"; }
      else if (st.on.has(channel)) { fn = st.on.get(channel); kind = "on"; }
    } else {
      const hit = reverseIndex(st).get(channel);
      if (hit) { fn = st[hit.kind].get(hit.raw); kind = hit.kind; }
    }
  }
  if (!fn) {
    if (globalHandlers.handle.has(channel)) { fn = globalHandlers.handle.get(channel); kind = "handle"; }
    else if (globalHandlers.on.has(channel)) { fn = globalHandlers.on.get(channel); kind = "on"; }
  }
  if (!fn) throw new Error(`no handler for channel: ${logicalOf(channel)}`);

  const ev = makeEvent();
  if (kind === "on" || sync) {
    // sync-style: handler sets ev.returnValue (or returns)
    let rv;
    Object.defineProperty(ev, "returnValue", { get() { return rv; }, set(v) { rv = v; }, configurable: true });
    const r = await Promise.resolve(fn(ev, ...args));
    return rv !== undefined ? rv : r;
  }
  return withTimeout(Promise.resolve(fn(ev, ...args)), CALL_TIMEOUT_MS, channel);
}

function withTimeout(p, ms_, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge call timeout after ${ms_}ms: ${label}`)), ms_);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function announceReady() {
  const st = mainState();
  const channels = st ? [...st.handle.keys()].map(logicalOf).sort() : [];
  const frame = JSON.stringify({ t: "ready", count: channels.length, channels });
  for (const ws of clients) { if (ws.readyState === WS.OPEN) { try { ws.send(frame); } catch {} } }
}

// ── HTTP + WS server ─────────────────────────────────────────────────────────
// The active org the SPA is using. The renderer's claude.ai session never gets a
// `lastActiveOrg` cookie (the SPA sets it client-side in the BROWSER, which never
// reaches the container). But the MAIN process's local-agent session-start reads
// it from session.defaultSession (Sr() → index.main.js:105788). We derive the real
// org from the SPA's own org-scoped /api traffic (see /proxy) and mirror it in.
let lastOrgSet = null;
async function setLastActiveOrg(org, st) {
  if (!org || lastOrgSet === org) return false;
  const targets = [];
  try { targets.push(electron.session.defaultSession); } catch (e) {}
  try { if (st && st.wc && st.wc.session && st.wc.session !== electron.session.defaultSession) targets.push(st.wc.session); } catch (e) {}
  for (const ses of targets) { try { await ses.cookies.set({ url: "https://claude.ai", name: "lastActiveOrg", value: org }); } catch (e) {} }
  lastOrgSet = org;
  log(`[org] mirrored lastActiveOrg=${org} into ${targets.length} session(s) for main-process Sr()`);
  return true;
}
// Cookies safe + durable to persist across container recycles (used ONLY by
// /auth-cookies, the persistence endpoint). We allowlist the login session and
// the active-org hint and NEVER persist cf_clearance/__cf_bm/Turnstile: those
// are IP+UA-bound bot-clearance cookies that go stale when the container's
// egress IP changes, and re-injecting a stale one crash-looped boot. They are
// re-minted automatically per IP on first load — exactly like a real browser.
const PERSIST_COOKIE_NAMES = new Set(["sessionKey", "lastActiveOrg"]);
const server = http.createServer(async (req, res) => {
  const reqUrl = (() => { try { return new URL(req.url, "http://localhost"); } catch { return null; } })();
  if (reqUrl && reqUrl.pathname === "/session") {
    // Server-side session sharing (auth model A): return the container's
    // claude.ai cookies so the Worker can attach them to proxied /api/* calls.
    // Reachable only via the Access-gated Worker over the private DO binding.
    try {
      const st = mainState();
      const ses = st && st.wc && st.wc.session ? st.wc.session : electron.session.defaultSession;
      const cookies = await ses.cookies.get({}); // all cookies in this session
      const wanted = cookies.filter((c) => /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(c.domain || ""));
      const cookieHeader = wanted.map((c) => `${c.name}=${c.value}`).join("; ");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ready: mainViewId != null,
        count: wanted.length,
        cookieHeader,
        names: wanted.map((c) => c.name),
        // surface whether a real auth/session cookie is present (logged in?)
        authed: wanted.some((c) => /sessionKey|__Secure|lastActiveOrg|activitySessionId/i.test(c.name)),
      }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e && e.message) }));
    }
    return;
  }
  if (reqUrl && reqUrl.pathname === "/proxy") {
    // Auth model A (robust): run the upstream claude.ai fetch INSIDE the main
    // view's renderer (claude.ai origin, Turnstile-cleared, authenticated
    // session). Set-Cookie lands in the container session automatically. The
    // Worker tunnels all /api/* here. Non-streaming JSON only (login/bootstrap).
    const st = mainState();
    if (!st || !st.wc || st.wc.isDestroyed()) { res.writeHead(503); res.end(JSON.stringify({ error: "main view not ready" })); return; }
    let bodyChunks = [];
    req.on("data", (d) => bodyChunks.push(d));
    req.on("end", async () => {
      let spec;
      try { spec = JSON.parse(Buffer.concat(bodyChunks).toString() || "{}"); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
      // Mirror the active org into the cookie jar the MAIN process reads, so the
      // real local-agent session start (LocalAgentModeSessionManager.startSession →
      // initializeWithAccount → Sr(), index.main.js:105788) can resolve currentOrgId.
      // Sr() reads `lastActiveOrg` from session.defaultSession; vrA() just validates
      // it as a UUID. The SPA never sets that cookie in the container, so we derive
      // the real org from its own org-scoped /api traffic.
      try {
        const m = /\/organizations\/([0-9a-fA-F-]{36})(?:\/|$)/.exec((spec && spec.path) || "");
        if (m && m[1]) await setLastActiveOrg(m[1], st);
      } catch (e) {}
      const code =
        "(async()=>{const p=" + JSON.stringify(spec) + ";const init={method:p.method,headers:p.headers||{},credentials:'include',redirect:'manual'};" +
        "if(p.bodyB64){const b=atob(p.bodyB64);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);init.body=a;}" +
        "let r;try{r=await fetch(p.path,init);}catch(e){return{error:String(e&&e.message)};}" +
        "const buf=await r.arrayBuffer();const by=new Uint8Array(buf);let s='';for(let i=0;i<by.length;i++)s+=String.fromCharCode(by[i]);" +
        "const h={};r.headers.forEach((v,k)=>{h[k]=v;});return{status:r.status,headers:h,bodyB64:btoa(s),url:r.url};})()";
      try {
        const result = await st.wc.executeJavaScript(code, true);
        // The bootstrap response carries the org list; the SPA's active org is
        // account.memberships[0].organization.uuid. Bootstrap is fetched on every
        // load, so this resolves the org BEFORE the local-agent session-start retries
        // — unlike org-scoped paths, which may not occur first (and didn't, here).
        try {
          if (!lastOrgSet && /\/(edge-api|api)\/bootstrap(?:$|\?)/.test(spec.path || "") && result && result.bodyB64) {
            const body = JSON.parse(Buffer.from(result.bodyB64, "base64").toString("utf8"));
            const ms = body && body.account && body.account.memberships;
            const org = Array.isArray(ms) && ms[0] && ms[0].organization && ms[0].organization.uuid;
            if (org) await setLastActiveOrg(org, st);
          }
        } catch (e) {}
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(502); res.end(JSON.stringify({ error: String(e && e.message) }));
      }
    });
    return;
  }
  if (reqUrl && reqUrl.pathname === "/proxy-stream") {
    // STREAMING passthrough for SSE (chat completions / anything Accept:
    // text/event-stream). The buffered /proxy (renderer fetch + arrayBuffer)
    // can't stream — the renderer's fetch-event-source onopen rejects a buffered/
    // timed-out response with "Failed to fetch". Here we do a NODE-side fetch with
    // the renderer session's cookies + UA (same container IP → cf_clearance stays
    // valid) and stream the body straight back, chunk by chunk.
    const st = mainState();
    if (!st || !st.wc || st.wc.isDestroyed()) { res.writeHead(503); res.end(JSON.stringify({ error: "main view not ready" })); return; }
    let bodyChunks = [];
    req.on("data", (d) => bodyChunks.push(d));
    req.on("end", async () => {
      let spec;
      try { spec = JSON.parse(Buffer.concat(bodyChunks).toString() || "{}"); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
      try {
        const ses = st.wc.session;
        const all = await ses.cookies.get({});
        const cookieHeader = all
          .filter((c) => /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(c.domain || ""))
          .map((c) => `${c.name}=${c.value}`).join("; ");
        const headers = Object.assign({}, spec.headers || {}, {
          cookie: cookieHeader,
          "user-agent": st.wc.getUserAgent(),
          origin: "https://claude.ai",
          referer: "https://claude.ai/",
        });
        let body;
        if (spec.bodyB64) body = Buffer.from(spec.bodyB64, "base64");
        const upstream = await fetch("https://claude.ai" + spec.path, {
          method: spec.method, headers, body, redirect: "manual",
        });
        const respHeaders = {};
        upstream.headers.forEach((v, k) => {
          const lk = k.toLowerCase();
          if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lk)) respHeaders[k] = v;
        });
        res.writeHead(upstream.status, respHeaders);
        log(`[proxy-stream] ${spec.method} ${spec.path.slice(0, 70)} -> ${upstream.status} ${respHeaders["content-type"] || ""}`);
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
        }
        res.end();
      } catch (e) {
        log(`[proxy-stream] ERROR ${e && e.message}`);
        try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e && e.message) })); } catch {}
      }
    });
    return;
  }
  if (req.url && req.url.startsWith("/boot")) {
    // The browser sync-fetches this BEFORE running the preload, to populate
    // process.argv with the real --desktop-* args the preload parses.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ready: bootArgv != null,
      argv: bootArgv || ["claude"],
      appHost: APP_HOST,
      sync: syncSnapshot, // {logical: {error,result}} for the 15 sendSync channels
    }));
    return;
  }
  if (req.url && req.url.startsWith("/healthz")) {
    const st = mainState();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true, electronReady: electron.app.isReady(), mainViewId,
      handlerCount: st ? st.handle.size : 0, onCount: st ? st.on.size : 0,
      clients: clients.size, uptimeMs: ms(),
    }));
    return;
  }
  if (reqUrl && reqUrl.pathname === "/debug-rpc") {
    const onlyErr = reqUrl.searchParams.get("errors") === "1";
    const rows = onlyErr ? recentRpc.filter((r) => !r.ok) : recentRpc;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ count: rows.length, rpc: rows.slice(-60) }, null, 2));
    return;
  }
  // GET /debug-pty — node-pty self-test (#5 verification). Spawns a real
  // shell in the CONTAINER under the Electron-41 ABI, runs a fixed command, and
  // returns the echoed output. Key-gated + fixed command (NOT a browser shell),
  // so it never exposes an unauthenticated/arbitrary PTY.
  if (reqUrl && reqUrl.pathname === "/debug-pty") {
    const out = { step: "start", abi: process.versions.modules, electron: process.versions.electron };
    try {
      const pty = require(path.join(REHOST, "app", "node_modules", "node-pty"));
      out.step = "required";
      const term = pty.spawn("/bin/bash", ["-lc", "echo bridge-pty-ok-$((6*7)); exit 0"], {
        name: "xterm-color", cols: 80, rows: 24, cwd: WORKSPACE, env: process.env,
      });
      let buf = "";
      term.onData((d) => { buf += d; });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 4000);
        term.onExit(({ exitCode }) => { out.exitCode = exitCode; clearTimeout(t); resolve(); });
      });
      out.step = "done"; out.output = buf.trim(); out.ok = /bridge-pty-ok-42/.test(buf);
    } catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
    res.writeHead(out.ok ? 200 : 500, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }
  // GET /debug-session — drive the REAL session+PTY handlers (#4/#5) WITHOUT
  // an interactive login, by injecting the account/org state the app gates on:
  //   setAccountDetails → populates Ss() store (so _I()/hx() resolve accountId)
  //   set lastActiveOrg cookie → so Sr() resolves orgId
  // then LocalSessions.start → startPty. The agent's later API calls will fail
  // (no real auth) but session creation + node-pty terminal spawn are local main
  // work — this verifies the handler/PTY routing end-to-end. Key-gated, fixed flow
  // (NOT an arbitrary browser shell).
  if (reqUrl && reqUrl.pathname === "/debug-session") {
    const TOK = "df09fea9-cb64-4a74-80a9-7bacc8add1d2";
    const C = (svc, m) => `$eipc_message$_${TOK}_$_claude.web_$_${svc}_$_${m}`;
    const ORG = "00000000-0000-4000-8000-0000000000aa";
    const trace = {};
    try {
      const acct = { isLoggedOut: false, hasWiggle: false, isRaven: false, paidAccountTier: "free",
        canUseOmelette: false, hasUsageBasedSeatTier: false, accountUuid: "00000000-0000-4000-8000-0000000000ab",
        displayName: "E2E", fullName: "E2E Test", accountTaggedId: "user_e2e", emailAddress: "e2e@example.com" };
      try { await invokeChannel(C("Account", "setAccountDetails"), [acct]); trace.setAccountDetails = "ok"; }
      catch (e) { trace.setAccountDetails = String(e && e.message); }
      // inject lastActiveOrg cookie into the renderer's session (Sr reads it)
      const st = mainState();
      const ses = st && st.wc && st.wc.session ? st.wc.session : electron.session.defaultSession;
      for (const url of ["https://claude.ai", "https://claude.ai/"]) {
        try { await ses.cookies.set({ url, name: "lastActiveOrg", value: ORG }); trace.cookieSet = url; break; }
        catch (e) { trace.cookieSet = String(e && e.message); }
      }
      try {
        const started = await invokeChannel(C("LocalSessions", "start"),
          [{ cwd: "/workspace", message: "print hello world", model: "claude-opus-4-7" }]);
        trace.start = started; trace.sessionId = started && started.sessionId;
      } catch (e) { trace.start = "ERR: " + String(e && e.message); }
      if (trace.sessionId) {
        try { trace.startPty = await invokeChannel(C("LocalSessions", "startPty"), [trace.sessionId, 80, 24]) ?? "ok(void)"; }
        catch (e) { trace.startPty = "ERR: " + String(e && e.message); }
        try { trace.writePty = await invokeChannel(C("LocalSessions", "writePty"), [trace.sessionId, "echo bridge-session-pty-ok\n"]) ?? "ok(void)"; }
        catch (e) { trace.writePty = "ERR: " + String(e && e.message); }
      }
    } catch (e) { trace.fatal = String(e && e.stack || e); }
    const ok = !!trace.sessionId;
    res.writeHead(ok ? 200 : 500, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(trace, null, 2));
    return;
  }
  // GET /auth-cookies — full claude.ai/anthropic cookie objects for the DO to
  // persist (so a real login survives container recycles → no re-login). Returns
  // restorable objects (url/name/value/domain/path/secure/httpOnly/expirationDate).
  if (reqUrl && reqUrl.pathname === "/auth-cookies") {
    try {
      const st = mainState();
      const ses = st && st.wc && st.wc.session ? st.wc.session : electron.session.defaultSession;
      const all = await ses.cookies.get({});
      // Persist ONLY durable, IP-independent login cookies. cf_clearance/__cf_bm/
      // Turnstile are deliberately excluded here (they ARE returned by /session
      // for LIVE proxying) — they're IP+UA-bound and re-injecting a stale one on a
      // recycled container crash-looped the renderer. See PERSIST_COOKIE_NAMES.
      const wanted = all.filter((c) =>
        /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(c.domain || "") &&
        PERSIST_COOKIE_NAMES.has(c.name));
      const cookies = wanted.map((c) => {
        const domain = (c.domain || "").replace(/^\./, "");
        return { url: `https://${domain}${c.path || "/"}`, name: c.name, value: c.value,
          domain: c.domain, path: c.path || "/", secure: c.secure !== false, httpOnly: !!c.httpOnly,
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}) };
      });
      const authed = wanted.some((c) => /sessionKey|lastActiveOrg/i.test(c.name));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ authed, count: cookies.length, cookies }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e && e.message) })); }
    return;
  }
  // POST /restore-cookies {cookies:[...]} — inject persisted cookies into the
  // renderer session on a fresh container so the claude.ai login is already present.
  if (reqUrl && reqUrl.pathname === "/restore-cookies") {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const list = Array.isArray(body.cookies) ? body.cookies : [];
        const st = mainState();
        const ses = st && st.wc && st.wc.session ? st.wc.session : electron.session.defaultSession;
        let ok = 0;
        for (const c of list) {
          try {
            await ses.cookies.set({ url: c.url, name: c.name, value: c.value,
              ...(c.domain ? { domain: c.domain } : {}), path: c.path || "/",
              secure: c.secure !== false, httpOnly: !!c.httpOnly,
              ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}) });
            ok++;
          } catch (e) { /* skip bad cookie */ }
        }
        log(`[auth-cache] restored ${ok}/${list.length} cookies into renderer session`);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ restored: ok, of: list.length }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: String(e && e.message) })); }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WS.Server({ server, path: "/bridge" });
wss.on("connection", (ws, req) => {
  ws.__sub = true;
  clients.add(ws);
  log(`WS client connected (${clients.size} total)`);
  // send ready snapshot if main view already up
  if (mainState()) announceReady();

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
    if (msg.t === "subscribe") { ws.__sub = true; return; }
    if (msg.t === "unsubscribe") { ws.__sub = false; return; }
    if (msg.t === "invoke" || msg.t === "sendSync") {
      const started = Date.now();
      try {
        const value = await invokeChannel(msg.channel, msg.args || [], { sync: msg.t === "sendSync" });
        ws.send(JSON.stringify({ id: msg.id, t: "result", ok: true, value }));
        recordRpc(msg, true, value, undefined, Date.now() - started);
        log(`RPC ok ${msg.t} ${logicalOf(msg.channel)} (${Date.now() - started}ms)`);
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, t: "result", ok: false, error: String(e && e.message || e) }));
        recordRpc(msg, false, undefined, String(e && e.message || e), Date.now() - started);
        log(`RPC ERR ${msg.t} ${logicalOf(msg.channel)}: ${e && e.message}`);
      }
    }
  });
  ws.on("close", () => { clients.delete(ws); log(`WS client closed (${clients.size} left)`); });
  ws.on("error", (e) => log("WS error:", e && e.message));
});

server.listen(PORT, () => log(`bridge HTTP+WS listening on :${PORT} (path /bridge, /healthz)`));

// ── boot the real app ────────────────────────────────────────────────────────
log("booting real Claude main via bootstrap.cjs ...");
try { require(path.join(REHOST, "bootstrap.cjs")); }
catch (e) { console.error(`[bridge] bootstrap threw:`, e && e.stack || e); }

electron.app.on("window-all-closed", (e) => { e.preventDefault?.(); }); // keep alive headless
process.on("uncaughtException", (e) => log("uncaughtException:", e && e.message));
process.on("unhandledRejection", (e) => log("unhandledRejection:", e && (e.message || e)));
