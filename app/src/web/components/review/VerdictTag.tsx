import { VERDICT_LABEL, type TagKind } from "../../lib/view-types.ts";
import { Icon, type IconName } from "../ui/icons.tsx";

export const VERDICT_ICON: Record<TagKind, IconName> = {
  delete: "trash",
  archive: "archive",
  keep: "keep",
  unsure: "check-question",
  protected: "shield",
};

const TONE: Record<TagKind, string> = {
  delete: "bg-trash-soft text-trash-ink",
  archive: "bg-archive-soft text-archive-ink",
  keep: "bg-keep-soft text-keep-ink",
  unsure: "bg-check-soft text-check-ink",
  protected: "bg-surface-sunk text-ink-2",
};

export function VerdictTag({
  kind,
  label,
  size = "md",
}: {
  kind: TagKind;
  label?: string | undefined;
  size?: "sm" | "md";
}) {
  const word = kind === "protected" ? "Protected" : VERDICT_LABEL[kind];
  return (
    <span
      className={`cb-tag inline-flex items-center gap-[5px] rounded-sm text-meta font-emphasis whitespace-nowrap ${
        size === "sm" ? "py-px pr-1.5 pl-1" : "py-0.5 pr-2 pl-1.5"
      } ${TONE[kind]}`}
    >
      <Icon name={VERDICT_ICON[kind]} size={size === "sm" ? 10 : 12} strokeWidth={1.6} />
      {label ?? word}
    </span>
  );
}
