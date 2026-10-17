import type { ActivityEntry, ActivityKind } from "../../shared/api.ts";
import { MAX_BOUND_PARAMS, placeholders, toIso } from "./sql.ts";

export type AuditKind = ActivityKind;

export interface AuditEntry {
  ts: number;
  accountId: string | null;
  kind: AuditKind;
  /** "latest_batch": the action_batches row inserted earlier in the same D1 batch (decision 9). */
  batchId: number | null | "latest_batch";
  count: number;
  /** Counts and codes only, never addresses or subjects. */
  result: Readonly<Record<string, number | string>>;
}

export interface AuditRow {
  id: number;
  ts: number;
  account_id: string | null;
  kind: AuditKind;
  batch_id: number | null;
  count: number;
  result_json: string;
}

const ACTION_RESULT_KEYS = [
  "executed",
  "failed",
  "skipped",
  "retryLater",
  "delete",
  "archive",
  "keep",
  "groups",
];

/** Fixed result keys per kind (decision 28, contracts 12.1 A5). Kinds not listed are stored as given. */
const RESULT_KEYS: Partial<Record<AuditKind, readonly string[]>> = {
  approve: ACTION_RESULT_KEYS,
  override: ACTION_RESULT_KEYS,
  cleanup: ACTION_RESULT_KEYS,
  auto_trash: ACTION_RESULT_KEYS,
  undo: ["restored", "failed"],
  policy_updated: ["allow", "deny"],
  calibration: ["tauDelete"],
  unsubscribe: ["outcome", "status"],
  account_connected: [],
  account_reconnected: [],
  account_disconnected: [],
  account_paused: [],
  account_resumed: [],
  reauth_required: [],
  config_error: [],
};

/** Keeps exactly the fixed keys of the kind, missing numbers are 0. */
export function auditResult(kind: AuditKind, result: AuditEntry["result"]): Record<string, number | string> {
  const keys = RESULT_KEYS[kind];
  if (!keys) return { ...result };
  return Object.fromEntries(keys.map((k) => [k, result[k] ?? 0]));
}

export function auditStmt(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json)
       VALUES (?1, ?2, ?3, CASE WHEN ?4 = 'latest_batch' THEN (SELECT MAX(id) FROM action_batches) ELSE ?4 END, ?5, ?6)`,
    )
    .bind(
      entry.ts,
      entry.accountId,
      entry.kind,
      entry.batchId,
      entry.count,
      JSON.stringify(auditResult(entry.kind, entry.result)),
    );
}

/** Rows of the given kinds since `since` (insights weekly, contracts 12.1 A3). audit_log is small. */
export function selectAuditKindsSinceStmt(
  db: D1Database,
  since: number,
  kinds: readonly AuditKind[],
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE ts >= ?1 AND kind IN (${placeholders(kinds.length, 2)}) ORDER BY id`,
    )
    .bind(since, ...kinds);
}

export function mapActivity(row: AuditRow): ActivityEntry {
  return {
    id: row.id,
    ts: toIso(row.ts),
    kind: row.kind,
    accountId: row.account_id,
    batchId: row.batch_id,
    count: row.count,
    result: JSON.parse(row.result_json) as Record<string, number | string>,
  };
}

export function selectActivityStmt(
  db: D1Database,
  opts: { accountId: string | null; beforeId: number | null; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE (?1 IS NULL OR account_id = ?1) AND (?2 IS NULL OR id < ?2)
       ORDER BY id DESC LIMIT ?3`,
    )
    .bind(opts.accountId, opts.beforeId, opts.limit);
}

/** Action audit rows (one per executed batch) carry byAction counts in result_json (decision 16). */
export function selectBatchAuditStmt(db: D1Database, batchIds: readonly number[]): D1PreparedStatement {
  if (batchIds.length > MAX_BOUND_PARAMS)
    throw new RangeError(`at most ${MAX_BOUND_PARAMS} batch ids per statement`);
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE kind IN ('approve', 'override', 'cleanup', 'auto_trash') AND batch_id IN (${placeholders(batchIds.length)})`,
    )
    .bind(...batchIds);
}
