import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "../env.ts";
import { newRequestId } from "../log.ts";
import { errorBody } from "./errors.ts";

/** Contracts 3.4: headers for Worker responses (/api/*, /oauth/*). */
export const workerSecureHeaders = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
  crossOriginOpenerPolicy: "same-origin",
});

export const apiResponseHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  if (c.res.headers.get("Content-Type")?.startsWith("application/json")) {
    c.header("Content-Type", "application/json; charset=utf-8");
  }
};

export const API_BODY_LIMIT_BYTES = 64 * 1024;

export const apiBodyLimit = bodyLimit({
  maxSize: API_BODY_LIMIT_BYTES,
  onError: (c) => c.json(errorBody("payload_too_large", "Request body is too large"), 413),
});

export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = newRequestId();
    c.set("requestId", requestId);
    c.set("deps", deps);
    await next();
    c.header("X-Request-Id", requestId);
  };
}
