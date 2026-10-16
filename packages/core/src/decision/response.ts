import { z } from "zod";
import type { ActionDistribution } from "../model/actions.ts";
import { DecisionError } from "../model/errors.ts";
import type { DecisionResult } from "./engine.ts";

const prob = z.number().finite().min(0).max(1);
const sumsToOne = (r: Record<string, number>) =>
  Math.abs(Object.values(r).reduce((s, p) => s + p, 0) - 1) <= 0.01;

export const ChoiceAnswerSchema = z.looseObject({
  type: z.literal("choice"),
  choice: z.enum(["delete", "archive", "keep", "unsure"]),
  confidence: prob.optional(),
  probabilities: z.strictObject({ delete: prob, archive: prob, keep: prob, unsure: prob }).refine(sumsToOne),
});

export const ScoreAnswerSchema = z.looseObject({
  type: z.literal("score"),
  score: z.number().finite().min(0).max(4),
  confidence: prob.optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.enum(["0", "1", "2", "3", "4"]), prob).optional(),
});

export const NoulAnswerSchema = z.looseObject({ type: z.literal("noul"), noul: prob });

export const DecisionResponseSchema = z.looseObject({
  model: z.string().min(1),
  answers: z.looseObject({
    action: ChoiceAnswerSchema,
    importance: ScoreAnswerSchema,
    is_record: NoulAnswerSchema,
    is_expired: NoulAnswerSchema,
    is_from_human: NoulAnswerSchema,
  }),
  usage: z.looseObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative().optional(),
  }),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export interface NormalizeMeta {
  /** AZURE_DECISION_DEPLOYMENT, used for modelVersion. */
  deployment: string;
  requestId: string | null;
  latencyMs: number;
}

function renormalize(p: {
  delete: number;
  archive: number;
  keep: number;
  unsure: number;
}): ActionDistribution {
  const sum = p.delete + p.archive + p.keep + p.unsure;
  return { delete: p.delete / sum, archive: p.archive / sum, keep: p.keep / sum, unsure: p.unsure / sum };
}

/**
 * Validates a parsed response body against DecisionResponseSchema and maps it to a DecisionResult.
 * Throws DecisionError("invalid_response") on any validation failure. `confidence` is never used.
 */
export function normalizeDecisionResponse(body: unknown, meta: NormalizeMeta): DecisionResult {
  const parsed = DecisionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DecisionError({
      kind: "invalid_response",
      status: 200,
      requestId: meta.requestId,
      message: "Decision-1 response failed validation",
    });
  }
  const { answers, model, usage } = parsed.data;
  return {
    action: renormalize(answers.action.probabilities),
    importance: answers.importance.score,
    flags: {
      isRecord: answers.is_record.noul,
      isExpired: answers.is_expired.noul,
      isFromHuman: answers.is_from_human.noul,
    },
    responseModel: model,
    modelVersion: `${meta.deployment}/${model}`,
    inputTokens: usage.input_tokens,
    requestId: meta.requestId,
    latencyMs: meta.latencyMs,
  };
}
