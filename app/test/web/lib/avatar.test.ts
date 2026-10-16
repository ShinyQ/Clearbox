import { describe, expect, it } from "vitest";
import { AVATAR_BG, avatarColorIndex, fnv1a32, monogram } from "../../../src/web/lib/avatar.ts";

describe("avatar", () => {
  it("hashes deterministically with FNV-1a 32", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  it("maps a domain to a stable palette index, case and space insensitive", () => {
    const i = avatarColorIndex("northwind.example");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(12);
    expect(avatarColorIndex(" Northwind.Example ")).toBe(i);
    expect(AVATAR_BG[i]).toBe(`bg-avatar-${i}`);
  });

  it("builds monograms from names, addresses and Unicode", () => {
    expect(monogram("Northwind Deals", "promo@northwind.example", "northwind.example")).toBe("N");
    expect(monogram(null, "digest@news.example", "news.example")).toBe("D");
    expect(monogram("  ", "", "contoso.example")).toBe("C");
    expect(monogram("Élodie", "e@x.example", "x.example")).toBe("É");
    expect(monogram("***", "", "")).toBe("?");
  });
});
