import { FakeEngine } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick, runTickInternal } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  count,
  decryptAccountToken,
  getAccount,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

async function issueCodes(): Promise<string[]> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'");
  return (JSON.parse(row?.value ?? "[]") as { code: string }[]).map((i) => i.code);
}

afterEach(expectNoUnhandled);

describe("runTick: failures", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
  });

  it("backs off for the provider's Retry-After and retries after it", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    mock.failNext({
      method: "GET",
      pathIncludes: "/inbox/messages",
      status: 429,
      headers: { "Retry-After": "120" },
      body: { error: { code: "TooManyRequests", message: "Please retry again later." } },
    });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "error", nextTickAt: new Date(NOW + 120_000).toISOString() });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      status: "active",
      attempts: 1,
      backoff_until: NOW + 120_000,
    });
    expect((await getAccount(ACCOUNT_A)).last_error).not.toBeNull();
    expect(await count("messages")).toBe(0);
    expect(await one("SELECT released_at FROM leases WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      released_at: NOW,
    });
    expect(await one("SELECT ticks FROM budget WHERE date = ?1", utcDate(NOW))).toEqual({ ticks: 1 });
    expect(
      (await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: new FakeEngine() })).outcome,
    ).toBe("idle");
    const retried = await runTick(env, { trigger: "cron", now: NOW + 121_000, engine: new FakeEngine() });
    expect(retried.outcome).toBe("processed");
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ attempts: 0, backoff_until: null, last_error: null });
  });

  it("marks a Gmail account needs_reauth on invalid_grant and stops ticking it", async () => {
    await seedTickAccount({
      provider: "gmail",
      accessToken: null,
      phase: "inbox_backfill",
      lastIncrementalAt: NOW - MINUTE,
    });
    mock.googleToken = {
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    };
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "error", nextTickAt: null });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      status: "needs_reauth",
      status_reason: "invalid_grant",
      attempts: 1,
    });
    expect(await one("SELECT kind FROM audit_log WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      kind: "reauth_required",
    });
    expect(
      (await runTick(env, { trigger: "cron", now: NOW + 7 * 60 * MINUTE, engine: new FakeEngine() })).outcome,
    ).toBe("idle");
  });

  it("marks an Outlook account config_error on an expired client secret and raises an app issue", async () => {
    await seedTickAccount({
      provider: "outlook",
      accessToken: null,
      phase: "inbox_backfill",
      lastIncrementalAt: NOW - MINUTE,
    });
    mock.microsoftToken = {
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "AADSTS7000222: The provided client secret keys are expired.",
      },
    };
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ status: "config_error" });
    expect(await issueCodes()).toContain("microsoft_client_invalid");
    expect(await one("SELECT kind FROM audit_log WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      kind: "config_error",
    });
  });

  it("persists a rotated Microsoft refresh token even when the page fetch then fails", async () => {
    await seedTickAccount({
      provider: "outlook",
      accessToken: null,
      phase: "inbox_backfill",
      lastIncrementalAt: NOW - MINUTE,
    });
    mock.failNext({ method: "GET", pathIncludes: "/inbox/messages", status: 503, times: 2 });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report.outcome).toBe("error");
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("ms-refresh-2");
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("ms-access-2");
    expect((await getAccount(ACCOUNT_A)).status).toBe("active");
  });

  it("aborts without ingesting when most Decision-1 calls fail transiently", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const err = decisionError("server", 503, true, "item");
    const engine = new FakeEngine({ overrides: new Map(mock.inbox.map((m) => [m.id, err])) });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine });
    expect(report).toMatchObject({ outcome: "error", errorCode: "decision_outage" });
    expect(await count("messages")).toBe(0);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ attempts: 1, backfill_cursor: null });
    expect((await getAccount(ACCOUNT_A)).backoff_until).toBeGreaterThan(NOW);
  });

  it("raises decision_auth_failed on a Decision-1 configuration error and ingests nothing", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const engine = new FakeEngine({
      overrides: new Map([["msg-000", decisionError("auth", 401, false, "config")]]),
    });
    expect((await runTick(env, { trigger: "cron", now: NOW, engine })).outcome).toBe("error");
    expect(await count("messages")).toBe(0);
    expect(await issueCodes()).toContain("decision_auth_failed");
  });

  it("raises decision_not_configured without Decision secrets, still scans sent mail, and clears the issue once decisions work", async () => {
    const noDecision = { ...env, AZURE_DECISION_KEY: "" };
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    expect(await runTick(noDecision, { trigger: "cron", now: NOW })).toMatchObject({
      outcome: "error",
      errorCode: "decision_not_configured",
    });
    expect(await issueCodes()).toContain("decision_not_configured");
    // Retry as soon as the backoff ends: still an inbox_backfill tick, so Decision-1 runs and the issue clears.
    const retryAt = (await getAccount(ACCOUNT_A)).backoff_until ?? NOW;
    expect(retryAt).toBeLessThan(NOW + 2 * MINUTE);
    const retried = await runTick(env, { trigger: "cron", now: retryAt, engine: new FakeEngine() });
    expect(retried.decided).toBeGreaterThan(0);
    expect(retried.outcome).toBe("processed");
    expect(await issueCodes()).not.toContain("decision_not_configured");

    await resetDb();
    mock.sent = [{ conversationId: "c-1", to: ["friend@example.net"], sentAt: NOW - MINUTE }];
    await seedTickAccount({ phase: "sent_backfill", lastIncrementalAt: null });
    expect((await runTick(noDecision, { trigger: "cron", now: NOW })).outcome).toBe("processed");
  });

  it("halves the page without backoff when the subrequest budget runs out mid-tick", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const report = await runTickInternal(
      env,
      { trigger: "cron", now: NOW, engine: new FakeEngine() },
      { subrequestLimit: 4 },
    );
    expect(report).toMatchObject({ outcome: "error", errorCode: "subrequest_budget" });
    expect(report.subrequests).toBeLessThanOrEqual(4);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ page_size: 12, backoff_until: null, attempts: 1 });
  });
});
