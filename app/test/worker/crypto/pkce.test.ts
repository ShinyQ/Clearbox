import { describe, expect, it } from "vitest";
import { challengeS256, createVerifier, randomBase64Url } from "../../../src/worker/crypto/pkce.ts";

describe("PKCE", () => {
  it("creates 43-char verifiers from the unreserved alphabet", () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
  });

  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("encodes 16 random bytes as 22 chars", () => {
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
