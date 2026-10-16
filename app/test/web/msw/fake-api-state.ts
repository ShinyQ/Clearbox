import type { ActionKind, SuggestedAction } from "@clearbox/core";
import type {
  AccountView,
  ActionBatchView,
  ActivityEntry,
  ApiErrorCode,
  ApiReason,
  Insights,
  ItemErrorCode,
  MeResponse,
  PolicyResponse,
} from "../../../src/shared/api.ts";
import {
  T0,
  defaultAccounts,
  defaultActivity,
  defaultBatches,
  defaultItems,
  makeInsights,
  makeMe,
  makePolicyResponse,
} from "./fixtures.ts";

export interface FakeItem {
  id: number;
  accountId: string;
  sender: string;
  senderName: string | null;
  domain: string;
  action: SuggestedAction;
  confidence: number;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
  reasons: ApiReason[];
  ceilingApplied: boolean;
  deepLink: string | null;
  status: "pending" | "executed" | "failed" | "undone";
  finalAction: ActionKind | null;
}

export type RouteName =
  | "me"
  | "accounts"
  | "patchAccount"
  | "deleteAccount"
  | "scan"
  | "summary"
  | "groups"
  | "group"
  | "approve"
  | "override"
  | "preview"
  | "cleanup"
  | "batches"
  | "undo"
  | "activity"
  | "insights"
  | "policy"
  | "putPolicy"
  | "patchSender";

export interface Failure {
  status: number;
  code: ApiErrorCode | "network";
  times: number;
  retryAt?: string;
  details?: unknown;
}

export interface RecordedRequest {
  route: RouteName;
  method: string;
  url: URL;
  body: unknown;
  csrf: string | null;
}

export type FakeBatch = ActionBatchView & { itemIds: number[] };

export interface FakeApiState {
  now: number;
  tau: number;
  me: MeResponse;
  accounts: AccountView[];
  items: FakeItem[];
  awaitingModel: number;
  batches: FakeBatch[];
  activity: ActivityEntry[];
  insights: Insights;
  policy: PolicyResponse;
  scanDecided: number;
  scanOutcome: "processed" | "idle" | "error";
  failures: Partial<Record<RouteName, Failure>>;
  retryLaterIds: Set<number>;
  retryLaterCode: ItemErrorCode;
  failIds: Set<number>;
  requests: RecordedRequest[];
  nextBatchId: number;
}

export function createFakeApiState(): FakeApiState {
  const accounts = defaultAccounts();
  return {
    now: T0,
    tau: 0.86,
    me: makeMe(),
    accounts,
    items: defaultItems(),
    awaitingModel: 0,
    batches: defaultBatches(),
    activity: defaultActivity(),
    insights: makeInsights(accounts),
    policy: makePolicyResponse(),
    scanDecided: 0,
    scanOutcome: "processed",
    failures: {},
    retryLaterIds: new Set(),
    retryLaterCode: "unavailable",
    failIds: new Set(),
    requests: [],
    nextBatchId: 10,
  };
}

export function encodeGroupKey(accountId: string, sender: string, action: SuggestedAction): string {
  const bytes = new TextEncoder().encode(JSON.stringify([accountId, sender, action]));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const keyOf = (i: FakeItem): string => encodeGroupKey(i.accountId, i.sender, i.action);

export function pendingItems(s: FakeApiState, accountId?: string | null): FakeItem[] {
  return s.items.filter((i) => i.status === "pending" && (!accountId || i.accountId === accountId));
}
