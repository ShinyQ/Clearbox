import { describe, expect, it } from "vitest";
import {
  UNSUBSCRIBE_URL_MAX_CHARS,
  checkUnsubscribeUrl,
  isOneClickPost,
  oneClickTarget,
} from "../../src/text/unsubscribe.ts";

describe("isOneClickPost", () => {
  it("accepts exactly the RFC 8058 pair, case-insensitive and trimmed", () => {
    expect(isOneClickPost("List-Unsubscribe=One-Click")).toBe(true);
    expect(isOneClickPost("  list-unsubscribe=one-click ")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isOneClickPost(null)).toBe(false);
    expect(isOneClickPost("")).toBe(false);
    expect(isOneClickPost("List-Unsubscribe=One-Click&email=a@example.com")).toBe(false);
    expect(isOneClickPost("List-Unsubscribe=Yes")).toBe(false);
  });
});

describe("oneClickTarget", () => {
  const post = "List-Unsubscribe=One-Click";

  it("returns the first https URI and ignores mailto", () => {
    expect(
      oneClickTarget("<mailto:u@shop.example.com?subject=unsub>, <https://shop.example.com/u/abc>", post),
    ).toBe("https://shop.example.com/u/abc");
    expect(oneClickTarget("<https://a.example.com/1>, <https://b.example.com/2>", post)).toBe(
      "https://a.example.com/1",
    );
  });

  it("handles folded headers and spaces inside the angle brackets", () => {
    expect(oneClickTarget("<mailto:u@shop.example.com>,\r\n < https://shop.example.com/u/abc >", post)).toBe(
      "https://shop.example.com/u/abc",
    );
  });

  it("returns null without the one-click post header, without https, or for bare URLs", () => {
    expect(oneClickTarget("<https://shop.example.com/u/abc>", null)).toBeNull();
    expect(oneClickTarget("<mailto:u@shop.example.com>", post)).toBeNull();
    expect(oneClickTarget("<http://shop.example.com/u/abc>", post)).toBeNull();
    expect(oneClickTarget("https://shop.example.com/u/abc", post)).toBeNull();
    expect(oneClickTarget(null, post)).toBeNull();
    expect(oneClickTarget("", post)).toBeNull();
  });
});

describe("checkUnsubscribeUrl", () => {
  const reason = (raw: string, ownHost?: string) => {
    const r = checkUnsubscribeUrl(raw, { ownHost: ownHost ?? null });
    return r.ok ? "ok" : r.reason;
  };

  it("accepts a public https URL and drops the fragment", () => {
    expect(checkUnsubscribeUrl("https://Shop.Example.com/u/abc?t=1#frag")).toEqual({
      ok: true,
      url: "https://shop.example.com/u/abc?t=1",
    });
    expect(reason("https://shop.example.com:443/u")).toBe("ok");
  });

  it("rejects non-https schemes", () => {
    expect(reason("http://shop.example.com/u")).toBe("not_https");
    expect(reason("javascript:alert(1)")).toBe("not_https");
    expect(reason("data:text/html,x")).toBe("not_https");
    expect(reason("file:///etc/passwd")).toBe("not_https");
  });

  it("rejects credentials and explicit ports", () => {
    expect(reason("https://user:pass@shop.example.com/u")).toBe("credentials");
    expect(reason("https://user@shop.example.com/u")).toBe("credentials");
    expect(reason("https://shop.example.com:8443/u")).toBe("port");
  });

  it("rejects IP literals, including encoded IPv4 forms", () => {
    expect(reason("https://127.0.0.1/u")).toBe("ip_literal");
    expect(reason("https://10.0.0.5/u")).toBe("ip_literal");
    expect(reason("https://169.254.169.254/latest")).toBe("ip_literal");
    expect(reason("https://[::1]/u")).toBe("ip_literal");
    expect(reason("https://[fd00::1]/u")).toBe("ip_literal");
    expect(reason("https://2130706433/u")).toBe("ip_literal");
    expect(reason("https://0x7f.1/u")).toBe("ip_literal");
  });

  it("rejects local, reserved and single-label hosts", () => {
    expect(reason("https://localhost/u")).toBe("local_host");
    expect(reason("https://api.localhost/u")).toBe("local_host");
    expect(reason("https://printer.local/u")).toBe("local_host");
    expect(reason("https://svc.internal/u")).toBe("local_host");
    expect(reason("https://router.home.arpa/u")).toBe("local_host");
    expect(reason("https://intranet/u")).toBe("local_host");
    expect(reason("https://x.onion/u")).toBe("local_host");
  });

  it("rejects the app's own host", () => {
    expect(reason("https://clearbox.example.test/api/accounts", "clearbox.example.test")).toBe("own_host");
    expect(reason("https://CLEARBOX.example.test./api", "clearbox.example.test")).toBe("own_host");
  });

  it("rejects header-injection and whitespace attempts before parsing", () => {
    expect(reason("https://shop.example.com/u\r\nX-Injected: 1")).toBe("invalid_chars");
    expect(reason("https://shop.example.com/u\tx")).toBe("invalid_chars");
    expect(reason("https://shop.example.com/u x")).toBe("invalid_chars");
    expect(reason("https://shöp.example.com/u")).toBe("invalid_chars");
    expect(reason("https://shop.example.com/u\u0000")).toBe("invalid_chars");
  });

  it("rejects overlong and malformed URLs", () => {
    expect(reason(`https://shop.example.com/${"a".repeat(UNSUBSCRIBE_URL_MAX_CHARS)}`)).toBe("too_long");
    expect(reason("https://")).toBe("malformed");
    expect(reason("not a url")).toBe("invalid_chars");
    expect(reason("https:shop")).toBe("local_host");
  });
});
