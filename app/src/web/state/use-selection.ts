import { useCallback, useMemo, useState } from "react";

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export function toggleKey(s: SelectionState, key: string): SelectionState {
  const next = new Set(s.selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { selected: next, anchor: key };
}

export function selectRange(s: SelectionState, key: string, order: readonly string[]): SelectionState {
  const to = order.indexOf(key);
  if (to < 0) return s;
  const from = s.anchor === null ? -1 : order.indexOf(s.anchor);
  const [start, end] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  const next = new Set(s.selected);
  for (const k of order.slice(start, end + 1)) next.add(k);
  return { selected: next, anchor: key };
}

export function selectAll(keys: readonly string[]): SelectionState {
  return { selected: new Set(keys), anchor: keys[keys.length - 1] ?? null };
}

export function removeKeys(s: SelectionState, keys: readonly string[]): SelectionState {
  const next = new Set(s.selected);
  for (const k of keys) next.delete(k);
  return { selected: next, anchor: s.anchor !== null && keys.includes(s.anchor) ? null : s.anchor };
}

export function useSelection() {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const toggle = useCallback((key: string) => setState((s) => toggleKey(s, key)), []);
  const range = useCallback(
    (key: string, order: readonly string[]) => setState((s) => selectRange(s, key, order)),
    [],
  );
  const all = useCallback((keys: readonly string[]) => setState(selectAll(keys)), []);
  const clear = useCallback(() => setState(EMPTY_SELECTION), []);
  const remove = useCallback((keys: readonly string[]) => setState((s) => removeKeys(s, keys)), []);
  const setAnchor = useCallback((key: string | null) => setState((s) => ({ ...s, anchor: key })), []);
  return useMemo(
    () => ({
      selected: state.selected,
      anchor: state.anchor,
      toggle,
      range,
      selectAll: all,
      clear,
      remove,
      setAnchor,
    }),
    [state, toggle, range, all, clear, remove, setAnchor],
  );
}
