import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, CleanupBody, CleanupPreview } from "../../../src/shared/api.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { runCleanup, type CleanupDeps } from "../../../src/web/api/cleanup.ts";

const preview = (count: number): CleanupPreview => ({
  asOf: "2026-10-15T10:00:00.000Z",
  threshold: 0.87,
  defaultThreshold: 0.87,
  count,
  byAction: { delete: count, archive: 0, keep: 0 },
  groups: 3,
  groupsLeft: 1,
});

const res = (o: Partial<ActionResponse>): ActionResponse => ({
  batchId: null,
  results: [],
  executed: 0,
  failed: 0,
  skipped: 0,
  retryLater: 0,
  remaining: 0,
  ...o,
});

function deps(responses: (ActionResponse | Error)[], overrides: Partial<CleanupDeps> = {}) {
  const bodies: CleanupBody[] = [];
  const queue = [...responses];
  const d: CleanupDeps = {
    post: vi.fn(async (body: CleanupBody) => {
      bodies.push(body);
      const next = queue.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async () => undefined),
    signal: { stop: false },
    ...overrides,
  };
  return { d, bodies };
}

describe("runCleanup", () => {
  it("loops until remaining is 0 and sends the confirmed threshold and asOf unchanged", async () => {
    const { d, bodies } = deps([
      res({ batchId: 1, executed: 100, remaining: 150 }),
      res({ batchId: 2, executed: 100, remaining: 50 }),
      res({ batchId: 3, executed: 48, skipped: 2, remaining: 0 }),
    ]);
    const out = await runCleanup(preview(250), { actions: ["delete", "archive"] }, d);
    expect(out.phase).toBe("done");
    expect(out.run).toMatchObject({ calls: 3, executed: 248, skipped: 2, batchIds: [1, 2, 3], total: 250 });
    expect(bodies).toEqual(
      Array(3).fill({ threshold: 0.87, actions: ["delete", "archive"], asOf: "2026-10-15T10:00:00.000Z" }),
    );
  });

  it("adds accountId when the run is scoped", async () => {
    const { d, bodies } = deps([res({ batchId: 1, executed: 5 })]);
    await runCleanup(preview(5), { actions: ["keep"], accountId: "acc_1" }, d);
    expect(bodies[0]).toEqual({
      threshold: 0.87,
      actions: ["keep"],
      asOf: "2026-10-15T10:00:00.000Z",
      accountId: "acc_1",
    });
  });

  it("stops with no_progress when a call makes no progress", async () => {
    const { d } = deps([
      res({ batchId: 1, executed: 100, remaining: 5 }),
      res({ retryLater: 5, remaining: 5 }),
    ]);
    const out = await runCleanup(preview(105), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "no_progress" });
    expect(out.run.executed).toBe(100);
  });

  it("names account_inactive when it dominates the retry_later items", async () => {
    const retry = Array.from({ length: 4 }, (_, i) => ({
      id: i,
      outcome: "retry_later" as const,
      action: "delete" as const,
      error: "account_inactive" as const,
    }));
    const { d } = deps([
      res({ batchId: 1, executed: 10, remaining: 4 }),
      res({ results: retry, retryLater: 4, remaining: 4 }),
    ]);
    expect(await runCleanup(preview(14), { actions: ["delete"] }, d)).toMatchObject({
      reason: "account_inactive",
    });
  });

  it("returns partial budget on 429 budget_exhausted without retrying", async () => {
    const { d } = deps([
      res({ batchId: 1, executed: 100, remaining: 20 }),
      new ApiError(429, "budget_exhausted", "x"),
    ]);
    const out = await runCleanup(preview(120), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "budget" });
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("returns partial rate_limited on 429 rate_limited", async () => {
    const { d } = deps([new ApiError(429, "rate_limited", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({
      reason: "rate_limited",
    });
  });

  it("retries a 5xx or network failure once after 2 s", async () => {
    const { d } = deps([new ApiError(503, "internal", "x"), res({ batchId: 1, executed: 10, remaining: 0 })]);
    const out = await runCleanup(preview(10), { actions: ["delete"] }, d);
    expect(out.phase).toBe("done");
    expect(d.sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up with network after the second failure", async () => {
    const { d } = deps([new ApiError(0, "network", "x"), new ApiError(0, "network", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({ reason: "network" });
  });

  it("maps a 400 to unexpected", async () => {
    const { d } = deps([new ApiError(400, "validation_failed", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({ reason: "unexpected" });
  });

  it("stops after maxCalls = ceil(count / 100) + 5", async () => {
    const { d } = deps(
      Array.from({ length: 20 }, (_, i) => res({ batchId: i + 1, executed: 1, remaining: 50 })),
    );
    const out = await runCleanup(preview(100), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "no_progress" });
    expect(out.run.calls).toBe(6);
  });

  it("honors Stop after the in-flight call completes", async () => {
    const signal = { stop: false };
    const { d } = deps([res({ batchId: 1, executed: 100, remaining: 100 })], { signal });
    (d.post as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      signal.stop = true;
      return res({ batchId: 1, executed: 100, remaining: 100 });
    });
    const out = await runCleanup(preview(200), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "stopped" });
    expect(out.run).toMatchObject({ executed: 100, batchIds: [1] });
  });

  it("reports item failures when the queue empties with failed items", async () => {
    const { d } = deps([res({ batchId: 1, executed: 96, failed: 4, remaining: 0 })]);
    expect(await runCleanup(preview(100), { actions: ["delete"] }, d)).toMatchObject({
      phase: "partial",
      reason: "item_failures",
    });
  });

  it("reports progress after every call", async () => {
    const onProgress = vi.fn();
    const { d } = deps(
      [res({ batchId: 1, executed: 100, remaining: 50 }), res({ batchId: 2, executed: 50 })],
      { onProgress },
    );
    await runCleanup(preview(150), { actions: ["delete"] }, d);
    expect(onProgress.mock.calls.map(([r]) => (r as { executed: number }).executed)).toEqual([100, 150]);
  });
});
