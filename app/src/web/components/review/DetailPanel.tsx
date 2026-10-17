import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import type { AccountView, SenderGroup, SuggestionItem } from "../../../shared/api.ts";
import { isModelUnavailable, membershipLine, toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import type { ActionKind, Platform } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { useFocusTrap } from "../../state/use-focus-trap.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { SHIMMER, SkeletonLine } from "../ui/Skeleton.tsx";
import { ConfidenceLabel } from "./ConfidenceLabel.tsx";
import { DetailActions } from "./DetailActions.tsx";
import { EmailPreviewList } from "./EmailPreviewList.tsx";
import { ReasonList } from "./ReasonLine.tsx";
import { SenderAvatar } from "./SenderAvatar.tsx";
import { displayName } from "./SenderGroupRow.tsx";
import { VerdictTag } from "./VerdictTag.tsx";

export interface DetailPanelProps {
  mode: "inline" | "slideover" | "sheet";
  open: boolean;
  group: SenderGroup | null;
  items: SuggestionItem[];
  detailState: "loading" | "ready" | "error";
  hasMoreItems: boolean;
  loadingMoreItems: boolean;
  tau: number;
  account: AccountView | null;
  busyAction: ActionKind | null;
  /** Soft-disables the action buttons (for example while Clean up runs). */
  actionsDisabled?: boolean;
  busyItemIds: ReadonlySet<number>;
  now: number;
  platform: Platform;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  onAction: (action: ActionKind) => void;
  onAlwaysKeep: (entry: string) => void;
  onAlwaysTrash: (entry: string) => void;
  onCopyAddress: () => void;
  onItemAction: (itemId: number, action: ActionKind) => void;
  onLoadMoreItems: () => void;
  onClose: () => void;
  onRetry: () => void;
  onReconnect: (account: AccountView) => void;
  /** Unsubscribe assistant (UI spec 4.14a), rendered below the actions. */
  unsubscribe?: ReactNode;
}

function tagLabel(g: SenderGroup): string {
  const n = formatCount(g.count);
  return {
    delete: `Move ${n} to Trash`,
    archive: `Archive ${n}`,
    keep: `Keep ${n} in inbox`,
    unsure: `Check ${n} yourself`,
  }[g.action];
}

const HINTS: [string[], string][] = [
  [["J", "K"], "move"],
  [["X"], "select"],
  [["T"], "trash"],
  [["A"], "archive"],
  [["E"], "keep"],
];

export function DetailPanel({ headingRef, ...p }: DetailPanelProps) {
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const floating = p.mode !== "inline";
  useHotkeys("slideover", [{ combo: "escape", handler: () => p.onClose() }], floating && p.open);
  useFocusTrap(rootRef, p.mode === "sheet" && p.open && p.group !== null);
  if (!p.group || !p.open) return null;
  const g = p.group;
  const name = displayName(g);
  const needsReconnect = p.account?.status === "needs_reauth";
  const range = g.confidence.max - g.confidence.min >= 0.05;

  const body: ReactNode = (
    <>
      <div className="flex items-center gap-2.5">
        {p.mode === "sheet" ? (
          <Button variant="ghost" size="sm" icon="arrow-left" onClick={p.onClose}>
            Back
          </Button>
        ) : null}
        <SenderAvatar name={g.senderName} address={g.sender} domain={g.domain} size={30} />
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-title-sm font-semibold text-ink outline-none"
          >
            {name.text}
          </h2>
          <p className="truncate text-small text-ink-3">
            {[g.sender || "Unknown sender", p.account?.email].filter(Boolean).join(" · ")}
          </p>
        </div>
        {p.mode === "slideover" ? (
          <Button variant="ghost" size="sm" icon="close" aria-label="Close" onClick={p.onClose} />
        ) : null}
      </div>
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <VerdictTag kind={g.action} label={tagLabel(g)} />
          <ConfidenceLabel
            value={g.confidence.avg}
            verdict={g.action}
            tau={p.tau}
            variant="inline"
            modelUnavailable={isModelUnavailable(g)}
          />
        </div>
        {range ? (
          <p className="text-small text-ink-3">{`Range ${toPercent(g.confidence.min)}–${toPercent(g.confidence.max)}% across ${plural(g.count, "email", "emails")}`}</p>
        ) : null}
        <p className="mb-2 text-small text-ink-3">{membershipLine(g.action, g.confidence, p.tau, g.count)}</p>
        <ReasonList reasons={g.topReasons} />
      </div>
      <p className="text-meta font-emphasis text-ink-3">Latest emails</p>
      {p.detailState === "loading" ? (
        <div
          aria-hidden="true"
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5"
        >
          <SkeletonLine width="90%" />
          <SkeletonLine width="75%" />
          <SkeletonLine width="80%" />
        </div>
      ) : p.detailState === "error" ? (
        <p className="text-small text-ink-3">
          Couldn't load these emails.{" "}
          <Button variant="link" size="sm" onClick={p.onRetry}>
            Try again
          </Button>
        </p>
      ) : (
        <EmailPreviewList
          items={p.items}
          total={g.count}
          provider={g.provider}
          senderLabel={name.text}
          expandedId={expandedId}
          hasMore={p.hasMoreItems}
          loadingMore={p.loadingMoreItems}
          tau={p.tau}
          now={p.now}
          busyIds={p.busyItemIds}
          onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
          onItemAction={p.onItemAction}
          onLoadMore={p.onLoadMoreItems}
        />
      )}
      {needsReconnect && p.account ? (
        <p className="flex flex-wrap items-center gap-1.5 text-small text-check-ink-strong">
          <Icon name="warning" size={12} />
          {`Reconnect ${p.account.email} to act on these emails.`}
          <Button variant="link" size="sm" onClick={() => p.account && p.onReconnect(p.account)}>
            Reconnect
          </Button>
        </p>
      ) : null}
      <DetailActions
        group={g}
        name={name.text}
        busyAction={p.busyAction}
        disabled={needsReconnect || p.actionsDisabled === true}
        onAction={p.onAction}
        onAlwaysKeep={p.onAlwaysKeep}
        onAlwaysTrash={p.onAlwaysTrash}
        onCopyAddress={p.onCopyAddress}
      />
      {p.unsubscribe}
      <div className="hidden flex-wrap gap-2.5 text-meta text-ink-3 lg:flex">
        {HINTS.map(([keys, label]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <Kbd keys={keys} />
            {label}
          </span>
        ))}
      </div>
    </>
  );

  const inner = "flex flex-col gap-3 bg-surface-raised p-4";
  if (p.mode === "inline") {
    return (
      <aside
        aria-labelledby={headingId}
        className={`${inner} xl:sticky xl:top-0 xl:max-h-dvh xl:overflow-y-auto`}
      >
        {body}
      </aside>
    );
  }
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal={p.mode === "sheet"}
      aria-labelledby={headingId}
      className={`${inner} fixed z-(--z-slideover) overflow-y-auto shadow-overlay ${
        p.mode === "slideover"
          ? "inset-y-0 right-0 w-(--layout-slideover) motion-safe:animate-[cb-slide-in_250ms_var(--ease-out)]"
          : "inset-0"
      }`}
    >
      {body}
    </div>
  );
}

/** Inline panel placeholder while the list loads (UI spec 5.1): avatar, 2 lines, card, 3 lines. */
export function DetailPanelSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 bg-surface-raised p-4">
      <div className="flex items-center gap-2.5">
        <span className={`size-[30px] shrink-0 rounded-md ${SHIMMER}`} />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <SkeletonLine width={120} height={14} />
          <SkeletonLine width={180} />
        </span>
      </div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
        <span className={`h-[22px] w-28 rounded-sm ${SHIMMER}`} />
        <SkeletonLine width="85%" />
        <SkeletonLine width="70%" />
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
        <SkeletonLine width="90%" />
        <SkeletonLine width="75%" />
        <SkeletonLine width="80%" />
      </div>
    </div>
  );
}
