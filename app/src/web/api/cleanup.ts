import type { ActionResponse, CleanupBody, CleanupPreview, ItemErrorCode } from "../../shared/api.ts";
import type { ActionKind } from "../lib/view-types.ts";
import { reportBug } from "../lib/report.ts";
import { isApiError } from "./client.ts";

export const RETRY_DELAY_MS = 2000;

type CodeCounts = Partial<Record<ItemErrorCode, number>>;

export interface RunTotals {
  calls: number;
  executed: number;
  failed: number;
  skipped: number;
  lastRemaining: number;
  lastRetryLater: number;
  failedCodes: CodeCounts;
  lastRetryCodes: CodeCounts;
  batchIds: number[];
  total: number;
}

export type PartialReason =
  | "stopped"
  | "budget"
  | "rate_limited"
  | "account_inactive"
  | "no_progress"
  | "network"
  | "item_failures"
  | "unexpected";

export type RunOutcome =
  { phase: "done"; run: RunTotals } | { phase: "partial"; reason: PartialReason; run: RunTotals };

export interface CleanupDeps {
  post: (body: CleanupBody) => Promise<ActionResponse>;
  sleep: (ms: number) => Promise<void>;
  signal: { stop: boolean };
  onProgress?: (run: RunTotals) => void;
}

export function emptyTotals(previewCount: number): RunTotals {
  return {
    calls: 0,
    executed: 0,
    failed: 0,
    skipped: 0,
    lastRemaining: previewCount,
    lastRetryLater: 0,
    failedCodes: {},
    lastRetryCodes: {},
    batchIds: [],
    total: previewCount,
  };
}

export const processedOf = (r: Pick<RunTotals, "executed" | "failed" | "skipped">): number =>
  r.executed + r.failed + r.skipped;

function countCodes(into: CodeCounts, res: ActionResponse, outcome: "failed" | "retry_later"): CodeCounts {
  const next = { ...into };
  for (const r of res.results) {
    if (r.outcome === outcome && r.error) next[r.error] = (next[r.error] ?? 0) + 1;
  }
  return next;
}

export function accumulate(run: RunTotals, res: ActionResponse): RunTotals {
  const executed = run.executed + res.executed;
  const failed = run.failed + res.failed;
  const skipped = run.skipped + res.skipped;
  return {
    calls: run.calls + 1,
    executed,
    failed,
    skipped,
    lastRemaining: res.remaining,
    lastRetryLater: res.retryLater,
    failedCodes: countCodes(run.failedCodes, res, "failed"),
    lastRetryCodes: countCodes({}, res, "retry_later"),
    batchIds: res.batchId === null ? run.batchIds : [...run.batchIds, res.batchId],
    total: Math.max(run.total, executed + failed + skipped + res.remaining),
  };
}

export function dominantReason(run: RunTotals): PartialReason {
  const merged: CodeCounts = { ...run.failedCodes };
  for (const [code, n] of Object.entries(run.lastRetryCodes) as [ItemErrorCode, number][]) {
    merged[code] = (merged[code] ?? 0) + n;
  }
  const entries = Object.entries(merged) as [ItemErrorCode, number][];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const top = entries.sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] * 2 > total && (top[0] === "account_inactive" || top[0] === "rate_limited"))
    return top[0];
  return "no_progress";
}

export function mapError(e: unknown): PartialReason {
  if (!isApiError(e)) return "unexpected";
  if (e.code === "budget_exhausted") return "budget";
  if (e.code === "rate_limited") return "rate_limited";
  if (e.code === "network" || e.status >= 500) return "network";
  return "unexpected";
}

const retryable = (e: unknown): boolean => isApiError(e) && (e.code === "network" || e.status >= 500);

async function postWithOneRetry(deps: CleanupDeps, body: CleanupBody): Promise<ActionResponse> {
  try {
    return await deps.post(body);
  } catch (e) {
    if (!retryable(e)) throw e;
    await deps.sleep(RETRY_DELAY_MS);
    return deps.post(body);
  }
}

/** UI spec 5.2.3: the server caps each call at 100 items and returns `remaining`. */
export async function runCleanup(
  preview: CleanupPreview,
  scope: { actions: ActionKind[]; accountId?: string | undefined },
  deps: CleanupDeps,
): Promise<RunOutcome> {
  const body: CleanupBody = {
    threshold: preview.threshold,
    actions: scope.actions,
    asOf: preview.asOf,
    ...(scope.accountId ? { accountId: scope.accountId } : {}),
  };
  let run = emptyTotals(preview.count);
  const maxCalls = Math.ceil(preview.count / 100) + 5;
  for (;;) {
    if (deps.signal.stop) return { phase: "partial", reason: "stopped", run };
    let res: ActionResponse;
    try {
      res = await postWithOneRetry(deps, body);
    } catch (e) {
      const reason = mapError(e);
      if (reason === "unexpected") reportBug("Clean up stopped on an unexpected error", e);
      return { phase: "partial", reason, run };
    }
    run = accumulate(run, res);
    deps.onProgress?.(run);
    if (res.remaining === 0) {
      return run.failed > 0 ? { phase: "partial", reason: "item_failures", run } : { phase: "done", run };
    }
    if (processedOf(res) === 0 || run.calls >= maxCalls)
      return { phase: "partial", reason: dominantReason(run), run };
  }
}
