import { describe, expect, it } from "vitest";
import { decodeEncodedWords, unfoldHeader } from "../../src/text/rfc2047.ts";

describe("unfoldHeader", () => {
  it("removes CRLF and LF folds but keeps the whitespace", () => {
    expect(unfoldHeader("Weekly\r\n picks")).toBe("Weekly picks");
    expect(unfoldHeader("a\n\tb")).toBe("a\tb");
    expect(unfoldHeader("  plain  ")).toBe("plain");
  });
});

describe("decodeEncodedWords", () => {
  it("decodes B (base64) UTF-8 words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6kgb2ZmZXJz?=")).toBe("Caf\u00e9 offers");
  });

  it("decodes Q words with underscores and hex escapes", () => {
    expect(decodeEncodedWords("=?utf-8?Q?Caf=C3=A9_offers?=")).toBe("Caf\u00e9 offers");
  });

  it("decodes ISO-8859-1", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9?=")).toBe("Caf\u00e9");
  });

  it("drops whitespace between adjacent encoded words only", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Hello?= =?UTF-8?Q?_world?= and more")).toBe("Hello world and more");
  });

  it("keeps plain text and undecodable words as they are", () => {
    expect(decodeEncodedWords("Plain subject")).toBe("Plain subject");
    expect(decodeEncodedWords("=?x-unknown-charset?Q?abc?=")).toBe("=?x-unknown-charset?Q?abc?=");
  });
});
