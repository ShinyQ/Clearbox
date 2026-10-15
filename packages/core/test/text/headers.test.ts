import { describe, expect, it } from "vitest";
import {
  headerValue,
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "../../src/text/headers.ts";

describe("headerValue", () => {
  const headers = [
    { name: "Subject", value: "Hello\r\n world" },
    { name: "subject", value: "second" },
  ];

  it("matches case-insensitively, returns the first, unfolded", () => {
    expect(headerValue(headers, "SUBJECT")).toBe("Hello world");
  });

  it("returns null when absent", () => {
    expect(headerValue(headers, "List-Id")).toBeNull();
  });
});

describe("parseAuthResults", () => {
  it("parses a Gmail header with an authserv-id", () => {
    const value =
      "mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass (google.com: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com";
    expect(parseAuthResults(value)).toEqual({
      authservId: "mx.google.com",
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    });
  });

  it("parses a Microsoft header without an authserv-id", () => {
    const value =
      "spf=softfail (sender IP is 192.0.2.1) smtp.mailfrom=example.net; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=example.net;compauth=fail reason=001";
    expect(parseAuthResults(value)).toEqual({ authservId: null, spf: "fail", dkim: "none", dmarc: "fail" });
  });

  it("treats any passing DKIM signature as pass and ignores text inside comments", () => {
    const value =
      "mx.google.com; dkim=fail header.d=a.example; dkim=pass header.d=b.example; spf=neutral (dmarc=pass in a comment)";
    expect(parseAuthResults(value)).toEqual({
      authservId: "mx.google.com",
      spf: "none",
      dkim: "pass",
      dmarc: "none",
    });
  });

  it("returns none for a missing header", () => {
    expect(parseAuthResults(null)).toEqual({ authservId: null, spf: "none", dkim: "none", dmarc: "none" });
  });

  it("strips deeply nested comments in linear time", () => {
    const value = "mx.example.test; spf=pass " + "(".repeat(50000) + ")".repeat(50000);
    expect(parseAuthResults(value)).toMatchObject({ authservId: "mx.example.test", spf: "pass" });
  });

  it("strips nested and escaped comments", () => {
    expect(parseAuthResults("mx.example.test; spf=(a (b) c)pass; dkim=fail (x \\) dkim=pass)")).toMatchObject(
      {
        spf: "pass",
        dkim: "fail",
      },
    );
  });
});

describe("parseListUnsubscribe", () => {
  it("splits https and mailto URIs", () => {
    expect(
      parseListUnsubscribe("<mailto:unsub@example.com?subject=unsubscribe>,\r\n <https://example.com/u/abc>"),
    ).toEqual({
      https: ["https://example.com/u/abc"],
      mailto: ["mailto:unsub@example.com?subject=unsubscribe"],
    });
  });

  it("ignores http and unbracketed values", () => {
    expect(parseListUnsubscribe("<http://example.com/u>, https://example.com/x")).toEqual({
      https: [],
      mailto: [],
    });
    expect(parseListUnsubscribe(null)).toEqual({ https: [], mailto: [] });
  });
});

describe("isBulkPrecedence", () => {
  it("accepts bulk, list and junk only", () => {
    expect(["bulk", " List ", "JUNK"].map(isBulkPrecedence)).toEqual([true, true, true]);
    expect(["first-class", "", null].map((v) => isBulkPrecedence(v))).toEqual([false, false, false]);
  });
});

describe("isAutoSubmitted", () => {
  it("is true for any value except no", () => {
    expect(isAutoSubmitted("auto-generated")).toBe(true);
    expect(isAutoSubmitted("auto-replied; owner-email=x@example.com")).toBe(true);
    expect(isAutoSubmitted("no")).toBe(false);
    expect(isAutoSubmitted(" No ")).toBe(false);
    expect(isAutoSubmitted(null)).toBe(false);
  });
});
