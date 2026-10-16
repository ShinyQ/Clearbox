import { CursorExpiredError, FakeEngine, POLL_INTERVAL_MS, ProviderResponseError } from "@clearbox/core";
import type { ChangesPage, InboxPage, MailProvider, SentPage } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TickAccountRow } from "../../../src/worker/scan/claim.ts";
import { fetchPage } from "../../../src/worker/scan/fetch.ts";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A,
  DAY,
  NOW,
  count,
  getAccount,
  graphCursor,
  one,
  resetDb,
  seedMessage,
  seedTickAccount,
} from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

describe("runTick: incremental", () => {
  beforeEach(resetDb);

  it("resyncs an expired cursor, ingests added mail, applies sent items and dismisses removed mail", async () => {
    const mock = new ProviderMock();
    mock.expiredTokens.add("expired-inbox");
    mock.inboxDelta.set("resync-inbox", {
      added: [
        mail(1, { from: "alice@example.net", conversationId: "conv-a" }),
        mail(2, { listUnsubscribe: true }),
      ],
      removed: ["gone-1"],
      next: "inbox-2",
    });
    mock.sentDelta.set("resync-sent", {
      items: [{ conversationId: "conv-x", to: ["alice@example.net"], sentAt: NOW - DAY }],
      next: "sent-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({
      phase: "incremental",
      incrementalCursor: graphCursor("expired-inbox", "sent-1", NOW - 2 * DAY),
      watermark: NOW - 2 * DAY,
    });
    const gone = await seedMessage(ACCOUNT_A, { providerId: "gone-1" });

    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });

    expect(report).toMatchObject({
      outcome: "processed",
      kind: "incremental",
      fetched: 2,
      decided: 2,
      removed: 1,
      errorCode: null,
    });
    const since = new Date(NOW - 2 * DAY).toISOString();
    expect(mock.resyncFilters.inbox).toEqual([expect.stringContaining(since)]);
    expect(mock.resyncFilters.sent).toEqual([expect.stringContaining(since)]);
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", gone)).toEqual({
      status: "dismissed",
    });
    expect(
      await count("correspondents", "account_id = ?1 AND address = 'alice@example.net'", ACCOUNT_A),
    ).toBe(1);
    expect(
      await one(
        "SELECT s.ceiling FROM suggestions s JOIN messages m ON m.id = s.message_id WHERE m.account_id = ?1 AND m.provider_msg_id = 'msg-001'",
        ACCOUNT_A,
      ),
    ).toEqual({ ceiling: "keep" });
    const account = await getAccount(ACCOUNT_A);
    expect(account.incremental_cursor).toContain("inbox-2");
    expect(account).toMatchObject({
      last_incremental_at: NOW,
      next_tick_at: NOW + POLL_INTERVAL_MS,
      phase: "incremental",
    });
    expect(mock.calls).toContain("GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta");
  });

  it("skips a delta update of an already stored message: no new row and no Decision-1 call", async () => {
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [mail(1, { listUnsubscribe: true }), mail(2, { listUnsubscribe: true })],
      removed: [],
      next: "inbox-2",
    });
    const decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "incremental" });
    await seedMessage(ACCOUNT_A, { providerId: "msg-001" });

    const report = await runTick(env, { trigger: "cron", now: NOW });

    expect(report).toMatchObject({
      outcome: "processed",
      kind: "incremental",
      fetched: 2,
      skippedKnown: 1,
      decided: 1,
      errorCode: null,
    });
    expect(decision.calls).toBe(1);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(2);
    expect(await count("messages", "account_id = ?1 AND provider_msg_id = 'msg-001'", ACCOUNT_A)).toBe(1);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(2);
    expect(await one("SELECT SUM(seen_count) AS n FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual({
      n: 1,
    });
  });

  it("resyncs from the watermark when the stored delta link points at a lookalike host", async () => {
    const mock = new ProviderMock();
    useNetwork(mock.handlers());
    const lookalike = JSON.stringify({
      v: 1,
      inboxDeltaLink:
        "https://graph.microsoft.com.example.net/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x",
      sentDeltaLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=sent-1",
      watermark: new Date(NOW - 2 * DAY).toISOString(),
    });
    await seedTickAccount({ phase: "incremental", incrementalCursor: lookalike, watermark: NOW - 2 * DAY });

    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });

    expect(report).toMatchObject({ outcome: "processed", kind: "incremental", fetched: 0, errorCode: null });
    const account = await getAccount(ACCOUNT_A);
    expect(account.incremental_cursor).toContain("resync-inbox");
    expect(account.incremental_cursor).toContain("resync-sent");
    expect(account.incremental_cursor).not.toContain("example.net");
    expect(mock.calls.some((c) => c.includes("example.net"))).toBe(false);
    expect(mock.calls).toContain("GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta");
    const since = new Date(NOW - 2 * DAY).toISOString();
    expect(mock.resyncFilters.inbox).toEqual([expect.stringContaining(since)]);
    expect(mock.resyncFilters.sent).toEqual([expect.stringContaining(since)]);
  });
});

const EMPTY_CHANGES: ChangesPage = {
  added: [],
  removedIds: [],
  sent: [],
  nextCursor: "after",
  caughtUp: true,
};

interface Script {
  sync?: (cursor: string) => ChangesPage;
  inbox?: (cursor: string | null) => InboxPage;
  sent?: (cursor: string | null) => SentPage;
}

/** A MailProvider whose fetch methods follow a script and record every call. */
function scriptedProvider(script: Script): { provider: MailProvider; calls: string[] } {
  const calls: string[] = [];
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const provider: MailProvider = {
    kind: "gmail",
    bootstrap: unexpected("bootstrap"),
    listInboxPage: async (cursor) => {
      calls.push(`inbox:${cursor ?? "null"}`);
      if (script.inbox === undefined) throw new Error("unexpected listInboxPage");
      return script.inbox(cursor);
    },
    listSentPage: async (cursor) => {
      calls.push(`sent:${cursor ?? "null"}`);
      if (script.sent === undefined) throw new Error("unexpected listSentPage");
      return script.sent(cursor);
    },
    syncChanges: async (cursor) => {
      calls.push(`sync:${cursor}`);
      if (script.sync === undefined) throw new Error("unexpected syncChanges");
      return script.sync(cursor);
    },
    resyncCursor: async (watermark) => {
      calls.push(`resync:${watermark ?? "null"}`);
      return "resynced";
    },
    inboxEstimate: async () => null,
    trash: unexpected("trash"),
    archive: unexpected("archive"),
    restore: unexpected("restore"),
  };
  return { provider, calls };
}

function row(over: Partial<TickAccountRow> = {}): TickAccountRow {
  return {
    sent_cursor: "stored-sent",
    backfill_cursor: "stored-backfill",
    incremental_cursor: "stored-incremental",
    watermark_received_at: NOW - DAY,
    page_size: 25,
    ...over,
  } as TickAccountRow;
}

const expired = (cursorKind: "backfill" | "sent" | "incremental") =>
  new CursorExpiredError({ provider: "gmail", cursorKind });
const refusedUrl = () => new ProviderResponseError({ provider: "outlook", status: 0 });

describe("fetchPage: expired and refused cursors", () => {
  it("resyncs once on Gmail's empty-history-page CursorExpiredError instead of looping", async () => {
    const { provider, calls } = scriptedProvider({
      sync: (cursor) => {
        if (cursor === "stored-incremental") throw expired("incremental");
        return EMPTY_CHANGES;
      },
    });
    const page = await fetchPage("incremental", provider, row());
    expect(page).toMatchObject({ kind: "incremental", startCursor: "resynced", page: EMPTY_CHANGES });
    expect(calls).toEqual(["sync:stored-incremental", `resync:${NOW - DAY}`, "sync:resynced"]);
  });

  it("does not loop when the resynced cursor fails again", async () => {
    const { provider, calls } = scriptedProvider({
      sync: () => {
        throw expired("incremental");
      },
    });
    await expect(fetchPage("incremental", provider, row())).rejects.toBeInstanceOf(CursorExpiredError);
    expect(calls).toEqual(["sync:stored-incremental", `resync:${NOW - DAY}`, "sync:resynced"]);
  });

  it("treats a refused stored URL (status 0) like an expired cursor for every cursor kind", async () => {
    const inc = scriptedProvider({
      sync: (cursor) => {
        if (cursor === "stored-incremental") throw refusedUrl();
        return EMPTY_CHANGES;
      },
    });
    expect(await fetchPage("incremental", inc.provider, row())).toMatchObject({ startCursor: "resynced" });
    expect(inc.calls).toEqual(["sync:stored-incremental", `resync:${NOW - DAY}`, "sync:resynced"]);

    const sent = scriptedProvider({
      sent: (cursor) => {
        if (cursor !== null) throw refusedUrl();
        return { items: [], nextCursor: null };
      },
    });
    expect(await fetchPage("sent_backfill", sent.provider, row())).toMatchObject({ kind: "sent_backfill" });
    expect(sent.calls).toEqual(["sent:stored-sent", "sent:null"]);

    const inbox = scriptedProvider({
      inbox: (cursor) => {
        if (cursor !== null) throw refusedUrl();
        return { messages: [], nextCursor: null };
      },
    });
    expect(await fetchPage("inbox_backfill", inbox.provider, row())).toMatchObject({
      kind: "inbox_backfill",
    });
    expect(inbox.calls).toEqual(["inbox:stored-backfill", "inbox:null"]);
  });

  it("rethrows other provider response errors and refusals of an already-null backfill cursor", async () => {
    const other = scriptedProvider({
      sync: () => {
        throw new ProviderResponseError({ provider: "outlook", status: 500 });
      },
    });
    await expect(fetchPage("incremental", other.provider, row())).rejects.toMatchObject({ status: 500 });
    expect(other.calls).toEqual(["sync:stored-incremental"]);

    const fromNull = scriptedProvider({
      inbox: () => {
        throw refusedUrl();
      },
    });
    await expect(
      fetchPage("inbox_backfill", fromNull.provider, row({ backfill_cursor: null })),
    ).rejects.toMatchObject({ status: 0 });
    expect(fromNull.calls).toEqual(["inbox:null"]);
  });
});
