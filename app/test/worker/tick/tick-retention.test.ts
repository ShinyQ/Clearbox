import { FakeEngine } from "@clearbox/core";
import { FakeMailbox, gmailHandlers } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, DAY, MINUTE, NOW, count, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

function tickDone(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const lines = spy.mock.calls.map((c) => String(c[0]));
  const line = lines.find((l) => l.includes('"evt":"tick.done"'));
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("runTick: incremental retention skip", () => {
  beforeEach(resetDb);

  it("Graph: skips a 40-day-old re-reported message and still ingests a fresh one on the same page", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [
        mail(1, { receivedAt: NOW - 40 * DAY, listUnsubscribe: true }),
        mail(2, { receivedAt: NOW - 4 * DAY, listUnsubscribe: true }),
      ],
      removed: [],
      next: "inbox-2",
    });
    const decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "incremental" });

    const report = await runTick(env, { trigger: "cron", now: NOW });

    expect(report).toMatchObject({
      outcome: "processed",
      kind: "incremental",
      fetched: 2,
      skippedKnown: 0,
      decided: 1,
      errorCode: null,
    });
    expect(decision.calls).toBe(1);
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'msg-001'", ACCOUNT_A)).toBe(0);
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'msg-002'", ACCOUNT_A)).toBe(1);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(1);
    expect(tickDone(spy)).toMatchObject({ kind: "incremental", fetched: 2, skippedOld: 1 });
  });

  it("Gmail: skips a history re-report of a 40-day-old message and ingests a fresh one", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const box = new FakeMailbox();
    box.validAccessToken = "g-access-2";
    box.addMessage({ id: "old-1", receivedAt: NOW - 40 * DAY });
    box.addMessage({ id: "fresh-1", receivedAt: NOW - 4 * DAY });
    const mock = new ProviderMock();
    const decision = new DecisionMock();
    useNetwork(gmailHandlers(box), mock.handlers(), decision.handlers());
    await seedTickAccount({ provider: "gmail", phase: "incremental", accessToken: "g-access-2" });

    const report = await runTick(env, { trigger: "cron", now: NOW });

    expect(report).toMatchObject({ outcome: "processed", kind: "incremental", fetched: 2, errorCode: null });
    expect(decision.calls).toBe(1);
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'old-1'", ACCOUNT_A)).toBe(0);
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'fresh-1'", ACCOUNT_A)).toBe(1);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(1);
    expect(tickDone(spy)).toMatchObject({ kind: "incremental", fetched: 2, skippedOld: 1 });
  });

  it("logs skippedOld 0 when nothing is older than the window", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [mail(1, { receivedAt: NOW - 29 * DAY, listUnsubscribe: true })],
      removed: [],
      next: "inbox-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "incremental" });

    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });

    expect(report).toMatchObject({ fetched: 1, decided: 1, errorCode: null });
    expect(tickDone(spy)).toMatchObject({ skippedOld: 0 });
  });

  it("does not apply to inbox backfill: a 40-day-old message is still ingested", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mock = new ProviderMock();
    mock.inbox = [
      mail(1, { receivedAt: NOW - 40 * DAY, listUnsubscribe: true }),
      mail(2, { receivedAt: NOW - 4 * DAY, listUnsubscribe: true }),
    ];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });

    expect(report).toMatchObject({ kind: "inbox_backfill", fetched: 2, decided: 2, errorCode: null });
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'msg-001'", ACCOUNT_A)).toBe(1);
    expect(tickDone(spy)).toMatchObject({ kind: "inbox_backfill", skippedOld: 0 });
  });
});
