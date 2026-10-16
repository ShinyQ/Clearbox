import type { FetchLike, ProviderKind, TokenUpdate } from "@clearbox/core";
import { encryptToken } from "../crypto/aead.ts";
import type { EncryptedValue } from "../crypto/aead.ts";
import { bytesFromBlob } from "../crypto/base64.ts";
import type { AppConfig } from "../env.ts";
import { PROVIDER_OAUTH } from "./providers.ts";
import type { ProviderOAuthMap, ProviderTarget } from "./providers.ts";
import { createD1TokenSource, refreshFnFor } from "./token-source.ts";
import type { D1TokenSource, TokenAccount } from "./token-source.ts";

/** The token columns of a claimed accounts row, as D1 returns them (BLOBs untyped). */
export interface TickTokenRow {
  id: string;
  provider: ProviderKind;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
}

function pair(ciphertext: unknown, iv: unknown): EncryptedValue | null {
  const c = bytesFromBlob(ciphertext);
  const i = bytesFromBlob(iv);
  return c && i ? { ciphertext: c, iv: i } : null;
}

export function tokenAccountOf(row: TickTokenRow): TokenAccount {
  return {
    id: row.id,
    provider: row.provider,
    keyVersion: row.key_version,
    refreshToken: pair(row.enc_refresh_token, row.refresh_iv),
    accessToken: pair(row.enc_access_token, row.access_iv),
    accessExpiresAt: row.access_expires_at,
  };
}

export interface TickTokenOptions {
  row: TickTokenRow;
  config: AppConfig;
  encKey: CryptoKey;
  /** The tick's counted fetch: refreshes reserve from the tick subrequest counter. */
  fetch: FetchLike;
  now: number;
  /** Tests may inject; default PROVIDER_OAUTH (plan 02 helpers). */
  oauth?: ProviderOAuthMap;
}

/**
 * Plan 03's D1 token source for one tick. Refresh grants send no redirect URI and a cron has no origin, so "".
 * The source has no single-flight refresh: provider calls for one account must stay sequential (never
 * Promise.all them), or concurrent expiry checks would each trigger a refresh.
 */
export function openTickTokens(o: TickTokenOptions): D1TokenSource {
  const now = () => o.now;
  return createD1TokenSource({
    account: tokenAccountOf(o.row),
    encKey: o.encKey,
    refresh: refreshFnFor(o.oauth ?? PROVIDER_OAUTH, o.config, o.row.provider, o.fetch, now, ""),
    now,
  });
}

export function providerTargetOf(row: {
  provider: ProviderKind;
  archive_folder_id: string | null;
}): ProviderTarget {
  return { provider: row.provider, archiveFolderId: row.archive_folder_id };
}

/** Encrypted columns for the tick's guarded account update (contracts 7.15; never written to a disconnected account). */
export interface TokenColumns {
  encAccess: Uint8Array<ArrayBuffer>;
  accessIv: Uint8Array<ArrayBuffer>;
  accessExpiresAt: number;
  encRefresh: Uint8Array<ArrayBuffer> | null;
  refreshIv: Uint8Array<ArrayBuffer> | null;
}

/**
 * Re-encrypts under the row's key_version, never CURRENT_KEY_VERSION (decision 23), mirroring plan 03's
 * `tokenUpdateStmt` in token-source.ts. That function inlines the logic and returns a statement, so it
 * cannot be shared without changing plan 03's exports.
 */
export async function encryptTokenUpdate(
  encKey: CryptoKey,
  account: { id: string; key_version: number },
  update: TokenUpdate,
): Promise<TokenColumns> {
  const ctx = (kind: "refresh" | "access") => ({
    accountId: account.id,
    kind,
    keyVersion: account.key_version,
  });
  const access = await encryptToken(encKey, update.accessToken, ctx("access"));
  const refresh =
    update.refreshToken === null ? null : await encryptToken(encKey, update.refreshToken, ctx("refresh"));
  return {
    encAccess: access.ciphertext,
    accessIv: access.iv,
    accessExpiresAt: update.accessExpiresAt,
    encRefresh: refresh?.ciphertext ?? null,
    refreshIv: refresh?.iv ?? null,
  };
}
