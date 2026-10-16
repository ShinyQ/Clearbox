import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { isGroupSort, isTabKey, type GroupSort, type TabKey } from "../../lib/view-types.ts";

type ParamName = "account" | "tab" | "sort" | "group";
const DEFAULTS: Partial<Record<ParamName, string>> = { tab: "all", sort: "confidence_desc" };

export function useReviewParams() {
  const [params, setParams] = useSearchParams();
  const update = useCallback(
    (patch: Partial<Record<ParamName, string | null>>, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch) as [ParamName, string | null][]) {
            if (v === null || v === "" || DEFAULTS[k] === v) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      ),
    [setParams],
  );
  return useMemo(() => {
    const tab = params.get("tab");
    const sort = params.get("sort");
    return {
      accountId: params.get("account") ?? undefined,
      tab: (isTabKey(tab) ? tab : "all") as TabKey,
      sort: (isGroupSort(sort) ? sort : "confidence_desc") as GroupSort,
      groupKey: params.get("group"),
      update,
    };
  }, [params, update]);
}
