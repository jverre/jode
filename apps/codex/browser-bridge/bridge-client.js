// ─────────────────────────────────────────────────────────────────────────────
// Codex UI/Server split — BROWSER BRIDGE CLIENT
//
// Loaded as a CLASSIC script BEFORE the Codex webview module. It:
//   1. builds an `electron` shim (contextBridge + ipcRenderer + webUtils) whose
//      ipcRenderer marshals over a WebSocket to the container bridge server,
//   2. synchronously loads & runs the REAL preload.js under that shim, so
//      window.electronBridge / window.codexWindowType are the AUTHENTIC API,
//   3. primes the 5 sendSync channels from a /__bridge/boot snapshot so the
//      preload's synchronous reads return real values,
//   4. relays the `connect-app-host` MessagePort (the capnweb stream to the codex
//      app-server) over the WebSocket via a port-multiplexing protocol.
//
// Transport frames (JSON):
//   c→s {id,t:"invoke",channel,args} | {t:"send",channel,args}
//       {t:"port-open",portId,channel} | {t:"port-msg",portId,b64} | {t:"port-close",portId}
//       {t:"ping"} | {t:"subscribe"|"unsubscribe"}
//   s→c {id,t:"result",ok,value|error} | {t:"push",channel,args}
//       {t:"port-msg",portId,b64} | {t:"port-close",portId} | {t:"ready",...} | {t:"pong"}
//
// Config (optional, set on window before this script):
//   window.__BRIDGE_WS_URL__       default same-origin /bridge
//   window.__BRIDGE_PRELOAD_URL__  default /__bridge/preload.js
//   window.__BRIDGE_BOOT_URL__     default /__bridge/boot
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  var LOGPREFIX = "[codex-bridge]";
  function log() { try { console.debug.apply(console, [LOGPREFIX].concat([].slice.call(arguments))); } catch (e) {} }
  function warnOnce(set, key, msg) { if (!set.has(key)) { set.add(key); try { console.warn(LOGPREFIX, msg); } catch (e) {} } }

  var WS_URL = window.__BRIDGE_WS_URL__ ||
    ((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/bridge");
  var PRELOAD_URL = window.__BRIDGE_PRELOAD_URL__ || "/__bridge/preload.js";
  var BOOT_URL = window.__BRIDGE_BOOT_URL__ || "/__bridge/boot";

  // ── WebSocket transport with reconnect + request/response correlation ──────
  var ws = null, open = false, nextId = 1, backoff = 250;
  var pending = new Map();        // id → {resolve, reject, timer}
  var sendQueue = [];             // frames queued while disconnected
  var listeners = new Map();      // channel → Set(fn)   (ipcRenderer.on)
  var ports = new Map();          // portId → MessagePort (browser side of connect-app-host)
  var warned = new Set();
  var CALL_TIMEOUT = 20000;

  function connect() {
    try { ws = new WebSocket(WS_URL); }
    catch (e) { log("WS construct failed", e && e.message); scheduleReconnect(); return; }
    ws.addEventListener("open", function () {
      open = true; backoff = 250;
      log("WS open", WS_URL);
      document.documentElement && document.documentElement.setAttribute("data-bridge", "open");
      var q = sendQueue; sendQueue = [];
      q.forEach(function (f) { rawSend(f); });
    });
    ws.addEventListener("message", function (ev) { onMessage(ev.data); });
    ws.addEventListener("close", function () {
      open = false;
      document.documentElement && document.documentElement.setAttribute("data-bridge", "closed");
      log("WS closed; reconnecting");
      scheduleReconnect();
    });
    ws.addEventListener("error", function () { try { ws.close(); } catch (e) {} });
  }
  function scheduleReconnect() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5000); }
  function rawSend(frame) {
    if (open && ws && ws.readyState === 1) { try { ws.send(frame); return true; } catch (e) {} }
    sendQueue.push(frame); return false;
  }

  // base64 <-> ArrayBuffer (port messages can carry binary capnweb frames)
  function abToB64(buf) {
    var bytes = new Uint8Array(buf), s = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToAb(b64) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function onMessage(data) {
    var msg; try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.t === "result") {
      var p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || "bridge error")); }
      return;
    }
    if (msg.t === "push") { dispatchPush(msg.channel, msg.args || []); return; }
    if (msg.t === "port-msg") {
      var port = ports.get(msg.portId);
      if (port) { try { port.postMessage(msg.b64 != null ? b64ToAb(msg.b64) : msg.data); } catch (e) { log("port post failed", e && e.message); } }
      return;
    }
    if (msg.t === "port-close") { var pc = ports.get(msg.portId); if (pc) { try { pc.close(); } catch (e) {} ports.delete(msg.portId); } return; }
    if (msg.t === "ready") { log("bridge ready:", msg.count, "channels"); document.documentElement && document.documentElement.setAttribute("data-bridge-channels", String(msg.count)); return; }
  }

  function dispatchPush(channel, args) {
    var set = listeners.get(channel);
    if (!set) return;
    var fakeEvent = { senderId: 0, ports: [] };
    set.forEach(function (fn) { try { fn.apply(null, [fakeEvent].concat(args)); } catch (e) { console.error(LOGPREFIX, "listener error", channel, e); } });
  }

  // ── open-in-browser interception ───────────────────────────────────────────
  // The app dispatches `open-in-browser` (via electronBridge.sendMessageFromView →
  // `codex_desktop:message-from-view`) to have the MAIN process open a URL — e.g.
  // the ChatGPT OAuth authUrl during sign-in. Relayed to the container that opens
  // an invisible window on the headless display. Handle http(s) URLs HERE instead,
  // in the user's real browser. (codex:// deep links etc. still relay to main.)
  // window.open is usually popup-blocked (the dispatch happens after awaits, so
  // the user-gesture token is gone) — fall back to a clickable overlay.
  function handleOpenInBrowser(url) {
    log("open-in-browser intercepted:", url);
    var w = null;
    try { w = window.open(url, "_blank", "noopener"); } catch (e) {}
    if (!w) showOpenLinkOverlay(url);
  }
  function showOpenLinkOverlay(url) {
    try {
      var prev = document.getElementById("__bridge_open_link__");
      if (prev) prev.remove();
      var box = document.createElement("div");
      box.id = "__bridge_open_link__";
      box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1a1a1a;color:#fff;padding:14px 16px;border-radius:10px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.4);max-width:340px;display:flex;gap:12px;align-items:center";
      var a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Continue sign-in in your browser →";
      a.style.cssText = "color:#7dd3fc;text-decoration:underline;word-break:break-word";
      a.addEventListener("click", function () { setTimeout(function () { box.remove(); }, 500); });
      var x = document.createElement("button");
      x.textContent = "×";
      x.style.cssText = "background:none;border:none;color:#999;font-size:18px;cursor:pointer;padding:0";
      x.addEventListener("click", function () { box.remove(); });
      box.appendChild(a); box.appendChild(x);
      (document.body || document.documentElement).appendChild(box);
      setTimeout(function () { box.remove(); }, 120000);
    } catch (e) { log("overlay failed; url:", url); }
  }

  // ── ipcRenderer shim ───────────────────────────────────────────────────────
  function invoke(channel) {
    var args = [].slice.call(arguments, 1);
    if (channel === "codex_desktop:message-from-view" && args[0] &&
        args[0].type === "open-in-browser" && /^https?:\/\//i.test(args[0].url || "")) {
      handleOpenInBrowser(args[0].url);
      return Promise.resolve();
    }
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error("bridge invoke timeout: " + channel)); } }, CALL_TIMEOUT);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      rawSend(JSON.stringify({ id: id, t: "invoke", channel: channel, args: args }));
    });
  }
  function on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return ipcRenderer;
  }
  function removeListener(channel, fn) { var s = listeners.get(channel); if (s) s.delete(fn); return ipcRenderer; }
  function removeAllListeners(channel) { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return ipcRenderer; }
  function send(channel) {
    rawSend(JSON.stringify({ t: "send", channel: channel, args: [].slice.call(arguments, 1) }));
  }
  // Codex's preload reads the RAW value from sendSync (e.g. the sentry options
  // object, the build flavor string, the theme), NOT a {error,result} envelope.
  function sendSync(channel) {
    if (syncSnapshot && Object.prototype.hasOwnProperty.call(syncSnapshot, channel)) return syncSnapshot[channel];
    throw new Error("bridge boot snapshot missing sendSync value for " + channel);
  }

  // postMessage: used by the preload for `connect-app-host` — it transfers a
  // MessagePort whose message stream is the capnweb RPC channel to the codex
  // app-server. Multiplex that port over the WebSocket: assign an id, pipe the
  // browser port's messages → WS, and WS port-msg → the port.
  var nextPortId = 1;
  function postMessage(channel, message, transfer) {
    var portList = transfer || [];
    if (!portList.length) {
      // no ports → a plain async message; forward like send
      rawSend(JSON.stringify({ t: "send", channel: channel, args: [message] }));
      return;
    }
    for (var i = 0; i < portList.length; i++) {
      var port = portList[i];
      var portId = nextPortId++;
      ports.set(portId, port);
      (function (port, portId) {
        port.onmessage = function (ev) {
          // capnweb frames are typically ArrayBuffer/string; b64-encode binary.
          if (ev.data instanceof ArrayBuffer) rawSend(JSON.stringify({ t: "port-msg", portId: portId, b64: abToB64(ev.data) }));
          else rawSend(JSON.stringify({ t: "port-msg", portId: portId, data: ev.data }));
        };
        port.onmessageerror = function () { log("port messageerror", portId); };
        try { port.start && port.start(); } catch (e) {}
      })(port, portId);
      rawSend(JSON.stringify({ t: "port-open", portId: portId, channel: channel }));
      log("connect-app-host: opened relay port", portId, "for", channel);
    }
  }

  var ipcRenderer = {
    invoke: invoke,
    on: on, addListener: on,
    once: function (ch, fn) { var wrap = function () { removeListener(ch, wrap); return fn.apply(null, arguments); }; return on(ch, wrap); },
    removeListener: removeListener, off: removeListener, removeAllListeners: removeAllListeners,
    send: send, sendSync: sendSync, postMessage: postMessage, sendToHost: function () {},
  };

  var contextBridge = {
    exposeInMainWorld: function (apiKey, api) { try { window[apiKey] = api; } catch (e) { console.error(LOGPREFIX, "exposeInMainWorld failed", apiKey, e); } },
    exposeInIsolatedWorld: function (_id, apiKey, api) { try { window[apiKey] = api; } catch (e) {} },
  };
  // Codex preload calls webUtils.getPathForFile(file) → absolute path (Electron
  // drag/drop). In the browser there is no path; return "" so callers no-op.
  var webUtils = { getPathForFile: function () { return ""; } };
  var webFrame = {
    routingId: 1, insertCSS: function (css) { try { var s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch (e) {} return "css-" + Math.random().toString(36).slice(2); },
    removeInsertedCSS: function () {}, executeJavaScript: function () { return Promise.resolve(); },
    setZoomFactor: function () {}, getZoomFactor: function () { return 1; }, setVisualZoomLevelLimits: function () {},
  };
  var electronShim = {
    contextBridge: contextBridge, ipcRenderer: ipcRenderer, webUtils: webUtils, webFrame: webFrame,
    shell: { openExternal: function (u) { try { window.open(u, "_blank", "noopener"); } catch (e) {} return Promise.resolve(); } },
  };

  function requireShim(spec) {
    if (spec === "electron" || spec === "electron/renderer" || spec === "electron/common") return electronShim;
    throw new Error("preload required unexpected module: " + spec);
  }

  // ── sync boot snapshot (the 5 sendSync channels) ───────────────────────────
  var syncSnapshot = {};
  function fetchBoot() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", BOOT_URL, false); // synchronous: must be ready before the preload runs
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        var boot = JSON.parse(xhr.responseText);
        if (boot && boot.sync && typeof boot.sync === "object") {
          syncSnapshot = boot.sync;
          log("boot sync snapshot:", Object.keys(syncSnapshot).length, "channels");
        }
      } else {
        throw new Error("boot fetch status " + xhr.status);
      }
    } catch (e) {
      throw new Error("bridge boot fetch failed: " + (e && e.message ? e.message : e));
    }
  }

  // The preload references bare `process` (Electron injects it in a real
  // renderer; e.g. isIntelMacBuild → process.platform/arch). The browser has no
  // `process`, so pass a shim reporting linux/x64.
  var processShim = {
    platform: "linux", arch: "x64", type: "renderer",
    env: {}, argv: ["codex"], versions: { electron: "42.1.0", chrome: "148.0.0.0", node: "24.0.0" },
    cwd: function () { return "/"; }, nextTick: function (f) { Promise.resolve().then(f); }, on: function () { return processShim; },
  };
  function runPreload(src) {
    var moduleObj = { exports: {} };
    try {
      var fn = new Function("require", "module", "exports", "global", "globalThis", "process", src + "\n//# sourceURL=" + PRELOAD_URL);
      fn(requireShim, moduleObj, moduleObj.exports, window, window, processShim);
      document.documentElement && document.documentElement.setAttribute("data-bridge-preload", "ran");
      log("real preload executed; electronBridge exposed:", typeof window.electronBridge !== "undefined");
    } catch (e) {
      document.documentElement && document.documentElement.setAttribute("data-bridge-preload", "error");
      console.error(LOGPREFIX, "preload execution failed:", e);
    }
  }
  function loadPreloadSync() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", PRELOAD_URL, false); // sync: must run before the SPA module
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) { runPreload(xhr.responseText); return true; }
      console.error(LOGPREFIX, "preload fetch failed", xhr.status);
    } catch (e) { console.error(LOGPREFIX, "preload sync load error", e); }
    return false;
  }

  window.__CODEX_BRIDGE__ = {
    invoke: invoke, on: on, ipcRenderer: ipcRenderer,
    state: function () { return { open: open, pending: pending.size, listeners: listeners.size, ports: ports.size, ws: WS_URL }; },
  };

  connect();
  fetchBoot();
  loadPreloadSync();
})();
