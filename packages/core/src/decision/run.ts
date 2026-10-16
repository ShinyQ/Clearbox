import { DecisionError } from "../model/errors.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";

export type DecisionOutcome =
  { key: string; ok: true; result: DecisionResult } | { key: string; ok: false; error: DecisionError };

function toDecisionError(error: unknown): DecisionError {
  return error instanceof DecisionError ? error : new DecisionError({ kind: "network", cause: error });
}

/** Runs at most `concurrency` decide() calls at once; never rejects; preserves input order. Non-DecisionError throws become kind "network". */
export async function decideAll(
  engine: DecisionEngine,
  inputs: readonly DecisionInput[],
  concurrency: number,
): Promise<DecisionOutcome[]> {
  return mapWithConcurrency(inputs, Math.max(1, concurrency), async (input): Promise<DecisionOutcome> => {
    try {
      return { key: input.key, ok: true, result: await engine.decide(input) };
    } catch (error) {
      return { key: input.key, ok: false, error: toDecisionError(error) };
    }
  });
}
