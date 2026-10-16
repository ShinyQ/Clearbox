import { useCallback, useMemo, useState } from "react";
import {
  flattenGroups,
  useAccounts,
  useCleanupPreview,
  useGroupDetail,
  useGroups,
  useMe,
  useQueueSummary,
} from "../../api/queries.ts";
import type { BulkAction } from "../../components/review/SelectionToolbar.tsx";
import { providerName } from "../../lib/account-status.ts";
import { GENERIC_ERROR } from "../../lib/copy-actions.ts";
import { formatCount, localResetTime } from "../../lib/format.ts";
import { TAB_ACTION, TAB_KEYS, type ActionKind, type GroupSort, type TabKey } from "../../lib/view-types.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { useOffline } from "../../state/offline.ts";
import { useDocumentTitle } from "../../state/use-document-title.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { useNow } from "../../state/use-now.ts";
import { usePlatform } from "../../state/use-platform.ts";
import { useSelection } from "../../state/use-selection.ts";
import {
  isBackfilling,
  modelUnavailableShare,
  actionAnnouncement,
  buildCopyContext,
  moveTarget,
  nextAfterRemoval,
  resolveTau,
  reviewPageState,
  sortedMeta,
  summaryCardState,
  tabCounts,
  type LoadStatus,
} from "./review-state.ts";
import { useGroupActions, type GroupActionCallbacks } from "./use-group-actions.ts";
import { useItemActions } from "./use-item-actions.ts";
import { useDetailMode, useJustCleaned, useReviewEffects } from "./use-review-effects.ts";
import { useReviewFocus, FOCUS_EMPTY, FOCUS_HEADING } from "./use-review-focus.ts";
import { useNewSuggestions } from "./use-new-suggestions.ts";
import { useReviewHotkeys } from "./use-review-hotkeys.ts";
import { useReviewParams } from "./use-review-params.ts";
import { useScanNow } from "./use-scan-now.ts";
import { loadKeysForSelectAll } from "./select-all.ts";

const status = (q: { isPending: boolean; isError: boolean }): LoadStatus =>
  q.isError ? "error" : q.isPending ? "pending" : "success";

export function useReviewController() {
  const params = useReviewParams();
  const { accountId, tab, sort } = params;
  const now = useNow();
  const platform = usePlatform();
  const offline = useOffline();
  const announce = useAnnounce();
  const toast = useToast();
  const cleanup = useCleanup();
  const phase = cleanup.state.machine.phase;
  const me = useMe();
  const accountsQ = useAccounts();
  const summaryQ = useQueueSummary(accountId);
  const previewQ = useCleanupPreview(accountId, phase === "idle");
  const groupsQ = useGroups({ accountId, action: TAB_ACTION[tab], sort });
  const accounts = useMemo(() => accountsQ.data?.accounts ?? [], [accountsQ.data]);
  const accountsById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);
  const scope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  const groups = useMemo(() => flattenGroups(groupsQ.data), [groupsQ.data]);
  const keys = useMemo(() => groups.map((g) => g.key), [groups]);
  const tau = resolveTau(previewQ.data, summaryQ.data, me.data);
  // Falls back to the first row so the grid always has a tab stop.
  const activeKey = params.groupKey && keys.includes(params.groupKey) ? params.groupKey : (keys[0] ?? null);
  const activeGroup = groups.find((g) => g.key === activeKey) ?? null;
  const detailQ = useGroupDetail(activeKey);
  const selection = useSelection();
  const detailMode = useDetailMode();
  const [detailOpen, setDetailOpen] = useState(false);
  const pill = useNewSuggestions(summaryQ.data, groupsQ.dataUpdatedAt);
  const focus = useReviewFocus(phase, activeKey, groups.length === 0);
  const { titleRef, headingRef, summaryButtonRef, emptyActionRef, request } = focus;
  const asOf = detailQ.data?.pages[0]?.asOf ?? summaryQ.data?.asOf ?? new Date(now).toISOString();

  const callbacks: GroupActionCallbacks = {
    onRemoved: (removed) => {
      selection.remove(removed);
      if (activeKey && removed.includes(activeKey)) {
        const next = nextAfterRemoval(keys, removed);
        params.update({ group: next }, true);
        request(next ?? FOCUS_EMPTY);
      }
    },
    onRestored: (key) => {
      params.update({ group: key }, true);
      request(key);
    },
    onDelta: pill.applyDelta,
    errorContext: (id) => ({
      providerLabel: providerName(accountsById[id]?.provider ?? "gmail"),
      resetTime: localResetTime(Date.now()),
    }),
    accountFor: (id) => accountsById[id],
  };
  const groupActions = useGroupActions(callbacks);
  const itemActions = useItemActions(groupActions, callbacks);
  const scan = useScanNow(accounts, accountId);

  const justCleaned = useJustCleaned(phase, previewQ.data?.count ?? 0);

  useReviewEffects({ keys, activeKey, selectedCount: selection.selected.size, newSuggestions: pill.show });

  const activate = useCallback(
    (key: string, opts: { openDetail: boolean; keyboard?: boolean }) => {
      params.update({ group: key }, true);
      selection.setAnchor(key);
      if (!opts.openDetail) return;
      if (detailMode !== "inline") {
        setDetailOpen(true);
        request(FOCUS_HEADING);
      } else if (opts.keyboard) request(FOCUS_HEADING);
    },
    [detailMode, params, selection, request],
  );

  const move = (to: Parameters<typeof moveTarget>[2]) => {
    const target = moveTarget(keys, activeKey, to);
    if (!target) return;
    params.update({ group: target }, true);
    selection.setAnchor(target);
    request(target);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    if (activeKey) request(activeKey);
  };

  // Hotkeys and bulk approve are ignored while Clean up is preparing, confirming or running: its preview
  // and run are tied to the groups as they were, so a concurrent action would make them stale. The mouse
  // path shows the same rule as soft-disabled detail buttons (ReviewWorkArea) instead of a silent no-op.
  const cleanupPhase = cleanup.state.machine.phase;
  const cleanupBusy =
    cleanupPhase === "preparing" || cleanupPhase === "confirming" || cleanupPhase === "running";
  const bulkRunning = groupActions.bulkProgress !== null;
  const selectedIdle = () =>
    groups.filter((g) => selection.selected.has(g.key) && !groupActions.busyKeys.has(g.key));
  const performAction = async (target: ActionKind) => {
    if (offline || cleanupBusy || bulkRunning) return;
    if (selection.selected.size > 0) {
      const picked = selectedIdle();
      if (picked.length > 0) await groupActions.bulk(picked, target, asOf);
      return;
    }
    if (
      !activeGroup ||
      groupActions.busyKeys.has(activeGroup.key) ||
      groupActions.exitingKeys.has(activeGroup.key)
    )
      return;
    const i = keys.indexOf(activeGroup.key);
    const next = groups[i + 1] ?? groups[i - 1];
    if (await groupActions.act(activeGroup, target, asOf)) {
      announce(actionAnnouncement(activeGroup, target, next));
    }
  };

  const toggleActive = () => {
    if (!activeKey || cleanupBusy || groupActions.busyKeys.has(activeKey)) return;
    selection.toggle(activeKey);
  };

  const bulkAction = (action: BulkAction) => {
    if (action === "approve") {
      if (offline || cleanupBusy || bulkRunning) return;
      const picked = selectedIdle();
      if (picked.length > 0) void groupActions.bulk(picked, "approve", asOf);
    } else void performAction(action);
  };

  const selectAllInTab = async () => {
    const keys = await loadKeysForSelectAll(groupsQ);
    if (keys) selection.selectAll(keys);
    else toast.show({ kind: "error", message: GENERIC_ERROR });
  };

  const resetView = (update: Parameters<typeof params.update>[0]) => {
    params.update({ ...update, group: null });
    selection.clear();
  };
  const changeTab = (t: TabKey) => resetView({ tab: t });
  const changeSort = (s: GroupSort) => resetView({ sort: s });
  const changeAccount = (v: string) => resetView({ account: v === "all" ? null : v });

  const summaryState = summaryCardState(status(previewQ), status(summaryQ), previewQ.data?.count ?? 0);
  const startCleanup = () => {
    if (offline || summaryState !== "ready" || phase !== "idle") return;
    cleanup.start("cleanup", accountId);
  };

  const pageState = reviewPageState({
    accounts: status(accountsQ),
    accountCount: accounts.length,
    summary: status(summaryQ),
    preview: status(previewQ),
    groups: status(groupsQ),
    pendingTotal: summaryQ.data?.pending.total ?? null,
    backfilling: isBackfilling(scope),
  });

  useReviewHotkeys(
    {
      move,
      toggleActive,
      rangeToActive: () => {
        if (activeKey && !cleanupBusy) selection.range(activeKey, keys);
      },
      act: (a) => void performAction(a),
      cleanUp: startCleanup,
      tab: (i) => {
        const t = TAB_KEYS[i];
        if (t) changeTab(t);
      },
      escape: () => selection.selected.size > 0 && selection.clear(),
    },
    pageState === "ready",
  );

  const groupCount = summaryQ.data?.groups ?? 0;
  useDocumentTitle(groupCount > 0 ? `(${formatCount(groupCount)}) Review · Clearbox` : "Review · Clearbox");

  const copyContext = buildCopyContext({
    scope,
    accountId,
    pendingTotal: summaryQ.data?.pending.total ?? 0,
    now,
  });

  return {
    params,
    tab,
    sort,
    accountId,
    now,
    platform,
    offline,
    cleanup,
    cleanupBusy,
    me,
    accounts,
    accountsById,
    scope,
    groups,
    keys,
    tau,
    activeKey,
    activeGroup,
    detailQ,
    selection,
    detailMode,
    detailOpen,
    pill,
    titleRef,
    headingRef,
    summaryButtonRef,
    emptyActionRef,
    groupActions,
    itemActions,
    scan,
    justCleaned,
    summaryQ,
    previewQ,
    groupsQ,
    summaryState,
    pageState,
    copyContext,
    meta: sortedMeta(scope, now),
    counts: tabCounts(summaryQ.data),
    modelShare: modelUnavailableShare(groups),
    asOf,
    activate,
    move,
    closeDetail,
    performAction,
    bulkAction,
    selectAllInTab,
    changeTab,
    changeSort,
    changeAccount,
    startCleanup,
  };
}

export type ReviewController = ReturnType<typeof useReviewController>;
