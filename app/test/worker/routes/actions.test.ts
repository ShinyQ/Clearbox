import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, ApiErrorBody, CleanupPreview } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { budgetDeltaStmt } from "../../../src/worker/db/budget.ts";
import { encodeGroupKey } from "../../../src/worker/db/suggestions.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const AS_OF = new Date(SEED_NOW).toISOString();

function setup() {
  const fake = new FakeProvider();
  const app = createApp({ now: () => SEED_NOW, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
  return { app, fake };
}

async function errorCode(res: Response): Promise<string> {
  return (await readJson<ApiErrorBody>(res)).error.code;
}

async function previewAccount() {
  const acc = await seedAccount();
  await seedSuggestions(acc.id, 1, { sender: "s1@example.com", action: "delete", confidence: 0.95 });
  await seedSuggestions(acc.id, 1, { sender: "s1@example.com", action: "delete", confidence: 0.6 });
  await seedSuggestions(acc.id, 1, { sender: "s2@example.com", action: "archive", confidence: 0.85 });
  await seedSuggestions(acc.id, 1, { sender: "s3@example.com", action: "keep", confidence: 0.9 });
  await seedSuggestions(acc.id, 1, { sender: "s4@example.com", action: "unsure", confidence: 0.3 });
  return acc;
}

describe("POST /api/approve", () => {
  it("approves exact ids", async () => {
    const { app, fake } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2);
    const res = await apiFetch("/api/approve", jsonInit("POST", { ids }), { app });
    expect(res.status).toBe(200);
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash"]);
  });

  it("validates id lists", async () => {
    const { app } = setup();
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { ids: tooMany }), { app }))).toBe(
      "validation_failed",
    );
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { ids: [1, 1] }), { app }))).toBe(
      "validation_failed",
    );
    expect(
      await errorCode(await apiFetch("/api/approve", jsonInit("POST", { groupKey: "k" }), { app })),
    ).toBe("validation_failed");
  });

  it("approves a sender group by key and asOf", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2, {
      sender: "group@example.com",
      action: "archive",
      confidence: 0.9,
    });
    const groupKey = encodeGroupKey(acc.id, "group@example.com", "archive");
    const res = await apiFetch("/api/approve", jsonInit("POST", { groupKey, asOf: AS_OF }), { app });
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    for (const id of ids) expect((await getSuggestionRow(id))?.["final_action"]).toBe("archive");
  });

  it("rejects unsure groups, malformed keys and unknown accounts", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const unsure = encodeGroupKey(acc.id, "x@example.com", "unsure");
    expect(
      await errorCode(
        await apiFetch("/api/approve", jsonInit("POST", { groupKey: unsure, asOf: AS_OF }), { app }),
      ),
    ).toBe("validation_failed");
    expect(
      await errorCode(
        await apiFetch("/api/approve", jsonInit("POST", { groupKey: "bad", asOf: AS_OF }), { app }),
      ),
    ).toBe("validation_failed");
    const unknown = encodeGroupKey("acc_ffffffffffffffff", "x@example.com", "delete");
    const res = await apiFetch("/api/approve", jsonInit("POST", { groupKey: unknown, asOf: AS_OF }), { app });
    expect(res.status).toBe(404);
  });

  it("logs request.error with the Hono route pattern on an unexpected provider error", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = new FakeProvider({ failWith: { trash: new TypeError("boom") } });
    const app = createApp({ now: () => SEED_NOW, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const res = await apiFetch("/api/approve", jsonInit("POST", { ids }), { app });
    expect((await readJson<ActionResponse>(res)).results[0]).toMatchObject({
      outcome: "retry_later",
      error: "unknown",
    });
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"evt":"request.error"'));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ route: "/api/approve", errorName: "TypeError" });
    spy.mockRestore();
  });

  it("answers 429 budget_exhausted at the daily cap", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    await budgetDeltaStmt(env.DB, AS_OF.slice(0, 10), { rowsWritten: 95_000 }, SEED_NOW).run();
    const res = await apiFetch("/api/approve", jsonInit("POST", { ids }), { app });
    expect(res.status).toBe(429);
    expect(await readJson<ApiErrorBody>(res)).toEqual({
      error: {
        code: "budget_exhausted",
        message: "Daily database write budget reached",
        retryAt: "2026-10-16T00:00:00.000Z",
      },
    });
    await budgetDeltaStmt(env.DB, AS_OF.slice(0, 10), { rowsWritten: -95_000 }, SEED_NOW).run();
  });
});

describe("POST /api/override", () => {
  it("executes the owner's action", async () => {
    const { app, fake } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1, { action: "delete" });
    const res = await apiFetch("/api/override", jsonInit("POST", { ids, action: "keep" }), { app });
    expect((await readJson<ActionResponse>(res)).results[0]).toMatchObject({
      outcome: "executed",
      action: "keep",
    });
    expect(fake.calls).toEqual([]);
    expect(
      await errorCode(await apiFetch("/api/override", jsonInit("POST", { ids, action: "unsure" }), { app })),
    ).toBe("validation_failed");
  });
});

describe("Clean up", () => {
  it("previews counts, groups and groups left with keep excluded by default", async () => {
    const { app } = setup();
    const acc = await previewAccount();
    const res = await apiFetch(`/api/cleanup/preview?accountId=${acc.id}`, {}, { app });
    expect(await readJson<CleanupPreview>(res)).toEqual({
      asOf: AS_OF,
      threshold: 0.8,
      defaultThreshold: 0.8,
      count: 2,
      byAction: { delete: 1, archive: 1, keep: 0 },
      groups: 2,
      groupsLeft: 3,
    });
  });

  it("previews Confirm all keeps and rejects keep mixed with other actions", async () => {
    const { app } = setup();
    const acc = await previewAccount();
    const keeps = await readJson<CleanupPreview>(
      await apiFetch(`/api/cleanup/preview?accountId=${acc.id}&actions=keep&threshold=0.5`, {}, { app }),
    );
    expect(keeps).toMatchObject({
      threshold: 0.5,
      count: 1,
      byAction: { delete: 0, archive: 0, keep: 1 },
      groups: 1,
      groupsLeft: 3,
    });
    const mixed = await apiFetch(`/api/cleanup/preview?actions=delete,keep`, {}, { app });
    expect(await errorCode(mixed)).toBe("validation_failed");
  });

  it("executes Clean up at the threshold and reports remaining", async () => {
    const { app, fake } = setup();
    const acc = await previewAccount();
    const res = await apiFetch("/api/cleanup", jsonInit("POST", { accountId: acc.id, asOf: AS_OF }), { app });
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash", "archive"]);
    const mixed = await apiFetch(
      "/api/cleanup",
      jsonInit("POST", { actions: ["keep", "delete"], asOf: AS_OF }),
      { app },
    );
    expect(await errorCode(mixed)).toBe("validation_failed");
    const keeps = await apiFetch(
      "/api/cleanup",
      jsonInit("POST", { accountId: acc.id, actions: ["keep"], threshold: 0.5, asOf: AS_OF }),
      { app },
    );
    expect((await readJson<ActionResponse>(keeps)).executed).toBe(1);
  });
});
