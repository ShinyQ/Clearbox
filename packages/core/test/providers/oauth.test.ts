import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
} from "../../src/model/errors.ts";
import {
  buildAuthorizeUrl,
  buildMailHeaders,
  chunkIds,
  exchangeCode,
  headerValues,
  parseCursorJson,
  parseTokenResponse,
  readJsonBody,
  refreshAccessToken,
  selectAuthenticationResults,
  sendGuarded,
  uniqueAddresses,
  type TokenEndpoint,
} from "../../src/providers/oauth.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const TOKEN_URL = "https://token.example.test/token";
const endpoint: TokenEndpoint = {
  provider: "gmail",
  url: TOKEN_URL,
  classify: (status, body) =>
    new ProviderAuthError({
      provider: "gmail",
      reason:
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : `http_${String(status)}`,
    }),
};

describe("buildAuthorizeUrl", () => {
  it("sets every defined parameter and omits undefined ones", () => {
    const url = new URL(
      buildAuthorizeUrl("https://auth.example.test/authorize", { a: "1", b: undefined, c: "x y" }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.test/authorize");
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("b")).toBe(false);
    expect(url.searchParams.get("c")).toBe("x y");
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("posts a form and maps the token response", async () => {
    const forms: URLSearchParams[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        forms.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "at-1",
          expires_in: 3599,
          token_type: "Bearer",
          scope: "scope-a  scope-b",
          refresh_token: "rt-1",
          refresh_token_expires_in: 604800,
        });
      }),
    );
    const tokens = await exchangeCode(
      fetch,
      endpoint,
      { grant_type: "authorization_code", code: "c-1" },
      NOW,
    );
    expect(forms[0]?.get("code")).toBe("c-1");
    expect(tokens).toEqual({
      accessToken: "at-1",
      expiresAt: NOW + 3_599_000,
      refreshToken: "rt-1",
      grantedScopes: ["scope-a", "scope-b"],
      refreshTokenExpiresAt: NOW + 604_800_000,
    });
  });

  it("returns refreshToken null when the response has none", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "at-2", expires_in: 60 })));
    const tokens = await refreshAccessToken(fetch, endpoint, { grant_type: "refresh_token" }, NOW);
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.grantedScopes).toEqual([]);
  });

  it("delegates non-2xx responses to the endpoint classifier", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "invalid_grant",
    });
  });

  it("maps a network failure to ProviderUnavailableError", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("rejects a 200 without access_token as ProviderResponseError", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ expires_in: 60 })));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toBeInstanceOf(ProviderResponseError);
  });
});

describe("parseTokenResponse", () => {
  it("rejects non-object bodies", () => {
    expect(() => parseTokenResponse("outlook", 200, null, NOW)).toThrow(ProviderResponseError);
  });
});

describe("sendGuarded", () => {
  it("passes ClearboxErrors through unchanged", async () => {
    const budget = new SubrequestBudgetError({ used: 45, limit: 45 });
    await expect(
      sendGuarded(() => Promise.reject(budget), "gmail", "https://x.example.test", {}),
    ).rejects.toBe(budget);
  });
  it("wraps other failures", async () => {
    await expect(
      sendGuarded(
        () => Promise.reject(new TypeError("fetch failed")),
        "outlook",
        "https://x.example.test",
        {},
      ),
    ).rejects.toMatchObject({ name: "ProviderUnavailableError", provider: "outlook" });
  });
});

describe("readJsonBody", () => {
  it("returns null for empty or invalid JSON", async () => {
    expect(await readJsonBody(new Response(""))).toBeNull();
    expect(await readJsonBody(new Response("<html>"))).toBeNull();
    expect(await readJsonBody(new Response('{"a":1}'))).toEqual({ a: 1 });
  });
});

describe("parseCursorJson", () => {
  it("returns the object for version 1", () => {
    expect(parseCursorJson('{"v":1,"pageToken":"p"}', "gmail", "backfill")).toEqual({ v: 1, pageToken: "p" });
  });
  it("throws CursorExpiredError for corrupt or unknown versions", () => {
    expect(() => parseCursorJson("not json", "gmail", "backfill")).toThrow(CursorExpiredError);
    expect(() => parseCursorJson('{"v":2}', "outlook", "incremental")).toThrow(CursorExpiredError);
  });
});

describe("chunkIds", () => {
  it("splits into chunks of the given size", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 20)).toEqual([]);
  });
});

describe("headerValues", () => {
  it("returns every value, case-insensitive, unfolded", () => {
    const headers = [
      { name: "Delivered-To", value: "a@example.test" },
      { name: "delivered-to", value: "b@example.test" },
      { name: "Subject", value: "Hello\r\n world" },
    ];
    expect(headerValues(headers, "DELIVERED-TO")).toEqual(["a@example.test", "b@example.test"]);
    expect(headerValues(headers, "subject")).toEqual(["Hello world"]);
  });
});

describe("selectAuthenticationResults", () => {
  const upstream = "relay.example.net; dkim=pass header.d=shop.example.com";
  const google = "mx.google.com; spf=pass smtp.mailfrom=esp.example.net";
  it("Gmail trusts only the mx.google.com authserv-id", () => {
    expect(selectAuthenticationResults([upstream, google], "gmail")).toBe(google);
    expect(selectAuthenticationResults([upstream], "gmail")).toBeNull();
    expect(selectAuthenticationResults([], "gmail")).toBeNull();
    expect(selectAuthenticationResults(["mx.google.com.evil.example; dkim=pass", google], "gmail")).toBe(
      google,
    );
    expect(selectAuthenticationResults(["dkim=pass header.d=mx.google.com"], "gmail")).toBeNull();
    expect(selectAuthenticationResults(["MX.Google.COM; dkim=pass"], "gmail")).toBe(
      "MX.Google.COM; dkim=pass",
    );
  });
  it("Microsoft uses the first value", () => {
    expect(selectAuthenticationResults(["spf=pass smtp.mailfrom=a.example", "spf=fail"], "outlook")).toBe(
      "spf=pass smtp.mailfrom=a.example",
    );
    expect(selectAuthenticationResults([], "outlook")).toBeNull();
  });
});

describe("buildMailHeaders", () => {
  it("normalizes every MailHeaders field and nulls missing ones", () => {
    const headers = buildMailHeaders(
      [
        { name: "list-unsubscribe", value: "<https://shop.example.com/u/1>" },
        { name: "Precedence", value: "bulk" },
        { name: "Return-Path", value: "<bounce@esp.example.net>" },
      ],
      "gmail",
    );
    expect(headers).toEqual({
      listUnsubscribe: "<https://shop.example.com/u/1>",
      listUnsubscribePost: null,
      listId: null,
      precedence: "bulk",
      autoSubmitted: null,
      authenticationResults: null,
      returnPath: "<bounce@esp.example.net>",
      contentType: null,
      references: null,
      inReplyTo: null,
    });
  });

  it("keeps only the trusted Authentication-Results value", () => {
    const raw = [
      { name: "Authentication-Results", value: "relay.example.net; dkim=pass" },
      { name: "authentication-results", value: "mx.google.com;\r\n spf=pass" },
    ];
    expect(buildMailHeaders(raw, "gmail").authenticationResults).toBe("mx.google.com; spf=pass");
    expect(buildMailHeaders(raw, "outlook").authenticationResults).toBe("relay.example.net; dkim=pass");
  });
});

describe("uniqueAddresses", () => {
  it("lowercases and de-duplicates across header values", () => {
    expect(
      uniqueAddresses(["A <A@Example.com>, b@example.org", "a@example.com; undisclosed-recipients:;"]),
    ).toEqual(["a@example.com", "b@example.org"]);
  });
});

describe("ClearboxError hierarchy", () => {
  it("provider errors are ClearboxErrors", () => {
    expect(new ProviderAuthError({ provider: "gmail", reason: "x" })).toBeInstanceOf(ClearboxError);
  });
});
