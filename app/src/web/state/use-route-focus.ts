import { useEffect, useRef, type RefObject } from "react";
import { useLocation } from "react-router";

/** UI spec 6.5: after a route change (not the first load), focus moves to the page h1. */
export function useRouteFocus(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const { key } = useLocation();
  const initial = useRef(key === "default");
  useEffect(() => {
    if (!enabled || initial.current) return;
    ref.current?.focus({ preventScroll: true });
  }, [ref, enabled]);
}
