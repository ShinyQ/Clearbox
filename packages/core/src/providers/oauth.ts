import type { FetchLike } from "../http/fetch.ts";
import type { MailHeaders, ProviderKind } from "../model/mail.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
} from "../model/errors.ts";
import { parseAddressList } from "../text/address.ts";
import { headerValue, parseAuthResults, type RawHeader } from "../text/headers.ts";
import { unfoldHeader } from "../text/rfc2047.ts";
import type { OAuthTokens } from "./token.ts";

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Exact redirect URI: `${origin}/oauth/google/callback` or `${origin}/oauth/microsoft/callback`. */
  redirectUri: string;
}

export interface AuthorizeParams {
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"] as const;
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"] as const;

/** Microsoft has no revoke endpoint for these scopes; Disconnect shows these links. */
export const MICROSOFT_CONSENT_URLS = {
  personal: "https://account.live.com/consent/Manage",
  work: "https://myapps.microsoft.com",
} as const;

// ---------------------------------------------------------------------------------------------
// Provider-agnostic shell (plan 02): token endpoint calls plus HTTP, cursor and header helpers
// shared by providers/google/* and providers/microsoft/*.
// ---------------------------------------------------------------------------------------------

/** True for plain JSON objects (not arrays, not null). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a response body as JSON; null for an empty or non-JSON body. Never throws on bad JSON. */
export async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Calls fetch; a network failure becomes ProviderUnavailableError. ClearboxErrors (budget) pass through. */
export async function sendGuarded(
  f: FetchLike,
  provider: ProviderKind,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await f(url, init);
  } catch (cause) {
    if (cause instanceof ClearboxError) throw cause;
    throw new ProviderUnavailableError({ provider, retryAfterMs: null, cause });
  }
}

/** Parses a provider cursor (JSON with "v": 1). Anything else throws CursorExpiredError so the caller restarts. */
export function parseCursorJson(
  raw: string,
  provider: ProviderKind,
  cursorKind: "backfill" | "sent" | "incremental",
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CursorExpiredError({ provider, cursorKind });
  }
  if (!isJsonObject(parsed) || parsed.v !== 1) throw new CursorExpiredError({ provider, cursorKind });
  return parsed;
}

/**
 * Best-effort count for display (inbox estimate): returns body[field] when it is a non-negative number, else null.
 * Auth, config and subrequest budget errors propagate; any other failure yields null.
 */
export async function bestEffortCount(
  read: () => Promise<Record<string, unknown>>,
  field: string,
): Promise<number | null> {
  try {
    const value = (await read())[field];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  } catch (error) {
    if (
      error instanceof ProviderAuthError ||
      error instanceof ProviderConfigError ||
      error instanceof SubrequestBudgetError
    ) {
      throw error;
    }
    return null;
  }
}

/** body[key] when it is a non-empty string, else null. */
export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Splits items into consecutive chunks of at most size items. */
export function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every value of a header (case-insensitive name), unfolded, in order. */
export function headerValues(headers: readonly RawHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === wanted).map((h) => unfoldHeader(h.value));
}

/**
 * Only the receiving provider's Authentication-Results is trusted:
 * Gmail = the first value whose authserv-id is "mx.google.com"; Microsoft = the first value.
 */
export function selectAuthenticationResults(
  values: readonly string[],
  provider: ProviderKind,
): string | null {
  if (provider === "outlook") return values[0] ?? null;
  return values.find((v) => parseAuthResults(v).authservId === "mx.google.com") ?? null;
}

/** Normalized MailHeaders from raw provider headers. */
export function buildMailHeaders(headers: readonly RawHeader[], provider: ProviderKind): MailHeaders {
  return {
    listUnsubscribe: headerValue(headers, "List-Unsubscribe"),
    listUnsubscribePost: headerValue(headers, "List-Unsubscribe-Post"),
    listId: headerValue(headers, "List-Id"),
    precedence: headerValue(headers, "Precedence"),
    autoSubmitted: headerValue(headers, "Auto-Submitted"),
    authenticationResults: selectAuthenticationResults(
      headerValues(headers, "Authentication-Results"),
      provider,
    ),
    returnPath: headerValue(headers, "Return-Path"),
    contentType: headerValue(headers, "Content-Type"),
    references: headerValue(headers, "References"),
    inReplyTo: headerValue(headers, "In-Reply-To"),
  };
}

/** Lowercased, de-duplicated addresses from address-list header values, in first-seen order. */
export function uniqueAddresses(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    for (const entry of parseAddressList(value)) if (entry.address !== null) out.add(entry.address);
  }
  return [...out];
}

/** Builds an authorize URL; undefined parameters are omitted. */
export function buildAuthorizeUrl(
  base: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A token endpoint plus the provider's error classification (google/oauth.ts, microsoft/oauth.ts). */
export interface TokenEndpoint {
  provider: ProviderKind;
  url: string;
  classify: (status: number, body: unknown, headers: Headers, now: number) => ClearboxError;
}

/** Validates a token endpoint success body. A missing access_token or expires_in is ProviderResponseError. */
export function parseTokenResponse(
  provider: ProviderKind,
  status: number,
  body: unknown,
  now: number,
): OAuthTokens {
  if (
    !isJsonObject(body) ||
    typeof body.access_token !== "string" ||
    body.access_token === "" ||
    typeof body.expires_in !== "number"
  ) {
    throw new ProviderResponseError({ provider, status });
  }
  const refresh = body.refresh_token;
  const refreshExpiresIn = body.refresh_token_expires_in;
  return {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
    refreshToken: typeof refresh === "string" && refresh !== "" ? refresh : null,
    grantedScopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter((s) => s !== "") : [],
    refreshTokenExpiresAt: typeof refreshExpiresIn === "number" ? now + refreshExpiresIn * 1000 : null,
  };
}

async function postTokenForm(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  const res = await sendGuarded(f, endpoint.provider, endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJsonBody(res);
  if (!res.ok) throw endpoint.classify(res.status, body, res.headers, now);
  return parseTokenResponse(endpoint.provider, res.status, body, now);
}

/** authorization_code grant. The caller supplies every form field (provider files build them). */
export function exchangeCode(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  return postTokenForm(f, endpoint, form, now);
}

/** refresh_token grant. A non-null result.refreshToken is a rotated token the caller must persist. */
export function refreshAccessToken(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  return postTokenForm(f, endpoint, form, now);
}
