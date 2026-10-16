import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { rowId } from "../../components/review/SenderGroupRow.tsx";
import { useRouteFocus } from "../../state/use-route-focus.ts";

export const FOCUS_EMPTY = "__empty__";
export const FOCUS_HEADING = "__heading__";

/** UI spec 4.14, 6.5: row, detail heading and empty-action focus handoffs for the Review page. */
export function useReviewFocus(phase: string, activeKey: string | null, listEmpty: boolean) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const emptyActionRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<string | null>(null);

  const focusRow = (key: string) => {
    const el = document.getElementById(rowId(key));
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  // Runs after every render so a target set by a handler lands once the new row exists.
  useEffect(() => {
    const target = pending.current;
    if (target === null) return;
    pending.current = null;
    if (target === FOCUS_EMPTY) emptyActionRef.current?.focus();
    else if (target === FOCUS_HEADING) headingRef.current?.focus();
    else focusRow(target);
  });

  const phaseRef = useRef(phase);
  useEffect(() => {
    const was = phaseRef.current;
    phaseRef.current = phase;
    if (was === "confirming" && phase === "idle") summaryButtonRef.current?.focus();
    else if (
      (was === "running" || was === "partial") &&
      phase === "idle" &&
      document.activeElement === document.body
    ) {
      if (emptyActionRef.current) emptyActionRef.current.focus();
      else if (activeKey) focusRow(activeKey);
    }
  }, [phase, activeKey]);

  const { key: locationKey } = useLocation();
  const rowFocused = useRef(locationKey === "default");
  useRouteFocus(titleRef, listEmpty);
  useEffect(() => {
    if (rowFocused.current || !activeKey) return;
    rowFocused.current = true;
    focusRow(activeKey);
  }, [activeKey]);

  const request = useCallback((target: string) => {
    pending.current = target;
  }, []);

  return {
    titleRef,
    headingRef,
    summaryButtonRef,
    emptyActionRef,
    request,
  };
}
