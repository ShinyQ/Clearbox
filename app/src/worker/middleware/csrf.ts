import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { CSRF_HEADER, CSRF_VALUE } from "../../shared/api.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "./errors.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    logEvent("access.denied", { reason: "csrf", route: routePath(c) });
    throw new ApiError(403, "csrf_required", "Missing CSRF header");
  }
  await next();
};
