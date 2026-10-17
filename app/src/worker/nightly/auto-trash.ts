import {
  AUTO_TRASH_DAILY_CAP,
  INGEST_STOP_ROWS,
  MAX_ITEMS_PER_ACTION_REQUEST,
  countingFetch,
} from "@clearbox/core";
import type { FetchLike, Policy, SubrequestCounter } from "@clearbox/core";
import { executeAutoTrash } from "../actions/execute.ts";
import type { ActionContext } from "../actions/execute.ts";
import { autoTrashCountsQuery } from "../db/suggestions.ts";
import { autoTrashKilled, readConfig } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { PROVIDER_OAUTH, makeProvider } from "../scan/providers.ts";
import type { ProviderFactory, ProviderOAuthMap } from "../scan/providers.ts";
import { rowsOf, stmt } from "../scan/write-plan.ts";
import type { BatchResult, BatchRunner } from "../scan/write-plan.ts";

/**
 * Auto-trash for trusted senders (contracts 12.11), run by the nightly job after calibration and before the weekly
 * reminder and the purge. Opt-in (policy.autoTrash, off by default). Each round is one executeAutoTrash call for one
 * account: the owner action path (claim, provider trash, one D1 write with batch and audit, budget), so Activity
 * shows "Auto-trash" with Undo for 24 hours.
 *
 * Why nightly and not in the tick: trusted mail only becomes a trash suggestion once it is policy.minAgeDays old
 * (recent mail is held, 12.10), so a daily run adds at most one day; the tick has no spare subrequests on its
 * worst-case paths (8.4: up to 38 of 45) and owns the account lease, while the nightly job already has a spare
 * budget that the purge only partly uses, and one place to cap, log and kill the feature.
 */

/** Items per round: one owner Clean up page. */
export const AUTO_TRASH_ROUND_LIMIT = MAX_ITEMS_PER_ACTION_REQUEST;
/** At most 5 rounds (500 emails, the daily cap) per night. */
export const AUTO_TRASH_MAX_ROUNDS = 5;
/** D1 calls of one round, reserved before it starts: budget, settings, accounts, targets, claim, write, budget delta. */
export const AUTO_TRASH_ROUND_D1_CALLS = 7;
/**
 * Worst case of one round (one account, 100 items): 7 D1 calls + token refresh 1 + 401 retry (refresh and repeat) 2 +
 * Graph $batch 5 (100 / 20; Gmail needs 2). A round only starts when this much is left above the floor.
 */
export const AUTO_TRASH_ROUND_SUBREQUESTS = 15;
/** Always left for the purge: 4 rounds, 2,000 expired emails (the same floor as on a weekly reminder day). */
export const AUTO_TRASH_PURGE_FLOOR = 8;

const DAY_MS = 86_400_000;

export type AutoTrashRunOutcome =
  | "done"
  | "nothing_to_do"
  | "cap_reached"
  | "disabled"
  | "not_configured"
  | "no_budget"
  | "stopped"
  | "failed";

export interface AutoTrashDeps {
  fetch: FetchLike;
  providerFactory: ProviderFactory;
  oauth: ProviderOAuthMap;
}

export const DEFAULT_AUTO_TRASH_DEPS: AutoTrashDeps = {
  fetch: (input, init) => fetch(input, init),
  providerFactory: makeProvider,
  oauth: PROVIDER_OAUTH,
};

export interface AutoTrashRun {
  env: Env;
  run: BatchRunner;
  work: SubrequestCounter;
  runId: string;
  now: number;
  policy: Policy;
  /** Active, unpaused accounts, oldest first (the reminder's target list). */
  accountIds: readonly string[];
  /** budget.rows_written today, including this run's writes so far. */
  rowsToday: number;
  /** Subrequests that must stay unused for the steps after this one (purge floor plus a due reminder). */
  reserveAfter: number;
  deps: AutoTrashDeps;
  results: BatchResult[];
}

export interface AutoTrashSummary {
  outcome: AutoTrashRunOutcome;
  rounds: number;
  executed: number;
  failed: number;
  retryLater: number;
}

/** Returns null when the owner has not turned auto-trash on (nothing read, written or logged). */
export async function runAutoTrash(r: AutoTrashRun): Promise<AutoTrashSummary | null> {
  if (!r.policy.autoTrash) return null;
  const summary: AutoTrashSummary = { outcome: "done", rounds: 0, executed: 0, failed: 0, retryLater: 0 };
  const finish = (outcome: AutoTrashRunOutcome): AutoTrashSummary => {
    summary.outcome = outcome;
    logEvent("auto_trash.done", { runId: r.runId, ...summary });
    return summary;
  };

  if (autoTrashKilled(r.env)) return finish("disabled");
  const cfg = readConfig(r.env);
  if (!cfg.ok) return finish("not_configured");
  if (r.accountIds.length === 0) return finish("nothing_to_do");
  if (cfg.config.freeTier && r.rowsToday >= INGEST_STOP_ROWS) return finish("no_budget");
  const spare = () => r.work.limit - r.work.used - r.reserveAfter;
  if (spare() < 1 + AUTO_TRASH_ROUND_SUBREQUESTS) return finish("no_budget");

  // D1 call A0: candidates per account and what this UTC day already trashed (every run counts).
  const dayStart = Math.floor(r.now / DAY_MS) * DAY_MS;
  const counts = autoTrashCountsQuery(r.accountIds, r.now - r.policy.minAgeDays * DAY_MS);
  const read = await r.run(r.work, [
    stmt(counts.sql, ...(counts.params as (string | number)[])),
    stmt(
      "SELECT COALESCE(SUM(executed_count), 0) AS n FROM action_batches WHERE kind = 'auto_trash' AND created_at >= ?1",
      dayStart,
    ),
  ]);
  r.results.push(...read);
  const pending = new Map(rowsOf<{ account_id: string; n: number }>(read[0]).map((x) => [x.account_id, x.n]));
  let capLeft = AUTO_TRASH_DAILY_CAP - (rowsOf<{ n: number }>(read[1])[0]?.n ?? 0);
  if (capLeft <= 0) return finish("cap_reached");
  if (pending.size === 0) return finish("nothing_to_do");

  const ctx: ActionContext = {
    db: r.env.DB,
    config: cfg.config,
    deps: {
      fetch: countingFetch(r.deps.fetch, r.work),
      now: () => r.now,
      providerFactory: r.deps.providerFactory,
      oauth: r.deps.oauth,
    },
    requestId: r.runId,
    origin: "",
    route: "nightly",
  };

  for (const accountId of r.accountIds) {
    if (!pending.has(accountId)) continue;
    let afterId = 0;
    for (;;) {
      if (capLeft <= 0) return finish("cap_reached");
      if (summary.rounds >= AUTO_TRASH_MAX_ROUNDS || spare() < AUTO_TRASH_ROUND_SUBREQUESTS) {
        return finish(summary.rounds === 0 ? "no_budget" : "done");
      }
      r.work.reserve(AUTO_TRASH_ROUND_D1_CALLS);
      summary.rounds += 1;
      const limit = Math.min(AUTO_TRASH_ROUND_LIMIT, capLeft);
      let out;
      try {
        out = await executeAutoTrash(ctx, { accountId, limit, afterId });
      } catch (err) {
        if (err instanceof ApiError && err.code === "budget_exhausted") return finish("no_budget");
        logEvent("request.error", {
          requestId: r.runId,
          route: "nightly",
          errorName: err instanceof Error ? err.name : "unknown",
        });
        return finish("failed");
      }
      const res = out.response;
      summary.executed += res.executed;
      summary.failed += res.failed;
      summary.retryLater += res.retryLater;
      capLeft -= res.executed;
      // Never retried in the same run: anything not done waits for the next night (or the owner).
      if (res.failed + res.retryLater > 0) return finish("stopped");
      if (out.lastId === null || out.scanned < limit) break;
      afterId = out.lastId;
    }
  }
  return finish(capLeft <= 0 ? "cap_reached" : "done");
}
