import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../../src/worker/index.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, MINUTE, NOW, count, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

async function fire(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime: NOW }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled handler", () => {
  let decision: DecisionMock;

  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = [mail(0, { listUnsubscribe: true }), mail(1), mail(2)];
    decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  afterEach(() => {
    expectNoUnhandled();
  });

  it("dispatches the minute cron to runTick: claims the account lease and ingests with Decision 1", async () => {
    await fire("* * * * *");
    expect(await one("SELECT name FROM leases WHERE name = ?1", `account:${ACCOUNT_A}`)).toEqual({
      name: `account:${ACCOUNT_A}`,
    });
    expect(await count("messages")).toBe(3);
    expect(decision.calls).toBe(3);
    expect(await count("suggestions", "model_version LIKE 'decision-1/%'")).toBe(3);
    expect(await count("settings", "key = 'nightly'")).toBe(0);
    expect(await count("leases", "name = 'nightly'")).toBe(0);
  });

  it("dispatches the 02:00 cron to runNightly: writes the nightly lease and summary, no tick", async () => {
    await fire("0 2 * * *");
    expect(await one("SELECT key FROM settings WHERE key = 'nightly'")).toEqual({ key: "nightly" });
    expect(await count("leases", "name = 'nightly' AND released_at IS NOT NULL")).toBe(1);
    expect(await count("leases", "name LIKE 'account:%'")).toBe(0);
    expect(await count("messages")).toBe(0);
    expect(decision.calls).toBe(0);
  });

  it("ignores any other cron", async () => {
    await fire("*/5 * * * *");
    expect(await count("messages")).toBe(0);
    expect(await count("leases")).toBe(0);
    expect(await count("settings", "key = 'nightly'")).toBe(0);
  });
});
