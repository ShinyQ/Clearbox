import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ProviderAuthError, ProviderRateLimitError } from "../../src/model/errors.ts";
import { createGmailProvider } from "../../src/providers/google/gmail.ts";
import { base64UrlUtf8, buildGmailNoteMime, rfc5322Date } from "../../src/providers/google/note.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { InboxNote } from "../../src/providers/provider.ts";
import { CLEARBOX_NOTE_SENDER } from "../../src/reminder/reminder.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 18, 2);
const NOTE: InboxNote = {
  subject: "Clearbox: 3 emails ready to review",
  text: "Line one.\nLine two.\n",
  to: "owner@example.test",
  sentAt: NOW,
};
const GMAIL_INSERT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GRAPH_INSERT = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";

function deps(
  tokens = { getAccessToken: () => Promise.resolve("at-1"), forceRefresh: () => Promise.resolve("at-2") },
) {
  return {
    fetch: (input: Request | string | URL, init?: RequestInit) => fetch(input, init),
    tokens,
    now: () => NOW,
  };
}

function fromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

describe("buildGmailNoteMime", () => {
  it("builds a plain text message from the reserved Clearbox sender with CRLF line endings", () => {
    const mime = buildGmailNoteMime(NOTE);
    const [head, body] = mime.split("\r\n\r\n");
    expect(head?.split("\r\n")).toEqual([
      `From: Clearbox <${CLEARBOX_NOTE_SENDER}>`,
      "To: <owner@example.test>",
      "Subject: Clearbox: 3 emails ready to review",
      "Date: Sun, 18 Oct 2026 02:00:00 +0000",
      `Message-ID: <reminder-${String(NOW)}@clearbox.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "Auto-Submitted: auto-generated",
      "X-Clearbox-Note: weekly-reminder",
    ]);
    expect(body).toBe("Line one.\r\nLine two.\r\n");
  });

  it("never lets a header value break the header block", () => {
    const mime = buildGmailNoteMime({
      ...NOTE,
      subject: "a\r\nBcc: x@example.com",
      to: "o@example.test\nX: y",
    });
    expect(mime).toContain("Subject: a Bcc: x@example.com\r\n");
    expect(mime).toContain("To: <o@example.test X: y>\r\n");
    expect(mime).not.toMatch(/\r\nBcc:/);
  });

  it("formats the date and base64url-encodes UTF-8 without padding", () => {
    expect(rfc5322Date(0)).toBe("Thu, 01 Jan 1970 00:00:00 +0000");
    expect(base64UrlUtf8("??>")).toBe("Pz8-");
    expect(fromBase64Url(base64UrlUtf8("caf\u00e9"))).toBe("caf\u00e9");
  });
});

describe("GmailProvider.insertInboxNote", () => {
  it("inserts the raw message into INBOX, unread, and returns the new id", async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    server.use(
      http.post(GMAIL_INSERT, async ({ request }) => {
        seen.push({
          url: request.url,
          auth: request.headers.get("authorization"),
          body: await request.json(),
        });
        return HttpResponse.json({
          id: "18f0note0001",
          threadId: "18f0note0001",
          labelIds: ["INBOX", "UNREAD"],
        });
      }),
    );
    expect(await createGmailProvider(deps()).insertInboxNote(NOTE)).toBe("18f0note0001");
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? "").searchParams.get("internalDateSource")).toBe("receivedTime");
    expect(seen[0]?.auth).toBe("Bearer at-1");
    const body = seen[0]?.body as { raw: string; labelIds: string[] };
    expect(body.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(fromBase64Url(body.raw)).toBe(buildGmailNoteMime(NOTE));
  });

  it("refreshes once on 401 and maps errors like every other call", async () => {
    let calls = 0;
    server.use(
      http.post(GMAIL_INSERT, () => {
        calls += 1;
        return calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json({ id: "n2" });
      }),
    );
    expect(await createGmailProvider(deps()).insertInboxNote(NOTE)).toBe("n2");

    server.use(http.post(GMAIL_INSERT, () => new HttpResponse(null, { status: 401 })));
    await expect(createGmailProvider(deps()).insertInboxNote(NOTE)).rejects.toBeInstanceOf(ProviderAuthError);

    server.use(
      http.post(GMAIL_INSERT, () =>
        HttpResponse.json(
          { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      ),
    );
    await expect(createGmailProvider(deps()).insertInboxNote(NOTE)).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
  });
});

describe("GraphProvider.insertInboxNote", () => {
  it("creates an unread, non-draft text message in Inbox from the Clearbox sender", async () => {
    const seen: { prefer: string | null; body: Record<string, unknown> }[] = [];
    server.use(
      http.post(GRAPH_INSERT, async ({ request }) => {
        seen.push({
          prefer: request.headers.get("prefer"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return HttpResponse.json({ id: "AAMkNote0001", isDraft: false }, { status: 201 });
      }),
    );
    const provider = createGraphProvider({ ...deps(), archiveFolderId: null });
    expect(await provider.insertInboxNote(NOTE)).toBe("AAMkNote0001");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prefer).toContain('IdType="ImmutableId"');
    const clearbox = { emailAddress: { name: "Clearbox", address: CLEARBOX_NOTE_SENDER } };
    expect(seen[0]?.body).toEqual({
      subject: NOTE.subject,
      body: { contentType: "text", content: NOTE.text },
      from: clearbox,
      sender: clearbox,
      toRecipients: [{ emailAddress: { address: "owner@example.test" } }],
      isRead: false,
      singleValueExtendedProperties: [
        { id: "Integer 0x0E07", value: "4" },
        { id: "SystemTime 0x0E06", value: "2026-10-18T02:00:00.000Z" },
        { id: "SystemTime 0x0039", value: "2026-10-18T02:00:00.000Z" },
      ],
    });
  });

  it("throws on a response without an id", async () => {
    server.use(http.post(GRAPH_INSERT, () => HttpResponse.json({}, { status: 201 })));
    await expect(
      createGraphProvider({ ...deps(), archiveFolderId: null }).insertInboxNote(NOTE),
    ).rejects.toMatchObject({ code: "provider_response" });
  });
});
