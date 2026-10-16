import { describe, expect, it } from "vitest";
import { parseAddress, parseAddressList, registrableDomain } from "../../src/text/address.ts";

describe("parseAddress", () => {
  it("parses quoted display names", () => {
    expect(parseAddress('"Shop, Inc." <News@Shop.Example.com>')).toEqual({
      address: "news@shop.example.com",
      name: "Shop, Inc.",
    });
  });

  it("parses unquoted names, bare and bracketed addresses, and comments", () => {
    expect(parseAddress("Example Shop <deals@example.com>")).toEqual({
      address: "deals@example.com",
      name: "Example Shop",
    });
    expect(parseAddress("<deals@example.com>")).toEqual({ address: "deals@example.com", name: null });
    expect(parseAddress("deals@example.com")).toEqual({ address: "deals@example.com", name: null });
    expect(parseAddress("deals@example.com (Example Deals)")).toEqual({
      address: "deals@example.com",
      name: "Example Deals",
    });
  });

  it("decodes RFC 2047 display names", () => {
    expect(parseAddress("=?UTF-8?B?Q2Fmw6k=?= <cafe@example.org>")).toEqual({
      address: "cafe@example.org",
      name: "Caf\u00e9",
    });
  });

  it("returns a null address when unparseable", () => {
    expect(parseAddress("undisclosed-recipients:;").address).toBeNull();
    expect(parseAddress("<>")).toEqual({ address: null, name: null });
    expect(parseAddress(null)).toEqual({ address: null, name: null });
  });

  it("ignores angle brackets inside a quoted display name", () => {
    expect(parseAddress('"PayPal <service@paypal.com>" <attacker@evil.example>')).toEqual({
      address: "attacker@evil.example",
      name: "PayPal <service@paypal.com>",
    });
    expect(parseAddress('"Smith <Sales>" <a@example.com>')).toEqual({
      address: "a@example.com",
      name: "Smith <Sales>",
    });
    expect(parseAddress('"Say \\"<x@y.example>\\"" <a@example.com>').address).toBe("a@example.com");
  });
});

describe("parseAddress bounds", () => {
  it("returns a null address quickly for a pathological dotted host", () => {
    const hostile = `<a@${".".repeat(100_000)},>`;
    expect(parseAddress(hostile).address).toBeNull();
    expect(parseAddressList(hostile)).toEqual([]);
  });

  it("rejects candidates longer than 254 characters and accepts 254", () => {
    const suffix = "@example.com";
    const atLimit = `${"a".repeat(254 - suffix.length)}${suffix}`;
    expect(parseAddress(atLimit).address).toBe(atLimit);
    expect(parseAddress(`${"a".repeat(255 - suffix.length)}${suffix}`).address).toBeNull();
  });

  it("rejects empty host labels", () => {
    expect(parseAddress("a@.example..com").address).toBeNull();
    expect(parseAddress("a@sub.example.co.uk").address).toBe("a@sub.example.co.uk");
  });
});

describe("parseAddressList", () => {
  it("splits on commas outside quotes and brackets", () => {
    const list = parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.net, Team <team@example.org>');
    expect(list.map((a) => a.address)).toEqual(["jane@example.com", "bob@example.net", "team@example.org"]);
    expect(list[0]?.name).toBe("Doe, Jane");
  });

  it("drops group names and empty groups", () => {
    expect(parseAddressList("friends: a@example.com, b@example.com;").map((a) => a.address)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("registrableDomain", () => {
  it("keeps the last two labels", () => {
    expect(registrableDomain("mail.news.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("News@Mail.Example.COM.")).toBe("example.com");
  });

  it("keeps three labels under known multi-part suffixes", () => {
    expect(registrableDomain("mail.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
  });

  it("handles empty, single-label and IP hosts", () => {
    expect(registrableDomain("")).toBe("");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("192.0.2.1")).toBe("192.0.2.1");
  });
});
