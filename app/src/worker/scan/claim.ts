import {
  CALIBRATED_SEGMENTS,
  DEFAULT_POLICY,
  LEASE_TTL_MS,
  TAU_DELETE_DEFAULT,
  TAU_DELETE_MAX,
  TAU_DELETE_MIN,
  parsePolicy,
} from "@clearbox/core";
import type { CalibratedSegment, Policy, ProviderKind, SegmentTaus } from "@clearbox/core";
import type { AccountPhase, AppIssue } from "../../shared/api.ts";
import { ApiError } from "../middleware/errors.ts";
import { isoOf, nextUtcMidnight, rowsOf, stmt, sumMeta } from "./write-plan.ts";
import type { BatchResult, Stmt } from "./write-plan.ts";

/** Contracts 8.2, verbatim. ?1 holder, ?2 now, ?3 expires_at, ?4 accountId or NULL, ?5 force, ?6 today, ?7 stop rows. */
export const CLAIM_SQL = `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
SELECT 'account:' || a.id, a.id, ?1, ?2, ?3, NULL
FROM accounts a
WHERE a.status = 'active'
  AND a.paused = 0
  AND (?4 IS NULL OR a.id = ?4)
  AND (a.backoff_until IS NULL OR a.backoff_until <= ?2)
  AND (?5 = 1 OR a.next_tick_at <= ?2)
  AND COALESCE((SELECT b.rows_written FROM budget b WHERE b.date = ?6), 0) < ?7
  AND NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.name = 'account:' || a.id AND l.released_at IS NULL AND l.expires_at > ?2
  )
ORDER BY a.last_tick_at IS NOT NULL, a.last_tick_at
LIMIT 1
ON CONFLICT (name) DO UPDATE SET
  account_id = excluded.account_id, holder = excluded.holder, acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING account_id`;

const HELD = "(SELECT account_id FROM leases WHERE holder = ?1 AND released_at IS NULL)";

export interface ClaimParams {
  tickId: string;
  now: number;
  accountId: string | null;
  force: boolean;
  today: string;
  stopRows: number;
}

export function claimStatements(p: ClaimParams): Stmt[] {
  return [
    stmt(CLAIM_SQL, p.tickId, p.now, p.now + LEASE_TTL_MS, p.accountId, p.force ? 1 : 0, p.today, p.stopRows),
    stmt(
      `UPDATE accounts SET tick_started_at = ?2,
         page_size = CASE WHEN tick_started_at IS NOT NULL
                           AND (tick_finished_at IS NULL OR tick_finished_at < tick_started_at)
                          THEN MAX(5, page_size / 2) ELSE page_size END,
         updated_at = ?2
       WHERE id = ${HELD}`,
      p.tickId,
      p.now,
    ),
    stmt(`SELECT * FROM accounts WHERE id = COALESCE(${HELD}, ?2)`, p.tickId, p.accountId),
    stmt("SELECT key, value FROM settings"),
    stmt("SELECT * FROM budget WHERE date = ?1", p.today),
    stmt(
      `SELECT COUNT(*) AS n FROM suggestions
       WHERE account_id = ${HELD} AND status = 'awaiting_model' AND (retry_after IS NULL OR retry_after <= ?2)`,
      p.tickId,
      p.now,
    ),
    stmt("SELECT holder, expires_at, released_at FROM leases WHERE name = 'account:' || ?1", p.accountId),
  ];
}

export interface TickAccountRow {
  id: string;
  provider: ProviderKind;
  email: string;
  status: string;
  status_reason: string | null;
  paused: number;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
  owner_aliases_json: string;
  archive_folder_id: string | null;
  phase: AccountPhase;
  sent_cursor: string | null;
  sent_scanned: number;
  backfill_cursor: string | null;
  backfill_done: number;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
  page_size: number;
  attempts: number;
  backoff_until: number | null;
  next_tick_at: number;
  last_tick_at: number | null;
  inbox_estimate: number | null;
}

export interface BudgetRow {
  date: string;
  rows_written: number;
  db_size_bytes: number;
}

export interface LeaseRow {
  holder: string;
  expires_at: number;
  released_at: number | null;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface ClaimResult {
  claimedAccountId: string | null;
  account: TickAccountRow | null;
  settings: SettingRow[];
  budget: BudgetRow | null;
  awaitingDue: number;
  lease: LeaseRow | null;
  rowsWritten: number;
  rowsRead: number;
}

export function parseClaim(results: readonly BatchResult[]): ClaimResult {
  return {
    claimedAccountId: rowsOf<{ account_id: string }>(results[0])[0]?.account_id ?? null,
    account: rowsOf<TickAccountRow>(results[2])[0] ?? null,
    settings: rowsOf<SettingRow>(results[3]),
    budget: rowsOf<BudgetRow>(results[4])[0] ?? null,
    awaitingDue: rowsOf<{ n: number }>(results[5])[0]?.n ?? 0,
    lease: rowsOf<LeaseRow>(results[6])[0] ?? null,
    rowsWritten: sumMeta(results, "rows_written"),
    rowsRead: sumMeta(results, "rows_read"),
  };
}

export interface TickSettings {
  policy: Policy;
  policyVersion: number;
  tauDelete: number;
  /** contracts 12.10: settings 'tau_segments'; null before the first segment calibration. */
  segmentTaus: SegmentTaus | null;
  issues: AppIssue[];
}

export function parseTickSettings(rows: readonly SettingRow[]): TickSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  let policy: Policy;
  try {
    policy = parsePolicy(map.get("policy") ?? null);
  } catch {
    policy = DEFAULT_POLICY;
  }
  const tau = Number(map.get("tau_delete") ?? TAU_DELETE_DEFAULT);
  const version = Number(map.get("policy_version") ?? 1);
  let issues: AppIssue[] = [];
  const raw = map.get("issues");
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) issues = parsed as AppIssue[];
    } catch {
      issues = [];
    }
  }
  return {
    policy,
    segmentTaus: parseSegmentTaus(map.get("tau_segments") ?? null),
    policyVersion: Number.isInteger(version) && version >= 1 ? version : 1,
    tauDelete: Number.isFinite(tau)
      ? Math.min(TAU_DELETE_MAX, Math.max(TAU_DELETE_MIN, tau))
      : TAU_DELETE_DEFAULT,
    issues,
  };
}

/**
 * contracts 12.10: {"sender": 0.93, "bulk": null, ...}. Values are clamped to [TAU_DELETE_MIN, TAU_DELETE_MAX]; null
 * pauses a segment; unknown keys and invalid values are dropped. Returns null when absent or unreadable.
 */
export function parseSegmentTaus(raw: string | null): SegmentTaus | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Partial<Record<CalibratedSegment, number | null>> = {};
  for (const segment of CALIBRATED_SEGMENTS) {
    const value = (parsed as Record<string, unknown>)[segment];
    if (value === null) out[segment] = null;
    else if (typeof value === "number" && Number.isFinite(value))
      out[segment] = Math.min(TAU_DELETE_MAX, Math.max(TAU_DELETE_MIN, value));
  }
  return out;
}

/** Contracts 7.5: why a scan-now request could not claim its account. */
export function scanNowError(c: ClaimResult, now: number, stopRows: number): ApiError {
  const a = c.account;
  if (a === null || a.status === "disconnected") return new ApiError(404, "not_found", "Account not found");
  if (a.status !== "active" || a.paused === 1) {
    return new ApiError(409, "account_inactive", "Account is not active");
  }
  if (c.lease !== null && c.lease.released_at === null && c.lease.expires_at > now) {
    return new ApiError(409, "account_busy", "A scan is already running for this account", {
      retryAt: isoOf(c.lease.expires_at),
    });
  }
  if (a.backoff_until !== null && a.backoff_until > now) {
    return new ApiError(409, "account_inactive", "Account is waiting after an error", {
      retryAt: isoOf(a.backoff_until),
    });
  }
  if ((c.budget?.rows_written ?? 0) >= stopRows) {
    return new ApiError(429, "budget_exhausted", "Daily database write budget reached", {
      retryAt: isoOf(nextUtcMidnight(now)),
    });
  }
  return new ApiError(409, "account_busy", "Account could not be claimed", { retryAt: isoOf(now + 60_000) });
}
