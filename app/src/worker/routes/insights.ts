import {
  BUDGET_ROWS_PER_DAY,
  CALIBRATION_WINDOW,
  D1_DAILY_WRITE_LIMIT,
  INGEST_STOP_ROWS,
} from "@clearbox/core";
import { Hono } from "hono";
import type { Insights } from "../../shared/api.ts";
import { listAccounts, toAccountSync } from "../db/accounts.ts";
import { selectAuditKindsSinceStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { mapBudget, selectBudgetHistoryStmt, selectBudgetStmt } from "../db/budget.ts";
import type { BudgetRow } from "../db/budget.ts";
import { deletePrecisionStmt, labelStatsStmt } from "../db/labels.ts";
import { readSettings } from "../db/settings.ts";
import { toIso, utcDate } from "../db/sql.ts";
import { countOpenByAccount } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DB_SIZE_LIMIT_BYTES = 500_000_000;
const DECISION_USD_PER_MILLION_TOKENS = 0.042;

export const insightsRoutes = new Hono<AppEnv>();

/** Monday 00:00 UTC of the ISO week containing ms. */
export function mondayUtc(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

insightsRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const now = c.get("deps").now();
  const today = utcDate(now);
  const [settings, accounts] = await Promise.all([
    readSettings(db),
    listAccounts(db, { includeDisconnected: true }),
  ]);
  const allIds = accounts.map((a) => a.id);
  const visible = accounts.filter((a) => a.status !== "disconnected");
  const firstWeek = mondayUtc(now) - 5 * WEEK_MS;

  const stmts: D1PreparedStatement[] = [
    selectBudgetStmt(db, today),
    selectBudgetHistoryStmt(db, utcDate(now - 13 * DAY_MS)),
    selectAuditKindsSinceStmt(db, firstWeek, ["approve", "override", "cleanup", "undo"]),
  ];
  // Task 7: the account-scoped builders produce `IN ()` on an empty list.
  if (allIds.length > 0) {
    stmts.push(
      deletePrecisionStmt(db, allIds, CALIBRATION_WINDOW),
      labelStatsStmt(db, allIds, now - 7 * DAY_MS),
    );
  }
  const [budgetRes, historyRes, auditRes, precisionRes, statsRes] = await db.batch(stmts);
  const counts = await countOpenByAccount(
    db,
    visible.map((a) => a.id),
  );

  const budget = mapBudget(((budgetRes?.results ?? [])[0] as BudgetRow | undefined) ?? null, today);
  const historyRows = new Map(((historyRes?.results ?? []) as BudgetRow[]).map((r) => [r.date, r]));
  const history = Array.from({ length: 14 }, (_, i) => {
    const date = utcDate(now - (13 - i) * DAY_MS);
    const row = historyRows.get(date);
    return {
      date,
      rowsWritten: row?.rows_written ?? 0,
      messagesIngested: row?.messages_ingested ?? 0,
      decisionCalls: row?.decision_calls ?? 0,
    };
  });

  const weekly = Array.from({ length: 6 }, (_, i) => ({
    weekStart: utcDate(firstWeek + i * WEEK_MS),
    cleaned: 0,
    undone: 0,
  }));
  for (const row of (auditRes?.results ?? []) as AuditRow[]) {
    const week = weekly[Math.floor((row.ts - firstWeek) / WEEK_MS)];
    if (!week) continue;
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const n = (k: string): number => {
      const v = result[k];
      return typeof v === "number" ? v : 0;
    };
    if (row.kind === "undo") week.undone += n("restored");
    else week.cleaned += n("delete") + n("archive");
  }

  const precision = ((precisionRes?.results ?? [])[0] as
    { decided: number; deleted: number } | undefined) ?? {
    decided: 0,
    deleted: 0,
  };
  const stats = ((statsRes?.results ?? [])[0] as { total: number; recent: number } | undefined) ?? {
    total: 0,
    recent: 0,
  };
  const calibration = settings.calibration;

  const body: Insights = {
    precision: {
      deletePrecision: precision.decided > 0 ? precision.deleted / precision.decided : null,
      deleteSuggestionsDecided: precision.decided,
      window: CALIBRATION_WINDOW,
    },
    labels: { total: stats.total, last7Days: stats.recent },
    calibration: {
      tauDelete: settings.tauDelete,
      outcome: calibration?.outcome ?? null,
      ranAt: calibration ? toIso(calibration.ranAt) : null,
      points: calibration?.points ?? [],
      segments: (calibration?.segments ?? []).map((g) => ({
        segment: g.segment,
        tauDelete: g.tauDelete,
        outcome: g.outcome,
        deleteSuggestions: g.deleteSuggestions,
        precisionAtTau: g.precisionAtTau,
      })),
    },
    budget: {
      date: today,
      rowsWritten: budget.rowsWritten,
      rowsCap: BUDGET_ROWS_PER_DAY,
      ingestStopRows: INGEST_STOP_ROWS,
      d1DailyWriteLimit: D1_DAILY_WRITE_LIMIT,
      ticks: budget.ticks,
      messagesIngested: budget.messagesIngested,
      decisionCalls: budget.decisionCalls,
      decisionFailures: budget.decisionFailures,
      decisionInputTokens: budget.decisionInputTokens,
      estimatedDecisionCostUsd: (budget.decisionInputTokens * DECISION_USD_PER_MILLION_TOKENS) / 1e6,
      dbSizeBytes: budget.dbSizeBytes,
      dbSizeLimitBytes: DB_SIZE_LIMIT_BYTES,
    },
    history,
    accounts: visible.flatMap((a) =>
      a.status === "disconnected"
        ? []
        : [
            {
              id: a.id,
              provider: a.provider,
              email: a.email,
              status: a.status,
              paused: a.paused,
              sync: toAccountSync(
                a,
                counts.get(a.id) ?? { pending: 0, awaitingModel: 0 },
                settings.policy.scanHistoryDays,
              ),
            },
          ],
    ),
    weekly,
  };
  return c.json(body);
});
