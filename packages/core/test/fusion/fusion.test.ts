import { describe, expect, it } from "vitest";
import type { DecisionResult } from "../../src/decision/engine.ts";
import {
  fuse,
  selectReasons,
  type FusionInput,
  type ReasonContext,
  type Thresholds,
} from "../../src/fusion/fusion.ts";
import type { GuardrailResult } from "../../src/guardrails/guardrails.ts";
import type { ActionDistribution, Ceiling } from "../../src/model/actions.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import type { Reason } from "../../src/model/reasons.ts";
import { selectPrior, type Prior } from "../../src/priors/priors.ts";
import { makeDecisionResult, makeSignals } from "../fixtures/builders.ts";

const TH: Thresholds = {
  tauDelete: TAU_DELETE_DEFAULT,
  deleteMargin: DELETE_MARGIN,
  minConfidence: MIN_CONFIDENCE,
};
const NO_PRIOR: Prior = selectPrior(null, null, "news@shop.example.com", "example.com");
const LOW_FLAGS = { isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 };

function dist(d: number, a: number, k: number, u: number): ActionDistribution {
  return { delete: d, archive: a, keep: k, unsure: u };
}

function guard(ceiling: Ceiling = "delete", reasons: Reason[] = [], denylisted = false): GuardrailResult {
  return { ceiling, reasons, allowlisted: false, denylisted };
}

function model(action: ActionDistribution, overrides: Partial<DecisionResult> = {}): DecisionResult {
  return makeDecisionResult({ action, flags: LOW_FLAGS, importance: 0, ...overrides });
}

function input(overrides: Partial<FusionInput> = {}): FusionInput {
  return {
    model: model(dist(0.5, 0.2, 0.2, 0.1)),
    prior: NO_PRIOR,
    guard: guard(),
    signals: makeSignals(),
    thresholds: TH,
    ...overrides,
  };
}

function expectDist(actual: ActionDistribution | null, expected: ActionDistribution): void {
  expect(actual).not.toBeNull();
  expect(actual?.delete).toBeCloseTo(expected.delete, 9);
  expect(actual?.archive).toBeCloseTo(expected.archive, 9);
  expect(actual?.keep).toBeCloseTo(expected.keep, 9);
  expect(actual?.unsure).toBeCloseTo(expected.unsure, 9);
}

function sum(d: ActionDistribution | null): number {
  return d === null ? Number.NaN : d.delete + d.archive + d.keep + d.unsure;
}

describe("fuse", () => {
  describe("contracts 5.1 edge cases", () => {
    it("no prior: lambda = 0 and v = m before flags", () => {
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)) }));
      expectDist(s.distribution, dist(0.5, 0.2, 0.2, 0.1));
      expect(s.modelDelete).toBeCloseTo(0.5, 9);
    });

    it("m.delete = 1: v = {delete: d, unsure: 1 - d, archive: 0, keep: 0}", () => {
      const prior = selectPrior({ deletes: 0, keeps: 2 }, null, "a@example.com", "example.com"); // n 2, p 0.25
      const s = fuse(input({ model: model(dist(1, 0, 0, 0)), prior }));
      const d = (5 / 7) * 1 + (2 / 7) * 0.25;
      expectDist(s.distribution, dist(d, 0, 0, 1 - d));
      expect(s.action).toBe("unsure");
    });

    it("m.delete = 1 and lambda = 0: v.unsure = 0 and delete wins with margin 1", () => {
      const s = fuse(input({ model: model(dist(1, 0, 0, 0)) }));
      expectDist(s.distribution, dist(1, 0, 0, 0));
      expect(s.action).toBe("delete");
      expect(s.confidence).toBeCloseTo(1, 9);
      expect(s.margin).toBeCloseTo(1, 9);
    });

    it("sender n = 2, domain n = 10: domain prior used with lambda = 10/15", () => {
      const prior = selectPrior(
        { deletes: 2, keeps: 0 },
        { deletes: 10, keeps: 0 },
        "a@example.com",
        "example.com",
      );
      expect(prior.source).toBe("domain");
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)), prior }));
      const lambda = 10 / 15;
      const d = (1 - lambda) * 0.5 + lambda * (11 / 12);
      const scale = (1 - d) / 0.5;
      expectDist(s.distribution, dist(d, 0.2 * scale, 0.2 * scale, 0.1 * scale));
    });

    it("sender n = 2, no domain prior: sender prior used with lambda = 2/7", () => {
      const prior = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com"); // p 0.75
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)), prior }));
      const d = (5 / 7) * 0.5 + (2 / 7) * 0.75;
      expect(s.distribution?.delete).toBeCloseTo(d, 9);
      expect(sum(s.distribution)).toBeCloseTo(1, 9);
    });

    it("ceiling keep: archive and delete mass fold into keep", () => {
      const s = fuse(input({ model: model(dist(0.9, 0.05, 0.03, 0.02)), guard: guard("keep") }));
      expectDist(s.distribution, dist(0, 0, 0.98, 0.02));
      expect(s.action).toBe("keep");
      expect(s.confidence).toBeCloseTo(0.98, 9);
      expect(s.ceilingApplied).toBe(true);
    });

    it("ceiling keep: unsure when the folded keep mass is below 0.55", () => {
      const s = fuse(input({ model: model(dist(0.2, 0.1, 0.2, 0.5)), guard: guard("keep") }));
      expectDist(s.distribution, dist(0, 0, 0.5, 0.5));
      expect(s.action).toBe("unsure");
      expect(s.confidence).toBeCloseTo(0.5, 9);
    });

    it("ceiling archive, model delete 0.95: delete folds into archive, ceilingApplied", () => {
      const reasons: Reason[] = [{ code: "guard_attachment", params: {} }];
      const s = fuse(input({ model: model(dist(0.95, 0.02, 0.02, 0.01)), guard: guard("archive", reasons) }));
      expectDist(s.distribution, dist(0, 0.97, 0.02, 0.01));
      expect(s.action).toBe("archive");
      expect(s.ceilingApplied).toBe(true);
      expect(s.ceiling).toBe("archive");
      expect(s.reasons[0]).toEqual({ code: "guard_attachment", params: {} });
    });

    it("delete 0.79, keep 0.15, tau 0.80: unsure with low confidence", () => {
      const s = fuse(input({ model: model(dist(0.79, 0.03, 0.15, 0.03)) }));
      expect(s.action).toBe("unsure");
      expect(s.confidence).toBeCloseTo(0.03, 9);
      expect(s.reasons.map((r) => r.code)).toContain("low_confidence");
    });

    it("delete 0.58, archive 0.40, tau 0.80: unsure", () => {
      const s = fuse(input({ model: model(dist(0.58, 0.4, 0.01, 0.01)) }));
      expect(s.action).toBe("unsure");
    });

    it("delete 0.90, archive 0.08, tau 0.80: delete with confidence 0.90 and margin 0.82", () => {
      const s = fuse(input({ model: model(dist(0.9, 0.08, 0.01, 0.01)) }));
      expect(s.action).toBe("delete");
      expect(s.confidence).toBeCloseTo(0.9, 9);
      expect(s.margin).toBeCloseTo(0.82, 9);
      expect(s.ceilingApplied).toBe(false);
    });

    it("tie keep = archive = 0.5: keep wins the tie but 0.5 < 0.55 gives unsure", () => {
      const s = fuse(input({ model: model(dist(0, 0.5, 0.5, 0)) }));
      expect(s.action).toBe("unsure");
      const lower = fuse(
        input({ model: model(dist(0, 0.5, 0.5, 0)), thresholds: { ...TH, minConfidence: 0.5 } }),
      );
      expect(lower.action).toBe("keep");
    });

    it("flags shift delete below tau: not delete", () => {
      const s = fuse(
        input({ model: model(dist(0.9, 0.05, 0.03, 0.02), { flags: { ...LOW_FLAGS, isRecord: 0.8 } }) }),
      );
      expect(s.distribution?.delete).toBeCloseTo(0.45, 9);
      expect(s.distribution?.archive).toBeCloseTo(0.5, 9);
      expect(s.action).not.toBe("delete");
    });

    it("model null: unsure, confidence 0, distribution null", () => {
      const s = fuse(input({ model: null, guard: guard("archive") }));
      expect(s).toMatchObject({
        action: "unsure",
        confidence: 0,
        distribution: null,
        modelDelete: null,
        margin: null,
        ceiling: "archive",
        ceilingApplied: false,
        importance: null,
        flags: null,
      });
      expect(s.reasons[0]?.code).toBe("model_unavailable");
    });
  });

  describe("flag shifts", () => {
    it("is_from_human moves half of delete to keep", () => {
      const s = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isFromHuman: 0.7 } }) }),
      );
      expectDist(s.distribution, dist(0.3, 0.1, 0.5, 0.1));
    });

    it("record then human apply in order", () => {
      const flags = { isRecord: 0.9, isExpired: 0.1, isFromHuman: 0.9 };
      const s = fuse(input({ model: model(dist(0.8, 0.1, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.2, 0.5, 0.25, 0.05));
    });

    it("is_expired moves 30% of archive to delete when not from a human", () => {
      const flags = { isRecord: 0.1, isExpired: 0.9, isFromHuman: 0.4 };
      const s = fuse(input({ model: model(dist(0.5, 0.4, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.62, 0.28, 0.05, 0.05));
    });

    it("is_expired does nothing when is_from_human >= 0.5", () => {
      const flags = { isRecord: 0.1, isExpired: 0.9, isFromHuman: 0.5 };
      const s = fuse(input({ model: model(dist(0.5, 0.4, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.5, 0.4, 0.05, 0.05));
    });

    it("flags exactly at 0.7 apply, just below do not", () => {
      const at = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isRecord: 0.7 } }) }),
      );
      const below = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isRecord: 0.69 } }) }),
      );
      expect(at.distribution?.delete).toBeCloseTo(0.3, 9);
      expect(below.distribution?.delete).toBeCloseTo(0.6, 9);
    });
  });

  describe("thresholds", () => {
    it("delete needs both tau and margin", () => {
      expect(fuse(input({ model: model(dist(0.8, 0.1, 0.05, 0.05)) })).action).toBe("delete");
      const lowTau = { ...TH, tauDelete: 0.5 };
      expect(fuse(input({ model: model(dist(0.58, 0.4, 0.02, 0)), thresholds: lowTau })).action).not.toBe(
        "delete",
      );
      expect(fuse(input({ model: model(dist(0.65, 0.35, 0, 0)), thresholds: lowTau })).action).toBe("delete");
      expect(
        fuse(input({ model: model(dist(0.85, 0.1, 0.05, 0)), thresholds: { ...TH, tauDelete: 0.9 } })).action,
      ).not.toBe("delete");
    });

    it("picks the best non-delete action when confident", () => {
      expect(fuse(input({ model: model(dist(0.1, 0.7, 0.1, 0.1)) })).action).toBe("archive");
      expect(fuse(input({ model: model(dist(0.1, 0.1, 0.7, 0.1)) })).action).toBe("keep");
      expect(fuse(input({ model: model(dist(0.1, 0.1, 0.1, 0.7)) })).action).toBe("unsure");
    });

    it("ceilingApplied is false when the unbounded choice was allowed", () => {
      const s = fuse(input({ model: model(dist(0.1, 0.1, 0.7, 0.1)), guard: guard("keep") }));
      expect(s.action).toBe("keep");
      expect(s.ceilingApplied).toBe(false);
    });

    it("always returns a distribution summing to 1 and copies importance and flags", () => {
      const flags = { isRecord: 0.9, isExpired: 0.9, isFromHuman: 0.2 };
      const s = fuse(
        input({
          model: model(dist(0.4, 0.3, 0.2, 0.1), { flags, importance: 2.5 }),
          guard: guard("archive"),
        }),
      );
      expect(sum(s.distribution)).toBeCloseTo(1, 9);
      expect(s.importance).toBe(2.5);
      expect(s.flags).toEqual(flags);
    });
  });
});

describe("selectReasons", () => {
  function ctx(overrides: Partial<ReasonContext> = {}): ReasonContext {
    return {
      model: model(dist(0.9, 0.05, 0.03, 0.02)),
      prior: NO_PRIOR,
      guard: guard(),
      signals: makeSignals(),
      action: "delete",
      ceilingApplied: false,
      lowConfidence: false,
      ...overrides,
    };
  }
  const codes = (c: ReasonContext): string[] => selectReasons(c).map((r) => r.code);
  const capped = guard("archive", [{ code: "guard_attachment", params: {} }]);

  it("starts with model_unavailable when the model is null", () => {
    expect(codes(ctx({ model: null, action: "unsure" }))[0]).toBe("model_unavailable");
  });

  it("includes guardrail reasons when the ceiling was applied", () => {
    expect(codes(ctx({ guard: capped, action: "archive", ceilingApplied: true }))[0]).toBe(
      "guard_attachment",
    );
  });

  it("includes guardrail reasons for keep/archive under a lowered ceiling even when not applied", () => {
    expect(codes(ctx({ guard: capped, action: "keep" }))).toContain("guard_attachment");
  });

  it("omits guardrail reasons for unsure when the ceiling was not applied", () => {
    expect(codes(ctx({ guard: capped, action: "unsure" }))).not.toContain("guard_attachment");
  });

  it("adds deny_listed only for delete", () => {
    expect(codes(ctx({ guard: guard("delete", [], true), action: "delete" }))).toContain("deny_listed");
    expect(codes(ctx({ guard: guard("delete", [], true), action: "unsure" }))).not.toContain("deny_listed");
  });

  it("adds low_confidence", () => {
    expect(codes(ctx({ action: "unsure", lowConfidence: true }))[0]).toBe("low_confidence");
  });

  it("adds the sender prior as deleted for delete or pDelete >= 0.5, else kept", () => {
    const deleting = selectPrior({ deletes: 14, keeps: 0 }, null, "a@example.com", "example.com");
    expect(selectReasons(ctx({ prior: deleting }))[0]).toEqual({
      code: "prior_sender_deleted",
      params: { deletes: 14, total: 14, domain: "example.com" },
    });
    const keeping = selectPrior({ deletes: 1, keeps: 4 }, null, "a@example.com", "example.com");
    expect(selectReasons(ctx({ prior: keeping, action: "keep", model: model(dist(0, 0, 1, 0)) }))[0]).toEqual(
      {
        code: "prior_sender_kept",
        params: { keeps: 4, total: 5, domain: "example.com" },
      },
    );
  });

  it("uses the domain prior codes and skips priors with n < 3", () => {
    const domain = selectPrior(null, { deletes: 3, keeps: 1 }, "a@example.com", "example.com");
    expect(codes(ctx({ prior: domain }))[0]).toBe("prior_domain_deleted");
    const weak = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com");
    expect(codes(ctx({ prior: weak })).some((c) => c.startsWith("prior_"))).toBe(false);
  });

  it("lists delete-side signal reasons in order", () => {
    const signals = makeSignals({
      senderSeenCount: 37,
      senderOpenRate: 0,
      hasListUnsubscribe: true,
      precedenceBulk: true,
    });
    const reasons = selectReasons(
      ctx({
        signals,
        model: model(dist(0.9, 0.05, 0.03, 0.02), { flags: { ...LOW_FLAGS, isExpired: 0.9 } }),
      }),
    );
    expect(reasons).toEqual([
      { code: "flag_expired", params: {} },
      { code: "low_open_rate", params: { openPct: 0, seen: 37 } },
      { code: "list_unsubscribe", params: {} },
    ]);
  });

  it("formats category, old unread and auth failures", () => {
    const signals = makeSignals({
      category: "promotions",
      isRead: false,
      ageDays: 45,
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
    });
    expect(selectReasons(ctx({ signals }))).toEqual([
      { code: "category", params: { category: "Promotions" } },
      { code: "old_unread", params: { ageDays: 45 } },
      { code: "auth_failed", params: { method: "DMARC" } },
    ]);
    const spfOnly = makeSignals({ auth: { spf: "fail", dkim: "pass", dmarc: "none" } });
    expect(selectReasons(ctx({ signals: spfOnly }))).toEqual([
      { code: "auth_failed", params: { method: "SPF" } },
    ]);
  });

  it("does not use low_open_rate below 5 messages or above 10%, nor category primary", () => {
    const signals = makeSignals({ senderSeenCount: 4, senderOpenRate: 0, category: "primary" });
    expect(codes(ctx({ signals }))).toEqual([]);
    const opened = makeSignals({ senderSeenCount: 20, senderOpenRate: 0.11 });
    expect(codes(ctx({ signals: opened }))).toEqual([]);
  });

  it("puts flag_record first for archive", () => {
    const c = ctx({
      action: "archive",
      model: model(dist(0.1, 0.8, 0.05, 0.05), { flags: { ...LOW_FLAGS, isRecord: 0.9 } }),
      signals: makeSignals({ hasListUnsubscribe: true }),
    });
    expect(codes(c)).toEqual(["flag_record", "list_unsubscribe"]);
  });

  it("uses flag_human and model_important for keep", () => {
    const c = ctx({
      action: "keep",
      model: model(dist(0, 0, 1, 0), { flags: { ...LOW_FLAGS, isFromHuman: 0.95 }, importance: 3.6 }),
      signals: makeSignals({ hasListUnsubscribe: true }),
    });
    expect(selectReasons(c)).toEqual([
      { code: "flag_human", params: {} },
      { code: "model_important", params: { level: "critical" } },
    ]);
  });

  it("keeps at most 3 reasons without duplicate codes", () => {
    const g = guard("keep", [
      { code: "guard_starred", params: {} },
      { code: "guard_starred", params: {} },
      { code: "guard_replied", params: {} },
      { code: "guard_correspondent", params: {} },
      { code: "guard_too_recent", params: { minAgeDays: 3 } },
    ]);
    const reasons = selectReasons(ctx({ guard: g, action: "keep", ceilingApplied: true }));
    expect(reasons.map((r) => r.code)).toEqual(["guard_starred", "guard_replied", "guard_correspondent"]);
  });
});
