import { backoffMs, parseRetryAfter } from "../../http/fetch.ts";
import type { FetchLike } from "../../http/fetch.ts";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { ClearboxError } from "../../model/errors.ts";
import {
  MICROSOFT_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  isJsonObject,
  refreshAccessToken,
} from "../oauth.ts";
import type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "../oauth.ts";
import type { ActionResult } from "../provider.ts";
import type { OAuthTokens } from "../token.ts";
import type { GraphBatchSubResponse } from "./types.ts";

// Microsoft has no OAuth revoke endpoint for these scopes (POST /me/revokeSignInSessions needs
// User.RevokeSessions.All and is not supported for personal accounts). Disconnect deletes the tokens
// locally and shows MICROSOFT_CONSENT_URLS (defined in providers/oauth.ts).

export const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const AUTH_CODES: ReadonlySet<number> = new Set([
  70008, 700082, 50173, 70000, 70043, 50076, 50079, 50078, 53003, 65001,
]);
const CONFIG_CODES: ReadonlySet<number> = new Set([7000215, 7000222, 700016, 50194, 50011]);
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

/** First AADSTS code: error_codes[0], else the number in "AADSTSnnnn" of error_description. */
export function aadstsCode(body: unknown): number | null {
  if (!isJsonObject(body)) return null;
  const codes = body.error_codes;
  const first: unknown = Array.isArray(codes) ? codes[0] : undefined;
  if (typeof first === "number") return first;
  const match =
    typeof body.error_description === "string" ? /AADSTS(\d+)/.exec(body.error_description) : null;
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Classifies a non-2xx Microsoft token endpoint response (contracts 4.4 table). AADSTS codes win over `error`. */
export function classifyMicrosoftOAuthError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const code = aadstsCode(body);
  const error = isJsonObject(body) && typeof body.error === "string" ? body.error : null;
  if (code === 90094) return new ProviderAuthError({ provider: "outlook", reason: "admin_consent_required" });
  if (code !== null && CONFIG_CODES.has(code))
    return new ProviderConfigError({ provider: "outlook", reason: `AADSTS${String(code)}` });
  if (code !== null && AUTH_CODES.has(code))
    return new ProviderAuthError({ provider: "outlook", reason: `AADSTS${String(code)}` });
  if (error !== null && REAUTH_ERRORS.has(error))
    return new ProviderAuthError({ provider: "outlook", reason: error });
  if (error !== null && CONFIG_ERRORS.has(error))
    return new ProviderConfigError({ provider: "outlook", reason: error });
  if (status === 429) {
    return new ProviderRateLimitError({
      provider: "outlook",
      retryAfterMs: parseRetryAfter(headers, now) ?? backoffMs(1),
    });
  }
  if (error === "temporarily_unavailable" || status >= 500) {
    return new ProviderUnavailableError({ provider: "outlook", retryAfterMs: parseRetryAfter(headers, now) });
  }
  return new ProviderResponseError({ provider: "outlook", status });
}

export const MICROSOFT_TOKEN_ENDPOINT: TokenEndpoint = {
  provider: "outlook",
  url: MICROSOFT_TOKEN_URL,
  classify: classifyMicrosoftOAuthError,
};

/** Tenant "common", response_mode=query (keeps the SameSite=Lax state cookie), prompt=select_account, PKCE S256. */
export function buildMicrosoftAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string {
  return buildAuthorizeUrl(MICROSOFT_AUTHORIZE_URL, {
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    login_hint: p.loginHint,
  });
}

export function exchangeMicrosoftCode(
  f: FetchLike,
  cfg: OAuthClientConfig,
  code: string,
  codeVerifier: string,
  now: number,
): Promise<OAuthTokens> {
  return exchangeCode(
    f,
    MICROSOFT_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      scope: MICROSOFT_SCOPES.join(" "),
      code,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
      client_secret: cfg.clientSecret,
    },
    now,
  );
}

/**
 * Microsoft rotates refresh tokens: result.refreshToken is the NEW token and the caller must re-encrypt and
 * persist it (contracts 7.15 TokenUpdate), also when the rest of the tick fails. null only if Entra omitted it.
 */
export function refreshMicrosoftToken(
  f: FetchLike,
  cfg: OAuthClientConfig,
  refreshToken: string,
  now: number,
): Promise<OAuthTokens> {
  return refreshAccessToken(
    f,
    MICROSOFT_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_secret: cfg.clientSecret,
      scope: MICROSOFT_SCOPES.join(" "),
    },
    now,
  );
}

function normalizeScope(scope: string): string {
  return scope
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/graph\.microsoft\.com\//, "");
}

/** Case-insensitive; accepts "Mail.ReadWrite" with or without the https://graph.microsoft.com/ prefix. */
export function hasGraphScopes(granted: readonly string[]): boolean {
  return granted.some((scope) => normalizeScope(scope) === "mail.readwrite");
}

// Graph error codes are identifiers ("ErrorAccessDenied", "syncStateNotFound"); anything else is not trusted
// as an error reason, so no free text from a response body can reach an error message.
const GRAPH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,100}$/;

/** error.code of a Graph error body when it is identifier-shaped, else null. Never error.message. */
export function graphErrorCode(body: unknown): string | null {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return null;
  const code = body.error.code;
  return typeof code === "string" && GRAPH_ERROR_CODE.test(code) ? code : null;
}

/** Classifies a whole-call Graph error (after the one 401 refresh retry). Delta expiry is handled by the caller. */
export function classifyGraphApiError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const retryAfter = parseRetryAfter(headers, now);
  if (status === 401) return new ProviderAuthError({ provider: "outlook", reason: "unauthorized" });
  if (status === 403)
    return new ProviderAuthError({ provider: "outlook", reason: graphErrorCode(body) ?? "forbidden" });
  if (status === 429)
    return new ProviderRateLimitError({ provider: "outlook", retryAfterMs: retryAfter ?? backoffMs(1) });
  if (status >= 500) return new ProviderUnavailableError({ provider: "outlook", retryAfterMs: retryAfter });
  return new ProviderResponseError({ provider: "outlook", status });
}

// ---- $batch sub-responses and delta expiry ----

const DELTA_EXPIRED_CODES: ReadonlySet<string> = new Set([
  "syncstatenotfound",
  "syncstateinvalid",
  "resyncrequired",
]);

/** Delta token expiry: 410 Gone (handled by the caller) or any 4xx with syncStateNotFound / syncStateInvalid / resyncRequired. */
export function isDeltaExpired(status: number, body: unknown): boolean {
  const code = graphErrorCode(body)?.toLowerCase() ?? null;
  return status === 410 || (status >= 400 && status < 500 && code !== null && DELTA_EXPIRED_CODES.has(code));
}

/** Retry-After of one $batch sub-response, in ms. Malformed header entries are ignored. */
export function subRetryAfter(sub: GraphBatchSubResponse, now: number): number | null {
  const headers = new Headers();
  const raw: unknown = sub.headers;
  if (isJsonObject(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== "string") continue;
      try {
        headers.append(name, value);
      } catch {
        // Invalid header name or value: skip it.
      }
    }
  }
  return parseRetryAfter(headers, now);
}

/**
 * One move sub-response -> ActionResult; newId is the moved message id from the response body.
 * A missing or malformed sub-response (no numeric status, or a 2xx without a JSON object body) is never a success.
 */
export function graphMoveResult(
  id: string,
  sub: GraphBatchSubResponse | undefined,
  now: number,
): ActionResult {
  const raw: unknown = sub;
  if (sub === undefined || !isJsonObject(raw) || typeof raw.status !== "number")
    return { id, ok: false, error: "unknown", retryAfterMs: null };
  if (sub.status === 200 || sub.status === 201) {
    if (!isJsonObject(sub.body)) return { id, ok: false, error: "unknown", retryAfterMs: null };
    const newId = typeof sub.body.id === "string" && sub.body.id !== "" ? sub.body.id : id;
    return { id, ok: true, newId };
  }
  if (sub.status === 404) return { id, ok: false, error: "not_found", retryAfterMs: null };
  if (sub.status === 429)
    return { id, ok: false, error: "rate_limited", retryAfterMs: subRetryAfter(sub, now) };
  if (sub.status >= 500)
    return { id, ok: false, error: "unavailable", retryAfterMs: subRetryAfter(sub, now) };
  if (sub.status === 400) return { id, ok: false, error: "bad_request", retryAfterMs: null };
  return { id, ok: false, error: "unknown", retryAfterMs: null };
}
