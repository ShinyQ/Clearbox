import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Hono } from "hono";
import { CSRF_HEADER, CSRF_VALUE } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import type { AppEnv } from "../../../src/worker/env.ts";
import { signAccessJwt } from "./access.ts";

export const TEST_ORIGIN = "https://clearbox.example.test";

export interface ApiFetchOptions {
  /** undefined: a valid owner JWT; null: no header; string: that token. */
  jwt?: string | null;
  /** undefined: "1" on mutations; null: no header; string: that value. */
  csrf?: string | null;
  /** Use this app (for injected deps or test-only routes) instead of the deployed entry. */
  app?: Hono<AppEnv>;
  /** Override bindings for this request (forces the createApp path). */
  env?: Readonly<Record<string, unknown>>;
  origin?: string;
}

interface FetchEntry {
  default: { fetch(request: Request): Promise<Response> };
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts: ApiFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const jwt = opts.jwt === undefined ? await signAccessJwt() : opts.jwt;
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  const csrf =
    opts.csrf === undefined ? (method === "GET" || method === "HEAD" ? null : CSRF_VALUE) : opts.csrf;
  if (csrf !== null) headers.set(CSRF_HEADER, csrf);
  if (init.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`${opts.origin ?? TEST_ORIGIN}${path}`, {
    ...init,
    method,
    headers,
    redirect: "manual",
  });
  if (opts.app === undefined && opts.env === undefined) {
    return (exports as unknown as FetchEntry).default.fetch(request);
  }
  const app = opts.app ?? createApp();
  const ctx = createExecutionContext();
  const response = await app.fetch(request, { ...env, ...opts.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function jsonInit(method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}
