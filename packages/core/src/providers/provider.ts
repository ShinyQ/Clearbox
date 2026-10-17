import type { FetchLike } from "../http/fetch.ts";
import type { MailMessage, ProviderKind } from "../model/mail.ts";
import type { TokenSource } from "./token.ts";

/**
 * Cursors are opaque strings to callers and stored verbatim in D1.
 * Each provider encodes them as JSON with a version field (shapes in contracts 4.3.1).
 */
export type BackfillCursor = string;
export type SentCursor = string;
export type IncrementalCursor = string;

export interface ProviderDeps {
  fetch: FetchLike;
  tokens: TokenSource;
  now: () => number;
}

export interface GraphProviderDeps extends ProviderDeps {
  /** Resolved at connect; null when no archive folder could be resolved or created. */
  archiveFolderId: string | null;
}

export interface BootstrapResult {
  /** Lowercased. */
  email: string;
  /** Gmail: email; Graph: /me id. */
  providerUserId: string;
  /** Lowercased, excluding email; Gmail sendAs, Graph: []. */
  aliases: string[];
  /** Graph only; Gmail null. */
  archiveFolderId: string | null;
  /** Taken BEFORE any backfill. */
  incrementalCursor: IncrementalCursor;
}

export interface InboxPage {
  /** Newest first. */
  messages: MailMessage[];
  /** null when the backfill reached the oldest inbox message. */
  nextCursor: BackfillCursor | null;
}

export interface SentItem {
  /** Gmail threadId / Graph conversationId. */
  threadId: string | null;
  /** Lowercased To + Cc + Bcc. */
  recipients: string[];
  sentAt: number;
}

export interface SentPage {
  items: SentItem[];
  nextCursor: SentCursor | null;
}

export interface ChangesPage {
  /** New inbox messages, full metadata, at most maxMessages. */
  added: MailMessage[];
  /** Provider ids that left the inbox (trashed, archived, moved, deleted) outside Clearbox. */
  removedIds: string[];
  /** New sent messages (for correspondents and replied threads), at most maxMessages. */
  sent: SentItem[];
  nextCursor: IncrementalCursor;
  /** True when the provider reported no further changes after nextCursor. */
  caughtUp: boolean;
}

export type ActionErrorCode =
  | "not_found" // message gone (Gmail 404 notFound, Graph 404 ErrorItemNotFound)
  | "rate_limited" // 429 / 403 rateLimitExceeded inside a batch
  | "unavailable" // 5xx / network inside a batch
  | "archive_unavailable" // Graph account without archive folder
  | "bad_request" // 400
  | "unknown";

export type ActionResult =
  | { id: string; ok: true; newId: string }
  | { id: string; ok: false; error: ActionErrorCode; retryAfterMs: number | null };

/** Raw List-Unsubscribe headers of one message (contracts 12.9); untrusted sender text. */
export interface UnsubscribeHeaders {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
}

export type RestoreFrom = "trash" | "archive";
export interface RestoreItem {
  id: string;
  from: RestoreFrom;
}

/** A plain text note Clearbox adds to the owner's own inbox (contracts 12.8). Never sent over SMTP. */
export interface InboxNote {
  /** One ASCII line. */
  subject: string;
  /** Plain text body, "\n" line breaks. */
  text: string;
  /** The mailbox address (lowercased); shown as the recipient. */
  to: string;
  /** Epoch ms; the note's date. */
  sentAt: number;
}

/**
 * No hard-delete method exists, by design.
 * Whole-call failures throw: ProviderAuthError, ProviderConfigError, ProviderRateLimitError,
 * ProviderUnavailableError, CursorExpiredError, ProviderResponseError.
 * Per-item failures are returned in ActionResult.
 * Every method issues its requests sequentially (never concurrent requests to one mailbox).
 */
export interface MailProvider {
  readonly kind: ProviderKind;
  /** Called once at connect time. */
  bootstrap(): Promise<BootstrapResult>;
  /** Inbox backfill, newest to oldest. cursor null = start at newest. */
  listInboxPage(cursor: BackfillCursor | null, pageSize: number): Promise<InboxPage>;
  /** Sent mail scan for correspondents and replied threads, newest first. */
  listSentPage(cursor: SentCursor | null, pageSize: number): Promise<SentPage>;
  /** Incremental changes since cursor. Throws CursorExpiredError when the cursor is no longer valid. */
  syncChanges(cursor: IncrementalCursor, maxMessages: number): Promise<ChangesPage>;
  /** New incremental cursor after expiry; watermark = newest receivedAt already ingested (epoch ms) or null. */
  resyncCursor(watermark: number | null): Promise<IncrementalCursor>;
  /**
   * Inbox message count (Gmail labels/INBOX messagesTotal, Graph mailFolders/inbox totalItemCount), one request.
   * Best effort: null on rate limit, 5xx, network or shape errors; auth, config and budget errors still throw.
   */
  inboxEstimate(): Promise<number | null>;
  /**
   * List-Unsubscribe and List-Unsubscribe-Post of one message, one request (Gmail messages.get format=metadata,
   * Graph GET message internetMessageHeaders). null when the message no longer exists (404).
   */
  unsubscribeHeaders(id: string): Promise<UnsubscribeHeaders | null>;
  /** Move to Trash / Deleted Items. Max 100 ids per call. */
  trash(ids: readonly string[]): Promise<ActionResult[]>;
  /** Gmail: remove INBOX; Graph: move to archiveFolderId. Max 100 ids per call. */
  archive(ids: readonly string[]): Promise<ActionResult[]>;
  /** Back to inbox. Gmail trash: untrash, then add INBOX if missing. Graph: move to "inbox". Max 100 per call. */
  restore(items: readonly RestoreItem[]): Promise<ActionResult[]>;
  /**
   * Adds an unread note to the inbox without sending anything (contracts 12.8), one request. Gmail
   * `messages.insert` (allowed with gmail.modify); Graph `POST /me/mailFolders/inbox/messages` (Mail.ReadWrite).
   * The sender is CLEARBOX_NOTE_SENDER so ingestion skips it. Returns the new provider message id.
   */
  insertInboxNote(note: InboxNote): Promise<string>;
}
