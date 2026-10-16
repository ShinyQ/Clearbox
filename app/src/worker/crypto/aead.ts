import { ClearboxError } from "@clearbox/core";
import { fromUtf8, utf8 } from "./base64.ts";

/** Version written into the AAD of newly encrypted values (accounts.key_version). */
export const CURRENT_KEY_VERSION = 1;

export type TokenKind = "refresh" | "access";

export interface TokenContext {
  accountId: string;
  kind: TokenKind;
  keyVersion: number;
}

export interface EncryptedValue {
  /** AES-GCM output including the 16-byte tag. */
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

export function tokenAad(ctx: TokenContext): Uint8Array<ArrayBuffer> {
  return utf8(`clearbox|${ctx.accountId}|${ctx.kind}|v${ctx.keyVersion}`);
}

export async function importEncKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ClearboxError("token_key_invalid", "TOKEN_ENC_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(
  key: CryptoKey,
  plaintext: string,
  ctx: TokenContext,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAad(ctx) },
    key,
    utf8(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptToken(
  key: CryptoKey,
  value: EncryptedValue,
  ctx: TokenContext,
): Promise<string> {
  try {
    if (value.iv.length !== 12) throw new Error("bad iv length");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: value.iv, additionalData: tokenAad(ctx) },
      key,
      value.ciphertext,
    );
    return fromUtf8(new Uint8Array(plaintext));
  } catch (cause) {
    throw new ClearboxError("token_decrypt_failed", "Token decryption failed", { cause });
  }
}
