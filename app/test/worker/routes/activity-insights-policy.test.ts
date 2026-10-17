import { DEFAULT_POLICY } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, ApiErrorBody, Insights, Page, PolicyResponse } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { auditStmt } from "../../../src/worker/db/audit.ts";
import { budgetDeltaStmt } from "../../../src/worker/db/budget.ts";
import { setSettingStmt } from "../../../src/worker/db/settings.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, seedLabels, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;
const app = createApp({ now: () => SEED_NOW });

describe("GET /api/activity", () => {
  it("pages audit entries newest first and filters by account", async () => {
    const a = await seedAccount();
    await env.DB.batch([
      auditStmt(env.DB, {
        ts: SEED_NOW - 3,
        accountId: a.id,
        kind: "account_connected",
        batchId: null,
        count: 0,
        result: {},
      }),
      auditStmt(env.DB, {
        ts: SEED_NOW - 2,
        accountId: null,
        kind: "policy_updated",
        batchId: null,
        count: 0,
        result: { allow: 1, deny: 0 },
      }),
      auditStmt(env.DB, {
        ts: SEED_NOW - 1,
        accountId: a.id,
        kind: "account_paused",
        batchId: null,
        count: 0,
        result: {},
      }),
    ]);
    const first = await readJson<Page<ActivityEntry>>(await apiFetch("/api/activity?limit=2", {}, { app }));
    expect(first.items.map((e) => e.kind)).toEqual(["account_paused", "policy_updated"]);
    expect(first.items[1]?.result).toEqual({ allow: 1, deny: 0 });
    const second = await readJson<Page<ActivityEntry>>(
      await apiFetch(`/api/activity?limit=2&cursor=${first.nextCursor ?? ""}`, {}, { app }),
    );
    expect(second.items.map((e) => e.kind)).toEqual(["account_connected"]);
    expect(second.nextCursor).toBeNull();
    const filtered = await readJson<Page<ActivityEntry>>(
      await apiFetch(`/api/activity?accountId=${a.id}`, {}, { app }),
    );
    expect(filtered.items.map((e) => e.kind)).toEqual(["account_paused", "account_connected"]);
    const mismatch = await apiFetch(
      `/api/activity?accountId=${a.id}&cursor=${first.nextCursor ?? ""}`,
      {},
      { app },
    );
    expect(mismatch.status).toBe(400);
  });
});

describe("GET /api/insights", () => {
  it("reports precision, labels, calibration, budget, history, weekly and accounts", async () => {
    const acc = await seedAccount({ email: "insights@example.com" });
    await seedSuggestions(acc.id, 2);
    await seedLabels(acc.id, 10, (i) => ({
      suggestedAction: "delete",
      ownerAction: i === 0 ? "keep" : "delete",
      createdAt: SEED_NOW - i * DAY,
    }));
    await seedLabels(acc.id, 2, {
      suggestedAction: "archive",
      ownerAction: "archive",
      createdAt: SEED_NOW - 20 * DAY,
    });
    const today = "2026-10-15";
    await budgetDeltaStmt(
      env.DB,
      today,
      {
        rowsWritten: 1_000,
        ticks: 5,
        messagesIngested: 50,
        decisionCalls: 40,
        decisionInputTokens: 1_000_000,
        dbSizeBytes: 123,
      },
      SEED_NOW,
    ).run();
    await budgetDeltaStmt(env.DB, "2026-10-10", { rowsWritten: 10 }, SEED_NOW).run();
    await env.DB.batch([
      setSettingStmt(
        env.DB,
        "calibration",
        {
          tauDelete: 0.85,
          changed: true,
          outcome: "calibrated",
          deleteSuggestions: 60,
          precisionAtTau: 0.99,
          points: [{ tau: 0.85, support: 30, precision: 0.99 }],
          ranAt: SEED_NOW - DAY,
        },
        SEED_NOW,
      ),
      setSettingStmt(env.DB, "tau_delete", 0.85, SEED_NOW),
      auditStmt(env.DB, {
        ts: SEED_NOW - 1_000,
        accountId: acc.id,
        kind: "approve",
        batchId: 1,
        count: 3,
        result: {
          executed: 4,
          failed: 0,
          skipped: 0,
          retryLater: 0,
          delete: 2,
          archive: 1,
          keep: 1,
          groups: 2,
        },
      }),
      auditStmt(env.DB, {
        ts: SEED_NOW - 500,
        accountId: acc.id,
        kind: "undo",
        batchId: 1,
        count: 1,
        result: { restored: 1, failed: 0 },
      }),
      auditStmt(env.DB, {
        ts: SEED_NOW - 7 * DAY,
        accountId: acc.id,
        kind: "cleanup",
        batchId: 2,
        count: 5,
        result: {
          executed: 5,
          failed: 0,
          skipped: 0,
          retryLater: 0,
          delete: 5,
          archive: 0,
          keep: 0,
          groups: 1,
        },
      }),
    ]);
    const body = await readJson<Insights>(await apiFetch("/api/insights", {}, { app }));
    expect(body.precision).toEqual({ deletePrecision: 0.9, deleteSuggestionsDecided: 10, window: 500 });
    expect(body.labels).toEqual({ total: 12, last7Days: 8 });
    expect(body.calibration).toEqual({
      tauDelete: 0.85,
      outcome: "calibrated",
      ranAt: new Date(SEED_NOW - DAY).toISOString(),
      points: [{ tau: 0.85, support: 30, precision: 0.99 }],
      segments: [],
    });
    expect(body.budget).toMatchObject({
      date: today,
      rowsWritten: 1_000,
      rowsCap: 90_000,
      ingestStopRows: 65_000,
      d1DailyWriteLimit: 100_000,
      ticks: 5,
      decisionCalls: 40,
      dbSizeBytes: 123,
      dbSizeLimitBytes: 500_000_000,
    });
    expect(body.budget.estimatedDecisionCostUsd).toBeCloseTo(0.042, 9);
    expect(body.history).toHaveLength(14);
    expect(body.history[0]?.date).toBe("2026-10-02");
    expect(body.history.find((h) => h.date === "2026-10-10")?.rowsWritten).toBe(10);
    expect(body.weekly.map((w) => w.weekStart)).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(body.weekly[5]).toEqual({ weekStart: "2026-10-12", cleaned: 3, undone: 1 });
    expect(body.weekly[4]).toEqual({ weekStart: "2026-10-05", cleaned: 5, undone: 0 });
    expect(body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: acc.id,
          provider: "gmail",
          email: "insights@example.com",
          status: "active",
          paused: false,
          sync: expect.objectContaining({ pendingCount: 2 }),
        }),
      ]),
    );
  });
});

describe("policy routes", () => {
  it("returns the defaults and version", async () => {
    expect(await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }))).toEqual({
      policy: DEFAULT_POLICY,
      version: 1,
      defaults: DEFAULT_POLICY,
      autoTrashKillSwitch: false,
    });
  });

  it("reports the auto-trash kill switch (contracts 12.11)", async () => {
    const on = await readJson<PolicyResponse>(
      await apiFetch("/api/policy", {}, { app, env: { AUTO_TRASH_KILL_SWITCH: "on" } }),
    );
    expect(on.autoTrashKillSwitch).toBe(true);
    expect(on.policy.autoTrash).toBe(false);
  });

  it("updates with optimistic concurrency and writes an audit row", async () => {
    const policy = { ...DEFAULT_POLICY, allowlist: ["boss@example.com"], minAgeDays: 5 };
    const res = await apiFetch("/api/policy", jsonInit("PUT", { policy, expectedVersion: 1 }), { app });
    expect(await readJson<PolicyResponse>(res)).toMatchObject({
      version: 2,
      policy: { allowlist: ["boss@example.com"], minAgeDays: 5 },
    });
    const stale = await apiFetch(
      "/api/policy",
      jsonInit("PUT", { policy: { ...policy, denylist: ["spam@example.org"] }, expectedVersion: 1 }),
      { app },
    );
    expect(stale.status).toBe(409);
    expect((await readJson<ApiErrorBody>(stale)).error.code).toBe("conflict");
    // A stale write in the same millisecond as the winning write changes nothing.
    const current = await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }));
    expect(current).toMatchObject({ version: 2, policy: { denylist: [] } });
    const bad = await apiFetch(
      "/api/policy",
      jsonInit("PUT", { policy: { ...policy, minAgeDays: -1 }, expectedVersion: 2 }),
      { app },
    );
    expect(bad.status).toBe(400);
    const audit = await env.DB.prepare(
      "SELECT result_json FROM audit_log WHERE kind = 'policy_updated' AND ts = ?1",
    )
      .bind(SEED_NOW)
      .all();
    expect(audit.results).toEqual([{ result_json: JSON.stringify({ allow: 1, deny: 0 }) }]);
  });

  it("moves a sender between lists and removes it with none", async () => {
    const deny = await readJson<PolicyResponse>(
      await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "Boss@Example.com", list: "deny" }), {
        app,
      }),
    );
    expect(deny.policy.denylist).toContain("boss@example.com");
    expect(deny.policy.allowlist).not.toContain("boss@example.com");
    const domain = await readJson<PolicyResponse>(
      await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "@example.net", list: "allow" }), {
        app,
      }),
    );
    expect(domain.policy.allowlist).toContain("@example.net");
    const none = await readJson<PolicyResponse>(
      await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "boss@example.com", list: "none" }), {
        app,
      }),
    );
    expect(none.policy.denylist).not.toContain("boss@example.com");
    expect(none.version).toBe(deny.version + 2);
    const invalid = await apiFetch(
      "/api/policy/senders",
      jsonInit("PATCH", { entry: "not an address", list: "deny" }),
      { app },
    );
    expect(invalid.status).toBe(400);
  });
});

describe("GET /api/insights weekly with auto-trash (contracts 12.11)", () => {
  it("counts auto-trashed emails as cleaned", async () => {
    const cleaned = async () =>
      (await readJson<Insights>(await apiFetch("/api/insights", {}, { app }))).weekly[5]?.cleaned ?? 0;
    const before = await cleaned();
    await auditStmt(env.DB, {
      ts: SEED_NOW - 1_000,
      accountId: null,
      kind: "auto_trash",
      batchId: null,
      count: 4,
      result: { executed: 4, delete: 4 },
    }).run();
    expect((await cleaned()) - before).toBe(4);
  });
});
