// ─────────────────────────────────────────────────────────────────────────────
// Claude Desktop UI/Server split — BROWSER BRIDGE CLIENT
//
// Loaded as a CLASSIC script before the SPA module. It:
//   1. builds an `electron` shim (contextBridge + ipcRenderer) whose ipcRenderer
//      marshals over a WebSocket to the container bridge server,
//   2. synchronously loads & runs the REAL mainView.js preload under that shim,
//      so window.claude.* / window.process / etc. are the AUTHENTIC preload API,
//   3. keeps a store-snapshot cache so the 15 sync `getStateSync` channels can
//      answer synchronously (primed via async getState, refreshed on `_$store$_update`).
//
// Config (set on window before this script, optional):
//   window.__BRIDGE_WS_URL__    default: same-origin /bridge
//   window.__BRIDGE_PRELOAD_URL__ default: /__bridge/mainView.js
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  var LOGPREFIX = "[bridge-client]";
  function log() { try { console.debug.apply(console, [LOGPREFIX].concat([].slice.call(arguments))); } catch (e) {} }
  function warnOnce(set, key, msg) { if (!set.has(key)) { set.add(key); try { console.warn(LOGPREFIX, msg); } catch (e) {} } }

  var WS_URL = window.__BRIDGE_WS_URL__ ||
    ((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/bridge");
  var PRELOAD_URL = window.__BRIDGE_PRELOAD_URL__ || "/__bridge/mainView.js";

  // ── store-snapshot cache (for sendSync getStateSync) ───────────────────────
  // logical channel WITHOUT the trailing op  →  last known state object
  var storeCache = Object.create(null);
  function storeKeyOfSync(rawChannel) {
    // e.g. ...$store$_getStateSync  → strip the op, keep the store path
    return logicalOf(rawChannel).replace(/\.\$store\$\.getStateSync$/, "");
  }
  function storeKeyOfUpdate(rawChannel) {
    return logicalOf(rawChannel).replace(/\.\$store\$\.update$/, "");
  }

  function logicalOf(c) {
    return String(c)
      .replace(/^\$eipc_message\$_[0-9a-f-]+_\$_/, "")
      .replace(/_\$store\$_/g, ".$store$.")
      .replace(/_\$_/g, ".");
  }

  // ── WebSocket transport with reconnect + request/response correlation ──────
  var ws = null;
  var open = false;
  var nextId = 1;
  var pending = new Map();           // id → {resolve, reject, timer}
  var sendQueue = [];                // frames queued while disconnected
  var listeners = new Map();         // rawChannel → Set(fn)
  var subscribedChannels = new Set();
  var backoff = 250;
  var warned = new Set();
  var CALL_TIMEOUT = 20000;
  var nativeWindowOpen = window.open ? window.open.bind(window) : null;

  function connect() {
    try { ws = new WebSocket(WS_URL); }
    catch (e) { log("WS construct failed", e && e.message); scheduleReconnect(); return; }
    ws.addEventListener("open", function () {
      open = true; backoff = 250;
      log("WS open", WS_URL);
      document.documentElement && document.documentElement.setAttribute("data-bridge", "open");
      var q = sendQueue; sendQueue = [];
      q.forEach(function (f) { rawSend(f); });
      primeStores();
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

  function onMessage(data) {
    var msg; try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.t === "result") {
      var p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || "bridge error")); }
      return;
    }
    if (msg.t === "push") {
      if (msg.channel === "__bridge:open-external") {
        handleOpenInBrowser((msg.args && msg.args[0]) || "");
        return;
      }
      // refresh store cache on _$store$_update pushes
      if (/\.\$store\$\.update$/.test(msg.logical || logicalOf(msg.channel))) {
        var k = storeKeyOfUpdate(msg.channel);
        storeCache[k] = (msg.args && msg.args[0] !== undefined) ? msg.args[0] : storeCache[k];
      }
      dispatchPush(msg.channel, msg.args || []);
      return;
    }
    if (msg.t === "ready") { log("bridge ready:", msg.count, "channels"); document.documentElement && document.documentElement.setAttribute("data-bridge-channels", String(msg.count)); return; }
  }

  function dispatchPush(channel, args) {
    var set = listeners.get(channel);
    if (!set) return;
    var fakeEvent = { senderId: 0, ports: [] };
    set.forEach(function (fn) { try { fn.apply(null, [fakeEvent].concat(args)); } catch (e) { console.error(LOGPREFIX, "listener error", channel, e); } });
  }

  // ── secondary-window / external-link interception ─────────────────────────
  // OAuth and SSO flows ask Electron to open a secondary browser window. In this
  // hosted split, the container is headless, so open those URLs in the user's
  // real browser and fall back to a clickable prompt if the popup is blocked.
  function handleOpenInBrowser(url) {
    if (!/^(https?:|mailto:)/i.test(String(url || ""))) return false;
    log("open-in-browser intercepted:", url);
    var w = null;
    try { w = nativeWindowOpen ? nativeWindowOpen(url, "_blank", "noopener") : null; } catch (e) {}
    if (!w) showOpenLinkOverlay(url);
    return true;
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
      a.textContent = "Continue sign-in in your browser";
      a.style.cssText = "color:#7dd3fc;text-decoration:underline;word-break:break-word";
      a.addEventListener("click", function () { setTimeout(function () { box.remove(); }, 500); });
      var x = document.createElement("button");
      x.textContent = "x";
      x.style.cssText = "background:none;border:none;color:#999;font-size:18px;cursor:pointer;padding:0";
      x.addEventListener("click", function () { box.remove(); });
      box.appendChild(a); box.appendChild(x);
      (document.body || document.documentElement).appendChild(box);
      setTimeout(function () { box.remove(); }, 120000);
    } catch (e) { log("overlay failed; url:", url); }
  }
  try {
    window.open = function (url, target, features) {
      var w = nativeWindowOpen ? nativeWindowOpen(url, target, features) : null;
      if (!w && /^(https?:|mailto:)/i.test(String(url || ""))) showOpenLinkOverlay(url);
      return w;
    };
  } catch (e) {}

  // Electron's ipcRenderer uses structured clone, which PRESERVES `undefined`
  // (incl. nested + non-trailing). JSON turns array `undefined`→`null` and drops
  // object `undefined` keys, so the main process's strict eipc validators reject
  // args (e.g. getPlugins/setAccountDetails — which blocks the account store!).
  // Encode every `undefined` as a sentinel; the bridge decodes it back to
  // `undefined` before calling the real handler. Faithfully matches structured
  // clone.
  var U_SENTINEL = "__BRIDGE_UNDEFINED__";
  function encodeUndef(v) {
    if (v === undefined) return U_SENTINEL;
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(encodeUndef);
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = encodeUndef(v[k]);
    return o;
  }
  function invoke(channel) {
    var rawArgs = [].slice.call(arguments, 1);
    var args = encodeUndef(rawArgs);
    // diagnostic: log RAW + ENCODED args for channels under investigation, so the
    // browser console shows exactly what's sent (reveals undefined→sentinel encode).
    try {
      if (/LocalSessions_\$_start|Account_\$_setAccountDetails|WindowControl_\$_resize|setYukonSilverConfig|FileSystem_\$_browseFolder/.test(channel)) {
        console.log("[bridge-client DEBUG] " + logicalOf(channel),
          "raw=", JSON.stringify(rawArgs, function (k, v) { return v === undefined ? "<<undef>>" : v; }),
          "encoded=", JSON.stringify(args),
          "encodeUndef?", (typeof encodeUndef === "function"));
      }
    } catch (e) {}
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error("bridge invoke timeout: " + logicalOf(channel))); } }, CALL_TIMEOUT);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      rawSend(JSON.stringify({ id: id, t: "invoke", channel: channel, args: args }));
    });
  }

  function on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    if (!subscribedChannels.has(channel)) { subscribedChannels.add(channel); /* server fans out all pushes; explicit sub optional */ }
    return ipcRenderer;
  }
  function removeListener(channel, fn) { var s = listeners.get(channel); if (s) s.delete(fn); return ipcRenderer; }
  function removeAllListeners(channel) { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return ipcRenderer; }

  // The preload reads {error, result} from sendSync. Replay the real envelope
  // captured by the bridge (/boot.sync); missing boot data is a bridge error.
  function sendSync(channel) {
    var logical = logicalOf(channel);
    if (syncEnvelopes && Object.prototype.hasOwnProperty.call(syncEnvelopes, logical)) {
      return syncEnvelopes[logical];
    }
    throw new Error("bridge boot snapshot missing sendSync envelope for " + logical);
  }

  function send(channel) {
    var args = encodeUndef([].slice.call(arguments, 1));
    rawSend(JSON.stringify({ t: "send", channel: channel, args: args }));
  }

  // prime a single store cache from its async getState equivalent
  function primeStore(syncChannel) {
    var getStateChannel = syncChannel.replace(/getStateSync"?$/, "getState");
    // build the raw getState channel from the raw sync channel
    var raw = syncChannel.replace(/getStateSync$/, "getState");
    invoke(raw).then(function (v) { if (v !== undefined) storeCache[storeKeyOfSync(syncChannel)] = v; }).catch(function () {});
  }
  function primeStores() {
    // we don't know the sync channels until the preload calls them; primed lazily
    // on first sendSync. Nothing to do eagerly.
  }

  // ── electron shim ──────────────────────────────────────────────────────────
  var ipcRenderer = {
    invoke: invoke,
    on: on, addListener: on, once: function (ch, fn) { var wrap = function () { removeListener(ch, wrap); return fn.apply(null, arguments); }; return on(ch, wrap); },
    removeListener: removeListener, off: removeListener, removeAllListeners: removeAllListeners,
    send: send, sendSync: sendSync, postMessage: function () { /* MessagePort bridge is intentionally not implemented here. */ },
    sendToHost: function () {},
  };
  // DISABLED: do NOT neutralise chatIn3p. Exhaustively tested forcing the SPA flag
  // We=false (to get a cloud-only Chat composer for the chat-only org) and it is
  // STRUCTURALLY UNSUPPORTED in this desktop build: even from a fully-cleared storage
  // state, We=false renders a blank "/new" (no chat-home composer in the desktop frame)
  // and the renderer derives lastKnownMode="cowork" again -> blank. So this build's
  // Chat tab cannot be turned into a standalone cloud-/completion surface by flag flips;
  // it is architecturally the chatIn3p merged local-agent Chat. Kept as a no-op so the
  // call sites stay; see notepad.md "Chat → cloud completion is structurally impossible".
  function scrubDesktopBootFeatures(apiKey, api) { return api; }
  var contextBridge = {
    // authentic Electron behaviour: flat assign window[apiKey] = api (keys are
    // dotted strings like "claude.web"; the SPA reads window["claude.web"]).
    exposeInMainWorld: function (apiKey, api) {
      try { window[apiKey] = scrubDesktopBootFeatures(apiKey, api); } catch (e) { console.error(LOGPREFIX, "exposeInMainWorld failed", apiKey, e); }
    },
    exposeInIsolatedWorld: function (_id, apiKey, api) { try { window[apiKey] = scrubDesktopBootFeatures(apiKey, api); } catch (e) {} },
  };
  // electron/renderer webFrame: the preload calls insertCSS and reads
  // top/frameToken/routingId in its origin-gate (Oa). top=self with matching
  // tokens makes that half of the gate pass.
  var webFrame = {
    routingId: 1,
    frameToken: "browser-top-frame",
    insertCSS: function (css) {
      try { var s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch (e) {}
      return "css-" + Math.random().toString(36).slice(2);
    },
    removeInsertedCSS: function () {},
    executeJavaScript: function () { return Promise.resolve(); },
    setZoomFactor: function () {}, getZoomFactor: function () { return 1; },
    setVisualZoomLevelLimits: function () {},
  };
  webFrame.top = webFrame;
  var electronShim = {
    contextBridge: contextBridge,
    ipcRenderer: ipcRenderer,
    webFrame: webFrame,
    shell: { openExternal: function (u) { handleOpenInBrowser(u); return Promise.resolve(); } },
    clipboard: window.navigator && navigator.clipboard ? {
      writeText: function (t) { return navigator.clipboard.writeText(t); },
      readText: function () { return navigator.clipboard.readText(); },
    } : { writeText: function () {}, readText: function () { return ""; } },
  };

  // ── load + run the REAL preload under the shim (synchronous, before SPA) ────
  function requireShim(spec) {
    if (spec === "electron" || spec === "electron/renderer" || spec === "electron/common") return electronShim;
    throw new Error("preload required unexpected module: " + spec);
  }

  // The preload only exposes the desktop API when window.location.origin is an
  // allowed app origin (app://localhost / claude.ai / claude.com). We serve from
  // the Worker origin, so we hand the preload a `window` PROXY that reports a
  // claude.ai origin. Only the preload sees it — the SPA uses the real window
  // (and contextBridge.exposeInMainWorld writes to the real window via closure).
  function makePreloadWindow() {
    var rl = window.location;
    var fakeLoc = {
      href: "https://claude.ai" + rl.pathname + rl.search + rl.hash,
      origin: "https://claude.ai", protocol: "https:", host: "claude.ai", hostname: "claude.ai", port: "",
      pathname: rl.pathname, search: rl.search, hash: rl.hash,
      assign: function (u) { rl.assign(u); }, replace: function (u) { rl.replace(u); }, reload: function () { rl.reload(); },
      toString: function () { return this.href; },
    };
    return new Proxy(window, {
      get: function (t, p) { if (p === "location") return fakeLoc; var v = t[p]; return typeof v === "function" ? v.bind(t) : v; },
      set: function (t, p, v) { t[p] = v; return true; },
      has: function (t, p) { return p in t; },
    });
  }

  function runPreload(src) {
    var moduleObj = { exports: {} };
    try {
      var win = makePreloadWindow();
      // Pass `process` as a param so the preload's bare `process.argv` keeps its
      // value even after it does exposeInMainWorld("process", …) (which clobbers
      // window.process). Pass `window` proxy so its origin gate (claude.ai) passes.
      var fn = new Function("require", "module", "exports", "global", "globalThis", "window", "process", src + "\n//# sourceURL=" + PRELOAD_URL);
      fn(requireShim, moduleObj, moduleObj.exports, win, win, win, preloadProcess || window.process);
      document.documentElement && document.documentElement.setAttribute("data-bridge-preload", "ran");
      var exposed = ["claude.web", "claude.settings"].filter(function (k) { return typeof window[k] !== "undefined"; });
      log("real preload executed; desktop namespaces exposed:", exposed.join(",") || "NONE");
    } catch (e) {
      document.documentElement && document.documentElement.setAttribute("data-bridge-preload", "error");
      console.error(LOGPREFIX, "preload execution failed:", e);
    }
  }

  var BOOT_URL = window.__BRIDGE_BOOT_URL__ || "/__bridge/boot";
  var preloadProcess = null; // the argv-bearing process passed INTO the preload
  function setupProcess(argv) {
    var p = window.process && typeof window.process === "object" ? window.process : {};
    p.argv = argv;
    p.env = p.env || {};
    p.platform = p.platform || "linux";
    p.arch = p.arch || "x64";
    p.version = p.version || "1.10628.0";
    p.versions = p.versions || { electron: "41.6.1", chrome: "146.0.7680.216", node: "24.16.0" };
    if (typeof p.cwd !== "function") p.cwd = function () { return "/"; };
    if (typeof p.nextTick !== "function") p.nextTick = function (f) { Promise.resolve().then(f); };
    if (typeof p.on !== "function") p.on = function () { return p; };
    try { window.process = p; } catch (e) {}
    preloadProcess = p;
    return p;
  }

  var syncEnvelopes = {}; // logical sendSync channel -> {error,result} (from /boot)
  function fetchBootArgv() {
    // The real preload parses process.argv for --desktop-features/etc., and reads
    // {error,result} envelopes from the 15 sendSync channels. Fetch both
    // synchronously, BEFORE running the preload.
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", BOOT_URL, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        var boot = JSON.parse(xhr.responseText);
        if (boot && boot.sync && typeof boot.sync === "object") {
          syncEnvelopes = boot.sync;
          log("boot sync envelopes:", Object.keys(syncEnvelopes).length, "channels");
        }
        if (boot && boot.ready && Array.isArray(boot.argv) && boot.argv.some(function (a) { return /^--desktop-features=/.test(a); })) {
          log("boot argv from bridge:", boot.argv.length, "args");
          return boot.argv;
        }
        throw new Error("bridge /boot is not ready");
      }
    } catch (e) {
      throw new Error("bridge boot fetch failed: " + (e && e.message ? e.message : e));
    }
  }

  function loadPreloadSync() {
    try {
      setupProcess(fetchBootArgv()); // process.argv ready before the preload runs
      var xhr = new XMLHttpRequest();
      xhr.open("GET", PRELOAD_URL, false); // sync: must run before the SPA module
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) { runPreload(xhr.responseText); return true; }
      console.error(LOGPREFIX, "preload fetch failed", xhr.status);
    } catch (e) { console.error(LOGPREFIX, "preload sync load error", e); }
    return false;
  }

  // expose a tiny debug surface
  window.__CLAUDE_BRIDGE__ = {
    invoke: invoke, on: on, ipcRenderer: ipcRenderer, storeCache: storeCache,
    state: function () { return { open: open, pending: pending.size, listeners: listeners.size, ws: WS_URL }; },
  };

  // The SPA picks desktop-vs-web mode from navigator.userAgent
  // (/\b(?:Claude(?:Nest|Gov)?|Electron)\//i). Spoof it (before the SPA module
  // runs) so it enters desktop mode and uses the bridge-backed desktop API.
  function spoofDesktopUserAgent() {
    try {
      var nav = window.navigator;
      var ua = nav && nav.userAgent || "Mozilla/5.0";
      if (!/\b(?:Claude(?:Nest|Gov)?|Electron)\//i.test(ua)) {
        // Reproduce the GENUINE Claude Desktop UA byte-for-byte. A naive
        // `ua + " Claude/x Electron/y"` append leaves the live Chrome major
        // (e.g. 148) and tacks Claude/Electron after Safari — both reveal a
        // real browser and, crucially, the stale version fails desktop statsig
        // gates (appVersion-targeted) so the Chat/Cowork tabs never render.
        var APP_VER = "1.10628.0", CHROME_VER = "146.0.7680.216", ELECTRON_VER = "41.6.1", CHROMIUM_MAJOR = "146";
        var desktopUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
          + "Claude/" + APP_VER + " Chrome/" + CHROME_VER + " Electron/" + ELECTRON_VER + " Safari/537.36";
        Object.defineProperty(nav, "userAgent", { configurable: true, get: function () { return desktopUA; } });
        try { Object.defineProperty(nav, "appVersion", { configurable: true, get: function () { return desktopUA.replace(/^Mozilla\//, ""); } }); } catch (e) {}
        // userAgentData (Client Hints): the real Electron app exposes only
        // Chromium + Not-A.Brand (NO "Google Chrome" brand). Match it so any
        // brand/version sniffing also reads as desktop Electron, not Chrome.
        try {
          if (nav.userAgentData) {
            var brands = [{ brand: "Not-A.Brand", version: "24" }, { brand: "Chromium", version: CHROMIUM_MAJOR }];
            var uad = nav.userAgentData, proxy = Object.create(Object.getPrototypeOf(uad));
            Object.defineProperty(proxy, "brands", { get: function () { return brands.slice(); } });
            Object.defineProperty(proxy, "platform", { get: function () { return "macOS"; } });
            Object.defineProperty(proxy, "mobile", { get: function () { return false; } });
            proxy.getHighEntropyValues = function (hints) {
              return Promise.resolve({ brands: brands.slice(), fullVersionList: brands.slice(), platform: "macOS", platformVersion: "15.2.0", architecture: "arm", bitness: "64", mobile: false, model: "", uaFullVersion: CHROME_VER });
            };
            proxy.toJSON = function () { return { brands: brands.slice(), mobile: false, platform: "macOS" }; };
            Object.defineProperty(nav, "userAgentData", { configurable: true, get: function () { return proxy; } });
          }
        } catch (e) {}
        log("spoofed desktop userAgent (Claude/" + APP_VER + ")");
      }
    } catch (e) { warnOnce(warned, "ua-spoof", "userAgent spoof failed: " + (e && e.message)); }
  }

  // HEADLESS HOST-LOOP: this build's Chat tab is the chatIn3p merged local-agent
  // surface (chatIn3p:supported from the real main process). Its send goes through the
  // session-start gate (index.spa.js ~93272): `if (hostLoopMode || vmRunningStatus===
  // "ready") proceed; else startClaudeVM(); wait...`. There is no micro-VM on this
  // headless Linux host (claude-swift is macOS/Windows-only), so the VM never reports
  // "ready" and the send hangs. Force ClaudeVM.isHostLoopModeEnabled()=true so the SPA
  // bypasses the VM wait and runs the agent on the host. (Pairs with bridge.cjs
  // mirroring lastActiveOrg into the main-process session so
  // LocalAgentModeSessionManager.startSession resolves account+org.) NOTE: the agent
  // still needs to actually run in the container (claude binary + node-pty) and the
  // org's local-agent OAuth must be granted — goal steps 4-5.
  function forceHostLoopMode() {
    function patch() {
      try {
        var web = window["claude.web"]; var vm = web && web.ClaudeVM;
        if (vm && typeof vm.isHostLoopModeEnabled === "function" && !vm.__hostLoopForced) {
          try { Object.defineProperty(vm, "isHostLoopModeEnabled", { configurable: true, writable: true, value: function () { return true; } }); }
          catch (e) { try { vm.isHostLoopModeEnabled = function () { return true; }; } catch (e2) {} }
          vm.__hostLoopForced = true;
          log("forced ClaudeVM.isHostLoopModeEnabled=true (headless host-loop: run agent on host, bypass VM wait)");
          return true;
        }
      } catch (e) {}
      return false;
    }
    if (!patch()) { var n = 0; var iv = setInterval(function () { if (patch() || ++n > 150) clearInterval(iv); }, 20); }
  }

  // STALE-MODE GUARD: the renderer's "dframe-store" (zustand persist, _V store)
  // remembers lastKnownMode/pendingMode. If a stale "cowork" value survives (e.g. from
  // an earlier local-session attempt), the frame's mode effect (index.spa.js ~20308)
  // redirects "/new" -> the cowork route, but cowork is unavailable here (yukonSilver
  // unsupported / chat-only org) so the router bounces back to "/new" -> a synchronous
  // redirect cycle (vendor-router "Maximum call stack size exceeded") -> blank app.
  // Cowork is NEVER available in this split, so scrub any persisted "cowork" mode to
  // "chat" before the SPA reads it. Runs before the SPA module, so it pre-empts the loop.
  function sanitizeDframeStore() {
    try {
      var raw = window.localStorage && localStorage.getItem("dframe-store");
      if (!raw) return;
      var obj = JSON.parse(raw);
      var st = obj && obj.state;
      if (!st) return;
      var changed = false;
      if (st.lastKnownMode === "cowork") { st.lastKnownMode = "chat"; changed = true; }
      if (st.pendingMode === "cowork") { st.pendingMode = null; changed = true; }
      if (st.lastUnmergedMode === "cowork") { st.lastUnmergedMode = "chat"; changed = true; }
      if (changed) { localStorage.setItem("dframe-store", JSON.stringify(obj)); log("sanitised dframe-store: stale cowork mode -> chat (avoid router redirect loop)"); }
    } catch (e) { warnOnce(warned, "dframe-sanitise", "dframe-store sanitise failed: " + (e && e.message)); }
  }

  // Relay client-side failures + render loops into the monitor (:8900) via the
  // dev-server's /__bridge/clientlog. The router "Maximum call stack" recursion and
  // SPA exceptions are client-side — invisible to the bridge/HTTP taps — so without
  // this they never showed in the debug UI.
  function setupClientLogRelay() {
    try {
      var endpoint = "/__bridge/clientlog";
      var seen = Object.create(null);
      function post(row) {
        try {
          var body = JSON.stringify(row);
          if (navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
          else fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {});
        } catch (e) {}
      }
      function emit(kind, channel, value, error) {
        var key = kind + "|" + channel + "|" + (error || "");
        var now = Date.now();
        var rec = seen[key] || (seen[key] = { n: 0, t0: now, flagged: false });
        if (now - rec.t0 > 3000) { rec.n = 0; rec.t0 = now; rec.flagged = false; }
        rec.n++;
        if (rec.n >= 5) {
          if (rec.flagged) return; // suppress flood once flagged
          rec.flagged = true;
          post({ dir: "loop", source: "client", channel: channel, value: "⟳ LOOP ×" + rec.n + "+ in <3s — " + String(value || "").slice(0, 200), ok: false, error: error ? String(error).slice(0, 300) : undefined });
          return;
        }
        post({ dir: "error", source: "client", channel: channel, value: String(value || "").slice(0, 500), ok: false, error: error ? String(error).slice(0, 300) : undefined });
      }
      window.addEventListener("error", function (e) {
        var loc = e && e.filename ? (String(e.filename).split("/").pop() + ":" + e.lineno) : "window.onerror";
        emit("error", loc, (e && e.message) || "error", (e && e.error && e.error.stack) || (e && e.message));
      });
      window.addEventListener("unhandledrejection", function (e) {
        var r = e && e.reason;
        emit("error", "unhandledrejection", (r && r.message) || String(r), (r && r.stack) || String(r));
      });
      var origErr = console.error.bind(console);
      console.error = function () {
        try {
          var parts = Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : (typeof a === "string" ? a : (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })()); }).join(" ");
          if (parts && !/\[bridge-client/.test(parts)) emit("console.error", "console.error", parts, parts);
        } catch (e) {}
        return origErr.apply(console, arguments);
      };
      log("client-log relay → monitor active");
    } catch (e) {}
  }

  sanitizeDframeStore();
  spoofDesktopUserAgent();
  setupClientLogRelay();
  connect();
  loadPreloadSync();
  forceHostLoopMode();
})();
