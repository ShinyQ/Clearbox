import {
  AUTO_TRASH_DAILY_CAP,
  DEFAULT_POLICY,
  INGEST_STOP_ROWS,
  ProviderRateLimitError,
} from "@clearbox/core";
import type { Policy, Signals } from "@clearbox/core";
import { makeSignals } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionBatchView, ActivityEntry, Page } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { runNightly } from "../../../src/worker/nightly/nightly.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { expectNoUnhandled, useNetworkOpen } from "../helpers/provider-mock.ts";
import { apiFetch, readJson } from "../helpers/request.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  all,
  count,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
  setBudget,
} from "../helpers/tick-db.ts";

/** Saturday 2026-10-17 02:00 UTC: the nightly cron, not the default reminder day. */
const T = Date.UTC(2026, 9, 17, 2);
/** Sunday 2026-10-18 02:00 UTC: the default reminder day. */
const SUNDAY = T + DAY;
const SENDER = "news@shop.example";

afterEach(expectNoUnhandled);

async function putSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

const setPolicy = (patch: Partial<Policy> = {}) =>
  putSetting("policy", {
    ...DEFAULT_POLICY,
    denylist: [SENDER],
    autoTrash: true,
    weeklyReminder: { enabled: false, weekday: 0 },
    ...patch,
  });

let seq = 0;
/** A pending trash suggestion in the Always OK to trash segment, 10 days old, with the given signals. */
async function seedTrusted(accountId: string, signals: Partial<Signals> = {}): Promise<number> {
  seq += 1;
  const id = await seedMessage(accountId, {
    providerId: `${accountId}-trusted-${seq}`,
    sender: SENDER,
    receivedAt: T - 10 * DAY,
    expiresAt: T + 30 * DAY,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET signals_json = ?2 WHERE id = ?1").bind(
      id,
      JSON.stringify(makeSignals({ senderAddress: SENDER, senderDomain: "shop.example", ...signals })),
    ),
    env.DB.prepare("UPDATE suggestions SET segment = 'rule' WHERE message_id = ?1").bind(id),
  ]);
  return id;
}

const statusOf = async (id: number) =>
  (await one<{ status: string }>("SELECT status FROM suggestions WHERE message_id = ?1", id))?.status;

function autoLogs(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"evt":"auto_trash.done"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("runNightly: auto-trash for trusted senders (contracts 12.11)", () => {
  let fake: FakeProvider;
  const nightly = (now = T, e: Env = env) =>
    runNightly(e, {
      now,
      autoTrash: { providerFactory: fake.factory(), oauth: fakeOAuth().oauth },
      reminder: { providerFactory: fake.factory(), sleep: () => Promise.resolve() },
    });

  beforeEach(async () => {
    await resetDb();
    fake = new FakeProvider();
    await seedTickAccount({ id: ACCOUNT_A, accessExpiresAt: T + 60 * DAY });
    useNetworkOpen();
  });

  it("leaves everything alone while the toggle is off (the default): no call, no log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy({ autoTrash: false });
    const id = await seedTrusted(ACCOUNT_A);
    await nightly();
    expect(fake.calls).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(autoLogs(spy)).toEqual([]);
  });

  it("trashes trusted mail as one Auto-trash batch, undoable for 24 hours, and skips capped mail", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy();
    const ok = [await seedTrusted(ACCOUNT_A), await seedTrusted(ACCOUNT_A)];
    const starred = await seedTrusted(ACCOUNT_A, { starred: true });
    const important = await seedTrusted(ACCOUNT_A, { providerImportant: true });
    await nightly();

    expect(fake.calls.map((c) => [c.method, c.ids.length])).toEqual([["trash", 2]]);
    for (const id of ok) expect(await statusOf(id)).toBe("executed");
    expect([await statusOf(starred), await statusOf(important)]).toEqual(["pending", "pending"]);
    const batch = await one<{ id: number; kind: string; undo_expires_at: number }>(
      "SELECT id, kind, undo_expires_at FROM action_batches",
    );
    expect(batch).toMatchObject({ kind: "auto_trash", undo_expires_at: T + DAY });
    expect(await count("audit_log", "kind = 'auto_trash' AND batch_id = ?1 AND count = 2", batch?.id)).toBe(
      1,
    );
    expect(await count("labels")).toBe(0);
    expect(autoLogs(spy)).toEqual([
      expect.objectContaining({ outcome: "done", rounds: 1, executed: 2, failed: 0, retryLater: 0 }),
    ]);
    // Contracts 9: counts and codes only.
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/shop\.example|owner@/);

    // Activity shows "Auto-trash" with Undo (the batch is undoable for 24 hours).
    const app = createApp({ now: () => T + 60_000 });
    const activity = await readJson<Page<ActivityEntry>>(await apiFetch("/api/activity", {}, { app }));
    expect(activity.items.find((e) => e.kind === "auto_trash")).toMatchObject({
      count: 2,
      batchId: batch?.id,
    });
    const batches = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches", {}, { app }));
    expect(batches.items[0]).toMatchObject({ kind: "auto_trash", undoable: true, byAction: { delete: 2 } });
  });

  it("does nothing when the deployment kill switch is on", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy();
    const id = await seedTrusted(ACCOUNT_A);
    await nightly(T, { ...env, AUTO_TRASH_KILL_SWITCH: "on" } as unknown as Env);
    expect(fake.calls).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(autoLogs(spy)).toEqual([expect.objectContaining({ outcome: "disabled", executed: 0 })]);
  });

  it("never exceeds the daily cap, counting earlier runs of the same UTC day", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy();
    await env.DB.prepare(
      `INSERT INTO action_batches (created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at)
       VALUES (?1, 'auto_trash', '[]', ?2, ?2, 0, ?3)`,
    )
      .bind(T - 60_000, AUTO_TRASH_DAILY_CAP - 2, T + DAY)
      .run();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await seedTrusted(ACCOUNT_A));
    await nightly();
    expect(fake.calls.map((c) => c.ids.length)).toEqual([2]);
    expect(await count("suggestions", "status = 'executed'")).toBe(2);
    expect(autoLogs(spy)).toEqual([expect.objectContaining({ outcome: "cap_reached", executed: 2 })]);

    await nightly(T + 60_000);
    expect(fake.calls).toHaveLength(1);
    expect(autoLogs(spy)[1]).toMatchObject({ outcome: "cap_reached", executed: 0 });
  });

  it("stops the run on a failure and puts the emails back without retrying", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy();
    await seedTickAccount({
      id: ACCOUNT_B,
      provider: "gmail",
      email: "second@example.test",
      accessExpiresAt: T + 60 * DAY,
    });
    const a = await seedTrusted(ACCOUNT_A);
    const b = await seedTrusted(ACCOUNT_B);
    fake.options = {
      failWith: { trash: new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 1000 }) },
    };
    await nightly();
    expect(fake.calls).toHaveLength(1);
    expect([await statusOf(a), await statusOf(b)]).toEqual(["pending", "pending"]);
    expect(await count("action_batches")).toBe(0);
    expect(autoLogs(spy)).toEqual([
      expect.objectContaining({ outcome: "stopped", executed: 0, retryLater: 1 }),
    ]);
  });

  it("works through more than one round of 100", async () => {
    await setPolicy();
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 150)
         INSERT INTO messages (account_id, provider_msg_id, sender, sender_domain, subject, received_at, is_read,
           signals_json, created_at)
         SELECT ?1, 'many-' || i, ?2, 'shop.example', 'Deals', ?3, 0, ?4, ?3 FROM seq`,
      ).bind(
        ACCOUNT_A,
        SENDER,
        T - 10 * DAY,
        JSON.stringify(makeSignals({ senderAddress: SENDER, senderDomain: "shop.example" })),
      ),
      env.DB.prepare(
        `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, ceiling,
           segment, policy_version, created_at, updated_at, expires_at)
         SELECT id, account_id, sender, sender_domain, 'pending', 'delete', 0.9, 'delete', 'rule', 1, ?2, ?2, ?3
         FROM messages WHERE account_id = ?1 AND provider_msg_id LIKE 'many-%'`,
      ).bind(ACCOUNT_A, T - DAY, T + 30 * DAY),
    ]);
    await nightly();
    expect(fake.calls.map((c) => c.ids.length)).toEqual([100, 50]);
    expect(await count("action_batches", "kind = 'auto_trash'")).toBe(2);
  });

  it("skips the run when the day's write budget is near its limit", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await setPolicy();
    const id = await seedTrusted(ACCOUNT_A);
    await setBudget(utcDate(T), INGEST_STOP_ROWS);
    await nightly();
    expect(fake.calls).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(autoLogs(spy)).toEqual([expect.objectContaining({ outcome: "no_budget" })]);
  });

  it("is counted by the weekly reminder, even with nothing left to review", async () => {
    await setPolicy({ weeklyReminder: { enabled: true, weekday: 0 } });
    await seedTrusted(ACCOUNT_A);
    await seedTrusted(ACCOUNT_A);
    await nightly(SUNDAY);
    expect(fake.calls.map((c) => c.method)).toEqual(["trash", "insertInboxNote"]);
    const note = fake.notes[0];
    expect(note?.subject).toBe("Clearbox: 2 emails auto-trashed this week");
    expect(note?.text).toContain(
      "Auto-trash moved 2 emails from your Always OK to trash senders to Trash this week.",
    );
    expect(await all("SELECT key FROM settings WHERE key = 'reminder'")).toHaveLength(1);
  });
});
