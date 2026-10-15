import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { readConfig } from "../env.ts";
import type { AppConfig, AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "./errors.ts";

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

/** One JWKS object per team domain per isolate: jose caches keys and refetches on unknown kid. */
const jwksCache = new Map<string, RemoteJwks>();

export function resetJwksCache(): void {
  jwksCache.clear();
}

function jwksFor(teamDomain: string): RemoteJwks {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export type AccessVerdict = { ok: true; email: string } | { ok: false; reason: "invalid" | "wrong_email" };

export async function verifyAccessJwt(token: string, config: AppConfig, now: number): Promise<AccessVerdict> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(config.accessTeamDomain), {
      issuer: config.accessTeamDomain,
      audience: config.accessAud,
      algorithms: ["RS256"],
      currentDate: new Date(now),
    }));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const claim = payload["email"];
  const email = typeof claim === "string" ? claim.trim().toLowerCase() : "";
  if (email === "" || email !== config.ownerEmail) return { ok: false, reason: "wrong_email" };
  return { ok: true, email };
}

export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Contracts 7.1 accessGuard. Runs on /api/* and /oauth/*. */
export const accessGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const route = routePath(c);
  const result = readConfig(c.env);
  if (!result.ok) {
    logEvent("config.invalid", { missing: result.invalid.join(",") });
    logEvent("access.denied", { reason: "misconfigured", route });
    throw new ApiError(500, "access_misconfigured", "Access is not configured");
  }
  const config = result.config;
  c.set("config", config);

  // readConfig already rejects DEV_AUTH_BYPASS=true outside development.
  if (
    config.devAuthBypass &&
    config.environment === "development" &&
    isLocalHostname(new URL(c.req.url).hostname)
  ) {
    c.set("ownerEmail", config.ownerEmail);
    await next();
    return;
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    logEvent("access.denied", { reason: "missing", route });
    throw new ApiError(401, "unauthenticated", "Authentication required");
  }
  // JWT exp/nbf are wall-clock claims; they are always checked against the real clock, not deps.now.
  const verdict = await verifyAccessJwt(token, config, Date.now());
  if (!verdict.ok) {
    logEvent("access.denied", { reason: verdict.reason, route });
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  c.set("ownerEmail", verdict.email);
  await next();
};
