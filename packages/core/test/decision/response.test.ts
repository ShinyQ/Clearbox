import { describe, expect, it } from "vitest";
import {
  ChoiceAnswerSchema,
  DecisionResponseSchema,
  NoulAnswerSchema,
  ScoreAnswerSchema,
  normalizeDecisionResponse,
} from "../../src/decision/response.ts";
import { DecisionError } from "../../src/model/errors.ts";
import deleteFixture from "../fixtures/decision/response-delete.json" with { type: "json" };
import minimalFixture from "../fixtures/decision/response-minimal.json" with { type: "json" };

const meta = { deployment: "decision-1", requestId: "req-1", latencyMs: 12 };

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("DecisionResponseSchema", () => {
  it("accepts the documented full response (research decision-1.md 4.3)", () => {
    expect(DecisionResponseSchema.safeParse(deleteFixture).success).toBe(true);
  });

  it("accepts a response without confidence, legend, score probabilities or output_tokens", () => {
    expect(DecisionResponseSchema.safeParse(minimalFixture).success).toBe(true);
  });

  it("tolerates unknown extra fields (loose objects)", () => {
    const body = {
      ...clone(deleteFixture),
      id: "x",
      answers: { ...clone(deleteFixture).answers, extra: { type: "noul", noul: 1 } },
    };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects a refusal or other unknown answer type", () => {
    const body = clone(deleteFixture) as Record<string, unknown> & { answers: Record<string, unknown> };
    body.answers.action = { type: "refusal", reason: "declined" };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a missing question", () => {
    const body = clone(deleteFixture) as { answers: Partial<typeof deleteFixture.answers> };
    delete body.answers.is_expired;
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects missing usage.input_tokens", () => {
    expect(
      DecisionResponseSchema.safeParse({ ...clone(deleteFixture), usage: { output_tokens: 3 } }).success,
    ).toBe(false);
  });
});

describe("ChoiceAnswerSchema", () => {
  const ok = {
    type: "choice",
    choice: "delete",
    probabilities: { delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1 },
  };

  it("accepts four probabilities summing to 1 within 0.01", () => {
    expect(ChoiceAnswerSchema.safeParse(ok).success).toBe(true);
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.705, archive: 0.1, keep: 0.1, unsure: 0.1 },
      }).success,
    ).toBe(true);
  });

  it("rejects sums off by more than 0.01", () => {
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.8, archive: 0.1, keep: 0.1, unsure: 0.1 },
      }).success,
    ).toBe(false);
  });

  it("rejects missing or extra option keys", () => {
    expect(
      ChoiceAnswerSchema.safeParse({ ...ok, probabilities: { delete: 0.8, archive: 0.1, keep: 0.1 } })
        .success,
    ).toBe(false);
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1, snooze: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range probabilities and unknown choices", () => {
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 1.2, archive: -0.2, keep: 0, unsure: 0 },
      }).success,
    ).toBe(false);
    expect(ChoiceAnswerSchema.safeParse({ ...ok, choice: "snooze" }).success).toBe(false);
  });
});

describe("ScoreAnswerSchema", () => {
  it("accepts scores 0..4 and index-keyed probabilities", () => {
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 0 }).success).toBe(true);
    const probabilities = { "0": 0.1, "1": 0, "2": 0, "3": 0, "4": 0.9 };
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 4, probabilities }).success).toBe(true);
  });

  it("requires all five level keys when probabilities are present (zod 4 enum records are exhaustive)", () => {
    expect(
      ScoreAnswerSchema.safeParse({ type: "score", score: 4, probabilities: { "0": 0.1, "4": 0.9 } }).success,
    ).toBe(false);
  });

  it("rejects scores outside 0..4 and label-keyed probabilities", () => {
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 4.01 }).success).toBe(false);
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 1, probabilities: { High: 1 } }).success).toBe(
      false,
    );
  });
});

describe("NoulAnswerSchema", () => {
  it("accepts a probability and rejects anything else", () => {
    expect(NoulAnswerSchema.safeParse({ type: "noul", noul: 0.5 }).success).toBe(true);
    expect(NoulAnswerSchema.safeParse({ type: "noul", noul: 1.5 }).success).toBe(false);
    expect(NoulAnswerSchema.safeParse({ type: "noul", probabilities: { true: 1 } }).success).toBe(false);
  });
});

describe("normalizeDecisionResponse", () => {
  it("maps answers to a DecisionResult", () => {
    const result = normalizeDecisionResponse(deleteFixture, meta);
    expect(result.action.delete).toBeCloseTo(0.95, 9);
    expect(result.action.archive).toBeCloseTo(0.02, 9);
    expect(result.importance).toBeCloseTo(0.21, 9);
    expect(result.flags).toEqual({ isRecord: 0.03, isExpired: 0.91, isFromHuman: 0.01 });
    expect(result.responseModel).toBe("microsoft-decision-1");
    expect(result.modelVersion).toBe("decision-1/microsoft-decision-1");
    expect(result.inputTokens).toBe(520);
    expect(result.requestId).toBe("req-1");
    expect(result.latencyMs).toBe(12);
  });

  it("renormalizes probabilities to sum to 1", () => {
    const result = normalizeDecisionResponse(minimalFixture, meta);
    const sum = result.action.delete + result.action.archive + result.action.keep + result.action.unsure;
    expect(sum).toBeCloseTo(1, 9);
    expect(result.action.keep).toBeCloseTo(0.6 / 1.004, 9);
    expect(result.importance).toBeCloseTo(3.4, 9);
  });

  it("throws DecisionError invalid_response, not retryable, item scope", () => {
    try {
      normalizeDecisionResponse({ model: "microsoft-decision-1", answers: {} }, meta);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionError);
      const e = error as DecisionError;
      expect([e.kind, e.retryable, e.scope, e.requestId]).toEqual([
        "invalid_response",
        false,
        "item",
        "req-1",
      ]);
    }
  });
});
