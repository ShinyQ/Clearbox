import { placeholders } from "./sql.ts";
import type { SqlQuery } from "./sql.ts";

/** contracts 12.10: owner decisions needed on one sender before a rule is offered. */
export const RULE_MIN_DECISIONS = 10;
/** Share of decisions that must match the offered rule. */
export const RULE_MIN_AGREEMENT = 0.95;
/** No contrary decision within this window. */
export const RULE_QUIET_MS = 30 * 86_400_000;
export const RULE_CANDIDATES_MAX = 50;
export const RULE_SUGGESTIONS_MAX = 10;
export const RULE_DISMISSALS_MAX = 200;

/**
 * Cheap prefilter on the per-sender prior counts (one row per sender): enough trashes with few keeps, or enough
 * keeps with no trash. Sender keys only (domain keys start with "@").
 */
export function ruleCandidatesQuery(accountIds: readonly string[], minDecisions: number): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT key AS sender, SUM(deletes) AS deletes, SUM(keeps) AS keeps FROM sender_priors
    WHERE account_id IN (${placeholders(a)}) AND key NOT LIKE '@%' AND key <> ''
    GROUP BY key
    HAVING (SUM(deletes) >= ?${a + 1} AND SUM(keeps) * 19 <= SUM(deletes))
        OR (SUM(keeps) >= ?${a + 1} AND SUM(deletes) = 0)
    ORDER BY SUM(deletes) + SUM(keeps) DESC, key
    LIMIT ?${a + 2}`;
  return { sql, params: [...accountIds, minDecisions, RULE_CANDIDATES_MAX] };
}

export interface RuleLabelRow {
  sender: string;
  deletes: number;
  keeps: number;
  archives: number;
  last_at: number;
  last_not_delete: number | null;
  last_not_keep: number | null;
}

/** The labels are the source of truth (undo rewrites a label to keep); uses labels_account_sender. */
export function ruleLabelsQuery(accountIds: readonly string[], senders: readonly string[]): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT sender, SUM(owner_action = 'delete') AS deletes, SUM(owner_action = 'keep') AS keeps,
      SUM(owner_action = 'archive') AS archives, MAX(created_at) AS last_at,
      MAX(CASE WHEN owner_action <> 'delete' THEN updated_at END) AS last_not_delete,
      MAX(CASE WHEN owner_action <> 'keep' THEN updated_at END) AS last_not_keep
    FROM labels
    WHERE account_id IN (${placeholders(a)}) AND sender IN (${placeholders(senders.length, a + 1)})
    GROUP BY sender`;
  return { sql, params: [...accountIds, ...senders] };
}
