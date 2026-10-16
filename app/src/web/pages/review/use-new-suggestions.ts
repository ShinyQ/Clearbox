import { useCallback, useState } from "react";
import type { QueueSummary } from "../../../shared/api.ts";

interface Snap {
  total: number;
  groups: number;
  at: number;
}

/** UI spec 6.6: snapshot the summary when the list loads; own changes move the snapshot by the same deltas. */
export function useNewSuggestions(summary: QueueSummary | undefined, groupsUpdatedAt: number) {
  const [snap, setSnap] = useState<Snap | null>(null);
  if (summary && groupsUpdatedAt > 0 && (snap === null || snap.at !== groupsUpdatedAt)) {
    setSnap({ total: summary.pending.total, groups: summary.groups, at: groupsUpdatedAt });
  }
  const applyDelta = useCallback((dEmails: number, dGroups: number) => {
    setSnap((s) => (s ? { ...s, total: s.total + dEmails, groups: s.groups + dGroups } : s));
  }, []);
  const show =
    !!summary &&
    !!snap &&
    snap.at === groupsUpdatedAt &&
    (summary.pending.total !== snap.total || summary.groups !== snap.groups);
  return { show, applyDelta };
}
