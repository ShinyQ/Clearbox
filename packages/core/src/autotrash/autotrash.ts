import type { DecisionSegment } from "../fusion/segments.ts";
import { evaluateGuardrails } from "../guardrails/guardrails.ts";
import type { Ceiling, SuggestedAction } from "../model/actions.ts";
import { matchRecordPattern, type Policy } from "../policy/policy.ts";
import type { Signals } from "../signals/signals.ts";

/**
 * Auto-trash for trusted senders (contracts 12.11). Opt-in (policy.autoTrash); the nightly job trashes pending
 * trash suggestions of senders on "Always OK to trash" through the owner action path, undoable for 24 hours.
 */

/** Emails auto-trashed per UTC day, across all accounts and runs. */
export const AUTO_TRASH_DAILY_CAP = 500;

export interface AutoTrashCandidate {
  action: SuggestedAction | null;
  /** suggestions.segment (12.10): "rule" means the denylist matched and no cap applied or was lifted. */
  segment: DecisionSegment | null;
  /** suggestions.ceiling as stored at ingest or refresh. */
  ceiling: Ceiling;
  /** messages.signals_json as stored at ingest. */
  signals: Signals;
  receivedAt: number;
  subject: string;
  snippet: string;
}

export type AutoTrashBlock =
  | "not_trash"
  | "capped"
  | "starred"
  | "important"
  | "replied"
  | "correspondent"
  | "attachment"
  | "record"
  | "too_recent"
  | "not_listed";

const DAY_MS = 86_400_000;

/**
 * Null when the suggestion may be trashed automatically, else the first reason it may not. Every check is fail
 * closed and re-evaluated against the current policy, so a stale segment or a rule removed since the suggestion
 * was made never leads to an automatic trash. Unlike guardrails, the denylist lifts nothing here, and the
 * provider's "important" flag also blocks.
 */
export function autoTrashBlock(c: AutoTrashCandidate, policy: Policy, now: number): AutoTrashBlock | null {
  if (c.action !== "delete") return "not_trash";
  if (c.ceiling !== "delete") return "capped";
  const s = c.signals;
  if (s.starred) return "starred";
  if (s.providerImportant) return "important";
  if (s.ownerReplied) return "replied";
  if (s.isCorrespondent) return "correspondent";
  if (s.hasAttachments) return "attachment";
  if (matchRecordPattern(c.subject, c.snippet, policy.recordPatterns) !== null) return "record";
  if (c.receivedAt <= 0) return "too_recent";
  const ageDays = Math.max(0, Math.floor((now - c.receivedAt) / DAY_MS));
  if (ageDays < policy.minAgeDays) return "too_recent";
  const guard = evaluateGuardrails(
    { signals: { ...s, ageDays }, subject: c.subject, snippet: c.snippet },
    policy,
  );
  if (c.segment !== "rule" || !guard.denylisted || guard.allowlisted) return "not_listed";
  if (guard.ceiling !== "delete" || guard.liftedByDenylist === true) return "capped";
  return null;
}
