import { plural } from "../../lib/format.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";

export type BulkAction = "approve" | "delete" | "archive" | "keep";

export interface SelectionToolbarProps {
  selectedCount: number;
  emailCount: number;
  allChecked: boolean;
  tabLabel: string;
  approveBlocked: boolean;
  approveHintId: string;
  bulkProgress: { done: number; total: number } | null;
  onToggleAll: (next: boolean) => void;
  onBulkAction: (action: BulkAction) => void;
  onClear: () => void;
}

export function SelectionToolbar(p: SelectionToolbarProps) {
  const working = p.bulkProgress !== null;
  return (
    <div
      role="toolbar"
      aria-label="Selected groups"
      className="flex min-h-[18px] flex-wrap items-center gap-1.5"
    >
      <Checkbox
        checked={p.allChecked ? true : "mixed"}
        label={`Select all groups in ${p.tabLabel}`}
        onChange={(next) => p.onToggleAll(next)}
      />
      <span className="mr-1 ml-2 text-body font-emphasis text-ink">
        {working
          ? `Working on ${p.bulkProgress?.done ?? 0} of ${p.bulkProgress?.total ?? 0} groups…`
          : `${plural(p.selectedCount, "group", "groups")} selected · ${plural(p.emailCount, "email", "emails")}`}
      </span>
      <Button
        size="sm"
        softDisabled={p.approveBlocked || working}
        aria-describedby={p.approveBlocked ? p.approveHintId : undefined}
        onClick={() => p.onBulkAction("approve")}
      >
        Approve suggestions
      </Button>
      <Button
        size="sm"
        kbd={["T"]}
        aria-keyshortcuts="T"
        softDisabled={working}
        onClick={() => p.onBulkAction("delete")}
      >
        Trash
      </Button>
      <Button
        size="sm"
        kbd={["A"]}
        aria-keyshortcuts="A"
        softDisabled={working}
        onClick={() => p.onBulkAction("archive")}
      >
        Archive
      </Button>
      <Button
        size="sm"
        kbd={["E"]}
        aria-keyshortcuts="E"
        softDisabled={working}
        onClick={() => p.onBulkAction("keep")}
      >
        Keep
      </Button>
      <Button
        size="sm"
        variant="ghost"
        kbd={["Esc"]}
        aria-keyshortcuts="Escape"
        className="ml-auto"
        softDisabled={working}
        onClick={p.onClear}
      >
        Clear
      </Button>
    </div>
  );
}
