import { describe, expect, it } from "vitest";
import {
  CLEARBOX_NOTE_SENDER,
  buildReminderNote,
  dropClearboxNotes,
  isClearboxNote,
  pendingTotal,
  reminderDue,
} from "../../src/reminder/reminder.ts";
import type { ReminderCounts } from "../../src/reminder/reminder.ts";

const DAY = 86_400_000;
/** Sunday 2026-10-18 02:00 UTC, the nightly cron time. */
const SUNDAY = Date.UTC(2026, 9, 18, 2);
const ON_SUNDAY = { enabled: true, weekday: 0 };

const counts = (over: Partial<ReminderCounts["pending"]> = {}, groups = 3): ReminderCounts => ({
  pending: { delete: 0, archive: 0, keep: 0, unsure: 0, ...over },
  groups,
});

describe("reminderDue", () => {
  it("is due on the chosen UTC weekday when nothing was sent yet", () => {
    expect(new Date(SUNDAY).getUTCDay()).toBe(0);
    expect(reminderDue(ON_SUNDAY, null, SUNDAY)).toBe(true);
  });

  it("is not due on other weekdays", () => {
    for (let d = 1; d < 7; d++) expect(reminderDue(ON_SUNDAY, null, SUNDAY + d * DAY)).toBe(false);
    expect(reminderDue({ enabled: true, weekday: 3 }, null, SUNDAY + 3 * DAY)).toBe(true);
  });

  it("is not due when off", () => {
    expect(reminderDue({ enabled: false, weekday: 0 }, null, SUNDAY)).toBe(false);
  });

  it("sends at most once per week, also on a rerun the same day", () => {
    expect(reminderDue(ON_SUNDAY, SUNDAY, SUNDAY)).toBe(false);
    expect(reminderDue(ON_SUNDAY, SUNDAY, SUNDAY + 3_600_000)).toBe(false);
    expect(reminderDue(ON_SUNDAY, SUNDAY, SUNDAY + 7 * DAY)).toBe(true);
  });

  it("keeps a 7 day gap when the weekday changes after a send", () => {
    const wednesday = { enabled: true, weekday: 3 };
    expect(reminderDue(wednesday, SUNDAY, SUNDAY + 3 * DAY)).toBe(false);
    expect(reminderDue(wednesday, SUNDAY, SUNDAY + 10 * DAY)).toBe(true);
  });
});

describe("isClearboxNote / dropClearboxNotes", () => {
  const from = (address: string | null) => ({ from: { address, name: null } });

  it("matches only the reserved Clearbox sender", () => {
    expect(isClearboxNote(from(CLEARBOX_NOTE_SENDER))).toBe(true);
    expect(isClearboxNote(from("Reminder@Clearbox.Invalid"))).toBe(true);
    expect(isClearboxNote(from("reminder@clearbox.example.com"))).toBe(false);
    expect(isClearboxNote(from("news@example.com"))).toBe(false);
    expect(isClearboxNote(from(null))).toBe(false);
  });

  it("drops notes and keeps everything else in order", () => {
    const a = from("a@example.com");
    const b = from("b@example.com");
    const out = dropClearboxNotes([a, from(CLEARBOX_NOTE_SENDER), b]);
    expect(out.kept).toEqual([a, b]);
    expect(out.skippedNotes).toBe(1);
  });
});

describe("buildReminderNote", () => {
  it("summarizes counts by action and links to Review and Rules", () => {
    const note = buildReminderNote({
      counts: counts({ delete: 1200, archive: 90, unsure: 1 }, 24),
      origin: "https://clearbox.example.test",
      to: "owner@example.test",
      now: SUNDAY,
    });
    expect(note.subject).toBe("Clearbox: 1,291 emails ready to review");
    expect(note.to).toBe("owner@example.test");
    expect(note.sentAt).toBe(SUNDAY);
    expect(note.text).toContain("1,291 emails are ready for your weekly cleanup.");
    expect(note.text).toContain("  Trash: 1,200\n  Archive: 90\n  Unsure: 1\n");
    expect(note.text).not.toContain("Keep:");
    expect(note.text).toContain("24 sender groups need a decision.");
    expect(note.text).toContain("Review them: https://clearbox.example.test/review");
    expect(note.text).toContain("open https://clearbox.example.test/rules and use Weekly reminder.");
  });

  it("uses singular forms", () => {
    const note = buildReminderNote({
      counts: counts({ keep: 1 }, 1),
      origin: null,
      to: "o@example.test",
      now: 0,
    });
    expect(note.subject).toBe("Clearbox: 1 email ready to review");
    expect(note.text).toContain("1 email is ready");
    expect(note.text).toContain("1 sender group needs a decision.");
    expect(note.text).toContain("Open Clearbox and go to Review.");
  });

  it("counts auto-trashed emails of the last 7 days (contracts 12.11)", () => {
    const note = buildReminderNote({
      counts: counts({ delete: 2 }, 1),
      origin: null,
      to: "o@example.test",
      now: 0,
      autoTrashed: 1234,
    });
    expect(note.subject).toBe("Clearbox: 2 emails ready to review");
    expect(note.text).toContain(
      "Auto-trash moved 1,234 emails from your Always OK to trash senders to Trash this week.",
    );
    expect(note.text).toContain("Anything else is trashed or archived only when you approve it.");
    expect(note.text).not.toContain("Nothing is trashed or archived until you approve it.");
  });

  it("still reports auto-trash when nothing is waiting for review", () => {
    const note = buildReminderNote({
      counts: counts({}, 0),
      origin: "https://clearbox.example.test",
      to: "o@example.test",
      now: 0,
      autoTrashed: 1,
    });
    expect(note.subject).toBe("Clearbox: 1 email auto-trashed this week");
    expect(note.text).toContain("Nothing is waiting for review.");
    expect(note.text).toContain("Auto-trash moved 1 email from your Always OK to trash senders");
    expect(note.text).not.toContain("Suggested actions:");
    expect(note.text).toContain("See it in Activity: https://clearbox.example.test/activity");
  });

  it("omits the auto-trash line when nothing was auto-trashed", () => {
    const note = buildReminderNote({ counts: counts({ delete: 1 }, 1), origin: null, to: "o", now: 0 });
    expect(note.text).not.toContain("Auto-trash");
    expect(note.text).toContain("Nothing is trashed or archived until you approve it.");
  });

  it("is plain ASCII text with no markup, remote content or em dash", () => {
    const note = buildReminderNote({
      counts: counts({ delete: 3, archive: 2, keep: 1, unsure: 4 }),
      origin: "https://clearbox.example.test",
      to: "owner@example.test",
      now: SUNDAY,
    });
    const all = `${note.subject}\n${note.text}`;
    expect(all).toMatch(/^[\x20-\x7e\n]*$/);
    expect(all).not.toMatch(/<[a-z!/]|https?:\/\/(?!clearbox\.example\.test\/)/i);
    expect(pendingTotal(counts({ delete: 3, archive: 2, keep: 1, unsure: 4 }))).toBe(10);
  });
});
