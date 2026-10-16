import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RulesPage } from "../../../src/web/pages/RulesPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { installFakeApi } from "../msw/handlers.ts";

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<RulesPage />, { path: "/rules" }) };
}
const chips = (name: string) =>
  within(screen.getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((li) => li.firstChild?.textContent);

describe("Rules page", () => {
  it("renders every rule with the current policy", async () => {
    const { container } = setup();
    expect(await screen.findByRole("textbox", { name: "Always keep these senders" })).toBeTruthy();
    expect(chips("Always keep")).toEqual(["mom@family.example", "@bank.example"]);
    expect(chips("Always OK to trash")).toEqual(["promo@northwind.example"]);
    expect(
      (screen.getByRole("combobox", { name: "Leave recent emails alone" }) as HTMLSelectElement).value,
    ).toBe("3");
    const locked = screen.getByRole("switch", { name: "Protect starred, flagged and replied threads" });
    expect([locked.getAttribute("aria-checked"), locked.getAttribute("aria-disabled")]).toEqual([
      "true",
      "true",
    ]);
    expect(screen.getByRole("switch", { name: "Store email previews" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Save changes" }).getAttribute("aria-disabled")).toBe("true");
    expect(document.title).toBe("Rules · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("moves an entry between lists, marks the draft dirty and saves", async () => {
    const { state, user } = setup();
    const input = await screen.findByRole("textbox", { name: "Always keep these senders" });
    await user.type(input, "promo@northwind.example{Enter}");
    expect(screen.getByText("Moved from Always OK to trash")).toBeTruthy();
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    expect(document.title).toBe("Rules (unsaved) · Clearbox");
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByText("Rules saved. They apply to new emails from now on.")).toBeTruthy();
    const body = state.requests.find((r) => r.route === "putPolicy")?.body as {
      policy: { allowlist: string[]; denylist: string[] };
      expectedVersion: number;
    };
    expect(body.expectedVersion).toBe(4);
    expect(body.policy.allowlist).toContain("promo@northwind.example");
    expect(body.policy.denylist).toEqual([]);
    await waitFor(() => expect(screen.queryByText("You have unsaved changes.")).toBeNull());
  });

  it("shows Scan history and saves All mail as null (rev 2.4)", async () => {
    const { state, user } = setup();
    const select = (await screen.findByRole("combobox", { name: "Scan history" })) as HTMLSelectElement;
    expect(select.value).toBe("90");
    expect([...select.options].map((o) => o.text)).toEqual([
      "Last 30 days",
      "Last 90 days",
      "Last year",
      "All mail",
    ]);
    expect(screen.getByText(/New mail is always scanned\./)).toBeTruthy();
    await user.selectOptions(select, "all");
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByText("Rules saved. They apply to new emails from now on.")).toBeTruthy();
    const body = state.requests.find((r) => r.route === "putPolicy")?.body as {
      policy: { scanHistoryDays: number | null };
    };
    expect(body.policy.scanHistoryDays).toBeNull();
  });

  it("validates record words on the client", async () => {
    const { user } = setup();
    await user.type(await screen.findByRole("textbox", { name: "Record words" }), "a{Enter}");
    expect(screen.getByText("Use 2 to 40 characters.")).toBeTruthy();
  });

  it("shows server validation errors under the field", async () => {
    const { user } = setup((s) => {
      s.failures.putPolicy = {
        status: 400,
        code: "validation_failed",
        times: 1,
        details: [{ path: "allowlist.2", message: "bad" }],
      };
    });
    await user.type(
      await screen.findByRole("textbox", { name: "Always keep these senders" }),
      "@new.example{Enter}",
    );
    await user.keyboard("{Control>}s{/Control}");
    expect(await screen.findByText("Some entries are not valid. Fix the highlighted fields.")).toBeTruthy();
    expect(screen.getByText("Use name@domain.com or @domain.com.")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Always keep these senders" })),
    );
  });

  it("handles a conflict by reloading the rules", async () => {
    const { user } = setup((s) => {
      s.failures.putPolicy = { status: 409, code: "conflict", times: 1 };
    });
    await user.click(await screen.findByRole("switch", { name: "Store email previews" }));
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByText("Rules changed in another tab.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reload rules" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Store email previews" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("resets to defaults and discards", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    expect(screen.queryByRole("list", { name: "Always keep" })?.querySelectorAll("li").length ?? 0).toBe(0);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(chips("Always keep")).toEqual(["mom@family.example", "@bank.example"]);
  });

  it("guards navigation while there are unsaved changes", async () => {
    const { router, user } = setup();
    await user.click(await screen.findByRole("switch", { name: "Remember subjects of emails you decide" }));
    await act(() => router.navigate("/review"));
    expect(screen.getByRole("button", { name: "Stay" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/rules");
    await act(() => router.navigate("/review"));
    await user.click(screen.getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });
});
