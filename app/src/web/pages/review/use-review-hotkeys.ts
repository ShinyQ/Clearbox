import type { RowMove } from "../../components/review/SenderGroupList.tsx";
import type { ActionKind } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";

export interface ReviewHotkeyHandlers {
  move: (to: RowMove) => void;
  toggleActive: () => void;
  rangeToActive: () => void;
  act: (action: ActionKind) => void;
  cleanUp: () => void;
  tab: (index: number) => void;
  escape: () => void;
}

/** UI spec 6.1 Review scope. Row-focused keys (Home, End, Page keys, Enter) live in the grid itself. */
export function useReviewHotkeys(h: ReviewHotkeyHandlers, enabled: boolean): void {
  useHotkeys(
    "review",
    [
      { combo: "j", handler: () => h.move("next"), repeat: true },
      { combo: "arrowdown", handler: () => h.move("next"), repeat: true },
      { combo: "k", handler: () => h.move("prev"), repeat: true },
      { combo: "arrowup", handler: () => h.move("prev"), repeat: true },
      { combo: "x", handler: () => h.toggleActive() },
      { combo: "shift+x", handler: () => h.rangeToActive() },
      { combo: "t", handler: () => h.act("delete") },
      { combo: "a", handler: () => h.act("archive") },
      { combo: "e", handler: () => h.act("keep") },
      { combo: "mod+enter", handler: () => h.cleanUp(), allowInInputs: true },
      ...[1, 2, 3, 4, 5].map((n) => ({ combo: String(n), handler: () => h.tab(n - 1) })),
      { combo: "escape", handler: () => h.escape() },
    ],
    enabled,
  );
}
