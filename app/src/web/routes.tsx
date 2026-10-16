import { createBrowserRouter, Outlet, type RouteObject } from "react-router";
import { AppShell } from "./components/shell/AppShell.tsx";
import { RouteErrorPage } from "./pages/FullPageError.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OAuthReturn } from "./pages/OAuthReturn.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { RootLayout } from "./pages/RootLayout.tsx";
import { RootRedirect } from "./pages/RootRedirect.tsx";

/** UI spec 3.5. `import.meta.env.DEV` is replaced at build time, so production drops the gallery chunk. */
export function appRoutes(): RouteObject[] {
  const dev: RouteObject[] = import.meta.env.DEV
    ? [
        {
          path: "/dev/components",
          lazy: async () => ({ Component: (await import("./pages/ComponentGallery.tsx")).ComponentGallery }),
        },
      ]
    : [];
  return [
    {
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        { path: "/", element: <RootRedirect /> },
        {
          path: "/setup",
          lazy: async () => ({ Component: (await import("./pages/SetupPage.tsx")).SetupPage }),
        },
        { path: "/settings/accounts", element: <OAuthReturn /> },
        {
          element: (
            <AppShell>
              <Outlet />
            </AppShell>
          ),
          // Keeps RootLayout's providers (and a running Clean up) mounted when a page fails to render.
          errorElement: <RouteErrorPage />,
          children: [
            { path: "/review", element: <ReviewPage /> },
            {
              path: "/activity",
              lazy: async () => ({ Component: (await import("./pages/ActivityPage.tsx")).ActivityPage }),
            },
            {
              path: "/insights",
              lazy: async () => ({ Component: (await import("./pages/InsightsPage.tsx")).InsightsPage }),
            },
            {
              path: "/rules",
              lazy: async () => ({ Component: (await import("./pages/RulesPage.tsx")).RulesPage }),
            },
            {
              path: "/accounts",
              lazy: async () => ({ Component: (await import("./pages/AccountsPage.tsx")).AccountsPage }),
            },
            ...dev,
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter() {
  return createBrowserRouter(appRoutes());
}
