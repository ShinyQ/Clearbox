import { ProviderConfigError } from "@clearbox/core";
import type { BootstrapResult, OAuthTokens, ProviderKind } from "@clearbox/core";
import type { AppIssueCode } from "../../shared/api.ts";
import { CURRENT_KEY_VERSION, encryptToken, importEncKey } from "../crypto/aead.ts";
import {
  findOpenAccountByEmail,
  insertAccountStmt,
  reconnectAccountStmt,
  setInboxEstimateStmt,
} from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { addIssue, issuesEqual, readSettings, removeIssue, setIssuesStmt } from "../db/settings.ts";
import type { AppConfig, AppDeps } from "../env.ts";
import { logEvent, newAccountId } from "../log.ts";
import { oauthClientConfig } from "../scan/providers.ts";
import { staticTokenSource } from "../scan/token-source.ts";

export type ConnectError =
  "token_exchange_failed" | "provider_config_error" | "scope_missing" | "no_refresh_token" | "profile_failed";

export interface ConnectContext {
  db: D1Database;
  config: AppConfig;
  deps: AppDeps;
  /** `${origin}/oauth/<google|microsoft>/callback` of this request. */
  redirectUri: string;
}

export type ConnectResult =
  { ok: true; accountId: string; reconnected: boolean } | { ok: false; error: ConnectError };

export function clientIssueCode(provider: ProviderKind): AppIssueCode {
  return provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid";
}

async function updateClientIssue(
  ctx: ConnectContext,
  provider: ProviderKind,
  raise: boolean,
): Promise<D1PreparedStatement | null> {
  const now = ctx.deps.now();
  const code = clientIssueCode(provider);
  const current = (await readSettings(ctx.db)).issues;
  const next = raise ? addIssue(current, code, null, now) : removeIssue(current, code);
  if (issuesEqual(current, next)) return null;
  logEvent(raise ? "issue.raised" : "issue.cleared", { code, accountId: null });
  return setIssuesStmt(ctx.db, next, now);
}

/** Contracts 7.13 steps 3 to 8. Never throws for provider failures; returns the callback error code. */
export async function completeConnect(
  ctx: ConnectContext,
  provider: ProviderKind,
  code: string,
  codeVerifier: string,
): Promise<ConnectResult> {
  const { deps } = ctx;
  const oauth = deps.oauth[provider];
  const cfg = oauthClientConfig(ctx.config, provider, ctx.redirectUri);
  if (!cfg) return { ok: false, error: "provider_config_error" };

  let tokens: OAuthTokens;
  try {
    tokens = await oauth.exchangeCode(deps.fetch, cfg, code, codeVerifier, deps.now());
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      const stmt = await updateClientIssue(ctx, provider, true);
      if (stmt) await stmt.run();
      return { ok: false, error: "provider_config_error" };
    }
    return { ok: false, error: "token_exchange_failed" };
  }

  if (!oauth.hasRequiredScopes(tokens.grantedScopes)) {
    // Best effort (contracts 7.13 step 4): revoke never throws and a false result does not change the outcome.
    if (oauth.revoke) await oauth.revoke(deps.fetch, tokens.refreshToken ?? tokens.accessToken);
    return { ok: false, error: "scope_missing" };
  }
  const refreshToken = tokens.refreshToken;
  if (refreshToken === null) return { ok: false, error: "no_refresh_token" };

  let boot: BootstrapResult;
  let inboxEstimate: number | null;
  try {
    const mailbox = deps.providerFactory(
      { provider, archiveFolderId: null },
      { fetch: deps.fetch, tokens: staticTokenSource(tokens.accessToken), now: deps.now },
    );
    boot = await mailbox.bootstrap();
    try {
      // Contracts 12.1 A4: one best-effort request; the first backfill tick fills the column when this fails.
      inboxEstimate = await mailbox.inboxEstimate();
    } catch {
      inboxEstimate = null;
    }
  } catch {
    return { ok: false, error: "profile_failed" };
  }

  try {
    const now = deps.now();
    const existing = await findOpenAccountByEmail(ctx.db, provider, boot.email);
    const accountId = existing?.id ?? newAccountId();
    // Decision 23: inserts and reconnects always encrypt with and store the current key version.
    const keyVersion = CURRENT_KEY_VERSION;
    const encKey = await importEncKey(ctx.config.tokenEncKey);
    const enc = (value: string, kind: "refresh" | "access") =>
      encryptToken(encKey, value, { accountId, kind, keyVersion });
    const encRefresh = await enc(refreshToken, "refresh");
    const encAccess = await enc(tokens.accessToken, "access");
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(
        reconnectAccountStmt(ctx.db, accountId, {
          providerUserId: boot.providerUserId,
          keyVersion,
          refreshToken: encRefresh,
          accessToken: encAccess,
          accessExpiresAt: tokens.expiresAt,
          grantedScopes: tokens.grantedScopes,
          ownerAliases: boot.aliases,
          archiveFolderId: boot.archiveFolderId,
          now,
        }),
      );
    } else {
      statements.push(
        insertAccountStmt(ctx.db, {
          id: accountId,
          provider,
          email: boot.email,
          providerUserId: boot.providerUserId,
          grantedScopes: tokens.grantedScopes,
          ownerAliases: boot.aliases,
          archiveFolderId: boot.archiveFolderId,
          incrementalCursor: boot.incrementalCursor,
          keyVersion,
          refreshToken: encRefresh,
          accessToken: encAccess,
          accessExpiresAt: tokens.expiresAt,
          now,
        }),
      );
    }
    if (inboxEstimate !== null) statements.push(setInboxEstimateStmt(ctx.db, accountId, inboxEstimate, now));
    statements.push(
      auditStmt(ctx.db, {
        ts: now,
        accountId,
        kind: existing ? "account_reconnected" : "account_connected",
        batchId: null,
        count: 0,
        result: {},
      }),
    );
    const issueStmt = await updateClientIssue(ctx, provider, false);
    if (issueStmt) statements.push(issueStmt);
    await ctx.db.batch(statements);
    if (existing && existing.status !== "active") {
      logEvent("account.status", { accountId, from: existing.status, to: "active", reason: "reconnected" });
    }
    return { ok: true, accountId, reconnected: existing !== null };
  } catch {
    return { ok: false, error: "profile_failed" };
  }
}
