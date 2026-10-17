import type { Reason } from "@clearbox/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, GroupDetail, Page, QueueSummary, SenderGroup } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import type { Account } from "../../../src/worker/db/accounts.ts";
import { encodeGroupKey } from "../../../src/worker/db/suggestions.ts";
import { apiFetch, readJson } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const app = createApp({ now: () => SEED_NOW });
const HOUR = 3_600_000;
let a: Account;
let b: Account;
let aDelete: number[];

beforeAll(async () => {
  a = await seedAccount({ provider: "gmail", email: "queue-a@example.com" });
  b = await seedAccount({ provider: "outlook", email: "queue-b@example.com" });
  aDelete = await seedSuggestions(a.id, 3, (i) => ({
    sender: "news@shop.example.com",
    action: "delete",
    confidence: [0.95, 0.9, 0.85][i] ?? 0.85,
    receivedAt: SEED_NOW - (i + 1) * 24 * HOUR,
    subject: `Deal ${i}`,
  }));
  await seedSuggestions(a.id, 2, {
    sender: "promo@deals.example.net",
    senderDomain: "example.net",
    action: "archive",
    confidence: 0.7,
  });
  await seedSuggestions(a.id, 1, {
    sender: "friend@example.org",
    senderDomain: "example.org",
    action: "keep",
    confidence: 0.8,
    subject: null,
  });
  await seedSuggestions(a.id, 1, { sender: "x@example.com", action: "unsure", confidence: 0.3 });
  await seedSuggestions(a.id, 1, { status: "awaiting_model" });
  await seedSuggestions(a.id, 1, { status: "executed", finalAction: "delete" });
  await seedSuggestions(b.id, 1, {
    sender: "news@shop.example.com",
    action: "delete",
    confidence: 0.99,
    webLink: "https://outlook.example.test/item/1",
  });
});

describe("GET /api/queue/summary", () => {
  it("counts pending suggestions, groups per action and the Clean up preview at tau", async () => {
    const res = await apiFetch("/api/queue/summary", {}, { app });
    expect(res.status).toBe(200);
    expect(await readJson<QueueSummary>(res)).toEqual({
      asOf: new Date(SEED_NOW).toISOString(),
      pending: { delete: 4, archive: 2, keep: 1, unsure: 1, total: 8 },
      awaitingModel: 1,
      recentHeld: 0,
      groups: 5,
      groupsByAction: { delete: 2, archive: 1, keep: 1, unsure: 1 },
      tauDelete: 0.8,
      cleanup: { threshold: 0.8, count: 4, byAction: { delete: 4, archive: 0, keep: 0 } },
    });
  });

  it("scopes to one account and returns zeros for unknown accounts", async () => {
    const one = await readJson<QueueSummary>(
      await apiFetch(`/api/queue/summary?accountId=${b.id}`, {}, { app }),
    );
    expect(one.pending).toEqual({ delete: 1, archive: 0, keep: 0, unsure: 0, total: 1 });
    const none = await readJson<QueueSummary>(
      await apiFetch("/api/queue/summary?accountId=acc_ffffffffffffffff", {}, { app }),
    );
    expect(none.pending.total).toBe(0);
    expect(none.groups).toBe(0);
  });
});

describe("GET /api/groups", () => {
  it("returns sender groups sorted by average confidence", async () => {
    const page = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups", {}, { app }));
    expect(page.items.map((g) => [g.accountId, g.sender, g.action])).toEqual([
      [b.id, "news@shop.example.com", "delete"],
      [a.id, "news@shop.example.com", "delete"],
      [a.id, "friend@example.org", "keep"],
      [a.id, "promo@deals.example.net", "archive"],
      [a.id, "x@example.com", "unsure"],
    ]);
    const group = page.items[1];
    expect(group).toMatchObject({
      key: encodeGroupKey(a.id, "news@shop.example.com", "delete"),
      provider: "gmail",
      senderName: "Shop News",
      domain: "example.com",
      count: 3,
      latestSubject: "Deal 0",
      ceilingApplied: false,
      topReasons: [{ code: "list_unsubscribe", text: "Has an unsubscribe link" }],
      newestReceivedAt: new Date(SEED_NOW - 24 * HOUR).toISOString(),
      oldestReceivedAt: new Date(SEED_NOW - 3 * 24 * HOUR).toISOString(),
    });
    expect(group?.confidence.min).toBeCloseTo(0.85, 9);
    expect(group?.confidence.avg).toBeCloseTo(0.9, 9);
    expect(group?.confidence.max).toBeCloseTo(0.95, 9);
    expect(page.items[2]?.latestSubject).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("pages with an opaque cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const page: Page<SenderGroup> = await readJson<Page<SenderGroup>>(
        await apiFetch(`/api/groups?limit=2${qs}`, {}, { app }),
      );
      seen.push(...page.items.map((g) => g.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it("filters by action and minimum confidence, and sorts by count", async () => {
    const archive = await readJson<Page<SenderGroup>>(
      await apiFetch("/api/groups?action=archive", {}, { app }),
    );
    expect(archive.items.map((g) => g.count)).toEqual([2]);
    const confident = await readJson<Page<SenderGroup>>(
      await apiFetch("/api/groups?minConfidence=0.9", {}, { app }),
    );
    expect(confident.items.map((g) => [g.accountId, g.count])).toEqual([
      [b.id, 1],
      [a.id, 2],
    ]);
    const byCount = await readJson<Page<SenderGroup>>(
      await apiFetch("/api/groups?sort=count_desc", {}, { app }),
    );
    expect(byCount.items[0]?.count).toBe(3);
  });

  it("rejects malformed cursors and cursors from other filters", async () => {
    const first = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups?limit=1", {}, { app }));
    const other = await apiFetch(
      `/api/groups?limit=1&action=delete&cursor=${first.nextCursor ?? ""}`,
      {},
      { app },
    );
    expect(other.status).toBe(400);
    expect((await readJson<ApiErrorBody>(other)).error.code).toBe("validation_failed");
    expect((await apiFetch("/api/groups?cursor=%25%25", {}, { app })).status).toBe(400);
    expect((await apiFetch("/api/groups?sort=random", {}, { app })).status).toBe(400);
  });
});

describe("GET /api/groups/:key", () => {
  it("returns the group and its items sorted by confidence, with paging", async () => {
    const key = encodeGroupKey(a.id, "news@shop.example.com", "delete");
    const first = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}?limit=2`, {}, { app }));
    expect(first.group.count).toBe(3);
    expect(first.items.items.map((i) => i.id)).toEqual([aDelete[0], aDelete[1]]);
    const item = first.items.items[0];
    expect(item).toMatchObject({
      accountId: a.id,
      provider: "gmail",
      status: "pending",
      action: "delete",
      confidence: 0.95,
      ceiling: "delete",
      ceilingApplied: false,
      from: { address: "news@shop.example.com", name: "Shop News" },
      subject: "Deal 0",
      snippet: "Synthetic snippet for tests",
      receivedAt: new Date(SEED_NOW - 24 * HOUR).toISOString(),
      isRead: false,
      reasons: [{ code: "list_unsubscribe", text: "Has an unsubscribe link" }],
      modelVersion: "fake/fake-1",
      policyVersion: 1,
    });
    expect(item?.signals.ageDays).toBe(1);
    expect(item?.distribution?.delete).toBeCloseTo(0.95, 9);
    expect(item?.deepLink).toMatch(
      /^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=queue-a%40example\.com#all\/msg-\d+$/,
    );
    const second = await readJson<GroupDetail>(
      await apiFetch(`/api/groups/${key}?limit=2&cursor=${first.items.nextCursor ?? ""}`, {}, { app }),
    );
    expect(second.items.items.map((i) => i.id)).toEqual([aDelete[2]]);
    expect(second.items.nextCursor).toBeNull();
  });

  it("uses the stored webLink for Outlook", async () => {
    const key = encodeGroupKey(b.id, "news@shop.example.com", "delete");
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app }));
    expect(detail.items.items[0]?.deepLink).toBe("https://outlook.example.test/item/1");
  });

  it("returns 400 for bad keys and 404 for unknown accounts or empty groups", async () => {
    expect((await apiFetch("/api/groups/not-a-key", {}, { app })).status).toBe(400);
    const unknown = encodeGroupKey("acc_ffffffffffffffff", "news@shop.example.com", "delete");
    expect((await apiFetch(`/api/groups/${unknown}`, {}, { app })).status).toBe(404);
    const empty = encodeGroupKey(a.id, "nobody@example.com", "delete");
    expect((await apiFetch(`/api/groups/${empty}`, {}, { app })).status).toBe(404);
  });
});

describe("stored reasons that core cannot render", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits unknown or malformed reasons from groups and group detail and logs only a count", async () => {
    const c = await seedAccount({ provider: "gmail", email: "queue-c@example.com" });
    const stored = [
      { code: "aaa_retired_code", params: {} },
      { code: "category", params: "Promotions" },
      { code: "list_unsubscribe", params: {} },
      { code: "bulk_mail" },
    ] as unknown as Reason[];
    await seedSuggestions(c.id, 1, { sender: "odd@example.com", reasons: stored });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const groupsRes = await apiFetch(`/api/groups?accountId=${c.id}`, {}, { app });
    expect(groupsRes.status).toBe(200);
    const groups = await readJson<Page<SenderGroup>>(groupsRes);
    expect(groups.items[0]?.topReasons).toEqual([
      { code: "bulk_mail", text: "Sent as bulk mail" },
      { code: "list_unsubscribe", text: "Has an unsubscribe link" },
    ]);

    const detailRes = await apiFetch(
      `/api/groups/${encodeGroupKey(c.id, "odd@example.com", "delete")}`,
      {},
      { app },
    );
    expect(detailRes.status).toBe(200);
    const detail = await readJson<GroupDetail>(detailRes);
    expect(detail.group.topReasons.map((r) => r.code)).toEqual(["bulk_mail", "list_unsubscribe"]);
    expect(detail.items.items[0]?.reasons).toEqual([
      { code: "list_unsubscribe", text: "Has an unsubscribe link" },
      { code: "bulk_mail", text: "Sent as bulk mail" },
    ]);

    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        evt: "request.error",
        route: "/api/groups",
        errorName: "InvalidStoredReason",
        skippedReasons: 2,
      }),
      expect.objectContaining({
        evt: "request.error",
        route: "/api/groups/:key",
        errorName: "InvalidStoredReason",
        skippedReasons: 4,
      }),
    ]);
    for (const line of lines) expect(line).not.toMatch(/aaa_retired_code|Promotions|@|odd/);
  });

  it("ignores bare-string reason elements instead of failing groups and group detail", async () => {
    const d = await seedAccount({ provider: "gmail", email: "queue-d@example.com" });
    const stored = ["bare-string", { code: "list_unsubscribe", params: {} }] as unknown as Reason[];
    await seedSuggestions(d.id, 1, { sender: "bare@example.com", reasons: stored });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const groupsRes = await apiFetch(`/api/groups?accountId=${d.id}`, {}, { app });
    expect(groupsRes.status).toBe(200);
    const groups = await readJson<Page<SenderGroup>>(groupsRes);
    expect(groups.items[0]?.topReasons).toEqual([
      { code: "list_unsubscribe", text: "Has an unsubscribe link" },
    ]);

    const detailRes = await apiFetch(
      `/api/groups/${encodeGroupKey(d.id, "bare@example.com", "delete")}`,
      {},
      { app },
    );
    expect(detailRes.status).toBe(200);
    const detail = await readJson<GroupDetail>(detailRes);
    expect(detail.group.topReasons.map((r) => r.code)).toEqual(["list_unsubscribe"]);
    expect(detail.items.items[0]?.reasons).toEqual([
      { code: "list_unsubscribe", text: "Has an unsubscribe link" },
    ]);
  });
});
