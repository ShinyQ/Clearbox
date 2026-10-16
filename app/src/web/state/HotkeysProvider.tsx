import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate } from "react-router";
import {
  G_HINT_MS,
  G_ROUTES,
  G_WINDOW_MS,
  isSingleKey,
  isTypingTarget,
  matchesCombo,
  normalizeKey,
  SCOPE_PRIORITY,
  SINGLE_KEYS_STORAGE,
  type Binding,
  type HotkeyScope,
} from "./hotkeys-core.ts";
import { useUndoStack } from "./UndoStackProvider.tsx";
import { usePlatform } from "./use-platform.ts";

interface Registration {
  scope: HotkeyScope;
  bindings: RefObject<Binding[]>;
}

interface Registry {
  register(scope: HotkeyScope, bindings: RefObject<Binding[]>): () => void;
}

export interface HotkeysControl {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
  gHint: boolean;
}

const RegistryContext = createContext<Registry | null>(null);
const ControlContext = createContext<HotkeysControl | null>(null);

/** Dialogs, menus, the mobile drawer and the detail sheet block single-key shortcuts (UI spec 6.2). */
const overlayOpen = () => document.querySelector("dialog[open], [role='menu'], [aria-modal='true']") !== null;

export function HotkeysProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const navigate = useNavigate();
  const { undoLatest } = useUndoStack();
  const regs = useRef(new Map<number, Registration>());
  const nextId = useRef(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [singleKeys, setSingleKeysState] = useState(
    () => window.localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off",
  );
  const [gHint, setGHint] = useState(false);
  const gPending = useRef(false);
  const gTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const singleRef = useRef(singleKeys);
  useEffect(() => {
    singleRef.current = singleKeys;
  }, [singleKeys]);

  const setSingleKeys = useCallback((on: boolean) => {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE, on ? "on" : "off");
    setSingleKeysState(on);
  }, []);

  const cancelG = useCallback(() => {
    gPending.current = false;
    for (const t of gTimers.current) clearTimeout(t);
    gTimers.current = [];
    setGHint(false);
  }, []);

  const registry = useMemo<Registry>(
    () => ({
      register(scope, bindings) {
        const id = nextId.current++;
        regs.current.set(id, { scope, bindings });
        return () => regs.current.delete(id);
      },
    }),
    [],
  );

  const globalBindings = useRef<Binding[]>([]);
  useLayoutEffect(() => {
    globalBindings.current = [
      { combo: "?", handler: () => setHelpOpen(true) },
      { combo: "mod+z", handler: () => void undoLatest() },
    ];
  });
  useEffect(() => registry.register("global", globalBindings), [registry]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const typing = isTypingTarget(e.target);
      const key = normalizeKey(e);
      if (gPending.current) {
        cancelG();
        const route = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? G_ROUTES[key] : undefined;
        if (route) {
          e.preventDefault();
          void navigate(route);
        }
        return;
      }
      if (typing && key === "escape" && e.target instanceof HTMLElement) e.target.blur();
      const blocked = overlayOpen();
      for (const scope of SCOPE_PRIORITY) {
        for (const reg of regs.current.values()) {
          if (reg.scope !== scope) continue;
          for (const b of reg.bindings.current) {
            if (!matchesCombo(e, b.combo, platform)) continue;
            if (isSingleKey(b.combo) && (!singleRef.current || blocked)) continue;
            if (typing && !b.allowInInputs && key !== "escape") continue;
            e.preventDefault();
            if (e.repeat && !b.repeat) return;
            b.handler(e);
            return;
          }
        }
      }
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (key === "g" && plain && !typing && !blocked && singleRef.current) {
        e.preventDefault();
        gPending.current = true;
        gTimers.current = [setTimeout(() => setGHint(true), G_HINT_MS), setTimeout(cancelG, G_WINDOW_MS)];
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancelG, navigate, platform]);

  const control = useMemo(
    () => ({ helpOpen, setHelpOpen, singleKeys, setSingleKeys, gHint }),
    [helpOpen, singleKeys, setSingleKeys, gHint],
  );
  return (
    <RegistryContext.Provider value={registry}>
      <ControlContext.Provider value={control}>{children}</ControlContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Registers bindings for a scope while mounted and `enabled`. The latest handlers are always used. */
export function useHotkeys(scope: HotkeyScope, bindings: Binding[], enabled = true): void {
  const registry = useContext(RegistryContext);
  const ref = useRef(bindings);
  useLayoutEffect(() => {
    ref.current = bindings;
  });
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register(scope, ref);
  }, [registry, scope, enabled]);
}

export function useHotkeysControl(): HotkeysControl {
  const v = useContext(ControlContext);
  if (!v) throw new Error("useHotkeysControl needs HotkeysProvider");
  return v;
}
