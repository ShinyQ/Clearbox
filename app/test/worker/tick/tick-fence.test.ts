import { FakeEngine, LEASE_TTL_MS } from "@clearbox/core";
import type { FetchLike } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  all,
  getAccount,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

const SENDER = "sender0@shop0.example";
const LATE = NOW + LEASE_TTL_MS + MINUTE;

/**
 * Simulates a stalled tick: before its first provider call, its lease expires and a newer tick claims the
 * account, so every later write of the stalled tick must be fenced out.
 */
function takeoverFetch(): FetchLike {
  let taken = false;
  return async (input, init) => {
    if (!taken) {
      taken = true;
      await env.DB.prepare(
        `UPDATE leases SET holder = 'newer-tick', acquired_at = ?2, expires_at = ?3, released_at = NULL
         WHERE name = 'account:' || ?1`,
      )
        .bind(ACCOUNT_A, LATE, LATE + LEASE_TTL_MS)
        .run();
    }
    return fetch(input, init);
  };
}

async function seedSender(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at)
     VALUES (?1, ?2, 'shop0.example', 7, 2, ?3)`,
  )
    .bind(ACCOUNT_A, SENDER, NOW - 30 * 86_400_000)
    .run();
}

describe("runTick: writes after a lost lease are fenced", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    await seedSender();
  });

  it("commits no account update and no sender count change on the success path", async () => {
    const before = await getAccount(ACCOUNT_A);
    const report = await runTick(env, {
      trigger: "cron",
      now: NOW,
      engine: new FakeEngine(),
      fetch: takeoverFetch(),
    });
    expect(report.outcome).toBe("processed");
    const after = await getAccount(ACCOUNT_A);
    expect(after).toMatchObject({
      phase: "inbox_backfill",
      backfill_done: 0,
      backfill_cursor: null,
      incremental_cursor: before.incremental_cursor,
      last_incremental_at: before.last_incremental_at,
      messages_ingested: 0,
      last_tick_at: null,
      next_tick_at: before.next_tick_at,
      page_size: 25,
    });
    expect(
      await all("SELECT address, seen_count, read_count FROM senders WHERE account_id = ?1", ACCOUNT_A),
    ).toEqual([{ address: SENDER, seen_count: 7, read_count: 2 }]);
    expect(await one("SELECT holder, released_at FROM leases WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      holder: "newer-tick",
      released_at: null,
    });
  });

  it("commits no account update on the failure path", async () => {
    mock.failNext({
      method: "GET",
      pathIncludes: "/inbox/messages",
      status: 429,
      headers: { "Retry-After": "120" },
      body: { error: { code: "TooManyRequests", message: "Please retry again later." } },
    });
    const report = await runTick(env, {
      trigger: "cron",
      now: NOW,
      engine: new FakeEngine(),
      fetch: takeoverFetch(),
    });
    expect(report.outcome).toBe("error");
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      status: "active",
      attempts: 0,
      backoff_until: null,
      last_error: null,
      last_tick_at: null,
      page_size: 25,
    });
    expect(await all("SELECT seen_count FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual([
      { seen_count: 7 },
    ]);
  });

  it("still commits while the tick holds its lease", async () => {
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report.outcome).toBe("processed");
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ messages_ingested: 5, last_tick_at: NOW });
    expect(
      await one("SELECT seen_count FROM senders WHERE account_id = ?1 AND address = ?2", ACCOUNT_A, SENDER),
    ).toEqual({ seen_count: 9 });
  });
});
