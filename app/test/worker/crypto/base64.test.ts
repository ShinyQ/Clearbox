import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesFromBlob,
  bytesToBase64,
  bytesToBase64Url,
  fromUtf8,
  utf8,
} from "../../../src/worker/crypto/base64.ts";

describe("base64", () => {
  it("round trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
  it("decodes the contracts test key to 32 bytes", () => {
    const key = base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    expect(key.length).toBe(32);
    expect(key[31]).toBe(31);
  });
  it("rejects malformed base64", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
    expect(() => base64ToBytes("abc")).toThrow();
  });
});

describe("base64url", () => {
  it("uses the url alphabet without padding", () => {
    const encoded = bytesToBase64Url(new Uint8Array([251, 255, 191]));
    expect(encoded).toBe("-_-_");
    expect(base64UrlToBytes(encoded)).toEqual(new Uint8Array([251, 255, 191]));
  });
  it("round trips lengths that need padding", () => {
    for (const n of [1, 2, 3, 4, 5, 16, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });
  it("rejects characters outside the url alphabet", () => {
    expect(() => base64UrlToBytes("ab+c")).toThrow();
    expect(() => base64UrlToBytes("ab=c")).toThrow();
  });
});

describe("utf8 and bytesFromBlob", () => {
  it("round trips text", () => {
    expect(fromUtf8(utf8("héllo"))).toBe("héllo");
  });
  it("normalizes D1 blob shapes", () => {
    expect(bytesFromBlob(null)).toBeNull();
    expect(bytesFromBlob([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytesFromBlob(new Uint8Array([4, 5]).buffer)).toEqual(new Uint8Array([4, 5]));
    expect(bytesFromBlob(new Uint8Array([6]))).toEqual(new Uint8Array([6]));
    expect(() => bytesFromBlob("text")).toThrow();
  });
});
