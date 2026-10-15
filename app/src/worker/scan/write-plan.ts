import {
  DECIDED_TTL_MS,
  MESSAGE_SUBJECT_MAX_CHARS,
  PENDING_TTL_MS,
  POLL_INTERVAL_MS,
  SENT_BACKFILL_MAX_MESSAGES,
} from "@clearbox/core";
import type { SentItem, SubrequestCounter } from "@clearbox/core";
import type { AccountPhase, AppIssue, AppIssueCode } from "../../shared/api.ts";
import { chunk, toIso as isoOf, withCount } from "../db/sql.ts";
import { truncateText } from "./ingest.ts";
import type { FinalItem } from "./ingest.ts";
import type { TokenColumns } from "./tick-tokens.ts";

export type SqlValue = string | number | null | Uint8Array;

/** A D1 statement as plain data; `tick.ts` binds it with `db.prepare(sql).bind(...params)`. */
export interface Stmt {
  sql: string;
  params: SqlValue[];
}

/** Structural subset of D1Result, so builders and parsers stay free of Workers types. */
export interface BatchResult {
  results?: unknown[];
  meta?: { changes?: number; rows_read?: number; rows_written?: number; size_after?: number };
}

/** Values per IN list; keeps every statement under D1's 100 bound parameters. */
export const IN_LIST_MAX = 90;

export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

/** "?start, ?start+1, ..." for IN lists that follow fixed leading parameters. */
export function numbered(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

export function rowsOf<T>(r: BatchResult | undefined): T[] {
  return (r?.results ?? []) as T[];
}

export function sumMeta(
  results: readonly BatchResult[],
  field: "changes" | "rows_read" | "rows_written",
): number {
  let total = 0;
  for (const r of results) total += r.meta?.[field] ?? 0;
  return total;
}

/** Runs one statement list as a single D1 batch (one transaction). */
export type BatchRunner = (counter: SubrequestCounter, stmts: readonly Stmt[]) => Promise<BatchResult[]>;

/**
 * The shared D1 call for the tick and the nightly job: each non-empty batch reserves one subrequest from the
 * counter (contracts 8.4); an empty list makes no call. `io` wraps the awaited call (the tick's stopwatch).
 */
export function batchRunner(
  db: D1Database,
  io: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): BatchRunner {
  return async (counter, stmts) => {
    if (stmts.length === 0) return [];
    return io(() =>
      withCount(counter, () => db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)))),
    );
  };
}

export function lastSizeAfter(results: readonly BatchResult[]): number {
  for (let i = results.length - 1; i >= 0; i--) {
    const size = results[i]?.meta?.size_after;
    if (typeof size === "number" && size > 0) return size;
  }
  return 0;
}

// Date helpers are plan 03's (db/sql.ts); re-exported so scan and nightly builders import one module.
export { nextUtcMidnight, toIso as isoOf, utcDate } from "../db/sql.ts";

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

export interface AccountCursorState {
  phase: AccountPhase;
  backfill_done: number;
  sent_cursor: string | null;
  sent_scanned: number;
  backfill_cursor: string | null;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
}

export type PageOutcome =
  | { kind: "sent_backfill"; itemCount: number; nextCursor: string | null }
  | { kind: "inbox_backfill"; nextCursor: string | null; partial: boolean }
  | { kind: "incremental"; startCursor: string; nextCursor: string; caughtUp: boolean; partial: boolean }
  | { kind: "redecide" };

export interface AccountAdvance extends AccountCursorState {
  nextTickAt: number;
}

/** Contracts 8.3. A partial page (subrequest squeeze) keeps the cursor so the next tick resumes it. */
export function computeAdvance(
  cur: AccountCursorState,
  out: PageOutcome,
  maxReceivedAt: number | null,
  now: number,
): AccountAdvance {
  const next: AccountAdvance = {
    phase: cur.phase,
    backfill_done: cur.backfill_done,
    sent_cursor: cur.sent_cursor,
    sent_scanned: cur.sent_scanned,
    backfill_cursor: cur.backfill_cursor,
    incremental_cursor: cur.incremental_cursor,
    last_incremental_at: cur.last_incremental_at,
    watermark_received_at:
      maxReceivedAt === null
        ? cur.watermark_received_at
        : Math.max(cur.watermark_received_at ?? 0, maxReceivedAt),
    nextTickAt: now,
  };
  switch (out.kind) {
    case "sent_backfill": {
      next.sent_cursor = out.nextCursor;
      next.sent_scanned = cur.sent_scanned + out.itemCount;
      if (out.nextCursor === null || next.sent_scanned >= SENT_BACKFILL_MAX_MESSAGES) {
        next.phase = "inbox_backfill";
      }
      return next;
    }
    case "inbox_backfill":
      if (out.partial) return next;
      next.backfill_cursor = out.nextCursor;
      if (out.nextCursor === null) {
        next.phase = "incremental";
        next.backfill_done = 1;
      }
      return next;
    case "incremental":
      next.incremental_cursor = out.partial ? out.startCursor : out.nextCursor;
      // A partial poll is not a completed poll: keeping last_incremental_at makes selectKind resume it on the
      // next tick (C9) instead of switching back to the backfill until the next 30-minute poll.
      if (!out.partial) next.last_incremental_at = now;
      if (cur.phase === "incremental" && out.caughtUp && !out.partial) {
        next.nextTickAt = now + POLL_INTERVAL_MS;
      }
      return next;
    case "redecide":
      return next;
  }
}

const MESSAGE_INSERT = `INSERT INTO messages (account_id, provider_msg_id, thread_id, internet_message_id, sender,
    sender_name, sender_domain, subject, snippet, received_at, is_read, signals_json, web_link, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
  ON CONFLICT (account_id, provider_msg_id) DO NOTHING`;

const SUGGESTION_INSERT = `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action,
    confidence, p_delete, p_archive, p_keep, p_unsure, model_p_delete, margin, importance, flags_json, ceiling,
    ceiling_applied, reasons_json, model_version, policy_version, decision_attempts, retry_after, created_at,
    updated_at, expires_at)
  SELECT m.id, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
    ?23, ?23, ?24
  FROM messages m WHERE m.account_id = ?1 AND m.provider_msg_id = ?2
  ON CONFLICT (message_id) DO NOTHING`;

const SUGGESTION_REDECIDE = `UPDATE suggestions SET status = ?3, action = ?4, confidence = ?5, p_delete = ?6,
    p_archive = ?7, p_keep = ?8, p_unsure = ?9, model_p_delete = ?10, margin = ?11, importance = ?12,
    flags_json = ?13, ceiling = ?14, ceiling_applied = ?15, reasons_json = ?16, model_version = ?17,
    decision_attempts = ?18, retry_after = ?19, updated_at = ?20
  WHERE message_id = ?1 AND account_id = ?2 AND status = 'awaiting_model'`;

const SENDER_UPSERT = `INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (account_id, address) DO UPDATE SET seen_count = seen_count + excluded.seen_count,
    read_count = read_count + excluded.read_count, last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`;

const CORRESPONDENT_UPSERT = `INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (account_id, address) DO UPDATE SET last_sent_at = excluded.last_sent_at
  WHERE excluded.last_sent_at > correspondents.last_sent_at`;

const THREAD_UPSERT = `INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (account_id, thread_id) DO UPDATE SET last_sent_at = excluded.last_sent_at
  WHERE excluded.last_sent_at > sent_threads.last_sent_at`;

// action = COALESCE(action, 'unsure') mirrors db/suggestions.ts dismissOpenStmt: the schema CHECK
// (status = 'awaiting_model' OR action IS NOT NULL) would otherwise reject dismissing an awaiting_model row.
function dismissSql(n: number): string {
  return `UPDATE suggestions SET status = 'dismissed', action = COALESCE(action, 'unsure'), updated_at = ?1,
      expires_at = ?2
    WHERE account_id = ?3 AND (status = 'pending' OR status = 'awaiting_model')
      AND message_id IN (SELECT id FROM messages WHERE account_id = ?3 AND provider_msg_id IN (${numbered(4, n)}))`;
}

const ACCOUNT_SUCCESS = `UPDATE accounts SET phase = ?2, backfill_done = MAX(backfill_done, ?3), sent_cursor = ?4,
    sent_scanned = ?5, backfill_cursor = ?6, incremental_cursor = ?7, last_incremental_at = ?8,
    watermark_received_at = ?9,
    enc_access_token = COALESCE(?10, enc_access_token), access_iv = COALESCE(?11, access_iv),
    access_expires_at = COALESCE(?12, access_expires_at),
    enc_refresh_token = COALESCE(?13, enc_refresh_token), refresh_iv = COALESCE(?14, refresh_iv),
    attempts = 0, backoff_until = NULL, last_error = NULL, status_reason = NULL,
    next_tick_at = MIN(?15, COALESCE((SELECT MIN(retry_after) FROM suggestions
      WHERE account_id = ?1 AND status = 'awaiting_model'), ?15)),
    last_tick_at = ?16, tick_finished_at = ?16, page_size = MIN(?17, page_size + 5),
    messages_ingested = messages_ingested + ?18, inbox_estimate = COALESCE(?19, inbox_estimate), updated_at = ?16
  WHERE id = ?1 AND status <> 'disconnected'`;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function suggestionColumns(it: FinalItem): SqlValue[] {
  const s = it.suggestion;
  const d = s?.distribution ?? null;
  return [
    s?.action ?? null,
    s === null ? null : clamp01(s.confidence),
    d === null ? null : clamp01(d.delete),
    d === null ? null : clamp01(d.archive),
    d === null ? null : clamp01(d.keep),
    d === null ? null : clamp01(d.unsure),
    s === null || s.modelDelete === null ? null : clamp01(s.modelDelete),
    s?.margin ?? null,
    s?.importance ?? null,
    s?.flags ? JSON.stringify(s.flags) : null,
    s?.ceiling ?? it.guard.ceiling,
    s?.ceilingApplied ? 1 : 0,
    JSON.stringify(s?.reasons ?? []),
  ];
}

export interface SuccessWriteInput {
  accountId: string;
  tickId: string;
  now: number;
  policyVersion: number;
  storeSnippets: boolean;
  /** Fresh items (existingMessageId null) are inserted; re-decided items update their suggestion. */
  items: readonly FinalItem[];
  sent: readonly SentItem[];
  ownerAddresses: readonly string[];
  removedIds: readonly string[];
  /** Full issue list when it changed, else null. */
  issues: readonly AppIssue[] | null;
  advance: AccountAdvance;
  tokens: TokenColumns | null;
  maxPageSize: number;
  /** Amendment A4: fresh provider inbox total, or null to keep the stored value. */
  inboxEstimate: number | null;
}

export interface SuccessWrite {
  stmts: Stmt[];
  /** Indexes of dismissal statements (sum their meta.changes for TickReport.removed). */
  dismissals: number[];
  /** Index of the trailing SELECT next_tick_at. */
  nextTickIndex: number;
}

/** One D1 batch = one transaction (contracts 8.2, D1 call 3). */
export function buildSuccessWrite(i: SuccessWriteInput): SuccessWrite {
  const stmts: Stmt[] = [];
  const fresh = i.items.filter((it) => it.existingMessageId === null);
  for (const it of fresh) {
    const sig = it.signals;
    stmts.push(
      stmt(
        MESSAGE_INSERT,
        i.accountId,
        it.msg.providerMessageId,
        it.msg.threadId,
        it.msg.internetMessageId,
        sig.senderAddress,
        sig.senderName,
        sig.senderDomain,
        truncateText(it.msg.subject, MESSAGE_SUBJECT_MAX_CHARS),
        i.storeSnippets ? it.msg.snippet : null,
        it.msg.receivedAt,
        it.msg.isRead ? 1 : 0,
        JSON.stringify(sig),
        it.msg.webLink,
        i.now,
      ),
    );
  }
  for (const it of fresh) {
    stmts.push(
      stmt(
        SUGGESTION_INSERT,
        i.accountId,
        it.msg.providerMessageId,
        it.signals.senderAddress,
        it.signals.senderDomain,
        it.status,
        ...suggestionColumns(it),
        it.modelVersion,
        i.policyVersion,
        it.attempts,
        it.retryAfter,
        i.now,
        i.now + PENDING_TTL_MS,
      ),
    );
  }
  for (const it of i.items) {
    if (it.existingMessageId === null) continue;
    stmts.push(
      stmt(
        SUGGESTION_REDECIDE,
        it.existingMessageId,
        i.accountId,
        it.status,
        ...suggestionColumns(it),
        it.modelVersion,
        it.attempts,
        it.retryAfter,
        i.now,
      ),
    );
  }
  const senders = new Map<string, { domain: string; seen: number; read: number; last: number }>();
  for (const it of fresh) {
    const address = it.signals.senderAddress;
    if (address === "") continue;
    const cur = senders.get(address) ?? { domain: it.signals.senderDomain, seen: 0, read: 0, last: 0 };
    senders.set(address, {
      domain: cur.domain,
      seen: cur.seen + 1,
      read: cur.read + (it.msg.isRead ? 1 : 0),
      last: Math.max(cur.last, it.msg.receivedAt),
    });
  }
  for (const [address, d] of senders) {
    stmts.push(stmt(SENDER_UPSERT, i.accountId, address, d.domain, d.seen, d.read, d.last));
  }
  const owners = new Set(i.ownerAddresses);
  const addresses = new Map<string, number>();
  const threads = new Map<string, number>();
  for (const item of i.sent) {
    for (const raw of item.recipients) {
      const address = raw.toLowerCase();
      if (address === "" || owners.has(address)) continue;
      addresses.set(address, Math.max(addresses.get(address) ?? 0, item.sentAt));
    }
    if (item.threadId !== null) {
      threads.set(item.threadId, Math.max(threads.get(item.threadId) ?? 0, item.sentAt));
    }
  }
  for (const [address, at] of addresses) stmts.push(stmt(CORRESPONDENT_UPSERT, i.accountId, address, at));
  for (const [thread, at] of threads) stmts.push(stmt(THREAD_UPSERT, i.accountId, thread, at));
  const dismissals: number[] = [];
  if (i.removedIds.length > 0) {
    for (const c of chunk(i.removedIds, IN_LIST_MAX)) {
      dismissals.push(stmts.length);
      stmts.push(stmt(dismissSql(c.length), i.now, i.now + DECIDED_TTL_MS, i.accountId, ...c));
    }
  }
  if (i.issues !== null) stmts.push(issuesStmt(i.issues, i.now));
  const a = i.advance;
  const t = i.tokens;
  stmts.push(
    stmt(
      ACCOUNT_SUCCESS,
      i.accountId,
      a.phase,
      a.backfill_done,
      a.sent_cursor,
      a.sent_scanned,
      a.backfill_cursor,
      a.incremental_cursor,
      a.last_incremental_at,
      a.watermark_received_at,
      t?.encAccess ?? null,
      t?.accessIv ?? null,
      t?.accessExpiresAt ?? null,
      t?.encRefresh ?? null,
      t?.refreshIv ?? null,
      a.nextTickAt,
      i.now,
      i.maxPageSize,
      fresh.length,
      i.inboxEstimate,
    ),
  );
  stmts.push(leaseReleaseStmt(i.accountId, i.tickId, i.now));
  const nextTickIndex = stmts.length;
  stmts.push(stmt("SELECT next_tick_at FROM accounts WHERE id = ?1", i.accountId));
  return { stmts, dismissals, nextTickIndex };
}
