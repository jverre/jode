// ─────────────────────────────────────────────────────────────────────────────
// Codex on Cloudflare — jode remote environment.
//
// Serves the REAL Codex webview SPA to the browser, injects the bridge-client +
// real preload, and bridges the renderer's IPC back to the headless Codex main
// process running in the container (bridge.cjs on :8787 over /bridge WS).
//
//   • EVERY request   → Cloudflare Access JWT verified (@jode/edge), incl. WS upgrade
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
import {
  durableObjectStub,
  enforceAccess,
  htmlResponse,
  jsResponse,
  sharedWorkspaceEnv,
  type AccessEnv,
  type WorkspaceMountEnv,
} from "@jode/edge";
import { INDEX_HTML, BRIDGE_CLIENT_JS, PRELOAD_JS } from "./generated-assets";

const BRIDGE_PORT = 8787;
const STATIC_PREFIXES = ["/assets/", "/static/", "/fonts/", "/images/", "/favicon", "/manifest"];

type Env = AccessEnv & WorkspaceMountEnv & {
  ASSETS: Fetcher;
  CODEX_BRIDGE: DurableObjectNamespace;
  WORKSPACE: R2Bucket;
  // ── Shared filesystem + model config (injected into the container via envVars) ──
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
      ...sharedWorkspaceEnv(env),
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

function bridgeStub(env: Env) {
  return durableObjectStub(env.CODEX_BRIDGE, "default");
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
    if (url.pathname === "/__bridge/bridge-client.js") return jsResponse(BRIDGE_CLIENT_JS);
    if (url.pathname === "/__bridge/preload.js") return jsResponse(PRELOAD_JS);
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
    return htmlResponse(INDEX_HTML);
  },
} satisfies ExportedHandler<Env>;
