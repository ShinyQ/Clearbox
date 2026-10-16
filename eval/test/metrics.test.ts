import { describe, expect, it } from "vitest";
import {
  argmaxAction,
  confusionMatrix,
  deletePrecisionRecall,
  percentile,
  reliabilityTable,
  shuffleRobustness,
  thresholdSweep,
  wilsonLowerBound,
} from "../src/metrics.ts";

describe("deletePrecisionRecall", () => {
  it("counts delete as the positive class", () => {
    const r = deletePrecisionRecall([
      { predicted: "delete", label: "delete" },
      { predicted: "delete", label: "delete" },
      { predicted: "delete", label: "keep" },
      { predicted: "unsure", label: "delete" },
      { predicted: "keep", label: "keep" },
    ]);
    expect(r.truePositives).toBe(2);
    expect(r.falsePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.precision).toBeCloseTo(2 / 3, 9);
    expect(r.recall).toBeCloseTo(2 / 3, 9);
    expect(r.precisionLower95).toBeLessThan(2 / 3);
  });

  it("returns null precision when nothing is predicted delete", () => {
    const r = deletePrecisionRecall([{ predicted: "keep", label: "keep" }]);
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
    expect(r.precisionLower95).toBeNull();
  });
});

describe("wilsonLowerBound", () => {
  it("is below the point estimate and null for n = 0", () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(50, 50)).toBeCloseTo(0.9287, 3);
    expect(wilsonLowerBound(10, 20)).toBeCloseTo(0.2993, 3);
  });
});

describe("confusionMatrix", () => {
  it("counts suggestion by label", () => {
    const m = confusionMatrix([
      { predicted: "unsure", label: "keep" },
      { predicted: "archive", label: "archive" },
      { predicted: "unsure", label: "keep" },
    ]);
    expect(m.unsure.keep).toBe(2);
    expect(m.archive.archive).toBe(1);
    expect(m.delete.delete).toBe(0);
  });
});

describe("reliabilityTable", () => {
  it("bins probabilities and computes ECE and Brier", () => {
    const t = reliabilityTable([
      { p: 0.95, positive: true },
      { p: 1, positive: true },
      { p: 0.05, positive: false },
      { p: 0.15, positive: true },
    ]);
    expect(t.bins).toHaveLength(10);
    expect(t.bins[9]?.count).toBe(2);
    expect(t.bins[9]?.meanPredicted).toBeCloseTo(0.975, 9);
    expect(t.bins[9]?.observedRate).toBe(1);
    expect(t.bins[0]?.count).toBe(1);
    expect(t.bins[1]?.observedRate).toBe(1);
    expect(t.bins[5]?.meanPredicted).toBeNull();
    // ECE = 2/4*0.025 + 1/4*0.05 + 1/4*0.85
    expect(t.ece).toBeCloseTo(0.2375, 9);
    // Brier = (0.0025 + 0 + 0.0025 + 0.7225) / 4
    expect(t.brier).toBeCloseTo(0.181875, 9);
  });

  it("handles no points", () => {
    const t = reliabilityTable([]);
    expect(t.ece).toBeNull();
    expect(t.brier).toBeNull();
  });
});

describe("thresholdSweep", () => {
  it("applies tau and the delete margin like calibration", () => {
    const samples = [
      { pDelete: 0.95, margin: 0.9, label: "delete" as const },
      { pDelete: 0.85, margin: 0.75, label: "keep" as const },
      { pDelete: 0.9, margin: 0.1, label: "delete" as const },
      { pDelete: null, margin: null, label: "delete" as const },
    ];
    const [at80, at90] = thresholdSweep(samples, [0.8, 0.9], 0.2);
    expect(at80).toEqual({ tau: 0.8, support: 2, precision: 0.5, recall: 1 / 3 });
    expect(at90).toEqual({ tau: 0.9, support: 1, precision: 1, recall: 1 / 3 });
  });
});

describe("shuffleRobustness", () => {
  it("measures flips and probability drift", () => {
    const r = shuffleRobustness([
      { baseline: "delete", shuffled: "delete", baselineDelete: 0.9, shuffledDelete: 0.88 },
      { baseline: "archive", shuffled: "unsure", baselineDelete: 0.3, shuffledDelete: 0.4 },
    ]);
    expect(r.flips).toBe(1);
    expect(r.flipRate).toBe(0.5);
    expect(r.meanAbsDeltaDelete).toBeCloseTo(0.06, 9);
    expect(r.maxAbsDeltaDelete).toBeCloseTo(0.1, 9);
    expect(shuffleRobustness([]).flipRate).toBeNull();
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("argmaxAction", () => {
  it("prefers the safe order on ties", () => {
    expect(argmaxAction({ delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1 })).toBe("delete");
    expect(argmaxAction({ delete: 0.4, archive: 0.4, keep: 0.1, unsure: 0.1 })).toBe("archive");
    expect(argmaxAction({ delete: 0.25, archive: 0.25, keep: 0.25, unsure: 0.25 })).toBe("keep");
  });
});
