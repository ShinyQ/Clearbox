import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { prefetchGroupDetail } from "../../api/queries.ts";
import { plural } from "../../lib/format.ts";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";

/** Prefetch of the next group's detail and the debounced live-region announcements (UI spec 7.3). */
export function useReviewEffects(i: {
  keys: readonly string[];
  activeKey: string | null;
  selectedCount: number;
  newSuggestions: boolean;
}) {
  const { keys, activeKey, selectedCount, newSuggestions } = i;
  const qc = useQueryClient();
  const announce = useAnnounce();

  useEffect(() => {
    const index = activeKey ? keys.indexOf(activeKey) : -1;
    const next = keys[index + 1];
    if (next) void prefetchGroupDetail(qc, next);
  }, [activeKey, keys, qc]);

  useEffect(() => {
    if (selectedCount === 0) return;
    const t = setTimeout(() => announce(`${plural(selectedCount, "group", "groups")} selected`), 300);
    return () => clearTimeout(t);
  }, [selectedCount, announce]);

  useEffect(() => {
    if (newSuggestions) announce("New suggestions are ready. Refresh to see them.");
  }, [newSuggestions, announce]);
}

/** True after a Clean up run returns to idle, until the preview has emails again (UI spec 5.2.2 "Inbox cleared"). */
export function useJustCleaned(phase: string, previewCount: number): boolean {
  const [prevPhase, setPrevPhase] = useState(phase);
  const [justCleaned, setJustCleaned] = useState(false);
  if (prevPhase !== phase) {
    setPrevPhase(phase);
    if ((prevPhase === "running" || prevPhase === "partial" || prevPhase === "done") && phase === "idle")
      setJustCleaned(true);
  }
  if (justCleaned && previewCount > 0) setJustCleaned(false);
  return justCleaned;
}

/** UI spec 4.14: inline panel from 1280px, slide-over from 1024px, bottom sheet below. */
export function useDetailMode(): "inline" | "slideover" | "sheet" {
  const wide = useMediaQuery(BP.xl);
  const medium = useMediaQuery(BP.lg);
  return wide ? "inline" : medium ? "slideover" : "sheet";
}
