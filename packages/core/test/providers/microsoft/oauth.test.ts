import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "../../../src/model/errors.ts";
import {
  aadstsCode,
  buildMicrosoftAuthorizeUrl,
  classifyGraphApiError,
  classifyMicrosoftOAuthError,
  exchangeMicrosoftCode,
  graphErrorCode,
  graphMoveResult,
  hasGraphScopes,
  isDeltaExpired,
  refreshMicrosoftToken,
} from "../../../src/providers/microsoft/oauth.ts";
import type { GraphBatchSubResponse } from "../../../src/providers/microsoft/types.ts";
import graphApiErrors from "../../fixtures/graph/api-errors.json" with { type: "json" };
import microsoftErrors from "../../fixtures/oauth/microsoft-errors.json" with { type: "json" };
import type { FakeOAuthState } from "../../msw/google-oauth.ts";
import {
  MICROSOFT_TEST_CLIENT,
  createMicrosoftOAuthState,
  microsoftOAuthHandlers,
} from "../../msw/microsoft-oauth.ts";
import { server } from "../../setup/msw.ts";
import { expectClassified, type ErrorRow } from "../error-table.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let state: FakeOAuthState;

beforeEach(() => {
  state = createMicrosoftOAuthState();
  server.use(...microsoftOAuthHandlers(state));
});

describe("buildMicrosoftAuthorizeUrl", () => {
  it("uses tenant common, response_mode=query, select_account and PKCE S256", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl(MICROSOFT_TEST_CLIENT, { state: "nonce-1", codeChallenge: "challenge-1" }),
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-ms-client",
      response_type: "code",
      redirect_uri: "http://localhost:5173/oauth/microsoft/callback",
      response_mode: "query",
      scope: "offline_access User.Read Mail.ReadWrite",
      state: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });
});

describe("exchangeMicrosoftCode", () => {
  it("returns tokens including the first refresh token", async () => {
    const tokens = await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "verifier-1", NOW);
    expect(tokens.accessToken).toBe("m-at-1");
    expect(tokens.refreshToken).toBe("m-rt-1");
    expect(hasGraphScopes(tokens.grantedScopes)).toBe(true);
    const form = state.tokenRequests[0];
    expect(form?.get("scope")).toBe("offline_access User.Read Mail.ReadWrite");
    expect(form?.get("code_verifier")).toBe("verifier-1");
  });

  it("maps a wrong secret to ProviderConfigError AADSTS7000215", async () => {
    await expect(
      exchangeMicrosoftCode(
        fetch,
        { ...MICROSOFT_TEST_CLIENT, clientSecret: "wrong" },
        "code-valid",
        "v",
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ProviderConfigError", reason: "AADSTS7000215" });
  });
});

describe("refreshMicrosoftToken", () => {
  it("returns a rotated refresh token on every refresh", async () => {
    const first = await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "v", NOW);
    const second = await refreshMicrosoftToken(
      fetch,
      MICROSOFT_TEST_CLIENT,
      first.refreshToken ?? "",
      NOW + 1,
    );
    const third = await refreshMicrosoftToken(
      fetch,
      MICROSOFT_TEST_CLIENT,
      second.refreshToken ?? "",
      NOW + 2,
    );
    expect([first.refreshToken, second.refreshToken, third.refreshToken]).toEqual([
      "m-rt-1",
      "m-rt-2",
      "m-rt-3",
    ]);
    const form = state.tokenRequests[2];
    expect(form?.get("refresh_token")).toBe("m-rt-2");
    expect(form?.get("client_secret")).toBe("test-ms-secret");
    expect(form?.get("scope")).toBe("offline_access User.Read Mail.ReadWrite");
  });

  it("returns refreshToken null when Entra omits it (caller keeps the stored token)", async () => {
    await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "v", NOW);
    state.rotateRefreshTokens = false;
    const tokens = await refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-1", NOW);
    expect(tokens.refreshToken).toBeNull();
  });

  it("maps an invalid refresh token to ProviderAuthError AADSTS70000", async () => {
    await expect(
      refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-unknown", NOW),
    ).rejects.toMatchObject({
      name: "ProviderAuthError",
      provider: "outlook",
      reason: "AADSTS70000",
    });
  });

  it("maps network failure to ProviderUnavailableError", async () => {
    server.use(
      http.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", () => HttpResponse.error()),
    );
    await expect(refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("hasGraphScopes", () => {
  it("accepts Mail.ReadWrite case-insensitively with or without the Graph prefix", () => {
    expect(hasGraphScopes(["https://graph.microsoft.com/Mail.ReadWrite"])).toBe(true);
    expect(hasGraphScopes(["mail.readwrite"])).toBe(true);
    expect(hasGraphScopes(["Mail.Read", "User.Read"])).toBe(false);
    expect(hasGraphScopes(["https://graph.microsoft.com/Mail.ReadWrite.Shared"])).toBe(false);
  });
});

describe("aadstsCode", () => {
  it("prefers error_codes and falls back to the description", () => {
    expect(aadstsCode({ error_codes: [70008], error_description: "AADSTS1: x" })).toBe(70008);
    expect(aadstsCode({ error_description: "AADSTS7000222: expired" })).toBe(7000222);
    expect(aadstsCode({ error: "x" })).toBeNull();
    expect(aadstsCode(null)).toBeNull();
  });
});

describe("classifyMicrosoftOAuthError", () => {
  it.each(microsoftErrors as ErrorRow[])("HTTP $status $body.error -> $expected", (row) => {
    expectClassified(
      row,
      classifyMicrosoftOAuthError(row.status, row.body, new Headers(row.headers ?? {}), NOW),
    );
  });
});

describe("classifyGraphApiError", () => {
  it.each(graphApiErrors as ErrorRow[])("HTTP $status -> $expected", (row) => {
    expectClassified(row, classifyGraphApiError(row.status, row.body, new Headers(row.headers ?? {}), NOW));
  });
  it("reads error.code", () => {
    expect(graphErrorCode({ error: { code: "syncStateNotFound", message: "x" } })).toBe("syncStateNotFound");
    expect(graphErrorCode({})).toBeNull();
    expect(
      graphErrorCode({ error: { code: "Access denied for owner@example.test", message: "x" } }),
    ).toBeNull();
    expect(
      classifyGraphApiError(403, { error: { code: "not an identifier", message: "x" } }, new Headers(), NOW),
    ).toMatchObject({ reason: "forbidden" });
  });
});

describe("isDeltaExpired", () => {
  it("detects 410 and 4xx sync state codes, case-insensitive", () => {
    expect(isDeltaExpired(410, null)).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "syncStateNotFound", message: "x" } })).toBe(true);
    expect(isDeltaExpired(404, { error: { code: "SyncStateInvalid", message: "x" } })).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "resyncRequired", message: "x" } })).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "ErrorInvalidRequest", message: "x" } })).toBe(false);
    expect(isDeltaExpired(503, { error: { code: "syncStateNotFound", message: "x" } })).toBe(false);
  });
});

describe("graphMoveResult", () => {
  const sub = (status: number, body: unknown = null, headers: Record<string, string> = {}) => ({
    id: "0",
    status,
    headers,
    body,
  });

  it("maps move sub-responses to ActionResult", () => {
    expect(graphMoveResult("a", sub(201, { id: "a-new" }), NOW)).toEqual({
      id: "a",
      ok: true,
      newId: "a-new",
    });
    expect(graphMoveResult("a", sub(200, {}), NOW)).toEqual({ id: "a", ok: true, newId: "a" });
    expect(graphMoveResult("a", sub(404), NOW)).toMatchObject({ error: "not_found" });
    expect(graphMoveResult("a", sub(429, null, { "Retry-After": "10" }), NOW)).toEqual({
      id: "a",
      ok: false,
      error: "rate_limited",
      retryAfterMs: 10_000,
    });
    expect(graphMoveResult("a", sub(504), NOW)).toMatchObject({ error: "unavailable" });
    expect(graphMoveResult("a", sub(400), NOW)).toMatchObject({ error: "bad_request" });
    expect(graphMoveResult("a", sub(403), NOW)).toMatchObject({ error: "unknown" });
    expect(graphMoveResult("a", undefined, NOW)).toMatchObject({ error: "unknown" });
    expect(graphMoveResult("a", sub(201, null), NOW)).toMatchObject({ ok: false, error: "unknown" });
    expect(graphMoveResult("a", sub(201, "not json"), NOW)).toMatchObject({ ok: false, error: "unknown" });
    const noStatus = { id: "0", headers: {}, body: { id: "a-new" } } as unknown as GraphBatchSubResponse;
    expect(graphMoveResult("a", noStatus, NOW)).toMatchObject({ ok: false, error: "unknown" });
    const badHeaders = { ...sub(429), headers: { "bad name": "1", "Retry-After": "3" } };
    expect(graphMoveResult("a", badHeaders, NOW)).toMatchObject({
      error: "rate_limited",
      retryAfterMs: 3000,
    });
    const nullHeaders = { ...sub(503), headers: null } as unknown as GraphBatchSubResponse;
    expect(graphMoveResult("a", nullHeaders, NOW)).toMatchObject({
      error: "unavailable",
      retryAfterMs: null,
    });
  });
});
