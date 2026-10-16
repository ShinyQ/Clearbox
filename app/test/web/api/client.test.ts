import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, networkFailureStore, sessionErrorStore } from "../../../src/web/api/client.ts";
import { api } from "../../../src/web/api/endpoints.ts";
import { qk } from "../../../src/web/api/keys.ts";
import { ACC_GMAIL, iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

afterEach(() => {
  sessionErrorStore.set(null);
  networkFailureStore.set(0);
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("sends X-Clearbox-CSRF: 1 on every mutation and never on GETs", async () => {
    const state = installFakeApi();
    await api.me();
    await api.summary(ACC_GMAIL);
    await api.override({ ids: [1000], action: "keep" });
    await api.patchAccount(ACC_GMAIL, { paused: true });
    await api.putPolicy({ policy: state.policy.policy, expectedVersion: state.policy.version });
    await api.patchSender({ entry: "@bank.example", list: "none" });
    await api.disconnectAccount(ACC_GMAIL);
    const gets = state.requests.filter((r) => r.method === "GET");
    const mutations = state.requests.filter((r) => r.method !== "GET");
    expect(gets.map((r) => r.csrf)).toEqual([null, null]);
    expect(mutations.map((r) => `${r.method} ${r.csrf}`)).toEqual([
      "POST 1",
      "PATCH 1",
      "PUT 1",
      "PATCH 1",
      "DELETE 1",
    ]);
  });

  it("drops empty query parameters", async () => {
    const state = installFakeApi();
    await api.groups({ sort: "confidence_desc", limit: 50 });
    expect(state.requests[0]?.url.search).toBe("?sort=confidence_desc&limit=50");
  });

  it("maps the error envelope to ApiError", async () => {
    installFakeApi((s) => {
      s.failures.summary = { status: 429, code: "budget_exhausted", times: 1, retryAt: iso(T0 + 60_000) };
    });
    const error = await api.summary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "budget_exhausted", retryAt: iso(T0 + 60_000) });
  });

  it("leaves retryAt undefined when the server sends none", async () => {
    installFakeApi((s) => {
      s.failures.summary = { status: 409, code: "account_inactive", times: 1 };
    });
    const error = await api.summary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "account_inactive", retryAt: undefined });
  });

  it("maps fetch rejection to a network error and counts consecutive failures", async () => {
    installFakeApi((s) => {
      s.failures.me = { status: 0, code: "network", times: 2 };
    });
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: "network" });
    await expect(api.me()).rejects.toMatchObject({ code: "network" });
    expect(networkFailureStore.get()).toBe(2);
    await api.me();
    expect(networkFailureStore.get()).toBe(0);
  });

  it.each([
    [401, "unauthenticated", "unauthenticated"],
    [403, "forbidden", "forbidden"],
    [500, "access_misconfigured", "access_misconfigured"],
  ] as const)("publishes %s %s as a session error", async (status, code, expected) => {
    installFakeApi((s) => {
      s.failures.accounts = { status, code, times: 1 };
    });
    await expect(api.accounts()).rejects.toBeInstanceOf(ApiError);
    expect(sessionErrorStore.get()).toBe(expected);
  });

  it("does not treat csrf_required as a session error", async () => {
    installFakeApi((s) => {
      s.failures.override = { status: 403, code: "csrf_required", times: 1 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(api.override({ ids: [1000], action: "keep" })).rejects.toMatchObject({
      code: "csrf_required",
    });
    expect(sessionErrorStore.get()).toBeNull();
  });

  it("rejects a response that does not match the contract", async () => {
    server.use(http.get("*/api/me", () => HttpResponse.json({ email: 5 })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(api.me()).rejects.toMatchObject({ code: "invalid_response" });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("query keys", () => {
  it("matches UI spec 8.3", () => {
    expect(qk.summary()).toEqual(["queue", "summary", { accountId: null }]);
    expect(qk.preview("acc_1")).toEqual([
      "cleanup",
      "preview",
      { accountId: "acc_1", actions: "delete,archive" },
    ]);
    expect(qk.groups({ sort: "confidence_desc" })).toEqual([
      "groups",
      { accountId: null, action: null, sort: "confidence_desc" },
    ]);
    expect(qk.group("k1")).toEqual(["group", "k1"]);
    expect(qk.activity()).toEqual(["activity", { accountId: null }]);
  });
});
