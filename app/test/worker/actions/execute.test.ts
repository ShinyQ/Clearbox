import { ProviderAuthError, ProviderConfigError, ProviderRateLimitError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSuggestions } from "../../../src/worker/actions/execute.ts";
import type { ActionContext, ExecuteRequest } from "../../../src/worker/actions/execute.ts";
import { defaultDeps } from "../../../src/worker/app.ts";
import { decryptToken } from "../../../src/worker/crypto/aead.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import type { Account } from "../../../src/worker/db/accounts.ts";
import { budgetDeltaStmt, readBudget } from "../../../src/worker/db/budget.ts";
import { readSettings } from "../../../src/worker/db/settings.ts";
import { readConfig } from "../../../src/worker/env.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { TEST_ORIGIN } from "../helpers/request.ts";
import {
  getSuggestionRow,
  SEED_NOW,
  seedAccount,
  seedMessages,
  seedSuggestions,
  testEncKey,
} from "../helpers/seed.ts";

const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

function context(provider: FakeProvider, envPatch: Record<string, string> = {}): ActionContext {
  const result = readConfig({ ...env, ...envPatch } as Env);
  if (!result.ok) throw new Error("config");
  return {
    db: env.DB,
    config: result.config,
    deps: defaultDeps({ now: () => SEED_NOW, providerFactory: provider.factory(), oauth: fakeOAuth().oauth }),
    requestId: "00000000-0000-4000-8000-0000000000aa",
    origin: TEST_ORIGIN,
    route: "/api/approve",
  };
}

const run = (provider: FakeProvider, req: ExecuteRequest) => executeSuggestions(context(provider), req);

async function rows(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .run<Record<string, unknown>>()
  ).results;
}

describe("approve ids", () => {
  it("trashes and archives exact pending ids and records labels, priors, batch and audit", async () => {
    const acc = await seedAccount({ email: "exec1@example.com" });
    const [d1, d2] = await seedSuggestions(acc.id, 2, { action: "delete", subject: "x".repeat(80) });
    const [ar] = await seedSuggestions(acc.id, 1, {
      action: "archive",
      sender: "bill@example.net",
      senderDomain: "example.net",
    });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [ar ?? 0, d1 ?? 0, d2 ?? 0] });

    expect(res).toMatchObject({ executed: 3, failed: 0, skipped: 0, retryLater: 0, remaining: 0 });
    expect(res.results.map((r) => [r.id, r.outcome, r.action])).toEqual([
      [ar, "executed", "archive"],
      [d1, "executed", "delete"],
      [d2, "executed", "delete"],
    ]);
    expect(fake.calls.map((c) => [c.method, c.ids.length])).toEqual([
      ["trash", 2],
      ["archive", 1],
    ]);
    const s = await getSuggestionRow(d1 ?? 0);
    expect(s).toMatchObject({
      status: "executed",
      final_action: "delete",
      decided_via: "approve",
      batch_id: res.batchId,
      decided_at: SEED_NOW,
      expires_at: SEED_NOW + 30 * DAY,
    });
    const label = await rows(
      "SELECT * FROM labels WHERE account_id = ?1 AND id = ?2",
      acc.id,
      s?.["label_id"],
    );
    expect(label[0]).toMatchObject({
      message_id: d1,
      owner_action: "delete",
      suggested_action: "delete",
      source: "approve",
    });
    expect(String(label[0]?.["subject_trunc"])).toHaveLength(60);
    expect(
      await rows("SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key", acc.id),
    ).toEqual([
      { key: "@example.com", deletes: 2, keeps: 0 },
      { key: "@example.net", deletes: 0, keeps: 1 },
      { key: "bill@example.net", deletes: 0, keeps: 1 },
      { key: "news@shop.example.com", deletes: 2, keeps: 0 },
    ]);
    const batch = await rows("SELECT * FROM action_batches WHERE id = ?1", res.batchId);
    expect(batch[0]).toMatchObject({
      kind: "approve",
      requested_count: 3,
      executed_count: 3,
      failed_count: 0,
      undo_expires_at: SEED_NOW + DAY,
    });
    expect(JSON.parse(String(batch[0]?.["suggestion_ids_json"]))).toEqual([ar, d1, d2]);
    const audit = await rows(
      "SELECT kind, account_id, batch_id, count, result_json FROM audit_log WHERE batch_id = ?1",
      res.batchId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "approve", account_id: acc.id, count: 3 });
    expect(JSON.parse(String(audit[0]?.["result_json"]))).toEqual({
      executed: 3,
      failed: 0,
      skipped: 0,
      retryLater: 0,
      delete: 2,
      archive: 1,
      keep: 0,
      groups: 2,
    });
  });

  it("never touches the provider without a pending suggestion; repeats are idempotent", async () => {
    const acc = await seedAccount();
    const gone = await seedAccount({ status: "disconnected" });
    const [pending] = await seedSuggestions(acc.id, 1);
    const [done] = await seedSuggestions(acc.id, 1, { status: "executed", finalAction: "delete" });
    const [unsure] = await seedSuggestions(acc.id, 1, { action: "unsure", confidence: 0.3 });
    const [other] = await seedSuggestions(gone.id, 1);
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [done ?? 0, unsure ?? 0, other ?? 0, 999_999] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["skipped", "not_pending"],
      ["skipped", "unsure_not_approvable"],
      ["skipped", "not_pending"],
      ["skipped", "not_pending"],
    ]);
    expect(res.batchId).toBeNull();
    expect(fake.calls).toEqual([]);
    await run(fake, { kind: "approve_ids", ids: [pending ?? 0] });
    const again = await run(fake, { kind: "approve_ids", ids: [pending ?? 0] });
    expect(again).toMatchObject({ executed: 0, skipped: 1, batchId: null });
    expect(fake.calls).toHaveLength(1);
  });

  it("executes keep without a provider call", async () => {
    const acc = await seedAccount();
    const [k] = await seedSuggestions(acc.id, 1, { action: "keep", confidence: 0.8 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [k ?? 0] });
    expect(res.executed).toBe(1);
    expect(fake.calls).toEqual([]);
    expect((await getSuggestionRow(k ?? 0))?.["final_action"]).toBe("keep");
  });
});

describe("provider failures", () => {
  it("maps per-item results and updates moved Graph ids", async () => {
    const acc = await seedAccount({ provider: "outlook" });
    const [ok, missing, throttled] = await seedSuggestions(acc.id, 3);
    const pid = async (id: number | undefined) =>
      String((await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", id))[0]?.["provider_msg_id"]);
    const fake = new FakeProvider({
      newIdFor: (id) => `${id}-moved`,
      results: new Map([
        [await pid(missing), { id: await pid(missing), ok: false, error: "not_found", retryAfterMs: null }],
        [
          await pid(throttled),
          { id: await pid(throttled), ok: false, error: "rate_limited", retryAfterMs: 1000 },
        ],
      ]),
    });
    const before = await pid(ok);
    const res = await run(fake, { kind: "approve_ids", ids: [ok ?? 0, missing ?? 0, throttled ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["executed", null],
      ["failed", "not_found"],
      ["retry_later", "rate_limited"],
    ]);
    expect(await pid(ok)).toBe(`${before}-moved`);
    expect((await getSuggestionRow(missing ?? 0))?.["status"]).toBe("failed");
    expect((await getSuggestionRow(missing ?? 0))?.["exec_error"]).toBe("not_found");
    expect((await getSuggestionRow(throttled ?? 0))?.["status"]).toBe("pending");
  });

  it("keeps the stored id when a moved Graph id is already taken, without failing the batch", async () => {
    const acc = await seedAccount({ provider: "outlook" });
    const [id] = await seedSuggestions(acc.id, 1);
    await seedMessages(acc.id, 1, { providerMsgId: "graph-taken-1" });
    const before = (await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", id))[0]?.[
      "provider_msg_id"
    ];
    const res = await run(new FakeProvider({ newIdFor: () => "graph-taken-1" }), {
      kind: "approve_ids",
      ids: [id ?? 0],
    });
    expect(res).toMatchObject({ executed: 1, failed: 0 });
    expect(res.batchId).not.toBeNull();
    expect(
      (await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", id))[0]?.["provider_msg_id"],
    ).toBe(before);
    expect(await getSuggestionRow(id ?? 0)).toMatchObject({ status: "executed", batch_id: res.batchId });
  });

  it("returns items to pending as unknown on an unexpected whole-call error and logs its class name only", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const fake = new FakeProvider({ failWith: { trash: new TypeError("secret detail msg-1") } });
    const res = await run(fake, { kind: "approve_ids", ids });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([["retry_later", "unknown"]]);
    expect((await getSuggestionRow(ids[0] ?? 0))?.["status"]).toBe("pending");
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"request.error"')) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      requestId: "00000000-0000-4000-8000-0000000000aa",
      route: "/api/approve",
      errorName: "TypeError",
    });
    expect(lines.join("\n")).not.toMatch(/secret detail|msg-/);
  });

  it("returns every item to pending on a whole-call rate limit", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2);
    const fake = new FakeProvider({
      failWith: { trash: new ProviderRateLimitError({ provider: "gmail", retryAfterMs: 1000 }) },
    });
    const res = await run(fake, { kind: "approve_ids", ids });
    expect(res.results.map((r) => r.error)).toEqual(["rate_limited", "rate_limited"]);
    expect(res.batchId).toBeNull();
    for (const id of ids) expect((await getSuggestionRow(id))?.["status"]).toBe("pending");
  });

  it("marks the account needs_reauth on ProviderAuthError and still serves other accounts", async () => {
    const bad = await seedAccount();
    const good = await seedAccount();
    const [b1] = await seedSuggestions(bad.id, 1);
    const [g1] = await seedSuggestions(good.id, 1);
    const badIds = new Set(
      (await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", b1)).map((r) =>
        String(r["provider_msg_id"]),
      ),
    );
    const fake = new FakeProvider();
    const factory = fake.factory();
    const ctx = context(fake);
    ctx.deps = {
      ...ctx.deps,
      providerFactory: (target, deps) => {
        const p = factory(target, deps);
        return {
          ...p,
          trash: async (ids: readonly string[]) =>
            ids.some((i) => badIds.has(i))
              ? Promise.reject(new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" }))
              : p.trash(ids),
        };
      },
    };
    const res = await executeSuggestions(ctx, { kind: "approve_ids", ids: [b1 ?? 0, g1 ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["retry_later", "account_inactive"],
      ["executed", null],
    ]);
    expect(await getAccount(env.DB, bad.id)).toMatchObject({
      status: "needs_reauth",
      statusReason: "invalid_grant",
    });
    expect(await rows("SELECT kind FROM audit_log WHERE account_id = ?1", bad.id)).toEqual([
      { kind: "reauth_required" },
    ]);
    expect((await getSuggestionRow(b1 ?? 0))?.["status"]).toBe("pending");
  });

  it("marks config_error and raises the client issue on ProviderConfigError", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const fake = new FakeProvider({
      failWith: { trash: new ProviderConfigError({ provider: "gmail", reason: "invalid_client" }) },
    });
    await run(fake, { kind: "approve_ids", ids });
    expect((await getAccount(env.DB, acc.id))?.status).toBe("config_error");
    expect((await readSettings(env.DB)).issues.map((i) => i.code)).toContain("google_client_invalid");
  });

  it("skips the provider for inactive accounts and Outlook archive without a folder", async () => {
    const inactive = await seedAccount({ status: "needs_reauth" });
    const [del] = await seedSuggestions(inactive.id, 1);
    const [keep] = await seedSuggestions(inactive.id, 1, { action: "keep", confidence: 0.9 });
    const noFolder = await seedAccount({ provider: "outlook", archiveFolderId: null });
    const [arch] = await seedSuggestions(noFolder.id, 1, { action: "archive", confidence: 0.9 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [del ?? 0, keep ?? 0, arch ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["retry_later", "account_inactive"],
      ["executed", null],
      ["failed", "archive_unavailable"],
    ]);
    expect(fake.calls).toEqual([]);
    expect((await getSuggestionRow(del ?? 0))?.["status"]).toBe("pending");
  });

  it("persists a rotated Microsoft refresh token after an action", async () => {
    const acc = await seedAccount({ provider: "outlook", accessToken: null });
    const ids = await seedSuggestions(acc.id, 1);
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const stored = await getAccount(env.DB, acc.id);
    const token = await decryptToken(
      await testEncKey(),
      stored?.refreshToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() },
      {
        accountId: acc.id,
        kind: "refresh",
        keyVersion: 1,
      },
    );
    expect(token).toBe("rotated-refresh");
  });
});

describe("override, group approve and Clean up", () => {
  it("override ignores the guardrail ceiling and records the owner action", async () => {
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, { action: "keep", ceiling: "keep", confidence: 0.9 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "override", ids: [id ?? 0], action: "delete" });
    expect(res.results[0]).toMatchObject({ outcome: "executed", action: "delete" });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash"]);
    const s = await getSuggestionRow(id ?? 0);
    expect(s?.["decided_via"]).toBe("override");
    expect(
      (
        await rows("SELECT suggested_action, owner_action, source FROM labels WHERE id = ?1", s?.["label_id"])
      )[0],
    ).toEqual({
      suggested_action: "keep",
      owner_action: "delete",
      source: "override",
    });
  });

  it("approves a group up to 100 items created before asOf and reports the remaining count", async () => {
    const acc = await seedAccount();
    await seedSuggestions(acc.id, 103, (i) => ({ sender: "bulk@example.com", confidence: 0.9 - i * 0.001 }));
    await seedSuggestions(acc.id, 1, { sender: "bulk@example.com", createdAt: SEED_NOW + 1 });
    const fake = new FakeProvider();
    const res = await run(fake, {
      kind: "approve_group",
      accountId: acc.id,
      sender: "bulk@example.com",
      action: "delete",
      asOf: SEED_NOW,
    });
    expect(res.executed).toBe(100);
    expect(res.remaining).toBe(3);
    expect(fake.calls[0]?.ids).toHaveLength(100);
    const next = await run(fake, {
      kind: "approve_group",
      accountId: acc.id,
      sender: "bulk@example.com",
      action: "delete",
      asOf: SEED_NOW,
    });
    expect(next).toMatchObject({ executed: 3, remaining: 0 });
  });

  it("cleans up by threshold and action, and supports Confirm all keeps", async () => {
    const acc = await seedAccount();
    const [high] = await seedSuggestions(acc.id, 1, {
      sender: "c1@example.com",
      action: "delete",
      confidence: 0.95,
    });
    const [low] = await seedSuggestions(acc.id, 1, {
      sender: "c2@example.com",
      action: "delete",
      confidence: 0.6,
    });
    const [keep] = await seedSuggestions(acc.id, 1, {
      sender: "c3@example.com",
      action: "keep",
      confidence: 0.9,
    });
    const fake = new FakeProvider();
    const res = await run(fake, {
      kind: "cleanup",
      actions: ["delete", "archive"],
      threshold: 0.9,
      accountId: acc.id,
      asOf: SEED_NOW,
    });
    expect(res.results.map((r) => r.id)).toEqual([high]);
    expect(res.remaining).toBe(0);
    expect((await getSuggestionRow(low ?? 0))?.["status"]).toBe("pending");
    const keeps = await run(fake, {
      kind: "cleanup",
      actions: ["keep"],
      threshold: 0.5,
      accountId: acc.id,
      asOf: SEED_NOW,
    });
    expect(keeps.results.map((r) => [r.id, r.outcome, r.action])).toEqual([[keep, "executed", "keep"]]);
    expect((await getSuggestionRow(keep ?? 0))?.["decided_via"]).toBe("cleanup");
  });
});

describe("budget and logging", () => {
  it("refuses owner actions at the daily cap on Free and counts written rows", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const date = new Date(SEED_NOW).toISOString().slice(0, 10);
    const before = (await readBudget(env.DB, date)).rowsWritten;
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const after = await readBudget(env.DB, date);
    expect(after.rowsWritten).toBeGreaterThan(before);
    expect(after.providerCalls).toBeGreaterThanOrEqual(1);

    await budgetDeltaStmt(env.DB, date, { rowsWritten: 90_000 }, SEED_NOW).run();
    const more = await seedSuggestions(acc.id, 1);
    const err = await run(new FakeProvider(), { kind: "approve_ids", ids: more }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      code: "budget_exhausted",
      retryAt: new Date(SEED_NOW + DAY / 2).toISOString(),
    });
    const paid = await executeSuggestions(context(new FakeProvider(), { FREE_TIER: "false" }), {
      kind: "approve_ids",
      ids: more,
    });
    expect(paid.executed).toBe(1);
    // D1 state is shared by the tests of this file: give the day's budget back for later tests.
    await budgetDeltaStmt(env.DB, date, { rowsWritten: -90_000 }, SEED_NOW).run();
  });

  it("logs action.executed with counts only", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const acc: Account = await seedAccount({ email: "logged@example.com" });
    const ids = await seedSuggestions(acc.id, 1);
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"action.executed"')) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({ kind: "approve", executed: 1, failed: 0, skipped: 0, retryLater: 0 });
    expect(lines.join("\n")).not.toMatch(/logged@example\.com|news@shop|msg-/);
  });
});
