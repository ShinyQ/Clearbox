import { ClearboxError } from "@clearbox/core";
import { base64UrlToBytes, bytesToBase64Url, utf8 } from "./base64.ts";

export async function importSigningKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ClearboxError("signing_key_invalid", "STATE_SIGNING_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signValue(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, utf8(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Constant-time verification through crypto.subtle.verify. */
export async function verifyValue(key: CryptoKey, value: string, signature: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sig, utf8(value));
}
