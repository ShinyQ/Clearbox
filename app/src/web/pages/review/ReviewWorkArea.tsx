import { DetailPanel } from "../../components/review/DetailPanel.tsx";
import { SenderGroupList } from "../../components/review/SenderGroupList.tsx";
import { startOAuth } from "../../lib/oauth-return.ts";
import type { ReviewController } from "./use-review-controller.ts";

/** List plus detail (UI spec 4.7, 4.14). Uses overflow-clip so the sticky header still sticks to the page. */
export function ReviewWorkArea({ c }: { c: ReviewController }) {
  const g = c.activeGroup;
  const detailPages = c.detailQ.data?.pages ?? [];
  const inline = c.detailMode === "inline" && g !== null;
  const tau = c.tau ?? 0;
  return (
    <div
      className={`overflow-clip rounded-b-xl border border-t-0 border-line bg-surface ${inline ? "xl:grid xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}
    >
      <div className={`min-w-0 ${inline ? "xl:border-r xl:border-line" : ""}`}>
        <SenderGroupList
          state={
            c.groupsQ.isPending
              ? "loading"
              : c.groupsQ.isError
                ? "error"
                : c.groups.length === 0
                  ? "empty"
                  : "ready"
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
      <DetailPanel
        mode={c.detailMode}
        open={c.detailMode === "inline" ? g !== null : c.detailOpen}
        group={g}
        items={detailPages.flatMap((p) => p.items.items)}
        detailState={c.detailQ.isPending ? "loading" : c.detailQ.isError ? "error" : "ready"}
        hasMoreItems={c.detailQ.hasNextPage}
        loadingMoreItems={c.detailQ.isFetchingNextPage}
        tau={tau}
        account={g ? (c.accountsById[g.accountId] ?? null) : null}
        busyAction={
          c.groupActions.busyAction && g && c.groupActions.busyAction.key === g.key
            ? c.groupActions.busyAction.action
            : null
        }
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
      />
    </div>
  );
}
