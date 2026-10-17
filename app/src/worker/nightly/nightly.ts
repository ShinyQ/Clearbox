import {
  BATCH_RETENTION_MS,
  CALIBRATION_SEGMENT_WINDOW,
  PURGE_STOP_ROWS,
  STALE_APPROVED_MS,
  TAU_DELETE_DEFAULT,
  TICK_SUBREQUEST_LIMIT,
  DEFAULT_POLICY,
  calibrateSegments,
  parsePolicy,
  createSubrequestCounter,
} from "@clearbox/core";
import type { ActionKind, Ceiling, DecisionSegment, Policy, SegmentCalibrationSample } from "@clearbox/core";
import { refreshPending } from "../actions/refresh.ts";
import type { RefreshSettings } from "../actions/refresh.ts";
import { parseSegmentTaus } from "../scan/claim.ts";
import { logEvent } from "../log.ts";
import {
  auditStmt,
  batchRunner,
  budgetUpsertStmt,
  lastSizeAfter,
  rowsOf,
  settingStmt,
  stmt,
  sumMeta,
  utcDate,
} from "../scan/write-plan.ts";
import type { BatchResult, Stmt } from "../scan/write-plan.ts";
import { newPurgeState, purgeDisconnected, purgeExpired } from "./purge.ts";

export const NIGHTLY_LEASE_TTL_MS = 600_000;
export const PURGE_EXPIRED_MAX_ROUNDS = 16;
export const PURGE_TOTAL_MAX_ROUNDS = 19;
const BUDGET_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const FINAL_D1_CALLS = 2;

const NIGHTLY_CLAIM = `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
VALUES ('nightly', NULL, ?1, ?2, ?3, NULL)
ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING holder`;

/** One statement per account (lead note 9), so every write on suggestions stays account-scoped. */
const STALE_APPROVED_RECOVERY = `UPDATE suggestions SET status = 'failed', exec_error = 'interrupted', updated_at = ?2
WHERE account_id = ?1 AND status = 'approved' AND updated_at < ?3`;

// Cross-account read exempted by contracts 6.1; the trailing SQL comment is the marker the isolation test reads.
const CALIBRATION_LABELS =
  "SELECT p_delete, margin, ceiling, owner_action, segment FROM labels ORDER BY id DESC LIMIT ?1 -- isolation-exempt: calibration";

interface LabelSampleRow {
  p_delete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  owner_action: ActionKind;
  segment: DecisionSegment | null;
}

/** contracts 12.10: pending rows re-fused per nightly round (one read and at most one write call). */
export const NIGHTLY_REFRESH_PAGE = 250;
export const NIGHTLY_REFRESH_MAX_ROUNDS = 8;

function parseNightlyPolicy(raw: string | undefined): Policy {
  try {
    return parsePolicy(raw ?? null);
  } catch {
    return DEFAULT_POLICY;
  }
}

export interface NightlyOptions {
  now: number;
}

function parseTau(value: string | undefined): number {
  const n = Number(value ?? TAU_DELETE_DEFAULT);
  return Number.isFinite(n) ? n : TAU_DELETE_DEFAULT;
}

/** Contracts 8.6: lease, stale recovery, calibration, bounded purge, housekeeping, budget. At most 45 D1 calls. */
export async function runNightly(env: Env, opts: NightlyOptions): Promise<void> {
  const now = opts.now;
  const runId = crypto.randomUUID();
  const today = utcDate(now);
  const run = batchRunner(env.DB);
  const work = createSubrequestCounter(TICK_SUBREQUEST_LIMIT - FINAL_D1_CALLS);
  const results: BatchResult[] = [];

  const claim = await run(work, [
    stmt(NIGHTLY_CLAIM, runId, now, now + NIGHTLY_LEASE_TTL_MS),
    stmt("SELECT value FROM settings WHERE key = 'tau_delete'"),
    stmt("SELECT rows_written FROM budget WHERE date = ?1", today),
    stmt("SELECT id, status FROM accounts ORDER BY id"),
    stmt("SELECT key, value FROM settings WHERE key IN ('tau_segments', 'policy')"),
  ]);
  if (rowsOf(claim[0]).length === 0) return;
  results.push(...claim);
  const tau = parseTau(rowsOf<{ value: string }>(claim[1])[0]?.value);
  const startRows = rowsOf<{ rows_written: number }>(claim[2])[0]?.rows_written ?? 0;
  const accounts = rowsOf<{ id: string; status: string }>(claim[3]);
  const disconnected = accounts.filter((a) => a.status === "disconnected").map((a) => a.id);
  const extra = new Map(rowsOf<{ key: string; value: string }>(claim[4]).map((r) => [r.key, r.value]));
  const currentTaus = parseSegmentTaus(extra.get("tau_segments") ?? null) ?? {};

  const recovery: Stmt[] = accounts.map((a) =>
    stmt(STALE_APPROVED_RECOVERY, a.id, now, now - STALE_APPROVED_MS),
  );
  const reads = await run(work, [...recovery, stmt(CALIBRATION_LABELS, CALIBRATION_SEGMENT_WINDOW)]);
  results.push(...reads);
  const staleRecovered = sumMeta(reads.slice(0, recovery.length), "changes");
  const samples: SegmentCalibrationSample[] = rowsOf<LabelSampleRow>(reads[recovery.length]).map((r) => ({
    pDelete: r.p_delete,
    margin: r.margin,
    ceiling: r.ceiling,
    ownerAction: r.owner_action,
    segment: r.segment,
  }));
  // contracts 12.10: one threshold per segment; the global one (5.3, newest CALIBRATION_WINDOW) stays the fallback.
  const segmented = calibrateSegments(samples, tau, currentTaus);
  const calibration = segmented.global;

  results.push(
    ...(await run(work, [
      settingStmt("tau_delete", JSON.stringify(calibration.tauDelete), now),
      settingStmt("tau_segments", JSON.stringify(segmented.taus), now),
      settingStmt(
        "calibration",
        JSON.stringify({ ...calibration, segments: segmented.segments, ranAt: now }),
        now,
      ),
      auditStmt(now, null, "calibration", calibration.deleteSuggestions, {
        tauDelete: calibration.tauDelete,
      }),
    ])),
  );

  const state = newPurgeState();
  // Read directly (not via readConfig) so housekeeping still runs with an incomplete config; the generated Env
  // type narrows FREE_TIER to the configured literal, hence String().
  const freeTier = String(env.FREE_TIER) !== "false";
  const stopRows = freeTier ? PURGE_STOP_ROWS : Number.MAX_SAFE_INTEGER;
  const base = startRows + sumMeta(results, "rows_written");
  await purgeExpired(run, work, now, state, {
    startRows: base,
    stopRows,
    maxRounds: PURGE_EXPIRED_MAX_ROUNDS,
  });
  // purgeDisconnected does not re-check status on its table deletes: pass only disconnected account ids.
  await purgeDisconnected(run, work, disconnected, now, state, {
    startRows: base,
    stopRows,
    maxRounds: PURGE_TOTAL_MAX_ROUNDS,
  });
  if (state.stoppedByBudget) {
    logEvent("budget.gate", { date: today, rowsWritten: base + state.rowsWritten, gate: "purge" });
  }

  // contracts 12.10: apply the new thresholds (and the day's priors and rules) to what is pending, with the D1 calls
  // the purge left over and below the purge stop rule.
  const refreshSettings: RefreshSettings = {
    policy: parseNightlyPolicy(extra.get("policy")),
    tauDelete: calibration.tauDelete,
    segmentTaus: segmented.taus,
  };
  const refresh = { rowsRead: 0, rowsWritten: 0, updated: 0 };
  const active = accounts.filter((a) => a.status !== "disconnected").map((a) => a.id);
  let rounds = 0;
  for (const accountId of active) {
    let afterId = 0;
    while (rounds < NIGHTLY_REFRESH_MAX_ROUNDS && work.limit - work.used >= 2) {
      if (base + state.rowsWritten + refresh.rowsWritten >= stopRows) break;
      work.reserve(2);
      rounds += 1;
      const out = await refreshPending(
        env.DB,
        { accountId, afterId, limit: NIGHTLY_REFRESH_PAGE },
        refreshSettings,
        now,
      );
      refresh.rowsRead += out.rowsRead;
      refresh.rowsWritten += out.rowsWritten;
      refresh.updated += out.updated;
      if (out.lastId === null || out.scanned < NIGHTLY_REFRESH_PAGE) break;
      afterId = out.lastId;
    }
  }

  const final = createSubrequestCounter(TICK_SUBREQUEST_LIMIT, work.used);
  const summary = {
    ranAt: now,
    purgedMessages: state.purgedMessages,
    purgedAccounts: state.purgedAccounts,
    staleRecovered,
    refreshed: refresh.updated,
  };
  results.push(
    ...(await run(final, [
      stmt("DELETE FROM action_batches WHERE created_at < ?1", now - BATCH_RETENTION_MS),
      stmt("DELETE FROM budget WHERE date < ?1", utcDate(now - BUDGET_KEEP_DAYS * DAY_MS)),
      stmt("DELETE FROM leases WHERE account_id IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts)"),
      settingStmt("nightly", JSON.stringify(summary), now),
      auditStmt(now, null, "purge", state.purgedMessages, {
        purgedAccounts: state.purgedAccounts,
        staleRecovered,
      }),
      stmt("UPDATE leases SET released_at = ?2 WHERE name = 'nightly' AND holder = ?1", runId, now),
    ])),
  );
  const rowsWritten = sumMeta(results, "rows_written") + state.rowsWritten + refresh.rowsWritten + 1;
  await run(final, [
    budgetUpsertStmt({
      date: today,
      rowsWritten,
      rowsRead: sumMeta(results, "rows_read") + state.rowsRead + refresh.rowsRead,
      ticks: 0,
      messagesIngested: 0,
      decisionCalls: 0,
      decisionFailures: 0,
      decisionInputTokens: 0,
      providerCalls: 0,
      dbSizeBytes: lastSizeAfter(results),
      now,
    }),
  ]);
  logEvent("nightly.done", {
    runId,
    tauDelete: calibration.tauDelete,
    calibrationOutcome: calibration.outcome,
    purgedMessages: state.purgedMessages,
    purgedAccounts: state.purgedAccounts,
    staleRecovered,
    rowsWritten,
  });
}
