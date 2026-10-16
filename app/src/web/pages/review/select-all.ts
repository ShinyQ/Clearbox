import { flattenGroups, type useGroups } from "../../api/queries.ts";

export const SELECT_ALL_CAP = 1000;
/** The groups query pages by 50, so the cap needs at most 20 requests; the loop never exceeds this. */
const MAX_PAGE_FETCHES = 20;

type GroupsQuery = ReturnType<typeof useGroups>;
type PageResult = Pick<GroupsQuery, "data" | "hasNextPage" | "isError">;

export interface PagedGroups extends Pick<GroupsQuery, "data" | "hasNextPage"> {
  fetchNextPage: () => Promise<PageResult>;
}

/**
 * Loads pages until the cap. TanStack resolves (not rejects) a failed page with the data unchanged and
 * hasNextPage still true, so a failed fetch must stop the loop. Returns null when a page failed.
 */
export async function loadKeysForSelectAll(q: PagedGroups): Promise<string[] | null> {
  let data = q.data;
  let more = q.hasNextPage;
  for (let n = 0; more && n < MAX_PAGE_FETCHES && flattenGroups(data).length < SELECT_ALL_CAP; n += 1) {
    const r = await q.fetchNextPage();
    if (r.isError) return null;
    data = r.data;
    more = r.hasNextPage;
  }
  return flattenGroups(data)
    .slice(0, SELECT_ALL_CAP)
    .map((g) => g.key);
}
