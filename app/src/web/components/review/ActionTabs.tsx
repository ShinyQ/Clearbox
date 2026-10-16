import { plural } from "../../lib/format.ts";
import { SORT_OPTIONS, TAB_KEYS, TAB_LABEL, type GroupSort, type TabKey } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Tabs } from "../ui/Tabs.tsx";

export interface ActionTabsProps {
  value: TabKey;
  counts: Record<TabKey, number | null>;
  onChange: (tab: TabKey) => void;
  sort: GroupSort;
  onSortChange: (sort: GroupSort) => void;
  newSuggestions: boolean;
  onRefresh: () => void;
  confirmKeeps?: { onClick: () => void; busy: boolean } | null | undefined;
}

export function ActionTabs(p: ActionTabsProps) {
  const items = TAB_KEYS.map((key) => {
    const count = p.counts[key];
    return {
      key,
      label: TAB_LABEL[key],
      count,
      ariaLabel: count === null ? undefined : `${TAB_LABEL[key]}, ${plural(count, "group", "groups")}`,
    };
  });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line">
      <Tabs
        label="Filter by suggestion"
        value={p.value}
        items={items}
        onChange={p.onChange}
        controls="group-list"
        idPrefix="tab"
      />
      <div className="ml-auto flex items-center gap-2 pb-1">
        {p.newSuggestions ? (
          <button
            type="button"
            onClick={p.onRefresh}
            className="rounded-full bg-accent-soft px-2.5 py-0.5 text-meta font-emphasis text-accent hover:text-accent-hover"
          >
            New suggestions · Refresh
          </button>
        ) : null}
        {p.value === "keep" && p.confirmKeeps ? (
          <Button
            size="sm"
            loading={p.confirmKeeps.busy}
            loadingLabel="Preparing…"
            onClick={p.confirmKeeps.onClick}
          >
            Confirm all keeps
          </Button>
        ) : null}
        <Select
          label="Sort groups"
          variant="ghost"
          value={p.sort}
          options={SORT_OPTIONS}
          onChange={p.onSortChange}
        />
      </div>
    </div>
  );
}
