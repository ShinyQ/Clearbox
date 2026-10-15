import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./client.ts";

/** UI spec 6.7: one retry for queries (never for 4xx), none for mutations. */
export function createQueryClient(opts: { retryDelayMs?: number } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          failureCount < 1 && !(isApiError(error) && error.status >= 400 && error.status < 500),
        ...(opts.retryDelayMs !== undefined ? { retryDelay: opts.retryDelayMs } : {}),
        refetchOnReconnect: true,
        refetchIntervalInBackground: false,
        networkMode: "online",
      },
      mutations: { retry: 0, networkMode: "online" },
    },
  });
}
