// ─────────────────────────────────────────────────────────────────────────────
// Codex UI/Server split — BRIDGE SERVER (container side)
//
// Runs the REAL Codex Electron main headless (via ../bootstrap.cjs), captures the
// global ipcMain handlers the renderer talks to, and exposes them over a
// WebSocket RPC transport to the browser-served webview. Unlike the Claude split,
// Codex uses STANDARD global ipcMain (ipcRenderer.invoke/sendSync/on) — so handler
// capture is on electron.ipcMain directly. The novel piece is the
// `connect-app-host` MessagePort relay: the renderer transfers a MessagePort whose
// stream is the capnweb RPC channel to the codex app-server; we bridge it with a
// MessageChannelMain and multiplex it over the WebSocket.
//
// Transport (JSON frames):
//   c→s {id,t:"invoke",channel,args} | {t:"send",channel,args}
//       {t:"port-open",portId,channel} | {t:"port-msg",portId,b64|data} | {t:"port-close",portId}
//       {t:"ping"} | {t:"subscribe"|"unsubscribe"}
//   s→c {id,t:"result",ok,value|error} | {t:"push",channel,args}
//       {t:"port-msg",portId,b64|data} | {t:"port-close",portId} | {t:"ready",...} | {t:"pong"}
//
// Security: WS requires ?key=<BRIDGE_KEY> (env). Never expose unauthenticated.
// ─────────────────────────────────────────────────────────────────────────────
const path = require("node:path");
const http = require("node:http");
const electron = require("electron");

const REHOST = process.env.REHOST_ROOT
  ? path.resolve(process.env.REHOST_ROOT)
  : path.resolve(__dirname, "..", "..", "linux-rehost");
// Codex bundles `ws` into its vite build (not a standalone module like the Claude
// payload), so install it alongside the bridge. Try the bridge's own node_modules
// first, then the app's, then the bare name.
const WS = (() => {
  for (const p of [path.join(__dirname, "node_modules", "ws"), path.join(REHOST, "app", "node_modules", "ws"), "ws"]) {
    try { return require(p); } catch {}
  }
  throw new Error("ws module not found (install it under /opt/bridge)");
})();

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const BRIDGE_KEY = process.env.BRIDGE_KEY || "dev-bridge-key";
const CALL_TIMEOUT_MS = Number(process.env.BRIDGE_CALL_TIMEOUT_MS || 15000);

const t0 = Date.now();
const ms = () => Date.now() - t0;
const log = (...a) => console.log(`[codex-bridge ${ms()}ms]`, ...a);

// ── handler capture (global ipcMain) ─────────────────────────────────────────
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

// The 5 channels the preload reads via ipcRenderer.sendSync at boot. The preload
// uses the RAW returned value (not a {error,result} envelope).
const SYNC_CHANNELS = [
  "codex_desktop:get-sentry-init-options",
  "codex_desktop:get-build-flavor",
  "codex_desktop:get-uses-owl-app-shell",
  "codex_desktop:get-shared-object-snapshot",
  "codex_desktop:get-system-theme-variant",
];

const clients = new Set();        // ws connections (push fan-out)
let mainViewId = null;            // webContents id of the main app window
let mainWc = null;                // the REAL primary-window webContents (trusted sender)
let syncSnapshot = {};            // channel -> raw value (replayed by the browser sendSync)

// ── main→renderer push capture + main-view identification ─────────────────────
electron.app.on("web-contents-created", (_e, wc) => {
  const origSend = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    try { if (wc.id === mainViewId && typeof channel === "string") fanoutPush(channel, args); } catch {}
    try { return origSend(channel, ...args); } catch {}
  };
  const identify = () => {
    try {
      if (mainViewId == null && wc.getType && wc.getType() === "window") {
        mainViewId = wc.id;
        mainWc = wc; // the REAL registered webContents — used as the trusted IPC sender
        log(`main window webContents identified: wc#${wc.id} type=window url=${(wc.getURL() || "").slice(0, 60)}`);
        announceReady();
        buildSyncSnapshot().catch((e) => log("sync snapshot failed:", e && e.message));
      }
    } catch {}
  };
  wc.on("did-finish-load", identify);
  wc.on("did-frame-finish-load", identify);
  // a window may already be the main view before first load completes
  setTimeout(identify, 1500);
});

// The renderer's app origin. Codex serves its webview over the `app://` custom
// scheme; the ipcMain handlers read event.senderFrame.url / event.sender.getURL()
// (e.g. for origin gating + logging), so the synthetic event must carry a valid
// app-origin frame or sync handlers throw "Cannot read properties of undefined".
const APP_ORIGIN = process.env.BRIDGE_APP_ORIGIN || "app://codex";
const SENDER_URL = APP_ORIGIN + "/index.html";
function makeEvent(ports) {
  // Use the REAL primary-window webContents as the sender so the app's trust gate
  // passes: isTrustedIpcSender requires sender.id ∈ registeredWebContentsIds, and
  // connect-app-host needs getContextForWebContents(sender) to resolve the real
  // window context. senderFrame is the real mainFrame (G1 requires it to equal
  // sender.mainFrame and its url to be a trusted app/renderer url).
  if (mainWc && !mainWc.isDestroyed()) {
    const senderFrame = (() => { try { return mainWc.mainFrame; } catch { return null; } })();
    return { sender: mainWc, senderFrame, frameId: 1, processId: 1, ports: ports || [] };
  }
  // Fallback (before the window is identified): synthetic sender.
  const sender = {
    id: mainViewId || 1, isDestroyed: () => false,
    getType: () => "window", getURL: () => SENDER_URL, getLastWebPreferences: () => ({}),
    mainFrame: { url: "about:blank", origin: APP_ORIGIN }, send: () => {}, postMessage: () => {},
  };
  const senderFrame = null; // null → G1 skips the identity check and reads sender.mainFrame.url
  return { sender, senderFrame, frameId: 1, processId: 1, ports: ports || [] };
}

function fanoutPush(channel, args) {
  const frame = JSON.stringify({ t: "push", channel, args });
  for (const ws of clients) { if (ws.readyState === WS.OPEN && ws.__sub !== false) { try { ws.send(frame); } catch {} } }
}
function announceReady() {
  const channels = [...globalHandlers.handle.keys(), ...globalHandlers.on.keys()].sort();
  const frame = JSON.stringify({ t: "ready", count: channels.length, channels });
  for (const ws of clients) { if (ws.readyState === WS.OPEN) { try { ws.send(frame); } catch {} } }
}

// Build the sendSync snapshot: call each sync channel's `on` handler with a
// synthetic event capturing returnValue; store the RAW value.
async function buildSyncSnapshot() {
  const snap = {};
  for (const ch of SYNC_CHANNELS) {
    const fn = globalHandlers.on.get(ch);
    if (!fn) continue;
    try {
      const ev = makeEvent();
      let rv;
      Object.defineProperty(ev, "returnValue", { get() { return rv; }, set(v) { rv = v; }, configurable: true });
      const ret = await Promise.resolve(fn(ev));
      snap[ch] = rv !== undefined ? rv : ret;
    } catch (e) { log(`sync ${ch} failed:`, e && e.message); }
  }
  syncSnapshot = snap;
  log(`built sync snapshot: ${Object.keys(snap).length}/${SYNC_CHANNELS.length} channels`);
}

// ── RPC debug ring buffer ─────────────────────────────────────────────────────
const recentRpc = [];
function preview(v) { try { const s = JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + "…" : s; } catch { return "[unserializable]"; } }
function recordRpc(msg, ok, value, error, dur) {
  try {
    recentRpc.push({ at: ms(), t: msg.t, channel: msg.channel, args: (msg.args || []).map(preview), ok, ms: dur, error: error || undefined, result: ok ? preview(value) : undefined });
    if (recentRpc.length > 80) recentRpc.shift();
    if (!ok) console.log(`[codex-bridge RPC-ERR] ${msg.channel} -> ${error}`);
  } catch {}
}

async function invokeChannel(channel, args, { sync } = {}) {
  args = Array.isArray(args) ? args : [];
  let fn = null, kind = "handle";
  if (globalHandlers.handle.has(channel)) { fn = globalHandlers.handle.get(channel); kind = "handle"; }
  else if (globalHandlers.on.has(channel)) { fn = globalHandlers.on.get(channel); kind = "on"; }
  if (!fn) throw new Error(`no handler for channel: ${channel}`);
  const ev = makeEvent();
  if (kind === "on" || sync) {
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

// ── connect-app-host MessagePort relay ────────────────────────────────────────
// The renderer transfers a MessagePort (the capnweb RPC stream to the codex
// app-server). For each browser port we mint a MessageChannelMain: port1 goes to
// the real main handler (which wires it to the app-server); port2 is ours, piped
// to the WS. portId namespaces frames per ws connection.
function openHostPort(ws, portId, channel) {
  const handler = globalHandlers.on.get(channel) || globalHandlers.handle.get(channel);
  if (!handler) { log(`port-open: no handler for ${channel}`); return; }
  let chan;
  try { chan = new electron.MessageChannelMain(); } catch (e) { log("MessageChannelMain unavailable:", e && e.message); return; }
  const { port1, port2 } = chan;
  ws.__ports = ws.__ports || new Map();
  ws.__ports.set(portId, port2);
  port2.on("message", (e) => {
    const d = e.data;
    let frame;
    if (d instanceof ArrayBuffer) frame = JSON.stringify({ t: "port-msg", portId, b64: Buffer.from(d).toString("base64") });
    else if (ArrayBuffer.isView(d)) frame = JSON.stringify({ t: "port-msg", portId, b64: Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString("base64") });
    else frame = JSON.stringify({ t: "port-msg", portId, data: d });
    try { if (ws.readyState === WS.OPEN) ws.send(frame); } catch {}
  });
  port2.on("close", () => { try { if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: "port-close", portId })); } catch {} });
  port2.start();
  // Deliver port1 to the real main handler as event.ports (how Electron delivers
  // a postMessage'd port to ipcMain).
  try {
    const ev = makeEvent([port1]);
    handler(ev);
    log(`connect-app-host: wired relay port ${portId} → main handler ${channel}`);
  } catch (e) { log("connect-app-host handler threw:", e && e.message); }
}
function hostPortMessage(ws, portId, payload) {
  const p = ws.__ports && ws.__ports.get(portId);
  if (!p) return;
  try { p.postMessage(payload); } catch (e) { log("port2 post failed:", e && e.message); }
}
function closeHostPort(ws, portId) {
  const p = ws.__ports && ws.__ports.get(portId);
  if (p) { try { p.close(); } catch {} ws.__ports.delete(portId); }
}

// ── HTTP + WS server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const reqUrl = (() => { try { return new URL(req.url, "http://localhost"); } catch { return null; } })();
  if (req.url && req.url.startsWith("/boot")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ready: mainViewId != null, sync: syncSnapshot }));
    return;
  }
  if (req.url && req.url.startsWith("/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, electronReady: electron.app.isReady(), mainViewId, handlers: globalHandlers.handle.size, on: globalHandlers.on.size, syncChannels: Object.keys(syncSnapshot).length, clients: clients.size, uptimeMs: ms() }));
    return;
  }
  if (reqUrl && reqUrl.pathname === "/debug-rpc") {
    if (reqUrl.searchParams.get("key") !== BRIDGE_KEY) { res.writeHead(401); res.end("unauthorized"); return; }
    const onlyErr = reqUrl.searchParams.get("errors") === "1";
    const rows = onlyErr ? recentRpc.filter((r) => !r.ok) : recentRpc;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ count: rows.length, mainViewId, rpc: rows.slice(-60) }, null, 2));
    return;
  }
  res.writeHead(404); res.end("not found");
});

const wss = new WS.Server({ server, path: "/bridge" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("key") !== BRIDGE_KEY) { log("WS rejected (bad key)"); ws.close(4001, "unauthorized"); return; }
  ws.__sub = true;
  clients.add(ws);
  log(`WS client connected (${clients.size} total)`);
  if (mainViewId != null) announceReady();

  ws.on("message", async (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
    if (msg.t === "subscribe") { ws.__sub = true; return; }
    if (msg.t === "unsubscribe") { ws.__sub = false; return; }
    if (msg.t === "port-open") { openHostPort(ws, msg.portId, msg.channel); return; }
    if (msg.t === "port-msg") { hostPortMessage(ws, msg.portId, msg.b64 != null ? Buffer.from(msg.b64, "base64").buffer : msg.data); return; }
    if (msg.t === "port-close") { closeHostPort(ws, msg.portId); return; }
    if (msg.t === "send") { invokeChannel(msg.channel, msg.args || [], {}).catch((e) => log(`send ${msg.channel} err: ${e && e.message}`)); return; }
    if (msg.t === "invoke" || msg.t === "sendSync") {
      const started = Date.now();
      try {
        const value = await invokeChannel(msg.channel, msg.args || [], { sync: msg.t === "sendSync" });
        ws.send(JSON.stringify({ id: msg.id, t: "result", ok: true, value }));
        recordRpc(msg, true, value, undefined, Date.now() - started);
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, t: "result", ok: false, error: String(e && e.message || e) }));
        recordRpc(msg, false, undefined, String(e && e.message || e), Date.now() - started);
      }
    }
  });
  ws.on("close", () => {
    clients.delete(ws);
    if (ws.__ports) { for (const p of ws.__ports.values()) { try { p.close(); } catch {} } ws.__ports.clear(); }
    log(`WS client closed (${clients.size} left)`);
  });
  ws.on("error", (e) => log("WS error:", e && e.message));
});

server.listen(PORT, () => log(`bridge HTTP+WS listening on :${PORT} (path /bridge, /healthz, /boot)`));

// ── boot the real Codex app ───────────────────────────────────────────────────
log("booting real Codex main via bootstrap.cjs ...");
try { require(path.join(REHOST, "bootstrap.cjs")); }
catch (e) { console.error(`[codex-bridge] bootstrap threw:`, e && e.stack || e); }

electron.app.on("window-all-closed", (e) => { e.preventDefault && e.preventDefault(); }); // keep alive headless
process.on("uncaughtException", (e) => log("uncaughtException:", e && e.message));
process.on("unhandledRejection", (e) => log("unhandledRejection:", e && (e.message || e)));
