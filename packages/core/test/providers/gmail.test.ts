import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError, ProviderAuthError, ProviderUnavailableError } from "../../src/model/errors.ts";
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

function inboxIdsNewestFirst(): string[] {
  return box.inFolder("inbox").map((m) => m.id);
}

describe("GmailProvider.bootstrap", () => {
  it("reads the profile first, then sendAs aliases, and starts the history cursor", async () => {
    box.addMessage();
    const result = await provider.bootstrap();
    expect(result).toEqual({
      email: "owner@example.test",
      providerUserId: "owner@example.test",
      aliases: ["alias@example.test"],
      archiveFolderId: null,
      incrementalCursor: JSON.stringify({
        v: 1,
        historyId: "1001",
        catchupAfter: null,
        catchupPageToken: null,
      }),
    });
    expect(box.requests).toEqual([
      "GET /gmail/v1/users/me/profile",
      "GET /gmail/v1/users/me/settings/sendAs",
    ]);
  });
});

describe("GmailProvider.inboxEstimate", () => {
  it("returns INBOX messagesTotal with one request", async () => {
    box.addMessage();
    box.addMessage();
    box.addMessage({ folder: "archive" });
    expect(await provider.inboxEstimate()).toBe(2);
    expect(box.requests).toEqual(["GET /gmail/v1/users/me/labels/INBOX"]);
  });

  it("returns null on rate limit but throws on auth failure", async () => {
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/labels/INBOX", status: 429 });
    expect(await provider.inboxEstimate()).toBeNull();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/labels/INBOX", status: 401, times: 2 });
    await expect(provider.inboxEstimate()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("GmailProvider.listInboxPage", () => {
  it("pages the inbox newest first with labelIds=INBOX and one metadata batch per page", async () => {
    for (let i = 0; i < 5; i++) box.addMessage();
    box.addMessage({ folder: "archive" });
    box.addMessage({ folder: "sent" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await provider.listInboxPage(cursor, 2);
      seen.push(...page.messages.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(inboxIdsNewestFirst());
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(3);
    expect(box.maxInFlight).toBe(1);
  });

  it("splits metadata into batches of at most 50 parts", async () => {
    for (let i = 0; i < 60; i++) box.addMessage();
    const page = await provider.listInboxPage(null, 60);
    expect(page.messages).toHaveLength(60);
    const batches: number[] = [];
    for (const r of box.requests) {
      if (r === "POST /batch/gmail/v1") batches.push(0);
      else if (r.startsWith("part:")) batches[batches.length - 1] = (batches[batches.length - 1] ?? 0) + 1;
    }
    expect(batches).toEqual([50, 10]);
    expect(box.maxInFlight).toBe(1);
  });

  it("encodes the backfill cursor as {v:1,pageToken}", async () => {
    for (let i = 0; i < 3; i++) box.addMessage();
    const page = await provider.listInboxPage(null, 2);
    expect(page.nextCursor).toBe(JSON.stringify({ v: 1, pageToken: "p2" }));
  });

  it("maps metadata into MailMessage", async () => {
    box.addMessage({
      subject: "=?UTF-8?B?Q2Fmw6kgbmV3cw==?=",
      mimeType: "multipart/mixed",
      starred: true,
      headers: [
        { name: "Authentication-Results", value: "mx.google.com; spf=pass smtp.mailfrom=esp.example.net" },
      ],
    });
    const [msg] = (await provider.listInboxPage(null, 25)).messages;
    expect(msg).toMatchObject({
      providerMessageId: "msg0001",
      subject: "Café news",
      from: { address: "sender0001@shop.example.com", name: "Sender 0001" },
      hasAttachments: true,
      starred: true,
      category: "promotions",
      headers: { authenticationResults: "mx.google.com; spf=pass smtp.mailfrom=esp.example.net" },
    });
  });

  it("refreshes once on a 401 and retries", async () => {
    box.addMessage();
    tokens.current = "at-stale";
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages).toHaveLength(1);
    expect(tokens.refreshes).toBe(1);
  });

  it("throws ProviderAuthError after a second 401", async () => {
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages", status: 401, times: 2 });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "unauthorized",
    });
    expect(tokens.refreshes).toBe(1);
  });

  it("propagates a refresh failure unchanged", async () => {
    tokens.current = "at-stale";
    tokens.refreshError = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({ reason: "invalid_grant" });
  });

  it("refreshes once when every batch part is 401 (outer 200)", async () => {
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: /^\/gmail\/v1\/users\/me\/messages\/msg/, status: 401, times: 2 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages).toHaveLength(2);
    expect(tokens.refreshes).toBe(1);
  });

  it("refreshes when a retried part first turns 401 on its retry", async () => {
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 500 });
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 401 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002", "msg0001"]);
    expect(tokens.refreshes).toBe(1);
  });

  it("retries a rate-limited part once inside the same call", async () => {
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 429 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002", "msg0001"]);
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:")).slice(2)).toEqual([
      "part:GET /gmail/v1/users/me/messages/msg0001",
    ]);
  });

  it("throws ProviderRateLimitError when a part stays rate limited", async () => {
    box.addMessage();
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg0001",
      status: 403,
      headers: { "Retry-After": "7" },
      body: {
        error: {
          code: 403,
          message: "User Rate Limit Exceeded",
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      },
      times: 2,
    });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 7000,
    });
  });

  it("drops a part that stays 5xx while others succeed, and drops 404 parts without retry", async () => {
    box.addMessage();
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 500, times: 2 });
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0002", status: 404 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0003"]);
    expect(box.requests.filter((r) => r.startsWith("part:"))).toHaveLength(4);
  });

  it("throws ProviderUnavailableError when every part of a chunk fails", async () => {
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 503, times: 2 });
    await expect(provider.listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("drops messages that left INBOX between list and metadata", async () => {
    box.addMessage();
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg0001",
      status: 200,
      body: { id: "msg0001", threadId: "thr0001", labelIds: ["TRASH"] },
    });
    expect((await provider.listInboxPage(null, 25)).messages).toEqual([]);
  });

  it("maps a rejected page token to CursorExpiredError(backfill)", async () => {
    await expect(
      provider.listInboxPage(JSON.stringify({ v: 1, pageToken: "garbage" }), 25),
    ).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "backfill",
    });
    await expect(provider.listInboxPage("not json", 25)).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("maps a whole-call 429 with Retry-After", async () => {
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      status: 429,
      headers: { "Retry-After": "12" },
    });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 12_000,
    });
  });

  it("maps a network failure to ProviderUnavailableError", async () => {
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", () => HttpResponse.error()),
    );
    await expect(provider.listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("GmailProvider.listSentPage", () => {
  it("returns thread ids and lowercased To + Cc + Bcc recipients, paged", async () => {
    box.addMessage({
      folder: "sent",
      fromAddress: "owner@example.test",
      to: ["Friend@Example.com"],
      cc: ["team@example.org"],
      bcc: ["hidden@example.net"],
    });
    box.addMessage({ folder: "sent", fromAddress: "owner@example.test", to: ["friend@example.com"] });
    box.addMessage({ folder: "sent", fromAddress: "owner@example.test", to: ["third@example.com"] });
    const first = await provider.listSentPage(null, 2);
    expect(first.items).toEqual([
      {
        threadId: "thr0003",
        recipients: ["third@example.com"],
        sentAt: box.messages.get("msg0003")?.receivedAt,
      },
      {
        threadId: "thr0002",
        recipients: ["friend@example.com"],
        sentAt: box.messages.get("msg0002")?.receivedAt,
      },
    ]);
    const second = await provider.listSentPage(first.nextCursor, 2);
    expect(second.items[0]?.recipients).toEqual([
      "friend@example.com",
      "team@example.org",
      "hidden@example.net",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("maps a rejected sent page token to CursorExpiredError(sent)", async () => {
    await expect(
      provider.listSentPage(JSON.stringify({ v: 1, pageToken: "bad" }), 100),
    ).rejects.toMatchObject({
      cursorKind: "sent",
    });
  });
});
