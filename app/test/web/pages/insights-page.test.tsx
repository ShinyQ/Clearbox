import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../../../src/web/api/keys.ts";
import { backlogText } from "../../../src/web/components/insights/BudgetPanel.tsx";
import { InsightsPage } from "../../../src/web/pages/InsightsPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { type FakeApiState } from "../msw/fake-api.ts";
import { iso, makeSync, T0 } from "../msw/fixtures.ts";
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
    expect(await screen.findByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    const match = screen.getByRole("region", { name: "How well Clearbox matches you" });
    expect(within(match).getByText("98.6%")).toBeTruthy();
    expect(within(match).getByText("of trash suggestions you agreed with (target 98%)")).toBeTruthy();
    expect(within(match).getByText("86%")).toBeTruthy();
    expect(screen.getByText("current Clean up threshold, tuned nightly from your choices")).toBeTruthy();
    expect(screen.getByText("Last tuned 9 h ago")).toBeTruthy();
    expect(screen.getByText("decisions learned from you (312 this week)")).toBeTruthy();
    const chart = screen.getByRole("group", { name: /^Emails cleaned per week: .*this week 1,284$/ });
    expect(within(chart).getAllByRole("img")).toHaveLength(6);
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

  it("shows the trash threshold per kind of email and explains a paused one (contracts 12.10)", async () => {
    setup();
    const panel = await screen.findByRole("region", { name: "Trash thresholds by kind of email" });
    expect(within(panel).getByText("1 paused")).toBeTruthy();
    const table = within(panel).getByRole("table", { name: "Trash thresholds by kind of email" });
    expect(within(table).getByText("Newsletters and bulk mail")).toBeTruthy();
    expect(within(table).getByText("Paused")).toBeTruthy();
    expect(
      within(table).getByText(
        "Trash suggestions paused (you agreed 91.0% of the time): below the 98% target, so these go to Check instead.",
      ),
    ).toBeTruthy();
    expect(
      within(table).getByText("Not enough trash decisions here yet (12 of 50), so Clearbox stays careful."),
    ).toBeTruthy();
  });

  it("hides the segment panel before the first segment calibration", async () => {
    setup((s) => {
      s.insights = { ...s.insights, calibration: { ...s.insights.calibration, segments: [] } };
    });
    await screen.findByText("Storage: 182 MB of 500 MB");
    expect(screen.queryByRole("region", { name: "Trash thresholds by kind of email" })).toBeNull();
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

  it("shows a panel error with Try again that refetches", async () => {
    const { state, user } = setup((s) => {
      s.failures.insights = { status: 500, code: "internal", times: 9 };
    });
    expect(await screen.findByRole("heading", { name: "Couldn't load insights." })).toBeTruthy();
    const before = state.requests.filter((r) => r.route === "insights").length;
    delete state.failures.insights;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    expect(state.requests.filter((r) => r.route === "insights").length).toBeGreaterThan(before);
  });

  it("keeps loaded insights visible when a background refetch fails", async () => {
    const { state, client } = setup();
    expect(await screen.findByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    state.failures.insights = { status: 500, code: "internal", times: 9 };
    await client.refetchQueries({ queryKey: qk.insights });
    await waitFor(() => expect(client.getQueryState(qk.insights)?.status).toBe("error"));
    expect(screen.getByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Couldn't load insights." })).toBeNull();
  });
});

describe("backlogText with a scan history window (rev 2.4)", () => {
  it("names the window and never a whole-inbox backlog", () => {
    const row = {
      id: "acc_1",
      provider: "gmail" as const,
      email: "you@example.com",
      status: "active" as const,
      paused: false,
      sync: makeSync({
        phase: "inbox_backfill",
        backfillDone: false,
        messagesIngested: 8_200,
        inboxEstimate: 79_000,
        scanHistoryDays: 90,
      }),
    };
    expect(backlogText(row, 6_800, T0)).toBe("Scanning the last 90 days, 8,200 so far");
  });
});
