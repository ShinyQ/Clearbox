import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { GroupDetail, Page, QueueSummary, SenderGroup } from "../../../shared/api.ts";
import type { SuggestedAction } from "../../lib/view-types.ts";
import { prefersReducedMotion } from "../../state/use-media-query.ts";

type GroupPages = InfiniteData<Page<SenderGroup>>;
type DetailPages = InfiniteData<GroupDetail>;
export type Snapshot = [QueryKey, unknown][];

/** Fade 200 ms then collapse 200 ms; instant with reduced motion (UI spec 4.8, 7.6, decision W15). */
export const rowExitDelayMs = (): number => (prefersReducedMotion() ? 0 : 400);

export function takeSnapshot(qc: QueryClient, extra: QueryKey[] = []): Snapshot {
  return [
    ...qc.getQueriesData({ queryKey: ["groups"] }),
    ...qc.getQueriesData({ queryKey: ["queue", "summary"] }),
    ...extra.flatMap((key) => qc.getQueriesData({ queryKey: key })),
  ];
}

export function restoreSnapshot(qc: QueryClient, snap: Snapshot): void {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

const mapGroups = (qc: QueryClient, fn: (items: SenderGroup[]) => SenderGroup[]) =>
  qc.setQueriesData<GroupPages>({ queryKey: ["groups"] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
  );

export function removeGroupFromCache(qc: QueryClient, key: string): void {
  mapGroups(qc, (items) => items.filter((g) => g.key !== key));
}

export function patchGroupCount(qc: QueryClient, key: string, count: number): void {
  mapGroups(qc, (items) => items.map((g) => (g.key === key ? { ...g, count } : g)));
}

export function groupsInCache(qc: QueryClient): SenderGroup[] {
  return qc
    .getQueriesData<GroupPages>({ queryKey: ["groups"] })
    .flatMap(([, d]) => d?.pages.flatMap((p) => p.items) ?? []);
}

/** Optimistic summary counts for every summary cache that includes this account. */
export function adjustSummary(
  qc: QueryClient,
  accountId: string,
  action: SuggestedAction,
  dEmails: number,
  dGroups: number,
): void {
  qc.setQueriesData<QueueSummary>(
    {
      queryKey: ["queue", "summary"],
      predicate: (q) => {
        const scope = q.queryKey[2] as { accountId: string | null } | undefined;
        return !scope || scope.accountId === null || scope.accountId === accountId;
      },
    },
    (old) =>
      old && {
        ...old,
        pending: {
          ...old.pending,
          [action]: Math.max(0, old.pending[action] + dEmails),
          total: Math.max(0, old.pending.total + dEmails),
        },
        groups: Math.max(0, old.groups + dGroups),
        groupsByAction: {
          ...old.groupsByAction,
          [action]: Math.max(0, old.groupsByAction[action] + dGroups),
        },
      },
  );
}

export function removeItemFromDetail(qc: QueryClient, key: string, id: number): void {
  qc.setQueriesData<DetailPages>({ queryKey: ["group", key] }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: { ...p.items, items: p.items.items.filter((i) => i.id !== id) },
          })),
        }
      : old,
  );
}
