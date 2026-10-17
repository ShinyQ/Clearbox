import { CursorExpiredError } from "../../model/errors.ts";
import type { MailCategory, MailMessage } from "../../model/mail.ts";
import { parseAddress } from "../../text/address.ts";
import { headerValue } from "../../text/headers.ts";
import { decodeEncodedWords } from "../../text/rfc2047.ts";
import { collapseWhitespace, decodeHtmlEntities, truncateChars } from "../../text/truncate.ts";
import { buildMailHeaders, headerValues, isJsonObject, parseCursorJson, uniqueAddresses } from "../oauth.ts";
import type { IncrementalCursor, SentItem } from "../provider.ts";
import type { GmailHistoryRecord, GmailMessageMetadata } from "./types.ts";

export const GMAIL_API = "https://gmail.googleapis.com";

/** Exact metadataHeaders list (contracts 4.3.2), sent as repeated query parameters. */
export const GMAIL_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Delivered-To",
  "Subject",
  "Date",
  "Message-ID",
  "References",
  "In-Reply-To",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "Authentication-Results",
  "Return-Path",
  "Content-Type",
] as const;
export const GMAIL_METADATA_FIELDS =
  "id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,headers)";
export const GMAIL_SENT_HEADERS = ["To", "Cc", "Bcc"] as const;
export const GMAIL_SENT_FIELDS = "id,threadId,internalDate,payload(headers)";

const SNIPPET_MAX_CHARS = 255;

function metadataPath(id: string, headers: readonly string[], fields: string): string {
  const query = new URLSearchParams({ format: "metadata" });
  for (const header of headers) query.append("metadataHeaders", header);
  query.set("fields", fields);
  return `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query.toString()}`;
}

/** Batch part path for inbox metadata. */
export function gmailMetadataPath(id: string): string {
  return metadataPath(id, GMAIL_METADATA_HEADERS, GMAIL_METADATA_FIELDS);
}

/** messages.get path for the two List-Unsubscribe headers only (contracts 12.9). */
export function gmailUnsubscribePath(id: string): string {
  return metadataPath(id, ["List-Unsubscribe", "List-Unsubscribe-Post"], "payload(headers)");
}

/** Batch part path for sent-message recipients. */
export function gmailSentMetadataPath(id: string): string {
  return metadataPath(id, GMAIL_SENT_HEADERS, GMAIL_SENT_FIELDS);
}

const CATEGORY_BY_LABEL: Readonly<Record<string, MailCategory>> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

export function gmailCategory(labels: readonly string[]): MailCategory | null {
  for (const label of labels) {
    const category = CATEGORY_BY_LABEL[label];
    if (category !== undefined) return category;
  }
  return null;
}

function receivedAtOf(meta: GmailMessageMetadata, date: string | null): number {
  const internal = Number(meta.internalDate);
  if (meta.internalDate !== undefined && Number.isFinite(internal)) return internal;
  const parsed = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function threadDepthOf(references: string | null, inReplyTo: string | null): number {
  const count = references === null ? 0 : (references.match(/<[^<>\s]+>/g) ?? []).length;
  if (count > 0) return count + 1;
  return inReplyTo === null ? 1 : 2;
}

/** GmailMessageMetadata (format=metadata) -> MailMessage (contracts 4.1). */
export function mapGmailMessage(meta: GmailMessageMetadata): MailMessage {
  const headers = meta.payload?.headers ?? [];
  const labels = meta.labelIds ?? [];
  const mimeType = (meta.payload?.mimeType ?? "").trim() || (headerValue(headers, "Content-Type") ?? "");
  return {
    providerMessageId: meta.id,
    threadId: meta.threadId === "" ? null : meta.threadId,
    internetMessageId: headerValue(headers, "Message-ID"),
    receivedAt: receivedAtOf(meta, headerValue(headers, "Date")),
    from: parseAddress(headerValue(headers, "From")),
    to: uniqueAddresses(headerValues(headers, "To")),
    cc: uniqueAddresses(headerValues(headers, "Cc")),
    deliveredTo: uniqueAddresses(headerValues(headers, "Delivered-To")),
    subject: decodeEncodedWords(headerValue(headers, "Subject") ?? "").trim(),
    snippet: truncateChars(collapseWhitespace(decodeHtmlEntities(meta.snippet ?? "")), SNIPPET_MAX_CHARS),
    isRead: !labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    providerImportant: labels.includes("IMPORTANT"),
    category: gmailCategory(labels),
    hasAttachments: mimeType.toLowerCase().startsWith("multipart/mixed"),
    attachmentsApprox: true,
    threadDepth: threadDepthOf(headerValue(headers, "References"), headerValue(headers, "In-Reply-To")),
    headers: buildMailHeaders(headers, "gmail"),
    webLink: null,
    labels: [...labels],
  };
}

/** Sent message metadata (To/Cc/Bcc) -> SentItem. */
export function mapGmailSentItem(meta: GmailMessageMetadata): SentItem {
  const headers = meta.payload?.headers ?? [];
  const sentAt = Number(meta.internalDate);
  return {
    threadId: meta.threadId === "" ? null : meta.threadId,
    recipients: uniqueAddresses([
      ...headerValues(headers, "To"),
      ...headerValues(headers, "Cc"),
      ...headerValues(headers, "Bcc"),
    ]),
    sentAt: Number.isFinite(sentAt) ? sentAt : 0,
  };
}

/** Gmail has no official deep link (research section 7); this opens the message in the right account. */
export function buildGmailDeepLink(email: string, providerMessageId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(providerMessageId)}`;
}

// ---- Cursors (contracts 4.3.1) ----

export interface IncrementalState {
  v: 1;
  historyId: string;
  catchupAfter: number | null;
  catchupPageToken: string | null;
}

export function pageTokenOf(cursor: string, kind: "backfill" | "sent"): string {
  const parsed = parseCursorJson(cursor, "gmail", kind);
  if (typeof parsed.pageToken !== "string" || parsed.pageToken === "") {
    throw new CursorExpiredError({ provider: "gmail", cursorKind: kind });
  }
  return parsed.pageToken;
}

export function pageCursor(pageToken: string | null): string | null {
  return pageToken === null ? null : JSON.stringify({ v: 1, pageToken });
}

export function decodeIncremental(cursor: string): IncrementalState {
  const parsed = parseCursorJson(cursor, "gmail", "incremental");
  if (typeof parsed.historyId !== "string" || parsed.historyId === "") {
    throw new CursorExpiredError({ provider: "gmail", cursorKind: "incremental" });
  }
  return {
    v: 1,
    historyId: parsed.historyId,
    catchupAfter: typeof parsed.catchupAfter === "number" ? parsed.catchupAfter : null,
    catchupPageToken: typeof parsed.catchupPageToken === "string" ? parsed.catchupPageToken : null,
  };
}

export function encodeIncremental(state: IncrementalState): IncrementalCursor {
  return JSON.stringify(state);
}

// ---- History (contracts 4.3.2 incremental rules) ----

export interface HistoryScan {
  inbox: string[];
  sent: string[];
  removed: string[];
  processed: number;
  lastId: string | null;
}

function countNew(seen: ReadonlySet<string>, ids: readonly string[]): number {
  return seen.size + ids.filter((id) => !seen.has(id)).length;
}

export function isHistoryRecord(value: unknown): value is GmailHistoryRecord {
  return isJsonObject(value) && typeof value.id === "string" && value.id !== "";
}

/** Walks records in order and stops before a record that would push inbox or sent adds past max. */
export function scanHistory(records: readonly GmailHistoryRecord[], max: number): HistoryScan {
  const inbox = new Set<string>();
  const sent = new Set<string>();
  const removed = new Set<string>();
  let processed = 0;
  let lastId: string | null = null;
  for (const record of records) {
    const addInbox: string[] = [];
    const addSent: string[] = [];
    const remove: string[] = [];
    for (const added of record.messagesAdded ?? []) {
      const labels = added.message.labelIds ?? [];
      if (labels.includes("INBOX")) addInbox.push(added.message.id);
      if (labels.includes("SENT")) addSent.push(added.message.id);
    }
    for (const change of record.labelsAdded ?? []) {
      if (change.labelIds.includes("INBOX")) addInbox.push(change.message.id);
      if (change.labelIds.includes("TRASH")) remove.push(change.message.id);
    }
    for (const change of record.labelsRemoved ?? []) {
      if (change.labelIds.includes("INBOX")) remove.push(change.message.id);
    }
    for (const deleted of record.messagesDeleted ?? []) remove.push(deleted.message.id);
    if (processed > 0 && (countNew(inbox, addInbox) > max || countNew(sent, addSent) > max)) break;
    // A single record above max (not seen in practice) keeps only the first max ids.
    for (const id of addInbox) if (inbox.size < max) inbox.add(id);
    for (const id of addSent) if (sent.size < max) sent.add(id);
    for (const id of remove) removed.add(id);
    processed++;
    lastId = record.id;
  }
  return { inbox: [...inbox], sent: [...sent], removed: [...removed], processed, lastId };
}
