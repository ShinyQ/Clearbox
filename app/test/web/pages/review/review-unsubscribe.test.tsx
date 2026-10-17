import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../../../src/web/pages/ReviewPage.tsx";
import { renderPage } from "../../helpers/render.tsx";
import { deriveGroups, type FakeApiState } from "../../msw/fake-api.ts";
import { T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

const SENDER = "promo@northwind.example";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi((s) => {
    s.unsubscribe[SENDER] = { oneClick: true, unsubscribedAt: null };
    mutate?.(s);
  });
  const utils = renderPage(<ReviewPage />, { path: "/review", route: "/review" });
  return { state, ...utils };
}
const northKey = (s: FakeApiState) => deriveGroups(s).find((g) => g.sender === SENDER)?.key;

async function openConfirm(user: ReturnType<typeof setup>["user"]) {
  const panel = await screen.findByRole("complementary", { name: "Northwind Deals" });
  await user.click(await within(panel).findByRole("button", { name: "Unsubscribe from Northwind Deals" }));
  return panel;
}

describe("Review unsubscribe assistant", () => {
  it("hides Unsubscribe when the newest email has no one-click", async () => {
    setup((s) => {
      s.unsubscribe = {};
    });
    const panel = await screen.findByRole("complementary", { name: "Northwind Deals" });
    await within(panel).findByRole("list", { name: /Latest emails/ });
    expect(within(panel).queryByRole("button", { name: /Unsubscribe/ })).toBeNull();
  });

  it("unsubscribes only, records it in the panel, and never trashes", async () => {
    const { state, user } = setup();
    const panel = await openConfirm(user);
    await user.click(within(panel).getByRole("button", { name: "Unsubscribe only" }));
    await screen.findByText(
      "Unsubscribed from Northwind Deals. It can take a few days for their emails to stop.",
    );
    expect(state.requests.filter((r) => r.route === "unsubscribe").map((r) => r.body)).toEqual([
      { groupKey: northKey(state) },
    ]);
    expect(state.requests.find((r) => r.route === "approve" || r.route === "override")).toBeUndefined();
    expect(await within(panel).findByText(/^Unsubscribed on /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("trashes and unsubscribes: unsubscribe first, then the group with Undo for the trash part", async () => {
    const { state, user } = setup();
    const panel = await openConfirm(user);
    await user.click(within(panel).getByRole("button", { name: "Trash 6 and unsubscribe" }));
    await screen.findByText("Unsubscribed from Northwind Deals and moved 6 emails to Trash.");
    const order = state.requests.map((r) => r.route).filter((r) => r === "unsubscribe" || r === "approve");
    expect(order).toEqual(["unsubscribe", "approve"]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Northwind Deals" })).toBeNull());
  });

  it("reports a failed unsubscribe and still trashes when both were asked for", async () => {
    const { state, user } = setup((s) => {
      s.unsubscribeResult = { outcome: "failed", error: "sender_redirect", unsubscribedAt: null };
    });
    const panel = await openConfirm(user);
    await user.click(within(panel).getByRole("button", { name: "Trash 6 and unsubscribe" }));
    await screen.findByText(
      "Northwind Deals answered with a redirect, which one-click unsubscribe doesn't allow. Use the link in one of their emails instead.",
    );
    await screen.findByText("Moved 6 emails from Northwind Deals to Trash.");
    expect(state.requests.some((r) => r.route === "approve")).toBe(true);
  });

  it("shows the budget error when the server refuses the request", async () => {
    const { user } = setup((s) => {
      s.failures.unsubscribe = {
        status: 429,
        code: "budget_exhausted",
        times: 1,
        retryAt: "2026-10-16T00:00:00.000Z",
      };
    });
    const panel = await openConfirm(user);
    await user.click(within(panel).getByRole("button", { name: "Unsubscribe only" }));
    await screen.findByText(/Today's free-tier limit for changes is reached/);
  });

  it("cancels without any request", async () => {
    const { state, user } = setup();
    const panel = await openConfirm(user);
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByRole("group", { name: /Unsubscribe from/ })).toBeNull();
    expect(state.requests.some((r) => r.route === "unsubscribe")).toBe(false);
  });
});

describe("Review unsubscribe assistant state", () => {
  it("closes an open confirmation when the owner moves to another group", async () => {
    const { user } = setup();
    await openConfirm(user);
    await user.keyboard("j");
    await screen.findByRole("complementary", { name: "Contoso Orders" });
    await user.keyboard("k");
    const panel = await screen.findByRole("complementary", { name: "Northwind Deals" });
    expect(within(panel).queryByRole("group", { name: /Unsubscribe from/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Unsubscribe from Northwind Deals" })).toBeTruthy();
  });
});
