import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(text: string) => void>(() => undefined);

/** One polite live region for the whole app (UI spec 4.33); clears after 1 s so repeats are re-read. */
export function LiveAnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(""), 1_000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div data-live-announcer aria-live="polite" aria-atomic="true" className="sr-only">
        {text}
      </div>
    </AnnounceContext.Provider>
  );
}

export const useAnnounce = (): ((text: string) => void) => useContext(AnnounceContext);
