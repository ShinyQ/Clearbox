import { PURGE_STOP_ROWS, createSubrequestCounter } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { batchRunner } from "../../../src/worker/scan/write-plan.ts";
import { newPurgeState, purgeDisconnected, purgeExpired } from "../../../src/worker/nightly/purge.ts";
import type { NightlyRunner } from "../../../src/worker/nightly/purge.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DAY,
  NOW,
  count,
  one,
  resetDb,
  seedExpiredBulk,
  seedLabel,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

const run: NightlyRunner = (counter, stmts) => batchRunner(env.DB)(counter, stmts);

const LIMITS = { startRows: 0, stopRows: PURGE_STOP_ROWS, maxRounds: 16 };
const ACCOUNT_TABLES = [
  "suggestions",
  "messages",
  "labels",
  "sender_priors",
  "senders",
  "correspondents",
  "sent_threads",
];

describe("purgeExpired", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount();
    await seedExpiredBulk(ACCOUNT_A, 600, NOW - DAY);
    await seedMessage(ACCOUNT_A, { providerId: "keep-1", expiresAt: NOW + DAY });
    await seedMessage(ACCOUNT_A, { providerId: "keep-2", expiresAt: NOW + DAY });
  });

  it("deletes expired suggestions and their messages in rounds of 500", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, LIMITS);
    expect(await count("messages")).toBe(2);
    expect(await count("suggestions")).toBe(2);
    expect(state).toMatchObject({ rounds: 2, purgedMessages: 600, stoppedByBudget: false });
    // The local D1 simulator reports one written row per deleted row (no index writes).
    expect(state.rowsWritten).toBeGreaterThanOrEqual(1200);
  });

  it("stops at the round limit", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, { ...LIMITS, maxRounds: 1 });
    expect(await count("messages")).toBe(102);
  });

  it("stops at the purge write gate", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, {
      ...LIMITS,
      startRows: PURGE_STOP_ROWS,
    });
    expect(await count("messages")).toBe(602);
    expect(state.stoppedByBudget).toBe(true);
  });

  it("stops without a round when fewer than 2 subrequests remain", async () => {
    const counter = createSubrequestCounter(43);
    counter.reserve(42);
    const state = newPurgeState();
    await purgeExpired(run, counter, NOW, state, LIMITS);
    expect(await count("messages")).toBe(602);
    expect(state.rounds).toBe(0);
    expect(counter.used).toBe(42);
  });

  it("purges expired rows of every account and keeps unexpired ones", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "other@example.test" });
    await seedExpiredBulk(ACCOUNT_B, 3, NOW - DAY);
    await seedMessage(ACCOUNT_B, { providerId: "b-keep", expiresAt: NOW + DAY });
    await purgeExpired(run, createSubrequestCounter(43), NOW, newPurgeState(), LIMITS);
    expect(await count("messages", "account_id = ?1", ACCOUNT_B)).toBe(1);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(2);
  });

  it("makes no delete call when nothing is expired", async () => {
    await resetDb();
    await seedTickAccount();
    await seedMessage(ACCOUNT_A, { providerId: "keep-1", expiresAt: NOW + DAY });
    const counter = createSubrequestCounter(43);
    const state = newPurgeState();
    await purgeExpired(run, counter, NOW, state, LIMITS);
    expect(counter.used).toBe(1);
    expect(state).toMatchObject({ rounds: 0, purgedMessages: 0 });
    expect(await count("messages")).toBe(1);
  });
});

describe("purgeDisconnected", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
    await seedTickAccount({ id: ACCOUNT_B, email: "gone@example.test", status: "disconnected" });
    for (const id of [ACCOUNT_A, ACCOUNT_B]) {
      await seedMessage(id, { providerId: "m-1" });
      await seedLabel(id, { pDelete: 0.9, margin: 0.8, ownerAction: "delete" });
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at) VALUES (?1, '@shop.example', 1, 0, 0)",
        ).bind(id),
        env.DB.prepare(
          "INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at) VALUES (?1, 'a@shop.example', 'shop.example', 1, 0, 0)",
        ).bind(id),
        env.DB.prepare(
          "INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, 'b@example.net', 0)",
        ).bind(id),
        env.DB.prepare(
          "INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, 't-1', 0)",
        ).bind(id),
        env.DB.prepare(
          "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at) VALUES ('account:' || ?1, ?1, 'h', 0, 1, 1)",
        ).bind(id),
      ]);
    }
  });

  it("deletes every row of a disconnected account, then the account, and leaves other accounts alone", async () => {
    await seedExpiredBulk(ACCOUNT_B, 1200, NOW + DAY);
    const state = newPurgeState();
    await purgeDisconnected(run, createSubrequestCounter(43), [ACCOUNT_B], NOW, state, {
      ...LIMITS,
      maxRounds: 19,
    });
    for (const t of ACCOUNT_TABLES) {
      expect(await count(t, "account_id = ?1", ACCOUNT_B), t).toBe(0);
      expect(await count(t, "account_id = ?1", ACCOUNT_A), t).toBe(1);
    }
    expect(await count("accounts", "id = ?1", ACCOUNT_B)).toBe(0);
    expect(await count("leases", "account_id = ?1", ACCOUNT_B)).toBe(0);
    expect(await one("SELECT kind, account_id FROM audit_log")).toEqual({
      kind: "account_purged",
      account_id: ACCOUNT_B,
    });
    expect(state).toMatchObject({ rounds: 2, purgedAccounts: 1 });
  });

  it("makes no call for an empty account list", async () => {
    const counter = createSubrequestCounter(43);
    const state = newPurgeState();
    await purgeDisconnected(run, counter, [], NOW, state, LIMITS);
    expect(counter.used).toBe(0);
    expect(state).toEqual(newPurgeState());
  });

  it("keeps the account row while rows remain when the round limit stops the purge", async () => {
    await seedExpiredBulk(ACCOUNT_B, 1200, NOW + DAY);
    const state = newPurgeState();
    await purgeDisconnected(run, createSubrequestCounter(43), [ACCOUNT_B], NOW, state, {
      ...LIMITS,
      maxRounds: 1,
    });
    expect(await count("accounts", "id = ?1", ACCOUNT_B)).toBe(1);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_B)).toBe(201);
    expect(state.purgedAccounts).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("never deletes an account that is not disconnected", async () => {
    const state = newPurgeState();
    await purgeDisconnected(run, createSubrequestCounter(43), [ACCOUNT_A], NOW, state, LIMITS);
    expect(await count("accounts", "id = ?1", ACCOUNT_A)).toBe(1);
    expect(state.purgedAccounts).toBe(0);
  });
});
