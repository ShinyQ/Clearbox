import type { ProviderKind } from "@clearbox/core";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import { signValue, verifyValue } from "../crypto/hmac.ts";
import { createVerifier, randomBase64Url } from "../crypto/pkce.ts";

export const OAUTH_COOKIE_NAME = "__Host-clearbox_oauth";
export const OAUTH_COOKIE_TTL_MS = 600_000;
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export interface OAuthStatePayload {
  p: ProviderKind;
  /** Nonce, sent to the provider as `state`. */
  n: string;
  /** PKCE verifier. */
  v: string;
  /** Expiry, epoch ms. */
  e: number;
}

const PayloadSchema = z.strictObject({
  p: z.enum(["gmail", "outlook"]),
  n: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  v: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  e: z.int(),
});

export type StateFailure =
  "missing" | "malformed" | "bad_signature" | "expired" | "provider_mismatch" | "state_mismatch";

export const CLEAR_OAUTH_COOKIE = `${OAUTH_COOKIE_NAME}=; Max-Age=0; ${ATTRIBUTES}`;

export async function createOAuthState(
  key: CryptoKey,
  provider: ProviderKind,
  now: number,
): Promise<{ payload: OAuthStatePayload; setCookie: string }> {
  const payload: OAuthStatePayload = {
    p: provider,
    n: randomBase64Url(16),
    v: createVerifier(),
    e: now + OAUTH_COOKIE_TTL_MS,
  };
  const body = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const value = `${body}.${await signValue(key, body)}`;
  return {
    payload,
    setCookie: `${OAUTH_COOKIE_NAME}=${value}; Max-Age=${OAUTH_COOKIE_TTL_MS / 1000}; ${ATTRIBUTES}`,
  };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Contracts 7.12 check order: present, HMAC, not expired, provider, state. */
export async function verifyOAuthState(
  key: CryptoKey,
  cookieHeader: string | null,
  provider: ProviderKind,
  state: string | null,
  now: number,
): Promise<{ ok: true; payload: OAuthStatePayload } | { ok: false; reason: StateFailure }> {
  const value = readCookie(cookieHeader, OAUTH_COOKIE_NAME);
  if (!value) return { ok: false, reason: "missing" };
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { ok: false, reason: "malformed" };
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!(await verifyValue(key, body, signature))) return { ok: false, reason: "bad_signature" };
  let payload: OAuthStatePayload;
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(fromUtf8(base64UrlToBytes(body))));
    if (!parsed.success) return { ok: false, reason: "malformed" };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.e <= now) return { ok: false, reason: "expired" };
  if (payload.p !== provider) return { ok: false, reason: "provider_mismatch" };
  if (state === null || state !== payload.n) return { ok: false, reason: "state_mismatch" };
  return { ok: true, payload };
}
