import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import { toIso as isoOf } from "../db/sql.ts";
import { stmt } from "./stmt.ts";
import type { Stmt } from "./stmt.ts";

export function settingStmt(key: string, valueJson: string, now: number): Stmt {
  return stmt(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    valueJson,
    now,
  );
}

export type AuditKind = "reauth_required" | "config_error" | "calibration" | "purge" | "account_purged";

/**
 * result holds counts and codes only (contracts 6.1 audit_log). Not plan 03's db/audit.ts auditStmt:
 * never import both into one file.
 */
export function auditStmt(
  ts: number,
  accountId: string | null,
  kind: AuditKind,
  count: number,
  result: Readonly<Record<string, string | number>>,
): Stmt {
  return stmt(
    "INSERT INTO audit_log (ts, account_id, kind, count, result_json) VALUES (?1, ?2, ?3, ?4, ?5)",
    ts,
    accountId,
    kind,
    count,
    JSON.stringify(result),
  );
}

export function leaseReleaseStmt(accountId: string, tickId: string, now: number): Stmt {
  return stmt(
    "UPDATE leases SET released_at = ?3 WHERE name = 'account:' || ?1 AND holder = ?2",
    accountId,
    tickId,
    now,
  );
}

/** Not plan 03's db/budget.ts BudgetDelta: never import both into one file. */
export interface BudgetDelta {
  date: string;
  rowsWritten: number;
  rowsRead: number;
  ticks: number;
  messagesIngested: number;
  decisionCalls: number;
  decisionFailures: number;
  decisionInputTokens: number;
  providerCalls: number;
  /** 0 = unknown, keeps the stored value. */
  dbSizeBytes: number;
  now: number;
}

export function budgetUpsertStmt(d: BudgetDelta): Stmt {
  return stmt(
    `INSERT INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
       decision_input_tokens, provider_calls, db_size_bytes, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (date) DO UPDATE SET
       rows_written = rows_written + excluded.rows_written,
       rows_read = rows_read + excluded.rows_read,
       ticks = ticks + excluded.ticks,
       messages_ingested = messages_ingested + excluded.messages_ingested,
       decision_calls = decision_calls + excluded.decision_calls,
       decision_failures = decision_failures + excluded.decision_failures,
       decision_input_tokens = decision_input_tokens + excluded.decision_input_tokens,
       provider_calls = provider_calls + excluded.provider_calls,
       db_size_bytes = CASE WHEN excluded.db_size_bytes > 0 THEN excluded.db_size_bytes ELSE db_size_bytes END,
       updated_at = excluded.updated_at`,
    d.date,
    d.rowsWritten,
    d.rowsRead,
    d.ticks,
    d.messagesIngested,
    d.decisionCalls,
    d.decisionFailures,
    d.decisionInputTokens,
    d.providerCalls,
    d.dbSizeBytes,
    d.now,
  );
}

export interface IssueRaise {
  code: AppIssueCode;
  accountId: string | null;
}

export interface IssueChange {
  issues: AppIssue[];
  changed: boolean;
  raised: AppIssueCode[];
  cleared: AppIssueCode[];
}

/** Clears first, then raises; a code that is both raised and cleared stays raised. */
export function applyIssues(
  current: readonly AppIssue[],
  raise: readonly IssueRaise[],
  clear: readonly AppIssueCode[],
  now: number,
): IssueChange {
  const raisedCodes = new Set(raise.map((r) => r.code));
  const clearSet = new Set(clear.filter((c) => !raisedCodes.has(c)));
  const issues = current.filter((i) => !clearSet.has(i.code));
  const cleared = [...new Set(current.filter((i) => clearSet.has(i.code)).map((i) => i.code))];
  const raised: AppIssueCode[] = [];
  for (const r of raise) {
    if (issues.some((i) => i.code === r.code && i.accountId === r.accountId)) continue;
    issues.push({ code: r.code, since: isoOf(now), accountId: r.accountId });
    raised.push(r.code);
  }
  return { issues, changed: raised.length > 0 || cleared.length > 0, raised, cleared };
}

export function issuesStmt(issues: readonly AppIssue[], now: number): Stmt {
  return settingStmt("issues", JSON.stringify(issues), now);
}
