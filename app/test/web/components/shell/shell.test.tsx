import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkFailureStore, sessionErrorStore } from "../../../../src/web/api/client.ts";
import { FullPageError, type FullPageErrorKind } from "../../../../src/web/pages/FullPageError.tsx";
import { browser } from "../../../../src/web/lib/links.ts";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { renderPage } from "../../helpers/render.tsx";
import { setViewport } from "../../helpers/viewport.ts";
import { T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

afterEach(() => {
  sessionErrorStore.set(null);
  networkFailureStore.set(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const Page = () => <h1>Test page</h1>;

describe("AppShell", () => {
  it("renders the sidebar with counts, account health, add account and the user menu", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    installFakeApi();
    const { container, user } = renderPage(<Page />, { path: "/review" });
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(await within(primary).findByRole("link", { name: "Review, 7 groups to review" })).toBeTruthy();
    expect(within(primary).getByRole("link", { name: "Add account" }).getAttribute("href")).toBe(
      "/accounts?add=1",
    );
    const accounts = screen.getByRole("navigation", { name: "Accounts" });
    expect(within(accounts).getByRole("link", { name: "you@example.com, up to date" })).toBeTruthy();
    expect(
      within(accounts).getByRole("link", { name: "you@example.net, catching up, 41% sorted" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    await user.click(screen.getByRole("button", { name: "Account menu for owner@example.test" }));
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await expectNoA11yViolations(container);
  });

  it("offers Reconnect for an account that needs it and remembers where to return", async () => {
    installFakeApi((s) => {
      s.accounts[1] = { ...s.accounts[1]!, status: "needs_reauth" };
    });
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { user } = renderPage(<Page />, { path: "/review" });
    const accounts = await screen.findByRole("navigation", { name: "Accounts" });
    await user.click(await within(accounts).findByRole("button", { name: "Reconnect you@example.net" }));
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/accounts");
    expect(assign).toHaveBeenCalledWith("/oauth/microsoft/start?loginHint=you%40example.net");
  });

  it("replaces the page with the session-expired state on 401", async () => {
    installFakeApi((s) => {
      s.failures.me = { status: 401, code: "unauthenticated", times: 5 };
    });
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => undefined);
    const { user } = renderPage(<Page />, { path: "/review" });
    expect(await screen.findByRole("heading", { name: "Your session expired" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the forbidden and misconfigured pages", async () => {
    installFakeApi();
    renderPage(<Page />, { path: "/review" });
    act(() => sessionErrorStore.set("access_misconfigured"));
    expect(await screen.findByRole("heading", { name: "Sign-in protection is not configured" })).toBeTruthy();
    act(() => sessionErrorStore.set("forbidden"));
    expect(screen.getByRole("heading", { name: "This Clearbox belongs to someone else" })).toBeTruthy();
  });

  it("collapses to a top bar with a modal drawer below 1024px", async () => {
    installFakeApi();
    setViewport(900);
    const { user } = renderPage(<Page />, { path: "/review" });
    const open = await screen.findByRole("button", { name: "Open navigation" });
    await user.click(open);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("closes the drawer after any in-drawer navigation, such as an account row link", async () => {
    installFakeApi();
    setViewport(900);
    const { user, router } = renderPage(<Page />, { path: "/review" });
    await user.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    await user.click(await within(drawer).findByRole("link", { name: "you@example.com, up to date" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(router.state.location.pathname).toBe("/accounts");
  });

  it("has no axe violations with the drawer open", async () => {
    installFakeApi();
    setViewport(900);
    const { user } = renderPage(<Page />, { path: "/review" });
    await user.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    await within(drawer).findByRole("link", { name: "you@example.com, up to date" });
    await expectNoA11yViolations(document.body);
  });

  it("toasts when the connection comes back", async () => {
    installFakeApi();
    renderPage(<Page />, { path: "/review" });
    act(() => networkFailureStore.set(2));
    act(() => networkFailureStore.set(0));
    expect(await screen.findByText("Back online.")).toBeTruthy();
  });
});

describe("FullPageError", () => {
  it.each<FullPageErrorKind>(["unauthenticated", "forbidden", "access_misconfigured"])(
    "has no axe violations for %s",
    async (kind) => {
      const { container } = render(<FullPageError kind={kind} />);
      await expectNoA11yViolations(container);
    },
  );
});
