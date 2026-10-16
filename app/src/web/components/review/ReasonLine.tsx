import type { ApiReason } from "../../../shared/api.ts";
import type { ReasonCode } from "../../lib/view-types.ts";
import { Icon, type IconName } from "../ui/icons.tsx";

const REASON_ICON: Partial<Record<ReasonCode, IconName>> = {
  prior_sender_deleted: "history",
  prior_sender_kept: "history",
  prior_domain_deleted: "history",
  prior_domain_kept: "history",
  low_open_rate: "eye-off",
  old_unread: "eye-off",
  list_unsubscribe: "megaphone",
  bulk_mail: "megaphone",
  auto_sent: "megaphone",
  category: "megaphone",
  guard_starred: "star",
  guard_replied: "person",
  guard_correspondent: "person",
  flag_human: "person",
  guard_allowlist: "list",
  deny_listed: "list",
  guard_too_recent: "clock",
  flag_expired: "clock",
  guard_attachment: "paperclip",
  guard_record_pattern: "receipt",
  flag_record: "receipt",
  auth_failed: "alert",
  model_important: "flag",
  model_unavailable: "spark-off",
  low_confidence: "question",
};

export const reasonIcon = (code: ReasonCode): IconName => REASON_ICON[code] ?? "info";

export function ReasonLine({ reason }: { reason: ApiReason }) {
  return (
    <li className="flex items-start gap-[9px] text-body text-ink-2">
      <span
        aria-hidden="true"
        className="grid size-[18px] shrink-0 place-items-center rounded-sm bg-surface-sunk text-ink-2"
      >
        <Icon name={reasonIcon(reason.code)} size={12} />
      </span>
      <span>{reason.text}</span>
    </li>
  );
}

/** Rows can arrive with fewer than three reasons; an empty list renders nothing. */
export function ReasonList({
  reasons,
  label = "Reasons",
}: {
  reasons: readonly ApiReason[];
  label?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-col gap-[7px]">
      {reasons.map((r) => (
        <ReasonLine key={`${r.code}:${r.text}`} reason={r} />
      ))}
    </ul>
  );
}
