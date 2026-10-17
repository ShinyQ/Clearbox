import type { SuggestedAction } from "../model/actions.ts";
import type { MailMessage } from "../model/mail.ts";
import type { WeeklyReminder } from "../policy/policy.ts";
import type { InboxNote } from "../providers/provider.ts";

/**
 * Sender of every note Clearbox adds to an inbox (contracts 12.8). The `.invalid` TLD is reserved (RFC 2606), so
 * no real mail can come from it; a spoofed copy is only left unsorted, which is the safe direction.
 */
export const CLEARBOX_NOTE_SENDER = "reminder@clearbox.invalid";
export const CLEARBOX_NOTE_NAME = "Clearbox";
/** Informational header on Gmail notes; detection relies on the sender, which both providers return. */
export const CLEARBOX_NOTE_HEADER = "X-Clearbox-Note";

const DAY_MS = 86_400_000;
/** At most one reminder in any 7 UTC days, even when the owner changes the weekday after a send. */
export const REMINDER_MIN_GAP_DAYS = 7;

/** True for a note Clearbox added itself: it is never ingested, suggested or acted on. */
export function isClearboxNote(message: Pick<MailMessage, "from">): boolean {
  return message.from.address?.trim().toLowerCase() === CLEARBOX_NOTE_SENDER;
}

/** Drops Clearbox's own notes from a provider page before any read, decision or write. */
export function dropClearboxNotes<T extends Pick<MailMessage, "from">>(
  messages: readonly T[],
): { kept: T[]; skippedNotes: number } {
  const kept = messages.filter((m) => !isClearboxNote(m));
  return { kept, skippedNotes: messages.length - kept.length };
}

/**
 * The nightly job (02:00 UTC) sends when the reminder is on, today is the chosen UTC weekday, and no reminder was
 * sent in the last 7 UTC days. Whether there is anything to review is checked separately (it needs a D1 read).
 */
export function reminderDue(reminder: WeeklyReminder, lastSentAt: number | null, now: number): boolean {
  if (!reminder.enabled) return false;
  if (new Date(now).getUTCDay() !== reminder.weekday) return false;
  if (lastSentAt === null) return true;
  return Math.floor(now / DAY_MS) - Math.floor(lastSentAt / DAY_MS) >= REMINDER_MIN_GAP_DAYS;
}

export interface ReminderCounts {
  /** Pending suggestions per suggested action, across every visible account. */
  pending: Record<SuggestedAction, number>;
  /** Pending sender groups (account, sender, action), the units the owner decides on. */
  groups: number;
}

export function pendingTotal(counts: ReminderCounts): number {
  return counts.pending.delete + counts.pending.archive + counts.pending.keep + counts.pending.unsure;
}

const ACTION_LINES: readonly { action: SuggestedAction; label: string }[] = [
  { action: "delete", label: "Trash" },
  { action: "archive", label: "Archive" },
  { action: "keep", label: "Keep" },
  { action: "unsure", label: "Unsure" },
];

const count = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;

export interface ReminderInput {
  counts: ReminderCounts;
  /** Deployed origin without trailing slash (for example https://clearbox.<subdomain>.workers.dev), or null. */
  origin: string | null;
  /** The mailbox the note is added to (lowercased). */
  to: string;
  now: number;
  /** Contracts 12.11: emails auto-trashed in the 7 days before this note; 0 or absent omits the line. */
  autoTrashed?: number;
}

/** Plain text only: no HTML, no images, no remote content, no tracking. ASCII, so no encoding questions. */
export function buildReminderNote(input: ReminderInput): InboxNote {
  const total = pendingTotal(input.counts);
  const auto = input.autoTrashed ?? 0;
  const emails = plural(total, "email", "emails");
  const lines = ACTION_LINES.filter((l) => input.counts.pending[l.action] > 0).map(
    (l) => `  ${l.label}: ${count(input.counts.pending[l.action])}`,
  );
  const link = (path: string, open: string, see: string): string =>
    input.origin === null ? open : `${see}: ${input.origin}${path}`;
  const rules =
    input.origin === null
      ? "To turn it off or change the day, open Rules in Clearbox and use Weekly reminder."
      : `To turn it off or change the day, open ${input.origin}/rules and use Weekly reminder.`;
  const pending =
    total > 0
      ? [
          `Clearbox has sorted your inbox. ${emails} ${total === 1 ? "is" : "are"} ready for your weekly cleanup.`,
          "",
          "Suggested actions:",
          ...lines,
          "",
          `${plural(input.counts.groups, "sender group needs", "sender groups need")} a decision.`,
          "",
          link("/review", "Open Clearbox and go to Review.", "Review them"),
        ]
      : ["Clearbox has sorted your inbox. Nothing is waiting for review."];
  const autoLines =
    auto > 0
      ? [
          "",
          `Auto-trash moved ${plural(auto, "email", "emails")} from your Always OK to trash senders to Trash this week.`,
          link("/activity", "Open Activity in Clearbox to see it.", "See it in Activity"),
        ]
      : [];
  const text = [
    ...pending,
    ...autoLines,
    "",
    auto > 0
      ? "Anything else is trashed or archived only when you approve it."
      : "Nothing is trashed or archived until you approve it.",
    "",
    "--",
    "This weekly reminder comes from your own Clearbox deployment. Clearbox added it to this inbox",
    "directly: it was not sent as email, and Clearbox never sorts it.",
    rules,
    "",
  ].join("\n");
  const subject =
    total === 0 && auto > 0
      ? `Clearbox: ${plural(auto, "email", "emails")} auto-trashed this week`
      : `Clearbox: ${emails} ready to review`;
  return { subject, text, to: input.to, sentAt: input.now };
}
