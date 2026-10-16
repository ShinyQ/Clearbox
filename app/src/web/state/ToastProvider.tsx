import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { addToast, type ToastInput, type ToastItem } from "./toast-queue.ts";
import { prefersReducedMotion } from "./use-media-query.ts";

export interface ToastApi {
  show(t: ToastInput): string;
  update(id: string, patch: Partial<ToastInput>): void;
  dismiss(id: string): void;
}

const ApiContext = createContext<ToastApi | null>(null);
const ListContext = createContext<ToastItem[]>([]);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const api = useMemo<ToastApi>(
    () => ({
      show(input) {
        const id = input.dedupeKey ? `d:${input.dedupeKey}` : `t${++counter.current}`;
        setToasts((list) => addToast(list, { ...input, id, createdAt: Date.now() }));
        return id;
      },
      update(id, patch) {
        setToasts((list) => list.map((t) => (t.id === id ? { ...t, ...patch, createdAt: Date.now() } : t)));
      },
      dismiss(id) {
        setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        setTimeout(
          () => setToasts((list) => list.filter((t) => t.id !== id || !t.leaving)),
          prefersReducedMotion() ? 0 : 200,
        );
      },
    }),
    [],
  );
  return (
    <ApiContext.Provider value={api}>
      <ListContext.Provider value={toasts}>{children}</ListContext.Provider>
    </ApiContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useToast needs ToastProvider");
  return api;
}

export const useToastList = (): ToastItem[] => useContext(ListContext);
