import {
  CursorExpiredError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
  createSubrequestCounter,
} from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DecisionNotConfiguredError,
  DecisionOutageError,
  buildFailureWrite,
  classifyFailure,
} from "../../../src/worker/scan/failure.ts";
import { encryptTokenUpdate } from "../../../src/worker/scan/tick-tokens.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { testEncKey } from "../helpers/seed.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  decryptAccountToken,
  getAccount,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

const C = { provider: "outlook" as const, attempts: 0, now: NOW, random: () => 0 };

function budgetError(): SubrequestBudgetError {
  try {
    createSubrequestCounter(0).reserve(1);
  } catch (err) {
    if (err instanceof SubrequestBudgetError) return err;
  }
  throw new Error("expected SubrequestBudgetError");
}

describe("classifyFailure", () => {
  it("halves the page and sets no backoff for a subrequest budget error, even when wrapped", () => {
    const direct = classifyFailure(budgetError(), C);
    expect(direct).toMatchObject({
      errorCode: "subrequest_budget",
      backoffUntil: null,
      halvePageSize: true,
      status: "active",
    });
    const wrapped = new ProviderUnavailableError({
      provider: "outlook",
      retryAfterMs: null,
      cause: budgetError(),
    });
    expect(classifyFailure(wrapped, C)).toMatchObject({
      errorCode: "subrequest_budget",
      halvePageSize: true,
    });
  });

  it("maps auth and config errors to account statuses, audits and issues", () => {
    const auth = classifyFailure(new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" }), {
      ...C,
      provider: "gmail",
    });
    expect(auth).toMatchObject({
      status: "needs_reauth",
      statusReason: "invalid_grant",
      audit: "reauth_required",
      raise: [],
    });
    const cfg = classifyFailure(new ProviderConfigError({ provider: "outlook", reason: "AADSTS7000222" }), C);
    expect(cfg).toMatchObject({
      status: "config_error",
      statusReason: "AADSTS7000222",
      audit: "config_error",
      raise: ["microsoft_client_invalid"],
    });
    const gcfg = classifyFailure(new ProviderConfigError({ provider: "gmail", reason: "invalid_client" }), {
      ...C,
      provider: "gmail",
    });
    expect(gcfg.raise).toEqual(["google_client_invalid"]);
  });

  it("classifies a Graph sub-response 401 after refresh (unauthorized) as needs_reauth", () => {
    expect(
      classifyFailure(new ProviderAuthError({ provider: "outlook", reason: "unauthorized" }), C),
    ).toMatchObject({
      status: "needs_reauth",
      statusReason: "unauthorized",
      audit: "reauth_required",
      raise: [],
    });
  });

  it("honors Retry-After and otherwise backs off exponentially from the attempt count", () => {
    expect(
      classifyFailure(new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 120_000 }), C)
        .backoffUntil,
    ).toBe(NOW + 120_000);
    expect(
      classifyFailure(new ProviderUnavailableError({ provider: "outlook", retryAfterMs: null }), C)
        .backoffUntil,
    ).toBe(NOW + MINUTE);
    expect(
      classifyFailure(new ProviderUnavailableError({ provider: "outlook", retryAfterMs: null }), {
        ...C,
        attempts: 2,
      }).backoffUntil,
    ).toBe(NOW + 4 * MINUTE);
  });

  it("records the provider status for provider failures only", () => {
    expect(
      classifyFailure(new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 1 }), C).provider,
    ).toEqual({
      status: 429,
    });
    expect(classifyFailure(new ProviderResponseError({ provider: "outlook", status: 502 }), C)).toMatchObject(
      {
        errorCode: "provider_response",
        provider: { status: 502 },
        status: "active",
        backoffUntil: NOW + MINUTE,
      },
    );
    expect(
      classifyFailure(new ProviderResponseError({ provider: "outlook", status: 0 }), C).provider,
    ).toEqual({ status: 0 });
    expect(
      classifyFailure(new CursorExpiredError({ provider: "outlook", cursorKind: "incremental" }), C),
    ).toMatchObject({ errorCode: "cursor_expired", provider: { status: null } });
  });

  it("raises Decision-1 configuration issues", () => {
    expect(classifyFailure(decisionError("auth", 401, false, "config"), C).raise).toEqual([
      "decision_auth_failed",
    ]);
    expect(classifyFailure(decisionError("deployment_not_found", 404, false, "config"), C).raise).toEqual([
      "decision_deployment_not_found",
    ]);
    expect(classifyFailure(decisionError("server", 500, true, "item"), C).raise).toEqual([]);
    expect(classifyFailure(new DecisionNotConfiguredError(), C)).toMatchObject({
      errorCode: "decision_not_configured",
      raise: ["decision_not_configured"],
    });
    expect(classifyFailure(new DecisionOutageError(5, 5), C)).toMatchObject({
      errorCode: "decision_outage",
      raise: [],
      backoffUntil: NOW + MINUTE,
    });
  });

  it("treats unknown errors as internal", () => {
    expect(classifyFailure(new Error("boom"), C)).toMatchObject({
      errorCode: "internal",
      status: "active",
      provider: null,
    });
  });
});

describe("buildFailureWrite", () => {
  beforeEach(resetDb);

  it("marks the account, persists rotated tokens, audits the status change and releases the lease", async () => {
    await seedTickAccount();
    await env.DB.prepare(
      "INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'tick-1', ?3, ?4)",
    )
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE)
      .run();
    const err = new ProviderAuthError({ provider: "outlook", reason: "AADSTS70008" });
    const plan = classifyFailure(err, C);
    const tokens = await encryptTokenUpdate(
      await testEncKey(),
      { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-2", accessExpiresAt: NOW + 3_600_000, refreshToken: "r-2" },
    );
    const stmts = buildFailureWrite({
      accountId: ACCOUNT_A,
      tickId: "tick-1",
      now: NOW,
      plan,
      tokens,
      issues: null,
    });
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      status: "needs_reauth",
      status_reason: "AADSTS70008",
      attempts: 1,
      last_error: err.code,
      last_tick_at: NOW,
    });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("r-2");
    expect(await one("SELECT released_at FROM leases WHERE holder = 'tick-1'")).toEqual({ released_at: NOW });
    expect(await one("SELECT kind, result_json FROM audit_log WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      kind: "reauth_required",
      result_json: '{"reason":"AADSTS70008"}',
    });
  });

  it("halves page_size without a backoff on a subrequest budget failure", async () => {
    await seedTickAccount({ pageSize: 25 });
    const plan = classifyFailure(budgetError(), C);
    const stmts = buildFailureWrite({
      accountId: ACCOUNT_A,
      tickId: "tick-1",
      now: NOW,
      plan,
      tokens: null,
      issues: null,
    });
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      page_size: 12,
      backoff_until: null,
      attempts: 1,
      status: "active",
    });
  });

  it("never drops page_size below 5 and leaves a disconnected account untouched", async () => {
    await seedTickAccount({ pageSize: 6 });
    const plan = classifyFailure(budgetError(), C);
    const run = async (): Promise<void> => {
      const stmts = buildFailureWrite({
        accountId: ACCOUNT_A,
        tickId: "t",
        now: NOW,
        plan,
        tokens: null,
        issues: null,
      });
      await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    };
    await run();
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ page_size: 5 });
    await env.DB.prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?1").bind(ACCOUNT_A).run();
    await run();
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ page_size: 5, attempts: 1, status: "disconnected" });
  });

  it("upserts raised app issues in the same batch and writes no audit for transient failures", async () => {
    await seedTickAccount();
    const plan = classifyFailure(new DecisionNotConfiguredError(), C);
    const stmts = buildFailureWrite({
      accountId: ACCOUNT_A,
      tickId: "t",
      now: NOW,
      plan,
      tokens: null,
      issues: [{ code: "decision_not_configured", since: new Date(NOW).toISOString(), accountId: null }],
    });
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    expect(await one("SELECT COUNT(*) AS n FROM audit_log")).toEqual({ n: 0 });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      last_error: "decision_not_configured",
      backoff_until: NOW + MINUTE,
    });
    expect(await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'")).toEqual({
      value: JSON.stringify([
        { code: "decision_not_configured", since: new Date(NOW).toISOString(), accountId: null },
      ]),
    });
  });
});
