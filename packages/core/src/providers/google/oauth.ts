import { backoffMs, parseRetryAfter } from "../../http/fetch.ts";
import type { FetchLike } from "../../http/fetch.ts";
import type { BatchResponsePart } from "../../http/multipart.ts";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { ClearboxError } from "../../model/errors.ts";
import {
  GOOGLE_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  isJsonObject,
  refreshAccessToken,
  sendGuarded,
} from "../oauth.ts";
import type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "../oauth.ts";
import type { ActionErrorCode, ActionResult } from "../provider.ts";
import type { OAuthTokens } from "../token.ts";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const REAUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
]);
const CONFIG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
]);
const RATE_REASONS: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** Classifies a non-2xx Google token endpoint response (contracts 4.4 table). */
export function classifyGoogleOAuthError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const error = isJsonObject(body) && typeof body.error === "string" ? body.error : null;
  if (error !== null && REAUTH_ERRORS.has(error))
    return new ProviderAuthError({ provider: "gmail", reason: error });
  if (error !== null && CONFIG_ERRORS.has(error))
    return new ProviderConfigError({ provider: "gmail", reason: error });
  if (status === 429) {
    return new ProviderRateLimitError({
      provider: "gmail",
      retryAfterMs: parseRetryAfter(headers, now) ?? backoffMs(1),
    });
  }
  if (error === "temporarily_unavailable" || status >= 500) {
    return new ProviderUnavailableError({ provider: "gmail", retryAfterMs: parseRetryAfter(headers, now) });
  }
  return new ProviderResponseError({ provider: "gmail", status });
}

export const GOOGLE_TOKEN_ENDPOINT: TokenEndpoint = {
  provider: "gmail",
  url: GOOGLE_TOKEN_URL,
  classify: classifyGoogleOAuthError,
};

/** access_type=offline, prompt=consent (a refresh token on every connect), PKCE S256. */
export function buildGoogleAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string {
  return buildAuthorizeUrl(GOOGLE_AUTHORIZE_URL, {
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    login_hint: p.loginHint,
  });
}

export function exchangeGoogleCode(
  f: FetchLike,
  cfg: OAuthClientConfig,
  code: string,
  codeVerifier: string,
  now: number,
): Promise<OAuthTokens> {
  return exchangeCode(
    f,
    GOOGLE_TOKEN_ENDPOINT,
    {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    },
    now,
  );
}

/** Google does not rotate refresh tokens: the result's refreshToken is null and the stored one stays valid. */
export function refreshGoogleToken(
  f: FetchLike,
  cfg: OAuthClientConfig,
  refreshToken: string,
  now: number,
): Promise<OAuthTokens> {
  return refreshAccessToken(
    f,
    GOOGLE_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    now,
  );
}

/** Best effort: true on 200, false on any error (never throws). Revoking either token revokes the grant. */
export async function revokeGoogleToken(f: FetchLike, token: string): Promise<boolean> {
  try {
    const res = await sendGuarded(f, "gmail", GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function hasGmailScope(granted: readonly string[]): boolean {
  return granted.includes(GMAIL_MODIFY_SCOPE);
}

/** error.errors[0].reason, else error.status, else null. */
export function gmailErrorReason(body: unknown): string | null {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return null;
  const errors = body.error.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  if (isJsonObject(first) && typeof first.reason === "string") return first.reason;
  return typeof body.error.status === "string" ? body.error.status : null;
}

export function isGmailRateLimit(status: number, reason: string | null): boolean {
  return status === 429 || (status === 403 && reason !== null && RATE_REASONS.has(reason));
}

export function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/**
 * Classifies a whole-call Gmail API error (after the one 401 refresh retry). 404 on history and 400 on a
 * page token are handled by the callers (CursorExpiredError) before this is called.
 */
export function classifyGmailApiError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const reason = gmailErrorReason(body);
  const retryAfter = parseRetryAfter(headers, now);
  if (status === 401) return new ProviderAuthError({ provider: "gmail", reason: "unauthorized" });
  if (isGmailRateLimit(status, reason)) {
    return new ProviderRateLimitError({ provider: "gmail", retryAfterMs: retryAfter ?? backoffMs(1) });
  }
  if (status === 403 && reason === "dailyLimitExceeded") {
    return new ProviderRateLimitError({ provider: "gmail", retryAfterMs: msUntilNextUtcMidnight(now) });
  }
  if (status === 403 && reason === "domainPolicy")
    return new ProviderAuthError({ provider: "gmail", reason: "domain_policy" });
  if (status === 403 && reason === "insufficientPermissions") {
    return new ProviderAuthError({ provider: "gmail", reason: "insufficient_scope" });
  }
  if (status >= 500) return new ProviderUnavailableError({ provider: "gmail", retryAfterMs: retryAfter });
  return new ProviderResponseError({ provider: "gmail", status });
}

// ---- Batch part classification (Gmail multipart batch) ----

export type PartOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "auth" }
  | { kind: "rate"; retryAfterMs: number | null }
  | { kind: "server"; retryAfterMs: number | null }
  | { kind: "fail"; error: ActionErrorCode };

/** A batch part body as JSON, or null when empty or unparseable. */
export function parsePartBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function classifyPart(part: BatchResponsePart | undefined, now: number): PartOutcome {
  if (part === undefined) return { kind: "server", retryAfterMs: null };
  const body = parsePartBody(part.bodyText);
  const retryAfterMs = parseRetryAfter(new Headers(part.headers), now);
  if (part.status >= 200 && part.status < 300) {
    if (isJsonObject(body)) return { kind: "ok", body };
    if (part.status === 204 && part.bodyText === "") return { kind: "ok", body: {} };
    // Unparseable or truncated (the multipart parser keeps a cut-off last part): retry like a missing part.
    return { kind: "server", retryAfterMs };
  }
  if (part.status === 401) return { kind: "auth" };
  if (isGmailRateLimit(part.status, gmailErrorReason(body))) return { kind: "rate", retryAfterMs };
  if (part.status >= 500) return { kind: "server", retryAfterMs };
  if (part.status === 404) return { kind: "fail", error: "not_found" };
  if (part.status === 400) return { kind: "fail", error: "bad_request" };
  return { kind: "fail", error: "unknown" };
}

export interface ActionOutcome {
  result: ActionResult;
  labelIds: string[] | null;
}

export function toActionOutcome(id: string, outcome: Exclude<PartOutcome, { kind: "auth" }>): ActionOutcome {
  switch (outcome.kind) {
    case "ok": {
      const labels = outcome.body.labelIds;
      const labelIds = Array.isArray(labels)
        ? labels.filter((l): l is string => typeof l === "string")
        : null;
      return { result: { id, ok: true, newId: id }, labelIds };
    }
    case "rate":
      return {
        result: { id, ok: false, error: "rate_limited", retryAfterMs: outcome.retryAfterMs },
        labelIds: null,
      };
    case "server":
      return {
        result: { id, ok: false, error: "unavailable", retryAfterMs: outcome.retryAfterMs },
        labelIds: null,
      };
    case "fail":
      return { result: { id, ok: false, error: outcome.error, retryAfterMs: null }, labelIds: null };
  }
}
