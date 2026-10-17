import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueSummary } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { jwksHandler } from "../helpers/access.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import { apiFetch, readJson } from "../helpers/request.ts";
import { DAY, MINUTE, NOW, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

interface Row {
  status: string;
  action: string | null;
  decision_attempts: number;
  retry_after: number | null;
  segment: string | null;
  model_action_json: string | null;
  ceiling: string;
}

const row = (providerId: string) =>
  one<Row>(
    `SELECT s.status, s.action, s.decision_attempts, s.retry_after, s.segment, s.model_action_json, s.ceiling
     FROM suggestions s JOIN messages m ON m.id = s.message_id WHERE m.provider_msg_id = ?1`,
    providerId,
  );

async function setMinAgeDays(days: number): Promise<void> {
  const policy = {
    allowlist: [],
    denylist: [],
    minAgeDays: days,
    storeSnippets: true,
    labelSubjects: true,
    recordPatterns: ["receipt"],
    scanHistoryDays: 90,
  };
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?1, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(policy))
    .run();
}

describe("Leave recent emails alone (contracts 12.10)", () => {
  beforeEach(resetDb);

  it("holds recent mail without a model call, then decides it once it is old enough", async () => {
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [
        mail(1, { receivedAt: NOW - MINUTE, listUnsubscribe: true }),
        mail(2, { receivedAt: NOW - 5 * DAY }),
      ],
      removed: [],
      next: "inbox-2",
    });
    const decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers(), [jwksHandler()]);
    await seedTickAccount({ phase: "incremental" });

    const first = await runTick(env, { trigger: "cron", now: NOW });
    expect(first).toMatchObject({ outcome: "processed", kind: "incremental", decided: 1 });
    expect(decision.calls).toBe(1);
    const held = await row("msg-001");
    expect(held).toMatchObject({ status: "awaiting_model", action: null, decision_attempts: 0 });
    expect(held?.retry_after).toBe(NOW - MINUTE + 3 * DAY);
    // The old one was decided now and keeps the raw model output for later re-fusion.
    const decided = await row("msg-002");
    expect(decided?.status).toBe("pending");
    expect(decided?.model_action_json).not.toBeNull();
    expect(decided?.segment).not.toBeNull();

    const app = createApp({ now: () => NOW });
    const summary = await readJson<QueueSummary>(await apiFetch("/api/queue/summary", {}, { app }));
    expect(summary).toMatchObject({ awaitingModel: 0, recentHeld: 1 });

    const later = NOW + 3 * DAY;
    const second = await runTick(env, { trigger: "cron", now: later });
    expect(second).toMatchObject({ outcome: "processed", kind: "redecide", decided: 1 });
    expect(decision.calls).toBe(2);
    const after = await row("msg-001");
    expect(after).toMatchObject({ status: "pending", decision_attempts: 1 });
    // Decided at age 3 days: no permanent "too recent" Keep cap.
    expect(after?.ceiling).toBe("delete");
  });

  it("holds nothing when the setting is Off", async () => {
    await setMinAgeDays(0);
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [mail(1, { receivedAt: NOW - MINUTE })],
      removed: [],
      next: "inbox-2",
    });
    const decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "incremental" });

    expect(await runTick(env, { trigger: "cron", now: NOW })).toMatchObject({ decided: 1 });
    expect((await row("msg-001"))?.status).toBe("pending");
  });

  it("re-holds a due email that a raised setting makes recent again, without a model call", async () => {
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [mail(1, { receivedAt: NOW - MINUTE })],
      removed: [],
      next: "inbox-2",
    });
    const decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "incremental" });
    await runTick(env, { trigger: "cron", now: NOW });
    expect(decision.calls).toBe(0);

    await setMinAgeDays(7);
    const later = NOW + 3 * DAY;
    expect(await runTick(env, { trigger: "cron", now: later })).toMatchObject({
      kind: "redecide",
      decided: 0,
    });
    expect(decision.calls).toBe(0);
    const held = await row("msg-001");
    expect(held).toMatchObject({ status: "awaiting_model", decision_attempts: 0 });
    expect(held?.retry_after).toBe(NOW - MINUTE + 7 * DAY);
  });
});
