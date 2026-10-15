import type { DecisionResult } from "../../src/decision/engine.ts";
import type { MailHeaders, MailMessage } from "../../src/model/mail.ts";
import { DEFAULT_POLICY, type Policy } from "../../src/policy/policy.ts";
import type { GmailHeader, GmailMessageMetadata } from "../../src/providers/google/types.ts";
import type { SenderHistory, Signals } from "../../src/signals/signals.ts";

/** Fixed test clock: 2026-10-15T00:00:00.000Z. */
export const TEST_NOW = Date.UTC(2026, 9, 15);
export const DAY_MS = 86_400_000;

export function makeMailHeaders(overrides: Partial<MailHeaders> = {}): MailHeaders {
  return {
    listUnsubscribe: null,
    listUnsubscribePost: null,
    listId: null,
    precedence: null,
    autoSubmitted: null,
    authenticationResults: null,
    returnPath: null,
    contentType: null,
    references: null,
    inReplyTo: null,
    ...overrides,
  };
}

export type MailMessageOverrides = Partial<Omit<MailMessage, "headers">> & { headers?: Partial<MailHeaders> };

/** A plain, read, 10-day-old message from a synthetic shop sender to owner@example.test. */
export function makeMailMessage(overrides: MailMessageOverrides = {}): MailMessage {
  const { headers, ...rest } = overrides;
  return {
    providerMessageId: "msg-0001",
    threadId: "thr-0001",
    internetMessageId: "<0001@mail.example.com>",
    receivedAt: TEST_NOW - 10 * DAY_MS,
    from: { address: "news@shop.example.com", name: "Example Shop" },
    to: ["owner@example.test"],
    cc: [],
    deliveredTo: [],
    subject: "Weekly picks from Example Shop",
    snippet: "New arrivals this week.",
    isRead: true,
    starred: false,
    providerImportant: false,
    category: null,
    hasAttachments: false,
    attachmentsApprox: false,
    threadDepth: 1,
    webLink: null,
    labels: [],
    ...rest,
    headers: makeMailHeaders(headers),
  };
}

export function makeSenderHistory(overrides: Partial<SenderHistory> = {}): SenderHistory {
  return {
    seenCount: 0,
    readCount: 0,
    isCorrespondent: false,
    senderPrior: null,
    domainPrior: null,
    ...overrides,
  };
}

/** Neutral signals: known sender, nothing bulk, nothing protected, 10 days old, read. */
export function makeSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    senderAddress: "news@shop.example.com",
    senderDomain: "example.com",
    senderName: "Example Shop",
    senderKnown: true,
    ownerReplied: false,
    isCorrespondent: false,
    senderSeenCount: 0,
    senderOpenRate: null,
    ownerDeleteRate: null,
    ownerDecisions: 0,
    hasListUnsubscribe: false,
    oneClickUnsubscribe: false,
    hasListId: false,
    precedenceBulk: false,
    autoSubmitted: false,
    espDomain: null,
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    category: null,
    starred: false,
    providerImportant: false,
    ageDays: 10,
    isRead: true,
    hasAttachments: false,
    attachmentsApprox: false,
    threadDepth: 1,
    ownerPosition: "to",
    ...overrides,
  };
}

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...DEFAULT_POLICY,
    allowlist: [...DEFAULT_POLICY.allowlist],
    denylist: [...DEFAULT_POLICY.denylist],
    recordPatterns: [...DEFAULT_POLICY.recordPatterns],
    ...overrides,
  };
}

/** A keep-leaning model result with low flags and importance 1. */
export function makeDecisionResult(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    action: { delete: 0.1, archive: 0.2, keep: 0.6, unsure: 0.1 },
    importance: 1,
    flags: { isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 },
    responseModel: "microsoft-decision-1",
    modelVersion: "decision-1/microsoft-decision-1",
    inputTokens: 500,
    requestId: null,
    latencyMs: 0,
    ...overrides,
  };
}

// ---- Provider wire builders (plan 02) ----

export type GmailMetadataOverrides = Partial<Omit<GmailMessageMetadata, "payload">> & {
  mimeType?: string;
  headers?: GmailHeader[];
};

/** Minimal Gmail inbox metadata from a synthetic sender; override headers to test parsing. */
export function makeGmailMetadata(overrides: GmailMetadataOverrides = {}): GmailMessageMetadata {
  const { mimeType, headers, ...rest } = overrides;
  return {
    id: "18f0000000000001",
    threadId: "18f0000000000001",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    snippet: "Synthetic snippet",
    historyId: "1001",
    internalDate: "1760000000000",
    payload: {
      mimeType: mimeType ?? "multipart/alternative",
      headers: headers ?? [
        { name: "From", value: "Example Sender <sender@example.com>" },
        { name: "To", value: "owner@example.test" },
        { name: "Subject", value: "Synthetic subject" },
      ],
    },
    ...rest,
  };
}
