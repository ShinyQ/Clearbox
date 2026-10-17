import { useEffect, useId, useRef } from "react";
import type { GroupUnsubscribe } from "../../../shared/api.ts";
import { formatCount, truncateName } from "../../lib/format.ts";
import {
  unsubscribeConfirmDetail,
  unsubscribeConfirmTitle,
  unsubscribedOn,
} from "../../lib/copy-unsubscribe.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";

export type UnsubscribePhase = "idle" | "confirming" | "running";
export type UnsubscribeChoice = "only" | "trash";

export interface UnsubscribeSectionProps {
  /** Sender display name (plain text). */
  name: string;
  /** Pending emails in the group (for "Trash 248 and unsubscribe"). */
  count: number;
  state: GroupUnsubscribe | null;
  phase: UnsubscribePhase;
  running: UnsubscribeChoice | null;
  /** Soft-disables the buttons (reconnect needed, offline, Clean up running, another action busy). */
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: (choice: UnsubscribeChoice) => void;
}

/**
 * UI spec 4.14a: owner-initiated RFC 8058 one-click unsubscribe in the detail panel. Shown only when the
 * newest email from the sender offers one-click (or the sender was unsubscribed before). Never automatic and
 * never on a shortcut: it always goes through this inline confirmation because it cannot be undone.
 */
export function UnsubscribeSection(p: UnsubscribeSectionProps) {
  const titleId = useId();
  const detailId = useId();
  const firstRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const open = p.phase !== "idle";
  useEffect(() => {
    if (open && !wasOpen.current) firstRef.current?.focus();
    if (!open && wasOpen.current && document.activeElement === document.body) startRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const offered = p.state?.oneClick === true;
  const at = p.state?.unsubscribedAt ?? null;
  if (!offered && at === null) return null;
  const short = truncateName(p.name);

  if (open && offered) {
    const busy = p.phase === "running";
    return (
      <div
        role="group"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
      >
        <p id={titleId} className="text-small font-semibold text-ink">
          {unsubscribeConfirmTitle(short)}
        </p>
        <p id={detailId} className="text-small text-ink-3">
          {unsubscribeConfirmDetail(p.count)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            ref={firstRef}
            variant="danger"
            size="sm"
            icon="trash"
            loading={p.running === "trash"}
            loadingLabel="Unsubscribing…"
            softDisabled={p.disabled || (busy && p.running !== "trash")}
            onClick={() => p.onConfirm("trash")}
          >
            {`Trash ${formatCount(p.count)} and unsubscribe`}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={p.running === "only"}
            loadingLabel="Unsubscribing…"
            softDisabled={p.disabled || (busy && p.running !== "only")}
            onClick={() => p.onConfirm("only")}
          >
            Unsubscribe only
          </Button>
          <Button variant="ghost" size="sm" softDisabled={busy} onClick={p.onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-3">
      {at !== null ? (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="check" size={12} />
          {unsubscribedOn(at)}
        </span>
      ) : null}
      {offered ? (
        <Button
          ref={startRef}
          variant="link"
          size="sm"
          softDisabled={p.disabled}
          aria-label={`Unsubscribe from ${p.name}`}
          onClick={p.onStart}
        >
          {at !== null ? "Unsubscribe again" : "Unsubscribe"}
        </Button>
      ) : null}
    </div>
  );
}
