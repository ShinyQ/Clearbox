import { ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { OAuthTokens } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CURRENT_KEY_VERSION, decryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import { readConfig } from "../../../src/worker/env.ts";
import {
  createD1TokenSource,
  refreshFnFor,
  staticTokenSource,
  tokenUpdateStmt,
} from "../../../src/worker/scan/token-source.ts";
import { fakeOAuth } from "../helpers/fake-provider.ts";
import { SEED_NOW, seedAccount, testEncKey } from "../helpers/seed.ts";

function recordingRefresh(rotated: string | null) {
  const seen: string[] = [];
  const refresh = async (rt: string): Promise<OAuthTokens> => {
    seen.push(rt);
    return {
      accessToken: `new-access-${seen.length}`,
      expiresAt: SEED_NOW + 3_600_000,
      refreshToken: rotated,
      grantedScopes: [],
      refreshTokenExpiresAt: null,
    };
  };
  return { refresh, seen };
}

const EMPTY = { ciphertext: new Uint8Array(), iv: new Uint8Array() };

describe("createD1TokenSource", () => {
  it("uses the cached encrypted access token while more than 5 minutes remain", async () => {
    const account = await seedAccount({
      accessToken: "cached-access",
      accessExpiresAt: SEED_NOW + 10 * 60_000,
    });
    const { refresh, seen } = recordingRefresh(null);
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    expect(await tokens.getAccessToken()).toBe("cached-access");
    expect(seen).toEqual([]);
    expect(tokens.update).toBeNull();
  });

  it("refreshes when fewer than 5 minutes remain and records the update", async () => {
    const account = await seedAccount({
      refreshToken: "stored-refresh",
      accessExpiresAt: SEED_NOW + 4 * 60_000,
    });
    const { refresh, seen } = recordingRefresh(null);
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    expect(await tokens.getAccessToken()).toBe("new-access-1");
    expect(await tokens.getAccessToken()).toBe("new-access-1");
    expect(seen).toEqual(["stored-refresh"]);
    expect(tokens.update).toEqual({
      accessToken: "new-access-1",
      accessExpiresAt: SEED_NOW + 3_600_000,
      refreshToken: null,
    });
  });

  it("captures Microsoft refresh token rotation and uses the rotated token next", async () => {
    const account = await seedAccount({
      provider: "outlook",
      refreshToken: "ms-refresh-1",
      accessToken: null,
    });
    const { refresh, seen } = recordingRefresh("ms-refresh-2");
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    await tokens.getAccessToken();
    await tokens.forceRefresh();
    expect(seen).toEqual(["ms-refresh-1", "ms-refresh-2"]);
    expect(tokens.update?.refreshToken).toBe("ms-refresh-2");
    expect(tokens.refreshCount).toBe(2);
  });

  it("maps a missing or undecryptable refresh token to ProviderAuthError", async () => {
    const account = await seedAccount({ accessToken: null });
    const { refresh } = recordingRefresh(null);
    const noRefresh = createD1TokenSource({
      account: { ...account, refreshToken: null },
      encKey: await testEncKey(),
      refresh,
      now: () => SEED_NOW,
    });
    await expect(noRefresh.getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(noRefresh.getAccessToken()).rejects.toMatchObject({ reason: "no_refresh_token" });
    const otherKey = await importEncKey(base64ToBytes(env.STATE_SIGNING_KEY));
    const wrongKey = createD1TokenSource({ account, encKey: otherKey, refresh, now: () => SEED_NOW });
    await expect(wrongKey.getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(wrongKey.getAccessToken()).rejects.toMatchObject({ reason: "token_decrypt_failed" });
    // Decryption binds the row's key_version into the AAD (decision 23).
    const otherVersion = createD1TokenSource({
      account: { ...account, keyVersion: CURRENT_KEY_VERSION + 1 },
      encKey: await testEncKey(),
      refresh,
      now: () => SEED_NOW,
    });
    await expect(otherVersion.getAccessToken()).rejects.toMatchObject({ reason: "token_decrypt_failed" });
  });
});

describe("tokenUpdateStmt", () => {
  it("re-encrypts and persists access and rotated refresh tokens", async () => {
    const account = await seedAccount({ provider: "outlook" });
    const key = await testEncKey();
    const stmt = await tokenUpdateStmt(
      env.DB,
      account,
      key,
      { accessToken: "a2", accessExpiresAt: SEED_NOW + 1, refreshToken: "r2" },
      SEED_NOW,
    );
    await stmt.run();
    const stored = await getAccount(env.DB, account.id);
    const ctx = (kind: "refresh" | "access") => ({
      accountId: account.id,
      kind,
      keyVersion: account.keyVersion,
    });
    expect(stored?.accessExpiresAt).toBe(SEED_NOW + 1);
    expect(stored?.updatedAt).toBe(SEED_NOW);
    expect(await decryptToken(key, stored?.accessToken ?? EMPTY, ctx("access"))).toBe("a2");
    expect(await decryptToken(key, stored?.refreshToken ?? EMPTY, ctx("refresh"))).toBe("r2");
  });

  it("keeps the stored refresh token when the provider did not rotate it", async () => {
    const account = await seedAccount({ refreshToken: "keep-me" });
    const key = await testEncKey();
    await (
      await tokenUpdateStmt(
        env.DB,
        account,
        key,
        { accessToken: "a3", accessExpiresAt: SEED_NOW + 2, refreshToken: null },
        SEED_NOW,
      )
    ).run();
    const stored = await getAccount(env.DB, account.id);
    const ctx = (kind: "refresh" | "access") => ({
      accountId: account.id,
      kind,
      keyVersion: account.keyVersion,
    });
    expect(await decryptToken(key, stored?.refreshToken ?? EMPTY, ctx("refresh"))).toBe("keep-me");
    expect(await decryptToken(key, stored?.accessToken ?? EMPTY, ctx("access"))).toBe("a3");
  });
  it("re-encrypts under the row's key_version, not CURRENT_KEY_VERSION", async () => {
    const seeded = await seedAccount({ provider: "outlook" });
    const account = { ...seeded, keyVersion: 2 };
    const key = await testEncKey();
    await (
      await tokenUpdateStmt(
        env.DB,
        account,
        key,
        { accessToken: "a4", accessExpiresAt: SEED_NOW + 3, refreshToken: "r4" },
        SEED_NOW,
      )
    ).run();
    const stored = await getAccount(env.DB, account.id);
    const ctx = (kind: "refresh" | "access", keyVersion: number) => ({
      accountId: account.id,
      kind,
      keyVersion,
    });
    expect(await decryptToken(key, stored?.accessToken ?? EMPTY, ctx("access", 2))).toBe("a4");
    expect(await decryptToken(key, stored?.refreshToken ?? EMPTY, ctx("refresh", 2))).toBe("r4");
    await expect(
      decryptToken(key, stored?.accessToken ?? EMPTY, ctx("access", CURRENT_KEY_VERSION)),
    ).rejects.toThrow();
    await expect(
      decryptToken(key, stored?.refreshToken ?? EMPTY, ctx("refresh", CURRENT_KEY_VERSION)),
    ).rejects.toThrow();
  });
});

describe("refreshFnFor and staticTokenSource", () => {
  it("throws ProviderConfigError when the provider client is not configured", async () => {
    const result = readConfig({ ...env, GOOGLE_CLIENT_ID: "" } as Env);
    if (!result.ok) throw new Error("config");
    const { oauth, calls } = fakeOAuth();
    const refresh = refreshFnFor(oauth, result.config, "gmail", fetch, () => SEED_NOW, "");
    await expect(refresh("rt")).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(refresh("rt")).rejects.toMatchObject({ provider: "gmail", reason: "client_not_configured" });
    expect(calls).toEqual([]);
  });

  it("calls the provider refresh helper with the client config", async () => {
    const result = readConfig(env);
    if (!result.ok) throw new Error("config");
    const { oauth, calls } = fakeOAuth();
    const refresh = refreshFnFor(oauth, result.config, "outlook", fetch, () => SEED_NOW, "");
    expect((await refresh("rt-1")).refreshToken).toBe("rotated-refresh");
    expect(calls).toEqual([{ fn: "refresh", provider: "outlook", value: "rt-1" }]);
  });

  it("serves a fixed token for connect-time bootstrap", async () => {
    const tokens = staticTokenSource("fixed");
    expect(await tokens.getAccessToken()).toBe("fixed");
    expect(await tokens.forceRefresh()).toBe("fixed");
  });
});
