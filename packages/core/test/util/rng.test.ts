import { describe, expect, it } from "vitest";
import { fnv1a32, mulberry32, seededShuffle } from "../../src/util/rng.ts";

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    expect(fnv1a32("\u00e9")).toBe(fnv1a32("\u00e9"));
    expect(fnv1a32("\u00e9")).not.toBe(fnv1a32("e"));
  });
});

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("differs between seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("seededShuffle", () => {
  const items = ["delete", "archive", "keep", "unsure"] as const;

  it("returns a permutation and leaves the input untouched", () => {
    const input = [...items];
    const out = seededShuffle(input, 7);
    expect([...out].sort()).toEqual([...items].sort());
    expect(input).toEqual([...items]);
  });

  it("is deterministic for a seed", () => {
    expect(seededShuffle(items, 123)).toEqual(seededShuffle(items, 123));
  });

  it("produces every ordering across many seeds (no stuck positions)", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 2000; seed++) orders.add(seededShuffle(items, seed).join(","));
    expect(orders.size).toBe(24);
  });

  it("handles empty and single-item arrays", () => {
    expect(seededShuffle([], 1)).toEqual([]);
    expect(seededShuffle(["x"], 1)).toEqual(["x"]);
  });
});
