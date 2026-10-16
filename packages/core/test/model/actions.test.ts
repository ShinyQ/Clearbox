import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_RANK,
  SUGGESTED_ACTIONS,
  isAllowedByCeiling,
  minCeiling,
  type Ceiling,
  type SuggestedAction,
} from "../../src/model/actions.ts";

describe("ACTION_RANK", () => {
  it("orders keep < archive < delete", () => {
    expect(ACTION_RANK.keep).toBeLessThan(ACTION_RANK.archive);
    expect(ACTION_RANK.archive).toBeLessThan(ACTION_RANK.delete);
    expect(ACTION_KINDS).toEqual(["delete", "archive", "keep"]);
    expect(SUGGESTED_ACTIONS).toEqual(["delete", "archive", "keep", "unsure"]);
  });
});

describe("isAllowedByCeiling", () => {
  const cases: [SuggestedAction, Ceiling, boolean][] = [
    ["delete", "delete", true],
    ["archive", "delete", true],
    ["keep", "delete", true],
    ["unsure", "delete", true],
    ["delete", "archive", false],
    ["archive", "archive", true],
    ["keep", "archive", true],
    ["unsure", "archive", true],
    ["delete", "keep", false],
    ["archive", "keep", false],
    ["keep", "keep", true],
    ["unsure", "keep", true],
  ];
  it.each(cases)("%s under ceiling %s -> %s", (action, ceiling, expected) => {
    expect(isAllowedByCeiling(action, ceiling)).toBe(expected);
  });
});

describe("minCeiling", () => {
  it("returns the lower-ranked ceiling", () => {
    expect(minCeiling("delete", "archive")).toBe("archive");
    expect(minCeiling("archive", "delete")).toBe("archive");
    expect(minCeiling("keep", "archive")).toBe("keep");
    expect(minCeiling("delete", "delete")).toBe("delete");
  });
});
