import { FakeEngine } from "@clearbox/core";
import { FakeMailbox, gmailHandlers } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  OWNER,
  count,
  getAccount,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

const INBOX_FOLDER = "GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox";

afterEach(expectNoUnhandled);

describe("runTick: inbox backfill", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 30 }, (_, i) => mail(i, { listUnsubscribe: i % 2 === 0 }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("ingests one page, writes suggestions and counters, advances the cursor and records the budget", async () => {
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({
      outcome: "processed",
      accountId: ACCOUNT_A,
      kind: "inbox_backfill",
      phase: "inbox_backfill",
      fetched: 25,
      skippedKnown: 0,
      decided: 25,
      deferred: 0,
      errorCode: null,
      nextTickAt: new Date(NOW).toISOString(),
    });
    expect(report.subrequests).toBeGreaterThanOrEqual(5);
    expect(report.subrequests).toBeLessThanOrEqual(45);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1 AND status = 'pending'", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1 AND action = 'delete'", ACCOUNT_A)).toBe(13);
    expect(await one("SELECT SUM(seen_count) AS n FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      n: 25,
    });
    const account = await getAccount(ACCOUNT_A);
    expect(account).toMatchObject({
      last_tick_at: NOW,
      next_tick_at: NOW,
      messages_ingested: 25,
      attempts: 0,
      inbox_estimate: 30,
    });
    expect(account.backfill_cursor).not.toBeNull();
    expect(await one("SELECT released_at FROM leases WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      released_at: NOW,
    });
    expect(
      await one("SELECT ticks, messages_ingested, rows_written FROM budget WHERE date = ?1", utcDate(NOW)),
    ).toEqual({ ticks: 1, messages_ingested: 25, rows_written: report.rowsWritten });
  });

  it("finishes the backfill on later ticks and refreshes the inbox estimate at most once per UTC day", async () => {
    expect(
      (await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() })).errorCode,
    ).toBeNull();
    for (let t = 1; t <= 4 && (await getAccount(ACCOUNT_A)).phase !== "incremental"; t++) {
      const report = await runTick(env, { trigger: "cron", now: NOW + t * MINUTE, engine: new FakeEngine() });
      expect(report.errorCode).toBeNull();
    }
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(30);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "incremental", backfill_done: 1 });
    expect(mock.calls.filter((c) => c === INBOX_FOLDER)).toHaveLength(1);
  });

  it("is idempotent: re-reading the same page writes no duplicate rows", async () => {
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    await env.DB.prepare("UPDATE accounts SET backfill_cursor = NULL WHERE id = ?1").bind(ACCOUNT_A).run();
    const again = await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: new FakeEngine() });
    expect(again).toMatchObject({ fetched: 25, skippedKnown: 25, decided: 0, errorCode: null });
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await one("SELECT SUM(seen_count) AS n FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      n: 25,
    });
  });

  it("returns idle and writes nothing when the configuration is invalid", async () => {
    const before = await getAccount(ACCOUNT_A);
    const report = await runTick(
      { ...env, TOKEN_ENC_KEY: "" },
      { trigger: "cron", now: NOW, engine: new FakeEngine() },
    );
    expect(report).toMatchObject({ outcome: "idle", errorCode: null });
    expect(await getAccount(ACCOUNT_A)).toEqual(before);
    expect(await count("leases")).toBe(0);
  });
});

describe("runTick: sent backfill", () => {
  beforeEach(resetDb);

  it("builds correspondents and replied threads, then moves to inbox backfill", async () => {
    const mock = new ProviderMock();
    mock.inboxTotal = 1234;
    mock.sent = Array.from({ length: 150 }, (_, i) => ({
      conversationId: `conv-s-${i}`,
      to: [`friend${i % 40}@example.net`, OWNER],
      sentAt: NOW - (i + 1) * MINUTE,
    }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "sent_backfill", lastIncrementalAt: null });
    const first = await runTick(env, { trigger: "cron", now: NOW });
    expect(first).toMatchObject({
      outcome: "processed",
      kind: "sent_backfill",
      fetched: 100,
      decided: 0,
      errorCode: null,
    });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "sent_backfill",
      sent_scanned: 100,
      inbox_estimate: 1234,
    });
    expect(await count("correspondents", "account_id = ?1", ACCOUNT_A)).toBe(40);
    expect(await count("correspondents", "address = ?1", OWNER)).toBe(0);
    const second = await runTick(env, { trigger: "cron", now: NOW + MINUTE });
    expect(second).toMatchObject({ fetched: 50, errorCode: null });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "inbox_backfill", sent_scanned: 150 });
    expect(await count("sent_threads", "account_id = ?1", ACCOUNT_A)).toBe(150);
    expect(await count("suggestions")).toBe(0);
  });

  it("restarts from the newest sent mail when the stored next link points at a lookalike host", async () => {
    const mock = new ProviderMock();
    mock.sent = Array.from({ length: 30 }, (_, i) => ({
      conversationId: `conv-s-${i}`,
      to: [`friend${i % 5}@example.net`],
      sentAt: NOW - (i + 1) * MINUTE,
    }));
    useNetwork(mock.handlers());
    const lookalike =
      "https://graph.microsoft.com.example.net/v1.0/me/mailFolders/sentitems/messages?$skip=100";
    await seedTickAccount({
      phase: "sent_backfill",
      lastIncrementalAt: null,
      sentCursor: JSON.stringify({ v: 1, nextLink: lookalike }),
    });
    const report = await runTick(env, { trigger: "cron", now: NOW });
    expect(report).toMatchObject({
      outcome: "processed",
      kind: "sent_backfill",
      fetched: 30,
      errorCode: null,
    });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "inbox_backfill", sent_scanned: 30 });
    expect(mock.calls.some((c) => c.includes("example.net"))).toBe(false);
  });
});

describe("runTick: Gmail metadata worst case", () => {
  beforeEach(resetDb);

  it("still writes a full page when one metadata chunk needs three batch POSTs and a token refresh", async () => {
    const box = new FakeMailbox();
    box.validAccessToken = "g-access-2";
    for (let i = 0; i < 25; i++) box.addMessage();
    // Attempt 1: every part 503 (retried); attempt 2: every part 401 (refresh, one more attempt); attempt 3: ok.
    const metadataPart = /^\/gmail\/v1\/users\/me\/messages\/[^/]+$/;
    box.failNext({ method: "GET", path: metadataPart, status: 503, times: 25 });
    box.failNext({ method: "GET", path: metadataPart, status: 401, times: 25 });
    const mock = new ProviderMock();
    const decision = new DecisionMock();
    useNetwork(gmailHandlers(box), mock.handlers(), decision.handlers());
    await seedTickAccount({
      provider: "gmail",
      phase: "inbox_backfill",
      accessToken: "g-access-2",
      lastIncrementalAt: NOW - MINUTE,
    });

    const report = await runTick(env, { trigger: "cron", now: NOW });

    expect(report).toMatchObject({
      outcome: "processed",
      kind: "inbox_backfill",
      fetched: 25,
      decided: 25,
      deferred: 0,
      errorCode: null,
    });
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(3);
    expect(mock.calls.filter((c) => c === "POST https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect(decision.calls).toBe(25);
    // claim 1, estimate 1, list 1, batch 3, refresh 1, context 1, Decision-1 25, final write 1, budget 1.
    expect(report.subrequests).toBe(35);
    expect(report.subrequests).toBeLessThanOrEqual(45);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1 AND status = 'pending'", ACCOUNT_A)).toBe(25);
  });
});
