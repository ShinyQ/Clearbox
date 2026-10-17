import {
  BUDGET_ROWS_PER_DAY,
  ClearboxError,
  DECIDED_TTL_MS,
  MAX_ITEMS_PER_ACTION_REQUEST,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  UNDO_WINDOW_MS,
} from "@clearbox/core";
import type { ActionErrorCode, ActionKind, MailProvider } from "@clearbox/core";
import type { ActionResponse, AppIssue, ItemErrorCode, ItemOutcome, ItemResult } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { listAccounts, markAccountStatusStmt } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { insertBatchStmt } from "../db/batches.ts";
import type { BatchKind } from "../db/batches.ts";
import { budgetDeltaStmt, readBudget } from "../db/budget.ts";
import type { Budget } from "../db/budget.ts";
import { insertLabelStmt } from "../db/labels.ts";
import { updateProviderMsgIdStmt } from "../db/messages.ts";
import { priorStatements } from "../db/priors.ts";
import { addIssue, issuesEqual, readSettings, setIssuesStmt } from "../db/settings.ts";
import {
  bindQuery,
  chunk,
  MAX_BOUND_PARAMS,
  nextUtcMidnight,
  sumRowsRead,
  sumRowsWritten,
  toIso,
  utcDate,
} from "../db/sql.ts";
import type { SqlQuery } from "../db/sql.ts";
import {
  claimQuery,
  markExecutedQuery,
  markFailedQuery,
  releaseQuery,
  remainingCleanupQuery,
  remainingGroupQuery,
  targetsByIdsQuery,
  targetsForCleanupQuery,
  targetsForGroupQuery,
} from "../db/suggestions.ts";
import type { TargetRow } from "../db/suggestions.ts";
import type { AppConfig, AppDeps } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { clientIssueCode } from "../oauth/connect.ts";
import { callbackPath } from "../scan/providers.ts";
import { createD1TokenSource, refreshFnFor, tokenUpdateStmt } from "../scan/token-source.ts";
import type { D1TokenSource } from "../scan/token-source.ts";
import { decisionPriorDeltas, labelFor } from "./learn.ts";
import { refreshScoped } from "./refresh.ts";
import type { DecidedItem } from "./learn.ts";

export type ExecuteRequest =
  | { kind: "approve_ids"; ids: readonly number[] }
  | { kind: "approve_group"; accountId: string; sender: string; action: ActionKind; asOf: number }
  | { kind: "override"; ids: readonly number[]; action: ActionKind }
  | {
      kind: "cleanup";
      actions: readonly ActionKind[];
      threshold: number;
      accountId: string | null;
      asOf: number;
    };

export interface ActionContext {
  db: D1Database;
  config: AppConfig;
  deps: AppDeps;
  requestId: string;
  /** Request origin, used for the OAuth client redirect URI on token refresh. */
  origin: string;
  /** Hono route pattern of the calling request (contracts 9 `request.error`). */
  route: string;
}

interface Candidate {
  row: TargetRow;
  action: ActionKind;
  account: Account;
}

interface Executed {
  cand: Candidate;
  newId: string | null;
}

interface Failed {
  cand: Candidate;
  code: ItemErrorCode;
}

export interface AccountFailure {
  account: Account;
  error: ProviderAuthError | ProviderConfigError;
}

/** Owner actions are refused only at BUDGET_ROWS_PER_DAY, and only on Free (contracts 6.4, 8.5). */
export function assertOwnerBudget(budget: Budget, config: AppConfig, now: number): void {
  if (!config.freeTier || budget.rowsWritten < BUDGET_ROWS_PER_DAY) return;
  logEvent("budget.gate", { date: budget.date, rowsWritten: budget.rowsWritten, gate: "owner" });
  throw new ApiError(429, "budget_exhausted", "Daily database write budget reached", {
    retryAt: toIso(nextUtcMidnight(now)),
  });
}

export function isTransient(code: ActionErrorCode): boolean {
  return code === "rate_limited" || code === "unavailable";
}

export function mapActionError(code: ActionErrorCode): ItemErrorCode {
  return code;
}

/** Whole-call provider errors (decision 13). */
export function classifyProviderError(err: unknown): {
  code: ItemErrorCode;
  authError: ProviderAuthError | ProviderConfigError | null;
} {
  if (err instanceof ProviderAuthError || err instanceof ProviderConfigError)
    return { code: "account_inactive", authError: err };
  if (err instanceof ProviderRateLimitError) return { code: "rate_limited", authError: null };
  if (err instanceof ProviderUnavailableError) return { code: "unavailable", authError: null };
  return { code: "unknown", authError: null };
}

export function openProvider(
  ctx: ActionContext,
  account: Account,
  encKey: CryptoKey,
): { provider: MailProvider; tokens: D1TokenSource } {
  const { deps } = ctx;
  const tokens = createD1TokenSource({
    account,
    encKey,
    now: deps.now,
    refresh: refreshFnFor(
      deps.oauth,
      ctx.config,
      account.provider,
      deps.fetch,
      deps.now,
      ctx.origin + callbackPath(account.provider),
    ),
  });
  const provider = deps.providerFactory(
    { provider: account.provider, archiveFolderId: account.archiveFolderId },
    { fetch: deps.fetch, tokens, now: deps.now },
  );
  return { provider, tokens };
}

export function accountFailureStatements(
  db: D1Database,
  failures: readonly AccountFailure[],
  issues: readonly AppIssue[],
  now: number,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  let next: AppIssue[] = [...issues];
  for (const f of failures) {
    const status = f.error instanceof ProviderConfigError ? "config_error" : "needs_reauth";
    stmts.push(markAccountStatusStmt(db, f.account.id, status, f.error.reason, now));
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: f.account.id,
        kind: status === "config_error" ? "config_error" : "reauth_required",
        batchId: null,
        count: 0,
        result: {},
      }),
    );
    logEvent("account.status", {
      accountId: f.account.id,
      from: f.account.status,
      to: status,
      reason: f.error.reason,
    });
    if (status === "config_error") {
      const code = clientIssueCode(f.account.provider);
      const updated = addIssue(next, code, null, now);
      if (!issuesEqual(next, updated)) logEvent("issue.raised", { code, accountId: null });
      next = updated;
    }
  }
  if (!issuesEqual(issues, next)) stmts.push(setIssuesStmt(db, next, now));
  return stmts;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

function batchKindOf(req: ExecuteRequest): BatchKind {
  return req.kind === "override" ? "override" : req.kind === "cleanup" ? "cleanup" : "approve";
}

/**
 * Clean up scope, shared by POST /api/cleanup, its preview and QueueSummary.cleanup. delete/archive only reach
 * accounts with status active (paused included, decision 12), so an inactive account's pending items can never
 * fill a Clean up page with retry_later results. Keep-only ("Confirm all keeps") makes no provider call and
 * covers every visible account. Empty when nothing can match (unknown or excluded ids), so callers never build
 * an `IN ()` list.
 */
export function cleanupAccountIds(
  accounts: readonly Account[],
  actions: readonly ActionKind[],
  accountId: string | null,
): string[] {
  if (actions.length === 0) return [];
  const moving = actions.some((a) => a !== "keep");
  return accounts
    .filter((a) => (accountId === null || a.id === accountId) && (!moving || a.status === "active"))
    .map((a) => a.id);
}

function cleanupScope(
  req: Extract<ExecuteRequest, { kind: "cleanup" }>,
  accounts: readonly Account[],
): string[] {
  return cleanupAccountIds(accounts, req.actions, req.accountId);
}

async function selectTargets(
  db: D1Database,
  req: ExecuteRequest,
  accounts: readonly Account[],
): Promise<TargetRow[]> {
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return [];
  if (accountIds.length > 90) throw new ClearboxError("too_many_accounts");
  let queries: SqlQuery[] = [];
  if (req.kind === "approve_ids" || req.kind === "override") {
    queries = chunk([...new Set(req.ids)], MAX_BOUND_PARAMS - accountIds.length).map((part) =>
      targetsByIdsQuery(accountIds, part),
    );
  } else if (req.kind === "approve_group") {
    if (accountIds.includes(req.accountId)) {
      queries = [
        targetsForGroupQuery(req.accountId, req.sender, req.action, req.asOf, MAX_ITEMS_PER_ACTION_REQUEST),
      ];
    }
  } else {
    const scope = cleanupScope(req, accounts);
    if (scope.length > 0) {
      queries = [
        targetsForCleanupQuery(scope, req.actions, req.threshold, req.asOf, MAX_ITEMS_PER_ACTION_REQUEST),
      ];
    }
  }
  if (queries.length === 0) return [];
  const results = await db.batch<TargetRow>(queries.map((q) => bindQuery(db, q)));
  return results.flatMap((r) => r.results);
}

function decided(c: Candidate): DecidedItem {
  return {
    messageId: c.row.message_id,
    accountId: c.account.id,
    sender: c.row.sender,
    senderDomain: c.row.sender_domain,
    subject: c.row.subject,
    suggestedAction: c.row.action ?? "unsure",
    ownerAction: c.action,
    pDelete: c.row.p_delete,
    margin: c.row.margin,
    ceiling: c.row.ceiling,
    segment: c.row.segment,
    modelVersion: c.row.model_version,
    policyVersion: c.row.policy_version,
  };
}

/**
 * Contracts 7.7: approve, override and Clean up share this path.
 * Invariant: no provider call happens for a suggestion this request did not move from pending to approved.
 */
export async function executeSuggestions(ctx: ActionContext, req: ExecuteRequest): Promise<ActionResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const kind = batchKindOf(req);
  const [budget, settings, visible] = await Promise.all([
    readBudget(db, utcDate(now)),
    readSettings(db),
    listAccounts(db, { includeDisconnected: false }),
  ]);
  assertOwnerBudget(budget, ctx.config, now);
  const accounts = new Map(visible.map((a) => [a.id, a]));
  const accountIds = [...accounts.keys()];
  const targets = await selectTargets(db, req, visible);

  const results = new Map<number, ItemResult>();
  const set = (id: number, outcome: ItemOutcome, action: ActionKind | null, error: ItemErrorCode | null) =>
    results.set(id, { id, outcome, action, error });
  const order =
    req.kind === "approve_ids" || req.kind === "override"
      ? [...new Set(req.ids)]
      : targets.map((t) => t.message_id);
  const byId = new Map(targets.map((t) => [t.message_id, t]));

  // 1. Classify.
  const candidates: Candidate[] = [];
  for (const id of order) {
    const row = byId.get(id);
    const account = row ? accounts.get(row.account_id) : undefined;
    if (!row || !account || row.status !== "pending") {
      set(id, "skipped", null, "not_pending");
      continue;
    }
    let action: ActionKind;
    if (req.kind === "override") {
      action = req.action;
    } else if (row.action === null || row.action === "unsure") {
      set(id, "skipped", null, "unsure_not_approvable");
      continue;
    } else {
      action = row.action;
    }
    if (action !== "keep" && account.status !== "active") {
      set(id, "retry_later", action, "account_inactive");
      continue;
    }
    candidates.push({ row, action, account });
  }

  // 2. Claim (pending -> approved).
  const writes: D1Result[] = [];
  const claimStmts: D1PreparedStatement[] = [];
  for (const [accountId, items] of groupBy(candidates, (c) => c.account.id)) {
    for (const part of chunk(
      items.map((c) => c.row.message_id),
      MAX_BOUND_PARAMS - 2,
    )) {
      claimStmts.push(bindQuery(db, claimQuery(accountId, part, now)));
    }
  }
  const claimed = new Set<number>();
  if (claimStmts.length > 0) {
    const claimResults = await db.batch<{ message_id: number }>(claimStmts);
    writes.push(...claimResults);
    for (const r of claimResults) for (const row of r.results) claimed.add(row.message_id);
  }
  const work = candidates.filter((c) => {
    if (claimed.has(c.row.message_id)) return true;
    set(c.row.message_id, "skipped", null, "not_pending");
    return false;
  });

  // 3. Provider calls, sequential per account.
  const executed: Executed[] = [];
  const failed: Failed[] = [];
  const retry: Failed[] = [];
  const failures: AccountFailure[] = [];
  const tokenStmts: D1PreparedStatement[] = [];
  let providerCalls = 0;
  const encKey = await importEncKey(ctx.config.tokenEncKey);
  for (const accountItems of groupBy(work, (c) => c.account.id).values()) {
    const account = accountItems[0]?.account;
    if (!account) continue;
    for (const c of accountItems) if (c.action === "keep") executed.push({ cand: c, newId: null });
    let moving = accountItems.filter((c) => c.action !== "keep");
    if (account.provider === "outlook" && account.archiveFolderId === null) {
      for (const c of moving)
        if (c.action === "archive") failed.push({ cand: c, code: "archive_unavailable" });
      moving = moving.filter((c) => c.action !== "archive");
    }
    if (moving.length === 0) continue;
    const { provider, tokens } = openProvider(ctx, account, encKey);
    let stop: ItemErrorCode | null = null;
    for (const action of ["delete", "archive"] as const) {
      const batch = moving.filter((c) => c.action === action);
      if (batch.length === 0) continue;
      if (stop !== null) {
        for (const c of batch) retry.push({ cand: c, code: stop });
        continue;
      }
      const pids = batch.map((c) => c.row.provider_msg_id);
      try {
        providerCalls += 1;
        const res = action === "delete" ? await provider.trash(pids) : await provider.archive(pids);
        const byPid = new Map(res.map((r) => [r.id, r]));
        for (const c of batch) {
          const r = byPid.get(c.row.provider_msg_id);
          if (!r) failed.push({ cand: c, code: "unknown" });
          else if (r.ok) executed.push({ cand: c, newId: r.newId });
          else if (isTransient(r.error)) retry.push({ cand: c, code: mapActionError(r.error) });
          else failed.push({ cand: c, code: mapActionError(r.error) });
        }
      } catch (err) {
        const failure = classifyProviderError(err);
        stop = failure.code;
        if (failure.authError) failures.push({ account, error: failure.authError });
        for (const c of batch) retry.push({ cand: c, code: failure.code });
        logEvent("provider.error", {
          requestId: ctx.requestId,
          accountId: account.id,
          provider: account.provider,
          errorCode: err instanceof ClearboxError ? err.code : "unknown",
          status: null,
        });
        // Not a provider error class: surface the class name (never the message) like onApiError does.
        if (!(err instanceof ClearboxError)) {
          logEvent("request.error", {
            requestId: ctx.requestId,
            route: ctx.route,
            errorName: err instanceof Error ? err.name : "unknown",
          });
        }
      }
    }
    if (tokens.update) tokenStmts.push(await tokenUpdateStmt(db, account, encKey, tokens.update, now));
  }

  const position = new Map(order.map((id, i) => [id, i]));
  executed.sort(
    (x, y) => (position.get(x.cand.row.message_id) ?? 0) - (position.get(y.cand.row.message_id) ?? 0),
  );
  for (const e of executed) set(e.cand.row.message_id, "executed", e.cand.action, null);
  for (const f of failed) set(f.cand.row.message_id, "failed", f.cand.action, f.code);
  for (const r of retry) set(r.cand.row.message_id, "retry_later", r.cand.action, r.code);
  const list = order.map(
    (id) =>
      results.get(id) ?? { id, outcome: "skipped" as const, action: null, error: "not_pending" as const },
  );
  const count = (o: ItemOutcome) => list.filter((r) => r.outcome === o).length;

  // 4. One D1 batch (one transaction) with every result.
  const stmts: D1PreparedStatement[] = [];
  let batchIndex = -1;
  if (executed.length > 0) {
    batchIndex = stmts.length;
    stmts.push(
      insertBatchStmt(db, {
        kind,
        suggestionIds: executed.map((e) => e.cand.row.message_id),
        requestedCount: order.length,
        executedCount: executed.length,
        failedCount: failed.length,
        createdAt: now,
        undoExpiresAt: now + UNDO_WINDOW_MS,
      }),
    );
  }
  for (const e of executed) {
    const { row, action, account } = e.cand;
    stmts.push(
      insertLabelStmt(db, account.id, labelFor(decided(e.cand), kind, settings.policy.labelSubjects, now)),
    );
    stmts.push(
      bindQuery(db, markExecutedQuery(account.id, row.message_id, action, kind, now, now + DECIDED_TTL_MS)),
    );
    if (e.newId !== null && e.newId !== row.provider_msg_id) {
      stmts.push(updateProviderMsgIdStmt(db, account.id, row.message_id, e.newId));
    }
  }
  for (const f of failed)
    stmts.push(bindQuery(db, markFailedQuery(f.cand.account.id, f.cand.row.message_id, f.code, now)));
  for (const [accountId, items] of groupBy(retry, (r) => r.cand.account.id)) {
    for (const part of chunk(
      items.map((r) => r.cand.row.message_id),
      MAX_BOUND_PARAMS - 2,
    )) {
      stmts.push(bindQuery(db, releaseQuery(accountId, part, now)));
    }
  }
  stmts.push(...priorStatements(db, decisionPriorDeltas(executed.map((e) => decided(e.cand))), now));
  stmts.push(...accountFailureStatements(db, failures, settings.issues, now));
  stmts.push(...tokenStmts);
  if (executed.length + failed.length > 0) {
    const touched = new Set([...executed, ...failed].map((x) => x.cand.account.id));
    const per = (a: ActionKind) => executed.filter((e) => e.cand.action === a).length;
    const groups = new Set(
      executed.map((e) => `${e.cand.account.id}\u001f${e.cand.row.sender}\u001f${e.cand.row.action ?? ""}`),
    );
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: touched.size === 1 ? ([...touched][0] ?? null) : null,
        kind,
        batchId: executed.length > 0 ? "latest_batch" : null,
        count: executed.length,
        result: {
          executed: count("executed"),
          failed: count("failed"),
          skipped: count("skipped"),
          retryLater: count("retry_later"),
          delete: per("delete"),
          archive: per("archive"),
          keep: per("keep"),
          groups: groups.size,
        },
      }),
    );
  }
  let remainingQuery: SqlQuery | null = null;
  if (req.kind === "approve_group" && accountIds.includes(req.accountId)) {
    remainingQuery = remainingGroupQuery(req.accountId, req.sender, req.action, req.asOf);
  } else if (req.kind === "cleanup") {
    const scope = cleanupScope(req, visible);
    if (scope.length > 0) remainingQuery = remainingCleanupQuery(scope, req.actions, req.threshold, req.asOf);
  }
  if (remainingQuery) stmts.push(bindQuery(db, remainingQuery));

  const finalResults = stmts.length > 0 ? await db.batch(stmts) : [];
  writes.push(...finalResults);
  const batchId =
    batchIndex >= 0
      ? ((finalResults[batchIndex]?.results[0] as { id: number } | undefined)?.id ?? null)
      : null;
  const remaining = remainingQuery
    ? ((finalResults[finalResults.length - 1]?.results[0] as { n: number } | undefined)?.n ?? 0)
    : 0;

  // contracts 12.10: owner decisions just moved these priors; re-fuse what is still pending for the same senders and
  // domains so Review reflects them now. Best effort: a failure here never fails the action.
  let refreshRows = { read: 0, written: 0 };
  for (const [accountId, items] of groupBy(executed, (e) => e.cand.account.id)) {
    try {
      const out = await refreshScoped(
        db,
        accountId,
        {
          senders: items.map((e) => e.cand.row.sender),
          domains: items.map((e) => e.cand.row.sender_domain),
        },
        settings,
        now,
      );
      refreshRows = { read: refreshRows.read + out.rowsRead, written: refreshRows.written + out.rowsWritten };
    } catch (err) {
      logEvent("request.error", {
        requestId: ctx.requestId,
        route: ctx.route,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // 5. Budget (contracts 8.5: counted like a tick's D1 call 4).
  await budgetDeltaStmt(
    db,
    utcDate(now),
    {
      rowsWritten: sumRowsWritten(writes) + refreshRows.written + 1,
      rowsRead: sumRowsRead(writes) + refreshRows.read,
      providerCalls,
    },
    now,
  ).run();

  const response: ActionResponse = {
    batchId,
    results: list,
    executed: count("executed"),
    failed: count("failed"),
    skipped: count("skipped"),
    retryLater: count("retry_later"),
    remaining,
  };
  logEvent("action.executed", {
    requestId: ctx.requestId,
    kind,
    batchId,
    executed: response.executed,
    failed: response.failed,
    skipped: response.skipped,
    retryLater: response.retryLater,
  });
  return response;
}
