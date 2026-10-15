import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "../../../src/model/errors.ts";
import {
  buildGoogleAuthorizeUrl,
  classifyGmailApiError,
  classifyGoogleOAuthError,
  classifyPart,
  exchangeGoogleCode,
  hasGmailScope,
  msUntilNextUtcMidnight,
  refreshGoogleToken,
  revokeGoogleToken,
  toActionOutcome,
} from "../../../src/providers/google/oauth.ts";
import gmailApiErrors from "../../fixtures/gmail/api-errors.json" with { type: "json" };
import googleErrors from "../../fixtures/oauth/google-errors.json" with { type: "json" };
import {
  GOOGLE_TEST_CLIENT,
  createGoogleOAuthState,
  googleOAuthHandlers,
  type FakeOAuthState,
} from "../../msw/google-oauth.ts";
import { server } from "../../setup/msw.ts";
import { expectClassified, type ErrorRow } from "../error-table.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let state: FakeOAuthState;

beforeEach(() => {
  state = createGoogleOAuthState();
  server.use(...googleOAuthHandlers(state));
});

describe("buildGoogleAuthorizeUrl", () => {
  it("requests gmail.modify offline with consent and PKCE S256", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(GOOGLE_TEST_CLIENT, { state: "nonce-1", codeChallenge: "challenge-1" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-google-client",
      redirect_uri: "http://localhost:5173/oauth/google/callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      access_type: "offline",
      prompt: "consent",
      state: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });
  it("adds login_hint only when given", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(GOOGLE_TEST_CLIENT, {
        state: "s",
        codeChallenge: "c",
        loginHint: "owner@example.test",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("owner@example.test");
  });
});

describe("exchangeGoogleCode", () => {
  it("exchanges the code with secret, redirect URI and verifier", async () => {
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "verifier-1", NOW);
    expect(tokens).toEqual({
      accessToken: "g-at-1",
      expiresAt: NOW + 3_599_000,
      refreshToken: "g-rt-1",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      refreshTokenExpiresAt: null,
    });
    const form = state.tokenRequests[0];
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code_verifier")).toBe("verifier-1");
    expect(form?.get("client_secret")).toBe("test-google-secret");
    expect(form?.get("redirect_uri")).toBe("http://localhost:5173/oauth/google/callback");
  });

  it("keeps refresh_token_expires_in for time-based access", async () => {
    state.refreshTokenExpiresIn = 86_400;
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(tokens.refreshTokenExpiresAt).toBe(NOW + 86_400_000);
  });

  it("reports granted scopes so the caller can detect unticked gmail.modify", async () => {
    state.grantedScope = "openid";
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(hasGmailScope(tokens.grantedScopes)).toBe(false);
  });

  it("maps a bad code to ProviderAuthError and a bad secret to ProviderConfigError", async () => {
    await expect(
      exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-wrong", "v", NOW),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(
      exchangeGoogleCode(fetch, { ...GOOGLE_TEST_CLIENT, clientSecret: "wrong" }, "code-valid", "v", NOW),
    ).rejects.toMatchObject({ name: "ProviderConfigError", reason: "invalid_client" });
  });
});

describe("refreshGoogleToken", () => {
  it("returns a new access token and no refresh token (no rotation)", async () => {
    await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    const tokens = await refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW + 1000);
    expect(tokens.accessToken).toBe("g-at-2");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresAt).toBe(NOW + 1000 + 3_599_000);
  });

  it("maps a revoked refresh token to ProviderAuthError invalid_grant", async () => {
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-unknown", NOW)).rejects.toMatchObject({
      name: "ProviderAuthError",
      provider: "gmail",
      reason: "invalid_grant",
    });
  });

  it("maps network failures to ProviderUnavailableError", async () => {
    server.use(http.post("https://oauth2.googleapis.com/token", () => HttpResponse.error()));
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("maps an injected invalid_client to ProviderConfigError", async () => {
    state.failNext({ method: "POST", path: "/token", status: 401, body: { error: "invalid_client" } });
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
  });
});

describe("revokeGoogleToken", () => {
  it("returns true for a live token and false otherwise", async () => {
    await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(true);
    expect(state.revoked).toEqual(["g-rt-1"]);
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(false);
  });
  it("never throws on network failure", async () => {
    server.use(http.post("https://oauth2.googleapis.com/revoke", () => HttpResponse.error()));
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(false);
  });
});

describe("hasGmailScope", () => {
  it("requires the exact gmail.modify scope", () => {
    expect(hasGmailScope(["openid", "https://www.googleapis.com/auth/gmail.modify"])).toBe(true);
    expect(hasGmailScope(["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
    expect(hasGmailScope([])).toBe(false);
  });
});

describe("classifyGoogleOAuthError", () => {
  it.each(googleErrors as ErrorRow[])("HTTP $status $body.error -> $expected", (row) => {
    expectClassified(
      row,
      classifyGoogleOAuthError(row.status, row.body, new Headers(row.headers ?? {}), NOW),
    );
  });
});

describe("classifyGmailApiError", () => {
  it.each(gmailApiErrors as ErrorRow[])("HTTP $status -> $expected", (row) => {
    expectClassified(row, classifyGmailApiError(row.status, row.body, new Headers(row.headers ?? {}), NOW));
  });
});

describe("msUntilNextUtcMidnight", () => {
  it("counts to the next UTC midnight", () => {
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 9, 15, 23, 59))).toBe(60_000);
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 11, 31, 12))).toBe(12 * 3_600_000);
  });
});

describe("classifyPart", () => {
  const part = (status: number, bodyText = "", headers: Record<string, string> = {}) => ({
    contentId: "m0",
    status,
    headers,
    bodyText,
  });

  it("classifies batch parts", () => {
    expect(classifyPart(part(200, '{"id":"a"}'), NOW)).toEqual({ kind: "ok", body: { id: "a" } });
    expect(classifyPart(part(204), NOW)).toEqual({ kind: "ok", body: {} });
    expect(classifyPart(part(200, '{"id":"a","labelIds":["IN'), NOW)).toEqual({
      kind: "server",
      retryAfterMs: null,
    });
    expect(classifyPart(part(200), NOW)).toEqual({ kind: "server", retryAfterMs: null });
    expect(classifyPart(part(200, "[]"), NOW)).toEqual({ kind: "server", retryAfterMs: null });
    expect(classifyPart(part(401), NOW)).toEqual({ kind: "auth" });
    expect(classifyPart(part(429, "", { "retry-after": "4" }), NOW)).toEqual({
      kind: "rate",
      retryAfterMs: 4000,
    });
    expect(
      classifyPart(
        part(403, '{"error":{"code":403,"message":"x","errors":[{"reason":"rateLimitExceeded"}]}}'),
        NOW,
      ),
    ).toEqual({ kind: "rate", retryAfterMs: null });
    expect(classifyPart(part(503), NOW)).toEqual({ kind: "server", retryAfterMs: null });
    expect(classifyPart(part(404), NOW)).toEqual({ kind: "fail", error: "not_found" });
    expect(classifyPart(part(400), NOW)).toEqual({ kind: "fail", error: "bad_request" });
    expect(classifyPart(part(403, "not json"), NOW)).toEqual({ kind: "fail", error: "unknown" });
    expect(classifyPart(undefined, NOW)).toEqual({ kind: "server", retryAfterMs: null });
  });
});

describe("toActionOutcome", () => {
  it("keeps label ids on success and maps failures to ActionResult codes", () => {
    expect(toActionOutcome("a", { kind: "ok", body: { labelIds: ["INBOX", 3] } })).toEqual({
      result: { id: "a", ok: true, newId: "a" },
      labelIds: ["INBOX"],
    });
    expect(toActionOutcome("a", { kind: "ok", body: {} }).labelIds).toBeNull();
    expect(toActionOutcome("a", { kind: "rate", retryAfterMs: 5 }).result).toEqual({
      id: "a",
      ok: false,
      error: "rate_limited",
      retryAfterMs: 5,
    });
    expect(toActionOutcome("a", { kind: "server", retryAfterMs: null }).result).toMatchObject({
      error: "unavailable",
    });
    expect(toActionOutcome("a", { kind: "fail", error: "not_found" }).result).toMatchObject({
      error: "not_found",
    });
  });
});
