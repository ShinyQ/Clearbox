import { describe, expect, it } from "vitest";
import {
  applyOwnerAction,
  priorDelta,
  priorKeyForDomain,
  priorKeyForSender,
  selectPrior,
} from "../../src/priors/priors.ts";

describe("prior keys", () => {
  it("uses the address and @domain", () => {
    expect(priorKeyForSender("a@example.com")).toBe("a@example.com");
    expect(priorKeyForDomain("example.com")).toBe("@example.com");
  });
});

describe("selectPrior", () => {
  it("uses the sender prior when its n >= 3", () => {
    const prior = selectPrior(
      { deletes: 3, keeps: 0 },
      { deletes: 0, keeps: 10 },
      "a@example.com",
      "example.com",
    );
    expect(prior).toEqual({ source: "sender", key: "a@example.com", alpha: 4, beta: 1, n: 3, pDelete: 0.8 });
  });

  it("falls back to the domain prior when the sender has n < 3 (sender 2, domain 10)", () => {
    const prior = selectPrior(
      { deletes: 2, keeps: 0 },
      { deletes: 8, keeps: 2 },
      "a@example.com",
      "example.com",
    );
    expect(prior.source).toBe("domain");
    expect(prior.key).toBe("@example.com");
    expect(prior.n).toBe(10);
    expect(prior.pDelete).toBeCloseTo(9 / 12, 9);
  });

  it("uses the sender prior with n < 3 when there is no domain prior", () => {
    const prior = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com");
    expect(prior).toEqual({ source: "sender", key: "a@example.com", alpha: 3, beta: 1, n: 2, pDelete: 0.75 });
  });

  it("treats a domain row with zero counts as absent", () => {
    const prior = selectPrior(
      { deletes: 1, keeps: 0 },
      { deletes: 0, keeps: 0 },
      "a@example.com",
      "example.com",
    );
    expect(prior.source).toBe("sender");
  });

  it("uses the domain prior when only the domain is known", () => {
    expect(selectPrior(null, { deletes: 1, keeps: 1 }, "a@example.com", "example.com").source).toBe("domain");
  });

  it("returns none with alpha = beta = 1 when nothing is known", () => {
    expect(selectPrior(null, null, "a@example.com", "example.com")).toEqual({
      source: "none",
      key: null,
      alpha: 1,
      beta: 1,
      n: 0,
      pDelete: 0.5,
    });
  });
});

describe("priorDelta", () => {
  it("counts delete as deletes and archive/keep as keeps", () => {
    expect(priorDelta("delete", 1)).toEqual({ deletes: 1, keeps: 0 });
    expect(priorDelta("archive", 1)).toEqual({ deletes: 0, keeps: 1 });
    expect(priorDelta("keep", 1)).toEqual({ deletes: 0, keeps: 1 });
  });

  it("returns the inverse for undo", () => {
    expect(priorDelta("delete", -1)).toEqual({ deletes: -1, keeps: 0 });
    expect(priorDelta("keep", -1)).toEqual({ deletes: 0, keeps: -1 });
  });
});

describe("applyOwnerAction", () => {
  it("adds the delta to existing counts", () => {
    expect(applyOwnerAction({ deletes: 2, keeps: 1 }, "delete", 1)).toEqual({ deletes: 3, keeps: 1 });
    expect(applyOwnerAction(null, "archive", 1)).toEqual({ deletes: 0, keeps: 1 });
  });

  it("undo followed by redo restores the counts and never goes below zero", () => {
    const start = { deletes: 1, keeps: 0 };
    const undone = applyOwnerAction(start, "delete", -1);
    expect(undone).toEqual({ deletes: 0, keeps: 0 });
    expect(applyOwnerAction(undone, "delete", -1)).toEqual({ deletes: 0, keeps: 0 });
    expect(applyOwnerAction(undone, "delete", 1)).toEqual(start);
  });
});
