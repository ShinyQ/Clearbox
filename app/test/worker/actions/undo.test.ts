import { ProviderRateLimitError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionBatchView, ApiErrorBody, Page, UndoResponse } from "../../../src/shared/api.ts";
import { executeSuggestions } from "../../../src/worker/actions/execute.ts";
import type { ActionContext } from "../../../src/worker/actions/execute.ts";
import { undoBatch } from "../../../src/worker/actions/undo.ts";
import { createApp, defaultDeps } from "../../../src/worker/app.ts";
import { auditStmt } from "../../../src/worker/db/audit.ts";
import { getBatch, insertBatchStmt } from "../../../src/worker/db/batches.ts";
import { readConfig } from "../../../src/worker/env.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson, TEST_ORIGIN } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

function context(provider: FakeProvider, now = SEED_NOW): ActionContext {
  const result = readConfig(env);
  if (!result.ok) throw new Error("config");
  return {
    db: env.DB,
    config: result.config,
    deps: defaultDeps({ now: () => now, providerFactory: provider.factory(), oauth: fakeOAuth().oauth }),
    requestId: "00000000-0000-4000-8000-0000000000bb",
    origin: TEST_ORIGIN,
    route: "/api/batches/:id/undo",
  };
}

async function priors(accountId: string) {
  return (
    await env.DB.prepare("SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key")
      .bind(accountId)
      .run()
  ).results;
}

async function executedBatch(provider: FakeProvider) {
  const acc = await seedAccount();
  const [del] = await seedSuggestions(acc.id, 1, { action: "delete" });
  const [arc] = await seedSuggestions(acc.id, 1, { action: "archive", confidence: 0.9 });
  const [keep] = await seedSuggestions(acc.id, 1, { action: "keep", confidence: 0.9 });
  const res = await executeSuggestions(context(provider), {
    kind: "approve_ids",
    ids: [del ?? 0, arc ?? 0, keep ?? 0],
  });
  return { acc, del: del ?? 0, arc: arc ?? 0, keep: keep ?? 0, batchId: res.batchId ?? 0 };
}

describe("undoBatch", () => {
  it("restores trash and archive items, rewrites labels and reverses priors", async () => {
    const fake = new FakeProvider();
    const { acc, del, arc, keep, batchId } = await executedBatch(fake);
    const res = await undoBatch(context(fake, SEED_NOW + 60_000), batchId);
    expect(res).toMatchObject({ batchId, restored: 2, failed: 0, skipped: 1 });
    expect(res.results.map((r) => [r.id, r.outcome])).toEqual([
      [del, "restored"],
      [arc, "restored"],
      [keep, "skipped"],
    ]);
    const restoreIds = fake.calls.filter((c) => c.method === "restore").flatMap((c) => c.ids);
    expect(restoreIds.some((id) => id.startsWith("trash:"))).toBe(true);
    expect(restoreIds.some((id) => id.startsWith("archive:"))).toBe(true);
    expect((await getSuggestionRow(del))?.["status"]).toBe("undone");
    expect((await getSuggestionRow(keep))?.["status"]).toBe("executed");
    const label = await env.DB.prepare("SELECT owner_action, source FROM labels WHERE id = ?1")
      .bind((await getSuggestionRow(del))?.["label_id"])
      .first();
    expect(label).toEqual({ owner_action: "keep", source: "undo" });
    expect(await priors(acc.id)).toEqual([
      { key: "@example.com", deletes: 0, keeps: 3 },
      { key: "news@shop.example.com", deletes: 0, keeps: 3 },
    ]);
    expect((await getBatch(env.DB, batchId))?.undoneAt).toBe(SEED_NOW + 60_000);
    const audit = await env.DB.prepare(
      "SELECT count, result_json FROM audit_log WHERE kind = 'undo' AND batch_id = ?1",
    )
      .bind(batchId)
      .first();
    expect(audit).toEqual({ count: 2, result_json: JSON.stringify({ restored: 2, failed: 0 }) });
  });

  it("is one-shot: a second undo skips everything without provider calls", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    await undoBatch(context(fake), batchId);
    const before = fake.calls.length;
    const again = await undoBatch(context(fake), batchId);
    expect(again).toMatchObject({ restored: 0, failed: 0, skipped: 3 });
    expect(fake.calls.length).toBe(before);
  });

  it("answers 410 after 24 hours and 404 for unknown batches", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    await expect(undoBatch(context(fake, SEED_NOW + DAY), batchId)).rejects.toMatchObject({
      status: 410,
      code: "undo_expired",
    });
    await expect(undoBatch(context(fake), 999_999)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("reopens the batch for undo when the provider throttles every restore", async () => {
    const ok = new FakeProvider();
    const { batchId, del } = await executedBatch(ok);
    const throttled = new FakeProvider({
      failWith: { restore: new ProviderRateLimitError({ provider: "gmail", retryAfterMs: 1000 }) },
    });
    const res = await undoBatch(context(throttled), batchId);
    expect(res).toMatchObject({ restored: 0, failed: 2 });
    expect(res.results.find((r) => r.id === del)?.error).toBe("rate_limited");
    expect((await getBatch(env.DB, batchId))?.undoneAt).toBeNull();
    expect((await undoBatch(context(ok), batchId)).restored).toBe(2);
  });

  it("stores moved Graph ids and fails items the provider reports as unknown", async () => {
    const acc = await seedAccount({ provider: "outlook" });
    const [a, b] = await seedSuggestions(acc.id, 2, { action: "archive" });
    const exec = new FakeProvider();
    const { batchId } = await executeSuggestions(context(exec), {
      kind: "approve_ids",
      ids: [a ?? 0, b ?? 0],
    });
    const pidOf = async (id: number | undefined) =>
      (
        await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1")
          .bind(id ?? 0)
          .first<{ provider_msg_id: string }>()
      )?.provider_msg_id ?? "";
    const pidA = await pidOf(a);
    const pidB = await pidOf(b);
    const restore = new FakeProvider({
      newIdFor: (id) => `inbox-${id}`,
      results: new Map([[pidB, { id: pidB, ok: false, error: "unknown", retryAfterMs: null }]]),
    });
    const res = await undoBatch(context(restore), batchId ?? 0);
    expect(res.results.map((r) => [r.id, r.outcome, r.error])).toEqual([
      [a, "restored", null],
      [b, "failed", "unknown"],
    ]);
    expect(await pidOf(a)).toBe(`inbox-${pidA}`);
    expect(await pidOf(b)).toBe(pidB);
    expect((await getSuggestionRow(b ?? 0))?.["status"]).toBe("executed");
    expect((await getBatch(env.DB, batchId ?? 0))?.undoneAt).toBe(SEED_NOW);
  });

  it("restores a full 100-item batch within the bound parameter limit", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 100, { action: "delete" });
    const fake = new FakeProvider();
    const { batchId } = await executeSuggestions(context(fake), { kind: "approve_ids", ids });
    const res = await undoBatch(context(fake), batchId ?? 0);
    expect(res).toMatchObject({ restored: 100, failed: 0, skipped: 0 });
    expect(res.results.map((r) => r.id)).toEqual(ids);
  });

  it("fails items on an unexpected restore error and logs only its class name", async () => {
    const ok = new FakeProvider();
    const { batchId } = await executedBatch(ok);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const broken = new FakeProvider({ failWith: { restore: new TypeError("secret detail msg-1") } });
    const res = await undoBatch(context(broken), batchId);
    expect(res).toMatchObject({ restored: 0, failed: 2, skipped: 1 });
    expect(res.results.filter((r) => r.outcome === "failed").map((r) => r.error)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect((await getBatch(env.DB, batchId))?.undoneAt).toBeNull();
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"request.error"')) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      requestId: "00000000-0000-4000-8000-0000000000bb",
      route: "/api/batches/:id/undo",
      errorName: "TypeError",
    });
    expect(lines.join("\n")).not.toMatch(/secret detail|msg-/);
    expect(lines.some((l) => l.includes('"evt":"undo.done"'))).toBe(true);
  });
});

describe("batches routes", () => {
  it("lists recent batches with byAction and undoes over HTTP", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    const app = createApp({
      now: () => SEED_NOW + 1,
      providerFactory: fake.factory(),
      oauth: fakeOAuth().oauth,
    });
    const page = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches", {}, { app }));
    const view = page.items.find((b) => b.id === batchId);
    expect(view).toMatchObject({
      kind: "approve",
      requestedCount: 3,
      executedCount: 3,
      failedCount: 0,
      byAction: { delete: 1, archive: 1, keep: 1 },
      undoable: true,
      undoneAt: null,
      undoExpiresAt: new Date(SEED_NOW + DAY).toISOString(),
    });
    const undo = await apiFetch(`/api/batches/${batchId}/undo`, jsonInit("POST"), { app });
    expect((await readJson<UndoResponse>(undo)).restored).toBe(2);
    const after = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches", {}, { app }));
    expect(after.items.find((b) => b.id === batchId)?.undoable).toBe(false);
    const missing = await apiFetch("/api/batches/abc/undo", jsonInit("POST"), { app });
    expect((await readJson<ApiErrorBody>(missing)).error.code).toBe("not_found");
  });

  it("pages batches newest first", async () => {
    const fake = new FakeProvider();
    await executedBatch(fake);
    await executedBatch(fake);
    const app = createApp({ now: () => SEED_NOW + 1 });
    const first = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches?limit=1", {}, { app }));
    expect(first.items).toHaveLength(1);
    const second = await readJson<Page<ActionBatchView>>(
      await apiFetch(`/api/batches?limit=1&cursor=${first.nextCursor ?? ""}`, {}, { app }),
    );
    expect((second.items[0]?.id ?? 0) < (first.items[0]?.id ?? 0)).toBe(true);
  });

  it("serves a full page of 100 batches with their audit counts", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 101; i++) {
      stmts.push(
        insertBatchStmt(env.DB, {
          kind: "cleanup",
          suggestionIds: [i + 1],
          requestedCount: 1,
          executedCount: 1,
          failedCount: 0,
          createdAt: SEED_NOW,
          undoExpiresAt: SEED_NOW + DAY,
        }),
        auditStmt(env.DB, {
          ts: SEED_NOW,
          accountId: null,
          kind: "cleanup",
          batchId: "latest_batch",
          count: 1,
          result: { executed: 1, archive: 1 },
        }),
      );
    }
    await env.DB.batch(stmts);
    const app = createApp({ now: () => SEED_NOW + 1 });
    const res = await apiFetch("/api/batches?limit=100", {}, { app });
    expect(res.status).toBe(200);
    const page = await readJson<Page<ActionBatchView>>(res);
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.every((b) => b.byAction.archive === 1 && b.byAction.delete === 0)).toBe(true);
  });
});
