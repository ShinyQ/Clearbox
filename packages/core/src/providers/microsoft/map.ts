import type { MailAddress, MailCategory, MailMessage } from "../../model/mail.ts";
import { parseAddress } from "../../text/address.ts";
import { decodeEncodedWords } from "../../text/rfc2047.ts";
import { collapseWhitespace, truncateChars } from "../../text/truncate.ts";
import { CursorExpiredError } from "../../model/errors.ts";
import { buildMailHeaders, parseCursorJson, stringField } from "../oauth.ts";
import type { SentItem } from "../provider.ts";
import type { GraphMessage, GraphRecipient } from "./types.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Every Graph request and $batch sub-request carries this Prefer value (ids survive moves). */
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Inbox $select (contracts 4.3.2). */
export const GRAPH_INBOX_SELECT =
  "id,conversationId,conversationIndex,internetMessageId,from,toRecipients,ccRecipients,subject,bodyPreview," +
  "receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification,webLink,internetMessageHeaders";
/** Delta $select: the inbox select without internetMessageHeaders. */
export const GRAPH_DELTA_INBOX_SELECT = GRAPH_INBOX_SELECT.replace(",internetMessageHeaders", "");
export const GRAPH_SENT_DELTA_SELECT =
  "id,conversationId,toRecipients,ccRecipients,bccRecipients,receivedDateTime";
export const GRAPH_SENT_LIST_SELECT = "conversationId,toRecipients,ccRecipients,bccRecipients,sentDateTime";

const SNIPPET_MAX_CHARS = 255;

/** Builds a Graph URL; values are percent-encoded (spaces as %20, never "+"), keys like $select stay literal. */
export function graphUrl(path: string, params: Readonly<Record<string, string>> = {}): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return query === "" ? `${GRAPH_BASE}${path}` : `${GRAPH_BASE}${path}?${query}`;
}

function toAddress(recipient: GraphRecipient | undefined): MailAddress {
  const raw = recipient?.emailAddress.address ?? null;
  const name = recipient?.emailAddress.name ?? null;
  const decoded = name === null ? "" : collapseWhitespace(decodeEncodedWords(name));
  return { address: raw === null ? null : parseAddress(raw).address, name: decoded === "" ? null : decoded };
}

/** Lowercased, de-duplicated addresses; unparseable (for example X.500) entries are dropped. */
export function graphRecipients(...lists: (GraphRecipient[] | undefined)[]): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const recipient of list ?? []) {
      const { address } = toAddress(recipient);
      if (address !== null) out.add(address);
    }
  }
  return [...out];
}

/** (bytes - 22) / 5 + 1 from the base64 conversationIndex; null when missing or malformed. */
export function conversationDepth(conversationIndex: string | undefined): number | null {
  if (conversationIndex === undefined || conversationIndex === "") return null;
  let length: number;
  try {
    length = atob(conversationIndex).length;
  } catch {
    return null;
  }
  return length < 22 ? null : Math.floor((length - 22) / 5) + 1;
}

function graphCategory(value: GraphMessage["inferenceClassification"]): MailCategory | null {
  return value === "focused" || value === "other" ? value : null;
}

function epochOf(iso: string | undefined): number {
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** GraphMessage -> MailMessage. Headers come from internetMessageHeaders ([] when absent). */
export function mapGraphMessage(msg: GraphMessage): MailMessage {
  return {
    providerMessageId: msg.id,
    threadId: msg.conversationId ?? null,
    internetMessageId: msg.internetMessageId ?? null,
    receivedAt: epochOf(msg.receivedDateTime),
    from: toAddress(msg.from),
    to: graphRecipients(msg.toRecipients),
    cc: graphRecipients(msg.ccRecipients),
    deliveredTo: [],
    subject: decodeEncodedWords(msg.subject ?? "").trim(),
    snippet: truncateChars(collapseWhitespace(msg.bodyPreview ?? ""), SNIPPET_MAX_CHARS),
    isRead: msg.isRead ?? false,
    starred: msg.flag?.flagStatus === "flagged",
    providerImportant: msg.importance === "high",
    category: graphCategory(msg.inferenceClassification),
    hasAttachments: msg.hasAttachments ?? false,
    attachmentsApprox: false,
    threadDepth: conversationDepth(msg.conversationIndex),
    headers: buildMailHeaders(msg.internetMessageHeaders ?? [], "outlook"),
    webLink: msg.webLink ?? null,
    labels: [],
  };
}

/** Sent Items message -> SentItem (sentDateTime for lists, receivedDateTime for delta). */
export function mapGraphSentItem(msg: GraphMessage): SentItem {
  return {
    threadId: msg.conversationId ?? null,
    recipients: graphRecipients(msg.toRecipients, msg.ccRecipients, msg.bccRecipients),
    sentAt: epochOf(msg.sentDateTime ?? msg.receivedDateTime),
  };
}

// ---- Incremental cursor (contracts 4.3.1) ----

export interface IncrementalState {
  v: 1;
  inboxDeltaLink: string;
  sentDeltaLink: string;
  watermark: string;
}

export function decodeIncremental(cursor: string): IncrementalState {
  const parsed = parseCursorJson(cursor, "outlook", "incremental");
  const inbox = stringField(parsed, "inboxDeltaLink");
  const sent = stringField(parsed, "sentDeltaLink");
  const watermark = stringField(parsed, "watermark");
  if (inbox === null || sent === null || watermark === null) {
    throw new CursorExpiredError({ provider: "outlook", cursorKind: "incremental" });
  }
  return { v: 1, inboxDeltaLink: inbox, sentDeltaLink: sent, watermark };
}
