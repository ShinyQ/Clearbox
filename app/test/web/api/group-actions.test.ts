import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, GroupDetail, SenderGroup, SuggestionItem } from "../../../src/shared/api.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { actOnGroup, type GroupActionDeps } from "../../../src/web/api/group-actions.ts";

const group = (o: Partial<SenderGroup> = {}): SenderGroup => ({
  key: "g1",
  accountId: "acc_1",
  provider: "gmail",
  sender: "promo@northwind.example",
  senderName: "Northwind Deals",
  domain: "northwind.example",
  action: "delete",
  count: 150,
  confidence: { min: 0.9, avg: 0.95, max: 0.99 },
  topReasons: [],
  ceilingApplied: false,
  newestReceivedAt: "2026-10-15T09:00:00.000Z",
  oldestReceivedAt: "2026-10-01T09:00:00.000Z",
  latestSubject: null,
  ...o,
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
const detail = (ids: number[]): GroupDetail => ({
  asOf: "2026-10-15T10:00:00.000Z",
  group: group(),
  items: { items: ids.map((id) => ({ id }) as SuggestionItem), nextCursor: null },
});

function fakeDeps(o: Partial<GroupActionDeps>): GroupActionDeps {
  return {
    approve: vi.fn(async () => res({})),
    override: vi.fn(async () => res({})),
    groupDetail: vi.fn(async () => detail([])),
    ...o,
  };
}

describe("actOnGroup", () => {
  it("approves the whole group by groupKey, 100 per call, until remaining is 0", async () => {
    const approve = vi
      .fn()
      .mockResolvedValueOnce(res({ batchId: 7, executed: 100, remaining: 50 }))
      .mockResolvedValueOnce(res({ batchId: 8, executed: 50, remaining: 0 }));
    const d = fakeDeps({ approve });
    const out = await actOnGroup(group(), "delete", "2026-10-15T10:00:00.000Z", d);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledWith({ groupKey: "g1", asOf: "2026-10-15T10:00:00.000Z" });
    expect(out).toEqual({
      executed: 150,
      failed: 0,
      skipped: 0,
      retryLater: 0,
      batchIds: [7, 8],
      codes: {},
      error: null,
    });
  });

  it("overrides by paging the pending items with limit 100", async () => {
    const groupDetail = vi
      .fn()
      .mockResolvedValueOnce(detail([1, 2, 3]))
      .mockResolvedValueOnce(detail([]));
    const override = vi.fn().mockResolvedValueOnce(res({ batchId: 9, executed: 3 }));
    const d = fakeDeps({ groupDetail, override });
    const out = await actOnGroup(group({ count: 3 }), "archive", "x", d);
    expect(groupDetail).toHaveBeenCalledWith("g1", { limit: 100 });
    expect(override).toHaveBeenCalledWith({ ids: [1, 2, 3], action: "archive" });
    expect(out.executed).toBe(3);
    expect(out.batchIds).toEqual([9]);
  });

  it("never approves a Check group", async () => {
    const d = fakeDeps({
      groupDetail: vi
        .fn()
        .mockResolvedValueOnce(detail([4]))
        .mockResolvedValueOnce(detail([])),
    });
    await actOnGroup(group({ action: "unsure", count: 1 }), "keep", "x", d);
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.override).toHaveBeenCalledWith({ ids: [4], action: "keep" });
  });

  it("stops when an override call only returns retry_later", async () => {
    const groupDetail = vi.fn().mockResolvedValue(detail([1]));
    const override = vi.fn().mockResolvedValue(res({ retryLater: 1 }));
    const out = await actOnGroup(group({ count: 1 }), "keep", "x", fakeDeps({ groupDetail, override }));
    expect(override).toHaveBeenCalledTimes(1);
    expect(out.retryLater).toBe(1);
  });

  it("treats a group that vanished (404) as finished", async () => {
    const groupDetail = vi
      .fn()
      .mockResolvedValueOnce(detail([1, 2]))
      .mockRejectedValueOnce(new ApiError(404, "not_found", "x"));
    const override = vi.fn().mockResolvedValueOnce(res({ batchId: 4, executed: 2 }));
    const out = await actOnGroup(group({ count: 2 }), "keep", "x", fakeDeps({ groupDetail, override }));
    expect(out).toMatchObject({ executed: 2, error: null });
  });

  it("returns the error with partial totals", async () => {
    const approve = vi
      .fn()
      .mockResolvedValueOnce(res({ batchId: 1, executed: 100, remaining: 50 }))
      .mockRejectedValueOnce(new ApiError(429, "budget_exhausted", "x"));
    const out = await actOnGroup(group(), "delete", "x", fakeDeps({ approve }));
    expect(out.executed).toBe(100);
    expect(out.error?.code).toBe("budget_exhausted");
  });
});
