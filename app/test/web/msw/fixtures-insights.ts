import type { AccountView, Insights, PolicyResponse } from "../../../src/shared/api.ts";
import { DAY, HOUR, T0, iso } from "./fixtures-accounts.ts";

export function makeInsights(accounts: AccountView[]): Insights {
  const weekStarts = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
  const cleaned = [420, 730, 512, 640, 980, 1284];
  const undone = [3, 5, 0, 2, 9, 18];
  return {
    precision: { deletePrecision: 0.986, deleteSuggestionsDecided: 412, window: 500 },
    labels: { total: 1912, last7Days: 312 },
    calibration: {
      tauDelete: 0.86,
      outcome: "calibrated",
      ranAt: iso(T0 - 9 * HOUR),
      points: [
        { tau: 0.8, support: 120, precision: 0.979 },
        { tau: 0.86, support: 96, precision: 0.986 },
        { tau: 0.9, support: 60, precision: 0.99 },
      ],
    },
    budget: {
      date: "2026-10-15",
      rowsWritten: 21_080,
      rowsCap: 90_000,
      ingestStopRows: 65_000,
      d1DailyWriteLimit: 100_000,
      ticks: 900,
      messagesIngested: 3_120,
      decisionCalls: 3_412,
      decisionFailures: 2,
      decisionInputTokens: 1_400_000,
      estimatedDecisionCostUsd: 0.0588,
      dbSizeBytes: 182_000_000,
      dbSizeLimitBytes: 500_000_000,
    },
    history: Array.from({ length: 14 }, (_, i) => ({
      date: iso(T0 - (13 - i) * DAY).slice(0, 10),
      rowsWritten: 20_000,
      messagesIngested: 6_000,
      decisionCalls: 3_000,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      status: a.status,
      paused: a.paused,
      sync: a.sync,
    })),
    weekly: weekStarts.map((weekStart, i) => ({
      weekStart,
      cleaned: cleaned[i] ?? 0,
      undone: undone[i] ?? 0,
    })),
  };
}

export function makePolicyResponse(): PolicyResponse {
  const defaults = {
    allowlist: [],
    denylist: [],
    minAgeDays: 3,
    storeSnippets: true,
    labelSubjects: true,
    recordPatterns: ["receipt", "invoice", "tax", "statement", "contract", "medical", "legal"],
    scanHistoryDays: 90 as const,
  };
  return {
    policy: {
      ...defaults,
      allowlist: ["mom@family.example", "@bank.example"],
      denylist: ["promo@northwind.example"],
    },
    version: 4,
    defaults,
  };
}
