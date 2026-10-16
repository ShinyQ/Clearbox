import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsPage } from "../../../src/web/pages/InsightsPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { type FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<InsightsPage />, { path: "/insights" }) };
}

describe("Insights page", () => {
  it("states agreement, threshold, decisions, weekly chart, budget and calibration", async () => {
    const { container } = setup();
    const match = await screen.findByRole("region", { name: "How well Clearbox matches you" });
    expect(await within(match).findByText("98.6%")).toBeTruthy();
    expect(within(match).getByText("of trash suggestions you agreed with (target 98%)")).toBeTruthy();
    expect(within(match).getByText("86%")).toBeTruthy();
    expect(screen.getByText("current Clean up threshold, tuned nightly from your choices")).toBeTruthy();
    expect(screen.getByText("Last tuned 9 h ago")).toBeTruthy();
    expect(screen.getByText("decisions learned from you (312 this week)")).toBeTruthy();
    const chart = screen.getByRole("group", { name: /^Emails cleaned per week: .*this week 1,284$/ });
    expect(within(chart).getAllByRole("button")).toHaveLength(6);
    expect(screen.getByText("This week: 1,284 cleaned, 18 undone")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Accounts and daily budget" });
    expect(within(table).getByRole("cell", { name: "11,800 emails · about 2 days" })).toBeTruthy();
    expect(within(table).getByText("Catching up")).toBeTruthy();
    expect(screen.getByText("Cloudflare free tier · resets 00:00")).toBeTruthy();
    expect(screen.getByText("21,080 of 90,000 daily writes used (23%)")).toBeTruthy();
    expect(screen.getByText("AI model today: 3,412 calls, 2 failed, about $0.06")).toBeTruthy();
    expect(screen.getByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Daily writes used" }).getAttribute("aria-valuenow")).toBe(
      "23",
    );
    expect(screen.getByText("How the threshold was chosen")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(document.title).toBe("Insights · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("explains insufficient data", async () => {
    setup((s) => {
      s.insights = {
        ...s.insights,
        precision: { ...s.insights.precision, deletePrecision: null },
        calibration: { ...s.insights.calibration, outcome: "insufficient_data", ranAt: null, points: [] },
        labels: { total: 0, last7Days: 0 },
      };
    });
    expect(
      await screen.findByText("Not enough trash decisions yet. Clearbox measures this after 50."),
    ).toBeTruthy();
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(
      screen.getByText("starting Clean up threshold. Clearbox tunes it after 50 trash decisions."),
    ).toBeTruthy();
    expect(screen.getByText("No decisions yet. Every Clean up and choice teaches Clearbox.")).toBeTruthy();
    expect(screen.getByText("Not enough decisions yet.")).toBeTruthy();
  });

  it("shows the budget at 100% and the paid tier", async () => {
    const { state } = setup((s) => {
      s.insights = { ...s.insights, budget: { ...s.insights.budget, rowsWritten: 90_000 } };
      s.me = { ...s.me, issues: [{ code: "budget_exhausted_today", since: iso(T0), accountId: null }] };
    });
    expect(
      await screen.findByText("90,000 of 90,000 daily writes used (100%). Sorting resumes after 00:00."),
    ).toBeTruthy();
    expect(screen.getByText("Today's free-tier limit is reached.")).toBeTruthy();
    expect(state.requests.some((r) => r.route === "insights")).toBe(true);
  });

  it("hides the write meter on Workers Paid", async () => {
    setup((s) => {
      s.me = { ...s.me, freeTier: false };
    });
    expect(await screen.findByText("Workers Paid · no daily write cap")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Daily writes used" })).toBeNull();
  });

  it("shows a panel error with Try again", async () => {
    setup((s) => {
      s.failures.insights = { status: 500, code: "internal", times: 9 };
    });
    expect(await screen.findByRole("heading", { name: "Couldn't load insights." })).toBeTruthy();
  });
});
