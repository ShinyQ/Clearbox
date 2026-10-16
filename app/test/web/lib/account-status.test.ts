import { describe, expect, it } from "vitest";
import {
  backlogRemaining,
  catchUpFraction,
  dailyRateFrom,
  deriveAccountUiStatus,
  etaText,
  scanWindowText,
} from "../../../src/web/lib/account-status.ts";
import { T0, iso, makeAccount, makeSync } from "../msw/fixtures.ts";

describe("deriveAccountUiStatus", () => {
  it("applies the first matching rule", () => {
    expect(deriveAccountUiStatus(makeAccount({ status: "config_error", paused: true }), T0)).toBe(
      "config_error",
    );
    expect(deriveAccountUiStatus(makeAccount({ status: "needs_reauth", paused: true }), T0)).toBe(
      "needs_reauth",
    );
    expect(deriveAccountUiStatus(makeAccount({ paused: true }), T0)).toBe("paused");
    expect(
      deriveAccountUiStatus(
        makeAccount({ sync: makeSync({ backoffUntil: iso(T0 + 180_000), backfillDone: false }) }),
        T0,
      ),
    ).toBe("waiting");
    expect(deriveAccountUiStatus(makeAccount({ sync: makeSync({ backfillDone: false }) }), T0)).toBe(
      "catching_up",
    );
    expect(deriveAccountUiStatus(makeAccount({ sync: makeSync({ phase: "inbox_backfill" }) }), T0)).toBe(
      "catching_up",
    );
    expect(deriveAccountUiStatus(makeAccount(), T0)).toBe("up_to_date");
  });
});

describe("catch-up math (A4)", () => {
  it("uses inboxEstimate when known", () => {
    const a = makeAccount({
      sync: makeSync({ backfillDone: false, messagesIngested: 8_200, inboxEstimate: 20_000 }),
    });
    expect(catchUpFraction(a)).toBeCloseTo(0.41, 9);
    expect(backlogRemaining(a)).toBe(11_800);
    expect(catchUpFraction(makeAccount({ sync: makeSync({ backfillDone: false }) }))).toBeNull();
  });

  it("claims no backlog or fraction when a scan history window applies (rev 2.4)", () => {
    const a = makeAccount({
      sync: makeSync({
        backfillDone: false,
        messagesIngested: 8_200,
        inboxEstimate: 79_000,
        scanHistoryDays: 90,
      }),
    });
    expect(catchUpFraction(a)).toBeNull();
    expect(backlogRemaining(a)).toBeNull();
    expect(backlogRemaining(makeAccount({ sync: makeSync({ scanHistoryDays: 90 }) }))).toBe(0);
    expect([scanWindowText(30), scanWindowText(90), scanWindowText(365), scanWindowText(null)]).toEqual([
      "the last 30 days",
      "the last 90 days",
      "the last year",
      null,
    ]);
  });

  it("estimates days from the last three complete days", () => {
    const history = [5_000, 6_000, 7_000, 8_000, 999].map((m, i) => ({
      date: `2026-10-${10 + i}`,
      rowsWritten: 0,
      messagesIngested: m,
      decisionCalls: 0,
    }));
    expect(dailyRateFrom(history)).toBe(7_000);
    expect(dailyRateFrom([])).toBe(6_800);
    expect(etaText(18_400, 6_800)).toBe("about 3 days");
    expect(etaText(8_000, 6_800)).toBe("about 1 day");
    expect(etaText(2_000, 6_800)).toBe("less than a day");
  });
});
