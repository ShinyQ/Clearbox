import { ScanHistoryDaysSchema } from "@clearbox/core";
import type { ReasonCode } from "@clearbox/core";
import { z } from "zod";
import {
  PutPolicyBodySchema,
  type AccountsResponse,
  type AccountSync,
  type AccountView,
  type ActionBatchView,
  type ActionResponse,
  type ActivityEntry,
  type ActivityKind,
  type ApiReason,
  type AppIssueCode,
  type CleanupPreview,
  type DisconnectResponse,
  type GroupDetail,
  type Insights,
  type ItemErrorCode,
  type ItemSignals,
  type MeResponse,
  type Page,
  type PolicyResponse,
  type QueueSummary,
  type RuleSuggestionsResponse,
  type SenderGroup,
  type SuggestionItem,
  type TickReport,
  type UndoResponse,
} from "../../shared/api.ts";

// Every schema is checked against its contract type with `satisfies` (decision W1).
const str = z.string();
const num = z.number();
const bool = z.boolean();
const nstr = z.string().nullable();
const actionKind = z.enum(["delete", "archive", "keep"]);
const suggested = z.enum(["delete", "archive", "keep", "unsure"]);
const provider = z.enum(["gmail", "outlook"]);
const byActionKind = z.object({ delete: num, archive: num, keep: num });
const bySuggested = z.object({ delete: num, archive: num, keep: num, unsure: num });
const anyString = <T extends string>() => z.custom<T>((v) => typeof v === "string");

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: nstr });
}

export const ApiReasonSchema = z.object({
  code: anyString<ReasonCode>(),
  text: str,
}) satisfies z.ZodType<ApiReason>;

export const MeResponseSchema = z.object({
  email: str,
  environment: z.enum(["development", "test", "production"]),
  freeTier: bool,
  providers: z.object({ gmail: bool, outlook: bool }),
  issues: z.array(z.object({ code: anyString<AppIssueCode>(), since: str, accountId: nstr })),
  tauDelete: num,
  serverTime: str,
}) satisfies z.ZodType<MeResponse>;

export const AccountSyncSchema = z.object({
  phase: z.enum(["sent_backfill", "inbox_backfill", "incremental"]),
  backfillDone: bool,
  messagesIngested: num,
  pendingCount: num,
  awaitingModelCount: num,
  lastTickAt: nstr,
  nextTickAt: nstr,
  backoffUntil: nstr,
  lastErrorCode: nstr,
  pageSize: num,
  inboxEstimate: num.nullable(),
  scanHistoryDays: ScanHistoryDaysSchema,
}) satisfies z.ZodType<AccountSync>;

const accountStatus = z.enum(["active", "needs_reauth", "config_error"]);

export const AccountViewSchema = z.object({
  id: str,
  provider,
  email: str,
  status: accountStatus,
  statusReason: nstr,
  paused: bool,
  archiveSupported: bool,
  sync: AccountSyncSchema,
  createdAt: str,
}) satisfies z.ZodType<AccountView>;

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountViewSchema),
}) satisfies z.ZodType<AccountsResponse>;

export const DisconnectResponseSchema = z.object({
  accountId: str,
  revocation: z.enum(["revoked", "failed", "not_supported"]),
  consentUrls: z.object({ personal: str, work: str }).nullable(),
}) satisfies z.ZodType<DisconnectResponse>;

export const TickReportSchema = z.object({
  outcome: z.enum(["processed", "idle", "error"]),
  accountId: nstr,
  kind: z.enum(["sent_backfill", "inbox_backfill", "incremental", "redecide"]).nullable(),
  phase: z.enum(["sent_backfill", "inbox_backfill", "incremental"]).nullable(),
  fetched: num,
  skippedKnown: num,
  decided: num,
  deferred: num,
  unsure: num,
  removed: num,
  subrequests: num,
  rowsWritten: num,
  nextTickAt: nstr,
  errorCode: nstr,
}) satisfies z.ZodType<TickReport>;

export const QueueSummarySchema = z.object({
  asOf: str,
  pending: bySuggested.extend({ total: num }),
  awaitingModel: num,
  recentHeld: num,
  groups: num,
  tauDelete: num,
  cleanup: z.object({ threshold: num, count: num, byAction: byActionKind }),
  groupsByAction: bySuggested,
}) satisfies z.ZodType<QueueSummary>;

export const SenderGroupSchema = z.object({
  key: str,
  accountId: str,
  provider,
  sender: str,
  senderName: nstr,
  domain: str,
  action: suggested,
  count: num,
  confidence: z.object({ min: num, avg: num, max: num }),
  topReasons: z.array(ApiReasonSchema),
  ceilingApplied: bool,
  newestReceivedAt: str,
  oldestReceivedAt: str,
  latestSubject: nstr,
}) satisfies z.ZodType<SenderGroup>;

export const SenderGroupPageSchema = pageSchema(SenderGroupSchema) satisfies z.ZodType<Page<SenderGroup>>;

export const SuggestionItemSchema = z.object({
  id: num,
  accountId: str,
  provider,
  status: z.enum(["awaiting_model", "pending", "approved", "executed", "failed", "dismissed", "undone"]),
  action: suggested,
  confidence: num,
  distribution: bySuggested.nullable(),
  importance: num.nullable(),
  ceiling: actionKind,
  ceilingApplied: bool,
  reasons: z.array(ApiReasonSchema),
  from: z.object({ address: str, name: nstr }),
  subject: nstr,
  snippet: nstr,
  receivedAt: str,
  isRead: bool,
  signals: z.custom<ItemSignals>((v) => typeof v === "object" && v !== null),
  deepLink: nstr,
  modelVersion: nstr,
  policyVersion: num,
}) satisfies z.ZodType<SuggestionItem>;

export const GroupDetailSchema = z.object({
  asOf: str,
  group: SenderGroupSchema,
  items: pageSchema(SuggestionItemSchema),
}) satisfies z.ZodType<GroupDetail>;

export const CleanupPreviewSchema = z.object({
  asOf: str,
  threshold: num,
  defaultThreshold: num,
  count: num,
  byAction: byActionKind,
  groups: num,
  groupsLeft: num,
}) satisfies z.ZodType<CleanupPreview>;

export const ActionResponseSchema = z.object({
  batchId: num.nullable(),
  results: z.array(
    z.object({
      id: num,
      outcome: z.enum(["executed", "failed", "skipped", "retry_later"]),
      action: actionKind.nullable(),
      error: anyString<ItemErrorCode>().nullable(),
    }),
  ),
  executed: num,
  failed: num,
  skipped: num,
  retryLater: num,
  remaining: num,
}) satisfies z.ZodType<ActionResponse>;

export const ActionBatchViewSchema = z.object({
  id: num,
  kind: z.enum(["approve", "override", "cleanup"]),
  createdAt: str,
  requestedCount: num,
  executedCount: num,
  failedCount: num,
  byAction: byActionKind,
  undoable: bool,
  undoExpiresAt: str,
  undoneAt: nstr,
}) satisfies z.ZodType<ActionBatchView>;

export const ActionBatchPageSchema = pageSchema(ActionBatchViewSchema) satisfies z.ZodType<
  Page<ActionBatchView>
>;

export const UndoResponseSchema = z.object({
  batchId: num,
  results: z.array(
    z.object({
      id: num,
      outcome: z.enum(["restored", "failed", "skipped"]),
      error: anyString<ItemErrorCode>().nullable(),
    }),
  ),
  restored: num,
  failed: num,
  skipped: num,
}) satisfies z.ZodType<UndoResponse>;

export const ActivityEntrySchema = z.object({
  id: num,
  ts: str,
  kind: anyString<ActivityKind>(),
  accountId: nstr,
  batchId: num.nullable(),
  count: num,
  result: z.record(z.string(), z.union([num, str])),
}) satisfies z.ZodType<ActivityEntry>;

export const ActivityPageSchema = pageSchema(ActivityEntrySchema) satisfies z.ZodType<Page<ActivityEntry>>;

export const InsightsSchema = z.object({
  precision: z.object({ deletePrecision: num.nullable(), deleteSuggestionsDecided: num, window: num }),
  labels: z.object({ total: num, last7Days: num }),
  calibration: z.object({
    tauDelete: num,
    outcome: z.enum(["insufficient_data", "calibrated", "no_tau_meets_target"]).nullable(),
    ranAt: nstr,
    points: z.array(z.object({ tau: num, support: num, precision: num.nullable() })),
    segments: z.array(
      z.object({
        segment: z.enum(["sender", "domain", "bulk", "other"]),
        tauDelete: num.nullable(),
        outcome: z.enum(["insufficient_data", "calibrated", "no_tau_meets_target"]),
        deleteSuggestions: num,
        precisionAtTau: num.nullable(),
      }),
    ),
  }),
  budget: z.object({
    date: str,
    rowsWritten: num,
    rowsCap: num,
    ingestStopRows: num,
    d1DailyWriteLimit: num,
    ticks: num,
    messagesIngested: num,
    decisionCalls: num,
    decisionFailures: num,
    decisionInputTokens: num,
    estimatedDecisionCostUsd: num,
    dbSizeBytes: num,
    dbSizeLimitBytes: num,
  }),
  history: z.array(z.object({ date: str, rowsWritten: num, messagesIngested: num, decisionCalls: num })),
  accounts: z.array(
    z.object({ id: str, provider, email: str, status: accountStatus, paused: bool, sync: AccountSyncSchema }),
  ),
  weekly: z.array(z.object({ weekStart: str, cleaned: num, undone: num })),
}) satisfies z.ZodType<Insights>;

const policy = PutPolicyBodySchema.shape.policy;

export const PolicyResponseSchema = z.object({
  policy,
  version: num,
  defaults: policy,
}) satisfies z.ZodType<PolicyResponse>;

export const RuleSuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      entry: str,
      list: z.enum(["allow", "deny"]),
      decisions: num,
      agreeing: num,
      lastDecidedAt: str,
    }),
  ),
}) satisfies z.ZodType<RuleSuggestionsResponse>;
