import { DetailPanel, DetailPanelSkeleton } from "../../components/review/DetailPanel.tsx";
import { SenderGroupList } from "../../components/review/SenderGroupList.tsx";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import { UnsubscribeSection } from "../../components/review/UnsubscribeSection.tsx";
import { providerName } from "../../lib/account-status.ts";
import { localResetTime } from "../../lib/format.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import type { ReviewController } from "./use-review-controller.ts";
import { useUnsubscribe } from "./use-unsubscribe.ts";

/** List plus detail (UI spec 4.7, 4.14). Uses overflow-clip so the sticky header still sticks to the page. */
export function ReviewWorkArea({ c }: { c: ReviewController }) {
  const g = c.activeGroup;
  const detailPages = c.detailQ.data?.pages ?? [];
  const tau = c.tau;
  const listLoading = c.groupsQ.isPending || tau === null;
  const inline = c.detailMode === "inline" && g !== null && tau !== null;
  // Reserve the inline panel column while the list loads so the list does not narrow afterwards.
  const placeholder = c.detailMode === "inline" && listLoading;
  const twoColumns = inline || placeholder;
  const unsub = useUnsubscribe(
    c.groupActions,
    (id) => ({
      providerLabel: providerName(c.accountsById[id]?.provider ?? "gmail"),
      resetTime: localResetTime(Date.now()),
    }),
    g?.key ?? null,
  );
  const account = g ? (c.accountsById[g.accountId] ?? null) : null;
  const groupBusy =
    g !== null &&
    (c.groupActions.busyKeys.has(g.key) ||
      c.groupActions.exitingKeys.has(g.key) ||
      (c.groupActions.busyAction?.key === g.key && unsub.runningFor(g.key) === null) ||
      (unsub.busy && unsub.runningFor(g.key) === null));
  return (
    <div
      className={`overflow-clip rounded-b-xl border border-t-0 border-line bg-surface ${twoColumns ? "xl:grid xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}
    >
      <div className={`min-w-0 ${twoColumns ? "xl:border-r xl:border-line" : ""}`}>
        <SenderGroupList
          state={
            listLoading ? "loading" : c.groupsQ.isError ? "error" : c.groups.length === 0 ? "empty" : "ready"
          }
          tab={c.tab}
          groups={c.groups}
          tau={tau}
          accountsById={c.accountsById}
          showAccount={c.accounts.length > 1 && !c.accountId}
          activeKey={c.activeKey}
          selected={c.selection.selected}
          busyKeys={c.groupActions.busyKeys}
          exitingKeys={c.groupActions.exitingKeys}
          totalInTab={c.counts[c.tab]}
          hasNextPage={c.groupsQ.hasNextPage}
          isFetchingNextPage={c.groupsQ.isFetchingNextPage}
          bulkProgress={c.groupActions.bulkProgress}
          platform={c.platform}
          onActivate={c.activate}
          onToggleSelect={(key, o) => (o.range ? c.selection.range(key, c.keys) : c.selection.toggle(key))}
          onSelectAllLoaded={() => c.selection.selectAll(c.keys)}
          onSelectAllInTab={() => void c.selectAllInTab()}
          onClearSelection={c.selection.clear}
          onBulkAction={c.bulkAction}
          onLoadMore={() => void c.groupsQ.fetchNextPage()}
          onRetry={() => void c.groupsQ.refetch()}
          onMove={c.move}
        />
      </div>
      {placeholder ? <DetailPanelSkeleton /> : null}
      {tau === null ? null : (
        <DetailPanel
          mode={c.detailMode}
          open={c.detailMode === "inline" ? g !== null : c.detailOpen}
          group={g}
          items={detailPages.flatMap((p) => p.items.items)}
          detailState={c.detailQ.isPending ? "loading" : c.detailQ.isError ? "error" : "ready"}
          hasMoreItems={c.detailQ.hasNextPage}
          loadingMoreItems={c.detailQ.isFetchingNextPage}
          tau={tau}
          account={account}
          busyAction={
            c.groupActions.busyAction && g && c.groupActions.busyAction.key === g.key
              ? c.groupActions.busyAction.action
              : null
          }
          actionsDisabled={c.cleanupBusy}
          busyItemIds={c.itemActions.busyItemIds}
          now={c.now}
          platform={c.platform}
          headingRef={c.headingRef}
          onAction={(a) => void c.performAction(a)}
          onAlwaysKeep={(entry) => g && void c.itemActions.alwaysKeep(g, entry, c.asOf)}
          onAlwaysTrash={() => g && void c.itemActions.alwaysTrash(g)}
          onCopyAddress={() => g && void c.itemActions.copyAddress(g)}
          onItemAction={(id, a) => {
            const item = detailPages.flatMap((p) => p.items.items).find((i) => i.id === id);
            if (g && item) void c.itemActions.itemAction(g, item, a);
          }}
          onLoadMoreItems={() => void c.detailQ.fetchNextPage()}
          onClose={c.closeDetail}
          onRetry={() => void c.detailQ.refetch()}
          onReconnect={(a) => startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email })}
          unsubscribe={
            g && g.sender !== "" ? (
              <UnsubscribeSection
                key={g.key}
                name={displayName(g).text}
                count={g.count}
                state={detailPages[0]?.unsubscribe ?? null}
                phase={unsub.phaseFor(g.key)}
                running={unsub.runningFor(g.key)}
                disabled={account?.status === "needs_reauth" || c.cleanupBusy || c.offline || groupBusy}
                onStart={() => unsub.start(g.key)}
                onCancel={unsub.cancel}
                onConfirm={(choice) => void unsub.confirm(g, displayName(g).text, choice, c.asOf)}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}
