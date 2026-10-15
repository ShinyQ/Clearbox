import type { FetchLike } from "@clearbox/core";
import { logEvent } from "../log.ts";
import type { DecideStage, FinalItem } from "./ingest.ts";

/** Filled by runTickInternal: pure compute, awaited I/O, and total wall time, in ms. */
export interface TickTimings {
  wallMs: number;
  ioMs: number;
  pureMs: number;
}

export class Stopwatch {
  readonly t: TickTimings;
  private inFlight = 0;
  private ioStart = 0;

  constructor(t?: TickTimings) {
    this.t = t ?? { wallMs: 0, ioMs: 0, pureMs: 0 };
  }

  pure<T>(fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.t.pureMs += performance.now() - start;
    }
  }

  /** Concurrent calls count once: the clock runs while at least one is in flight (union of intervals). */
  async io<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight === 0) this.ioStart = performance.now();
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.t.ioMs += performance.now() - this.ioStart;
    }
  }
}

export function tally(f: FetchLike): { fetch: FetchLike; count: () => number } {
  let n = 0;
  return {
    fetch: (input, init) => {
      n += 1;
      return f(input, init);
    },
    count: () => n,
  };
}

export interface DecisionStats {
  decided: number;
  deferred: number;
  unsure: number;
  calls: number;
  failures: number;
  inputTokens: number;
  latencies: number[];
}

export function emptyStats(): DecisionStats {
  return { decided: 0, deferred: 0, unsure: 0, calls: 0, failures: 0, inputTokens: 0, latencies: [] };
}

export function decisionStats(stage: DecideStage, finals: readonly FinalItem[]): DecisionStats {
  const stats = emptyStats();
  stats.calls = stage.outcomes.length;
  for (const o of stage.outcomes) {
    if (o.ok) {
      stats.decided += 1;
      stats.inputTokens += o.result.inputTokens;
      stats.latencies.push(o.result.latencyMs);
    } else {
      stats.failures += 1;
    }
  }
  stats.deferred = finals.filter((f) => f.status === "awaiting_model").length;
  stats.unsure = finals.filter((f) => f.status === "pending" && f.suggestion?.action === "unsure").length;
  return stats;
}

export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function logDecisionErrors(stage: DecideStage, tickId: string, accountId: string): void {
  for (const o of stage.outcomes) {
    if (o.ok) continue;
    logEvent("decision.error", {
      tickId,
      accountId,
      messageId: null,
      kind: o.error.kind,
      status: o.error.status,
      requestId: o.error.requestId,
    });
  }
}
