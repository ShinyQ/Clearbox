import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../../src/web/pages/ReviewPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { setViewport } from "../helpers/viewport.ts";
import { deriveGroups, type FakeApiState } from "../msw/fake-api.ts";
import { makeSync, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void, path = "/review") {
  const state = installFakeApi(mutate);
  const utils = renderPage(<ReviewPage />, { path, route: "/review" });
  return { state, ...utils };
}
const keyOfName = (s: FakeApiState, name: string) => deriveGroups(s).find((g) => g.senderName === name)?.key;

describe("Review page", () => {
  it("renders the ready state with summary, tabs, rows and the inline detail", async () => {
    const { container } = setup();
    expect(
      await screen.findByRole("heading", { level: 2, name: "14 emails are ready to clean up" }),
    ).toBeTruthy();
    expect(screen.getByText("Sorted 1 min ago · catching up")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trash, 3 groups" })).toBeTruthy();
    expect(await screen.findByRole("complementary", { name: "Northwind Deals" })).toBeTruthy();
    const first = screen.getAllByRole("row")[1];
    expect(first?.getAttribute("aria-current")).toBe("true");
    expect(document.title).toBe("(7) Review · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("supports the keyboard triage flow with Undo", async () => {
    const { state, user } = setup();
    const northKey = keyOfName(state, "Northwind Deals");
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("j");
    expect(await screen.findByRole("complementary", { name: "Contoso Orders" })).toBeTruthy();
    await user.keyboard("x");
    expect(screen.getByText("1 group selected · 3 emails")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar", { name: "Selected groups" })).toBeNull();
    await user.keyboard("k");
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("t");
    await screen.findByText("Moved 6 emails from Northwind Deals to Trash.");
    expect(state.requests.find((r) => r.route === "approve")?.body).toMatchObject({
      groupKey: northKey,
    });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Contoso Orders/),
    );
    await user.keyboard("{Control>}z{/Control}");
    await screen.findByText("Restored 6 emails to your inbox.");
  });

  it("switches tabs with number keys and overrides a Check group with T", async () => {
    const { state, user } = setup();
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("4");
    expect(await screen.findByRole("grid", { name: "Sender groups, Check tab" })).toBeTruthy();
    await screen.findByRole("complementary", { name: "Build Bot" });
    await user.keyboard("t");
    await screen.findByText("Moved 5 emails from Build Bot to Trash.");
    expect(state.requests.some((r) => r.route === "override")).toBe(true);
  });

  it("runs Clean up from mod+Enter, then shows Inbox cleared", async () => {
    const { state, user } = setup();
    await screen.findByRole("button", { name: "Clean up 14" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Clean up 14 emails in 4 sender groups?")).toBeTruthy();
    expect(
      screen.getByText(
        "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you.",
      ),
    ).toBeTruthy();
    await user.keyboard("{Enter}");
    await screen.findByText("14 emails cleaned up from 4 sender groups");
    expect(state.requests.filter((r) => r.route === "cleanup")[0]?.body).toMatchObject({
      threshold: 0.86,
      actions: ["delete", "archive"],
    });
    expect(await screen.findByRole("heading", { name: "Inbox cleared" })).toBeTruthy();
    expect(
      screen.getByText("4 groups are waiting for your call. New mail gets sorted every 30 minutes."),
    ).toBeTruthy();
  });

  it("rolls back a failed action and keeps focus on the row", async () => {
    const { user } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("t");
    await screen.findByText("Something went wrong. Nothing was changed.");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Northwind Deals/),
    );
    expect(screen.getAllByRole("row")).toHaveLength(8);
  });

  it.each([
    ["nothing sure", (s: FakeApiState) => void (s.tau = 0.995), "Nothing is sure enough to clean up yet"],
    [
      "all caught up",
      (s: FakeApiState) => {
        s.items = [];
        s.accounts = s.accounts.map((a) => ({ ...a, sync: makeSync() }));
      },
      "All caught up",
    ],
    ["first sort", (s: FakeApiState) => void (s.items = []), "Sorting your mailbox"],
    ["no accounts", (s: FakeApiState) => void (s.accounts = []), "Connect a mailbox to start"],
  ])("shows the %s state", async (_name, mutate, heading) => {
    const { container } = setup(mutate);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("shows first-sort progress from inboxEstimate", async () => {
    setup((s) => void (s.items = []));
    await screen.findByRole("heading", { name: "Sorting your mailbox" });
    expect(screen.getByRole("progressbar", { name: "Sorting progress" }).getAttribute("aria-valuenow")).toBe(
      "41",
    );
  });

  it("shows the error state when everything fails", async () => {
    setup((s) => {
      for (const r of ["summary", "preview", "groups"] as const)
        s.failures[r] = { status: 500, code: "internal", times: 9 };
    });
    expect(await screen.findByRole("heading", { name: "Couldn't load Review" })).toBeTruthy();
  });

  it("shows the reconnect banner for an account that needs it", async () => {
    setup((s) => {
      s.accounts[0] = { ...s.accounts[0]!, status: "needs_reauth" };
    });
    expect(await screen.findByText("you@example.com needs to reconnect.")).toBeTruthy();
  });

  it("opens the slide-over at 1100px and returns focus to the row on Esc", async () => {
    setViewport(1100);
    const { user } = setup();
    const row = await screen.findByRole("row", { name: /^Contoso Orders/ });
    await user.click(within(row).getByText("Contoso Orders"));
    const dialog = await screen.findByRole("dialog", { name: "Contoso Orders" });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Contoso Orders" })),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Contoso Orders" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("row", { name: /^Contoso Orders/ })),
    );
  });

  it("keeps a tab stop on the first row when the group param is unknown", async () => {
    setup(undefined, "/review?group=missing");
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[1]?.getAttribute("tabindex")).toBe("-1");
  });

  it("offers Confirm all keeps on the Keep tab", async () => {
    const { user } = setup(undefined, "/review?tab=keep");
    await user.click(await screen.findByRole("button", { name: "Confirm all keeps" }));
    expect(await screen.findByText("Mark 2 emails in 1 sender group as Keep?")).toBeTruthy();
  });
});
