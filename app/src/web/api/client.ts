import type { z } from "zod";
import { CSRF_HEADER, CSRF_VALUE, type ApiErrorBody, type ApiErrorCode } from "../../shared/api.ts";
import { reportBug } from "../lib/report.ts";

export type ApiErrorKind = ApiErrorCode | "network" | "invalid_response";
export type SessionError = "unauthenticated" | "forbidden" | "access_misconfigured";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorKind;
  readonly retryAt: string | undefined;
  readonly details: unknown;
  constructor(status: number, code: ApiErrorKind, message: string, retryAt?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
    this.details = details;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(cb: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const cb of [...subs]) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Read by the root layout (UI spec 5.9). */
export const sessionErrorStore = createStore<SessionError | null>(null);
/** Consecutive network failures; two or more means offline (UI spec 5.9). */
export const networkFailureStore = createStore<number>(0);

type Params = Record<string, string | number | null | undefined>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function buildUrl(path: string, params?: Params): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function publishSessionError(status: number, code: ApiErrorKind): void {
  if (status === 401) sessionErrorStore.set("unauthenticated");
  else if (status === 403 && code === "forbidden") sessionErrorStore.set("forbidden");
  else if (code === "access_misconfigured") sessionErrorStore.set("access_misconfigured");
}

async function toApiError(res: Response, label: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  const e = body?.error;
  const code: ApiErrorKind = e?.code ?? (res.status >= 500 ? "internal" : "invalid_response");
  publishSessionError(res.status, code);
  if (code === "csrf_required") reportBug(`CSRF header rejected on ${label}`);
  return new ApiError(res.status, code, e?.message ?? `HTTP ${res.status}`, e?.retryAt, e?.details);
}

async function request<S extends z.ZodType>(
  method: Method,
  url: string,
  label: string,
  schema: S,
  init: RequestInit,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, method, credentials: "same-origin", redirect: "manual" });
  } catch {
    networkFailureStore.set(networkFailureStore.get() + 1);
    throw new ApiError(0, "network", "Network error");
  }
  networkFailureStore.set(0);
  if (res.type === "opaqueredirect") {
    // Cloudflare Access redirects expired sessions to its login page (decision W21).
    publishSessionError(401, "unauthenticated");
    throw new ApiError(401, "unauthenticated", "Session expired");
  }
  if (!res.ok) throw await toApiError(res, label);
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    reportBug(`Unexpected response from ${label}`, parsed.error.issues);
    throw new ApiError(res.status, "invalid_response", "Unexpected response");
  }
  return parsed.data;
}

export function apiGet<S extends z.ZodType>(path: string, schema: S, params?: Params): Promise<z.output<S>> {
  return request("GET", buildUrl(path, params), `GET ${path}`, schema, {
    headers: { Accept: "application/json" },
  });
}

export function apiSend<S extends z.ZodType>(
  method: Exclude<Method, "GET">,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const headers: Record<string, string> = { Accept: "application/json", [CSRF_HEADER]: CSRF_VALUE };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return request(method, buildUrl(path), `${method} ${path}`, schema, {
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
