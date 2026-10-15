export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Exact redirect URI: `${origin}/oauth/google/callback` or `${origin}/oauth/microsoft/callback`. */
  redirectUri: string;
}

export interface AuthorizeParams {
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"] as const;
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"] as const;

/** Microsoft has no revoke endpoint for these scopes; Disconnect shows these links. */
export const MICROSOFT_CONSENT_URLS = {
  personal: "https://account.live.com/consent/Manage",
  work: "https://myapps.microsoft.com",
} as const;
