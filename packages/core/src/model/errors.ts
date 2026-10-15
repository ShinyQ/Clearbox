import type { ProviderKind } from "./mail.ts";

interface ErrorExtras {
  message?: string;
  cause?: unknown;
}

function causeOption(extras: ErrorExtras): { cause?: unknown } {
  return "cause" in extras ? { cause: extras.cause } : {};
}

/** Base class for every error thrown by @clearbox/core. Messages never carry user data. */
export class ClearboxError extends Error {
  readonly code: string;

  constructor(code: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Refresh token invalid or user interaction required. Account -> needs_reauth. */
export class ProviderAuthError extends ClearboxError {
  readonly provider: ProviderKind;
  /** e.g. "invalid_grant", "interaction_required", "unauthorized", "domain_policy", "admin_consent_required", "AADSTS70008". */
  readonly reason: string;

  constructor(options: { provider: ProviderKind; reason: string } & ErrorExtras) {
    super(
      "provider_auth",
      options.message ?? `${options.provider} authorization failed (${options.reason})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.reason = options.reason;
  }
}

/** Owner configuration problem (client id/secret wrong or expired). Account -> config_error; app issue raised. */
export class ProviderConfigError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly reason: string;

  constructor(options: { provider: ProviderKind; reason: string } & ErrorExtras) {
    super(
      "provider_config",
      options.message ?? `${options.provider} client configuration rejected (${options.reason})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.reason = options.reason;
  }
}

export class ProviderRateLimitError extends ClearboxError {
  readonly provider: ProviderKind;
  /** From Retry-After, else backoffMs(attempt). */
  readonly retryAfterMs: number;

  constructor(options: { provider: ProviderKind; retryAfterMs: number } & ErrorExtras) {
    super(
      "provider_rate_limited",
      options.message ?? `${options.provider} rate limited`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderUnavailableError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly retryAfterMs: number | null;

  constructor(options: { provider: ProviderKind; retryAfterMs?: number | null } & ErrorExtras) {
    super("provider_unavailable", options.message ?? `${options.provider} unavailable`, causeOption(options));
    this.provider = options.provider;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Incremental cursor expired (Gmail history 404, Graph syncStateNotFound / 410) or backfill page token rejected (400). */
export class CursorExpiredError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly cursorKind: "backfill" | "sent" | "incremental";

  constructor(
    options: { provider: ProviderKind; cursorKind: "backfill" | "sent" | "incremental" } & ErrorExtras,
  ) {
    super(
      "cursor_expired",
      options.message ?? `${options.provider} ${options.cursorKind} cursor expired`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.cursorKind = options.cursorKind;
  }
}

/** Unexpected status or response shape. Not retryable within the tick; counts as a tick failure. */
export class ProviderResponseError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly status: number;

  constructor(options: { provider: ProviderKind; status: number } & ErrorExtras) {
    super(
      "provider_response",
      options.message ?? `${options.provider} unexpected response (${String(options.status)})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.status = options.status;
  }
}

/** Thrown by countingFetch when a tick or request would exceed its subrequest limit. */
export class SubrequestBudgetError extends ClearboxError {
  readonly used: number;
  readonly limit: number;

  constructor(options: { used: number; limit: number } & ErrorExtras) {
    super(
      "subrequest_budget",
      options.message ?? `Subrequest budget exhausted (${String(options.used)} of ${String(options.limit)})`,
      causeOption(options),
    );
    this.used = options.used;
    this.limit = options.limit;
  }
}

/** Connect flow: granted scopes do not include the required scope. */
export class ScopeMissingError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly granted: string[];

  constructor(options: { provider: ProviderKind; granted: string[] } & ErrorExtras) {
    super(
      "scope_missing",
      options.message ?? `${options.provider} required scope not granted`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.granted = options.granted;
  }
}

export type DecisionErrorKind =
  | "auth" // 401, 403          scope config, not retryable
  | "deployment_not_found" // 404              scope config, not retryable
  | "bad_request" // 400              scope item,   not retryable
  | "too_large" // 413              scope item,   not retryable
  | "unprocessable" // 422              scope item,   not retryable
  | "invalid_response" // zod failure      scope item,   not retryable
  | "rate_limited" // 429              scope item,   retryable
  | "server" // 408, 500-504     scope item,   retryable
  | "timeout" // > timeoutMs      scope item,   retryable
  | "network"; // fetch threw      scope item,   retryable

/** Default retryability and scope per kind (contracts 4.12). */
export const DECISION_ERROR_RULES: Readonly<
  Record<DecisionErrorKind, { retryable: boolean; scope: "config" | "item" }>
> = {
  auth: { retryable: false, scope: "config" },
  deployment_not_found: { retryable: false, scope: "config" },
  bad_request: { retryable: false, scope: "item" },
  too_large: { retryable: false, scope: "item" },
  unprocessable: { retryable: false, scope: "item" },
  invalid_response: { retryable: false, scope: "item" },
  rate_limited: { retryable: true, scope: "item" },
  server: { retryable: true, scope: "item" },
  timeout: { retryable: true, scope: "item" },
  network: { retryable: true, scope: "item" },
};

export interface DecisionErrorOptions extends ErrorExtras {
  kind: DecisionErrorKind;
  status?: number | null;
  /** Defaults to DECISION_ERROR_RULES[kind].retryable. */
  retryable?: boolean;
  /** Defaults to DECISION_ERROR_RULES[kind].scope. */
  scope?: "config" | "item";
  retryAfterMs?: number | null;
  requestId?: string | null;
}

export class DecisionError extends ClearboxError {
  readonly kind: DecisionErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  /** "config": stop the tick and raise an app issue; "item": affects this message only. */
  readonly scope: "config" | "item";
  /** retry-after-ms, then retry-after, else null. */
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;

  constructor(options: DecisionErrorOptions) {
    const status = options.status ?? null;
    super(
      `decision_${options.kind}`,
      options.message ??
        `Decision-1 request failed (${options.kind}${status === null ? "" : `, HTTP ${String(status)}`})`,
      causeOption(options),
    );
    const rule = DECISION_ERROR_RULES[options.kind];
    this.kind = options.kind;
    this.status = status;
    this.retryable = options.retryable ?? rule.retryable;
    this.scope = options.scope ?? rule.scope;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.requestId = options.requestId ?? null;
  }
}
