import type { SubrequestCounter } from "@clearbox/core";
import type { AccountPhase, AppIssueCode, TickKind, TickReport } from "../../shared/api.ts";
import { logEvent } from "../log.ts";
import type { TickAccountRow, TickSettings } from "./claim.ts";
import { buildFailureWrite, classifyFailure } from "./failure.ts";
import { encryptTokenUpdate } from "./tick-tokens.ts";
import type { Processed } from "./tick-process.ts";
import { emptyStats, percentile } from "./tick-stats.ts";
import type { DecisionStats } from "./tick-stats.ts";
import type { D1TokenSource } from "./token-source.ts";
import { applyIssues, budgetUpsertStmt, isoOf, lastSizeAfter, rowsOf, sumMeta } from "./write-plan.ts";
import type { BatchResult, BatchRunner, IssueChange, IssueRaise } from "./write-plan.ts";

export interface TickResult {
  outcome: "processed" | "error";
  phase: AccountPhase;
  nextTickAt: number | null;
  errorCode: string | null;
  freshCount: number;
  rowsWritten: number;
  rowsRead: number;
  dbSize: number;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  removed: number;
  issues: IssueChange | null;
}

export function successResult(p: Processed, res: readonly BatchResult[]): TickResult {
  return {
    outcome: "processed",
    phase: p.advance.phase,
    nextTickAt:
      rowsOf<{ next_tick_at: number }>(res[p.write.nextTickIndex])[0]?.next_tick_at ?? p.advance.nextTickAt,
    errorCode: null,
    freshCount: p.freshCount,
    rowsWritten: sumMeta(res, "rows_written"),
    rowsRead: p.rowsRead + sumMeta(res, "rows_read"),
    dbSize: lastSizeAfter(res),
    stats: p.stats,
    fetched: p.fetched,
    skippedKnown: p.skippedKnown,
    removed: p.write.dismissals.reduce((n, i) => n + (res[i]?.meta?.changes ?? 0), 0),
    issues: p.issues,
  };
}

export function idleReport(subrequests: number, nextTickAt: number | null): TickReport {
  return {
    outcome: "idle",
    accountId: null,
    kind: null,
    phase: null,
    fetched: 0,
    skippedKnown: 0,
    decided: 0,
    deferred: 0,
    unsure: 0,
    removed: 0,
    subrequests,
    rowsWritten: 0,
    nextTickAt: nextTickAt === null ? null : isoOf(nextTickAt),
    errorCode: null,
  };
}

export interface FinishParams {
  run: BatchRunner;
  final: SubrequestCounter;
  claimRowsWritten: number;
  claimRowsRead: number;
  result: TickResult;
  account: TickAccountRow;
  kind: TickKind;
  tickId: string;
  today: string;
  now: number;
  providerCalls: number;
  startedAt: number;
}

/** D1 call 4 (budget), logs and the report. */
export async function finishTick(f: FinishParams): Promise<TickReport> {
  const r = f.result;
  const rowsWritten = f.claimRowsWritten + r.rowsWritten + 1;
  try {
    await f.run(f.final, [
      budgetUpsertStmt({
        date: f.today,
        rowsWritten,
        rowsRead: f.claimRowsRead + r.rowsRead,
        ticks: 1,
        messagesIngested: r.freshCount,
        decisionCalls: r.stats.calls,
        decisionFailures: r.stats.failures,
        decisionInputTokens: r.stats.inputTokens,
        providerCalls: f.providerCalls,
        dbSizeBytes: r.dbSize,
        now: f.now,
      }),
    ]);
  } catch {
    logEvent("tick.failed", {
      tickId: f.tickId,
      accountId: f.account.id,
      kind: f.kind,
      errorCode: "budget_write_failed",
      attempts: f.account.attempts,
      retryAfterMs: null,
    });
  }
  for (const code of r.issues?.raised ?? []) logEvent("issue.raised", { code, accountId: null });
  for (const code of r.issues?.cleared ?? []) logEvent("issue.cleared", { code, accountId: null });
  if (r.outcome === "processed") {
    logEvent("tick.done", {
      tickId: f.tickId,
      accountId: f.account.id,
      kind: f.kind,
      fetched: r.fetched,
      skippedKnown: r.skippedKnown,
      decided: r.stats.decided,
      deferred: r.stats.deferred,
      unsure: r.stats.unsure,
      removed: r.removed,
      subrequests: f.final.used,
      rowsWritten,
      rowsRead: f.claimRowsRead + r.rowsRead,
      inputTokens: r.stats.inputTokens,
      decisionP50Ms: percentile(r.stats.latencies, 0.5),
      decisionP95Ms: percentile(r.stats.latencies, 0.95),
      durationMs: Math.round(performance.now() - f.startedAt),
    });
  }
  return {
    outcome: r.outcome,
    accountId: f.account.id,
    kind: f.kind,
    phase: r.phase,
    fetched: r.fetched,
    skippedKnown: r.skippedKnown,
    decided: r.stats.decided,
    deferred: r.stats.deferred,
    unsure: r.stats.unsure,
    removed: r.removed,
    subrequests: f.final.used,
    rowsWritten,
    nextTickAt: r.nextTickAt === null ? null : isoOf(r.nextTickAt),
    errorCode: r.errorCode,
  };
}

export interface FailParams {
  err: unknown;
  account: TickAccountRow;
  kind: TickKind;
  tickId: string;
  now: number;
  settings: TickSettings;
  tokens: D1TokenSource;
  encKey: CryptoKey;
  run: BatchRunner;
  final: SubrequestCounter;
  raise: readonly IssueRaise[];
  clear: readonly AppIssueCode[];
}

/** Contracts 8.2 catch branch: persist the failure, keep rotated tokens, release the lease. */
export async function failTick(f: FailParams): Promise<TickResult> {
  const plan = classifyFailure(f.err, {
    provider: f.account.provider,
    attempts: f.account.attempts,
    now: f.now,
    pageSize: f.account.page_size,
  });
  const update = f.tokens.update;
  const clear = [...f.clear];
  if (update !== null) {
    clear.push(f.account.provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid");
  }
  const issues = applyIssues(
    f.settings.issues,
    [...f.raise, ...plan.raise.map((code) => ({ code, accountId: null }))],
    clear,
    f.now,
  );
  const tokens = update === null ? null : await encryptTokenUpdate(f.encKey, f.account, update);
  const res = await f.run(
    f.final,
    buildFailureWrite({
      accountId: f.account.id,
      tickId: f.tickId,
      now: f.now,
      plan,
      tokens,
      issues: issues.changed ? issues.issues : null,
    }),
  );
  if (plan.provider !== null) {
    logEvent("provider.error", {
      tickId: f.tickId,
      accountId: f.account.id,
      provider: f.account.provider,
      errorCode: plan.errorCode,
      status: plan.provider.status,
    });
  }
  if (plan.status !== "active") {
    logEvent("account.status", {
      accountId: f.account.id,
      from: "active",
      to: plan.status,
      reason: plan.statusReason,
    });
  }
  logEvent("tick.failed", {
    tickId: f.tickId,
    accountId: f.account.id,
    kind: f.kind,
    errorCode: plan.errorCode,
    attempts: f.account.attempts + 1,
    retryAfterMs: plan.retryAfterMs,
  });
  return {
    outcome: "error",
    phase: f.account.phase,
    nextTickAt: plan.status !== "active" ? null : (plan.backoffUntil ?? f.now),
    errorCode: plan.errorCode,
    freshCount: 0,
    rowsWritten: sumMeta(res, "rows_written"),
    rowsRead: sumMeta(res, "rows_read"),
    dbSize: lastSizeAfter(res),
    stats: emptyStats(),
    fetched: 0,
    skippedKnown: 0,
    removed: 0,
    issues,
  };
}
