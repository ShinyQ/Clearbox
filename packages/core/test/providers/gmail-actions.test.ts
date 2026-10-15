import { beforeEach, describe, expect, it } from "vitest";
import { ClearboxError, ProviderRateLimitError } from "../../src/model/errors.ts";
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

describe("GmailProvider.trash", () => {
  it("trashes through the batch endpoint and reports per-item results in input order", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    const results = await provider.trash([a.id, "missing01", b.id]);
    expect(results).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect(a.folder).toBe("trash");
    expect(box.requests).toEqual([
      "POST /batch/gmail/v1",
      "part:POST /gmail/v1/users/me/messages/msg0001/trash",
      "part:POST /gmail/v1/users/me/messages/missing01/trash",
      "part:POST /gmail/v1/users/me/messages/msg0002/trash",
    ]);
  });

  it("returns rate_limited with Retry-After for a throttled part", async () => {
    const a = box.addMessage();
    box.failNext({
      method: "POST",
      path: `/gmail/v1/users/me/messages/${a.id}/trash`,
      status: 429,
      headers: { "Retry-After": "5" },
    });
    expect(await provider.trash([a.id])).toEqual([
      { id: a.id, ok: false, error: "rate_limited", retryAfterMs: 5000 },
    ]);
  });

  it("splits more than 50 ids into several batch requests", async () => {
    const ids = Array.from({ length: 60 }, () => box.addMessage().id);
    const results = await provider.trash(ids);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(2);
  });

  it("refuses more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id${String(i)}`);
    await expect(provider.trash(ids)).rejects.toMatchObject({ code: "too_many_ids" });
    await expect(provider.trash(ids)).rejects.toBeInstanceOf(ClearboxError);
  });

  it("refreshes once when the batch parts come back 401", async () => {
    const a = box.addMessage();
    tokens.current = "at-stale";
    expect(await provider.trash([a.id])).toEqual([{ id: a.id, ok: true, newId: a.id }]);
    expect(tokens.refreshes).toBe(1);
  });
});

describe("GmailProvider.archive", () => {
  it("removes INBOX with one batchModify", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    expect(await provider.archive([a.id, b.id])).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["archive", "archive"]);
    expect(box.requests).toEqual(["POST /gmail/v1/users/me/messages/batchModify"]);
  });

  it("falls back to per-message modify when batchModify rejects an id", async () => {
    const a = box.addMessage();
    expect(await provider.archive([a.id, "missing01"])).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
    ]);
    expect(a.folder).toBe("archive");
  });

  it("throws on a whole-call rate limit", async () => {
    const a = box.addMessage();
    box.failNext({ method: "POST", path: "/gmail/v1/users/me/messages/batchModify", status: 429 });
    await expect(provider.archive([a.id])).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe("GmailProvider.restore", () => {
  it("untrashes and re-adds INBOX when untrash does not restore it", async () => {
    const a = box.addMessage();
    box.move(a.id, "trash");
    expect(await provider.restore([{ id: a.id, from: "trash" }])).toEqual([
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect(a.folder).toBe("inbox");
    expect(box.requests).toContain("POST /gmail/v1/users/me/messages/batchModify");
  });

  it("skips batchModify when untrash already restored INBOX", async () => {
    box.untrashRestoresInbox = true;
    const a = box.addMessage();
    box.move(a.id, "trash");
    expect(await provider.restore([{ id: a.id, from: "trash" }])).toEqual([
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect(box.requests).not.toContain("POST /gmail/v1/users/me/messages/batchModify");
  });

  it("restores archived mail with batchModify and keeps input order", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    box.move(a.id, "archive");
    box.move(b.id, "trash");
    const results = await provider.restore([
      { id: b.id, from: "trash" },
      { id: "missing01", from: "trash" },
      { id: a.id, from: "archive" },
    ]);
    expect(results).toEqual([
      { id: b.id, ok: true, newId: b.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["inbox", "inbox"]);
  });
});
