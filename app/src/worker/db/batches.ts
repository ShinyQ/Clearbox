export type BatchKind = "approve" | "override" | "cleanup";

export interface BatchRow {
  id: number;
  created_at: number;
  kind: BatchKind;
  suggestion_ids_json: string;
  requested_count: number;
  executed_count: number;
  failed_count: number;
  undo_expires_at: number;
  undone_at: number | null;
}

export interface ActionBatch {
  id: number;
  createdAt: number;
  kind: BatchKind;
  suggestionIds: number[];
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  undoExpiresAt: number;
  undoneAt: number | null;
}

export function mapBatch(row: BatchRow): ActionBatch {
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    suggestionIds: JSON.parse(row.suggestion_ids_json) as number[],
    requestedCount: row.requested_count,
    executedCount: row.executed_count,
    failedCount: row.failed_count,
    undoExpiresAt: row.undo_expires_at,
    undoneAt: row.undone_at,
  };
}

export interface NewBatch {
  kind: BatchKind;
  /** Executed suggestion ids (message ids), at most 100. */
  suggestionIds: readonly number[];
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  createdAt: number;
  undoExpiresAt: number;
}

export function insertBatchStmt(db: D1Database, b: NewBatch): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO action_batches (created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    )
    .bind(
      b.createdAt,
      b.kind,
      JSON.stringify(b.suggestionIds),
      b.requestedCount,
      b.executedCount,
      b.failedCount,
      b.undoExpiresAt,
    );
}

export async function getBatch(db: D1Database, id: number): Promise<ActionBatch | null> {
  const row = await db.prepare("SELECT * FROM action_batches WHERE id = ?1").bind(id).first<BatchRow>();
  return row ? mapBatch(row) : null;
}

export function listBatchesStmt(
  db: D1Database,
  opts: { since: number; beforeId: number | null; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      "SELECT * FROM action_batches WHERE created_at >= ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3",
    )
    .bind(opts.since, opts.beforeId, opts.limit);
}

/** One-shot undo claim (decision 10). */
export function claimUndoStmt(db: D1Database, id: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE action_batches SET undone_at = ?2 WHERE id = ?1 AND undone_at IS NULL AND undo_expires_at > ?2 AND executed_count > 0 RETURNING id",
    )
    .bind(id, now);
}

export function resetUndoStmt(db: D1Database, id: number, undoneAt: number): D1PreparedStatement {
  return db
    .prepare("UPDATE action_batches SET undone_at = NULL WHERE id = ?1 AND undone_at = ?2")
    .bind(id, undoneAt);
}
