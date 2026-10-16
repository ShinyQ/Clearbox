import { createBrowserRouter, Outlet, type RouteObject } from "react-router";
import { AppShell } from "./components/shell/AppShell.tsx";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { RouteErrorPage } from "./pages/FullPageError.tsx";
import { InsightsPage } from "./pages/InsightsPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OAuthReturn } from "./pages/OAuthReturn.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { RootLayout } from "./pages/RootLayout.tsx";
import { RootRedirect } from "./pages/RootRedirect.tsx";
import { RulesPage } from "./pages/RulesPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";

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
        { path: "/setup", element: <SetupPage /> },
        { path: "/settings/accounts", element: <OAuthReturn /> },
        {
          element: (
            <AppShell>
              <Outlet />
            </AppShell>
          ),
          children: [
            { path: "/review", element: <ReviewPage /> },
            { path: "/activity", element: <ActivityPage /> },
            { path: "/insights", element: <InsightsPage /> },
            { path: "/rules", element: <RulesPage /> },
            { path: "/accounts", element: <AccountsPage /> },
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
