import { describe, expect, it } from "vitest";
import type { EvalRow } from "../src/pipeline.ts";
import { INPUT_PRICE_PER_MILLION_USD, renderReport, summarize } from "../src/report.ts";

function row(over: Partial<EvalRow>): EvalRow {
  return {
    id: "syn-001",
    source: "synthetic",
    category: "promotion",
    label: "delete",
    ceiling: "delete",
    error: null,
    modelAction: "delete",
    modelDelete: 0.95,
    suggestion: "delete",
    confidence: 0.95,
    fusedDelete: 0.95,
    margin: 0.9,
    shuffledModelAction: "delete",
    shuffledModelDelete: 0.94,
    shuffledSuggestion: "delete",
    latencyMs: [300, 320],
    inputTokens: [600, 600],
    responseModel: "microsoft-decision-1",
    ...over,
  };
}

const ROWS: EvalRow[] = [
  row({ id: "syn-001" }),
  row({ id: "syn-002", label: "keep", category: "human", suggestion: "delete" }),
  row({
    id: "syn-003",
    label: "archive",
    category: "receipt",
    suggestion: "archive",
    modelAction: "archive",
    fusedDelete: 0.05,
    modelDelete: 0.05,
    margin: -0.8,
    ceiling: "archive",
    shuffledModelAction: "archive",
    shuffledModelDelete: 0.06,
    shuffledSuggestion: "archive",
  }),
  row({
    id: "syn-004",
    label: "keep",
    category: "human",
    error: "rate_limited",
    modelAction: null,
    modelDelete: null,
    suggestion: "unsure",
    confidence: 0,
    fusedDelete: null,
    margin: null,
    shuffledModelAction: null,
    shuffledModelDelete: null,
    shuffledSuggestion: null,
    latencyMs: [],
    inputTokens: [],
    responseModel: null,
  }),
];

describe("summarize", () => {
  const s = summarize(ROWS);

  it("computes headline metrics", () => {
    expect(s.total).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.errors).toEqual({ rate_limited: 1 });
    expect(s.labels).toEqual({ delete: 1, archive: 1, keep: 2 });
    expect(s.fused.precision).toBe(0.5);
    expect(s.fused.recall).toBe(1);
    expect(s.harmfulDeletes).toEqual([{ id: "syn-002", category: "human" }]);
    expect(s.unsureRate).toBe(0.25);
    expect(s.ceilingCapped).toBe(1);
  });

  it("aggregates latency, tokens and cost", () => {
    expect(s.calls).toBe(6);
    expect(s.latencyP50Ms).toBe(300);
    expect(s.latencyP95Ms).toBe(320);
    expect(s.tokensTotal).toBe(3600);
    expect(s.estimatedCostUsd).toBeCloseTo((3600 / 1_000_000) * INPUT_PRICE_PER_MILLION_USD, 12);
    expect(s.responseModels).toEqual(["microsoft-decision-1"]);
  });

  it("reports shuffle robustness over successful rows only", () => {
    expect(s.shuffleModel.pairs).toBe(3);
    expect(s.shuffleModel.flips).toBe(0);
  });

  it("builds per-category stats", () => {
    const human = s.perCategory.find((c) => c.category === "human");
    expect(human).toEqual({ category: "human", n: 2, accuracy: 0, deleteSuggested: 1, deletePrecision: 0 });
  });

  it("counts rows whose shuffle call failed", () => {
    expect(s.shuffleErrors).toBe(0);
    expect(summarize([row({ id: "syn-010", shuffleError: "timeout" })]).shuffleErrors).toBe(1);
  });
});

describe("renderReport", () => {
  const text = renderReport(summarize(ROWS), {
    generatedAt: "2026-10-15T00:00:00.000Z",
    deployment: "decision-1",
    fixtures: "emails.jsonl",
    tauDelete: 0.8,
    shuffle: true,
    concurrency: 2,
    rpm: 240,
  });

  it("contains every section", () => {
    for (const heading of [
      "# Clearbox eval report",
      "## Headline",
      "## Confusion matrix",
      "## Per category",
      "## Reliability (calibration)",
      "## Threshold sweep",
      "## Option-order shuffle robustness",
      "## Latency and tokens",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("BELOW TARGET");
    expect(text).toContain("syn-002 (human)");
  });

  it("never contains an em dash", () => {
    expect(text.includes("\u2014")).toBe(false);
  });
});
