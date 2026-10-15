import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { ApiError, parseWith, readJsonBody } from "../../../src/worker/middleware/errors.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/boom", () => {
    throw new Error("secret detail owner@example.test");
  });
  app.get("/api/test/busy", () => {
    throw new ApiError(409, "account_busy", "Account is busy", { retryAt: "2026-10-15T10:05:00.000Z" });
  });
  app.post("/api/test/validate", async (c) => {
    const body = parseWith(z.strictObject({ n: z.int() }), await readJsonBody(c));
    return c.json(body);
  });
  return app;
}

describe("error envelope and headers", () => {
  it("returns not_found for unknown API paths", async () => {
    const res = await apiFetch("/api/nope", {}, { app: testApp() });
    expect(res.status).toBe(404);
    expect(await readJson<ApiErrorBody>(res)).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("sets security, cache and request id headers on every API response", async () => {
    const res = await apiFetch("/api/nope", {}, { app: testApp() });
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps unexpected errors to 500 internal without leaking details", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await apiFetch("/api/test/boom", {}, { app: testApp() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(text).not.toContain("secret");
    expect(res.headers.get("X-Request-Id")).not.toBeNull();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const logged = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l["evt"] === "request.error");
    expect(logged).toMatchObject({ requestId: res.headers.get("X-Request-Id"), errorName: "Error" });
    expect(typeof logged?.["route"]).toBe("string");
    expect(lines.join("\n")).not.toContain("secret");
    spy.mockRestore();
  });

  it("renders ApiError with retryAt", async () => {
    const res = await apiFetch("/api/test/busy", {}, { app: testApp() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "account_busy", message: "Account is busy", retryAt: "2026-10-15T10:05:00.000Z" },
    });
  });

  it("maps zod failures to validation_failed with path details", async () => {
    const res = await apiFetch("/api/test/validate", jsonInit("POST", { n: "x" }), { app: testApp() });
    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual([{ path: "n", message: expect.any(String) }]);
  });

  it("rejects non-JSON bodies", async () => {
    const res = await apiFetch("/api/test/validate", { method: "POST", body: "{" }, { app: testApp() });
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe("validation_failed");
  });

  it("rejects bodies over 64 KiB with 413", async () => {
    const res = await apiFetch("/api/test/validate", jsonInit("POST", { pad: "x".repeat(70_000) }), {
      app: testApp(),
    });
    expect(res.status).toBe(413);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe("payload_too_large");
  });
});
