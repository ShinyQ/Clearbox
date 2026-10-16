import { ACCESS_TOKEN_MIN_TTL_MS, ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { FetchLike, OAuthTokens, ProviderKind, TokenSource, TokenUpdate } from "@clearbox/core";
import { decryptToken, encryptToken } from "../crypto/aead.ts";
import type { TokenKind } from "../crypto/aead.ts";
import { accessTokenUpdateStmt, tokensUpdateStmt } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import type { AppConfig } from "../env.ts";
import { oauthClientConfig } from "./providers.ts";
import type { ProviderOAuthMap } from "./providers.ts";

// TokenUpdate (contracts 4.4 / 7.15) comes from @clearbox/core (plan 01); refreshToken is non-null when the
// provider rotated the refresh token (Microsoft: every refresh).

export type RefreshFn = (refreshToken: string) => Promise<OAuthTokens>;

export type TokenAccount = Pick<
  Account,
  "id" | "provider" | "keyVersion" | "refreshToken" | "accessToken" | "accessExpiresAt"
>;

export interface D1TokenSourceOptions {
  account: TokenAccount;
  encKey: CryptoKey;
  refresh: RefreshFn;
  now: () => number;
}

export interface D1TokenSource extends TokenSource {
  readonly update: TokenUpdate | null;
  readonly refreshCount: number;
}

export function createD1TokenSource(opts: D1TokenSourceOptions): D1TokenSource {
  const { account } = opts;
  let cached: { token: string; expiresAt: number } | null = null;
  let refreshToken: string | null = null;
  let update: TokenUpdate | null = null;
  let refreshCount = 0;
  // Decryption uses the row's key_version (decision 23).
  const ctx = (kind: TokenKind) => ({ accountId: account.id, kind, keyVersion: account.keyVersion });

  async function currentRefreshToken(): Promise<string> {
    if (refreshToken !== null) return refreshToken;
    if (!account.refreshToken)
      throw new ProviderAuthError({ provider: account.provider, reason: "no_refresh_token" });
    try {
      refreshToken = await decryptToken(opts.encKey, account.refreshToken, ctx("refresh"));
    } catch (cause) {
      throw new ProviderAuthError({ provider: account.provider, reason: "token_decrypt_failed", cause });
    }
    return refreshToken;
  }

  async function forceRefresh(): Promise<string> {
    const tokens = await opts.refresh(await currentRefreshToken());
    refreshCount += 1;
    if (tokens.refreshToken) refreshToken = tokens.refreshToken;
    cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    update = {
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken ?? update?.refreshToken ?? null,
    };
    return tokens.accessToken;
  }

  async function getAccessToken(): Promise<string> {
    const now = opts.now();
    if (cached && cached.expiresAt - now >= ACCESS_TOKEN_MIN_TTL_MS) return cached.token;
    if (
      !cached &&
      account.accessToken &&
      account.accessExpiresAt !== null &&
      account.accessExpiresAt - now >= ACCESS_TOKEN_MIN_TTL_MS
    ) {
      try {
        const token = await decryptToken(opts.encKey, account.accessToken, ctx("access"));
        cached = { token, expiresAt: account.accessExpiresAt };
        return token;
      } catch {
        // An unreadable cached access token is replaced by a refresh.
      }
    }
    return forceRefresh();
  }

  return {
    getAccessToken,
    forceRefresh,
    get update() {
      return update;
    },
    get refreshCount() {
      return refreshCount;
    },
  };
}

export function refreshFnFor(
  oauth: ProviderOAuthMap,
  config: AppConfig,
  provider: ProviderKind,
  fetch: FetchLike,
  now: () => number,
  redirectUri: string,
): RefreshFn {
  return async (rt) => {
    const cfg = oauthClientConfig(config, provider, redirectUri);
    if (!cfg) throw new ProviderConfigError({ provider, reason: "client_not_configured" });
    return oauth[provider].refresh(fetch, cfg, rt, now());
  };
}

/** Re-encrypts in place under the row's key_version (decision 23: only inserts and reconnects write CURRENT_KEY_VERSION). */
export async function tokenUpdateStmt(
  db: D1Database,
  account: TokenAccount,
  encKey: CryptoKey,
  update: TokenUpdate,
  now: number,
): Promise<D1PreparedStatement> {
  const ctx = (kind: TokenKind) => ({ accountId: account.id, kind, keyVersion: account.keyVersion });
  const access = await encryptToken(encKey, update.accessToken, ctx("access"));
  if (update.refreshToken !== null) {
    const refresh = await encryptToken(encKey, update.refreshToken, ctx("refresh"));
    return tokensUpdateStmt(db, account.id, refresh, access, update.accessExpiresAt, now);
  }
  return accessTokenUpdateStmt(db, account.id, access, update.accessExpiresAt, now);
}

/** Connect-time bootstrap uses the freshly exchanged access token (contracts 7.13 step 6). */
export function staticTokenSource(accessToken: string): TokenSource {
  return {
    getAccessToken: async () => accessToken,
    forceRefresh: async () => accessToken,
  };
}
