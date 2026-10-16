import type { CleanupPreview } from "../../shared/api.ts";
import { processedOf, type PartialReason, type RunTotals } from "../api/cleanup.ts";
import { toPercent } from "./confidence.ts";
import { formatCount, plural } from "./format.ts";

export type CleanupMode = "cleanup" | "confirm_keeps";

export interface CopyContext {
  pendingTotal: number;
  accountEmail: string | null;
  inactiveEmail: string | null;
  providerLabel: string;
  resetTime: string;
}

const groupsOf = (n: number) => plural(n, "sender group", "sender groups");
const emailsOf = (n: number) => plural(n, "email", "emails");

export function confirmTitle(mode: CleanupMode, p: CleanupPreview, ctx: CopyContext): string {
  if (mode === "confirm_keeps") return `Mark ${emailsOf(p.count)} in ${groupsOf(p.groups)} as Keep?`;
  if (ctx.accountEmail) return `Clean up ${emailsOf(p.count)} from ${ctx.accountEmail}?`;
  return `Clean up ${emailsOf(p.count)} in ${groupsOf(p.groups)}?`;
}

function destinations(d: number, a: number): string {
  if (d > 0 && a > 0) {
    return `${formatCount(d)} ${d === 1 ? "goes" : "go"} to Trash and ${formatCount(a)} to Archive. Nothing is permanently deleted.`;
  }
  if (d > 0) {
    return `${d === 1 ? "It goes" : `All ${formatCount(d)} go`} to Trash. Nothing is permanently deleted.`;
  }
  return `${a === 1 ? "It goes" : `All ${formatCount(a)} go`} to Archive.`;
}

export function confirmDetail(mode: CleanupMode, p: CleanupPreview, ctx: CopyContext): string {
  if (mode === "confirm_keeps") {
    return "They stay in your inbox, leave Review, and Clearbox learns from your choice.";
  }
  const pct = toPercent(p.threshold);
  const parts = [destinations(p.byAction.delete, p.byAction.archive)];
  if (typeof p.groupsLeft === "number") {
    if (p.groupsLeft === 1) parts.push(`1 group below ${pct}% stays here for you.`);
    else if (p.groupsLeft > 1)
      parts.push(`${formatCount(p.groupsLeft)} groups below ${pct}% stay here for you.`);
  } else {
    // Without groupsLeft (A2) only the email count is known.
    const rest = Math.max(0, ctx.pendingTotal - p.count);
    if (rest > 0) {
      parts.push(
        `${emailsOf(rest)} below ${pct}% or waiting for your choice ${rest === 1 ? "stays" : "stay"} here.`,
      );
    }
  }
  // Trash and Archive only cover active accounts (server note 1).
  if (ctx.inactiveEmail) parts.push(`Emails from ${ctx.inactiveEmail} are skipped until you reconnect it.`);
  return parts.join(" ");
}

export const runningTitle = (mode: CleanupMode, processed: number, total: number): string =>
  `${mode === "confirm_keeps" ? "Confirming…" : "Cleaning up…"} ${formatCount(processed)} of ${formatCount(total)}`;

export const STOPPING_TITLE = "Stopping after this step…";

/** Reports what the run handled, never the whole preview: inactive accounts are excluded server-side. */
export function doneToast(mode: CleanupMode, run: RunTotals, p: CleanupPreview): string {
  const handled = run.skipped > 0 ? ` (${formatCount(run.skipped)} were already handled)` : "";
  if (run.executed === 0) {
    return `${mode === "confirm_keeps" ? "Nothing needed confirming" : "Nothing needed cleaning up"}${handled}`;
  }
  if (mode === "confirm_keeps") {
    return `Kept ${emailsOf(run.executed)} from ${groupsOf(p.groups)}. Clearbox will remember.`;
  }
  return `${emailsOf(run.executed)} cleaned up from ${groupsOf(p.groups)}${handled}`;
}

/** Partial runs report only the executed count; the group count is not exact (UI spec 5.2.4). */
export function partialToast(mode: CleanupMode, run: RunTotals): string {
  return mode === "confirm_keeps"
    ? `Kept ${emailsOf(run.executed)}. Clearbox will remember.`
    : `${emailsOf(run.executed)} cleaned up`;
}

interface Words {
  noun: string;
  during: string;
  doneWas: (n: number) => string;
  nothingLeft: string;
  prepareFailed: string;
  failedTitle: (n: number) => string;
  failedDetail: string;
  inactiveDetail: (email: string) => string;
  stuckDetail: string;
}

const WORDS: Record<CleanupMode, Words> = {
  cleanup: {
    noun: "Clean up",
    during: "Clean up",
    doneWas: (n) => `${plural(n, "email was", "emails were")} cleaned up.`,
    nothingLeft: "Nothing left to clean up. New suggestions appear after the next sort.",
    prepareFailed: "Couldn't prepare Clean up. Nothing was changed.",
    failedTitle: (n) => `${formatCount(n)} could not be moved.`,
    failedDetail:
      "They were moved or deleted outside Clearbox, or the mailbox refused the change. They are marked as failed.",
    inactiveDetail: (email) => `${email} needs to reconnect before its emails can be moved.`,
    stuckDetail: "The mailbox did not accept more changes right now. Try again in a few minutes.",
  },
  confirm_keeps: {
    noun: "Confirming keeps",
    during: "confirming keeps",
    doneWas: (n) => `${plural(n, "email was", "emails were")} kept.`,
    nothingLeft: "Nothing left to confirm. New suggestions appear after the next sort.",
    prepareFailed: "Couldn't prepare Confirm all keeps. Nothing was changed.",
    failedTitle: (n) => `${formatCount(n)} could not be confirmed.`,
    failedDetail:
      "They were deleted or changed outside Clearbox, so they could not be confirmed. They are marked as failed.",
    inactiveDetail: (email) => `${email} needs to reconnect before its emails can be confirmed.`,
    stuckDetail: "Clearbox could not confirm more right now. Try again in a few minutes.",
  },
};

export const nothingLeftToast = (mode: CleanupMode): string => WORDS[mode].nothingLeft;
export const prepareFailedToast = (mode: CleanupMode): string => WORDS[mode].prepareFailed;

export function partialCopy(
  reason: PartialReason,
  run: RunTotals,
  ctx: CopyContext,
  mode: CleanupMode = "cleanup",
): { title: string; detail: string } {
  const { noun, during } = WORDS[mode];
  const done = WORDS[mode].doneWas(run.executed);
  const restN = Math.max(0, run.total - processedOf(run));
  const rest = formatCount(restN);
  const one = restN === 1;
  switch (reason) {
    case "stopped":
      return { title: `${noun} stopped. ${done}`, detail: "The rest stay in Review." };
    case "budget":
      return {
        title: `${noun} paused at today's free-tier limit. ${done}`,
        detail: `The other ${rest} ${one ? "stays" : "stay"} in Review. Actions work again after ${ctx.resetTime}.`,
      };
    case "rate_limited":
      return {
        title: `${ctx.providerLabel} asked Clearbox to slow down. ${done}`,
        detail: `The other ${rest} ${one ? "stays" : "stay"} in Review. Try again in a minute.`,
      };
    case "account_inactive":
      return {
        title: `${done} ${rest} ${one ? "was" : "were"} skipped.`,
        detail: WORDS[mode].inactiveDetail(ctx.inactiveEmail ?? "An account"),
      };
    case "item_failures":
      return {
        title: `${done} ${WORDS[mode].failedTitle(run.failed)}`,
        detail: WORDS[mode].failedDetail,
      };
    case "no_progress":
      return {
        title: `${done} ${rest} ${one ? "is" : "are"} still waiting.`,
        detail: WORDS[mode].stuckDetail,
      };
    case "network":
      return {
        title: `Connection lost during ${during}. ${done}`,
        detail: "The rest stay in Review. Try again when you're back online.",
      };
    case "unexpected":
      return {
        title: `${noun} stopped because of an unexpected error. ${done}`,
        detail: "The rest stay in Review. Try again; if it keeps happening, check the Worker logs.",
      };
  }
}
