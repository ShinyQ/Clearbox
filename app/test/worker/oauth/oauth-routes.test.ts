import { ProviderConfigError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/worker/app.ts";
import { CURRENT_KEY_VERSION, decryptToken } from "../../../src/worker/crypto/aead.ts";
import { challengeS256 } from "../../../src/worker/crypto/pkce.ts";
import { findOpenAccountByEmail, getAccount } from "../../../src/worker/db/accounts.ts";
import { readSettings, setIssuesStmt } from "../../../src/worker/db/settings.ts";
import type { AppOverrides } from "../../../src/worker/app.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, testEncKey } from "../helpers/seed.ts";

afterEach(() => vi.restoreAllMocks());

let mailboxSeq = 0;

function setup(
  overrides: Partial<AppOverrides> = {},
  oauthOverrides: Parameters<typeof fakeOAuth>[0] = {},
  email = `mailbox${++mailboxSeq}@example.com`,
) {
  const provider = new FakeProvider({
    bootstrap: {
      email,
      providerUserId: email,
      aliases: ["alias@example.com"],
      archiveFolderId: null,
      incrementalCursor: '{"v":1,"historyId":"777"}',
    },
    inboxEstimate: 4_321,
  });
  const { oauth, calls } = fakeOAuth(oauthOverrides);
  const app = createApp({ now: () => SEED_NOW, providerFactory: provider.factory(), oauth, ...overrides });
  return { app, provider, calls, email };
}

async function start(app: ReturnType<typeof createApp>, segment = "google", query = "") {
  const res = await apiFetch(`/oauth/${segment}/start${query}`, {}, { app });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const location = new URL(res.headers.get("Location") ?? "https://invalid.test");
  return { res, cookie, location, state: location.searchParams.get("state") ?? "" };
}

async function callback(
  app: ReturnType<typeof createApp>,
  segment: string,
  query: Record<string, string>,
  cookie: string | null,
) {
  const init = cookie === null ? {} : { headers: { Cookie: cookie } };
  return apiFetch(`/oauth/${segment}/callback?${new URLSearchParams(query).toString()}`, init, { app });
}

function settingsRedirect(res: Response): Record<string, string> {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location") ?? "", "https://clearbox.example.test");
  expect(location.pathname).toBe("/settings/accounts");
  return Object.fromEntries(location.searchParams);
}

describe("GET /oauth/:provider/start", () => {
  it("sets the state cookie and redirects to the authorize URL with PKCE", async () => {
    const { app, calls } = setup();
    const { res, cookie, location, state } = await start(app, "google", "?loginHint=Mailbox%40example.com");
    expect(res.status).toBe(302);
    expect(location.origin).toBe("https://auth.example.test");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://clearbox.example.test/oauth/google/callback",
    );
    expect(location.searchParams.get("client_id")).toBe("test-google-client");
    expect(location.searchParams.get("login_hint")).toBe("mailbox@example.com");
    expect(cookie.startsWith("__Host-clearbox_oauth=")).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual([{ fn: "authorize", provider: "gmail", value: state }]);
  });

  it("redirects with provider_not_configured when the client is missing", async () => {
    const { app } = setup();
    const res = await apiFetch("/oauth/microsoft/start", {}, { app, env: { MS_CLIENT_SECRET: "" } });
    expect(settingsRedirect(res)).toEqual({ error: "provider_not_configured", provider: "outlook" });
  });

  it("returns 404 for unknown providers", async () => {
    const { app } = setup();
    expect((await apiFetch("/oauth/yahoo/start", {}, { app })).status).toBe(404);
  });
});

describe("GET /oauth/:provider/callback", () => {
  it("connects a new Gmail account with encrypted tokens", async () => {
    const { app, calls, provider, email } = setup();
    const flow = await start(app);
    const res = await callback(app, "google", { code: "auth-code", state: flow.state }, flow.cookie);
    const params = settingsRedirect(res);
    expect(params["connected"]).toMatch(/^acc_[0-9a-f]{16}$/);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const exchange = calls.find((c) => c.fn === "exchange");
    const verifier = exchange?.value.split("|")[1] ?? "";
    expect(exchange?.value.split("|")[0]).toBe("auth-code");
    expect(await challengeS256(verifier)).toBe(flow.location.searchParams.get("code_challenge"));
    expect(provider.calls.map((c) => c.method)).toEqual(["bootstrap", "inboxEstimate"]);

    const account = await getAccount(env.DB, params["connected"] ?? "");
    expect(account).toMatchObject({
      provider: "gmail",
      email,
      status: "active",
      phase: "sent_backfill",
      incrementalCursor: '{"v":1,"historyId":"777"}',
      ownerAliases: ["alias@example.com"],
      nextTickAt: 0,
      keyVersion: CURRENT_KEY_VERSION,
      inboxEstimate: 4_321,
    });
    const key = await testEncKey();
    const ctx = (kind: "refresh" | "access") => ({ accountId: account?.id ?? "", kind, keyVersion: 1 });
    const empty = { ciphertext: new Uint8Array(), iv: new Uint8Array() };
    expect(await decryptToken(key, account?.refreshToken ?? empty, ctx("refresh"))).toBe("fresh-refresh");
    expect(await decryptToken(key, account?.accessToken ?? empty, ctx("access"))).toBe("fresh-access");
    const audit = await env.DB.prepare("SELECT kind, result_json FROM audit_log WHERE account_id = ?1")
      .bind(account?.id)
      .run();
    expect(audit.results).toEqual([{ kind: "account_connected", result_json: "{}" }]);
  });

  it("reconnects an existing account, keeps its id and clears the client issue", async () => {
    const existing = await seedAccount({
      email: "returning@example.com",
      status: "needs_reauth",
      statusReason: "invalid_grant",
    });
    await setIssuesStmt(
      env.DB,
      [{ code: "google_client_invalid", since: new Date(SEED_NOW).toISOString(), accountId: null }],
      SEED_NOW,
    ).run();
    // Decision 23: a reconnect re-encrypts under the current key version, whatever the row stored before.
    await env.DB.prepare("UPDATE accounts SET key_version = 2 WHERE id = ?1").bind(existing.id).run();
    const { app } = setup({}, {}, "returning@example.com");
    const flow = await start(app);
    const params = settingsRedirect(
      await callback(app, "google", { code: "c", state: flow.state }, flow.cookie),
    );
    expect(params["connected"]).toBe(existing.id);
    const reconnected = await getAccount(env.DB, existing.id);
    expect(reconnected).toMatchObject({
      status: "active",
      statusReason: null,
      incrementalCursor: existing.incrementalCursor,
      keyVersion: CURRENT_KEY_VERSION,
    });
    const refreshCtx = { accountId: existing.id, kind: "refresh" as const, keyVersion: CURRENT_KEY_VERSION };
    const refresh = reconnected?.refreshToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() };
    expect(await decryptToken(await testEncKey(), refresh, refreshCtx)).toBe("fresh-refresh");
    expect((await readSettings(env.DB)).issues).toEqual([]);
    const kinds = await env.DB.prepare("SELECT kind FROM audit_log WHERE account_id = ?1 ORDER BY id")
      .bind(existing.id)
      .run();
    expect(kinds.results).toEqual([{ kind: "account_reconnected" }]);
  });

  it("rejects tampered, missing, mismatched and expired state with state_invalid", async () => {
    const { app, email } = setup();
    const flow = await start(app);
    const tampered = flow.cookie.replace(".", ".x");
    expect(
      settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, tampered))["error"],
    ).toBe("state_invalid");
    expect(
      settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, null))["error"],
    ).toBe("state_invalid");
    expect(
      settingsRedirect(await callback(app, "google", { code: "c", state: "wrong" }, flow.cookie))["error"],
    ).toBe("state_invalid");
    expect(
      settingsRedirect(await callback(app, "microsoft", { code: "c", state: flow.state }, flow.cookie))[
        "error"
      ],
    ).toBe("state_invalid");
    const later = setup({ now: () => SEED_NOW + 600_001 }, {}, email);
    const expired = await callback(later.app, "google", { code: "c", state: flow.state }, flow.cookie);
    expect(settingsRedirect(expired)).toEqual({ error: "state_invalid", provider: "gmail" });
    expect(expired.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await findOpenAccountByEmail(env.DB, "gmail", email)).toBeNull();
  });

  it("maps provider errors to access_denied and admin_consent_required", async () => {
    const { app } = setup();
    expect(settingsRedirect(await callback(app, "google", { error: "access_denied" }, null))).toEqual({
      error: "access_denied",
      provider: "gmail",
    });
    expect(
      settingsRedirect(await callback(app, "microsoft", { error: "consent_required" }, null))["error"],
    ).toBe("admin_consent_required");
    expect(
      settingsRedirect(
        await callback(
          app,
          "microsoft",
          { error: "access_denied", error_description: "AADSTS90094: admin" },
          null,
        ),
      )["error"],
    ).toBe("admin_consent_required");
  });

  it("revokes and refuses a grant without the Gmail scope", async () => {
    const { app, calls } = setup(
      {},
      {
        gmail: {
          exchangeCode: async (_f, _cfg, _code, _v, now) => ({
            accessToken: "a",
            expiresAt: now + 1,
            refreshToken: "r-no-scope",
            grantedScopes: ["openid"],
            refreshTokenExpiresAt: null,
          }),
          revoke: async (_f, token) => {
            calls.push({ fn: "revoke", provider: "gmail", value: token });
            return true;
          },
        },
      },
    );
    const flow = await start(app);
    expect(
      settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie))["error"],
    ).toBe("scope_missing");
    expect(calls.filter((c) => c.fn === "revoke")).toEqual([
      { fn: "revoke", provider: "gmail", value: "r-no-scope" },
    ]);
  });

  it("requires a refresh token", async () => {
    const { app } = setup(
      {},
      {
        outlook: {
          exchangeCode: async (_f, _cfg, _code, _v, now) => ({
            accessToken: "a",
            expiresAt: now + 1,
            refreshToken: null,
            grantedScopes: ["Mail.ReadWrite", "offline_access", "User.Read"],
            refreshTokenExpiresAt: null,
          }),
        },
      },
    );
    const flow = await start(app, "microsoft");
    expect(
      settingsRedirect(await callback(app, "microsoft", { code: "c", state: flow.state }, flow.cookie)),
    ).toEqual({
      error: "no_refresh_token",
      provider: "outlook",
    });
  });

  it("maps client configuration errors and raises the app issue", async () => {
    const { app } = setup(
      {},
      {
        gmail: {
          exchangeCode: async () => {
            throw new ProviderConfigError({ provider: "gmail", reason: "invalid_client" });
          },
        },
      },
    );
    const flow = await start(app);
    expect(
      settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie))["error"],
    ).toBe("provider_config_error");
    expect((await readSettings(env.DB)).issues.map((i) => i.code)).toEqual(["google_client_invalid"]);
  });

  it("maps other exchange failures and bootstrap failures", async () => {
    const failing = setup(
      {},
      {
        gmail: {
          exchangeCode: async () => {
            throw new Error("network");
          },
        },
      },
    );
    const flow1 = await start(failing.app);
    expect(
      settingsRedirect(
        await callback(failing.app, "google", { code: "c", state: flow1.state }, flow1.cookie),
      )["error"],
    ).toBe("token_exchange_failed");
    const broken = setup({
      providerFactory: new FakeProvider({ failWith: { bootstrap: new Error("profile") } }).factory(),
    });
    const flow2 = await start(broken.app);
    expect(
      settingsRedirect(await callback(broken.app, "google", { code: "c", state: flow2.state }, flow2.cookie))[
        "error"
      ],
    ).toBe("profile_failed");
  });

  it("connects with a null inbox estimate when the best-effort estimate fails", async () => {
    const email = "estimate-fails@example.com";
    const provider = new FakeProvider({
      bootstrap: {
        email,
        providerUserId: email,
        aliases: [],
        archiveFolderId: null,
        incrementalCursor: '{"v":1,"historyId":"9"}',
      },
      failWith: { inboxEstimate: new Error("throttled") },
    });
    const { app } = setup({ providerFactory: provider.factory() }, {}, email);
    const flow = await start(app);
    const params = settingsRedirect(
      await callback(app, "google", { code: "c", state: flow.state }, flow.cookie),
    );
    expect(params["connected"]).toMatch(/^acc_[0-9a-f]{16}$/);
    expect((await getAccount(env.DB, params["connected"] ?? ""))?.inboxEstimate).toBeNull();
  });

  it("logs oauth.connect with codes and ids only", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { app, email } = setup();
    const flow = await start(app);
    await callback(app, "google", { code: "secret-code", state: flow.state }, flow.cookie);
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"oauth.connect"')) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({ provider: "gmail", outcome: "connected" });
    expect(lines.join("\n")).not.toMatch(/secret-code|fresh-/);
    expect(lines.join("\n")).not.toContain(email);
  });
});
