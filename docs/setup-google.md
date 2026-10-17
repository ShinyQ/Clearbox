# Set up Google (Gmail)

Each Clearbox deployment uses its own Google OAuth client. Clearbox requests one scope, `https://www.googleapis.com/auth/gmail.modify`, which can read, label, archive and trash mail and add the optional weekly reminder note to your inbox (`messages.insert`; nothing is sent), but **cannot permanently delete** it.

You need the Worker URL from [setup-cloudflare.md](setup-cloudflare.md) (`https://clearbox.<subdomain>.workers.dev`). `pnpm setup:cf` prints the exact redirect URIs.

## 1. Project and Gmail API

1. Open the Google Cloud console and create a project (for example "Clearbox").
2. APIs & Services > Library > **Gmail API** > Enable. (CLI: `gcloud services enable gmail.googleapis.com --project <project-id>`.)

## 2. OAuth consent screen (Google Auth Platform)

1. **Branding**: app name `Clearbox`, your support email, your developer contact email. No logo (a logo triggers brand verification).
2. **Audience**:
   - Personal Gmail: user type **External**.
   - Google Workspace account: **Internal** is simplest (only users of your organization, no publishing step).
3. **Data access** > Add or remove scopes: add `https://www.googleapis.com/auth/gmail.modify` (listed under Gmail API as a restricted scope). Add nothing else.
4. **Publishing status** (External only): click **Publish app** so the status is **In production**.

### The 7-day Testing-mode gotcha

While an External app is in **Testing**, Google expires its refresh tokens after **7 days**. Every connected Gmail account would drop to "Reconnect" once a week. Always publish the app.

### "In production (unverified)"

A published app that requests a restricted scope without Google verification shows **"Google hasn't verified this app"** at sign-in. For your own mailbox this is expected: choose **Advanced > Go to Clearbox (unsafe)** and continue. Limits of an unverified app: at most 100 users over its lifetime, and the warning on every consent. Verification (with a security assessment for restricted scopes) is only needed if you offer the app to other people, which Clearbox does not do.

Test users are not needed once the app is in production.

## 3. OAuth client

1. Clients > **Create client** > Application type **Web application**, name `Clearbox`.
2. **Authorized redirect URIs** (exact match: scheme, host, path, no trailing slash):
   - `https://clearbox.<subdomain>.workers.dev/oauth/google/callback`
   - optional for local development: `http://localhost:5173/oauth/google/callback`
3. Authorized JavaScript origins: leave empty.
4. Create, then copy the **Client ID** (ends with `.apps.googleusercontent.com`) and the **Client secret**.
5. Run `pnpm setup:cf` and enter `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. If they are already set, answer "yes" when the script asks whether to replace them.
6. In Clearbox: on the **Setup** page (first account) or the **Accounts** page (later), click **Connect Gmail**. The sidebar has an **Add account** button too. On the consent screen keep the Gmail permission ticked; if you untick it, Clearbox refuses the connection (`scope_missing`, "Some permissions were not granted.").

## 4. When Gmail asks you to reconnect

Google invalidates the refresh token when:

- you change your Google password (tokens with Gmail scopes are revoked);
- it has not been used for 6 months;
- the app is still in Testing (7 days);
- more than 100 refresh tokens exist for the same account and client (the oldest is dropped);
- you remove Clearbox at https://myaccount.google.com/permissions;
- a Workspace admin restricts the scope (`admin_policy_enforced`). The admin must allow the app in the Admin console (Security > Access and data control > API controls).

The account shows **Reconnect**. Click it; Clearbox keeps your history and suggestions.

## 5. Configuration errors

| Message or state                                                                                | Cause                                                                                                                                                              | Fix                                                                                 |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Banner "Google sign-in is misconfigured.", account status "Setup error" (`config_error`)        | Wrong client id or secret, or the client was deleted (`invalid_client`, `deleted_client`; Google deletes clients unused for a long time, restorable for 30 days)   | Fix or recreate the client, update the secrets with `pnpm setup:cf`, then Reconnect |
| `redirect_uri_mismatch` on the Google page                                                      | Redirect URI not registered exactly                                                                                                                                | Copy the URI printed by `pnpm setup:cf` into the client                             |
| "Gmail is not set up yet." (`provider_not_configured`)                                          | `GOOGLE_CLIENT_ID` is empty                                                                                                                                        | Set it with `pnpm setup:cf`                                                         |
| "Google did not grant offline access." (`no_refresh_token`)                                     | Google returned no refresh token                                                                                                                                   | Remove Clearbox at https://myaccount.google.com/permissions and connect again       |

## 6. Disconnect

**Disconnect** in Clearbox revokes the token at Google (`oauth2.googleapis.com/revoke`), wipes it locally and purges that account's data in the nightly job. If Google does not confirm the revoke, Clearbox tells you; you can also remove access at https://myaccount.google.com/permissions.
