import type { MailHeaders, MailMessage } from "../../src/model/mail.ts";
import { DEFAULT_POLICY, type Policy } from "../../src/policy/policy.ts";
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
