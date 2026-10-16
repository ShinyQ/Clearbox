import { setupErrorBanner, type AppBannerSpec } from "./banners.ts";
import { docsUrl } from "./links.ts";
import type { ProviderKind } from "./view-types.ts";

const RETRY = (label: string, onClick: () => void) => [{ label, kind: "callback" as const, onClick }];

/** Helper lines under the Connect buttons when a provider has no client credentials (UI spec 5.5). */
export const NOT_CONFIGURED: Record<ProviderKind, string> = {
  gmail:
    "Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/setup-google.md).",
  outlook:
    "Outlook is not set up yet. Add MS_CLIENT_ID and MS_CLIENT_SECRET as Worker secrets (see docs/setup-microsoft.md).",
};

/** UI spec 5.5 OAuth return table. */
export function oauthErrorBanner(
  code: string,
  provider: ProviderKind | null,
  retry: () => void,
): AppBannerSpec | null {
  const p = provider ?? "gmail";
  const warn = (title: string, body: string): AppBannerSpec => ({
    id: `oauth-${code}`,
    tone: "warning",
    title,
    body,
    actions: RETRY("Try again", retry),
  });
  const err = (title: string, body: string): AppBannerSpec => ({
    id: `oauth-${code}`,
    tone: "error",
    title,
    body,
    actions: RETRY("Try again", retry),
  });
  switch (code) {
    case "access_denied":
      return warn(
        "Access was not granted.",
        "You cancelled the sign-in or declined the permissions. Clearbox needs them to sort your mail.",
      );
    case "admin_consent_required":
      return warn(
        "Your organization must approve Clearbox first.",
        "Ask your Microsoft 365 admin to grant consent for this app, then try again.",
      );
    case "state_invalid":
      return warn("The sign-in took too long or was opened in another tab.", "Start again from this page.");
    case "token_exchange_failed":
      return err("The provider did not complete the sign-in.", "Wait a moment and try again.");
    case "provider_config_error":
      return { ...setupErrorBanner(p), id: `oauth-${code}` };
    case "scope_missing":
      return warn(
        "Some permissions were not granted.",
        "Clearbox needs permission to read and organize mail. Try again and keep every box checked.",
      );
    case "no_refresh_token":
      return warn(
        "Google did not grant offline access.",
        "Remove Clearbox at myaccount.google.com/permissions, then connect again.",
      );
    case "profile_failed":
      return err(
        "Connected, but Clearbox could not read the mailbox profile.",
        "Try again. If it keeps failing, check that the Gmail API (or Microsoft Graph) is enabled.",
      );
    case "provider_not_configured":
      return {
        id: `oauth-${code}`,
        tone: "warning",
        title: p === "gmail" ? "Gmail is not set up yet." : "Outlook is not set up yet.",
        body:
          p === "gmail"
            ? "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets, then redeploy."
            : "Add MS_CLIENT_ID and MS_CLIENT_SECRET as Worker secrets, then redeploy.",
        actions: [
          {
            label: "Open setup guide",
            kind: "link",
            href: docsUrl(p === "gmail" ? "setup-google.md" : "setup-microsoft.md"),
          },
        ],
      };
    default:
      return null;
  }
}
