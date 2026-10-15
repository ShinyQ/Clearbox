import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { createGmailProvider } from "../../src/providers/google/gmail.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { gmailHandlers } from "../msw/gmail.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;
let provider: MailProvider;

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...gmailHandlers(box));
  provider = createGmailProvider({ fetch: (input, init) => fetch(input, init), tokens, now: () => NOW });
});

describe("GmailProvider.syncChanges", () => {
  it("reports caughtUp with no changes", async () => {
    box.addMessage();
    const { incrementalCursor } = await provider.bootstrap();
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page).toEqual({
      added: [],
      removedIds: [],
      sent: [],
      nextCursor: incrementalCursor,
      caughtUp: true,
    });
  });

  it("collects new inbox mail, sent mail and removals (archive, trash, delete)", async () => {
    const kept = box.addMessage();
    const archived = box.addMessage();
    const trashed = box.addMessage();
    const deleted = box.addMessage();
    const { incrementalCursor } = await provider.bootstrap();
    const fresh = box.addMessage();
    box.addMessage({ folder: "sent", to: ["friend@example.com"] });
    box.move(archived.id, "archive");
    box.move(trashed.id, "trash");
    box.move(deleted.id, null);
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(page.sent).toEqual([
      {
        threadId: "thr0006",
        recipients: ["friend@example.com"],
        sentAt: box.messages.get("msg0006")?.receivedAt,
      },
    ]);
    expect(page.removedIds.sort()).toEqual([archived.id, deleted.id, trashed.id].sort());
    expect(page.caughtUp).toBe(true);
    expect(JSON.parse(page.nextCursor)).toEqual({
      v: 1,
      historyId: String(1000 + box.seq),
      catchupAfter: null,
      catchupPageToken: null,
    });
    expect(kept.folder).toBe("inbox");
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(1);
    expect(box.maxInFlight).toBe(1);
  });

  it("stops at maxMessages and resumes from the last processed record", async () => {
    const { incrementalCursor } = await provider.bootstrap();
    for (let i = 0; i < 5; i++) box.addMessage();
    const added: string[] = [];
    let cursor = incrementalCursor;
    let calls = 0;
    for (;;) {
      const page = await provider.syncChanges(cursor, 2);
      expect(page.added.length).toBeLessThanOrEqual(2);
      added.push(...page.added.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      calls++;
      if (page.caughtUp) break;
    }
    expect(added).toEqual(["msg0001", "msg0002", "msg0003", "msg0004", "msg0005"]);
    expect(calls).toBe(3);
  });

  it("throws CursorExpiredError when history returns 404", async () => {
    const { incrementalCursor } = await provider.bootstrap();
    box.addMessage();
    box.expireCursors();
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toMatchObject({
      name: "CursorExpiredError",
      provider: "gmail",
      cursorKind: "incremental",
    });
  });

  it("follows a history page that has a nextPageToken without claiming caughtUp", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () =>
        HttpResponse.json({
          history: [
            {
              id: "2001",
              messagesAdded: [{ message: { id: a.id, threadId: a.threadId, labelIds: ["INBOX", "UNREAD"] } }],
            },
            {
              id: "2002",
              messagesAdded: [{ message: { id: "draft01", threadId: "draft01", labelIds: ["DRAFT"] } }],
            },
            {
              id: "2003",
              labelsAdded: [{ message: { id: b.id, threadId: b.threadId }, labelIds: ["TRASH"] }],
            },
          ],
          nextPageToken: "h2003",
          historyId: "2100",
        }),
      ),
    );
    const page = await provider.syncChanges(
      JSON.stringify({ v: 1, historyId: "2000", catchupAfter: null, catchupPageToken: null }),
      25,
    );
    expect(page.added.map((m) => m.providerMessageId)).toEqual([a.id]);
    expect(page.removedIds).toEqual([b.id]);
    expect(page.caughtUp).toBe(false);
    expect(JSON.parse(page.nextCursor)).toMatchObject({ historyId: "2003" });
  });

  it("lets a removal win over an add of the same id within one page", async () => {
    const { incrementalCursor } = await provider.bootstrap();
    const bounced = box.addMessage();
    box.move(bounced.id, "trash");
    box.move(bounced.id, "inbox");
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page.added).toEqual([]);
    expect(page.removedIds).toEqual([bounced.id]);
    expect(page.caughtUp).toBe(true);
    expect(box.requests).not.toContain("POST /batch/gmail/v1");
  });

  it("rejects a history response without a historyId", async () => {
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () => HttpResponse.json({})),
    );
    await expect(
      provider.syncChanges(
        JSON.stringify({ v: 1, historyId: "2000", catchupAfter: null, catchupPageToken: null }),
        25,
      ),
    ).rejects.toMatchObject({ name: "ProviderResponseError", provider: "gmail" });
  });
});

describe("GmailProvider.resyncCursor", () => {
  it("takes a fresh historyId and drains a catch-up list after the watermark first", async () => {
    const old = box.addMessage();
    const newer1 = box.addMessage();
    const newer2 = box.addMessage();
    const cursor = await provider.resyncCursor(old.receivedAt);
    expect(JSON.parse(cursor)).toEqual({
      v: 1,
      historyId: String(1000 + box.seq),
      catchupAfter: Math.floor(old.receivedAt / 1000) - 1,
      catchupPageToken: null,
    });
    const first = await provider.syncChanges(cursor, 25);
    expect(first.added.map((m) => m.providerMessageId)).toEqual([newer2.id, newer1.id, old.id]);
    expect(first.caughtUp).toBe(false);
    expect(box.requests.some((r) => r === "GET /gmail/v1/users/me/messages")).toBe(true);
    const fresh = box.addMessage();
    const second = await provider.syncChanges(first.nextCursor, 25);
    expect(second.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(second.caughtUp).toBe(true);
  });

  it("pages the catch-up list", async () => {
    const watermark = box.addMessage().receivedAt;
    for (let i = 0; i < 3; i++) box.addMessage();
    const cursor = await provider.resyncCursor(watermark);
    const first = await provider.syncChanges(cursor, 2);
    expect(JSON.parse(first.nextCursor)).toMatchObject({ catchupPageToken: "p2" });
    const second = await provider.syncChanges(first.nextCursor, 2);
    expect(JSON.parse(second.nextCursor)).toMatchObject({ catchupAfter: null, catchupPageToken: null });
    expect([...first.added, ...second.added]).toHaveLength(4);
  });

  it("skips catch-up without a watermark", async () => {
    expect(JSON.parse(await provider.resyncCursor(null))).toMatchObject({ catchupAfter: null });
  });
});
