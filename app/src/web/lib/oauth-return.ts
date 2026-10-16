import { browser } from "./links.ts";
import type { ProviderKind } from "./view-types.ts";

export const OAUTH_RETURN_KEY = "clearbox.oauthReturn";
type ReturnPath = "/setup" | "/accounts";

/** UI spec 4.3 and 5.5: remember the page, then leave the SPA for the provider's sign-in. */
export function startOAuth(
  provider: ProviderKind,
  opts: { returnTo: ReturnPath; loginHint?: string | undefined },
): void {
  window.sessionStorage.setItem(OAUTH_RETURN_KEY, opts.returnTo);
  const base = provider === "gmail" ? "/oauth/google/start" : "/oauth/microsoft/start";
  browser.assign(opts.loginHint ? `${base}?loginHint=${encodeURIComponent(opts.loginHint)}` : base);
}

export function consumeOAuthReturn(): ReturnPath {
  const value = window.sessionStorage.getItem(OAUTH_RETURN_KEY);
  window.sessionStorage.removeItem(OAUTH_RETURN_KEY);
  return value === "/setup" ? "/setup" : "/accounts";
}
