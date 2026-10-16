import { describe, expect, it } from "vitest";
import type { CleanupPreview } from "../../../src/shared/api.ts";
import { emptyTotals } from "../../../src/web/api/cleanup.ts";
import {
  confirmDetail,
  confirmTitle,
  doneToast,
  partialCopy,
  type CopyContext,
} from "../../../src/web/lib/copy.ts";
import { createFakeApiState, previewOf } from "../msw/fake-api.ts";

const s = createFakeApiState();
const base = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
const ctx: CopyContext = {
  pendingTotal: 27,
  accountEmail: null,
  inactiveEmail: null,
  providerLabel: "Gmail",
  resetTime: "07:00",
};
const withActions = (d: number, a: number, groups: number): CleanupPreview => ({
  ...base,
  count: d + a,
  byAction: { delete: d, archive: a, keep: 0 },
  groups,
});

describe("confirm copy (UI spec 5.2.4)", () => {
  it("uses exact preview counts and tau from the preview", () => {
    expect(confirmTitle("cleanup", base, ctx)).toBe("Clean up 14 emails in 4 sender groups?");
    expect(confirmDetail("cleanup", base, ctx)).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you.",
    );
  });

  it("covers trash only, archive only, account filter, nothing left, missing A2 and inactive accounts", () => {
    expect(confirmDetail("cleanup", withActions(11, 0, 3), ctx)).toBe(
      "All 11 go to Trash. Nothing is permanently deleted. 4 groups below 86% stay here for you.",
    );
    expect(confirmDetail("cleanup", withActions(0, 3, 1), ctx)).toBe(
      "All 3 go to Archive. 4 groups below 86% stay here for you.",
    );
    expect(confirmTitle("cleanup", base, { ...ctx, accountEmail: "you@example.com" })).toBe(
      "Clean up 14 emails from you@example.com?",
    );
    expect(confirmDetail("cleanup", { ...base, groupsLeft: 0 }, ctx)).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted.",
    );
    expect(confirmDetail("cleanup", { ...base, groupsLeft: undefined as unknown as number }, ctx)).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 13 emails below 86% or waiting for your choice stay here.",
    );
    expect(confirmDetail("cleanup", base, { ...ctx, inactiveEmail: "you@example.net" })).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you. Emails from you@example.net are skipped until you reconnect it.",
    );
  });

  it("words Confirm all keeps", () => {
    const keeps = { ...base, count: 47, byAction: { delete: 0, archive: 0, keep: 47 }, groups: 12 };
    expect(confirmTitle("confirm_keeps", keeps, ctx)).toBe("Mark 47 emails in 12 sender groups as Keep?");
    expect(confirmDetail("confirm_keeps", keeps, ctx)).toBe(
      "They stay in your inbox, leave Review, and Clearbox learns from your choice.",
    );
  });
});

describe("outcome copy", () => {
  const run = { ...emptyTotals(1284), executed: 1180, total: 1284 };

  it("words the done toast with already-handled items", () => {
    expect(doneToast("cleanup", { ...run, executed: 1280, skipped: 4 }, { ...base, groups: 371 })).toBe(
      "1,280 emails cleaned up from 371 sender groups (4 were already handled)",
    );
    expect(doneToast("confirm_keeps", { ...run, executed: 47 }, { ...base, groups: 12 })).toBe(
      "Kept 47 emails from 12 sender groups. Clearbox will remember.",
    );
  });

  it.each([
    [
      "budget",
      "Clean up paused at today's free-tier limit. 1,180 emails were cleaned up.",
      "The other 104 stay in Review. Actions work again after 07:00.",
    ],
    [
      "rate_limited",
      "Gmail asked Clearbox to slow down. 1,180 emails were cleaned up.",
      "The other 104 stay in Review. Try again in a minute.",
    ],
    [
      "account_inactive",
      "1,180 emails were cleaned up. 104 were skipped.",
      "you@example.net needs to reconnect before its emails can be moved.",
    ],
    [
      "no_progress",
      "1,180 emails were cleaned up. 104 are still waiting.",
      "The mailbox did not accept more changes right now. Try again in a few minutes.",
    ],
    ["stopped", "Clean up stopped. 1,180 emails were cleaned up.", "The rest stay in Review."],
    [
      "network",
      "Connection lost during Clean up. 1,180 emails were cleaned up.",
      "The rest stay in Review. Try again when you're back online.",
    ],
    [
      "unexpected",
      "Clean up stopped because of an unexpected error. 1,180 emails were cleaned up.",
      "The rest stay in Review. Try again; if it keeps happening, check the Worker logs.",
    ],
  ] as const)("words partial %s", (reason, title, detail) => {
    expect(partialCopy(reason, run, { ...ctx, inactiveEmail: "you@example.net" })).toEqual({
      title,
      detail,
    });
  });

  it("words item failures", () => {
    expect(partialCopy("item_failures", { ...run, executed: 1280, failed: 4 }, ctx)).toEqual({
      title: "1,280 emails were cleaned up. 4 could not be moved.",
      detail:
        "They were moved or deleted outside Clearbox, or the mailbox refused the change. They are marked as failed.",
    });
  });
});

describe("singulars and keeps wording (W16, W25)", () => {
  const run = { ...emptyTotals(3), executed: 1, total: 3 };

  it("uses natural singulars", () => {
    expect(confirmTitle("cleanup", { ...withActions(1, 0, 1), groupsLeft: 1 }, ctx)).toBe(
      "Clean up 1 email in 1 sender group?",
    );
    expect(confirmDetail("cleanup", { ...withActions(1, 0, 1), groupsLeft: 1 }, ctx)).toBe(
      "It goes to Trash. Nothing is permanently deleted. 1 group below 86% stays here for you.",
    );
    expect(confirmDetail("cleanup", withActions(1, 3, 2), ctx)).toContain(
      "1 goes to Trash and 3 to Archive.",
    );
    expect(partialCopy("stopped", run, ctx).title).toBe("Clean up stopped. 1 email was cleaned up.");
  });

  it("does not claim cleaned up emails when the run only skipped items or only kept", () => {
    expect(doneToast("cleanup", { ...run, executed: 0, skipped: 2 }, base)).toBe(
      "Nothing needed cleaning up (2 were already handled)",
    );
    expect(partialCopy("stopped", { ...run, executed: 5, total: 9 }, ctx, "confirm_keeps")).toEqual({
      title: "Confirming keeps stopped. 5 emails were kept.",
      detail: "The rest stay in Review.",
    });
  });
});
