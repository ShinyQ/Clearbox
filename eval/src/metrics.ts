import type { ActionKind, SuggestedAction } from "@clearbox/core";

export interface LabeledPrediction {
  predicted: SuggestedAction;
  label: ActionKind;
}

export interface PrecisionRecall {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when nothing was predicted as delete. */
  precision: number | null;
  /** null when nothing is labeled delete. */
  recall: number | null;
  /** Wilson 95% lower bound of precision; null when precision is null. */
  precisionLower95: number | null;
}

export function wilsonLowerBound(successes: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / (1 + z2 / n));
}

export function deletePrecisionRecall(rows: readonly LabeledPrediction[]): PrecisionRecall {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    const predictedDelete = r.predicted === "delete";
    const labeledDelete = r.label === "delete";
    if (predictedDelete && labeledDelete) tp++;
    else if (predictedDelete) fp++;
    else if (labeledDelete) fn++;
  }
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    precisionLower95: wilsonLowerBound(tp, tp + fp),
  };
}

export const PREDICTED_ORDER = ["delete", "archive", "keep", "unsure"] as const;
export const LABEL_ORDER = ["delete", "archive", "keep"] as const;
export type ConfusionMatrix = Record<SuggestedAction, Record<ActionKind, number>>;

export function confusionMatrix(rows: readonly LabeledPrediction[]): ConfusionMatrix {
  const empty = (): Record<ActionKind, number> => ({ delete: 0, archive: 0, keep: 0 });
  const m: ConfusionMatrix = { delete: empty(), archive: empty(), keep: empty(), unsure: empty() };
  for (const r of rows) m[r.predicted][r.label]++;
  return m;
}

export interface ProbabilityPoint {
  /** Predicted probability that the owner deletes, in [0, 1]. */
  p: number;
  positive: boolean;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface ReliabilityTable {
  bins: ReliabilityBin[];
  /** Expected calibration error: sum over bins of count/N * |meanPredicted - observedRate|. */
  ece: number | null;
  /** Mean squared error of p against the 0/1 outcome. */
  brier: number | null;
}

/** Equal-width bins on [0, 1]; p = 1 falls in the last bin. */
export function reliabilityTable(points: readonly ProbabilityPoint[], binCount = 10): ReliabilityTable {
  const sums = Array.from({ length: binCount }, () => ({ count: 0, p: 0, positives: 0 }));
  let brier = 0;
  for (const pt of points) {
    const p = Math.min(1, Math.max(0, pt.p));
    const index = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = sums[index];
    if (bin === undefined) continue;
    bin.count++;
    bin.p += p;
    if (pt.positive) bin.positives++;
    brier += (p - (pt.positive ? 1 : 0)) ** 2;
  }
  const n = points.length;
  let ece = 0;
  const bins = sums.map((s, i) => {
    const meanPredicted = s.count === 0 ? null : s.p / s.count;
    const observedRate = s.count === 0 ? null : s.positives / s.count;
    if (meanPredicted !== null && observedRate !== null)
      ece += (s.count / n) * Math.abs(meanPredicted - observedRate);
    return { lower: i / binCount, upper: (i + 1) / binCount, count: s.count, meanPredicted, observedRate };
  });
  return { bins, ece: n === 0 ? null : ece, brier: n === 0 ? null : brier / n };
}

export interface ThresholdPoint {
  tau: number;
  support: number;
  precision: number | null;
  recall: number | null;
}

export interface ThresholdSample {
  pDelete: number | null;
  margin: number | null;
  label: ActionKind;
}

/** Same rule as calibration (contracts 5.3): delete when pDelete >= tau and margin >= deleteMargin. */
export function thresholdSweep(
  samples: readonly ThresholdSample[],
  taus: readonly number[],
  deleteMargin: number,
): ThresholdPoint[] {
  const positives = samples.filter((s) => s.label === "delete").length;
  return taus.map((tau) => {
    const selected = samples.filter(
      (s) => s.pDelete !== null && s.margin !== null && s.pDelete >= tau && s.margin >= deleteMargin,
    );
    const hits = selected.filter((s) => s.label === "delete").length;
    return {
      tau,
      support: selected.length,
      precision: selected.length === 0 ? null : hits / selected.length,
      recall: positives === 0 ? null : hits / positives,
    };
  });
}

export interface ShufflePair {
  baseline: SuggestedAction;
  shuffled: SuggestedAction;
  baselineDelete: number;
  shuffledDelete: number;
}

export interface ShuffleRobustness {
  pairs: number;
  flips: number;
  flipRate: number | null;
  meanAbsDeltaDelete: number | null;
  maxAbsDeltaDelete: number | null;
}

export function shuffleRobustness(pairs: readonly ShufflePair[]): ShuffleRobustness {
  if (pairs.length === 0) {
    return { pairs: 0, flips: 0, flipRate: null, meanAbsDeltaDelete: null, maxAbsDeltaDelete: null };
  }
  let flips = 0;
  let sum = 0;
  let max = 0;
  for (const pair of pairs) {
    if (pair.baseline !== pair.shuffled) flips++;
    const delta = Math.abs(pair.baselineDelete - pair.shuffledDelete);
    sum += delta;
    max = Math.max(max, delta);
  }
  return {
    pairs: pairs.length,
    flips,
    flipRate: flips / pairs.length,
    meanAbsDeltaDelete: sum / pairs.length,
    maxAbsDeltaDelete: max,
  };
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[Math.min(sorted.length, rank) - 1] ?? null;
}

/** Highest-probability action; ties resolve in the safe order keep, archive, unsure, delete. */
export function argmaxAction(dist: Readonly<Record<SuggestedAction, number>>): SuggestedAction {
  const order: SuggestedAction[] = ["keep", "archive", "unsure", "delete"];
  let best: SuggestedAction = "keep";
  for (const action of order) if (dist[action] > dist[best]) best = action;
  return best;
}
