import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  removeKeys,
  selectAll,
  selectRange,
  toggleKey,
} from "../../../src/web/state/use-selection.ts";

const order = ["a", "b", "c", "d", "e"];

describe("selection model (UI spec 6.3)", () => {
  it("toggles and sets the anchor", () => {
    const s = toggleKey(EMPTY_SELECTION, "b");
    expect([...s.selected]).toEqual(["b"]);
    expect(s.anchor).toBe("b");
    expect([...toggleKey(s, "b").selected]).toEqual([]);
  });

  it("adds the inclusive range from the anchor in either direction", () => {
    const s = selectRange(toggleKey(EMPTY_SELECTION, "d"), "b", order);
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
    expect([...selectRange({ selected: new Set(), anchor: null }, "c", order).selected]).toEqual(["c"]);
  });

  it("selects all and removes executed keys", () => {
    const all = selectAll(order);
    expect(all.selected.size).toBe(5);
    expect([...removeKeys(all, ["a", "e"]).selected]).toEqual(["b", "c", "d"]);
  });
});
