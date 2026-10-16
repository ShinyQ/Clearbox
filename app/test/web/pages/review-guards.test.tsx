import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../../src/web/pages/ReviewPage.tsx";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { ACC_GMAIL, makeGroupItems, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void, path = "/review") {
  const state = installFakeApi(mutate);
  const utils = renderPage(<ReviewPage />, { path, route: "/review" });
  return { state, ...utils };
}
const mutating = (s: FakeApiState) =>
  s.requests.filter((r) => r.route === "approve" || r.route === "override");

describe("Clean up gate", () => {
  it("ignores action hotkeys while the Clean up confirm bar is open", async () => {
    const { state, user } = setup();
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await screen.findByText("Clean up 14 emails in 4 sender groups?");
    await user.keyboard("t");
    expect(mutating(state)).toHaveLength(0);
  });

  it("soft-disables the detail actions and gates bulk approve while Clean up is open", async () => {
    const { state, user } = setup();
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("x");
    const approve = await screen.findByRole("button", { name: "Approve suggestions" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await screen.findByText("Clean up 14 emails in 4 sender groups?");
    expect(screen.getByRole("button", { name: "Trash 6" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Trash 6" }));
    await user.click(approve);
    expect(mutating(state)).toHaveLength(0);
  });
});

describe("Select all in tab", () => {
  it("stops after a bounded number of requests when the next page fails", async () => {
    const { state, user } = setup((s) => {
      s.items = Array.from({ length: 120 }, (_, i) =>
        makeGroupItems(
          {
            accountId: ACC_GMAIL,
            sender: `bulk${i}@bulk${i}.example`,
            name: `Bulk ${i}`,
            action: "delete",
            confidences: [0.97],
            subjects: ["Hello"],
            reasons: [],
          },
          1000 + i,
        ),
      ).flat();
    }, "/review?tab=trash");
    await user.click(await screen.findByRole("checkbox", { name: "Select all groups in Trash" }));
    const link = await screen.findByRole("button", { name: "Select all 120 in Trash" });
    state.failures.groups = { status: 500, code: "internal", times: 1000 };
    const before = state.requests.filter((r) => r.route === "groups").length;
    await user.click(link);
    await screen.findByText("Something went wrong. Nothing was changed.");
    expect(state.requests.filter((r) => r.route === "groups").length - before).toBeLessThanOrEqual(2);
  });
});
