import {
  buildGoogleAuthorizeUrl,
  buildMicrosoftAuthorizeUrl,
  createGmailProvider,
  createGraphProvider,
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  hasGmailScope,
  hasGraphScopes,
  refreshGoogleToken,
  refreshMicrosoftToken,
  revokeGoogleToken,
} from "@clearbox/core";
import type {
  AuthorizeParams,
  FetchLike,
  MailProvider,
  OAuthClientConfig,
  OAuthTokens,
  ProviderDeps,
  ProviderKind,
} from "@clearbox/core";
import type { AppConfig } from "../env.ts";

export interface ProviderTarget {
  provider: ProviderKind;
  archiveFolderId: string | null;
}

export type ProviderFactory = (target: ProviderTarget, deps: ProviderDeps) => MailProvider;

export const makeProvider: ProviderFactory = (target, deps) =>
  target.provider === "gmail"
    ? createGmailProvider(deps)
    : createGraphProvider({ ...deps, archiveFolderId: target.archiveFolderId });

export interface ProviderOAuth {
  buildAuthorizeUrl(cfg: OAuthClientConfig, params: AuthorizeParams): string;
  exchangeCode(
    f: FetchLike,
    cfg: OAuthClientConfig,
    code: string,
    codeVerifier: string,
    now: number,
  ): Promise<OAuthTokens>;
  refresh(f: FetchLike, cfg: OAuthClientConfig, refreshToken: string, now: number): Promise<OAuthTokens>;
  hasRequiredScopes(granted: readonly string[]): boolean;
  /** null when the provider has no revoke endpoint (Microsoft). */
  revoke: ((f: FetchLike, token: string) => Promise<boolean>) | null;
}

export type ProviderOAuthMap = Readonly<Record<ProviderKind, ProviderOAuth>>;

export const PROVIDER_OAUTH: ProviderOAuthMap = {
  gmail: {
    buildAuthorizeUrl: buildGoogleAuthorizeUrl,
    exchangeCode: exchangeGoogleCode,
    refresh: refreshGoogleToken,
    hasRequiredScopes: hasGmailScope,
    revoke: revokeGoogleToken,
  },
  outlook: {
    buildAuthorizeUrl: buildMicrosoftAuthorizeUrl,
    exchangeCode: exchangeMicrosoftCode,
    refresh: refreshMicrosoftToken,
    hasRequiredScopes: hasGraphScopes,
    revoke: null,
  },
};

export function routeSegment(provider: ProviderKind): "google" | "microsoft" {
  return provider === "gmail" ? "google" : "microsoft";
}

export function callbackPath(provider: ProviderKind): string {
  return `/oauth/${routeSegment(provider)}/callback`;
}

/** null when the provider's client id or secret is not configured. redirectUri is ignored by refresh grants. */
export function oauthClientConfig(
  config: AppConfig,
  provider: ProviderKind,
  redirectUri: string,
): OAuthClientConfig | null {
  const secrets = provider === "gmail" ? config.google : config.microsoft;
  return secrets ? { clientId: secrets.clientId, clientSecret: secrets.clientSecret, redirectUri } : null;
}
