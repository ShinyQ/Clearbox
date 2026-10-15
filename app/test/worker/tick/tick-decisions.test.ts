import { FakeEngine } from "@clearbox/core";
import type { DecisionError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  DAY,
  MINUTE,
  NOW,
  getAccount,
  graphCursor,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

const RETRYABLE = decisionError("server", 503, true, "item");

function engine(failing: Record<string, DecisionError> = {}): FakeEngine {
  return new FakeEngine({ overrides: new Map(Object.entries(failing)) });
}

async function suggestion(providerId: string) {
  return one<{
    status: string;
    action: string | null;
    decision_attempts: number;
    retry_after: number | null;
    reasons_json: string;
  }>(
    `SELECT s.status, s.action, s.decision_attempts, s.retry_after, s.reasons_json
     FROM suggestions s JOIN messages m ON m.id = s.message_id
     WHERE m.account_id = ?1 AND m.provider_msg_id = ?2`,
    ACCOUNT_A,
    providerId,
  );
}

afterEach(expectNoUnhandled);

describe("runTick: Decision-1 outcomes", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true })),
      removed: [],
      next: "inbox-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({
      phase: "incremental",
      incrementalCursor: graphCursor("inbox-1", "sent-1", NOW - DAY),
    });
  });

  it("defers an isolated transient failure, schedules the retry and re-decides it 5 minutes later", async () => {
    const first = await runTick(env, { trigger: "cron", now: NOW, engine: engine({ "msg-002": RETRYABLE }) });
    expect(first).toMatchObject({ kind: "incremental", decided: 4, deferred: 1, errorCode: null });
    expect(await suggestion("msg-002")).toMatchObject({
      status: "awaiting_model",
      decision_attempts: 1,
      retry_after: NOW + 5 * MINUTE,
    });
    // Caught up would mean a 30-minute poll; the pending retry pulls the next tick forward (C7).
    expect((await getAccount(ACCOUNT_A)).next_tick_at).toBe(NOW + 5 * MINUTE);
    expect(await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: engine() })).toMatchObject({
      outcome: "idle",
      errorCode: null,
    });

    const redecide = await runTick(env, { trigger: "cron", now: NOW + 5 * MINUTE, engine: engine() });
    expect(redecide).toMatchObject({
      kind: "redecide",
      decided: 1,
      deferred: 0,
      fetched: 0,
      errorCode: null,
    });
    expect(await suggestion("msg-002")).toMatchObject({
      status: "pending",
      decision_attempts: 2,
      retry_after: null,
    });
  });

  it("falls back to unsure after three failed attempts", async () => {
    const failing = engine({ "msg-002": RETRYABLE });
    expect((await runTick(env, { trigger: "cron", now: NOW, engine: failing })).errorCode).toBeNull();
    expect(
      (await runTick(env, { trigger: "cron", now: NOW + 5 * MINUTE, engine: failing })).errorCode,
    ).toBeNull();
    expect(await suggestion("msg-002")).toMatchObject({
      status: "awaiting_model",
      decision_attempts: 2,
      retry_after: NOW + 35 * MINUTE,
    });
    const last = await runTick(env, { trigger: "cron", now: NOW + 35 * MINUTE, engine: failing });
    expect(last).toMatchObject({ kind: "redecide", unsure: 1, errorCode: null });
    const row = await suggestion("msg-002");
    expect(row).toMatchObject({ status: "pending", action: "unsure", decision_attempts: 3 });
    expect(row?.reasons_json).toContain("model_unavailable");
  });

  it("stores a non-retryable item failure as unsure right away", async () => {
    const report = await runTick(env, {
      trigger: "cron",
      now: NOW,
      engine: engine({ "msg-003": decisionError("unprocessable", 422, false, "item") }),
    });
    expect(report).toMatchObject({ decided: 4, deferred: 0, errorCode: null });
    expect(report.unsure).toBeGreaterThanOrEqual(1);
    expect(await suggestion("msg-003")).toMatchObject({
      status: "pending",
      action: "unsure",
      decision_attempts: 1,
    });
  });
});
