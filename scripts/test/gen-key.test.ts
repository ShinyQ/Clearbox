import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KEY_BYTES, generateKey, isValidKey } from "../gen-key.ts";

describe("generateKey", () => {
  it("returns standard base64 of 32 bytes", () => {
    const key = generateKey();
    assert.equal(key.length, 44);
    assert.equal(Buffer.from(key, "base64").length, KEY_BYTES);
    assert.ok(isValidKey(key));
  });

  it("uses the injected random source", () => {
    const key = generateKey((size) => new Uint8Array(size).fill(7));
    assert.equal(key, Buffer.alloc(32, 7).toString("base64"));
  });

  it("rejects a short random source", () => {
    assert.throws(() => generateKey((size) => new Uint8Array(size - 1)), /expected 32 random bytes/);
  });

  it("returns different keys on each call", () => {
    assert.notEqual(generateKey(), generateKey());
  });
});

describe("isValidKey", () => {
  it("rejects wrong lengths and alphabets", () => {
    assert.equal(isValidKey(Buffer.alloc(16, 1).toString("base64")), false);
    assert.equal(isValidKey(Buffer.alloc(32, 1).toString("base64url")), false);
    assert.equal(isValidKey(""), false);
  });
});
