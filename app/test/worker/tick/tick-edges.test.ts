import { FakeEngine, POLL_INTERVAL_MS, STORAGE_SOFT_LIMIT_BYTES } from "@clearbox/core";
import type { FetchLike } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppIssue } from "../../../src/shared/api.ts";
import { runTick, runTickInternal } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  DAY,
  MINUTE,
  NOW,
  count,
  getAccount,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
  setBudget,
} from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

const YESTERDAY_ISSUE: AppIssue = {
  code: "storage_near_limit",
  since: new Date(NOW - DAY).toISOString(),
  accountId: null,
};

async function setIssues(issues: AppIssue[]): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('issues', ?1, 0)")
    .bind(JSON.stringify(issues))
    .run();
}

async function issues(): Promise<AppIssue[] | null> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'");
  return row === null ? null : (JSON.parse(row.value) as AppIssue[]);
}

function recordingFetch(urls: string[]): FetchLike {
  return (input, init) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return fetch(input, init);
  };
}

describe("runTick: storage gate edges", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("keeps the raised storage gate when today's size is still unknown (no budget row yet)", async () => {
    await setIssues([YESTERDAY_ISSUE]);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "processed", kind: "incremental", errorCode: null });
    expect(await issues()).toEqual([YESTERDAY_ISSUE]);
    expect((await getAccount(ACCOUNT_A)).backfill_cursor).toBeNull();
  });

  it("treats a zero size as unknown: no raise, no clear, backfill runs while no gate is raised", async () => {
    await setBudget(utcDate(NOW), 10, 0);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "processed", kind: "inbox_backfill", errorCode: null });
    expect(await issues()).toBeNull();
  });

  it("clears the gate once a known size is below the limit", async () => {
    await setIssues([YESTERDAY_ISSUE]);
    await setBudget(utcDate(NOW), 10, STORAGE_SOFT_LIMIT_BYTES - 1);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "processed", kind: "inbox_backfill", errorCode: null });
    expect(await issues()).toEqual([]);
  });

  it("polls a storage-gated backfill account at the incremental interval once caught up", async () => {
    await setBudget(utcDate(NOW), 0, STORAGE_SOFT_LIMIT_BYTES);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({
      outcome: "processed",
      kind: "incremental",
      nextTickAt: new Date(NOW + POLL_INTERVAL_MS).toISOString(),
    });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      phase: "inbox_backfill",
      next_tick_at: NOW + POLL_INTERVAL_MS,
    });
  });

  it("also polls at the interval when the gate is kept from the raised issue", async () => {
    await setIssues([YESTERDAY_ISSUE]);
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect((await getAccount(ACCOUNT_A)).next_tick_at).toBe(NOW + POLL_INTERVAL_MS);
  });
});

describe("runTick: subrequest budget failures at the page size floor", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
  });

  it("backs off normally instead of retrying every minute", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE, pageSize: 5 });
    const report = await runTickInternal(
      env,
      { trigger: "cron", now: NOW, engine: new FakeEngine() },
      { subrequestLimit: 4 },
    );
    expect(report).toMatchObject({ outcome: "error", errorCode: "subrequest_budget" });
    const a = await getAccount(ACCOUNT_A);
    expect(a).toMatchObject({ page_size: 5, attempts: 1, status: "active" });
    expect(a.backoff_until).toBeGreaterThanOrEqual(NOW + MINUTE);
    expect(a.backoff_until).toBeLessThanOrEqual(NOW + MINUTE + 1000);
    expect(report.nextTickAt).toBe(new Date(a.backoff_until ?? 0).toISOString());
  });
});

describe("runTick: the stored page size is clamped to the tier maximum", () => {
  let urls: string[];
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    urls = [];
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 30 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
  });

  it("never lists more than 25 messages on the Free tier after a paid-tier page size of 100", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE, pageSize: 100 });
    const report = await runTick(env, {
      trigger: "cron",
      now: NOW,
      engine: new FakeEngine(),
      fetch: recordingFetch(urls),
    });
    expect(report).toMatchObject({ outcome: "processed", kind: "inbox_backfill", fetched: 25 });
    const list = urls.find((u) => u.includes("/mailFolders/inbox/messages?"));
    expect(new URL(list ?? "https://invalid.example").searchParams.get("$top")).toBe("25");
    expect((await getAccount(ACCOUNT_A)).page_size).toBe(25);
  });

  it("re-decides at most 25 suggestions on the Free tier after a page size of 100", async () => {
    // One real ingest provides valid signals_json for the seeded awaiting_model rows.
    mock.inbox = [mail(0, { listUnsubscribe: true })];
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    const real = await one<{ signals_json: string }>(
      "SELECT signals_json FROM messages WHERE account_id = ?1",
      ACCOUNT_A,
    );
    for (let i = 0; i < 30; i++) {
      await seedMessage(ACCOUNT_A, {
        providerId: `due-${i}`,
        status: "awaiting_model",
        retryAfter: NOW,
        createdAt: NOW - DAY + i,
      });
    }
    await env.DB.prepare("UPDATE messages SET signals_json = ?1 WHERE provider_msg_id LIKE 'due-%'")
      .bind(real?.signals_json ?? "{}")
      .run();
    await env.DB.prepare("UPDATE accounts SET page_size = 100").run();
    const report = await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: new FakeEngine() });
    expect(report).toMatchObject({ errorCode: null, outcome: "processed", kind: "redecide", decided: 25 });
    expect(await count("suggestions", "status = 'awaiting_model'")).toBe(5);
  });
});
