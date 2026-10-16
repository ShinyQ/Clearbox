import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthReturn } from "../../src/web/pages/OAuthReturn.tsx";
import { RouteErrorPage } from "../../src/web/pages/FullPageError.tsx";
import { appRoutes } from "../../src/web/routes.tsx";
import { createTestQueryClient } from "./helpers/query.tsx";
import type { FakeApiState } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

afterEach(() => vi.restoreAllMocks());

function renderApp(path: string, mutate?: (s: FakeApiState) => void, strict = false) {
  const state = installFakeApi(mutate);
  const router = createMemoryRouter(appRoutes(), { initialEntries: [path] });
  const tree = (
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { state, router, user: userEvent.setup() };
}

// Real pages consume the query after arrival, so the forwarding is observed against a stub target.
function renderOAuthReturnOnly(path: string, strict = false) {
  const router = createMemoryRouter(
    [
      { path: "/settings/accounts", element: <OAuthReturn /> },
      { path: "/setup", element: <p>Setup stub</p> },
      { path: "/accounts", element: <p>Accounts stub</p> },
    ],
    { initialEntries: [path] },
  );
  const tree = <RouterProvider router={router} />;
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

describe("routes (UI spec 3.5)", () => {
  it("redirects / to Review when accounts exist and to Setup when none do", async () => {
    const a = renderApp("/");
    await waitFor(() => expect(a.router.state.location.pathname).toBe("/review"));
    cleanup();
    const b = renderApp("/", (s) => void (s.accounts = []));
    await waitFor(() => expect(b.router.state.location.pathname).toBe("/setup"));
  });

  it("returns from OAuth to the remembered page with the same query", async () => {
    window.sessionStorage.setItem("clearbox.oauthReturn", "/setup");
    const { router } = renderApp("/settings/accounts?error=scope_missing&provider=gmail");
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(await screen.findByText("Some permissions were not granted.")).toBeTruthy();
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBeNull();
  });

  it("keeps the remembered OAuth target and query under StrictMode", async () => {
    window.sessionStorage.setItem("clearbox.oauthReturn", "/setup");
    const router = renderOAuthReturnOnly("/settings/accounts?error=scope_missing&provider=gmail", true);
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe("/setup");
    expect(router.state.location.search).toBe("?error=scope_missing&provider=gmail");
  });

  it("forwards ?connected to the remembered page with the query preserved", async () => {
    window.sessionStorage.setItem("clearbox.oauthReturn", "/setup");
    const router = renderOAuthReturnOnly("/settings/accounts?connected=acc_1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(router.state.location.search).toBe("?connected=acc_1");
  });

  it("shows an accessible loading status while accounts load", async () => {
    renderApp("/");
    expect(screen.getByRole("status").textContent).toBe("Loading");
    await screen.findByRole("heading", { level: 1, name: "Review" });
  });

  it("defaults the OAuth return to Accounts", async () => {
    const { router } = renderApp("/settings/accounts?error=access_denied&provider=gmail");
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
  });

  it("shows the 404 page with a way back", async () => {
    const { router, user } = renderApp("/nope");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByText("This page does not exist in Clearbox.")).toBeTruthy();
    expect(document.title).toBe("Page not found · Clearbox");
    await user.click(screen.getByRole("button", { name: "Go to Review" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });

  it("navigates with G sequences and focuses the new page title", async () => {
    const { router, user } = renderApp("/review");
    await screen.findByRole("heading", { level: 1, name: "Review" });
    await user.keyboard("gi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/insights"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Insights" })),
    );
    await user.keyboard("gc");
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
  });

  it("registers the dev gallery in development", async () => {
    renderApp("/dev/components");
    expect(await screen.findByRole("heading", { level: 1, name: "Components" })).toBeTruthy();
  });

  it("renders the error boundary page for render errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("boom");
    }
    const router = createMemoryRouter([{ path: "/", element: <Boom />, errorElement: <RouteErrorPage /> }]);
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Something went wrong on this page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("keeps the root providers mounted when a page inside the shell fails to render", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("boom");
    }
    const routes = appRoutes();
    const shell = routes[0]?.children?.find((r) => r.children !== undefined);
    const insights = shell?.children?.find((r) => r.path === "/insights");
    if (!insights) throw new Error("insights route missing");
    insights.element = <Boom />;
    installFakeApi();
    const router = createMemoryRouter(routes, { initialEntries: ["/insights"] });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Something went wrong on this page" })).toBeTruthy();
    await userEvent.setup().keyboard("?");
    expect(await screen.findByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
