import { INGEST_STOP_ROWS, LEASE_TTL_MS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimStatements,
  parseClaim,
  parseTickSettings,
  scanNowError,
} from "../../../src/worker/scan/claim.ts";
import type { ClaimParams } from "../../../src/worker/scan/claim.ts";
import { nextUtcMidnight, utcDate } from "../../../src/worker/scan/write-plan.ts";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  MINUTE,
  NOW,
  getAccount,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
  setBudget,
} from "../helpers/tick-db.ts";

async function claim(p: Partial<ClaimParams> = {}) {
  const params: ClaimParams = {
    tickId: crypto.randomUUID(),
    now: NOW,
    accountId: null,
    force: false,
    today: utcDate(NOW),
    stopRows: INGEST_STOP_ROWS,
    ...p,
  };
  const res = await env.DB.batch(claimStatements(params).map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  return { params, claim: parseClaim(res) };
}

describe("claimStatements", () => {
  beforeEach(resetDb);

  it("claims the due account and loads account, settings and budget", async () => {
    await seedTickAccount();
    await setBudget(utcDate(NOW), 10);
    const { params, claim: c } = await claim();
    expect(c.claimedAccountId).toBe(ACCOUNT_A);
    expect(c.account?.id).toBe(ACCOUNT_A);
    expect(c.settings.map((s) => s.key).sort()).toEqual(["policy_version", "tau_delete"]);
    expect(c.budget?.rows_written).toBe(10);
    const lease = await one<{ holder: string; expires_at: number }>(
      "SELECT * FROM leases WHERE name = ?1",
      `account:${ACCOUNT_A}`,
    );
    expect(lease).toMatchObject({ holder: params.tickId, expires_at: NOW + LEASE_TTL_MS });
    expect((await getAccount(ACCOUNT_A)).page_size).toBe(25);
    expect(c.rowsWritten).toBeGreaterThan(0);
  });

  it("does not claim while an unexpired lease is held, and reclaims after expiry or release", async () => {
    await seedTickAccount();
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_A);
    expect((await claim({ now: NOW + MINUTE })).claim.claimedAccountId).toBeNull();
    expect((await claim({ now: NOW + LEASE_TTL_MS })).claim.claimedAccountId).toBe(ACCOUNT_A);
    await env.DB.prepare("UPDATE leases SET released_at = ?1")
      .bind(NOW + LEASE_TTL_MS + 1)
      .run();
    expect((await claim({ now: NOW + LEASE_TTL_MS + 2 })).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("is atomic under two concurrent claims", async () => {
    await seedTickAccount();
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a.claim.claimedAccountId, b.claim.claimedAccountId].filter((x) => x !== null)).toEqual([
      ACCOUNT_A,
    ]);
  });

  it("orders by last_tick_at with never-ticked accounts first", async () => {
    await seedTickAccount({ id: ACCOUNT_A, lastTickAt: NOW - MINUTE });
    await seedTickAccount({ id: ACCOUNT_B, email: "second@example.test", lastTickAt: null });
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_B);
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("skips paused, inactive, backing-off and not-yet-due accounts; force ignores only next_tick_at", async () => {
    await seedTickAccount({ id: ACCOUNT_A, paused: true });
    await seedTickAccount({ id: ACCOUNT_B, email: "b@example.test", nextTickAt: NOW + MINUTE });
    expect((await claim()).claim.claimedAccountId).toBeNull();
    expect((await claim({ accountId: ACCOUNT_B, force: true })).claim.claimedAccountId).toBe(ACCOUNT_B);
    await resetDb();
    await seedTickAccount({ status: "needs_reauth" });
    expect((await claim({ accountId: ACCOUNT_A, force: true })).claim.claimedAccountId).toBeNull();
    await resetDb();
    await seedTickAccount({ backoffUntil: NOW + MINUTE });
    expect((await claim({ accountId: ACCOUNT_A, force: true })).claim.claimedAccountId).toBeNull();
  });

  it("stops claiming at the ingest write gate", async () => {
    await seedTickAccount();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    const gated = await claim();
    expect(gated.claim.claimedAccountId).toBeNull();
    expect(gated.claim.rowsWritten).toBe(0);
    expect((await claim({ stopRows: Number.MAX_SAFE_INTEGER })).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("halves page_size when the previous tick never finished", async () => {
    await seedTickAccount({ tickStartedAt: NOW - 10 * MINUTE, tickFinishedAt: NOW - 20 * MINUTE });
    await claim();
    const a = await getAccount(ACCOUNT_A);
    expect(a.page_size).toBe(12);
  });

  it("counts only due awaiting_model suggestions", async () => {
    await seedTickAccount();
    await seedMessage(ACCOUNT_A, { providerId: "due", status: "awaiting_model", retryAfter: NOW - 1 });
    await seedMessage(ACCOUNT_A, { providerId: "later", status: "awaiting_model", retryAfter: NOW + MINUTE });
    expect((await claim()).claim.awaitingDue).toBe(1);
  });
});

describe("scanNowError", () => {
  beforeEach(resetDb);

  it("maps every pre-claim failure to the 7.5 HTTP errors", async () => {
    let c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({ status: 404, code: "not_found" });

    await seedTickAccount({ paused: true });
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({ status: 409, code: "account_inactive" });

    await env.DB.prepare("UPDATE accounts SET paused = 0").run();
    await claim({ accountId: ACCOUNT_A, force: true });
    c = (await claim({ accountId: ACCOUNT_A, force: true, now: NOW + MINUTE })).claim;
    expect(scanNowError(c, NOW + MINUTE, INGEST_STOP_ROWS)).toMatchObject({
      status: 409,
      code: "account_busy",
    });

    await env.DB.prepare("DELETE FROM leases").run();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    const err = scanNowError(c, NOW, INGEST_STOP_ROWS);
    expect(err).toMatchObject({ status: 429, code: "budget_exhausted" });
    expect(nextUtcMidnight(NOW)).toBe(Date.UTC(2026, 9, 16));
  });

  it("pins the exact code and retryAt of every scan-now error (consumed by the SPA)", async () => {
    const backoff = NOW + 7 * MINUTE;
    await seedTickAccount({ backoffUntil: backoff });
    let c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({
      status: 409,
      code: "account_inactive",
      retryAt: new Date(backoff).toISOString(),
    });

    await resetDb();
    await seedTickAccount({ status: "disconnected" });
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({
      status: 404,
      code: "not_found",
      retryAt: null,
    });

    for (const status of ["needs_reauth", "config_error"] as const) {
      await resetDb();
      await seedTickAccount({ status });
      c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
      expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({
        status: 409,
        code: "account_inactive",
        retryAt: null,
      });
    }

    await resetDb();
    await seedTickAccount();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({
      status: 429,
      code: "budget_exhausted",
      retryAt: new Date(nextUtcMidnight(NOW)).toISOString(),
    });

    await resetDb();
    await seedTickAccount();
    const held = await claim({ accountId: ACCOUNT_A, force: true });
    expect(held.claim.claimedAccountId).toBe(ACCOUNT_A);
    c = (await claim({ accountId: ACCOUNT_A, force: true, now: NOW + MINUTE })).claim;
    expect(scanNowError(c, NOW + MINUTE, INGEST_STOP_ROWS)).toMatchObject({
      status: 409,
      code: "account_busy",
      retryAt: new Date(NOW + LEASE_TTL_MS).toISOString(),
    });
  });
});

describe("parseTickSettings", () => {
  it("falls back to defaults and clamps tau_delete", () => {
    const s = parseTickSettings([
      { key: "tau_delete", value: "1.5" },
      { key: "policy", value: '{"not":"a policy"}' },
      {
        key: "issues",
        value: '[{"code":"storage_near_limit","since":"2026-10-15T00:00:00.000Z","accountId":null}]',
      },
    ]);
    expect(s.tauDelete).toBe(0.99);
    expect(s.policy.minAgeDays).toBe(3);
    expect(s.policyVersion).toBe(1);
    expect(s.issues).toHaveLength(1);
  });
});
