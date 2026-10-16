import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { resetJwksCache } from "../../../src/worker/middleware/access.ts";
import { signAccessJwt } from "../helpers/access.ts";
import { apiFetch, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/ping", (c) => c.json({ email: c.get("ownerEmail") }));
  return app;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await readJson<ApiErrorBody>(res)).error.code).toBe(code);
}

beforeEach(() => resetJwksCache());
afterEach(() => vi.restoreAllMocks());

describe("accessGuard", () => {
  it("accepts a valid owner JWT and exposes the owner email", async () => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "owner@example.test" });
  });

  it("compares the email case-insensitively", async () => {
    const jwt = await signAccessJwt({ email: "OWNER@Example.TEST" });
    expect((await apiFetch("/api/test/ping", {}, { app: testApp(), jwt })).status).toBe(200);
  });

  it("returns 401 when the header is missing", async () => {
    await expectError(
      await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: null }),
      401,
      "unauthenticated",
    );
  });

  it("ignores the CF_Authorization cookie", async () => {
    const cookie = `CF_Authorization=${await signAccessJwt()}`;
    const res = await apiFetch(
      "/api/test/ping",
      { headers: { Cookie: cookie } },
      { app: testApp(), jwt: null },
    );
    await expectError(res, 401, "unauthenticated");
  });

  it.each([
    ["bad signature", () => signAccessJwt({}, { key: "other" })],
    ["wrong audience", () => signAccessJwt({ aud: ["another-aud"] })],
    ["wrong issuer", () => signAccessJwt({ iss: "https://evil.cloudflareaccess.com" })],
    ["expired", () => signAccessJwt({ iat: 1_000, nbf: 1_000, exp: 2_000 })],
    ["wrong email", () => signAccessJwt({ email: "someone@example.test" })],
    ["service token without email", () => signAccessJwt({ common_name: "svc.access" }, { omit: ["email"] })],
  ])("returns 403 for %s", async (_name, makeJwt) => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: await makeJwt() });
    await expectError(res, 403, "forbidden");
  });

  it.each([
    ["ACCESS_AUD", ""],
    ["ACCESS_TEAM_DOMAIN", ""],
    ["OWNER_EMAIL", ""],
    ["TOKEN_ENC_KEY", "short"],
    ["STATE_SIGNING_KEY", undefined],
  ])("fails closed with 500 when %s is invalid", async (name, value) => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp(), env: { [name]: value } });
    await expectError(res, 500, "access_misconfigured");
  });

  it("fails closed when the bypass flag is set outside development", async () => {
    const res = await apiFetch(
      "/api/test/ping",
      {},
      { app: testApp(), jwt: null, env: { DEV_AUTH_BYPASS: "true" } },
    );
    await expectError(res, 500, "access_misconfigured");
  });

  it("honors the dev bypass only in development on localhost", async () => {
    const devEnv = { ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" };
    const local = await apiFetch(
      "/api/test/ping",
      {},
      { app: testApp(), jwt: null, env: devEnv, origin: "http://localhost:5173" },
    );
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ email: "owner@example.test" });
    const loopback = await apiFetch(
      "/api/test/ping",
      {},
      { app: testApp(), jwt: null, env: devEnv, origin: "http://127.0.0.1:5173" },
    );
    expect(loopback.status).toBe(200);
    const remote = await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: null, env: devEnv });
    await expectError(remote, 401, "unauthenticated");
  });

  it("guards /oauth/* too", async () => {
    await expectError(
      await apiFetch("/oauth/google/start", {}, { app: testApp(), jwt: null }),
      401,
      "unauthenticated",
    );
  });

  it("logs access.denied with the route pattern, never the URL or identity", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await apiFetch(
      "/api/test/ping?secret=1",
      {},
      { app: testApp(), jwt: await signAccessJwt({ email: "x@example.test" }) },
    );
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const denied = lines.find((l) => l.includes('"evt":"access.denied"'));
    expect(denied).toBeDefined();
    expect(JSON.parse(denied ?? "{}")).toMatchObject({ reason: "wrong_email", route: "/api/*" });
    expect(lines.join("\n")).not.toMatch(/test\/ping|secret|example\.test/);
  });
});
