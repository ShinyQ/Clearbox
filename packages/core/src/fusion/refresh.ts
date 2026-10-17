import type { DecisionFlags, DecisionResult } from "../decision/engine.ts";
import { evaluateGuardrails, type GuardrailResult } from "../guardrails/guardrails.ts";
import { minCeiling, type ActionDistribution, type Ceiling } from "../model/actions.ts";
import type { Policy } from "../policy/policy.ts";
import { selectPrior, type Prior, type PriorCounts } from "../priors/priors.ts";
import type { Signals } from "../signals/signals.ts";
import { fuse, type Suggestion, type Thresholds } from "./fusion.ts";

const DAY_MS = 86_400_000;

/**
 * contracts 12.10, "Leave recent emails alone": epoch ms at which an email is old enough to be decided, or null when
 * it is not held (date unknown, the setting is Off, or it is already old enough). Consistent with guardrail 4:
 * ageDays < minAgeDays exactly while now < receivedAt + minAgeDays days.
 */
export function holdUntil(receivedAt: number, minAgeDays: number, now: number): number | null {
  if (receivedAt <= 0 || minAgeDays <= 0) return null;
  const until = receivedAt + minAgeDays * DAY_MS;
  return now < until ? until : null;
}

/** The raw Decision-1 output kept on a suggestion (suggestions.model_action_json plus flags and importance). */
export interface StoredModel {
  action: ActionDistribution;
  flags: DecisionFlags;
  importance: number;
  modelVersion: string;
}

export interface RefreshInput {
  model: StoredModel;
  /** messages.signals_json as stored at ingest. */
  signals: Signals;
  receivedAt: number;
  subject: string;
  snippet: string;
  /** suggestions.ceiling: a refresh can lower the ceiling, never raise it. */
  storedCeiling: Ceiling;
  policy: Policy;
  senderPrior: PriorCounts | null;
  domainPrior: PriorCounts | null;
  thresholds: Thresholds;
  now: number;
}

export interface RefreshResult {
  suggestion: Suggestion;
  guard: GuardrailResult;
  prior: Prior;
}

/**
 * Re-fuses a pending suggestion with the current priors, policy and thresholds without calling the model again.
 * Guardrails are recomputed (age from receivedAt), then capped by the stored ceiling, so a refresh never lifts a
 * cap (for example a record pattern found in a snippet that is no longer stored).
 */
export function refreshSuggestion(input: RefreshInput): RefreshResult {
  const ageDays =
    input.receivedAt <= 0 ? 0 : Math.max(0, Math.floor((input.now - input.receivedAt) / DAY_MS));
  const signals: Signals = { ...input.signals, ageDays };
  const computed = evaluateGuardrails(
    { signals, subject: input.subject, snippet: input.snippet },
    input.policy,
  );
  const ceiling = minCeiling(computed.ceiling, input.storedCeiling);
  const guard: GuardrailResult = ceiling === computed.ceiling ? computed : { ...computed, ceiling };
  const prior = selectPrior(
    input.senderPrior,
    input.domainPrior,
    signals.senderAddress,
    signals.senderDomain,
  );
  const model: DecisionResult = {
    action: input.model.action,
    importance: input.model.importance,
    flags: input.model.flags,
    responseModel: "",
    modelVersion: input.model.modelVersion,
    inputTokens: 0,
    requestId: null,
    latencyMs: 0,
  };
  const suggestion = fuse({ model, prior, guard, signals, thresholds: input.thresholds });
  return { suggestion, guard, prior };
}
