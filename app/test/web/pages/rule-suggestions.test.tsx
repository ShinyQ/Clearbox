import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuleSuggestion } from "../../../src/shared/api.ts";
import { RuleSuggestions, ruleSuggestionText } from "../../../src/web/components/rules/RuleSuggestions.tsx";
import { summarySubline } from "../../../src/web/components/review/SummaryCard.tsx";
import { RulesPage } from "../../../src/web/pages/RulesPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { installFakeApi } from "../msw/handlers.ts";

const OFFERS: RuleSuggestion[] = [
  {
    entry: "deals@shop.example",
    list: "deny",
    decisions: 24,
    agreeing: 24,
    lastDecidedAt: "2026-10-14T10:00:00.000Z",
  },
  {
    entry: "mom@family.example.org",
    list: "allow",
    decisions: 12,
    agreeing: 12,
    lastDecidedAt: "2026-10-13T10:00:00.000Z",
  },
];

describe("Suggested rules (contracts 12.10)", () => {
  it("words an offer from the owner's own decisions", () => {
    expect(ruleSuggestionText(OFFERS[0]!)).toBe("You trashed 24 of 24 emails from deals@shop.example.");
    expect(ruleSuggestionText(OFFERS[1]!)).toBe("You kept 12 of 12 emails from mom@family.example.org.");
  });

  it("lists every offer in Rules and applies one with a single click", async () => {
    const state = installFakeApi((s) => {
      s.ruleSuggestions = [...OFFERS];
    });
    const { user, container } = renderPage(<RulesPage />, { path: "/rules" });
    const panel = await screen.findByRole("region", { name: "Suggested rules" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    await expectNoA11yViolations(container);
    await user.click(within(panel).getByRole("button", { name: "Always OK to trash" }));
    expect(
      await screen.findByText(
        "deals@shop.example is on your Always OK to trash list. Its emails skip the confidence check.",
      ),
    ).toBeTruthy();
    expect(state.requests.find((r) => r.route === "patchSender")?.body).toEqual({
      entry: "deals@shop.example",
      list: "deny",
    });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
  });

  it("dismisses an offer without changing any rule", async () => {
    const state = installFakeApi((s) => {
      s.ruleSuggestions = [OFFERS[1]!];
    });
    const { user } = renderPage(<RulesPage />, { path: "/rules" });
    await user.click(await screen.findByRole("button", { name: "Not now: mom@family.example.org" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggested rules" })).toBeNull());
    expect(state.requests.some((r) => r.route === "patchSender")).toBe(false);
    expect(state.requests.find((r) => r.route === "dismissRuleSuggestion")?.body).toEqual({
      entry: "mom@family.example.org",
      list: "allow",
    });
  });

  it("shows only the first offer in Review, with a link to the rest", async () => {
    installFakeApi((s) => {
      s.ruleSuggestions = [...OFFERS];
    });
    renderPage(<RuleSuggestions variant="review" />, { path: "/review" });
    const panel = await screen.findByRole("region", { name: "Suggested rules" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    expect(within(panel).getByRole("link", { name: "1 more in Rules" }).getAttribute("href")).toBe("/rules");
  });

  it("renders nothing without offers", async () => {
    const state = installFakeApi();
    renderPage(<RuleSuggestions variant="review" />, { path: "/review" });
    await waitFor(() => expect(state.requests.some((r) => r.route === "ruleSuggestions")).toBe(true));
    expect(screen.queryByRole("region", { name: "Suggested rules" })).toBeNull();
  });
});

describe("summarySubline: recent emails left alone", () => {
  it("mentions held recent mail separately from mail waiting for the model", () => {
    const base = { groups: 2, groupsLeft: 0, emailsLeft: 0, catchingUp: false, awaitingModel: 0 };
    expect(summarySubline({ ...base, recentHeld: 3 })).toContain(
      "3 recent emails are left alone until they are old enough to sort.",
    );
    expect(summarySubline({ ...base, recentHeld: 0 })).not.toContain("recent");
  });
});
