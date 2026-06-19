// @jode/auth — Cloudflare Access JWT verification + identity types.
//
// One implementation, used at the edge (the Worker gate in apps/claude-code) and
// referenced by the desktop app for login state. This replaces the prototype's
// hardcoded `split-bridge-key-v1` shared key: identity now comes from a verified
// Cloudflare Access JWT, gating every request including the /bridge WS upgrade.
//
// Runs in the Workers runtime — uses WebCrypto (`crypto.subtle`) and `fetch`,
// no Node APIs.

/** The verified identity carried by a Cloudflare Access JWT. */
export interface Identity {
  /** The `email` claim — the single allowlisted address for v1. */
  email: string;
  /** The Access application audience tag (`aud`). */
  aud: string;
  /** Subject identifier (`sub`). */
  sub: string;
}

export interface AccessConfig {
  /**
   * Team domain — the JWT issuer, e.g. `https://<team>.cloudflareaccess.com`
   * (no trailing slash). Public keys are fetched from `${teamDomain}/cdn-cgi/access/certs`.
   */
  teamDomain: string;
  /** The Access application audience tag (the `aud` claim to require). */
  aud: string;
  /** The single allowed email address (compared case-insensitively). */
  allowedEmail: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    /** HTTP status the edge gate should return for this failure. */
    readonly status: 401 | 403 = 403,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// ── base64url ────────────────────────────────────────────────────────────────
function b64urlToBytes(input: string): Uint8Array {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s.length % 4 ? s + "=".repeat(4 - (s.length % 4)) : s;
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input))) as T;
}

// ── JWKS cache ─────────────────────────────────────────────────────────────--
// Cloudflare rotates Access signing keys; cache the imported keys per team
// domain with a short TTL and refetch on an unknown `kid`.
interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  use?: string;
}
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
const jwksCache = new Map<string, { keys: Map<string, CryptoKey>; at: number }>();

async function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function fetchKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const certsUrl = `${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`;
  const resp = await fetch(certsUrl);
  if (!resp.ok) throw new AuthError(`failed to fetch Access certs (${resp.status})`, 403);
  const body = (await resp.json()) as { keys?: Jwk[] };
  if (!body.keys?.length) throw new AuthError("Access certs response had no keys", 403);
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) keys.set(jwk.kid, await importJwk(jwk));
  jwksCache.set(teamDomain, { keys, at: Date.now() });
  return keys;
}

async function getKey(teamDomain: string, kid: string): Promise<CryptoKey> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.at < JWKS_TTL_MS) {
    const hit = cached.keys.get(kid);
    if (hit) return hit;
  }
  // miss or stale or unknown kid → refetch once
  const keys = await fetchKeys(teamDomain);
  const key = keys.get(kid);
  if (!key) throw new AuthError(`no Access signing key for kid=${kid}`, 403);
  return key;
}

interface AccessClaims {
  aud?: string | string[];
  email?: string;
  sub?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
}

/**
 * Verify a Cloudflare Access JWT (the `Cf-Access-Jwt-Assertion` header / the
 * `CF_Authorization` cookie). Checks the RS256 signature against the team's
 * `/cdn-cgi/access/certs`, the issuer, expiry/not-before, the `aud` tag, and the
 * email claim. Returns the {@link Identity} on success.
 *
 * @throws {AuthError} on any failure (`.status` is 401 for a missing/malformed
 *   token, 403 for a token that fails verification or the allowlist).
 */
export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<Identity> {
  if (!token) throw new AuthError("missing Access token", 401);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed Access token", 401);
  const [rawHeader, rawPayload, rawSig] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = b64urlToJson(rawHeader);
  } catch {
    throw new AuthError("unparseable token header", 401);
  }
  if (header.alg !== "RS256") throw new AuthError(`unexpected alg ${header.alg}`, 403);
  if (!header.kid) throw new AuthError("token header missing kid", 403);

  const key = await getKey(config.teamDomain, header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSig) as BufferSource,
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`) as BufferSource,
  );
  if (!valid) throw new AuthError("bad token signature", 403);

  const claims = b64urlToJson<AccessClaims>(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now >= claims.exp) throw new AuthError("token expired", 403);
  if (typeof claims.nbf === "number" && now < claims.nbf) throw new AuthError("token not yet valid", 403);

  const expectedIss = config.teamDomain.replace(/\/$/, "");
  if (claims.iss && claims.iss.replace(/\/$/, "") !== expectedIss) {
    throw new AuthError("issuer mismatch", 403);
  }

  const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!auds.includes(config.aud)) throw new AuthError("audience mismatch", 403);

  const email = (claims.email || "").toLowerCase();
  if (!email || email !== config.allowedEmail.toLowerCase()) {
    throw new AuthError("email not allowed", 403);
  }

  return { email, aud: config.aud, sub: claims.sub || "" };
}

/** Extract the Access JWT from a request — header first, then the cookie. */
export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
