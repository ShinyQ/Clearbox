import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { AppShell } from "../../../src/web/components/shell/AppShell.tsx";
import { RootLayout } from "../../../src/web/pages/RootLayout.tsx";
import { createTestQueryClient } from "./query.tsx";

export interface RenderPageOptions {
  path: string;
  route?: string;
  shell?: boolean;
  client?: QueryClient;
}

/** Renders one page inside RootLayout (and AppShell unless shell is false) on a memory router. */
export type RenderedPage = RenderResult & {
  router: ReturnType<typeof createMemoryRouter>;
  client: QueryClient;
  user: UserEvent;
};

export function renderPage(element: ReactNode, opts: RenderPageOptions): RenderedPage {
  const client = opts.client ?? createTestQueryClient();
  const route = opts.route ?? opts.path.split(/[?#]/)[0] ?? "/";
  const pageRoutes = [
    { path: route, element },
    { path: "*", element: <h1>Elsewhere</h1> },
  ];
  const router = createMemoryRouter(
    [
      {
        element: <RootLayout />,
        children:
          opts.shell === false
            ? pageRoutes
            : [
                {
                  element: (
                    <AppShell>
                      <Outlet />
                    </AppShell>
                  ),
                  children: pageRoutes,
                },
              ],
      },
    ],
    { initialEntries: [opts.path] },
  );
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, client, user: userEvent.setup() };
}
