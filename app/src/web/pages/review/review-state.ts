import type {
  AccountView,
  CleanupPreview,
  MeResponse,
  QueueSummary,
  SenderGroup,
} from "../../../shared/api.ts";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import type { RowMove } from "../../components/review/SenderGroupList.tsx";
import { catchUpFraction, newestTickAt, providerName } from "../../lib/account-status.ts";
import { isModelUnavailable } from "../../lib/confidence.ts";
import type { CopyContext } from "../../lib/copy.ts";
import { localResetTime, relativeAgo } from "../../lib/format.ts";
import type { ActionKind, TabKey } from "../../lib/view-types.ts";

export type ReviewPageState = "loading" | "no_accounts" | "error" | "first_sort" | "all_caught_up" | "ready";
export type LoadStatus = "pending" | "error" | "success";

export function reviewPageState(i: {
  accounts: LoadStatus;
  accountCount: number;
  summary: LoadStatus;
  preview: LoadStatus;
  groups: LoadStatus;
  pendingTotal: number | null;
  backfilling: boolean;
}): ReviewPageState {
  if (i.accounts === "pending") return "loading";
  if (i.accounts === "success" && i.accountCount === 0) return "no_accounts";
  if (i.summary === "error" && i.preview === "error" && i.groups === "error") return "error";
  if (i.pendingTotal === 0) return i.backfilling ? "first_sort" : "all_caught_up";
  return "ready";
}

export function summaryCardState(
  preview: LoadStatus,
  summary: LoadStatus,
  previewCount: number,
): "loading" | "ready" | "nothing_sure" | "error" {
  if (preview === "error") return "error";
  if (preview === "pending" || summary === "pending") return "loading";
  return previewCount === 0 ? "nothing_sure" : "ready";
}

/** UI spec 5.1: preview.threshold, then summary.tauDelete, then me.tauDelete. Never a constant. */
export const resolveTau = (p?: CleanupPreview, s?: QueueSummary, m?: MeResponse): number | null =>
  p?.threshold ?? s?.tauDelete ?? m?.tauDelete ?? null;

const active = (accounts: readonly AccountView[]) => accounts.filter((a) => a.status === "active");
export const isBackfilling = (accounts: readonly AccountView[]): boolean =>
  active(accounts).some((a) => !a.sync.backfillDone);
export const isCatchingUp = (accounts: readonly AccountView[]): boolean =>
  active(accounts).some((a) => !a.sync.backfillDone || a.sync.phase !== "incremental");

export function sortedMeta(accounts: readonly AccountView[], now: number): string {
  const tick = newestTickAt(accounts);
  const base = tick ? `Sorted ${relativeAgo(tick, now)}` : "Not sorted yet";
  return isCatchingUp(accounts) ? `${base} · catching up` : base;
}

export function tabCounts(s: QueueSummary | undefined): Record<TabKey, number | null> {
  if (!s) return { all: null, trash: null, archive: null, check: null, keep: null };
  return {
    all: s.groups,
    trash: s.groupsByAction.delete,
    archive: s.groupsByAction.archive,
    check: s.groupsByAction.unsure,
    keep: s.groupsByAction.keep,
  };
}

export const modelUnavailableShare = (groups: readonly SenderGroup[]): number =>
  groups.length === 0 ? 0 : groups.filter(isModelUnavailable).length / groups.length;

export function moveTarget(keys: readonly string[], activeKey: string | null, to: RowMove): string | null {
  if (keys.length === 0) return null;
  const i = activeKey ? keys.indexOf(activeKey) : -1;
  const idx = {
    next: i + 1,
    prev: i - 1,
    first: 0,
    last: keys.length - 1,
    pagedown: i + 10,
    pageup: i - 10,
  }[to];
  return keys[Math.min(keys.length - 1, Math.max(0, idx))] ?? null;
}

/** UI spec 6.5: the next row at the same index, else the previous row. */
export function nextAfterRemoval(keys: readonly string[], removed: readonly string[]): string | null {
  const first = keys.findIndex((k) => removed.includes(k));
  const remaining = keys.filter((k) => !removed.includes(k));
  if (remaining.length === 0) return null;
  return remaining[Math.min(Math.max(first, 0), remaining.length - 1)] ?? null;
}

export function firstSortProgress(accounts: readonly AccountView[]): {
  value: number | null;
  sorted: number;
} {
  const sorted = accounts.reduce((sum, a) => sum + a.sync.messagesIngested, 0);
  const backfilling = active(accounts).filter((a) => !a.sync.backfillDone);
  const fractions = backfilling.map(catchUpFraction);
  if (fractions.length === 0 || fractions.some((f) => f === null)) return { value: null, sorted };
  const known = fractions as number[];
  return { value: known.reduce((s, f) => s + f, 0) / known.length, sorted };
}

export function buildCopyContext(i: {
  scope: readonly AccountView[];
  accountId: string | undefined;
  pendingTotal: number;
  now: number;
}): CopyContext {
  // The server leaves every non-active account (needs_reauth or config_error) out of trash/archive Clean up.
  const inactive = i.scope.find((a) => a.status !== "active") ?? null;
  const providers = [...new Set(i.scope.map((a) => a.provider))];
  return {
    pendingTotal: i.pendingTotal,
    accountEmail: i.accountId ? (i.scope.find((a) => a.id === i.accountId)?.email ?? null) : null,
    inactiveEmail: inactive?.email ?? null,
    providerLabel: providers.length === 1 && providers[0] ? providerName(providers[0]) : "Your mail provider",
    resetTime: localResetTime(i.now),
  };
}

const VERB: Record<ActionKind, string> = { delete: "moved to Trash", archive: "archived", keep: "kept" };

/** Live-region text after a keyboard action (UI spec 7.3): what happened and which row is next. */
export const actionAnnouncement = (
  group: SenderGroup,
  target: ActionKind,
  next: SenderGroup | undefined,
): string => `${displayName(group).text} ${VERB[target]}.${next ? ` Next: ${displayName(next).text}.` : ""}`;
