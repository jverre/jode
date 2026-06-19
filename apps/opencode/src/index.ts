// ─────────────────────────────────────────────────────────────────────────────
// OpenCode on Cloudflare — jode remote environment (sibling of @jode/claude-code).
//
// Unlike the Claude Code app, OpenCode ships a real headless server (`opencode
// serve`) that serves its OWN web UI, JSON API, and terminal WebSocket on a
// single port (4096), with the production UI auto-connecting to `location.origin`.
// So this Worker is a *pure authenticated reverse proxy*: no SPA injection, no
// payload, no bridge — verify the Cloudflare Access identity, then forward every
// request (HTTP + WS) to the container running `opencode serve`.
//
//   • EVERY request   → Cloudflare Access JWT verified (@jode/edge), incl. WS upgrade
//   • all paths       → reverse-proxy to the container on :4096 (UI + API + WS)
//   • /workspace      → persisted to R2 by the container (see scripts/entrypoint.sh)
// ─────────────────────────────────────────────────────────────────────────────
import { Container } from "@cloudflare/containers";
import {
  durableObjectStub,
  enforceAccess,
  sharedWorkspaceEnv,
  type AccessEnv,
  type WorkspaceMountEnv,
} from "@jode/edge";

const OPENCODE_PORT = 4096;

type Env = AccessEnv & WorkspaceMountEnv & {
  OPENCODE: DurableObjectNamespace;
  WORKSPACE: R2Bucket;
  // ── Shared filesystem + model config, injected into the container via envVars ──
  /** Model provider key(s) the agent uses (secret). */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

export class OpencodeContainer extends Container {
  defaultPort = OPENCODE_PORT;
  requiredPorts = [OPENCODE_PORT];
  // Let the container sleep when idle to save money. /workspace is a live FUSE
  // mount of the shared R2 bucket, so a sleep loses nothing — the files are in
  // the bucket, not on the container disk.
  sleepAfter = "30m";

  override async fetch(request: Request): Promise<Response> {
    // Inject secrets into the container BEFORE it starts, so they live only as
    // Worker secrets (`wrangler secret put ...`) — never baked into the image.
    // No-op once the container is already running.
    const env = this.env as Env;
    this.envVars = {
      ...this.envVars,
      ...sharedWorkspaceEnv(env),
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    };

    await this.startAndWaitForPorts();
    // Forward HTTP and WebSocket upgrades straight through to opencode serve.
    return this.containerFetch(request, OPENCODE_PORT);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await enforceAccess(request, env);
    if (denied) return denied;

    // One shared workspace instance (max_instances=1). To make it multi-tenant,
    // key the DO id off the verified Access email so each user gets their own
    // container + their own R2 workspace snapshot — see README.
    const stub = durableObjectStub(env.OPENCODE, "default");
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
