import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { networkFailureStore } from "../../../../src/web/api/client.ts";
import { AppBanners } from "../../../../src/web/components/shell/AppBanners.tsx";
import { DOCS_BASE_URL } from "../../../../src/web/lib/links.ts";
import { renderPage } from "../../helpers/render.tsx";
import { iso, T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

afterEach(() => networkFailureStore.set(0));

describe("AppBanners", () => {
  it("renders the offline banner once two network failures happen", async () => {
    installFakeApi();
    renderPage(<AppBanners page="review" />, { path: "/review", shell: false });
    expect(screen.queryByText("You're offline.")).toBeNull();
    act(() => networkFailureStore.set(2));
    expect(await screen.findByText("You're offline.")).toBeTruthy();
  });

  it("links the setup guide to the docs folder", async () => {
    installFakeApi((s) => {
      s.me.issues = [{ code: "google_client_invalid", since: iso(T0), accountId: null }];
    });
    renderPage(<AppBanners page="review" />, { path: "/review", shell: false });
    await screen.findByText("Google sign-in is misconfigured.");
    const link = screen.getByRole("link", { name: "Open setup guide" });
    expect(link.getAttribute("href")).toBe(`${DOCS_BASE_URL}setup-google.md`);
  });

  it("persists a dismissal in sessionStorage and hides the banner", async () => {
    installFakeApi((s) => {
      s.me.issues = [{ code: "storage_near_limit", since: iso(T0), accountId: null }];
    });
    const { user } = renderPage(<AppBanners page="review" />, { path: "/review", shell: false });
    await screen.findByText("Storage is almost full.");
    await user.click(screen.getByRole("button", { name: "Dismiss: Storage is almost full." }));
    expect(screen.queryByText("Storage is almost full.")).toBeNull();
    expect(window.sessionStorage.getItem("clearbox.banner.storage")).toBe("1");
  });

  it("keeps a dismissed extra banner hidden", async () => {
    installFakeApi();
    const extra = [{ id: "note", tone: "info" as const, title: "Heads up.", dismissible: true }];
    const { user } = renderPage(<AppBanners page="review" extra={extra} />, {
      path: "/review",
      shell: false,
    });
    await user.click(await screen.findByRole("button", { name: "Dismiss: Heads up." }));
    expect(screen.queryByText("Heads up.")).toBeNull();
  });
});
