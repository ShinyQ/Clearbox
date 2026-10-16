import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  auditStmt,
  mapActivity,
  selectActivityStmt,
  selectAuditKindsSinceStmt,
  selectBatchAuditStmt,
} from "../../../src/worker/db/audit.ts";
import type { AuditRow } from "../../../src/worker/db/audit.ts";
import { budgetDeltaStmt, readBudget, selectBudgetHistoryStmt } from "../../../src/worker/db/budget.ts";
import type { BudgetRow } from "../../../src/worker/db/budget.ts";

const NOW = Date.UTC(2026, 9, 15, 12);

describe("budget repository", () => {
  it("returns zeros for a day without a row", async () => {
    expect(await readBudget(env.DB, "2026-01-01")).toMatchObject({
      date: "2026-01-01",
      rowsWritten: 0,
      ticks: 0,
    });
  });

  it("accumulates deltas and keeps db size unless provided", async () => {
    await budgetDeltaStmt(env.DB, "2026-10-15", { rowsWritten: 10, ticks: 1, dbSizeBytes: 5_000 }, NOW).run();
    await budgetDeltaStmt(env.DB, "2026-10-15", { rowsWritten: 7, providerCalls: 3 }, NOW + 1).run();
    const b = await readBudget(env.DB, "2026-10-15");
    expect(b).toMatchObject({
      rowsWritten: 17,
      ticks: 1,
      providerCalls: 3,
      dbSizeBytes: 5_000,
      updatedAt: NOW + 1,
    });
    await budgetDeltaStmt(env.DB, "2026-10-14", { rowsWritten: 1 }, NOW).run();
    const history = await selectBudgetHistoryStmt(env.DB, "2026-10-14").run<BudgetRow>();
    expect(history.results.map((r) => r.date)).toEqual(["2026-10-14", "2026-10-15"]);
  });
});

describe("audit repository", () => {
  it("appends rows and pages them newest first with an optional account filter", async () => {
    await env.DB.batch([
      auditStmt(env.DB, {
        ts: NOW,
        accountId: "acc_0000000000000001",
        kind: "account_connected",
        batchId: null,
        count: 0,
        result: {},
      }),
      auditStmt(env.DB, {
        ts: NOW + 1,
        accountId: null,
        kind: "approve",
        batchId: 9,
        count: 3,
        result: { executed: 3, delete: 3 },
      }),
      auditStmt(env.DB, {
        ts: NOW + 2,
        accountId: "acc_0000000000000002",
        kind: "account_paused",
        batchId: null,
        count: 0,
        result: {},
      }),
    ]);
    const page = await selectActivityStmt(env.DB, {
      accountId: null,
      beforeId: null,
      limit: 2,
    }).run<AuditRow>();
    const entries = page.results.map(mapActivity);
    expect(entries.map((e) => e.kind)).toEqual(["account_paused", "approve"]);
    expect(entries[1]).toMatchObject({
      batchId: 9,
      count: 3,
      result: { executed: 3, delete: 3 },
      ts: new Date(NOW + 1).toISOString(),
    });
    const older = await selectActivityStmt(env.DB, {
      accountId: null,
      beforeId: entries[1]?.id ?? 0,
      limit: 5,
    }).run<AuditRow>();
    expect(older.results.map((r) => r.kind)).toEqual(["account_connected"]);
    const filtered = await selectActivityStmt(env.DB, {
      accountId: "acc_0000000000000002",
      beforeId: null,
      limit: 5,
    }).run<AuditRow>();
    expect(filtered.results).toHaveLength(1);
    const batchRows = await selectBatchAuditStmt(env.DB, [9, 10]).run<AuditRow>();
    expect(batchRows.results.map((r) => r.batch_id)).toEqual([9]);
    const since = await selectAuditKindsSinceStmt(env.DB, NOW + 1, [
      "approve",
      "account_paused",
    ]).run<AuditRow>();
    expect(since.results.map((r) => r.kind)).toEqual(["approve", "account_paused"]);
  });

  it("stores exactly the fixed result keys per kind (decision 28, contracts 12.1 A5)", async () => {
    await env.DB.batch([
      auditStmt(env.DB, {
        ts: NOW,
        accountId: null,
        kind: "cleanup",
        batchId: null,
        count: 2,
        result: { delete: 2, extra: "x" },
      }),
      auditStmt(env.DB, {
        ts: NOW,
        accountId: null,
        kind: "undo",
        batchId: null,
        count: 1,
        result: { restored: 1 },
      }),
      auditStmt(env.DB, {
        ts: NOW,
        accountId: null,
        kind: "policy_updated",
        batchId: null,
        count: 0,
        result: { allow: 2 },
      }),
      auditStmt(env.DB, {
        ts: NOW,
        accountId: "acc_0000000000000001",
        kind: "account_resumed",
        batchId: null,
        count: 0,
        result: { stray: 1 },
      }),
    ]);
    const rows = await selectAuditKindsSinceStmt(env.DB, NOW, [
      "cleanup",
      "undo",
      "policy_updated",
      "account_resumed",
    ]).run<AuditRow>();
    expect(rows.results.map((r) => JSON.parse(r.result_json) as unknown)).toEqual([
      { executed: 0, failed: 0, skipped: 0, retryLater: 0, delete: 2, archive: 0, keep: 0, groups: 0 },
      { restored: 1, failed: 0 },
      { allow: 2, deny: 0 },
      {},
    ]);
  });

  it("resolves latest_batch to the newest action batch id", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO action_batches (id, created_at, kind, suggestion_ids_json, requested_count, undo_expires_at) VALUES (41, ?1, 'approve', '[1]', 1, ?1)",
      ).bind(NOW),
      auditStmt(env.DB, {
        ts: NOW,
        accountId: null,
        kind: "approve",
        batchId: "latest_batch",
        count: 1,
        result: { executed: 1 },
      }),
    ]);
    const rows = await selectBatchAuditStmt(env.DB, [41]).run<AuditRow>();
    expect(rows.results.map((r) => r.batch_id)).toEqual([41]);
  });
});

describe("audit statement limits", () => {
  it("rejects more batch ids than the bound parameter limit", () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() => selectBatchAuditStmt(env.DB, ids)).toThrow(RangeError);
    expect(() => selectBatchAuditStmt(env.DB, ids.slice(0, 99))).not.toThrow();
  });
});
