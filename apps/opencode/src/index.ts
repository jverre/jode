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
//   • EVERY request   → Cloudflare Access JWT verified (@jode/auth), incl. WS upgrade
//   • all paths       → reverse-proxy to the container on :4096 (UI + API + WS)
//   • /workspace      → persisted to R2 by the container (see scripts/entrypoint.sh)
// ─────────────────────────────────────────────────────────────────────────────
import { Container } from "@cloudflare/containers";
import { verifyAccessJwt, extractAccessToken, AuthError } from "@jode/auth";

const OPENCODE_PORT = 4096;

type Env = {
  OPENCODE: DurableObjectNamespace;
  WORKSPACE: R2Bucket;
  // ── Cloudflare Access gate (verified by @jode/auth) ──
  /** Team domain / JWT issuer, e.g. https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience tag (the `aud` claim to require). */
  ACCESS_AUD: string;
  /** The single allowed email address. */
  ALLOWED_EMAIL: string;
  /** Local-dev only: set to "true" in .dev.vars to skip Access verification.
   *  NEVER set in wrangler.toml [vars] — production must always verify. */
  ACCESS_DEV_BYPASS?: string;
  // ── Shared filesystem + model config, injected into the container via envVars ──
  /** S3 creds for the SHARED jode filesystem (one R2 bucket FUSE-mounted at
   *  /workspace by every tool). Endpoint e.g.
   *  https://<ACCOUNT_ID>.r2.cloudflarestorage.com (secret). */
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET: string;
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
      R2_ENDPOINT: env.R2_ENDPOINT ?? "",
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      R2_BUCKET: env.R2_BUCKET ?? "",
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
      OPENAI_API_KEY: env.OPENAI_API_KEY ?? "",
    };

    await this.startAndWaitForPorts();
    // Forward HTTP and WebSocket upgrades straight through to opencode serve.
    return this.containerFetch(request, OPENCODE_PORT);
  }
}

// ── Cloudflare Access gate ───────────────────────────────────────────────────
// Verify the Access JWT on EVERY request (including the terminal WS upgrade)
// before any routing. Fail closed: missing config → 503; missing/invalid
// identity → 401/403. Identical model to @jode/claude-code. This is the PRIMARY
// authentication — the container (which runs arbitrary commands) is never
// reachable without a verified, allowlisted Access identity.
async function enforceAccess(request: Request, env: Env): Promise<Response | null> {
  // Local `wrangler dev` can't mint a real Access JWT, so allow an explicit
  // opt-out that lives ONLY in .dev.vars (never in wrangler.toml [vars]). This
  // lets the desktop webview load the agent during `npm run dev`.
  if (env.ACCESS_DEV_BYPASS === "true") return null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    return new Response("Access not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAIL)", { status: 503 });
  }
  const token = extractAccessToken(request);
  if (!token) return new Response("unauthorized: no Cloudflare Access token", { status: 401 });
  try {
    await verifyAccessJwt(token, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      allowedEmail: env.ALLOWED_EMAIL,
    });
    return null; // authorized
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    console.log(`[access] rejected: ${(e as Error).message}`);
    return new Response("forbidden", { status });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = await enforceAccess(request, env);
    if (denied) return denied;

    // One shared workspace instance (max_instances=1). To make it multi-tenant,
    // key the DO id off the verified Access email so each user gets their own
    // container + their own R2 workspace snapshot — see README.
    const id = env.OPENCODE.idFromName("default");
    const stub = env.OPENCODE.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
