/** Actions the owner can execute. */
export type ActionKind = "delete" | "archive" | "keep";
/** Actions the system can suggest. */
export type SuggestedAction = ActionKind | "unsure";
/** Highest action the guardrails allow. */
export type Ceiling = ActionKind;

export const ACTION_KINDS = ["delete", "archive", "keep"] as const;
export const SUGGESTED_ACTIONS = ["delete", "archive", "keep", "unsure"] as const;

/** keep < archive < delete. "unsure" is not ranked and is always allowed. */
export const ACTION_RANK: Readonly<Record<ActionKind, number>> = { keep: 0, archive: 1, delete: 2 };

export function isAllowedByCeiling(action: SuggestedAction, ceiling: Ceiling): boolean {
  return action === "unsure" || ACTION_RANK[action] <= ACTION_RANK[ceiling];
}

export function minCeiling(a: Ceiling, b: Ceiling): Ceiling {
  return ACTION_RANK[a] <= ACTION_RANK[b] ? a : b;
}

/** Probability per suggested action; values in [0,1], sum 1 (tolerance 1e-9 after normalization). */
export type ActionDistribution = Record<SuggestedAction, number>;
