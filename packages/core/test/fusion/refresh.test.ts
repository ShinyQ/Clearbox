import { describe, expect, it } from "vitest";
import { holdUntil, refreshSuggestion, type RefreshInput } from "../../src/fusion/refresh.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import { makePolicy, makeSignals } from "../fixtures/builders.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17);

describe("holdUntil", () => {
  it("holds mail younger than minAgeDays until it is old enough", () => {
    expect(holdUntil(NOW - DAY, 3, NOW)).toBe(NOW + 2 * DAY);
    expect(holdUntil(NOW - 3 * DAY, 3, NOW)).toBeNull();
    expect(holdUntil(NOW - 3 * DAY + 1, 3, NOW)).toBe(NOW + 1);
  });

  it("never holds an unknown date or when the setting is Off", () => {
    expect(holdUntil(0, 3, NOW)).toBeNull();
    expect(holdUntil(NOW, 0, NOW)).toBeNull();
  });
});

function input(overrides: Partial<RefreshInput> = {}): RefreshInput {
  return {
    model: {
      action: { delete: 0.2, archive: 0.1, keep: 0.6, unsure: 0.1 },
      flags: { isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 },
      importance: 1,
      modelVersion: "fake/fake-1",
    },
    signals: makeSignals({ ageDays: 0 }),
    receivedAt: NOW - 10 * DAY,
    subject: "Weekly digest",
    snippet: "",
    storedCeiling: "delete",
    policy: makePolicy(),
    senderPrior: null,
    domainPrior: null,
    thresholds: { tauDelete: TAU_DELETE_DEFAULT, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
    now: NOW,
    ...overrides,
  };
}

describe("refreshSuggestion", () => {
  it("lets consistent owner trashes turn a stale Keep into Trash", () => {
    expect(refreshSuggestion(input()).suggestion.action).toBe("keep");
    const after = refreshSuggestion(input({ senderPrior: { deletes: 40, keeps: 0 } }));
    expect(after.prior.source).toBe("sender");
    expect(after.suggestion.segment).toBe("sender");
    expect(after.suggestion.action).toBe("delete");
  });

  it("recomputes the age from receivedAt, so a stored ageDays 0 no longer caps", () => {
    const r = refreshSuggestion(input());
    expect(r.guard.reasons.map((x) => x.code)).not.toContain("guard_too_recent");
  });

  it("never lifts a stored ceiling", () => {
    const r = refreshSuggestion(input({ senderPrior: { deletes: 40, keeps: 0 }, storedCeiling: "archive" }));
    expect(r.guard.ceiling).toBe("archive");
    expect(r.suggestion.action).not.toBe("delete");
  });

  it("applies a new Always OK to trash rule", () => {
    const r = refreshSuggestion(input({ policy: makePolicy({ denylist: ["news@shop.example.com"] }) }));
    expect(r.suggestion.segment).toBe("rule");
    expect(r.suggestion.action).toBe("delete");
  });
});
