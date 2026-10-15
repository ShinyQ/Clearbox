import type { TokenSource } from "../../src/providers/token.ts";
import { FailureQueue, type FailRule } from "./failures.ts";

export type { FailRule } from "./failures.ts";

export type FakeFolder = "inbox" | "archive" | "trash" | "sent";
export type GmailCategoryLabel =
  "CATEGORY_PERSONAL" | "CATEGORY_PROMOTIONS" | "CATEGORY_SOCIAL" | "CATEGORY_UPDATES" | "CATEGORY_FORUMS";

export interface FakeHeader {
  name: string;
  value: string;
}

/** Provider-neutral synthetic message; gmail.ts and graph.ts render it in each provider's wire shape. */
export interface FakeMessage {
  /** Gmail message id or Graph immutable id (case-sensitive, unchanged by moves). */
  id: string;
  threadId: string;
  folder: FakeFolder;
  receivedAt: number;
  fromName: string | null;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  snippet: string;
  isRead: boolean;
  starred: boolean;
  important: boolean;
  category: GmailCategoryLabel | null;
  inference: "focused" | "other";
  mimeType: string;
  hasAttachments: boolean;
  /** Extra raw headers (List-Unsubscribe, Authentication-Results, ...). */
  headers: FakeHeader[];
  /** Graph: when false, list responses omit internetMessageHeaders, forcing the $batch fallback. */
  headersOnList: boolean;
}

/** One change-log entry; drives Gmail history records and Graph delta rounds. */
export interface FakeChange {
  seq: number;
  id: string;
  from: FakeFolder | null;
  to: FakeFolder | null;
}

export const FAKE_OWNER = "owner@example.test";
const BASE_TIME = Date.UTC(2026, 9, 1);

/** In-memory mailbox shared by the Gmail and Graph MSW handlers (contracts 10.3). */
export class FakeMailbox {
  readonly owner = FAKE_OWNER;
  readonly failures = new FailureQueue();
  /** Every top-level request ("GET /gmail/v1/...") and batch part ("part:GET /gmail/v1/...") in order. */
  readonly requests: string[] = [];
  /** Prefer header of every Graph request and sub-request. */
  readonly preferHeaders: string[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly changes: FakeChange[] = [];
  aliases: string[] = ["Alias@Example.test"];
  validAccessToken = "at-valid";
  /** Graph /me mail; null exercises the userPrincipalName fallback. */
  graphMail: string | null = "Owner@Example.test";
  graphUserId = "graph-user-0001";
  archiveFolderId = "folder-archive-0001";
  /** "missing": GET archive 404 then POST creates it; "uncreatable": GET 404 and POST 403. */
  archiveFolder: "present" | "missing" | "uncreatable" = "present";
  /** Gmail untrash: false (default) leaves the message without INBOX, exercising the INBOX re-add. */
  untrashRestoresInbox = false;
  /** Status for an expired Graph delta token: 400 syncStateNotFound or 410 Gone. */
  deltaExpiredStatus: 400 | 410 = 400;
  seq = 0;
  /** Cursors (history ids, delta tokens) older than this sequence number are rejected. */
  minValidSeq = 0;
  inFlight = 0;
  maxInFlight = 0;
  private nextNumber = 1;

  failNext(rule: FailRule): void {
    this.failures.add(rule);
  }

  addMessage(overrides: Partial<FakeMessage> = {}): FakeMessage {
    const n = this.nextNumber++;
    const tag = String(n).padStart(4, "0");
    const message: FakeMessage = {
      id: `msg${tag}`,
      threadId: `thr${tag}`,
      folder: "inbox",
      receivedAt: BASE_TIME + n * 60_000,
      fromName: `Sender ${tag}`,
      fromAddress: `sender${tag}@shop.example.com`,
      to: [FAKE_OWNER],
      cc: [],
      bcc: [],
      subject: `Synthetic subject ${tag}`,
      snippet: `Synthetic snippet ${tag}`,
      isRead: false,
      starred: false,
      important: false,
      category: "CATEGORY_PROMOTIONS",
      inference: "other",
      mimeType: "multipart/alternative",
      hasAttachments: false,
      headers: [{ name: "List-Unsubscribe", value: `<https://shop.example.com/u/${tag}>` }],
      headersOnList: true,
      ...overrides,
    };
    this.messages.set(message.id, message);
    this.record(message.id, null, message.folder);
    return message;
  }

  /** Moves a message (to = null deletes it permanently) and records the change. */
  move(id: string, to: FakeFolder | null): void {
    const message = this.messages.get(id);
    if (message === undefined || message.folder === to) return;
    const from = message.folder;
    if (to === null) this.messages.delete(id);
    else message.folder = to;
    this.record(id, from, to);
  }

  /** Invalidates every cursor taken before the current position (history 404, delta syncStateNotFound / 410). */
  expireCursors(): void {
    this.minValidSeq = this.seq;
  }

  inFolder(folder: FakeFolder): FakeMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.folder === folder)
      .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? -1 : 1));
  }

  /** Wraps a handler: logs the request and tracks concurrency (the providers must never overlap requests). */
  async track<T>(label: string, run: () => Promise<T>): Promise<T> {
    this.requests.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await run();
    } finally {
      this.inFlight--;
    }
  }

  private record(id: string, from: FakeFolder | null, to: FakeFolder | null): void {
    this.seq++;
    this.changes.push({ seq: this.seq, id, from, to });
  }
}

/** TokenSource for provider tests: forceRefresh() switches to the mailbox's valid token. */
export class FakeTokenSource implements TokenSource {
  current: string;
  refreshes = 0;
  refreshError: Error | null = null;
  private readonly mailbox: { validAccessToken: string };

  constructor(mailbox: { validAccessToken: string }, current?: string) {
    this.mailbox = mailbox;
    this.current = current ?? mailbox.validAccessToken;
  }

  async getAccessToken(): Promise<string> {
    return this.current;
  }

  async forceRefresh(): Promise<string> {
    this.refreshes++;
    if (this.refreshError !== null) throw this.refreshError;
    this.current = this.mailbox.validAccessToken;
    return this.current;
  }
}

/** JSON body used for injected failures without an explicit body. */
export function defaultErrorBody(status: number): unknown {
  return { error: { code: status, message: "Injected failure", errors: [{ reason: "injected" }] } };
}
