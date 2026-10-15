import { describe, expect, it } from "vitest";
import { CursorExpiredError } from "../../../src/model/errors.ts";
import {
  GMAIL_METADATA_HEADERS,
  buildGmailDeepLink,
  decodeIncremental,
  encodeIncremental,
  gmailCategory,
  gmailMetadataPath,
  gmailSentMetadataPath,
  mapGmailMessage,
  mapGmailSentItem,
  pageCursor,
  pageTokenOf,
  scanHistory,
} from "../../../src/providers/google/map.ts";
import type { GmailHistoryResponse, GmailMessageMetadata } from "../../../src/providers/google/types.ts";
import { makeGmailMetadata } from "../../fixtures/builders.ts";
import historyPage from "../../fixtures/gmail/history-page.json" with { type: "json" };
import newsletter from "../../fixtures/gmail/metadata-newsletter.json" with { type: "json" };

describe("mapGmailMessage", () => {
  it("normalizes the newsletter fixture", () => {
    const msg = mapGmailMessage(newsletter as GmailMessageMetadata);
    expect(msg).toMatchObject({
      providerMessageId: "19a0c0ffee000001",
      threadId: "19a0c0ffee000000",
      internetMessageId: "<abc123@mail.shop.example.com>",
      receivedAt: 1_760_500_000_000,
      from: { address: "news@shop.example.com", name: "Café Shop" },
      to: ["owner@example.test", "team@example.org"],
      cc: ["jane@example.net"],
      deliveredTo: ["owner@example.test"],
      subject: "Café autumn sale über 30% off",
      snippet: "Our autumn sale starts now & ends Sunday. Don't miss it",
      isRead: false,
      starred: false,
      providerImportant: true,
      category: "promotions",
      hasAttachments: true,
      attachmentsApprox: true,
      threadDepth: 3,
      webLink: null,
      labels: ["UNREAD", "CATEGORY_PROMOTIONS", "INBOX", "IMPORTANT"],
    });
    expect(msg.headers).toEqual({
      listUnsubscribe: "<mailto:unsub@shop.example.com?subject=unsub>, <https://shop.example.com/u/abc>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      listId: "Shop News <news.shop.example.com>",
      precedence: "bulk",
      autoSubmitted: null,
      authenticationResults:
        "mx.google.com; dkim=pass header.i=@shop.example.com header.s=s1 header.b=Ab12; spf=pass (google.com: domain of bounce@esp.example.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@esp.example.net; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example.com",
      returnPath: "<bounce-123@esp.example.net>",
      contentType: 'multipart/mixed; boundary="b1"',
      references: "<r1@example.com> <r2@example.com>",
      inReplyTo: "<r2@example.com>",
    });
  });

  it("drops an upstream Authentication-Results that is not from mx.google.com", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({
        headers: [{ name: "Authentication-Results", value: "evil.example.net; spf=pass" }],
      }),
    );
    expect(msg.headers.authenticationResults).toBeNull();
  });

  it("falls back to the Content-Type header when payload.mimeType is missing", () => {
    const meta = makeGmailMetadata({
      headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=x" }],
    });
    delete meta.payload?.mimeType;
    expect(mapGmailMessage(meta).hasAttachments).toBe(true);
    expect(mapGmailMessage(makeGmailMetadata({ mimeType: "multipart/related" })).hasAttachments).toBe(false);
    expect(mapGmailMessage(makeGmailMetadata({ mimeType: "multipart/alternative" })).hasAttachments).toBe(
      false,
    );
  });

  it("uses the Date header when internalDate is missing, else 0", () => {
    const meta = makeGmailMetadata({ headers: [{ name: "Date", value: "Wed, 15 Oct 2025 03:46:40 +0000" }] });
    delete meta.internalDate;
    expect(mapGmailMessage(meta).receivedAt).toBe(1_760_500_000_000);
    const none = makeGmailMetadata({ headers: [] });
    delete none.internalDate;
    expect(mapGmailMessage(none).receivedAt).toBe(0);
    const bad = makeGmailMetadata({
      internalDate: "not-a-number",
      headers: [{ name: "Date", value: "junk" }],
    });
    expect(mapGmailMessage(bad).receivedAt).toBe(0);
  });

  it("handles a missing From, Subject and payload", () => {
    const msg = mapGmailMessage({ id: "18f0000000000009", threadId: "18f0000000000009" });
    expect(msg.from).toEqual({ address: null, name: null });
    expect(msg.subject).toBe("");
    expect(msg.snippet).toBe("");
    expect(msg.isRead).toBe(true);
    expect(msg.category).toBeNull();
    expect(msg.threadDepth).toBe(1);
  });

  it("maps STARRED, CATEGORY_PERSONAL and read state", () => {
    const msg = mapGmailMessage(makeGmailMetadata({ labelIds: ["INBOX", "STARRED", "CATEGORY_PERSONAL"] }));
    expect(msg).toMatchObject({ starred: true, isRead: true, category: "primary", providerImportant: false });
  });

  it("counts In-Reply-To without References as depth 2", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({ headers: [{ name: "In-Reply-To", value: "<a@example.com>" }] }),
    );
    expect(msg.threadDepth).toBe(2);
  });

  it("decodes RFC 2047 edge cases in subject and display name", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({
        headers: [
          { name: "From", value: '"=?ISO-8859-1?Q?Gr=FC=DFe?=" <greet@example.org>' },
          { name: "Subject", value: "=?utf-8?b?Q2Fmw6kgbmV3cw==?= and =?x-unknown?Q?raw?=" },
        ],
      }),
    );
    expect(msg.from).toEqual({ address: "greet@example.org", name: "Grüße" });
    expect(msg.subject).toBe("Café news and =?x-unknown?Q?raw?=");
  });

  it("truncates the snippet to 255 code points", () => {
    const msg = mapGmailMessage(makeGmailMetadata({ snippet: "é".repeat(300) }));
    expect([...msg.snippet]).toHaveLength(255);
  });
});

describe("mapGmailSentItem", () => {
  it("collects lowercased To, Cc and Bcc recipients", () => {
    const item = mapGmailSentItem(
      makeGmailMetadata({
        threadId: "18f00000000000aa",
        internalDate: "1760000000000",
        headers: [
          { name: "To", value: "Friend <Friend@Example.com>" },
          { name: "Cc", value: "friend@example.com, other@example.org" },
          { name: "Bcc", value: "hidden@example.net" },
        ],
      }),
    );
    expect(item).toEqual({
      threadId: "18f00000000000aa",
      recipients: ["friend@example.com", "other@example.org", "hidden@example.net"],
      sentAt: 1_760_000_000_000,
    });
  });
});

describe("gmailMetadataPath", () => {
  it("repeats metadataHeaders and sets fields", () => {
    const url = new URL(gmailMetadataPath("18f0000000000001"), "https://gmail.googleapis.com");
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/18f0000000000001");
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual([...GMAIL_METADATA_HEADERS]);
    expect(url.searchParams.get("fields")).toBe(
      "id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,headers)",
    );
  });
  it("sent path asks for To, Cc and Bcc only", () => {
    const url = new URL(gmailSentMetadataPath("x1"), "https://gmail.googleapis.com");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual(["To", "Cc", "Bcc"]);
  });
});

describe("gmailCategory", () => {
  it("maps CATEGORY_* labels", () => {
    expect(gmailCategory(["CATEGORY_SOCIAL"])).toBe("social");
    expect(gmailCategory(["CATEGORY_FORUMS"])).toBe("forums");
    expect(gmailCategory(["INBOX"])).toBeNull();
  });
});

describe("buildGmailDeepLink", () => {
  it("opens the message for the right account", () => {
    expect(buildGmailDeepLink("owner@example.test", "19a0c0ffee000001")).toBe(
      "https://mail.google.com/mail/u/?authuser=owner%40example.test#all/19a0c0ffee000001",
    );
  });
});

describe("scanHistory", () => {
  const records = (historyPage as GmailHistoryResponse).history ?? [];

  it("classifies adds, sent adds and removals in record order", () => {
    expect(scanHistory(records, 25)).toEqual({
      inbox: ["msg0001", "msg0005", "msg0006"],
      sent: ["sent01"],
      removed: ["msg0002", "msg0003", "msg0004"],
      processed: 8,
      lastId: "2008",
    });
  });

  it("stops before the record that would exceed maxMessages", () => {
    expect(scanHistory(records, 2)).toMatchObject({
      inbox: ["msg0001", "msg0005"],
      processed: 7,
      lastId: "2007",
    });
  });

  it("always processes the first record", () => {
    const big = [
      {
        id: "3001",
        messagesAdded: ["a", "b", "c"].map((id) => ({ message: { id, threadId: id, labelIds: ["INBOX"] } })),
      },
    ];
    expect(scanHistory(big, 2)).toMatchObject({ inbox: ["a", "b"], processed: 1, lastId: "3001" });
  });
});

describe("Gmail cursors", () => {
  it("round-trips page and incremental cursors", () => {
    expect(pageTokenOf(pageCursor("p25") ?? "", "backfill")).toBe("p25");
    expect(pageCursor(null)).toBeNull();
    const state = { v: 1 as const, historyId: "42", catchupAfter: 1_760_000_000, catchupPageToken: null };
    expect(decodeIncremental(encodeIncremental(state))).toEqual(state);
  });

  it("rejects malformed cursors with CursorExpiredError", () => {
    expect(() => pageTokenOf('{"v":1}', "sent")).toThrow(CursorExpiredError);
    expect(() => decodeIncremental('{"v":1,"historyId":""}')).toThrow(CursorExpiredError);
  });
});
