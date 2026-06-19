import { AuthError, extractAccessToken, verifyAccessJwt } from "@jode/auth";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
}

export interface WorkspaceMountEnv {
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
}

export async function enforceAccess(request: Request, env: AccessEnv): Promise<Response | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    return textResponse("Access not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAIL)", 503);
  }

  const token = extractAccessToken(request);
  if (!token) return textResponse("unauthorized: no Cloudflare Access token", 401);

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
    return textResponse("forbidden", status);
  }
}

export function durableObjectStub(
  namespace: DurableObjectNamespace,
  name: string,
  options?: DurableObjectNamespaceGetDurableObjectOptions,
): DurableObjectStub {
  return namespace.get(namespace.idFromName(name), options);
}

export function sharedWorkspaceEnv(env: WorkspaceMountEnv): Record<string, string> {
  const missing = [
    ["R2_ENDPOINT", env.R2_ENDPOINT],
    ["R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID],
    ["R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY],
    ["R2_BUCKET", env.R2_BUCKET],
  ].filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Shared workspace is not configured: missing ${missing.map(([key]) => key).join(", ")}`);
  }

  return {
    R2_ENDPOINT: env.R2_ENDPOINT ?? "",
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
    R2_BUCKET: env.R2_BUCKET ?? "",
  };
}

export function jsResponse(body: string): Response {
  return typedNoStoreResponse(body, "text/javascript; charset=utf-8");
}

export function htmlResponse(body: string): Response {
  return typedNoStoreResponse(body, "text/html; charset=utf-8");
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function typedNoStoreResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
