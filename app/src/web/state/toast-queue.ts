export type ToastKind = "success" | "info" | "error";

export interface ToastAction {
  label: "Undo" | "Try again" | "Reconnect" | "View";
  onAction: () => void;
  shortcut?: "mod+z" | undefined;
}

export interface ToastInput {
  kind: ToastKind;
  message: string;
  action?: ToastAction | undefined;
  durationMs?: number | undefined;
  dedupeKey?: string | undefined;
  /** "Undoing…" state: spinner, no buttons (decision W11). */
  busy?: boolean | undefined;
}

export interface ToastItem extends ToastInput {
  id: string;
  createdAt: number;
  leaving?: boolean | undefined;
}

export const MAX_TOASTS = 3;

export function defaultDuration(t: ToastInput): number | null {
  if (t.durationMs !== undefined) return t.durationMs;
  if (t.kind === "error") return null;
  return t.kind === "success" ? 8_000 : 5_000;
}

/** UI spec 6.8: dedupe in place; a 4th toast drops the oldest non-error, else the oldest error. */
export function addToast(list: readonly ToastItem[], item: ToastItem): ToastItem[] {
  if (item.dedupeKey) {
    const i = list.findIndex((t) => t.dedupeKey === item.dedupeKey);
    if (i >= 0) return list.map((t, j) => (j === i ? item : t));
  }
  const next = [...list, item];
  while (next.filter((t) => !t.leaving).length > MAX_TOASTS) {
    const older = next.slice(0, -1);
    const victim = older.findIndex((t) => !t.leaving && t.kind !== "error");
    next.splice(victim >= 0 ? victim : older.findIndex((t) => !t.leaving), 1);
  }
  return next;
}
