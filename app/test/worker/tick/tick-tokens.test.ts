import { ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { FetchLike } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../../../src/worker/crypto/aead.ts";
import { readConfig } from "../../../src/worker/env.ts";
import type { AppConfig } from "../../../src/worker/env.ts";
import type { TickAccountRow } from "../../../src/worker/scan/claim.ts";
import { makeDecisionEngine } from "../../../src/worker/scan/engine.ts";
import { makeProvider } from "../../../src/worker/scan/providers.ts";
import {
  encryptTokenUpdate,
  openTickTokens,
  providerTargetOf,
  tokenAccountOf,
} from "../../../src/worker/scan/tick-tokens.ts";
import { testEncKey } from "../helpers/seed.ts";
import {
  ACCOUNT_A,
  MINUTE,
  NOW,
  decryptAccountToken,
  one,
  resetDb,
  seedTickAccount,
} from "../helpers/tick-db.ts";

async function loadAccount(): Promise<TickAccountRow> {
  const row = await one<TickAccountRow>("SELECT * FROM accounts WHERE id = ?1", ACCOUNT_A);
  if (row === null) throw new Error("missing account");
  return row;
}

function config(overrides: Partial<Env> = {}): AppConfig {
  const result = readConfig({ ...env, ...overrides } as Env);
  if (!result.ok) throw new Error(`invalid test config: ${result.invalid.join(",")}`);
  return result.config;
}

function stubFetch(body: Record<string, unknown>, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json(body, { status });
    },
  };
}

const failingFetch: FetchLike = async () => {
  throw new Error("no network expected");
};

async function open(fetch: FetchLike, cfg: AppConfig = config()) {
  return openTickTokens({
    row: await loadAccount(),
    config: cfg,
    encKey: await testEncKey(),
    fetch,
    now: NOW,
  });
}

describe("openTickTokens (plan 03 createD1TokenSource over a claimed row)", () => {
  beforeEach(resetDb);

  it("returns the stored access token without any request while it is fresh", async () => {
    await seedTickAccount({ accessToken: "access-1", accessExpiresAt: NOW + 60 * MINUTE });
    const ts = await open(failingFetch);
    expect(await ts.getAccessToken()).toBe("access-1");
    expect(ts.update).toBeNull();
  });

  it("refreshes a Microsoft token near expiry and captures the rotated refresh token", async () => {
    await seedTickAccount({ provider: "outlook", accessExpiresAt: NOW + MINUTE });
    const stub = stubFetch({
      token_type: "Bearer",
      scope: "Mail.ReadWrite User.Read offline_access",
      expires_in: 3599,
      access_token: "ms-access-2",
      refresh_token: "ms-refresh-2",
    });
    const ts = await open(stub.fetch);
    expect(await ts.getAccessToken()).toBe("ms-access-2");
    expect(await ts.getAccessToken()).toBe("ms-access-2");
    expect(stub.urls).toHaveLength(1);
    expect(ts.update).toEqual({
      accessToken: "ms-access-2",
      accessExpiresAt: NOW + 3_599_000,
      refreshToken: "ms-refresh-2",
    });
  });

  it("refreshes Google without a new refresh token", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const stub = stubFetch({
      access_token: "g-access-2",
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
    const ts = await open(stub.fetch);
    expect(await ts.getAccessToken()).toBe("g-access-2");
    expect(ts.update?.refreshToken).toBeNull();
    const cols = await encryptTokenUpdate(
      await testEncKey(),
      { id: ACCOUNT_A, key_version: 1 },
      ts.update ?? { accessToken: "", accessExpiresAt: 0, refreshToken: null },
    );
    expect(cols.encRefresh).toBeNull();
    expect(cols.refreshIv).toBeNull();
  });

  it("forceRefresh refreshes even when the token is fresh", async () => {
    await seedTickAccount({ provider: "outlook" });
    const stub = stubFetch({
      token_type: "Bearer",
      scope: "Mail.ReadWrite",
      expires_in: 3599,
      access_token: "ms-access-3",
      refresh_token: "ms-refresh-3",
    });
    const ts = await open(stub.fetch);
    expect(await ts.forceRefresh()).toBe("ms-access-3");
  });

  it("propagates invalid_grant as ProviderAuthError", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const stub = stubFetch(
      { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      400,
    );
    const ts = await open(stub.fetch);
    await expect(ts.getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("fails with ProviderConfigError without a request when the provider client is not configured", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const ts = await open(failingFetch, config({ GOOGLE_CLIENT_ID: "" }));
    await expect(ts.getAccessToken()).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("encryptTokenUpdate produces columns that decrypt with the account AAD", async () => {
    const key = await testEncKey();
    const cols = await encryptTokenUpdate(
      key,
      { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-1", accessExpiresAt: NOW, refreshToken: "r-1" },
    );
    const ctx = (kind: "refresh" | "access") => ({ accountId: ACCOUNT_A, kind, keyVersion: 1 });
    expect(await decryptToken(key, { ciphertext: cols.encAccess, iv: cols.accessIv }, ctx("access"))).toBe(
      "a-1",
    );
    const enc = cols.encRefresh;
    const iv = cols.refreshIv;
    if (enc === null || iv === null) throw new Error("refresh columns missing");
    expect(await decryptToken(key, { ciphertext: enc, iv }, ctx("refresh"))).toBe("r-1");
  });

  it("re-encrypts a refreshed token under the row's key_version, not CURRENT_KEY_VERSION", async () => {
    await seedTickAccount({ provider: "outlook", keyVersion: 2, accessExpiresAt: NOW + MINUTE });
    const stub = stubFetch({
      token_type: "Bearer",
      scope: "Mail.ReadWrite User.Read offline_access",
      expires_in: 3599,
      access_token: "ms-access-v2",
      refresh_token: "ms-refresh-v2",
    });
    const row = await loadAccount();
    expect(row.key_version).toBe(2);
    const key = await testEncKey();
    const ts = openTickTokens({ row, config: config(), encKey: key, fetch: stub.fetch, now: NOW });
    expect(await ts.getAccessToken()).toBe("ms-access-v2");
    const update = ts.update;
    if (update === null) throw new Error("expected a token update");
    const cols = await encryptTokenUpdate(key, row, update);
    const { encRefresh, refreshIv } = cols;
    if (encRefresh === null || refreshIv === null) throw new Error("refresh columns missing");
    const ctx = (kind: "refresh" | "access", keyVersion: number) => ({
      accountId: ACCOUNT_A,
      kind,
      keyVersion,
    });
    // A version-1 AAD must not open the ciphertext.
    await expect(
      decryptToken(key, { ciphertext: cols.encAccess, iv: cols.accessIv }, ctx("access", 1)),
    ).rejects.toBeDefined();

    await env.DB.prepare(
      `UPDATE accounts SET enc_access_token = ?1, access_iv = ?2, access_expires_at = ?3,
         enc_refresh_token = ?4, refresh_iv = ?5 WHERE id = ?6`,
    )
      .bind(cols.encAccess, cols.accessIv, cols.accessExpiresAt, encRefresh, refreshIv, ACCOUNT_A)
      .run();
    expect(
      await one<{ key_version: number }>("SELECT key_version FROM accounts WHERE id = ?1", ACCOUNT_A),
    ).toEqual({
      key_version: 2,
    });
    // decryptAccountToken opens with the stored row's key_version (2) AAD.
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("ms-access-v2");
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("ms-refresh-v2");
  });

  it("tokenAccountOf maps the claimed row to plan 03's TokenAccount", async () => {
    await seedTickAccount({ provider: "outlook", accessToken: null });
    const account = tokenAccountOf(await loadAccount());
    expect(account).toMatchObject({
      id: ACCOUNT_A,
      provider: "outlook",
      keyVersion: 1,
      accessToken: null,
      accessExpiresAt: null,
    });
    expect(account.refreshToken?.iv).toHaveLength(12);
  });
});

describe("factories", () => {
  it("plan 03 makeProvider picks the provider implementation from the claimed row", () => {
    const deps = {
      fetch: failingFetch,
      tokens: { getAccessToken: async () => "t", forceRefresh: async () => "t" },
      now: () => NOW,
    };
    expect(makeProvider(providerTargetOf({ provider: "gmail", archive_folder_id: null }), deps).kind).toBe(
      "gmail",
    );
    expect(makeProvider(providerTargetOf({ provider: "outlook", archive_folder_id: "f" }), deps).kind).toBe(
      "outlook",
    );
  });

  it("makeDecisionEngine returns null when any Decision secret is empty", () => {
    expect(makeDecisionEngine(env, failingFetch)?.name).toBe("mai");
    expect(makeDecisionEngine({ ...env, AZURE_DECISION_KEY: "" }, failingFetch)).toBeNull();
    expect(makeDecisionEngine({ ...env, AZURE_DECISION_ENDPOINT: "" }, failingFetch)).toBeNull();
    expect(makeDecisionEngine({ ...env, AZURE_DECISION_DEPLOYMENT: "" }, failingFetch)).toBeNull();
  });
});
