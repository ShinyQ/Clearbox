import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { GroupDetail, Page, QueueSummary, SenderGroup, SuggestionItem } from "../../../shared/api.ts";
import type { SuggestedAction } from "../../lib/view-types.ts";
import { prefersReducedMotion } from "../../state/use-media-query.ts";

type GroupPages = InfiniteData<Page<SenderGroup>>;
type DetailPages = InfiniteData<GroupDetail>;

/** Fade 200 ms then collapse 200 ms; instant with reduced motion (UI spec 4.8, 7.6, decision W15). */
export const rowExitDelayMs = (): number => (prefersReducedMotion() ? 0 : 400);

interface Position<T> {
  queryKey: QueryKey;
  page: number;
  index: number;
  value: T;
}

export type GroupPositions = Position<SenderGroup>[];

/** Where the group sits in every groups cache, taken before it is optimistically removed. */
export function captureGroupPositions(qc: QueryClient, key: string): GroupPositions {
  return qc.getQueriesData<GroupPages>({ queryKey: ["groups"] }).flatMap(([queryKey, data]) =>
    (data?.pages ?? []).flatMap((p, page) => {
      const index = p.items.findIndex((g) => g.key === key);
      const value = p.items[index];
      return value ? [{ queryKey, page, index, value }] : [];
    }),
  );
}

/** Puts back only this group, so concurrent actions on other groups keep their own result. */
export function restoreGroup(qc: QueryClient, positions: GroupPositions): void {
  for (const pos of positions)
    qc.setQueryData<GroupPages>(pos.queryKey, (old) => {
      if (!old || old.pages.length === 0) return old;
      if (old.pages.some((p) => p.items.some((g) => g.key === pos.value.key))) return old;
      const at = Math.min(pos.page, old.pages.length - 1);
      return {
        ...old,
        pages: old.pages.map((p, i) => {
          if (i !== at) return p;
          const items = [...p.items];
          items.splice(Math.min(pos.index, items.length), 0, pos.value);
          return { ...p, items };
        }),
      };
    });
}

export type ItemPositions = Position<SuggestionItem>[];

export function captureItemPositions(qc: QueryClient, key: string, id: number): ItemPositions {
  return qc.getQueriesData<DetailPages>({ queryKey: ["group", key] }).flatMap(([queryKey, data]) =>
    (data?.pages ?? []).flatMap((p, page) => {
      const index = p.items.items.findIndex((i) => i.id === id);
      const value = p.items.items[index];
      return value ? [{ queryKey, page, index, value }] : [];
    }),
  );
}

export function restoreItem(qc: QueryClient, positions: ItemPositions): void {
  for (const pos of positions)
    qc.setQueryData<DetailPages>(pos.queryKey, (old) => {
      if (!old || old.pages.length === 0) return old;
      if (old.pages.some((p) => p.items.items.some((i) => i.id === pos.value.id))) return old;
      const at = Math.min(pos.page, old.pages.length - 1);
      return {
        ...old,
        pages: old.pages.map((p, i) => {
          if (i !== at) return p;
          const items = [...p.items.items];
          items.splice(Math.min(pos.index, items.length), 0, pos.value);
          return { ...p, items: { ...p.items, items } };
        }),
      };
    });
}

const mapGroups = (qc: QueryClient, fn: (items: SenderGroup[]) => SenderGroup[]) =>
  qc.setQueriesData<GroupPages>({ queryKey: ["groups"] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
  );

export function removeGroupFromCache(qc: QueryClient, key: string): void {
  mapGroups(qc, (items) => items.filter((g) => g.key !== key));
}

export function bumpGroupCount(qc: QueryClient, key: string, delta: number): void {
  mapGroups(qc, (items) =>
    items.map((g) => (g.key === key ? { ...g, count: Math.max(0, g.count + delta) } : g)),
  );
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
