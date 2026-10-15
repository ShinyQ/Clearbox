import { describe, expect, it } from "vitest";
import { CursorExpiredError } from "../../../src/model/errors.ts";
import {
  GRAPH_DELTA_INBOX_SELECT,
  GRAPH_INBOX_SELECT,
  conversationDepth,
  decodeIncremental,
  graphRecipients,
  graphUrl,
  mapGraphMessage,
  mapGraphSentItem,
} from "../../../src/providers/microsoft/map.ts";
import type { GraphMessage } from "../../../src/providers/microsoft/types.ts";
import { makeGraphMessage } from "../../fixtures/builders.ts";
import newsletter from "../../fixtures/graph/message-newsletter.json" with { type: "json" };

describe("mapGraphMessage", () => {
  it("normalizes the newsletter fixture", () => {
    const msg = mapGraphMessage(newsletter as GraphMessage);
    expect(msg).toMatchObject({
      providerMessageId: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AFake-Newsletter-01",
      threadId: "AAQkAGI2Fake-Conv-01",
      internetMessageId: "<abc123@mail.shop.example.com>",
      receivedAt: Date.UTC(2026, 9, 14, 21, 3, 11),
      from: { address: "news@shop.example.com", name: "Shop" },
      to: ["owner@example.test"],
      cc: ["team@example.org"],
      deliveredTo: [],
      subject: "Big sale",
      snippet: "Our biggest sale of the year starts now",
      isRead: false,
      starred: true,
      providerImportant: true,
      category: "focused",
      hasAttachments: true,
      attachmentsApprox: false,
      threadDepth: 3,
      webLink: "https://outlook.office365.com/owa/?ItemID=AAkALgFake&exvsurl=1&viewmodel=ReadMessageItem",
      labels: [],
    });
    expect(msg.headers.listUnsubscribe).toBe("<https://shop.example.com/u/abc>");
    expect(msg.headers.authenticationResults).toContain("compauth=pass");
    expect(msg.headers.returnPath).toBe("bounce@esp.example.net");
    expect(Number.isFinite(msg.receivedAt)).toBe(true);
    const literal = mapGraphMessage(makeGraphMessage({ bodyPreview: `Tom &amp; Jerry ${"x".repeat(300)}` }));
    expect(literal.snippet.startsWith("Tom &amp; Jerry ")).toBe(true);
    expect([...literal.snippet].length).toBe(255);
  });

  it("keeps the case-sensitive immutable id verbatim", () => {
    expect(mapGraphMessage(makeGraphMessage({ id: "AAkALg-Mixed-CASE-id" })).providerMessageId).toBe(
      "AAkALg-Mixed-CASE-id",
    );
  });

  it("handles missing optional fields", () => {
    const msg = mapGraphMessage({ id: "AAkALg-min" });
    expect(msg).toMatchObject({
      threadId: null,
      receivedAt: 0,
      from: { address: null, name: null },
      subject: "",
      snippet: "",
      isRead: false,
      starred: false,
      category: null,
      threadDepth: null,
      webLink: null,
    });
    expect(msg.headers.authenticationResults).toBeNull();
    const malformed = mapGraphMessage(makeGraphMessage({ receivedDateTime: "not a date" }));
    expect(Number.isFinite(malformed.receivedAt)).toBe(true);
    expect(malformed.receivedAt).toBe(0);
  });

  it("decodes an encoded display name and subject defensively", () => {
    const msg = mapGraphMessage(
      makeGraphMessage({
        subject: "=?UTF-8?B?Q2Fmw6kgbmV3cw==?=",
        from: { emailAddress: { name: "=?ISO-8859-1?Q?Gr=FC=DFe?=", address: "greet@example.org" } },
      }),
    );
    expect(msg.subject).toBe("Café news");
    expect(msg.from.name).toBe("Grüße");
  });
});

describe("mapGraphSentItem", () => {
  it("uses To + Cc + Bcc and sentDateTime", () => {
    const item = mapGraphSentItem(
      makeGraphMessage({
        conversationId: "conv-1",
        sentDateTime: "2026-10-01T10:00:00Z",
        toRecipients: [{ emailAddress: { address: "A@Example.com" } }],
        ccRecipients: [{ emailAddress: { address: "a@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "b@example.org" } }],
      }),
    );
    expect(item).toEqual({
      threadId: "conv-1",
      recipients: ["a@example.com", "b@example.org"],
      sentAt: Date.UTC(2026, 9, 1, 10),
    });
  });
});

describe("conversationDepth", () => {
  it("computes (bytes - 22) / 5 + 1", () => {
    expect(conversationDepth("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==")).toBe(1);
    expect(conversationDepth("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")).toBe(3);
  });
  it("returns null for missing, short or malformed values", () => {
    expect(conversationDepth(undefined)).toBeNull();
    expect(conversationDepth("AQEBAQEBAQEBAQ==")).toBeNull();
    expect(conversationDepth("***")).toBeNull();
  });
});

describe("graphRecipients", () => {
  it("drops non-SMTP addresses", () => {
    expect(
      graphRecipients([{ emailAddress: { address: "/O=EXCHANGELABS/CN=X" } }, { emailAddress: {} }]),
    ).toEqual([]);
  });
});

describe("graphUrl and selects", () => {
  it("encodes values with %20 and keeps $ keys", () => {
    expect(
      graphUrl("/me/mailFolders/inbox/messages", { $filter: "receivedDateTime le 2026-10-01T00:00:00Z" }),
    ).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime%20le%202026-10-01T00%3A00%3A00Z",
    );
  });
  it("delta select is the inbox select without internetMessageHeaders", () => {
    expect(GRAPH_INBOX_SELECT.endsWith(",webLink,internetMessageHeaders")).toBe(true);
    expect(GRAPH_DELTA_INBOX_SELECT.includes("internetMessageHeaders")).toBe(false);
    expect(GRAPH_DELTA_INBOX_SELECT.includes("conversationIndex")).toBe(true);
  });
});

describe("decodeIncremental", () => {
  it("reads the Graph incremental cursor and rejects incomplete ones", () => {
    const state = {
      v: 1,
      inboxDeltaLink: "https://graph.microsoft.com/a",
      sentDeltaLink: "https://graph.microsoft.com/b",
      watermark: "2026-10-15T12:00:00.000Z",
    };
    expect(decodeIncremental(JSON.stringify(state))).toEqual(state);
    expect(() => decodeIncremental(JSON.stringify({ ...state, sentDeltaLink: "" }))).toThrow(
      CursorExpiredError,
    );
  });
});
