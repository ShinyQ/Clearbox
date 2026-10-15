import { Hono } from "hono";
import { z } from "zod";
import { ActivityQuerySchema } from "../../shared/api.ts";
import type { ActivityEntry, Page } from "../../shared/api.ts";
import { mapActivity, selectActivityStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { decodeCursor, encodeCursor } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";

export const activityRoutes = new Hono<AppEnv>();

const CursorSchema = z.strictObject({ v: z.literal(1), f: z.string(), id: z.int().positive() });

activityRoutes.get("/", async (c) => {
  const q = parseWith(ActivityQuerySchema, c.req.query());
  const fingerprint = q.accountId ?? "";
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, CursorSchema);
  if (cursor && cursor.f !== fingerprint)
    throw new ApiError(400, "validation_failed", "Cursor does not match the filters");
  const rows = (
    await selectActivityStmt(c.env.DB, {
      accountId: q.accountId ?? null,
      beforeId: cursor?.id ?? null,
      limit: q.limit + 1,
    }).run<AuditRow>()
  ).results;
  const items = rows.slice(0, q.limit).map(mapActivity);
  const last = items[items.length - 1];
  const page: Page<ActivityEntry> = {
    items,
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: 1, f: fingerprint, id: last.id }) : null,
  };
  return c.json(page);
});
