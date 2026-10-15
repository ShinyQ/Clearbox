# Clearbox: Design Spec

- **Status:** Draft for review
- **Date:** 2026-10-15
- **Owner:** ShinyQ

## 1. Summary

Clearbox scans Gmail and Outlook mailboxes, suggests which emails to **delete**, **archive**, or **keep**, and executes only the suggestions the owner approves. Suggestions come from a layered pipeline: deterministic signals, policy guardrails, learned per-sender priors, and **Microsoft-Decision-1** (Microsoft Foundry, Sweden Central, `DataZoneStandard`). It runs on **Cloudflare Workers Free** and can also run locally.

The repository is public and generic (anyone can self-host with their own accounts). Each deployment is **private to a single owner**.

## 2. Goals and non-goals

### Goals

1. Suggest delete / archive / keep / unsure per email with a confidence value and human-readable reasons.
2. Never delete without explicit owner approval. Deletion means "move to Trash / Deleted Items" (recoverable).
3. Improve over time from the owner's approve/reject decisions.
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

Verified on 2026-10-15 with `az cognitiveservices model list -l swedencentral`:

| Field | Value |
|---|---|
| Model | `Microsoft-Decision-1` (marketed as MAI-Decision-1), format `Microsoft`, version `1` |
| Lifecycle | Preview |
| Sweden Central SKU | `DataZoneStandard` (EU data zone) |
| Endpoint | `POST {foundry-endpoint}/providers/microsoft/v1/systemone` |
| Auth | `api-key` header or Entra ID bearer token (scope `https://cognitiveservices.azure.com/.default`) |
| Request | `{ model: <deployment-name>, state: <text or JSON>, questions: { <name>: { type: choice / score / noul, instructions, criteria } } }` |
| Response | `answers.<name>` with the selected option and a probability per option. No rationale text. |
| Price | $0.042 per 1M input tokens; output is free |

Source: [Deploy and use Microsoft-Decision-1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision).

## 4. Architecture

```
Browser (React SPA: review queue)
   │  Cloudflare Access (owner email only)
   ▼
Worker (Hono API + Static Assets) ─── D1 (EU jurisdiction)
   │ creates                                ▲
   ▼                                        │
ScanWorkflow (Cloudflare Workflows) ────────┘
   ├─ MailProvider ──► Microsoft Graph | Gmail API
   ├─ SignalExtractor      (pure)
   ├─ Guardrails           (pure, policy file)
   ├─ PriorStore           (D1)
   ├─ DecisionEngine ──► Foundry systemone endpoint (Sweden Central)
   └─ FusionPolicy         (pure)
Cron Triggers ──► start ScanWorkflow per account; nightly calibrate + purge
```

### Stack

TypeScript, pnpm workspaces, Hono, React + Vite + Tailwind, zod, Vitest, and the Cloudflare CLI (`cf`) for resources and deployment. Cloudflare products: Workers, Workers Static Assets, D1, Workflows, Cron Triggers, Workers secrets, Access, and Smart Placement.

### Repository layout

```
packages/core/        # pure TS, no Cloudflare imports
  providers/          # MailProvider interface + GraphProvider + GmailProvider
  signals/            # MailMessage + history -> Signals
  guardrails/         # Signals + Policy -> Ceiling + reasons
  decision/           # DecisionEngine interface + MaiDecisionEngine + FakeEngine
  fusion/             # model probs + prior + ceiling -> Suggestion
  policy/             # policy schema (zod) + defaults
apps/worker/          # Hono routes, ScanWorkflow, cron, D1 repos, OAuth, crypto
apps/web/             # React SPA (built into Worker static assets)
migrations/           # D1 SQL migrations
docs/                 # setup guides, runbook, this spec
eval/                 # eval harness + synthetic labeled fixtures
```

### Module interfaces

| Module | Responsibility | Interface (summary) |
|---|---|---|
| `MailProvider` | List, fetch metadata, sync incrementally, trash, archive, restore | `listPage(cursor)`, `syncSince(cursor)`, `getMetadata(ids)`, `listSentRecipients(cursor)`, `trash(ids)`, `archive(ids)`, `restore(ids)` |
| `SignalExtractor` | Build `Signals` from a normalized `MailMessage` plus `SenderHistory` | `extract(msg, history): Signals` |
| `Guardrails` | Compute the highest action allowed | `evaluate(signals, policy): { ceiling, reasons[] }` |
| `DecisionEngine` | Score the four actions plus auxiliary questions | `decide(state): DecisionResult` |
| `FusionPolicy` | Combine the model, prior, flags, and ceiling into a suggestion | `fuse(result, prior, guard, thresholds): Suggestion` |
| `PriorStore` | Read and update per-sender and per-domain Beta priors | `get(accountId, sender)`, `update(label)` |

`MailProvider` intentionally exposes **no hard-delete method**.

## 5. Mail connectivity

Both providers use official REST APIs with OAuth 2.0 authorization code + PKCE. Each self-hoster registers their own OAuth clients. There is no shared client.

### Connect flow

```
Settings -> "Connect Gmail" / "Connect Outlook"
 -> GET /oauth/{google|microsoft}/start     (PKCE verifier + signed, 10-min state cookie)
 -> provider consent screen
 -> GET /oauth/{provider}/callback          (verify state, exchange code)
 -> encrypt refresh token -> D1 -> start initial ScanWorkflow
```

### Provider mapping

| | Outlook (Microsoft Graph) | Gmail (Gmail API) |
|---|---|---|
| Owner setup | Entra ID app registration (web platform, redirect URI, client secret) | Google Cloud project, Gmail API enabled, OAuth consent screen, web client |
| Scopes | `Mail.ReadWrite offline_access User.Read` | `https://www.googleapis.com/auth/gmail.modify`, `access_type=offline`, `prompt=consent` |
| List inbox | `GET /me/mailFolders/inbox/messages?$select=id,from,subject,bodyPreview,receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification,conversationId,toRecipients,ccRecipients,internetMessageHeaders&$top=25` | `users.messages.list?q=in:inbox&maxResults=25`, then `messages.get?format=metadata&metadataHeaders=From,To,Cc,Subject,Date,List-Unsubscribe,Precedence,Auto-Submitted,Authentication-Results,Return-Path` |
| Snippet | `bodyPreview` (up to 255 characters) | `snippet` |
| Category hints | `inferenceClassification` (focused / other), `flag`, `importance` | `labelIds` (`CATEGORY_*`, `STARRED`, `IMPORTANT`) |
| Incremental sync | `/me/mailFolders/inbox/messages/delta` (store `deltaLink`) | `users.history.list?startHistoryId=` (store `historyId`) |
| Correspondents | Sent Items recipients (metadata only) | `q=in:sent`, `To`/`Cc` headers |
| Batching | `$batch`, 20 per request | `/batch/gmail/v1`, up to 50 per request |
| Trash | `POST /me/messages/{id}/move {destinationId:"deleteditems"}` | `messages.trash` |
| Archive | move to `archive` | `batchModify` remove `INBOX` |
| Restore | move to `inbox` | `messages.untrash` |

The known-correspondents set comes from Sent mail, so no contacts scope is needed.

### Known gotchas (document in setup guides)

- **Gmail refresh tokens expire after 7 days in OAuth "Testing" mode.** Personal accounts should set the consent screen to "In production" (unverified; shows a warning; capped at 100 users). Google Workspace accounts can use "Internal".
- **Work or school Microsoft accounts** may block user consent to `Mail.ReadWrite` or block unknown apps through Conditional Access. Admin consent is then required. Personal outlook.com accounts work by default.
- **Rate limits:** Graph allows about 10k requests per 10 minutes per mailbox; Gmail uses per-user quota units. Honor `Retry-After`.

## 6. Decision pipeline

### 6.1 Signals

Signals are metadata-first. No full body is fetched; only the provider snippet is used.

| Group | Signals |
|---|---|
| Sender | address, domain, display name, `is_correspondent` (owner has sent to them), `owner_replied_in_thread`, 90-day volume, open rate (share read), owner delete rate (from labels) |
| Headers | `has_list_unsubscribe`, `precedence_bulk`, `auto_submitted`, ESP domain (from `Return-Path`), SPF / DKIM / DMARC pass or fail |
| Provider | Gmail `CATEGORY_*`, `STARRED`, `IMPORTANT`; Outlook focused / other, flagged, importance |
| Message | age in days, `is_read`, `has_attachments`, thread length, owner position (to / cc / bcc), subject, snippet |

### 6.2 Guardrails

Guardrails return an **action ceiling**, ordered `keep < archive < delete`. Defaults live in `clearbox.policy.yaml` and are validated with zod.

| Rule | Ceiling |
|---|---|
| Starred, flagged, or marked important by the owner | keep |
| Owner replied in the thread, or sender is a known correspondent | keep |
| Sender or domain on the allowlist | keep |
| Message younger than `min_age_days` (default 3) | keep |
| Has attachments | archive |
| Subject or snippet matches a record pattern (receipt, invoice, tax, statement, contract, medical, legal) | archive |
| Sender or domain on the denylist | no cap (delete allowed) |

Guardrails rely on headers and history wherever possible, so a hostile email body cannot lift its own ceiling.

### 6.3 Decision-1 request

One request per email:

```json
{
  "model": "<deployment-name>",
  "state": {
    "email": { "from": "...", "domain": "...", "subject": "...", "snippet": "...", "age_days": 41,
               "signals": { "has_list_unsubscribe": true, "precedence_bulk": true, "category": "promotions",
                            "is_read": false, "has_attachments": false, "owner_position": "to" } },
    "sender_history": { "messages_90d": 37, "open_rate": 0.0, "owner_delete_rate": 1.0, "is_correspondent": false },
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

`similar_past_decisions` holds up to 5 most recent labels from the same sender, falling back to the same domain. No embeddings in v1.

The target state size is 800 input tokens or fewer. Subject and snippet are truncated so the request stays within that budget.

### 6.4 Fusion (deterministic)

Let `m = {delete, archive, keep, unsure}` be the model probabilities.

1. **Prior.** Per-sender Beta prior: `α = 1 + #owner_delete`, `β = 1 + #owner_not_delete`, and `n = α + β - 2`. Use the domain prior when the sender has `n < 3`. Then `p_s = α / (α + β)`.
2. **Blend.** With `λ = n / (n + 5)`, compute `d = (1 - λ)·m.delete + λ·p_s`.
3. **Rebuild the distribution.** Build `v` with `v.delete = d`. For each other action `x`:
   - if `m.delete < 1`, set `v.x = m.x · (1 - d) / (1 - m.delete)`
   - otherwise, set `v.unsure = 1 - d` and every other `v.x = 0`

   `v` now sums to 1.
4. **Flag shifts.** Applied in this order. Each shift moves mass between two entries of `v`, so the sum stays 1:
   - If `is_record ≥ 0.7`, move 50% of `v.delete` to `v.archive`.
   - If `is_from_human ≥ 0.7`, move 50% of `v.delete` to `v.keep`.
   - If `is_expired ≥ 0.7` and `is_from_human < 0.5`, move 30% of `v.archive` to `v.delete`.

   From here on, `d` refers to `v.delete`.
5. **Ceiling.** If the top action exceeds the guardrail ceiling, set the action to the ceiling and add the guardrail reason.
6. **Thresholds.** Suggest `delete` only if `d ≥ τ_delete` (default 0.80) **and** `d` exceeds the next action by at least 0.20. Otherwise use the best non-delete action. If the top probability is below 0.55, suggest `unsure`.
7. **Reasons.** Pick up to 3 human-readable reasons from the dominant signals, the prior, and the flags, for example "deleted 14/14 from this sender", "0% opened in 90 days", "has List-Unsubscribe", "offer expired".

### 6.5 Learning loop

- Every approve, reject, or override writes a `labels` row, updates `sender_priors`, and joins the few-shot pool.
- A **nightly calibration** job computes delete precision over the last 500 labels. When at least 50 delete suggestions exist, it picks the smallest `τ_delete` in `[0.80, 0.99]` (step 0.01) whose precision is at least **0.98**. `τ_delete` never drops below 0.80.
- `model_version` and `policy_version` are stored on each suggestion so behavior changes can be compared.

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
| App access | Cloudflare Access protects **all** routes, including `workers.dev`, with a policy that allows only the owner's email. The Worker independently verifies `Cf-Access-Jwt-Assertion`: signature against the team JWKS, `aud`, `exp`, and that `email` equals the `OWNER_EMAIL` secret. It **fails closed** when Access config is missing. |
| Local dev | Binds to localhost. `DEV_AUTH_BYPASS=true` is honored only when `ENVIRONMENT=development`; otherwise the Worker refuses to start. |
| OAuth scopes | Gmail `gmail.modify` only. It cannot permanently delete, so the provider itself enforces trash-only. Graph uses delegated `Mail.ReadWrite`, `offline_access`, `User.Read`. No send scopes and no contacts scopes. |
| OAuth flow | Authorization code + PKCE (S256). `state` is HMAC-signed, bound to a `SameSite=Lax`, `HttpOnly`, `Secure` cookie, with a 10-minute TTL. Redirect URIs must match exactly. |
| Token storage | Refresh tokens are encrypted with AES-256-GCM (WebCrypto). Each record gets a random 96-bit IV and uses `account_id` as AAD. A `key_version` column supports rotation. The key lives in the `TOKEN_ENC_KEY` secret. Access tokens are kept in memory only. |
| Disconnect | Revokes the token at the provider, deletes the account's token, messages, and suggestions, and keeps the audit log. |
| Web | Strict CSP (`default-src 'self'`, no inline script). Mutating routes require the `X-Clearbox-CSRF` header plus the Access JWT. App cookies use `SameSite=Strict`. Email content is **rendered as plain text only**; HTML bodies are never rendered. |
| Prompt injection | Email text is untrusted `state`. Decision-1 returns only bounded probabilities, so there are no tools and no generated text. The blast radius is limited by guardrails based on headers and history, by mandatory human approval, and by trash-only actions. |
| Destructive actions | Approval sends the exact suggestion IDs the UI displayed. The server verifies they are `pending` and belong to the account, caps a batch at 500, and executes idempotently. Undo is available for 24 hours in the UI (the provider keeps trash for about 30 days). The audit log is append-only. |
| Data minimization and residency | Clearbox stores metadata plus the snippet. Snippet storage can be turned off with `STORE_SNIPPETS=false`. Message rows have a 30-day TTL and are purged nightly. `labels` keep only the sender, the domain, and a subject truncated to 60 characters (set `LABEL_SUBJECTS=false` to drop the subject). D1 is created with **EU jurisdiction**, and Decision-1 runs on **DataZoneStandard (EU)**. Logs contain opaque IDs and counts only, never addresses, subjects, or snippets. |
| Isolation | Every repository function requires `account_id`. A lint rule or test asserts that no query on account-owned tables omits it. |
| Public repo hygiene | No secrets in the repo. `.dev.vars` is gitignored, and fixtures are synthetic only. Secrets are set with `cf` secrets: `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_KEY`, `AZURE_DECISION_DEPLOYMENT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. |
| Supply chain | Lockfile committed, minimal dependencies, Dependabot, CodeQL, and GitHub secret scanning with push protection. |
| Review gate | A `security-review` pass over token handling, OAuth, Access verification, and action endpoints is required before first deploy. |

## 8. Data model (D1)

| Table | Columns | Notes |
|---|---|---|
| `accounts` | id, provider, email_hash, enc_refresh_token, iv, key_version, sync_cursor, backfill_cursor, status (`active`, `needs_reauth`, `disconnected`), created_at | `email_hash` = SHA-256 of the lowercased address |
| `messages` | id, account_id, provider_msg_id, sender, sender_domain, subject, snippet, signals_json, received_at, expires_at | Unique on (account_id, provider_msg_id); purged after `expires_at` |
| `suggestions` | id, message_id, account_id, action, p_delete, p_archive, p_keep, p_unsure, importance, flags_json, ceiling, reasons_json, model_version, policy_version, status, updated_at | status: `pending`, `approved`, `rejected`, `executed`, `failed`, `undone` |
| `labels` | id, account_id, sender, sender_domain, subject_trunc, suggested_action, owner_action, created_at | Kept after the message row is purged; used as the eval and few-shot pool |
| `sender_priors` | account_id, key, alpha, beta | `key` is an address or `@domain` |
| `audit_log` | id, ts, account_id, action, ids_hash, count, result | Append-only |
| `budget` | date, rows_written, decision_calls | Enforces the free-tier write budget |
| `settings` | key, value | `τ_delete`, policy version, and similar |

Indexes: `(account_id, status)` on suggestions, `(account_id, sender_domain)` on messages and labels, and `expires_at` on messages.

## 9. Scan workflow and Cloudflare Free budget

### Free plan limits (verified 2026-10-15)

- **Workers:** 10 ms CPU per request or step, 50 subrequests, 100k requests per day, 5 Cron Triggers.
- **Workflows:** 1,024 steps per instance, 100 concurrent instances.
- **D1:** 5M rows read and 100k rows written per day, 5 GB storage.

### ScanWorkflow (one instance per account per run)

1. `step.do("load-account")` refreshes the access token (1 subrequest).
2. Loop (each iteration is one step, at most 25 messages):
   1. List and fetch a page of metadata (1 or 2 subrequests).
   2. Load priors and labels for the senders on the page (1 D1 batch).
   3. Run the Decision-1 calls: 25 requests, at most 6 concurrent, with retries.
   4. Run fusion (pure).
   5. Write messages and suggestions, update the budget (1 `db.batch`).
   6. Return the cursor.
3. Stop the loop when the page is empty, when the step count reaches 900 (then start a successor instance with the cursor), or when the daily write budget (90k rows) is reached (then `step.sleep` until 00:05 UTC).
4. Backfill walks the inbox from newest to oldest. Steady state uses the delta or history cursor.

Each step uses at most 30 subrequests. The CPU target is **8 ms or less per step**, enforced by a benchmark test.

**Crons:** `*/30 * * * *` starts a scan for every active account. `0 2 * * *` runs calibration and the TTL purge.

**Cost estimate:** about 5 D1 rows written per email gives about 15k emails per day of backfill on the free plan. Decision-1 costs about 800 tokens × $0.042/M, which is about **$0.34 per 10k emails**.

**Upgrade path:** on Workers Paid, set `FREE_TIER=false`. That raises the page size to 100, removes the write budget, and lifts the step limit to 10k. No code changes are needed.

## 10. Error handling

| Failure | Behavior |
|---|---|
| Provider 429 / 503 | Retry the step with exponential backoff, honoring `Retry-After` |
| `invalid_grant` (revoked or expired refresh token) | Set the account to `needs_reauth`, skip its scans, and show a UI banner |
| Decision-1 error, timeout (10 s), or 4xx/5xx | Retry 3 times, then store the suggestion as `unsure` with the reason "model unavailable" |
| Response fails zod validation | Store as `unsure` |
| Daily D1 write budget reached | `step.sleep` until the next UTC day |
| Execute fails for a message (missing or moved) | Mark that suggestion `failed` and continue; return per-item results |
| CPU limit (error 1102) on a step | Halve the page size for the account (minimum 5) and retry |
| Any unexpected error | Fail safe: no action is taken, and the suggestion stays `pending` or `unsure` |

Invariant: **no code path executes a trash or archive without an approved suggestion ID.**

## 11. Review UI

- **Queue** grouped by sender (account selector, action filter), sorted by confidence. Each group shows the count, the suggested action, a confidence bar, and the top reasons.
- **Actions:** approve a group, approve a single item, override an action, and "Always keep sender" or "Always allow delete" (edits the allow / deny list).
- **Message view:** subject, sender, date, snippet, and signals, all rendered as plain text, with a link to open the message in Gmail or Outlook.
- **Undo** for the last 24 hours.
- **Dashboard:** delete precision, label count, current `τ_delete`, scan status per account, and today's free-tier budget usage.
- **Settings:** connect or disconnect accounts, edit the policy (allow / deny lists, `min_age_days`), and toggle snippet storage.

## 12. Setup and operations

- **Guides:** `docs/setup-cloudflare.md`, `docs/setup-azure.md`, `docs/setup-google.md`, `docs/setup-microsoft.md`, and `docs/runbook.md` (key rotation, re-auth, purge, restore).
- **`pnpm setup`:** uses `cf` to create the D1 database (EU jurisdiction), apply migrations, prompt for and set secrets, deploy, and print the Access configuration steps.
- **Azure:** `infra/azure/` contains a script or Bicep that creates an AIServices resource in `swedencentral` and a `Microsoft-Decision-1` deployment with SKU `DataZoneStandard`.
- **Local:** `cf dev` with local D1 and `.dev.vars`, plus `DEV_AUTH_BYPASS` (development only).

## 13. Testing and evaluation

| Layer | Tooling | Coverage |
|---|---|---|
| Core | Vitest | Signal extraction, the guardrail ceiling matrix, fusion math (including the renormalize edge cases), prior updates, thresholds |
| Providers | Vitest + MSW with synthetic recorded fixtures | Graph and Gmail parsing, paging, delta / history, batch responses, 429 handling, trash / archive / restore |
| Worker | `@cloudflare/vitest-pool-workers` | Routes; Access JWT verification (fail closed, wrong email, wrong aud); OAuth state and PKCE; encryption round trip; approval invariants; Workflow steps with `FakeEngine` |
| Free-tier budget | Benchmark test | A 25-message step uses 8 ms CPU or less and 30 subrequests or less |
| Model eval | `pnpm eval` against the live deployment | Delete precision and recall, a calibration (reliability) curve, and an option-order shuffle robustness check, on synthetic fixtures plus exported owner labels |
| Security | `security-review` agent, CodeQL | Before first deploy and on changes to auth, crypto, or actions |

**Observability:** Workers Logs (structured, IDs only), per-scan metrics (messages, decisions, errors, model latency p50 / p95, tokens), and audit log views in the dashboard.

## 14. Future extensions (not in v1)

- An `Explainer` plugin interface that sends `unsure` items to a generative model for a summary (Approach C).
- An unsubscribe assistant using `List-Unsubscribe` and one-click unsubscribe.
- Multi-tenant mode.
- Embeddings-based similar-decision retrieval.
- Entra ID auth to Foundry, replacing the API key.

## 15. Risks and open items

| Risk | Mitigation |
|---|---|
| Decision-1 is in Preview; its API or availability may change | Isolate it behind `DecisionEngine`; pin the deployment name; `FakeEngine` keeps the app usable |
| 10 ms CPU on Free | Benchmark test, adaptive page size, and the Paid escape hatch |
| Gmail restricted scope and unverified-app warning | Documented "In production (unverified)" setup for personal use |
| Corporate Microsoft tenants blocking consent | Documented admin-consent path |
| `cf` CLI configuration format and the Workers Vitest pool compatibility | Verify against current docs during planning before scaffolding |
