import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createQueryClient } from "../../../src/web/api/query-client.ts";

export function createTestQueryClient(): QueryClient {
  return createQueryClient({ retryDelayMs: 0 });
}

export function queryWrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
