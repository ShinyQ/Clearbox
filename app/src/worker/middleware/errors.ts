import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { z } from "zod";
import { routePath } from "hono/route";
import type { ApiErrorBody, ApiErrorCode } from "../../shared/api.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";

export interface ApiErrorOptions {
  details?: unknown;
  retryAt?: string;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly retryAt: string | null;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAt = options.retryAt ?? null;
  }
}

export function errorBody(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}): ApiErrorBody {
  const error: ApiErrorBody["error"] = { code, message };
  if (options.details !== undefined) error.details = options.details;
  if (options.retryAt !== undefined) error.retryAt = options.retryAt;
  return { error };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, "validation_failed", "Request validation failed", {
      details: zodIssues(parsed.error),
    });
  }
  return parsed.data;
}

export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err) {
    // hono/body-limit errors the body stream with BodyLimitError; rethrow so it answers 413.
    if (err instanceof Error && err.name === "BodyLimitError") throw err;
    throw new ApiError(400, "validation_failed", "Request body must be JSON");
  }
}

export function apiErrorResponse(c: Context<AppEnv>, err: ApiError): Response {
  const options: ApiErrorOptions = {};
  if (err.details !== undefined) options.details = err.details;
  if (err.retryAt !== null) options.retryAt = err.retryAt;
  return c.json(errorBody(err.code, err.message, options), err.status);
}

export function onApiError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) return apiErrorResponse(c, err);
  if (err instanceof ZodError) {
    return c.json(
      errorBody("validation_failed", "Request validation failed", { details: zodIssues(err) }),
      400,
    );
  }
  // Contracts 9 request.error: the error name only, never its message (it may contain mail data).
  logEvent("request.error", { requestId: c.get("requestId"), route: routePath(c), errorName: err.name });
  return c.json(errorBody("internal", "Internal error"), 500);
}

export function notFoundHandler(c: Context<AppEnv>): Response {
  return c.json(errorBody("not_found", "Not found"), 404);
}
