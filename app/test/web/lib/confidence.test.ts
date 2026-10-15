import { describe, expect, it } from "vitest";
import {
  bandFor,
  inCleanup,
  membershipLine,
  scaleBands,
  toPercent,
} from "../../../src/web/lib/confidence.ts";

describe("bandFor", () => {
  it.each([0.8, 0.86, 0.95, 0.99])("uses the API tau %s for the Sure and Likely boundary", (tau) => {
    expect(bandFor(tau, tau, "delete")).toBe(tau >= 0.95 ? "very_sure" : "sure");
    expect(bandFor(tau - 0.0001, tau, "delete")).toBe("likely");
    expect(bandFor(0.7, tau, "archive")).toBe("likely");
    expect(bandFor(0.6999, tau, "archive")).toBe("unsure");
    expect(bandFor(0.95, tau, "keep")).toBe(tau > 0.95 ? "likely" : "very_sure");
  });

  it("always calls Check verdicts unsure", () => {
    expect(bandFor(0.99, 0.86, "unsure")).toBe("unsure");
  });
});

describe("toPercent", () => {
  it.each([
    [0.29, 29],
    [0.949, 94],
    [0.86, 86],
    [0.85, 85],
    [1, 100],
  ])("floors %s to %s", (value, expected) => {
    expect(toPercent(value)).toBe(expected);
  });
});

describe("inCleanup", () => {
  it("includes only Trash and Archive at Sure or Very sure", () => {
    expect(inCleanup("delete", "sure")).toBe(true);
    expect(inCleanup("archive", "very_sure")).toBe(true);
    expect(inCleanup("delete", "likely")).toBe(false);
    expect(inCleanup("keep", "very_sure")).toBe(false);
    expect(inCleanup("unsure", "unsure")).toBe(false);
  });
});

describe("scaleBands", () => {
  it("computes ranges from tau", () => {
    expect(scaleBands(0.86).map((b) => `${b.label}|${b.range}|${b.membership}`)).toEqual([
      "Very sure|95 to 100%|In Clean up",
      "Sure|86 to 94%|In Clean up",
      "Likely|70 to 85%|Left for you",
      "Unsure|Below 70%|Left for you",
    ]);
  });

  it("explains an empty Sure band above 95%", () => {
    const sure = scaleBands(0.96)[1];
    expect([sure?.range, sure?.membership]).toEqual(["None right now", "Threshold is above 95%"]);
  });
});

describe("membershipLine", () => {
  it("describes each case with the API tau", () => {
    expect(membershipLine("delete", { min: 0.91, max: 0.99 }, 0.86, 248)).toBe("All 248 are in Clean up.");
    expect(membershipLine("delete", { min: 0.91, max: 0.99 }, 0.86, 1)).toBe("The 1 email is in Clean up.");
    expect(membershipLine("delete", { min: 0.8, max: 0.9 }, 0.86, 3)).toBe(
      "Emails below 86% stay here for you after Clean up.",
    );
    expect(membershipLine("archive", { min: 0.74, max: 0.84 }, 0.86, 4)).toBe(
      "Below 86%, so Clean up leaves this group for you.",
    );
    expect(membershipLine("keep", { min: 0.9, max: 0.9 }, 0.86, 2)).toBe(
      "Keep suggestions are not part of Clean up.",
    );
    expect(membershipLine("unsure", { min: 0.4, max: 0.5 }, 0.86, 5)).toBe(
      "Clearbox needs your call on this group.",
    );
  });
});
