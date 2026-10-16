import { beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError, ProviderResponseError } from "../../src/model/errors.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
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

describe("GraphProvider.syncChanges", () => {
  it("returns new inbox mail with headers, removals and sent items, then catches up", async () => {
    const leaving = box.addMessage();
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    box.requests.length = 0;
    const fresh = box.addMessage({ receivedAt: NOW + 60_000 });
    box.addMessage({ folder: "sent", to: ["friend@example.com"], receivedAt: NOW + 120_000 });
    box.move(leaving.id, "trash");
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(page.added[0]?.headers.listUnsubscribe).toBe("<https://shop.example.com/u/0002>");
    expect(page.removedIds).toEqual([leaving.id]);
    expect(page.sent).toEqual([
      { threadId: "thr0003", recipients: ["friend@example.com"], sentAt: NOW + 120_000 },
    ]);
    expect(page.caughtUp).toBe(true);
    expect(JSON.parse(page.nextCursor)).toMatchObject({ watermark: new Date(NOW + 60_000).toISOString() });
    expect(box.requests.slice(0, 2)).toEqual([
      "GET /me/mailFolders/inbox/messages/delta",
      "GET /me/mailFolders/sentitems/messages/delta",
    ]);
    expect(box.preferHeaders.some((p) => p.includes("odata.maxpagesize=25"))).toBe(true);
  });

  it("pages with maxMessages until caught up", async () => {
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    for (let i = 0; i < 5; i++) box.addMessage({ receivedAt: NOW + i });
    const ids: string[] = [];
    let cursor = incrementalCursor;
    let calls = 0;
    for (;;) {
      const page = await provider.syncChanges(cursor, 2);
      expect(page.added.length).toBeLessThanOrEqual(2);
      ids.push(...page.added.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      calls++;
      if (page.caughtUp) break;
    }
    expect(new Set(ids).size).toBe(5);
    expect(calls).toBe(3);
  });

  it("throws CursorExpiredError on syncStateNotFound and on 410 Gone", async () => {
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    box.addMessage();
    box.expireCursors();
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "incremental",
    });
    box.deltaExpiredStatus = 410;
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("never sends the token to a foreign host from a stored delta link", async () => {
    const cursor = JSON.stringify({
      v: 1,
      inboxDeltaLink: "https://graph.microsoft.com.example.net/v1.0/me/mailFolders/inbox/messages/delta",
      sentDeltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta",
      watermark: new Date(NOW).toISOString(),
    });
    await expect(makeProvider().syncChanges(cursor, 25)).rejects.toBeInstanceOf(ProviderResponseError);
    expect(box.requests).toEqual([]);
  });
});

describe("GraphProvider.resyncCursor", () => {
  it("makes no request and re-reads everything received since the watermark", async () => {
    const t = Date.UTC(2026, 9, 12);
    box.addMessage({ receivedAt: t - 60_000 });
    const after1 = box.addMessage({ receivedAt: t });
    const after2 = box.addMessage({ receivedAt: t + 60_000 });
    const provider = makeProvider();
    const cursor = await provider.resyncCursor(t);
    expect(box.requests).toEqual([]);
    expect(JSON.parse(cursor)).toMatchObject({ v: 1, watermark: new Date(t).toISOString() });
    const page = await provider.syncChanges(cursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([after2.id, after1.id]);
    expect(page.caughtUp).toBe(true);
    box.addMessage({ receivedAt: t + 120_000 });
    const next = await provider.syncChanges(page.nextCursor, 25);
    expect(next.added).toHaveLength(1);
  });

  it("uses now when the watermark is null", async () => {
    expect(JSON.parse(await makeProvider().resyncCursor(null))).toMatchObject({
      watermark: new Date(NOW).toISOString(),
    });
  });
});
