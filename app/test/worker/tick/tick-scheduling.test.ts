import { FakeEngine, INGEST_STOP_ROWS, STORAGE_SOFT_LIMIT_BYTES } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick, runTickInternal, selectKind } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  count,
  getAccount,
  graphCursor,
  one,
  resetDb,
  seedTickAccount,
  setBudget,
} from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

describe("selectKind", () => {
  it("prefers due re-decisions, then the sent scan, then interleaves incremental polls with backfill", () => {
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW }, 1, NOW)).toBe("redecide");
    expect(selectKind({ phase: "sent_backfill", last_incremental_at: null }, 0, NOW)).toBe("sent_backfill");
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: null }, 0, NOW)).toBe("incremental");
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW - 31 * MINUTE }, 0, NOW)).toBe(
      "incremental",
    );
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW - MINUTE }, 0, NOW)).toBe(
      "inbox_backfill",
    );
    expect(selectKind({ phase: "incremental", last_incremental_at: NOW }, 0, NOW)).toBe("incremental");
  });
});

describe("runTick: leases, gates and the subrequest budget", () => {
  let mock: ProviderMock;
  let decision: DecisionMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("lets only one of two concurrent ticks claim the account", async () => {
    const reports = await Promise.all([
      runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }),
      runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }),
    ]);
    expect(reports.map((r) => r.outcome).sort()).toEqual(["idle", "processed"]);
    expect(reports.map((r) => r.errorCode)).toEqual([null, null]);
    expect(await count("messages")).toBe(5);
  });

  it("refuses scan-now while another tick holds the lease", async () => {
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'other', ?3, ?4)",
    )
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE)
      .run();
    await expect(
      runTick(env, { trigger: "scan_now", accountId: ACCOUNT_A, now: NOW, engine: new FakeEngine() }),
    ).rejects.toMatchObject({ status: 409, code: "account_busy" });
    expect(await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() })).toMatchObject({
      outcome: "idle",
      errorCode: null,
    });
  });

  it("writes nothing when the daily ingest budget is exhausted and reports the next UTC day", async () => {
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    const before = await getAccount(ACCOUNT_A);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({
      outcome: "idle",
      nextTickAt: "2026-10-16T00:00:00.000Z",
      rowsWritten: 0,
      errorCode: null,
    });
    expect(await getAccount(ACCOUNT_A)).toEqual(before);
    expect(await count("leases")).toBe(0);
    expect(await one("SELECT rows_written, ticks FROM budget WHERE date = ?1", utcDate(NOW))).toEqual({
      rows_written: INGEST_STOP_ROWS,
      ticks: 0,
    });
    await expect(
      runTick(env, { trigger: "scan_now", accountId: ACCOUNT_A, now: NOW, engine: new FakeEngine() }),
    ).rejects.toMatchObject({ status: 429, code: "budget_exhausted" });
  });

  it("decides only what fits in the subrequest budget, keeps the cursor and finishes on the next tick", async () => {
    const first = await runTickInternal(env, { trigger: "cron", now: NOW }, { subrequestLimit: 9 });
    expect(first).toMatchObject({
      outcome: "processed",
      decided: 3,
      nextTickAt: new Date(NOW).toISOString(),
      errorCode: null,
    });
    expect(first.subrequests).toBeLessThanOrEqual(9);
    expect(await count("messages")).toBe(3);
    expect((await getAccount(ACCOUNT_A)).backfill_cursor).toBeNull();
    const second = await runTickInternal(env, { trigger: "cron", now: NOW + MINUTE }, { subrequestLimit: 9 });
    expect(second).toMatchObject({ skippedKnown: 3, decided: 2, errorCode: null });
    expect(second.subrequests).toBeLessThanOrEqual(9);
    expect(await count("messages")).toBe(5);
    expect(decision.calls).toBe(5);
  });

  it("switches backfill to incremental and raises storage_near_limit near the database size limit", async () => {
    await setBudget(utcDate(NOW), 0, STORAGE_SOFT_LIMIT_BYTES);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ kind: "incremental", errorCode: null });
    const issues = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'");
    expect(JSON.parse(issues?.value ?? "[]")).toEqual([
      expect.objectContaining({ code: "storage_near_limit", accountId: null }),
    ]);
  });

  it("fills timings for the benchmark", async () => {
    const timings = { wallMs: 0, ioMs: 0, pureMs: 0 };
    const report = await runTickInternal(
      env,
      { trigger: "cron", now: NOW, engine: new FakeEngine() },
      { timings },
    );
    expect(report).toMatchObject({ outcome: "processed", errorCode: null });
    expect(timings.wallMs).toBeGreaterThan(0);
    expect(timings.ioMs).toBeGreaterThan(0);
    expect(timings.ioMs + timings.pureMs).toBeLessThanOrEqual(timings.wallMs + 1);
  });

  it("measures concurrent Decision-1 calls as the union of their intervals, not their sum", async () => {
    const timings = { wallMs: 0, ioMs: 0, pureMs: 0 };
    const report = await runTickInternal(env, { trigger: "cron", now: NOW }, { timings });
    expect(report).toMatchObject({ outcome: "processed", decided: 5, errorCode: null });
    expect(decision.calls).toBe(5);
    expect(timings.ioMs).toBeGreaterThan(0);
    expect(timings.ioMs).toBeLessThanOrEqual(timings.wallMs + 1);
    expect(timings.ioMs + timings.pureMs).toBeLessThanOrEqual(timings.wallMs + 1);
  });
});

describe("runTick: a partial incremental poll during the backfill", () => {
  let decision: DecisionMock;

  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = Array.from({ length: 30 }, (_, i) => mail(100 + i));
    mock.inboxDelta.set("inbox-1", {
      added: Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true })),
      removed: [],
      next: "inbox-2",
    });
    decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({
      phase: "inbox_backfill",
      lastIncrementalAt: NOW - 31 * MINUTE,
      incrementalCursor: graphCursor("inbox-1", "sent-1", NOW - 31 * MINUTE),
    });
  });

  it("re-reads the rest of the page on the very next tick instead of waiting for the next poll", async () => {
    const first = await runTickInternal(env, { trigger: "cron", now: NOW }, { subrequestLimit: 9 });
    expect(first).toMatchObject({
      outcome: "processed",
      kind: "incremental",
      decided: 2,
      nextTickAt: new Date(NOW).toISOString(),
      errorCode: null,
    });
    const after = await getAccount(ACCOUNT_A);
    expect(after.incremental_cursor).toContain("inbox-1");
    expect(after.last_incremental_at).toBe(NOW - 31 * MINUTE);

    const second = await runTick(env, { trigger: "cron", now: NOW + MINUTE });
    expect(second).toMatchObject({ kind: "incremental", skippedKnown: 2, decided: 3, errorCode: null });
    const done = await getAccount(ACCOUNT_A);
    expect(done.incremental_cursor).toContain("inbox-2");
    expect(done.last_incremental_at).toBe(NOW + MINUTE);
    expect(decision.calls).toBe(5);

    const third = await runTick(env, { trigger: "cron", now: NOW + 2 * MINUTE });
    expect(third).toMatchObject({ kind: "inbox_backfill", errorCode: null });
  });
});
