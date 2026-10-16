import type { ActionKind, ProviderKind, ReasonCode, SuggestedAction } from "@clearbox/core";

export type { ActionKind, ProviderKind, ReasonCode, SuggestedAction };

export type Verdict = SuggestedAction;
export type TagKind = Verdict | "protected";
export type Band = "very_sure" | "sure" | "likely" | "unsure";
export type TabKey = "all" | "trash" | "archive" | "check" | "keep";
export type GroupSort = "confidence_desc" | "count_desc" | "newest";
export type Platform = "mac" | "other";
export type AccountUiStatus =
  "up_to_date" | "catching_up" | "paused" | "needs_reauth" | "config_error" | "waiting";

export const VERDICT_LABEL: Record<Verdict, string> = {
  delete: "Trash",
  archive: "Archive",
  keep: "Keep",
  unsure: "Check",
};
export const BAND_LABEL: Record<Band, string> = {
  very_sure: "Very sure",
  sure: "Sure",
  likely: "Likely",
  unsure: "Unsure",
};
export const TAB_ACTION: Record<TabKey, Verdict | undefined> = {
  all: undefined,
  trash: "delete",
  archive: "archive",
  check: "unsure",
  keep: "keep",
};
export const TAB_KEYS: readonly TabKey[] = ["all", "trash", "archive", "check", "keep"];
export const TAB_LABEL: Record<TabKey, string> = {
  all: "All",
  trash: "Trash",
  archive: "Archive",
  check: "Check",
  keep: "Keep",
};
export const SORT_OPTIONS: readonly { value: GroupSort; label: string }[] = [
  { value: "confidence_desc", label: "Sort: Confidence" },
  { value: "count_desc", label: "Sort: Most emails" },
  { value: "newest", label: "Sort: Newest" },
];

export function isTabKey(v: string | null): v is TabKey {
  return v !== null && (TAB_KEYS as readonly string[]).includes(v);
}

export function isGroupSort(v: string | null): v is GroupSort {
  return v === "confidence_desc" || v === "count_desc" || v === "newest";
}
