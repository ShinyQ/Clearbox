import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { importSigningKey, signValue, verifyValue } from "../../../src/worker/crypto/hmac.ts";

const RAW = base64ToBytes("HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=");

describe("HMAC signing", () => {
  it("verifies its own signature", async () => {
    const key = await importSigningKey(RAW);
    const sig = await signValue(key, "payload");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyValue(key, "payload", sig)).toBe(true);
  });

  it("rejects altered values, altered or malformed signatures and other keys", async () => {
    const key = await importSigningKey(RAW);
    const sig = await signValue(key, "payload");
    expect(await verifyValue(key, "payload2", sig)).toBe(false);
    // Flip the first character: it carries 6 signature bits (the last one partly carries padding bits).
    expect(await verifyValue(key, "payload", (sig.startsWith("A") ? "B" : "A") + sig.slice(1))).toBe(false);
    expect(await verifyValue(key, "payload", "not+base64url")).toBe(false);
    const other = await importSigningKey(base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="));
    expect(await verifyValue(other, "payload", sig)).toBe(false);
  });

  it("refuses keys that are not 32 bytes", async () => {
    await expect(importSigningKey(new Uint8Array(8))).rejects.toMatchObject({ code: "signing_key_invalid" });
  });
});
