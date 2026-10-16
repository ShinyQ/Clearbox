import { formatCount, plural } from "./format.ts";
import type { ActionKind } from "./view-types.ts";

export interface ActionErrorContext {
  providerLabel: string;
  resetTime: string;
}

export const GENERIC_ERROR = "Something went wrong. Nothing was changed.";
export const NETWORK_ERROR = "Couldn't reach Clearbox. Check your connection and try again.";
const emails = (n: number) => plural(n, "email", "emails");
const groups = (n: number) => plural(n, "sender group", "sender groups");

export function groupActionToast(target: ActionKind, name: string, n: number): string {
  if (target === "delete") return `Moved ${emails(n)} from ${name} to Trash.`;
  if (target === "archive") return `Archived ${emails(n)} from ${name}.`;
  return `Kept ${emails(n)} from ${name}. Clearbox will remember.`;
}

export function bulkActionToast(target: ActionKind, n: number, groupCount: number): string {
  if (target === "delete") return `Moved ${emails(n)} from ${groups(groupCount)} to Trash.`;
  if (target === "archive") return `Archived ${emails(n)} from ${groups(groupCount)}.`;
  return `Kept ${emails(n)} from ${groups(groupCount)}.`;
}

export function approveSummaryToast(by: Record<ActionKind, number>): string {
  const parts = [
    by.delete > 0 ? `${formatCount(by.delete)} to Trash` : "",
    by.archive > 0 ? `${formatCount(by.archive)} archived` : "",
    by.keep > 0 ? `${formatCount(by.keep)} kept` : "",
  ].filter(Boolean);
  return `Done: ${parts.join(", ")}.`;
}

export function partialGroupToast(target: ActionKind, executed: number, count: number): string {
  const left = formatCount(count - executed);
  if (target === "delete")
    return `Moved ${formatCount(executed)} of ${emails(count)} to Trash. ${left} could not be moved and stay in Review.`;
  if (target === "archive")
    return `Archived ${formatCount(executed)} of ${emails(count)}. ${left} could not be archived and stay in Review.`;
  return `Kept ${formatCount(executed)} of ${emails(count)}. ${left} could not be kept and stay in Review.`;
}

export function perEmailToast(target: ActionKind): string {
  return { delete: "Moved 1 email to Trash.", archive: "Archived 1 email.", keep: "Kept 1 email." }[target];
}

/** Error toasts for owner actions (UI spec 5.1 table, 4.18 generic copy). */
export function actionErrorMessage(code: string | null | undefined, ctx: ActionErrorContext): string {
  if (code === "budget_exhausted")
    return `Today's free-tier limit for changes is reached. Try again after ${ctx.resetTime}.`;
  if (code === "rate_limited")
    return `${ctx.providerLabel} asked Clearbox to slow down. Nothing else was changed. Try again in a minute.`;
  if (code === "network") return NETWORK_ERROR;
  return GENERIC_ERROR;
}

export type UndoKind = "cleanup" | "action";
export const NOTHING_TO_RESTORE = "Nothing needed restoring. These emails were already back or untouched.";

export const undoExpiredMessage = (kind: UndoKind) =>
  `Undo is no longer available for this ${kind === "cleanup" ? "Clean up" : "action"} (24 hours passed).`;

/** `failed` is null when a whole batch call threw, so the number of unrestored emails is unknown. */
export function undoResultMessage(kind: UndoKind, restored: number, failed: number | null): string {
  if (failed === 0) return `Restored ${emails(restored)} to your inbox.`;
  const rest = kind === "cleanup" ? " and are still in Trash or Archive." : ".";
  const who = failed === null ? "Some" : formatCount(failed);
  return `Restored ${emails(restored)}. ${who} could not be restored${rest}`;
}

/** Undo toast for a finished undo. Keep items are skipped by the server, so nothing restored is not a success. */
export function undoResultToast(
  kind: UndoKind,
  restored: number,
  failed: number | null,
): { kind: "success" | "info" | "error"; message: string } {
  if (restored === 0 && failed === 0) return { kind: "info", message: NOTHING_TO_RESTORE };
  return { kind: failed === 0 ? "success" : "error", message: undoResultMessage(kind, restored, failed) };
}
