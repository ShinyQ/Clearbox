import { beforeAll, describe, expect, it } from "vitest";
import type { ActionResponse, CleanupPreview, QueueSummary } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import type { Account } from "../../../src/worker/db/accounts.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const AS_OF = new Date(SEED_NOW).toISOString();

// Storage is shared by the tests in this file: they run in order and build on each other.
const fake = new FakeProvider();
const app = createApp({ now: () => SEED_NOW, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
let reauth: Account;
let broken: Account;
let active: Account;
let paused: Account;
let activeIds: number[];
let pausedIds: number[];
let reauthKeep: number[];

beforeAll(async () => {
  reauth = await seedAccount({ status: "needs_reauth", email: "scope-reauth@example.com" });
  broken = await seedAccount({ status: "config_error", email: "scope-broken@example.com" });
  active = await seedAccount({ email: "scope-active@example.com" });
  paused = await seedAccount({ paused: true, email: "scope-paused@example.com" });
  // The inactive accounts' items outrank every active item and fill a whole 100-item Clean up page.
  await seedSuggestions(reauth.id, 100, { sender: "bulk@example.com", action: "delete", confidence: 0.99 });
  await seedSuggestions(broken.id, 5, { sender: "bulk@example.net", action: "archive", confidence: 0.98 });
  reauthKeep = await seedSuggestions(reauth.id, 1, {
    sender: "friend@example.org",
    action: "keep",
    confidence: 0.9,
  });
  activeIds = await seedSuggestions(active.id, 3, {
    sender: "news@example.com",
    action: "delete",
    confidence: 0.85,
  });
  pausedIds = await seedSuggestions(paused.id, 2, {
    sender: "promo@example.net",
    action: "archive",
    confidence: 0.82,
  });
});

describe("Clean up scope with inactive accounts", () => {
  it("leaves needs_reauth and config_error accounts out of the summary and preview counts", async () => {
    const summary = await readJson<QueueSummary>(await apiFetch("/api/queue/summary", {}, { app }));
    expect(summary.pending.total).toBe(111);
    expect(summary.cleanup).toEqual({
      threshold: 0.8,
      count: 5,
      byAction: { delete: 3, archive: 2, keep: 0 },
    });
    const preview = await readJson<CleanupPreview>(await apiFetch("/api/cleanup/preview", {}, { app }));
    expect(preview).toMatchObject({ count: 5, byAction: { delete: 3, archive: 2, keep: 0 }, groups: 2 });
    // Every group of the inactive accounts stays behind after this Clean up.
    expect(preview.groupsLeft).toBe(3);
    const one = await readJson<CleanupPreview>(
      await apiFetch(`/api/cleanup/preview?accountId=${reauth.id}`, {}, { app }),
    );
    expect(one).toMatchObject({ count: 0, byAction: { delete: 0, archive: 0, keep: 0 }, groups: 0 });
    const oneSummary = await readJson<QueueSummary>(
      await apiFetch(`/api/queue/summary?accountId=${broken.id}`, {}, { app }),
    );
    expect(oneSummary.pending.total).toBe(5);
    expect(oneSummary.cleanup.count).toBe(0);
  });

  it("keeps inactive accounts in scope for Confirm all keeps", async () => {
    const keeps = await readJson<CleanupPreview>(
      await apiFetch("/api/cleanup/preview?actions=keep&threshold=0.5", {}, { app }),
    );
    expect(keeps).toMatchObject({ count: 1, byAction: { delete: 0, archive: 0, keep: 1 } });
  });

  it("returns an empty scope for an inactive account id", async () => {
    const res = await readJson<ActionResponse>(
      await apiFetch("/api/cleanup", jsonInit("POST", { accountId: reauth.id, asOf: AS_OF }), { app }),
    );
    expect(res).toMatchObject({ executed: 0, retryLater: 0, remaining: 0, results: [] });
    expect(fake.calls).toEqual([]);
  });

  it("executes active and paused accounts' items on an all-accounts Clean up until nothing remains", async () => {
    const res = await readJson<ActionResponse>(
      await apiFetch("/api/cleanup", jsonInit("POST", { asOf: AS_OF }), { app }),
    );
    expect(res).toMatchObject({ executed: 5, retryLater: 0, failed: 0, skipped: 0, remaining: 0 });
    expect(res.results.map((r) => r.id).sort((x, y) => x - y)).toEqual(
      [...activeIds, ...pausedIds].sort((x, y) => x - y),
    );
    expect(fake.calls.map((c) => c.method).sort()).toEqual(["archive", "trash"]);
    const after = await readJson<CleanupPreview>(await apiFetch("/api/cleanup/preview", {}, { app }));
    expect(after.count).toBe(0);
  });

  it("confirms the inactive account's keeps without a provider call", async () => {
    const calls = fake.calls.length;
    const res = await readJson<ActionResponse>(
      await apiFetch("/api/cleanup", jsonInit("POST", { actions: ["keep"], threshold: 0.5, asOf: AS_OF }), {
        app,
      }),
    );
    expect(res).toMatchObject({ executed: 1, remaining: 0 });
    expect(res.results.map((r) => r.id)).toEqual(reauthKeep);
    expect(fake.calls).toHaveLength(calls);
    expect((await getSuggestionRow(reauthKeep[0] ?? 0))?.["decided_via"]).toBe("cleanup");
  });
});
