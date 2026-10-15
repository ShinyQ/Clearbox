import { BATCH_RETENTION_MS } from "@clearbox/core";
import type { ActionKind } from "@clearbox/core";
import { Hono } from "hono";
import { z } from "zod";
import { PageQuerySchema } from "../../shared/api.ts";
import type { ActionBatchView, Page } from "../../shared/api.ts";
import { undoBatch } from "../actions/undo.ts";
import { selectBatchAuditStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { listBatchesStmt, mapBatch } from "../db/batches.ts";
import type { ActionBatch, BatchRow } from "../db/batches.ts";
import { chunk, decodeCursor, encodeCursor, MAX_BOUND_PARAMS, toIso, toIsoOrNull } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";
import { actionContext } from "./actions.ts";

export const batchesRoutes = new Hono<AppEnv>();

const CursorSchema = z.strictObject({ v: z.literal(1), id: z.int().positive() });

export function toBatchView(batch: ActionBatch, audit: AuditRow | undefined, now: number): ActionBatchView {
  const result = audit ? (JSON.parse(audit.result_json) as Record<string, unknown>) : {};
  const num = (k: ActionKind) => (typeof result[k] === "number" ? (result[k] as number) : 0);
  return {
    id: batch.id,
    kind: batch.kind,
    createdAt: toIso(batch.createdAt),
    requestedCount: batch.requestedCount,
    executedCount: batch.executedCount,
    failedCount: batch.failedCount,
    byAction: { delete: num("delete"), archive: num("archive"), keep: num("keep") },
    undoable: now < batch.undoExpiresAt && batch.undoneAt === null && batch.executedCount > 0,
    undoExpiresAt: toIso(batch.undoExpiresAt),
    undoneAt: toIsoOrNull(batch.undoneAt),
  };
}

batchesRoutes.get("/", async (c) => {
  const q = parseWith(PageQuerySchema, c.req.query());
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, CursorSchema);
  const db = c.env.DB;
  const now = c.get("deps").now();
  const rows = (
    await listBatchesStmt(db, {
      since: now - BATCH_RETENTION_MS,
      beforeId: cursor?.id ?? null,
      limit: q.limit + 1,
    }).run<BatchRow>()
  ).results;
  const batches = rows.slice(0, q.limit).map(mapBatch);
  const audits = new Map<number, AuditRow>();
  if (batches.length > 0) {
    // A full page (100) exceeds one statement's bound parameters.
    const stmts = chunk(
      batches.map((b) => b.id),
      MAX_BOUND_PARAMS,
    ).map((ids) => selectBatchAuditStmt(db, ids));
    for (const res of await db.batch<AuditRow>(stmts))
      for (const a of res.results) if (a.batch_id !== null) audits.set(a.batch_id, a);
  }
  const last = batches[batches.length - 1];
  const page: Page<ActionBatchView> = {
    items: batches.map((b) => toBatchView(b, audits.get(b.id), now)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: 1, id: last.id }) : null,
  };
  return c.json(page);
});

batchesRoutes.post("/:id/undo", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(404, "not_found", "Batch not found");
  return c.json(await undoBatch(actionContext(c), id));
});
