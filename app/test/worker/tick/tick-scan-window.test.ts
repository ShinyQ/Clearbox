import { DEFAULT_POLICY, FakeEngine } from "@clearbox/core";
import type { Policy } from "@clearbox/core";
import { FakeMailbox, gmailHandlers } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsResponse, PolicyResponse } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import {
  ProviderMock,
  expectNoUnhandled,
  mail,
  useNetwork,
  useNetworkOpen,
} from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  MINUTE,
  NOW,
  count,
  getAccount,
  resetDb,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

async function storePolicy(scanHistoryDays: Policy["scanHistoryDays"]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify({ ...DEFAULT_POLICY, scanHistoryDays }))
    .run();
}

function tickDone(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"evt":"tick.done"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const tick = (now: number) => runTick(env, { trigger: "cron", now, engine: new FakeEngine() });

describe("runTick: scan history window (rev 2.4)", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
  });

  it("skips backfill mail older than the window and ends the backfill at the window edge", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await storePolicy(30);
    mock.inbox = [
      ...Array.from({ length: 10 }, (_, i) => mail(i, { receivedAt: NOW - 5 * DAY - i * MINUTE })),
      ...Array.from({ length: 10 }, (_, i) => mail(100 + i, { receivedAt: NOW - 40 * DAY - i * MINUTE })),
    ];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    const report = await tick(NOW);

    expect(report).toMatchObject({ kind: "inbox_backfill", phase: "incremental", fetched: 20, decided: 10 });
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(10);
    expect(await count("messages", "account_id = ?1 AND received_at < ?2", ACCOUNT_A, NOW - 30 * DAY)).toBe(
      0,
    );
    // Stopped at the edge, not at the end of the inbox: backfill_done stays 0 and the cursor stays at the page start.
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "incremental",
      backfill_done: 0,
      backfill_cursor: null,
      next_tick_at: NOW,
    });
    expect(tickDone(spy)[0]).toMatchObject({ kind: "inbox_backfill", fetched: 20, skippedOld: 10 });
  });

  it("keeps the cursor of the edge page, then resumes from it when the window widens", async () => {
    await storePolicy(30);
    mock.inbox = [
      ...Array.from({ length: 30 }, (_, i) => mail(i, { receivedAt: NOW - 5 * DAY - i * MINUTE })),
      ...Array.from({ length: 30 }, (_, i) => mail(100 + i, { receivedAt: NOW - 40 * DAY - i * MINUTE })),
    ];
    useNetworkOpen(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", pageSize: 25, lastIncrementalAt: NOW - MINUTE });

    expect(await tick(NOW)).toMatchObject({ kind: "inbox_backfill", phase: "inbox_backfill", decided: 25 });
    const pageTwoCursor = (await getAccount(ACCOUNT_A)).backfill_cursor;
    expect(pageTwoCursor).not.toBeNull();

    const edge = await tick(NOW + MINUTE);
    expect(edge).toMatchObject({ kind: "inbox_backfill", phase: "incremental", decided: 5 });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "incremental",
      backfill_done: 0,
      backfill_cursor: pageTwoCursor,
    });
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(30);

    // Widening the window through the API moves the account back to inbox_backfill without touching the cursor.
    const app = createApp({ now: () => NOW + 2 * MINUTE });
    const current = await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }));
    const put = await apiFetch(
      "/api/policy",
      jsonInit("PUT", {
        policy: { ...current.policy, scanHistoryDays: 90 },
        expectedVersion: current.version,
      }),
      { app },
    );
    expect(put.status).toBe(200);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "inbox_backfill",
      backfill_done: 0,
      backfill_cursor: pageTwoCursor,
    });

    // The edge page is re-read (its 5 in-window items are known), then the backfill runs to the end of the inbox.
    expect(await tick(NOW + 3 * MINUTE)).toMatchObject({
      kind: "inbox_backfill",
      skippedKnown: 5,
      decided: 20,
    });
    expect(await tick(NOW + 4 * MINUTE)).toMatchObject({
      kind: "inbox_backfill",
      phase: "incremental",
      decided: 10,
    });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "incremental",
      backfill_done: 1,
      backfill_cursor: null,
    });
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(60);
  });

  it("defaults to 90 days when the stored policy has no scanHistoryDays", async () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_POLICY };
    delete legacy["scanHistoryDays"];
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?1, 0)")
      .bind(JSON.stringify(legacy))
      .run();
    mock.inbox = [
      mail(1, { receivedAt: NOW - 80 * DAY }),
      mail(2, { receivedAt: NOW - 89 * DAY }),
      mail(3, { receivedAt: NOW - 100 * DAY }),
    ];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    expect(await tick(NOW)).toMatchObject({ phase: "incremental", fetched: 3, decided: 2 });
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'msg-003'", ACCOUNT_A)).toBe(0);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ backfill_done: 0 });
  });

  it("also defaults to 90 days when no policy is stored at all", async () => {
    mock.inbox = [mail(1, { receivedAt: NOW - 10 * DAY }), mail(2, { receivedAt: NOW - 91 * DAY })];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    expect(await tick(NOW)).toMatchObject({ phase: "incremental", fetched: 2, decided: 1 });
  });

  it("scans everything with All mail (null) and finishes with backfill_done = 1", async () => {
    await storePolicy(null);
    mock.inbox = [mail(1, { receivedAt: NOW - 4 * DAY }), mail(2, { receivedAt: NOW - 3000 * DAY })];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    expect(await tick(NOW)).toMatchObject({ phase: "incremental", fetched: 2, decided: 2 });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ backfill_done: 1 });
  });

  it("Gmail: stops at the window edge and keeps the page cursor", async () => {
    await storePolicy(30);
    const box = new FakeMailbox();
    box.validAccessToken = "g-access-2";
    for (let i = 0; i < 4; i++) box.addMessage({ id: `new-${i}`, receivedAt: NOW - (i + 4) * DAY });
    for (let i = 0; i < 4; i++) box.addMessage({ id: `old-${i}`, receivedAt: NOW - (40 + i) * DAY });
    useNetwork(gmailHandlers(box), mock.handlers());
    await seedTickAccount({
      provider: "gmail",
      phase: "inbox_backfill",
      accessToken: "g-access-2",
      lastIncrementalAt: NOW - MINUTE,
    });

    expect(await tick(NOW)).toMatchObject({
      kind: "inbox_backfill",
      phase: "incremental",
      fetched: 8,
      decided: 4,
    });
    expect(await count("messages", "account_id = ?1 AND provider_msg_id LIKE 'old-%'", ACCOUNT_A)).toBe(0);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "incremental", backfill_done: 0 });
  });

  it("leaves incremental sync unaffected: new mail is scanned after an edge stop", async () => {
    await storePolicy(30);
    mock.inboxDelta.set("inbox-1", {
      added: [mail(1, { receivedAt: NOW - 29 * DAY }), mail(2, { receivedAt: NOW - 4 * DAY })],
      removed: [],
      next: "inbox-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "incremental", backfillCursor: "edge-cursor" });
    await env.DB.prepare("UPDATE accounts SET backfill_done = 0 WHERE id = ?1").bind(ACCOUNT_A).run();

    expect(await tick(NOW)).toMatchObject({
      kind: "incremental",
      phase: "incremental",
      fetched: 2,
      decided: 2,
    });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "incremental",
      backfill_done: 0,
      backfill_cursor: "edge-cursor",
    });
  });
});

describe("PUT /api/policy: scan history window changes (rev 2.4)", () => {
  beforeEach(async () => {
    await resetDb();
    useNetworkOpen();
  });

  const app = createApp({ now: () => NOW });

  async function put(scanHistoryDays: unknown): Promise<Response> {
    const current = await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }));
    return apiFetch(
      "/api/policy",
      jsonInit("PUT", { policy: { ...current.policy, scanHistoryDays }, expectedVersion: current.version }),
      { app },
    );
  }

  async function seedEdgeStopped(id: string, nextTickAt: number): Promise<void> {
    await seedTickAccount({
      id,
      email: `${id}@example.test`,
      phase: "incremental",
      backfillCursor: "c",
      nextTickAt,
    });
    await env.DB.prepare("UPDATE accounts SET backfill_done = 0 WHERE id = ?1").bind(id).run();
  }

  it("rejects values other than 30, 90, 365 or null", async () => {
    for (const bad of [0, 60, "90", 3650]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await put(365)).status).toBe(200);
    expect((await put(null)).status).toBe(200);
  });

  it("resumes only edge-stopped accounts when widening; narrowing changes no account and keeps suggestions", async () => {
    await seedEdgeStopped(ACCOUNT_A, NOW + 30 * MINUTE);
    await seedTickAccount({ id: ACCOUNT_B, email: "full@example.test", phase: "incremental" });
    await env.DB.prepare("UPDATE accounts SET backfill_done = 1 WHERE id = ?1").bind(ACCOUNT_B).run();
    await seedMessage(ACCOUNT_A, { providerId: "old-pending", receivedAt: NOW - 200 * DAY });

    expect((await put(30)).status).toBe(200);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "incremental",
      next_tick_at: NOW + 30 * MINUTE,
    });
    expect(await count("suggestions", "account_id = ?1 AND status = 'pending'", ACCOUNT_A)).toBe(1);

    expect((await put(365)).status).toBe(200);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "inbox_backfill",
      backfill_cursor: "c",
      next_tick_at: NOW,
    });
    expect(await getAccount(ACCOUNT_B)).toMatchObject({ phase: "incremental", backfill_done: 1 });
  });

  it("does not resume anything when the write loses the version race", async () => {
    await seedEdgeStopped(ACCOUNT_A, NOW + 30 * MINUTE);
    const res = await apiFetch(
      "/api/policy",
      jsonInit("PUT", { policy: { ...DEFAULT_POLICY, scanHistoryDays: null }, expectedVersion: 7 }),
      { app },
    );
    expect(res.status).toBe(409);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "incremental" });
  });

  it("reports the window and a finished backfill for an edge-stopped account", async () => {
    await seedEdgeStopped(ACCOUNT_A, NOW);
    const body = await readJson<AccountsResponse>(await apiFetch("/api/accounts", {}, { app }));
    expect(body.accounts[0]?.sync).toMatchObject({
      phase: "incremental",
      backfillDone: true,
      scanHistoryDays: 90,
    });
  });
});
