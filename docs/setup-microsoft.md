# Set up Microsoft (Outlook)

Each Clearbox deployment uses its own Microsoft Entra app registration. Clearbox requests the delegated Microsoft Graph permissions `offline_access`, `User.Read` and `Mail.ReadWrite`. It moves mail between folders (Deleted Items, Archive, Inbox) and never deletes permanently.

You need the Worker URL from [setup-cloudflare.md](setup-cloudflare.md) (`https://clearbox.<subdomain>.workers.dev`).

## 1. Register the app

You need access to an Entra tenant. A personal Microsoft account can create one by signing up for a free Azure account; the app can still sign in personal outlook.com accounts.

1. Microsoft Entra admin center > Identity > Applications > **App registrations** > **New registration**.
2. Name: `Clearbox`.
3. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (`AzureADandPersonalMicrosoftAccount`). Clearbox signs in through the `common` endpoint; a single-tenant app fails with AADSTS50194.
4. Redirect URI: platform **Web**, `https://clearbox.<subdomain>.workers.dev/oauth/microsoft/callback`. Use HTTPS, no query string, exact case.
5. Register, then copy the **Application (client) ID** from the Overview page.

## 2. Authentication settings

- Authentication > Web > add `http://localhost:5173/oauth/microsoft/callback` if you develop locally.
- Leave implicit grant (access tokens and ID tokens) **off**.
- Leave "Allow public client flows" **No**.
- Do not add the URI under the "Single-page application" platform: SPA refresh tokens expire after 24 hours.

## 3. Client secret

1. Certificates & secrets > Client secrets > **New client secret**. Expiry: 12 months is a good default (the portal maximum is 24 months).
2. Copy the secret **Value** immediately (not the Secret ID). It is shown once.
3. Put a reminder in your calendar a few weeks before expiry (the [runbook](runbook.md) covers rotating the Entra client secret).

## 4. API permissions

API permissions > Add a permission > Microsoft Graph > **Delegated permissions**: `offline_access`, `User.Read`, `Mail.ReadWrite`. Do not add application permissions. Personal accounts consent themselves on first sign-in.

## 5. Store the values and connect

1. Run `pnpm setup:cf` and enter `MS_CLIENT_ID` (the Application ID) and `MS_CLIENT_SECRET` (the secret value). If they are already set, answer "yes" when the script asks whether to replace them.
2. In Clearbox: on the **Setup** page (first account) or the **Accounts** page (later), click **Connect Outlook**, pick your account and accept the permissions. The sidebar has an **Add account** button too.

## 6. Work or school accounts: admin consent

Many organizations block users from consenting to `Mail.ReadWrite` for unknown apps, or block them with Conditional Access. Symptoms: Microsoft shows "Need admin approval", or Clearbox shows "Your organization must approve Clearbox first." (`admin_consent_required`; AADSTS90094, AADSTS65001) or a Conditional Access block (AADSTS53003).

An administrator of that tenant can grant consent once:

- Entra admin center > Enterprise applications > Clearbox > Permissions > **Grant admin consent for <organization>**, or
- open `https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<app-id>` while signed in as an admin.

If the organization does not allow third-party mail apps at all, Clearbox cannot be used with that mailbox.

## 7. No revoke endpoint

Microsoft has no OAuth token revocation endpoint for these permissions. **Disconnect** in Clearbox wipes the tokens locally and purges the account's data, then shows a banner with two buttons so you can remove the grant yourself:

- **Personal account**: https://account.live.com/consent/Manage
- **Work or school account**: https://myapps.microsoft.com (grants given by an admin can only be removed by an admin).

## 8. Errors

| Error                      | Meaning                                                                         | Fix                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AADSTS7000215              | Invalid client secret                                                           | Paste the secret Value (not the ID) with `pnpm setup:cf`                                 |
| AADSTS7000222              | Client secret expired                                                           | Create a new secret, update `MS_CLIENT_SECRET`, Reconnect accounts in "Setup error"      |
| AADSTS50011                | Redirect URI mismatch                                                           | Register the exact URI printed by `pnpm setup:cf` under the Web platform                 |
| AADSTS50194                | App is single-tenant                                                            | Change Supported account types (Authentication > Supported accounts) or recreate the app |
| AADSTS700016               | App not found in the directory                                                  | Wrong `MS_CLIENT_ID`                                                                     |
| AADSTS70008, 700082, 50173 | Refresh token expired or revoked (inactivity, password reset, revoked sessions) | Reconnect                                                                                |

A rejected client secret shows the banner "Microsoft sign-in is misconfigured." and the account status "Setup error".

Microsoft refresh tokens rotate on every use; Clearbox stores the new one after each refresh. An account that is checked at least every 90 days does not expire for inactivity.
