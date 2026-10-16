import { INGEST_STOP_ROWS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, TickReport } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { nextUtcMidnight, utcDate } from "../../../src/worker/scan/write-plan.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetworkOpen } from "../helpers/provider-mock.ts";
import { apiFetch } from "../helpers/request.ts";
import { ACCOUNT_A, MINUTE, NOW, count, resetDb, seedTickAccount, setBudget } from "../helpers/tick-db.ts";

const path = (id: string) => `/api/accounts/${id}/scan`;

/** The route reads time from injected deps; the Access JWT check keeps the real clock. */
const app = createApp({ now: () => NOW });
const post = (id: string) => apiFetch(path(id), { method: "POST" }, { app });

describe("POST /api/accounts/:id/scan", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = [mail(0), mail(1)];
    useNetworkOpen(mock.handlers(), new DecisionMock().handlers());
  });

  afterEach(() => {
    expectNoUnhandled();
  });

  it("runs one forced tick and returns the TickReport", async () => {
    await seedTickAccount({ nextTickAt: NOW + 60 * MINUTE });
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TickReport;
    expect(body).toMatchObject({ outcome: "processed", accountId: ACCOUNT_A });
    expect(body.subrequests).toBeLessThanOrEqual(45);
    expect(await count("messages")).toBe(2);
  });

  it("returns 404 for an unknown account", async () => {
    const res = await post("acc_00000000000000ff");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("not_found");
  });

  it("returns 409 account_inactive for a paused account", async () => {
    await seedTickAccount({ paused: true });
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("account_inactive");
    expect(await count("messages")).toBe(0);
  });

  it("returns 409 account_busy with retryAt while a tick holds the lease", async () => {
    await seedTickAccount();
    const expires = NOW + 5 * MINUTE;
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'other', ?3, ?4)",
    )
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, expires)
      .run();
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error).toMatchObject({
      code: "account_busy",
      retryAt: new Date(expires).toISOString(),
    });
    expect(await count("messages")).toBe(0);
  });

  it("returns 429 budget_exhausted at the daily ingest gate", async () => {
    await seedTickAccount();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(429);
    const error = ((await res.json()) as ApiErrorBody).error;
    expect(error.code).toBe("budget_exhausted");
    expect(error.retryAt).toBe(new Date(nextUtcMidnight(NOW)).toISOString());
    expect(error.retryAt).toBe("2026-10-16T00:00:00.000Z");
    expect(await count("messages")).toBe(0);
  });

  it("returns 409 account_inactive with retryAt = backoff_until while the account backs off", async () => {
    const backoff = NOW + 7 * MINUTE;
    await seedTickAccount({ backoffUntil: backoff, attempts: 2 });
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error).toMatchObject({
      code: "account_inactive",
      retryAt: new Date(backoff).toISOString(),
    });
    expect(await count("messages")).toBe(0);
  });

  it("returns 404 not_found for a disconnected account", async () => {
    await seedTickAccount({ status: "disconnected" });
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("not_found");
  });

  it("returns 409 account_inactive without retryAt for an account that needs reauth", async () => {
    await seedTickAccount({ status: "needs_reauth" });
    const res = await post(ACCOUNT_A);
    expect(res.status).toBe(409);
    const error = ((await res.json()) as ApiErrorBody).error;
    expect(error.code).toBe("account_inactive");
    expect(error.retryAt).toBeUndefined();
  });
});
