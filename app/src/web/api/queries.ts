import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { AccountView, ActionBatchView, Page, SenderGroup } from "../../shared/api.ts";
import { deriveAccountUiStatus } from "../lib/account-status.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";
import { api } from "./endpoints.ts";
import { qk } from "./keys.ts";

const MIN = 60_000;

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 5 * MIN, refetchOnWindowFocus: true });
}

export function accountsInterval(
  accounts: readonly AccountView[] | undefined,
  fast: boolean,
  now: number,
): number {
  if (fast) return 15_000;
  const busy = (accounts ?? []).some((a) => {
    const status = deriveAccountUiStatus(a, now);
    return status === "catching_up" || status === "waiting" || a.sync.awaitingModelCount > 0;
  });
  return busy ? 15_000 : 60_000;
}

/** `fast` is set while a scan runs or the Setup page is open. */
export function useAccounts(opts: { fast?: boolean } = {}) {
  const fast = opts.fast ?? false;
  return useQuery({
    queryKey: qk.accounts,
    queryFn: api.accounts,
    staleTime: 10_000,
    refetchInterval: (q) => accountsInterval(q.state.data?.accounts, fast, Date.now()),
    refetchOnWindowFocus: true,
  });
}

export function useQueueSummary(accountId?: string) {
  return useQuery({
    queryKey: qk.summary(accountId),
    queryFn: () => api.summary(accountId),
    staleTime: 0,
    refetchInterval: MIN,
    refetchOnWindowFocus: true,
  });
}

/** Polls only while the Clean up machine is idle; Clean up always fetches a fresh preview itself. */
export function useCleanupPreview(accountId: string | undefined, polling: boolean) {
  return useQuery({
    queryKey: qk.preview(accountId),
    queryFn: () => api.cleanupPreview({ actions: "delete,archive", accountId }),
    staleTime: 0,
    refetchInterval: polling ? MIN : false,
    refetchOnWindowFocus: polling,
  });
}

export interface GroupFilter {
  accountId?: string | undefined;
  action?: Verdict | undefined;
  sort: GroupSort;
}

export function groupsOptions(f: GroupFilter) {
  return infiniteQueryOptions({
    queryKey: qk.groups(f),
    queryFn: ({ pageParam }) => api.groups({ ...f, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p: Page<SenderGroup>) => p.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGroups(f: GroupFilter) {
  return useInfiniteQuery(groupsOptions(f));
}

export function flattenGroups(data: InfiniteData<Page<SenderGroup>> | undefined): SenderGroup[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

export function groupDetailOptions(key: string) {
  return infiniteQueryOptions({
    queryKey: qk.group(key),
    queryFn: ({ pageParam }) => api.groupDetail(key, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (d) => d.items.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGroupDetail(key: string | null) {
  return useInfiniteQuery({ ...groupDetailOptions(key ?? ""), enabled: key !== null });
}

export function prefetchGroupDetail(qc: QueryClient, key: string): Promise<void> {
  return qc.prefetchInfiniteQuery(groupDetailOptions(key));
}

/** Batches are kept 7 days; all pages are loaded (at most 10) so Activity can join them. */
export function useBatches(active: boolean) {
  return useQuery({
    queryKey: qk.batches,
    queryFn: async () => {
      const all: ActionBatchView[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await api.batches({ limit: 100, cursor });
        all.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return all;
    },
    staleTime: 30_000,
    refetchInterval: active ? MIN : false,
    refetchOnWindowFocus: true,
  });
}

export function useActivity(accountId?: string) {
  return useInfiniteQuery({
    queryKey: qk.activity(accountId),
    queryFn: ({ pageParam }) => api.activity({ accountId, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useInsights() {
  return useQuery({
    queryKey: qk.insights,
    queryFn: api.insights,
    staleTime: MIN,
    refetchInterval: 5 * MIN,
    refetchOnWindowFocus: true,
  });
}

export function usePolicy() {
  return useQuery({
    queryKey: qk.policy,
    queryFn: api.policy,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Contracts 12.10: one-click sender rules offered from consistent decisions. */
export function useRuleSuggestions() {
  return useQuery({
    queryKey: qk.ruleSuggestions,
    queryFn: api.ruleSuggestions,
    staleTime: MIN,
    refetchOnWindowFocus: true,
  });
}
