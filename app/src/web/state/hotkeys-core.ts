import type { Platform } from "../lib/view-types.ts";

export type HotkeyScope = "dialog" | "menu" | "confirm" | "slideover" | "review" | "rules" | "global";
export const SCOPE_PRIORITY: readonly HotkeyScope[] = [
  "dialog",
  "menu",
  "confirm",
  "slideover",
  "review",
  "rules",
  "global",
];

export interface Binding {
  combo: string;
  handler: (e: KeyboardEvent) => void;
  allowInInputs?: boolean;
  /** Auto-repeat (a held key) runs the handler again only when true; action keys act once per press. */
  repeat?: boolean;
}

export const G_ROUTES: Readonly<Record<string, string>> = {
  r: "/review",
  a: "/activity",
  i: "/insights",
  u: "/rules",
  c: "/accounts",
};
export const G_WINDOW_MS = 1_000;
export const G_HINT_MS = 400;
export const SINGLE_KEYS_STORAGE = "clearbox.singleKeys";

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  return { key: parts[parts.length - 1] ?? "", mod: parts.includes("mod"), shift: parts.includes("shift") };
}

export function normalizeKey(e: Pick<KeyboardEvent, "key">): string {
  const k = e.key.toLowerCase();
  return k === "esc" ? "escape" : k;
}

/** UI spec 6.2: case-insensitive letters, Alt never, no modifier beyond the listed one. */
export function matchesCombo(e: KeyboardEvent, combo: string, platform: Platform): boolean {
  if (e.altKey) return false;
  const c = parseCombo(combo);
  const mod = platform === "mac" ? e.metaKey : e.ctrlKey;
  const otherMod = platform === "mac" ? e.ctrlKey : e.metaKey;
  if (otherMod || c.mod !== mod) return false;
  const key = normalizeKey(e);
  if (c.key === "?") return key === "?";
  if (c.shift !== e.shiftKey) return false;
  return key === c.key;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Character-key shortcuts that the WCAG 2.1.4 toggle turns off (letters, digits, not "?"). */
export function isSingleKey(combo: string): boolean {
  const c = parseCombo(combo);
  return !c.mod && c.key.length === 1 && c.key !== "?";
}
