import type { ActionKind, SuggestedAction } from "@clearbox/core";
import type {
  ActionBatchView,
  ActionResponse,
  CleanupPreview,
  ItemResult,
  QueueSummary,
  SenderGroup,
  SuggestionItem,
} from "../../../src/shared/api.ts";
import { keyOf, pendingItems, type FakeApiState, type FakeItem } from "./fake-api-state.ts";
import { iso } from "./fixtures.ts";

export { createFakeApiState, encodeGroupKey, keyOf, pendingItems } from "./fake-api-state.ts";
export type {
  FakeApiState,
  FakeBatch,
  FakeItem,
  Failure,
  RecordedRequest,
  RouteName,
} from "./fake-api-state.ts";

function toGroup(s: FakeApiState, key: string, list: FakeItem[]): SenderGroup {
  const byNewest = [...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const newest = byNewest[0]!;
  const oldest = byNewest[byNewest.length - 1]!;
  const confs = list.map((i) => i.confidence);
  return {
    key,
    accountId: newest.accountId,
    provider: s.accounts.find((a) => a.id === newest.accountId)?.provider ?? "gmail",
    sender: newest.sender,
    senderName: newest.senderName,
    domain: newest.domain,
    action: newest.action,
    count: list.length,
    confidence: {
      min: Math.min(...confs),
      avg: confs.reduce((sum, c) => sum + c, 0) / confs.length,
      max: Math.max(...confs),
    },
    topReasons: newest.reasons.slice(0, 3),
    ceilingApplied: list.some((i) => i.ceilingApplied),
    newestReceivedAt: newest.receivedAt,
    oldestReceivedAt: oldest.receivedAt,
    latestSubject: newest.subject,
  };
}

export function deriveGroups(s: FakeApiState, accountId?: string | null): SenderGroup[] {
  const map = new Map<string, FakeItem[]>();
  for (const item of pendingItems(s, accountId)) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map].map(([key, list]) => toGroup(s, key, list));
}

export function sortGroups(groups: SenderGroup[], sort: string): SenderGroup[] {
  const copy = [...groups];
  if (sort === "count_desc") return copy.sort((a, b) => b.count - a.count);
  if (sort === "newest") return copy.sort((a, b) => b.newestReceivedAt.localeCompare(a.newestReceivedAt));
  return copy.sort((a, b) => b.confidence.avg - a.confidence.avg);
}

export function toSuggestionItem(s: FakeApiState, i: FakeItem): SuggestionItem {
  return {
    id: i.id,
    accountId: i.accountId,
    provider: s.accounts.find((a) => a.id === i.accountId)?.provider ?? "gmail",
    status: "pending",
    action: i.action,
    confidence: i.confidence,
    distribution: null,
    importance: null,
    ceiling: "delete",
    ceilingApplied: i.ceilingApplied,
    reasons: i.reasons,
    from: { address: i.sender, name: i.senderName },
    subject: i.subject,
    snippet: i.snippet,
    receivedAt: i.receivedAt,
    isRead: i.isRead,
    signals: {
      hasListUnsubscribe: true,
      precedenceBulk: false,
      autoSubmitted: false,
      category: null,
      hasAttachments: false,
      starred: false,
      ownerReplied: false,
      isCorrespondent: false,
      ageDays: 5,
      ownerPosition: "to",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    },
    deepLink: i.deepLink,
    modelVersion: "decision-1",
    policyVersion: 1,
  };
}

const count = (list: FakeItem[], a: SuggestedAction): number => list.filter((i) => i.action === a).length;

export function summaryOf(s: FakeApiState, accountId?: string | null): QueueSummary {
  const pend = pendingItems(s, accountId);
  const groups = deriveGroups(s, accountId);
  const g = (a: SuggestedAction) => groups.filter((x) => x.action === a).length;
  const atTau = pend.filter((i) => i.action !== "unsure" && i.confidence >= s.tau);
  return {
    asOf: iso(s.now),
    pending: {
      delete: count(pend, "delete"),
      archive: count(pend, "archive"),
      keep: count(pend, "keep"),
      unsure: count(pend, "unsure"),
      total: pend.length,
    },
    awaitingModel: s.awaitingModel,
    recentHeld: 0,
    groups: groups.length,
    tauDelete: s.tau,
    cleanup: {
      threshold: s.tau,
      count: atTau.length,
      byAction: {
        delete: count(atTau, "delete"),
        archive: count(atTau, "archive"),
        keep: count(atTau, "keep"),
      },
    },
    groupsByAction: { delete: g("delete"), archive: g("archive"), keep: g("keep"), unsure: g("unsure") },
  };
}

export interface ScopeQuery {
  actions: ActionKind[];
  threshold: number;
  accountId?: string | null;
}

export function inScope(s: FakeApiState, q: ScopeQuery): FakeItem[] {
  return pendingItems(s, q.accountId)
    .filter((i) => q.actions.includes(i.action as ActionKind) && i.confidence >= q.threshold)
    .sort((a, b) => b.confidence - a.confidence);
}

export function previewOf(s: FakeApiState, q: ScopeQuery): CleanupPreview {
  const scoped = inScope(s, q);
  const ids = new Set(scoped.map((i) => i.id));
  const left = pendingItems(s, q.accountId).filter((i) => !ids.has(i.id));
  return {
    asOf: iso(s.now),
    threshold: q.threshold,
    defaultThreshold: s.tau,
    count: scoped.length,
    byAction: {
      delete: count(scoped, "delete"),
      archive: count(scoped, "archive"),
      keep: count(scoped, "keep"),
    },
    groups: new Set(scoped.map(keyOf)).size,
    groupsLeft: new Set(left.map(keyOf)).size,
  };
}

export function execute(
  s: FakeApiState,
  targets: { item: FakeItem; action: ActionKind }[],
  kind: ActionBatchView["kind"],
): Omit<ActionResponse, "remaining"> {
  const results: ItemResult[] = [];
  const executedIds: number[] = [];
  const byAction = { delete: 0, archive: 0, keep: 0 };
  let failed = 0;
  let retryLater = 0;
  for (const { item, action } of targets) {
    if (s.retryLaterIds.has(item.id)) {
      retryLater += 1;
      results.push({ id: item.id, outcome: "retry_later", action, error: s.retryLaterCode });
    } else if (s.failIds.has(item.id)) {
      failed += 1;
      item.status = "failed";
      results.push({ id: item.id, outcome: "failed", action, error: "not_found" });
    } else {
      item.status = "executed";
      item.finalAction = action;
      byAction[action] += 1;
      executedIds.push(item.id);
      results.push({ id: item.id, outcome: "executed", action, error: null });
    }
  }
  let batchId: number | null = null;
  if (executedIds.length > 0) {
    batchId = s.nextBatchId++;
    s.batches.unshift({
      id: batchId,
      kind,
      createdAt: iso(s.now),
      requestedCount: targets.length,
      executedCount: executedIds.length,
      failedCount: failed,
      byAction,
      undoable: true,
      undoExpiresAt: iso(s.now + 24 * 3_600_000),
      undoneAt: null,
      itemIds: executedIds,
    });
  }
  return { batchId, results, executed: executedIds.length, failed, skipped: 0, retryLater };
}
