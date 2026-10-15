import {
  INGEST_STOP_ROWS,
  PAGE_SIZE_FREE,
  PAGE_SIZE_PAID,
  POLL_INTERVAL_MS,
  STORAGE_SOFT_LIMIT_BYTES,
  TICK_SUBREQUEST_LIMIT,
  countingFetch,
  createSubrequestCounter,
} from "@clearbox/core";
import type { DecisionEngine, FetchLike } from "@clearbox/core";
import type { AppIssueCode, TickKind, TickReport } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { readConfig } from "../env.ts";
import { logEvent } from "../log.ts";
import { claimStatements, parseClaim, parseTickSettings, scanNowError } from "./claim.ts";
import type { TickAccountRow } from "./claim.ts";
import { failTick, finishTick, idleReport, successResult } from "./tick-finish.ts";
import type { TickResult } from "./tick-finish.ts";
import { processAccount } from "./tick-process.ts";
import type { ProcessParams } from "./tick-process.ts";
import { Stopwatch, tally } from "./tick-stats.ts";
import type { TickTimings } from "./tick-stats.ts";
import { openTickTokens } from "./tick-tokens.ts";
import { batchRunner, nextUtcMidnight, utcDate } from "./write-plan.ts";
import type { IssueRaise } from "./write-plan.ts";

/** Contracts 8.1. */
export interface TickOptions {
  trigger: "cron" | "scan_now";
  /** Required for scan_now. */
  accountId?: string;
  now: number;
  /** Tests inject FakeEngine; default makeDecisionEngine(env, countingFetch). */
  engine?: DecisionEngine;
  /** Tests may inject; default globalThis.fetch. */
  fetch?: FetchLike;
}

export type { TickTimings } from "./tick-stats.ts";

export interface TickInternals {
  subrequestLimit?: number;
  timings?: TickTimings;
}

/**
 * The final write and the budget upsert always fit (contracts C9 decision). Everything else draws from the
 * work counter, and Decision-1 gets only the room left after the provider fetch has actually run: the fetch
 * cost varies. Worst case per Gmail metadata chunk (50 ids): 3 batch POSTs (a 5xx/429/missing-part retry plus
 * one extra attempt after a 401 part) and 1 token refresh, on top of the list or history call.
 */
const FINAL_D1_CALLS = 2;
const PAID_TICK_SUBREQUEST_LIMIT = 500;

export function selectKind(
  a: Pick<TickAccountRow, "phase" | "last_incremental_at">,
  awaitingDue: number,
  now: number,
): TickKind {
  if (awaitingDue > 0) return "redecide";
  if (a.phase === "sent_backfill") return "sent_backfill";
  if (
    a.phase === "incremental" ||
    a.last_incremental_at === null ||
    now - a.last_incremental_at >= POLL_INTERVAL_MS
  ) {
    return "incremental";
  }
  return "inbox_backfill";
}

async function tick(
  env: Env,
  opts: TickOptions,
  internals: TickInternals,
  watch: Stopwatch,
): Promise<TickReport> {
  const startedAt = performance.now();
  const config = readConfig(env);
  if (!config.ok) {
    logEvent("config.invalid", { missing: config.invalid.join(",") });
    return idleReport(0, null);
  }
  const now = opts.now;
  const tickId = crypto.randomUUID();
  const freeTier = config.config.freeTier;
  const limit = internals.subrequestLimit ?? (freeTier ? TICK_SUBREQUEST_LIMIT : PAID_TICK_SUBREQUEST_LIMIT);
  const stopRows = freeTier ? INGEST_STOP_ROWS : Number.MAX_SAFE_INTEGER;
  const work = createSubrequestCounter(Math.max(1, limit - FINAL_D1_CALLS));
  const base: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const counted = countingFetch((input, init) => watch.io(() => base(input, init)), work);
  const providerFetch = tally(counted);
  const decisionFetch = tally(counted);
  const run = batchRunner(env.DB, (fn) => watch.io(fn));
  const today = utcDate(now);

  // D1 call 1: claim.
  const claimResults = await run(
    work,
    claimStatements({
      tickId,
      now,
      accountId: opts.accountId ?? null,
      force: opts.trigger === "scan_now",
      today,
      stopRows,
    }),
  );
  const claim = parseClaim(claimResults);
  const account = claim.account;
  if (claim.claimedAccountId === null || account === null) {
    if (opts.trigger === "scan_now") throw scanNowError(claim, now, stopRows);
    const rowsWritten = claim.budget?.rows_written ?? 0;
    const gated = rowsWritten >= stopRows;
    if (gated) logEvent("budget.gate", { date: today, rowsWritten, gate: "ingest" });
    logEvent("tick.idle", { tickId, trigger: opts.trigger });
    return idleReport(work.used, gated ? nextUtcMidnight(now) : null);
  }

  const settings = parseTickSettings(claim.settings);
  let kind = selectKind(account, claim.awaitingDue, now);
  const raise: IssueRaise[] = [];
  const clear: AppIssueCode[] = [];
  if ((claim.budget?.db_size_bytes ?? 0) >= STORAGE_SOFT_LIMIT_BYTES) {
    if (kind === "inbox_backfill") {
      raise.push({ code: "storage_near_limit", accountId: null });
      kind = "incremental";
    }
  } else {
    clear.push("storage_near_limit");
  }
  logEvent("tick.claimed", {
    tickId,
    trigger: opts.trigger,
    accountId: account.id,
    kind,
    phase: account.phase,
    pageSize: account.page_size,
  });
  const encKey = await importEncKey(config.config.tokenEncKey);
  const tokens = openTickTokens({
    row: account,
    config: config.config,
    encKey,
    fetch: providerFetch.fetch,
    now,
  });
  const params: ProcessParams = {
    env,
    account,
    kind,
    now,
    tickId,
    settings,
    engine: opts.engine,
    providerFetch: providerFetch.fetch,
    decisionFetch: decisionFetch.fetch,
    tokens,
    encKey,
    work,
    run,
    watch,
    raise,
    clear,
    maxPageSize: freeTier ? PAGE_SIZE_FREE : PAGE_SIZE_PAID,
  };

  let final = createSubrequestCounter(limit, work.used);
  let result: TickResult;
  try {
    const processed = await processAccount(params);
    final = createSubrequestCounter(limit, work.used);
    const finalResults = await run(final, processed.write.stmts);
    result = successResult(processed, finalResults);
  } catch (err) {
    final = createSubrequestCounter(limit, Math.max(work.used, final.used));
    result = await failTick({
      err,
      account,
      kind,
      tickId,
      now,
      settings,
      tokens,
      encKey,
      run,
      final,
      raise,
      clear,
    });
  }

  return finishTick({
    run,
    final,
    claimRowsWritten: claim.rowsWritten,
    claimRowsRead: claim.rowsRead,
    result,
    account,
    kind,
    tickId,
    today,
    now,
    providerCalls: providerFetch.count(),
    startedAt,
  });
}

export async function runTickInternal(
  env: Env,
  opts: TickOptions,
  internals: TickInternals,
): Promise<TickReport> {
  const watch = new Stopwatch(internals.timings);
  const start = performance.now();
  try {
    return await tick(env, opts, internals, watch);
  } finally {
    watch.t.wallMs += performance.now() - start;
  }
}

/** The single tick code path for the cron and POST /api/accounts/:id/scan (contracts 8.1). */
export function runTick(env: Env, opts: TickOptions): Promise<TickReport> {
  return runTickInternal(env, opts, {});
}
