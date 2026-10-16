import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { AccountView, SenderGroup } from "../../../shared/api.ts";
import { formatCount } from "../../lib/format.ts";
import { TAB_LABEL, type Platform, type TabKey } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { SkeletonRows } from "../ui/Skeleton.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { SelectionToolbar, type BulkAction } from "./SelectionToolbar.tsx";
import { SenderGroupRow } from "./SenderGroupRow.tsx";

export type RowMove = "next" | "prev" | "first" | "last" | "pagedown" | "pageup";

export const EMPTY_COPY: Record<TabKey, [string, string]> = {
  all: ["Nothing to review", "New mail gets sorted every 30 minutes."],
  trash: ["No trash suggestions", "Nothing here looks safe to trash right now."],
  archive: ["No archive suggestions", "Receipts and finished threads will show up here."],
  check: ["No groups to check", "Clearbox is confident about everything left."],
  keep: ["No keep suggestions", "Emails Clearbox thinks you should keep will show up here."],
};

export interface SenderGroupListProps {
  state: "loading" | "ready" | "empty" | "error";
  tab: TabKey;
  groups: readonly SenderGroup[];
  tau: number;
  accountsById: Readonly<Record<string, AccountView>>;
  showAccount: boolean;
  activeKey: string | null;
  selected: ReadonlySet<string>;
  busyKeys: ReadonlySet<string>;
  exitingKeys: ReadonlySet<string>;
  totalInTab: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  bulkProgress: { done: number; total: number } | null;
  platform: Platform;
  onActivate: (key: string, opts: { openDetail: boolean; keyboard?: boolean }) => void;
  onToggleSelect: (key: string, opts: { range: boolean }) => void;
  onSelectAllLoaded: () => void;
  onSelectAllInTab: () => void;
  onClearSelection: () => void;
  onBulkAction: (action: BulkAction) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onMove: (to: RowMove) => void;
}

const HEADER =
  "grid grid-cols-[22px_minmax(0,1fr)_auto] gap-2.5 sm:grid-cols-[22px_minmax(0,1fr)_92px_108px_44px]";
const MOVE_KEYS: Record<string, RowMove> = {
  ArrowDown: "next",
  ArrowUp: "prev",
  Home: "first",
  End: "last",
  PageDown: "pagedown",
  PageUp: "pageup",
};

export function SenderGroupList(p: SenderGroupListProps) {
  const hintId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(p.onLoadMore);
  useEffect(() => {
    loadMore.current = p.onLoadMore;
  });

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !p.hasNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore.current();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [p.hasNextPage, p.groups.length]);

  if (p.state === "empty" || p.state === "error") {
    const [title, body] =
      p.state === "error"
        ? ["Couldn't load sender groups", "Check your connection, then try again."]
        : EMPTY_COPY[p.tab];
    return (
      <div id="group-list">
        <EmptyState
          variant="inline"
          title={title}
          body={body}
          action={p.state === "error" ? { label: "Try again", onClick: p.onRetry } : undefined}
        />
      </div>
    );
  }

  const loaded = p.groups.map((g) => g.key);
  const selectedGroups = p.groups.filter((g) => p.selected.has(g.key));
  const allSelected = loaded.length > 0 && selectedGroups.length === loaded.length;
  const someSelected = selectedGroups.length > 0;
  const approveBlocked = selectedGroups.some((g) => g.action === "unsure");
  const label = TAB_LABEL[p.tab];
  const total = p.totalInTab ?? loaded.length;
  const capped = total > 1000;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role='row'][data-group-key]");
    if (!row || e.altKey) return;
    const mod = p.platform === "mac" ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      p.onSelectAllLoaded();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const move = MOVE_KEYS[e.key];
    if (move) {
      e.preventDefault();
      p.onMove(move);
    } else if (e.key === "Enter" && row.dataset.groupKey) {
      e.preventDefault();
      p.onActivate(row.dataset.groupKey, { openDetail: true, keyboard: true });
    }
  };

  return (
    <div
      role="grid"
      id="group-list"
      aria-label={`Sender groups, ${label} tab`}
      aria-multiselectable="true"
      aria-rowcount={p.totalInTab ?? -1}
      aria-busy={p.state === "loading" || p.isFetchingNextPage || undefined}
      onKeyDown={onKeyDown}
      className="[scroll-padding-top:44px] [scroll-padding-bottom:96px]"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-(--z-sticky) border-b border-line bg-surface-raised px-3.5 py-2 text-meta text-ink-3"
      >
        {someSelected ? (
          <div role="gridcell" aria-colspan={5}>
            <SelectionToolbar
              selectedCount={selectedGroups.length}
              emailCount={selectedGroups.reduce((sum, g) => sum + g.count, 0)}
              allChecked={allSelected}
              tabLabel={label}
              approveBlocked={approveBlocked}
              approveHintId={hintId}
              bulkProgress={p.bulkProgress}
              onToggleAll={(next) => (next ? p.onSelectAllLoaded() : p.onClearSelection())}
              onBulkAction={p.onBulkAction}
              onClear={p.onClearSelection}
            />
            {approveBlocked ? (
              <p id={hintId} className="mt-1 text-small text-ink-3">
                Check groups need your choice. Use Trash, Archive or Keep.
              </p>
            ) : null}
            {allSelected && p.hasNextPage ? (
              <p className="mt-1 text-small text-ink-2">
                {`All ${formatCount(loaded.length)} loaded groups are selected.`}{" "}
                <Button variant="link" size="sm" onClick={p.onSelectAllInTab}>
                  {capped ? "Select first 1,000" : `Select all ${formatCount(total)} in ${label}`}
                </Button>
              </p>
            ) : null}
          </div>
        ) : (
          <div className={HEADER}>
            <span role="columnheader" className="grid place-items-center">
              <Checkbox
                checked={false}
                disabled={p.state === "loading"}
                label={`Select all groups in ${label}`}
                onChange={() => p.onSelectAllLoaded()}
              />
            </span>
            <span role="columnheader">Sender</span>
            <span role="columnheader" className="max-sm:hidden">
              Verdict
            </span>
            <span role="columnheader" className="max-sm:hidden">
              Confidence
            </span>
            <span role="columnheader" className="text-right">
              Emails
            </span>
          </div>
        )}
      </div>
      {p.state === "loading" ? (
        <>
          <VisuallyHidden>Loading sender groups</VisuallyHidden>
          <SkeletonRows count={8} />
        </>
      ) : (
        p.groups.map((g, i) => (
          <SenderGroupRow
            key={g.key}
            group={g}
            tau={p.tau}
            rowIndex={i}
            active={g.key === p.activeKey}
            selected={p.selected.has(g.key)}
            busy={p.busyKeys.has(g.key)}
            exiting={p.exitingKeys.has(g.key)}
            focusable={g.key === p.activeKey || (p.activeKey === null && i === 0)}
            accountEmail={p.showAccount ? (p.accountsById[g.accountId]?.email ?? null) : null}
            onClick={(e) => {
              const mod = p.platform === "mac" ? e.metaKey : e.ctrlKey;
              if (e.shiftKey) p.onToggleSelect(g.key, { range: true });
              else if (mod) p.onToggleSelect(g.key, { range: false });
              else p.onActivate(g.key, { openDetail: true });
            }}
            onCheckboxChange={(_next, e) => p.onToggleSelect(g.key, { range: e.shiftKey })}
          />
        ))
      )}
      {p.isFetchingNextPage ? <SkeletonRows count={3} /> : null}
      <div ref={sentinel} aria-hidden="true" />
    </div>
  );
}
