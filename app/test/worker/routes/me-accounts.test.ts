import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  AccountsResponse,
  AccountView,
  ApiErrorBody,
  DisconnectResponse,
  MeResponse,
} from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import { appOriginOf } from "../../../src/worker/db/settings.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

function setup(revoke?: (token: string) => Promise<boolean>) {
  const { oauth, calls } = fakeOAuth(revoke ? { gmail: { revoke: async (_f, token) => revoke(token) } } : {});
  const app = createApp({ now: () => SEED_NOW, oauth, providerFactory: new FakeProvider().factory() });
  return { app, calls };
}

async function auditKinds(accountId: string): Promise<string[]> {
  const res = await env.DB.prepare("SELECT kind FROM audit_log WHERE account_id = ?1 ORDER BY id")
    .bind(accountId)
    .run<{ kind: string }>();
  return res.results.map((r) => r.kind);
}

describe("GET /api/me", () => {
  it("returns the owner session", async () => {
    const { app } = setup();
    const res = await apiFetch("/api/me", {}, { app });
    expect(res.status).toBe(200);
    expect(await readJson<MeResponse>(res)).toEqual({
      email: "owner@example.test",
      environment: "test",
      freeTier: true,
      providers: { gmail: true, outlook: true },
      issues: [],
      tauDelete: 0.8,
      serverTime: new Date(SEED_NOW).toISOString(),
    });
  });

  it("reports unconfigured providers", async () => {
    const { app } = setup();
    const res = await apiFetch("/api/me", {}, { app, env: { GOOGLE_CLIENT_ID: "" } });
    expect((await readJson<MeResponse>(res)).providers).toEqual({ gmail: false, outlook: true });
  });

  it("records the deployment origin for the weekly reminder link, writing only when it changes", async () => {
    const { app } = setup();
    const origin = () =>
      env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = 'app_origin'").first<{
        value: string;
        updated_at: number;
      }>();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'app_origin'").run();
    await apiFetch("/api/me", {}, { app });
    expect(await origin()).toEqual({
      value: JSON.stringify("https://clearbox.example.test"),
      updated_at: SEED_NOW,
    });

    const later = createApp({ now: () => SEED_NOW + 1_000, providerFactory: new FakeProvider().factory() });
    await apiFetch("/api/me", {}, { app: later });
    expect((await origin())?.updated_at).toBe(SEED_NOW);
  });
});

describe("appOriginOf", () => {
  it("accepts https and local http only", () => {
    expect(appOriginOf("https://clearbox.example.test/api/me?x=1")).toBe("https://clearbox.example.test");
    expect(appOriginOf("http://localhost:5173/api/me")).toBe("http://localhost:5173");
    expect(appOriginOf("http://127.0.0.1:8787/api/me")).toBe("http://127.0.0.1:8787");
    expect(appOriginOf("http://clearbox.example.test/api/me")).toBeNull();
  });
});

describe("GET /api/accounts", () => {
  it("lists visible accounts with open counts", async () => {
    const { app } = setup();
    const a = await seedAccount({ provider: "gmail" });
    const b = await seedAccount({ provider: "outlook" });
    await seedAccount({ status: "disconnected" });
    await seedSuggestions(a.id, 2);
    await seedSuggestions(b.id, 1, { status: "awaiting_model" });
    const body = await readJson<AccountsResponse>(await apiFetch("/api/accounts", {}, { app }));
    expect(body.accounts.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(body.accounts[0]?.sync).toMatchObject({ pendingCount: 2, awaitingModelCount: 0 });
    expect(body.accounts[1]).toMatchObject({
      provider: "outlook",
      archiveSupported: true,
      sync: { awaitingModelCount: 1 },
    });
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("pauses and resumes with one audit row per change", async () => {
    const { app } = setup();
    const a = await seedAccount();
    const paused = await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: true }), { app });
    expect(paused.status).toBe(200);
    expect((await readJson<AccountView>(paused)).paused).toBe(true);
    await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: true }), { app });
    await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: false }), { app });
    expect(await auditKinds(a.id)).toEqual(["account_paused", "account_resumed"]);
  });

  it("validates the body and the account", async () => {
    const { app } = setup();
    const a = await seedAccount();
    const gone = await seedAccount({ status: "disconnected" });
    const bad = await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: "yes" }), { app });
    expect((await readJson<ApiErrorBody>(bad)).error.code).toBe("validation_failed");
    expect(
      (await apiFetch(`/api/accounts/acc_ffffffffffffffff`, jsonInit("PATCH", { paused: true }), { app }))
        .status,
    ).toBe(404);
    expect(
      (await apiFetch(`/api/accounts/${gone.id}`, jsonInit("PATCH", { paused: true }), { app })).status,
    ).toBe(404);
  });
});

describe("DELETE /api/accounts/:id", () => {
  it("revokes Gmail, wipes tokens and dismisses open suggestions", async () => {
    const { app, calls } = setup();
    const a = await seedAccount({ provider: "gmail", refreshToken: "gmail-refresh" });
    const [open] = await seedSuggestions(a.id, 1);
    const res = await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app });
    expect(res.status).toBe(200);
    expect(await readJson<DisconnectResponse>(res)).toEqual({
      accountId: a.id,
      revocation: "revoked",
      consentUrls: null,
    });
    expect(calls).toEqual([{ fn: "revoke", provider: "gmail", value: "gmail-refresh" }]);
    expect(await getAccount(env.DB, a.id)).toMatchObject({
      status: "disconnected",
      refreshToken: null,
      accessToken: null,
    });
    expect((await getSuggestionRow(open ?? 0))?.["status"]).toBe("dismissed");
    expect(await auditKinds(a.id)).toEqual(["account_disconnected"]);
    expect((await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app })).status).toBe(404);
  });

  it("still disconnects when Google revoke fails or throws", async () => {
    const failing = setup(async () => false);
    const a = await seedAccount({ provider: "gmail" });
    expect(
      (
        await readJson<DisconnectResponse>(
          await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app: failing.app }),
        )
      ).revocation,
    ).toBe("failed");
    const throwing = setup(async () => {
      throw new Error("network");
    });
    const b = await seedAccount({ provider: "gmail" });
    const res = await apiFetch(`/api/accounts/${b.id}`, jsonInit("DELETE"), { app: throwing.app });
    expect((await readJson<DisconnectResponse>(res)).revocation).toBe("failed");
    expect((await getAccount(env.DB, b.id))?.status).toBe("disconnected");
  });

  it("logs ids and codes only when the revoke throws", async () => {
    const { app } = setup(async () => {
      throw new TypeError("network gmail-refresh mailbox@example.com");
    });
    const a = await seedAccount({ provider: "gmail", refreshToken: "gmail-refresh" });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app });
    const lines = spy.mock.calls.map((call) => String(call[0]));
    spy.mockRestore();
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e["evt"] === "request.error")).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      route: "/api/accounts/:id",
      errorName: "TypeError",
    });
    expect(events.find((e) => e["evt"] === "account.status")).toMatchObject({
      accountId: a.id,
      from: "active",
      to: "disconnected",
      reason: "owner",
    });
    expect(lines.join("\n")).not.toMatch(/network|gmail-refresh|@example\.com/);
  });

  it("returns consent links for Outlook without calling a revoke endpoint", async () => {
    const { app, calls } = setup();
    const a = await seedAccount({ provider: "outlook" });
    const body = await readJson<DisconnectResponse>(
      await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app }),
    );
    expect(body).toEqual({
      accountId: a.id,
      revocation: "not_supported",
      consentUrls: {
        personal: "https://account.live.com/consent/Manage",
        work: "https://myapps.microsoft.com",
      },
    });
    expect(calls).toEqual([]);
  });
});
