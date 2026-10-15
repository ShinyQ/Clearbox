import {
  ClearboxError,
  CursorExpiredError,
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
  backoffMs,
} from "@clearbox/core";
import type { ProviderKind } from "@clearbox/core";
import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import type { TokenColumns } from "./tick-tokens.ts";
import { auditStmt, issuesStmt, leaseReleaseStmt, stmt } from "./write-plan.ts";
import type { Stmt } from "./write-plan.ts";

export class DecisionNotConfiguredError extends ClearboxError {
  constructor() {
    super("decision_not_configured", "Decision-1 endpoint, key or deployment is not configured");
  }
}

/** Most Decision-1 calls of a tick failed transiently: nothing is ingested and the account backs off. */
export class DecisionOutageError extends ClearboxError {
  readonly failures: number;
  readonly total: number;

  constructor(failures: number, total: number) {
    super("decision_outage", "Most Decision-1 calls failed transiently");
    this.failures = failures;
    this.total = total;
  }
}

export interface FailurePlan {
  errorCode: string;
  status: "active" | "needs_reauth" | "config_error";
  statusReason: string | null;
  backoffUntil: number | null;
  retryAfterMs: number | null;
  halvePageSize: boolean;
  audit: "reauth_required" | "config_error" | null;
  raise: AppIssueCode[];
  /** Set for provider failures (for the provider.error log event). */
  provider: { status: number | null } | null;
}

export interface ClassifyContext {
  provider: ProviderKind;
  attempts: number;
  now: number;
  random?: () => number;
}

/** Providers may wrap a fetch failure; the budget error can sit in the cause chain. */
function findBudgetError(err: unknown): SubrequestBudgetError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof SubrequestBudgetError) return cur;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return null;
}

export function classifyFailure(err: unknown, c: ClassifyContext): FailurePlan {
  const plan = (
    errorCode: string,
    retryAfterMs: number | null,
    extra: Partial<FailurePlan> = {},
  ): FailurePlan => ({
    errorCode,
    status: "active",
    statusReason: null,
    retryAfterMs,
    backoffUntil: c.now + (retryAfterMs ?? backoffMs(c.attempts + 1, c.random)),
    halvePageSize: false,
    audit: null,
    raise: [],
    provider: null,
    ...extra,
  });
  const budget = findBudgetError(err);
  if (budget !== null) return plan(budget.code, null, { backoffUntil: null, halvePageSize: true });
  if (err instanceof ProviderAuthError) {
    return plan(err.code, null, {
      status: "needs_reauth",
      statusReason: err.reason,
      audit: "reauth_required",
      provider: { status: null },
    });
  }
  if (err instanceof ProviderConfigError) {
    return plan(err.code, null, {
      status: "config_error",
      statusReason: err.reason,
      audit: "config_error",
      raise: [err.provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid"],
      provider: { status: null },
    });
  }
  if (err instanceof ProviderRateLimitError)
    return plan(err.code, err.retryAfterMs, { provider: { status: 429 } });
  if (err instanceof ProviderUnavailableError)
    return plan(err.code, err.retryAfterMs, { provider: { status: null } });
  if (err instanceof ProviderResponseError) return plan(err.code, null, { provider: { status: err.status } });
  if (err instanceof CursorExpiredError) return plan(err.code, null, { provider: { status: null } });
  if (err instanceof DecisionNotConfiguredError)
    return plan(err.code, null, { raise: ["decision_not_configured"] });
  if (err instanceof DecisionError) {
    const raise: AppIssueCode[] =
      err.kind === "auth"
        ? ["decision_auth_failed"]
        : err.kind === "deployment_not_found"
          ? ["decision_deployment_not_found"]
          : [];
    return plan(err.code, err.retryAfterMs, { raise });
  }
  if (err instanceof ClearboxError) return plan(err.code, null);
  return plan("internal", null);
}

const ACCOUNT_FAILURE = `UPDATE accounts SET attempts = attempts + 1, backoff_until = ?2, status = ?3,
    status_reason = ?4, last_error = ?5,
    enc_access_token = COALESCE(?6, enc_access_token), access_iv = COALESCE(?7, access_iv),
    access_expires_at = COALESCE(?8, access_expires_at),
    enc_refresh_token = COALESCE(?9, enc_refresh_token), refresh_iv = COALESCE(?10, refresh_iv),
    page_size = CASE WHEN ?11 = 1 THEN MAX(5, page_size / 2) ELSE page_size END,
    last_tick_at = ?12, tick_finished_at = ?12, updated_at = ?12
  WHERE id = ?1 AND status <> 'disconnected'`;

export interface FailureWriteInput {
  accountId: string;
  tickId: string;
  now: number;
  plan: FailurePlan;
  /** Rotated tokens captured before the failure (Microsoft rotation must never be lost). */
  tokens: TokenColumns | null;
  issues: readonly AppIssue[] | null;
}

/** Contracts 8.2 "D1 call 3'": one batch, nothing ingested. */
export function buildFailureWrite(i: FailureWriteInput): Stmt[] {
  const t = i.tokens;
  const stmts: Stmt[] = [
    stmt(
      ACCOUNT_FAILURE,
      i.accountId,
      i.plan.backoffUntil,
      i.plan.status,
      i.plan.statusReason,
      i.plan.errorCode,
      t?.encAccess ?? null,
      t?.accessIv ?? null,
      t?.accessExpiresAt ?? null,
      t?.encRefresh ?? null,
      t?.refreshIv ?? null,
      i.plan.halvePageSize ? 1 : 0,
      i.now,
    ),
    leaseReleaseStmt(i.accountId, i.tickId, i.now),
  ];
  if (i.plan.audit !== null) {
    stmts.push(
      auditStmt(i.now, i.accountId, i.plan.audit, 1, { reason: i.plan.statusReason ?? i.plan.errorCode }),
    );
  }
  if (i.issues !== null) stmts.push(issuesStmt(i.issues, i.now));
  return stmts;
}
