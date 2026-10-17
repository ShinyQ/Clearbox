import type { UnsubscribeErrorCode } from "../../shared/api.ts";
import { formatDayMonth, plural } from "./format.ts";

/** UI spec 4.14a copy. Unsubscribing is irreversible, so every surface that starts it says so. */
export const UNSUBSCRIBE_CAUTION = "Unsubscribing can't be undone.";

export const unsubscribedOn = (iso: string): string => `Unsubscribed on ${formatDayMonth(iso)}`;

export const unsubscribeConfirmTitle = (name: string): string => `Unsubscribe from ${name}?`;

export function unsubscribeConfirmDetail(count: number): string {
  return `Clearbox sends the sender's one-click unsubscribe request. ${UNSUBSCRIBE_CAUTION} Moving ${plural(count, "email", "emails")} to Trash can be undone for 24 hours.`;
}

export const unsubscribeDoneToast = (name: string): string =>
  `Unsubscribed from ${name}. It can take a few days for their emails to stop.`;

export const trashAndUnsubscribeToast = (name: string, n: number): string =>
  `Unsubscribed from ${name} and moved ${plural(n, "email", "emails")} to Trash.`;

/** Error toast for a failed unsubscribe. `name` is the sender's display name (plain text). */
export function unsubscribeErrorMessage(code: UnsubscribeErrorCode | null, name: string): string {
  switch (code) {
    case "not_available":
      return `${name} no longer offers one-click unsubscribe. Nothing was sent.`;
    case "message_gone":
      return `The newest email from ${name} is gone, so its unsubscribe link couldn't be read. Nothing was sent.`;
    case "unsafe_url":
      return `${name}'s unsubscribe link didn't pass Clearbox's safety check. Nothing was sent.`;
    case "account_inactive":
      return "Reconnect this account to unsubscribe. Nothing was sent.";
    case "sender_rejected":
      return `${name} didn't accept the unsubscribe request. Try again later, or use the link in one of their emails.`;
    case "sender_redirect":
      return `${name} answered with a redirect, which one-click unsubscribe doesn't allow. Use the link in one of their emails instead.`;
    case "sender_timeout":
      return `${name} didn't answer in time. Try again later.`;
    case "sender_unreachable":
      return `Couldn't reach ${name}'s unsubscribe server. Try again later.`;
    default:
      return "Couldn't read the unsubscribe link from your mailbox. Nothing was sent. Try again in a minute.";
  }
}

/** Activity "Result" text for an unsubscribe audit row (codes only, never the sender). */
export function unsubscribeActivityResult(outcome: string | number | undefined): string {
  switch (outcome) {
    case "unsubscribed":
      return "Done";
    case "not_available":
      return "Not offered";
    case "message_gone":
      return "Email gone";
    case "unsafe_url":
      return "Blocked: unsafe link";
    case "account_inactive":
      return "Needs reconnect";
    case "sender_rejected":
      return "Sender refused";
    case "sender_redirect":
      return "Sender redirected";
    case "sender_timeout":
      return "No answer";
    case "sender_unreachable":
      return "Sender unreachable";
    default:
      return "Mailbox error";
  }
}
