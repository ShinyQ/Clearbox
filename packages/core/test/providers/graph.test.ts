import { beforeEach, describe, expect, it } from "vitest";
import {
  ProviderAuthError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../src/model/errors.ts";
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

describe("GraphProvider.bootstrap", () => {
  it("reads /me, resolves the archive folder and starts both delta links", async () => {
    box.addMessage();
    const result = await makeProvider().bootstrap();
    expect(result).toMatchObject({
      email: "owner@example.test",
      providerUserId: "graph-user-0001",
      aliases: [],
      archiveFolderId: "folder-archive-0001",
    });
    const cursor = JSON.parse(result.incrementalCursor) as Record<string, string>;
    expect(cursor.v).toBe(1);
    expect(cursor.watermark).toBe("2026-10-15T12:00:00.000Z");
    expect(cursor.inboxDeltaLink).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta\?\$deltatoken=/,
    );
    expect(cursor.sentDeltaLink).toMatch(/sentitems\/messages\/delta\?\$deltatoken=/);
    expect(box.requests).toEqual([
      "GET /me",
      "GET /me/mailFolders/archive",
      "GET /me/mailFolders/inbox/messages/delta",
      "GET /me/mailFolders/sentitems/messages/delta",
    ]);
    expect(box.preferHeaders.every((p) => p.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("falls back to userPrincipalName when mail is null", async () => {
    box.graphMail = null;
    expect((await makeProvider().bootstrap()).email).toBe("owner@example.test");
  });

  it("creates an Archive folder when the well-known folder is missing", async () => {
    box.archiveFolder = "missing";
    expect((await makeProvider().bootstrap()).archiveFolderId).toBe("folder-archive-0001");
    expect(box.requests).toContain("POST /me/mailFolders");
  });

  it("returns archiveFolderId null when the folder cannot be created", async () => {
    box.archiveFolder = "uncreatable";
    expect((await makeProvider().bootstrap()).archiveFolderId).toBeNull();
  });

  it("fails the connect on a transient archive lookup error instead of disabling archive", async () => {
    box.failNext({ method: "GET", path: "/me/mailFolders/archive", status: 503 });
    await expect(makeProvider().bootstrap()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("GraphProvider.inboxEstimate", () => {
  it("returns totalItemCount and null on throttling", async () => {
    box.addMessage();
    box.addMessage({ folder: "archive" });
    const provider = makeProvider();
    expect(await provider.inboxEstimate()).toBe(1);
    box.failNext({ method: "GET", path: "/me/mailFolders/inbox", status: 429 });
    expect(await provider.inboxEstimate()).toBeNull();
  });
});

describe("GraphProvider.listInboxPage", () => {
  it("pages by receivedDateTime keyset without gaps or duplicates when times tie at the boundary", async () => {
    const t = Date.UTC(2026, 9, 10, 8);
    box.addMessage({ receivedAt: t + 3000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 1000 });
    const provider = makeProvider();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await provider.listInboxPage(cursor, 2);
      seen.push(...page.messages.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(box.inFolder("inbox").map((m) => m.id));
    expect(new Set(seen).size).toBe(5);
  });

  it("returns a sub-second tie group spanning a page boundary, filtering lt the next second", async () => {
    const t = Date.UTC(2026, 9, 10, 8);
    for (const offset of [3000, 2900, 2500, 2100, 1000]) box.addMessage({ receivedAt: t + offset });
    const urls: string[] = [];
    const provider = createGraphProvider({
      fetch: (input, init) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return fetch(input, init);
      },
      tokens,
      now: () => NOW,
      archiveFolderId: null,
    });
    const first = await provider.listInboxPage(null, 2);
    expect(JSON.parse(first.nextCursor ?? "null")).toMatchObject({ before: "2026-10-10T08:00:02Z" });
    const second = await provider.listInboxPage(first.nextCursor, 2);
    const filter = new URL(urls[urls.length - 1] ?? "").searchParams.get("$filter");
    expect(filter).toBe("receivedDateTime lt 2026-10-10T08:00:03Z");
    const third = await provider.listInboxPage(second.nextCursor, 2);
    expect(third.nextCursor).toBeNull();
    const seen = [first, second, third].flatMap((p) => p.messages.map((m) => m.providerMessageId));
    expect(seen).toEqual(["msg0001", "msg0002", "msg0003", "msg0004", "msg0005"]);
  });

  it("rejects a backfill cursor whose before is not a date", async () => {
    const cursor = JSON.stringify({ v: 1, before: "not-a-date", seenAtBefore: [] });
    await expect(makeProvider().listInboxPage(cursor, 2)).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "backfill",
    });
    expect(box.requests).toEqual([]);
  });

  it("encodes the backfill cursor as {v:1,before,seenAtBefore}", async () => {
    const t = Date.UTC(2026, 9, 10, 8);
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 1000 });
    box.addMessage({ receivedAt: t });
    const page = await makeProvider().listInboxPage(null, 2);
    expect(JSON.parse(page.nextCursor ?? "null")).toEqual({
      v: 1,
      before: "2026-10-10T08:00:01Z",
      seenAtBefore: ["msg0002"],
    });
  });

  it("maps list messages including internetMessageHeaders", async () => {
    box.addMessage({ id: "AAkALg-Mixed-CASE-01", starred: true, important: true, hasAttachments: true });
    const [msg] = (await makeProvider().listInboxPage(null, 25)).messages;
    expect(msg).toMatchObject({
      providerMessageId: "AAkALg-Mixed-CASE-01",
      starred: true,
      providerImportant: true,
      hasAttachments: true,
      attachmentsApprox: false,
      headers: { listUnsubscribe: "<https://shop.example.com/u/0001>" },
    });
    expect(msg?.webLink).toContain("AAkALg-Mixed-CASE-01");
  });

  it("fetches missing headers with $batch, 20 per request", async () => {
    for (let i = 0; i < 25; i++) box.addMessage({ headersOnList: false });
    const page = await makeProvider().listInboxPage(null, 25);
    expect(page.messages).toHaveLength(25);
    expect(page.messages.every((m) => m.headers.listUnsubscribe !== null)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /$batch")).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:GET /me/messages/"))).toHaveLength(25);
  });

  it("drops a message whose header fetch returns 404 and throws on a throttled sub-request", async () => {
    box.addMessage({ headersOnList: false });
    box.addMessage({ headersOnList: false });
    box.failNext({
      method: "GET",
      path: "/me/messages/msg0001",
      status: 404,
      body: { error: { code: "ErrorItemNotFound", message: "x" } },
    });
    const page = await makeProvider().listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002"]);
    box.failNext({
      method: "GET",
      path: "/me/messages/msg0002",
      status: 429,
      headers: { "Retry-After": "9" },
    });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 9000,
    });
  });

  it("ignores malformed header entries from the $batch fallback", async () => {
    box.addMessage({ headersOnList: false });
    box.failNext({
      method: "GET",
      path: "/me/messages/msg0001",
      status: 200,
      body: {
        id: "msg0001",
        internetMessageHeaders: [42, { name: 7 }, { name: "List-Id", value: "<news.shop.example.com>" }],
      },
    });
    const [msg] = (await makeProvider().listInboxPage(null, 25)).messages;
    expect(msg?.headers).toMatchObject({ listId: "<news.shop.example.com>", listUnsubscribe: null });
  });

  it("refreshes once on a 401 header sub-response and retries only that sub-request", async () => {
    box.addMessage({ headersOnList: false });
    box.addMessage({ headersOnList: false });
    box.failNext({ method: "GET", path: "/me/messages/msg0001", status: 401 });
    const page = await makeProvider().listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002", "msg0001"]);
    expect(page.messages.every((m) => m.headers.listUnsubscribe !== null)).toBe(true);
    expect(tokens.refreshes).toBe(1);
    expect(box.requests.filter((r) => r === "POST /$batch")).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:GET /me/messages/msg0001"))).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:GET /me/messages/msg0002"))).toHaveLength(1);
  });

  it("throws ProviderAuthError when a header sub-request is 401 again after the refresh", async () => {
    box.addMessage({ headersOnList: false });
    box.failNext({ method: "GET", path: "/me/messages/msg0001", status: 401, times: 2 });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "unauthorized",
    });
    expect(tokens.refreshes).toBe(1);
  });

  it("refreshes once on 401", async () => {
    box.addMessage();
    tokens.current = "at-stale";
    expect((await makeProvider().listInboxPage(null, 25)).messages).toHaveLength(1);
    expect(tokens.refreshes).toBe(1);
  });

  it("throws ProviderAuthError after a second 401", async () => {
    box.failNext({ method: "GET", path: "/me/mailFolders/inbox/messages", status: 401, times: 2 });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("honors Retry-After on 429", async () => {
    box.failNext({
      method: "GET",
      path: "/me/mailFolders/inbox/messages",
      status: 429,
      headers: { "Retry-After": "10" },
    });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 10_000,
    });
  });

  it("never runs two requests at once", async () => {
    for (let i = 0; i < 5; i++) box.addMessage({ headersOnList: false });
    await makeProvider().listInboxPage(null, 25);
    expect(box.maxInFlight).toBe(1);
  });
});

describe("GraphProvider.listSentPage", () => {
  it("follows nextLink and maps recipients", async () => {
    box.addMessage({
      folder: "sent",
      to: ["Friend@Example.com"],
      cc: ["team@example.org"],
      bcc: ["hidden@example.net"],
    });
    box.addMessage({ folder: "sent", to: ["second@example.com"] });
    const provider = makeProvider();
    const first = await provider.listSentPage(null, 1);
    expect(first.items).toEqual([
      {
        threadId: "thr0002",
        recipients: ["second@example.com"],
        sentAt: box.messages.get("msg0002")?.receivedAt,
      },
    ]);
    expect(JSON.parse(first.nextCursor ?? "null")).toMatchObject({ v: 1 });
    const second = await provider.listSentPage(first.nextCursor, 1);
    expect(second.items[0]?.recipients).toEqual([
      "friend@example.com",
      "team@example.org",
      "hidden@example.net",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("maps a rejected nextLink to CursorExpiredError(sent)", async () => {
    const cursor = JSON.stringify({
      v: 1,
      nextLink: "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$skip=-1",
    });
    await expect(makeProvider().listSentPage(cursor, 100)).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "sent",
    });
  });

  it("never sends the token to a foreign host from a cursor", async () => {
    const cursor = JSON.stringify({ v: 1, nextLink: "https://evil.example.net/steal" });
    await expect(makeProvider().listSentPage(cursor, 100)).rejects.toBeInstanceOf(ProviderResponseError);
    expect(box.requests).toEqual([]);
  });
});
