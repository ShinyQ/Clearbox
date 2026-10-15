# Clearbox: Design Spec

- **Status:** Approved, rev 2
- **Date:** 2026-10-15
- **Owner:** ShinyQ
- **Companion:** [`2026-10-15-clearbox-contracts.md`](2026-10-15-clearbox-contracts.md) holds every exact name, type, table, route, constant and dependency version. This spec is the narrative; when they disagree, the contracts document wins.

## 1. Summary

Clearbox scans Gmail and Outlook mailboxes, suggests which emails to **delete**, **archive**, or **keep** (or marks them **unsure**), and executes only the suggestions the owner approves. Suggestions come from a layered pipeline: deterministic signals, policy guardrails, learned per-sender priors, and **Microsoft-Decision-1** (Microsoft Foundry, Sweden Central, `DataZoneStandard`), called through a deployment the owner names (for example `decision-1`). It runs on **Cloudflare Workers Free**, driven by a once-a-minute cron "tick", and can also run locally.

The repository is public and generic (anyone can self-host with their own accounts). Each deployment is **private to a single owner**.

## 2. Goals and non-goals

### Goals

1. Suggest delete / archive / keep / unsure per email with a confidence value and human-readable reasons.
2. Never delete without explicit owner approval. Deletion means "move to Trash / Deleted Items" (recoverable).
3. Improve over time from the owner's approve, override and undo decisions.
4. Support multiple Gmail and Outlook accounts in one deployment.
5. Run within Cloudflare Workers **Free** plan limits (hard constraint). Workers Paid is an optional upgrade with no code changes.
6. Self-hostable by others with clean, pluggable abstractions.

### Non-goals (v1)

- Permanent deletion.
- Fully automatic actions without approval.
- Multi-tenant SaaS (one deployment serves one owner).
- Generative explanations or summaries (a plugin seam is reserved; see section 14).
- Unsubscribe automation.
- IMAP or other providers.

## 3. Verified model facts

Verified on 2026-10-15 from Microsoft Learn, Azure Resource Manager (`az cognitiveservices model list -l swedencentral`, usage and pricing APIs) and third-party live captures (details and evidence levels in `docs/superpowers/research/decision-1.md`; not yet live-verified by us).

| Field | Value |
|---|---|
| Model | `Microsoft-Decision-1` (marketed as MAI-Decision-1), format `Microsoft`, version `1`, Preview; version 1 inference retirement **2027-02-04** |
| Sweden Central SKU | `DataZoneStandard` (EU data zone, area `EUR`) |
| Endpoint | `POST https://<foundry-account>.services.ai.azure.com/providers/microsoft/v1/systemone` (account root, not a project URL, no `api-version`) |
| Auth | `api-key` header (Clearbox) or Entra ID bearer token |
| Request | `{ model: <deployment-name>, state, questions }` and nothing else (unknown top-level fields are rejected with 400). `model` is the **deployment name**; a deployment may not be named `Microsoft-Decision-1` (reserved word) |
| Question types | `choice` (2 to 255 options), `score` (2 to 10 ascending levels), `noul` (yes/no probability) |
| Response | `answers.<name>` per type: `choice` gives `choice`, `confidence`, `probabilities` keyed by option; `score` gives `score` (probability-weighted mean of 0-based level indexes), `confidence`, `legend` and `probabilities` keyed `"0".."4"`; `noul` gives a single number `noul`. Plus `model: "microsoft-decision-1"` and `usage.input_tokens` / `usage.output_tokens`. No rationale text, no id (request id is the `apim-request-id` header) |
| Capacity | 1 capacity unit = **1 request per minute**. Clearbox uses **300 RPM** |
| Tokens | Questions and criteria are billed as input (about 200 to 300 tokens for Clearbox's five questions). Compact JSON state is about 3.5 characters per token |
| Price | $0.042 per 1M input tokens; output is free; same in EU and US data zones |
| Determinism | No sampling parameters exist; option order can shift scores slightly, so Clearbox shuffles option order per request |

Source: [Deploy and use Microsoft-Decision-1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision).

## 4. Architecture

```
Browser (React SPA: Clean up dashboard and review queue)
   |  Cloudflare Access (owner email only), JWT re-verified in the Worker
   v
Worker "clearbox" (one Vite project: Hono API + SPA static assets) ---- D1 "clearbox" (EU jurisdiction)
   |                                                                    ^
   | Cron "* * * * *": one tick per minute = one account, one page      |
   | POST /api/accounts/:id/scan: the same tick, on demand              |
   | Cron "0 2 * * *": calibration + TTL purge                          |
   v                                                                    |
 runTick -------------------------------------------------------------- +
   |- MailProvider --> Microsoft Graph | Gmail API
   |- SignalExtractor   (pure)
   |- Guardrails        (pure, policy in D1)
   |- PriorStore        (D1)
   |- DecisionEngine --> Foundry systemone endpoint (Sweden Central)
   '- FusionPolicy      (pure)
```

### Why a cron tick instead of Workflows

Cloudflare Workflows on Free allows only 50 external subrequests per **instance** (not per step) and 3,000 steps per day, which makes a multi-page scan workflow unsafe. Instead, a cron fires every minute and runs one **tick**: it leases one account, processes one page of at most 25 messages, writes everything in one D1 batch, advances the cursor and releases the lease. Retries are simply later ticks (per-account attempt count and backoff). A tick stays within 45 subrequests, counting D1 calls. "Scan now" in the UI runs the same tick synchronously.

### Stack

TypeScript 6.0, pnpm workspaces, Hono, React + React Router + TanStack Query + Tailwind v4, zod 4, jose, Vitest 5 with `@cloudflare/vitest-plugin` and MSW 3, and the Cloudflare CLI (`cf`, beta) with the Cloudflare Vite plugin 2.0 beta. Cloudflare products: Workers, Workers Static Assets, D1, Cron Triggers, Workers secrets and Access. No Workflows, no Smart Placement (it would only affect the `fetch` handler, while the heavy traffic runs in `scheduled`).

### Repository layout

```
packages/core/   # @clearbox/core: pure TS (no Cloudflare, Hono or DOM imports)
                 # model, providers (Gmail, Graph, OAuth), signals, policy, guardrails,
                 # priors, decision (Mai + Fake engines), fusion, calibration
app/             # @clearbox/app: ONE Vite project with cloudflare.config.ts
  src/worker/    # Hono routes, tick, nightly job, D1 repositories, OAuth, crypto
  src/web/       # React SPA (built into the Worker's static assets)
  src/shared/    # REST contract shared by worker and web
  migrations/    # D1 SQL migrations
eval/            # eval harness + synthetic labeled fixtures
infra/azure/     # Bicep and az script for the Decision-1 deployment
scripts/         # setup:cf, gen-key, text checks
docs/            # setup guides, runbook, this spec, contracts, research
```

The Worker and SPA share one Vite project because `cf` has no assets directory setting: static assets are the Vite client build of the same project that builds the Worker.

### Module interfaces

| Module | Responsibility | Interface (summary) |
|---|---|---|
| `MailProvider` | Bootstrap, backfill, sent scan, incremental sync, trash, archive, restore | `bootstrap()`, `listInboxPage(cursor, n)`, `listSentPage(cursor, n)`, `syncChanges(cursor, n)`, `resyncCursor(watermark)`, `trash(ids)`, `archive(ids)`, `restore(items)` |
| `SignalExtractor` | Build `Signals` from a normalized `MailMessage` plus `SenderHistory` | `extractSignals(msg, history, ctx)` |
| `Guardrails` | Compute the highest action allowed | `evaluateGuardrails({signals, subject, snippet}, policy)` returns `{ ceiling, reasons, allowlisted, denylisted }` |
| `DecisionEngine` | Score the four actions plus auxiliary questions | `decide({key, state, seed})` returns `DecisionResult` or throws `DecisionError` |
| `FusionPolicy` | Combine the model, prior, flags, and ceiling into a suggestion | `fuse({model, prior, guard, signals, thresholds})` |
| `PriorStore` | Read and update per-sender and per-domain Beta priors | D1 repository; `selectPrior(...)`, `priorDelta(action, direction)` in core |

`MailProvider` intentionally exposes **no hard-delete method**, and Gmail's `gmail.modify` scope cannot hard-delete anyway.

## 5. Mail connectivity

Both providers use official REST APIs with OAuth 2.0 authorization code + PKCE (S256). Each self-hoster registers their own OAuth clients. There is no shared client.

### Connect flow

```
Settings -> "Connect Gmail" / "Connect Outlook"
 -> GET /oauth/{google|microsoft}/start     (PKCE verifier + nonce in an HMAC-signed, 10-minute, SameSite=Lax cookie)
 -> provider consent screen
 -> GET /oauth/{provider}/callback          (verify cookie and state, exchange code, check granted scopes,
                                             require a refresh token, bootstrap the mailbox)
 -> encrypt tokens -> D1 -> first tick within a minute
```

Bootstrap at connect time records everything the scan needs: the mailbox address and aliases, the **incremental cursor taken before any backfill** (Gmail `getProfile.historyId`; Graph filtered delta links for Inbox and Sent Items), and for Outlook the **resolved archive folder id** (`GET /me/mailFolders/archive`, else create an "Archive" folder, else archive is unavailable for that account).

### Provider mapping

| | Outlook (Microsoft Graph) | Gmail (Gmail API) |
|---|---|---|
| Owner setup | Entra app for "any organizational directory and personal Microsoft accounts" (tenant `common`), Web platform, redirect URI, client secret (expires, at most 24 months) | Google Cloud project, Gmail API, consent screen "In production", Web client |
| Scopes | `offline_access User.Read Mail.ReadWrite`; granted scopes checked | `https://www.googleapis.com/auth/gmail.modify` (Restricted, cannot hard-delete); `access_type=offline`, `prompt=consent`; granted scopes checked (granular consent) |
| Authorize | `response_mode=query` (keeps the Lax state cookie working), `prompt=select_account` | standard |
| Every request | `Prefer: IdType="ImmutableId"` (ids survive moves; case-sensitive) | none |
| Backfill | `GET /me/mailFolders/inbox/messages` newest first, keyset on `receivedDateTime`, `$top=25`, `$select` including `internetMessageHeaders`, `webLink`, `conversationIndex` (fallback `$batch` for headers when the list omits them) | `messages.list?labelIds=INBOX&maxResults=25`, then one `/batch/gmail/v1` of `messages.get?format=metadata` with `From, To, Cc, Delivered-To, Subject, Date, Message-ID, References, In-Reply-To, List-Unsubscribe, List-Unsubscribe-Post, List-Id, Precedence, Auto-Submitted, Authentication-Results, Return-Path, Content-Type` |
| Snippet | `bodyPreview` (255 characters) | `snippet` (entities decoded) |
| Attachments | `hasAttachments` (excludes inline) | heuristic: top-level `multipart/mixed` (approximate) |
| Category hints | `inferenceClassification`, `flag`, `importance` | `labelIds` (`CATEGORY_*`, `STARRED`, `IMPORTANT`) |
| Incremental sync | Inbox and Sent Items delta links; `@removed` items dismiss open suggestions; `syncStateNotFound` / 410 means resync from the watermark | `history.list` from the last processed record; label removals and trash dismiss open suggestions; 404 means resync (new historyId plus a catch-up list `after:<watermark>`) |
| Owner replied / correspondents | Sent Items `conversationId` set and recipient set | `labelIds=SENT` `threadId` set and `To`/`Cc` recipients; `sendAs` aliases |
| Batching | `$batch`, 20 per request; Outlook processes at most 4 at a time; no other concurrent requests to the mailbox | `/batch/gmail/v1`, at most 50 per request |
| Trash | `POST /me/messages/{id}/move {destinationId:"deleteditems"}`; store the returned id | `messages.trash` |
| Archive | move to the stored archive folder id | `batchModify` remove `INBOX` |
| Restore | move to `inbox` | `untrash`, then add `INBOX` if it is missing |
| Refresh tokens | **rotate on every refresh; the new one is re-encrypted and persisted** | not rotated |
| Disconnect | no revoke endpoint for these scopes: delete locally and show the consent-removal links (account.live.com/consent/Manage, myapps.microsoft.com) | `POST oauth2.googleapis.com/revoke`, then delete locally |

Header handling: header names match case-insensitively, folded headers are unfolded, RFC 2047 encoded words are decoded in subjects and display names, and only the receiving provider's `Authentication-Results` is trusted (Gmail authserv-id `mx.google.com`; Microsoft's first entry).

### Known gotchas (documented in setup guides)

- **Gmail refresh tokens expire after 7 days in OAuth "Testing" mode**, after 6 months unused, on every password change, and beyond 100 tokens per client per account. Personal accounts should set the consent screen to "In production" (unverified; shows a warning; capped at 100 users). Google Workspace accounts can use "Internal".
- **Work or school Microsoft accounts** may block user consent to `Mail.ReadWrite` or block unknown apps through Conditional Access. Admin consent is then required. Personal outlook.com accounts work by default.
- **Owner configuration errors** (`invalid_client`, Entra AADSTS7000215 / AADSTS7000222 expired secret) put the account in `config_error`, not `needs_reauth`, and show an app-level banner.
- **Rate limits:** Gmail allows 6,000 quota units per user per minute (a 25-message page costs about 505 units); Graph allows 10,000 requests per 10 minutes and **4 concurrent requests** per mailbox per app. Clearbox honors `Retry-After` and never sends concurrent requests to one mailbox.

## 6. Decision pipeline

### 6.1 Signals

Signals are metadata-first. No full body is fetched; only the provider snippet is used.

| Group | Signals |
|---|---|
| Sender | address, domain, display name, `is_correspondent` (owner has sent to them), `owner_replied` (owner sent in the thread or conversation), messages seen and open rate (from a per-sender counter table), owner delete rate and decision count (from priors) |
| Headers | `has_list_unsubscribe`, one-click unsubscribe, `List-Id`, `precedence_bulk`, `auto_submitted`, ESP domain (from `Return-Path`), SPF / DKIM / DMARC pass, fail or none |
| Provider | Gmail `CATEGORY_*`, `STARRED`, `IMPORTANT`; Outlook focused / other, flagged, importance |
| Message | age in days, `is_read`, `has_attachments` (approximate on Gmail), thread depth (References count or `conversationIndex` length), owner position (to / cc / bcc or list), subject, snippet |

### 6.2 Guardrails

Guardrails return an **action ceiling**, ordered `keep < archive < delete`; `unsure` is always allowed. The policy (allow and deny lists, `min_age_days`, record patterns, snippet and label-subject storage) has TypeScript defaults validated with zod and owner edits stored in D1, versioned.

| Rule (in order) | Ceiling | Lifted by the denylist? |
|---|---|---|
| Starred (Gmail) or flagged (Outlook) by the owner | keep | no |
| Owner replied in the thread | keep | no |
| Sender or domain on the allowlist (allowlist beats denylist) | keep | no |
| Message younger than `min_age_days` (default 3) | keep | no |
| Sender is a known correspondent | keep | yes |
| Has attachments | archive | yes |
| Subject or snippet matches a record pattern (receipt, invoice, tax, statement, contract, medical, legal) | archive | yes |

Provider importance (Gmail `IMPORTANT`, Outlook `importance=high`) is a model signal only, not a guardrail: Gmail sets it automatically and senders set Outlook's. Guardrails rely on headers and history wherever possible, so a hostile email body cannot lift its own ceiling (a record pattern can only lower it).

### 6.3 Decision-1 request

One request per email, body exactly `{ model, state, questions }`:

```json
{
  "model": "<deployment-name>",
  "state": {
    "email": { "from": "...", "domain": "...", "subject": "...", "snippet": "...", "age_days": 41,
               "signals": { "has_list_unsubscribe": true, "precedence_bulk": true, "auto_submitted": false,
                            "category": "promotions", "is_read": false, "has_attachments": false,
                            "owner_position": "to", "thread_depth": 1, "provider_important": false,
                            "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" } } },
    "sender_history": { "messages_seen": 37, "open_rate": 0.0, "owner_delete_rate": 1.0,
                        "owner_decisions": 14, "is_correspondent": false },
    "similar_past_decisions": [ { "domain": "...", "subject": "...", "owner_action": "delete" } ]
  },
  "questions": {
    "action": { "type": "choice",
      "instructions": "What should the mailbox owner do with this email?",
      "criteria": {
        "delete": "No future value: promotions, expired notifications, ignored newsletters, superseded automated alerts",
        "archive": "Worth keeping as a record but needs no attention: receipts, confirmations, completed threads",
        "keep": "Needs attention or is personally important to the owner",
        "unsure": "Cannot tell from the information given" } },
    "importance": { "type": "score", "instructions": "How important is this email to the owner?",
      "criteria": ["Noise", "Low", "Moderate", "High", "Critical"] },
    "is_record": { "type": "noul", "instructions": "Is this a record the owner may need later (receipt, invoice, contract, statement, ticket, account notice)?" },
    "is_expired": { "type": "noul", "instructions": "Is the content time-bound, and has that time passed (one-time code, ended sale, past event)?" },
    "is_from_human": { "type": "noul", "instructions": "Was this written personally by a human to the owner, not generated by an automated system?" }
  }
}
```

- The `action` option order is **shuffled per request** with a seed derived from the account and message id (a retry reproduces the order); keys stay stable and `score` levels stay ascending.
- `similar_past_decisions` holds up to 5 most recent labels from the same sender, then the same domain. No embeddings in v1.
- **Token budget:** the whole request targets 800 input tokens or fewer. The questions cost about 200 to 300, so the compact JSON `state` is capped at 1,750 characters (about 500 tokens at 3.5 characters per token). Past decisions, then the snippet, then the subject are trimmed until it fits. `usage.input_tokens` is recorded as the truth.
- The response is validated with zod against the exact per-type shapes (section 3). `confidence` is ignored; Clearbox uses `probabilities` (renormalized), `score` (importance 0 to 4) and the `noul` values.
- Concurrency is at most **4 Decision-1 calls at once** per tick, independent of the mailbox (which never sees concurrent requests). At 25 calls per tick and one tick per minute plus occasional "Scan now", usage stays far below the 300 RPM capacity.

### 6.4 Fusion (deterministic)

Let `m = {delete, archive, keep, unsure}` be the model probabilities.

1. **Prior.** Per-sender Beta prior: `α = 1 + #owner_delete`, `β = 1 + #owner_not_delete`, and `n = α + β - 2`. Use the domain prior when the sender has `n < 3` and a domain prior exists. Then `p_s = α / (α + β)`. With no prior, `n = 0`.
2. **Blend.** With `λ = n / (n + 5)`, compute `d = (1 - λ)·m.delete + λ·p_s`.
3. **Rebuild the distribution.** `v.delete = d`. For each other action `x`: if `m.delete < 1`, `v.x = m.x · (1 - d) / (1 - m.delete)`; otherwise `v.unsure = 1 - d` and every other `v.x = 0`. `v` sums to 1.
4. **Flag shifts**, in order, each moving mass between two entries:
   - If `is_record ≥ 0.7`, move 50% of `v.delete` to `v.archive`.
   - If `is_from_human ≥ 0.7`, move 50% of `v.delete` to `v.keep`.
   - If `is_expired ≥ 0.7` and `is_from_human < 0.5`, move 30% of `v.archive` to `v.delete`.
5. **Ceiling.** The probability mass of every action above the guardrail ceiling is folded into the ceiling action. If the unconstrained choice exceeded the ceiling, the guardrail reasons are shown.
6. **Thresholds.** Suggest `delete` only if `d ≥ τ_delete` (default 0.80) **and** `d` exceeds the next action by at least 0.20. Otherwise use the best non-delete action (ties favor keep, then archive, then unsure). If that is below 0.55, suggest `unsure`. Confidence is the final probability of the suggested action.
7. **Reasons.** Up to 3 human-readable reasons in priority order: model unavailable, guardrails, deny list, low confidence, the prior ("deleted 14/14 from this sender"), then signals that support the action ("opened 0% of 37 emails", "has an unsubscribe link", "looks expired").

When the model fails permanently for a message, the suggestion is `unsure` with the reason "model unavailable". Exact pseudo-code and edge cases are in contracts section 5.

### 6.5 Learning loop

- Every approve, override, or Clean up writes a `labels` row, updates the sender and domain priors, and joins the few-shot pool. Undo corrects the label to keep and reverses the prior update.
- A **nightly calibration** job reads the newest 500 labels. When at least 50 of them would have been delete suggestions at `τ = 0.80`, it evaluates `τ` from 0.80 to 0.99 (step 0.01) and picks the smallest `τ` with at least 20 supporting labels and precision **≥ 0.98**; if none qualifies, `τ_delete = 0.99`. `τ_delete` never drops below 0.80.
- `model_version` (`<deployment>/<response model>`) and `policy_version` are stored on each suggestion and label so behavior changes can be compared.

## 7. Security

### Threat model

The highest-value asset is a mailbox refresh token. Other assets are email metadata, the Azure API key, and the decision history. The adversaries considered are:

- an unauthenticated internet user hitting the Worker URL
- hostile email content (prompt injection, XSS)
- leaked logs
- a supply-chain compromise
- a public-repo leak

### Controls

| Area | Control |
|---|---|
| App access | A Worker-level Cloudflare Access application ("All traffic") protects **every** hostname of the Worker, including `workers.dev`, with a policy that allows only the owner's email. The Worker **always** verifies `Cf-Access-Jwt-Assertion` itself with `jose` (`createRemoteJWKSet` + `jwtVerify`): RS256 signature against the team JWKS, `iss` = `ACCESS_TEAM_DOMAIN`, `aud` contains `ACCESS_AUD`, `exp`/`nbf`, and `email` equals `OWNER_EMAIL`. This is mandatory because the built-in `ctx.access` identity is not available to Workers with Static Assets. It **fails closed** when Access configuration is missing. |
| Local dev | `cf dev` serves on `http://localhost:5173`. The auth bypass is honored only when `ENVIRONMENT=development`, `DEV_AUTH_BYPASS=true` (both derived from the build mode, never from secrets) **and** the request hostname is `localhost` or `127.0.0.1`; the bypass flag in any other environment is a fatal misconfiguration. |
| OAuth scopes | Gmail `gmail.modify` only, which cannot permanently delete, so the provider itself enforces trash-only. Graph uses delegated `Mail.ReadWrite`, `offline_access`, `User.Read`. No send or contacts scopes. Granted scopes are checked on every connect. |
| OAuth flow | Authorization code + PKCE (S256). The verifier and a nonce travel in an HMAC-signed `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 10-minute TTL); `state` equals the nonce. Microsoft uses `response_mode=query` so the Lax cookie is sent. Redirect URIs are derived from the request origin and must match the registrations exactly. |
| Token storage | Refresh tokens (and the short-lived access token cached between ticks) are encrypted with AES-256-GCM (WebCrypto), a random 96-bit IV per value, and AAD binding the account id, token kind and key version. A `key_version` column supports rotation. The key lives in the `TOKEN_ENC_KEY` secret. Rotated Microsoft refresh tokens are persisted after every refresh. |
| Disconnect | Gmail: revoke at Google. Outlook: no revoke endpoint exists, so the UI links to the consent pages. Tokens are wiped immediately; messages, suggestions, labels and priors are purged by the nightly job; the audit log is kept. |
| Web | Strict CSP for the SPA via `public/_headers` (`default-src 'self'`, no inline script or style, `frame-ancestors 'none'`); Worker responses get `default-src 'none'` and `Cache-Control: no-store`. Mutating API routes require the `X-Clearbox-CSRF: 1` header plus the Access JWT; no CORS is ever enabled. Email content is **rendered as plain text only**; HTML bodies are never rendered. |
| Prompt injection | Email text is untrusted `state`. Decision-1 returns only bounded probabilities, so there are no tools and no generated text. The blast radius is limited by guardrails based on headers and history, by mandatory human approval, and by trash-only actions. |
| Destructive actions | Approval targets exact suggestion IDs, a sender group bounded by the `asOf` time the UI displayed, or the Clean up threshold the UI displayed. The server verifies each suggestion is `pending` and belongs to its account, caps every request at 100 items, and executes idempotently. Undo is available for 24 hours (the provider keeps trash for about 30 days). The audit log is append-only. |
| Data minimization and residency | Clearbox stores metadata plus the snippet; snippet storage and label subjects can be turned off in the policy. Message rows are purged 30 days after a decision (90 days if never reviewed). `labels` keep only the sender, the domain, and a subject truncated to 60 characters. D1 is created with **EU jurisdiction**, and Decision-1 runs on **DataZoneStandard (EU)**. Logs contain opaque IDs and counts only, never addresses, subjects, snippets, provider message ids or query strings (`redactQueryString` is on, because OAuth callbacks carry codes). |
| Isolation | Every repository function on account-owned tables requires an account id, and a test scans the SQL to enforce it. |
| Public repo hygiene | No secrets or environment-specific values (account ids, subdomains, team names, Azure resource names) in the repo. `.dev.vars` and `app/clearbox.local.json` are gitignored, and fixtures are synthetic only. Secrets: `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_KEY`, `AZURE_DECISION_DEPLOYMENT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. |
| Supply chain | Exact dependency versions, lockfile committed, minimal dependencies, Dependabot, CodeQL, and GitHub secret scanning with push protection. |
| Review gate | A `security-review` pass over token handling, OAuth, Access verification, and action endpoints is required before first deploy. |

## 8. Data model (D1)

Full DDL, indexes and CHECK constraints are in contracts section 6. Summary:

| Table | Purpose | Notes |
|---|---|---|
| `accounts` | One row per connected mailbox | status `active` / `needs_reauth` / `config_error` / `disconnected`, `paused`, encrypted tokens, scopes, aliases, `archive_folder_id`, phase (`sent_backfill`, `inbox_backfill`, `incremental`), cursors, watermark, page size, attempts, `backoff_until`, `next_tick_at`, `last_tick_at` |
| `leases` | Per-account tick lease and the nightly lease | expiry 5 minutes; a lease that was never released means the previous tick was killed, so the page size halves |
| `messages` | Message metadata, snippet, signals | unique on (account, provider id) |
| `suggestions` | One per message | status `awaiting_model`, `pending`, `approved`, `executed`, `failed`, `dismissed`, `undone`; fused probabilities, ceiling, reasons, versions, `expires_at`; partial index on open suggestions |
| `labels` | Owner decisions, kept after messages are purged | eval, calibration and few-shot pool |
| `sender_priors`, `senders`, `correspondents`, `sent_threads` | Learned priors, sender counters, sent-mail sets | WITHOUT ROWID, keyed by account |
| `action_batches` | Executed batches for undo | 24-hour undo window, kept 7 days |
| `audit_log` | Append-only activity | counts and codes only |
| `budget` | Daily rows written, ticks, Decision-1 calls and tokens, database size | enforces the Free write budget |
| `settings` | `tau_delete`, policy and its version, calibration report, app issues | |

## 9. Scan tick and Cloudflare Free budget

### Free plan limits (verified 2026-10-15)

- **Workers:** 10 ms CPU per invocation (requests and Cron Triggers), 50 external subrequests plus 1,000 to Cloudflare services per invocation (the D1 page still says 50 queries, so Clearbox counts D1 calls against its own 45 budget), 100k requests per day, **5 Cron Triggers per account**, 64 vars and secrets.
- **D1:** 5M rows read and 100k rows written per day (each index entry counts as a written row, deletes count too), **500 MB per database**, 10 databases and 5 GB per account, 100 bound parameters per statement. A `batch()` is one call and one transaction.

### Tick

1. **Claim** (one D1 batch): lease the active, unpaused account that is due (`next_tick_at` and `backoff_until` passed, not leased) with the oldest `last_tick_at`, but only while today's rows written are below 65,000. Nothing is written when no account is due.
2. **Choose the kind:** re-decide deferred suggestions first; otherwise sent-mail scan (first 1,000 sent messages), inbox backfill (newest to oldest), or incremental sync (whenever 30 minutes have passed, interleaved with backfill).
3. **Fetch one page** from the provider (token refreshed only when it expires within 5 minutes).
4. **Context** (one D1 batch): known ids, priors, sender counters, correspondents, replied threads, recent labels.
5. **Decide:** signals, guardrails and state for new messages; up to 25 Decision-1 calls, at most 4 concurrent. A configuration error (401/403/404) or a majority of transient failures aborts the tick without writing; isolated transient failures store the suggestion as `awaiting_model` and retry after 5 and 30 minutes, then fall back to `unsure`.
6. **Write** (one D1 batch, transactional): messages, suggestions, sender counters, sent sets, dismissals, account cursors and schedule, rotated tokens, lease release.
7. **Budget** (one D1 call): add the exact `meta.rows_written` of this tick.

Worst case per tick: 38 subrequests including D1 calls (39 for "Scan now" with a cold JWKS fetch), under the 45 cap. Failures set `attempts` and `backoff_until` (1 minute doubling to 6 hours, or the provider's `Retry-After`), and the next tick retries.

**Crons:** `* * * * *` runs one tick. `0 2 * * *` runs stale-execution recovery, calibration, and the bounded purge (expired suggestions and messages, disconnected accounts, old batches).

**Budget:** an email costs about 4.8 rows written to ingest, 5.3 when the owner decides it, and 3 when it is purged (about 13 over its life). Ticks stop at 65,000 rows per day, the purge at 80,000, and owner actions at 90,000 (90% of the 100k limit), which reserves at least 25,000 rows for the weekly review session. Ingestion is capped at 36,000 emails/day by ticks (1,440 x 25) but in practice by D1: about **13,000 emails/day** during the initial backfill and about **6,800 emails/day** sustained once purges and decisions are counted. Backfill pauses at 450 MB of the 500 MB database limit.

**Cost estimate:** 450 to 800 input tokens per email at $0.042 per million is about **$0.25 to $0.34 per 10k emails**.

**Upgrade path:** on Workers Paid, set `FREE_TIER=false`. That raises the page size to 100 and removes the D1 write gates. No code changes are needed.

## 10. Error handling

| Failure | Behavior |
|---|---|
| Provider 429 / 503 / Gmail `rateLimitExceeded` | End the tick; `backoff_until` from `Retry-After` or exponential backoff; the next tick retries |
| Provider 401 | Refresh the access token once and repeat the request; a second 401 is an auth error |
| `invalid_grant`, `interaction_required` (revoked or expired grant) | Account `needs_reauth`; skip its ticks; UI banner "Reconnect" |
| `invalid_client`, AADSTS7000215 / 7000222 (owner config) | Account `config_error`; app issue banner for the owner |
| Incremental cursor expired (Gmail history 404, Graph `syncStateNotFound` / 410) | Resync from the watermark (Graph filtered delta; Gmail new historyId plus a catch-up list) |
| Decision-1 401/403/404 | Configuration issue: abort the tick, raise an app issue, back off |
| Decision-1 400/413/422 or invalid response | Do not retry; store `unsure` with "model unavailable" |
| Decision-1 408/429/5xx, timeout (10 s), network | Store `awaiting_model`; retry after 5 and 30 minutes, then `unsure`; a majority failing aborts the tick |
| Daily D1 write budget reached | Ticks are not claimed until the next UTC day; owner actions continue up to 90,000 rows |
| Execute fails for a message (missing or moved) | Mark that suggestion `failed` and continue; return per-item results; throttled items return to `pending` as "retry later" |
| Tick killed (CPU, memory) | The unreleased lease halves the account's page size on the next claim (minimum 5); successful ticks grow it back |
| Any unexpected error | Fail safe: no action is taken, and suggestions stay `pending` or `awaiting_model` |

Invariant: **no code path executes a trash or archive without a pending suggestion the owner approved in that request.**

## 11. Review UI

The UI (a desktop-first "Clean up" dashboard for a weekly 5 to 10 minute session) is designed separately. Its server contract is the REST API in contracts section 7:

- **Session and accounts:** `GET /api/me`, accounts list, connect (OAuth start), pause, disconnect, and "Scan now".
- **Queue:** summary counts per action, sender groups (paged, filter by account and action, sort by confidence), and group detail with items (subject, sender, date, snippet, signals, reasons, deep link to Gmail or Outlook, all plain text).
- **Actions:** approve exact ids or a whole sender group, override an action (reject = keep), and **Clean up**: approve every pending suggestion at or above a confidence threshold (default current `τ_delete`), 100 per call, with a `remaining` count so the UI can loop.
- **Undo** for the last 24 hours, by batch.
- **Activity** feed from the audit log.
- **Insights:** delete precision, label counts, `τ_delete` and calibration curve, today's budget usage, database size, and per-account sync status.
- **Policy:** allow and deny lists ("Always keep sender", "Always allow delete"), `min_age_days`, record patterns, snippet and label-subject storage.

## 12. Setup and operations

- **Guides:** `docs/setup-cloudflare.md`, `docs/setup-azure.md`, `docs/setup-google.md`, `docs/setup-microsoft.md`, and `docs/runbook.md` (key rotation, re-auth, config errors and client secret expiry, purge, restore, budget exhaustion, Decision-1 version retirement on 2027-02-04).
- **`pnpm setup:cf`:** creates the D1 database with `cf d1 create --name clearbox --jurisdiction eu`, records its id in the gitignored `app/clearbox.local.json`, applies migrations, sets secrets through a temporary gitignored `--secrets-file`, deploys with **`cf deploy --no-provision`** (auto-provisioning could create a non-EU database), and prints the Access steps (Worker-level application, "All traffic", owner email policy, copy the AUD tag into `ACCESS_AUD`).
- **Azure:** `infra/azure/` contains Bicep and an az script that create (or reuse) an AIServices account in `swedencentral` and a `Microsoft-Decision-1` deployment named `decision-1` with SKU `DataZoneStandard`, capacity **300** (requests per minute), and `NoAutoUpgrade`.
- **Local:** `cf dev` (Vite on `http://localhost:5173`) with local D1 (`pnpm db:migrate:local`, which passes `--persist-to .cloudflare/state`), `app/.dev.vars`, and the development-only auth bypass. Trigger crons locally with `/cdn-cgi/local/scheduled?cron=...`.
- **Cron quota:** Clearbox uses 2 of the 5 Cron Triggers per account on Free; check other Workers on the account first.

## 13. Testing and evaluation

| Layer | Tooling | Coverage |
|---|---|---|
| Core | Vitest 5 (Node) | Signal extraction, header parsing and RFC 2047, the guardrail matrix, fusion math and edge cases, priors, thresholds, calibration, state token budget and option shuffle, response validation |
| Providers | Vitest + MSW 3 (`msw/node`) with synthetic fixtures and an in-memory fake mailbox | Gmail and Graph parsing, paging, history and delta (including expiry), batch multipart and `$batch`, immutable ids, 401 refresh, 429 handling, trash / archive / restore |
| Worker | `@cloudflare/vitest-plugin` (reads `cloudflare.config.ts`), `@msw/cloudflare` | Routes; Access JWT verification (fail closed, wrong email, aud, iss, expiry, dev bypass rules); CSRF; OAuth state and PKCE; encryption round trip; claim SQL; tick paths with `FakeEngine`; approval invariants; undo; nightly job; SQL isolation |
| SPA | Vitest with happy-dom and Testing Library | Plain-text rendering, API client CSRF header, Clean up loop |
| Free-tier budget | Node benchmark and a subrequest counter | A 25-message page uses 6 ms CPU or less in pure processing; every tick path stays within 45 subrequests |
| Model eval | `pnpm eval` against the live deployment | Delete precision and recall, a calibration (reliability) curve, and an option-order shuffle robustness check, on synthetic fixtures plus exported owner labels |
| Security | `security-review` agent, CodeQL | Before first deploy and on changes to auth, crypto, or actions |

**Observability:** Workers Logs (structured JSON events, IDs and counts only), per-tick metrics (messages, decisions, deferrals, subrequests, rows written, model latency p50 / p95, tokens), the `budget` table, and audit log views in the dashboard.

## 14. Future extensions (not in v1)

- An `Explainer` plugin interface that sends `unsure` items to a generative model for a summary.
- An unsubscribe assistant using `List-Unsubscribe` and one-click unsubscribe.
- Multi-tenant mode.
- Embeddings-based similar-decision retrieval.
- Entra ID auth to Foundry, replacing the API key.
- Re-scoring pending suggestions after policy or `τ_delete` changes.

## 15. Risks and open items

| Risk | Mitigation |
|---|---|
| Decision-1 is in Preview; version 1 retires 2027-02-04; the API may change | Isolate it behind `DecisionEngine`; `NoAutoUpgrade`; tolerant zod schemas; `FakeEngine` keeps the app usable; runbook item for the migration |
| Decision-1 rate-limit headers and 429 body are unverified | Treat `retry-after-ms` / `retry-after` as optional; transient errors defer to later ticks |
| `cf` CLI and Vite plugin 2.0 are beta | Exact pinned versions; documented Wrangler fallback in research; `experimental.newConfig` fallback for tests |
| 10 ms CPU on Free | Benchmark test, adaptive page size, and the Paid escape hatch |
| Unverified Graph behaviors (headers on list and delta, archive folder existence, filtered delta continuity, personal-account `mail`) | Fallbacks are built in (header `$batch`, archive folder creation, watermark resync); record synthetic-ized fixtures during implementation |
| Unverified Gmail behaviors (`payload.mimeType` in metadata, header decoding, untrash restoring `INBOX`) | Request `Content-Type`, decode defensively, re-add `INBOX` after untrash |
| Gmail restricted scope and unverified-app warning | Documented "In production (unverified)" setup for personal use |
| Corporate Microsoft tenants blocking consent | Documented admin-consent path |
| D1 write budget limits backfill speed | Budget gates, purge bounds, Paid upgrade path |

## 16. Revision history

### Contracts rev 2.2 (2026-10-15)

The six implementation plans were reconciled into one executable sequence (index: `docs/superpowers/plans/2026-10-15-clearbox-00-index.md`) and the contracts document was updated to match (contracts section 12.5): plan-owned files added to the layout, one core `TokenUpdate`, `MailProvider.inboxEstimate` written at connect and refreshed by the tick, plan 03 owning the worker token source and provider factory, a `request.error` log event, MSW 3 `onUnhandledFrame`, the ESLint `no-console` fix, the extended `check-text` gate, `.impeccable/` and `eval/private/` git-ignored, and the SPA test dependencies (`axe-core`, `@testing-library/user-event`, happy-dom). This narrative spec is otherwise unchanged.

### Rev 2 (2026-10-15)

Applied the verified research (`docs/superpowers/research/cloudflare.md`, `mail-providers.md`, `decision-1.md`) and the lead's architecture decisions. The new contracts document is the detailed source of truth.

| Area | Change | Why |
|---|---|---|
| Scan engine | Replaced ScanWorkflow (Cloudflare Workflows) with a cron tick every minute: one account, one page, D1 lease, retries on later ticks; "Scan now" runs the same tick | Free Workflows allow 50 subrequests per instance and 3,000 steps per day |
| Crons | `*/30 * * * *` became `* * * * *`; nightly unchanged | Tick design |
| Layout | `apps/worker` + `apps/web` became one Vite project `app/` (`src/worker`, `src/web`, `src/shared`); `packages/core` unchanged; config is `cloudflare.config.ts` | `cf` has no assets directory; assets come from the Vite build |
| Platform | No Workflows, no Smart Placement; deploy with `--no-provision`; D1 explicitly EU; local migrations with `--persist-to` | Research C1, C2, C6, C13, C14 |
| Budgets | D1 500 MB per database; index rows and deletes count as writes; rows per email recomputed (about 13 over a lifecycle); gates at 65k / 80k / 90k rows; throughput about 13k/day initially and 6.8k/day sustained (was 15k/day); 45-subrequest tick budget counting D1 | Research C3, C4, C5 |
| Decision-1 | Account-root endpoint, deployment name not reserved word, capacity in RPM (300), exact per-type response shapes, importance 0 to 4, option shuffle, whole-request 800-token budget with 1,750-character state, no retries on 400/404/413/422, concurrency 4, retirement date | decision-1.md |
| Fusion | Ceiling now folds disallowed mass into the ceiling action; explicit tie-break; reasons priority defined | Deterministic, testable rules |
| Calibration | Added 20-label minimum support per threshold and the 0.99 fallback | Avoids choosing a threshold from a handful of labels |
| Mail | Graph immutable ids on every request; Microsoft refresh-token rotation persisted; `config_error` status for owner credential errors; `response_mode=query`; granted-scope checks; archive folder resolved at connect; Gmail `labelIds=INBOX`, extra headers, attachment heuristic; sent-mail sets for replied and correspondents; historyId before backfill; untrash re-adds INBOX; RFC 2047 decoding; no Microsoft revoke | mail-providers.md |
| Guardrails | Provider importance is a signal, not a guardrail; denylist precedence defined; policy stored in D1 with TypeScript defaults (no YAML) | Gmail IMPORTANT is automatic; fewer dependencies |
| Security | Access JWT verification in code is mandatory (`ctx.access` unavailable with Static Assets), `jose`; dev bypass limited to localhost and development mode; access token cached encrypted in D1; `redactQueryString`; disconnect purges asynchronously | Research C11 and design review |
| Data | Statuses `awaiting_model`, `dismissed`; `config_error`, `disconnected`; `email` stored (needed for Gmail deep links and the UI) instead of `email_hash`; new tables `leases`, `senders`, `correspondents`, `sent_threads`, `action_batches`; pending suggestions kept up to 90 days | Tick design and UI needs |
| UI | Section 11 now describes the REST surface, including the Clean up endpoint; visual design is specified separately | UI designed in parallel |
| Testing | `@cloudflare/vitest-plugin` with `experimental.newConfig`, MSW 3 with `@msw/cloudflare`, happy-dom for the SPA | Research C9 |
| Privacy | Environment-specific details removed from the research docs | Public repository |

### Rev 1 (2026-10-15)

Initial approved design.
