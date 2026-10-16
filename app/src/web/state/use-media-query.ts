import { useSyncExternalStore } from "react";

export const BP = { sm: "(min-width: 40rem)", lg: "(min-width: 64rem)", xl: "(min-width: 80rem)" } as const;
const REDUCED = "(prefers-reduced-motion: reduce)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const usePrefersReducedMotion = (): boolean => useMediaQuery(REDUCED);
export const prefersReducedMotion = (): boolean => window.matchMedia(REDUCED).matches;
