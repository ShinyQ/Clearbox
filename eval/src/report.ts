import { DELETE_MARGIN, type ActionKind } from "@clearbox/core";
import { FIXTURE_CATEGORIES, type FixtureCategory } from "./fixtures.ts";
import {
  LABEL_ORDER,
  PREDICTED_ORDER,
  confusionMatrix,
  deletePrecisionRecall,
  percentile,
  reliabilityTable,
  shuffleRobustness,
  thresholdSweep,
  type ConfusionMatrix,
  type PrecisionRecall,
  type ReliabilityTable,
  type ShufflePair,
  type ShuffleRobustness,
  type ThresholdPoint,
} from "./metrics.ts";
import type { EvalRow } from "./pipeline.ts";

/** Product target (PRODUCT.md): delete precision at or above 98%. */
export const TARGET_DELETE_PRECISION = 0.98;
/** USD per 1M input tokens (output is free). */
export const INPUT_PRICE_PER_MILLION_USD = 0.042;
export const SWEEP_TAUS = [0.8, 0.85, 0.9, 0.95, 0.99] as const;

export interface CategoryStats {
  category: FixtureCategory;
  n: number;
  accuracy: number | null;
  deleteSuggested: number;
  deletePrecision: number | null;
}

export interface EvalSummary {
  total: number;
  failed: number;
  errors: Record<string, number>;
  /** Rows whose option-order shuffle call failed (their shuffle pair is excluded). */
  shuffleErrors: number;
  labels: Record<ActionKind, number>;
  fused: PrecisionRecall;
  model: PrecisionRecall;
  confusion: ConfusionMatrix;
  harmfulDeletes: { id: string; category: FixtureCategory }[];
  unsureRate: number | null;
  ceilingCapped: number;
  reliabilityFused: ReliabilityTable;
  reliabilityModel: ReliabilityTable;
  sweep: ThresholdPoint[];
  shuffleModel: ShuffleRobustness;
  shuffleFused: ShuffleRobustness;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  calls: number;
  tokensTotal: number;
  tokensMean: number | null;
  tokensMax: number | null;
  estimatedCostUsd: number;
  perCategory: CategoryStats[];
  responseModels: string[];
}

export function summarize(rows: readonly EvalRow[]): EvalSummary {
  const ok = rows.filter((r) => r.error === null);
  const errors: Record<string, number> = {};
  for (const r of rows) if (r.error !== null) errors[r.error] = (errors[r.error] ?? 0) + 1;
  const labels: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  for (const r of rows) labels[r.label]++;

  const shufflePairs = (pick: "model" | "fused"): ShufflePair[] =>
    ok.flatMap((r) => {
      const baseline = pick === "model" ? r.modelAction : r.suggestion;
      const shuffled = pick === "model" ? r.shuffledModelAction : r.shuffledSuggestion;
      if (baseline === null || shuffled === null || r.modelDelete === null || r.shuffledModelDelete === null)
        return [];
      return [{ baseline, shuffled, baselineDelete: r.modelDelete, shuffledDelete: r.shuffledModelDelete }];
    });

  const latencies = rows.flatMap((r) => r.latencyMs);
  const tokens = rows.flatMap((r) => r.inputTokens);
  const tokensTotal = tokens.reduce((s, t) => s + t, 0);

  const perCategory = FIXTURE_CATEGORIES.flatMap((category): CategoryStats[] => {
    const inCat = rows.filter((r) => r.category === category);
    if (inCat.length === 0) return [];
    const suggestedDelete = inCat.filter((r) => r.suggestion === "delete");
    return [
      {
        category,
        n: inCat.length,
        accuracy: inCat.filter((r) => r.suggestion === r.label).length / inCat.length,
        deleteSuggested: suggestedDelete.length,
        deletePrecision:
          suggestedDelete.length === 0
            ? null
            : suggestedDelete.filter((r) => r.label === "delete").length / suggestedDelete.length,
      },
    ];
  });

  return {
    total: rows.length,
    failed: rows.length - ok.length,
    errors,
    shuffleErrors: rows.filter((r) => r.shuffleError != null).length,
    labels,
    fused: deletePrecisionRecall(rows.map((r) => ({ predicted: r.suggestion, label: r.label }))),
    model: deletePrecisionRecall(
      ok.flatMap((r) => (r.modelAction === null ? [] : [{ predicted: r.modelAction, label: r.label }])),
    ),
    confusion: confusionMatrix(rows.map((r) => ({ predicted: r.suggestion, label: r.label }))),
    harmfulDeletes: rows
      .filter((r) => r.suggestion === "delete" && r.label === "keep")
      .map((r) => ({ id: r.id, category: r.category })),
    unsureRate: rows.length === 0 ? null : rows.filter((r) => r.suggestion === "unsure").length / rows.length,
    ceilingCapped: rows.filter((r) => r.ceiling !== "delete").length,
    reliabilityFused: reliabilityTable(
      ok.flatMap((r) =>
        r.fusedDelete === null ? [] : [{ p: r.fusedDelete, positive: r.label === "delete" }],
      ),
    ),
    reliabilityModel: reliabilityTable(
      ok.flatMap((r) =>
        r.modelDelete === null ? [] : [{ p: r.modelDelete, positive: r.label === "delete" }],
      ),
    ),
    sweep: thresholdSweep(
      rows.map((r) => ({ pDelete: r.fusedDelete, margin: r.margin, label: r.label })),
      SWEEP_TAUS,
      DELETE_MARGIN,
    ),
    shuffleModel: shuffleRobustness(shufflePairs("model")),
    shuffleFused: shuffleRobustness(shufflePairs("fused")),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    calls: latencies.length,
    tokensTotal,
    tokensMean: tokens.length === 0 ? null : tokensTotal / tokens.length,
    tokensMax: tokens.length === 0 ? null : Math.max(...tokens),
    estimatedCostUsd: (tokensTotal / 1_000_000) * INPUT_PRICE_PER_MILLION_USD,
    perCategory,
    responseModels: [...new Set(ok.flatMap((r) => (r.responseModel === null ? [] : [r.responseModel])))],
  };
}

export interface ReportMeta {
  generatedAt: string;
  deployment: string;
  fixtures: string;
  tauDelete: number;
  shuffle: boolean;
  concurrency: number;
  rpm: number;
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, digits = 3): string => (v === null ? "n/a" : v.toFixed(digits));
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;

function reliabilitySection(title: string, table: ReliabilityTable): string[] {
  return [
    `### ${title}`,
    "",
    row(["P(delete) bucket", "Count", "Mean predicted", "Observed delete rate"]),
    row(["---", "---:", "---:", "---:"]),
    ...table.bins.map((b) =>
      row([
        `${b.lower.toFixed(1)} to ${b.upper.toFixed(1)}`,
        b.count,
        num(b.meanPredicted),
        num(b.observedRate),
      ]),
    ),
    "",
    `ECE ${num(table.ece)}, Brier ${num(table.brier)}.`,
    "",
  ];
}

/** Markdown report. Contains ids, categories and numbers only: never subjects, snippets or addresses. */
export function renderReport(summary: EvalSummary, meta: ReportMeta): string {
  const s = summary;
  const verdict =
    s.fused.precision === null
      ? "no delete suggestions"
      : s.fused.precision >= TARGET_DELETE_PRECISION
        ? "meets target"
        : "BELOW TARGET";
  const lines: string[] = [
    "# Clearbox eval report",
    "",
    `- Generated: ${meta.generatedAt}`,
    `- Fixtures: ${meta.fixtures} (${s.total}; delete ${s.labels.delete}, archive ${s.labels.archive}, keep ${s.labels.keep})`,
    `- Deployment: ${meta.deployment}; response model: ${s.responseModels.join(", ") || "n/a"}`,
    `- tau_delete ${meta.tauDelete}, delete margin ${DELETE_MARGIN}, no priors, no past decisions`,
    `- Concurrency ${meta.concurrency}, pacing ${meta.rpm} requests per minute, shuffle check ${meta.shuffle ? "on" : "off"}`,
    `- Model failures: ${s.failed}${
      Object.keys(s.errors).length > 0
        ? ` (${Object.entries(s.errors)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})`
        : ""
    }`,
    `- Shuffle call failures: ${s.shuffleErrors}`,
    "",
    "## Headline",
    "",
    row(["Metric", "Fused suggestion", "Model argmax only"]),
    row(["---", "---:", "---:"]),
    row(["Delete precision", pct(s.fused.precision), pct(s.model.precision)]),
    row(["Delete precision, 95% lower bound", pct(s.fused.precisionLower95), pct(s.model.precisionLower95)]),
    row(["Delete recall", pct(s.fused.recall), pct(s.model.recall)]),
    row([
      "Delete suggestions (TP + FP)",
      s.fused.truePositives + s.fused.falsePositives,
      s.model.truePositives + s.model.falsePositives,
    ]),
    "",
    `Target delete precision ${pct(TARGET_DELETE_PRECISION)}: **${verdict}**. Unsure rate ${pct(s.unsureRate)}. Guardrail ceiling below delete on ${s.ceilingCapped} of ${s.total}.`,
    "",
    `Harmful deletes (suggested delete, labeled keep): ${s.harmfulDeletes.length === 0 ? "none" : s.harmfulDeletes.map((h) => `${h.id} (${h.category})`).join(", ")}`,
    "",
    "## Confusion matrix (rows: suggestion, columns: label)",
    "",
    row(["", ...LABEL_ORDER]),
    row(["---", ...LABEL_ORDER.map(() => "---:")]),
    ...PREDICTED_ORDER.map((p) => row([p, ...LABEL_ORDER.map((l) => s.confusion[p][l])])),
    "",
    "## Per category",
    "",
    row(["Category", "N", "Accuracy", "Delete suggested", "Delete precision"]),
    row(["---", "---:", "---:", "---:", "---:"]),
    ...s.perCategory.map((c) =>
      row([c.category, c.n, pct(c.accuracy), c.deleteSuggested, pct(c.deletePrecision)]),
    ),
    "",
    "## Reliability (calibration)",
    "",
    ...reliabilitySection("Fused P(delete), after prior, flags and ceiling", s.reliabilityFused),
    ...reliabilitySection("Raw model P(delete)", s.reliabilityModel),
    "## Threshold sweep (fused P(delete) >= tau and margin >= delete margin)",
    "",
    row(["tau", "Support", "Precision", "Recall"]),
    row(["---:", "---:", "---:", "---:"]),
    ...s.sweep.map((p) => row([p.tau.toFixed(2), p.support, pct(p.precision), pct(p.recall)])),
    "",
    "## Option-order shuffle robustness",
    "",
    row(["Level", "Pairs", "Flips", "Flip rate", "Mean abs delta P(delete)", "Max abs delta P(delete)"]),
    row(["---", "---:", "---:", "---:", "---:", "---:"]),
    ...(
      [
        ["Model argmax", s.shuffleModel],
        ["Fused suggestion", s.shuffleFused],
      ] as const
    ).map(([name, r]) =>
      row([name, r.pairs, r.flips, pct(r.flipRate), num(r.meanAbsDeltaDelete), num(r.maxAbsDeltaDelete)]),
    ),
    "",
    "## Latency and tokens",
    "",
    `- Calls: ${s.calls}; latency p50 ${num(s.latencyP50Ms, 0)} ms, p95 ${num(s.latencyP95Ms, 0)} ms`,
    `- Input tokens: total ${s.tokensTotal}, mean ${num(s.tokensMean, 1)}, max ${s.tokensMax ?? "n/a"}`,
    `- Estimated cost: $${s.estimatedCostUsd.toFixed(6)} at $${INPUT_PRICE_PER_MILLION_USD} per 1M input tokens`,
    "",
  ];
  return lines.join("\n");
}
