import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALLOW_MARKER, isProbablyBinary, scanText } from "../check-text.ts";

// Secret-shaped inputs are assembled at runtime so this file never matches its own rules.
const join = (...parts: string[]): string => parts.join("");

function rulesFor(text: string): string[] {
  return scanText("x.txt", text).map((f) => f.rule);
}

describe("scanText", () => {
  it("flags an em dash with line and column", () => {
    const findings = scanText("doc.md", `first line\nsecond ${"\u2014"} line`);
    assert.deepEqual(findings, [{ path: "doc.md", line: 2, column: 8, rule: "em-dash" }]);
  });

  it("allows en dashes and plain hyphens", () => {
    assert.deepEqual(rulesFor("ranges 1\u20135 and a - b"), []);
  });

  it("never exempts em dashes, even with the allow marker", () => {
    assert.deepEqual(rulesFor(`a ${"\u2014"} b // ${ALLOW_MARKER}`), ["em-dash"]);
  });

  it("flags private key blocks", () => {
    assert.deepEqual(rulesFor(join("-----", "BEGIN RSA PRIVATE KEY", "-----")), ["private-key"]);
    assert.deepEqual(rulesFor(join("-----", "BEGIN PRIVATE KEY", "-----")), ["private-key"]);
  });

  it("flags a real-looking AZURE_DECISION_KEY", () => {
    const rules = rulesFor(join("AZURE_DECISION_KEY", "=", "a1B2c3D4e5F6g7H8i9J0k1L2"));
    assert.ok(rules.includes("azure-decision-key"));
  });

  it("accepts placeholder dotenv values", () => {
    assert.deepEqual(
      rulesFor("AZURE_DECISION_KEY=<key>\nTOKEN_ENC_KEY=<pnpm gen-key>\nACCESS_AUD=<access-aud-tag>"),
      [],
    );
  });

  it("flags literal Clearbox secrets in dotenv files", () => {
    assert.deepEqual(rulesFor(join("TOKEN_ENC_KEY", "=", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")), [
      "clearbox-secret-assignment",
    ]);
  });

  it("flags common provider token shapes", () => {
    const cases: [string, string][] = [
      [join("AKIA", "ABCDEFGHIJKLMNOP"), "aws-access-key"],
      [join("ghp", "_", "a".repeat(36)), "github-token"],
      [join("github", "_pat_", "b".repeat(30)), "github-token"],
      [join("AIza", "c".repeat(35)), "google-api-key"],
      [join("GOCSPX", "-", "d".repeat(28)), "google-oauth-secret"],
      [join("abc", "8Q~", "e".repeat(32)), "entra-client-secret"],
      [join("xoxb", "-", "1234567890-abc"), "slack-token"],
      [join("AccountKey", "=", "f".repeat(86), "=="), "azure-storage-key"],
      [join("eyJ", "hbGciOiJSUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "g".repeat(20)), "jwt"],
    ];
    for (const [text, rule] of cases) assert.deepEqual(rulesFor(text), [rule], rule);
  });

  it("exempts allowable rules on lines with the allow marker", () => {
    assert.deepEqual(rulesFor(`${join("AKIA", "ABCDEFGHIJKLMNOP")} // ${ALLOW_MARKER}`), []);
  });

  it("does not flag the synthetic base64 test keys or ordinary prose", () => {
    const text =
      'TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",\nThe key is set by pnpm setup:cf.';
    assert.deepEqual(rulesFor(text), []);
  });
});

describe("isProbablyBinary", () => {
  it("detects NUL bytes", () => {
    assert.equal(isProbablyBinary(new Uint8Array([72, 0, 73])), true);
    assert.equal(isProbablyBinary(new TextEncoder().encode("plain text")), false);
  });
});
