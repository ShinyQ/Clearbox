import { CLEARBOX_NOTE_SENDER, FakeEngine } from "@clearbox/core";
import { FakeMailbox, gmailHandlers } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, DAY, MINUTE, NOW, count, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

afterEach(expectNoUnhandled);

const tick = () => runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
const stored = (id: string) => count("messages", "account_id = ?1 AND provider_msg_id = ?2", ACCOUNT_A, id);

/** Contracts 12.8: the weekly reminder note Clearbox adds to the inbox is never ingested. */
describe("runTick: Clearbox's own inbox notes are never ingested", () => {
  beforeEach(resetDb);

  it("Graph incremental: drops the note and ingests the rest of the page", async () => {
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: [
        mail(1, { receivedAt: NOW - MINUTE, from: CLEARBOX_NOTE_SENDER, fromName: "Clearbox" }),
        mail(2, { receivedAt: NOW - 2 * DAY }),
      ],
      removed: [],
      next: "inbox-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "incremental" });

    expect(await tick()).toMatchObject({ outcome: "processed", kind: "incremental", fetched: 2, decided: 1 });
    expect(await stored("msg-001")).toBe(0);
    expect(await stored("msg-002")).toBe(1);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(1);
  });

  it("Graph inbox backfill: drops the note from a backfill page", async () => {
    const mock = new ProviderMock();
    mock.inbox = [
      mail(1, { receivedAt: NOW - MINUTE, from: CLEARBOX_NOTE_SENDER.toUpperCase() }),
      mail(2, { receivedAt: NOW - 5 * DAY }),
      mail(3, { receivedAt: NOW - 6 * DAY }),
    ];
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });

    expect(await tick()).toMatchObject({ kind: "inbox_backfill", fetched: 3, decided: 2 });
    expect(await stored("msg-001")).toBe(0);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(2);
  });

  it("Gmail incremental: drops the inserted note (From header) and ingests the rest", async () => {
    const box = new FakeMailbox();
    box.validAccessToken = "g-access-2";
    box.addMessage({
      id: "note-1",
      receivedAt: NOW - MINUTE,
      fromName: "Clearbox",
      fromAddress: CLEARBOX_NOTE_SENDER,
    });
    box.addMessage({ id: "fresh-1", receivedAt: NOW - 2 * DAY });
    useNetwork(gmailHandlers(box));
    await seedTickAccount({ provider: "gmail", phase: "incremental", accessToken: "g-access-2" });

    expect(await tick()).toMatchObject({ outcome: "processed", kind: "incremental", fetched: 2, decided: 1 });
    expect(await stored("note-1")).toBe(0);
    expect(await stored("fresh-1")).toBe(1);
  });
});
