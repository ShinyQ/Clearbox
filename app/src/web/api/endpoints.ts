import type { z } from "zod";
import type {
  ApproveBody,
  CleanupBody,
  DismissRuleSuggestionBodySchema,
  OverrideBody,
  PatchAccountBody,
  PatchSenderBodySchema,
  PutPolicyBodySchema,
  UnsubscribeBody,
} from "../../shared/api.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";
import { apiGet, apiSend } from "./client.ts";
import {
  AccountsResponseSchema,
  AccountViewSchema,
  ActionBatchPageSchema,
  ActionResponseSchema,
  ActivityPageSchema,
  CleanupPreviewSchema,
  DisconnectResponseSchema,
  GroupDetailSchema,
  InsightsSchema,
  MeResponseSchema,
  NoContentSchema,
  PolicyResponseSchema,
  RuleSuggestionsSchema,
  QueueSummarySchema,
  SenderGroupPageSchema,
  TickReportSchema,
  UndoResponseSchema,
  UnsubscribeResponseSchema,
} from "./schemas.ts";

export type PutPolicyBody = z.input<typeof PutPolicyBodySchema>;
export type PatchSenderBody = z.input<typeof PatchSenderBodySchema>;
export type DismissRuleSuggestionBody = z.input<typeof DismissRuleSuggestionBodySchema>;

export interface PageParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface GroupsQuery extends PageParams {
  accountId?: string | undefined;
  action?: Verdict | undefined;
  sort: GroupSort;
}
export interface PreviewQuery {
  actions: string;
  accountId?: string | undefined;
  threshold?: number | undefined;
}

const seg = encodeURIComponent;

export const api = {
  me: () => apiGet("/api/me", MeResponseSchema),
  accounts: () => apiGet("/api/accounts", AccountsResponseSchema),
  patchAccount: (id: string, body: PatchAccountBody) =>
    apiSend("PATCH", `/api/accounts/${seg(id)}`, AccountViewSchema, body),
  disconnectAccount: (id: string) => apiSend("DELETE", `/api/accounts/${seg(id)}`, DisconnectResponseSchema),
  scanAccount: (id: string) => apiSend("POST", `/api/accounts/${seg(id)}/scan`, TickReportSchema),
  summary: (accountId?: string) => apiGet("/api/queue/summary", QueueSummarySchema, { accountId }),
  groups: (q: GroupsQuery) =>
    apiGet("/api/groups", SenderGroupPageSchema, {
      accountId: q.accountId,
      action: q.action,
      sort: q.sort,
      limit: q.limit,
      cursor: q.cursor,
    }),
  groupDetail: (key: string, q: PageParams = {}) =>
    apiGet(`/api/groups/${seg(key)}`, GroupDetailSchema, { limit: q.limit, cursor: q.cursor }),
  approve: (body: ApproveBody) => apiSend("POST", "/api/approve", ActionResponseSchema, body),
  override: (body: OverrideBody) => apiSend("POST", "/api/override", ActionResponseSchema, body),
  unsubscribe: (body: UnsubscribeBody) =>
    apiSend("POST", "/api/unsubscribe", UnsubscribeResponseSchema, body),
  cleanupPreview: (q: PreviewQuery) =>
    apiGet("/api/cleanup/preview", CleanupPreviewSchema, {
      actions: q.actions,
      accountId: q.accountId,
      threshold: q.threshold,
    }),
  cleanup: (body: CleanupBody) => apiSend("POST", "/api/cleanup", ActionResponseSchema, body),
  batches: (q: PageParams = {}) =>
    apiGet("/api/batches", ActionBatchPageSchema, { limit: q.limit, cursor: q.cursor }),
  undoBatch: (id: number) => apiSend("POST", `/api/batches/${id}/undo`, UndoResponseSchema),
  activity: (q: PageParams & { accountId?: string | undefined }) =>
    apiGet("/api/activity", ActivityPageSchema, { accountId: q.accountId, limit: q.limit, cursor: q.cursor }),
  insights: () => apiGet("/api/insights", InsightsSchema),
  policy: () => apiGet("/api/policy", PolicyResponseSchema),
  putPolicy: (body: PutPolicyBody) => apiSend("PUT", "/api/policy", PolicyResponseSchema, body),
  patchSender: (body: PatchSenderBody) => apiSend("PATCH", "/api/policy/senders", PolicyResponseSchema, body),
  ruleSuggestions: () => apiGet("/api/rules/suggestions", RuleSuggestionsSchema),
  dismissRuleSuggestion: (body: DismissRuleSuggestionBody) =>
    apiSend("POST", "/api/rules/suggestions/dismiss", NoContentSchema, body),
};
