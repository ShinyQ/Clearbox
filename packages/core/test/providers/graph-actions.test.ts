import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ClearboxError, ProviderRateLimitError } from "../../src/model/errors.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import batchMoveMixed from "../fixtures/graph/batch-move-mixed.json" with { type: "json" };
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { graphHandlers } from "../msw/graph.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;

function makeProvider(archiveFolderId: string | null = "folder-archive-0001"): MailProvider {
  return createGraphProvider({
    fetch: (input, init) => fetch(input, init),
    tokens,
    now: () => NOW,
    archiveFolderId,
  });
}

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...graphHandlers(box));
});

describe("GraphProvider.trash / archive / restore", () => {
  it("moves to deleteditems, the archive folder and inbox, keeping immutable ids", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    const provider = makeProvider();
    expect(await provider.trash([a.id])).toEqual([{ id: a.id, ok: true, newId: a.id }]);
    expect(await provider.archive([b.id])).toEqual([{ id: b.id, ok: true, newId: b.id }]);
    expect([a.folder, b.folder]).toEqual(["trash", "archive"]);
    expect(
      await provider.restore([
        { id: a.id, from: "trash" },
        { id: b.id, from: "archive" },
      ]),
    ).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["inbox", "inbox"]);
  });

  it("returns archive_unavailable without any request when no archive folder was resolved", async () => {
    const a = box.addMessage();
    expect(await makeProvider(null).archive([a.id])).toEqual([
      { id: a.id, ok: false, error: "archive_unavailable", retryAfterMs: null },
    ]);
    expect(box.requests).toEqual([]);
  });

  it("splits 25 moves into two $batch requests", async () => {
    const ids = Array.from({ length: 25 }, () => box.addMessage().id);
    const results = await makeProvider().trash(ids);
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /$batch")).toHaveLength(2);
  });

  it("correlates out-of-order sub-responses by id: new id, throttled and missing", async () => {
    server.use(http.post("https://graph.microsoft.com/v1.0/$batch", () => HttpResponse.json(batchMoveMixed)));
    const results = await makeProvider().trash(["AAkALg-A", "AAkALg-B", "AAkALg-C"]);
    expect(results).toEqual([
      { id: "AAkALg-A", ok: true, newId: "AAkALg-Fake-New-0" },
      { id: "AAkALg-B", ok: false, error: "rate_limited", retryAfterMs: 10_000 },
      { id: "AAkALg-C", ok: false, error: "not_found", retryAfterMs: null },
    ]);
  });

  it("reports unknown for a sub-response that is missing", async () => {
    server.use(
      http.post("https://graph.microsoft.com/v1.0/$batch", () => HttpResponse.json({ responses: [] })),
    );
    expect(await makeProvider().trash(["AAkALg-A"])).toEqual([
      { id: "AAkALg-A", ok: false, error: "unknown", retryAfterMs: null },
    ]);
  });

  it("throws on a whole-batch 429 and refuses more than 100 ids", async () => {
    box.failNext({ method: "POST", path: "/$batch", status: 429, headers: { "Retry-After": "3" } });
    await expect(makeProvider().trash(["AAkALg-A"])).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 3000,
    });
    await expect(
      makeProvider().trash(Array.from({ length: 101 }, (_, i) => `id${String(i)}`)),
    ).rejects.toBeInstanceOf(ClearboxError);
  });

  it("refreshes the token once and retries only the sub-requests that came back 401", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    box.failNext({ method: "POST", path: `/me/messages/${b.id}/move`, status: 401 });
    expect(await makeProvider().trash([a.id, b.id])).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect(tokens.refreshes).toBe(1);
    expect(box.requests.filter((r) => r.startsWith("part:"))).toEqual([
      `part:POST /me/messages/${a.id}/move`,
      `part:POST /me/messages/${b.id}/move`,
      `part:POST /me/messages/${b.id}/move`,
    ]);
    expect(box.maxInFlight).toBe(1);
  });

  it("throws ProviderAuthError when a sub-request is still 401 after the refresh", async () => {
    const a = box.addMessage();
    box.failNext({ method: "POST", path: `/me/messages/${a.id}/move`, status: 401, times: 2 });
    await expect(makeProvider().trash([a.id])).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "unauthorized",
    });
    expect(tokens.refreshes).toBe(1);
  });

  it("sends the immutable id preference on every sub-request", async () => {
    const a = box.addMessage();
    await makeProvider().trash([a.id]);
    expect(box.preferHeaders).toHaveLength(2);
    expect(box.preferHeaders.every((p) => p.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("ProviderRateLimitError is exported for callers", () => {
    expect(new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 1 })).toBeInstanceOf(
      ClearboxError,
    );
  });
});
