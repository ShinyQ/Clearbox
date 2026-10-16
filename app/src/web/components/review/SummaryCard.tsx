import { useId, type Ref } from "react";
import type { CleanupPreview } from "../../../shared/api.ts";
import { toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { ariaMod, enterKey, modKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { SkeletonLine, SHIMMER } from "../ui/Skeleton.tsx";
import { Spark } from "../ui/Spark.tsx";
import { SplitBar } from "./SplitBar.tsx";

export interface SummaryCardProps {
  state: "loading" | "ready" | "nothing_sure" | "error";
  preview: CleanupPreview | null;
  pendingTotal: number;
  awaitingModel: number;
  groupsLeft: number | null;
  tau: number | null;
  catchingUp: boolean;
  cleanupPhase: "idle" | "preparing" | "busy";
  offline: boolean;
  platform: Platform;
  onCleanUp: () => void;
  onRetry: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

export const summaryHeadline = (count: number): string =>
  count === 1 ? "1 email is ready to clean up" : `${formatCount(count)} emails are ready to clean up`;

export function leftForYouSentence(groupsLeft: number | null, emailsLeft: number): string {
  if (groupsLeft === null) {
    return emailsLeft === 1
      ? "1 email is left for you to check."
      : `${formatCount(emailsLeft)} emails are left for you to check.`;
  }
  return groupsLeft === 1
    ? "1 group is left for you to check."
    : `${formatCount(groupsLeft)} groups are left for you to check.`;
}

export function summarySubline(o: {
  groups: number;
  groupsLeft: number | null;
  emailsLeft: number;
  catchingUp: boolean;
  awaitingModel: number;
}): string {
  const parts = [`Clearbox is confident about ${plural(o.groups, "sender group", "sender groups")}.`];
  parts.push(o.groupsLeft === 0 ? "Nothing else needs you." : leftForYouSentence(o.groupsLeft, o.emailsLeft));
  if (o.catchingUp) parts.push("Still sorting older mail.");
  if (o.awaitingModel > 0) {
    parts.push(
      o.awaitingModel === 1
        ? "1 email is waiting for the AI model."
        : `${formatCount(o.awaitingModel)} emails are waiting for the AI model.`,
    );
  }
  return parts.join(" ");
}

export const nothingSureSubline = (groupsLeft: number | null, emailsLeft: number, tau: number): string =>
  `${leftForYouSentence(groupsLeft, emailsLeft)} Suggestions at ${toPercent(tau)}% or higher go into Clean up.`;

export function SummaryCard({ buttonRef, ...p }: SummaryCardProps) {
  const headingId = useId();
  const count = p.preview?.count ?? 0;
  const emailsLeft = Math.max(0, p.pendingTotal - count);
  const loading = p.state === "loading";
  const segments = [
    {
      key: "trash",
      className: "bg-trash",
      value: p.preview?.byAction.delete ?? 0,
      legend: `${formatCount(p.preview?.byAction.delete ?? 0)} to trash`,
    },
    {
      key: "archive",
      className: "bg-archive",
      value: p.preview?.byAction.archive ?? 0,
      legend: `${formatCount(p.preview?.byAction.archive ?? 0)} to archive`,
    },
    {
      key: "left",
      className: "bg-neutral-fill",
      value: emailsLeft,
      legend: `${formatCount(emailsLeft)} to check or keep`,
    },
  ];
  const headline =
    p.state === "error"
      ? "Couldn't load the Clean up summary"
      : p.state === "nothing_sure"
        ? "Nothing is sure enough to clean up yet"
        : summaryHeadline(count);
  const sub =
    p.state === "error"
      ? "Your sender groups below still work."
      : p.state === "nothing_sure" && p.tau !== null
        ? nothingSureSubline(p.groupsLeft, emailsLeft, p.tau)
        : summarySubline({
            groups: p.preview?.groups ?? 0,
            groupsLeft: p.groupsLeft,
            emailsLeft,
            catchingUp: p.catchingUp,
            awaitingModel: p.awaitingModel,
          });

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading || undefined}
      className="mb-4 flex items-center gap-4 rounded-xl border border-line bg-surface px-[18px] py-4 shadow-card"
    >
      <Spark size={22} />
      <div className="min-w-0 flex-1">
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <span id={headingId} className="sr-only">
              Loading the Clean up summary
            </span>
            <SkeletonLine width={260} height={14} />
            <SkeletonLine width={360} />
            <span className={`mt-1 block h-1.5 w-[340px] max-w-full rounded-xs ${SHIMMER}`} />
          </div>
        ) : (
          <>
            <h2 id={headingId} className="mb-[3px] text-title-lg font-heading text-ink">
              {headline}
            </h2>
            <p className="text-body text-ink-2">{sub}</p>
            {p.state === "ready" ? <SplitBar segments={segments} /> : null}
            {p.state === "nothing_sure" ? <SplitBar segments={segments.slice(2)} /> : null}
            {p.offline && p.state === "ready" ? (
              <p className="mt-1.5 text-small text-ink-3">You're offline.</p>
            ) : null}
          </>
        )}
      </div>
      {loading ? <span aria-hidden="true" className={`h-9 w-[120px] rounded-lg ${SHIMMER}`} /> : null}
      {p.state === "error" ? <Button onClick={p.onRetry}>Try again</Button> : null}
      {p.state === "ready" ? (
        <Button
          ref={buttonRef}
          variant="primary"
          size="lg"
          kbd={[modKey(p.platform), enterKey(p.platform)]}
          aria-keyshortcuts={`${ariaMod(p.platform)}+Enter`}
          loading={p.cleanupPhase === "preparing"}
          loadingLabel="Preparing…"
          softDisabled={p.cleanupPhase === "busy" || p.offline}
          onClick={p.onCleanUp}
        >
          {p.cleanupPhase === "busy" ? "Cleaning up…" : `Clean up ${formatCount(count)}`}
        </Button>
      ) : null}
    </section>
  );
}
