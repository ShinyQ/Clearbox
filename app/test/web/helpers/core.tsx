import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ToastRegion } from "../../../src/web/components/ui/Toast.tsx";
import { LiveAnnouncerProvider } from "../../../src/web/state/LiveAnnouncer.tsx";
import { ToastProvider } from "../../../src/web/state/ToastProvider.tsx";
import { UndoStackProvider } from "../../../src/web/state/UndoStackProvider.tsx";
import { createTestQueryClient } from "./query.tsx";

export function CoreProviders({ children }: { children: ReactNode }) {
  return (
    <LiveAnnouncerProvider>
      <ToastProvider>
        <UndoStackProvider>
          {children}
          <ToastRegion raised={false} />
        </UndoStackProvider>
      </ToastProvider>
    </LiveAnnouncerProvider>
  );
}

export type CoreRender = RenderResult & {
  client: QueryClient;
  router: ReturnType<typeof createMemoryRouter>;
  user: ReturnType<typeof userEvent.setup>;
};

/** Renders `ui` inside the cross-page providers, a memory router and a fresh QueryClient. */
export function renderWithCore(
  ui: ReactNode,
  opts: { client?: QueryClient; path?: string } = {},
): CoreRender {
  const client = opts.client ?? createTestQueryClient();
  const router = createMemoryRouter([{ path: "*", element: <CoreProviders>{ui}</CoreProviders> }], {
    initialEntries: [opts.path ?? "/review"],
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, client, router, user: userEvent.setup() };
}

export function announcements(): string {
  return document.querySelector("[data-live-announcer]")?.textContent ?? "";
}
