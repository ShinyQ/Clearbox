import { PURGE_STOP_ROWS } from "@clearbox/core";
import { makeSignals } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNightly } from "../../../src/worker/nightly/nightly.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  MINUTE,
  NOW,
  count,
  one,
  resetDb,
  seedLabel,
  seedMessage,
  seedTickAccount,
  setBudget,
} from "../helpers/tick-db.ts";
import { expectNoUnhandled, useNetwork } from "../helpers/provider-mock.ts";

const ACCOUNT_C = "acc_00000000000000c3";

async function setting<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?1", key);
  return row === null ? null : (JSON.parse(row.value) as T);
}

async function suggestion(
  messageId: number,
): Promise<{ status: string; exec_error: string | null; updated_at: number } | null> {
  return one("SELECT status, exec_error, updated_at FROM suggestions WHERE message_id = ?1", messageId);
}

/** Delegates to the test D1 binding and records each prepared SQL string and each batch call. */
function recordingEnv(): { env: Env; sqls: string[]; batches: () => number } {
  const sqls: string[] = [];
  let batches = 0;
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return env.DB.prepare(sql);
    },
    batch(stmts: D1PreparedStatement[]) {
      batches += 1;
      return env.DB.batch(stmts);
    },
  } as unknown as D1Database;
  return { env: { ...env, DB: db }, sqls, batches: () => batches };
}

const isRecovery = (sql: string): boolean => /^UPDATE suggestions SET status = 'failed'/.test(sql);

describe("runNightly", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
    // The nightly job makes no provider or Decision calls: any request fails the test.
    useNetwork();
  });

  afterEach(expectNoUnhandled);

  it("calibrates tau_delete from the newest labels and audits it with the A5 result key", async () => {
    for (let i = 0; i < 60; i++) {
      await seedLabel(ACCOUNT_A, { pDelete: 0.85, margin: 0.5, ownerAction: i < 10 ? "keep" : "delete" });
    }
    for (let i = 0; i < 50; i++)
      await seedLabel(ACCOUNT_A, { pDelete: 0.95, margin: 0.9, ownerAction: "delete" });
    await runNightly(env, { now: NOW });
    expect(await setting<number>("tau_delete")).toBeCloseTo(0.86, 9);
    expect(await setting<{ outcome: string; ranAt: number }>("calibration")).toMatchObject({
      outcome: "calibrated",
      ranAt: NOW,
    });
    const audit = await one<{ count: number; result_json: string }>(
      "SELECT count, result_json FROM audit_log WHERE kind = 'calibration'",
    );
    expect(audit?.count).toBe(110);
    expect(JSON.parse(audit?.result_json ?? "{}")).toEqual({ tauDelete: 0.86 });
  });

  it("calibrates a threshold per segment and pauses a segment that cannot reach 98% (contracts 12.10)", async () => {
    for (let i = 0; i < 60; i++)
      await seedLabel(ACCOUNT_A, { pDelete: 0.9, margin: 0.5, ownerAction: "delete" });
    for (let i = 0; i < 70; i++) {
      await seedLabel(ACCOUNT_A, { pDelete: 0.95, margin: 0.5, ownerAction: i < 10 ? "keep" : "delete" });
    }
    await env.DB.prepare(
      "UPDATE labels SET segment = CASE WHEN p_delete < 0.92 THEN 'bulk' ELSE 'sender' END",
    ).run();
    await runNightly(env, { now: NOW });
    expect(await setting("tau_segments")).toEqual({ sender: null, domain: 0.99, bulk: 0.8, other: 0.99 });
    const calibration = await setting<{ segments: { segment: string; outcome: string }[] }>("calibration");
    expect(calibration?.segments.map((g) => [g.segment, g.outcome])).toEqual([
      ["sender", "no_tau_meets_target"],
      ["domain", "insufficient_data"],
      ["bulk", "calibrated"],
      ["other", "insufficient_data"],
    ]);
  });

  it("re-fuses pending suggestions with the new thresholds", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('tau_segments', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify({ sender: null, domain: null, bulk: null, other: null }))
      .run();
    const id = await seedMessage(ACCOUNT_A, {
      providerId: "fresh",
      status: "pending",
      receivedAt: NOW - 10 * DAY,
    });
    await env.DB.prepare(
      `UPDATE suggestions SET action = 'delete', confidence = 0.95, p_delete = 0.95, margin = 0.9, ceiling = 'delete',
         model_action_json = '{"delete":0.95,"archive":0.02,"keep":0.02,"unsure":0.01}',
         flags_json = '{"isRecord":0.01,"isExpired":0.01,"isFromHuman":0.01}', importance = 0.5
       WHERE message_id = ?1`,
    )
      .bind(id)
      .run();
    await env.DB.prepare("UPDATE messages SET signals_json = ?2 WHERE id = ?1")
      .bind(
        id,
        JSON.stringify(makeSignals({ senderAddress: "news@shop.example", senderDomain: "shop.example" })),
      )
      .run();
    await runNightly(env, { now: NOW });
    // Too few labels: every segment keeps its current value, here paused, so the trash suggestion turns to Check.
    expect(await one("SELECT action, segment FROM suggestions WHERE message_id = ?1", id)).toEqual({
      action: "unsure",
      segment: "other",
    });
    expect(await setting<{ refreshed: number }>("nightly")).toMatchObject({ refreshed: 1 });
  });

  it("keeps tau_delete with too few labels", async () => {
    await seedLabel(ACCOUNT_A, { pDelete: 0.95, margin: 0.9, ownerAction: "delete" });
    await runNightly(env, { now: NOW });
    expect(await setting<number>("tau_delete")).toBe(0.8);
    expect(await setting<{ outcome: string }>("calibration")).toMatchObject({ outcome: "insufficient_data" });
  });

  it("recovers stale approvals, purges expired rows and records the summary", async () => {
    const stale = await seedMessage(ACCOUNT_A, {
      providerId: "stale",
      status: "approved",
      updatedAt: NOW - 11 * MINUTE,
    });
    const fresh = await seedMessage(ACCOUNT_A, {
      providerId: "fresh",
      status: "approved",
      updatedAt: NOW - MINUTE,
    });
    for (const id of ["x-1", "x-2", "x-3"])
      await seedMessage(ACCOUNT_A, { providerId: id, expiresAt: NOW - 1 });
    await runNightly(env, { now: NOW });
    expect(await one("SELECT status, exec_error FROM suggestions WHERE message_id = ?1", stale)).toEqual({
      status: "failed",
      exec_error: "interrupted",
    });
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", fresh)).toEqual({
      status: "approved",
    });
    expect(await count("messages", "provider_msg_id LIKE 'x-%'")).toBe(0);
    expect(await setting("nightly")).toEqual({
      ranAt: NOW,
      purgedMessages: 3,
      purgedAccounts: 0,
      staleRecovered: 1,
      refreshed: 0,
    });
    expect(await one("SELECT count FROM audit_log WHERE kind = 'purge'")).toEqual({ count: 3 });
    expect(await one("SELECT released_at FROM leases WHERE name = 'nightly'")).toEqual({ released_at: NOW });
    expect(
      (await one<{ rows_written: number }>("SELECT rows_written FROM budget WHERE date = ?1", utcDate(NOW)))
        ?.rows_written,
    ).toBeGreaterThan(0);
  });

  it("recovers stale approvals per account, each by its own condition", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "second@example.test" });
    const aStale = await seedMessage(ACCOUNT_A, {
      providerId: "a-stale",
      status: "approved",
      updatedAt: NOW - 11 * MINUTE,
    });
    const aFresh = await seedMessage(ACCOUNT_A, {
      providerId: "a-fresh",
      status: "approved",
      updatedAt: NOW - 9 * MINUTE,
    });
    const bStale = await seedMessage(ACCOUNT_B, {
      providerId: "b-stale",
      status: "approved",
      updatedAt: NOW - 60 * MINUTE,
    });
    const bFresh = await seedMessage(ACCOUNT_B, {
      providerId: "b-fresh",
      status: "approved",
      updatedAt: NOW - MINUTE,
    });
    const bPending = await seedMessage(ACCOUNT_B, {
      providerId: "b-pending",
      status: "pending",
      updatedAt: NOW - DAY,
    });
    await runNightly(env, { now: NOW });
    expect(await suggestion(aStale)).toEqual({
      status: "failed",
      exec_error: "interrupted",
      updated_at: NOW,
    });
    expect(await suggestion(bStale)).toEqual({
      status: "failed",
      exec_error: "interrupted",
      updated_at: NOW,
    });
    expect(await suggestion(aFresh)).toEqual({
      status: "approved",
      exec_error: null,
      updated_at: NOW - 9 * MINUTE,
    });
    expect(await suggestion(bFresh)).toEqual({
      status: "approved",
      exec_error: null,
      updated_at: NOW - MINUTE,
    });
    expect(await suggestion(bPending)).toEqual({
      status: "pending",
      exec_error: null,
      updated_at: NOW - DAY,
    });
    expect(await setting("nightly")).toMatchObject({ staleRecovered: 2 });
  });

  it("issues one account-scoped stale recovery UPDATE per account and stays within 45 D1 calls", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "second@example.test", status: "disconnected" });
    await seedTickAccount({ id: ACCOUNT_C, email: "third@example.test", status: "needs_reauth" });
    const rec = recordingEnv();
    await runNightly(rec.env, { now: NOW });
    const recovery = rec.sqls.filter(isRecovery);
    expect(recovery).toHaveLength(3);
    for (const sql of recovery)
      expect(sql).toMatch(/WHERE account_id = \?1 AND status = 'approved' AND updated_at < \?3/);
    expect(rec.batches()).toBeLessThanOrEqual(45);
  });

  it("runs with no accounts at all (no stale recovery statements)", async () => {
    await env.DB.prepare("DELETE FROM accounts").run();
    const rec = recordingEnv();
    await runNightly(rec.env, { now: NOW });
    expect(rec.sqls.filter(isRecovery)).toEqual([]);
    expect(await setting("nightly")).toEqual({
      ranAt: NOW,
      purgedMessages: 0,
      purgedAccounts: 0,
      staleRecovered: 0,
      refreshed: 0,
    });
    expect(await setting<{ outcome: string }>("calibration")).toMatchObject({ outcome: "insufficient_data" });
  });

  it("purges a disconnected account end to end", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "gone@example.test", status: "disconnected" });
    await seedMessage(ACCOUNT_B, { providerId: "b-1" });
    await runNightly(env, { now: NOW });
    expect(await count("accounts", "id = ?1", ACCOUNT_B)).toBe(0);
    expect(await count("messages", "account_id = ?1", ACCOUNT_B)).toBe(0);
    expect(await setting("nightly")).toMatchObject({ purgedAccounts: 1 });
  });

  it("leaves accounts that are not disconnected and their rows in place", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "reauth@example.test", status: "needs_reauth" });
    await seedTickAccount({ id: ACCOUNT_C, email: "gone@example.test", status: "disconnected" });
    for (const id of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]) {
      await seedMessage(id, { providerId: `${id}-1` });
      await seedLabel(id, { pDelete: 0.9, margin: 0.9, ownerAction: "delete" });
    }
    await runNightly(env, { now: NOW });
    expect(await count("accounts", "id = ?1", ACCOUNT_C)).toBe(0);
    expect(await count("messages", "account_id = ?1", ACCOUNT_C)).toBe(0);
    expect(await count("labels", "account_id = ?1", ACCOUNT_C)).toBe(0);
    for (const id of [ACCOUNT_A, ACCOUNT_B]) {
      expect(await count("accounts", "id = ?1", id)).toBe(1);
      expect(await count("messages", "account_id = ?1", id)).toBe(1);
      expect(await count("suggestions", "account_id = ?1", id)).toBe(1);
      expect(await count("labels", "account_id = ?1", id)).toBe(1);
    }
    expect(await setting("nightly")).toMatchObject({ purgedAccounts: 1, purgedMessages: 1 });
  });

  it("skips the purge at the purge write gate but still calibrates", async () => {
    await setBudget(utcDate(NOW), PURGE_STOP_ROWS);
    await seedMessage(ACCOUNT_A, { providerId: "x-1", expiresAt: NOW - 1 });
    await runNightly(env, { now: NOW });
    expect(await count("messages", "provider_msg_id = 'x-1'")).toBe(1);
    expect(await setting("calibration")).not.toBeNull();
  });

  it("ignores the purge write gate on the paid tier", async () => {
    await setBudget(utcDate(NOW), PURGE_STOP_ROWS);
    await seedMessage(ACCOUNT_A, { providerId: "x-1", expiresAt: NOW - 1 });
    await runNightly({ ...env, FREE_TIER: "false" } as unknown as Env, { now: NOW });
    expect(await count("messages", "provider_msg_id = 'x-1'")).toBe(0);
    expect(await setting("nightly")).toMatchObject({ purgedMessages: 1 });
  });

  it("does nothing while another run holds the nightly lease", async () => {
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES ('nightly', NULL, 'other', ?1, ?2)",
    )
      .bind(NOW, NOW + 10 * MINUTE)
      .run();
    await runNightly(env, { now: NOW });
    expect(await setting("nightly")).toBeNull();
    expect(await setting("calibration")).toBeNull();
    expect(await one("SELECT holder, released_at FROM leases WHERE name = 'nightly'")).toEqual({
      holder: "other",
      released_at: null,
    });
  });

  it("takes over an expired nightly lease", async () => {
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES ('nightly', NULL, 'other', ?1, ?2)",
    )
      .bind(NOW - 20 * MINUTE, NOW - 10 * MINUTE)
      .run();
    await runNightly(env, { now: NOW });
    expect(await setting("nightly")).toMatchObject({ ranAt: NOW });
    const lease = await one<{ holder: string; acquired_at: number; expires_at: number; released_at: number }>(
      "SELECT holder, acquired_at, expires_at, released_at FROM leases WHERE name = 'nightly'",
    );
    expect(lease).toMatchObject({ acquired_at: NOW, expires_at: NOW + 10 * MINUTE, released_at: NOW });
    expect(lease?.holder).not.toBe("other");
  });

  it("deletes old action batches, old budget rows and leases of deleted accounts", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO action_batches (created_at, kind, suggestion_ids_json, requested_count, undo_expires_at) VALUES (?1, 'approve', '[]', 0, ?1), (?2, 'approve', '[]', 0, ?2)",
      ).bind(NOW - 8 * DAY, NOW - DAY),
      env.DB.prepare("INSERT INTO budget (date, rows_written, updated_at) VALUES (?1, 5, 0)").bind(
        utcDate(NOW - 91 * DAY),
      ),
      env.DB.prepare(
        "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at) VALUES ('account:acc_00000000000000ff', 'acc_00000000000000ff', 'h', 0, 1, 1)",
      ),
    ]);
    await runNightly(env, { now: NOW });
    expect(await count("action_batches")).toBe(1);
    expect(await count("budget", "date = ?1", utcDate(NOW - 91 * DAY))).toBe(0);
    expect(await count("leases", "account_id = 'acc_00000000000000ff'")).toBe(0);
  });
});
