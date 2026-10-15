import type { DecisionEngine, FetchLike } from "@clearbox/core";
import type { TickReport } from "../../shared/api.ts";

export interface TickOptions {
  trigger: "cron" | "scan_now";
  /** Required for scan_now. */
  accountId?: string;
  now: number;
  /** Tests inject FakeEngine; default makeDecisionEngine(env). */
  engine?: DecisionEngine;
  /** Tests may inject; default globalThis.fetch. */
  fetch?: FetchLike;
}

/**
 * TEMPORARY STUB from plan 03 so the Worker entry compiles and runs.
 * Plan 04 replaces this whole file with the real tick (contracts 8.2), keeping these exports.
 */
export async function runTick(env: Env, opts: TickOptions): Promise<TickReport> {
  void env;
  return {
    outcome: "idle",
    accountId: opts.accountId ?? null,
    kind: null,
    phase: null,
    fetched: 0,
    skippedKnown: 0,
    decided: 0,
    deferred: 0,
    unsure: 0,
    removed: 0,
    subrequests: 0,
    rowsWritten: 0,
    nextTickAt: null,
    errorCode: null,
  };
}
