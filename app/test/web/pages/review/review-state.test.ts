import { describe, expect, it } from "vitest";
import {
  firstSortProgress,
  moveTarget,
  nextAfterRemoval,
  reviewPageState,
  sortedMeta,
  summaryCardState,
  tabCounts,
} from "../../../../src/web/pages/review/review-state.ts";
import { createFakeApiState, summaryOf } from "../../msw/fake-api.ts";
import { makeAccount, makeSync, T0 } from "../../msw/fixtures.ts";

const ok = "success" as const;

describe("review-state", () => {
  it("derives the page state", () => {
    const base = {
      accounts: ok,
      accountCount: 2,
      summary: ok,
      preview: ok,
      groups: ok,
      pendingTotal: 27,
      backfilling: false,
    };
    expect(reviewPageState({ ...base, accounts: "pending" })).toBe("loading");
    expect(reviewPageState({ ...base, accountCount: 0 })).toBe("no_accounts");
    expect(reviewPageState({ ...base, summary: "error", preview: "error", groups: "error" })).toBe("error");
    expect(reviewPageState({ ...base, pendingTotal: 0, backfilling: true })).toBe("first_sort");
    expect(reviewPageState({ ...base, pendingTotal: 0 })).toBe("all_caught_up");
    expect(reviewPageState(base)).toBe("ready");
  });

  it("derives the summary card state", () => {
    expect(summaryCardState("pending", ok, 0)).toBe("loading");
    expect(summaryCardState("error", ok, 0)).toBe("error");
    expect(summaryCardState(ok, ok, 0)).toBe("nothing_sure");
    expect(summaryCardState(ok, ok, 14)).toBe("ready");
  });

  it("formats the header meta and tab counts", () => {
    const s = createFakeApiState();
    expect(sortedMeta(s.accounts, T0)).toBe("Sorted 1 min ago · catching up");
    expect(sortedMeta([makeAccount({ sync: makeSync({ lastTickAt: null }) })], T0)).toBe("Not sorted yet");
    expect(tabCounts(summaryOf(s))).toEqual({ all: 7, trash: 3, archive: 2, check: 1, keep: 1 });
    expect(tabCounts(undefined).all).toBeNull();
  });

  it("moves and picks the next row after removal", () => {
    const keys = ["a", "b", "c", "d"];
    expect([
      moveTarget(keys, "b", "next"),
      moveTarget(keys, "a", "prev"),
      moveTarget(keys, "b", "last"),
      moveTarget(keys, "c", "pageup"),
    ]).toEqual(["c", "a", "d", "a"]);
    expect(nextAfterRemoval(keys, ["b"])).toBe("c");
    expect(nextAfterRemoval(keys, ["d"])).toBe("c");
    expect(nextAfterRemoval(["a"], ["a"])).toBeNull();
  });

  it("averages first-sort progress when every estimate is known", () => {
    const accounts = createFakeApiState().accounts;
    expect(firstSortProgress(accounts)).toEqual({ value: 0.41, sorted: 40_318 });
    expect(
      firstSortProgress([
        makeAccount({
          sync: makeSync({ backfillDone: false, inboxEstimate: null, messagesIngested: 10 }),
        }),
      ]).value,
    ).toBeNull();
  });
});
