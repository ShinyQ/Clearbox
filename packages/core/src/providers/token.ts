/** What a token source hands back to the tick for re-encryption and persistence (contracts 7.15). */
export interface TokenUpdate {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  /** Non-null when the provider returned a new refresh token (Microsoft rotation). */
  refreshToken: string | null;
}

export interface TokenSource {
  /** Valid access token; refreshes when fewer than ACCESS_TOKEN_MIN_TTL_MS remain. */
  getAccessToken(): Promise<string>;
  /** Refresh unconditionally (after a 401). */
  forceRefresh(): Promise<string>;
}

export interface OAuthTokens {
  accessToken: string;
  /** Epoch ms = now + expires_in * 1000. */
  expiresAt: number;
  /** Google: only on code exchange. Microsoft: on exchange AND every refresh (rotation). */
  refreshToken: string | null;
  grantedScopes: string[];
  refreshTokenExpiresAt: number | null;
}
