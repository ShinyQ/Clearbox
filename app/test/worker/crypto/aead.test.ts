import { ClearboxError } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import {
  CURRENT_KEY_VERSION,
  decryptToken,
  encryptToken,
  importEncKey,
  tokenAad,
} from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes, fromUtf8 } from "../../../src/worker/crypto/base64.ts";

const RAW_KEY = base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
const CTX = { accountId: "acc_0123456789abcdef", kind: "refresh" as const, keyVersion: CURRENT_KEY_VERSION };

describe("token encryption", () => {
  it("builds the contracts 7.15 AAD", () => {
    expect(fromUtf8(tokenAad(CTX))).toBe("clearbox|acc_0123456789abcdef|refresh|v1");
  });

  it("round trips and uses a fresh 12-byte IV per value", async () => {
    const key = await importEncKey(RAW_KEY);
    const a = await encryptToken(key, "refresh-token-value", CTX);
    const b = await encryptToken(key, "refresh-token-value", CTX);
    expect(a.iv.length).toBe(12);
    expect(a.ciphertext.length).toBe("refresh-token-value".length + 16);
    expect(a.iv).not.toEqual(b.iv);
    expect(await decryptToken(key, a, CTX)).toBe("refresh-token-value");
  });

  it("rejects a different account, kind or key version (AAD mismatch)", async () => {
    const key = await importEncKey(RAW_KEY);
    const value = await encryptToken(key, "secret", CTX);
    for (const ctx of [
      { ...CTX, accountId: "acc_ffffffffffffffff" },
      { ...CTX, kind: "access" as const },
      { ...CTX, keyVersion: 2 },
    ]) {
      await expect(decryptToken(key, value, ctx)).rejects.toMatchObject({ code: "token_decrypt_failed" });
    }
  });

  it("detects tampered ciphertext and IV", async () => {
    const key = await importEncKey(RAW_KEY);
    const value = await encryptToken(key, "secret", CTX);
    const ciphertext = Uint8Array.from(value.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await expect(decryptToken(key, { ...value, ciphertext }, CTX)).rejects.toBeInstanceOf(ClearboxError);
    const iv = Uint8Array.from(value.iv);
    iv[0] = (iv[0] ?? 0) ^ 1;
    await expect(decryptToken(key, { ...value, iv }, CTX)).rejects.toBeInstanceOf(ClearboxError);
  });

  it("rejects a wrong key", async () => {
    const value = await encryptToken(await importEncKey(RAW_KEY), "secret", CTX);
    const other = await importEncKey(base64ToBytes("HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA="));
    await expect(decryptToken(other, value, CTX)).rejects.toMatchObject({ code: "token_decrypt_failed" });
  });

  it("refuses keys that are not 32 bytes", async () => {
    await expect(importEncKey(new Uint8Array(16))).rejects.toMatchObject({ code: "token_key_invalid" });
  });
});
