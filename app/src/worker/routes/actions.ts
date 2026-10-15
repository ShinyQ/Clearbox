import type { ActionKind } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { routePath } from "hono/route";
import {
  ApproveBodySchema,
  CleanupBodySchema,
  CleanupPreviewQuerySchema,
  OverrideBodySchema,
} from "../../shared/api.ts";
import type { CleanupPreview } from "../../shared/api.ts";
import { cleanupAccountIds, executeSuggestions } from "../actions/execute.ts";
import type { ActionContext } from "../actions/execute.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, isoToMs, toIso } from "../db/sql.ts";
import {
  cleanupCountsQuery,
  decodeGroupKey,
  groupsLeftQuery,
  pendingByActionQuery,
} from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";
import { loadVisibleAccount } from "./accounts.ts";
import { CLEANUP_DEFAULT_ACTIONS, scopeAccounts } from "./queue.ts";

export const actionsRoutes = new Hono<AppEnv>();

export function actionContext(c: Context<AppEnv>): ActionContext {
  return {
    db: c.env.DB,
    config: c.get("config"),
    deps: c.get("deps"),
    requestId: c.get("requestId"),
    origin: new URL(c.req.url).origin,
    route: routePath(c),
  };
}

/** Decision 29: default delete + archive; keep only on its own ("Confirm all keeps"). */
export function resolveCleanupActions(actions: readonly ActionKind[] | undefined): ActionKind[] {
  if (actions === undefined || actions.length === 0) return [...CLEANUP_DEFAULT_ACTIONS];
  const unique = [...new Set(actions)];
  if (unique.includes("keep") && unique.length > 1) {
    throw new ApiError(400, "validation_failed", "Keep suggestions are confirmed on their own", {
      details: [{ path: "actions", message: "keep cannot be combined with delete or archive" }],
    });
  }
  return unique;
}

actionsRoutes.post("/approve", async (c) => {
  const body = parseWith(ApproveBodySchema, await readJsonBody(c));
  const ctx = actionContext(c);
  if ("ids" in body) return c.json(await executeSuggestions(ctx, { kind: "approve_ids", ids: body.ids }));
  const decoded = decodeGroupKey(body.groupKey);
  if (!decoded) throw new ApiError(400, "validation_failed", "Malformed group key");
  if (decoded.action === "unsure") {
    throw new ApiError(
      400,
      "validation_failed",
      "Unsure groups cannot be approved; choose an action with override",
    );
  }
  await loadVisibleAccount(ctx.db, decoded.accountId);
  return c.json(
    await executeSuggestions(ctx, {
      kind: "approve_group",
      accountId: decoded.accountId,
      sender: decoded.sender,
      action: decoded.action,
      asOf: isoToMs(body.asOf),
    }),
  );
});

actionsRoutes.post("/override", async (c) => {
  const body = parseWith(OverrideBodySchema, await readJsonBody(c));
  return c.json(
    await executeSuggestions(actionContext(c), { kind: "override", ids: body.ids, action: body.action }),
  );
});

actionsRoutes.get("/cleanup/preview", async (c) => {
  const q = parseWith(CleanupPreviewQuerySchema, c.req.query());
  const db = c.env.DB;
  const settings = await readSettings(db);
  const threshold = q.threshold ?? settings.tauDelete;
  const actions = resolveCleanupActions(q.actions?.split(",") as ActionKind[] | undefined);
  const accounts = await scopeAccounts(db, q.accountId);
  const ids = cleanupAccountIds(accounts, actions, null);
  // Accounts outside the Clean up scope (inactive, for delete/archive) keep every pending group.
  const excluded = accounts.filter((a) => !ids.includes(a.id)).map((a) => a.id);
  const byAction: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  let groups = 0;
  let groupsLeft = 0;
  const stmts: D1PreparedStatement[] = [];
  if (ids.length > 0) {
    stmts.push(
      bindQuery(db, cleanupCountsQuery(ids, actions, threshold)),
      bindQuery(db, groupsLeftQuery(ids, actions, threshold)),
    );
  }
  if (excluded.length > 0) stmts.push(bindQuery(db, pendingByActionQuery(excluded)));
  const results = stmts.length > 0 ? await db.batch(stmts) : [];
  if (ids.length > 0) {
    const [counts, left] = results;
    for (const row of (counts?.results ?? []) as { action: ActionKind; n: number; g: number }[]) {
      byAction[row.action] = row.n;
      groups += row.g;
    }
    groupsLeft = ((left?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  }
  if (excluded.length > 0) {
    for (const row of (results[results.length - 1]?.results ?? []) as { g: number }[]) groupsLeft += row.g;
  }
  const body: CleanupPreview = {
    asOf: toIso(c.get("deps").now()),
    threshold,
    defaultThreshold: settings.tauDelete,
    count: byAction.delete + byAction.archive + byAction.keep,
    byAction,
    groups,
    groupsLeft,
  };
  return c.json(body);
});

actionsRoutes.post("/cleanup", async (c) => {
  const body = parseWith(CleanupBodySchema, await readJsonBody(c));
  const ctx = actionContext(c);
  const actions = resolveCleanupActions(body.actions);
  const threshold = body.threshold ?? (await readSettings(ctx.db)).tauDelete;
  return c.json(
    await executeSuggestions(ctx, {
      kind: "cleanup",
      actions,
      threshold,
      accountId: body.accountId ?? null,
      asOf: isoToMs(body.asOf),
    }),
  );
});
