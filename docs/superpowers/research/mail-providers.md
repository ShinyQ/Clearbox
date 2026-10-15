# Mail provider research: Gmail API and Microsoft Graph mail

Researched and verified on 2026-10-15 against current official documentation. No real mailbox was called and no OAuth app was created. The only live requests made were unauthenticated probes (Gmail batch endpoint, Google token and revoke endpoints with bogus values, Google discovery documents) to confirm endpoint shapes.

Legend used in this document:

- **[Verified]**: stated in the cited official page (or an official discovery document).
- **[Observed]**: confirmed by an unauthenticated live probe on 2026-10-15.
- **[Unverified]**: not stated in official docs; based on community reports or reasoning. Must be confirmed with a recorded fixture from the owner's own mailbox before it is relied on.

Note: `developers.google.com/gmail/api/...` now redirects to `developers.google.com/workspace/gmail/api/...`. URLs below use the new paths.

---

## 1. OAuth

### 1.1 Google (Gmail)

Sources:

- G1: https://developers.google.com/identity/protocols/oauth2/web-server
- G2: https://developers.google.com/identity/protocols/oauth2 (section "Refresh token expiration")
- G3: https://accounts.google.com/.well-known/openid-configuration
- G4: https://developers.google.com/identity/protocols/oauth2/native-app (PKCE parameter definitions)
- G5: https://developers.google.com/workspace/gmail/api/auth/scopes

**Endpoints [Verified G1, G3]**

| Purpose | URL |
|---|---|
| Authorize | `https://accounts.google.com/o/oauth2/v2/auth` (HTTPS only) |
| Token (code exchange and refresh) | `POST https://oauth2.googleapis.com/token` (`application/x-www-form-urlencoded`) |
| Revoke | `POST https://oauth2.googleapis.com/revoke` |

**Authorize request**

```
GET https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=<CLIENT_ID>
  &redirect_uri=https%3A%2F%2Fclearbox.example.com%2Foauth%2Fgoogle%2Fcallback
  &response_type=code
  &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify
  &access_type=offline
  &prompt=consent
  &state=<signed state>
  &code_challenge=<BASE64URL(SHA256(verifier))>
  &code_challenge_method=S256
```

- `access_type=offline` is required to get a refresh token. [Verified G1]
- `prompt=consent` forces the consent screen. Without it, the user is only prompted the first time, and Google's own note says "The `refresh_token` is only returned on the first authorization". Re-connecting an account without `prompt=consent` can therefore return no refresh token. Keep `prompt=consent`. [Verified G1]
- `login_hint` (optional) can pre-select the account on re-auth. [Verified G1]
- `include_granted_scopes` is not needed (single scope).
- **PKCE:** the Google discovery document lists `code_challenge_methods_supported: ["plain","S256"]` [Verified G3]. The web-server guide (G1) does not list `code_challenge` in its parameter table; it is documented in the native-app guide (G4: verifier 43 to 128 chars of `[A-Za-z0-9-._~]`, `code_challenge = BASE64URL(SHA256(ASCII(verifier)))`). Sending PKCE with a web client is accepted by the server, but treat it as defense in depth: the web client must still send `client_secret`. [Verified G3/G4; web-client combination Unverified in docs, widely used]
- Granular consent is always on for new clients: the user can untick scopes. The token response `scope` field must be checked to contain `https://www.googleapis.com/auth/gmail.modify`; if missing, reject the connection with a clear message. [Verified G1 "Step 6: Check which scopes users granted"]

Callback: `?code=...&state=...` or `?error=access_denied&state=...` on the query string. [Verified G1]

**Code exchange [Verified G1]**

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

code=<code>&client_id=<id>&client_secret=<secret>&redirect_uri=<same redirect>&grant_type=authorization_code&code_verifier=<verifier>
```

```json
{
  "access_token": "ya29.a0...",
  "expires_in": 3599,
  "token_type": "Bearer",
  "scope": "https://www.googleapis.com/auth/gmail.modify",
  "refresh_token": "1//0g..."
}
```

`refresh_token_expires_in` appears only if the user granted "time-based access" (refresh token then expires after that duration). Store it if present. [Verified G1]

**Refresh [Verified G1]**

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id=<id>&client_secret=<secret>&refresh_token=<rt>&grant_type=refresh_token
```

```json
{ "access_token": "ya29.a0...", "expires_in": 3599, "scope": "https://www.googleapis.com/auth/gmail.modify", "token_type": "Bearer" }
```

- **Google does not return a new refresh token on refresh.** The documented refresh response has no `refresh_token`. Keep using the stored one; no D1 write is needed on refresh. [Verified G1]
- Docs label `client_secret` as "Optional" in both tables; for a confidential web client always send it. (DPoP is an optional new feature; not needed.)

**Refresh token lifetime and invalidation [Verified G2]**

A Google refresh token stops working when:

- the user revokes access;
- it has not been used for **six months**;
- **the user changes password and the token contains Gmail scopes** (relevant: every password change forces re-auth);
- the account exceeds the max number of live refresh tokens (limit **100 per Google Account per client ID**; the oldest is silently invalidated);
- time-based access expired;
- an admin restricts the scope (`admin_policy_enforced`).
- **Testing publishing status with External user type: refresh tokens expire in 7 days** (unless only basic profile scopes are requested). [Verified G2]

**Error shapes**

```json
{ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }
```

- `error: "invalid_grant"` is the documented code for expired or revoked refresh tokens [Verified G1]. The exact `error_description` text above is the commonly observed one [Unverified]; match only on `error`.
- GCP session control policies return `invalid_grant` with `"error_subtype": "invalid_rapt"` [Verified G2]. Treat the same as `invalid_grant` (needs re-auth).
- Wrong client credentials: [Observed] `{"error":"invalid_client","error_description":"The OAuth client was not found."}`. This is an owner configuration problem, not a user re-auth problem.
- `deleted_client`: OAuth clients unused for a long time can be auto-deleted (restorable for 30 days). [Verified G1]

**User's email address with only `gmail.modify`**

`GET https://gmail.googleapis.com/gmail/v1/users/me/profile` (1 quota unit) returns `emailAddress`, `messagesTotal`, `threadsTotal`, `historyId`. [Verified: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile]. No `openid`/`email` scope and no ID token needed.

**Revocation [Verified G1]**

```
POST https://oauth2.googleapis.com/revoke
Content-Type: application/x-www-form-urlencoded

token=<refresh_token or access_token>
```

- 200 on success. 400 with an error code on failure; [Observed] bogus token returns `{"error":"invalid_token"}`.
- Revoking an access token also revokes its refresh token. Revocation removes **all scopes granted to the project** and may take some time to take effect.
- Users can also revoke at https://myaccount.google.com/permissions.

**Client and redirect URI rules [Verified G1 "Redirect URI validation rules"]**

- Client type: **Web application** (has a client secret).
- Redirect URI must exactly match (scheme, case, trailing slash). HTTPS required; localhost (and localhost IPs) exempt. No raw IPs, no fragments, no wildcards, no userinfo, no path traversal, TLD must be on the public suffix list. `*.workers.dev` is on the public suffix list, so `https://<name>.<account>.workers.dev/oauth/google/callback` is valid.

**Scope classification [Verified G5]**: `gmail.modify` is a **Restricted** scope: "Read, compose, and send emails from your Gmail account. This scope does not allow immediate, permanent deletion of threads and messages, bypassing the trash." Hard delete (`messages.delete`, `batchDelete`) requires `https://mail.google.com/` only [Verified: Gmail discovery document scopes], so with `gmail.modify` Clearbox physically cannot hard-delete. Good for the safety story.

### 1.2 Microsoft (Entra ID, Microsoft Graph)

Sources:

- M1: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- M2: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- M3: https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
- M4: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- M5: https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
- M6: https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-application-configuration#authority
- M7: https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes
- M8: https://learn.microsoft.com/en-us/graph/api/user-revokesigninsessions?view=graph-rest-1.0
- M9: https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0 and https://learn.microsoft.com/en-us/graph/api/resources/user?view=graph-rest-1.0

**Tenant segment [Verified M1, M6]**

| `{tenant}` | Who can sign in |
|---|---|
| `common` | Work/school **and** personal Microsoft accounts |
| `organizations` | Work/school only |
| `consumers` | Personal Microsoft accounts only |
| tenant GUID or domain | That tenant only |

Use `common`. The app registration's "Supported account types" must match ("Accounts in any organizational directory and personal Microsoft accounts", `signInAudience = AzureADandPersonalMicrosoftAccount`). A single-tenant app created recently that calls `/common` gets **AADSTS50194**. [Verified M3]

**Authorize request [Verified M1]**

```
GET https://login.microsoftonline.com/common/oauth2/v2.0/authorize
  ?client_id=<APP_ID>
  &response_type=code
  &redirect_uri=https%3A%2F%2Fclearbox.example.com%2Foauth%2Fmicrosoft%2Fcallback
  &response_mode=query
  &scope=offline_access%20User.Read%20Mail.ReadWrite
  &state=<signed state>
  &code_challenge=<BASE64URL(SHA256(verifier))>
  &code_challenge_method=S256
  &prompt=select_account
```

- Scopes without a resource prefix default to Microsoft Graph (`User.Read` = `https://graph.microsoft.com/User.Read`). [Verified M5]
- `offline_access` must be requested explicitly to receive a refresh token on v2.0. [Verified M5]
- `prompt` values: `login`, `none`, `consent`, `select_account`. `prompt=consent` is not required for a refresh token (unlike Google); `select_account` is useful to let the owner pick the right account. [Verified M1]
- **PKCE** "is now recommended for all application types, both public and confidential clients"; both `plain` and `S256` supported. [Verified M1]
- `response_mode`: default `query` for code-only requests. Docs recommend `form_post`, but **`form_post` sends a cross-site POST to the callback, so a `SameSite=Lax` state cookie is not sent**. Clearbox should use `response_mode=query` (code only, no `id_token`), which keeps the Lax state cookie working. [Verified M1; cookie interaction is standard browser behavior]
- Error redirect: `?error=<code>&error_description=...&state=...` (e.g. `access_denied`, `consent_required`, `interaction_required`). [Verified M1]

**Code exchange [Verified M1]**

```
POST https://login.microsoftonline.com/common/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=<id>&scope=offline_access%20User.Read%20Mail.ReadWrite&code=<code>&redirect_uri=<same>&grant_type=authorization_code&code_verifier=<verifier>&client_secret=<url-encoded secret>
```

```json
{
  "token_type": "Bearer",
  "scope": "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
  "expires_in": 3599,
  "access_token": "EwB...",
  "refresh_token": "M.C5..."
}
```

(No `id_token` because `openid` is not requested.) The `scope` value lists granted scopes; check it contains `Mail.ReadWrite` (case-insensitive, with or without the `https://graph.microsoft.com/` prefix). [Verified M1; exact scope string format Unverified, docs sample shows a URL-encoded value]

**Refresh [Verified M1, M2]**

```
POST https://login.microsoftonline.com/common/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=<id>&grant_type=refresh_token&refresh_token=<rt>&client_secret=<secret>&scope=offline_access%20User.Read%20Mail.ReadWrite
```

Response has the same shape as the code exchange and **includes a new `refresh_token`**: "Refresh tokens replace themselves with a fresh token upon every use ... Securely delete the old refresh token after acquiring a new one." Old tokens are not revoked on use, but the docs say to replace. **Clearbox must re-encrypt and persist the new refresh token after every Microsoft refresh** (1 D1 write per refresh). [Verified M2]

**Lifetime [Verified M2, M7]**: default **90 days** for web apps (24 hours for SPA redirect URIs, which Clearbox must not use). `MaxInactiveTime` is 90 days and max age is "until-revoked", so with a refresh every scan (every 30 minutes) the token effectively never expires. Confidential client tokens survive user password changes (they are revoked when the user or an admin revokes refresh tokens, or when an admin resets the password in Entra/M365 admin centers). [Verified M2 revocation table]

**Error shape [Verified M1]**

```json
{
  "error": "invalid_grant",
  "error_description": "AADSTS700082: The refresh token has expired due to inactivity. ...\r\nTrace ID: ...\r\nCorrelation ID: ...\r\nTimestamp: ...",
  "error_codes": [700082],
  "timestamp": "2026-10-15 09:00:00Z",
  "trace_id": "...",
  "correlation_id": "..."
}
```

AADSTS codes relevant to Clearbox [Verified M3]:

| Code | Meaning | Clearbox action |
|---|---|---|
| 70008 | ExpiredOrRevokedGrant: refresh token expired due to inactivity | `needs_reauth` |
| 700082 | ExpiredOrRevokedGrantInactiveToken | `needs_reauth` |
| 50173 | Grant expired because it was revoked (password changed or reset) | `needs_reauth` |
| 70000 | InvalidGrant: refresh token isn't valid | `needs_reauth` |
| 70043 | Refresh token expired by Conditional Access sign-in frequency | `needs_reauth` |
| 50076 / 50079 / 50078 | MFA required / enrollment / expired | `needs_reauth` (comes as `interaction_required`) |
| 53003 | Blocked by Conditional Access | `needs_reauth` + show admin hint |
| 65001 | Consent missing (DelegationDoesNotExist) | `needs_reauth` |
| 90094 | Admin consent required | show admin-consent instructions |
| 54005 | Auth code already redeemed | restart connect flow |
| 50148 / 501481 | PKCE verifier mismatch | restart connect flow (bug) |
| 50011 | Redirect URI mismatch | owner config error |
| 50194 | App not multitenant but `/common` used | owner config error |
| 700016 | App not found in directory | owner config error |
| 7000215 | Invalid client secret | **owner config error, not user re-auth** |
| 7000222 | Client secret expired | **owner config error, not user re-auth** |

Classification rule: `error === "invalid_grant"` or `"interaction_required"` → `needs_reauth`; `error === "invalid_client"` or `"unauthorized_client"` → app configuration error (banner for the owner, all Microsoft accounts affected); `"temporarily_unavailable"` → retry.

**User's email with `User.Read` [Verified M9]**: `GET https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName`. Default properties include `mail` and `userPrincipalName`. Use `mail ?? userPrincipalName`. For personal accounts `mail` may be null and `userPrincipalName` holds the sign-in address [Unverified for MSA; record a fixture].

**Revocation**: Entra ID has **no OAuth token revocation endpoint**. `POST /me/revokeSignInSessions` needs `User.RevokeSessions.All` and is "Not supported" for personal accounts [Verified M8]; it would also sign the user out of everything. Therefore: on disconnect, delete the encrypted token locally and instruct the user to remove consent:

- Personal accounts: https://account.live.com/consent/Manage [Unverified as an official doc link; referenced from Microsoft Q&A]
- Work/school: https://myapps.microsoft.com (user-consented apps; admin-consented grants can only be removed by an admin) [Unverified; Microsoft Q&A answer https://learn.microsoft.com/answers/a/1911536]

**Client and redirect URI rules [Verified M1, M4]**

- Platform: **Web**, with client secret (or certificate). PKCE plus client secret is the recommended combination for confidential clients.
- Redirect URIs must use `https`, except `http://localhost`. Case-sensitive. Max 256 characters. **Query parameters are not allowed in redirect URIs for apps that sign in personal Microsoft accounts.** URIs without a path get a trailing slash appended in the response.
- Client secrets expire (portal maximum 24 months [Unverified, portal UI]): plan a rotation reminder in `docs/runbook.md`. Expiry shows up as AADSTS7000222.

---

## 2. Gmail reading

Sources:

- GM1 messages.list: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- GM2 messages.get: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
- GM3 Message resource: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- GM4 batch: https://developers.google.com/workspace/gmail/api/guides/batch
- GM5 sync: https://developers.google.com/workspace/gmail/api/guides/sync
- GM6 history.list: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- GM7 labels: https://developers.google.com/workspace/gmail/api/guides/labels
- GM8 filtering: https://developers.google.com/workspace/gmail/api/guides/filtering
- GM9 discovery: https://gmail.googleapis.com/$discovery/rest?version=v1 (revision 20261012)
- GM10 performance (partial response `fields`): https://developers.google.com/workspace/gmail/api/guides/performance
- GM11 threads.get: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get

Base URL: `https://gmail.googleapis.com/gmail/v1/users/me/...` [Verified GM9: `rootUrl` `https://gmail.googleapis.com/`, `servicePath` empty, method paths `gmail/v1/users/{userId}/...`].

### 2.1 messages.list [Verified GM1]

```
GET https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=25&pageToken=<token>
```

| Param | Notes |
|---|---|
| `q` | Gmail search syntax, e.g. `in:inbox`, `in:sent`, `has:attachment`, `rfc822msgid:<id>`. Dates in `after:/before:` are PST midnight unless given as epoch seconds [Verified GM8] |
| `labelIds` | Repeatable; messages must match **all** labels. `labelIds=INBOX` is an exact label match and is equivalent to the inbox view |
| `maxResults` | Default 100, max 500 |
| `pageToken` | From previous `nextPageToken` |
| `includeSpamTrash` | Default false (spam/trash excluded) |

```json
{
  "messages": [
    { "id": "18f2c3a4b5d6e7f8", "threadId": "18f2c3a4b5d6e7f8" },
    { "id": "18f2c39911aa22bb", "threadId": "18f2bf0011223344" }
  ],
  "nextPageToken": "09876543210987654321",
  "resultSizeEstimate": 201
}
```

Only `id` and `threadId` are returned. `messages` is absent when empty. Order is newest first (implied by GM5: "the most recent message (the first message in the list response)").

### 2.2 messages.get format=metadata [Verified GM2, GM3, GM9]

```
GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}
  ?format=metadata
  &metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject
  &metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To
  &metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=List-Id
  &metadataHeaders=Precedence&metadataHeaders=Auto-Submitted&metadataHeaders=Authentication-Results
  &metadataHeaders=Return-Path&metadataHeaders=Content-Type&metadataHeaders=Delivered-To
  &fields=id,threadId,labelIds,snippet,historyId,internalDate,sizeEstimate,payload(mimeType,headers)
```

- `metadataHeaders` is a **repeated** query parameter (`"repeated": true` in GM9): repeat the key, do not comma-join.
- `format=metadata` "Returns only email message ID, labels, and email headers." [Verified GM9]
- `fields` (partial response) is a global parameter that trims the payload [Verified GM10, GM9 `parameters.fields`].

Abbreviated response (shape per GM3; values illustrative):

```json
{
  "id": "18f2c3a4b5d6e7f8",
  "threadId": "18f2c3a4b5d6e7f8",
  "labelIds": ["UNREAD", "CATEGORY_PROMOTIONS", "INBOX"],
  "snippet": "Our biggest sale of the year starts now ...",
  "historyId": "4421337",
  "internalDate": "1760500000000",
  "sizeEstimate": 48213,
  "payload": {
    "mimeType": "multipart/alternative",
    "headers": [
      { "name": "From", "value": "\"Shop\" <news@shop.example>" },
      { "name": "Subject", "value": "Big sale" },
      { "name": "List-Unsubscribe", "value": "<mailto:u@shop.example?subject=unsub>, <https://shop.example/u/abc>" },
      { "name": "List-Unsubscribe-Post", "value": "List-Unsubscribe=One-Click" },
      { "name": "Authentication-Results", "value": "mx.google.com; dkim=pass header.i=@shop.example header.s=s1 header.b=Ab12; spf=pass (google.com: domain of bounce@esp.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@esp.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example" },
      { "name": "Return-Path", "value": "<bounce-123@esp.example>" },
      { "name": "Content-Type", "value": "multipart/alternative; boundary=\"b1\"" }
    ]
  }
}
```

Field facts [Verified GM3]:

- `id`: "The immutable ID of the message" (unchanged by trash, archive, label changes).
- `internalDate`: epoch ms **as a string**; more reliable than the `Date` header.
- `historyId`: last history record that modified the message.
- `payload.headers`: array of `{name, value}`; duplicate header names appear as separate entries (e.g. several `Authentication-Results`).
- `snippet`: short plain-text excerpt (HTML entities may be escaped, e.g. `&#39;`; decode before display) [Unverified detail].

### 2.3 Attachment detection with metadata only

`format=metadata` does not include body parts, and `payload.parts` is documented only for container parts in full format. There is no `hasAttachments` flag in the Gmail API. Options, in order of preference:

1. **Top-level MIME type** (recommended, no extra cost): read `payload.mimeType`, falling back to the `Content-Type` header requested via `metadataHeaders`. `multipart/mixed` ≈ has attachments. `multipart/alternative` = no attachments. `multipart/related` = inline images only (treat as no attachment, matching Graph's `hasAttachments` semantics which excludes inline). `multipart/signed` / `multipart/encrypted` = unknown (treat as no). This is a heuristic: some senders wrap plain bodies in `multipart/mixed`. [Unverified that `payload.mimeType` is populated in metadata format; requesting the `Content-Type` header makes it robust either way]
2. **Search intersection** (exact, +1 call, +5 units): `messages.list?q=in:inbox has:attachment after:<epochSecOldest-1> before:<epochSecNewest+1>&maxResults=100` and intersect IDs with the page.
3. `format=full` per message: exact (parts with `filename`), but downloads body structure and violates the metadata-first rule. Not recommended.

### 2.4 Batch endpoint [Verified GM4, GM9; Observed]

- Endpoint: `POST https://gmail.googleapis.com/batch/gmail/v1` (GM4: default path `/batch/api_name/api_version`; GM9 `batchPath: "batch"` so `https://gmail.googleapis.com/batch` also works). [Observed: both, plus `https://www.googleapis.com/batch/gmail/v1`, answer 200 multipart.]
- **Max 100 calls per batch; Google recommends no more than 50** ("Larger batch sizes are likely to trigger rate limiting"). A batch of n counts as n requests for quota.
- Each part: `Content-Type: application/http`, optional `Content-ID`; body is a full HTTP request with **path only** (no host). Outer headers (e.g. `Authorization`) apply to every part unless overridden.
- Response: `multipart/mixed` with a **different boundary** (read it from the response `Content-Type`). Parts are in request order; `Content-ID` echoes as `response-<original>`. Calls may execute in any order. The outer status is 200 even when parts fail.

Request (25 gets; CRLF line endings):

```
POST /batch/gmail/v1 HTTP/1.1
Host: gmail.googleapis.com
Authorization: Bearer <access_token>
Content-Type: multipart/mixed; boundary=batch_clearbox

--batch_clearbox
Content-Type: application/http
Content-ID: <m0>

GET /gmail/v1/users/me/messages/18f2c3a4b5d6e7f8?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=id,threadId,labelIds,snippet,internalDate,payload(mimeType,headers)

--batch_clearbox
Content-Type: application/http
Content-ID: <m1>

GET /gmail/v1/users/me/messages/18f2c39911aa22bb?format=metadata&metadataHeaders=From&metadataHeaders=Subject

--batch_clearbox--
```

Response (real shape from the unauthenticated probe, [Observed]):

```
HTTP/2 200
content-type: multipart/mixed; boundary=batch_Cyn4WCixKy6OBn77vnITG81-8YLpxCSW

--batch_Cyn4WCixKy6OBn77vnITG81-8YLpxCSW
Content-Type: application/http
Content-ID: <response-m0>

HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8

{ "id": "18f2c3a4b5d6e7f8", "threadId": "...", "labelIds": ["INBOX"], ... }
--batch_Cyn4WCixKy6OBn77vnITG81-8YLpxCSW
Content-Type: application/http
Content-ID: <response-m1>

HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=UTF-8

{ "error": { "code": 401, "message": "Request is missing required authentication credential. ...", "errors": [ { "message": "Login Required.", "domain": "global", "reason": "required", "location": "Authorization", "locationType": "header" } ], "status": "UNAUTHENTICATED" } }
--batch_Cyn4WCixKy6OBn77vnITG81-8YLpxCSW--
```

Parser: split on `--<boundary>`; per part skip part headers to the first blank line; parse `HTTP/1.1 <status>` line; skip inner headers to the next blank line; the rest is the JSON body. Map by `Content-ID` (strip `<response-` and `>`), not by position. Retry only failed parts.

### 2.5 Incremental sync: history.list [Verified GM5, GM6]

```
GET https://gmail.googleapis.com/gmail/v1/users/me/history
  ?startHistoryId=4421337
  &historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved&historyTypes=messageDeleted
  &maxResults=500&pageToken=<token>
```

- `historyTypes` enum: `messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved` (repeated). `labelId` filters to messages with that label (optional).
- History IDs are increasing but not contiguous. Records are "typically available for at least one week ... in some rare circumstances ... only a few hours". **An invalid or too-old `startHistoryId` returns HTTP 404 → full sync.**
- No `nextPageToken` means caught up; store the response `historyId`.
- Messages inside records typically only have `id` and `threadId`.

```json
{
  "history": [
    {
      "id": "4421400",
      "messagesAdded": [ { "message": { "id": "18f2d...", "threadId": "18f2d...", "labelIds": ["UNREAD", "INBOX", "CATEGORY_UPDATES"] } } ]
    },
    {
      "id": "4421410",
      "labelsRemoved": [ { "message": { "id": "18f2c3a4b5d6e7f8", "threadId": "18f2c3a4b5d6e7f8" }, "labelIds": ["INBOX"] } ]
    }
  ],
  "historyId": "4421455"
}
```

Bootstrapping: before the backfill starts, call `users.getProfile` (1 unit) and save `historyId` as the steady-state cursor, so mail arriving during the backfill is picked up later by history.list. `messagesDeleted` means permanently deleted (not trashed).

### 2.6 Threads and "owner replied" [Verified GM7, GM8, GM11, quota page]

- `SENT` label is applied automatically to messages the user sends. Labels exist on messages; a thread's labels are the union of its messages' labels [Verified GM7].
- `threads.get?format=metadata` returns all messages with labels and headers but costs **40 units** per call [Verified quota]. Too expensive per inbox message.
- The API's `q` does not do thread-wide search ("The Gmail UI allows users to perform thread-wide searches, but the API doesn't") [Verified GM8].
- **Recommended:** build a set of thread IDs the owner has sent in: `messages.list?labelIds=SENT&maxResults=500` (5 units per 500 IDs, returns `threadId`). Then `owner_replied_in_thread = sentThreadIds.has(msg.threadId)`. Refresh incrementally via history (`messageAdded` with `SENT` in `labelIds`).
- Correspondent addresses need `To`/`Cc` of sent messages: batch `messages.get?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc` (20 units each). Example cost: 1,000 sent messages = 20,000 units, about 4 minutes at 6,000 units per user per minute. Limit to a window (e.g. last 365 days via `q=in:sent after:<epoch>`).
- Owner aliases: `GET /gmail/v1/users/me/settings/sendAs` is allowed with `gmail.modify` [Verified GM9 scopes], 1 unit. Use it so `is_correspondent` and "owner position" handle aliases.
- Thread length without threads.get: approximate depth from the `References` header (count of message IDs) or `In-Reply-To` presence.

---

## 3. Microsoft Graph reading

Sources:

- MG1 message resource: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
- MG2 list messages: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- MG3 get message: https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
- MG4 message delta: https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0
- MG5 delta for messages guide: https://learn.microsoft.com/en-us/graph/delta-query-messages
- MG6 delta overview: https://learn.microsoft.com/en-us/graph/delta-query-overview
- MG7 mailFolder (well-known names): https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0
- MG8 move: https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0
- MG9 immutable IDs: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- MG10 JSON batching: https://learn.microsoft.com/en-us/graph/json-batching
- MG11 list messages in folder: https://learn.microsoft.com/en-us/graph/api/mailfolder-list-messages?view=graph-rest-1.0

Base URL: `https://graph.microsoft.com/v1.0`.

### 3.1 Immutable IDs: send on every request [Verified MG1, MG9]

`message.id` "By default ... changes when the item is moved from one container (such as a folder or calendar) to another." Opt in with header **`Prefer: IdType="ImmutableId"`** on **every** request (it only applies to the request it is on). The immutable ID survives folder moves within the mailbox; it changes only if moved to an archive mailbox (Exchange Online Archive, not the `archive` folder) or exported and re-imported. It also works with delta (`nextLink`/`deltaLink` compatible with both formats). IDs are **case-sensitive**: do not lower-case them and use a case-sensitive (BINARY) collation in D1 (SQLite default is BINARY, fine).

### 3.2 List inbox [Verified MG2, MG11, MG1]

```
GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages
  ?$select=id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification,internetMessageId,webLink,internetMessageHeaders
  &$top=25
  &$orderby=receivedDateTime desc
Prefer: IdType="ImmutableId"
```

- Default page size 10; `$top` range **1 to 1000**. Large pages with many properties can cause 504. [Verified MG2]
- Paging: follow `@odata.nextLink` verbatim (it carries `$skip`); do not parse or modify it. [Verified MG2]
- If `$filter` and `$orderby` are combined, properties in `$orderby` must also appear first in `$filter`. [Verified MG2]
- **`internetMessageHeaders` on list is not documented.** MG1 lists the property; MG3 shows it only on single GET with `$select=internetMessageHeaders`. Community reports indicate it is returned on list when selected, but this is [Unverified], as is availability for personal outlook.com mailboxes. Design a fallback: if the list response lacks `internetMessageHeaders`, fetch them with one `$batch` of `GET /me/messages/{id}?$select=internetMessageHeaders` (25 messages = 2 batches = 2 subrequests).

Abbreviated response (fields per MG1; values illustrative):

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('...')/mailFolders('inbox')/messages(...)",
  "value": [
    {
      "@odata.etag": "W/\"CQAAABYAAAA...\"",
      "id": "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A...",
      "conversationId": "AAQkAGI2...",
      "receivedDateTime": "2026-10-14T21:03:11Z",
      "subject": "Big sale",
      "bodyPreview": "Our biggest sale of the year starts now ...",
      "isRead": false,
      "importance": "normal",
      "hasAttachments": false,
      "inferenceClassification": "other",
      "internetMessageId": "<abc123@esp.example>",
      "webLink": "https://outlook.office365.com/owa/?ItemID=AAkALg...&exvsurl=1&viewmodel=ReadMessageItem",
      "flag": { "flagStatus": "notFlagged" },
      "from": { "emailAddress": { "name": "Shop", "address": "news@shop.example" } },
      "toRecipients": [ { "emailAddress": { "name": "Owner", "address": "owner@outlook.com" } } ],
      "ccRecipients": [],
      "internetMessageHeaders": [
        { "name": "List-Unsubscribe", "value": "<https://shop.example/u/abc>" },
        { "name": "Authentication-Results", "value": "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=esp.example; dkim=pass (signature was verified) header.d=shop.example;dmarc=pass action=none header.from=shop.example;compauth=pass reason=100" }
      ]
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24select=...&%24top=25&%24skip=25"
}
```

Property facts [Verified MG1]:

- `bodyPreview`: first 255 characters, plain text.
- `hasAttachments`: excludes inline attachments (inline-only messages report false).
- `inferenceClassification`: `focused` or `other`.
- `importance`: `low`, `normal`, `high`. `flag.flagStatus`: `notFlagged`, `complete`, `flagged`.
- `from` vs `sender`: usually equal; differ for delegation.
- `subject` is a decoded string (Graph property, not a raw header).
- `webLink`: "The URL to open the message in Outlook on the web."
- `conversationIndex` (binary, base64): position in the conversation. Per [MS-OXOMSG] PidTagConversationIndex, it is a 22-byte header plus 5 bytes per reply level, so `(bytes - 22) / 5` approximates thread depth [Unverified for Graph specifically; spec reference https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxomsg/9e994fbb-b839-495f-84e3-2c8c02c7dd9b].

### 3.3 Delta query for the inbox [Verified MG4, MG5, MG6]

```
GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta
  ?$select=id,conversationId,from,subject,bodyPreview,receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification
  &changeType=created
Prefer: odata.maxpagesize=25, IdType="ImmutableId"
```

(Two Prefer preferences can be sent comma-separated in one header or as two `Prefer` headers per RFC 7240. [Unverified that Graph accepts both forms; test with a fixture])

- Supports `$select`, `$top`, `$expand`. `$filter` only `receivedDateTime ge|gt {value}` (returns at most 5,000 messages); `$orderby` only `receivedDateTime desc`; no `$search`. Query options are encoded into the tokens: specify them only on the first call, then follow `@odata.nextLink` / `@odata.deltaLink` verbatim.
- `changeType=created|updated|deleted` custom option (initial request only).
- The round ends with `@odata.deltaLink` (contains `$deltatoken`); store the whole URL. Intermediate pages give `@odata.nextLink` (`$skiptoken`).
- Removed items: `{ "id": "...", "@removed": { "reason": "deleted" } }`. This is emitted when an item is deleted **or moved out of the folder** (so archive/trash done in Outlook shows as `@removed`). Read/unread changes also appear, even with filters.
- **Token expiry:** for Outlook entities there is no fixed lifetime; tokens are evicted from an internal cache. Expired token → a 4xx error with code such as `syncStateNotFound`. Also possible: **`410 Gone`** with a `Location` header holding a fresh initial URL. Both mean: full resync.
- The initial round enumerates the **whole folder** (not "from now"). `$deltatoken=latest` is only for Entra resources, not messages. To start "from now" cheaply: initial request with `$filter=receivedDateTime ge <connect time>` gives a near-empty round and a deltaLink. [Design suggestion; verify that later rounds of a filtered delta still report new messages]

Delta response:

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(message)",
  "value": [
    { "@odata.type": "#microsoft.graph.message", "id": "AAkALg...", "subject": "Hello", "isRead": false, "receivedDateTime": "2026-10-15T08:00:00Z" },
    { "@odata.type": "#microsoft.graph.message", "id": "AAkALg...old", "@removed": { "reason": "deleted" } }
  ],
  "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=GwcBoTmPuoGNlgXgF1nyUNMXY"
}
```

### 3.4 Well-known folders [Verified MG7]

`inbox`, `sentitems`, `deleteditems`, `archive`, `junkemail`, `drafts`, `msgfolderroot`, `recoverableitemsdeletions`, `clutter`, `scheduled`, and others. Well-known names are locale-independent and usable as `destinationId`.

- `archive`: "The archive folder messages are sent to when using the One_Click Archive feature in Outlook clients that support it. **Note:** This isn't the same as the Archive Mailbox feature of Exchange online."
- Whether the `archive` folder exists in every mailbox (especially older or personal mailboxes) is **not documented** [Unverified]. Resolve at connect time: `GET /me/mailFolders/archive?$select=id,displayName`. On 404, fall back to creating a folder (`POST /me/mailFolders {"displayName":"Archive"}`) and store its ID, or disable "archive" for that account. Store the resolved folder ID, not the name.
- Mail folder IDs are already stable (immutable ID header not needed for folders) [Verified MG9].

### 3.5 Owner replied in conversation (Graph)

Same approach as Gmail: page `GET /me/mailFolders/sentitems/messages?$select=conversationId,toRecipients,ccRecipients,bccRecipients,sentDateTime&$top=100&$orderby=sentDateTime desc` and build a `conversationId` set plus a correspondent address set. `owner_replied_in_thread = sentConversationIds.has(msg.conversationId)`. Per-message `$filter=conversationId eq '...'` queries would cost one request per inbox message; avoid. [Approach is a design choice; properties Verified MG1]

### 3.6 JSON $batch [Verified MG10, throttling-limits]

```
POST https://graph.microsoft.com/v1.0/$batch
Content-Type: application/json

{
  "requests": [
    { "id": "1", "method": "POST", "url": "/me/messages/AAkALg.../move",
      "headers": { "Content-Type": "application/json", "Prefer": "IdType=\"ImmutableId\"" },
      "body": { "destinationId": "deleteditems" } },
    { "id": "2", "method": "GET", "url": "/me/messages/AAkALg...?$select=internetMessageHeaders",
      "headers": { "Prefer": "IdType=\"ImmutableId\"" } }
  ]
}
```

- **Max 20 requests.** `id` must be unique (else whole batch 400). `url` is relative (`/me/...`). `headers` required when `body` is present and must include `Content-Type`. Headers are per sub-request: put `Prefer: IdType="ImmutableId"` on each one.
- `dependsOn: ["1"]` sequences requests; a failed dependency yields `424`. "Batch should be either fully sequential or fully parallel."
- Response: `{ "responses": [ { "id", "status", "headers", "body" } ] }` in **any order**; correlate by `id`. Outer status 200 does not mean sub-requests succeeded.
- Each sub-request counts individually against throttling; throttled ones return `status: 429` inside the batch with their own `Retry-After` in `headers`; retry only those.
- Outlook concurrency: for an unordered batch, Graph forwards **at most 4 sub-requests at a time** to Outlook, which keeps one batch within the 4-concurrent-per-mailbox limit. Do not run other requests to the same mailbox in parallel with a batch.

```json
{
  "responses": [
    { "id": "2", "status": 200, "headers": { "Content-Type": "application/json" }, "body": { "id": "AAkALg...", "internetMessageHeaders": [] } },
    { "id": "1", "status": 201, "headers": { "Content-Type": "application/json" }, "body": { "id": "AAkALg...", "parentFolderId": "AQMkAD..." } },
    { "id": "3", "status": 429, "headers": { "Retry-After": "10" }, "body": { "error": { "code": "TooManyRequests", "message": "Please retry again later." } } }
  ]
}
```

---

## 4. Actions

### 4.1 Gmail [Verified GM3, GM9, quota page]

| Action | Request | Response | Quota units |
|---|---|---|---|
| Trash | `POST /gmail/v1/users/me/messages/{id}/trash` (empty body) | Message | 20 |
| Untrash | `POST /gmail/v1/users/me/messages/{id}/untrash` (empty body) | Message | 5 |
| Archive (bulk) | `POST /gmail/v1/users/me/messages/batchModify` `{"ids":[...],"removeLabelIds":["INBOX"]}` | empty body, 204/200 | 50 |
| Un-archive (bulk) | `batchModify` `{"ids":[...],"addLabelIds":["INBOX"]}` | empty | 50 |
| Modify one | `POST /gmail/v1/users/me/messages/{id}/modify` `{"addLabelIds":[],"removeLabelIds":[]}` | Message | 5 |

- `batchModify`: **max 1000 IDs per request** [Verified]. There is no `batchTrash`; trash a page of messages through the batch endpoint (25 to 50 trash calls = 1 Workers subrequest, 20 units each).
- `TRASH` is a manually applicable system label [Verified GM7], so `batchModify {"addLabelIds":["TRASH"],"removeLabelIds":["INBOX"]}` is an alternative bulk trash. Prefer `messages.trash` for documented semantics.
- Restore after trash: `untrash` removes the TRASH label. Whether `INBOX` comes back automatically is [Unverified]; restore defensively: `untrash`, then check returned `labelIds` and call `modify {"addLabelIds":["INBOX"]}` if missing.
- Gmail empties Trash after 30 days (Gmail Help, not API docs). Undo window (24 h) is well inside.
- Message IDs never change on trash/archive, so undo can reuse the stored ID.

Gmail quotas [Verified https://developers.google.com/workspace/gmail/api/reference/quota]: as of **May 1, 2026** (projects created after that date): **6,000 quota units per minute per user per project**, 1,200,000 per minute per project, and a **daily billing threshold of 80,000,000 units per project per day** (charges planned "later in 2026" above it). Method costs used by Clearbox:

| Method | Units |
|---|---|
| getProfile | 1 |
| history.list | 2 |
| messages.list | 5 |
| messages.get | 20 |
| messages.modify | 5 |
| messages.batchModify | 50 |
| messages.trash | 20 |
| messages.untrash | 5 |
| threads.get | 40 |
| threads.list | 10 |
| settings.sendAs.list | 1 |

A 25-message page costs 5 + 25 × 20 = 505 units, so at most ~11 pages per minute per user.

### 4.2 Microsoft Graph [Verified MG8, MG9]

```
POST https://graph.microsoft.com/v1.0/me/messages/{id}/move
Content-Type: application/json
Prefer: IdType="ImmutableId"

{ "destinationId": "deleteditems" }
```

- Returns **`201 Created`** with the moved message. Docs: "This creates a new copy of the message in the destination folder and removes the original message."
- **Without the immutable ID header the returned message has a NEW `id`; the old ID is dead.** With `Prefer: IdType="ImmutableId"` on the list, delta, and move requests, the ID stays the same. Still, always store `response.id` from the move (cheap insurance) and use it for undo.
- `destinationId`: folder ID or well-known name (`deleteditems`, `archive`, `inbox`).
- Trash = move to `deleteditems`. Archive = move to the resolved archive folder ID. Restore = move back to `inbox` using the stored (immutable) ID.
- Missing message: 404 (`ErrorItemNotFound` is the usual Exchange code) [code name Unverified]; mark the suggestion `failed`.
- Bulk: `$batch` of up to 20 moves = 1 Workers subrequest.

---

## 5. Throttling and errors

### 5.1 Gmail [Verified https://developers.google.com/workspace/gmail/api/guides/handle-errors]

| HTTP | `error.errors[0].reason` | Meaning | Action |
|---|---|---|---|
| 400 | `badRequest` | client bug | fail item |
| 401 | `authError` (`"Invalid Credentials"`) | access token expired or invalid | refresh token once, retry; if refresh gives `invalid_grant` → `needs_reauth` |
| 403 | `rateLimitExceeded` | project/user rate | backoff + retry |
| 403 | `userRateLimitExceeded` | per-user limit | backoff + retry |
| 403 | `dailyLimitExceeded` | project daily cap | stop until next day |
| 403 | `domainPolicy` | Workspace admin disabled Gmail apps | `needs_reauth` with admin message |
| 404 | `notFound` | message gone; or history ID too old (history.list) | fail item / full resync |
| 429 | "Too many concurrent requests for user" or "User-rate limit exceeded" | per-user concurrency or bandwidth | backoff + retry |
| 5xx | `backendError` | transient | backoff + retry |

Error body shape:

```json
{ "error": { "code": 403, "message": "User Rate Limit Exceeded", "errors": [ { "domain": "usageLimits", "reason": "userRateLimitExceeded", "message": "User Rate Limit Exceeded" } ] } }
```

Newer responses also carry `"status"` (e.g. `"UNAUTHENTICATED"`, `"RESOURCE_EXHAUSTED"`) [Observed `status` on 401].

- `Retry-After`: Gmail docs only say 429 comes "with a retry time"; the header is not documented. Honor `Retry-After` if present; otherwise truncated exponential backoff: `min(2^n s + random(0..1000 ms), 32 to 64 s)`, start at ≥1 s. [Verified quota page "Example algorithm"]
- Per-user concurrent request limit exists (number undocumented). Run one batch at a time per account.

### 5.2 Microsoft Graph [Verified https://learn.microsoft.com/en-us/graph/throttling and https://learn.microsoft.com/en-us/graph/throttling-limits]

- 429 with **`Retry-After`** (seconds) header; Outlook resources provide it. If absent, exponential backoff.

```
HTTP/1.1 429 Too Many Requests
Retry-After: 10
Content-Type: application/json

{ "error": { "code": "TooManyRequests", "innerError": { "code": "429", "date": "2020-08-18T12:51:51", "message": "Please retry after", "request-id": "94fb3b52-...", "status": "429" }, "message": "Please retry again later." } }
```

- Outlook limits **per app ID + mailbox**: **10,000 requests per 10 minutes**, **4 concurrent requests**, 150 MB upload per 5 minutes. Global: 130,000 requests per 10 seconds per app across all tenants.
- `$batch` sub-requests count individually; throttled sub-requests return 429 inside a 200 batch.
- 503 / 504 may include `Retry-After`; retry with backoff. 504 can be caused by too-large pages.
- Error body: `{ "error": { "code": "...", "message": "...", "innerError": { "date", "request-id", "client-request-id" } } }`.

---

## 6. Header parsing notes

Headers Clearbox reads: `From`, `To`, `Cc`, `Delivered-To`, `Subject`, `Date`, `Message-ID`, `References`, `In-Reply-To`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Precedence`, `Auto-Submitted`, `Authentication-Results`, `Return-Path`, `Content-Type`.

- **Header name matching:** case-insensitive (RFC 5322). Gmail returns names as they appear in the message (e.g. `Message-Id` vs `Message-ID`). Whether `metadataHeaders` matching is case-insensitive is [Unverified]; request canonical spellings and match case-insensitively when reading.
- **Duplicates:** both providers return repeated headers as separate array entries. Use the first (topmost) occurrence for `Authentication-Results` stamped by the receiving provider.
- **List-Unsubscribe** (RFC 2369): comma-separated `<uri>` list, e.g. `<mailto:u@x.example?subject=unsub>, <https://x.example/u/abc>`. `has_list_unsubscribe = true` if present and non-empty.
- **List-Unsubscribe-Post** (RFC 8058): exactly `List-Unsubscribe=One-Click` means one-click POST is supported (only valid with an `https` URI in `List-Unsubscribe`).
- **Precedence**: non-standard; values `bulk`, `list`, `junk` → `precedence_bulk = true` (case-insensitive, trim).
- **Auto-Submitted** (RFC 3834): `no` (or absent) = human; `auto-generated`, `auto-replied`, `auto-notified` → `auto_submitted = true`. Value may carry parameters after `;`.
- **Return-Path**: `<bounce-123@esp.example>`; may be `<>` for bounces. ESP domain = registrable domain of the address. Note Graph personal mailboxes may not expose `Return-Path` [Unverified].
- **Authentication-Results** (RFC 8601): `authserv-id; method=result (comment) prop=value; ...`.
  - Gmail: starts with `mx.google.com;` then `dkim=pass header.i=@d header.s=sel header.b=...; spf=pass (...) smtp.mailfrom=...; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=d`. Trust only an A-R whose authserv-id is `mx.google.com`, ignore others (added by upstream hops, spoofable). Gmail may also include `ARC-Authentication-Results`; ignore.
  - Microsoft 365 / Outlook.com: **no authserv-id prefix**; format `spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=contoso.com; dkim=pass (signature was verified) header.d=contoso.com;dmarc=pass action=none header.from=contoso.com;compauth=pass reason=100`. Values: `spf=pass|fail|softfail|neutral|none|temperror|permerror`, `dkim=pass|fail|none`, `dmarc=pass|fail|bestguesspass|none`, plus `compauth`. [Verified https://learn.microsoft.com/en-us/defender-office-365/message-headers-eop-mdo]
  - Parser: split on `;` outside parentheses and quotes, drop `(comments)`, then for each `method=result` token take `spf`, `dkim`, `dmarc` (and `compauth` for Microsoft). Multiple `dkim=` results: pass if any is `pass` and aligned with `header.from` domain. Map `bestguesspass` to pass-ish (no DMARC record).
- **RFC 2047 encoded words** (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`): Gmail docs do not say whether `payload.headers` values are decoded; community reports conflict [Unverified]. Graph `subject`, `from.emailAddress.name` are decoded properties; `internetMessageHeaders` values may be raw [Unverified]. Implement a small decoder (B and Q encodings, `TextDecoder` for charsets) that is a no-op when no `=?` token is present, and apply it to `Subject` and display names from both providers. Also unfold folded headers (CRLF + whitespace).
- **From parsing**: forms `Name <addr@d>`, `"Last, First" <addr@d>`, bare `addr@d`, `addr@d (Name)`. Strip quotes, handle escaped quotes, lower-case the address, domain = part after the last `@`. For Graph prefer `from.emailAddress.{name,address}`; for Gmail parse the header. Treat unparseable values as unknown sender (no "known correspondent" bonus).

---

## 7. Deep links

- **Gmail:** there is **no official deep-link format** in Google docs [Unverified]. Commonly working forms:
  - `https://mail.google.com/mail/u/?authuser=<email>#all/<messageId>` (hex API message ID; `#inbox/<id>` also works while in inbox)
  - Robust fallback (documented search operator `rfc822msgid:`): `https://mail.google.com/mail/u/?authuser=<email>#search/rfc822msgid%3A<url-encoded Message-ID>`. Requires the `Message-ID` header (add to `metadataHeaders`).
  - Use `authuser=<email>` so multi-account browsers open the right mailbox.
- **Graph:** `webLink` property [Verified MG1], e.g. `https://outlook.office365.com/owa/?ItemID=<id>&exvsurl=1&viewmodel=ReadMessageItem` (personal accounts use an outlook.live.com host [Unverified]). Select and store it; it embeds the item ID, so request it with the immutable ID header and refresh it after a move if needed.

---

## 8. Minimal TypeScript response shapes

```ts
// ---------- Google OAuth ----------
export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;          // seconds
  token_type: "Bearer";
  scope: string;               // space-delimited granted scopes
  refresh_token?: string;      // only on code exchange with access_type=offline (+ prompt=consent)
  refresh_token_expires_in?: number; // only for time-based access grants
}
export interface GoogleOAuthError {
  error: "invalid_grant" | "invalid_client" | "invalid_request" | "unauthorized_client" | "deleted_client" | "invalid_token" | string;
  error_description?: string;
  error_subtype?: string;      // e.g. "invalid_rapt"
}

// ---------- Gmail ----------
export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}
export interface GmailMessageRef { id: string; threadId: string }
export interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
export interface GmailHeader { name: string; value: string }
export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;       // epoch ms as string
  sizeEstimate?: number;
  payload?: { mimeType?: string; headers?: GmailHeader[] };
}
export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessageRef & { labelIds?: string[] } }[];
  messagesDeleted?: { message: GmailMessageRef }[];
  labelsAdded?: { message: GmailMessageRef; labelIds: string[] }[];
  labelsRemoved?: { message: GmailMessageRef; labelIds: string[] }[];
}
export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId: string;
}
export interface GmailSendAsList {
  sendAs?: { sendAsEmail: string; isPrimary?: boolean }[];
}
export interface GmailBatchModifyRequest {
  ids: string[];               // max 1000
  addLabelIds?: string[];
  removeLabelIds?: string[];
}
export interface GoogleApiError {
  error: {
    code: number;
    message: string;
    status?: string;
    errors?: { domain?: string; reason?: string; message?: string; location?: string; locationType?: string }[];
  };
}
/** One parsed part of a Gmail multipart/mixed batch response. */
export interface GmailBatchPart<T> {
  contentId: string;           // without "response-" prefix and angle brackets
  status: number;
  headers: Record<string, string>;
  body: T | GoogleApiError | null;
}

// ---------- Microsoft OAuth ----------
export interface MsTokenResponse {
  token_type: "Bearer";
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;      // returned on every refresh: persist it
}
export interface MsOAuthError {
  error: "invalid_grant" | "interaction_required" | "invalid_client" | "unauthorized_client" | "consent_required" | "invalid_scope" | "temporarily_unavailable" | "invalid_request" | string;
  error_description: string;   // starts with "AADSTSnnnn:"
  error_codes?: number[];
  timestamp?: string;
  trace_id?: string;
  correlation_id?: string;
  suberror?: string;
}

// ---------- Microsoft Graph ----------
export interface GraphMe {
  id: string;
  mail: string | null;
  userPrincipalName: string;
  displayName?: string | null;
}
export interface GraphEmailAddress { name?: string; address?: string }
export interface GraphRecipient { emailAddress: GraphEmailAddress }
export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;   // ISO 8601 UTC
  subject?: string | null;
  bodyPreview?: string;
  isRead?: boolean;
  importance?: "low" | "normal" | "high";
  hasAttachments?: boolean;
  inferenceClassification?: "focused" | "other";
  flag?: { flagStatus: "notFlagged" | "complete" | "flagged" };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  parentFolderId?: string;
  webLink?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: { reason: "deleted" | "changed" | string }; // delta only
}
export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}
export interface GraphMailFolder { id: string; displayName: string }
export interface GraphBatchRequest {
  requests: {
    id: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;               // relative, e.g. "/me/messages/{id}/move"
    headers?: Record<string, string>;
    body?: unknown;
    dependsOn?: string[];
  }[];                         // max 20
}
export interface GraphBatchResponse {
  responses: {
    id: string;
    status: number;
    headers?: Record<string, string>;
    body?: unknown;            // GraphMessage | GraphError | ...
  }[];
}
export interface GraphError {
  error: {
    code: string;              // e.g. "TooManyRequests", "ErrorItemNotFound", "syncStateNotFound"
    message: string;
    innerError?: { date?: string; "request-id"?: string; "client-request-id"?: string };
  };
}
```

---

## 9. Workers subrequest budget per 25-message page

| Step | Gmail | Graph |
|---|---|---|
| Token refresh (once per step or per run) | 1 | 1 |
| List page | 1 (`messages.list`) | 1 (list with `$select`) |
| Metadata | 1 (batch of 25 `messages.get`) | 0 if headers come with list, else 2 (`$batch` 20 + 5) |
| Trash/archive 25 (execute) | 1 (batch of 25 trash) or 1 `batchModify` | 2 (`$batch` 20 + 5) |
| Incremental poll | 1 per `history.list` page | 1 per delta page |

Worst case per scan step: Gmail 3, Graph 4. Well inside the 30-subrequest step budget, leaving room for Decision-1 calls.

---

## 10. Implications for Clearbox / spec corrections

1. **Graph move changes IDs by default.** Send `Prefer: IdType="ImmutableId"` on every Graph request (list, delta, `$batch` sub-requests, move). Store the ID returned by move anyway and use it for undo. Treat IDs as case-sensitive. (Spec section 5 table and section 10 "Execute fails ... moved" should mention this.)
2. **Microsoft rotates refresh tokens.** Persist the new `refresh_token` after every refresh (re-encrypt, 1 D1 write). Google does not return a new one; no write needed. Spec `ScanWorkflow` step 1 should say "refresh and, for Microsoft, persist the rotated refresh token".
3. **No Microsoft revoke endpoint** for these scopes. Disconnect = delete locally + instruct user to remove consent at account.live.com/consent/Manage (personal) or myapps.microsoft.com (work). Google disconnect should call `POST https://oauth2.googleapis.com/revoke`.
4. **Error classification:** `invalid_client` (Google "OAuth client was not found", AADSTS7000215, AADSTS7000222 expired secret) is an **owner config error**, not `needs_reauth`. Add an app-level status/banner. Add a runbook item for Entra client secret expiry (max 24 months).
5. **Gmail re-auth triggers** to document: password change revokes tokens with Gmail scopes; 6 months unused; Testing mode 7 days; 100 tokens per client per account. `gmail.modify` is a Restricted scope (unverified app warning, 100-user cap).
6. **Granular consent:** the Google user can untick `gmail.modify`; verify `scope` in the token response before saving the account.
7. **`response_mode=query`** for Microsoft (not `form_post`) so the `SameSite=Lax` state cookie works. Keep `prompt=consent` for Google (refresh token only on first consent otherwise).
8. **Microsoft redirect URI:** HTTPS, no query string (personal accounts), app registered for "any org + personal" to use `/common`.
9. **Archive folder caveat:** resolve `GET /me/mailFolders/archive` at connect time; store the folder ID; handle 404 (create "Archive" folder or disable archive). Note `archive` is not the Exchange Online Archive mailbox.
10. **Attachment detection on Gmail:** add `Content-Type` to `metadataHeaders` and use top-level `multipart/mixed` as the `has_attachments` heuristic; document that it is approximate. Graph `hasAttachments` excludes inline-only attachments, matching this heuristic's treatment of `multipart/related`.
11. **`internetMessageHeaders` on Graph list is undocumented.** Keep it in `$select`, but implement the `$batch` per-message fallback and record a fixture from a real personal and work mailbox during implementation. Also add `internetMessageId` and `webLink` to `$select`.
12. **Gmail `metadataHeaders` list:** add `Content-Type`, `Message-ID`, `References`, `In-Reply-To`, `List-Unsubscribe-Post`, `List-Id`, `Delivered-To` to the spec's list. Use `labelIds=INBOX` instead of `q=in:inbox`. Use the `fields` parameter to trim payloads (CPU budget).
13. **Gmail batch size:** spec says "up to 50 per request"; correct (max 100, recommended ≤50). Use the endpoint `https://gmail.googleapis.com/batch/gmail/v1`. Graph `$batch` 20 is correct; never run other same-mailbox requests concurrently with a batch (4-concurrent limit).
14. **Gmail quotas changed (May 2026):** 6,000 units per user per minute; 80M units per project per day billing threshold. A 25-message page is 505 units (~11 pages per minute per user). Spec "Rate limits" gotcha should cite these numbers. Graph: 10,000 requests per 10 minutes and **4 concurrent** per mailbox per app.
15. **Gmail incremental cursor:** take `historyId` from `users.getProfile` **before** backfill starts. On history 404, full resync. Graph: delta token expiry is cache-based (no fixed TTL); handle `syncStateNotFound` and `410 Gone` by resync. Graph delta's first round enumerates the whole folder; to start "from now", use a `receivedDateTime ge` filtered delta at connect time (verify).
16. **Owner replied / correspondents:** build `sentThreadIds` (Gmail `labelIds=SENT`, 5 units per 500) and `sentConversationIds` (Graph sent items), not per-message thread lookups (`threads.get` = 40 units). Use Gmail `settings.sendAs` (allowed with `gmail.modify`) for aliases. Thread length can be approximated from `References` (both) or `conversationIndex` (Graph).
17. **Restore semantics:** Gmail untrash may not re-add `INBOX`; restore = untrash + add `INBOX` if missing. Graph restore = move to `inbox` with the stored immutable ID.
18. **Header decoding:** implement RFC 2047 decoding and header unfolding defensively for both providers; trust only the receiving provider's `Authentication-Results` (Gmail `mx.google.com` authserv-id; Microsoft format has no authserv-id and adds `compauth`).
19. **Deep links:** Graph `webLink` is official; Gmail has no official deep link. Use `#all/<id>` with `authuser`, with an `rfc822msgid:` search fallback.
20. **Hard delete impossible by scope:** with `gmail.modify`, `messages.delete`/`batchDelete` are not callable (require `https://mail.google.com/`). Worth stating in the security section as a second layer behind "no hard-delete method".

### Unresolved (need a recorded fixture from a real mailbox during implementation)

- Graph: is `internetMessageHeaders` returned on list and on delta when in `$select`? For personal outlook.com mailboxes?
- Graph: does `/me/mailFolders/archive` exist for all personal and work mailboxes? Exact 404 error code.
- Graph: `/me` `mail` value for personal accounts; `webLink` host for personal accounts; combined `Prefer` header form.
- Graph: does a `receivedDateTime ge` filtered delta continue to report new messages in later rounds?
- Gmail: is `payload.mimeType` present in `format=metadata` responses? Are header values RFC 2047 decoded? Is `metadataHeaders` matching case-insensitive?
- Gmail: does `untrash` restore the `INBOX` label? Is `Retry-After` sent on 429?
- Gmail deep link format stability (undocumented).
