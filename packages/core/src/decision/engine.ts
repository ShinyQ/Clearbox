import type { ActionDistribution } from "../model/actions.ts";
import type { DecisionState } from "./state.ts";

export interface DecisionFlags {
  isRecord: number;
  isExpired: number;
  isFromHuman: number;
}

export interface DecisionResult {
  /** From answers.action.probabilities, renormalized to sum exactly 1. */
  action: ActionDistribution;
  /** answers.importance.score, 0..4. */
  importance: number;
  flags: DecisionFlags;
  /** e.g. "microsoft-decision-1". */
  responseModel: string;
  /** `${deployment}/${responseModel}`; FakeEngine: "fake/fake-1". */
  modelVersion: string;
  inputTokens: number;
  /** apim-request-id header. */
  requestId: string | null;
  latencyMs: number;
}

export interface DecisionInput {
  /** Correlation key, e.g. providerMessageId. */
  key: string;
  state: DecisionState;
  seed: number;
}

export interface DecisionEngine {
  readonly name: "mai" | "fake";
  /** Throws DecisionError. Never retries internally (retries happen on a later tick). */
  decide(input: DecisionInput): Promise<DecisionResult>;
}
