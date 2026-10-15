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
