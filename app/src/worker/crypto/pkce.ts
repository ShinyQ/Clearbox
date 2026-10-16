import { bytesToBase64Url, utf8 } from "./base64.ts";

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** 32 random bytes, base64url: 43 chars of [A-Za-z0-9_-] (RFC 7636 section 4.1). */
export function createVerifier(): string {
  return randomBase64Url(32);
}

export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
