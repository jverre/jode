// jode web app — Cloudflare Worker.
//
// Serves the built shell SPA (the rail) and gates it with Cloudflare Access,
// exactly like the agent Workers. The SPA frames each agent's hosted Worker in
// an iframe; those subdomains belong to the same Access app, so once the user is
// signed in here the iframes authenticate via the shared Access SSO. The Worker
// itself does not proxy agents — it only serves static assets.
import { verifyAccessJwt, extractAccessToken, AuthError } from "@jode/auth";

interface Env {
  /** The built SPA (./dist), bound in wrangler.toml. */
  ASSETS: Fetcher;
  // ── Cloudflare Access gate (verified by @jode/auth) ──
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  /** Local-dev only: "true" in .dev.vars skips Access verification. NEVER set in
   *  wrangler.toml [vars]. */
  ACCESS_DEV_BYPASS?: string;
}

// Verify the Access JWT before serving anything. Fail closed: missing config →
// 503; missing/invalid identity → 401/403. Mirrors the agent Workers so the
// shell is gated identically (defense-in-depth on top of the edge Access app).
async function enforceAccess(request: Request, env: Env): Promise<Response | null> {
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
    return null;
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
    return env.ASSETS.fetch(request);
  },
};
