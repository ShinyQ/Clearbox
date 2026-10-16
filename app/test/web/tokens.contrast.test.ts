/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest replaces CSS imports (including ?raw) with an empty string by default.
// The web suite always runs from app/ (pnpm --filter @clearbox/app exec vitest ...).
const css = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");

function readTokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of css.matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    // Prettier lowercases CSS hex colors, so normalize before comparing.
    if (m[1] && m[2]) map.set(m[1], m[2].toUpperCase());
  }
  return map;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const AVATARS = Array.from({ length: 12 }, (_, i) => ["white", `avatar-${i}`] as const);

// UI spec 7.2, text pairs (4.5:1).
const TEXT_PAIRS: (readonly [string, string])[] = [
  ["ink", "surface"],
  ["ink", "canvas"],
  ["ink", "surface-sunk"],
  ["ink", "surface-selected"],
  ["ink-2", "surface"],
  ["ink-2", "surface-sunk"],
  ["ink-2", "surface-selected"],
  ["ink-3", "surface"],
  ["ink-3", "canvas"],
  ["ink-3", "surface-raised"],
  ["ink-3", "surface-hover"],
  ["ink-3", "surface-sunk"],
  ["ink-3", "surface-selected"],
  ["on-inverse", "inverse"],
  ["on-inverse-2", "inverse"],
  ["on-inverse-3", "inverse"],
  ["white", "trash"],
  ["white", "trash-hover"],
  ["trash-ink", "trash-soft"],
  ["archive-ink", "archive-soft"],
  ["keep-ink", "keep-soft"],
  ["check-ink", "check-soft"],
  ["check-ink-strong", "check-soft"],
  ["trash-ink", "surface"],
  ["band-very-sure-ink", "surface"],
  ["band-very-sure-ink", "surface-selected"],
  ["band-sure-ink", "surface"],
  ["band-sure-ink", "surface-selected"],
  ["band-likely-ink", "surface"],
  ["band-likely-ink", "surface-selected"],
  ["band-unsure-ink", "surface"],
  ["band-unsure-ink", "surface-selected"],
  ["band-unsure-ink", "surface-sunk"],
  ["accent", "surface"],
  ["accent", "accent-soft"],
  ["accent-hover", "surface"],
  ["ink", "neutral-fill"],
  ["white", "provider-gmail"],
  ["white", "provider-outlook"],
  ["white", "provider-off"],
  ...AVATARS,
];

// UI spec 7.2, UI component and graphic pairs (3:1). Exempt pairs are excluded on purpose.
const UI_PAIRS: (readonly [string, string])[] = [
  ["focus", "surface"],
  ["focus", "surface-selected"],
  ["focus", "surface-sunk"],
  ["white", "inverse"],
  ["line-control", "surface"],
  ["line-control", "surface-selected"],
  ["line-control", "surface-sunk"],
  ["white", "line-control"],
  ["tick", "track"],
  ["tick", "surface-selected"],
  ["status-ok", "surface-sunk"],
  ["status-sync", "surface-sunk"],
  ["status-warn", "surface-sunk"],
  ["status-error", "surface-sunk"],
  ["status-off", "surface-sunk"],
  ["accent-bar", "surface"],
  ["accent", "surface"],
  ["trash", "surface"],
  ["archive", "surface"],
  ["band-very-sure", "track"],
];

describe("design tokens", () => {
  const tokens = readTokens();
  const hex = (name: string): string => {
    const value = tokens.get(name);
    if (!value) throw new Error(`missing token --color-${name}`);
    return value;
  };

  it.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)("graphic %s on %s is at least 3:1", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the owner-binding band fills exactly", () => {
    expect([hex("band-very-sure"), hex("band-sure"), hex("band-likely"), hex("band-unsure")]).toEqual([
      "#1F9D55",
      "#6CC08B",
      "#E0A030",
      "#E5762E",
    ]);
  });

  it("clears the default Tailwind palette and does not import dark mode", () => {
    expect(css).toContain("--color-*: initial;");
    expect(css).not.toContain("styles.dark.css");
  });
});
