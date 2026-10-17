import {
  BATCH_RETENTION_MS,
  CALIBRATION_WINDOW,
  PURGE_STOP_ROWS,
  STALE_APPROVED_MS,
  TAU_DELETE_DEFAULT,
  TICK_SUBREQUEST_LIMIT,
  calibrateTauDelete,
  createSubrequestCounter,
} from "@clearbox/core";
import type { ActionKind, CalibrationSample, Ceiling } from "@clearbox/core";
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
import {
  DEFAULT_REMINDER_DEPS,
  REMINDER_SETTINGS_SQL,
  REMINDER_TARGETS_SQL,
  parseReminderSettings,
  runWeeklyReminder,
} from "./reminder.ts";
import type { ReminderDeps } from "./reminder.ts";

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
  "SELECT p_delete, margin, ceiling, owner_action FROM labels ORDER BY id DESC LIMIT ?1 -- isolation-exempt: calibration";

interface LabelSampleRow {
  p_delete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  owner_action: ActionKind;
}

export interface NightlyOptions {
  now: number;
  /** Tests inject the provider fetch, factory and sleep of the weekly reminder (contracts 12.8). */
  reminder?: Partial<ReminderDeps>;
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
    stmt(REMINDER_SETTINGS_SQL),
    stmt(REMINDER_TARGETS_SQL),
  ]);
  if (rowsOf(claim[0]).length === 0) return;
  results.push(...claim);
  const tau = parseTau(rowsOf<{ value: string }>(claim[1])[0]?.value);
  const startRows = rowsOf<{ rows_written: number }>(claim[2])[0]?.rows_written ?? 0;
  const accounts = rowsOf<{ id: string; status: string }>(claim[3]);
  const disconnected = accounts.filter((a) => a.status === "disconnected").map((a) => a.id);

  const recovery: Stmt[] = accounts.map((a) =>
    stmt(STALE_APPROVED_RECOVERY, a.id, now, now - STALE_APPROVED_MS),
  );
  const reads = await run(work, [...recovery, stmt(CALIBRATION_LABELS, CALIBRATION_WINDOW)]);
  results.push(...reads);
  const staleRecovered = sumMeta(reads.slice(0, recovery.length), "changes");
  const samples: CalibrationSample[] = rowsOf<LabelSampleRow>(reads[recovery.length]).map((r) => ({
    pDelete: r.p_delete,
    margin: r.margin,
    ceiling: r.ceiling,
    ownerAction: r.owner_action,
  }));
  const calibration = calibrateTauDelete(samples, tau);

  results.push(
    ...(await run(work, [
      settingStmt("tau_delete", JSON.stringify(calibration.tauDelete), now),
      settingStmt("calibration", JSON.stringify({ ...calibration, ranAt: now }), now),
      auditStmt(now, null, "calibration", calibration.deleteSuggestions, {
        tauDelete: calibration.tauDelete,
      }),
    ])),
  );

  // Contracts 12.8: before the purge, which then gets only the subrequests left over.
  try {
    await runWeeklyReminder({
      env,
      run,
      work,
      runId,
      now,
      settings: parseReminderSettings(rowsOf(claim[4])),
      targets: rowsOf<{ id: string; email: string }>(claim[5]),
      visibleIds: accounts.filter((a) => a.status !== "disconnected").map((a) => a.id),
      deps: { ...DEFAULT_REMINDER_DEPS, ...opts.reminder },
      results,
    });
  } catch (err) {
    logEvent("reminder.done", {
      runId,
      outcome: "failed",
      accountId: null,
      pending: 0,
      groups: 0,
      errorCode: err instanceof Error ? err.name : "internal",
    });
  }

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

  const final = createSubrequestCounter(TICK_SUBREQUEST_LIMIT, work.used);
  const summary = {
    ranAt: now,
    purgedMessages: state.purgedMessages,
    purgedAccounts: state.purgedAccounts,
    staleRecovered,
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
  const rowsWritten = sumMeta(results, "rows_written") + state.rowsWritten + 1;
  await run(final, [
    budgetUpsertStmt({
      date: today,
      rowsWritten,
      rowsRead: sumMeta(results, "rows_read") + state.rowsRead,
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
