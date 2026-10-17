import type { ActionKind, Ceiling, DecisionSegment, SuggestedAction } from "@clearbox/core";
import { placeholders } from "./sql.ts";

export type LabelSource = "approve" | "override" | "cleanup" | "undo";

export interface LabelInsert {
  messageId: number | null;
  sender: string;
  senderDomain: string;
  /** <= LABEL_SUBJECT_MAX_CHARS; null when policy.labelSubjects is false. */
  subjectTrunc: string | null;
  suggestedAction: SuggestedAction;
  ownerAction: ActionKind;
  source: LabelSource;
  pDelete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  /** contracts 12.10; omitted (NULL) when unknown. */
  segment?: DecisionSegment | null;
  modelVersion: string | null;
  policyVersion: number;
  now: number;
}

export function insertLabelStmt(db: D1Database, accountId: string, l: LabelInsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action, owner_action,
         source, p_delete, margin, ceiling, model_version, policy_version, created_at, updated_at, segment)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15)`,
    )
    .bind(
      accountId,
      l.messageId,
      l.sender,
      l.senderDomain,
      l.subjectTrunc,
      l.suggestedAction,
      l.ownerAction,
      l.source,
      l.pDelete,
      l.margin,
      l.ceiling,
      l.modelVersion,
      l.policyVersion,
      l.now,
      l.segment ?? null,
    );
}

/** Contracts 7.8: a restored item's label becomes keep / undo. */
export function undoLabelStmt(
  db: D1Database,
  accountId: string,
  labelId: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE labels SET owner_action = 'keep', source = 'undo', updated_at = ?3 WHERE account_id = ?1 AND id = ?2",
    )
    .bind(accountId, labelId, now);
}

export function labelStatsStmt(
  db: D1Database,
  accountIds: readonly string[],
  since: number,
): D1PreparedStatement {
  const n = accountIds.length;
  return db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?${n + 1}), 0) AS recent
       FROM labels WHERE account_id IN (${placeholders(n)})`,
    )
    .bind(...accountIds, since);
}

/** Contracts 7.10: among the newest `window` labels with suggested_action = 'delete'. */
export function deletePrecisionStmt(
  db: D1Database,
  accountIds: readonly string[],
  window: number,
): D1PreparedStatement {
  const n = accountIds.length;
  return db
    .prepare(
      `SELECT COUNT(*) AS decided, COALESCE(SUM(owner_action = 'delete'), 0) AS deleted FROM (
         SELECT owner_action FROM labels
         WHERE account_id IN (${placeholders(n)}) AND suggested_action = 'delete'
         ORDER BY id DESC LIMIT ?${n + 1}
       )`,
    )
    .bind(...accountIds, window);
}
