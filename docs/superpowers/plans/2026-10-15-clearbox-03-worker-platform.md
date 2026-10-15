# Clearbox Worker Platform Implementation Plan (plan 03 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@clearbox/app` Worker platform: the Vite + `cf` app scaffold, the D1 schema, Cloudflare Access and CSRF security, token encryption, the OAuth connect flow, the D1 repository layer, and every REST route in contracts section 7 except `POST /api/accounts/:id/scan`, including the approve/override/Clean up execution path and undo.

**Architecture:** One Vite project in `app/` builds the Worker (`src/worker`, Hono on Workers with D1) and the SPA (`src/web`, a placeholder here, replaced by plan 05). Requests pass `secureHeaders` -> request context -> Access JWT guard -> CSRF guard -> body limit -> zod-validated routes -> one error envelope. All SQL lives in `src/worker/db/*.ts` statement builders that are always scoped by `account_id`; owner actions claim suggestions (`pending -> approved`), call the mail provider through an injectable `ProviderFactory`, and commit every result in one D1 batch (one transaction).

**Tech Stack:** TypeScript 6.0.3 (strict, erasable syntax only), Hono 4.13.13, Cloudflare D1, `cf` 1.0.0-beta.17 with `@cloudflare/vite-plugin` 2.0.0-beta.sha-67fa336fd, Vite 8.3.4, zod 4.6.7, jose 6.2.12, WebCrypto (AES-256-GCM, HMAC-SHA-256, SHA-256), Vitest 5.0.4 with `@cloudflare/vitest-plugin` 1.4.2, msw 3.0.3 with `@msw/cloudflare` 0.2.0.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` (contracts), including the binding section 12 "Amendments (rev 2.1)", which overrides earlier sections. Exact names, paths, types, routes and SQL come from it; this plan does not edit it.
- Prerequisites: plan 01 (repo scaffold, root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `scripts/check-text.ts`, all of `@clearbox/core` including `@clearbox/core/testing`) and plan 02 (Gmail and Graph providers plus OAuth helpers exported from `@clearbox/core`) are merged before Task 1 starts.
- Node.js 24.13.1 (`engines` `>=24.13.0`), pnpm 12.11.2. Exact dependency versions from contracts section 2, no ranges.
- No em dashes (U+2014) anywhere: code, comments, tests, commit messages. `pnpm lint` runs `scripts/check-text.ts`.
- ESM only, `"type": "module"`, relative imports with explicit `.ts`/`.tsx` extensions, `import type` for types, named exports only (default exports only in `src/worker/index.ts` and config files).
- No `enum`, no `namespace`, no parameter properties, no `any`, no non-null assertions outside tests (`erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` are on).
- Only `src/worker/log.ts` calls `console.log`. Logs carry opaque ids, counts, enum codes and HTTP statuses only: never email addresses (including the owner's), display names, subjects, snippets, provider message or thread ids, tokens, cookies, URLs or query strings.
- SQL only in `src/worker/db/*.ts`. Always numbered `?N` parameters, never value interpolation. IN lists built with `placeholders(n, start)` and at most 99 bound parameters per statement. Every statement on `messages`, `suggestions`, `labels`, `sender_priors`, `senders`, `correspondents`, `sent_threads` contains `account_id = ?` or `account_id IN (` (INSERT statements list `account_id` as a column).
- Timestamps are epoch milliseconds internally and ISO 8601 (`toISOString()`) in REST responses. Time is injected (`now`), tests never depend on the wall clock except for JWT `exp` claims that `jose` checks.
- Every non-2xx `/api/*` response body is `ApiErrorBody`; every `/api/*` response has `Cache-Control: no-store` and `X-Request-Id`.
- Fixtures are synthetic: `example.com`, `example.net`, `example.org`, `*.test`. Owner email in tests is `owner@example.test`.
- Do not run `cf deploy` or touch a Cloudflare account in this plan; everything runs locally.
- `cf workers types` and `cf build` (inside `typecheck`, `build`, `deploy:cf`) evaluate `app/cloudflare.config.ts` in production mode, which throws without a D1 id (contracts 3.2). Local typecheck and build commands therefore run with `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000` (the public local id; plan 06 CI does the same). Never write that id into `app/clearbox.local.json`.

---

## Contract issues and decisions

These are gaps or ambiguities in the contracts that fall inside this plan's scope. The contracts doc is not edited; each item records the decision this plan implements.

1. **`scan/token-source.ts` and `scan/providers.ts` are built here, not in plan 04.** Owner actions, undo, disconnect and the OAuth callback need a `TokenSource` and a provider factory before plan 04 runs. Plan 04 imports `createD1TokenSource`, `refreshFnFor`, `D1TokenSource`, `TokenAccount`, `makeProvider`, `PROVIDER_OAUTH`, `ProviderTarget` and `ProviderOAuthMap` from these files and does not recreate or edit them; its tick-specific additions live in the new file `scan/tick-tokens.ts`.
2. **`TokenUpdate` shape.** There is exactly one `TokenUpdate`: plan 01 declares it in `packages/core/src/providers/token.ts` with the contracts 7.15 shape `{ accessToken: string; accessExpiresAt: number; refreshToken: string | null }` (contracts 4.4, rev 2.2). `src/worker/scan/token-source.ts` imports it from `@clearbox/core` and does not redeclare or re-export it; plan 04 does the same.
3. **Who owns which `db/*.ts` files.** This plan creates `sql.ts`, `accounts.ts`, `messages.ts`, `suggestions.ts`, `labels.ts`, `priors.ts`, `settings.ts`, `budget.ts`, `audit.ts`, `batches.ts`. Plan 04 adds no `db/*.ts` file: its lease, sender, correspondent and sent-thread SQL lives in its `scan/*.ts` and `nightly/*.ts` statement builders (contracts 1.1 and 11, rev 2.2), so contracts' former `db/leases.ts` and `db/senders.ts` do not exist. `messages.ts` and `suggestions.ts` already provide the ingest inserts from contracts 8.2 (`insertMessageStmt`, `insertSuggestionStmt`) because the test seed helpers need them.
4. **`scheduled` handler stubs.** `src/worker/index.ts` imports `runTick` from `./scan/tick.ts` and `runNightly` from `./nightly/nightly.ts` exactly as contracts 8.1. This plan ships both files as clearly marked temporary stubs (idle report, no-op). Plan 04 replaces both files wholesale and keeps the exported names and signatures.
5. **Scan-now route placement.** `POST /api/accounts/:id/scan` belongs to plan 04 but lives in `src/worker/routes/accounts.ts` per contracts 1.1. That file exports `accountsRoutes` (a `Hono<AppEnv>` mounted at `/api/accounts` by `createApp`). Plan 04 adds `accountsRoutes.post("/:id/scan", ...)` in the same file; no change to `app.ts` is needed.
6. **INSERT statements and the isolation rule.** An `INSERT ... VALUES` has no `WHERE account_id = ?`. The isolation test (contracts 6.1) therefore accepts INSERT statements whose column list contains `account_id`; all other statements need `account_id = ?` or `account_id IN (`.
7. **Isolation exemption marker.** Contracts 6.1 exempts "the calibration read of labels across accounts". Because the test scans SQL text, an exempt SQL string must contain the SQL comment `-- isolation-exempt: calibration`. That is the only accepted reason inside `src/worker/db/`. Plan 04 must add the marker to its calibration query.
8. **Query plan test ownership.** `app/test/worker/db/query-plans.test.ts` is created here with the queue, group, group-items and cleanup queries. Plan 04 checks its own awaiting-model (redecide) read against `suggestions_open` in `app/test/worker/tick/context.test.ts` (its SQL lives in `scan/context.ts`, not `db/`), so it does not edit this file.
9. **Batch and label ids inside one D1 batch.** D1 runs a batch as one serialized transaction, so the execute batch inserts the `action_batches` row first and sets `suggestions.batch_id = (SELECT MAX(id) FROM action_batches)` and `label_id = (SELECT MAX(id) FROM labels)` immediately after each label insert. This keeps the whole decision write in one transaction.
10. **Undo is one-shot per batch.** Contracts 7.8 defines `undoable` with `undoneAt is null`. Undo claims the batch first (`UPDATE action_batches SET undone_at = ? WHERE id = ? AND undone_at IS NULL AND undo_expires_at > ?`), so concurrent undo requests cannot double-apply priors. If no item was restored (for example the provider throttled the whole call), `undone_at` is reset to NULL so the owner can retry.
11. **Undo of `keep` items.** `keep` executed nothing at the provider, so undo returns those items as `skipped` (error `null`) and leaves them `executed`.
12. **Account status during actions.** `delete`/`archive` items of an account whose status is not `active` return `retry_later` with `account_inactive` and are never claimed. `keep` items execute regardless (no provider call). Paused accounts can still execute actions (pause only stops scanning). Outlook `archive` on an account without `archive_folder_id` is claimed and marked `failed` with `archive_unavailable` without a provider call. Unknown ids or ids of other accounts are `skipped` with `not_pending`.
13. **Whole-call provider errors.** `ProviderRateLimitError` -> `retry_later/rate_limited`, `ProviderUnavailableError` -> `retry_later/unavailable`, any other non-auth error -> `retry_later/unknown`; items return to `pending` and the account stops processing for this request. `ProviderAuthError`/`ProviderConfigError` follow contracts 7.7 and also write audit `reauth_required`/`config_error`; `ProviderConfigError` raises app issue `<provider>_client_invalid`.
14. **Group ordering and `confidence_desc`.** `confidence_desc` sorts groups by average confidence (ties: account id, sender, action ascending). Group and item cursors are keyset cursors encoded as base64url JSON with a filter fingerprint; a cursor used with different filters is `400 validation_failed`.
15. **Group `senderName` and `topReasons`.** `senderName` is the display name on the newest message of the group (`''` maps to `null`). `topReasons` are the three most frequent reason codes; the rendered text uses the params of one representative reason row for that code.
16. **Audit `result_json` for actions.** Action audit rows store the fixed keys of decision 28 (counts only). `GET /api/batches` reads `byAction` from that row, which avoids scanning `suggestions` (no `batch_id` index exists).
17. **Request logging.** Contracts 9 has no per-request event. This plan logs only the listed events (`access.denied`, `oauth.connect`, `action.executed`, `undo.done`, `provider.error`, `account.status`, `budget.gate`, `issue.raised`, `issue.cleared`), sets `X-Request-Id` on every Worker response, and relies on Workers invocation logs (with `redactQueryString: true`) for request lines. For unexpected errors `onError` logs `request.error` (`requestId`, `route`, `errorName`; contracts 9, rev 2.2) and returns `500 internal` with the request id. The error message is never logged.
18. **OAuth helper injection.** `createApp(overrides)` accepts `oauth` and `providerFactory` overrides so worker tests never depend on plan 02 wire details. Production uses `PROVIDER_OAUTH` (core helpers) and `makeProvider`.
19. **Refresh redirect URI.** `refreshGoogleToken` / `refreshMicrosoftToken` take an `OAuthClientConfig`, whose `redirectUri` is irrelevant for refresh grants. Request handlers pass the request-derived callback URI; plan 04 (no request origin in `scheduled`) passes `""`.
20. **`AccountSync.nextTickAt`.** `next_tick_at = 0` means "due now" and is returned as `null`.
21. **OAuth callback error type.** `src/shared/api.ts` additionally exports `OAUTH_CALLBACK_ERRORS` and `OAuthCallbackErrorCode` (the list in contracts 7.13) so the SPA can map `?error=` codes without inventing strings.
22. **Group key and cursors.** `encodeGroupKey`/`decodeGroupKey` live in `src/worker/db/suggestions.ts`; `encodeCursor`/`decodeCursor` live in `src/worker/db/sql.ts` (both listed files), so no new files are added to contracts 1.1.
23. **Key rotation.** Only `TOKEN_ENC_KEY` exists. Encryption always uses `CURRENT_KEY_VERSION = 1`; decryption uses the row's `key_version` in the AAD. A second key secret for rotation is out of scope (runbook, plan 06).
24. **Web placeholder.** `index.html`, `src/web/main.tsx`, `src/web/styles.css`, `public/favicon.svg`, `test/web/setup.ts` and `test/web/placeholder.test.tsx` are minimal placeholders so `cf build` and `pnpm test` pass before plan 05. Plan 05 replaces `index.html`, `main.tsx`, `styles.css` and `setup.ts`, keeps the favicon, and deletes `placeholder.test.tsx` (its Task 25).
25. **Policy writes.** `PUT /api/policy` uses a conditional version increment in the same batch as the policy write: `UPDATE settings ... WHERE key = 'policy_version' AND CAST(value AS INTEGER) = ?expected`, and the policy upsert and audit insert are guarded on the new version and timestamp. `PATCH /api/policy/senders` retries the read-modify-write up to 3 times on a concurrent change, then answers `409 conflict`.
26. **Amendments rev 2.1 applied (contracts 12).** `src/shared/api.ts` adds `AccountSync.inboxEstimate` (A4), `QueueSummary.groupsByAction` (A1), `SenderGroup.latestSubject` (A6), `CleanupPreview.groupsLeft` (A2) and `Insights.weekly` (A3); migration 0001 adds `accounts.inbox_estimate INTEGER` with `CHECK (inbox_estimate IS NULL OR inbox_estimate >= 0)` right after `messages_ingested`. Each added line carries a `rev 2.1 Ax` comment.
27. **Who writes `inbox_estimate` (A4).** `completeConnect` calls plan 02's `MailProvider.inboxEstimate()` once after `bootstrap()` (one subrequest, best effort: any error or `null` leaves the column NULL) and writes it with `setInboxEstimateStmt(db, accountId, estimate, now)` in the same D1 batch as the account insert or reconnect. Plan 04 fills a NULL value on the first backfill tick and refreshes it at most daily during backfill with the same statement builder. The API returns NULL until a value is known.
28. **Fixed audit result keys (A5).** `approve`/`override`/`cleanup` rows store exactly `{ executed, failed, skipped, retryLater, delete, archive, keep, groups }` where `delete`/`archive`/`keep` count executed items per final action and `groups` counts distinct `(account, sender, suggested action)` groups among executed items; `undo` stores `{ restored, failed }`; `policy_updated` stores `{ allow, deny }` (list sizes). Other kinds written by this plan (`account_*`, `reauth_required`, `config_error`) store `{}`. This replaces decision 16's key list; `GET /api/batches` still reads `byAction` from these keys.
29. **Keep is excluded from Clean up; "Confirm all keeps" (12.3).** `GET /api/cleanup/preview` and `POST /api/cleanup` default `actions` to `["delete", "archive"]`. `actions` that mix `keep` with other actions are `400 validation_failed`. `actions: ["keep"]` alone is the "Confirm all keeps" request: it approves pending `keep` suggestions in scope with `confidence >= threshold` (the UI sends `threshold: 0.5`, the schema minimum), at most 100 per call with `remaining`, recorded with `decided_via = 'cleanup'` and audit kind `cleanup`. No new route is added.
30. **Weekly insights (A3).** Weeks start Monday 00:00 UTC; the 6 weeks end with the current week. `cleaned` sums `delete + archive` from `approve`/`override`/`cleanup` audit rows in the week; `undone` sums `restored` from `undo` audit rows. Computed from `audit_log` only (small table, one scan). `weekStart` is the UTC date `YYYY-MM-DD` of that Monday (same format as `history[].date`).
31. **Group subject and name (A6, decision 15).** `latestSubject` and `senderName` come from the newest pending message of the group via one aggregate `MAX(printf('%015d', received_at) || json_array(sender_name, subject))`, so nulls survive and no extra query is needed.
32. **SPA test dependencies (12.4).** `app/package.json` also declares `axe-core` 4.14.0 and `@testing-library/user-event` 14.6.8 as dev dependencies so plan 05 does not edit the manifest for them.
33. **`groupsLeft` scope (A2).** Sender groups are `(account, sender, suggested action)` over `pending` items, so `groupsLeft` counts pending groups with at least one item the Clean up would not take (below threshold, `unsure`, `keep`, or an action not selected). `awaiting_model` items belong to no group and are reported separately as `QueueSummary.awaitingModel`.

---

## File Structure

All paths are relative to the repository root. Everything is inside `app/` (contracts 1.1).

| File | Responsibility | Task |
|---|---|---|
| `app/package.json` | `@clearbox/app` manifest, scripts (contracts 1.3), all app dependencies (including SPA deps for plan 05) | 1 |
| `app/cloudflare.config.ts` | `cf` project config (contracts 3.2, verbatim) | 1 |
| `app/vite.config.ts` | Vite + React + Tailwind + Cloudflare plugin (contracts 3.3) | 1 |
| `app/vitest.worker.config.ts` | Workers runtime tests (contracts 3.6) | 1 |
| `app/vitest.web.config.ts` | SPA tests in happy-dom (contracts 3.6) | 1 |
| `app/tsconfig.json`, `tsconfig.worker.json`, `tsconfig.web.json`, `tsconfig.node.json` | TypeScript project references (contracts 3.5) | 1 |
| `app/index.html` | SPA entry, no inline script or style | 1 |
| `app/.dev.vars.example` | local secrets template (contracts 3.7) | 1 |
| `app/public/_headers` | CSP and security headers for assets (contracts 3.4) | 1 |
| `app/public/favicon.svg` | app icon (plan 05 keeps it) | 1 |
| `app/migrations/0001_init.sql` | D1 schema (contracts 6.1, verbatim) | 1 |
| `app/src/web/main.tsx`, `app/src/web/styles.css` | TEMPORARY SPA placeholder (plan 05 replaces) | 1 |
| `app/test/worker/env.d.ts` | `ProvidedEnv` with `TEST_MIGRATIONS` | 1 |
| `app/test/worker/setup/apply-migrations.ts`, `setup/network.ts` | per-file D1 migrations, MSW network with JWKS + catch-all | 1, 5 |
| `app/test/web/setup.ts`, `app/test/web/placeholder.test.tsx` | TEMPORARY web test harness (plan 05 replaces / deletes) | 1 |
| `app/src/shared/api.ts` | REST contract: zod schemas + response types (contracts 7, verbatim) | 2 |
| `app/src/worker/env.ts` | `AppConfig`, `readConfig`, `AppEnv`, `AppDeps`, `CRON_TICK`, `CRON_NIGHTLY` | 3, 5 |
| `app/src/worker/log.ts` | `logEvent`, `newRequestId`, `newAccountId` | 3 |
| `app/src/worker/crypto/base64.ts` | base64 / base64url codecs, `bytesFromBlob` | 4 |
| `app/src/worker/crypto/aead.ts` | AES-256-GCM token encryption with AAD | 4 |
| `app/src/worker/crypto/hmac.ts` | HMAC-SHA-256 sign/verify | 4 |
| `app/src/worker/crypto/pkce.ts` | PKCE verifier and S256 challenge, random base64url | 4 |
| `app/src/worker/middleware/errors.ts` | `ApiError`, envelope, zod mapping, `parseWith`, `onApiError`, `notFoundHandler` | 5 |
| `app/src/worker/middleware/headers.ts` | `workerSecureHeaders`, `apiResponseHeaders`, `requestContext`, `apiBodyLimit` | 5 |
| `app/src/worker/middleware/access.ts` | `verifyAccessJwt`, `accessGuard`, dev bypass | 5 |
| `app/src/worker/middleware/csrf.ts` | `csrfGuard` | 5 |
| `app/src/worker/scan/providers.ts` | `ProviderFactory`, `makeProvider`, `ProviderOAuth`, `PROVIDER_OAUTH`, `oauthClientConfig` | 5 |
| `app/src/worker/app.ts` | `createApp(overrides)`: middleware order, route mounting | 5, 9, 10, 11, 13, 14, 15 |
| `app/src/worker/index.ts` | `export default { fetch, scheduled }` | 1, 5 |
| `app/src/worker/scan/tick.ts` | TEMPORARY stub of `runTick` + `TickOptions` (plan 04 replaces) | 5 |
| `app/src/worker/nightly/nightly.ts` | TEMPORARY stub of `runNightly` (plan 04 replaces) | 5 |
| `app/test/worker/helpers/access.ts` | RS256 test keys, JWKS handler, `signAccessJwt` | 5 |
| `app/test/worker/helpers/request.ts` | `apiFetch`, `readJson` | 5 |
| `app/src/worker/db/sql.ts` | `chunk`, `placeholders`, `sumRowsWritten`, `sumRowsRead`, `now`, `withCount`, `toIso`, `utcDate`, cursors | 6 |
| `app/src/worker/db/settings.ts` | typed settings read/write, app issues | 6 |
| `app/src/worker/db/budget.ts` | budget upsert, reads, history | 6 |
| `app/src/worker/db/audit.ts` | audit append, activity page, batch audit rows | 6 |
| `app/src/worker/db/accounts.ts` | `Account` mapper, account reads and statements | 7 |
| `app/src/worker/db/messages.ts` | message insert, provider id update | 7 |
| `app/src/worker/db/suggestions.ts` | suggestion insert, open counts, dismiss, group key; queue queries (Task 11); execution queries (Task 12) | 7, 11, 12 |
| `app/src/worker/db/labels.ts` | label insert, undo update, insight reads | 7 |
| `app/src/worker/db/priors.ts` | prior delta aggregation and upserts | 7 |
| `app/src/worker/db/batches.ts` | action batch insert, read, list, undo claim/reset | 7 |
| `app/test/worker/helpers/seed.ts` | `seedAccount`, `seedMessages`, `seedSuggestions`, `seedLabels` | 7 |
| `app/src/worker/scan/token-source.ts` | `createD1TokenSource`, `refreshFnFor`, `tokenUpdateStmt`, `staticTokenSource` (uses core's `TokenUpdate`) | 8 |
| `app/test/worker/helpers/fake-provider.ts` | `FakeProvider`, `fakeProviderFactory`, `fakeOAuth` | 8 |
| `app/src/worker/oauth/state-cookie.ts` | OAuth state cookie create/verify/clear (contracts 7.12) | 9 |
| `app/src/worker/oauth/connect.ts` | `completeConnect` (contracts 7.13 steps 3 to 8) | 9 |
| `app/src/worker/routes/oauth.ts` | `/oauth/{google,microsoft}/{start,callback}` | 9 |
| `app/src/worker/routes/me.ts` | `GET /api/me` | 10 |
| `app/src/worker/routes/accounts.ts` | accounts list, patch, delete (plan 04 adds scan) | 10 |
| `app/src/worker/routes/queue.ts` | summary, groups, group detail | 11 |
| `app/src/worker/actions/learn.ts` | label and prior statements for decisions and undo | 12 |
| `app/src/worker/actions/execute.ts` | `executeSuggestions` (approve, override, cleanup) | 12 |
| `app/src/worker/routes/actions.ts` | approve, override, cleanup preview, cleanup | 13 |
| `app/src/worker/actions/undo.ts` | `undoBatch` | 14 |
| `app/src/worker/routes/batches.ts` | batches list, undo | 14 |
| `app/src/worker/routes/activity.ts` | activity feed | 15 |
| `app/src/worker/routes/insights.ts` | insights | 15 |
| `app/src/worker/routes/policy.ts` | policy get, put, sender patch | 15 |

Not created here (owned elsewhere): `scan/engine.ts`, `scan/ingest.ts`, `scan/write-plan.ts`, `scan/claim.ts`, `scan/context.ts`, `scan/failure.ts`, `scan/tick-tokens.ts`, `nightly/purge.ts` and the real `scan/tick.ts` / `nightly/nightly.ts` (plan 04); every other `src/web/**` file (plan 05).

Test files (contracts 10.1 areas): `app/test/worker/db/schema.test.ts`, `routes/api-schemas.test.ts`, `access/config.test.ts`, `routes/log.test.ts`, `crypto/base64.test.ts`, `crypto/aead.test.ts`, `crypto/hmac.test.ts`, `crypto/pkce.test.ts`, `access/access.test.ts`, `csrf/csrf.test.ts`, `routes/envelope.test.ts`, `routes/entry.test.ts`, `db/sql.test.ts`, `db/settings.test.ts`, `db/budget-audit.test.ts`, `db/repositories.test.ts`, `db-isolation.test.ts`, `oauth/token-source.test.ts`, `oauth/state-cookie.test.ts`, `oauth/oauth-routes.test.ts`, `routes/me-accounts.test.ts`, `routes/queue.test.ts`, `db/query-plans.test.ts`, `actions/execute.test.ts`, `routes/actions.test.ts`, `actions/undo.test.ts`, `routes/activity-insights-policy.test.ts`.

## Interfaces produced for other plans

Plans 04 and 05 consume these exact exports. Signatures are defined in the tasks below.

| Path | Exports | Consumer |
|---|---|---|
| `app/src/shared/api.ts` | every type and schema in contracts 7 (incl. `TickReport`, `ApiErrorBody`, `ApiErrorCode`, `CSRF_HEADER`, `CSRF_VALUE`, `AppIssue`, `AppIssueCode`), plus `OAUTH_CALLBACK_ERRORS`, `OAuthCallbackErrorCode` | 04, 05 |
| `app/src/worker/env.ts` | `CRON_TICK`, `CRON_NIGHTLY`, `AppConfig`, `ConfigResult`, `readConfig(env: Env): ConfigResult`, `AppDeps`, `AppEnv` | 04 |
| `app/src/worker/log.ts` | `logEvent(name, fields)`, `LogEventName`, `newRequestId(): string`, `newAccountId(): string` | 04 |
| `app/src/worker/middleware/errors.ts` | `ApiError` (`new ApiError(status, code, message, { details?, retryAt? })`), `errorBody`, `parseWith(schema, input)` | 04 (scan route pre-claim errors) |
| `app/src/worker/crypto/aead.ts` | `CURRENT_KEY_VERSION`, `importEncKey(raw)`, `encryptToken(key, plaintext, ctx)`, `decryptToken(key, value, ctx)`, `EncryptedValue`, `TokenKind` | 04 |
| `app/src/worker/scan/token-source.ts` | `RefreshFn`, `TokenAccount`, `D1TokenSource`, `createD1TokenSource(opts)`, `refreshFnFor(oauth, config, provider, fetch, now, redirectUri)`, `tokenUpdateStmt(db, account, encKey, update, now)`, `staticTokenSource(accessToken)` | 04 |
| `app/src/worker/scan/providers.ts` | `ProviderTarget`, `ProviderFactory`, `makeProvider`, `ProviderOAuth`, `ProviderOAuthMap`, `PROVIDER_OAUTH`, `oauthClientConfig(config, provider, redirectUri)`, `callbackPath`, `routeSegment` | 04 |
| `app/src/worker/db/sql.ts` | `chunk`, `placeholders`, `sumRowsWritten`, `sumRowsRead`, `now`, `withCount`, `toIso`, `utcDate`, `nextUtcMidnight`, `encodeCursor`, `decodeCursor`, `MAX_BOUND_PARAMS` | 04 |
| `app/src/worker/db/accounts.ts` | `Account`, `AccountRow`, `mapAccount`, `getAccount`, `listAccounts`, `markAccountStatusStmt`, `setInboxEstimateStmt` (A4), `tokensUpdateStmt`, `accessTokenUpdateStmt`, `toAccountView`, `toAccountSync` | 04 |
| `app/src/worker/db/messages.ts` | `MessageInsert`, `insertMessageStmt`, `updateProviderMsgIdStmt` | 04 |
| `app/src/worker/db/suggestions.ts` | `SuggestionInsert`, `insertSuggestionStmt`, `countOpenByAccount` | 04 |
| `app/src/worker/db/settings.ts` | `Settings`, `selectSettingsStmt`, `parseSettings`, `readSettings`, `setSettingStmt`, `addIssue`, `removeIssue`, `setIssuesStmt`, `issuesEqual` | 04 |
| `app/src/worker/db/budget.ts` | `Budget`, `BudgetDelta`, `selectBudgetStmt`, `mapBudget`, `budgetDeltaStmt`, `readBudget` | 04 |
| `app/src/worker/db/audit.ts` | `AuditKind`, `auditStmt` (result keys per contracts 12.1 A5) | 04 |
| `app/src/worker/db/labels.ts` | `insertLabelStmt`, `LabelInsert` | 04 (reads) |
| `app/src/worker/routes/accounts.ts` | `accountsRoutes` (plan 04 adds `POST /:id/scan`) | 04 |
| `app/src/worker/scan/tick.ts` (stub) | `TickOptions`, `runTick(env, opts): Promise<TickReport>` | replaced by 04 |
| `app/src/worker/nightly/nightly.ts` (stub) | `runNightly(env, opts: { now: number }): Promise<void>` | replaced by 04 |
| `app/test/worker/helpers/*` | `apiFetch`, `readJson`, `signAccessJwt`, `jwksHandler`, `seedAccount`, `seedMessages`, `seedSuggestions`, `seedLabels`, `FakeProvider`, `fakeProviderFactory`, `fakeOAuth` | 04 |
| HTTP | every route in contracts 7.3 except `POST /api/accounts/:id/scan`; OAuth redirects to `/settings/accounts?connected=<id>` or `?error=<code>&provider=<kind>` | 05 |

---

### Task 1: App scaffold, D1 migration and test harness

**Files:**
- Create: `app/package.json`
- Create: `app/cloudflare.config.ts`
- Create: `app/vite.config.ts`
- Create: `app/vitest.worker.config.ts`
- Create: `app/vitest.web.config.ts`
- Create: `app/tsconfig.json`, `app/tsconfig.worker.json`, `app/tsconfig.web.json`, `app/tsconfig.node.json`
- Create: `app/index.html`
- Create: `app/.dev.vars.example`
- Create: `app/public/_headers`, `app/public/favicon.svg`
- Create: `app/migrations/0001_init.sql`
- Create: `app/src/worker/index.ts` (minimal; replaced in Task 5)
- Create: `app/src/web/main.tsx`, `app/src/web/styles.css` (TEMPORARY placeholders, plan 05 replaces)
- Create: `app/test/worker/env.d.ts`
- Create: `app/test/worker/setup/apply-migrations.ts`, `app/test/worker/setup/network.ts` (extended in Task 5)
- Create: `app/test/web/setup.ts` (TEMPORARY, plan 05 replaces)
- Test: `app/test/worker/db/schema.test.ts`, `app/test/web/placeholder.test.tsx` (TEMPORARY, plan 05 deletes)

**Interfaces:**
- Consumes: plan 01 root workspace (`pnpm-workspace.yaml` lists `app`, `tsconfig.base.json`), `@clearbox/core` package (`workspace:*`).
- Produces: `@clearbox/app` package with scripts `dev`, `build`, `typecheck`, `test`, `test:worker`, `test:web`, `db:migrate:local`, `deploy:cf` (contracts 1.3); D1 schema of contracts 6.1; global `Env` type generated by `cf workers types` into `app/.cloudflare/types/index.d.ts`; test env bindings from `vitest.worker.config.ts`; `network` (MSW) exported from `app/test/worker/setup/network.ts`.

- [ ] **Step 1: Create `app/package.json`**

```json
{
  "name": "@clearbox/app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "cf dev",
    "build": "cf workers types && tsc -b && cf build",
    "typecheck": "cf workers types && tsc -b",
    "test": "vitest run -c vitest.worker.config.ts && vitest run -c vitest.web.config.ts",
    "test:worker": "vitest run -c vitest.worker.config.ts",
    "test:web": "vitest run -c vitest.web.config.ts",
    "db:migrate:local": "cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local --persist-to .cloudflare/state",
    "deploy:cf": "cf workers types && tsc -b && cf deploy --no-provision"
  },
  "dependencies": {
    "@clearbox/core": "workspace:*",
    "@tanstack/react-query": "5.104.3",
    "hono": "4.13.13",
    "jose": "6.2.12",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "react-router": "8.4.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "2.0.0-beta.sha-67fa336fd",
    "@cloudflare/vitest-plugin": "1.4.2",
    "@msw/cloudflare": "0.2.0",
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/dom": "10.4.2",
    "@testing-library/user-event": "14.6.8",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "axe-core": "4.14.0",
    "cf": "1.0.0-beta.17",
    "happy-dom": "21.0.1",
    "msw": "3.0.3",
    "tailwindcss": "4.3.3",
    "vite": "8.3.4",
    "vitest": "5.0.4"
  }
}
```

The SPA dependencies (including the contracts 12.4 additions `axe-core` and `@testing-library/user-event`) are declared here so plan 05 does not need to edit this manifest.

- [ ] **Step 2: Create `app/cloudflare.config.ts` (contracts 3.2, verbatim)**

```ts
import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/** Local (dev and test) D1 is keyed by this fixed UUID; remote uses the real EU database. */
const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";

function remoteD1Id(): string {
  const fromEnv = process.env.CLEARBOX_D1_ID;
  if (fromEnv) return fromEnv;
  const file = new URL("./clearbox.local.json", import.meta.url);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { d1DatabaseId?: string };
    if (parsed.d1DatabaseId) return parsed.d1DatabaseId;
  }
  throw new Error(
    "No D1 database id. Run `pnpm setup:cf` or set CLEARBOX_D1_ID. Refusing to continue so cf cannot auto-provision a non-EU database.",
  );
}

export default defineConfig((ctx) => {
  const mode = ctx.mode ?? "production";
  const isLocal = mode === "development" || mode === "test";
  const environment = mode === "development" ? "development" : mode === "test" ? "test" : "production";

  return {
    worker: {
      name: "clearbox",
      entrypoint,
      // Must not exceed the workerd date shipped with miniflare 5.20261012.
      compatibilityDate: "2026-10-12",
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/oauth/*"],
      },
      env: {
        DB: bindings.d1({ id: isLocal ? LOCAL_D1_ID : remoteD1Id(), name: "clearbox" }),
        ENVIRONMENT: bindings.text(environment),
        DEV_AUTH_BYPASS: bindings.text(mode === "development" ? "true" : "false"),
        FREE_TIER: bindings.text("true"),
        AZURE_DECISION_ENDPOINT: bindings.secret(),
        AZURE_DECISION_KEY: bindings.secret(),
        AZURE_DECISION_DEPLOYMENT: bindings.secret(),
        GOOGLE_CLIENT_ID: bindings.secret(),
        GOOGLE_CLIENT_SECRET: bindings.secret(),
        MS_CLIENT_ID: bindings.secret(),
        MS_CLIENT_SECRET: bindings.secret(),
        TOKEN_ENC_KEY: bindings.secret(),
        STATE_SIGNING_KEY: bindings.secret(),
        OWNER_EMAIL: bindings.secret(),
        ACCESS_TEAM_DOMAIN: bindings.secret(),
        ACCESS_AUD: bindings.secret(),
      },
      triggers: [
        triggers.scheduled({ schedule: "* * * * *" }),
        triggers.scheduled({ schedule: "0 2 * * *" }),
      ],
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: true },
      },
      workersDev: true,
      previewUrls: false,
    },
  };
});
```

- [ ] **Step 3: Create `app/vite.config.ts` (contracts 3.3, verbatim)**

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { host: "localhost", port: 5173, strictPort: true },
  build: { sourcemap: false },
});
```

- [ ] **Step 4: Create the Vitest configs (contracts 3.6, verbatim)**

`app/vitest.worker.config.ts`:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      experimental: { newConfig: true },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          ENVIRONMENT: "test",
          DEV_AUTH_BYPASS: "false",
          FREE_TIER: "true",
          OWNER_EMAIL: "owner@example.test",
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-0000000000000000000000000000000000000000000000000000000000",
          TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          STATE_SIGNING_KEY: "HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=",
          AZURE_DECISION_ENDPOINT: "https://decision.example.test",
          AZURE_DECISION_KEY: "test-key",
          AZURE_DECISION_DEPLOYMENT: "decision-1",
          GOOGLE_CLIENT_ID: "test-google-client",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          MS_CLIENT_ID: "test-ms-client",
          MS_CLIENT_SECRET: "test-ms-secret",
        },
      },
    })),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["test/worker/setup/apply-migrations.ts", "test/worker/setup/network.ts"],
  },
});
```

`app/vitest.web.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { include: ["test/web/**/*.test.{ts,tsx}"], environment: "happy-dom", setupFiles: ["test/web/setup.ts"] },
});
```

- [ ] **Step 5: Create the TypeScript configs (contracts 3.5, verbatim)**

`app/tsconfig.json`:

```json
{ "files": [], "references": [{ "path": "./tsconfig.worker.json" }, { "path": "./tsconfig.web.json" }, { "path": "./tsconfig.node.json" }] }
```

`app/tsconfig.worker.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "composite": true, "noEmit": true, "types": ["@cloudflare/vitest-plugin/types"] },
  "include": ["src/worker", "src/shared", ".cloudflare/types", "test/worker"]
}
```

`app/tsconfig.web.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "composite": true, "noEmit": true, "lib": ["ES2024", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src/web", "src/shared", "test/web"]
}
```

`app/tsconfig.node.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "composite": true, "noEmit": true, "types": ["node"] },
  "include": ["cloudflare.config.ts", "vite.config.ts", "vitest.worker.config.ts", "vitest.web.config.ts"]
}
```

`app/test/worker/env.d.ts`:

```ts
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
```

- [ ] **Step 6: Create `app/.dev.vars.example` (contracts 3.7, verbatim)**

```dotenv
AZURE_DECISION_ENDPOINT=https://<foundry-account>.services.ai.azure.com
AZURE_DECISION_KEY=<key>
AZURE_DECISION_DEPLOYMENT=decision-1
GOOGLE_CLIENT_ID=<google-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret>
MS_CLIENT_ID=<entra-app-id>
MS_CLIENT_SECRET=<entra-client-secret>
TOKEN_ENC_KEY=<pnpm gen-key>
STATE_SIGNING_KEY=<pnpm gen-key>
OWNER_EMAIL=<you@example.com>
ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
ACCESS_AUD=<access-aud-tag>
```

- [ ] **Step 7: Create the static assets**

`app/public/_headers` (contracts 3.4, verbatim):

```txt
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
```

`app/public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f2937"/><path d="M8 11h16v2H8zm0 4h16v2H8zm0 4h10v2H8z" fill="#f9fafb"/></svg>
```

`app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Clearbox</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

`app/src/web/styles.css` (TEMPORARY, plan 05 replaces):

```css
@import "tailwindcss";
```

`app/src/web/main.tsx` (TEMPORARY placeholder so `cf build` has a client entry; plan 05 replaces this file):

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Placeholder() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Clearbox</h1>
      <p>The review UI is not built yet.</p>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <Placeholder />
    </StrictMode>,
  );
}
```

- [ ] **Step 8: Create the minimal Worker entry (replaced in Task 5)**

`app/src/worker/index.ts`:

```ts
export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 9: Create the worker test setup files**

`app/test/worker/setup/apply-migrations.ts`:

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`app/test/worker/setup/network.ts` (Task 5 adds the Access JWKS handler):

```ts
import { setupNetwork } from "@msw/cloudflare";
import { http } from "msw";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Last-resort handler: any unmocked outbound request fails the test. */
const catchAll = http.all("*", ({ request }) => {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
});

export const network = setupNetwork(catchAll);

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
```

Runtime handlers added with `network.use(...)` take precedence over the initial `catchAll`, and `resetHandlers()` restores only the initial handlers. If `setupNetwork` in `@msw/cloudflare@0.2.0` does not accept initial handlers (type error), change to `export const network = setupNetwork();` and add `beforeEach(() => network.use(catchAll))` after `beforeAll`, keeping the rest.

- [ ] **Step 10: Create the web test setup (TEMPORARY, plan 05 replaces)**

`app/test/web/setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

- [ ] **Step 11: Write the failing schema test**

`app/test/worker/db/schema.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const TABLES = [
  "accounts",
  "action_batches",
  "audit_log",
  "budget",
  "correspondents",
  "labels",
  "leases",
  "messages",
  "sender_priors",
  "senders",
  "sent_threads",
  "settings",
  "suggestions",
];

describe("0001_init migration", () => {
  it("creates every table of contracts 6.1", async () => {
    const res = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).run<{ name: string }>();
    expect(res.results.map((r) => r.name)).toEqual(TABLES);
  });

  it("creates the partial open-suggestions index", async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'suggestions_open'").first<{
      sql: string;
    }>();
    expect(row?.sql).toContain("WHERE status = 'pending' OR status = 'awaiting_model'");
  });

  it("seeds tau_delete and policy_version", async () => {
    const res = await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").run<{
      key: string;
      value: string;
    }>();
    expect(res.results).toEqual([
      { key: "policy_version", value: "1" },
      { key: "tau_delete", value: "0.8" },
    ]);
  });

  it("adds the rev 2.1 inbox_estimate column to accounts", async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('accounts')").run<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("inbox_estimate");
  });

  it("rejects a malformed account id", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO accounts (id, provider, email, provider_user_id, granted_scopes, incremental_cursor, enc_refresh_token, refresh_iv, created_at, updated_at) VALUES ('bad', 'gmail', 'a@example.com', 'a@example.com', '', '{}', x'00', x'00', 0, 0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
```

`app/test/web/placeholder.test.tsx` (TEMPORARY, plan 05 deletes it):

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("placeholder SPA entry", () => {
  it("renders the Clearbox heading into #root", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("../../src/web/main.tsx");
    expect(await screen.findByRole("heading", { name: "Clearbox" })).toBeTruthy();
  });
});
```

- [ ] **Step 12: Install and run the schema test to verify it fails**

Run: `pnpm install && pnpm --filter @clearbox/app test:worker -- test/worker/db/schema.test.ts`
Expected: FAIL. `readD1Migrations` finds no `migrations/` files, so `sqlite_master` lists no Clearbox tables (first assertion shows `[]`), or the run aborts with `ENOENT ... migrations`.

- [ ] **Step 13: Create `app/migrations/0001_init.sql` (contracts 6.1 verbatim plus the contracts 12.1 A4 column `inbox_estimate`)**

```sql
-- Migration number: 0001 	 2026-10-15T00:00:00.000Z

CREATE TABLE accounts (
  id                  TEXT PRIMARY KEY CHECK (length(id) = 20 AND id GLOB 'acc_[0-9a-f]*'),
  provider            TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email               TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  provider_user_id    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'needs_reauth', 'config_error', 'disconnected')),
  status_reason       TEXT,
  paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  key_version         INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  enc_refresh_token   BLOB,
  refresh_iv          BLOB,
  enc_access_token    BLOB,
  access_iv           BLOB,
  access_expires_at   INTEGER,
  granted_scopes      TEXT NOT NULL,
  owner_aliases_json  TEXT NOT NULL DEFAULT '[]',
  archive_folder_id   TEXT,
  phase               TEXT NOT NULL DEFAULT 'sent_backfill'
                        CHECK (phase IN ('sent_backfill', 'inbox_backfill', 'incremental')),
  sent_cursor         TEXT,
  sent_scanned        INTEGER NOT NULL DEFAULT 0 CHECK (sent_scanned >= 0),
  backfill_cursor     TEXT,
  backfill_done       INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
  incremental_cursor  TEXT NOT NULL,
  last_incremental_at INTEGER,
  watermark_received_at INTEGER,
  page_size           INTEGER NOT NULL DEFAULT 25 CHECK (page_size BETWEEN 5 AND 100),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  backoff_until       INTEGER,
  next_tick_at        INTEGER NOT NULL DEFAULT 0,
  last_tick_at        INTEGER,
  tick_started_at     INTEGER,
  tick_finished_at    INTEGER,
  last_error          TEXT,
  messages_ingested   INTEGER NOT NULL DEFAULT 0,
  inbox_estimate      INTEGER CHECK (inbox_estimate IS NULL OR inbox_estimate >= 0), -- rev 2.1 A4
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((enc_refresh_token IS NULL) = (refresh_iv IS NULL)),
  CHECK ((enc_access_token IS NULL) = (access_iv IS NULL)),
  CHECK (status = 'disconnected' OR enc_refresh_token IS NOT NULL)
);
CREATE UNIQUE INDEX accounts_provider_email ON accounts (provider, email) WHERE status <> 'disconnected';

CREATE TABLE leases (
  name         TEXT PRIMARY KEY,           -- 'account:<account_id>' or 'nightly'
  account_id   TEXT,
  holder       TEXT NOT NULL,              -- tick id / run id (uuid)
  acquired_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  released_at  INTEGER
) WITHOUT ROWID;

CREATE TABLE messages (
  id                  INTEGER PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts (id),
  provider_msg_id     TEXT NOT NULL,
  thread_id           TEXT,
  internet_message_id TEXT,
  sender              TEXT NOT NULL,       -- lowercased address, '' when unknown
  sender_name         TEXT,
  sender_domain       TEXT NOT NULL,       -- '' when unknown
  subject             TEXT,                -- <= 200 chars
  snippet             TEXT,                -- NULL when policy.storeSnippets = false
  received_at         INTEGER NOT NULL,
  is_read             INTEGER NOT NULL CHECK (is_read IN (0, 1)),
  signals_json        TEXT NOT NULL,
  web_link            TEXT,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_account_provider_id ON messages (account_id, provider_msg_id);

CREATE TABLE suggestions (
  message_id         INTEGER PRIMARY KEY REFERENCES messages (id),
  account_id         TEXT NOT NULL REFERENCES accounts (id),
  sender             TEXT NOT NULL,
  sender_domain      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN
                       ('awaiting_model', 'pending', 'approved', 'executed', 'failed', 'dismissed', 'undone')),
  action             TEXT CHECK (action IN ('delete', 'archive', 'keep', 'unsure')),
  confidence         REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  p_delete           REAL CHECK (p_delete IS NULL OR p_delete BETWEEN 0 AND 1),
  p_archive          REAL CHECK (p_archive IS NULL OR p_archive BETWEEN 0 AND 1),
  p_keep             REAL CHECK (p_keep IS NULL OR p_keep BETWEEN 0 AND 1),
  p_unsure           REAL CHECK (p_unsure IS NULL OR p_unsure BETWEEN 0 AND 1),
  model_p_delete     REAL CHECK (model_p_delete IS NULL OR model_p_delete BETWEEN 0 AND 1),
  margin             REAL,
  importance         REAL CHECK (importance IS NULL OR importance BETWEEN 0 AND 4),
  flags_json         TEXT,                 -- {"isRecord":0.03,"isExpired":0.91,"isFromHuman":0.01}
  ceiling            TEXT NOT NULL CHECK (ceiling IN ('keep', 'archive', 'delete')),
  ceiling_applied    INTEGER NOT NULL DEFAULT 0 CHECK (ceiling_applied IN (0, 1)),
  reasons_json       TEXT NOT NULL DEFAULT '[]',
  model_version      TEXT,
  policy_version     INTEGER NOT NULL,
  decision_attempts  INTEGER NOT NULL DEFAULT 0,
  retry_after        INTEGER,
  final_action       TEXT CHECK (final_action IN ('delete', 'archive', 'keep')),
  decided_via        TEXT CHECK (decided_via IN ('approve', 'override', 'cleanup')),
  batch_id           INTEGER,
  label_id           INTEGER,
  exec_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  expires_at         INTEGER NOT NULL,
  CHECK (status = 'awaiting_model' OR action IS NOT NULL),
  CHECK (status NOT IN ('executed', 'undone') OR final_action IS NOT NULL)
);
-- OR form on purpose: SQLite proves "status = 'pending'" implies this predicate, but not an IN (...) predicate.
CREATE INDEX suggestions_open ON suggestions (account_id, status, sender)
  WHERE status = 'pending' OR status = 'awaiting_model';

CREATE TABLE labels (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  message_id       INTEGER,                -- loose reference; message rows are purged
  sender           TEXT NOT NULL,
  sender_domain    TEXT NOT NULL,
  subject_trunc    TEXT,                   -- <= 60 chars; NULL when policy.labelSubjects = false
  suggested_action TEXT NOT NULL CHECK (suggested_action IN ('delete', 'archive', 'keep', 'unsure')),
  owner_action     TEXT NOT NULL CHECK (owner_action IN ('delete', 'archive', 'keep')),
  source           TEXT NOT NULL CHECK (source IN ('approve', 'override', 'cleanup', 'undo')),
  p_delete         REAL,
  margin           REAL,
  ceiling          TEXT NOT NULL CHECK (ceiling IN ('keep', 'archive', 'delete')),
  model_version    TEXT,
  policy_version   INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX labels_account_sender ON labels (account_id, sender);
CREATE INDEX labels_account_domain ON labels (account_id, sender_domain);

CREATE TABLE sender_priors (
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  key         TEXT NOT NULL,               -- 'user@example.com' or '@example.com'
  deletes     INTEGER NOT NULL DEFAULT 0 CHECK (deletes >= 0),
  keeps       INTEGER NOT NULL DEFAULT 0 CHECK (keeps >= 0),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
) WITHOUT ROWID;

CREATE TABLE senders (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  address       TEXT NOT NULL,
  domain        TEXT NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  read_count    INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TABLE correspondents (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  address       TEXT NOT NULL,
  last_sent_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
) WITHOUT ROWID;

CREATE TABLE sent_threads (
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  thread_id     TEXT NOT NULL,
  last_sent_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, thread_id)
) WITHOUT ROWID;

CREATE TABLE action_batches (
  id                   INTEGER PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('approve', 'override', 'cleanup')),
  suggestion_ids_json  TEXT NOT NULL,      -- JSON array of message_id integers, <= 100
  requested_count      INTEGER NOT NULL,
  executed_count       INTEGER NOT NULL DEFAULT 0,
  failed_count         INTEGER NOT NULL DEFAULT 0,
  undo_expires_at      INTEGER NOT NULL,
  undone_at            INTEGER
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  account_id  TEXT,                        -- no FK: audit rows outlive accounts
  kind        TEXT NOT NULL CHECK (kind IN (
                'account_connected', 'account_reconnected', 'account_disconnected', 'account_purged',
                'account_paused', 'account_resumed', 'reauth_required', 'config_error',
                'approve', 'override', 'cleanup', 'undo',
                'policy_updated', 'calibration', 'purge')),
  batch_id    INTEGER,
  count       INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}'   -- counts and codes only, never addresses or subjects
);

CREATE TABLE budget (
  date                  TEXT PRIMARY KEY CHECK (length(date) = 10),  -- 'YYYY-MM-DD' UTC
  rows_written          INTEGER NOT NULL DEFAULT 0,
  rows_read             INTEGER NOT NULL DEFAULT 0,
  ticks                 INTEGER NOT NULL DEFAULT 0,
  messages_ingested     INTEGER NOT NULL DEFAULT 0,
  decision_calls        INTEGER NOT NULL DEFAULT 0,
  decision_failures     INTEGER NOT NULL DEFAULT 0,
  decision_input_tokens INTEGER NOT NULL DEFAULT 0,
  provider_calls        INTEGER NOT NULL DEFAULT 0,
  db_size_bytes         INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,               -- JSON
  updated_at  INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO settings (key, value, updated_at) VALUES
  ('tau_delete', '0.8', 0),
  ('policy_version', '1', 0);
```

- [ ] **Step 14: Run the worker and web tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db/schema.test.ts`
Expected: PASS, `5 passed`.

Run: `pnpm --filter @clearbox/app test:web`
Expected: PASS, `1 passed`.

- [ ] **Step 15: Verify typecheck and build**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exits 0; `app/.cloudflare/types/index.d.ts` exists and declares `interface Env` with `DB: D1Database` and every binding of `cloudflare.config.ts`.

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app build`
Expected: exits 0 and writes `app/.cloudflare/output/v0/` (client assets include `index.html`, `_headers`, `favicon.svg`).

If `tsc -b` rejects `composite` with `noEmit`, apply the contracts 3.5 fallback: remove `"composite": true` from the three tsconfigs and replace `tsc -b` in the `build`, `typecheck` and `deploy:cf` scripts with `tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json && tsc -p tsconfig.node.json`, then rerun both commands.

- [ ] **Step 16: Apply the migration to the local dev database (smoke check)**

Run: `pnpm --filter @clearbox/app db:migrate:local`
Expected: output lists `0001_init.sql` as applied; `app/.cloudflare/state/v3/` exists (gitignored).

- [ ] **Step 17: Commit**

```bash
git add app pnpm-lock.yaml
git commit -m "feat(app): scaffold Worker + SPA project, D1 schema and test harness"
```

---

### Task 2: Shared REST contract (`src/shared/api.ts`)

**Files:**
- Create: `app/src/shared/api.ts`
- Test: `app/test/worker/routes/api-schemas.test.ts`

**Interfaces:**
- Consumes: from `@clearbox/core`: `PolicySchema`, `SenderEntrySchema`, types `ActionKind`, `Ceiling`, `MailCategory`, `OwnerPosition`, `AuthVerdict`, `ProviderKind`, `Policy`, `ReasonCode`, `SuggestedAction`, `CalibrationPoint`.
- Produces: every export of contracts 7.2 and 7.4 to 7.11, verbatim plus the contracts 12.1 field additions A1 (`QueueSummary.groupsByAction`), A2 (`CleanupPreview.groupsLeft`), A3 (`Insights.weekly`), A4 (`AccountSync.inboxEstimate`), A6 (`SenderGroup.latestSubject`) (exports: `CSRF_HEADER`, `CSRF_VALUE`, `ApiErrorCode`, `ApiErrorBody`, `PageQuerySchema`, `Page<T>`, `ApiReason`, `AppIssueCode`, `AppIssue`, `AccountStatus`, `AccountPhase`, `SuggestionStatus`, `Distribution`, `IsoDateSchema`, `SuggestionIdsSchema`, `MeResponse`, `AccountSync`, `AccountView`, `AccountsResponse`, `PatchAccountBodySchema`, `PatchAccountBody`, `DisconnectResponse`, `TickKind`, `TickReport`, `SummaryQuerySchema`, `QueueSummary`, `GroupsQuerySchema`, `GroupKey`, `SenderGroup`, `ItemSignals`, `SuggestionItem`, `GroupDetail`, `ApproveBodySchema`, `ApproveBody`, `OverrideBodySchema`, `OverrideBody`, `CleanupPreviewQuerySchema`, `CleanupBodySchema`, `CleanupBody`, `CleanupPreview`, `ItemOutcome`, `ItemErrorCode`, `ItemResult`, `ActionResponse`, `ActionBatchView`, `UndoItemResult`, `UndoResponse`, `ActivityQuerySchema`, `ActivityKind`, `ActivityEntry`, `Insights`, `PolicyResponse`, `PutPolicyBodySchema`, `PatchSenderBodySchema`), plus `OAUTH_CALLBACK_ERRORS` and `OAuthCallbackErrorCode` (decision 21).

- [ ] **Step 1: Write the failing schema tests**

`app/test/worker/routes/api-schemas.test.ts`:

```ts
import { DEFAULT_POLICY } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import {
  ApproveBodySchema,
  CleanupBodySchema,
  CleanupPreviewQuerySchema,
  GroupsQuerySchema,
  OAUTH_CALLBACK_ERRORS,
  PageQuerySchema,
  PatchSenderBodySchema,
  PutPolicyBodySchema,
  SuggestionIdsSchema,
} from "../../../src/shared/api.ts";

describe("PageQuerySchema", () => {
  it("coerces limit and defaults to 50", () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PageQuerySchema.parse({ limit: "10", cursor: "abc" })).toEqual({ limit: 10, cursor: "abc" });
  });
  it("rejects limit above 100", () => {
    expect(PageQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("SuggestionIdsSchema", () => {
  it("rejects duplicates, empty lists and more than 100 ids", () => {
    expect(SuggestionIdsSchema.safeParse([1, 1]).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse([]).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse(Array.from({ length: 101 }, (_, i) => i + 1)).success).toBe(false);
    expect(SuggestionIdsSchema.safeParse([1, 2, 3]).success).toBe(true);
  });
});

describe("ApproveBodySchema", () => {
  it("accepts ids or a group key with asOf, nothing else", () => {
    expect(ApproveBodySchema.safeParse({ ids: [1] }).success).toBe(true);
    expect(ApproveBodySchema.safeParse({ groupKey: "k", asOf: "2026-10-15T10:00:00.000Z" }).success).toBe(true);
    expect(ApproveBodySchema.safeParse({ groupKey: "k" }).success).toBe(false);
    expect(ApproveBodySchema.safeParse({ ids: [1], extra: true }).success).toBe(false);
  });
});

describe("Groups and cleanup queries", () => {
  it("defaults the group sort", () => {
    expect(GroupsQuerySchema.parse({}).sort).toBe("confidence_desc");
  });
  it("validates the cleanup actions CSV", () => {
    expect(CleanupPreviewQuerySchema.safeParse({ actions: "delete,archive" }).success).toBe(true);
    expect(CleanupPreviewQuerySchema.safeParse({ actions: "delete,unsure" }).success).toBe(false);
  });
  it("requires asOf on cleanup", () => {
    expect(CleanupBodySchema.safeParse({ threshold: 0.9 }).success).toBe(false);
  });
});

describe("Policy bodies", () => {
  it("lowercases sender entries", () => {
    expect(PatchSenderBodySchema.parse({ entry: " News@Example.COM ", list: "deny" })).toEqual({
      entry: "news@example.com",
      list: "deny",
    });
  });
  it("requires expectedVersion >= 1", () => {
    expect(PutPolicyBodySchema.safeParse({ policy: DEFAULT_POLICY, expectedVersion: 0 }).success).toBe(false);
    expect(PutPolicyBodySchema.safeParse({ policy: DEFAULT_POLICY, expectedVersion: 1 }).success).toBe(true);
  });
});

describe("OAUTH_CALLBACK_ERRORS", () => {
  it("lists the contracts 7.13 codes", () => {
    expect([...OAUTH_CALLBACK_ERRORS]).toEqual([
      "access_denied",
      "admin_consent_required",
      "state_invalid",
      "token_exchange_failed",
      "provider_config_error",
      "scope_missing",
      "no_refresh_token",
      "profile_failed",
      "provider_not_configured",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/api-schemas.test.ts`
Expected: FAIL with `Failed to load url ../../../src/shared/api.ts` (module does not exist).

- [ ] **Step 3: Create `app/src/shared/api.ts`**

The body is contracts 7.2, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10 and 7.11 concatenated verbatim in that order, with the five contracts 12.1 fields inserted (each marked `rev 2.1 Ax`), followed by the OAuth callback error list:

```ts
import { z } from "zod";
import { PolicySchema, SenderEntrySchema } from "@clearbox/core";
import type { ActionKind, Ceiling, MailCategory, OwnerPosition, AuthVerdict, ProviderKind, Policy,
  ReasonCode, SuggestedAction, CalibrationPoint } from "@clearbox/core";

export const CSRF_HEADER = "X-Clearbox-CSRF";
export const CSRF_VALUE = "1";

export type ApiErrorCode =
  | "validation_failed"      // 400
  | "unauthenticated"        // 401
  | "forbidden"              // 403
  | "csrf_required"          // 403
  | "not_found"              // 404
  | "conflict"               // 409 (stale expectedVersion)
  | "account_busy"           // 409 (lease held by another tick)
  | "account_inactive"       // 409 (status not active, or paused, for scan-now)
  | "undo_expired"           // 410
  | "payload_too_large"      // 413
  | "provider_not_configured"// 422
  | "budget_exhausted"       // 429 (D1 daily budget)
  | "rate_limited"           // 429 (provider throttled the whole request)
  | "internal"               // 500
  | "access_misconfigured"   // 500
  | "provider_error";        // 502

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;          // English, safe to show, no addresses or subjects
    details?: unknown;        // validation_failed: zod issues as { path: string, message: string }[]
    retryAt?: string;         // ISO, for 409 account_busy, 429
  };
}

/** Cursor pagination. `cursor` is opaque (server-encoded base64url JSON). */
export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface ApiReason { code: ReasonCode; text: string }

export type AppIssueCode =
  | "decision_not_configured" | "decision_auth_failed" | "decision_deployment_not_found"
  | "google_client_invalid" | "microsoft_client_invalid"
  | "storage_near_limit" | "budget_exhausted_today";
export interface AppIssue { code: AppIssueCode; since: string; accountId: string | null }

export type AccountStatus = "active" | "needs_reauth" | "config_error";
export type AccountPhase = "sent_backfill" | "inbox_backfill" | "incremental";
export type SuggestionStatus = "awaiting_model" | "pending" | "approved" | "executed" | "failed" | "dismissed" | "undone";
export type Distribution = Record<SuggestedAction, number>;
export const IsoDateSchema = z.iso.datetime({ offset: true });
export const SuggestionIdsSchema = z.array(z.int().positive()).min(1).max(100)
  .refine((ids) => new Set(ids).size === ids.length, "ids must be unique");
export interface MeResponse {
  email: string;                         // owner email
  environment: "development" | "test" | "production";
  freeTier: boolean;
  providers: { gmail: boolean; outlook: boolean };   // client id and secret configured
  issues: AppIssue[];
  tauDelete: number;
  serverTime: string;
}
export interface AccountSync {
  phase: AccountPhase;
  backfillDone: boolean;
  messagesIngested: number;
  pendingCount: number;
  awaitingModelCount: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  backoffUntil: string | null;
  lastErrorCode: string | null;
  pageSize: number;
  /** rev 2.1 A4: provider inbox total (accounts.inbox_estimate); null when unknown. */
  inboxEstimate: number | null;
}

export interface AccountView {
  id: string;
  provider: ProviderKind;
  email: string;
  status: AccountStatus;
  statusReason: string | null;           // e.g. "invalid_grant", "AADSTS7000222"
  paused: boolean;
  archiveSupported: boolean;             // Gmail always true; Graph: archive_folder_id not null
  sync: AccountSync;
  createdAt: string;
}

export interface AccountsResponse { accounts: AccountView[] }   // excludes status 'disconnected'

export const PatchAccountBodySchema = z.strictObject({ paused: z.boolean() });
export type PatchAccountBody = z.infer<typeof PatchAccountBodySchema>;

export interface DisconnectResponse {
  accountId: string;
  /** Gmail: result of POST oauth2.googleapis.com/revoke. Outlook: always "not_supported". */
  revocation: "revoked" | "failed" | "not_supported";
  /** Outlook only: where the owner removes consent. */
  consentUrls: { personal: string; work: string } | null;
}

export type TickKind = "sent_backfill" | "inbox_backfill" | "incremental" | "redecide";
export interface TickReport {
  outcome: "processed" | "idle" | "error";
  accountId: string | null;
  kind: TickKind | null;
  phase: AccountPhase | null;
  fetched: number;          // messages or sent items returned by the provider
  skippedKnown: number;     // already in D1
  decided: number;          // Decision-1 successes
  deferred: number;         // awaiting_model after this tick
  unsure: number;           // stored as unsure (model failed permanently or low confidence)
  removed: number;          // suggestions dismissed because the message left the inbox
  subrequests: number;
  rowsWritten: number;
  nextTickAt: string | null;
  errorCode: string | null; // ClearboxError.code on outcome "error"
}
export const SummaryQuerySchema = z.object({ accountId: z.string().optional() });

export interface QueueSummary {
  asOf: string;                            // server time; pass back as asOf to approve/cleanup
  pending: Record<SuggestedAction, number> & { total: number };
  awaitingModel: number;
  groups: number;                          // distinct (account, sender, action) among pending
  /** rev 2.1 A1: distinct pending sender groups per suggested action. */
  groupsByAction: Record<SuggestedAction, number>;
  tauDelete: number;
  cleanup: { threshold: number; count: number; byAction: Record<ActionKind, number> }; // at threshold = tauDelete
}

export const GroupsQuerySchema = PageQuerySchema.extend({
  accountId: z.string().optional(),
  action: z.enum(["delete", "archive", "keep", "unsure"]).optional(),
  sort: z.enum(["confidence_desc", "count_desc", "newest"]).default("confidence_desc"),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
});

/** Opaque key: base64url(JSON.stringify([accountId, sender, action])). */
export type GroupKey = string;

export interface SenderGroup {
  key: GroupKey;
  accountId: string;
  provider: ProviderKind;
  sender: string;                          // "" for unknown senders (one group per account and action)
  senderName: string | null;               // most recent display name
  domain: string;
  action: SuggestedAction;
  count: number;
  confidence: { min: number; avg: number; max: number };
  topReasons: ApiReason[];                 // up to 3, most frequent codes in the group
  ceilingApplied: boolean;                 // any item capped by a guardrail
  newestReceivedAt: string;
  /** rev 2.1 A6: subject of the newest pending item; null when not stored. */
  latestSubject: string | null;
  oldestReceivedAt: string;
}

export interface ItemSignals {
  hasListUnsubscribe: boolean;
  precedenceBulk: boolean;
  autoSubmitted: boolean;
  category: MailCategory | null;
  hasAttachments: boolean;
  starred: boolean;
  ownerReplied: boolean;
  isCorrespondent: boolean;
  ageDays: number;
  ownerPosition: OwnerPosition;
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
}

export interface SuggestionItem {
  id: number;                              // suggestions.message_id
  accountId: string;
  provider: ProviderKind;
  status: SuggestionStatus;
  action: SuggestedAction;
  confidence: number;
  distribution: Distribution | null;
  importance: number | null;               // 0..4
  ceiling: Ceiling;
  ceilingApplied: boolean;
  reasons: ApiReason[];
  from: { address: string; name: string | null };
  subject: string | null;
  snippet: string | null;                  // null when snippets are not stored
  receivedAt: string;
  isRead: boolean;
  signals: ItemSignals;
  /** Gmail: https://mail.google.com/mail/u/?authuser=<email>#all/<id>; Outlook: webLink. */
  deepLink: string | null;
  modelVersion: string | null;
  policyVersion: number;
}

export interface GroupDetail {
  asOf: string;
  group: SenderGroup;
  items: Page<SuggestionItem>;             // sorted by confidence desc, then receivedAt desc
}
export const ApproveBodySchema = z.union([
  z.strictObject({ ids: SuggestionIdsSchema }),
  z.strictObject({ groupKey: z.string().min(1).max(1024), asOf: IsoDateSchema }),
]);
export type ApproveBody = z.infer<typeof ApproveBodySchema>;

export const OverrideBodySchema = z.strictObject({
  ids: SuggestionIdsSchema,
  action: z.enum(["delete", "archive", "keep"]),
});
export type OverrideBody = z.infer<typeof OverrideBodySchema>;

export const CleanupPreviewQuerySchema = z.object({
  threshold: z.coerce.number().min(0.5).max(1).optional(),         // default: current tauDelete
  actions: z.string().regex(/^(delete|archive|keep)(,(delete|archive|keep))*$/).optional(), // CSV, default all three
  accountId: z.string().optional(),
});

export const CleanupBodySchema = z.strictObject({
  threshold: z.number().min(0.5).max(1).optional(),
  actions: z.array(z.enum(["delete", "archive", "keep"])).min(1).max(3).optional(),
  accountId: z.string().optional(),
  asOf: IsoDateSchema,
});
export type CleanupBody = z.infer<typeof CleanupBodySchema>;

export interface CleanupPreview {
  asOf: string;
  threshold: number;
  defaultThreshold: number;                // current tauDelete
  count: number;
  byAction: Record<ActionKind, number>;
  groups: number;
  /** rev 2.1 A2: pending sender groups in scope that keep at least one pending item after this Clean up. */
  groupsLeft: number;
}

export type ItemOutcome = "executed" | "failed" | "skipped" | "retry_later";
export type ItemErrorCode =
  | "not_pending" | "unsure_not_approvable" | "account_inactive" | "not_found"
  | "archive_unavailable" | "rate_limited" | "unavailable" | "bad_request" | "budget" | "unknown";

export interface ItemResult {
  id: number;
  outcome: ItemOutcome;
  action: ActionKind | null;               // what was (or would have been) executed
  error: ItemErrorCode | null;
}

export interface ActionResponse {
  batchId: number | null;                  // null when nothing executed
  results: ItemResult[];                   // one per targeted suggestion, in request order (ids) or confidence order
  executed: number;
  failed: number;
  skipped: number;
  retryLater: number;
  /** Items still matching the request after this call (0 for ids/override). The UI loops while > 0. */
  remaining: number;
}
export interface ActionBatchView {
  id: number;
  kind: "approve" | "override" | "cleanup";
  createdAt: string;
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  byAction: Record<ActionKind, number>;    // executed items per final_action
  undoable: boolean;                       // now < undoExpiresAt and undoneAt is null and executedCount > 0
  undoExpiresAt: string;
  undoneAt: string | null;
}

export interface UndoItemResult { id: number; outcome: "restored" | "failed" | "skipped"; error: ItemErrorCode | null }
export interface UndoResponse {
  batchId: number;
  results: UndoItemResult[];
  restored: number;
  failed: number;
  skipped: number;
}
export const ActivityQuerySchema = PageQuerySchema.extend({ accountId: z.string().optional() });

export type ActivityKind =
  | "account_connected" | "account_reconnected" | "account_disconnected" | "account_purged"
  | "account_paused" | "account_resumed" | "reauth_required" | "config_error"
  | "approve" | "override" | "cleanup" | "undo" | "policy_updated" | "calibration" | "purge";

export interface ActivityEntry {
  id: number;
  ts: string;
  kind: ActivityKind;
  accountId: string | null;
  batchId: number | null;
  count: number;
  result: Record<string, number | string>;  // counts and codes only
}
export interface Insights {
  precision: {
    deletePrecision: number | null;        // among the newest 500 labels with suggested_action = 'delete': share with owner_action = 'delete'
    deleteSuggestionsDecided: number;
    window: number;                        // 500
  };
  labels: { total: number; last7Days: number };
  calibration: {
    tauDelete: number;
    outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target" | null;
    ranAt: string | null;
    points: CalibrationPoint[];
  };
  budget: {
    date: string;                          // UTC date
    rowsWritten: number;
    rowsCap: number;                       // BUDGET_ROWS_PER_DAY
    ingestStopRows: number;                // INGEST_STOP_ROWS
    d1DailyWriteLimit: number;             // D1_DAILY_WRITE_LIMIT
    ticks: number;
    messagesIngested: number;
    decisionCalls: number;
    decisionFailures: number;
    decisionInputTokens: number;
    estimatedDecisionCostUsd: number;      // decisionInputTokens * 0.042 / 1e6
    dbSizeBytes: number;
    dbSizeLimitBytes: number;              // 500_000_000
  };
  history: { date: string; rowsWritten: number; messagesIngested: number; decisionCalls: number }[]; // last 14 days
  accounts: (Pick<AccountView, "id" | "provider" | "email" | "status" | "paused"> & { sync: AccountSync })[];
  /** rev 2.1 A3: last 6 ISO weeks (Monday start, UTC), oldest first, zero-filled. */
  weekly: { weekStart: string; cleaned: number; undone: number }[];
}
export interface PolicyResponse { policy: Policy; version: number; defaults: Policy }

export const PutPolicyBodySchema = z.strictObject({ policy: PolicySchema, expectedVersion: z.int().min(1) });
export const PatchSenderBodySchema = z.strictObject({
  entry: SenderEntrySchema,                // "user@example.com" or "@example.com"
  list: z.enum(["allow", "deny", "none"]), // "none" removes it from both lists
});

/** Error codes of the OAuth callback redirect `?error=<code>&provider=<kind>` (contracts 7.13). */
export const OAUTH_CALLBACK_ERRORS = [
  "access_denied",
  "admin_consent_required",
  "state_invalid",
  "token_exchange_failed",
  "provider_config_error",
  "scope_missing",
  "no_refresh_token",
  "profile_failed",
  "provider_not_configured",
] as const;
export type OAuthCallbackErrorCode = (typeof OAUTH_CALLBACK_ERRORS)[number];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/api-schemas.test.ts`
Expected: PASS, `10 passed`.

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/api.ts app/test/worker/routes/api-schemas.test.ts
git commit -m "feat(app): add shared REST contract schemas and types"
```

---

### Task 3: Configuration, logging and base64 codecs

**Files:**
- Create: `app/src/worker/crypto/base64.ts`
- Create: `app/src/worker/env.ts` (extended in Task 5)
- Create: `app/src/worker/log.ts`
- Test: `app/test/worker/crypto/base64.test.ts`, `app/test/worker/access/config.test.ts`, `app/test/worker/routes/log.test.ts`

**Interfaces:**
- Consumes: global `Env` (Task 1), `zod`.
- Produces:
  - `base64.ts`: `bytesToBase64(bytes: Uint8Array): string`, `base64ToBytes(b64: string): Uint8Array<ArrayBuffer>` (throws `Error` on malformed input), `bytesToBase64Url(bytes: Uint8Array): string` (no padding), `base64UrlToBytes(s: string): Uint8Array<ArrayBuffer>`, `utf8(s: string): Uint8Array<ArrayBuffer>`, `fromUtf8(bytes: Uint8Array): string`, `bytesFromBlob(value: unknown): Uint8Array<ArrayBuffer> | null`.
  - `env.ts`: `CRON_TICK = "* * * * *"`, `CRON_NIGHTLY = "0 2 * * *"`, `type Environment = "development" | "test" | "production"`, `interface OAuthClientSecrets { clientId: string; clientSecret: string }`, `interface DecisionSecrets { endpoint: string; apiKey: string; deployment: string }`, `interface AppConfig { environment; devAuthBypass: boolean; freeTier: boolean; ownerEmail: string; accessTeamDomain: string; accessAud: string; tokenEncKey: Uint8Array<ArrayBuffer>; stateSigningKey: Uint8Array<ArrayBuffer>; google: OAuthClientSecrets | null; microsoft: OAuthClientSecrets | null; decision: DecisionSecrets | null }`, `type ConfigResult = { ok: true; config: AppConfig } | { ok: false; invalid: string[] }`, `readConfig(env: Env): ConfigResult` (cached per env object).
  - `log.ts`: `type LogEventName` (contracts 9), `interface LogBase`, `type LogFields = Readonly<Record<string, string | number | boolean | null>>`, `logEvent(name: LogEventName, fields: LogFields): void`, `newRequestId(): string`, `newAccountId(): string` (`acc_` + 16 lowercase hex).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/crypto/base64.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesFromBlob,
  bytesToBase64,
  bytesToBase64Url,
  fromUtf8,
  utf8,
} from "../../../src/worker/crypto/base64.ts";

describe("base64", () => {
  it("round trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
  it("decodes the contracts test key to 32 bytes", () => {
    const key = base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    expect(key.length).toBe(32);
    expect(key[31]).toBe(31);
  });
  it("rejects malformed base64", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
    expect(() => base64ToBytes("abc")).toThrow();
  });
});

describe("base64url", () => {
  it("uses the url alphabet without padding", () => {
    const encoded = bytesToBase64Url(new Uint8Array([251, 255, 191]));
    expect(encoded).toBe("-_-_");
    expect(base64UrlToBytes(encoded)).toEqual(new Uint8Array([251, 255, 191]));
  });
  it("round trips lengths that need padding", () => {
    for (const n of [1, 2, 3, 4, 5, 16, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });
  it("rejects characters outside the url alphabet", () => {
    expect(() => base64UrlToBytes("ab+c")).toThrow();
    expect(() => base64UrlToBytes("ab=c")).toThrow();
  });
});

describe("utf8 and bytesFromBlob", () => {
  it("round trips text", () => {
    expect(fromUtf8(utf8("héllo"))).toBe("héllo");
  });
  it("normalizes D1 blob shapes", () => {
    expect(bytesFromBlob(null)).toBeNull();
    expect(bytesFromBlob([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytesFromBlob(new Uint8Array([4, 5]).buffer)).toEqual(new Uint8Array([4, 5]));
    expect(bytesFromBlob(new Uint8Array([6]))).toEqual(new Uint8Array([6]));
    expect(() => bytesFromBlob("text")).toThrow();
  });
});
```

`app/test/worker/access/config.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CRON_NIGHTLY, CRON_TICK, readConfig } from "../../../src/worker/env.ts";

function withEnv(patch: Record<string, string | undefined>): Env {
  return { ...env, ...patch } as Env;
}

describe("readConfig", () => {
  it("accepts the test environment", () => {
    const result = readConfig(env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environment).toBe("test");
    expect(result.config.ownerEmail).toBe("owner@example.test");
    expect(result.config.accessTeamDomain).toBe("https://test-team.cloudflareaccess.com");
    expect(result.config.tokenEncKey.length).toBe(32);
    expect(result.config.google).toEqual({ clientId: "test-google-client", clientSecret: "test-google-secret" });
    expect(result.config.decision?.deployment).toBe("decision-1");
    expect(result.config.freeTier).toBe(true);
  });

  it("caches the result per env object", () => {
    expect(readConfig(env)).toBe(readConfig(env));
  });

  it("fails closed on missing or malformed Access and key secrets", () => {
    const result = readConfig(
      withEnv({ ACCESS_AUD: "", OWNER_EMAIL: "not-an-email", TOKEN_ENC_KEY: "AAAA", STATE_SIGNING_KEY: undefined }),
    );
    expect(result).toEqual({
      ok: false,
      invalid: ["OWNER_EMAIL", "ACCESS_AUD", "TOKEN_ENC_KEY", "STATE_SIGNING_KEY"],
    });
  });

  it("rejects a non-https team domain", () => {
    const result = readConfig(withEnv({ ACCESS_TEAM_DOMAIN: "http://test-team.cloudflareaccess.com" }));
    expect(result).toEqual({ ok: false, invalid: ["ACCESS_TEAM_DOMAIN"] });
  });

  it("rejects the dev bypass flag outside development", () => {
    const result = readConfig(withEnv({ DEV_AUTH_BYPASS: "true" }));
    expect(result).toEqual({ ok: false, invalid: ["DEV_AUTH_BYPASS"] });
  });

  it("allows the dev bypass flag in development", () => {
    const result = readConfig(withEnv({ ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" }));
    expect(result.ok && result.config.devAuthBypass).toBe(true);
  });

  it("normalizes owner email and team domain", () => {
    const result = readConfig(
      withEnv({ OWNER_EMAIL: " Owner@Example.TEST ", ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com/" }),
    );
    expect(result.ok && result.config.ownerEmail).toBe("owner@example.test");
    expect(result.ok && result.config.accessTeamDomain).toBe("https://test-team.cloudflareaccess.com");
  });

  it("treats empty provider and decision secrets as disabled, not invalid", () => {
    const result = readConfig(withEnv({ GOOGLE_CLIENT_SECRET: "", MS_CLIENT_ID: "", AZURE_DECISION_KEY: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.google).toBeNull();
    expect(result.config.microsoft).toBeNull();
    expect(result.config.decision).toBeNull();
  });

  it("exposes the cron expressions", () => {
    expect(CRON_TICK).toBe("* * * * *");
    expect(CRON_NIGHTLY).toBe("0 2 * * *");
  });
});
```

`app/test/worker/routes/log.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, newAccountId, newRequestId } from "../../../src/worker/log.ts";

afterEach(() => vi.restoreAllMocks());

describe("logEvent", () => {
  it("writes one JSON line with app, ts and evt", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("tick.idle", { tickId: "t-1", trigger: "cron" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ app: "clearbox", evt: "tick.idle", tickId: "t-1", trigger: "cron" });
    expect(typeof line["ts"]).toBe("string");
  });

  it("does not let fields override the base keys", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("issue.raised", { evt: "spoofed", app: "other", code: "storage_near_limit", accountId: null });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line["evt"]).toBe("issue.raised");
    expect(line["app"]).toBe("clearbox");
  });
});

describe("id helpers", () => {
  it("creates account ids that satisfy the accounts CHECK", () => {
    const id = newAccountId();
    expect(id).toMatch(/^acc_[0-9a-f]{16}$/);
    expect(newAccountId()).not.toBe(id);
  });
  it("creates uuid request ids", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/crypto/base64.test.ts test/worker/access/config.test.ts test/worker/routes/log.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/crypto/base64.ts` (and the same for `env.ts`, `log.ts`).

- [ ] **Step 3: Implement `app/src/worker/crypto/base64.ts`**

```ts
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_RE.test(b64)) throw new Error("invalid base64");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_RE.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** D1 returns BLOB columns as ArrayBuffer or number[] depending on the API; normalize to bytes. */
export function bytesFromBlob(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value === null || value === undefined) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) return Uint8Array.from(value as number[]);
  throw new Error("unexpected blob value");
}
```

- [ ] **Step 4: Implement `app/src/worker/env.ts`**

```ts
import { z } from "zod";
import { base64ToBytes } from "./crypto/base64.ts";

export const CRON_TICK = "* * * * *";
export const CRON_NIGHTLY = "0 2 * * *";

export type Environment = "development" | "test" | "production";

export interface OAuthClientSecrets {
  clientId: string;
  clientSecret: string;
}

export interface DecisionSecrets {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

export interface AppConfig {
  environment: Environment;
  devAuthBypass: boolean;
  freeTier: boolean;
  ownerEmail: string;
  /** Full origin without trailing slash; equals the Access JWT `iss`. */
  accessTeamDomain: string;
  accessAud: string;
  tokenEncKey: Uint8Array<ArrayBuffer>;
  stateSigningKey: Uint8Array<ArrayBuffer>;
  google: OAuthClientSecrets | null;
  microsoft: OAuthClientSecrets | null;
  decision: DecisionSecrets | null;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; invalid: string[] };

const EnvironmentSchema = z.enum(["development", "test", "production"]);
const FlagSchema = z.enum(["true", "false"]).transform((v) => v === "true");
const OwnerEmailSchema = z.string().trim().toLowerCase().pipe(z.email());
const TeamDomainSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/[A-Za-z0-9.-]+\/?$/)
  .transform((v) => v.replace(/\/$/, ""));
const NonEmptySchema = z.string().trim().min(1);
const Key32Schema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      const bytes = base64ToBytes(v);
      if (bytes.length === 32) return bytes;
    } catch {
      // fall through to the issue below
    }
    ctx.addIssue({ code: "custom", message: "expected base64 of exactly 32 bytes" });
    return z.NEVER;
  });
const OptionalSchema = z.string().trim().optional();

const cache = new WeakMap<object, ConfigResult>();

/** Validates every secret and var once per env object (one per isolate in production). Fails closed. */
export function readConfig(env: Env): ConfigResult {
  const hit = cache.get(env);
  if (hit) return hit;
  const result = validate(env as unknown as Record<string, unknown>);
  cache.set(env, result);
  return result;
}

function validate(env: Record<string, unknown>): ConfigResult {
  const invalid: string[] = [];
  function pick<T>(name: string, schema: z.ZodType<T>): T | undefined {
    const parsed = schema.safeParse(env[name]);
    if (!parsed.success) {
      invalid.push(name);
      return undefined;
    }
    return parsed.data;
  }
  function optional(name: string): string {
    const parsed = OptionalSchema.safeParse(env[name]);
    return parsed.success ? (parsed.data ?? "") : "";
  }

  const environment = pick("ENVIRONMENT", EnvironmentSchema);
  const devAuthBypass = pick("DEV_AUTH_BYPASS", FlagSchema);
  const freeTier = pick("FREE_TIER", FlagSchema);
  const ownerEmail = pick("OWNER_EMAIL", OwnerEmailSchema);
  const accessTeamDomain = pick("ACCESS_TEAM_DOMAIN", TeamDomainSchema);
  const accessAud = pick("ACCESS_AUD", NonEmptySchema);
  const tokenEncKey = pick("TOKEN_ENC_KEY", Key32Schema);
  const stateSigningKey = pick("STATE_SIGNING_KEY", Key32Schema);
  if (devAuthBypass === true && environment !== "development") invalid.push("DEV_AUTH_BYPASS");

  if (
    invalid.length > 0 ||
    environment === undefined ||
    devAuthBypass === undefined ||
    freeTier === undefined ||
    ownerEmail === undefined ||
    accessTeamDomain === undefined ||
    accessAud === undefined ||
    tokenEncKey === undefined ||
    stateSigningKey === undefined
  ) {
    return { ok: false, invalid };
  }

  const googleId = optional("GOOGLE_CLIENT_ID");
  const googleSecret = optional("GOOGLE_CLIENT_SECRET");
  const msId = optional("MS_CLIENT_ID");
  const msSecret = optional("MS_CLIENT_SECRET");
  const endpoint = optional("AZURE_DECISION_ENDPOINT").replace(/\/$/, "");
  const apiKey = optional("AZURE_DECISION_KEY");
  const deployment = optional("AZURE_DECISION_DEPLOYMENT");

  return {
    ok: true,
    config: {
      environment,
      devAuthBypass,
      freeTier,
      ownerEmail,
      accessTeamDomain,
      accessAud,
      tokenEncKey,
      stateSigningKey,
      google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
      microsoft: msId && msSecret ? { clientId: msId, clientSecret: msSecret } : null,
      decision: endpoint && apiKey && deployment ? { endpoint, apiKey, deployment } : null,
    },
  };
}
```

- [ ] **Step 5: Implement `app/src/worker/log.ts`**

```ts
export type LogEventName =
  | "tick.idle" | "tick.claimed" | "tick.done" | "tick.failed"
  | "decision.error" | "provider.error" | "account.status"
  | "oauth.connect" | "action.executed" | "undo.done"
  | "nightly.done" | "access.denied" | "config.invalid" | "budget.gate"
  | "issue.raised" | "issue.cleared" | "request.error";

export interface LogBase {
  app: "clearbox";
  ts: string;
  evt: LogEventName;
}

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** The only console.log call site in the Worker. Fields must be ids, counts, codes or statuses (contracts 9). */
export function logEvent(name: LogEventName, fields: LogFields): void {
  const base: LogBase = { app: "clearbox", ts: new Date().toISOString(), evt: name };
  console.log(JSON.stringify({ ...fields, ...base }));
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "acc_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/crypto/base64.test.ts test/worker/access/config.test.ts test/worker/routes/log.test.ts`
Expected: PASS, `21 passed` (8 base64, 9 config, 4 log).

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/crypto/base64.ts app/src/worker/env.ts app/src/worker/log.ts app/test/worker/crypto/base64.test.ts app/test/worker/access/config.test.ts app/test/worker/routes/log.test.ts
git commit -m "feat(worker): add config validation, structured logging and base64 codecs"
```

---

### Task 4: Token encryption, HMAC signing and PKCE

**Files:**
- Create: `app/src/worker/crypto/aead.ts`
- Create: `app/src/worker/crypto/hmac.ts`
- Create: `app/src/worker/crypto/pkce.ts`
- Test: `app/test/worker/crypto/aead.test.ts`, `app/test/worker/crypto/hmac.test.ts`, `app/test/worker/crypto/pkce.test.ts`

**Interfaces:**
- Consumes: `utf8`, `fromUtf8`, `bytesToBase64Url`, `base64UrlToBytes`, `base64ToBytes` (Task 3); `ClearboxError` from `@clearbox/core` (`new ClearboxError(code, message?, { cause? })`).
- Produces:
  - `aead.ts`: `CURRENT_KEY_VERSION = 1`, `type TokenKind = "refresh" | "access"`, `interface TokenContext { accountId: string; kind: TokenKind; keyVersion: number }`, `interface EncryptedValue { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }`, `tokenAad(ctx): Uint8Array<ArrayBuffer>`, `importEncKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey>`, `encryptToken(key, plaintext: string, ctx): Promise<EncryptedValue>`, `decryptToken(key, value: EncryptedValue, ctx): Promise<string>` (throws `ClearboxError` code `token_decrypt_failed`).
  - `hmac.ts`: `importSigningKey(raw): Promise<CryptoKey>`, `signValue(key, value: string): Promise<string>` (base64url), `verifyValue(key, value: string, signature: string): Promise<boolean>`.
  - `pkce.ts`: `randomBase64Url(byteLength: number): string`, `createVerifier(): string` (43 chars), `challengeS256(verifier: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/crypto/aead.test.ts`:

```ts
import { ClearboxError } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import {
  CURRENT_KEY_VERSION,
  decryptToken,
  encryptToken,
  importEncKey,
  tokenAad,
} from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes, fromUtf8 } from "../../../src/worker/crypto/base64.ts";

const RAW_KEY = base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
const CTX = { accountId: "acc_0123456789abcdef", kind: "refresh" as const, keyVersion: CURRENT_KEY_VERSION };

describe("token encryption", () => {
  it("builds the contracts 7.15 AAD", () => {
    expect(fromUtf8(tokenAad(CTX))).toBe("clearbox|acc_0123456789abcdef|refresh|v1");
  });

  it("round trips and uses a fresh 12-byte IV per value", async () => {
    const key = await importEncKey(RAW_KEY);
    const a = await encryptToken(key, "refresh-token-value", CTX);
    const b = await encryptToken(key, "refresh-token-value", CTX);
    expect(a.iv.length).toBe(12);
    expect(a.ciphertext.length).toBe("refresh-token-value".length + 16);
    expect(a.iv).not.toEqual(b.iv);
    expect(await decryptToken(key, a, CTX)).toBe("refresh-token-value");
  });

  it("rejects a different account, kind or key version (AAD mismatch)", async () => {
    const key = await importEncKey(RAW_KEY);
    const value = await encryptToken(key, "secret", CTX);
    for (const ctx of [
      { ...CTX, accountId: "acc_ffffffffffffffff" },
      { ...CTX, kind: "access" as const },
      { ...CTX, keyVersion: 2 },
    ]) {
      await expect(decryptToken(key, value, ctx)).rejects.toMatchObject({ code: "token_decrypt_failed" });
    }
  });

  it("detects tampered ciphertext and IV", async () => {
    const key = await importEncKey(RAW_KEY);
    const value = await encryptToken(key, "secret", CTX);
    const ciphertext = Uint8Array.from(value.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await expect(decryptToken(key, { ...value, ciphertext }, CTX)).rejects.toBeInstanceOf(ClearboxError);
    const iv = Uint8Array.from(value.iv);
    iv[0] = (iv[0] ?? 0) ^ 1;
    await expect(decryptToken(key, { ...value, iv }, CTX)).rejects.toBeInstanceOf(ClearboxError);
  });

  it("rejects a wrong key", async () => {
    const value = await encryptToken(await importEncKey(RAW_KEY), "secret", CTX);
    const other = await importEncKey(base64ToBytes("HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA="));
    await expect(decryptToken(other, value, CTX)).rejects.toMatchObject({ code: "token_decrypt_failed" });
  });

  it("refuses keys that are not 32 bytes", async () => {
    await expect(importEncKey(new Uint8Array(16))).rejects.toMatchObject({ code: "token_key_invalid" });
  });
});
```

`app/test/worker/crypto/hmac.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { importSigningKey, signValue, verifyValue } from "../../../src/worker/crypto/hmac.ts";

const RAW = base64ToBytes("HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=");

describe("HMAC signing", () => {
  it("verifies its own signature", async () => {
    const key = await importSigningKey(RAW);
    const sig = await signValue(key, "payload");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyValue(key, "payload", sig)).toBe(true);
  });

  it("rejects altered values, altered or malformed signatures and other keys", async () => {
    const key = await importSigningKey(RAW);
    const sig = await signValue(key, "payload");
    expect(await verifyValue(key, "payload2", sig)).toBe(false);
    // Flip the first character: it carries 6 signature bits (the last one partly carries padding bits).
    expect(await verifyValue(key, "payload", (sig.startsWith("A") ? "B" : "A") + sig.slice(1))).toBe(false);
    expect(await verifyValue(key, "payload", "not+base64url")).toBe(false);
    const other = await importSigningKey(base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="));
    expect(await verifyValue(other, "payload", sig)).toBe(false);
  });

  it("refuses keys that are not 32 bytes", async () => {
    await expect(importSigningKey(new Uint8Array(8))).rejects.toMatchObject({ code: "signing_key_invalid" });
  });
});
```

`app/test/worker/crypto/pkce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { challengeS256, createVerifier, randomBase64Url } from "../../../src/worker/crypto/pkce.ts";

describe("PKCE", () => {
  it("creates 43-char verifiers from the unreserved alphabet", () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
  });

  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("encodes 16 random bytes as 22 chars", () => {
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/crypto`
Expected: FAIL with `Failed to load url ../../../src/worker/crypto/aead.ts` (and `hmac.ts`, `pkce.ts`); `base64.test.ts` still passes.

- [ ] **Step 3: Implement `app/src/worker/crypto/aead.ts`**

```ts
import { ClearboxError } from "@clearbox/core";
import { fromUtf8, utf8 } from "./base64.ts";

/** Version written into the AAD of newly encrypted values (accounts.key_version). */
export const CURRENT_KEY_VERSION = 1;

export type TokenKind = "refresh" | "access";

export interface TokenContext {
  accountId: string;
  kind: TokenKind;
  keyVersion: number;
}

export interface EncryptedValue {
  /** AES-GCM output including the 16-byte tag. */
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

export function tokenAad(ctx: TokenContext): Uint8Array<ArrayBuffer> {
  return utf8(`clearbox|${ctx.accountId}|${ctx.kind}|v${ctx.keyVersion}`);
}

export async function importEncKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ClearboxError("token_key_invalid", "TOKEN_ENC_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(key: CryptoKey, plaintext: string, ctx: TokenContext): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAad(ctx) },
    key,
    utf8(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptToken(key: CryptoKey, value: EncryptedValue, ctx: TokenContext): Promise<string> {
  try {
    if (value.iv.length !== 12) throw new Error("bad iv length");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: value.iv, additionalData: tokenAad(ctx) },
      key,
      value.ciphertext,
    );
    return fromUtf8(new Uint8Array(plaintext));
  } catch (cause) {
    throw new ClearboxError("token_decrypt_failed", "Token decryption failed", { cause });
  }
}
```

- [ ] **Step 4: Implement `app/src/worker/crypto/hmac.ts`**

```ts
import { ClearboxError } from "@clearbox/core";
import { base64UrlToBytes, bytesToBase64Url, utf8 } from "./base64.ts";

export async function importSigningKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ClearboxError("signing_key_invalid", "STATE_SIGNING_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signValue(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, utf8(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Constant-time verification through crypto.subtle.verify. */
export async function verifyValue(key: CryptoKey, value: string, signature: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sig, utf8(value));
}
```

- [ ] **Step 5: Implement `app/src/worker/crypto/pkce.ts`**

```ts
import { bytesToBase64Url, utf8 } from "./base64.ts";

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** 32 random bytes, base64url: 43 chars of [A-Za-z0-9_-] (RFC 7636 section 4.1). */
export function createVerifier(): string {
  return randomBase64Url(32);
}

export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/crypto`
Expected: PASS, `20 passed` (8 from `base64.test.ts`, 6 aead, 3 hmac, 3 pkce).

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/crypto app/test/worker/crypto
git commit -m "feat(worker): add AES-GCM token encryption, HMAC signing and PKCE"
```

---

### Task 5: Hono app, security middleware, error envelope and Worker entry

**Files:**
- Create: `app/src/worker/middleware/errors.ts`
- Create: `app/src/worker/middleware/headers.ts`
- Create: `app/src/worker/middleware/access.ts`
- Create: `app/src/worker/middleware/csrf.ts`
- Create: `app/src/worker/scan/providers.ts`
- Create: `app/src/worker/app.ts`
- Create: `app/src/worker/scan/tick.ts` (TEMPORARY stub, plan 04 replaces)
- Create: `app/src/worker/nightly/nightly.ts` (TEMPORARY stub, plan 04 replaces)
- Modify: `app/src/worker/env.ts` (append `AppDeps`, `AppVariables`, `AppEnv`)
- Modify: `app/src/worker/index.ts` (replace the Task 1 placeholder)
- Create: `app/test/worker/helpers/access.ts`, `app/test/worker/helpers/request.ts`
- Modify: `app/test/worker/setup/network.ts` (add the JWKS handler)
- Test: `app/test/worker/access/access.test.ts`, `app/test/worker/csrf/csrf.test.ts`, `app/test/worker/routes/envelope.test.ts`, `app/test/worker/routes/entry.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `AppConfig` (Task 3), `logEvent`, `newRequestId` (Task 3), `CSRF_HEADER`, `CSRF_VALUE`, `ApiErrorBody`, `ApiErrorCode`, `TickReport` (Task 2); from `@clearbox/core`: `FetchLike`, `MailProvider`, `ProviderDeps`, `ProviderKind`, `OAuthClientConfig`, `OAuthTokens`, `AuthorizeParams`, `DecisionEngine`, `createGmailProvider`, `createGraphProvider`, `buildGoogleAuthorizeUrl`, `exchangeGoogleCode`, `refreshGoogleToken`, `revokeGoogleToken`, `hasGmailScope`, `buildMicrosoftAuthorizeUrl`, `exchangeMicrosoftCode`, `refreshMicrosoftToken`, `hasGraphScopes`.
- Produces:
  - `errors.ts`: `class ApiError extends Error { status: ContentfulStatusCode; code: ApiErrorCode; details: unknown; retryAt: string | null }` with `new ApiError(status, code, message, options?: ApiErrorOptions)`, `interface ApiErrorOptions { details?: unknown; retryAt?: string }`, `errorBody(code, message, options?): ApiErrorBody`, `interface ValidationIssue { path: string; message: string }`, `zodIssues(err: ZodError): ValidationIssue[]`, `parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S>` (throws `400 validation_failed`), `readJsonBody(c): Promise<unknown>`, `apiErrorResponse(c, err)`, `onApiError(err, c)` (logs `request.error` with `requestId`, `route`, `errorName` before answering `500 internal`), `notFoundHandler(c)`.
  - `headers.ts`: `workerSecureHeaders`, `apiResponseHeaders` (`Cache-Control: no-store`, `Content-Type: application/json; charset=utf-8`), `API_BODY_LIMIT_BYTES = 65536`, `apiBodyLimit`, `requestContext(deps: AppDeps)`.
  - `access.ts`: `type AccessVerdict = { ok: true; email: string } | { ok: false; reason: "invalid" | "wrong_email" }`, `verifyAccessJwt(token, config, now): Promise<AccessVerdict>`, `isLocalHostname(hostname): boolean`, `resetJwksCache(): void`, `accessGuard`.
  - `csrf.ts`: `csrfGuard`.
  - `providers.ts`: `interface ProviderTarget { provider: ProviderKind; archiveFolderId: string | null }`, `type ProviderFactory = (target: ProviderTarget, deps: ProviderDeps) => MailProvider`, `makeProvider: ProviderFactory`, `interface ProviderOAuth { buildAuthorizeUrl; exchangeCode; refresh; hasRequiredScopes; revoke: ((f: FetchLike, token: string) => Promise<boolean>) | null }`, `type ProviderOAuthMap = Readonly<Record<ProviderKind, ProviderOAuth>>`, `PROVIDER_OAUTH: ProviderOAuthMap`, `callbackPath(provider): string`, `routeSegment(provider): "google" | "microsoft"`, `oauthClientConfig(config: AppConfig, provider: ProviderKind, redirectUri: string): OAuthClientConfig | null`.
  - `env.ts` additions: `interface AppDeps { fetch: FetchLike; now: () => number; providerFactory: ProviderFactory; oauth: ProviderOAuthMap }`, `interface AppVariables { requestId: string; deps: AppDeps; config: AppConfig; ownerEmail: string }`, `interface AppEnv { Bindings: Env; Variables: AppVariables }`.
  - `app.ts`: `interface AppOverrides { fetch?: FetchLike; now?: () => number; providerFactory?: ProviderFactory; oauth?: ProviderOAuthMap }`, `defaultDeps(overrides?): AppDeps`, `createApp(overrides?: AppOverrides): Hono<AppEnv>`. Later tasks add `app.route(...)` lines inside `createApp` at the marked place.
  - `scan/tick.ts` (stub): `interface TickOptions { trigger: "cron" | "scan_now"; accountId?: string; now: number; engine?: DecisionEngine; fetch?: FetchLike }`, `runTick(env: Env, opts: TickOptions): Promise<TickReport>`.
  - `nightly/nightly.ts` (stub): `runNightly(env: Env, opts: { now: number }): Promise<void>`.
  - Test helpers: `TEST_TEAM_DOMAIN`, `TEST_AUD`, `TEST_OWNER`, `TEST_KID`, `jwksHandler()`, `signAccessJwt(claims?, options?: { key?: "valid" | "other"; omit?: readonly string[] })`, `TEST_ORIGIN = "https://clearbox.example.test"`, `apiFetch(path, init?, opts?: ApiFetchOptions)`, `interface ApiFetchOptions { jwt?: string | null; csrf?: string | null; app?: Hono<AppEnv>; env?: Readonly<Record<string, unknown>>; origin?: string }`, `readJson<T>(res)`, `jsonInit(method, body): RequestInit`.

- [ ] **Step 1: Write the test helpers**

`app/test/worker/helpers/access.ts`:

```ts
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { http, HttpResponse } from "msw";

export const TEST_TEAM_DOMAIN = "https://test-team.cloudflareaccess.com";
export const TEST_AUD = "test-aud-0000000000000000000000000000000000000000000000000000000000";
export const TEST_OWNER = "owner@example.test";
export const TEST_KID = "test-kid";

const validPair = await generateKeyPair("RS256", { extractable: true });
const otherPair = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(validPair.publicKey)), kid: TEST_KID, alg: "RS256", use: "sig" };

/** Serves the Access JWKS (contracts 10.4). */
export function jwksHandler() {
  return http.get(`${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`, () => HttpResponse.json({ keys: [publicJwk] }));
}

export interface SignOptions {
  /** "other" signs with a key that is not in the JWKS but reuses the same kid. */
  key?: "valid" | "other";
  omit?: readonly string[];
}

export async function signAccessJwt(claims: Record<string, unknown> = {}, options: SignOptions = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const full: Record<string, unknown> = {
    iss: TEST_TEAM_DOMAIN,
    aud: [TEST_AUD],
    email: TEST_OWNER,
    sub: "00000000-0000-4000-8000-000000000001",
    type: "app",
    iat: nowSec,
    nbf: nowSec - 5,
    exp: nowSec + 3600,
    ...claims,
  };
  const omit = options.omit ?? [];
  const payload = Object.fromEntries(Object.entries(full).filter(([k]) => !omit.includes(k)));
  const key = options.key === "other" ? otherPair.privateKey : validPair.privateKey;
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: TEST_KID }).sign(key);
}
```

Replace `app/test/worker/setup/network.ts` with:

```ts
import { setupNetwork } from "@msw/cloudflare";
import { http } from "msw";
import { afterAll, afterEach, beforeAll } from "vitest";
import { jwksHandler } from "../helpers/access.ts";

/** Last-resort handler: any unmocked outbound request fails the test. */
const catchAll = http.all("*", ({ request }) => {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
});

export const network = setupNetwork(jwksHandler(), catchAll);

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
```

(Same fallback as Task 1 Step 9 if `setupNetwork` takes no initial handlers: `beforeEach(() => network.use(jwksHandler(), catchAll))`.)

`app/test/worker/helpers/request.ts`:

```ts
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Hono } from "hono";
import { CSRF_HEADER, CSRF_VALUE } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import type { AppEnv } from "../../../src/worker/env.ts";
import { signAccessJwt } from "./access.ts";

export const TEST_ORIGIN = "https://clearbox.example.test";

export interface ApiFetchOptions {
  /** undefined: a valid owner JWT; null: no header; string: that token. */
  jwt?: string | null;
  /** undefined: "1" on mutations; null: no header; string: that value. */
  csrf?: string | null;
  /** Use this app (for injected deps or test-only routes) instead of the deployed entry. */
  app?: Hono<AppEnv>;
  /** Override bindings for this request (forces the createApp path). */
  env?: Readonly<Record<string, unknown>>;
  origin?: string;
}

interface FetchEntry {
  default: { fetch(request: Request): Promise<Response> };
}

export async function apiFetch(path: string, init: RequestInit = {}, opts: ApiFetchOptions = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const jwt = opts.jwt === undefined ? await signAccessJwt() : opts.jwt;
  if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
  const csrf = opts.csrf === undefined ? (method === "GET" || method === "HEAD" ? null : CSRF_VALUE) : opts.csrf;
  if (csrf !== null) headers.set(CSRF_HEADER, csrf);
  if (init.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`${opts.origin ?? TEST_ORIGIN}${path}`, { ...init, method, headers, redirect: "manual" });
  if (opts.app === undefined && opts.env === undefined) {
    return (exports as unknown as FetchEntry).default.fetch(request);
  }
  const app = opts.app ?? createApp();
  const ctx = createExecutionContext();
  const response = await app.fetch(request, { ...env, ...opts.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function jsonInit(method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}
```

- [ ] **Step 2: Write the failing tests**

`app/test/worker/access/access.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { resetJwksCache } from "../../../src/worker/middleware/access.ts";
import { signAccessJwt } from "../helpers/access.ts";
import { apiFetch, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/ping", (c) => c.json({ email: c.get("ownerEmail") }));
  return app;
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await readJson<ApiErrorBody>(res)).error.code).toBe(code);
}

beforeEach(() => resetJwksCache());
afterEach(() => vi.restoreAllMocks());

describe("accessGuard", () => {
  it("accepts a valid owner JWT and exposes the owner email", async () => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "owner@example.test" });
  });

  it("compares the email case-insensitively", async () => {
    const jwt = await signAccessJwt({ email: "OWNER@Example.TEST" });
    expect((await apiFetch("/api/test/ping", {}, { app: testApp(), jwt })).status).toBe(200);
  });

  it("returns 401 when the header is missing", async () => {
    await expectError(await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: null }), 401, "unauthenticated");
  });

  it("ignores the CF_Authorization cookie", async () => {
    const cookie = `CF_Authorization=${await signAccessJwt()}`;
    const res = await apiFetch("/api/test/ping", { headers: { Cookie: cookie } }, { app: testApp(), jwt: null });
    await expectError(res, 401, "unauthenticated");
  });

  it.each([
    ["bad signature", () => signAccessJwt({}, { key: "other" })],
    ["wrong audience", () => signAccessJwt({ aud: ["another-aud"] })],
    ["wrong issuer", () => signAccessJwt({ iss: "https://evil.cloudflareaccess.com" })],
    ["expired", () => signAccessJwt({ iat: 1_000, nbf: 1_000, exp: 2_000 })],
    ["wrong email", () => signAccessJwt({ email: "someone@example.test" })],
    ["service token without email", () => signAccessJwt({ common_name: "svc.access" }, { omit: ["email"] })],
  ])("returns 403 for %s", async (_name, makeJwt) => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: await makeJwt() });
    await expectError(res, 403, "forbidden");
  });

  it.each([
    ["ACCESS_AUD", ""],
    ["ACCESS_TEAM_DOMAIN", ""],
    ["OWNER_EMAIL", ""],
    ["TOKEN_ENC_KEY", "short"],
    ["STATE_SIGNING_KEY", undefined],
  ])("fails closed with 500 when %s is invalid", async (name, value) => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp(), env: { [name]: value } });
    await expectError(res, 500, "access_misconfigured");
  });

  it("fails closed when the bypass flag is set outside development", async () => {
    const res = await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: null, env: { DEV_AUTH_BYPASS: "true" } });
    await expectError(res, 500, "access_misconfigured");
  });

  it("honors the dev bypass only in development on localhost", async () => {
    const devEnv = { ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" };
    const local = await apiFetch(
      "/api/test/ping",
      {},
      { app: testApp(), jwt: null, env: devEnv, origin: "http://localhost:5173" },
    );
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ email: "owner@example.test" });
    const loopback = await apiFetch(
      "/api/test/ping",
      {},
      { app: testApp(), jwt: null, env: devEnv, origin: "http://127.0.0.1:5173" },
    );
    expect(loopback.status).toBe(200);
    const remote = await apiFetch("/api/test/ping", {}, { app: testApp(), jwt: null, env: devEnv });
    await expectError(remote, 401, "unauthenticated");
  });

  it("guards /oauth/* too", async () => {
    await expectError(await apiFetch("/oauth/google/start", {}, { app: testApp(), jwt: null }), 401, "unauthenticated");
  });

  it("logs access.denied with the route pattern, never the URL or identity", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await apiFetch("/api/test/ping?secret=1", {}, { app: testApp(), jwt: await signAccessJwt({ email: "x@example.test" }) });
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const denied = lines.find((l) => l.includes('"evt":"access.denied"'));
    expect(denied).toBeDefined();
    expect(JSON.parse(denied ?? "{}")).toMatchObject({ reason: "wrong_email", route: "/api/*" });
    expect(lines.join("\n")).not.toMatch(/test\/ping|secret|example\.test/);
  });
});
```

`app/test/worker/csrf/csrf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/item", (c) => c.json({ ok: true }));
  app.post("/api/test/item", (c) => c.json({ ok: true }));
  app.put("/api/test/item", (c) => c.json({ ok: true }));
  app.patch("/api/test/item", (c) => c.json({ ok: true }));
  app.delete("/api/test/item", (c) => c.json({ ok: true }));
  return app;
}

describe("csrfGuard", () => {
  it("allows GET without the header", async () => {
    expect((await apiFetch("/api/test/item", {}, { app: testApp() })).status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("requires X-Clearbox-CSRF: 1 on %s", async (method) => {
    const missing = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp(), csrf: null });
    expect(missing.status).toBe(403);
    expect((await readJson<ApiErrorBody>(missing)).error.code).toBe("csrf_required");
    const wrong = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp(), csrf: "0" });
    expect(wrong.status).toBe(403);
    const ok = await apiFetch("/api/test/item", jsonInit(method, {}), { app: testApp() });
    expect(ok.status).toBe(200);
  });

  it("never sends CORS headers", async () => {
    const res = await apiFetch("/api/test/item", { headers: { Origin: "https://evil.example" } }, { app: testApp() });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
```

`app/test/worker/routes/envelope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiErrorBody } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { ApiError, parseWith, readJsonBody } from "../../../src/worker/middleware/errors.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";

function testApp() {
  const app = createApp();
  app.get("/api/test/boom", () => {
    throw new Error("secret detail owner@example.test");
  });
  app.get("/api/test/busy", () => {
    throw new ApiError(409, "account_busy", "Account is busy", { retryAt: "2026-10-15T10:05:00.000Z" });
  });
  app.post("/api/test/validate", async (c) => {
    const body = parseWith(z.strictObject({ n: z.int() }), await readJsonBody(c));
    return c.json(body);
  });
  return app;
}

describe("error envelope and headers", () => {
  it("returns not_found for unknown API paths", async () => {
    const res = await apiFetch("/api/nope", {}, { app: testApp() });
    expect(res.status).toBe(404);
    expect(await readJson<ApiErrorBody>(res)).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("sets security, cache and request id headers on every API response", async () => {
    const res = await apiFetch("/api/nope", {}, { app: testApp() });
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps unexpected errors to 500 internal without leaking details", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await apiFetch("/api/test/boom", {}, { app: testApp() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(text).not.toContain("secret");
    expect(res.headers.get("X-Request-Id")).not.toBeNull();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l["evt"] === "request.error");
    expect(logged).toMatchObject({ requestId: res.headers.get("X-Request-Id"), errorName: "Error" });
    expect(typeof logged?.["route"]).toBe("string");
    expect(lines.join("\n")).not.toContain("secret");
    spy.mockRestore();
  });

  it("renders ApiError with retryAt", async () => {
    const res = await apiFetch("/api/test/busy", {}, { app: testApp() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "account_busy", message: "Account is busy", retryAt: "2026-10-15T10:05:00.000Z" },
    });
  });

  it("maps zod failures to validation_failed with path details", async () => {
    const res = await apiFetch("/api/test/validate", jsonInit("POST", { n: "x" }), { app: testApp() });
    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual([{ path: "n", message: expect.any(String) }]);
  });

  it("rejects non-JSON bodies", async () => {
    const res = await apiFetch("/api/test/validate", { method: "POST", body: "{" }, { app: testApp() });
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe("validation_failed");
  });

  it("rejects bodies over 64 KiB with 413", async () => {
    const res = await apiFetch("/api/test/validate", jsonInit("POST", { pad: "x".repeat(70_000) }), { app: testApp() });
    expect(res.status).toBe(413);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe("payload_too_large");
  });
});
```

`app/test/worker/routes/entry.test.ts`:

```ts
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../../src/worker/index.ts";
import { CRON_NIGHTLY, CRON_TICK } from "../../../src/worker/env.ts";
import { apiFetch } from "../helpers/request.ts";

describe("worker entry", () => {
  it("serves the Hono app through exports.default.fetch", async () => {
    const res = await apiFetch("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-Id")).not.toBeNull();
  });

  it.each([CRON_TICK, CRON_NIGHTLY, "*/5 * * * *"])("handles scheduled cron %s without throwing", async (cron) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.UTC(2026, 9, 15, 2) }), env, ctx);
    await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/access/access.test.ts test/worker/csrf test/worker/routes/envelope.test.ts test/worker/routes/entry.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/app.ts`.

- [ ] **Step 4: Implement `app/src/worker/scan/providers.ts`**

```ts
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
  exchangeCode(f: FetchLike, cfg: OAuthClientConfig, code: string, codeVerifier: string, now: number): Promise<OAuthTokens>;
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
```

- [ ] **Step 5: Append the Hono types to `app/src/worker/env.ts`**

Add these imports at the top of `env.ts` (after the existing imports):

```ts
import type { FetchLike } from "@clearbox/core";
import type { ProviderFactory, ProviderOAuthMap } from "./scan/providers.ts";
```

Append at the end of `env.ts`:

```ts
/** Injectable dependencies; tests replace them through createApp(overrides). */
export interface AppDeps {
  fetch: FetchLike;
  now: () => number;
  providerFactory: ProviderFactory;
  oauth: ProviderOAuthMap;
}

export interface AppVariables {
  requestId: string;
  deps: AppDeps;
  /** Set by accessGuard. */
  config: AppConfig;
  /** Set by accessGuard. */
  ownerEmail: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
```

- [ ] **Step 6: Implement `app/src/worker/middleware/errors.ts`**

```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { z } from "zod";
import { routePath } from "hono/route";
import type { ApiErrorBody, ApiErrorCode } from "../../shared/api.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";

export interface ApiErrorOptions {
  details?: unknown;
  retryAt?: string;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly retryAt: string | null;

  constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAt = options.retryAt ?? null;
  }
}

export function errorBody(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}): ApiErrorBody {
  const error: ApiErrorBody["error"] = { code, message };
  if (options.details !== undefined) error.details = options.details;
  if (options.retryAt !== undefined) error.retryAt = options.retryAt;
  return { error };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, "validation_failed", "Request validation failed", { details: zodIssues(parsed.error) });
  }
  return parsed.data;
}

export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err) {
    // hono/body-limit errors the body stream with BodyLimitError; rethrow so it answers 413.
    if (err instanceof Error && err.name === "BodyLimitError") throw err;
    throw new ApiError(400, "validation_failed", "Request body must be JSON");
  }
}

export function apiErrorResponse(c: Context<AppEnv>, err: ApiError): Response {
  const options: ApiErrorOptions = {};
  if (err.details !== undefined) options.details = err.details;
  if (err.retryAt !== null) options.retryAt = err.retryAt;
  return c.json(errorBody(err.code, err.message, options), err.status);
}

export function onApiError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) return apiErrorResponse(c, err);
  if (err instanceof ZodError) {
    return c.json(errorBody("validation_failed", "Request validation failed", { details: zodIssues(err) }), 400);
  }
  // Contracts 9 request.error: the error name only, never its message (it may contain mail data).
  logEvent("request.error", { requestId: c.get("requestId"), route: routePath(c), errorName: err.name });
  return c.json(errorBody("internal", "Internal error"), 500);
}

export function notFoundHandler(c: Context<AppEnv>): Response {
  return c.json(errorBody("not_found", "Not found"), 404);
}
```

- [ ] **Step 7: Implement `app/src/worker/middleware/headers.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "../env.ts";
import { newRequestId } from "../log.ts";
import { errorBody } from "./errors.ts";

/** Contracts 3.4: headers for Worker responses (/api/*, /oauth/*). */
export const workerSecureHeaders = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
  crossOriginOpenerPolicy: "same-origin",
});

export const apiResponseHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  if (c.res.headers.get("Content-Type")?.startsWith("application/json")) {
    c.header("Content-Type", "application/json; charset=utf-8");
  }
};

export const API_BODY_LIMIT_BYTES = 64 * 1024;

export const apiBodyLimit = bodyLimit({
  maxSize: API_BODY_LIMIT_BYTES,
  onError: (c) => c.json(errorBody("payload_too_large", "Request body is too large"), 413),
});

export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = newRequestId();
    c.set("requestId", requestId);
    c.set("deps", deps);
    await next();
    c.header("X-Request-Id", requestId);
  };
}
```

- [ ] **Step 8: Implement `app/src/worker/middleware/access.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { readConfig } from "../env.ts";
import type { AppConfig, AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "./errors.ts";

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

/** One JWKS object per team domain per isolate: jose caches keys and refetches on unknown kid. */
const jwksCache = new Map<string, RemoteJwks>();

export function resetJwksCache(): void {
  jwksCache.clear();
}

function jwksFor(teamDomain: string): RemoteJwks {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export type AccessVerdict = { ok: true; email: string } | { ok: false; reason: "invalid" | "wrong_email" };

export async function verifyAccessJwt(token: string, config: AppConfig, now: number): Promise<AccessVerdict> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(config.accessTeamDomain), {
      issuer: config.accessTeamDomain,
      audience: config.accessAud,
      algorithms: ["RS256"],
      currentDate: new Date(now),
    }));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const claim = payload["email"];
  const email = typeof claim === "string" ? claim.trim().toLowerCase() : "";
  if (email === "" || email !== config.ownerEmail) return { ok: false, reason: "wrong_email" };
  return { ok: true, email };
}

export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Contracts 7.1 accessGuard. Runs on /api/* and /oauth/*. */
export const accessGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const route = routePath(c);
  const result = readConfig(c.env);
  if (!result.ok) {
    logEvent("config.invalid", { missing: result.invalid.join(",") });
    logEvent("access.denied", { reason: "misconfigured", route });
    throw new ApiError(500, "access_misconfigured", "Access is not configured");
  }
  const config = result.config;
  c.set("config", config);

  // readConfig already rejects DEV_AUTH_BYPASS=true outside development.
  if (config.devAuthBypass && config.environment === "development" && isLocalHostname(new URL(c.req.url).hostname)) {
    c.set("ownerEmail", config.ownerEmail);
    await next();
    return;
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    logEvent("access.denied", { reason: "missing", route });
    throw new ApiError(401, "unauthenticated", "Authentication required");
  }
  // JWT exp/nbf are wall-clock claims; they are always checked against the real clock, not deps.now.
  const verdict = await verifyAccessJwt(token, config, Date.now());
  if (!verdict.ok) {
    logEvent("access.denied", { reason: verdict.reason, route });
    throw new ApiError(403, "forbidden", "Forbidden");
  }
  c.set("ownerEmail", verdict.email);
  await next();
};
```

- [ ] **Step 9: Implement `app/src/worker/middleware/csrf.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { CSRF_HEADER, CSRF_VALUE } from "../../shared/api.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "./errors.ts";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    logEvent("access.denied", { reason: "csrf", route: routePath(c) });
    throw new ApiError(403, "csrf_required", "Missing CSRF header");
  }
  await next();
};
```

- [ ] **Step 10: Create the stubs plan 04 replaces**

`app/src/worker/scan/tick.ts`:

```ts
import type { DecisionEngine, FetchLike } from "@clearbox/core";
import type { TickReport } from "../../shared/api.ts";

export interface TickOptions {
  trigger: "cron" | "scan_now";
  /** Required for scan_now. */
  accountId?: string;
  now: number;
  /** Tests inject FakeEngine; default makeDecisionEngine(env). */
  engine?: DecisionEngine;
  /** Tests may inject; default globalThis.fetch. */
  fetch?: FetchLike;
}

/**
 * TEMPORARY STUB from plan 03 so the Worker entry compiles and runs.
 * Plan 04 replaces this whole file with the real tick (contracts 8.2), keeping these exports.
 */
export async function runTick(env: Env, opts: TickOptions): Promise<TickReport> {
  void env;
  return {
    outcome: "idle",
    accountId: opts.accountId ?? null,
    kind: null,
    phase: null,
    fetched: 0,
    skippedKnown: 0,
    decided: 0,
    deferred: 0,
    unsure: 0,
    removed: 0,
    subrequests: 0,
    rowsWritten: 0,
    nextTickAt: null,
    errorCode: null,
  };
}
```

`app/src/worker/nightly/nightly.ts`:

```ts
/**
 * TEMPORARY STUB from plan 03 so the Worker entry compiles and runs.
 * Plan 04 replaces this whole file with the real nightly job (contracts 8.6), keeping this export.
 */
export async function runNightly(env: Env, opts: { now: number }): Promise<void> {
  void env;
  void opts;
}
```

- [ ] **Step 11: Implement `app/src/worker/app.ts`**

```ts
import type { FetchLike } from "@clearbox/core";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./env.ts";
import { accessGuard } from "./middleware/access.ts";
import { csrfGuard } from "./middleware/csrf.ts";
import { notFoundHandler, onApiError } from "./middleware/errors.ts";
import { apiBodyLimit, apiResponseHeaders, requestContext, workerSecureHeaders } from "./middleware/headers.ts";
import { makeProvider, PROVIDER_OAUTH } from "./scan/providers.ts";
import type { ProviderFactory, ProviderOAuthMap } from "./scan/providers.ts";

export interface AppOverrides {
  fetch?: FetchLike;
  now?: () => number;
  providerFactory?: ProviderFactory;
  oauth?: ProviderOAuthMap;
}

export function defaultDeps(overrides: AppOverrides = {}): AppDeps {
  return {
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    now: overrides.now ?? (() => Date.now()),
    providerFactory: overrides.providerFactory ?? makeProvider,
    oauth: overrides.oauth ?? PROVIDER_OAUTH,
  };
}

/** Contracts 7.1 middleware order: secureHeaders -> accessGuard -> csrfGuard -> routes -> notFound -> onError. */
export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", workerSecureHeaders);
  app.use("*", requestContext(defaultDeps(overrides)));
  app.use("/api/*", apiResponseHeaders);
  app.use("/api/*", accessGuard);
  app.use("/oauth/*", accessGuard);
  app.use("/api/*", csrfGuard);
  app.use("/api/*", apiBodyLimit);

  // Routes (mounted by later tasks, in this order).

  app.notFound(notFoundHandler);
  app.onError(onApiError);
  return app;
}
```

- [ ] **Step 12: Replace `app/src/worker/index.ts`**

```ts
import { createApp } from "./app.ts";
import { CRON_NIGHTLY, CRON_TICK } from "./env.ts";
import { runNightly } from "./nightly/nightly.ts";
import { runTick } from "./scan/tick.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case CRON_TICK:
        ctx.waitUntil(runTick(env, { trigger: "cron", now: controller.scheduledTime }));
        break;
      case CRON_NIGHTLY:
        ctx.waitUntil(runNightly(env, { now: controller.scheduledTime }));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 13: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/access/access.test.ts test/worker/csrf test/worker/routes/envelope.test.ts test/worker/routes/entry.test.ts`
Expected: PASS, `36 passed` (19 access, 6 csrf, 7 envelope, 4 entry).

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exits 0.

- [ ] **Step 14: Commit**

```bash
git add app/src/worker app/test/worker
git commit -m "feat(worker): add Hono app with Access JWT, CSRF, security headers and error envelope"
```

---

### Task 6: D1 helpers, settings, budget and audit repositories

**Files:**
- Create: `app/src/worker/db/sql.ts`
- Create: `app/src/worker/db/settings.ts`
- Create: `app/src/worker/db/budget.ts`
- Create: `app/src/worker/db/audit.ts`
- Test: `app/test/worker/db/sql.test.ts`, `app/test/worker/db/settings.test.ts`, `app/test/worker/db/budget-audit.test.ts`

**Interfaces:**
- Consumes: `ApiError` (Task 5), base64url codecs (Task 3), api types `AppIssue`, `AppIssueCode`, `ActivityKind`, `ActivityEntry` (Task 2); from `@clearbox/core`: `SubrequestCounter`, `createSubrequestCounter`, `Policy`, `CalibrationResult`, `DEFAULT_POLICY`, `parsePolicy`, `TAU_DELETE_DEFAULT`.
- Produces:
  - `sql.ts`: `MAX_BOUND_PARAMS = 99`, `chunk<T>(items: readonly T[], size: number): T[][]`, `placeholders(count: number, start?: number): string` (`"?3, ?4"`), `sumRowsWritten(results: readonly D1Result[]): number`, `sumRowsRead(results): number`, `now(): number`, `withCount<T>(counter: SubrequestCounter, fn: () => Promise<T>): Promise<T>`, `toIso(ms: number): string`, `toIsoOrNull(ms: number | null): string | null`, `utcDate(ms: number): string` (`YYYY-MM-DD`), `nextUtcMidnight(ms: number): number`, `encodeCursor(value: unknown): string`, `decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S>` (throws `ApiError(400, "validation_failed")`), `flag(value: unknown): boolean`, `isoToMs(iso: string): number`, `interface SqlQuery { sql: string; params: unknown[] }`, `bindQuery(db, q: SqlQuery): D1PreparedStatement`.
  - `settings.ts`: `type SettingKey = "tau_delete" | "policy" | "policy_version" | "calibration" | "issues" | "nightly"`, `type CalibrationSetting = CalibrationResult & { ranAt: number }`, `interface NightlySetting { ranAt: number; purgedMessages: number; purgedAccounts: number; staleRecovered: number }`, `interface Settings { tauDelete: number; policy: Policy; policyVersion: number; calibration: CalibrationSetting | null; issues: AppIssue[]; nightly: NightlySetting | null }`, `interface SettingRow { key: string; value: string }`, `selectSettingsStmt(db)`, `parseSettings(rows): Settings`, `readSettings(db): Promise<Settings>`, `setSettingStmt(db, key, value: unknown, now)`, `addIssue(issues, code, accountId: string | null, now): AppIssue[]`, `removeIssue(issues, code, accountId?: string | null): AppIssue[]`, `issuesEqual(a, b): boolean`, `setIssuesStmt(db, issues, now)`.
  - `budget.ts`: `interface Budget { date; rowsWritten; rowsRead; ticks; messagesIngested; decisionCalls; decisionFailures; decisionInputTokens; providerCalls; dbSizeBytes; updatedAt }`, `interface BudgetRow` (snake_case columns), `mapBudget(row: BudgetRow | null, date: string): Budget`, `selectBudgetStmt(db, date)`, `readBudget(db, date): Promise<Budget>`, `interface BudgetDelta { rowsWritten?; rowsRead?; ticks?; messagesIngested?; decisionCalls?; decisionFailures?; decisionInputTokens?; providerCalls?; dbSizeBytes?: number | null }`, `budgetDeltaStmt(db, date, delta, now)`, `selectBudgetHistoryStmt(db, fromDate)`.
  - `audit.ts`: `type AuditKind = ActivityKind`, `interface AuditEntry { ts: number; accountId: string | null; kind: AuditKind; batchId: number | null | "latest_batch"; count: number; result: Readonly<Record<string, number | string>> }`, `auditStmt(db, entry)`, `selectAuditKindsSinceStmt(db, since, kinds)`, `interface AuditRow`, `mapActivity(row): ActivityEntry`, `selectActivityStmt(db, opts: { accountId: string | null; beforeId: number | null; limit: number })`, `selectBatchAuditStmt(db, batchIds: readonly number[])`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/db/sql.test.ts`:

```ts
import { createSubrequestCounter } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  chunk,
  decodeCursor,
  encodeCursor,
  isoToMs,
  nextUtcMidnight,
  placeholders,
  sumRowsWritten,
  toIsoOrNull,
  utcDate,
  withCount,
} from "../../../src/worker/db/sql.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";

describe("sql helpers", () => {
  it("chunks and builds numbered placeholders", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(placeholders(3)).toBe("?1, ?2, ?3");
    expect(placeholders(2, 4)).toBe("?4, ?5");
  });

  it("formats UTC dates and the next midnight", () => {
    const t = Date.UTC(2026, 9, 15, 23, 59, 59);
    expect(utcDate(t)).toBe("2026-10-15");
    expect(nextUtcMidnight(t)).toBe(Date.UTC(2026, 9, 16));
    expect(toIsoOrNull(null)).toBeNull();
    expect(isoToMs("2026-10-15T00:00:00.000Z")).toBe(Date.UTC(2026, 9, 15));
  });

  it("round trips cursors and rejects malformed ones with 400", () => {
    const schema = z.strictObject({ v: z.literal(1), id: z.int() });
    expect(decodeCursor(encodeCursor({ v: 1, id: 7 }), schema)).toEqual({ v: 1, id: 7 });
    for (const bad of ["***", encodeCursor({ v: 2, id: 7 }), encodeCursor("text")]) {
      try {
        decodeCursor(bad, schema);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe("validation_failed");
      }
    }
  });

  it("sums rows written from batch metadata", async () => {
    const results = await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k1', '1', 0)"),
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k2', '2', 0)"),
    ]);
    expect(sumRowsWritten(results)).toBeGreaterThanOrEqual(2);
  });

  it("reserves one subrequest per D1 call", async () => {
    const counter = createSubrequestCounter(1);
    await withCount(counter, () => env.DB.prepare("SELECT 1").run());
    expect(counter.used).toBe(1);
    await expect(withCount(counter, () => env.DB.prepare("SELECT 1").run())).rejects.toMatchObject({
      code: "subrequest_budget",
    });
  });
});
```

`app/test/worker/db/settings.test.ts`:

```ts
import { DEFAULT_POLICY } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  addIssue,
  issuesEqual,
  readSettings,
  removeIssue,
  setIssuesStmt,
  setSettingStmt,
} from "../../../src/worker/db/settings.ts";

const NOW = Date.UTC(2026, 9, 15, 12);

describe("settings repository", () => {
  it("returns migration defaults", async () => {
    const s = await readSettings(env.DB);
    expect(s.tauDelete).toBe(0.8);
    expect(s.policyVersion).toBe(1);
    expect(s.policy).toEqual(DEFAULT_POLICY);
    expect(s.calibration).toBeNull();
    expect(s.issues).toEqual([]);
    expect(s.nightly).toBeNull();
  });

  it("upserts JSON values", async () => {
    await env.DB.batch([
      setSettingStmt(env.DB, "tau_delete", 0.87, NOW),
      setSettingStmt(env.DB, "policy", { ...DEFAULT_POLICY, minAgeDays: 7 }, NOW),
    ]);
    const s = await readSettings(env.DB);
    expect(s.tauDelete).toBe(0.87);
    expect(s.policy.minAgeDays).toBe(7);
  });

  it("adds issues once per (code, account) and removes them", async () => {
    let issues = addIssue([], "storage_near_limit", null, NOW);
    issues = addIssue(issues, "storage_near_limit", null, NOW + 1);
    issues = addIssue(issues, "google_client_invalid", "acc_0000000000000001", NOW);
    expect(issues).toEqual([
      { code: "storage_near_limit", since: new Date(NOW).toISOString(), accountId: null },
      { code: "google_client_invalid", since: new Date(NOW).toISOString(), accountId: "acc_0000000000000001" },
    ]);
    expect(removeIssue(issues, "google_client_invalid")).toHaveLength(1);
    expect(removeIssue(issues, "google_client_invalid", "acc_ffffffffffffffff")).toHaveLength(2);
    expect(issuesEqual(issues, [...issues])).toBe(true);
    expect(issuesEqual(issues, issues.slice(1))).toBe(false);
    await setIssuesStmt(env.DB, issues, NOW).run();
    expect((await readSettings(env.DB)).issues).toEqual(issues);
  });
});
```

`app/test/worker/db/budget-audit.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  auditStmt,
  mapActivity,
  selectActivityStmt,
  selectAuditKindsSinceStmt,
  selectBatchAuditStmt,
} from "../../../src/worker/db/audit.ts";
import type { AuditRow } from "../../../src/worker/db/audit.ts";
import { budgetDeltaStmt, readBudget, selectBudgetHistoryStmt } from "../../../src/worker/db/budget.ts";
import type { BudgetRow } from "../../../src/worker/db/budget.ts";

const NOW = Date.UTC(2026, 9, 15, 12);

describe("budget repository", () => {
  it("returns zeros for a day without a row", async () => {
    expect(await readBudget(env.DB, "2026-01-01")).toMatchObject({ date: "2026-01-01", rowsWritten: 0, ticks: 0 });
  });

  it("accumulates deltas and keeps db size unless provided", async () => {
    await budgetDeltaStmt(env.DB, "2026-10-15", { rowsWritten: 10, ticks: 1, dbSizeBytes: 5_000 }, NOW).run();
    await budgetDeltaStmt(env.DB, "2026-10-15", { rowsWritten: 7, providerCalls: 3 }, NOW + 1).run();
    const b = await readBudget(env.DB, "2026-10-15");
    expect(b).toMatchObject({ rowsWritten: 17, ticks: 1, providerCalls: 3, dbSizeBytes: 5_000, updatedAt: NOW + 1 });
    await budgetDeltaStmt(env.DB, "2026-10-14", { rowsWritten: 1 }, NOW).run();
    const history = await selectBudgetHistoryStmt(env.DB, "2026-10-14").run<BudgetRow>();
    expect(history.results.map((r) => r.date)).toEqual(["2026-10-14", "2026-10-15"]);
  });
});

describe("audit repository", () => {
  it("appends rows and pages them newest first with an optional account filter", async () => {
    await env.DB.batch([
      auditStmt(env.DB, { ts: NOW, accountId: "acc_0000000000000001", kind: "account_connected", batchId: null, count: 0, result: {} }),
      auditStmt(env.DB, { ts: NOW + 1, accountId: null, kind: "approve", batchId: 9, count: 3, result: { executed: 3, delete: 3 } }),
      auditStmt(env.DB, { ts: NOW + 2, accountId: "acc_0000000000000002", kind: "account_paused", batchId: null, count: 0, result: {} }),
    ]);
    const page = await selectActivityStmt(env.DB, { accountId: null, beforeId: null, limit: 2 }).run<AuditRow>();
    const entries = page.results.map(mapActivity);
    expect(entries.map((e) => e.kind)).toEqual(["account_paused", "approve"]);
    expect(entries[1]).toMatchObject({ batchId: 9, count: 3, result: { executed: 3, delete: 3 }, ts: new Date(NOW + 1).toISOString() });
    const older = await selectActivityStmt(env.DB, { accountId: null, beforeId: entries[1]?.id ?? 0, limit: 5 }).run<AuditRow>();
    expect(older.results.map((r) => r.kind)).toEqual(["account_connected"]);
    const filtered = await selectActivityStmt(env.DB, { accountId: "acc_0000000000000002", beforeId: null, limit: 5 }).run<AuditRow>();
    expect(filtered.results).toHaveLength(1);
    const batchRows = await selectBatchAuditStmt(env.DB, [9, 10]).run<AuditRow>();
    expect(batchRows.results.map((r) => r.batch_id)).toEqual([9]);
    const since = await selectAuditKindsSinceStmt(env.DB, NOW + 1, ["approve", "account_paused"]).run<AuditRow>();
    expect(since.results.map((r) => r.kind)).toEqual(["approve", "account_paused"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db/sql.test.ts test/worker/db/settings.test.ts test/worker/db/budget-audit.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/db/sql.ts` (and `settings.ts`, `budget.ts`, `audit.ts`).

- [ ] **Step 3: Implement `app/src/worker/db/sql.ts`**

```ts
import type { SubrequestCounter } from "@clearbox/core";
import type { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import { ApiError } from "../middleware/errors.ts";

/** D1 allows 100 bound parameters per statement; stay at 99 or fewer. */
export const MAX_BOUND_PARAMS = 99;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A statement whose SQL text is inspectable (query plan tests) before binding. */
export interface SqlQuery {
  sql: string;
  params: unknown[];
}

export function bindQuery(db: D1Database, q: SqlQuery): D1PreparedStatement {
  return db.prepare(q.sql).bind(...q.params);
}

/** "?start, ?start+1, ..." for numbered parameters. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

export function sumRowsWritten(results: readonly D1Result[]): number {
  return results.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0);
}

export function sumRowsRead(results: readonly D1Result[]): number {
  return results.reduce((sum, r) => sum + (r.meta.rows_read ?? 0), 0);
}

export function now(): number {
  return Date.now();
}

/** Every D1 call reserves one subrequest from the tick counter (contracts 8.4). */
export async function withCount<T>(counter: SubrequestCounter, fn: () => Promise<T>): Promise<T> {
  counter.reserve(1);
  return fn();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

export function utcDate(ms: number): string {
  return toIso(ms).slice(0, 10);
}

export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** SQLite booleans are 0/1 integers. */
export function flag(value: unknown): boolean {
  return value === 1 || value === true;
}

export function encodeCursor(value: unknown): string {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(base64UrlToBytes(cursor)));
  } catch {
    throw new ApiError(400, "validation_failed", "Malformed cursor");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "validation_failed", "Malformed cursor");
  return parsed.data;
}
```

- [ ] **Step 4: Implement `app/src/worker/db/settings.ts`**

```ts
import { DEFAULT_POLICY, parsePolicy, TAU_DELETE_DEFAULT } from "@clearbox/core";
import type { CalibrationResult, Policy } from "@clearbox/core";
import { z } from "zod";
import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import { toIso } from "./sql.ts";

export type SettingKey = "tau_delete" | "policy" | "policy_version" | "calibration" | "issues" | "nightly";

export type CalibrationSetting = CalibrationResult & { ranAt: number };

export interface NightlySetting {
  ranAt: number;
  purgedMessages: number;
  purgedAccounts: number;
  staleRecovered: number;
}

export interface Settings {
  tauDelete: number;
  policy: Policy;
  policyVersion: number;
  calibration: CalibrationSetting | null;
  issues: AppIssue[];
  nightly: NightlySetting | null;
}

export interface SettingRow {
  key: string;
  value: string;
}

const IssueListSchema = z.array(
  z.object({ code: z.string(), since: z.string(), accountId: z.string().nullable() }),
);

export function selectSettingsStmt(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT key, value FROM settings");
}

export function parseSettings(rows: readonly SettingRow[]): Settings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const json = (key: SettingKey): unknown => {
    const raw = map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as unknown);
  };
  const tau = json("tau_delete");
  const version = json("policy_version");
  const issues = IssueListSchema.safeParse(json("issues") ?? []);
  return {
    tauDelete: typeof tau === "number" ? tau : TAU_DELETE_DEFAULT,
    policy: map.has("policy") ? parsePolicy(map.get("policy") ?? null) : DEFAULT_POLICY,
    policyVersion: typeof version === "number" ? version : 1,
    calibration: (json("calibration") as CalibrationSetting | null) ?? null,
    issues: issues.success ? (issues.data as AppIssue[]) : [],
    nightly: (json("nightly") as NightlySetting | null) ?? null,
  };
}

export async function readSettings(db: D1Database): Promise<Settings> {
  const res = await selectSettingsStmt(db).run<SettingRow>();
  return parseSettings(res.results);
}

export function setSettingStmt(db: D1Database, key: SettingKey, value: unknown, now: number): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), now);
}

export function addIssue(issues: readonly AppIssue[], code: AppIssueCode, accountId: string | null, now: number): AppIssue[] {
  if (issues.some((i) => i.code === code && i.accountId === accountId)) return [...issues];
  return [...issues, { code, since: toIso(now), accountId }];
}

/** accountId undefined removes the code for every account. */
export function removeIssue(issues: readonly AppIssue[], code: AppIssueCode, accountId?: string | null): AppIssue[] {
  return issues.filter((i) => !(i.code === code && (accountId === undefined || i.accountId === accountId)));
}

export function issuesEqual(a: readonly AppIssue[], b: readonly AppIssue[]): boolean {
  const key = (i: AppIssue) => `${i.code}|${i.accountId ?? ""}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, idx) => k === right[idx]);
}

export function setIssuesStmt(db: D1Database, issues: readonly AppIssue[], now: number): D1PreparedStatement {
  return setSettingStmt(db, "issues", issues, now);
}
```

- [ ] **Step 5: Implement `app/src/worker/db/budget.ts`**

```ts
export interface Budget {
  date: string;
  rowsWritten: number;
  rowsRead: number;
  ticks: number;
  messagesIngested: number;
  decisionCalls: number;
  decisionFailures: number;
  decisionInputTokens: number;
  providerCalls: number;
  dbSizeBytes: number;
  updatedAt: number;
}

export interface BudgetRow {
  date: string;
  rows_written: number;
  rows_read: number;
  ticks: number;
  messages_ingested: number;
  decision_calls: number;
  decision_failures: number;
  decision_input_tokens: number;
  provider_calls: number;
  db_size_bytes: number;
  updated_at: number;
}

export interface BudgetDelta {
  rowsWritten?: number;
  rowsRead?: number;
  ticks?: number;
  messagesIngested?: number;
  decisionCalls?: number;
  decisionFailures?: number;
  decisionInputTokens?: number;
  providerCalls?: number;
  /** Absolute value (from D1 meta.size_after); null or absent keeps the stored value. */
  dbSizeBytes?: number | null;
}

export function mapBudget(row: BudgetRow | null, date: string): Budget {
  if (!row) {
    return {
      date,
      rowsWritten: 0,
      rowsRead: 0,
      ticks: 0,
      messagesIngested: 0,
      decisionCalls: 0,
      decisionFailures: 0,
      decisionInputTokens: 0,
      providerCalls: 0,
      dbSizeBytes: 0,
      updatedAt: 0,
    };
  }
  return {
    date: row.date,
    rowsWritten: row.rows_written,
    rowsRead: row.rows_read,
    ticks: row.ticks,
    messagesIngested: row.messages_ingested,
    decisionCalls: row.decision_calls,
    decisionFailures: row.decision_failures,
    decisionInputTokens: row.decision_input_tokens,
    providerCalls: row.provider_calls,
    dbSizeBytes: row.db_size_bytes,
    updatedAt: row.updated_at,
  };
}

export function selectBudgetStmt(db: D1Database, date: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM budget WHERE date = ?1").bind(date);
}

export async function readBudget(db: D1Database, date: string): Promise<Budget> {
  return mapBudget(await selectBudgetStmt(db, date).first<BudgetRow>(), date);
}

export function budgetDeltaStmt(db: D1Database, date: string, delta: BudgetDelta, now: number): D1PreparedStatement {
  const size = delta.dbSizeBytes ?? null;
  return db
    .prepare(
      `INSERT INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
         decision_input_tokens, provider_calls, db_size_bytes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, 0), ?11)
       ON CONFLICT (date) DO UPDATE SET
         rows_written = rows_written + excluded.rows_written,
         rows_read = rows_read + excluded.rows_read,
         ticks = ticks + excluded.ticks,
         messages_ingested = messages_ingested + excluded.messages_ingested,
         decision_calls = decision_calls + excluded.decision_calls,
         decision_failures = decision_failures + excluded.decision_failures,
         decision_input_tokens = decision_input_tokens + excluded.decision_input_tokens,
         provider_calls = provider_calls + excluded.provider_calls,
         db_size_bytes = CASE WHEN ?10 IS NULL THEN budget.db_size_bytes ELSE excluded.db_size_bytes END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      date,
      delta.rowsWritten ?? 0,
      delta.rowsRead ?? 0,
      delta.ticks ?? 0,
      delta.messagesIngested ?? 0,
      delta.decisionCalls ?? 0,
      delta.decisionFailures ?? 0,
      delta.decisionInputTokens ?? 0,
      delta.providerCalls ?? 0,
      size,
      now,
    );
}

export function selectBudgetHistoryStmt(db: D1Database, fromDate: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM budget WHERE date >= ?1 ORDER BY date").bind(fromDate);
}
```

- [ ] **Step 6: Implement `app/src/worker/db/audit.ts`**

```ts
import type { ActivityEntry, ActivityKind } from "../../shared/api.ts";
import { placeholders, toIso } from "./sql.ts";

export type AuditKind = ActivityKind;

export interface AuditEntry {
  ts: number;
  accountId: string | null;
  kind: AuditKind;
  /** "latest_batch": the action_batches row inserted earlier in the same D1 batch (decision 9). */
  batchId: number | null | "latest_batch";
  count: number;
  /** Counts and codes only, never addresses or subjects. */
  result: Readonly<Record<string, number | string>>;
}

export interface AuditRow {
  id: number;
  ts: number;
  account_id: string | null;
  kind: AuditKind;
  batch_id: number | null;
  count: number;
  result_json: string;
}

export function auditStmt(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json)
       VALUES (?1, ?2, ?3, CASE WHEN ?4 = 'latest_batch' THEN (SELECT MAX(id) FROM action_batches) ELSE ?4 END, ?5, ?6)`,
    )
    .bind(entry.ts, entry.accountId, entry.kind, entry.batchId, entry.count, JSON.stringify(entry.result));
}

/** Rows of the given kinds since `since` (insights weekly, contracts 12.1 A3). audit_log is small. */
export function selectAuditKindsSinceStmt(db: D1Database, since: number, kinds: readonly AuditKind[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE ts >= ?1 AND kind IN (${placeholders(kinds.length, 2)}) ORDER BY id`,
    )
    .bind(since, ...kinds);
}

export function mapActivity(row: AuditRow): ActivityEntry {
  return {
    id: row.id,
    ts: toIso(row.ts),
    kind: row.kind,
    accountId: row.account_id,
    batchId: row.batch_id,
    count: row.count,
    result: JSON.parse(row.result_json) as Record<string, number | string>,
  };
}

export function selectActivityStmt(
  db: D1Database,
  opts: { accountId: string | null; beforeId: number | null; limit: number },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE (?1 IS NULL OR account_id = ?1) AND (?2 IS NULL OR id < ?2)
       ORDER BY id DESC LIMIT ?3`,
    )
    .bind(opts.accountId, opts.beforeId, opts.limit);
}

/** Action audit rows (one per executed batch) carry byAction counts in result_json (decision 16). */
export function selectBatchAuditStmt(db: D1Database, batchIds: readonly number[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, account_id, kind, batch_id, count, result_json FROM audit_log
       WHERE kind IN ('approve', 'override', 'cleanup') AND batch_id IN (${placeholders(batchIds.length)})`,
    )
    .bind(...batchIds);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db/sql.test.ts test/worker/db/settings.test.ts test/worker/db/budget-audit.test.ts`
Expected: PASS, `11 passed`.

- [ ] **Step 8: Commit**

```bash
git add app/src/worker/db app/test/worker/db
git commit -m "feat(worker): add D1 helpers and settings, budget and audit repositories"
```

---

### Task 7: Account-scoped repositories, seed helpers and the isolation test

**Files:**
- Create: `app/src/worker/db/accounts.ts`
- Create: `app/src/worker/db/messages.ts`
- Create: `app/src/worker/db/suggestions.ts` (extended in Tasks 11 and 12)
- Create: `app/src/worker/db/labels.ts`
- Create: `app/src/worker/db/priors.ts`
- Create: `app/src/worker/db/batches.ts`
- Create: `app/test/worker/helpers/seed.ts`
- Test: `app/test/worker/db/repositories.test.ts`, `app/test/worker/db-isolation.test.ts`

**Interfaces:**
- Consumes: `sql.ts` helpers (Task 6), `EncryptedValue`, `encryptToken`, `importEncKey`, `CURRENT_KEY_VERSION` (Task 4), `bytesFromBlob`, `bytesToBase64Url`, `base64UrlToBytes`, `utf8`, `fromUtf8` (Task 3), api types `AccountPhase`, `AccountStatus`, `AccountSync`, `AccountView`, `SuggestionStatus` (Task 2); from `@clearbox/core`: `ProviderKind`, `ActionKind`, `SuggestedAction`, `Ceiling`, `PriorCounts`, `Reason`, `Signals`; from `@clearbox/core/testing`: `makeSignals(overrides?: Partial<Signals>): Signals`.
- Produces:
  - `accounts.ts`: `type AccountRowStatus = "active" | "needs_reauth" | "config_error" | "disconnected"`, `interface AccountRow` (all `accounts` columns, snake_case), `interface Account` (camelCase; `refreshToken: EncryptedValue | null`, `accessToken: EncryptedValue | null`, `grantedScopes: string[]`, `ownerAliases: string[]`, `paused: boolean`, `backfillDone: boolean`, other columns as numbers or strings), `mapAccount(row): Account`, `getAccount(db, id): Promise<Account | null>`, `listAccounts(db, opts: { includeDisconnected: boolean }): Promise<Account[]>`, `findOpenAccountByEmail(db, provider, email): Promise<Account | null>`, `interface NewAccount`, `insertAccountStmt(db, a)`, `interface ReconnectUpdate`, `reconnectAccountStmt(db, id, u)`, `setPausedStmt(db, id, paused, now)`, `disconnectAccountStmt(db, id, now)`, `markAccountStatusStmt(db, id, status: "needs_reauth" | "config_error", reason: string, now)`, `accessTokenUpdateStmt(db, id, access: EncryptedValue, expiresAt, now)`, `setInboxEstimateStmt(db, id, estimate: number | null, now)` (rev 2.1 A4, used by plan 04), `tokensUpdateStmt(db, id, refresh: EncryptedValue, access: EncryptedValue, expiresAt, now)`, `interface OpenCounts { pending: number; awaitingModel: number }`, `toAccountView(account, counts): AccountView`, `toAccountSync(account, counts): AccountSync`.
  - `messages.ts`: `interface MessageInsert { providerMsgId; threadId; internetMessageId; sender; senderName; senderDomain; subject; snippet; receivedAt; isRead: boolean; signalsJson: string; webLink; createdAt }`, `insertMessageStmt(db, accountId, m)` (`ON CONFLICT (account_id, provider_msg_id) DO NOTHING`), `updateProviderMsgIdStmt(db, accountId, messageId, providerMsgId)`.
  - `suggestions.ts`: `interface SuggestionInsert`, `insertSuggestionStmt(db, accountId, providerMsgId, s)` (contracts 8.2 insert-select), `countOpenByAccountStmt(db, accountIds)`, `countOpenByAccount(db, accountIds): Promise<Map<string, OpenCounts>>`, `dismissOpenStmt(db, accountId, now)`, `encodeGroupKey(accountId, sender, action): string`, `decodeGroupKey(key): { accountId: string; sender: string; action: SuggestedAction } | null`.
  - `labels.ts`: `type LabelSource = "approve" | "override" | "cleanup" | "undo"`, `interface LabelInsert`, `insertLabelStmt(db, accountId, l)`, `undoLabelStmt(db, accountId, labelId, now)`, `labelStatsStmt(db, accountIds, since)`, `deletePrecisionStmt(db, accountIds, window)`.
  - `priors.ts`: `interface PriorDeltaEntry { accountId: string; key: string; deletes: number; keeps: number }`, `type PriorDeltaMap = Map<string, PriorDeltaEntry>`, `addPriorDelta(map, accountId, sender, domain, delta: PriorCounts): void`, `priorUpsertStmt(db, accountId, key, delta: PriorCounts, now)`, `priorStatements(db, map, now): D1PreparedStatement[]`.
  - `batches.ts`: `type BatchKind = "approve" | "override" | "cleanup"`, `interface BatchRow`, `interface ActionBatch`, `mapBatch(row)`, `interface NewBatch`, `insertBatchStmt(db, b)` (`RETURNING id`), `getBatch(db, id): Promise<ActionBatch | null>`, `listBatchesStmt(db, opts: { since: number; beforeId: number | null; limit: number })`, `claimUndoStmt(db, id, now)` (`RETURNING id`), `resetUndoStmt(db, id, undoneAt)`.
  - Seed helpers: `SEED_NOW = Date.UTC(2026, 9, 15, 12)`, `testEncKey(): Promise<CryptoKey>`, `interface SeedAccountInput`, `seedAccount(input?): Promise<Account>`, `seedMessages(accountId, n, overrides?): Promise<number[]>`, `interface SeedSuggestionOptions`, `seedSuggestions(accountId, n, opts?): Promise<number[]>`, `interface SeedLabelOptions`, `seedLabels(accountId, n, opts?): Promise<number[]>`, `getSuggestionRow(id): Promise<Record<string, unknown> | null>`.

- [ ] **Step 1: Write the seed helpers**

`app/test/worker/helpers/seed.ts`:

```ts
import type { ActionKind, Ceiling, ProviderKind, Reason, Signals, SuggestedAction } from "@clearbox/core";
import { makeSignals } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import type { AccountPhase, SuggestionStatus } from "../../../src/shared/api.ts";
import { CURRENT_KEY_VERSION, encryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { getAccount, insertAccountStmt } from "../../../src/worker/db/accounts.ts";
import type { Account, AccountRowStatus } from "../../../src/worker/db/accounts.ts";
import { insertLabelStmt } from "../../../src/worker/db/labels.ts";
import type { LabelSource } from "../../../src/worker/db/labels.ts";
import { insertMessageStmt } from "../../../src/worker/db/messages.ts";
import type { MessageInsert } from "../../../src/worker/db/messages.ts";
import { insertSuggestionStmt } from "../../../src/worker/db/suggestions.ts";

export const SEED_NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 3_600_000;
let seq = 0;

export async function testEncKey(): Promise<CryptoKey> {
  return importEncKey(base64ToBytes(env.TOKEN_ENC_KEY));
}

export interface SeedAccountInput {
  id?: string;
  provider?: ProviderKind;
  email?: string;
  status?: AccountRowStatus;
  statusReason?: string | null;
  paused?: boolean;
  archiveFolderId?: string | null;
  refreshToken?: string;
  /** null stores no cached access token. */
  accessToken?: string | null;
  accessExpiresAt?: number;
  phase?: AccountPhase;
  createdAt?: number;
  lastTickAt?: number | null;
  nextTickAt?: number;
}

export async function seedAccount(input: SeedAccountInput = {}): Promise<Account> {
  seq += 1;
  const id = input.id ?? `acc_${seq.toString(16).padStart(16, "0")}`;
  const provider = input.provider ?? "gmail";
  const email = input.email ?? `mailbox${seq}@example.com`;
  const key = await testEncKey();
  const ctx = (kind: "refresh" | "access") => ({ accountId: id, kind, keyVersion: CURRENT_KEY_VERSION });
  const refresh = await encryptToken(key, input.refreshToken ?? `refresh-${id}`, ctx("refresh"));
  const access = await encryptToken(key, input.accessToken ?? `access-${id}`, ctx("access"));
  const createdAt = input.createdAt ?? SEED_NOW - 30 * 24 * HOUR;
  await insertAccountStmt(env.DB, {
    id,
    provider,
    email,
    providerUserId: provider === "gmail" ? email : `user-${id}`,
    grantedScopes: provider === "gmail" ? ["https://www.googleapis.com/auth/gmail.modify"] : ["Mail.ReadWrite", "offline_access", "User.Read"],
    ownerAliases: [],
    archiveFolderId: input.archiveFolderId === undefined ? (provider === "outlook" ? "folder-archive" : null) : input.archiveFolderId,
    incrementalCursor: JSON.stringify({ v: 1, historyId: "1" }),
    keyVersion: CURRENT_KEY_VERSION,
    refreshToken: refresh,
    accessToken: access,
    accessExpiresAt: input.accessExpiresAt ?? Date.UTC(2100, 0, 1),
    now: createdAt,
  }).run();
  await env.DB.prepare(
    `UPDATE accounts SET status = ?2, status_reason = ?3, paused = ?4, phase = ?5, last_tick_at = ?6, next_tick_at = ?7,
       enc_access_token = CASE WHEN ?8 = 1 THEN NULL ELSE enc_access_token END,
       access_iv = CASE WHEN ?8 = 1 THEN NULL ELSE access_iv END,
       access_expires_at = CASE WHEN ?8 = 1 THEN NULL ELSE access_expires_at END
     WHERE id = ?1`,
  )
    .bind(
      id,
      input.status ?? "active",
      input.statusReason ?? null,
      input.paused ? 1 : 0,
      input.phase ?? "incremental",
      input.lastTickAt ?? null,
      input.nextTickAt ?? 0,
      input.accessToken === null ? 1 : 0,
    )
    .run();
  const account = await getAccount(env.DB, id);
  if (!account) throw new Error("seedAccount failed");
  return account;
}

type PerIndex<T> = T | ((i: number) => T);
const at = <T>(value: PerIndex<T> | undefined, i: number): T | undefined =>
  typeof value === "function" ? (value as (i: number) => T)(i) : value;

export async function seedMessages(
  accountId: string,
  n: number,
  overrides?: PerIndex<Partial<MessageInsert>>,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    const o = at(overrides, i) ?? {};
    const m: MessageInsert = {
      providerMsgId: `msg-${seq}`,
      threadId: `thread-${seq}`,
      internetMessageId: `<m${seq}@example.com>`,
      sender: "news@shop.example.com",
      senderName: "Shop News",
      senderDomain: "example.com",
      subject: `Weekly deals ${seq}`,
      snippet: "Synthetic snippet for tests",
      receivedAt: SEED_NOW - (i + 1) * HOUR,
      isRead: false,
      signalsJson: JSON.stringify(makeSignals()),
      webLink: null,
      createdAt: SEED_NOW - (i + 1) * HOUR,
      ...o,
    };
    await insertMessageStmt(env.DB, accountId, m).run();
    const row = await env.DB.prepare("SELECT id FROM messages WHERE account_id = ?1 AND provider_msg_id = ?2")
      .bind(accountId, m.providerMsgId)
      .first<{ id: number }>();
    if (!row) throw new Error("seedMessages failed");
    ids.push(row.id);
  }
  return ids;
}

export interface SeedSuggestionOptions {
  sender?: string;
  senderName?: string | null;
  senderDomain?: string;
  subject?: string | null;
  snippet?: string | null;
  receivedAt?: number;
  isRead?: boolean;
  webLink?: string | null;
  signals?: Partial<Signals>;
  status?: SuggestionStatus;
  action?: SuggestedAction;
  confidence?: number;
  distribution?: { delete: number; archive: number; keep: number; unsure: number } | null;
  margin?: number | null;
  ceiling?: Ceiling;
  ceilingApplied?: boolean;
  reasons?: Reason[];
  modelVersion?: string | null;
  policyVersion?: number;
  createdAt?: number;
  finalAction?: ActionKind | null;
  decidedVia?: "approve" | "override" | "cleanup" | null;
  batchId?: number | null;
  labelId?: number | null;
}

export async function seedSuggestions(
  accountId: string,
  n: number,
  opts?: PerIndex<SeedSuggestionOptions>,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = at(opts, i) ?? {};
    const sender = o.sender ?? "news@shop.example.com";
    const senderDomain = o.senderDomain ?? "example.com";
    const [messageId] = await seedMessages(accountId, 1, {
      sender,
      senderDomain,
      senderName: o.senderName === undefined ? "Shop News" : o.senderName,
      subject: o.subject === undefined ? `Weekly deals ${i}` : o.subject,
      snippet: o.snippet === undefined ? "Synthetic snippet for tests" : o.snippet,
      receivedAt: o.receivedAt ?? SEED_NOW - (i + 1) * HOUR,
      isRead: o.isRead ?? false,
      webLink: o.webLink ?? null,
      signalsJson: JSON.stringify(makeSignals({ senderAddress: sender, senderDomain, ...o.signals })),
    });
    if (messageId === undefined) throw new Error("seedSuggestions failed");
    const action = o.action ?? "delete";
    const confidence = o.confidence ?? 0.9;
    const dist =
      o.distribution === undefined
        ? { delete: action === "delete" ? confidence : 0.05, archive: 0.03, keep: 0.02, unsure: 0 }
        : o.distribution;
    const status = o.status ?? "pending";
    const providerMsgId = (await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1")
      .bind(messageId)
      .first<{ provider_msg_id: string }>())?.provider_msg_id;
    if (!providerMsgId) throw new Error("seedSuggestions failed");
    const createdAt = o.createdAt ?? SEED_NOW - 60_000;
    await insertSuggestionStmt(env.DB, accountId, providerMsgId, {
      sender,
      senderDomain,
      status: status === "awaiting_model" ? "awaiting_model" : "pending",
      action: status === "awaiting_model" ? null : action,
      confidence: status === "awaiting_model" ? null : confidence,
      pDelete: dist?.delete ?? null,
      pArchive: dist?.archive ?? null,
      pKeep: dist?.keep ?? null,
      pUnsure: dist?.unsure ?? null,
      modelPDelete: dist?.delete ?? null,
      margin: o.margin === undefined ? 0.5 : o.margin,
      importance: 0.5,
      flagsJson: JSON.stringify({ isRecord: 0.05, isExpired: 0.1, isFromHuman: 0.05 }),
      ceiling: o.ceiling ?? "delete",
      ceilingApplied: o.ceilingApplied ?? false,
      reasonsJson: JSON.stringify(o.reasons ?? [{ code: "list_unsubscribe", params: {} }]),
      modelVersion: o.modelVersion === undefined ? "fake/fake-1" : o.modelVersion,
      policyVersion: o.policyVersion ?? 1,
      decisionAttempts: 0,
      retryAfter: null,
      createdAt,
      expiresAt: createdAt + 90 * 24 * HOUR,
    }).run();
    if (status !== "pending" && status !== "awaiting_model") {
      await env.DB.prepare(
        `UPDATE suggestions SET status = ?2, final_action = ?3, decided_via = ?4, batch_id = ?5, label_id = ?6,
           decided_at = CASE WHEN ?3 IS NULL THEN NULL ELSE ?7 END
         WHERE message_id = ?1`,
      )
        .bind(messageId, status, o.finalAction ?? null, o.decidedVia ?? null, o.batchId ?? null, o.labelId ?? null, createdAt)
        .run();
    }
    ids.push(messageId);
  }
  return ids;
}

export interface SeedLabelOptions {
  sender?: string;
  senderDomain?: string;
  suggestedAction?: SuggestedAction;
  ownerAction?: ActionKind;
  source?: LabelSource;
  pDelete?: number | null;
  createdAt?: number;
  messageId?: number | null;
}

export async function seedLabels(accountId: string, n: number, opts?: PerIndex<SeedLabelOptions>): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = at(opts, i) ?? {};
    const res = await insertLabelStmt(env.DB, accountId, {
      messageId: o.messageId ?? null,
      sender: o.sender ?? "news@shop.example.com",
      senderDomain: o.senderDomain ?? "example.com",
      subjectTrunc: "Weekly deals",
      suggestedAction: o.suggestedAction ?? "delete",
      ownerAction: o.ownerAction ?? "delete",
      source: o.source ?? "approve",
      pDelete: o.pDelete === undefined ? 0.9 : o.pDelete,
      margin: 0.5,
      ceiling: "delete",
      modelVersion: "fake/fake-1",
      policyVersion: 1,
      now: o.createdAt ?? SEED_NOW - i * 1_000,
    }).run();
    ids.push(Number(res.meta.last_row_id));
  }
  return ids;
}

export async function getSuggestionRow(id: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM suggestions WHERE message_id = ?1").bind(id).first<Record<string, unknown>>();
}
```

- [ ] **Step 2: Write the failing repository tests**

`app/test/worker/db/repositories.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  disconnectAccountStmt,
  findOpenAccountByEmail,
  getAccount,
  listAccounts,
  markAccountStatusStmt,
  setInboxEstimateStmt,
  setPausedStmt,
  toAccountView,
} from "../../../src/worker/db/accounts.ts";
import { claimUndoStmt, getBatch, insertBatchStmt, resetUndoStmt } from "../../../src/worker/db/batches.ts";
import { undoLabelStmt } from "../../../src/worker/db/labels.ts";
import { insertMessageStmt, updateProviderMsgIdStmt } from "../../../src/worker/db/messages.ts";
import { addPriorDelta, priorStatements } from "../../../src/worker/db/priors.ts";
import {
  countOpenByAccount,
  decodeGroupKey,
  dismissOpenStmt,
  encodeGroupKey,
} from "../../../src/worker/db/suggestions.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedLabels, seedMessages, seedSuggestions } from "../helpers/seed.ts";

describe("accounts repository", () => {
  it("maps rows, hides disconnected accounts and finds by provider and email", async () => {
    const a = await seedAccount({ provider: "gmail", email: "one@example.com" });
    const b = await seedAccount({ provider: "outlook", email: "two@example.com", archiveFolderId: null });
    await seedAccount({ status: "disconnected" });
    expect(a.refreshToken?.iv.length).toBe(12);
    expect(a.grantedScopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    const visible = await listAccounts(env.DB, { includeDisconnected: false });
    expect(visible.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect((await listAccounts(env.DB, { includeDisconnected: true })).length).toBe(3);
    expect((await findOpenAccountByEmail(env.DB, "gmail", "one@example.com"))?.id).toBe(a.id);
    expect(await findOpenAccountByEmail(env.DB, "outlook", "one@example.com")).toBeNull();
    const view = toAccountView(b, { pending: 2, awaitingModel: 1 });
    expect(view).toMatchObject({
      id: b.id,
      provider: "outlook",
      status: "active",
      paused: false,
      archiveSupported: false,
      sync: { pendingCount: 2, awaitingModelCount: 1, nextTickAt: null, phase: "incremental", inboxEstimate: null },
    });
  });

  it("pauses, marks status and disconnects (wiping tokens and dismissing open suggestions)", async () => {
    const a = await seedAccount();
    const [pending, awaiting, executed] = [
      ...(await seedSuggestions(a.id, 1)),
      ...(await seedSuggestions(a.id, 1, { status: "awaiting_model" })),
      ...(await seedSuggestions(a.id, 1, { status: "executed", finalAction: "delete" })),
    ];
    await setPausedStmt(env.DB, a.id, true, SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.paused).toBe(true);
    await setInboxEstimateStmt(env.DB, a.id, 12_345, SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.inboxEstimate).toBe(12_345);
    await markAccountStatusStmt(env.DB, a.id, "needs_reauth", "invalid_grant", SEED_NOW).run();
    expect((await getAccount(env.DB, a.id))?.statusReason).toBe("invalid_grant");
    await env.DB.batch([disconnectAccountStmt(env.DB, a.id, SEED_NOW), dismissOpenStmt(env.DB, a.id, SEED_NOW)]);
    const after = await getAccount(env.DB, a.id);
    expect(after).toMatchObject({ status: "disconnected", refreshToken: null, accessToken: null, accessExpiresAt: null });
    expect((await getSuggestionRow(pending ?? 0))?.["status"]).toBe("dismissed");
    expect((await getSuggestionRow(awaiting ?? 0))?.["status"]).toBe("dismissed");
    expect((await getSuggestionRow(executed ?? 0))?.["status"]).toBe("executed");
  });
});

describe("messages and suggestions", () => {
  it("ignores duplicate provider ids and updates moved ids", async () => {
    const a = await seedAccount();
    const [id] = await seedMessages(a.id, 1, { providerMsgId: "dup-1" });
    const again = await insertMessageStmt(env.DB, a.id, {
      providerMsgId: "dup-1",
      threadId: null,
      internetMessageId: null,
      sender: "",
      senderName: null,
      senderDomain: "",
      subject: null,
      snippet: null,
      receivedAt: 0,
      isRead: false,
      signalsJson: "{}",
      webLink: null,
      createdAt: 0,
    }).run();
    expect(again.meta.changes).toBe(0);
    await updateProviderMsgIdStmt(env.DB, a.id, id ?? 0, "moved-1").run();
    const row = await env.DB.prepare("SELECT provider_msg_id FROM messages WHERE id = ?1").bind(id).first();
    expect(row).toEqual({ provider_msg_id: "moved-1" });
  });

  it("counts open suggestions per account", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await seedSuggestions(a.id, 3);
    await seedSuggestions(a.id, 2, { status: "awaiting_model" });
    await seedSuggestions(b.id, 1, { status: "executed", finalAction: "keep" });
    const counts = await countOpenByAccount(env.DB, [a.id, b.id]);
    expect(counts.get(a.id)).toEqual({ pending: 3, awaitingModel: 2 });
    expect(counts.get(b.id)).toEqual({ pending: 0, awaitingModel: 0 });
    expect((await countOpenByAccount(env.DB, [])).size).toBe(0);
  });

  it("encodes and decodes group keys", () => {
    const key = encodeGroupKey("acc_0000000000000001", "news@example.com", "delete");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGroupKey(key)).toEqual({ accountId: "acc_0000000000000001", sender: "news@example.com", action: "delete" });
    expect(decodeGroupKey("garbage")).toBeNull();
    expect(decodeGroupKey(encodeGroupKey("acc_0000000000000001", "x@example.com", "delete").slice(0, -3))).toBeNull();
  });
});

describe("labels, priors and batches", () => {
  it("rewrites a label on undo", async () => {
    const a = await seedAccount();
    const [labelId] = await seedLabels(a.id, 1, { ownerAction: "delete" });
    await undoLabelStmt(env.DB, a.id, labelId ?? 0, SEED_NOW).run();
    const row = await env.DB.prepare("SELECT owner_action, source FROM labels WHERE id = ?1").bind(labelId).first();
    expect(row).toEqual({ owner_action: "keep", source: "undo" });
  });

  it("aggregates prior deltas per key and clamps at zero", async () => {
    const a = await seedAccount();
    const map = new Map();
    addPriorDelta(map, a.id, "news@example.com", "example.com", { deletes: 1, keeps: 0 });
    addPriorDelta(map, a.id, "news@example.com", "example.com", { deletes: 1, keeps: 0 });
    addPriorDelta(map, a.id, "", "example.com", { deletes: 0, keeps: 1 });
    await env.DB.batch(priorStatements(env.DB, map, SEED_NOW));
    const rows = await env.DB.prepare("SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key")
      .bind(a.id)
      .run();
    expect(rows.results).toEqual([
      { key: "@example.com", deletes: 2, keeps: 1 },
      { key: "news@example.com", deletes: 2, keeps: 0 },
    ]);
    const undo = new Map();
    addPriorDelta(undo, a.id, "news@example.com", "example.com", { deletes: -3, keeps: 1 });
    await env.DB.batch(priorStatements(env.DB, undo, SEED_NOW));
    const after = await env.DB.prepare("SELECT deletes, keeps FROM sender_priors WHERE account_id = ?1 AND key = ?2")
      .bind(a.id, "news@example.com")
      .first();
    expect(after).toEqual({ deletes: 0, keeps: 1 });
  });

  it("inserts a batch and claims undo once", async () => {
    const res = await insertBatchStmt(env.DB, {
      kind: "approve",
      suggestionIds: [1, 2],
      requestedCount: 2,
      executedCount: 2,
      failedCount: 0,
      createdAt: SEED_NOW,
      undoExpiresAt: SEED_NOW + 86_400_000,
    }).first<{ id: number }>();
    const id = res?.id ?? 0;
    expect(await getBatch(env.DB, id)).toMatchObject({ kind: "approve", suggestionIds: [1, 2], undoneAt: null });
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 1).run()).results).toHaveLength(1);
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 2).run()).results).toHaveLength(0);
    await resetUndoStmt(env.DB, id, SEED_NOW + 1).run();
    expect((await getBatch(env.DB, id))?.undoneAt).toBeNull();
    expect((await claimUndoStmt(env.DB, id, SEED_NOW + 86_400_001).run()).results).toHaveLength(0);
  });
});
```

`app/test/worker/db-isolation.test.ts`:

```ts
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const sources = import.meta.glob(
  [
    "../../src/worker/db/*.ts",
    "../../src/worker/actions/*.ts",
    "../../src/worker/routes/*.ts",
    "../../src/worker/oauth/*.ts",
    "../../src/worker/scan/token-source.ts",
    "../../src/worker/scan/providers.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const OWNED = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(messages|suggestions|labels|sender_priors|senders|correspondents|sent_threads)\b/i;
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
const SCOPED = /account_id\s*=\s*\?|account_id IN \(/;
const EXEMPT = /--\s*isolation-exempt:\s*([a-z_]+)/;
const ALLOWED_EXEMPTIONS = new Set(["calibration"]);

function literals(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"/g)) {
    const text = m[1] ?? m[2] ?? "";
    if (SQL_START.test(text)) out.push(text);
  }
  return out;
}

function isScoped(sql: string): boolean {
  if (/^\s*INSERT\b/i.test(sql)) {
    const columns = /^\s*INSERT\s+INTO\s+\w+\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? "";
    return /\baccount_id\b/.test(columns);
  }
  return SCOPED.test(sql);
}

const dbFiles = Object.entries(sources).filter(([path]) => path.includes("/worker/db/"));
const otherFiles = Object.entries(sources).filter(([path]) => !path.includes("/worker/db/"));

describe("D1 account isolation (contracts 6.1)", () => {
  it("finds the repository SQL", () => {
    const count = dbFiles.flatMap(([, src]) => literals(src)).length;
    expect(count).toBeGreaterThan(20);
  });

  it("scopes every statement on account-owned tables by account_id", () => {
    const offenders: string[] = [];
    for (const [path, src] of dbFiles) {
      for (const sql of literals(src)) {
        if (!OWNED.test(sql)) continue;
        const exempt = EXEMPT.exec(sql)?.[1];
        if (exempt !== undefined) {
          if (!ALLOWED_EXEMPTIONS.has(exempt)) offenders.push(`${path}: unknown exemption ${exempt}`);
          continue;
        }
        if (!isScoped(sql)) offenders.push(`${path}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("requires accountId or accountIds on exported functions that touch account-owned tables", () => {
    const offenders: string[] = [];
    for (const [path, src] of dbFiles) {
      for (const block of src.split(/\n(?=export )/)) {
        const header = /^export (?:async )?function (\w+)(?:<[^>]*>)?\(([^)]*)\)/.exec(block);
        if (!header) continue;
        const touches = literals(block).some((sql) => OWNED.test(sql) && !EXEMPT.test(sql));
        if (touches && !/\baccountIds?\b/.test(header[2] ?? "")) offenders.push(`${path}: ${header[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps account-owned SQL out of routes, actions, oauth and scan helpers", () => {
    const offenders = otherFiles.flatMap(([path, src]) =>
      literals(src).filter((sql) => OWNED.test(sql)).map(() => path),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db/repositories.test.ts test/worker/db-isolation.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/db/accounts.ts` for the repository test; the isolation test fails on `finds the repository SQL` (count is below 20).

- [ ] **Step 4: Implement `app/src/worker/db/accounts.ts`**

```ts
import type { ProviderKind } from "@clearbox/core";
import type { AccountPhase, AccountStatus, AccountSync, AccountView } from "../../shared/api.ts";
import type { EncryptedValue } from "../crypto/aead.ts";
import { bytesFromBlob } from "../crypto/base64.ts";
import { flag, toIso, toIsoOrNull } from "./sql.ts";

export type AccountRowStatus = "active" | "needs_reauth" | "config_error" | "disconnected";

export interface AccountRow {
  id: string;
  provider: ProviderKind;
  email: string;
  provider_user_id: string;
  status: AccountRowStatus;
  status_reason: string | null;
  paused: number;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
  granted_scopes: string;
  owner_aliases_json: string;
  archive_folder_id: string | null;
  phase: AccountPhase;
  sent_cursor: string | null;
  sent_scanned: number;
  backfill_cursor: string | null;
  backfill_done: number;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
  page_size: number;
  attempts: number;
  backoff_until: number | null;
  next_tick_at: number;
  last_tick_at: number | null;
  tick_started_at: number | null;
  tick_finished_at: number | null;
  last_error: string | null;
  messages_ingested: number;
  inbox_estimate: number | null;
  created_at: number;
  updated_at: number;
}

export interface Account {
  id: string;
  provider: ProviderKind;
  email: string;
  providerUserId: string;
  status: AccountRowStatus;
  statusReason: string | null;
  paused: boolean;
  keyVersion: number;
  refreshToken: EncryptedValue | null;
  accessToken: EncryptedValue | null;
  accessExpiresAt: number | null;
  grantedScopes: string[];
  ownerAliases: string[];
  archiveFolderId: string | null;
  phase: AccountPhase;
  sentCursor: string | null;
  sentScanned: number;
  backfillCursor: string | null;
  backfillDone: boolean;
  incrementalCursor: string;
  lastIncrementalAt: number | null;
  watermarkReceivedAt: number | null;
  pageSize: number;
  attempts: number;
  backoffUntil: number | null;
  nextTickAt: number;
  lastTickAt: number | null;
  tickStartedAt: number | null;
  tickFinishedAt: number | null;
  lastError: string | null;
  messagesIngested: number;
  /** rev 2.1 A4: provider inbox total, written by plan 04. */
  inboxEstimate: number | null;
  createdAt: number;
  updatedAt: number;
}

function pair(ciphertext: unknown, iv: unknown): EncryptedValue | null {
  const c = bytesFromBlob(ciphertext);
  const i = bytesFromBlob(iv);
  return c && i ? { ciphertext: c, iv: i } : null;
}

export function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    providerUserId: row.provider_user_id,
    status: row.status,
    statusReason: row.status_reason,
    paused: flag(row.paused),
    keyVersion: row.key_version,
    refreshToken: pair(row.enc_refresh_token, row.refresh_iv),
    accessToken: pair(row.enc_access_token, row.access_iv),
    accessExpiresAt: row.access_expires_at,
    grantedScopes: row.granted_scopes.split(" ").filter((s) => s !== ""),
    ownerAliases: JSON.parse(row.owner_aliases_json) as string[],
    archiveFolderId: row.archive_folder_id,
    phase: row.phase,
    sentCursor: row.sent_cursor,
    sentScanned: row.sent_scanned,
    backfillCursor: row.backfill_cursor,
    backfillDone: flag(row.backfill_done),
    incrementalCursor: row.incremental_cursor,
    lastIncrementalAt: row.last_incremental_at,
    watermarkReceivedAt: row.watermark_received_at,
    pageSize: row.page_size,
    attempts: row.attempts,
    backoffUntil: row.backoff_until,
    nextTickAt: row.next_tick_at,
    lastTickAt: row.last_tick_at,
    tickStartedAt: row.tick_started_at,
    tickFinishedAt: row.tick_finished_at,
    lastError: row.last_error,
    messagesIngested: row.messages_ingested,
    inboxEstimate: row.inbox_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
  const row = await db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function listAccounts(db: D1Database, opts: { includeDisconnected: boolean }): Promise<Account[]> {
  const res = await db
    .prepare("SELECT * FROM accounts WHERE (?1 = 1 OR status <> 'disconnected') ORDER BY created_at, id")
    .bind(opts.includeDisconnected ? 1 : 0)
    .run<AccountRow>();
  return res.results.map(mapAccount);
}

export async function findOpenAccountByEmail(db: D1Database, provider: ProviderKind, email: string): Promise<Account | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE provider = ?1 AND email = ?2 AND status <> 'disconnected'")
    .bind(provider, email)
    .first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export interface NewAccount {
  id: string;
  provider: ProviderKind;
  email: string;
  providerUserId: string;
  grantedScopes: readonly string[];
  ownerAliases: readonly string[];
  archiveFolderId: string | null;
  incrementalCursor: string;
  keyVersion: number;
  refreshToken: EncryptedValue;
  accessToken: EncryptedValue;
  accessExpiresAt: number;
  now: number;
}

export function insertAccountStmt(db: D1Database, a: NewAccount): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounts (id, provider, email, provider_user_id, status, key_version, enc_refresh_token, refresh_iv,
         enc_access_token, access_iv, access_expires_at, granted_scopes, owner_aliases_json, archive_folder_id,
         phase, incremental_cursor, next_tick_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'sent_backfill', ?14, 0, ?15, ?15)`,
    )
    .bind(
      a.id,
      a.provider,
      a.email,
      a.providerUserId,
      a.keyVersion,
      a.refreshToken.ciphertext,
      a.refreshToken.iv,
      a.accessToken.ciphertext,
      a.accessToken.iv,
      a.accessExpiresAt,
      a.grantedScopes.join(" "),
      JSON.stringify(a.ownerAliases),
      a.archiveFolderId,
      a.incrementalCursor,
      a.now,
    );
}

export interface ReconnectUpdate {
  providerUserId: string;
  keyVersion: number;
  refreshToken: EncryptedValue;
  accessToken: EncryptedValue;
  accessExpiresAt: number;
  grantedScopes: readonly string[];
  ownerAliases: readonly string[];
  archiveFolderId: string | null;
  now: number;
}

/** Contracts 7.13 step 7: new tokens and status active; cursors are kept. */
export function reconnectAccountStmt(db: D1Database, id: string, u: ReconnectUpdate): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET provider_user_id = ?2, status = 'active', status_reason = NULL, key_version = ?3,
         enc_refresh_token = ?4, refresh_iv = ?5, enc_access_token = ?6, access_iv = ?7, access_expires_at = ?8,
         granted_scopes = ?9, owner_aliases_json = ?10, archive_folder_id = ?11, attempts = 0, backoff_until = NULL,
         last_error = NULL, updated_at = ?12
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(
      id,
      u.providerUserId,
      u.keyVersion,
      u.refreshToken.ciphertext,
      u.refreshToken.iv,
      u.accessToken.ciphertext,
      u.accessToken.iv,
      u.accessExpiresAt,
      u.grantedScopes.join(" "),
      JSON.stringify(u.ownerAliases),
      u.archiveFolderId,
      u.now,
    );
}

export function setPausedStmt(db: D1Database, id: string, paused: boolean, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE accounts SET paused = ?2, updated_at = ?3 WHERE id = ?1 AND status <> 'disconnected'")
    .bind(id, paused ? 1 : 0, now);
}

export function disconnectAccountStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET status = 'disconnected', enc_refresh_token = NULL, refresh_iv = NULL,
         enc_access_token = NULL, access_iv = NULL, access_expires_at = NULL, updated_at = ?2
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(id, now);
}

export function markAccountStatusStmt(
  db: D1Database,
  id: string,
  status: "needs_reauth" | "config_error",
  reason: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare("UPDATE accounts SET status = ?2, status_reason = ?3, updated_at = ?4 WHERE id = ?1 AND status <> 'disconnected'")
    .bind(id, status, reason, now);
}

export function accessTokenUpdateStmt(
  db: D1Database,
  id: string,
  access: EncryptedValue,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE accounts SET enc_access_token = ?2, access_iv = ?3, access_expires_at = ?4, updated_at = ?5 WHERE id = ?1 AND status <> 'disconnected'",
    )
    .bind(id, access.ciphertext, access.iv, expiresAt, now);
}

export function tokensUpdateStmt(
  db: D1Database,
  id: string,
  refresh: EncryptedValue,
  access: EncryptedValue,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE accounts SET enc_refresh_token = ?2, refresh_iv = ?3, enc_access_token = ?4, access_iv = ?5,
         access_expires_at = ?6, updated_at = ?7
       WHERE id = ?1 AND status <> 'disconnected'`,
    )
    .bind(id, refresh.ciphertext, refresh.iv, access.ciphertext, access.iv, expiresAt, now);
}

/** rev 2.1 A4: written by plan 04 (first tick, then at most daily during backfill). */
export function setInboxEstimateStmt(db: D1Database, id: string, estimate: number | null, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE accounts SET inbox_estimate = ?2, updated_at = ?3 WHERE id = ?1 AND status <> 'disconnected'")
    .bind(id, estimate, now);
}

export interface OpenCounts {
  pending: number;
  awaitingModel: number;
}

export function toAccountSync(a: Account, counts: OpenCounts): AccountSync {
  return {
    phase: a.phase,
    backfillDone: a.backfillDone,
    messagesIngested: a.messagesIngested,
    pendingCount: counts.pending,
    awaitingModelCount: counts.awaitingModel,
    lastTickAt: toIsoOrNull(a.lastTickAt),
    nextTickAt: a.nextTickAt > 0 ? toIso(a.nextTickAt) : null,
    backoffUntil: toIsoOrNull(a.backoffUntil),
    lastErrorCode: a.lastError,
    pageSize: a.pageSize,
    inboxEstimate: a.inboxEstimate,
  };
}

export function toAccountView(a: Account, counts: OpenCounts): AccountView {
  if (a.status === "disconnected") throw new Error("disconnected accounts have no view");
  const status: AccountStatus = a.status;
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    status,
    statusReason: a.statusReason,
    paused: a.paused,
    archiveSupported: a.provider === "gmail" || a.archiveFolderId !== null,
    sync: toAccountSync(a, counts),
    createdAt: toIso(a.createdAt),
  };
}
```

- [ ] **Step 5: Implement `app/src/worker/db/messages.ts`**

```ts
export interface MessageInsert {
  providerMsgId: string;
  threadId: string | null;
  internetMessageId: string | null;
  /** Lowercased address, "" when unknown. */
  sender: string;
  senderName: string | null;
  senderDomain: string;
  /** At most MESSAGE_SUBJECT_MAX_CHARS. */
  subject: string | null;
  /** null when policy.storeSnippets is false. */
  snippet: string | null;
  receivedAt: number;
  isRead: boolean;
  signalsJson: string;
  webLink: string | null;
  createdAt: number;
}

export function insertMessageStmt(db: D1Database, accountId: string, m: MessageInsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO messages (account_id, provider_msg_id, thread_id, internet_message_id, sender, sender_name,
         sender_domain, subject, snippet, received_at, is_read, signals_json, web_link, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (account_id, provider_msg_id) DO NOTHING`,
    )
    .bind(
      accountId,
      m.providerMsgId,
      m.threadId,
      m.internetMessageId,
      m.sender,
      m.senderName,
      m.senderDomain,
      m.subject,
      m.snippet,
      m.receivedAt,
      m.isRead ? 1 : 0,
      m.signalsJson,
      m.webLink,
      m.createdAt,
    );
}

/** Graph move returns a new immutable id (contracts 7.7). */
export function updateProviderMsgIdStmt(
  db: D1Database,
  accountId: string,
  messageId: number,
  providerMsgId: string,
): D1PreparedStatement {
  return db
    .prepare("UPDATE messages SET provider_msg_id = ?3 WHERE account_id = ?1 AND id = ?2")
    .bind(accountId, messageId, providerMsgId);
}
```

- [ ] **Step 6: Implement `app/src/worker/db/suggestions.ts` (base part)**

```ts
import { DECIDED_TTL_MS, SUGGESTED_ACTIONS } from "@clearbox/core";
import type { Ceiling, SuggestedAction } from "@clearbox/core";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import type { OpenCounts } from "./accounts.ts";
import { placeholders } from "./sql.ts";

export interface SuggestionInsert {
  sender: string;
  senderDomain: string;
  status: "awaiting_model" | "pending";
  action: SuggestedAction | null;
  confidence: number | null;
  pDelete: number | null;
  pArchive: number | null;
  pKeep: number | null;
  pUnsure: number | null;
  modelPDelete: number | null;
  margin: number | null;
  importance: number | null;
  flagsJson: string | null;
  ceiling: Ceiling;
  ceilingApplied: boolean;
  reasonsJson: string;
  modelVersion: string | null;
  policyVersion: number;
  decisionAttempts: number;
  retryAfter: number | null;
  createdAt: number;
  expiresAt: number;
}

/** Contracts 8.2: suggestion row keyed by the message id of (account, provider id). */
export function insertSuggestionStmt(
  db: D1Database,
  accountId: string,
  providerMsgId: string,
  s: SuggestionInsert,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, p_delete,
         p_archive, p_keep, p_unsure, model_p_delete, margin, importance, flags_json, ceiling, ceiling_applied,
         reasons_json, model_version, policy_version, decision_attempts, retry_after, created_at, updated_at, expires_at)
       SELECT id, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23, ?24
       FROM messages WHERE account_id = ?1 AND provider_msg_id = ?2
       ON CONFLICT (message_id) DO NOTHING`,
    )
    .bind(
      accountId,
      providerMsgId,
      s.sender,
      s.senderDomain,
      s.status,
      s.action,
      s.confidence,
      s.pDelete,
      s.pArchive,
      s.pKeep,
      s.pUnsure,
      s.modelPDelete,
      s.margin,
      s.importance,
      s.flagsJson,
      s.ceiling,
      s.ceilingApplied ? 1 : 0,
      s.reasonsJson,
      s.modelVersion,
      s.policyVersion,
      s.decisionAttempts,
      s.retryAfter,
      s.createdAt,
      s.expiresAt,
    );
}

export function countOpenByAccountStmt(db: D1Database, accountIds: readonly string[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT account_id, SUM(status = 'pending') AS pending, SUM(status = 'awaiting_model') AS awaiting
       FROM suggestions
       WHERE account_id IN (${placeholders(accountIds.length)}) AND (status = 'pending' OR status = 'awaiting_model')
       GROUP BY account_id`,
    )
    .bind(...accountIds);
}

export async function countOpenByAccount(
  db: D1Database,
  accountIds: readonly string[],
): Promise<Map<string, OpenCounts>> {
  const out = new Map<string, OpenCounts>(accountIds.map((id) => [id, { pending: 0, awaitingModel: 0 }]));
  if (accountIds.length === 0) return out;
  const res = await countOpenByAccountStmt(db, accountIds).run<{ account_id: string; pending: number; awaiting: number }>();
  for (const r of res.results) out.set(r.account_id, { pending: r.pending, awaitingModel: r.awaiting });
  return out;
}

/** Disconnect: every open suggestion of the account becomes dismissed (contracts 7.5). */
export function dismissOpenStmt(db: D1Database, accountId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE suggestions SET status = 'dismissed', updated_at = ?2, expires_at = ?2 + ?3
       WHERE account_id = ?1 AND (status = 'pending' OR status = 'awaiting_model')`,
    )
    .bind(accountId, now, DECIDED_TTL_MS);
}

const GroupKeySchema = z.tuple([z.string().regex(/^acc_[0-9a-f]{16}$/), z.string().max(320), z.enum(SUGGESTED_ACTIONS)]);

/** Contracts 7.6: base64url(JSON.stringify([accountId, sender, action])). */
export function encodeGroupKey(accountId: string, sender: string, action: SuggestedAction): string {
  return bytesToBase64Url(utf8(JSON.stringify([accountId, sender, action])));
}

export function decodeGroupKey(key: string): { accountId: string; sender: string; action: SuggestedAction } | null {
  try {
    const parsed = GroupKeySchema.safeParse(JSON.parse(fromUtf8(base64UrlToBytes(key))));
    if (!parsed.success) return null;
    const [accountId, sender, action] = parsed.data;
    return { accountId, sender, action };
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Implement `app/src/worker/db/labels.ts`**

```ts
import type { ActionKind, Ceiling, SuggestedAction } from "@clearbox/core";
import { placeholders } from "./sql.ts";

export type LabelSource = "approve" | "override" | "cleanup" | "undo";

export interface LabelInsert {
  messageId: number | null;
  sender: string;
  senderDomain: string;
  /** <= LABEL_SUBJECT_MAX_CHARS; null when policy.labelSubjects is false. */
  subjectTrunc: string | null;
  suggestedAction: SuggestedAction;
  ownerAction: ActionKind;
  source: LabelSource;
  pDelete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  modelVersion: string | null;
  policyVersion: number;
  now: number;
}

export function insertLabelStmt(db: D1Database, accountId: string, l: LabelInsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action, owner_action,
         source, p_delete, margin, ceiling, model_version, policy_version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    )
    .bind(
      accountId,
      l.messageId,
      l.sender,
      l.senderDomain,
      l.subjectTrunc,
      l.suggestedAction,
      l.ownerAction,
      l.source,
      l.pDelete,
      l.margin,
      l.ceiling,
      l.modelVersion,
      l.policyVersion,
      l.now,
    );
}

/** Contracts 7.8: a restored item's label becomes keep / undo. */
export function undoLabelStmt(db: D1Database, accountId: string, labelId: number, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE labels SET owner_action = 'keep', source = 'undo', updated_at = ?3 WHERE account_id = ?1 AND id = ?2")
    .bind(accountId, labelId, now);
}

export function labelStatsStmt(db: D1Database, accountIds: readonly string[], since: number): D1PreparedStatement {
  const n = accountIds.length;
  return db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?${n + 1}), 0) AS recent
       FROM labels WHERE account_id IN (${placeholders(n)})`,
    )
    .bind(...accountIds, since);
}

/** Contracts 7.10: among the newest `window` labels with suggested_action = 'delete'. */
export function deletePrecisionStmt(db: D1Database, accountIds: readonly string[], window: number): D1PreparedStatement {
  const n = accountIds.length;
  return db
    .prepare(
      `SELECT COUNT(*) AS decided, COALESCE(SUM(owner_action = 'delete'), 0) AS deleted FROM (
         SELECT owner_action FROM labels
         WHERE account_id IN (${placeholders(n)}) AND suggested_action = 'delete'
         ORDER BY id DESC LIMIT ?${n + 1}
       )`,
    )
    .bind(...accountIds, window);
}
```

- [ ] **Step 8: Implement `app/src/worker/db/priors.ts`**

```ts
import { priorKeyForDomain, priorKeyForSender } from "@clearbox/core";
import type { PriorCounts } from "@clearbox/core";

export interface PriorDeltaEntry {
  accountId: string;
  key: string;
  deletes: number;
  keeps: number;
}

export type PriorDeltaMap = Map<string, PriorDeltaEntry>;

function bump(map: PriorDeltaMap, accountId: string, key: string, delta: PriorCounts): void {
  const id = `${accountId}\u001f${key}`;
  const entry = map.get(id) ?? { accountId, key, deletes: 0, keeps: 0 };
  entry.deletes += delta.deletes;
  entry.keeps += delta.keeps;
  map.set(id, entry);
}

/** Applies one owner decision delta to the sender key and the domain key (skipping unknown ones). */
export function addPriorDelta(
  map: PriorDeltaMap,
  accountId: string,
  sender: string,
  domain: string,
  delta: PriorCounts,
): void {
  if (sender !== "") bump(map, accountId, priorKeyForSender(sender), delta);
  if (domain !== "") bump(map, accountId, priorKeyForDomain(domain), delta);
}

/** Upsert with clamping at zero; negative deltas come from undo. */
export function priorUpsertStmt(
  db: D1Database,
  accountId: string,
  key: string,
  delta: PriorCounts,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at)
       VALUES (?1, ?2, MAX(0, ?3), MAX(0, ?4), ?5)
       ON CONFLICT (account_id, key) DO UPDATE SET
         deletes = MAX(0, sender_priors.deletes + ?3),
         keeps = MAX(0, sender_priors.keeps + ?4),
         updated_at = ?5`,
    )
    .bind(accountId, key, delta.deletes, delta.keeps, now);
}

export function priorStatements(db: D1Database, map: PriorDeltaMap, now: number): D1PreparedStatement[] {
  return [...map.values()]
    .filter((e) => e.deletes !== 0 || e.keeps !== 0)
    .map((e) => priorUpsertStmt(db, e.accountId, e.key, { deletes: e.deletes, keeps: e.keeps }, now));
}
```

- [ ] **Step 9: Implement `app/src/worker/db/batches.ts`**

```ts
export type BatchKind = "approve" | "override" | "cleanup";

export interface BatchRow {
  id: number;
  created_at: number;
  kind: BatchKind;
  suggestion_ids_json: string;
  requested_count: number;
  executed_count: number;
  failed_count: number;
  undo_expires_at: number;
  undone_at: number | null;
}

export interface ActionBatch {
  id: number;
  createdAt: number;
  kind: BatchKind;
  suggestionIds: number[];
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  undoExpiresAt: number;
  undoneAt: number | null;
}

export function mapBatch(row: BatchRow): ActionBatch {
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    suggestionIds: JSON.parse(row.suggestion_ids_json) as number[],
    requestedCount: row.requested_count,
    executedCount: row.executed_count,
    failedCount: row.failed_count,
    undoExpiresAt: row.undo_expires_at,
    undoneAt: row.undone_at,
  };
}

export interface NewBatch {
  kind: BatchKind;
  /** Executed suggestion ids (message ids), at most 100. */
  suggestionIds: readonly number[];
  requestedCount: number;
  executedCount: number;
  failedCount: number;
  createdAt: number;
  undoExpiresAt: number;
}

export function insertBatchStmt(db: D1Database, b: NewBatch): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO action_batches (created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    )
    .bind(b.createdAt, b.kind, JSON.stringify(b.suggestionIds), b.requestedCount, b.executedCount, b.failedCount, b.undoExpiresAt);
}

export async function getBatch(db: D1Database, id: number): Promise<ActionBatch | null> {
  const row = await db.prepare("SELECT * FROM action_batches WHERE id = ?1").bind(id).first<BatchRow>();
  return row ? mapBatch(row) : null;
}

export function listBatchesStmt(
  db: D1Database,
  opts: { since: number; beforeId: number | null; limit: number },
): D1PreparedStatement {
  return db
    .prepare("SELECT * FROM action_batches WHERE created_at >= ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3")
    .bind(opts.since, opts.beforeId, opts.limit);
}

/** One-shot undo claim (decision 10). */
export function claimUndoStmt(db: D1Database, id: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE action_batches SET undone_at = ?2 WHERE id = ?1 AND undone_at IS NULL AND undo_expires_at > ?2 AND executed_count > 0 RETURNING id",
    )
    .bind(id, now);
}

export function resetUndoStmt(db: D1Database, id: number, undoneAt: number): D1PreparedStatement {
  return db.prepare("UPDATE action_batches SET undone_at = NULL WHERE id = ?1 AND undone_at = ?2").bind(id, undoneAt);
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db`
Expected: PASS for `schema`, `sql`, `settings`, `budget-audit`, `repositories` (8 tests in `repositories.test.ts`).

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db-isolation.test.ts`
Expected: PASS, `4 passed`.

If D1 returns BLOB columns in a shape `bytesFromBlob` does not handle, the `refreshToken?.iv.length` assertion fails with `unexpected blob value`; extend `bytesFromBlob` for that shape and rerun.

- [ ] **Step 11: Commit**

```bash
git add app/src/worker/db app/test/worker/helpers/seed.ts app/test/worker/db app/test/worker/db-isolation.test.ts
git commit -m "feat(worker): add account-scoped D1 repositories, seed helpers and isolation test"
```

---

### Task 8: D1-backed token source and provider test doubles

**Files:**
- Create: `app/src/worker/scan/token-source.ts`
- Create: `app/test/worker/helpers/fake-provider.ts`
- Test: `app/test/worker/oauth/token-source.test.ts`

**Interfaces:**
- Consumes: `Account`, `accessTokenUpdateStmt`, `tokensUpdateStmt`, `getAccount` (Task 7), `decryptToken`, `encryptToken` (Task 4), `AppConfig` (Task 3), `oauthClientConfig`, `ProviderOAuthMap`, `ProviderFactory`, `ProviderTarget`, `PROVIDER_OAUTH` (Task 5); from `@clearbox/core`: `TokenSource`, `TokenUpdate`, `OAuthTokens`, `FetchLike`, `ProviderKind`, `MailProvider`, `ActionResult`, `BootstrapResult`, `RestoreItem`, `ACCESS_TOKEN_MIN_TTL_MS`, `ProviderAuthError` (`new ProviderAuthError({ provider, reason })`), `ProviderConfigError` (`new ProviderConfigError({ provider, reason })`), `ClearboxError`.
- Produces:
  - `token-source.ts` (uses `TokenUpdate` from `@clearbox/core`, not redeclared): `type RefreshFn = (refreshToken: string) => Promise<OAuthTokens>`, `type TokenAccount = Pick<Account, "id" | "provider" | "keyVersion" | "refreshToken" | "accessToken" | "accessExpiresAt">`, `interface D1TokenSourceOptions { account: TokenAccount; encKey: CryptoKey; refresh: RefreshFn; now: () => number }`, `interface D1TokenSource extends TokenSource { readonly update: TokenUpdate | null; readonly refreshCount: number }`, `createD1TokenSource(opts): D1TokenSource`, `refreshFnFor(oauth: ProviderOAuthMap, config: AppConfig, provider: ProviderKind, fetch: FetchLike, now: () => number, redirectUri: string): RefreshFn`, `tokenUpdateStmt(db, account: TokenAccount, encKey, update: TokenUpdate, now): Promise<D1PreparedStatement>`, `staticTokenSource(accessToken: string): TokenSource`.
  - `fake-provider.ts`: `interface FakeCall { method: "bootstrap" | "inboxEstimate" | "trash" | "archive" | "restore"; ids: string[]; target: ProviderTarget }`, `interface FakeProviderOptions { results?: ReadonlyMap<string, ActionResult>; failWith?: Partial<Record<FakeCall["method"], Error>>; newIdFor?: (id: string) => string; bootstrap?: BootstrapResult; inboxEstimate?: number | null }` (the fake implements every `MailProvider` method, including plan 02's `inboxEstimate`), `class FakeProvider { calls: FakeCall[]; options: FakeProviderOptions; factory(): ProviderFactory }`, `fakeProviderFactory(p: FakeProvider): ProviderFactory`, `interface FakeOAuthCall { fn: "authorize" | "exchange" | "refresh" | "revoke"; provider: ProviderKind; value: string }`, `fakeOAuth(overrides?): { oauth: ProviderOAuthMap; calls: FakeOAuthCall[] }`.

- [ ] **Step 1: Write the provider test doubles**

`app/test/worker/helpers/fake-provider.ts`:

```ts
import type {
  ActionResult,
  AuthorizeParams,
  BootstrapResult,
  MailProvider,
  OAuthClientConfig,
  OAuthTokens,
  ProviderDeps,
  ProviderKind,
  RestoreItem,
} from "@clearbox/core";
import { PROVIDER_OAUTH } from "../../../src/worker/scan/providers.ts";
import type { ProviderFactory, ProviderOAuth, ProviderOAuthMap, ProviderTarget } from "../../../src/worker/scan/providers.ts";

export interface FakeCall {
  method: "bootstrap" | "inboxEstimate" | "trash" | "archive" | "restore";
  ids: string[];
  target: ProviderTarget;
}

export interface FakeProviderOptions {
  /** Per provider message id result; default ok with newIdFor(id). */
  results?: ReadonlyMap<string, ActionResult>;
  /** Throw this error from the whole call. */
  failWith?: Partial<Record<FakeCall["method"], Error>>;
  newIdFor?: (id: string) => string;
  bootstrap?: BootstrapResult;
  /** Value returned by inboxEstimate(); default null (unknown). */
  inboxEstimate?: number | null;
}

const DEFAULT_BOOTSTRAP: BootstrapResult = {
  email: "mailbox@example.com",
  providerUserId: "mailbox@example.com",
  aliases: [],
  archiveFolderId: null,
  incrementalCursor: JSON.stringify({ v: 1, historyId: "100" }),
};

/** In-memory MailProvider for worker tests; it calls tokens.getAccessToken() like a real provider. */
export class FakeProvider {
  readonly calls: FakeCall[] = [];
  options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  factory(): ProviderFactory {
    return (target, deps) => this.bind(target, deps);
  }

  private bind(target: ProviderTarget, deps: ProviderDeps): MailProvider {
    const run = async (method: FakeCall["method"], ids: string[], recorded: string[] = ids): Promise<ActionResult[]> => {
      this.calls.push({ method, ids: recorded, target });
      await deps.tokens.getAccessToken();
      const failure = this.options.failWith?.[method];
      if (failure) throw failure;
      return ids.map(
        (id) => this.options.results?.get(id) ?? { id, ok: true, newId: this.options.newIdFor?.(id) ?? id },
      );
    };
    const unused = (name: string) => async (): Promise<never> => {
      throw new Error(`FakeProvider.${name} is not used by plan 03 tests`);
    };
    return {
      kind: target.provider,
      bootstrap: async () => {
        this.calls.push({ method: "bootstrap", ids: [], target });
        await deps.tokens.getAccessToken();
        const failure = this.options.failWith?.bootstrap;
        if (failure) throw failure;
        return this.options.bootstrap ?? DEFAULT_BOOTSTRAP;
      },
      inboxEstimate: async () => {
        this.calls.push({ method: "inboxEstimate", ids: [], target });
        await deps.tokens.getAccessToken();
        const failure = this.options.failWith?.inboxEstimate;
        if (failure) throw failure;
        return this.options.inboxEstimate ?? null;
      },
      listInboxPage: unused("listInboxPage"),
      listSentPage: unused("listSentPage"),
      syncChanges: unused("syncChanges"),
      resyncCursor: unused("resyncCursor"),
      trash: (ids: readonly string[]) => run("trash", [...ids]),
      archive: (ids: readonly string[]) => run("archive", [...ids]),
      // Calls record restore items as "<from>:<id>"; results are looked up by the raw id.
      restore: (items: readonly RestoreItem[]) =>
        run(
          "restore",
          items.map((i) => i.id),
          items.map((i) => `${i.from}:${i.id}`),
        ),
    };
  }
}

export function fakeProviderFactory(p: FakeProvider): ProviderFactory {
  return p.factory();
}

export interface FakeOAuthCall {
  fn: "authorize" | "exchange" | "refresh" | "revoke";
  provider: ProviderKind;
  value: string;
}

export function fakeOAuth(
  overrides: Partial<Record<ProviderKind, Partial<ProviderOAuth>>> = {},
): { oauth: ProviderOAuthMap; calls: FakeOAuthCall[] } {
  const calls: FakeOAuthCall[] = [];
  const make = (provider: ProviderKind): ProviderOAuth => ({
    buildAuthorizeUrl: (cfg: OAuthClientConfig, p: AuthorizeParams) => {
      calls.push({ fn: "authorize", provider, value: p.state });
      const url = new URL(`https://auth.example.test/${provider}/authorize`);
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("state", p.state);
      url.searchParams.set("code_challenge", p.codeChallenge);
      if (p.loginHint !== undefined) url.searchParams.set("login_hint", p.loginHint);
      return url.toString();
    },
    exchangeCode: async (_f, _cfg, code, codeVerifier, now): Promise<OAuthTokens> => {
      calls.push({ fn: "exchange", provider, value: `${code}|${codeVerifier}` });
      return {
        accessToken: "fresh-access",
        expiresAt: now + 3_600_000,
        refreshToken: "fresh-refresh",
        grantedScopes:
          provider === "gmail" ? ["https://www.googleapis.com/auth/gmail.modify"] : ["Mail.ReadWrite", "offline_access", "User.Read"],
        refreshTokenExpiresAt: null,
      };
    },
    refresh: async (_f, _cfg, refreshToken, now): Promise<OAuthTokens> => {
      calls.push({ fn: "refresh", provider, value: refreshToken });
      return {
        accessToken: "refreshed-access",
        expiresAt: now + 3_600_000,
        refreshToken: provider === "outlook" ? "rotated-refresh" : null,
        grantedScopes: [],
        refreshTokenExpiresAt: null,
      };
    },
    hasRequiredScopes: PROVIDER_OAUTH[provider].hasRequiredScopes,
    revoke:
      provider === "gmail"
        ? async (_f, token) => {
            calls.push({ fn: "revoke", provider, value: token });
            return true;
          }
        : null,
    ...overrides[provider],
  });
  return { oauth: { gmail: make("gmail"), outlook: make("outlook") }, calls };
}
```

- [ ] **Step 2: Write the failing token source tests**

`app/test/worker/oauth/token-source.test.ts`:

```ts
import { ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { OAuthTokens } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import { readConfig } from "../../../src/worker/env.ts";
import {
  createD1TokenSource,
  refreshFnFor,
  staticTokenSource,
  tokenUpdateStmt,
} from "../../../src/worker/scan/token-source.ts";
import { fakeOAuth } from "../helpers/fake-provider.ts";
import { SEED_NOW, seedAccount, testEncKey } from "../helpers/seed.ts";

function recordingRefresh(rotated: string | null) {
  const seen: string[] = [];
  const refresh = async (rt: string): Promise<OAuthTokens> => {
    seen.push(rt);
    return { accessToken: `new-access-${seen.length}`, expiresAt: SEED_NOW + 3_600_000, refreshToken: rotated, grantedScopes: [], refreshTokenExpiresAt: null };
  };
  return { refresh, seen };
}

describe("createD1TokenSource", () => {
  it("uses the cached encrypted access token while more than 5 minutes remain", async () => {
    const account = await seedAccount({ accessToken: "cached-access", accessExpiresAt: SEED_NOW + 10 * 60_000 });
    const { refresh, seen } = recordingRefresh(null);
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    expect(await tokens.getAccessToken()).toBe("cached-access");
    expect(seen).toEqual([]);
    expect(tokens.update).toBeNull();
  });

  it("refreshes when fewer than 5 minutes remain and records the update", async () => {
    const account = await seedAccount({ refreshToken: "stored-refresh", accessExpiresAt: SEED_NOW + 4 * 60_000 });
    const { refresh, seen } = recordingRefresh(null);
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    expect(await tokens.getAccessToken()).toBe("new-access-1");
    expect(await tokens.getAccessToken()).toBe("new-access-1");
    expect(seen).toEqual(["stored-refresh"]);
    expect(tokens.update).toEqual({ accessToken: "new-access-1", accessExpiresAt: SEED_NOW + 3_600_000, refreshToken: null });
  });

  it("captures Microsoft refresh token rotation and uses the rotated token next", async () => {
    const account = await seedAccount({ provider: "outlook", refreshToken: "ms-refresh-1", accessToken: null });
    const { refresh, seen } = recordingRefresh("ms-refresh-2");
    const tokens = createD1TokenSource({ account, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    await tokens.getAccessToken();
    await tokens.forceRefresh();
    expect(seen).toEqual(["ms-refresh-1", "ms-refresh-2"]);
    expect(tokens.update?.refreshToken).toBe("ms-refresh-2");
    expect(tokens.refreshCount).toBe(2);
  });

  it("maps a missing or undecryptable refresh token to ProviderAuthError", async () => {
    const account = await seedAccount({ accessToken: null });
    const { refresh } = recordingRefresh(null);
    const noRefresh = createD1TokenSource({ account: { ...account, refreshToken: null }, encKey: await testEncKey(), refresh, now: () => SEED_NOW });
    await expect(noRefresh.getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
    const otherKey = await importEncKey(base64ToBytes(env.STATE_SIGNING_KEY));
    const wrongKey = createD1TokenSource({ account, encKey: otherKey, refresh, now: () => SEED_NOW });
    await expect(wrongKey.getAccessToken()).rejects.toMatchObject({ reason: "token_decrypt_failed" });
  });
});

describe("tokenUpdateStmt", () => {
  it("re-encrypts and persists access and rotated refresh tokens", async () => {
    const account = await seedAccount({ provider: "outlook" });
    const key = await testEncKey();
    const stmt = await tokenUpdateStmt(env.DB, account, key, { accessToken: "a2", accessExpiresAt: SEED_NOW + 1, refreshToken: "r2" }, SEED_NOW);
    await stmt.run();
    const stored = await getAccount(env.DB, account.id);
    const ctx = (kind: "refresh" | "access") => ({ accountId: account.id, kind, keyVersion: account.keyVersion });
    expect(stored?.accessExpiresAt).toBe(SEED_NOW + 1);
    expect(await decryptToken(key, stored?.accessToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() }, ctx("access"))).toBe("a2");
    expect(await decryptToken(key, stored?.refreshToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() }, ctx("refresh"))).toBe("r2");
  });

  it("keeps the stored refresh token when the provider did not rotate it", async () => {
    const account = await seedAccount({ refreshToken: "keep-me" });
    const key = await testEncKey();
    await (await tokenUpdateStmt(env.DB, account, key, { accessToken: "a3", accessExpiresAt: SEED_NOW + 2, refreshToken: null }, SEED_NOW)).run();
    const stored = await getAccount(env.DB, account.id);
    const ctx = { accountId: account.id, kind: "refresh" as const, keyVersion: account.keyVersion };
    expect(await decryptToken(key, stored?.refreshToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() }, ctx)).toBe("keep-me");
  });
});

describe("refreshFnFor and staticTokenSource", () => {
  it("throws ProviderConfigError when the provider client is not configured", async () => {
    const result = readConfig({ ...env, GOOGLE_CLIENT_ID: "" } as Env);
    if (!result.ok) throw new Error("config");
    const { oauth } = fakeOAuth();
    const refresh = refreshFnFor(oauth, result.config, "gmail", fetch, () => SEED_NOW, "");
    await expect(refresh("rt")).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("calls the provider refresh helper with the client config", async () => {
    const result = readConfig(env);
    if (!result.ok) throw new Error("config");
    const { oauth, calls } = fakeOAuth();
    const refresh = refreshFnFor(oauth, result.config, "outlook", fetch, () => SEED_NOW, "");
    expect((await refresh("rt-1")).refreshToken).toBe("rotated-refresh");
    expect(calls).toEqual([{ fn: "refresh", provider: "outlook", value: "rt-1" }]);
  });

  it("serves a fixed token for connect-time bootstrap", async () => {
    const tokens = staticTokenSource("fixed");
    expect(await tokens.getAccessToken()).toBe("fixed");
    expect(await tokens.forceRefresh()).toBe("fixed");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/oauth/token-source.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/scan/token-source.ts`.

- [ ] **Step 4: Implement `app/src/worker/scan/token-source.ts`**

```ts
import { ACCESS_TOKEN_MIN_TTL_MS, ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { FetchLike, OAuthTokens, ProviderKind, TokenSource, TokenUpdate } from "@clearbox/core";
import { decryptToken, encryptToken } from "../crypto/aead.ts";
import type { TokenKind } from "../crypto/aead.ts";
import { accessTokenUpdateStmt, tokensUpdateStmt } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import type { AppConfig } from "../env.ts";
import { oauthClientConfig } from "./providers.ts";
import type { ProviderOAuthMap } from "./providers.ts";

// TokenUpdate (contracts 4.4 / 7.15) comes from @clearbox/core (plan 01); refreshToken is non-null when the
// provider rotated the refresh token (Microsoft: every refresh).

export type RefreshFn = (refreshToken: string) => Promise<OAuthTokens>;

export type TokenAccount = Pick<Account, "id" | "provider" | "keyVersion" | "refreshToken" | "accessToken" | "accessExpiresAt">;

export interface D1TokenSourceOptions {
  account: TokenAccount;
  encKey: CryptoKey;
  refresh: RefreshFn;
  now: () => number;
}

export interface D1TokenSource extends TokenSource {
  readonly update: TokenUpdate | null;
  readonly refreshCount: number;
}

export function createD1TokenSource(opts: D1TokenSourceOptions): D1TokenSource {
  const { account } = opts;
  let cached: { token: string; expiresAt: number } | null = null;
  let refreshToken: string | null = null;
  let update: TokenUpdate | null = null;
  let refreshCount = 0;
  const ctx = (kind: TokenKind) => ({ accountId: account.id, kind, keyVersion: account.keyVersion });

  async function currentRefreshToken(): Promise<string> {
    if (refreshToken !== null) return refreshToken;
    if (!account.refreshToken) throw new ProviderAuthError({ provider: account.provider, reason: "no_refresh_token" });
    try {
      refreshToken = await decryptToken(opts.encKey, account.refreshToken, ctx("refresh"));
    } catch (cause) {
      throw new ProviderAuthError({ provider: account.provider, reason: "token_decrypt_failed", cause });
    }
    return refreshToken;
  }

  async function forceRefresh(): Promise<string> {
    const tokens = await opts.refresh(await currentRefreshToken());
    refreshCount += 1;
    if (tokens.refreshToken) refreshToken = tokens.refreshToken;
    cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    update = {
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken ?? update?.refreshToken ?? null,
    };
    return tokens.accessToken;
  }

  async function getAccessToken(): Promise<string> {
    const now = opts.now();
    if (cached && cached.expiresAt - now >= ACCESS_TOKEN_MIN_TTL_MS) return cached.token;
    if (
      !cached &&
      account.accessToken &&
      account.accessExpiresAt !== null &&
      account.accessExpiresAt - now >= ACCESS_TOKEN_MIN_TTL_MS
    ) {
      try {
        const token = await decryptToken(opts.encKey, account.accessToken, ctx("access"));
        cached = { token, expiresAt: account.accessExpiresAt };
        return token;
      } catch {
        // An unreadable cached access token is replaced by a refresh.
      }
    }
    return forceRefresh();
  }

  return {
    getAccessToken,
    forceRefresh,
    get update() {
      return update;
    },
    get refreshCount() {
      return refreshCount;
    },
  };
}

export function refreshFnFor(
  oauth: ProviderOAuthMap,
  config: AppConfig,
  provider: ProviderKind,
  fetch: FetchLike,
  now: () => number,
  redirectUri: string,
): RefreshFn {
  return async (rt) => {
    const cfg = oauthClientConfig(config, provider, redirectUri);
    if (!cfg) throw new ProviderConfigError({ provider, reason: "client_not_configured" });
    return oauth[provider].refresh(fetch, cfg, rt, now());
  };
}

/** Encrypts a TokenUpdate with the account's key version (contracts 7.15). */
export async function tokenUpdateStmt(
  db: D1Database,
  account: TokenAccount,
  encKey: CryptoKey,
  update: TokenUpdate,
  now: number,
): Promise<D1PreparedStatement> {
  const ctx = (kind: TokenKind) => ({ accountId: account.id, kind, keyVersion: account.keyVersion });
  const access = await encryptToken(encKey, update.accessToken, ctx("access"));
  if (update.refreshToken !== null) {
    const refresh = await encryptToken(encKey, update.refreshToken, ctx("refresh"));
    return tokensUpdateStmt(db, account.id, refresh, access, update.accessExpiresAt, now);
  }
  return accessTokenUpdateStmt(db, account.id, access, update.accessExpiresAt, now);
}

/** Connect-time bootstrap uses the freshly exchanged access token (contracts 7.13 step 6). */
export function staticTokenSource(accessToken: string): TokenSource {
  return {
    getAccessToken: async () => accessToken,
    forceRefresh: async () => accessToken,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/oauth/token-source.test.ts`
Expected: PASS, `9 passed`.

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db-isolation.test.ts`
Expected: PASS (token-source.ts has no account-owned SQL).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/scan/token-source.ts app/test/worker/helpers/fake-provider.ts app/test/worker/oauth/token-source.test.ts
git commit -m "feat(worker): add D1-backed token source with rotation capture and provider fakes"
```

---

### Task 9: OAuth state cookie, connect flow and OAuth routes

**Files:**
- Create: `app/src/worker/oauth/state-cookie.ts`
- Create: `app/src/worker/oauth/connect.ts`
- Create: `app/src/worker/routes/oauth.ts`
- Modify: `app/src/worker/app.ts` (mount `oauthRoutes`)
- Test: `app/test/worker/oauth/state-cookie.test.ts`, `app/test/worker/oauth/oauth-routes.test.ts`

**Interfaces:**
- Consumes: `importSigningKey`, `signValue`, `verifyValue` (Task 4), `createVerifier`, `challengeS256`, `randomBase64Url` (Task 4), `importEncKey`, `encryptToken`, `CURRENT_KEY_VERSION` (Task 4), `findOpenAccountByEmail`, `insertAccountStmt`, `reconnectAccountStmt`, `setInboxEstimateStmt` (Task 7), `auditStmt` (Task 6), `readSettings`, `addIssue`, `removeIssue`, `issuesEqual`, `setIssuesStmt` (Task 6), `staticTokenSource` (Task 8), `oauthClientConfig`, `callbackPath`, `routeSegment` (Task 5), `logEvent`, `newAccountId` (Task 3), `AppEnv`, `AppConfig`, `AppDeps` (Tasks 3, 5), `OAuthCallbackErrorCode`, `AppIssueCode` (Task 2); from `@clearbox/core`: `ProviderKind`, `AuthorizeParams`, `OAuthTokens`, `ProviderConfigError`.
- Produces:
  - `state-cookie.ts`: `OAUTH_COOKIE_NAME = "__Host-clearbox_oauth"`, `OAUTH_COOKIE_TTL_MS = 600000`, `interface OAuthStatePayload { p: ProviderKind; n: string; v: string; e: number }`, `type StateFailure = "missing" | "malformed" | "bad_signature" | "expired" | "provider_mismatch" | "state_mismatch"`, `createOAuthState(key, provider, now): Promise<{ payload: OAuthStatePayload; setCookie: string }>`, `verifyOAuthState(key, cookieHeader: string | null, provider, state: string | null, now): Promise<{ ok: true; payload } | { ok: false; reason: StateFailure }>`, `CLEAR_OAUTH_COOKIE: string`, `readCookie(header: string | null, name: string): string | null`.
  - `connect.ts`: `type ConnectError = "token_exchange_failed" | "provider_config_error" | "scope_missing" | "no_refresh_token" | "profile_failed"`, `interface ConnectContext { db: D1Database; config: AppConfig; deps: AppDeps; redirectUri: string }`, `type ConnectResult = { ok: true; accountId: string; reconnected: boolean } | { ok: false; error: ConnectError }`, `completeConnect(ctx, provider, code, codeVerifier): Promise<ConnectResult>`, `clientIssueCode(provider): AppIssueCode`.
  - `routes/oauth.ts`: `oauthRoutes` (`Hono<AppEnv>`, mounted at `/oauth`): `GET /:segment/start`, `GET /:segment/callback` for segments `google` and `microsoft`.

- [ ] **Step 1: Write the failing state cookie tests**

`app/test/worker/oauth/state-cookie.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../../src/worker/crypto/base64.ts";
import { importSigningKey } from "../../../src/worker/crypto/hmac.ts";
import {
  CLEAR_OAUTH_COOKIE,
  createOAuthState,
  OAUTH_COOKIE_NAME,
  readCookie,
  verifyOAuthState,
} from "../../../src/worker/oauth/state-cookie.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const key = () => importSigningKey(base64ToBytes(env.STATE_SIGNING_KEY));

async function issued() {
  const created = await createOAuthState(await key(), "gmail", NOW);
  const cookie = created.setCookie.split(";")[0] ?? "";
  return { created, cookie };
}

describe("OAuth state cookie", () => {
  it("sets a __Host- cookie with the contracts 7.12 attributes and payload", async () => {
    const { created } = await issued();
    expect(created.setCookie).toMatch(/^__Host-clearbox_oauth=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
    expect(created.setCookie).toContain("Max-Age=600");
    expect(created.setCookie).toContain("Path=/");
    expect(created.setCookie).toContain("HttpOnly");
    expect(created.setCookie).toContain("Secure");
    expect(created.setCookie).toContain("SameSite=Lax");
    expect(created.payload.p).toBe("gmail");
    expect(created.payload.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.payload.v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.payload.e).toBe(NOW + 600_000);
  });

  it("verifies a matching callback", async () => {
    const { created, cookie } = await issued();
    const result = await verifyOAuthState(await key(), `other=1; ${cookie}`, "gmail", created.payload.n, NOW + 1_000);
    expect(result).toEqual({ ok: true, payload: created.payload });
  });

  it("rejects missing, malformed, tampered, expired, mismatched provider and mismatched state", async () => {
    const { created, cookie } = await issued();
    const k = await key();
    const [name, value] = cookie.split("=");
    const [body, sig] = (value ?? "").split(".");
    const flip = (v: string) => (v.startsWith("A") ? "B" : "A") + v.slice(1);
    const tamperedBody = `${name}=${flip(body ?? "")}.${sig}`;
    const tamperedSig = `${name}=${body}.${flip(sig ?? "")}`;
    const cases: [string | null, "gmail" | "outlook", string | null, number, string][] = [
      [null, "gmail", created.payload.n, NOW, "missing"],
      [`${OAUTH_COOKIE_NAME}=nodot`, "gmail", created.payload.n, NOW, "malformed"],
      [tamperedBody, "gmail", created.payload.n, NOW, "bad_signature"],
      [tamperedSig, "gmail", created.payload.n, NOW, "bad_signature"],
      [cookie, "gmail", created.payload.n, NOW + 600_001, "expired"],
      [cookie, "outlook", created.payload.n, NOW, "provider_mismatch"],
      [cookie, "gmail", "different-state", NOW, "state_mismatch"],
      [cookie, "gmail", null, NOW, "state_mismatch"],
    ];
    for (const [header, provider, state, now, reason] of cases) {
      expect(await verifyOAuthState(k, header, provider, state, now)).toEqual({ ok: false, reason });
    }
  });

  it("parses cookies and clears with Max-Age=0", () => {
    expect(readCookie("a=1; __Host-clearbox_oauth=x.y; b=2", OAUTH_COOKIE_NAME)).toBe("x.y");
    expect(readCookie("a=1", OAUTH_COOKIE_NAME)).toBeNull();
    expect(readCookie(null, OAUTH_COOKIE_NAME)).toBeNull();
    expect(CLEAR_OAUTH_COOKIE).toBe("__Host-clearbox_oauth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
  });
});
```

- [ ] **Step 2: Write the failing OAuth route tests**

`app/test/worker/oauth/oauth-routes.test.ts`:

```ts
import { ProviderConfigError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/worker/app.ts";
import { CURRENT_KEY_VERSION, decryptToken } from "../../../src/worker/crypto/aead.ts";
import { challengeS256 } from "../../../src/worker/crypto/pkce.ts";
import { findOpenAccountByEmail, getAccount } from "../../../src/worker/db/accounts.ts";
import { readSettings, setIssuesStmt } from "../../../src/worker/db/settings.ts";
import type { AppOverrides } from "../../../src/worker/app.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, testEncKey } from "../helpers/seed.ts";

afterEach(() => vi.restoreAllMocks());

let mailboxSeq = 0;

function setup(
  overrides: Partial<AppOverrides> = {},
  oauthOverrides: Parameters<typeof fakeOAuth>[0] = {},
  email = `mailbox${++mailboxSeq}@example.com`,
) {
  const provider = new FakeProvider({
    bootstrap: {
      email,
      providerUserId: email,
      aliases: ["alias@example.com"],
      archiveFolderId: null,
      incrementalCursor: '{"v":1,"historyId":"777"}',
    },
    inboxEstimate: 4_321,
  });
  const { oauth, calls } = fakeOAuth(oauthOverrides);
  const app = createApp({ now: () => SEED_NOW, providerFactory: provider.factory(), oauth, ...overrides });
  return { app, provider, calls, email };
}

async function start(app: ReturnType<typeof createApp>, segment = "google", query = "") {
  const res = await apiFetch(`/oauth/${segment}/start${query}`, {}, { app });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const location = new URL(res.headers.get("Location") ?? "https://invalid.test");
  return { res, cookie, location, state: location.searchParams.get("state") ?? "" };
}

async function callback(app: ReturnType<typeof createApp>, segment: string, query: Record<string, string>, cookie: string | null) {
  const init = cookie === null ? {} : { headers: { Cookie: cookie } };
  return apiFetch(`/oauth/${segment}/callback?${new URLSearchParams(query).toString()}`, init, { app });
}

function settingsRedirect(res: Response): Record<string, string> {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location") ?? "", "https://clearbox.example.test");
  expect(location.pathname).toBe("/settings/accounts");
  return Object.fromEntries(location.searchParams);
}

describe("GET /oauth/:provider/start", () => {
  it("sets the state cookie and redirects to the authorize URL with PKCE", async () => {
    const { app, calls } = setup();
    const { res, cookie, location, state } = await start(app, "google", "?loginHint=Mailbox%40example.com");
    expect(res.status).toBe(302);
    expect(location.origin).toBe("https://auth.example.test");
    expect(location.searchParams.get("redirect_uri")).toBe("https://clearbox.example.test/oauth/google/callback");
    expect(location.searchParams.get("client_id")).toBe("test-google-client");
    expect(location.searchParams.get("login_hint")).toBe("mailbox@example.com");
    expect(cookie.startsWith("__Host-clearbox_oauth=")).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual([{ fn: "authorize", provider: "gmail", value: state }]);
  });

  it("redirects with provider_not_configured when the client is missing", async () => {
    const { app } = setup();
    const res = await apiFetch("/oauth/microsoft/start", {}, { app, env: { MS_CLIENT_SECRET: "" } });
    expect(settingsRedirect(res)).toEqual({ error: "provider_not_configured", provider: "outlook" });
  });

  it("returns 404 for unknown providers", async () => {
    const { app } = setup();
    expect((await apiFetch("/oauth/yahoo/start", {}, { app })).status).toBe(404);
  });
});

describe("GET /oauth/:provider/callback", () => {
  it("connects a new Gmail account with encrypted tokens", async () => {
    const { app, calls, provider, email } = setup();
    const flow = await start(app);
    const res = await callback(app, "google", { code: "auth-code", state: flow.state }, flow.cookie);
    const params = settingsRedirect(res);
    expect(params["connected"]).toMatch(/^acc_[0-9a-f]{16}$/);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const exchange = calls.find((c) => c.fn === "exchange");
    const verifier = exchange?.value.split("|")[1] ?? "";
    expect(exchange?.value.split("|")[0]).toBe("auth-code");
    expect(await challengeS256(verifier)).toBe(flow.location.searchParams.get("code_challenge"));
    expect(provider.calls.map((c) => c.method)).toEqual(["bootstrap", "inboxEstimate"]);

    const account = await getAccount(env.DB, params["connected"] ?? "");
    expect(account).toMatchObject({
      provider: "gmail",
      email,
      status: "active",
      phase: "sent_backfill",
      incrementalCursor: '{"v":1,"historyId":"777"}',
      ownerAliases: ["alias@example.com"],
      nextTickAt: 0,
      keyVersion: CURRENT_KEY_VERSION,
      inboxEstimate: 4_321,
    });
    const key = await testEncKey();
    const ctx = (kind: "refresh" | "access") => ({ accountId: account?.id ?? "", kind, keyVersion: 1 });
    const empty = { ciphertext: new Uint8Array(), iv: new Uint8Array() };
    expect(await decryptToken(key, account?.refreshToken ?? empty, ctx("refresh"))).toBe("fresh-refresh");
    expect(await decryptToken(key, account?.accessToken ?? empty, ctx("access"))).toBe("fresh-access");
    const audit = await env.DB.prepare("SELECT kind, result_json FROM audit_log WHERE account_id = ?1").bind(account?.id).run();
    expect(audit.results).toEqual([{ kind: "account_connected", result_json: "{}" }]);
  });

  it("reconnects an existing account, keeps its id and clears the client issue", async () => {
    const existing = await seedAccount({ email: "returning@example.com", status: "needs_reauth", statusReason: "invalid_grant" });
    await setIssuesStmt(env.DB, [{ code: "google_client_invalid", since: new Date(SEED_NOW).toISOString(), accountId: null }], SEED_NOW).run();
    const { app } = setup({}, {}, "returning@example.com");
    const flow = await start(app);
    const params = settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie));
    expect(params["connected"]).toBe(existing.id);
    expect(await getAccount(env.DB, existing.id)).toMatchObject({ status: "active", statusReason: null, incrementalCursor: existing.incrementalCursor });
    expect((await readSettings(env.DB)).issues).toEqual([]);
    const kinds = await env.DB.prepare("SELECT kind FROM audit_log WHERE account_id = ?1 ORDER BY id").bind(existing.id).run();
    expect(kinds.results).toEqual([{ kind: "account_reconnected" }]);
  });

  it("rejects tampered, missing, mismatched and expired state with state_invalid", async () => {
    const { app, email } = setup();
    const flow = await start(app);
    const tampered = flow.cookie.replace(".", ".x");
    expect(settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, tampered))["error"]).toBe("state_invalid");
    expect(settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, null))["error"]).toBe("state_invalid");
    expect(settingsRedirect(await callback(app, "google", { code: "c", state: "wrong" }, flow.cookie))["error"]).toBe("state_invalid");
    expect(settingsRedirect(await callback(app, "microsoft", { code: "c", state: flow.state }, flow.cookie))["error"]).toBe("state_invalid");
    const later = setup({ now: () => SEED_NOW + 600_001 }, {}, email);
    const expired = await callback(later.app, "google", { code: "c", state: flow.state }, flow.cookie);
    expect(settingsRedirect(expired)).toEqual({ error: "state_invalid", provider: "gmail" });
    expect(expired.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await findOpenAccountByEmail(env.DB, "gmail", email)).toBeNull();
  });

  it("maps provider errors to access_denied and admin_consent_required", async () => {
    const { app } = setup();
    expect(settingsRedirect(await callback(app, "google", { error: "access_denied" }, null))).toEqual({
      error: "access_denied",
      provider: "gmail",
    });
    expect(settingsRedirect(await callback(app, "microsoft", { error: "consent_required" }, null))["error"]).toBe(
      "admin_consent_required",
    );
    expect(
      settingsRedirect(
        await callback(app, "microsoft", { error: "access_denied", error_description: "AADSTS90094: admin" }, null),
      )["error"],
    ).toBe("admin_consent_required");
  });

  it("revokes and refuses a grant without the Gmail scope", async () => {
    const { app, calls } = setup({}, {
      gmail: {
        exchangeCode: async (_f, _cfg, _code, _v, now) => ({
          accessToken: "a",
          expiresAt: now + 1,
          refreshToken: "r-no-scope",
          grantedScopes: ["openid"],
          refreshTokenExpiresAt: null,
        }),
        revoke: async (_f, token) => {
          calls.push({ fn: "revoke", provider: "gmail", value: token });
          return true;
        },
      },
    });
    const flow = await start(app);
    expect(settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie))["error"]).toBe("scope_missing");
    expect(calls.filter((c) => c.fn === "revoke")).toEqual([{ fn: "revoke", provider: "gmail", value: "r-no-scope" }]);
  });

  it("requires a refresh token", async () => {
    const { app } = setup({}, {
      outlook: {
        exchangeCode: async (_f, _cfg, _code, _v, now) => ({
          accessToken: "a",
          expiresAt: now + 1,
          refreshToken: null,
          grantedScopes: ["Mail.ReadWrite", "offline_access", "User.Read"],
          refreshTokenExpiresAt: null,
        }),
      },
    });
    const flow = await start(app, "microsoft");
    expect(settingsRedirect(await callback(app, "microsoft", { code: "c", state: flow.state }, flow.cookie))).toEqual({
      error: "no_refresh_token",
      provider: "outlook",
    });
  });

  it("maps client configuration errors and raises the app issue", async () => {
    const { app } = setup({}, {
      gmail: {
        exchangeCode: async () => {
          throw new ProviderConfigError({ provider: "gmail", reason: "invalid_client" });
        },
      },
    });
    const flow = await start(app);
    expect(settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie))["error"]).toBe(
      "provider_config_error",
    );
    expect((await readSettings(env.DB)).issues.map((i) => i.code)).toEqual(["google_client_invalid"]);
  });

  it("maps other exchange failures and bootstrap failures", async () => {
    const failing = setup({}, {
      gmail: {
        exchangeCode: async () => {
          throw new Error("network");
        },
      },
    });
    const flow1 = await start(failing.app);
    expect(settingsRedirect(await callback(failing.app, "google", { code: "c", state: flow1.state }, flow1.cookie))["error"]).toBe(
      "token_exchange_failed",
    );
    const broken = setup({ providerFactory: new FakeProvider({ failWith: { bootstrap: new Error("profile") } }).factory() });
    const flow2 = await start(broken.app);
    expect(settingsRedirect(await callback(broken.app, "google", { code: "c", state: flow2.state }, flow2.cookie))["error"]).toBe(
      "profile_failed",
    );
  });

  it("connects with a null inbox estimate when the best-effort estimate fails", async () => {
    const email = "estimate-fails@example.com";
    const provider = new FakeProvider({
      bootstrap: { email, providerUserId: email, aliases: [], archiveFolderId: null, incrementalCursor: '{"v":1,"historyId":"9"}' },
      failWith: { inboxEstimate: new Error("throttled") },
    });
    const { app } = setup({ providerFactory: provider.factory() }, {}, email);
    const flow = await start(app);
    const params = settingsRedirect(await callback(app, "google", { code: "c", state: flow.state }, flow.cookie));
    expect(params["connected"]).toMatch(/^acc_[0-9a-f]{16}$/);
    expect((await getAccount(env.DB, params["connected"] ?? ""))?.inboxEstimate).toBeNull();
  });

  it("logs oauth.connect with codes and ids only", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { app, email } = setup();
    const flow = await start(app);
    await callback(app, "google", { code: "secret-code", state: flow.state }, flow.cookie);
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"oauth.connect"')) ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({ provider: "gmail", outcome: "connected" });
    expect(lines.join("\n")).not.toMatch(/secret-code|fresh-/);
    expect(lines.join("\n")).not.toContain(email);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/oauth/state-cookie.test.ts test/worker/oauth/oauth-routes.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/oauth/state-cookie.ts`.

- [ ] **Step 4: Implement `app/src/worker/oauth/state-cookie.ts`**

```ts
import type { ProviderKind } from "@clearbox/core";
import { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../crypto/base64.ts";
import { signValue, verifyValue } from "../crypto/hmac.ts";
import { createVerifier, randomBase64Url } from "../crypto/pkce.ts";

export const OAUTH_COOKIE_NAME = "__Host-clearbox_oauth";
export const OAUTH_COOKIE_TTL_MS = 600_000;
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export interface OAuthStatePayload {
  p: ProviderKind;
  /** Nonce, sent to the provider as `state`. */
  n: string;
  /** PKCE verifier. */
  v: string;
  /** Expiry, epoch ms. */
  e: number;
}

const PayloadSchema = z.strictObject({
  p: z.enum(["gmail", "outlook"]),
  n: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  v: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  e: z.int(),
});

export type StateFailure = "missing" | "malformed" | "bad_signature" | "expired" | "provider_mismatch" | "state_mismatch";

export const CLEAR_OAUTH_COOKIE = `${OAUTH_COOKIE_NAME}=; Max-Age=0; ${ATTRIBUTES}`;

export async function createOAuthState(
  key: CryptoKey,
  provider: ProviderKind,
  now: number,
): Promise<{ payload: OAuthStatePayload; setCookie: string }> {
  const payload: OAuthStatePayload = { p: provider, n: randomBase64Url(16), v: createVerifier(), e: now + OAUTH_COOKIE_TTL_MS };
  const body = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const value = `${body}.${await signValue(key, body)}`;
  return { payload, setCookie: `${OAUTH_COOKIE_NAME}=${value}; Max-Age=${OAUTH_COOKIE_TTL_MS / 1000}; ${ATTRIBUTES}` };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Contracts 7.12 check order: present, HMAC, not expired, provider, state. */
export async function verifyOAuthState(
  key: CryptoKey,
  cookieHeader: string | null,
  provider: ProviderKind,
  state: string | null,
  now: number,
): Promise<{ ok: true; payload: OAuthStatePayload } | { ok: false; reason: StateFailure }> {
  const value = readCookie(cookieHeader, OAUTH_COOKIE_NAME);
  if (!value) return { ok: false, reason: "missing" };
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { ok: false, reason: "malformed" };
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!(await verifyValue(key, body, signature))) return { ok: false, reason: "bad_signature" };
  let payload: OAuthStatePayload;
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(fromUtf8(base64UrlToBytes(body))));
    if (!parsed.success) return { ok: false, reason: "malformed" };
    payload = parsed.data;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.e <= now) return { ok: false, reason: "expired" };
  if (payload.p !== provider) return { ok: false, reason: "provider_mismatch" };
  if (state === null || state !== payload.n) return { ok: false, reason: "state_mismatch" };
  return { ok: true, payload };
}
```

- [ ] **Step 5: Implement `app/src/worker/oauth/connect.ts`**

```ts
import { ProviderConfigError } from "@clearbox/core";
import type { BootstrapResult, OAuthTokens, ProviderKind } from "@clearbox/core";
import type { AppIssueCode } from "../../shared/api.ts";
import { CURRENT_KEY_VERSION, encryptToken, importEncKey } from "../crypto/aead.ts";
import { findOpenAccountByEmail, insertAccountStmt, reconnectAccountStmt, setInboxEstimateStmt } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { addIssue, issuesEqual, readSettings, removeIssue, setIssuesStmt } from "../db/settings.ts";
import type { AppConfig, AppDeps } from "../env.ts";
import { logEvent, newAccountId } from "../log.ts";
import { oauthClientConfig } from "../scan/providers.ts";
import { staticTokenSource } from "../scan/token-source.ts";

export type ConnectError =
  | "token_exchange_failed"
  | "provider_config_error"
  | "scope_missing"
  | "no_refresh_token"
  | "profile_failed";

export interface ConnectContext {
  db: D1Database;
  config: AppConfig;
  deps: AppDeps;
  /** `${origin}/oauth/<google|microsoft>/callback` of this request. */
  redirectUri: string;
}

export type ConnectResult = { ok: true; accountId: string; reconnected: boolean } | { ok: false; error: ConnectError };

export function clientIssueCode(provider: ProviderKind): AppIssueCode {
  return provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid";
}

async function updateClientIssue(ctx: ConnectContext, provider: ProviderKind, raise: boolean): Promise<D1PreparedStatement | null> {
  const now = ctx.deps.now();
  const code = clientIssueCode(provider);
  const current = (await readSettings(ctx.db)).issues;
  const next = raise ? addIssue(current, code, null, now) : removeIssue(current, code);
  if (issuesEqual(current, next)) return null;
  logEvent(raise ? "issue.raised" : "issue.cleared", { code, accountId: null });
  return setIssuesStmt(ctx.db, next, now);
}

/** Contracts 7.13 steps 3 to 8. Never throws for provider failures; returns the callback error code. */
export async function completeConnect(
  ctx: ConnectContext,
  provider: ProviderKind,
  code: string,
  codeVerifier: string,
): Promise<ConnectResult> {
  const { deps } = ctx;
  const oauth = deps.oauth[provider];
  const cfg = oauthClientConfig(ctx.config, provider, ctx.redirectUri);
  if (!cfg) return { ok: false, error: "provider_config_error" };

  let tokens: OAuthTokens;
  try {
    tokens = await oauth.exchangeCode(deps.fetch, cfg, code, codeVerifier, deps.now());
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      const stmt = await updateClientIssue(ctx, provider, true);
      if (stmt) await stmt.run();
      return { ok: false, error: "provider_config_error" };
    }
    return { ok: false, error: "token_exchange_failed" };
  }

  if (!oauth.hasRequiredScopes(tokens.grantedScopes)) {
    if (oauth.revoke) {
      try {
        await oauth.revoke(deps.fetch, tokens.refreshToken ?? tokens.accessToken);
      } catch {
        // Best effort (contracts 7.13 step 4).
      }
    }
    return { ok: false, error: "scope_missing" };
  }
  const refreshToken = tokens.refreshToken;
  if (refreshToken === null) return { ok: false, error: "no_refresh_token" };

  let boot: BootstrapResult;
  let inboxEstimate: number | null = null;
  try {
    const mailbox = deps.providerFactory(
      { provider, archiveFolderId: null },
      { fetch: deps.fetch, tokens: staticTokenSource(tokens.accessToken), now: deps.now },
    );
    boot = await mailbox.bootstrap();
    try {
      // Contracts 12.1 A4: one best-effort request; the first backfill tick fills the column when this fails.
      inboxEstimate = await mailbox.inboxEstimate();
    } catch {
      inboxEstimate = null;
    }
  } catch {
    return { ok: false, error: "profile_failed" };
  }

  try {
    const now = deps.now();
    const existing = await findOpenAccountByEmail(ctx.db, provider, boot.email);
    const accountId = existing?.id ?? newAccountId();
    const keyVersion = existing?.keyVersion ?? CURRENT_KEY_VERSION;
    const encKey = await importEncKey(ctx.config.tokenEncKey);
    const enc = (value: string, kind: "refresh" | "access") => encryptToken(encKey, value, { accountId, kind, keyVersion });
    const encRefresh = await enc(refreshToken, "refresh");
    const encAccess = await enc(tokens.accessToken, "access");
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(
        reconnectAccountStmt(ctx.db, accountId, {
          providerUserId: boot.providerUserId,
          keyVersion,
          refreshToken: encRefresh,
          accessToken: encAccess,
          accessExpiresAt: tokens.expiresAt,
          grantedScopes: tokens.grantedScopes,
          ownerAliases: boot.aliases,
          archiveFolderId: boot.archiveFolderId,
          now,
        }),
      );
    } else {
      statements.push(
        insertAccountStmt(ctx.db, {
          id: accountId,
          provider,
          email: boot.email,
          providerUserId: boot.providerUserId,
          grantedScopes: tokens.grantedScopes,
          ownerAliases: boot.aliases,
          archiveFolderId: boot.archiveFolderId,
          incrementalCursor: boot.incrementalCursor,
          keyVersion,
          refreshToken: encRefresh,
          accessToken: encAccess,
          accessExpiresAt: tokens.expiresAt,
          now,
        }),
      );
    }
    if (inboxEstimate !== null) statements.push(setInboxEstimateStmt(ctx.db, accountId, inboxEstimate, now));
    statements.push(
      auditStmt(ctx.db, {
        ts: now,
        accountId,
        kind: existing ? "account_reconnected" : "account_connected",
        batchId: null,
        count: 0,
        result: {},
      }),
    );
    const issueStmt = await updateClientIssue(ctx, provider, false);
    if (issueStmt) statements.push(issueStmt);
    await ctx.db.batch(statements);
    if (existing && existing.status !== "active") {
      logEvent("account.status", { accountId, from: existing.status, to: "active", reason: "reconnected" });
    }
    return { ok: true, accountId, reconnected: existing !== null };
  } catch {
    return { ok: false, error: "profile_failed" };
  }
}
```

- [ ] **Step 6: Implement `app/src/worker/routes/oauth.ts`**

```ts
import type { AuthorizeParams, ProviderKind } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { OAuthCallbackErrorCode } from "../../shared/api.ts";
import { importSigningKey } from "../crypto/hmac.ts";
import { challengeS256 } from "../crypto/pkce.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { notFoundHandler } from "../middleware/errors.ts";
import { completeConnect } from "../oauth/connect.ts";
import { CLEAR_OAUTH_COOKIE, createOAuthState, verifyOAuthState } from "../oauth/state-cookie.ts";
import { callbackPath, oauthClientConfig } from "../scan/providers.ts";

const SEGMENTS: Readonly<Record<string, ProviderKind>> = { google: "gmail", microsoft: "outlook" };
const LoginHintSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const oauthRoutes = new Hono<AppEnv>();

function providerFor(c: Context<AppEnv>): ProviderKind | null {
  return SEGMENTS[c.req.param("segment") ?? ""] ?? null;
}

function toSettings(c: Context<AppEnv>, params: Record<string, string>): Response {
  c.header("Cache-Control", "no-store");
  return c.redirect(`/settings/accounts?${new URLSearchParams(params).toString()}`, 302);
}

oauthRoutes.get("/:segment/start", async (c) => {
  const provider = providerFor(c);
  if (!provider) return notFoundHandler(c);
  const config = c.get("config");
  const deps = c.get("deps");
  const cfg = oauthClientConfig(config, provider, new URL(c.req.url).origin + callbackPath(provider));
  if (!cfg) return toSettings(c, { error: "provider_not_configured", provider });

  const state = await createOAuthState(await importSigningKey(config.stateSigningKey), provider, deps.now());
  const params: AuthorizeParams = { state: state.payload.n, codeChallenge: await challengeS256(state.payload.v) };
  const hint = LoginHintSchema.safeParse(c.req.query("loginHint"));
  if (hint.success) params.loginHint = hint.data;
  c.header("Set-Cookie", state.setCookie);
  c.header("Cache-Control", "no-store");
  return c.redirect(deps.oauth[provider].buildAuthorizeUrl(cfg, params), 302);
});

async function handleCallback(
  c: Context<AppEnv>,
  provider: ProviderKind,
): Promise<{ ok: true; accountId: string; reconnected: boolean } | { ok: false; error: OAuthCallbackErrorCode }> {
  const config = c.get("config");
  const deps = c.get("deps");
  const providerError = c.req.query("error");
  if (providerError !== undefined) {
    const description = c.req.query("error_description") ?? "";
    const admin = provider === "outlook" && (providerError === "consent_required" || description.includes("AADSTS90094"));
    return { ok: false, error: admin ? "admin_consent_required" : "access_denied" };
  }
  const verified = await verifyOAuthState(
    await importSigningKey(config.stateSigningKey),
    c.req.header("Cookie") ?? null,
    provider,
    c.req.query("state") ?? null,
    deps.now(),
  );
  if (!verified.ok) return { ok: false, error: "state_invalid" };
  const code = c.req.query("code");
  if (!code) return { ok: false, error: "token_exchange_failed" };
  const redirectUri = new URL(c.req.url).origin + callbackPath(provider);
  if (!oauthClientConfig(config, provider, redirectUri)) return { ok: false, error: "provider_not_configured" };
  return completeConnect({ db: c.env.DB, config, deps, redirectUri }, provider, code, verified.payload.v);
}

oauthRoutes.get("/:segment/callback", async (c) => {
  const provider = providerFor(c);
  if (!provider) return notFoundHandler(c);
  c.header("Set-Cookie", CLEAR_OAUTH_COOKIE);
  let result: Awaited<ReturnType<typeof handleCallback>>;
  try {
    result = await handleCallback(c, provider);
  } catch {
    result = { ok: false, error: "token_exchange_failed" };
  }
  if (result.ok) {
    logEvent("oauth.connect", {
      provider,
      outcome: result.reconnected ? "reconnected" : "connected",
      accountId: result.accountId,
    });
    return toSettings(c, { connected: result.accountId });
  }
  logEvent("oauth.connect", { provider, outcome: result.error, accountId: null });
  return toSettings(c, { error: result.error, provider });
});
```

- [ ] **Step 7: Mount the routes in `app/src/worker/app.ts`**

Add the import:

```ts
import { oauthRoutes } from "./routes/oauth.ts";
```

Replace the line `  // Routes (mounted by later tasks, in this order).` with:

```ts
  // Routes (mounted by later tasks, in this order).
  app.route("/oauth", oauthRoutes);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/oauth`
Expected: PASS, `26 passed` (4 state cookie, 13 routes, 9 token source).

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/db-isolation.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/worker/oauth app/src/worker/routes/oauth.ts app/src/worker/app.ts app/test/worker/oauth
git commit -m "feat(worker): add signed OAuth state cookie, connect flow and OAuth routes"
```

---

### Task 10: Session and account routes

**Files:**
- Create: `app/src/worker/routes/me.ts`
- Create: `app/src/worker/routes/accounts.ts`
- Modify: `app/src/worker/app.ts` (mount `meRoutes`, `accountsRoutes`)
- Test: `app/test/worker/routes/me-accounts.test.ts`

**Interfaces:**
- Consumes: `readSettings` (Task 6), `listAccounts`, `getAccount`, `toAccountView`, `setPausedStmt`, `disconnectAccountStmt` (Task 7), `countOpenByAccount`, `dismissOpenStmt` (Task 7), `auditStmt` (Task 6), `decryptToken`, `importEncKey` (Task 4), `parseWith`, `readJsonBody`, `ApiError` (Task 5), `logEvent` (Task 3), `toIso` (Task 6); api types `MeResponse`, `AccountsResponse`, `AccountView`, `PatchAccountBodySchema`, `DisconnectResponse` (Task 2); `MICROSOFT_CONSENT_URLS` from `@clearbox/core`.
- Produces: `meRoutes` (`GET /me`, mounted at `/api`), `accountsRoutes` (`GET /`, `PATCH /:id`, `DELETE /:id`, mounted at `/api/accounts`; plan 04 adds `POST /:id/scan` to this same object), `loadVisibleAccount(db, id): Promise<Account>` (throws `404 not_found`), `accountViews(db, accounts): Promise<AccountView[]>`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/routes/me-accounts.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountsResponse, AccountView, ApiErrorBody, DisconnectResponse, MeResponse } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

function setup(revoke?: (token: string) => Promise<boolean>) {
  const { oauth, calls } = fakeOAuth(revoke ? { gmail: { revoke: async (_f, token) => revoke(token) } } : {});
  const app = createApp({ now: () => SEED_NOW, oauth, providerFactory: new FakeProvider().factory() });
  return { app, calls };
}

async function auditKinds(accountId: string): Promise<string[]> {
  const res = await env.DB.prepare("SELECT kind FROM audit_log WHERE account_id = ?1 ORDER BY id")
    .bind(accountId)
    .run<{ kind: string }>();
  return res.results.map((r) => r.kind);
}

describe("GET /api/me", () => {
  it("returns the owner session", async () => {
    const { app } = setup();
    const res = await apiFetch("/api/me", {}, { app });
    expect(res.status).toBe(200);
    expect(await readJson<MeResponse>(res)).toEqual({
      email: "owner@example.test",
      environment: "test",
      freeTier: true,
      providers: { gmail: true, outlook: true },
      issues: [],
      tauDelete: 0.8,
      serverTime: new Date(SEED_NOW).toISOString(),
    });
  });

  it("reports unconfigured providers", async () => {
    const { app } = setup();
    const res = await apiFetch("/api/me", {}, { app, env: { GOOGLE_CLIENT_ID: "" } });
    expect((await readJson<MeResponse>(res)).providers).toEqual({ gmail: false, outlook: true });
  });
});

describe("GET /api/accounts", () => {
  it("lists visible accounts with open counts", async () => {
    const { app } = setup();
    const a = await seedAccount({ provider: "gmail" });
    const b = await seedAccount({ provider: "outlook" });
    await seedAccount({ status: "disconnected" });
    await seedSuggestions(a.id, 2);
    await seedSuggestions(b.id, 1, { status: "awaiting_model" });
    const body = await readJson<AccountsResponse>(await apiFetch("/api/accounts", {}, { app }));
    expect(body.accounts.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(body.accounts[0]?.sync).toMatchObject({ pendingCount: 2, awaitingModelCount: 0 });
    expect(body.accounts[1]).toMatchObject({ provider: "outlook", archiveSupported: true, sync: { awaitingModelCount: 1 } });
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("pauses and resumes with one audit row per change", async () => {
    const { app } = setup();
    const a = await seedAccount();
    const paused = await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: true }), { app });
    expect(paused.status).toBe(200);
    expect((await readJson<AccountView>(paused)).paused).toBe(true);
    await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: true }), { app });
    await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: false }), { app });
    expect(await auditKinds(a.id)).toEqual(["account_paused", "account_resumed"]);
  });

  it("validates the body and the account", async () => {
    const { app } = setup();
    const a = await seedAccount();
    const gone = await seedAccount({ status: "disconnected" });
    const bad = await apiFetch(`/api/accounts/${a.id}`, jsonInit("PATCH", { paused: "yes" }), { app });
    expect((await readJson<ApiErrorBody>(bad)).error.code).toBe("validation_failed");
    expect((await apiFetch(`/api/accounts/acc_ffffffffffffffff`, jsonInit("PATCH", { paused: true }), { app })).status).toBe(404);
    expect((await apiFetch(`/api/accounts/${gone.id}`, jsonInit("PATCH", { paused: true }), { app })).status).toBe(404);
  });
});

describe("DELETE /api/accounts/:id", () => {
  it("revokes Gmail, wipes tokens and dismisses open suggestions", async () => {
    const { app, calls } = setup();
    const a = await seedAccount({ provider: "gmail", refreshToken: "gmail-refresh" });
    const [open] = await seedSuggestions(a.id, 1);
    const res = await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app });
    expect(res.status).toBe(200);
    expect(await readJson<DisconnectResponse>(res)).toEqual({ accountId: a.id, revocation: "revoked", consentUrls: null });
    expect(calls).toEqual([{ fn: "revoke", provider: "gmail", value: "gmail-refresh" }]);
    expect(await getAccount(env.DB, a.id)).toMatchObject({ status: "disconnected", refreshToken: null, accessToken: null });
    expect((await getSuggestionRow(open ?? 0))?.["status"]).toBe("dismissed");
    expect(await auditKinds(a.id)).toEqual(["account_disconnected"]);
    expect((await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app })).status).toBe(404);
  });

  it("still disconnects when Google revoke fails or throws", async () => {
    const failing = setup(async () => false);
    const a = await seedAccount({ provider: "gmail" });
    expect((await readJson<DisconnectResponse>(await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app: failing.app }))).revocation).toBe("failed");
    const throwing = setup(async () => {
      throw new Error("network");
    });
    const b = await seedAccount({ provider: "gmail" });
    const res = await apiFetch(`/api/accounts/${b.id}`, jsonInit("DELETE"), { app: throwing.app });
    expect((await readJson<DisconnectResponse>(res)).revocation).toBe("failed");
    expect((await getAccount(env.DB, b.id))?.status).toBe("disconnected");
  });

  it("returns consent links for Outlook without calling a revoke endpoint", async () => {
    const { app, calls } = setup();
    const a = await seedAccount({ provider: "outlook" });
    const body = await readJson<DisconnectResponse>(await apiFetch(`/api/accounts/${a.id}`, jsonInit("DELETE"), { app }));
    expect(body).toEqual({
      accountId: a.id,
      revocation: "not_supported",
      consentUrls: { personal: "https://account.live.com/consent/Manage", work: "https://myapps.microsoft.com" },
    });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/me-accounts.test.ts`
Expected: FAIL; `GET /api/me` returns `404` (`expected 404 to be 200`) because no routes are mounted.

- [ ] **Step 3: Implement `app/src/worker/routes/me.ts`**

```ts
import { Hono } from "hono";
import type { MeResponse } from "../../shared/api.ts";
import { readSettings } from "../db/settings.ts";
import { toIso } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const config = c.get("config");
  const settings = await readSettings(c.env.DB);
  const body: MeResponse = {
    email: c.get("ownerEmail"),
    environment: config.environment,
    freeTier: config.freeTier,
    providers: { gmail: config.google !== null, outlook: config.microsoft !== null },
    issues: settings.issues,
    tauDelete: settings.tauDelete,
    serverTime: toIso(c.get("deps").now()),
  };
  return c.json(body);
});
```

- [ ] **Step 4: Implement `app/src/worker/routes/accounts.ts`**

```ts
import { MICROSOFT_CONSENT_URLS } from "@clearbox/core";
import { Hono } from "hono";
import { PatchAccountBodySchema } from "../../shared/api.ts";
import type { AccountsResponse, AccountView, DisconnectResponse } from "../../shared/api.ts";
import { decryptToken, importEncKey } from "../crypto/aead.ts";
import { disconnectAccountStmt, getAccount, listAccounts, setPausedStmt, toAccountView } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { countOpenByAccount, dismissOpenStmt } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";

export const accountsRoutes = new Hono<AppEnv>();

/** Non-disconnected account or 404 not_found. */
export async function loadVisibleAccount(db: D1Database, id: string): Promise<Account> {
  const account = await getAccount(db, id);
  if (!account || account.status === "disconnected") throw new ApiError(404, "not_found", "Account not found");
  return account;
}

export async function accountViews(db: D1Database, accounts: readonly Account[]): Promise<AccountView[]> {
  const visible = accounts.filter((a) => a.status !== "disconnected");
  const counts = await countOpenByAccount(db, visible.map((a) => a.id));
  return visible.map((a) => toAccountView(a, counts.get(a.id) ?? { pending: 0, awaitingModel: 0 }));
}

accountsRoutes.get("/", async (c) => {
  const accounts = await listAccounts(c.env.DB, { includeDisconnected: false });
  const body: AccountsResponse = { accounts: await accountViews(c.env.DB, accounts) };
  return c.json(body);
});

accountsRoutes.patch("/:id", async (c) => {
  const body = parseWith(PatchAccountBodySchema, await readJsonBody(c));
  const db = c.env.DB;
  const account = await loadVisibleAccount(db, c.req.param("id"));
  if (account.paused !== body.paused) {
    const now = c.get("deps").now();
    await db.batch([
      setPausedStmt(db, account.id, body.paused, now),
      auditStmt(db, {
        ts: now,
        accountId: account.id,
        kind: body.paused ? "account_paused" : "account_resumed",
        batchId: null,
        count: 0,
        result: {},
      }),
    ]);
  }
  const [view] = await accountViews(db, [await loadVisibleAccount(db, account.id)]);
  if (!view) throw new ApiError(404, "not_found", "Account not found");
  return c.json(view);
});

accountsRoutes.delete("/:id", async (c) => {
  const db = c.env.DB;
  const deps = c.get("deps");
  const config = c.get("config");
  const account = await loadVisibleAccount(db, c.req.param("id"));

  let revocation: DisconnectResponse["revocation"] = "not_supported";
  const revoke = deps.oauth[account.provider].revoke;
  if (revoke) {
    revocation = "failed";
    try {
      if (account.refreshToken) {
        const token = await decryptToken(await importEncKey(config.tokenEncKey), account.refreshToken, {
          accountId: account.id,
          kind: "refresh",
          keyVersion: account.keyVersion,
        });
        revocation = (await revoke(deps.fetch, token)) ? "revoked" : "failed";
      }
    } catch {
      revocation = "failed";
    }
  }

  const now = deps.now();
  await db.batch([
    disconnectAccountStmt(db, account.id, now),
    dismissOpenStmt(db, account.id, now),
    auditStmt(db, { ts: now, accountId: account.id, kind: "account_disconnected", batchId: null, count: 0, result: {} }),
  ]);
  logEvent("account.status", { accountId: account.id, from: account.status, to: "disconnected", reason: "owner" });

  const body: DisconnectResponse = {
    accountId: account.id,
    revocation,
    consentUrls:
      account.provider === "outlook"
        ? { personal: MICROSOFT_CONSENT_URLS.personal, work: MICROSOFT_CONSENT_URLS.work }
        : null,
  };
  return c.json(body);
});

// Plan 04 adds: accountsRoutes.post("/:id/scan", ...) (contracts 7.5 scan now).
```

- [ ] **Step 5: Mount the routes in `app/src/worker/app.ts`**

Add the imports:

```ts
import { accountsRoutes } from "./routes/accounts.ts";
import { meRoutes } from "./routes/me.ts";
```

Change the route block to:

```ts
  // Routes (mounted by later tasks, in this order).
  app.route("/oauth", oauthRoutes);
  app.route("/api", meRoutes);
  app.route("/api/accounts", accountsRoutes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/me-accounts.test.ts test/worker/db-isolation.test.ts`
Expected: PASS, `12 passed` (8 route tests, 4 isolation tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/routes/me.ts app/src/worker/routes/accounts.ts app/src/worker/app.ts app/test/worker/routes/me-accounts.test.ts
git commit -m "feat(worker): add session, account list, pause and disconnect routes"
```

---

### Task 11: Queue summary, sender groups and group detail

**Files:**
- Modify: `app/src/worker/db/suggestions.ts` (append the queue queries)
- Create: `app/src/worker/routes/queue.ts`
- Modify: `app/src/worker/app.ts` (mount `queueRoutes`)
- Test: `app/test/worker/routes/queue.test.ts`, `app/test/worker/db/query-plans.test.ts`

**Interfaces:**
- Consumes: `SqlQuery`, `bindQuery`, `placeholders`, `chunk`, `encodeCursor`, `decodeCursor`, `toIso`, `MAX_BOUND_PARAMS` (Task 6), `encodeGroupKey`, `decodeGroupKey` (Task 7), `listAccounts`, `Account` (Task 7), `readSettings` (Task 6), `parseWith`, `ApiError` (Task 5); api `SummaryQuerySchema`, `GroupsQuerySchema`, `PageQuerySchema`, `QueueSummary`, `SenderGroup`, `SuggestionItem`, `GroupDetail`, `ApiReason`, `ItemSignals`, `Page` (Task 2); from `@clearbox/core`: `renderReason`, `Reason`, `Signals`, `SuggestedAction`, `ActionKind`, `SUGGESTED_ACTIONS`, `buildGmailDeepLink` (plan 02).
- Produces (in `db/suggestions.ts`):
  - `type GroupSort = "confidence_desc" | "count_desc" | "newest"`, `interface GroupFilter { action: SuggestedAction | null; minConfidence: number | null; sender: string | null }`, `interface GroupKeyset { k: number; a: string; s: string; x: SuggestedAction }`, `interface GroupRow { account_id; sender; action; n; cmin; cavg; cmax; capped; domain; newest; oldest; latest }`, `groupsQuery(accountIds, filter, sort, after, limit): SqlQuery`, `groupSortValue(row, sort): number`, `parseLatest(latest: string): { name: string | null; subject: string | null }`.
  - `interface ReasonCountRow { sender; action; code; n; reason_json }`, `groupReasonsQuery(accountId, senders, action: SuggestedAction | null): SqlQuery`.
  - `pendingByActionQuery(accountIds): SqlQuery` (rows `{ action, n, g }`), `awaitingCountQuery(accountIds): SqlQuery` (row `{ n }`), `cleanupCountsQuery(accountIds, actions: readonly ActionKind[], threshold): SqlQuery` (rows `{ action, n, g }`), `groupsLeftQuery(accountIds, actions, threshold): SqlQuery` (row `{ n }`).
  - `interface ItemKeyset { c: number; r: number; i: number }`, `interface GroupItemRow`, `groupItemsQuery(accountId, sender, action, after, limit): SqlQuery`.
- Produces (in `routes/queue.ts`): `queueRoutes` (mounted at `/api`: `GET /queue/summary`, `GET /groups`, `GET /groups/:key`), `scopeAccounts(db, accountId?: string): Promise<Account[]>`, `topReasonsFor(db, groups: readonly { accountId; sender; action }[], action: SuggestedAction | null): Promise<Map<string, ApiReason[]>>` (map key `accountId + U+001F + sender + U+001F + action`), `toSuggestionItem(row, account, now): SuggestionItem`, `CLEANUP_DEFAULT_ACTIONS = ["delete", "archive"]`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/routes/queue.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody, GroupDetail, Page, QueueSummary, SenderGroup } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import type { Account } from "../../../src/worker/db/accounts.ts";
import { encodeGroupKey } from "../../../src/worker/db/suggestions.ts";
import { apiFetch, readJson } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const app = createApp({ now: () => SEED_NOW });
const HOUR = 3_600_000;
let a: Account;
let b: Account;
let aDelete: number[];

beforeAll(async () => {
  a = await seedAccount({ provider: "gmail", email: "queue-a@example.com" });
  b = await seedAccount({ provider: "outlook", email: "queue-b@example.com" });
  aDelete = await seedSuggestions(a.id, 3, (i) => ({
    sender: "news@shop.example.com",
    action: "delete",
    confidence: [0.95, 0.9, 0.85][i] ?? 0.85,
    receivedAt: SEED_NOW - (i + 1) * 24 * HOUR,
    subject: `Deal ${i}`,
  }));
  await seedSuggestions(a.id, 2, { sender: "promo@deals.example.net", senderDomain: "example.net", action: "archive", confidence: 0.7 });
  await seedSuggestions(a.id, 1, { sender: "friend@example.org", senderDomain: "example.org", action: "keep", confidence: 0.8, subject: null });
  await seedSuggestions(a.id, 1, { sender: "x@example.com", action: "unsure", confidence: 0.3 });
  await seedSuggestions(a.id, 1, { status: "awaiting_model" });
  await seedSuggestions(a.id, 1, { status: "executed", finalAction: "delete" });
  await seedSuggestions(b.id, 1, { sender: "news@shop.example.com", action: "delete", confidence: 0.99, webLink: "https://outlook.example.test/item/1" });
});

describe("GET /api/queue/summary", () => {
  it("counts pending suggestions, groups per action and the Clean up preview at tau", async () => {
    const res = await apiFetch("/api/queue/summary", {}, { app });
    expect(res.status).toBe(200);
    expect(await readJson<QueueSummary>(res)).toEqual({
      asOf: new Date(SEED_NOW).toISOString(),
      pending: { delete: 4, archive: 2, keep: 1, unsure: 1, total: 8 },
      awaitingModel: 1,
      groups: 5,
      groupsByAction: { delete: 2, archive: 1, keep: 1, unsure: 1 },
      tauDelete: 0.8,
      cleanup: { threshold: 0.8, count: 4, byAction: { delete: 4, archive: 0, keep: 0 } },
    });
  });

  it("scopes to one account and returns zeros for unknown accounts", async () => {
    const one = await readJson<QueueSummary>(await apiFetch(`/api/queue/summary?accountId=${b.id}`, {}, { app }));
    expect(one.pending).toEqual({ delete: 1, archive: 0, keep: 0, unsure: 0, total: 1 });
    const none = await readJson<QueueSummary>(await apiFetch("/api/queue/summary?accountId=acc_ffffffffffffffff", {}, { app }));
    expect(none.pending.total).toBe(0);
    expect(none.groups).toBe(0);
  });
});

describe("GET /api/groups", () => {
  it("returns sender groups sorted by average confidence", async () => {
    const page = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups", {}, { app }));
    expect(page.items.map((g) => [g.accountId, g.sender, g.action])).toEqual([
      [b.id, "news@shop.example.com", "delete"],
      [a.id, "news@shop.example.com", "delete"],
      [a.id, "friend@example.org", "keep"],
      [a.id, "promo@deals.example.net", "archive"],
      [a.id, "x@example.com", "unsure"],
    ]);
    const group = page.items[1];
    expect(group).toMatchObject({
      key: encodeGroupKey(a.id, "news@shop.example.com", "delete"),
      provider: "gmail",
      senderName: "Shop News",
      domain: "example.com",
      count: 3,
      latestSubject: "Deal 0",
      ceilingApplied: false,
      topReasons: [{ code: "list_unsubscribe", text: "Has an unsubscribe link" }],
      newestReceivedAt: new Date(SEED_NOW - 24 * HOUR).toISOString(),
      oldestReceivedAt: new Date(SEED_NOW - 3 * 24 * HOUR).toISOString(),
    });
    expect(group?.confidence.min).toBeCloseTo(0.85, 9);
    expect(group?.confidence.avg).toBeCloseTo(0.9, 9);
    expect(group?.confidence.max).toBeCloseTo(0.95, 9);
    expect(page.items[2]?.latestSubject).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("pages with an opaque cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const page: Page<SenderGroup> = await readJson<Page<SenderGroup>>(await apiFetch(`/api/groups?limit=2${qs}`, {}, { app }));
      seen.push(...page.items.map((g) => g.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it("filters by action and minimum confidence, and sorts by count", async () => {
    const archive = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups?action=archive", {}, { app }));
    expect(archive.items.map((g) => g.count)).toEqual([2]);
    const confident = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups?minConfidence=0.9", {}, { app }));
    expect(confident.items.map((g) => [g.accountId, g.count])).toEqual([
      [b.id, 1],
      [a.id, 2],
    ]);
    const byCount = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups?sort=count_desc", {}, { app }));
    expect(byCount.items[0]?.count).toBe(3);
  });

  it("rejects malformed cursors and cursors from other filters", async () => {
    const first = await readJson<Page<SenderGroup>>(await apiFetch("/api/groups?limit=1", {}, { app }));
    const other = await apiFetch(`/api/groups?limit=1&action=delete&cursor=${first.nextCursor ?? ""}`, {}, { app });
    expect(other.status).toBe(400);
    expect((await readJson<ApiErrorBody>(other)).error.code).toBe("validation_failed");
    expect((await apiFetch("/api/groups?cursor=%25%25", {}, { app })).status).toBe(400);
    expect((await apiFetch("/api/groups?sort=random", {}, { app })).status).toBe(400);
  });
});

describe("GET /api/groups/:key", () => {
  it("returns the group and its items sorted by confidence, with paging", async () => {
    const key = encodeGroupKey(a.id, "news@shop.example.com", "delete");
    const first = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}?limit=2`, {}, { app }));
    expect(first.group.count).toBe(3);
    expect(first.items.items.map((i) => i.id)).toEqual([aDelete[0], aDelete[1]]);
    const item = first.items.items[0];
    expect(item).toMatchObject({
      accountId: a.id,
      provider: "gmail",
      status: "pending",
      action: "delete",
      confidence: 0.95,
      ceiling: "delete",
      ceilingApplied: false,
      from: { address: "news@shop.example.com", name: "Shop News" },
      subject: "Deal 0",
      snippet: "Synthetic snippet for tests",
      receivedAt: new Date(SEED_NOW - 24 * HOUR).toISOString(),
      isRead: false,
      reasons: [{ code: "list_unsubscribe", text: "Has an unsubscribe link" }],
      modelVersion: "fake/fake-1",
      policyVersion: 1,
    });
    expect(item?.signals.ageDays).toBe(1);
    expect(item?.distribution?.delete).toBeCloseTo(0.95, 9);
    expect(item?.deepLink).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/\?authuser=queue-a%40example\.com#all\/msg-\d+$/);
    const second = await readJson<GroupDetail>(
      await apiFetch(`/api/groups/${key}?limit=2&cursor=${first.items.nextCursor ?? ""}`, {}, { app }),
    );
    expect(second.items.items.map((i) => i.id)).toEqual([aDelete[2]]);
    expect(second.items.nextCursor).toBeNull();
  });

  it("uses the stored webLink for Outlook", async () => {
    const key = encodeGroupKey(b.id, "news@shop.example.com", "delete");
    const detail = await readJson<GroupDetail>(await apiFetch(`/api/groups/${key}`, {}, { app }));
    expect(detail.items.items[0]?.deepLink).toBe("https://outlook.example.test/item/1");
  });

  it("returns 400 for bad keys and 404 for unknown accounts or empty groups", async () => {
    expect((await apiFetch("/api/groups/not-a-key", {}, { app })).status).toBe(400);
    const unknown = encodeGroupKey("acc_ffffffffffffffff", "news@shop.example.com", "delete");
    expect((await apiFetch(`/api/groups/${unknown}`, {}, { app })).status).toBe(404);
    const empty = encodeGroupKey(a.id, "nobody@example.com", "delete");
    expect((await apiFetch(`/api/groups/${empty}`, {}, { app })).status).toBe(404);
  });
});
```

`app/test/worker/db/query-plans.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  awaitingCountQuery,
  cleanupCountsQuery,
  groupItemsQuery,
  groupsQuery,
  pendingByActionQuery,
} from "../../../src/worker/db/suggestions.ts";
import type { SqlQuery } from "../../../src/worker/db/sql.ts";

const ACC = "acc_0000000000000001";

async function plan(q: SqlQuery): Promise<string> {
  const res = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).bind(...q.params).run<{ detail: string }>();
  return res.results.map((r) => r.detail).join("\n");
}

describe("open-suggestion queries use suggestions_open (contracts 6.1)", () => {
  it.each([
    ["queue summary", pendingByActionQuery([ACC])],
    ["awaiting count", awaitingCountQuery([ACC])],
    ["cleanup counts", cleanupCountsQuery([ACC], ["delete", "archive"], 0.8)],
    ["groups", groupsQuery([ACC], { action: null, minConfidence: null, sender: null }, "confidence_desc", null, 50)],
    ["group items", groupItemsQuery(ACC, "news@example.com", "delete", null, 50)],
  ])("%s", async (_name, q) => {
    expect(await plan(q)).toMatch(/USING (?:COVERING )?INDEX suggestions_open/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/queue.test.ts test/worker/db/query-plans.test.ts`
Expected: FAIL; `query-plans.test.ts` with `pendingByActionQuery is not a function` (no such export yet) and `queue.test.ts` with `expected 404 to be 200`.

- [ ] **Step 3: Append the queue queries to `app/src/worker/db/suggestions.ts`**

Add to the existing imports of `suggestions.ts`:

```ts
import type { ActionKind } from "@clearbox/core";
import type { SqlQuery } from "./sql.ts";
```

Append at the end of the file:

```ts
// Queue queries (contracts 7.6). Every one filters account_id and status = 'pending' (or 'awaiting_model') as an
// equality so SQLite uses the suggestions_open partial index.

export type GroupSort = "confidence_desc" | "count_desc" | "newest";

export interface GroupFilter {
  action: SuggestedAction | null;
  minConfidence: number | null;
  sender: string | null;
}

export interface GroupKeyset {
  /** Sort value of the last row on the previous page. */
  k: number;
  a: string;
  s: string;
  x: SuggestedAction;
}

export interface GroupRow {
  account_id: string;
  sender: string;
  action: SuggestedAction;
  n: number;
  cmin: number;
  cavg: number;
  cmax: number;
  capped: number;
  domain: string;
  newest: number;
  oldest: number;
  /** printf('%015d', received_at) || json_array(sender_name, subject) of the newest item. */
  latest: string;
}

const SORT_EXPR: Readonly<Record<GroupSort, string>> = {
  confidence_desc: "AVG(COALESCE(s.confidence, 0))",
  count_desc: "COUNT(*)",
  newest: "MAX(m.received_at)",
};

export function groupSortValue(row: GroupRow, sort: GroupSort): number {
  return sort === "confidence_desc" ? row.cavg : sort === "count_desc" ? row.n : row.newest;
}

export function parseLatest(latest: string): { name: string | null; subject: string | null } {
  const [name, subject] = JSON.parse(latest.slice(15)) as [string | null, string | null];
  return { name: name === "" ? null : name, subject };
}

export function groupsQuery(
  accountIds: readonly string[],
  filter: GroupFilter,
  sort: GroupSort,
  after: GroupKeyset | null,
  limit: number,
): SqlQuery {
  const params: unknown[] = [...accountIds];
  const bind = (value: unknown) => {
    params.push(value);
    return `?${params.length}`;
  };
  const extra: string[] = [];
  if (filter.action !== null) extra.push(`AND s.action = ${bind(filter.action)}`);
  if (filter.minConfidence !== null) extra.push(`AND s.confidence >= ${bind(filter.minConfidence)}`);
  if (filter.sender !== null) extra.push(`AND s.sender = ${bind(filter.sender)}`);
  const expr = SORT_EXPR[sort];
  let having = "";
  if (after) {
    const k = bind(after.k);
    having = `HAVING ${expr} < ${k} OR (${expr} = ${k} AND (s.account_id, s.sender, s.action) > (${bind(after.a)}, ${bind(after.s)}, ${bind(after.x)}))`;
  }
  const lim = bind(limit);
  const sql = `SELECT s.account_id AS account_id, s.sender AS sender, s.action AS action, COUNT(*) AS n,
      MIN(COALESCE(s.confidence, 0)) AS cmin, AVG(COALESCE(s.confidence, 0)) AS cavg, MAX(COALESCE(s.confidence, 0)) AS cmax,
      MAX(s.ceiling_applied) AS capped, MIN(s.sender_domain) AS domain,
      MAX(m.received_at) AS newest, MIN(m.received_at) AS oldest,
      MAX(printf('%015d', m.received_at) || json_array(m.sender_name, m.subject)) AS latest
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id IN (${placeholders(accountIds.length)}) AND s.status = 'pending' ${extra.join(" ")}
    GROUP BY s.account_id, s.sender, s.action
    ${having}
    ORDER BY ${expr} DESC, s.account_id, s.sender, s.action
    LIMIT ${lim}`;
  return { sql, params };
}

export interface ReasonCountRow {
  sender: string;
  action: SuggestedAction;
  code: string;
  n: number;
  reason_json: string;
}

export function groupReasonsQuery(accountId: string, senders: readonly string[], action: SuggestedAction | null): SqlQuery {
  const n = senders.length;
  const sql = `SELECT s.sender AS sender, s.action AS action, json_extract(r.value, '$.code') AS code, COUNT(*) AS n,
      MIN(r.value) AS reason_json
    FROM suggestions s, json_each(s.reasons_json) r
    WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender IN (${placeholders(n, 2)})
      AND (?${n + 2} IS NULL OR s.action = ?${n + 2})
    GROUP BY s.sender, s.action, code`;
  return { sql, params: [accountId, ...senders, action] };
}

export function pendingByActionQuery(accountIds: readonly string[]): SqlQuery {
  const sql = `SELECT action, COUNT(*) AS n, COUNT(DISTINCT account_id || char(31) || sender) AS g
    FROM suggestions WHERE account_id IN (${placeholders(accountIds.length)}) AND status = 'pending'
    GROUP BY action`;
  return { sql, params: [...accountIds] };
}

export function awaitingCountQuery(accountIds: readonly string[]): SqlQuery {
  const sql = `SELECT COUNT(*) AS n FROM suggestions
    WHERE account_id IN (${placeholders(accountIds.length)}) AND status = 'awaiting_model'`;
  return { sql, params: [...accountIds] };
}

export function cleanupCountsQuery(accountIds: readonly string[], actions: readonly ActionKind[], threshold: number): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT action, COUNT(*) AS n, COUNT(DISTINCT account_id || char(31) || sender) AS g
    FROM suggestions
    WHERE account_id IN (${placeholders(a)}) AND status = 'pending'
      AND action IN (${placeholders(actions.length, a + 1)}) AND confidence >= ?${a + actions.length + 1}
    GROUP BY action`;
  return { sql, params: [...accountIds, ...actions, threshold] };
}

/** Contracts 12.1 A2: pending groups that keep at least one item this Clean up would not take. */
export function groupsLeftQuery(accountIds: readonly string[], actions: readonly ActionKind[], threshold: number): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM suggestions
      WHERE account_id IN (${placeholders(a)}) AND status = 'pending'
        AND NOT (action IN (${placeholders(actions.length, a + 1)}) AND COALESCE(confidence, 0) >= ?${a + actions.length + 1})
      GROUP BY account_id, sender, action
    )`;
  return { sql, params: [...accountIds, ...actions, threshold] };
}

export interface ItemKeyset {
  c: number;
  r: number;
  i: number;
}

export interface GroupItemRow {
  message_id: number;
  account_id: string;
  status: "pending";
  action: SuggestedAction;
  confidence: number | null;
  p_delete: number | null;
  p_archive: number | null;
  p_keep: number | null;
  p_unsure: number | null;
  importance: number | null;
  ceiling: "keep" | "archive" | "delete";
  ceiling_applied: number;
  reasons_json: string;
  model_version: string | null;
  policy_version: number;
  provider_msg_id: string;
  sender: string;
  sender_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  is_read: number;
  signals_json: string;
  web_link: string | null;
}

export function groupItemsQuery(
  accountId: string,
  sender: string,
  action: SuggestedAction,
  after: ItemKeyset | null,
  limit: number,
): SqlQuery {
  const keyset = after
    ? `AND (COALESCE(s.confidence, 0) < ?4 OR (COALESCE(s.confidence, 0) = ?4
         AND (m.received_at < ?5 OR (m.received_at = ?5 AND s.message_id < ?6))))`
    : "AND ?4 IS NULL AND ?5 IS NULL AND ?6 IS NULL";
  const sql = `SELECT s.message_id, s.account_id, s.status, s.action, s.confidence, s.p_delete, s.p_archive, s.p_keep,
      s.p_unsure, s.importance, s.ceiling, s.ceiling_applied, s.reasons_json, s.model_version, s.policy_version,
      m.provider_msg_id, m.sender, m.sender_name, m.subject, m.snippet, m.received_at, m.is_read, m.signals_json, m.web_link
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender = ?2 AND s.action = ?3 ${keyset}
    ORDER BY COALESCE(s.confidence, 0) DESC, m.received_at DESC, s.message_id DESC
    LIMIT ?7`;
  return {
    sql,
    params: [accountId, sender, action, after?.c ?? null, after?.r ?? null, after?.i ?? null, limit],
  };
}
```

- [ ] **Step 4: Implement `app/src/worker/routes/queue.ts`**

```ts
import { buildGmailDeepLink, renderReason, SUGGESTED_ACTIONS } from "@clearbox/core";
import type { ActionKind, Reason, Signals, SuggestedAction } from "@clearbox/core";
import { Hono } from "hono";
import { z } from "zod";
import { GroupsQuerySchema, PageQuerySchema, SummaryQuerySchema } from "../../shared/api.ts";
import type { ApiReason, GroupDetail, ItemSignals, Page, QueueSummary, SenderGroup, SuggestionItem } from "../../shared/api.ts";
import { listAccounts } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, chunk, decodeCursor, encodeCursor, flag, MAX_BOUND_PARAMS, toIso } from "../db/sql.ts";
import {
  awaitingCountQuery,
  cleanupCountsQuery,
  decodeGroupKey,
  encodeGroupKey,
  groupItemsQuery,
  groupReasonsQuery,
  groupSortValue,
  groupsQuery,
  parseLatest,
  pendingByActionQuery,
} from "../db/suggestions.ts";
import type { GroupItemRow, GroupRow, ReasonCountRow } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";

/** Contracts 12.3: Keep suggestions are excluded from Clean up. */
export const CLEANUP_DEFAULT_ACTIONS: readonly ActionKind[] = ["delete", "archive"];

export const queueRoutes = new Hono<AppEnv>();

const zeroByAction = (): Record<SuggestedAction, number> => ({ delete: 0, archive: 0, keep: 0, unsure: 0 });

/** Visible accounts, optionally narrowed to one id (unknown ids give an empty scope). */
export async function scopeAccounts(db: D1Database, accountId?: string): Promise<Account[]> {
  const accounts = await listAccounts(db, { includeDisconnected: false });
  return accountId === undefined ? accounts : accounts.filter((a) => a.id === accountId);
}

const groupMapKey = (accountId: string, sender: string, action: string) => `${accountId}\u001f${sender}\u001f${action}`;

function toApiReason(reasonJson: string): ApiReason {
  const reason = JSON.parse(reasonJson) as Reason;
  return { code: reason.code, text: renderReason(reason) };
}

/** Top 3 reason codes per group (decision 15). */
export async function topReasonsFor(
  db: D1Database,
  groups: readonly { accountId: string; sender: string; action: SuggestedAction }[],
  action: SuggestedAction | null,
): Promise<Map<string, ApiReason[]>> {
  const sendersByAccount = new Map<string, Set<string>>();
  for (const g of groups) {
    const set = sendersByAccount.get(g.accountId) ?? new Set<string>();
    set.add(g.sender);
    sendersByAccount.set(g.accountId, set);
  }
  const queries: { accountId: string; q: ReturnType<typeof groupReasonsQuery> }[] = [];
  for (const [accountId, senders] of sendersByAccount) {
    for (const part of chunk([...senders], MAX_BOUND_PARAMS - 2)) {
      queries.push({ accountId, q: groupReasonsQuery(accountId, part, action) });
    }
  }
  const out = new Map<string, ApiReason[]>();
  if (queries.length === 0) return out;
  const results = await db.batch<ReasonCountRow>(queries.map((x) => bindQuery(db, x.q)));
  const counts = new Map<string, ReasonCountRow[]>();
  results.forEach((res, idx) => {
    const accountId = queries[idx]?.accountId ?? "";
    for (const row of res.results) {
      const key = groupMapKey(accountId, row.sender, row.action);
      counts.set(key, [...(counts.get(key) ?? []), row]);
    }
  });
  for (const [key, rows] of counts) {
    rows.sort((x, y) => y.n - x.n || x.code.localeCompare(y.code));
    out.set(key, rows.slice(0, 3).map((r) => toApiReason(r.reason_json)));
  }
  return out;
}

function toSenderGroup(row: GroupRow, account: Account, reasons: Map<string, ApiReason[]>): SenderGroup {
  const latest = parseLatest(row.latest);
  return {
    key: encodeGroupKey(row.account_id, row.sender, row.action),
    accountId: row.account_id,
    provider: account.provider,
    sender: row.sender,
    senderName: latest.name,
    domain: row.domain,
    action: row.action,
    count: row.n,
    confidence: { min: row.cmin, avg: row.cavg, max: row.cmax },
    topReasons: reasons.get(groupMapKey(row.account_id, row.sender, row.action)) ?? [],
    ceilingApplied: flag(row.capped),
    newestReceivedAt: toIso(row.newest),
    oldestReceivedAt: toIso(row.oldest),
    latestSubject: latest.subject,
  };
}

function itemSignals(signals: Signals, receivedAt: number, now: number): ItemSignals {
  return {
    hasListUnsubscribe: signals.hasListUnsubscribe,
    precedenceBulk: signals.precedenceBulk,
    autoSubmitted: signals.autoSubmitted,
    category: signals.category,
    hasAttachments: signals.hasAttachments,
    starred: signals.starred,
    ownerReplied: signals.ownerReplied,
    isCorrespondent: signals.isCorrespondent,
    ageDays: Math.max(0, Math.floor((now - receivedAt) / 86_400_000)),
    ownerPosition: signals.ownerPosition,
    auth: signals.auth,
  };
}

export function toSuggestionItem(row: GroupItemRow, account: Account, now: number): SuggestionItem {
  const hasDistribution = row.p_delete !== null && row.p_archive !== null && row.p_keep !== null && row.p_unsure !== null;
  const reasons = (JSON.parse(row.reasons_json) as Reason[]).map((r) => ({ code: r.code, text: renderReason(r) }));
  return {
    id: row.message_id,
    accountId: row.account_id,
    provider: account.provider,
    status: row.status,
    action: row.action,
    confidence: row.confidence ?? 0,
    distribution: hasDistribution
      ? { delete: row.p_delete ?? 0, archive: row.p_archive ?? 0, keep: row.p_keep ?? 0, unsure: row.p_unsure ?? 0 }
      : null,
    importance: row.importance,
    ceiling: row.ceiling,
    ceilingApplied: flag(row.ceiling_applied),
    reasons,
    from: { address: row.sender, name: row.sender_name },
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: toIso(row.received_at),
    isRead: flag(row.is_read),
    signals: itemSignals(JSON.parse(row.signals_json) as Signals, row.received_at, now),
    // Gmail links come from plan 02's buildGmailDeepLink; Graph stores webLink per message.
    deepLink: account.provider === "gmail" ? buildGmailDeepLink(account.email, row.provider_msg_id) : row.web_link,
    modelVersion: row.model_version,
    policyVersion: row.policy_version,
  };
}

queueRoutes.get("/queue/summary", async (c) => {
  const q = parseWith(SummaryQuerySchema, c.req.query());
  const db = c.env.DB;
  const now = c.get("deps").now();
  const settings = await readSettings(db);
  const ids = (await scopeAccounts(db, q.accountId)).map((a) => a.id);
  const pending = { ...zeroByAction(), total: 0 };
  const groupsByAction = zeroByAction();
  const byAction: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  let awaitingModel = 0;
  if (ids.length > 0) {
    const [byActionRes, awaitingRes, cleanupRes] = await db.batch([
      bindQuery(db, pendingByActionQuery(ids)),
      bindQuery(db, awaitingCountQuery(ids)),
      bindQuery(db, cleanupCountsQuery(ids, CLEANUP_DEFAULT_ACTIONS, settings.tauDelete)),
    ]);
    for (const row of (byActionRes?.results ?? []) as { action: SuggestedAction; n: number; g: number }[]) {
      pending[row.action] = row.n;
      pending.total += row.n;
      groupsByAction[row.action] = row.g;
    }
    awaitingModel = ((awaitingRes?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
    for (const row of (cleanupRes?.results ?? []) as { action: ActionKind; n: number }[]) byAction[row.action] = row.n;
  }
  const body: QueueSummary = {
    asOf: toIso(now),
    pending,
    awaitingModel,
    groups: Object.values(groupsByAction).reduce((s, n) => s + n, 0),
    groupsByAction,
    tauDelete: settings.tauDelete,
    cleanup: {
      threshold: settings.tauDelete,
      count: byAction.delete + byAction.archive + byAction.keep,
      byAction,
    },
  };
  return c.json(body);
});

const GroupCursorSchema = z.strictObject({
  v: z.literal(1),
  f: z.string(),
  k: z.number(),
  a: z.string(),
  s: z.string(),
  x: z.enum(SUGGESTED_ACTIONS),
});

queueRoutes.get("/groups", async (c) => {
  const q = parseWith(GroupsQuerySchema, c.req.query());
  const db = c.env.DB;
  const fingerprint = JSON.stringify([q.accountId ?? null, q.action ?? null, q.sort, q.minConfidence ?? null]);
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, GroupCursorSchema);
  if (cursor && cursor.f !== fingerprint) throw new ApiError(400, "validation_failed", "Cursor does not match the filters");
  const accounts = await scopeAccounts(db, q.accountId);
  const page: Page<SenderGroup> = { items: [], nextCursor: null };
  if (accounts.length > 0) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const query = groupsQuery(
      accounts.map((a) => a.id),
      { action: q.action ?? null, minConfidence: q.minConfidence ?? null, sender: null },
      q.sort,
      cursor ? { k: cursor.k, a: cursor.a, s: cursor.s, x: cursor.x } : null,
      q.limit + 1,
    );
    const rows = (await bindQuery(db, query).run<GroupRow>()).results;
    const pageRows = rows.slice(0, q.limit);
    const reasons = await topReasonsFor(
      db,
      pageRows.map((r) => ({ accountId: r.account_id, sender: r.sender, action: r.action })),
      q.action ?? null,
    );
    for (const row of pageRows) {
      const account = byId.get(row.account_id);
      if (account) page.items.push(toSenderGroup(row, account, reasons));
    }
    const last = pageRows[pageRows.length - 1];
    if (rows.length > q.limit && last) {
      page.nextCursor = encodeCursor({ v: 1, f: fingerprint, k: groupSortValue(last, q.sort), a: last.account_id, s: last.sender, x: last.action });
    }
  }
  return c.json(page);
});

const ItemCursorSchema = z.strictObject({ v: z.literal(1), f: z.string(), c: z.number(), r: z.int(), i: z.int() });

queueRoutes.get("/groups/:key", async (c) => {
  const key = c.req.param("key");
  const decoded = decodeGroupKey(key);
  if (!decoded) throw new ApiError(400, "validation_failed", "Malformed group key");
  const q = parseWith(PageQuerySchema, c.req.query());
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, ItemCursorSchema);
  if (cursor && cursor.f !== key) throw new ApiError(400, "validation_failed", "Cursor does not match the group");
  const db = c.env.DB;
  const now = c.get("deps").now();
  const [account] = await scopeAccounts(db, decoded.accountId);
  if (!account) throw new ApiError(404, "not_found", "Group not found");

  const [groupRes, itemsRes] = await db.batch([
    bindQuery(db, groupsQuery([account.id], { action: decoded.action, minConfidence: null, sender: decoded.sender }, "confidence_desc", null, 1)),
    bindQuery(db, groupItemsQuery(account.id, decoded.sender, decoded.action, cursor ? { c: cursor.c, r: cursor.r, i: cursor.i } : null, q.limit + 1)),
  ]);
  const groupRow = (groupRes?.results ?? [])[0] as GroupRow | undefined;
  if (!groupRow) throw new ApiError(404, "not_found", "Group not found");
  const reasons = await topReasonsFor(db, [{ accountId: account.id, sender: decoded.sender, action: decoded.action }], decoded.action);
  const rows = (itemsRes?.results ?? []) as GroupItemRow[];
  const pageRows = rows.slice(0, q.limit);
  const last = pageRows[pageRows.length - 1];
  const body: GroupDetail = {
    asOf: toIso(now),
    group: toSenderGroup(groupRow, account, reasons),
    items: {
      items: pageRows.map((row) => toSuggestionItem(row, account, now)),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ v: 1, f: key, c: last.confidence ?? 0, r: last.received_at, i: last.message_id })
          : null,
    },
  };
  return c.json(body);
});
```

- [ ] **Step 5: Mount the routes in `app/src/worker/app.ts`**

Add the import:

```ts
import { queueRoutes } from "./routes/queue.ts";
```

Append to the route block (after `accountsRoutes`):

```ts
  app.route("/api", queueRoutes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/queue.test.ts test/worker/db/query-plans.test.ts test/worker/db-isolation.test.ts`
Expected: PASS, `18 passed` (9 queue, 5 query plans, 4 isolation).

If a query plan assertion fails because the planner prefers a full scan on an empty table, seed 50 pending rows for `ACC` in a `beforeAll` of `query-plans.test.ts` with `seedAccount({ id: ACC })` and `seedSuggestions(ACC, 50)` and rerun. The index choice must then show `suggestions_open`.

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/db/suggestions.ts app/src/worker/routes/queue.ts app/src/worker/app.ts app/test/worker/routes/queue.test.ts app/test/worker/db/query-plans.test.ts
git commit -m "feat(worker): add queue summary, sender groups and group detail routes"
```

---

### Task 12: Owner action execution (approve, override, Clean up)

**Files:**
- Modify: `app/src/worker/db/suggestions.ts` (append execution queries)
- Create: `app/src/worker/actions/learn.ts`
- Create: `app/src/worker/actions/execute.ts`
- Modify: `app/test/worker/db/query-plans.test.ts` (add the cleanup selection)
- Test: `app/test/worker/actions/execute.test.ts`

**Interfaces:**
- Consumes: `SqlQuery`, `bindQuery`, `placeholders`, `chunk`, `MAX_BOUND_PARAMS`, `sumRowsWritten`, `sumRowsRead`, `utcDate`, `nextUtcMidnight`, `toIso` (Task 6), `readBudget`, `budgetDeltaStmt`, `readSettings`, `addIssue`, `setIssuesStmt`, `issuesEqual`, `auditStmt` (Task 6), `listAccounts`, `markAccountStatusStmt`, `Account` (Task 7), `insertLabelStmt`, `LabelInsert`, `LabelSource` (Task 7), `addPriorDelta`, `priorStatements`, `PriorDeltaMap` (Task 7), `insertBatchStmt`, `BatchKind` (Task 7), `updateProviderMsgIdStmt` (Task 7), `createD1TokenSource`, `refreshFnFor`, `tokenUpdateStmt` (Task 8), `importEncKey` (Task 4), `callbackPath` (Task 5), `clientIssueCode` (Task 9), `ApiError` (Task 5), `logEvent` (Task 3), `AppConfig`, `AppDeps` (Tasks 3, 5); api `ActionResponse`, `ItemResult`, `ItemErrorCode`, `ItemOutcome`, `SuggestionStatus` (Task 2); from `@clearbox/core`: `ActionKind`, `ActionErrorCode`, `SuggestedAction`, `Ceiling`, `priorDelta`, `ClearboxError`, `ProviderAuthError`, `ProviderConfigError`, `ProviderRateLimitError`, `ProviderUnavailableError`, `BUDGET_ROWS_PER_DAY`, `DECIDED_TTL_MS`, `UNDO_WINDOW_MS`, `MAX_ITEMS_PER_ACTION_REQUEST`, `LABEL_SUBJECT_MAX_CHARS`.
- Produces:
  - `db/suggestions.ts`: `interface TargetRow { message_id; account_id; status: SuggestionStatus; action: SuggestedAction | null; confidence; p_delete; margin; ceiling; model_version; policy_version; sender; sender_domain; provider_msg_id; subject; final_action: ActionKind | null; label_id: number | null }`, `targetsByIdsQuery(accountIds, ids)`, `targetsForGroupQuery(accountId, sender, action, asOf, limit)`, `targetsForCleanupQuery(accountIds, actions, threshold, asOf, limit)`, `remainingGroupQuery(accountId, sender, action, asOf)`, `remainingCleanupQuery(accountIds, actions, threshold, asOf)`, `claimQuery(accountId, ids, now)` (`RETURNING message_id`), `markExecutedQuery(accountId, messageId, finalAction, decidedVia, decidedAt, expiresAt)`, `markFailedQuery(accountId, messageId, code, now)`, `releaseQuery(accountId, ids, now)`, `undoTargetsQuery(accountIds, batchId, ids)`, `markUndoneQuery(accountId, messageId, now)`.
  - `actions/learn.ts`: `interface DecidedItem { messageId; accountId; sender; senderDomain; subject: string | null; suggestedAction: SuggestedAction; ownerAction: ActionKind; pDelete: number | null; margin: number | null; ceiling: Ceiling; modelVersion: string | null; policyVersion: number }`, `truncateSubject(subject, labelSubjects): string | null`, `labelFor(item, source: LabelSource, labelSubjects: boolean, now): LabelInsert`, `decisionPriorDeltas(items): PriorDeltaMap`, `interface UndoneItem { accountId; sender; senderDomain; finalAction: ActionKind }`, `undoPriorDeltas(items): PriorDeltaMap`.
  - `actions/execute.ts`: `type ExecuteRequest = { kind: "approve_ids"; ids: readonly number[] } | { kind: "approve_group"; accountId: string; sender: string; action: ActionKind; asOf: number } | { kind: "override"; ids: readonly number[]; action: ActionKind } | { kind: "cleanup"; actions: readonly ActionKind[]; threshold: number; accountId: string | null; asOf: number }`, `interface ActionContext { db: D1Database; config: AppConfig; deps: AppDeps; requestId: string; origin: string }`, `assertOwnerBudget(budget: Budget, config: AppConfig, now: number): void` (throws `429 budget_exhausted`), `mapActionError(code: ActionErrorCode): ItemErrorCode`, `isTransient(code: ActionErrorCode): boolean`, `classifyProviderError(err): { code: ItemErrorCode; authError: ProviderAuthError | ProviderConfigError | null }`, `openProvider(ctx, account, encKey): { provider: MailProvider; tokens: D1TokenSource }`, `interface AccountFailure { account: Account; error: ProviderAuthError | ProviderConfigError }`, `accountFailureStatements(db, failures, issues, now): D1PreparedStatement[]` (the last four are shared with undo), `executeSuggestions(ctx, req): Promise<ActionResponse>`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/actions/execute.test.ts`:

```ts
import { ProviderAuthError, ProviderConfigError, ProviderRateLimitError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSuggestions } from "../../../src/worker/actions/execute.ts";
import type { ActionContext, ExecuteRequest } from "../../../src/worker/actions/execute.ts";
import { defaultDeps } from "../../../src/worker/app.ts";
import { decryptToken } from "../../../src/worker/crypto/aead.ts";
import { getAccount } from "../../../src/worker/db/accounts.ts";
import type { Account } from "../../../src/worker/db/accounts.ts";
import { budgetDeltaStmt, readBudget } from "../../../src/worker/db/budget.ts";
import { readSettings } from "../../../src/worker/db/settings.ts";
import { readConfig } from "../../../src/worker/env.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { TEST_ORIGIN } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions, testEncKey } from "../helpers/seed.ts";

const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

function context(provider: FakeProvider, envPatch: Record<string, string> = {}): ActionContext {
  const result = readConfig({ ...env, ...envPatch } as Env);
  if (!result.ok) throw new Error("config");
  return {
    db: env.DB,
    config: result.config,
    deps: defaultDeps({ now: () => SEED_NOW, providerFactory: provider.factory(), oauth: fakeOAuth().oauth }),
    requestId: "00000000-0000-4000-8000-0000000000aa",
    origin: TEST_ORIGIN,
  };
}

const run = (provider: FakeProvider, req: ExecuteRequest) => executeSuggestions(context(provider), req);

async function rows(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).bind(...params).run<Record<string, unknown>>()).results;
}

describe("approve ids", () => {
  it("trashes and archives exact pending ids and records labels, priors, batch and audit", async () => {
    const acc = await seedAccount({ email: "exec1@example.com" });
    const [d1, d2] = await seedSuggestions(acc.id, 2, { action: "delete", subject: "x".repeat(80) });
    const [ar] = await seedSuggestions(acc.id, 1, { action: "archive", sender: "bill@example.net", senderDomain: "example.net" });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [ar ?? 0, d1 ?? 0, d2 ?? 0] });

    expect(res).toMatchObject({ executed: 3, failed: 0, skipped: 0, retryLater: 0, remaining: 0 });
    expect(res.results.map((r) => [r.id, r.outcome, r.action])).toEqual([
      [ar, "executed", "archive"],
      [d1, "executed", "delete"],
      [d2, "executed", "delete"],
    ]);
    expect(fake.calls.map((c) => [c.method, c.ids.length])).toEqual([
      ["trash", 2],
      ["archive", 1],
    ]);
    const s = await getSuggestionRow(d1 ?? 0);
    expect(s).toMatchObject({ status: "executed", final_action: "delete", decided_via: "approve", batch_id: res.batchId, decided_at: SEED_NOW, expires_at: SEED_NOW + 30 * DAY });
    const label = await rows("SELECT * FROM labels WHERE account_id = ?1 AND id = ?2", acc.id, s?.["label_id"]);
    expect(label[0]).toMatchObject({ message_id: d1, owner_action: "delete", suggested_action: "delete", source: "approve" });
    expect(String(label[0]?.["subject_trunc"])).toHaveLength(60);
    expect(await rows("SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key", acc.id)).toEqual([
      { key: "@example.com", deletes: 2, keeps: 0 },
      { key: "@example.net", deletes: 0, keeps: 1 },
      { key: "bill@example.net", deletes: 0, keeps: 1 },
      { key: "news@shop.example.com", deletes: 2, keeps: 0 },
    ]);
    const batch = await rows("SELECT * FROM action_batches WHERE id = ?1", res.batchId);
    expect(batch[0]).toMatchObject({ kind: "approve", requested_count: 3, executed_count: 3, failed_count: 0, undo_expires_at: SEED_NOW + DAY });
    expect(JSON.parse(String(batch[0]?.["suggestion_ids_json"]))).toEqual([ar, d1, d2]);
    const audit = await rows("SELECT kind, account_id, batch_id, count, result_json FROM audit_log WHERE batch_id = ?1", res.batchId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "approve", account_id: acc.id, count: 3 });
    expect(JSON.parse(String(audit[0]?.["result_json"]))).toEqual({
      executed: 3, failed: 0, skipped: 0, retryLater: 0, delete: 2, archive: 1, keep: 0, groups: 2,
    });
  });

  it("never touches the provider without a pending suggestion; repeats are idempotent", async () => {
    const acc = await seedAccount();
    const gone = await seedAccount({ status: "disconnected" });
    const [pending] = await seedSuggestions(acc.id, 1);
    const [done] = await seedSuggestions(acc.id, 1, { status: "executed", finalAction: "delete" });
    const [unsure] = await seedSuggestions(acc.id, 1, { action: "unsure", confidence: 0.3 });
    const [other] = await seedSuggestions(gone.id, 1);
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [done ?? 0, unsure ?? 0, other ?? 0, 999_999] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["skipped", "not_pending"],
      ["skipped", "unsure_not_approvable"],
      ["skipped", "not_pending"],
      ["skipped", "not_pending"],
    ]);
    expect(res.batchId).toBeNull();
    expect(fake.calls).toEqual([]);
    await run(fake, { kind: "approve_ids", ids: [pending ?? 0] });
    const again = await run(fake, { kind: "approve_ids", ids: [pending ?? 0] });
    expect(again).toMatchObject({ executed: 0, skipped: 1, batchId: null });
    expect(fake.calls).toHaveLength(1);
  });

  it("executes keep without a provider call", async () => {
    const acc = await seedAccount();
    const [k] = await seedSuggestions(acc.id, 1, { action: "keep", confidence: 0.8 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [k ?? 0] });
    expect(res.executed).toBe(1);
    expect(fake.calls).toEqual([]);
    expect((await getSuggestionRow(k ?? 0))?.["final_action"]).toBe("keep");
  });
});

describe("provider failures", () => {
  it("maps per-item results and updates moved Graph ids", async () => {
    const acc = await seedAccount({ provider: "outlook" });
    const [ok, missing, throttled] = await seedSuggestions(acc.id, 3);
    const pid = async (id: number | undefined) => String((await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", id))[0]?.["provider_msg_id"]);
    const fake = new FakeProvider({
      newIdFor: (id) => `${id}-moved`,
      results: new Map([
        [await pid(missing), { id: await pid(missing), ok: false, error: "not_found", retryAfterMs: null }],
        [await pid(throttled), { id: await pid(throttled), ok: false, error: "rate_limited", retryAfterMs: 1000 }],
      ]),
    });
    const before = await pid(ok);
    const res = await run(fake, { kind: "approve_ids", ids: [ok ?? 0, missing ?? 0, throttled ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["executed", null],
      ["failed", "not_found"],
      ["retry_later", "rate_limited"],
    ]);
    expect(await pid(ok)).toBe(`${before}-moved`);
    expect((await getSuggestionRow(missing ?? 0))?.["status"]).toBe("failed");
    expect((await getSuggestionRow(missing ?? 0))?.["exec_error"]).toBe("not_found");
    expect((await getSuggestionRow(throttled ?? 0))?.["status"]).toBe("pending");
  });

  it("returns every item to pending on a whole-call rate limit", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2);
    const fake = new FakeProvider({ failWith: { trash: new ProviderRateLimitError({ provider: "gmail", retryAfterMs: 1000 }) } });
    const res = await run(fake, { kind: "approve_ids", ids });
    expect(res.results.map((r) => r.error)).toEqual(["rate_limited", "rate_limited"]);
    expect(res.batchId).toBeNull();
    for (const id of ids) expect((await getSuggestionRow(id))?.["status"]).toBe("pending");
  });

  it("marks the account needs_reauth on ProviderAuthError and still serves other accounts", async () => {
    const bad = await seedAccount();
    const good = await seedAccount();
    const [b1] = await seedSuggestions(bad.id, 1);
    const [g1] = await seedSuggestions(good.id, 1);
    const badIds = new Set((await rows("SELECT provider_msg_id FROM messages WHERE id = ?1", b1)).map((r) => String(r["provider_msg_id"])));
    const fake = new FakeProvider();
    const factory = fake.factory();
    const ctx = context(fake);
    ctx.deps = {
      ...ctx.deps,
      providerFactory: (target, deps) => {
        const p = factory(target, deps);
        return {
          ...p,
          trash: async (ids: readonly string[]) =>
            ids.some((i) => badIds.has(i))
              ? Promise.reject(new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" }))
              : p.trash(ids),
        };
      },
    };
    const res = await executeSuggestions(ctx, { kind: "approve_ids", ids: [b1 ?? 0, g1 ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["retry_later", "account_inactive"],
      ["executed", null],
    ]);
    expect(await getAccount(env.DB, bad.id)).toMatchObject({ status: "needs_reauth", statusReason: "invalid_grant" });
    expect(await rows("SELECT kind FROM audit_log WHERE account_id = ?1", bad.id)).toEqual([{ kind: "reauth_required" }]);
    expect((await getSuggestionRow(b1 ?? 0))?.["status"]).toBe("pending");
  });

  it("marks config_error and raises the client issue on ProviderConfigError", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const fake = new FakeProvider({ failWith: { trash: new ProviderConfigError({ provider: "gmail", reason: "invalid_client" }) } });
    await run(fake, { kind: "approve_ids", ids });
    expect((await getAccount(env.DB, acc.id))?.status).toBe("config_error");
    expect((await readSettings(env.DB)).issues.map((i) => i.code)).toContain("google_client_invalid");
  });

  it("skips the provider for inactive accounts and Outlook archive without a folder", async () => {
    const inactive = await seedAccount({ status: "needs_reauth" });
    const [del] = await seedSuggestions(inactive.id, 1);
    const [keep] = await seedSuggestions(inactive.id, 1, { action: "keep", confidence: 0.9 });
    const noFolder = await seedAccount({ provider: "outlook", archiveFolderId: null });
    const [arch] = await seedSuggestions(noFolder.id, 1, { action: "archive", confidence: 0.9 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_ids", ids: [del ?? 0, keep ?? 0, arch ?? 0] });
    expect(res.results.map((r) => [r.outcome, r.error])).toEqual([
      ["retry_later", "account_inactive"],
      ["executed", null],
      ["failed", "archive_unavailable"],
    ]);
    expect(fake.calls).toEqual([]);
    expect((await getSuggestionRow(del ?? 0))?.["status"]).toBe("pending");
  });

  it("persists a rotated Microsoft refresh token after an action", async () => {
    const acc = await seedAccount({ provider: "outlook", accessToken: null });
    const ids = await seedSuggestions(acc.id, 1);
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const stored = await getAccount(env.DB, acc.id);
    const token = await decryptToken(await testEncKey(), stored?.refreshToken ?? { ciphertext: new Uint8Array(), iv: new Uint8Array() }, {
      accountId: acc.id,
      kind: "refresh",
      keyVersion: 1,
    });
    expect(token).toBe("rotated-refresh");
  });
});

describe("override, group approve and Clean up", () => {
  it("override ignores the guardrail ceiling and records the owner action", async () => {
    const acc = await seedAccount();
    const [id] = await seedSuggestions(acc.id, 1, { action: "keep", ceiling: "keep", confidence: 0.9 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "override", ids: [id ?? 0], action: "delete" });
    expect(res.results[0]).toMatchObject({ outcome: "executed", action: "delete" });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash"]);
    const s = await getSuggestionRow(id ?? 0);
    expect(s?.["decided_via"]).toBe("override");
    expect((await rows("SELECT suggested_action, owner_action, source FROM labels WHERE id = ?1", s?.["label_id"]))[0]).toEqual({
      suggested_action: "keep",
      owner_action: "delete",
      source: "override",
    });
  });

  it("approves a group up to 100 items created before asOf and reports the remaining count", async () => {
    const acc = await seedAccount();
    await seedSuggestions(acc.id, 103, (i) => ({ sender: "bulk@example.com", confidence: 0.9 - i * 0.001 }));
    await seedSuggestions(acc.id, 1, { sender: "bulk@example.com", createdAt: SEED_NOW + 1 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "approve_group", accountId: acc.id, sender: "bulk@example.com", action: "delete", asOf: SEED_NOW });
    expect(res.executed).toBe(100);
    expect(res.remaining).toBe(3);
    expect(fake.calls[0]?.ids).toHaveLength(100);
    const next = await run(fake, { kind: "approve_group", accountId: acc.id, sender: "bulk@example.com", action: "delete", asOf: SEED_NOW });
    expect(next).toMatchObject({ executed: 3, remaining: 0 });
  });

  it("cleans up by threshold and action, and supports Confirm all keeps", async () => {
    const acc = await seedAccount();
    const [high] = await seedSuggestions(acc.id, 1, { sender: "c1@example.com", action: "delete", confidence: 0.95 });
    const [low] = await seedSuggestions(acc.id, 1, { sender: "c2@example.com", action: "delete", confidence: 0.6 });
    const [keep] = await seedSuggestions(acc.id, 1, { sender: "c3@example.com", action: "keep", confidence: 0.9 });
    const fake = new FakeProvider();
    const res = await run(fake, { kind: "cleanup", actions: ["delete", "archive"], threshold: 0.9, accountId: acc.id, asOf: SEED_NOW });
    expect(res.results.map((r) => r.id)).toEqual([high]);
    expect(res.remaining).toBe(0);
    expect((await getSuggestionRow(low ?? 0))?.["status"]).toBe("pending");
    const keeps = await run(fake, { kind: "cleanup", actions: ["keep"], threshold: 0.5, accountId: acc.id, asOf: SEED_NOW });
    expect(keeps.results.map((r) => [r.id, r.outcome, r.action])).toEqual([[keep, "executed", "keep"]]);
    expect((await getSuggestionRow(keep ?? 0))?.["decided_via"]).toBe("cleanup");
  });
});

describe("budget and logging", () => {
  it("refuses owner actions at the daily cap on Free and counts written rows", async () => {
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    const date = new Date(SEED_NOW).toISOString().slice(0, 10);
    const before = (await readBudget(env.DB, date)).rowsWritten;
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const after = await readBudget(env.DB, date);
    expect(after.rowsWritten).toBeGreaterThan(before);
    expect(after.providerCalls).toBeGreaterThanOrEqual(1);

    await budgetDeltaStmt(env.DB, date, { rowsWritten: 90_000 }, SEED_NOW).run();
    const more = await seedSuggestions(acc.id, 1);
    const err = await run(new FakeProvider(), { kind: "approve_ids", ids: more }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "budget_exhausted", retryAt: new Date(SEED_NOW + DAY / 2).toISOString() });
    const paid = await executeSuggestions(context(new FakeProvider(), { FREE_TIER: "false" }), { kind: "approve_ids", ids: more });
    expect(paid.executed).toBe(1);
  });

  it("logs action.executed with counts only", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const acc: Account = await seedAccount({ email: "logged@example.com" });
    const ids = await seedSuggestions(acc.id, 1);
    await run(new FakeProvider(), { kind: "approve_ids", ids });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const event = JSON.parse(lines.find((l) => l.includes('"evt":"action.executed"')) ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({ kind: "approve", executed: 1, failed: 0, skipped: 0, retryLater: 0 });
    expect(lines.join("\n")).not.toMatch(/logged@example\.com|news@shop|msg-/);
  });
});
```


Add the cleanup and group selections to `app/test/worker/db/query-plans.test.ts`: extend the import list with `targetsForCleanupQuery` and `targetsForGroupQuery`, and add these two rows to the `it.each` table:

```ts
    ["cleanup selection", targetsForCleanupQuery([ACC], ["delete", "archive"], 0.8, 1_000, 100)],
    ["group selection", targetsForGroupQuery(ACC, "news@example.com", "delete", 1_000, 100)],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/actions/execute.test.ts test/worker/db/query-plans.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/actions/execute.ts`; `query-plans.test.ts` fails with `targetsForCleanupQuery is not a function`.

- [ ] **Step 3: Append the execution queries to `app/src/worker/db/suggestions.ts`**

Add `SuggestionStatus` to the imports of `suggestions.ts`:

```ts
import type { SuggestionStatus } from "../../shared/api.ts";
```

Append at the end of the file:

```ts
// Execution queries (contracts 7.7, 7.8). Claims are guarded by WHERE status = 'pending'.

export interface TargetRow {
  message_id: number;
  account_id: string;
  status: SuggestionStatus;
  action: SuggestedAction | null;
  confidence: number | null;
  p_delete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  model_version: string | null;
  policy_version: number;
  sender: string;
  sender_domain: string;
  final_action: ActionKind | null;
  label_id: number | null;
  provider_msg_id: string;
  subject: string | null;
}

const TARGET_COLUMNS =
  "s.message_id, s.account_id, s.status, s.action, s.confidence, s.p_delete, s.margin, s.ceiling, s.model_version, " +
  "s.policy_version, s.sender, s.sender_domain, s.final_action, s.label_id, m.provider_msg_id, m.subject";

export function targetsByIdsQuery(accountIds: readonly string[], ids: readonly number[]): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT ${TARGET_COLUMNS}
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id IN (${placeholders(a)}) AND s.message_id IN (${placeholders(ids.length, a + 1)})`;
  return { sql, params: [...accountIds, ...ids] };
}

export function targetsForGroupQuery(
  accountId: string,
  sender: string,
  action: SuggestedAction,
  asOf: number,
  limit: number,
): SqlQuery {
  const sql = `SELECT ${TARGET_COLUMNS}
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id = ?1 AND s.status = 'pending' AND s.sender = ?2 AND s.action = ?3 AND s.created_at <= ?4
    ORDER BY COALESCE(s.confidence, 0) DESC, s.message_id
    LIMIT ?5`;
  return { sql, params: [accountId, sender, action, asOf, limit] };
}

export function targetsForCleanupQuery(
  accountIds: readonly string[],
  actions: readonly ActionKind[],
  threshold: number,
  asOf: number,
  limit: number,
): SqlQuery {
  const a = accountIds.length;
  const t = a + actions.length + 1;
  const sql = `SELECT ${TARGET_COLUMNS}
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id IN (${placeholders(a)}) AND s.status = 'pending'
      AND s.action IN (${placeholders(actions.length, a + 1)}) AND s.confidence >= ?${t} AND s.created_at <= ?${t + 1}
    ORDER BY s.confidence DESC, s.message_id
    LIMIT ?${t + 2}`;
  return { sql, params: [...accountIds, ...actions, threshold, asOf, limit] };
}

export function remainingGroupQuery(accountId: string, sender: string, action: SuggestedAction, asOf: number): SqlQuery {
  const sql = `SELECT COUNT(*) AS n FROM suggestions
    WHERE account_id = ?1 AND status = 'pending' AND sender = ?2 AND action = ?3 AND created_at <= ?4`;
  return { sql, params: [accountId, sender, action, asOf] };
}

export function remainingCleanupQuery(
  accountIds: readonly string[],
  actions: readonly ActionKind[],
  threshold: number,
  asOf: number,
): SqlQuery {
  const a = accountIds.length;
  const t = a + actions.length + 1;
  const sql = `SELECT COUNT(*) AS n FROM suggestions
    WHERE account_id IN (${placeholders(a)}) AND status = 'pending'
      AND action IN (${placeholders(actions.length, a + 1)}) AND confidence >= ?${t} AND created_at <= ?${t + 1}`;
  return { sql, params: [...accountIds, ...actions, threshold, asOf] };
}

/** pending -> approved; RETURNING lists the rows this request owns. */
export function claimQuery(accountId: string, ids: readonly number[], now: number): SqlQuery {
  const sql = `UPDATE suggestions SET status = 'approved', updated_at = ?2
    WHERE account_id = ?1 AND status = 'pending' AND message_id IN (${placeholders(ids.length, 3)})
    RETURNING message_id`;
  return { sql, params: [accountId, now, ...ids] };
}

/** Must directly follow the label insert (and the batch insert) in the same D1 batch (decision 9). */
export function markExecutedQuery(
  accountId: string,
  messageId: number,
  finalAction: ActionKind,
  decidedVia: "approve" | "override" | "cleanup",
  decidedAt: number,
  expiresAt: number,
): SqlQuery {
  const sql = `UPDATE suggestions SET status = 'executed', final_action = ?3, decided_via = ?4, decided_at = ?5,
      updated_at = ?5, expires_at = ?6, exec_error = NULL,
      batch_id = (SELECT MAX(id) FROM action_batches), label_id = (SELECT MAX(id) FROM labels)
    WHERE account_id = ?1 AND message_id = ?2 AND status = 'approved'`;
  return { sql, params: [accountId, messageId, finalAction, decidedVia, decidedAt, expiresAt] };
}

export function markFailedQuery(accountId: string, messageId: number, code: string, now: number): SqlQuery {
  const sql = `UPDATE suggestions SET status = 'failed', exec_error = ?3, updated_at = ?4
    WHERE account_id = ?1 AND message_id = ?2 AND status = 'approved'`;
  return { sql, params: [accountId, messageId, code, now] };
}

/** Transient failures go back to the queue (contracts 6.2). */
export function releaseQuery(accountId: string, ids: readonly number[], now: number): SqlQuery {
  const sql = `UPDATE suggestions SET status = 'pending', updated_at = ?2
    WHERE account_id = ?1 AND status = 'approved' AND message_id IN (${placeholders(ids.length, 3)})`;
  return { sql, params: [accountId, now, ...ids] };
}

export function undoTargetsQuery(accountIds: readonly string[], batchId: number, ids: readonly number[]): SqlQuery {
  const a = accountIds.length;
  const sql = `SELECT ${TARGET_COLUMNS}
    FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
    WHERE s.account_id IN (${placeholders(a)}) AND s.batch_id = ?${a + 1} AND s.message_id IN (${placeholders(ids.length, a + 2)})`;
  return { sql, params: [...accountIds, batchId, ...ids] };
}

export function markUndoneQuery(accountId: string, messageId: number, now: number): SqlQuery {
  const sql = `UPDATE suggestions SET status = 'undone', updated_at = ?3
    WHERE account_id = ?1 AND message_id = ?2 AND status = 'executed'`;
  return { sql, params: [accountId, messageId, now] };
}
```

- [ ] **Step 4: Implement `app/src/worker/actions/learn.ts`**

```ts
import { LABEL_SUBJECT_MAX_CHARS, priorDelta } from "@clearbox/core";
import type { ActionKind, Ceiling, SuggestedAction } from "@clearbox/core";
import type { LabelInsert, LabelSource } from "../db/labels.ts";
import { addPriorDelta } from "../db/priors.ts";
import type { PriorDeltaMap } from "../db/priors.ts";

export interface DecidedItem {
  messageId: number;
  accountId: string;
  sender: string;
  senderDomain: string;
  subject: string | null;
  suggestedAction: SuggestedAction;
  ownerAction: ActionKind;
  pDelete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  modelVersion: string | null;
  policyVersion: number;
}

/** Code-point safe truncation to LABEL_SUBJECT_MAX_CHARS; null when policy.labelSubjects is false. */
export function truncateSubject(subject: string | null, labelSubjects: boolean): string | null {
  if (!labelSubjects || subject === null) return null;
  return Array.from(subject).slice(0, LABEL_SUBJECT_MAX_CHARS).join("");
}

export function labelFor(item: DecidedItem, source: LabelSource, labelSubjects: boolean, now: number): LabelInsert {
  return {
    messageId: item.messageId,
    sender: item.sender,
    senderDomain: item.senderDomain,
    subjectTrunc: truncateSubject(item.subject, labelSubjects),
    suggestedAction: item.suggestedAction,
    ownerAction: item.ownerAction,
    source,
    pDelete: item.pDelete,
    margin: item.margin,
    ceiling: item.ceiling,
    modelVersion: item.modelVersion,
    policyVersion: item.policyVersion,
    now,
  };
}

export function decisionPriorDeltas(items: readonly DecidedItem[]): PriorDeltaMap {
  const map: PriorDeltaMap = new Map();
  for (const i of items) addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta(i.ownerAction, 1));
  return map;
}

export interface UndoneItem {
  accountId: string;
  sender: string;
  senderDomain: string;
  finalAction: ActionKind;
}

/** Contracts 7.8: priorDelta(original, -1) plus priorDelta("keep", +1). */
export function undoPriorDeltas(items: readonly UndoneItem[]): PriorDeltaMap {
  const map: PriorDeltaMap = new Map();
  for (const i of items) {
    addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta(i.finalAction, -1));
    addPriorDelta(map, i.accountId, i.sender, i.senderDomain, priorDelta("keep", 1));
  }
  return map;
}
```

- [ ] **Step 5: Implement `app/src/worker/actions/execute.ts`**

```ts
import {
  BUDGET_ROWS_PER_DAY,
  ClearboxError,
  DECIDED_TTL_MS,
  MAX_ITEMS_PER_ACTION_REQUEST,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  UNDO_WINDOW_MS,
} from "@clearbox/core";
import type { ActionErrorCode, ActionKind, MailProvider } from "@clearbox/core";
import type { ActionResponse, AppIssue, ItemErrorCode, ItemOutcome, ItemResult } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { listAccounts, markAccountStatusStmt } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { insertBatchStmt } from "../db/batches.ts";
import type { BatchKind } from "../db/batches.ts";
import { budgetDeltaStmt, readBudget } from "../db/budget.ts";
import type { Budget } from "../db/budget.ts";
import { insertLabelStmt } from "../db/labels.ts";
import { updateProviderMsgIdStmt } from "../db/messages.ts";
import { priorStatements } from "../db/priors.ts";
import { addIssue, issuesEqual, readSettings, setIssuesStmt } from "../db/settings.ts";
import { bindQuery, chunk, MAX_BOUND_PARAMS, nextUtcMidnight, sumRowsRead, sumRowsWritten, toIso, utcDate } from "../db/sql.ts";
import type { SqlQuery } from "../db/sql.ts";
import {
  claimQuery,
  markExecutedQuery,
  markFailedQuery,
  releaseQuery,
  remainingCleanupQuery,
  remainingGroupQuery,
  targetsByIdsQuery,
  targetsForCleanupQuery,
  targetsForGroupQuery,
} from "../db/suggestions.ts";
import type { TargetRow } from "../db/suggestions.ts";
import type { AppConfig, AppDeps } from "../env.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { clientIssueCode } from "../oauth/connect.ts";
import { callbackPath } from "../scan/providers.ts";
import { createD1TokenSource, refreshFnFor, tokenUpdateStmt } from "../scan/token-source.ts";
import type { D1TokenSource } from "../scan/token-source.ts";
import { decisionPriorDeltas, labelFor } from "./learn.ts";
import type { DecidedItem } from "./learn.ts";

export type ExecuteRequest =
  | { kind: "approve_ids"; ids: readonly number[] }
  | { kind: "approve_group"; accountId: string; sender: string; action: ActionKind; asOf: number }
  | { kind: "override"; ids: readonly number[]; action: ActionKind }
  | { kind: "cleanup"; actions: readonly ActionKind[]; threshold: number; accountId: string | null; asOf: number };

export interface ActionContext {
  db: D1Database;
  config: AppConfig;
  deps: AppDeps;
  requestId: string;
  /** Request origin, used for the OAuth client redirect URI on token refresh. */
  origin: string;
}

interface Candidate {
  row: TargetRow;
  action: ActionKind;
  account: Account;
}

interface Executed {
  cand: Candidate;
  newId: string | null;
}

interface Failed {
  cand: Candidate;
  code: ItemErrorCode;
}

export interface AccountFailure {
  account: Account;
  error: ProviderAuthError | ProviderConfigError;
}

/** Owner actions are refused only at BUDGET_ROWS_PER_DAY, and only on Free (contracts 6.4, 8.5). */
export function assertOwnerBudget(budget: Budget, config: AppConfig, now: number): void {
  if (!config.freeTier || budget.rowsWritten < BUDGET_ROWS_PER_DAY) return;
  logEvent("budget.gate", { date: budget.date, rowsWritten: budget.rowsWritten, gate: "owner" });
  throw new ApiError(429, "budget_exhausted", "Daily database write budget reached", {
    retryAt: toIso(nextUtcMidnight(now)),
  });
}

export function isTransient(code: ActionErrorCode): boolean {
  return code === "rate_limited" || code === "unavailable";
}

export function mapActionError(code: ActionErrorCode): ItemErrorCode {
  return code;
}

/** Whole-call provider errors (decision 13). */
export function classifyProviderError(err: unknown): { code: ItemErrorCode; authError: ProviderAuthError | ProviderConfigError | null } {
  if (err instanceof ProviderAuthError || err instanceof ProviderConfigError) return { code: "account_inactive", authError: err };
  if (err instanceof ProviderRateLimitError) return { code: "rate_limited", authError: null };
  if (err instanceof ProviderUnavailableError) return { code: "unavailable", authError: null };
  return { code: "unknown", authError: null };
}

export function openProvider(ctx: ActionContext, account: Account, encKey: CryptoKey): { provider: MailProvider; tokens: D1TokenSource } {
  const { deps } = ctx;
  const tokens = createD1TokenSource({
    account,
    encKey,
    now: deps.now,
    refresh: refreshFnFor(deps.oauth, ctx.config, account.provider, deps.fetch, deps.now, ctx.origin + callbackPath(account.provider)),
  });
  const provider = deps.providerFactory(
    { provider: account.provider, archiveFolderId: account.archiveFolderId },
    { fetch: deps.fetch, tokens, now: deps.now },
  );
  return { provider, tokens };
}

export function accountFailureStatements(
  db: D1Database,
  failures: readonly AccountFailure[],
  issues: readonly AppIssue[],
  now: number,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  let next: AppIssue[] = [...issues];
  for (const f of failures) {
    const status = f.error instanceof ProviderConfigError ? "config_error" : "needs_reauth";
    stmts.push(markAccountStatusStmt(db, f.account.id, status, f.error.reason, now));
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: f.account.id,
        kind: status === "config_error" ? "config_error" : "reauth_required",
        batchId: null,
        count: 0,
        result: {},
      }),
    );
    logEvent("account.status", { accountId: f.account.id, from: f.account.status, to: status, reason: f.error.reason });
    if (status === "config_error") {
      const code = clientIssueCode(f.account.provider);
      const updated = addIssue(next, code, null, now);
      if (!issuesEqual(next, updated)) logEvent("issue.raised", { code, accountId: null });
      next = updated;
    }
  }
  if (!issuesEqual(issues, next)) stmts.push(setIssuesStmt(db, next, now));
  return stmts;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

function batchKindOf(req: ExecuteRequest): BatchKind {
  return req.kind === "override" ? "override" : req.kind === "cleanup" ? "cleanup" : "approve";
}

function cleanupScope(req: Extract<ExecuteRequest, { kind: "cleanup" }>, accountIds: readonly string[]): string[] {
  return req.accountId === null ? [...accountIds] : accountIds.filter((id) => id === req.accountId);
}

async function selectTargets(db: D1Database, req: ExecuteRequest, accountIds: readonly string[]): Promise<TargetRow[]> {
  if (accountIds.length === 0) return [];
  if (accountIds.length > 90) throw new ClearboxError("too_many_accounts");
  let queries: SqlQuery[] = [];
  if (req.kind === "approve_ids" || req.kind === "override") {
    queries = chunk([...new Set(req.ids)], MAX_BOUND_PARAMS - accountIds.length).map((part) => targetsByIdsQuery(accountIds, part));
  } else if (req.kind === "approve_group") {
    if (accountIds.includes(req.accountId)) {
      queries = [targetsForGroupQuery(req.accountId, req.sender, req.action, req.asOf, MAX_ITEMS_PER_ACTION_REQUEST)];
    }
  } else {
    const scope = cleanupScope(req, accountIds);
    if (scope.length > 0) {
      queries = [targetsForCleanupQuery(scope, req.actions, req.threshold, req.asOf, MAX_ITEMS_PER_ACTION_REQUEST)];
    }
  }
  if (queries.length === 0) return [];
  const results = await db.batch<TargetRow>(queries.map((q) => bindQuery(db, q)));
  return results.flatMap((r) => r.results);
}

function decided(c: Candidate): DecidedItem {
  return {
    messageId: c.row.message_id,
    accountId: c.account.id,
    sender: c.row.sender,
    senderDomain: c.row.sender_domain,
    subject: c.row.subject,
    suggestedAction: c.row.action ?? "unsure",
    ownerAction: c.action,
    pDelete: c.row.p_delete,
    margin: c.row.margin,
    ceiling: c.row.ceiling,
    modelVersion: c.row.model_version,
    policyVersion: c.row.policy_version,
  };
}

/**
 * Contracts 7.7: approve, override and Clean up share this path.
 * Invariant: no provider call happens for a suggestion this request did not move from pending to approved.
 */
export async function executeSuggestions(ctx: ActionContext, req: ExecuteRequest): Promise<ActionResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const kind = batchKindOf(req);
  const [budget, settings, visible] = await Promise.all([
    readBudget(db, utcDate(now)),
    readSettings(db),
    listAccounts(db, { includeDisconnected: false }),
  ]);
  assertOwnerBudget(budget, ctx.config, now);
  const accounts = new Map(visible.map((a) => [a.id, a]));
  const accountIds = [...accounts.keys()];
  const targets = await selectTargets(db, req, accountIds);

  const results = new Map<number, ItemResult>();
  const set = (id: number, outcome: ItemOutcome, action: ActionKind | null, error: ItemErrorCode | null) =>
    results.set(id, { id, outcome, action, error });
  const order = req.kind === "approve_ids" || req.kind === "override" ? [...new Set(req.ids)] : targets.map((t) => t.message_id);
  const byId = new Map(targets.map((t) => [t.message_id, t]));

  // 1. Classify.
  const candidates: Candidate[] = [];
  for (const id of order) {
    const row = byId.get(id);
    const account = row ? accounts.get(row.account_id) : undefined;
    if (!row || !account || row.status !== "pending") {
      set(id, "skipped", null, "not_pending");
      continue;
    }
    let action: ActionKind;
    if (req.kind === "override") {
      action = req.action;
    } else if (row.action === null || row.action === "unsure") {
      set(id, "skipped", null, "unsure_not_approvable");
      continue;
    } else {
      action = row.action;
    }
    if (action !== "keep" && account.status !== "active") {
      set(id, "retry_later", action, "account_inactive");
      continue;
    }
    candidates.push({ row, action, account });
  }

  // 2. Claim (pending -> approved).
  const writes: D1Result[] = [];
  const claimStmts: D1PreparedStatement[] = [];
  for (const [accountId, items] of groupBy(candidates, (c) => c.account.id)) {
    for (const part of chunk(items.map((c) => c.row.message_id), MAX_BOUND_PARAMS - 2)) {
      claimStmts.push(bindQuery(db, claimQuery(accountId, part, now)));
    }
  }
  const claimed = new Set<number>();
  if (claimStmts.length > 0) {
    const claimResults = await db.batch<{ message_id: number }>(claimStmts);
    writes.push(...claimResults);
    for (const r of claimResults) for (const row of r.results) claimed.add(row.message_id);
  }
  const work = candidates.filter((c) => {
    if (claimed.has(c.row.message_id)) return true;
    set(c.row.message_id, "skipped", null, "not_pending");
    return false;
  });

  // 3. Provider calls, sequential per account.
  const executed: Executed[] = [];
  const failed: Failed[] = [];
  const retry: Failed[] = [];
  const failures: AccountFailure[] = [];
  const tokenStmts: D1PreparedStatement[] = [];
  let providerCalls = 0;
  const encKey = await importEncKey(ctx.config.tokenEncKey);
  for (const accountItems of groupBy(work, (c) => c.account.id).values()) {
    const account = accountItems[0]?.account;
    if (!account) continue;
    for (const c of accountItems) if (c.action === "keep") executed.push({ cand: c, newId: null });
    let moving = accountItems.filter((c) => c.action !== "keep");
    if (account.provider === "outlook" && account.archiveFolderId === null) {
      for (const c of moving) if (c.action === "archive") failed.push({ cand: c, code: "archive_unavailable" });
      moving = moving.filter((c) => c.action !== "archive");
    }
    if (moving.length === 0) continue;
    const { provider, tokens } = openProvider(ctx, account, encKey);
    let stop: ItemErrorCode | null = null;
    for (const action of ["delete", "archive"] as const) {
      const batch = moving.filter((c) => c.action === action);
      if (batch.length === 0) continue;
      if (stop !== null) {
        for (const c of batch) retry.push({ cand: c, code: stop });
        continue;
      }
      const pids = batch.map((c) => c.row.provider_msg_id);
      try {
        providerCalls += 1;
        const res = action === "delete" ? await provider.trash(pids) : await provider.archive(pids);
        const byPid = new Map(res.map((r) => [r.id, r]));
        for (const c of batch) {
          const r = byPid.get(c.row.provider_msg_id);
          if (!r) failed.push({ cand: c, code: "unknown" });
          else if (r.ok) executed.push({ cand: c, newId: r.newId });
          else if (isTransient(r.error)) retry.push({ cand: c, code: mapActionError(r.error) });
          else failed.push({ cand: c, code: mapActionError(r.error) });
        }
      } catch (err) {
        const failure = classifyProviderError(err);
        stop = failure.code;
        if (failure.authError) failures.push({ account, error: failure.authError });
        for (const c of batch) retry.push({ cand: c, code: failure.code });
        logEvent("provider.error", {
          requestId: ctx.requestId,
          accountId: account.id,
          provider: account.provider,
          errorCode: err instanceof ClearboxError ? err.code : "unknown",
          status: null,
        });
      }
    }
    if (tokens.update) tokenStmts.push(await tokenUpdateStmt(db, account, encKey, tokens.update, now));
  }

  const position = new Map(order.map((id, i) => [id, i]));
  executed.sort((x, y) => (position.get(x.cand.row.message_id) ?? 0) - (position.get(y.cand.row.message_id) ?? 0));
  for (const e of executed) set(e.cand.row.message_id, "executed", e.cand.action, null);
  for (const f of failed) set(f.cand.row.message_id, "failed", f.cand.action, f.code);
  for (const r of retry) set(r.cand.row.message_id, "retry_later", r.cand.action, r.code);
  const list = order.map((id) => results.get(id) ?? { id, outcome: "skipped" as const, action: null, error: "not_pending" as const });
  const count = (o: ItemOutcome) => list.filter((r) => r.outcome === o).length;

  // 4. One D1 batch (one transaction) with every result.
  const stmts: D1PreparedStatement[] = [];
  let batchIndex = -1;
  if (executed.length > 0) {
    batchIndex = stmts.length;
    stmts.push(
      insertBatchStmt(db, {
        kind,
        suggestionIds: executed.map((e) => e.cand.row.message_id),
        requestedCount: order.length,
        executedCount: executed.length,
        failedCount: failed.length,
        createdAt: now,
        undoExpiresAt: now + UNDO_WINDOW_MS,
      }),
    );
  }
  for (const e of executed) {
    const { row, action, account } = e.cand;
    stmts.push(insertLabelStmt(db, account.id, labelFor(decided(e.cand), kind, settings.policy.labelSubjects, now)));
    stmts.push(bindQuery(db, markExecutedQuery(account.id, row.message_id, action, kind, now, now + DECIDED_TTL_MS)));
    if (e.newId !== null && e.newId !== row.provider_msg_id) {
      stmts.push(updateProviderMsgIdStmt(db, account.id, row.message_id, e.newId));
    }
  }
  for (const f of failed) stmts.push(bindQuery(db, markFailedQuery(f.cand.account.id, f.cand.row.message_id, f.code, now)));
  for (const [accountId, items] of groupBy(retry, (r) => r.cand.account.id)) {
    for (const part of chunk(items.map((r) => r.cand.row.message_id), MAX_BOUND_PARAMS - 2)) {
      stmts.push(bindQuery(db, releaseQuery(accountId, part, now)));
    }
  }
  stmts.push(...priorStatements(db, decisionPriorDeltas(executed.map((e) => decided(e.cand))), now));
  stmts.push(...accountFailureStatements(db, failures, settings.issues, now));
  stmts.push(...tokenStmts);
  if (executed.length + failed.length > 0) {
    const touched = new Set([...executed, ...failed].map((x) => x.cand.account.id));
    const per = (a: ActionKind) => executed.filter((e) => e.cand.action === a).length;
    const groups = new Set(executed.map((e) => `${e.cand.account.id}\u001f${e.cand.row.sender}\u001f${e.cand.row.action ?? ""}`));
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: touched.size === 1 ? ([...touched][0] ?? null) : null,
        kind,
        batchId: executed.length > 0 ? "latest_batch" : null,
        count: executed.length,
        result: {
          executed: count("executed"),
          failed: count("failed"),
          skipped: count("skipped"),
          retryLater: count("retry_later"),
          delete: per("delete"),
          archive: per("archive"),
          keep: per("keep"),
          groups: groups.size,
        },
      }),
    );
  }
  let remainingQuery: SqlQuery | null = null;
  if (req.kind === "approve_group" && accountIds.includes(req.accountId)) {
    remainingQuery = remainingGroupQuery(req.accountId, req.sender, req.action, req.asOf);
  } else if (req.kind === "cleanup") {
    const scope = cleanupScope(req, accountIds);
    if (scope.length > 0) remainingQuery = remainingCleanupQuery(scope, req.actions, req.threshold, req.asOf);
  }
  if (remainingQuery) stmts.push(bindQuery(db, remainingQuery));

  const finalResults = stmts.length > 0 ? await db.batch(stmts) : [];
  writes.push(...finalResults);
  const batchId =
    batchIndex >= 0 ? ((finalResults[batchIndex]?.results[0] as { id: number } | undefined)?.id ?? null) : null;
  const remaining = remainingQuery
    ? ((finalResults[finalResults.length - 1]?.results[0] as { n: number } | undefined)?.n ?? 0)
    : 0;

  // 5. Budget (contracts 8.5: counted like a tick's D1 call 4).
  await budgetDeltaStmt(db, utcDate(now), { rowsWritten: sumRowsWritten(writes) + 1, rowsRead: sumRowsRead(writes), providerCalls }, now).run();

  const response: ActionResponse = {
    batchId,
    results: list,
    executed: count("executed"),
    failed: count("failed"),
    skipped: count("skipped"),
    retryLater: count("retry_later"),
    remaining,
  };
  logEvent("action.executed", {
    requestId: ctx.requestId,
    kind,
    batchId,
    executed: response.executed,
    failed: response.failed,
    skipped: response.skipped,
    retryLater: response.retryLater,
  });
  return response;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/actions/execute.test.ts test/worker/db/query-plans.test.ts test/worker/db-isolation.test.ts`
Expected: PASS, `25 passed` (14 execute, 7 query plans, 4 isolation).

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/db/suggestions.ts app/src/worker/actions app/test/worker/actions/execute.test.ts app/test/worker/db/query-plans.test.ts
git commit -m "feat(worker): execute approve, override and Clean up with claims, labels, priors and audit"
```

---

### Task 13: Action routes (approve, override, Clean up preview, Clean up)

**Files:**
- Create: `app/src/worker/routes/actions.ts`
- Modify: `app/src/worker/app.ts` (mount `actionsRoutes`)
- Test: `app/test/worker/routes/actions.test.ts`

**Interfaces:**
- Consumes: `executeSuggestions`, `ActionContext` (Task 12), `cleanupCountsQuery`, `groupsLeftQuery`, `decodeGroupKey` (Tasks 7, 11), `scopeAccounts`, `CLEANUP_DEFAULT_ACTIONS` (Task 11), `loadVisibleAccount` (Task 10), `readSettings` (Task 6), `bindQuery`, `isoToMs`, `toIso` (Task 6), `parseWith`, `readJsonBody`, `ApiError` (Task 5); api `ApproveBodySchema`, `OverrideBodySchema`, `CleanupPreviewQuerySchema`, `CleanupBodySchema`, `CleanupPreview`, `ActionResponse` (Task 2); `ActionKind` from `@clearbox/core`.
- Produces: `actionsRoutes` (mounted at `/api`: `POST /approve`, `POST /override`, `GET /cleanup/preview`, `POST /cleanup`), `actionContext(c): ActionContext`, `resolveCleanupActions(actions: readonly ActionKind[] | undefined): ActionKind[]` (decision 29).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/routes/actions.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActionResponse, ApiErrorBody, CleanupPreview } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { budgetDeltaStmt } from "../../../src/worker/db/budget.ts";
import { encodeGroupKey } from "../../../src/worker/db/suggestions.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const AS_OF = new Date(SEED_NOW).toISOString();

function setup() {
  const fake = new FakeProvider();
  const app = createApp({ now: () => SEED_NOW, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
  return { app, fake };
}

async function errorCode(res: Response): Promise<string> {
  return (await readJson<ApiErrorBody>(res)).error.code;
}

async function previewAccount() {
  const acc = await seedAccount();
  await seedSuggestions(acc.id, 1, { sender: "s1@example.com", action: "delete", confidence: 0.95 });
  await seedSuggestions(acc.id, 1, { sender: "s1@example.com", action: "delete", confidence: 0.6 });
  await seedSuggestions(acc.id, 1, { sender: "s2@example.com", action: "archive", confidence: 0.85 });
  await seedSuggestions(acc.id, 1, { sender: "s3@example.com", action: "keep", confidence: 0.9 });
  await seedSuggestions(acc.id, 1, { sender: "s4@example.com", action: "unsure", confidence: 0.3 });
  return acc;
}

describe("POST /api/approve", () => {
  it("approves exact ids", async () => {
    const { app, fake } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2);
    const res = await apiFetch("/api/approve", jsonInit("POST", { ids }), { app });
    expect(res.status).toBe(200);
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash"]);
  });

  it("validates id lists", async () => {
    const { app } = setup();
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { ids: tooMany }), { app }))).toBe("validation_failed");
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { ids: [1, 1] }), { app }))).toBe("validation_failed");
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { groupKey: "k" }), { app }))).toBe("validation_failed");
  });

  it("approves a sender group by key and asOf", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 2, { sender: "group@example.com", action: "archive", confidence: 0.9 });
    const groupKey = encodeGroupKey(acc.id, "group@example.com", "archive");
    const res = await apiFetch("/api/approve", jsonInit("POST", { groupKey, asOf: AS_OF }), { app });
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    for (const id of ids) expect((await getSuggestionRow(id))?.["final_action"]).toBe("archive");
  });

  it("rejects unsure groups, malformed keys and unknown accounts", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const unsure = encodeGroupKey(acc.id, "x@example.com", "unsure");
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { groupKey: unsure, asOf: AS_OF }), { app }))).toBe("validation_failed");
    expect(await errorCode(await apiFetch("/api/approve", jsonInit("POST", { groupKey: "bad", asOf: AS_OF }), { app }))).toBe("validation_failed");
    const unknown = encodeGroupKey("acc_ffffffffffffffff", "x@example.com", "delete");
    const res = await apiFetch("/api/approve", jsonInit("POST", { groupKey: unknown, asOf: AS_OF }), { app });
    expect(res.status).toBe(404);
  });

  it("answers 429 budget_exhausted at the daily cap", async () => {
    const { app } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1);
    await budgetDeltaStmt(env.DB, AS_OF.slice(0, 10), { rowsWritten: 95_000 }, SEED_NOW).run();
    const res = await apiFetch("/api/approve", jsonInit("POST", { ids }), { app });
    expect(res.status).toBe(429);
    expect(await readJson<ApiErrorBody>(res)).toEqual({
      error: { code: "budget_exhausted", message: "Daily database write budget reached", retryAt: "2026-10-16T00:00:00.000Z" },
    });
    await budgetDeltaStmt(env.DB, AS_OF.slice(0, 10), { rowsWritten: -95_000 }, SEED_NOW).run();
  });
});

describe("POST /api/override", () => {
  it("executes the owner's action", async () => {
    const { app, fake } = setup();
    const acc = await seedAccount();
    const ids = await seedSuggestions(acc.id, 1, { action: "delete" });
    const res = await apiFetch("/api/override", jsonInit("POST", { ids, action: "keep" }), { app });
    expect((await readJson<ActionResponse>(res)).results[0]).toMatchObject({ outcome: "executed", action: "keep" });
    expect(fake.calls).toEqual([]);
    expect(await errorCode(await apiFetch("/api/override", jsonInit("POST", { ids, action: "unsure" }), { app }))).toBe("validation_failed");
  });
});

describe("Clean up", () => {
  it("previews counts, groups and groups left with keep excluded by default", async () => {
    const { app } = setup();
    const acc = await previewAccount();
    const res = await apiFetch(`/api/cleanup/preview?accountId=${acc.id}`, {}, { app });
    expect(await readJson<CleanupPreview>(res)).toEqual({
      asOf: AS_OF,
      threshold: 0.8,
      defaultThreshold: 0.8,
      count: 2,
      byAction: { delete: 1, archive: 1, keep: 0 },
      groups: 2,
      groupsLeft: 3,
    });
  });

  it("previews Confirm all keeps and rejects keep mixed with other actions", async () => {
    const { app } = setup();
    const acc = await previewAccount();
    const keeps = await readJson<CleanupPreview>(
      await apiFetch(`/api/cleanup/preview?accountId=${acc.id}&actions=keep&threshold=0.5`, {}, { app }),
    );
    expect(keeps).toMatchObject({ threshold: 0.5, count: 1, byAction: { delete: 0, archive: 0, keep: 1 }, groups: 1, groupsLeft: 3 });
    const mixed = await apiFetch(`/api/cleanup/preview?actions=delete,keep`, {}, { app });
    expect(await errorCode(mixed)).toBe("validation_failed");
  });

  it("executes Clean up at the threshold and reports remaining", async () => {
    const { app, fake } = setup();
    const acc = await previewAccount();
    const res = await apiFetch("/api/cleanup", jsonInit("POST", { accountId: acc.id, asOf: AS_OF }), { app });
    expect(await readJson<ActionResponse>(res)).toMatchObject({ executed: 2, remaining: 0 });
    expect(fake.calls.map((c) => c.method)).toEqual(["trash", "archive"]);
    const mixed = await apiFetch("/api/cleanup", jsonInit("POST", { actions: ["keep", "delete"], asOf: AS_OF }), { app });
    expect(await errorCode(mixed)).toBe("validation_failed");
    const keeps = await apiFetch("/api/cleanup", jsonInit("POST", { accountId: acc.id, actions: ["keep"], threshold: 0.5, asOf: AS_OF }), { app });
    expect((await readJson<ActionResponse>(keeps)).executed).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/actions.test.ts`
Expected: FAIL with `expected 404 to be 200` (routes not mounted).

- [ ] **Step 3: Implement `app/src/worker/routes/actions.ts`**

```ts
import type { ActionKind } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { ApproveBodySchema, CleanupBodySchema, CleanupPreviewQuerySchema, OverrideBodySchema } from "../../shared/api.ts";
import type { CleanupPreview } from "../../shared/api.ts";
import { executeSuggestions } from "../actions/execute.ts";
import type { ActionContext } from "../actions/execute.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, isoToMs, toIso } from "../db/sql.ts";
import { cleanupCountsQuery, decodeGroupKey, groupsLeftQuery } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";
import { loadVisibleAccount } from "./accounts.ts";
import { CLEANUP_DEFAULT_ACTIONS, scopeAccounts } from "./queue.ts";

export const actionsRoutes = new Hono<AppEnv>();

export function actionContext(c: Context<AppEnv>): ActionContext {
  return {
    db: c.env.DB,
    config: c.get("config"),
    deps: c.get("deps"),
    requestId: c.get("requestId"),
    origin: new URL(c.req.url).origin,
  };
}

/** Decision 29: default delete + archive; keep only on its own ("Confirm all keeps"). */
export function resolveCleanupActions(actions: readonly ActionKind[] | undefined): ActionKind[] {
  if (actions === undefined || actions.length === 0) return [...CLEANUP_DEFAULT_ACTIONS];
  const unique = [...new Set(actions)];
  if (unique.includes("keep") && unique.length > 1) {
    throw new ApiError(400, "validation_failed", "Keep suggestions are confirmed on their own", {
      details: [{ path: "actions", message: "keep cannot be combined with delete or archive" }],
    });
  }
  return unique;
}

actionsRoutes.post("/approve", async (c) => {
  const body = parseWith(ApproveBodySchema, await readJsonBody(c));
  const ctx = actionContext(c);
  if ("ids" in body) return c.json(await executeSuggestions(ctx, { kind: "approve_ids", ids: body.ids }));
  const decoded = decodeGroupKey(body.groupKey);
  if (!decoded) throw new ApiError(400, "validation_failed", "Malformed group key");
  if (decoded.action === "unsure") {
    throw new ApiError(400, "validation_failed", "Unsure groups cannot be approved; choose an action with override");
  }
  await loadVisibleAccount(ctx.db, decoded.accountId);
  return c.json(
    await executeSuggestions(ctx, {
      kind: "approve_group",
      accountId: decoded.accountId,
      sender: decoded.sender,
      action: decoded.action,
      asOf: isoToMs(body.asOf),
    }),
  );
});

actionsRoutes.post("/override", async (c) => {
  const body = parseWith(OverrideBodySchema, await readJsonBody(c));
  return c.json(await executeSuggestions(actionContext(c), { kind: "override", ids: body.ids, action: body.action }));
});

actionsRoutes.get("/cleanup/preview", async (c) => {
  const q = parseWith(CleanupPreviewQuerySchema, c.req.query());
  const db = c.env.DB;
  const settings = await readSettings(db);
  const threshold = q.threshold ?? settings.tauDelete;
  const actions = resolveCleanupActions(q.actions?.split(",") as ActionKind[] | undefined);
  const ids = (await scopeAccounts(db, q.accountId)).map((a) => a.id);
  const byAction: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  let groups = 0;
  let groupsLeft = 0;
  if (ids.length > 0) {
    const [counts, left] = await db.batch([
      bindQuery(db, cleanupCountsQuery(ids, actions, threshold)),
      bindQuery(db, groupsLeftQuery(ids, actions, threshold)),
    ]);
    for (const row of (counts?.results ?? []) as { action: ActionKind; n: number; g: number }[]) {
      byAction[row.action] = row.n;
      groups += row.g;
    }
    groupsLeft = ((left?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  }
  const body: CleanupPreview = {
    asOf: toIso(c.get("deps").now()),
    threshold,
    defaultThreshold: settings.tauDelete,
    count: byAction.delete + byAction.archive + byAction.keep,
    byAction,
    groups,
    groupsLeft,
  };
  return c.json(body);
});

actionsRoutes.post("/cleanup", async (c) => {
  const body = parseWith(CleanupBodySchema, await readJsonBody(c));
  const ctx = actionContext(c);
  const actions = resolveCleanupActions(body.actions);
  const threshold = body.threshold ?? (await readSettings(ctx.db)).tauDelete;
  return c.json(
    await executeSuggestions(ctx, {
      kind: "cleanup",
      actions,
      threshold,
      accountId: body.accountId ?? null,
      asOf: isoToMs(body.asOf),
    }),
  );
});
```

- [ ] **Step 4: Mount the routes in `app/src/worker/app.ts`**

Add the import:

```ts
import { actionsRoutes } from "./routes/actions.ts";
```

Append to the route block (after `queueRoutes`):

```ts
  app.route("/api", actionsRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/actions.test.ts test/worker/db-isolation.test.ts`
Expected: PASS, `13 passed` (9 actions, 4 isolation).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/routes/actions.ts app/src/worker/app.ts app/test/worker/routes/actions.test.ts
git commit -m "feat(worker): add approve, override and Clean up routes with preview"
```

---

### Task 14: Undo and the batches routes

**Files:**
- Create: `app/src/worker/actions/undo.ts`
- Create: `app/src/worker/routes/batches.ts`
- Modify: `app/src/worker/app.ts` (mount `batchesRoutes`)
- Test: `app/test/worker/actions/undo.test.ts`

**Interfaces:**
- Consumes: `ActionContext`, `assertOwnerBudget`, `openProvider`, `classifyProviderError`, `accountFailureStatements`, `AccountFailure`, `mapActionError` (Task 12), `actionContext` (Task 13), `undoPriorDeltas` (Task 12), `undoTargetsQuery`, `markUndoneQuery`, `TargetRow` (Task 12), `getBatch`, `claimUndoStmt`, `resetUndoStmt`, `listBatchesStmt`, `mapBatch`, `BatchRow` (Task 7), `undoLabelStmt` (Task 7), `updateProviderMsgIdStmt` (Task 7), `priorStatements` (Task 7), `listAccounts` (Task 7), `auditStmt`, `selectBatchAuditStmt`, `AuditRow` (Task 6), `readBudget`, `budgetDeltaStmt`, `readSettings` (Task 6), `tokenUpdateStmt` (Task 8), `importEncKey` (Task 4), `chunk`, `bindQuery`, `MAX_BOUND_PARAMS`, `encodeCursor`, `decodeCursor`, `toIso`, `utcDate`, `sumRowsWritten`, `sumRowsRead` (Task 6), `ApiError`, `parseWith` (Task 5), `logEvent` (Task 3); api `UndoResponse`, `UndoItemResult`, `ItemErrorCode`, `ActionBatchView`, `Page`, `PageQuerySchema` (Task 2); from `@clearbox/core`: `ActionKind`, `RestoreItem`, `BATCH_RETENTION_MS`.
- Produces: `undoBatch(ctx: ActionContext, batchId: number): Promise<UndoResponse>` (throws `404 not_found`, `410 undo_expired`, `429 budget_exhausted`), `batchesRoutes` (mounted at `/api/batches`: `GET /`, `POST /:id/undo`), `toBatchView(batch, audit: AuditRow | undefined, now): ActionBatchView`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/actions/undo.test.ts`:

```ts
import { ProviderRateLimitError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActionBatchView, ApiErrorBody, Page, UndoResponse } from "../../../src/shared/api.ts";
import { executeSuggestions } from "../../../src/worker/actions/execute.ts";
import type { ActionContext } from "../../../src/worker/actions/execute.ts";
import { undoBatch } from "../../../src/worker/actions/undo.ts";
import { createApp, defaultDeps } from "../../../src/worker/app.ts";
import { getBatch } from "../../../src/worker/db/batches.ts";
import { readConfig } from "../../../src/worker/env.ts";
import { FakeProvider, fakeOAuth } from "../helpers/fake-provider.ts";
import { apiFetch, jsonInit, readJson, TEST_ORIGIN } from "../helpers/request.ts";
import { getSuggestionRow, SEED_NOW, seedAccount, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;

function context(provider: FakeProvider, now = SEED_NOW): ActionContext {
  const result = readConfig(env);
  if (!result.ok) throw new Error("config");
  return {
    db: env.DB,
    config: result.config,
    deps: defaultDeps({ now: () => now, providerFactory: provider.factory(), oauth: fakeOAuth().oauth }),
    requestId: "00000000-0000-4000-8000-0000000000bb",
    origin: TEST_ORIGIN,
  };
}

async function priors(accountId: string) {
  return (await env.DB.prepare("SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 ORDER BY key").bind(accountId).run()).results;
}

async function executedBatch(provider: FakeProvider) {
  const acc = await seedAccount();
  const [del] = await seedSuggestions(acc.id, 1, { action: "delete" });
  const [arc] = await seedSuggestions(acc.id, 1, { action: "archive", confidence: 0.9 });
  const [keep] = await seedSuggestions(acc.id, 1, { action: "keep", confidence: 0.9 });
  const res = await executeSuggestions(context(provider), { kind: "approve_ids", ids: [del ?? 0, arc ?? 0, keep ?? 0] });
  return { acc, del: del ?? 0, arc: arc ?? 0, keep: keep ?? 0, batchId: res.batchId ?? 0 };
}

describe("undoBatch", () => {
  it("restores trash and archive items, rewrites labels and reverses priors", async () => {
    const fake = new FakeProvider();
    const { acc, del, arc, keep, batchId } = await executedBatch(fake);
    const res = await undoBatch(context(fake, SEED_NOW + 60_000), batchId);
    expect(res).toMatchObject({ batchId, restored: 2, failed: 0, skipped: 1 });
    expect(res.results.map((r) => [r.id, r.outcome])).toEqual([
      [del, "restored"],
      [arc, "restored"],
      [keep, "skipped"],
    ]);
    const restoreIds = fake.calls.filter((c) => c.method === "restore").flatMap((c) => c.ids);
    expect(restoreIds.some((id) => id.startsWith("trash:"))).toBe(true);
    expect(restoreIds.some((id) => id.startsWith("archive:"))).toBe(true);
    expect((await getSuggestionRow(del))?.["status"]).toBe("undone");
    expect((await getSuggestionRow(keep))?.["status"]).toBe("executed");
    const label = await env.DB.prepare("SELECT owner_action, source FROM labels WHERE id = ?1").bind((await getSuggestionRow(del))?.["label_id"]).first();
    expect(label).toEqual({ owner_action: "keep", source: "undo" });
    expect(await priors(acc.id)).toEqual([
      { key: "@example.com", deletes: 0, keeps: 3 },
      { key: "news@shop.example.com", deletes: 0, keeps: 3 },
    ]);
    expect((await getBatch(env.DB, batchId))?.undoneAt).toBe(SEED_NOW + 60_000);
    const audit = await env.DB.prepare("SELECT count, result_json FROM audit_log WHERE kind = 'undo' AND batch_id = ?1").bind(batchId).first();
    expect(audit).toEqual({ count: 2, result_json: JSON.stringify({ restored: 2, failed: 0 }) });
  });

  it("is one-shot: a second undo skips everything without provider calls", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    await undoBatch(context(fake), batchId);
    const before = fake.calls.length;
    const again = await undoBatch(context(fake), batchId);
    expect(again).toMatchObject({ restored: 0, failed: 0, skipped: 3 });
    expect(fake.calls.length).toBe(before);
  });

  it("answers 410 after 24 hours and 404 for unknown batches", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    await expect(undoBatch(context(fake, SEED_NOW + DAY), batchId)).rejects.toMatchObject({ status: 410, code: "undo_expired" });
    await expect(undoBatch(context(fake), 999_999)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("reopens the batch for undo when the provider throttles every restore", async () => {
    const ok = new FakeProvider();
    const { batchId, del } = await executedBatch(ok);
    const throttled = new FakeProvider({ failWith: { restore: new ProviderRateLimitError({ provider: "gmail", retryAfterMs: 1000 }) } });
    const res = await undoBatch(context(throttled), batchId);
    expect(res).toMatchObject({ restored: 0, failed: 2 });
    expect(res.results.find((r) => r.id === del)?.error).toBe("rate_limited");
    expect((await getBatch(env.DB, batchId))?.undoneAt).toBeNull();
    expect((await undoBatch(context(ok), batchId)).restored).toBe(2);
  });
});

describe("batches routes", () => {
  it("lists recent batches with byAction and undoes over HTTP", async () => {
    const fake = new FakeProvider();
    const { batchId } = await executedBatch(fake);
    const app = createApp({ now: () => SEED_NOW + 1, providerFactory: fake.factory(), oauth: fakeOAuth().oauth });
    const page = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches", {}, { app }));
    const view = page.items.find((b) => b.id === batchId);
    expect(view).toMatchObject({
      kind: "approve",
      requestedCount: 3,
      executedCount: 3,
      failedCount: 0,
      byAction: { delete: 1, archive: 1, keep: 1 },
      undoable: true,
      undoneAt: null,
      undoExpiresAt: new Date(SEED_NOW + DAY).toISOString(),
    });
    const undo = await apiFetch(`/api/batches/${batchId}/undo`, jsonInit("POST"), { app });
    expect((await readJson<UndoResponse>(undo)).restored).toBe(2);
    const after = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches", {}, { app }));
    expect(after.items.find((b) => b.id === batchId)?.undoable).toBe(false);
    const missing = await apiFetch("/api/batches/abc/undo", jsonInit("POST"), { app });
    expect((await readJson<ApiErrorBody>(missing)).error.code).toBe("not_found");
  });

  it("pages batches newest first", async () => {
    const fake = new FakeProvider();
    await executedBatch(fake);
    await executedBatch(fake);
    const app = createApp({ now: () => SEED_NOW + 1 });
    const first = await readJson<Page<ActionBatchView>>(await apiFetch("/api/batches?limit=1", {}, { app }));
    expect(first.items).toHaveLength(1);
    const second = await readJson<Page<ActionBatchView>>(await apiFetch(`/api/batches?limit=1&cursor=${first.nextCursor ?? ""}`, {}, { app }));
    expect((second.items[0]?.id ?? 0) < (first.items[0]?.id ?? 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/actions/undo.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/actions/undo.ts`.

- [ ] **Step 3: Implement `app/src/worker/actions/undo.ts`**

```ts
import type { ActionKind, RestoreItem } from "@clearbox/core";
import type { ItemErrorCode, UndoItemResult, UndoResponse } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { listAccounts } from "../db/accounts.ts";
import type { Account } from "../db/accounts.ts";
import { auditStmt } from "../db/audit.ts";
import { claimUndoStmt, getBatch, resetUndoStmt } from "../db/batches.ts";
import { budgetDeltaStmt, readBudget } from "../db/budget.ts";
import { undoLabelStmt } from "../db/labels.ts";
import { updateProviderMsgIdStmt } from "../db/messages.ts";
import { priorStatements } from "../db/priors.ts";
import { readSettings } from "../db/settings.ts";
import { bindQuery, chunk, MAX_BOUND_PARAMS, sumRowsRead, sumRowsWritten, utcDate } from "../db/sql.ts";
import { markUndoneQuery, undoTargetsQuery } from "../db/suggestions.ts";
import type { TargetRow } from "../db/suggestions.ts";
import { logEvent } from "../log.ts";
import { ApiError } from "../middleware/errors.ts";
import { tokenUpdateStmt } from "../scan/token-source.ts";
import {
  accountFailureStatements,
  assertOwnerBudget,
  classifyProviderError,
  mapActionError,
  openProvider,
} from "./execute.ts";
import type { AccountFailure, ActionContext } from "./execute.ts";
import { undoPriorDeltas } from "./learn.ts";

interface Restored {
  row: TargetRow;
  account: Account;
  finalAction: ActionKind;
  newId: string;
}

/** Contracts 7.8 plus decisions 10 and 11. */
export async function undoBatch(ctx: ActionContext, batchId: number): Promise<UndoResponse> {
  const { db, deps } = ctx;
  const now = deps.now();
  const batch = await getBatch(db, batchId);
  if (!batch) throw new ApiError(404, "not_found", "Batch not found");
  if (now >= batch.undoExpiresAt) throw new ApiError(410, "undo_expired", "The undo window for this batch has ended");
  const [budget, settings, accounts] = await Promise.all([
    readBudget(db, utcDate(now)),
    readSettings(db),
    listAccounts(db, { includeDisconnected: true }),
  ]);
  assertOwnerBudget(budget, ctx.config, now);

  const skippedAll = (): UndoResponse => ({
    batchId,
    results: batch.suggestionIds.map((id) => ({ id, outcome: "skipped", error: null })),
    restored: 0,
    failed: 0,
    skipped: batch.suggestionIds.length,
  });
  const claim = await claimUndoStmt(db, batchId, now).run<{ id: number }>();
  const writes: D1Result[] = [claim];
  if (claim.results.length === 0) return skippedAll();

  try {
    const accountIds = accounts.map((a) => a.id);
    const byAccount = new Map(accounts.map((a) => [a.id, a]));
    const rows: TargetRow[] = [];
    if (accountIds.length > 0 && batch.suggestionIds.length > 0) {
      const queries = chunk(batch.suggestionIds, MAX_BOUND_PARAMS - accountIds.length - 1).map((part) =>
        bindQuery(db, undoTargetsQuery(accountIds, batchId, part)),
      );
      for (const r of await db.batch<TargetRow>(queries)) rows.push(...r.results);
    }
    const rowById = new Map(rows.map((r) => [r.message_id, r]));
    const results = new Map<number, UndoItemResult>();
    const set = (id: number, outcome: UndoItemResult["outcome"], error: ItemErrorCode | null) => results.set(id, { id, outcome, error });

    const restored: Restored[] = [];
    const failures: AccountFailure[] = [];
    const tokenStmts: D1PreparedStatement[] = [];
    let providerCalls = 0;
    const encKey = await importEncKey(ctx.config.tokenEncKey);
    const work = new Map<string, TargetRow[]>();
    for (const id of batch.suggestionIds) {
      const row = rowById.get(id);
      if (!row || row.status !== "executed" || row.final_action === null || row.final_action === "keep") {
        set(id, "skipped", null);
        continue;
      }
      const account = byAccount.get(row.account_id);
      if (!account || account.status !== "active") {
        set(id, "failed", "account_inactive");
        continue;
      }
      work.set(account.id, [...(work.get(account.id) ?? []), row]);
    }
    for (const [accountId, items] of work) {
      const account = byAccount.get(accountId);
      if (!account) continue;
      const { provider, tokens } = openProvider(ctx, account, encKey);
      const restoreItems: RestoreItem[] = items.map((r) => ({ id: r.provider_msg_id, from: r.final_action === "delete" ? "trash" : "archive" }));
      try {
        providerCalls += 1;
        const res = await provider.restore(restoreItems);
        const byPid = new Map(res.map((r) => [r.id, r]));
        for (const row of items) {
          const r = byPid.get(row.provider_msg_id);
          if (!r) set(row.message_id, "failed", "unknown");
          else if (r.ok) {
            restored.push({ row, account, finalAction: row.final_action ?? "keep", newId: r.newId });
            set(row.message_id, "restored", null);
          } else set(row.message_id, "failed", mapActionError(r.error));
        }
      } catch (err) {
        const failure = classifyProviderError(err);
        if (failure.authError) failures.push({ account, error: failure.authError });
        for (const row of items) set(row.message_id, "failed", failure.code);
        logEvent("provider.error", { requestId: ctx.requestId, accountId, provider: account.provider, errorCode: failure.code, status: null });
      }
      if (tokens.update) tokenStmts.push(await tokenUpdateStmt(db, account, encKey, tokens.update, now));
    }

    const list = batch.suggestionIds.map((id) => results.get(id) ?? { id, outcome: "skipped" as const, error: null });
    const count = (o: UndoItemResult["outcome"]) => list.filter((r) => r.outcome === o).length;
    const stmts: D1PreparedStatement[] = [];
    for (const r of restored) {
      stmts.push(bindQuery(db, markUndoneQuery(r.account.id, r.row.message_id, now)));
      if (r.row.label_id !== null) stmts.push(undoLabelStmt(db, r.account.id, r.row.label_id, now));
      if (r.newId !== r.row.provider_msg_id) stmts.push(updateProviderMsgIdStmt(db, r.account.id, r.row.message_id, r.newId));
    }
    stmts.push(
      ...priorStatements(
        db,
        undoPriorDeltas(restored.map((r) => ({ accountId: r.account.id, sender: r.row.sender, senderDomain: r.row.sender_domain, finalAction: r.finalAction }))),
        now,
      ),
    );
    stmts.push(...accountFailureStatements(db, failures, settings.issues, now));
    stmts.push(...tokenStmts);
    const touched = new Set(restored.map((r) => r.account.id));
    stmts.push(
      auditStmt(db, {
        ts: now,
        accountId: touched.size === 1 ? ([...touched][0] ?? null) : null,
        kind: "undo",
        batchId,
        count: restored.length,
        result: { restored: count("restored"), failed: count("failed") },
      }),
    );
    if (restored.length === 0) stmts.push(resetUndoStmt(db, batchId, now));
    writes.push(...(await db.batch(stmts)));
    await budgetDeltaStmt(db, utcDate(now), { rowsWritten: sumRowsWritten(writes) + 1, rowsRead: sumRowsRead(writes), providerCalls }, now).run();

    const response: UndoResponse = { batchId, results: list, restored: count("restored"), failed: count("failed"), skipped: count("skipped") };
    logEvent("undo.done", { requestId: ctx.requestId, batchId, restored: response.restored, failed: response.failed, skipped: response.skipped });
    return response;
  } catch (err) {
    await resetUndoStmt(db, batchId, now).run().catch(() => undefined);
    throw err;
  }
}
```

Undo does not retry single items: a failed restore stays `executed` (the owner can restore it in the provider's UI), and only a fully failed undo reopens the batch (decision 10).

- [ ] **Step 4: Implement `app/src/worker/routes/batches.ts`**

```ts
import { BATCH_RETENTION_MS } from "@clearbox/core";
import type { ActionKind } from "@clearbox/core";
import { Hono } from "hono";
import { z } from "zod";
import { PageQuerySchema } from "../../shared/api.ts";
import type { ActionBatchView, Page } from "../../shared/api.ts";
import { undoBatch } from "../actions/undo.ts";
import { selectBatchAuditStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { listBatchesStmt, mapBatch } from "../db/batches.ts";
import type { ActionBatch, BatchRow } from "../db/batches.ts";
import { decodeCursor, encodeCursor, toIso, toIsoOrNull } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";
import { actionContext } from "./actions.ts";

export const batchesRoutes = new Hono<AppEnv>();

const CursorSchema = z.strictObject({ v: z.literal(1), id: z.int().positive() });

export function toBatchView(batch: ActionBatch, audit: AuditRow | undefined, now: number): ActionBatchView {
  const result = audit ? (JSON.parse(audit.result_json) as Record<string, unknown>) : {};
  const num = (k: ActionKind) => (typeof result[k] === "number" ? (result[k] as number) : 0);
  return {
    id: batch.id,
    kind: batch.kind,
    createdAt: toIso(batch.createdAt),
    requestedCount: batch.requestedCount,
    executedCount: batch.executedCount,
    failedCount: batch.failedCount,
    byAction: { delete: num("delete"), archive: num("archive"), keep: num("keep") },
    undoable: now < batch.undoExpiresAt && batch.undoneAt === null && batch.executedCount > 0,
    undoExpiresAt: toIso(batch.undoExpiresAt),
    undoneAt: toIsoOrNull(batch.undoneAt),
  };
}

batchesRoutes.get("/", async (c) => {
  const q = parseWith(PageQuerySchema, c.req.query());
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, CursorSchema);
  const db = c.env.DB;
  const now = c.get("deps").now();
  const rows = (await listBatchesStmt(db, { since: now - BATCH_RETENTION_MS, beforeId: cursor?.id ?? null, limit: q.limit + 1 }).run<BatchRow>()).results;
  const batches = rows.slice(0, q.limit).map(mapBatch);
  const audits = new Map<number, AuditRow>();
  if (batches.length > 0) {
    const res = await selectBatchAuditStmt(db, batches.map((b) => b.id)).run<AuditRow>();
    for (const a of res.results) if (a.batch_id !== null) audits.set(a.batch_id, a);
  }
  const last = batches[batches.length - 1];
  const page: Page<ActionBatchView> = {
    items: batches.map((b) => toBatchView(b, audits.get(b.id), now)),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: 1, id: last.id }) : null,
  };
  return c.json(page);
});

batchesRoutes.post("/:id/undo", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(404, "not_found", "Batch not found");
  return c.json(await undoBatch(actionContext(c), id));
});
```

- [ ] **Step 5: Mount the routes in `app/src/worker/app.ts`**

Add the import:

```ts
import { batchesRoutes } from "./routes/batches.ts";
```

Append to the route block (after `actionsRoutes`):

```ts
  app.route("/api/batches", batchesRoutes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/actions test/worker/db-isolation.test.ts`
Expected: PASS, `24 passed` (14 execute, 6 undo, 4 isolation).

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/actions/undo.ts app/src/worker/routes/batches.ts app/src/worker/app.ts app/test/worker/actions/undo.test.ts
git commit -m "feat(worker): add 24-hour undo and the batches routes"
```

---

### Task 15: Activity, insights and policy routes

**Files:**
- Modify: `app/src/worker/db/settings.ts` (append `writePolicy`)
- Create: `app/src/worker/routes/activity.ts`
- Create: `app/src/worker/routes/insights.ts`
- Create: `app/src/worker/routes/policy.ts`
- Modify: `app/src/worker/app.ts` (mount the three route groups)
- Test: `app/test/worker/routes/activity-insights-policy.test.ts`

**Interfaces:**
- Consumes: `selectActivityStmt`, `mapActivity`, `AuditRow`, `selectAuditKindsSinceStmt`, `auditStmt` (Task 6), `selectBudgetStmt`, `selectBudgetHistoryStmt`, `mapBudget`, `BudgetRow`, `budgetDeltaStmt` (Task 6), `readSettings`, `setSettingStmt` (Task 6), `deletePrecisionStmt`, `labelStatsStmt` (Task 7), `listAccounts`, `toAccountSync` (Task 7), `countOpenByAccount` (Task 7), `encodeCursor`, `decodeCursor`, `toIso`, `utcDate` (Task 6), `parseWith`, `readJsonBody`, `ApiError` (Task 5); api `ActivityQuerySchema`, `ActivityEntry`, `Page`, `Insights`, `PolicyResponse`, `PutPolicyBodySchema`, `PatchSenderBodySchema` (Task 2); from `@clearbox/core`: `DEFAULT_POLICY`, `PolicySchema`, `Policy`, `BUDGET_ROWS_PER_DAY`, `INGEST_STOP_ROWS`, `D1_DAILY_WRITE_LIMIT`, `CALIBRATION_WINDOW`.
- Produces: `writePolicy(db, policy: Policy, expectedVersion: number, now: number): Promise<number | null>` in `db/settings.ts` (new version, or null on a version conflict; writes audit `policy_updated` with `{ allow, deny }`), `activityRoutes` (`GET /` at `/api/activity`), `insightsRoutes` (`GET /` at `/api/insights`), `mondayUtc(ms): number`, `policyRoutes` (`GET /`, `PUT /`, `PATCH /senders` at `/api/policy`), `applySenderPatch(policy, entry, list): Policy`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/routes/activity-insights-policy.test.ts`:

```ts
import { DEFAULT_POLICY } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActivityEntry, ApiErrorBody, Insights, Page, PolicyResponse } from "../../../src/shared/api.ts";
import { createApp } from "../../../src/worker/app.ts";
import { auditStmt } from "../../../src/worker/db/audit.ts";
import { budgetDeltaStmt } from "../../../src/worker/db/budget.ts";
import { setSettingStmt } from "../../../src/worker/db/settings.ts";
import { apiFetch, jsonInit, readJson } from "../helpers/request.ts";
import { SEED_NOW, seedAccount, seedLabels, seedSuggestions } from "../helpers/seed.ts";

const DAY = 86_400_000;
const app = createApp({ now: () => SEED_NOW });

describe("GET /api/activity", () => {
  it("pages audit entries newest first and filters by account", async () => {
    const a = await seedAccount();
    await env.DB.batch([
      auditStmt(env.DB, { ts: SEED_NOW - 3, accountId: a.id, kind: "account_connected", batchId: null, count: 0, result: {} }),
      auditStmt(env.DB, { ts: SEED_NOW - 2, accountId: null, kind: "policy_updated", batchId: null, count: 0, result: { allow: 1, deny: 0 } }),
      auditStmt(env.DB, { ts: SEED_NOW - 1, accountId: a.id, kind: "account_paused", batchId: null, count: 0, result: {} }),
    ]);
    const first = await readJson<Page<ActivityEntry>>(await apiFetch("/api/activity?limit=2", {}, { app }));
    expect(first.items.map((e) => e.kind)).toEqual(["account_paused", "policy_updated"]);
    expect(first.items[1]?.result).toEqual({ allow: 1, deny: 0 });
    const second = await readJson<Page<ActivityEntry>>(await apiFetch(`/api/activity?limit=2&cursor=${first.nextCursor ?? ""}`, {}, { app }));
    expect(second.items.map((e) => e.kind)).toEqual(["account_connected"]);
    expect(second.nextCursor).toBeNull();
    const filtered = await readJson<Page<ActivityEntry>>(await apiFetch(`/api/activity?accountId=${a.id}`, {}, { app }));
    expect(filtered.items.map((e) => e.kind)).toEqual(["account_paused", "account_connected"]);
    const mismatch = await apiFetch(`/api/activity?accountId=${a.id}&cursor=${first.nextCursor ?? ""}`, {}, { app });
    expect(mismatch.status).toBe(400);
  });
});

describe("GET /api/insights", () => {
  it("reports precision, labels, calibration, budget, history, weekly and accounts", async () => {
    const acc = await seedAccount({ email: "insights@example.com" });
    await seedSuggestions(acc.id, 2);
    await seedLabels(acc.id, 10, (i) => ({ suggestedAction: "delete", ownerAction: i === 0 ? "keep" : "delete", createdAt: SEED_NOW - i * DAY }));
    await seedLabels(acc.id, 2, { suggestedAction: "archive", ownerAction: "archive", createdAt: SEED_NOW - 20 * DAY });
    const today = "2026-10-15";
    await budgetDeltaStmt(env.DB, today, { rowsWritten: 1_000, ticks: 5, messagesIngested: 50, decisionCalls: 40, decisionInputTokens: 1_000_000, dbSizeBytes: 123 }, SEED_NOW).run();
    await budgetDeltaStmt(env.DB, "2026-10-10", { rowsWritten: 10 }, SEED_NOW).run();
    await env.DB.batch([
      setSettingStmt(env.DB, "calibration", { tauDelete: 0.85, changed: true, outcome: "calibrated", deleteSuggestions: 60, precisionAtTau: 0.99, points: [{ tau: 0.85, support: 30, precision: 0.99 }], ranAt: SEED_NOW - DAY }, SEED_NOW),
      setSettingStmt(env.DB, "tau_delete", 0.85, SEED_NOW),
      auditStmt(env.DB, { ts: SEED_NOW - 1_000, accountId: acc.id, kind: "approve", batchId: 1, count: 3, result: { executed: 4, failed: 0, skipped: 0, retryLater: 0, delete: 2, archive: 1, keep: 1, groups: 2 } }),
      auditStmt(env.DB, { ts: SEED_NOW - 500, accountId: acc.id, kind: "undo", batchId: 1, count: 1, result: { restored: 1, failed: 0 } }),
      auditStmt(env.DB, { ts: SEED_NOW - 7 * DAY, accountId: acc.id, kind: "cleanup", batchId: 2, count: 5, result: { executed: 5, failed: 0, skipped: 0, retryLater: 0, delete: 5, archive: 0, keep: 0, groups: 1 } }),
    ]);
    const body = await readJson<Insights>(await apiFetch("/api/insights", {}, { app }));
    expect(body.precision).toEqual({ deletePrecision: 0.9, deleteSuggestionsDecided: 10, window: 500 });
    expect(body.labels).toEqual({ total: 12, last7Days: 8 });
    expect(body.calibration).toEqual({ tauDelete: 0.85, outcome: "calibrated", ranAt: new Date(SEED_NOW - DAY).toISOString(), points: [{ tau: 0.85, support: 30, precision: 0.99 }] });
    expect(body.budget).toMatchObject({
      date: today,
      rowsWritten: 1_000,
      rowsCap: 90_000,
      ingestStopRows: 65_000,
      d1DailyWriteLimit: 100_000,
      ticks: 5,
      decisionCalls: 40,
      dbSizeBytes: 123,
      dbSizeLimitBytes: 500_000_000,
    });
    expect(body.budget.estimatedDecisionCostUsd).toBeCloseTo(0.042, 9);
    expect(body.history).toHaveLength(14);
    expect(body.history[0]?.date).toBe("2026-10-02");
    expect(body.history.find((h) => h.date === "2026-10-10")?.rowsWritten).toBe(10);
    expect(body.weekly.map((w) => w.weekStart)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(body.weekly[5]).toEqual({ weekStart: "2026-10-12", cleaned: 3, undone: 1 });
    expect(body.weekly[4]).toEqual({ weekStart: "2026-10-05", cleaned: 5, undone: 0 });
    expect(body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: acc.id, provider: "gmail", email: "insights@example.com", status: "active", paused: false, sync: expect.objectContaining({ pendingCount: 2 }) }),
    ]));
  });
});

describe("policy routes", () => {
  it("returns the defaults and version", async () => {
    expect(await readJson<PolicyResponse>(await apiFetch("/api/policy", {}, { app }))).toEqual({
      policy: DEFAULT_POLICY,
      version: 1,
      defaults: DEFAULT_POLICY,
    });
  });

  it("updates with optimistic concurrency and writes an audit row", async () => {
    const policy = { ...DEFAULT_POLICY, allowlist: ["boss@example.com"], minAgeDays: 5 };
    const res = await apiFetch("/api/policy", jsonInit("PUT", { policy, expectedVersion: 1 }), { app });
    expect(await readJson<PolicyResponse>(res)).toMatchObject({ version: 2, policy: { allowlist: ["boss@example.com"], minAgeDays: 5 } });
    const stale = await apiFetch("/api/policy", jsonInit("PUT", { policy, expectedVersion: 1 }), { app });
    expect(stale.status).toBe(409);
    expect((await readJson<ApiErrorBody>(stale)).error.code).toBe("conflict");
    const bad = await apiFetch("/api/policy", jsonInit("PUT", { policy: { ...policy, minAgeDays: -1 }, expectedVersion: 2 }), { app });
    expect(bad.status).toBe(400);
    const audit = await env.DB.prepare("SELECT result_json FROM audit_log WHERE kind = 'policy_updated' ORDER BY id DESC LIMIT 1").first();
    expect(audit).toEqual({ result_json: JSON.stringify({ allow: 1, deny: 0 }) });
  });

  it("moves a sender between lists and removes it with none", async () => {
    const deny = await readJson<PolicyResponse>(await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "Boss@Example.com", list: "deny" }), { app }));
    expect(deny.policy.denylist).toContain("boss@example.com");
    expect(deny.policy.allowlist).not.toContain("boss@example.com");
    const domain = await readJson<PolicyResponse>(await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "@example.net", list: "allow" }), { app }));
    expect(domain.policy.allowlist).toContain("@example.net");
    const none = await readJson<PolicyResponse>(await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "boss@example.com", list: "none" }), { app }));
    expect(none.policy.denylist).not.toContain("boss@example.com");
    expect(none.version).toBe(deny.version + 2);
    const invalid = await apiFetch("/api/policy/senders", jsonInit("PATCH", { entry: "not an address", list: "deny" }), { app });
    expect(invalid.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/activity-insights-policy.test.ts`
Expected: FAIL with `expected 404 to be ...` / `Unexpected end of JSON` because the routes are not mounted.

- [ ] **Step 3: Append `writePolicy` to `app/src/worker/db/settings.ts`**

```ts
/**
 * Decision 25: conditional version bump, then policy upsert and audit guarded on the new version and timestamp,
 * in one D1 batch. Returns the new version, or null when expectedVersion is stale.
 */
export async function writePolicy(db: D1Database, policy: Policy, expectedVersion: number, now: number): Promise<number | null> {
  const next = String(expectedVersion + 1);
  const result = { allow: policy.allowlist.length, deny: policy.denylist.length };
  const [bump] = await db.batch([
    db
      .prepare("UPDATE settings SET value = ?2, updated_at = ?3 WHERE key = 'policy_version' AND CAST(value AS INTEGER) = ?1")
      .bind(expectedVersion, next, now),
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         SELECT 'policy', ?1, ?2
         WHERE (SELECT value FROM settings WHERE key = 'policy_version') = ?3
           AND (SELECT updated_at FROM settings WHERE key = 'policy_version') = ?2
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(policy), now, next),
    db
      .prepare(
        `INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json)
         SELECT ?1, NULL, 'policy_updated', NULL, 0, ?2
         WHERE (SELECT value FROM settings WHERE key = 'policy_version') = ?3
           AND (SELECT updated_at FROM settings WHERE key = 'policy_version') = ?1`,
      )
      .bind(now, JSON.stringify(result), next),
  ]);
  return (bump?.meta.changes ?? 0) === 1 ? expectedVersion + 1 : null;
}
```

- [ ] **Step 4: Implement `app/src/worker/routes/activity.ts`**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ActivityQuerySchema } from "../../shared/api.ts";
import type { ActivityEntry, Page } from "../../shared/api.ts";
import { mapActivity, selectActivityStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { decodeCursor, encodeCursor } from "../db/sql.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith } from "../middleware/errors.ts";

export const activityRoutes = new Hono<AppEnv>();

const CursorSchema = z.strictObject({ v: z.literal(1), f: z.string(), id: z.int().positive() });

activityRoutes.get("/", async (c) => {
  const q = parseWith(ActivityQuerySchema, c.req.query());
  const fingerprint = q.accountId ?? "";
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, CursorSchema);
  if (cursor && cursor.f !== fingerprint) throw new ApiError(400, "validation_failed", "Cursor does not match the filters");
  const rows = (
    await selectActivityStmt(c.env.DB, { accountId: q.accountId ?? null, beforeId: cursor?.id ?? null, limit: q.limit + 1 }).run<AuditRow>()
  ).results;
  const items = rows.slice(0, q.limit).map(mapActivity);
  const last = items[items.length - 1];
  const page: Page<ActivityEntry> = {
    items,
    nextCursor: rows.length > q.limit && last ? encodeCursor({ v: 1, f: fingerprint, id: last.id }) : null,
  };
  return c.json(page);
});
```

- [ ] **Step 5: Implement `app/src/worker/routes/insights.ts`**

```ts
import { BUDGET_ROWS_PER_DAY, CALIBRATION_WINDOW, D1_DAILY_WRITE_LIMIT, INGEST_STOP_ROWS } from "@clearbox/core";
import { Hono } from "hono";
import type { Insights } from "../../shared/api.ts";
import { listAccounts, toAccountSync } from "../db/accounts.ts";
import { selectAuditKindsSinceStmt } from "../db/audit.ts";
import type { AuditRow } from "../db/audit.ts";
import { mapBudget, selectBudgetHistoryStmt, selectBudgetStmt } from "../db/budget.ts";
import type { BudgetRow } from "../db/budget.ts";
import { deletePrecisionStmt, labelStatsStmt } from "../db/labels.ts";
import { readSettings } from "../db/settings.ts";
import { toIso, utcDate } from "../db/sql.ts";
import { countOpenByAccount } from "../db/suggestions.ts";
import type { AppEnv } from "../env.ts";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DB_SIZE_LIMIT_BYTES = 500_000_000;
const DECISION_USD_PER_MILLION_TOKENS = 0.042;

export const insightsRoutes = new Hono<AppEnv>();

/** Monday 00:00 UTC of the ISO week containing ms. */
export function mondayUtc(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

insightsRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const now = c.get("deps").now();
  const today = utcDate(now);
  const [settings, accounts] = await Promise.all([readSettings(db), listAccounts(db, { includeDisconnected: true })]);
  const allIds = accounts.map((a) => a.id);
  const visible = accounts.filter((a) => a.status !== "disconnected");
  const firstWeek = mondayUtc(now) - 5 * WEEK_MS;

  const stmts: D1PreparedStatement[] = [
    selectBudgetStmt(db, today),
    selectBudgetHistoryStmt(db, utcDate(now - 13 * DAY_MS)),
    selectAuditKindsSinceStmt(db, firstWeek, ["approve", "override", "cleanup", "undo"]),
  ];
  if (allIds.length > 0) {
    stmts.push(deletePrecisionStmt(db, allIds, CALIBRATION_WINDOW), labelStatsStmt(db, allIds, now - 7 * DAY_MS));
  }
  const [budgetRes, historyRes, auditRes, precisionRes, statsRes] = await db.batch(stmts);
  const counts = await countOpenByAccount(db, visible.map((a) => a.id));

  const budget = mapBudget(((budgetRes?.results ?? [])[0] as BudgetRow | undefined) ?? null, today);
  const historyRows = new Map(((historyRes?.results ?? []) as BudgetRow[]).map((r) => [r.date, r]));
  const history = Array.from({ length: 14 }, (_, i) => {
    const date = utcDate(now - (13 - i) * DAY_MS);
    const row = historyRows.get(date);
    return { date, rowsWritten: row?.rows_written ?? 0, messagesIngested: row?.messages_ingested ?? 0, decisionCalls: row?.decision_calls ?? 0 };
  });

  const weekly = Array.from({ length: 6 }, (_, i) => ({ weekStart: utcDate(firstWeek + i * WEEK_MS), cleaned: 0, undone: 0 }));
  for (const row of (auditRes?.results ?? []) as AuditRow[]) {
    const week = weekly[Math.floor((row.ts - firstWeek) / WEEK_MS)];
    if (!week) continue;
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const n = (k: string) => (typeof result[k] === "number" ? (result[k] as number) : 0);
    if (row.kind === "undo") week.undone += n("restored");
    else week.cleaned += n("delete") + n("archive");
  }

  const precision = ((precisionRes?.results ?? [])[0] as { decided: number; deleted: number } | undefined) ?? { decided: 0, deleted: 0 };
  const stats = ((statsRes?.results ?? [])[0] as { total: number; recent: number } | undefined) ?? { total: 0, recent: 0 };
  const calibration = settings.calibration;

  const body: Insights = {
    precision: {
      deletePrecision: precision.decided > 0 ? precision.deleted / precision.decided : null,
      deleteSuggestionsDecided: precision.decided,
      window: CALIBRATION_WINDOW,
    },
    labels: { total: stats.total, last7Days: stats.recent },
    calibration: {
      tauDelete: settings.tauDelete,
      outcome: calibration?.outcome ?? null,
      ranAt: calibration ? toIso(calibration.ranAt) : null,
      points: calibration?.points ?? [],
    },
    budget: {
      date: today,
      rowsWritten: budget.rowsWritten,
      rowsCap: BUDGET_ROWS_PER_DAY,
      ingestStopRows: INGEST_STOP_ROWS,
      d1DailyWriteLimit: D1_DAILY_WRITE_LIMIT,
      ticks: budget.ticks,
      messagesIngested: budget.messagesIngested,
      decisionCalls: budget.decisionCalls,
      decisionFailures: budget.decisionFailures,
      decisionInputTokens: budget.decisionInputTokens,
      estimatedDecisionCostUsd: (budget.decisionInputTokens * DECISION_USD_PER_MILLION_TOKENS) / 1e6,
      dbSizeBytes: budget.dbSizeBytes,
      dbSizeLimitBytes: DB_SIZE_LIMIT_BYTES,
    },
    history,
    accounts: visible.flatMap((a) =>
      a.status === "disconnected"
        ? []
        : [{ id: a.id, provider: a.provider, email: a.email, status: a.status, paused: a.paused, sync: toAccountSync(a, counts.get(a.id) ?? { pending: 0, awaitingModel: 0 }) }],
    ),
    weekly,
  };
  return c.json(body);
});
```

- [ ] **Step 6: Implement `app/src/worker/routes/policy.ts`**

```ts
import { DEFAULT_POLICY, PolicySchema } from "@clearbox/core";
import type { Policy } from "@clearbox/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { PatchSenderBodySchema, PutPolicyBodySchema } from "../../shared/api.ts";
import type { PolicyResponse } from "../../shared/api.ts";
import { readSettings, writePolicy } from "../db/settings.ts";
import type { AppEnv } from "../env.ts";
import { ApiError, parseWith, readJsonBody } from "../middleware/errors.ts";

export const policyRoutes = new Hono<AppEnv>();

const PATCH_ATTEMPTS = 3;

async function policyResponse(c: Context<AppEnv>): Promise<Response> {
  const settings = await readSettings(c.env.DB);
  const body: PolicyResponse = { policy: settings.policy, version: settings.policyVersion, defaults: DEFAULT_POLICY };
  return c.json(body);
}

/** Contracts 7.11: adding to one list removes the entry from the other; "none" removes it from both. */
export function applySenderPatch(policy: Policy, entry: string, list: "allow" | "deny" | "none"): Policy {
  const allowlist = policy.allowlist.filter((e) => e !== entry);
  const denylist = policy.denylist.filter((e) => e !== entry);
  if (list === "allow") allowlist.push(entry);
  if (list === "deny") denylist.push(entry);
  return { ...policy, allowlist, denylist };
}

policyRoutes.get("/", (c) => policyResponse(c));

policyRoutes.put("/", async (c) => {
  const body = parseWith(PutPolicyBodySchema, await readJsonBody(c));
  const version = await writePolicy(c.env.DB, body.policy, body.expectedVersion, c.get("deps").now());
  if (version === null) throw new ApiError(409, "conflict", "The policy changed; reload and try again");
  return policyResponse(c);
});

policyRoutes.patch("/senders", async (c) => {
  const body = parseWith(PatchSenderBodySchema, await readJsonBody(c));
  for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
    const settings = await readSettings(c.env.DB);
    const next = parseWith(PolicySchema, applySenderPatch(settings.policy, body.entry, body.list));
    const version = await writePolicy(c.env.DB, next, settings.policyVersion, c.get("deps").now());
    if (version !== null) return policyResponse(c);
  }
  throw new ApiError(409, "conflict", "The policy changed; reload and try again");
});
```

- [ ] **Step 7: Mount the routes in `app/src/worker/app.ts`**

Add the imports:

```ts
import { activityRoutes } from "./routes/activity.ts";
import { insightsRoutes } from "./routes/insights.ts";
import { policyRoutes } from "./routes/policy.ts";
```

Append to the route block (after `batchesRoutes`):

```ts
  app.route("/api/activity", activityRoutes);
  app.route("/api/insights", insightsRoutes);
  app.route("/api/policy", policyRoutes);
```

The final route block in `createApp` reads:

```ts
  // Routes (mounted by later tasks, in this order).
  app.route("/oauth", oauthRoutes);
  app.route("/api", meRoutes);
  app.route("/api/accounts", accountsRoutes);
  app.route("/api", queueRoutes);
  app.route("/api", actionsRoutes);
  app.route("/api/batches", batchesRoutes);
  app.route("/api/activity", activityRoutes);
  app.route("/api/insights", insightsRoutes);
  app.route("/api/policy", policyRoutes);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app test:worker -- test/worker/routes/activity-insights-policy.test.ts test/worker/db-isolation.test.ts`
Expected: PASS, `9 passed` (1 activity, 1 insights, 3 policy, 4 isolation).

- [ ] **Step 9: Commit**

```bash
git add app/src/worker/db/settings.ts app/src/worker/routes/activity.ts app/src/worker/routes/insights.ts app/src/worker/routes/policy.ts app/src/worker/app.ts app/test/worker/routes/activity-insights-policy.test.ts
git commit -m "feat(worker): add activity, insights and policy routes"
```

---

### Task 16: Full verification

**Files:**
- No new files. Fix-ups only if a check fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a green `@clearbox/app` package: all worker and web tests, typecheck, lint, build.

- [ ] **Step 1: Run every app test**

Run: `pnpm --filter @clearbox/app test`
Expected: both Vitest runs PASS; the worker run lists the files `schema`, `api-schemas`, `config`, `log`, `base64`, `aead`, `hmac`, `pkce`, `access`, `csrf`, `envelope`, `entry`, `sql`, `settings`, `budget-audit`, `repositories`, `db-isolation`, `token-source`, `state-cookie`, `oauth-routes`, `me-accounts`, `queue`, `query-plans`, `execute`, `actions`, `undo`, `activity-insights-policy` with 0 failures; the web run passes `placeholder.test.tsx`.

- [ ] **Step 2: Typecheck, lint and text checks**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck && pnpm lint`
Expected: exits 0. `pnpm lint` runs ESLint (no `console` outside `log.ts`, no `any`, no `react` imports in `src/worker`) and `scripts/check-text.ts` (no U+2014, no key material).

- [ ] **Step 3: Build**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app build`
Expected: exits 0; `app/.cloudflare/output/v0/` contains the Worker bundle and the client assets including `_headers`.

- [ ] **Step 4: Smoke-test the dev server with the bypass**

Create `app/.dev.vars` from `app/.dev.vars.example` with the test values from `vitest.worker.config.ts` (synthetic keys, `OWNER_EMAIL=owner@example.test`), then run in a second terminal: `pnpm --filter @clearbox/app db:migrate:local && pnpm --filter @clearbox/app dev`.

Run: `curl -s http://localhost:5173/api/me`
Expected: JSON with `"email":"owner@example.test"` and `"environment":"development"` (dev bypass on localhost).

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5173/api/approve -H "Content-Type: application/json" -d '{"ids":[1]}'`
Expected: `403` (missing `X-Clearbox-CSRF`).

Stop the dev server and delete `app/.dev.vars` (it is gitignored, but it holds test values only for this check).

- [ ] **Step 5: Commit any fix-ups**

```bash
git add app
git commit -m "chore(app): fix-ups from full verification"
```

(Skip if there is nothing to commit.)

---

## Self-review

**Spec coverage (contracts sections in this plan's scope):**

| Requirement | Task |
|---|---|
| 1.1 `app/` files: package, configs, tsconfigs, `index.html`, `.dev.vars.example`, `public/_headers`, `favicon.svg`, migration, `src/shared/api.ts`, `src/worker/{index,env,app,log}.ts`, `middleware/*`, `crypto/*`, `oauth/*`, `db/*` (except `leases.ts`, `senders.ts`), `scan/token-source.ts`, `scan/providers.ts`, `actions/*`, `routes/*` | 1 to 15 |
| 1.3 app scripts, 2 pinned versions, 12.4 SPA test deps | 1 |
| 3.2 to 3.7 config files verbatim, local secrets template, test bindings | 1 |
| 6.1 migration verbatim (+ 12.1 A4 column), partial index usage, isolation rule and test, query plan test | 1, 7, 11, 12 |
| 6.2 status transitions (pending, approved, executed, failed, dismissed, undone) | 7, 10, 12, 14 |
| 6.3 settings keys (tau, policy, version, calibration read, issues) | 6, 9, 12, 15 |
| 6.4 owner budget gate at 90,000 rows and budget accounting for owner actions | 12, 14 |
| 7.1 middleware order, Access JWT (header only, RS256, iss, aud, exp, email, service tokens rejected, JWKS cached), dev bypass rules, CSRF, headers, `no-store`, 64 KiB limit | 5 |
| 7.2 error envelope, zod mapping, pagination cursors | 5, 6, 11 |
| 7.4 `GET /api/me` | 10 |
| 7.5 accounts list, pause, disconnect (Google revoke, Microsoft consent links, dismiss open suggestions, audit) | 10 |
| 7.5 scan now | plan 04 (decision 5) |
| 7.6 summary, groups (paging, filter, sort), group detail, deep links, plain-text fields, A1, A6 | 11 |
| 7.7 approve ids/group, override, Clean up, preview, caps, idempotency, per-item results, labels, priors, batch, audit, Graph new ids, auth/config errors, A2, A5, 12.3 | 12, 13 |
| 7.8 undo (24 h, 410, restore from trash/archive, labels, priors), batches list | 14 |
| 7.9 activity | 15 |
| 7.10 insights (+ A3 weekly, A4 inbox estimate via AccountSync) | 7, 15 |
| 7.11 policy get, put with `expectedVersion`, sender patch, audit (A5 keys) | 15 |
| 7.12 OAuth state cookie | 9 |
| 7.13 OAuth start/callback steps 1 to 9 and error codes | 9 |
| 7.14 redirect target `/settings/accounts`, `/api` and `/oauth` never fall back | 5, 9 |
| 7.15 AES-256-GCM, AAD, key version, token source with rotation capture, encrypted access token cache | 4, 8 |
| 8.1 entry points (`fetch`, `scheduled` with `CRON_TICK`, `CRON_NIGHTLY`) | 5 (stubs for plan 04) |
| 9 logging events and field rules | 3, 5, 9, 10, 12, 14 |
| 10.4 worker test conventions and required security tests (Access matrix, CSRF, OAuth state, AES-GCM, approval invariants, DB isolation) | 5, 4, 9, 12, 7 |

**Placeholder scan:** no "TBD", "TODO", "implement later" or "similar to Task N". The only conditional instructions are the documented contract fallbacks (contracts 3.5 `composite` fallback, `@msw/cloudflare` initial-handler fallback, query-plan seeding fallback), each with exact replacement content.

**Type consistency checks done:**
- `ApiError(status, code, message, { details?, retryAt? })` is used the same way in every task; `retryAt` is an ISO string.
- `Account` fields (`refreshToken`, `accessToken`, `keyVersion`, `archiveFolderId`, `inboxEstimate`) match between `db/accounts.ts`, `scan/token-source.ts` (`TokenAccount`), seed helpers and routes.
- `ProviderFactory(target: ProviderTarget, deps: ProviderDeps)` and `ProviderOAuthMap` are the same in `providers.ts`, `env.ts` (`AppDeps`), `app.ts` (`AppOverrides`), `fake-provider.ts` and `connect.ts`.
- `SqlQuery`/`bindQuery` are used by every query builder in `db/suggestions.ts` and by `query-plans.test.ts`.
- `AuditEntry.batchId` accepts `"latest_batch"` (Task 6) because Task 12 links the audit row to the batch inserted in the same D1 batch.
- `executeSuggestions` and `undoBatch` share `ActionContext`, `openProvider`, `classifyProviderError`, `accountFailureStatements`, `assertOwnerBudget`.
- Route mount order in `createApp` is listed once in its final form (Task 15 Step 7).

**Open items for the lead:**
- `@msw/cloudflare@0.2.0` initial handler support and the D1 BLOB result shape are verified at execution time (fallbacks given in Tasks 1, 5 and 7).
- Reconciled with plan 04 (index plan 00): it keeps the `runTick`/`runNightly`/`TickOptions` signatures, marks its calibration SQL with `-- isolation-exempt: calibration` (and extends `db-isolation.test.ts` to check it), checks the awaiting-model query plan in its own `context.test.ts`, refreshes `accounts.inbox_estimate` inside its guarded tick account update, and replaces the `// Plan 04 adds` comment in `routes/accounts.ts` with `accountsRoutes.post("/:id/scan", ...)`.
- Unexpected request errors log `request.error` (contracts 9 rev 2.2, decision 17).


## Execution notes

Executed on branch `feat/clearbox-03-worker-platform` (stacked on `feat/clearbox-02-mail-providers`) with superpowers:subagent-driven-development: one implementer per task, a spec and quality review after each task (fix rounds on Tasks 8, 9 and 14), a final whole-branch review and one fix wave. No dependency was added. No name in "Interfaces produced for other plans" or the index registry was renamed or changed signature; the only interface additions are listed under "Additive interface changes".

### Gate 03 result

`pnpm install --frozen-lockfile && pnpm test && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm lint && pnpm format:check && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm build && git diff --quiet HEAD && echo committed` passes: core `Test Files  40 passed (40)`, `Tests  635 passed (635)`; app worker `Test Files  28 passed (28)`, `Tests  220 passed (220)`; app web `Test Files  1 passed (1)`, `Tests  1 passed (1)`; `check-text: 225 tracked files clean`; `All matched files use Prettier code style!`; `app/.cloudflare/output/v0/` exists (client assets include `_headers`); `committed`.

Counts differ from the plan text: core carries 635 tests from plans 01 and 02 (not 353 + 252; see their execution notes). The worker run has the 27 files the gate lists plus `test/worker/routes/cleanup-scope.test.ts` (final-review fix F1); per-task test counts are higher than the briefs because regression tests were added for the deviations below. Worker runs print wrangler `Missing required secrets` and Node `DEP0040 punycode` notices (test values come from `miniflare.bindings`); they are harmless and pre-date any route code.

Task 16 smoke test (dev server with `.dev.vars` from the example, then deleted): `GET /api/me` returned `"email":"owner@example.test"` and `"environment":"development"`; `POST /api/approve` without `X-Clearbox-CSRF` returned `403`.

### Live-verification outcomes (index items)

| # | Outcome |
|---|---|
| 9 | `@cloudflare/vitest-plugin` 1.4.2 with `experimental.newConfig` loads `app/cloudflare.config.ts` in test mode (the `DB` binding comes from it; `miniflare.bindings` apply on top). Vitest 5's default `fsModuleCache` broke the workerd pool, so `vitest.worker.config.ts` sets `fsModuleCache: false`. |
| 10 | `@msw/cloudflare` 0.2.0 `setupNetwork()` takes no arguments. The documented fallback is used: `beforeEach(() => network.use(jwksHandler(), catchAll))`. |
| 11 | Local D1 returns BLOB columns as `number[]`; `bytesFromBlob` handles it. |
| 13 | `cf build` writes `app/.cloudflare/output/v0/` (`config.json`, `workers/default/bundle/index.js`, client assets in `workers/default/assets/`). Plan 05 and Gate 05 paths are correct. |
| 14 | Confirmed for `cf workers types` and `cf build`, and also for `cf d1 migrations apply --local`: `db:migrate:local` therefore passes `--mode development` (uses `LOCAL_D1_ID`, no `CLEARBOX_D1_ID` needed). |
| 15 | `tsc -b` accepts `composite` with `noEmit` under TypeScript 6.0.3; each app tsconfig sets `tsBuildInfoFile` under `node_modules/.tmp` so no `.tsbuildinfo` lands in tracked paths. |

### Deviations (fix forward)

| # | Task | Change | Why |
|---|---|---|---|
| 1 | 1 | `pnpm-workspace.yaml` gains `allowBuilds: { esbuild: false, workerd: false }` and a pnpm-written `minimumReleaseAgeExclude` for four pinned SPA packages | `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`; the platform binaries come from optional packages (verified on macOS; plan 06 CI should confirm Linux). The exclude entries can go once those versions age |
| 2 | 1 | `cloudflare.config.ts` resolves `clearbox.local.json` with `path.join(import.meta.dirname, ...)` and is type-checked by `tsconfig.worker.json` (not `tsconfig.node.json`); `test/worker/env.d.ts` augments `Cloudflare.Env` with `TEST_MIGRATIONS` | Workers `URL` is not Node's `PathLike`; generated types already import the config; `env` from `cloudflare:workers` is typed `Cloudflare.Env` |
| 3 | 3 | `utf8()` returns `Uint8Array.from(new TextEncoder().encode(s))` | Workers types for `TextEncoder.encode` are not assignable to `Uint8Array<ArrayBuffer>` |
| 4 | 6 | `auditStmt` normalizes results to the fixed A5 keys (`auditResult`); `parseSettings` returns a copy of the default policy; `selectBatchAuditStmt` throws `RangeError` above 99 ids | Decision 28 exact keys; shared constant mutation; 99-parameter rule |
| 5 | 7 | `dismissOpenStmt` sets `action = COALESCE(action, 'unsure')` | Schema `CHECK (status = 'awaiting_model' OR action IS NOT NULL)` rejected dismissing `awaiting_model` rows on disconnect |
| 6 | 7 | `packages/core/test/msw/gmail.ts` and `google-oauth.ts`: two private helper parameters narrowed to `Pick<Request, ...>` (type-only) | Importing `@clearbox/core/testing` from the worker tsconfig failed typecheck against Workers `Request` |
| 7 | 9 | New accounts and reconnects encrypt with and store `CURRENT_KEY_VERSION` (brief kept the existing row version on reconnect); in-place updates (`tokenUpdateStmt`) keep the row's `key_version` | Decision 23 |
| 8 | 9 | `revokeGoogleToken` result handled as a boolean (dead `try/catch` removed); unexpected failures in the callback and in `completeConnect` keep their redirect codes but log `request.error` (`ConnectContext.onUnexpectedError`, route `/oauth/:segment/callback`) | Plan 02 API; decision 17 diagnostics |
| 9 | 9 | A reconnect whose `inboxEstimate()` fails or returns `null` keeps the previous estimate (new rows stay NULL) | Decision 27 describes not writing; erasing a known value is worse |
| 10 | 10 | Disconnect logs `request.error` when the stored refresh token cannot be decrypted (still answers `revocation: "failed"`) | Key or AAD misconfiguration was invisible |
| 11 | 11 | Stored reasons are validated before `renderReason` (`code` in `REASON_CODES`, params a string/number record); invalid ones are omitted and the request logs `request.error` with `errorName: "InvalidStoredReason"` and a `skippedReasons` count on a 200; `groupReasonsQuery` ignores non-object `reasons_json` elements; `topReasonsFor`/`toSuggestionItem` gain an optional trailing skip counter | `renderReason` throws on unknown codes (plan 01 note). No contracts 9 event fits; flag `request.error` reuse (and `skippedReasons`) for the next contracts revision |
| 12 | 12 | `updateProviderMsgIdStmt` skips the update (`NOT EXISTS` guard) when another row of the account already has the moved Graph id; empty Clean up `actions` match nothing; unexpected non-provider errors in a provider call log `request.error`; the budget test restores the budget | A UNIQUE collision would abort the one-transaction result batch after mail had moved |
| 13 | 13 | `ActionContext` gains `route: string` (set from `routePath(c)` by `actionContext(c)`) | Contracts 9 needs a route pattern in `request.error` |
| 14 | 14 | `GET /api/batches` chunks the audit read by `MAX_BOUND_PARAMS`; undo target reads are chunked (accounts + 1 + ids <= 99, at most 90 accounts); `provider.error.errorCode` uses the `ClearboxError` code; the claim is reset only if the final write did not commit | 99-parameter rule (page limit is 100); log contract; a failed post-commit budget write must not reopen an applied undo |
| 15 | 14 | Decision 10 interpreted as: reset `undone_at` only when nothing was restored AND at least one item failed. An all-skipped batch (for example a "Confirm all keeps" batch) stays undone | Literal reading kept keep-only batches undoable for 24 hours, writing a zero-count `undo` audit row on every click |
| 16 | 15, final | `writePolicy` runs the policy upsert and the audit insert guarded on `policy_version = ?expected`, then the conditional bump last; success is the bump's `changes === 1`. Same semantics as decision 25, different statement order | The plan order let a stale same-millisecond write overwrite the policy; the interim `changes()` chain depended on undocumented D1 connection behaviour and could lose the policy silently |
| 17 | final | `readConfig` validates `AZURE_DECISION_ENDPOINT` (https account root: no path, query, fragment or credentials) and rejects deployment `Microsoft-Decision-1`; invalid values fail closed in `invalid`; empty values still mean "off" | Contracts 3.7; an `http://` endpoint would send `api-key` in cleartext |
| 18 | final | Delete/archive Clean up (execute, preview, `QueueSummary.cleanup`) is scoped to `active` accounts (paused accounts are active); keep-only Clean up keeps every visible account; an explicit inactive `accountId` gives an empty scope; preview `groupsLeft` counts inactive accounts' pending groups as left. New export `cleanupAccountIds` in `actions/execute.ts` | One `needs_reauth` account with 100+ high-confidence items blocked every all-accounts Clean up (`retry_later` forever, `remaining` never 0) |

### Additive interface changes

`auditResult` (`db/audit.ts`), `ConnectContext.onUnexpectedError?` (`oauth/connect.ts`), `ActionContext.route` (`actions/execute.ts`), `cleanupAccountIds` (`actions/execute.ts`), optional trailing parameters on `topReasonsFor` and `toSuggestionItem` (`routes/queue.ts`). Nothing was removed or renamed.

### Notes for later plans

- Plan 04:
  - `dismissSql` for `removedIds` (contracts 8.2) must also set `action = COALESCE(action, 'unsure')`; otherwise an `awaiting_model` suggestion hits the schema CHECK and aborts the whole tick batch on every tick of that account.
  - The nightly stale-`approved` recovery SQL has no `account_id` predicate; rewrite it per account or mark it with an isolation exemption and extend the isolation test.
  - `tokenUpdateStmt` re-encrypts under the row's `key_version`; `encryptTokenUpdate` must do the same. `createD1TokenSource` has no single-flight refresh: keep provider calls per account sequential.
  - Builders that take `accountIds` (`countOpenByAccount` excepted) emit `IN ()` on an empty list; guard callers. Account-id IN lists are not chunked (about 90 accounts maximum per statement).
  - `entry.test.ts` cannot tell the cron routes apart while both handlers are no-op stubs; assert dispatch when replacing them.
  - The test network catch-all answers 500 for unmocked requests instead of failing the test; code that maps 5xx to `retry_later` can pass silently with a missing mock.
- Plan 05:
  - Delete/archive Clean up counts and execution exclude inactive accounts; keep-only ("Confirm all keeps") does not.
  - A partly restored undo whose other items failed with a retryable error stays undone (`undoable: false`); do not offer an in-app retry for those items.
  - `src/shared/api.ts` keeps the contract-verbatim comment "default all three" on Clean up actions; the server enforces decision 29 (`["delete","archive"]` default, `keep` only on its own).
  - OAuth landing redirects and codes are unchanged (`/settings/accounts?connected=<id>` or `?error=<code>&provider=<kind>`).
- Plan 06: confirm `allowBuilds: false` for `esbuild`/`workerd` on Linux CI; remove `minimumReleaseAgeExclude` once the pinned versions age.

### Deferred minor findings (triaged by the final review as safe to defer)

Test hygiene and coverage gaps (spy restores outside `finally`, order-dependent tests sharing per-file D1, untested IV length, CHECK on `inbox_estimate`, PATCH sender 3-retry 409, undo 429 and `account_inactive`, per-item `unavailable`, the `ACCESS_TOKEN_MIN_TTL_MS` boundary, direct `FakeProvider` tests); the `request.error` field mapping repeated in five call sites; a dead `BodyLimitError` branch in `errors.ts`; `TeamDomainSchema` accepts any https host; `bytesFromBlob` accepts non-byte numbers; AAD fields joined by `|` (ids are generated); audit rows not tied to the guarded UPDATE on racing disconnect, pause or reconnect; `issue.cleared` logged before its batch commits; an unreachable `provider_config_error` branch in `completeConnect`; inbox estimate not range-checked before the CHECK; inflated `skippedReasons` count; missing reason params render the placeholder text; silent Graph id collision; undo `rowsRead` undercount; batch id `1e2` accepted; `deletePrecisionStmt`/`labelStatsStmt` bind accounts + 1.
