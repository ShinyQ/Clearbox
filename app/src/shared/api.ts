import { z } from "zod";
import { PolicySchema, SenderEntrySchema } from "@clearbox/core";
import type {
  ActionKind,
  Ceiling,
  MailCategory,
  OwnerPosition,
  AuthVerdict,
  ProviderKind,
  Policy,
  ReasonCode,
  ScanHistoryDays,
  SuggestedAction,
  CalibrationPoint,
} from "@clearbox/core";

export const CSRF_HEADER = "X-Clearbox-CSRF";
export const CSRF_VALUE = "1";

export type ApiErrorCode =
  | "validation_failed" // 400
  | "unauthenticated" // 401
  | "forbidden" // 403
  | "csrf_required" // 403
  | "not_found" // 404
  | "conflict" // 409 (stale expectedVersion)
  | "account_busy" // 409 (lease held by another tick)
  | "account_inactive" // 409 (status not active, or paused, for scan-now)
  | "undo_expired" // 410
  | "payload_too_large" // 413
  | "provider_not_configured" // 422
  | "budget_exhausted" // 429 (D1 daily budget)
  | "rate_limited" // 429 (provider throttled the whole request)
  | "internal" // 500
  | "access_misconfigured" // 500
  | "provider_error"; // 502

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string; // English, safe to show, no addresses or subjects
    details?: unknown; // validation_failed: zod issues as { path: string, message: string }[]
    retryAt?: string; // ISO, for 409 account_busy, 429
  };
}

/** Cursor pagination. `cursor` is opaque (server-encoded base64url JSON). */
export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiReason {
  code: ReasonCode;
  text: string;
}

export type AppIssueCode =
  | "decision_not_configured"
  | "decision_auth_failed"
  | "decision_deployment_not_found"
  | "google_client_invalid"
  | "microsoft_client_invalid"
  | "storage_near_limit"
  | "budget_exhausted_today";
export interface AppIssue {
  code: AppIssueCode;
  since: string;
  accountId: string | null;
}

export type AccountStatus = "active" | "needs_reauth" | "config_error";
export type AccountPhase = "sent_backfill" | "inbox_backfill" | "incremental";
export type SuggestionStatus =
  "awaiting_model" | "pending" | "approved" | "executed" | "failed" | "dismissed" | "undone";
export type Distribution = Record<SuggestedAction, number>;
export const IsoDateSchema = z.iso.datetime({ offset: true });
export const SuggestionIdsSchema = z
  .array(z.int().positive())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "ids must be unique");
export interface MeResponse {
  email: string; // owner email
  environment: "development" | "test" | "production";
  freeTier: boolean;
  providers: { gmail: boolean; outlook: boolean }; // client id and secret configured
  issues: AppIssue[];
  tauDelete: number;
  serverTime: string;
}
export interface AccountSync {
  phase: AccountPhase;
  /**
   * True once the inbox backfill finished for the current scan history window (phase incremental). Rev 2.4: also
   * true when the backfill stopped at the window edge with older mail left unscanned.
   */
  backfillDone: boolean;
  messagesIngested: number;
  pendingCount: number;
  awaitingModelCount: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  backoffUntil: string | null;
  lastErrorCode: string | null;
  pageSize: number;
  /** rev 2.1 A4: provider inbox total (accounts.inbox_estimate); null when unknown. */
  inboxEstimate: number | null;
  /**
   * Rev 2.4: the owner's scan history window in days (policy.scanHistoryDays), null for all mail. When not null,
   * inboxEstimate is the whole inbox and is not the backlog.
   */
  scanHistoryDays: ScanHistoryDays;
}

export interface AccountView {
  id: string;
  provider: ProviderKind;
  email: string;
  status: AccountStatus;
  statusReason: string | null; // e.g. "invalid_grant", "AADSTS7000222"
  paused: boolean;
  archiveSupported: boolean; // Gmail always true; Graph: archive_folder_id not null
  sync: AccountSync;
  createdAt: string;
}

export interface AccountsResponse {
  accounts: AccountView[];
} // excludes status 'disconnected'

export const PatchAccountBodySchema = z.strictObject({ paused: z.boolean() });
export type PatchAccountBody = z.infer<typeof PatchAccountBodySchema>;

export interface DisconnectResponse {
  accountId: string;
  /** Gmail: result of POST oauth2.googleapis.com/revoke. Outlook: always "not_supported". */
  revocation: "revoked" | "failed" | "not_supported";
  /** Outlook only: where the owner removes consent. */
  consentUrls: { personal: string; work: string } | null;
}

export type TickKind = "sent_backfill" | "inbox_backfill" | "incremental" | "redecide";
export interface TickReport {
  outcome: "processed" | "idle" | "error";
  accountId: string | null;
  kind: TickKind | null;
  phase: AccountPhase | null;
  fetched: number; // messages or sent items returned by the provider
  skippedKnown: number; // already in D1
  decided: number; // Decision-1 successes
  deferred: number; // awaiting_model after this tick
  unsure: number; // stored as unsure (model failed permanently or low confidence)
  removed: number; // suggestions dismissed because the message left the inbox
  subrequests: number;
  rowsWritten: number;
  nextTickAt: string | null;
  errorCode: string | null; // ClearboxError.code on outcome "error"
}
export const SummaryQuerySchema = z.object({ accountId: z.string().optional() });

export interface QueueSummary {
  asOf: string; // server time; pass back as asOf to approve/cleanup
  pending: Record<SuggestedAction, number> & { total: number };
  awaitingModel: number;
  /** contracts 12.10: recent emails left alone until they are policy.minAgeDays old (not counted in awaitingModel). */
  recentHeld: number;
  groups: number; // distinct (account, sender, action) among pending
  /** rev 2.1 A1: distinct pending sender groups per suggested action. */
  groupsByAction: Record<SuggestedAction, number>;
  tauDelete: number;
  cleanup: { threshold: number; count: number; byAction: Record<ActionKind, number> }; // at threshold = tauDelete
}

export const GroupsQuerySchema = PageQuerySchema.extend({
  accountId: z.string().optional(),
  action: z.enum(["delete", "archive", "keep", "unsure"]).optional(),
  sort: z.enum(["confidence_desc", "count_desc", "newest"]).default("confidence_desc"),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
});

/** Opaque key: base64url(JSON.stringify([accountId, sender, action])). */
export type GroupKey = string;

export interface SenderGroup {
  key: GroupKey;
  accountId: string;
  provider: ProviderKind;
  sender: string; // "" for unknown senders (one group per account and action)
  senderName: string | null; // most recent display name
  domain: string;
  action: SuggestedAction;
  count: number;
  confidence: { min: number; avg: number; max: number };
  topReasons: ApiReason[]; // up to 3, most frequent codes in the group
  ceilingApplied: boolean; // any item capped by a guardrail
  newestReceivedAt: string;
  /** rev 2.1 A6: subject of the newest pending item; null when not stored. */
  latestSubject: string | null;
  oldestReceivedAt: string;
}

export interface ItemSignals {
  hasListUnsubscribe: boolean;
  precedenceBulk: boolean;
  autoSubmitted: boolean;
  category: MailCategory | null;
  hasAttachments: boolean;
  starred: boolean;
  ownerReplied: boolean;
  isCorrespondent: boolean;
  ageDays: number;
  ownerPosition: OwnerPosition;
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
}

export interface SuggestionItem {
  id: number; // suggestions.message_id
  accountId: string;
  provider: ProviderKind;
  status: SuggestionStatus;
  action: SuggestedAction;
  confidence: number;
  distribution: Distribution | null;
  importance: number | null; // 0..4
  ceiling: Ceiling;
  ceilingApplied: boolean;
  reasons: ApiReason[];
  from: { address: string; name: string | null };
  subject: string | null;
  snippet: string | null; // null when snippets are not stored
  receivedAt: string;
  isRead: boolean;
  signals: ItemSignals;
  /** Gmail: https://mail.google.com/mail/u/?authuser=<email>#all/<id>; Outlook: webLink. */
  deepLink: string | null;
  modelVersion: string | null;
  policyVersion: number;
}

export interface GroupDetail {
  asOf: string;
  group: SenderGroup;
  items: Page<SuggestionItem>; // sorted by confidence desc, then receivedAt desc
  /** Contracts 12.9: one-click unsubscribe state of the group's sender. */
  unsubscribe: GroupUnsubscribe;
}
export const ApproveBodySchema = z.union([
  z.strictObject({ ids: SuggestionIdsSchema }),
  z.strictObject({ groupKey: z.string().min(1).max(1024), asOf: IsoDateSchema }),
]);
export type ApproveBody = z.infer<typeof ApproveBodySchema>;

export const OverrideBodySchema = z.strictObject({
  ids: SuggestionIdsSchema,
  action: z.enum(["delete", "archive", "keep"]),
});
export type OverrideBody = z.infer<typeof OverrideBodySchema>;

export const CleanupPreviewQuerySchema = z.object({
  threshold: z.coerce.number().min(0.5).max(1).optional(), // default: current tauDelete
  actions: z
    .string()
    .regex(/^(delete|archive|keep)(,(delete|archive|keep))*$/)
    .optional(), // CSV, default all three
  accountId: z.string().optional(),
});

export const CleanupBodySchema = z.strictObject({
  threshold: z.number().min(0.5).max(1).optional(),
  actions: z
    .array(z.enum(["delete", "archive", "keep"]))
    .min(1)
    .max(3)
    .optional(),
  accountId: z.string().optional(),
  asOf: IsoDateSchema,
});
export type CleanupBody = z.infer<typeof CleanupBodySchema>;

export interface CleanupPreview {
  asOf: string;
  threshold: number;
  defaultThreshold: number; // current tauDelete
  count: number;
  byAction: Record<ActionKind, number>;
  groups: number;
  /** rev 2.1 A2: pending sender groups in scope that keep at least one pending item after this Clean up. */
  groupsLeft: number;
}

export type ItemOutcome = "executed" | "failed" | "skipped" | "retry_later";
export type ItemErrorCode =
  | "not_pending"
  | "unsure_not_approvable"
  | "account_inactive"
  | "not_found"
  | "archive_unavailable"
  | "rate_limited"
  | "unavailable"
  | "bad_request"
  | "budget"
  | "unknown";

export interface ItemResult {
  id: number;
  outcome: ItemOutcome;
  action: ActionKind | null; // what was (or would have been) executed
  error: ItemErrorCode | null;
}

export interface ActionResponse {
  batchId: number | null; // null when nothing executed
  results: ItemResult[]; // one per targeted suggestion, in request order (ids) or confidence order
  executed: number;
  failed: number;
  skipped: number;
  retryLater: number;
  /** Items still matching the request after this call (0 for ids/override). The UI loops while > 0. */
  remaining: number;
}
export interface ActionBatchView {
  id: number;
  kind: "approve" | "override" | "cleanup";
  createdAt: string;
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  byAction: Record<ActionKind, number>; // executed items per final_action
  undoable: boolean; // now < undoExpiresAt and undoneAt is null and executedCount > 0
  undoExpiresAt: string;
  undoneAt: string | null;
}

export interface UndoItemResult {
  id: number;
  outcome: "restored" | "failed" | "skipped";
  error: ItemErrorCode | null;
}
export interface UndoResponse {
  batchId: number;
  results: UndoItemResult[];
  restored: number;
  failed: number;
  skipped: number;
}
export const ActivityQuerySchema = PageQuerySchema.extend({ accountId: z.string().optional() });

export type ActivityKind =
  | "account_connected"
  | "account_reconnected"
  | "account_disconnected"
  | "account_purged"
  | "account_paused"
  | "account_resumed"
  | "reauth_required"
  | "config_error"
  | "approve"
  | "override"
  | "cleanup"
  | "undo"
  | "policy_updated"
  | "calibration"
  | "purge"
  | "unsubscribe";

export interface ActivityEntry {
  id: number;
  ts: string;
  kind: ActivityKind;
  accountId: string | null;
  batchId: number | null;
  count: number;
  result: Record<string, number | string>; // counts and codes only
}
export interface Insights {
  precision: {
    deletePrecision: number | null; // among the newest 500 labels with suggested_action = 'delete': share with owner_action = 'delete'
    deleteSuggestionsDecided: number;
    window: number; // 500
  };
  labels: { total: number; last7Days: number };
  calibration: {
    tauDelete: number;
    outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target" | null;
    ranAt: string | null;
    points: CalibrationPoint[];
    /** contracts 12.10: per-segment trash thresholds from the same nightly run; empty before the first one. */
    segments: SegmentCalibrationView[];
  };
  budget: {
    date: string; // UTC date
    rowsWritten: number;
    rowsCap: number; // BUDGET_ROWS_PER_DAY
    ingestStopRows: number; // INGEST_STOP_ROWS
    d1DailyWriteLimit: number; // D1_DAILY_WRITE_LIMIT
    ticks: number;
    messagesIngested: number;
    decisionCalls: number;
    decisionFailures: number;
    decisionInputTokens: number;
    estimatedDecisionCostUsd: number; // decisionInputTokens * 0.042 / 1e6
    dbSizeBytes: number;
    dbSizeLimitBytes: number; // 500_000_000
  };
  history: { date: string; rowsWritten: number; messagesIngested: number; decisionCalls: number }[]; // last 14 days
  accounts: (Pick<AccountView, "id" | "provider" | "email" | "status" | "paused"> & { sync: AccountSync })[];
  /** rev 2.1 A3: last 6 ISO weeks (Monday start, UTC), oldest first, zero-filled. */
  weekly: { weekStart: string; cleaned: number; undone: number }[];
}
export interface PolicyResponse {
  policy: Policy;
  version: number;
  defaults: Policy;
}

export const PutPolicyBodySchema = z.strictObject({ policy: PolicySchema, expectedVersion: z.int().min(1) });
export const PatchSenderBodySchema = z.strictObject({
  entry: SenderEntrySchema, // "user@example.com" or "@example.com"
  list: z.enum(["allow", "deny", "none"]), // "none" removes it from both lists
});

/** Error codes of the OAuth callback redirect `?error=<code>&provider=<kind>` (contracts 7.13). */
export const OAUTH_CALLBACK_ERRORS = [
  "access_denied",
  "admin_consent_required",
  "state_invalid",
  "token_exchange_failed",
  "provider_config_error",
  "scope_missing",
  "no_refresh_token",
  "profile_failed",
  "provider_not_configured",
] as const;
export type OAuthCallbackErrorCode = (typeof OAUTH_CALLBACK_ERRORS)[number];

// contracts 12.10: accuracy and learning.

/** "rule" segments skip the confidence check and are not calibrated. */
export type CalibratedSegmentName = "sender" | "domain" | "bulk" | "other";
export interface SegmentCalibrationView {
  segment: CalibratedSegmentName;
  /** null: paused, no trash suggestions in this segment until your choices agree often enough. */
  tauDelete: number | null;
  outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target";
  deleteSuggestions: number;
  precisionAtTau: number | null;
}

/** A one-click sender rule offered from consistent owner decisions (never applied automatically). */
export interface RuleSuggestion {
  entry: string; // sender address
  list: "allow" | "deny"; // allow = "Always keep", deny = "Always OK to trash"
  decisions: number; // owner decisions on this sender
  agreeing: number; // decisions matching the suggested rule
  lastDecidedAt: string;
}
export interface RuleSuggestionsResponse {
  suggestions: RuleSuggestion[];
}
export const DismissRuleSuggestionBodySchema = z.strictObject({
  entry: SenderEntrySchema,
  list: z.enum(["allow", "deny"]),
});

/** Contracts 12.9: unsubscribe assistant (RFC 8058 one-click only). */
export interface GroupUnsubscribe {
  /** The newest pending email from this sender offers one-click unsubscribe and passed DKIM. */
  oneClick: boolean;
  /** Last successful one-click unsubscribe from this sender in this account, else null. */
  unsubscribedAt: string | null;
}

export const UnsubscribeBodySchema = z.strictObject({ groupKey: z.string().min(1).max(1024) });
export type UnsubscribeBody = z.infer<typeof UnsubscribeBodySchema>;

export const UNSUBSCRIBE_ERRORS = [
  "not_available", // no pending email with one-click (or DKIM did not pass), or the headers changed
  "message_gone", // the newest email no longer exists at the provider
  "unsafe_url", // the sender's URL failed the safety check (not https, IP literal, local host, ...)
  "account_inactive", // the account needs a reconnect
  "rate_limited", // the provider throttled the header read
  "unavailable", // the provider was unavailable
  "provider_error", // any other provider failure
  "sender_rejected", // the sender answered 4xx or 5xx
  "sender_redirect", // the sender answered 3xx (RFC 8058 forbids redirects; not followed)
  "sender_timeout", // no answer within the timeout
  "sender_unreachable", // DNS, TLS or network failure
] as const;
export type UnsubscribeErrorCode = (typeof UNSUBSCRIBE_ERRORS)[number];

export interface UnsubscribeResponse {
  outcome: "unsubscribed" | "failed";
  error: UnsubscribeErrorCode | null;
  /** Set when outcome is "unsubscribed". */
  unsubscribedAt: string | null;
}
