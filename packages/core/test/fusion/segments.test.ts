import { describe, expect, it } from "vitest";
import { fuse, type Thresholds } from "../../src/fusion/fusion.ts";
import { decisionSegment, isBulkMail, segmentTau } from "../../src/fusion/segments.ts";
import type { GuardrailResult } from "../../src/guardrails/guardrails.ts";
import type { ActionDistribution, Ceiling } from "../../src/model/actions.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import { selectPrior } from "../../src/priors/priors.ts";
import { makeDecisionResult, makeSignals } from "../fixtures/builders.ts";

const TH: Thresholds = {
  tauDelete: TAU_DELETE_DEFAULT,
  deleteMargin: DELETE_MARGIN,
  minConfidence: MIN_CONFIDENCE,
};
const ADDRESS = "news@shop.example.com";
const NO_PRIOR = selectPrior(null, null, ADDRESS, "example.com");
const SENDER_PRIOR = selectPrior({ deletes: 9, keeps: 0 }, null, ADDRESS, "example.com");
const DOMAIN_PRIOR = selectPrior(null, { deletes: 3, keeps: 0 }, ADDRESS, "example.com");

function guard(ceiling: Ceiling = "delete", denylisted = false, lifted = false): GuardrailResult {
  return { ceiling, reasons: [], allowlisted: false, denylisted, liftedByDenylist: lifted };
}

function dist(d: number, a: number, k: number, u: number): ActionDistribution {
  return { delete: d, archive: a, keep: k, unsure: u };
}

describe("decisionSegment", () => {
  it("picks rule, sender, domain, bulk and other in that order", () => {
    const bulk = makeSignals({ hasListUnsubscribe: true });
    expect(decisionSegment(SENDER_PRIOR, bulk, guard("delete", true))).toBe("rule");
    expect(decisionSegment(SENDER_PRIOR, bulk, guard())).toBe("sender");
    expect(decisionSegment(DOMAIN_PRIOR, bulk, guard())).toBe("domain");
    expect(decisionSegment(NO_PRIOR, bulk, guard())).toBe("bulk");
    expect(decisionSegment(NO_PRIOR, makeSignals(), guard())).toBe("other");
  });

  it("is not rule when a cap still applies or the denylist lifted a cap", () => {
    expect(decisionSegment(NO_PRIOR, makeSignals(), guard("keep", true))).toBe("other");
    expect(decisionSegment(NO_PRIOR, makeSignals(), guard("delete", true, true))).toBe("other");
  });

  it("needs PRIOR_MIN_N decisions for a prior segment", () => {
    const weak = selectPrior({ deletes: 2, keeps: 0 }, null, ADDRESS, "example.com");
    expect(decisionSegment(weak, makeSignals(), guard())).toBe("other");
  });
});

describe("isBulkMail", () => {
  it("uses list headers, bulk precedence and bulk categories", () => {
    expect(isBulkMail(makeSignals())).toBe(false);
    expect(isBulkMail(makeSignals({ hasListId: true }))).toBe(true);
    expect(isBulkMail(makeSignals({ precedenceBulk: true }))).toBe(true);
    expect(isBulkMail(makeSignals({ category: "promotions" }))).toBe(true);
    expect(isBulkMail(makeSignals({ category: "primary" }))).toBe(false);
  });
});

describe("segmentTau", () => {
  it("returns 0 for rule, the segment value (null = paused) or the global fallback", () => {
    expect(segmentTau("rule", 0.9, { sender: 0.95 })).toBe(0);
    expect(segmentTau("sender", 0.9, { sender: 0.95 })).toBe(0.95);
    expect(segmentTau("bulk", 0.9, { bulk: null })).toBeNull();
    expect(segmentTau("other", 0.9, { bulk: 0.8 })).toBe(0.9);
    expect(segmentTau("other", 0.9, undefined)).toBe(0.9);
  });
});

describe("fuse with segments", () => {
  const strong = makeDecisionResult({ action: dist(0.9, 0.05, 0.03, 0.02) });

  it("uses the segment threshold instead of the global one", () => {
    const s = fuse({
      model: strong,
      prior: NO_PRIOR,
      guard: guard(),
      signals: makeSignals({ hasListUnsubscribe: true }),
      thresholds: { ...TH, tauDelete: 0.99, segmentTaus: { bulk: 0.85 } },
    });
    expect(s.segment).toBe("bulk");
    expect(s.action).toBe("delete");
    expect(s.deleteTau).toBe(0.85);
  });

  it("suggests no trash in a paused segment", () => {
    const s = fuse({
      model: strong,
      prior: NO_PRIOR,
      guard: guard(),
      signals: makeSignals({ hasListUnsubscribe: true }),
      thresholds: { ...TH, segmentTaus: { bulk: null } },
    });
    expect(s.action).toBe("unsure");
    expect(s.deleteTau).toBeNull();
    expect(s.reasons.map((r) => r.code)).toContain("low_confidence");
  });

  it("skips the confidence check for an Always OK to trash sender", () => {
    const weak = makeDecisionResult({ action: dist(0.3, 0.2, 0.4, 0.1) });
    const s = fuse({
      model: weak,
      prior: NO_PRIOR,
      guard: guard("delete", true),
      signals: makeSignals(),
      thresholds: TH,
    });
    expect(s.segment).toBe("rule");
    expect(s.action).toBe("delete");
    expect(s.confidence).toBeCloseTo(0.3, 9);
    expect(s.deleteTau).toBe(0);
    expect(s.reasons[0]?.code).toBe("deny_listed");
  });

  it("keeps the normal check when the denylist lifted a cap", () => {
    const weak = makeDecisionResult({ action: dist(0.3, 0.2, 0.4, 0.1) });
    const s = fuse({
      model: weak,
      prior: NO_PRIOR,
      guard: guard("delete", true, true),
      signals: makeSignals(),
      thresholds: TH,
    });
    expect(s.action).not.toBe("delete");
  });

  it("never applies the rule when the model failed", () => {
    const s = fuse({
      model: null,
      prior: NO_PRIOR,
      guard: guard("delete", true),
      signals: makeSignals(),
      thresholds: TH,
    });
    expect(s.action).toBe("unsure");
    expect(s.segment).toBe("rule");
    expect(s.deleteTau).toBeNull();
  });
});
