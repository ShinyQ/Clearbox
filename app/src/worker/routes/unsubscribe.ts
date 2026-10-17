import { Hono } from "hono";
import { UnsubscribeBodySchema } from "../../shared/api.ts";
import { unsubscribeSender } from "../actions/unsubscribe.ts";
import { decodeGroupKey } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";
import { actionContext } from "./actions.ts";

export const unsubscribeRoutes = new Hono<AppEnv>();

/** Contracts 12.8: POST /api/unsubscribe, owner-initiated RFC 8058 one-click for the group's sender. */
unsubscribeRoutes.post("/unsubscribe", async (c) => {
  const body = parseWith(UnsubscribeBodySchema, await readJsonBody(c));
  const decoded = decodeGroupKey(body.groupKey);
  if (!decoded) throw new ApiError(400, "validation_failed", "Malformed group key");
  if (decoded.sender === "")
    throw new ApiError(400, "validation_failed", "Unknown senders cannot be unsubscribed from");
  return c.json(await unsubscribeSender(actionContext(c), decoded.accountId, decoded.sender));
});
