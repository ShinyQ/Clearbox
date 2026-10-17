import { describe, expect, it } from "vitest";
import { describeActivity } from "../../../src/web/lib/activity.ts";
import { createFakeApiState } from "../msw/fake-api.ts";

const s = createFakeApiState();
const ctx = {
  accountsById: Object.fromEntries(s.accounts.map((a) => [a.id, a])),
  batchesById: Object.fromEntries(s.batches.map((b) => [b.id, b])),
};
const row = (id: number) =>
  describeActivity(
    s.activity.find((e) => e.id === id)!,
    ctx,
  );

describe("describeActivity (UI spec 5.4)", () => {
  it("describes batch kinds with results and undo state", () => {
    expect(row(9)).toMatchObject({
      verb: "Clean up",
      detail: "1,284 emails, 371 sender groups",
      result: "1,280 done · 4 already moved",
      account: "All accounts",
      last: { kind: "undo", batchId: 3 },
    });
    expect(row(7)).toMatchObject({
      verb: "Trash",
      detail: "248 emails",
      result: "Done",
      account: "you@example.com",
      last: { kind: "undone" },
    });
    expect(row(6)).toMatchObject({
      verb: "Changed",
      detail: "12 emails to Trash",
      last: { kind: "expired" },
    });
    expect(row(8)).toMatchObject({ verb: "Undo", detail: "248 emails restored", result: "Done", last: null });
  });

  it("uses the singular for one purged record", () => {
    const purge = s.activity.find((e) => e.id === 3)!;
    expect(describeActivity({ ...purge, count: 1 }, ctx).detail).toBe("1 old record removed");
  });

  it("describes maintenance, rules and account events", () => {
    expect(row(5)).toMatchObject({
      verb: "Rules updated",
      detail: "",
      result: "Always keep 3 · Always OK to trash 1",
      last: { kind: "route", label: "Open Rules", to: "/rules" },
    });
    expect(row(4)).toMatchObject({
      verb: "Threshold tuned",
      detail: "checked 312 trash decisions",
      result: "Now 86%",
    });
    expect(row(3)).toMatchObject({
      verb: "Nightly cleanup",
      detail: "4,210 old records removed",
      result: "Done",
    });
    expect(row(2)).toMatchObject({
      verb: "Needs reconnect",
      detail: "you@example.net",
      result: "Sorting paused",
      last: null,
    });
    expect(row(1)).toMatchObject({ verb: "Connected", detail: "you@example.com", result: "Sorting started" });
  });

  it("names unknown accounts and offers Reconnect only while needed", () => {
    const entry = {
      id: 50,
      ts: s.activity[0]!.ts,
      kind: "reauth_required" as const,
      accountId: "acc_ffffffffffffffff",
      batchId: null,
      count: 0,
      result: {},
    };
    expect(describeActivity(entry, ctx)).toMatchObject({
      account: "A removed account",
      detail: "a removed account",
    });
    const needs = { ...s.accounts[1]!, status: "needs_reauth" as const };
    const withNeeds = { ...ctx, accountsById: { ...ctx.accountsById, [needs.id]: needs } };
    expect(
      describeActivity(
        s.activity.find((e) => e.id === 2)!,
        withNeeds,
      ).last,
    ).toMatchObject({
      kind: "reconnect",
    });
  });

  it("does not depend on the stored details of tick audit rows", () => {
    const needs = { ...s.accounts[1]!, status: "needs_reauth" as const };
    const withNeeds = { ...ctx, accountsById: { ...ctx.accountsById, [needs.id]: needs } };
    const base = { ts: s.activity[0]!.ts, accountId: needs.id, batchId: null, count: 0 };
    for (const result of [{}, { reason: "invalid_grant" }]) {
      const reauth = describeActivity({ ...base, id: 60, kind: "reauth_required", result }, withNeeds);
      expect(reauth).toMatchObject({
        verb: "Needs reconnect",
        detail: "you@example.net",
        result: "Sorting paused",
        last: { kind: "reconnect" },
      });
      expect(describeActivity({ ...base, id: 61, kind: "config_error", result }, withNeeds)).toMatchObject({
        verb: "Setup error",
        detail: "you@example.net",
        result: "Sorting paused",
        last: { kind: "route", label: "Open Accounts", to: "/accounts" },
      });
    }
  });

  it("derives approve verbs, override targets and failure counts from result keys", () => {
    const base = { ts: s.activity[0]!.ts, accountId: null, batchId: null, count: 30 };
    const counts = { executed: 0, failed: 0, skipped: 0, retryLater: 0, delete: 0, archive: 0, keep: 0 };
    const approve = (result: Record<string, number>) =>
      describeActivity({ ...base, id: 70, kind: "approve", result: { ...counts, ...result } }, ctx);
    expect(approve({ archive: 30, executed: 30 })).toMatchObject({ verb: "Archive", result: "Done" });
    expect(approve({ keep: 30, executed: 30 }).verb).toBe("Keep");
    expect(approve({ delete: 20, archive: 10, executed: 25, failed: 5 })).toMatchObject({
      verb: "Approved",
      result: "25 done · 5 failed",
    });
    const override = describeActivity(
      { ...base, id: 71, kind: "override", result: { ...counts, archive: 30, executed: 30 } },
      ctx,
    );
    expect(override.detail).toBe("30 emails to Archive");
    const undo = describeActivity(
      { ...base, id: 72, kind: "undo", result: { restored: 20, failed: 10 } },
      ctx,
    );
    expect(undo.result).toBe("20 restored · 10 failed");
  });

  it("shows no undo state for keep-only batches and keeps it when a trash or archive part exists", () => {
    const base = { ts: s.activity[0]!.ts, accountId: null, count: 30 };
    const counts = { executed: 30, failed: 0, skipped: 0, retryLater: 0, delete: 0, archive: 0, keep: 0 };
    const batch = (id: number, over: Partial<(typeof s.batches)[number]>) => ({
      ...s.batches[0]!,
      id,
      ...over,
    });
    const withBatches = {
      ...ctx,
      batchesById: {
        ...ctx.batchesById,
        20: batch(20, { undoable: true, byAction: { delete: 0, archive: 0, keep: 30 } }),
        21: batch(21, { undoable: false, undoneAt: "2026-10-15T08:00:00.000Z" }),
        22: batch(22, { undoable: false, undoExpiresAt: "2026-10-01T08:00:00.000Z" }),
        23: batch(23, { undoable: true, byAction: { delete: 0, archive: 10, keep: 20 } }),
      },
    };
    const approve = (batchId: number, result: Record<string, number>) =>
      describeActivity(
        { ...base, id: 90 + batchId, batchId, kind: "approve", result: { ...counts, ...result } },
        withBatches,
      );
    expect(approve(20, { keep: 30 }).last).toBeNull();
    expect(approve(21, { keep: 30 }).last).toBeNull();
    expect(approve(22, { keep: 30 }).last).toBeNull();
    expect(approve(23, { archive: 10, keep: 20 }).last).toEqual({ kind: "undo", batchId: 23 });
    expect(approve(20, { delete: 30 }).last).toEqual({ kind: "undo", batchId: 20 });
    const cleanup = describeActivity(
      { ...base, id: 99, batchId: 20, kind: "cleanup", result: { ...counts, keep: 30, groups: 3 } },
      withBatches,
    );
    expect(cleanup.last).toBeNull();
  });

  it("falls back for missing result details", () => {
    const base = { ts: s.activity[0]!.ts, accountId: null, batchId: null, count: 0, result: {} };
    expect(describeActivity({ ...base, id: 80, kind: "policy_updated" }, ctx).result).toBe("Saved");
    expect(describeActivity({ ...base, id: 81, kind: "calibration" }, ctx).result).toBe("Unchanged");
  });
});

describe("describeActivity unsubscribe rows (contracts 12.9)", () => {
  const entry = (outcome: string, count: number) =>
    describeActivity(
      {
        id: 99,
        ts: "2026-10-15T10:00:00.000Z",
        kind: "unsubscribe",
        accountId: null,
        batchId: null,
        count,
        result: { outcome, status: 200 },
      },
      ctx,
    );

  it("names no sender and maps outcome codes to short results", () => {
    expect(entry("unsubscribed", 1)).toMatchObject({
      verb: "Unsubscribed",
      detail: "one sender",
      result: "Done",
      last: null,
    });
    expect(entry("sender_redirect", 0)).toMatchObject({
      verb: "Unsubscribe failed",
      result: "Sender redirected",
    });
    expect(entry("unsafe_url", 0).result).toBe("Blocked: unsafe link");
    expect(entry("provider_error", 0).result).toBe("Mailbox error");
  });
});

describe("describeActivity auto-trash rows (contracts 12.11)", () => {
  const counts = {
    executed: 3,
    failed: 0,
    skipped: 0,
    retryLater: 0,
    delete: 3,
    archive: 0,
    keep: 0,
    groups: 1,
  };
  const batch = (over: object = {}) => ({
    id: 90,
    kind: "auto_trash" as const,
    createdAt: "2026-10-15T02:00:00.000Z",
    requestedCount: 3,
    executedCount: 3,
    failedCount: 0,
    byAction: { delete: 3, archive: 0, keep: 0 },
    undoable: true,
    undoExpiresAt: "2026-10-16T02:00:00.000Z",
    undoneAt: null,
    ...over,
  });
  const entry = (b: ReturnType<typeof batch> | null, count = 3, result: Record<string, number> = counts) =>
    describeActivity(
      {
        id: 90,
        ts: "2026-10-15T02:00:00.000Z",
        kind: "auto_trash",
        accountId: null,
        batchId: 90,
        count,
        result,
      },
      { ...ctx, batchesById: b ? { 90: b } : {} },
    );

  it("names the rule, not a sender, and offers Undo while the batch is undoable", () => {
    expect(entry(batch())).toMatchObject({
      verb: "Auto-trash",
      detail: "3 emails from Always OK to trash senders",
      result: "Done",
      account: "All accounts",
      last: { kind: "undo", batchId: 90 },
    });
    expect(entry(batch({ undoable: false, undoneAt: "2026-10-15T03:00:00.000Z" })).last).toEqual({
      kind: "undone",
    });
    expect(entry(null).last).toEqual({ kind: "expired" });
    expect(entry(batch(), 1, { ...counts, executed: 1, delete: 1 }).detail).toBe(
      "1 email from Always OK to trash senders",
    );
  });
});
