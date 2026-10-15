import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { http, HttpResponse } from "msw";

export const TEST_TEAM_DOMAIN = "https://test-team.cloudflareaccess.com";
export const TEST_AUD = "test-aud-0000000000000000000000000000000000000000000000000000000000";
export const TEST_OWNER = "owner@example.test";
export const TEST_KID = "test-kid";

const validPair = await generateKeyPair("RS256", { extractable: true });
const otherPair = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(validPair.publicKey)), kid: TEST_KID, alg: "RS256", use: "sig" };

/** Serves the Access JWKS (contracts 10.4). */
export function jwksHandler() {
  return http.get(`${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`, () => HttpResponse.json({ keys: [publicJwk] }));
}

export interface SignOptions {
  /** "other" signs with a key that is not in the JWKS but reuses the same kid. */
  key?: "valid" | "other";
  omit?: readonly string[];
}

export async function signAccessJwt(
  claims: Record<string, unknown> = {},
  options: SignOptions = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const full: Record<string, unknown> = {
    iss: TEST_TEAM_DOMAIN,
    aud: [TEST_AUD],
    email: TEST_OWNER,
    sub: "00000000-0000-4000-8000-000000000001",
    type: "app",
    iat: nowSec,
    nbf: nowSec - 5,
    exp: nowSec + 3600,
    ...claims,
  };
  const omit = options.omit ?? [];
  const payload = Object.fromEntries(Object.entries(full).filter(([k]) => !omit.includes(k)));
  const key = options.key === "other" ? otherPair.privateKey : validPair.privateKey;
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: TEST_KID }).sign(key);
}
