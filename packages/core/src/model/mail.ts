export type ProviderKind = "gmail" | "outlook";

/** Opaque account id: "acc_" + 16 lowercase hex chars (8 random bytes). */
export type AccountId = string;

export interface AccountRef {
  id: AccountId;
  provider: ProviderKind;
  /** Lowercased primary address of the mailbox. */
  email: string;
}

export interface MailAddress {
  /** Lowercased address, or null when unparseable. */
  address: string | null;
  /** Decoded display name (RFC 2047), or null. */
  name: string | null;
}

export type MailCategory =
  | "primary"
  | "promotions"
  | "social"
  | "updates"
  | "forums" // Gmail CATEGORY_*
  | "focused"
  | "other"; // Outlook inferenceClassification

export type OwnerPosition = "to" | "cc" | "bcc_or_list";

export type AuthVerdict = "pass" | "fail" | "none";

/** Normalized metadata for one message. No body content beyond the provider snippet. */
export interface MailMessage {
  /** Gmail message id, or Graph immutable id. Case-sensitive. */
  providerMessageId: string;
  /** Gmail threadId or Graph conversationId. */
  threadId: string | null;
  internetMessageId: string | null;
  /** Epoch ms. Gmail internalDate, Graph receivedDateTime. */
  receivedAt: number;
  from: MailAddress;
  /** Lowercased addresses. */
  to: string[];
  cc: string[];
  /** Gmail Delivered-To values; [] for Graph. */
  deliveredTo: string[];
  /** Decoded, unfolded, "" when absent. */
  subject: string;
  /** Plain text, entities decoded, whitespace collapsed, max 255 chars. */
  snippet: string;
  isRead: boolean;
  /** Owner-set: Gmail STARRED or Graph flag.flagStatus === "flagged". */
  starred: boolean;
  /** Provider-set: Gmail IMPORTANT label or Graph importance === "high". Signal only, never a guardrail. */
  providerImportant: boolean;
  category: MailCategory | null;
  hasAttachments: boolean;
  /** True when hasAttachments comes from the Gmail multipart/mixed heuristic. */
  attachmentsApprox: boolean;
  /** Approximate thread depth: Gmail References count + 1; Graph (conversationIndex bytes - 22) / 5 + 1. */
  threadDepth: number | null;
  headers: MailHeaders;
  /** Graph webLink. Gmail: null (deep link built in the app from account email + id). */
  webLink: string | null;
  /** Raw provider labels (Gmail labelIds). [] for Graph. */
  labels: string[];
}

export interface MailHeaders {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  listId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  /** Only the receiving provider's results: Gmail authserv-id "mx.google.com"; Microsoft the first entry. */
  authenticationResults: string | null;
  returnPath: string | null;
  contentType: string | null;
  references: string | null;
  inReplyTo: string | null;
}
