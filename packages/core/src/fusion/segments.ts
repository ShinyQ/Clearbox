import type { GuardrailResult } from "../guardrails/guardrails.ts";
import { PRIOR_MIN_N } from "../model/constants.ts";
import type { Prior } from "../priors/priors.ts";
import type { Signals } from "../signals/signals.ts";

/**
 * Accuracy and learning (contracts 12.10). Each suggestion belongs to exactly one segment, picked in this order:
 * - rule:   sender is on "Always OK to trash", nothing capped the email and the denylist lifted no cap
 * - sender: a sender prior with at least PRIOR_MIN_N owner decisions
 * - domain: a domain prior with at least PRIOR_MIN_N owner decisions
 * - bulk:   no strong prior, but list or bulk headers or a bulk category
 * - other:  everything else
 * The trash threshold is calibrated per segment (rule skips the confidence check).
 */
export const DECISION_SEGMENTS = ["rule", "sender", "domain", "bulk", "other"] as const;
export type DecisionSegment = (typeof DECISION_SEGMENTS)[number];

export const CALIBRATED_SEGMENTS = ["sender", "domain", "bulk", "other"] as const;
export type CalibratedSegment = (typeof CALIBRATED_SEGMENTS)[number];

/** Per-segment trash threshold: a number, null when the segment is paused (no trash suggestions). */
export type SegmentTaus = Readonly<Partial<Record<CalibratedSegment, number | null>>>;

const BULK_CATEGORIES: ReadonlySet<string> = new Set(["promotions", "social", "updates", "forums"]);

export function isBulkMail(s: Signals): boolean {
  return (
    s.hasListUnsubscribe ||
    s.hasListId ||
    s.precedenceBulk ||
    (s.category !== null && BULK_CATEGORIES.has(s.category))
  );
}

export function decisionSegment(prior: Prior, signals: Signals, guard: GuardrailResult): DecisionSegment {
  if (guard.denylisted && guard.ceiling === "delete" && guard.liftedByDenylist !== true) return "rule";
  if (prior.n >= PRIOR_MIN_N && prior.source === "sender") return "sender";
  if (prior.n >= PRIOR_MIN_N && prior.source === "domain") return "domain";
  return isBulkMail(signals) ? "bulk" : "other";
}

/**
 * Trash threshold for a segment: 0 for rule (no confidence check), the segment's calibrated value (null =
 * paused), else the global tauDelete.
 */
export function segmentTau(
  segment: DecisionSegment,
  tauDelete: number,
  taus: SegmentTaus | undefined,
): number | null {
  if (segment === "rule") return 0;
  const value = taus?.[segment];
  return value === undefined ? tauDelete : value;
}
