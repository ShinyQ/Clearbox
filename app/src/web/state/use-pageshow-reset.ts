import { useEffect, useRef } from "react";

/** Runs `reset` when the browser restores the page from the back-forward cache (Back after an OAuth redirect). */
export function usePageshowReset(reset: () => void): void {
  const ref = useRef(reset);
  useEffect(() => {
    ref.current = reset;
  });
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) ref.current();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
}
