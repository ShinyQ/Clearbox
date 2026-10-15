# Clearbox: Shared Contracts

- **Status:** Approved, rev 2.2 (pairs with design spec rev 2; rev 2.1 and rev 2.2 changes are summarized in section 12)
- **Date:** 2026-10-15
- **Scope:** the single source of truth for every name, type, file path, table, route, env var, constant and dependency version that implementation plans reference. The design spec (`2026-10-15-clearbox-design.md`) is the narrative; when the two disagree, **this document wins** and the spec must be fixed.
- **Rule for plan authors:** do not invent shared names. If something shared is missing here, add it to this document in the same change that needs it, and keep the spec consistent.

Conventions used below:

- All timestamps stored in D1 and passed between modules are **epoch milliseconds (UTC) as integers**. REST responses use ISO 8601 strings (`toISOString()`).
- "Account-owned table" means a table with an `account_id` column.
- Code blocks are normative unless marked "example".

---

## 1. Repository layout, workspace and scripts

### 1.1 Layout

Every planned file is listed. Files not listed here must not be created without updating this section (tests and fixtures are covered by the patterns in section 10).

```
/
  package.json                      # root: workspace scripts, shared dev tooling (eslint, prettier, typescript)
  pnpm-workspace.yaml               # packages: packages/*, app, eval
  pnpm-lock.yaml                    # committed lockfile
  .npmrc                            # engine-strict=true, auto-install-peers=true
  .nvmrc                            # "24"
  .editorconfig                     # utf-8, lf, 2 spaces, final newline
  .gitignore                        # see 3.9
  .prettierrc.json                  # see 3.8
  .prettierignore                   # pnpm-lock.yaml, .cloudflare/, dist/, coverage/, *.md, docs/design/, .impeccable/
  eslint.config.js                  # flat config for the whole repo (see 3.8)
  tsconfig.base.json                # shared strict compiler options (see 3.5)
  README.md                         # what Clearbox is, quick start, links to docs/
  LICENSE                           # MIT (created by plan 06)
  SECURITY.md                       # how to report vulnerabilities; threat model summary
  PRODUCT.md                        # product truth (owned by the lead, do not edit in plans)
  .github/
    dependabot.yml                  # weekly npm + github-actions updates
    workflows/ci.yml                # install, lint, typecheck, test on push and PR (Node 24, pnpm 12)
    workflows/codeql.yml            # CodeQL javascript-typescript analysis
  scripts/
    tsconfig.json                   # typecheck config for scripts (Node types); CI runs tsc -p scripts/tsconfig.json
    check-text.ts                   # fails if a tracked or untracked non-ignored text file contains U+2014 (em dash) or a secret pattern (see 3.8); created by plan 01, replaced by plan 06's superset
    setup-cf.ts                     # interactive: create EU D1, write app/clearbox.local.json, apply remote migrations, set secrets, deploy --no-provision, print Access steps
    gen-key.ts                      # prints a base64 32-byte random key (TOKEN_ENC_KEY, STATE_SIGNING_KEY)
    lib/is-main.ts                  # isMain(import.meta.url): run main() only when executed directly
    lib/run.ts                      # CommandRunner interface + spawn implementation (no shell)
    lib/prompt.ts                   # Prompter interface + raw-mode terminal implementation (hidden input)
    lib/setup-config.ts             # pure setup:cf helpers (secret specs, cf JSON parsing, local config, redirect URIs, Access steps)
    test/*.test.ts                  # node:test suites for the scripts (run by CI: node --test "scripts/test/*.test.ts")
  infra/
    azure/decision.bicep            # AIServices account (optional) + Microsoft-Decision-1 deployment, DataZoneStandard, capacity in RPM
    azure/decision-existing.bicep   # deployment only, into an existing AIServices account
    azure/deploy-decision.sh        # az CLI equivalent of the Bicep files, parameterized, no environment values
  docs/
    setup-cloudflare.md             # cf install, EU D1, secrets, deploy, Access app (Worker destination, owner email policy)
    setup-azure.md                  # Foundry account in swedencentral, decision-1 deployment, capacity 300 RPM, key
    setup-google.md                 # GCP project, Gmail API, consent screen "In production", web client, redirect URI
    setup-microsoft.md              # Entra app (any org + personal), web platform, redirect URI, secret expiry
    runbook.md                      # key rotation, re-auth, config_error, purge, restore, budget exhaustion, Decision-1 retirement, tick CPU check (plan 04 creates the CPU section, plan 06 the full file)
    security-review-checklist.md    # pre-deploy security gate (design spec 7), evidence per item
    superpowers/specs/              # design spec + this contracts doc
    superpowers/research/           # verified research (generic, no environment details)
  packages/
    core/                           # @clearbox/core: pure TypeScript, NO Cloudflare, Hono or DOM imports
      package.json
      tsconfig.json
      vitest.config.ts
      src/index.ts                  # public barrel: re-exports everything listed in section 4
      src/model/mail.ts             # ProviderKind, AccountRef, MailMessage, MailAddress, MailCategory, OwnerPosition
      src/model/actions.ts          # ActionKind, SuggestedAction, Ceiling, ACTION_RANK, isAllowedByCeiling
      src/model/reasons.ts          # ReasonCode, Reason, REASON_TEMPLATES, renderReason
      src/model/errors.ts           # error classes (section 4.12)
      src/model/constants.ts        # every numeric constant in section 4.13
      src/http/fetch.ts             # FetchLike, SubrequestCounter, countingFetch, parseRetryAfter, backoffMs
      src/http/multipart.ts         # Gmail batch: buildBatchBody, parseBatchResponse
      src/text/rfc2047.ts           # decodeEncodedWords (B and Q), unfoldHeader
      src/text/address.ts           # parseAddress, parseAddressList, registrableDomain (last two labels heuristic + small multi-part TLD list)
      src/text/headers.ts           # parseAuthResults, parseListUnsubscribe, isBulkPrecedence, isAutoSubmitted, headerValue
      src/text/truncate.ts          # truncateChars (code-point safe), collapseWhitespace, decodeHtmlEntities
      src/util/rng.ts               # fnv1a32, mulberry32, seededShuffle
      src/util/concurrency.ts       # mapWithConcurrency
      src/providers/provider.ts     # MailProvider interface (incl. inboxEstimate, rev 2.2) + page/cursor/result types (section 4.3)
      src/providers/token.ts        # TokenSource, TokenUpdate, OAuthTokens
      src/providers/oauth.ts        # OAuthClientConfig, AuthorizeParams, scope constants (plan 01); TokenEndpoint, buildAuthorizeUrl, exchangeCode, refreshAccessToken, parseTokenResponse and helpers shared by both providers (plan 02 appends)
      src/providers/google/oauth.ts # Google endpoints, scope check, error classification
      src/providers/google/types.ts # Gmail wire types (copied from research section 8)
      src/providers/google/map.ts   # GmailMessageMetadata -> MailMessage
      src/providers/google/gmail.ts # createGmailProvider
      src/providers/microsoft/oauth.ts  # Entra endpoints, scope check, AADSTS classification
      src/providers/microsoft/types.ts  # Graph wire types (copied from research section 8)
      src/providers/microsoft/map.ts    # GraphMessage -> MailMessage
      src/providers/microsoft/graph.ts  # createGraphProvider
      src/signals/signals.ts        # Signals, SenderHistory, SignalContext, extractSignals
      src/policy/policy.ts          # PolicySchema, Policy, DEFAULT_POLICY, parsePolicy, matchesSenderList
      src/guardrails/guardrails.ts  # evaluateGuardrails
      src/priors/priors.ts          # Prior, PriorCounts, selectPrior, priorKeyForSender, priorKeyForDomain, applyOwnerAction
      src/decision/engine.ts        # DecisionEngine, DecisionInput, DecisionResult
      src/decision/state.ts         # DecisionState, PastDecision, buildDecisionState (token budget)
      src/decision/questions.ts     # DECISION_QUESTIONS, buildDecisionRequest (seeded option shuffle)
      src/decision/response.ts      # zod DecisionResponseSchema, normalizeDecisionResponse
      src/decision/mai-engine.ts    # MaiDecisionEngine (fetch, timeout, error classification)
      src/decision/fake-engine.ts   # FakeEngine (deterministic, rule-based)
      src/decision/run.ts           # decideAll (concurrency-limited, settled outcomes)
      src/fusion/fusion.ts          # Thresholds, FusionInput, Suggestion, fuse, selectReasons
      src/calibration/calibration.ts# CalibrationSample, CalibrationResult, calibrateTauDelete
      test/                         # see section 10
  app/                              # @clearbox/app: ONE Vite project = Worker (src/worker) + SPA (src/web)
    package.json
    cloudflare.config.ts            # cf project config (section 3.2)
    vite.config.ts                  # Vite + React + Tailwind + Cloudflare plugin (section 3.3)
    vitest.worker.config.ts         # Workers runtime tests (section 3.6)
    vitest.web.config.ts            # SPA tests in happy-dom (section 3.6)
    tsconfig.json                   # solution file referencing the three below
    tsconfig.worker.json            # src/worker, src/shared, .cloudflare/types
    tsconfig.web.json               # src/web, src/shared, DOM libs
    tsconfig.node.json              # config files and test setup under Node types
    index.html                      # SPA entry, loads /src/web/main.tsx, no inline script or style
    .dev.vars.example               # template for local secrets (section 3.7); real .dev.vars is gitignored
    clearbox.local.json             # GITIGNORED: { "d1DatabaseId": "<uuid>" } written by scripts/setup-cf.ts
    public/_headers                 # CSP and security headers for asset responses (section 3.4)
    public/favicon.svg
    migrations/0001_init.sql        # D1 schema (section 6)
    src/shared/api.ts               # REST contract: zod request schemas + response types (section 7), shared by worker and web
    src/worker/index.ts             # export default { fetch, scheduled } satisfies ExportedHandler<Env>
    src/worker/env.ts               # AppEnv, readConfig (validates secrets, fail closed), CRON_TICK, CRON_NIGHTLY
    src/worker/app.ts               # createApp(): Hono app, middleware order, route mounting, notFound, onError
    src/worker/log.ts               # logEvent (section 9), newId helpers
    src/worker/middleware/access.ts # verifyAccessJwt with jose, dev bypass rules
    src/worker/middleware/csrf.ts   # requires X-Clearbox-CSRF: 1 on mutating /api routes
    src/worker/middleware/errors.ts # ApiError, error envelope, zod error mapping
    src/worker/middleware/headers.ts# secureHeaders config for Worker responses
    src/worker/crypto/base64.ts     # base64 and base64url encode/decode
    src/worker/crypto/aead.ts       # importEncKey, encryptToken, decryptToken (AES-256-GCM, AAD)
    src/worker/crypto/hmac.ts       # importSigningKey, signValue, verifyValue (HMAC-SHA-256)
    src/worker/crypto/pkce.ts       # createVerifier, challengeS256
    src/worker/oauth/state-cookie.ts# OAuth state cookie create/verify (section 7.12)
    src/worker/oauth/connect.ts     # completeConnect: scope check, profile, bootstrap, account upsert
    src/worker/db/sql.ts            # D1 helpers: chunk, placeholders, sumRowsWritten, now
    src/worker/db/accounts.ts       # account repository
    src/worker/db/messages.ts       # message insert/read
    src/worker/db/suggestions.ts    # suggestion insert/update/query, group queries
    src/worker/db/labels.ts         # label insert/update, few-shot and calibration reads
    src/worker/db/priors.ts         # sender_priors reads and upserts
    src/worker/db/settings.ts       # typed settings get/set (section 6.3)
    src/worker/db/budget.ts         # budget upsert and reads
    src/worker/db/audit.ts          # audit_log append and feed
    src/worker/db/batches.ts        # action_batches insert, read, mark undone
    src/worker/scan/tick.ts         # runTick(env, opts), runTickInternal: the single tick code path (section 8); plan 03 ships a stub, plan 04 replaces it
    src/worker/scan/token-source.ts # plan 03: createD1TokenSource, refreshFnFor, tokenUpdateStmt, staticTokenSource (uses core TokenUpdate)
    src/worker/scan/providers.ts    # plan 03: ProviderTarget, ProviderFactory, makeProvider(target, deps), ProviderOAuth, PROVIDER_OAUTH, oauthClientConfig, callbackPath, routeSegment
    src/worker/scan/tick-tokens.ts  # plan 04: openTickTokens (claimed row -> plan 03 token source), providerTargetOf, TokenColumns, encryptTokenUpdate
    src/worker/scan/engine.ts       # makeDecisionEngine(env, fetch)
    src/worker/scan/claim.ts        # CLAIM_SQL, claim batch, claim parsing, tick settings, scan-now error mapping
    src/worker/scan/context.ts      # context read statements (fresh page and redecide) and parsing
    src/worker/scan/ingest.ts       # pure: page -> signals -> guardrails -> decisions -> fusion (FinalItem)
    src/worker/scan/write-plan.ts   # statement toolkit ({ sql, params }) and the D1 write batch for a tick
    src/worker/scan/failure.ts      # failure classification, failure write batch, DecisionOutageError, DecisionNotConfiguredError
    src/worker/actions/execute.ts   # executeSuggestions: approve, override, cleanup share this
    src/worker/actions/undo.ts      # undoBatch
    src/worker/actions/learn.ts     # label + prior statements for owner decisions and undo
    src/worker/nightly/nightly.ts   # runNightly: lease, calibration, purge, stale recovery (plan 03 stub, plan 04 replaces)
    src/worker/nightly/purge.ts     # bounded chunked deletes
    src/worker/routes/me.ts         # GET /api/me
    src/worker/routes/accounts.ts   # accounts list, patch, delete, scan-now
    src/worker/routes/queue.ts      # summary, groups, group detail
    src/worker/routes/actions.ts    # approve, override, cleanup preview, cleanup
    src/worker/routes/batches.ts    # batches list, undo
    src/worker/routes/activity.ts   # activity feed
    src/worker/routes/insights.ts   # insights
    src/worker/routes/policy.ts     # policy get, put, sender patch
    src/worker/routes/oauth.ts      # /oauth/{google,microsoft}/{start,callback}
    src/web/main.tsx                # React root, QueryClientProvider, RouterProvider (plan 03 placeholder, plan 05 replaces)
    src/web/styles.css              # @import "tailwindcss"; design tokens (owned by the UI plan)
    src/web/styles.dark.css         # v1.1 dark token set, not imported
    src/web/api/client.ts           # apiGet/apiSend: same-origin, zod-validated, adds X-Clearbox-CSRF on mutations, parses ApiErrorBody
    src/web/api/schemas.ts          # zod response schemas, each `satisfies z.ZodType<ContractType>`
    src/web/api/endpoints.ts        # one typed function per REST route
    src/web/api/keys.ts             # query key factory
    src/web/api/query-client.ts     # createQueryClient (global defaults)
    src/web/api/queries.ts          # TanStack Query hooks and polling cadence for every route in section 7
    src/web/api/mutations.ts        # mutation hooks, invalidations, optimistic pause
    src/web/api/cleanup.ts          # pure Clean up loop
    src/web/api/group-actions.ts    # pure group approve/override loop
    src/web/lib/                    # pure view helpers: view-types, confidence, format, avatar, account-status, platform, report, copy, copy-actions, links, oauth-return, oauth-errors, banners, activity, rules-draft
    src/web/state/                  # providers and hooks: LiveAnnouncer, ToastProvider, toast-queue, UndoStackProvider, HotkeysProvider, hotkeys-core, CleanupProvider, cleanup-machine, offline, use-*.ts
    src/web/routes.tsx              # route table (UI spec 3.5; /settings/accounts is the OAuth return of 7.14)
    src/web/pages/                  # one file per page plus pages/review/ (Review hooks) and pages/gallery/ (dev-only); UI plan owns the list
    src/web/components/             # ui/, shell/, review/, insights/, accounts/, rules/ (UI plan owns the list)
    test/                           # see section 10
  eval/                             # @clearbox/eval: offline evaluation against a live Decision-1 deployment
    package.json
    tsconfig.json
    vitest.config.ts
    src/run.ts                      # pnpm eval CLI: loads fixtures, runs the pipeline, writes the report
    src/metrics.ts                  # precision, recall, Wilson bound, confusion, reliability bins, threshold sweep, shuffle robustness
    src/fixtures.ts                 # fixture schema, loader, reserved-domain guard, toMailMessage
    src/pipeline.ts                 # per-fixture core pipeline, pacing, eval-only retries, shuffle seed
    src/report.ts                   # summarize(rows) and the markdown report
    src/io.ts                       # paths, isMain, assertGitIgnored, readD1Id
    src/export-labels.ts            # D1 owner-label export into eval/private/ (git-ignored)
    fixtures/emails.jsonl           # synthetic labeled emails only (example.com / .test domains)
    test/                           # Vitest suites
    private/                        # GITIGNORED: exported owner labels and eval reports
```

Notes:

- Rev 2.2: there is no `src/worker/db/leases.ts` or `db/senders.ts`; the lease, sender, correspondent and sent-thread SQL of the tick lives in `scan/claim.ts` and `scan/write-plan.ts`, and nightly SQL in `nightly/*.ts` (section 11).
- `app/` replaces rev 1's `apps/worker` + `apps/web`: `cf` has no `assets.directory`; assets are the Vite client build of the same project (research cloudflare.md C8).
- No `clearbox.policy.yaml`. Policy defaults are TypeScript (`DEFAULT_POLICY`), owner edits live in D1 `settings` (no YAML dependency).
- `packages/core` uses only Web-standard globals available in both Node 24 and Workers: `fetch`, `Request`, `Response`, `Headers`, `URL`, `TextEncoder`, `TextDecoder`, `AbortSignal.timeout`, `crypto.subtle`, `crypto.getRandomValues`.

### 1.2 Workspace

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - app
  - eval
```

Package names: `@clearbox/core`, `@clearbox/app`, `@clearbox/eval`. All `"private": true`, `"type": "module"`.

`packages/core/package.json` exports TypeScript source (no build step; consumers are Vite, Vitest and Node type stripping):

```json
{
  "name": "@clearbox/core",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./test/testing.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "zod": "4.6.7" },
  "devDependencies": { "vitest": "5.0.4", "msw": "3.0.3" }
}
```

Relative imports everywhere use explicit `.ts` extensions (`import { fuse } from "./fusion/fusion.ts"`), so Node 24 type stripping can run `eval/` and `scripts/` directly. Use only erasable TypeScript syntax (no `enum`, no `namespace`, no parameter properties): `erasableSyntaxOnly` is on.

### 1.3 Root scripts

Root `package.json`:

```json
{
  "name": "clearbox",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.11.2",
  "engines": { "node": ">=24.13.0" },
  "scripts": {
    "dev": "pnpm --filter @clearbox/app dev",
    "build": "pnpm --filter @clearbox/app build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint . && node scripts/check-text.ts",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "pnpm -r test",
    "db:migrate:local": "pnpm --filter @clearbox/app db:migrate:local",
    "setup:cf": "node scripts/setup-cf.ts",
    "deploy:cf": "pnpm --filter @clearbox/app deploy:cf",
    "gen-key": "node scripts/gen-key.ts",
    "eval": "pnpm --filter @clearbox/eval eval"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "24.19.2",
    "eslint": "10.12.0",
    "eslint-plugin-react-hooks": "7.1.1",
    "globals": "17.13.0",
    "prettier": "3.9.10",
    "typescript": "6.0.3",
    "typescript-eslint": "8.71.2"
  }
}
```

Script names avoid pnpm built-ins (`pnpm setup` and `pnpm deploy` are pnpm commands), hence `setup:cf` and `deploy:cf`.

`app/package.json` scripts:

```json
{
  "scripts": {
    "dev": "cf dev",
    "build": "cf workers types && tsc -b && cf build",
    "typecheck": "cf workers types && tsc -b",
    "test": "vitest run -c vitest.worker.config.ts && vitest run -c vitest.web.config.ts",
    "test:worker": "vitest run -c vitest.worker.config.ts",
    "test:web": "vitest run -c vitest.web.config.ts",
    "db:migrate:local": "cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local --persist-to .cloudflare/state",
    "deploy:cf": "cf workers types && tsc -b && cf deploy --no-provision"
  }
}
```

`eval/package.json` scripts: `"eval": "node src/run.ts"`, `"export-labels": "node src/export-labels.ts"`, `"typecheck": "tsc -p tsconfig.json"`, `"test": "vitest run"` (so `pnpm -r typecheck` and `pnpm -r test` cover eval; rev 2.2). `pnpm eval` reads `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_KEY`, `AZURE_DECISION_DEPLOYMENT` from the process environment; never from files in the repo).

---

## 2. Dependencies (pinned, verified on the npm registry 2026-10-15)

Exact versions, no ranges. Verified with `npm view <pkg> version` / `dist-tags` on 2026-10-15.

| Package | Version | Where | Notes |
|---|---|---|---|
| Node.js | 24.13.1 (engines `>=24.13.0`) | runtime for tooling | `cf` needs >= 22.18, react-router 8 needs >= 22.22, Vitest 5 supports 24 |
| pnpm | 12.11.2 | `packageManager` | via Corepack |
| typescript | **6.0.3** | root dev | npm `latest` is 7.0.2, but `typescript-eslint@8.71.2` peers `typescript >=4.8.4 <6.1.0`; pin the newest 6.0.x |
| vite | 8.3.4 | app dev | |
| @cloudflare/vite-plugin | **2.0.0-beta.sha-67fa336fd** | app dev | npm `beta` tag (2026-10-14); `latest` 1.64.0 is the Wrangler-based line and must not be used with `cf`. Bundles miniflare `5.20261012.0-beta` and `@cloudflare/config@0.26.0` |
| cf | 1.0.0-beta.17 | app dev | provides the CLI and `cf/config` (re-exports `@cloudflare/config@0.26.0`). Same miniflare as the Vite plugin |
| @vitejs/plugin-react | 6.1.2 | app dev | peers `vite ^8` |
| hono | 4.13.13 | app | |
| zod | 4.6.7 | core, app, eval | >= 4.5 required |
| jose | 6.2.12 | app | used by the official Workers Access example (`createRemoteJWKSet`, `jwtVerify`) |
| react, react-dom | 19.3.1 | app | |
| @types/react, @types/react-dom | 19.3.0 | app dev | |
| react-router | 8.4.0 | app | declarative data router (`createBrowserRouter`, `RouterProvider`); no framework mode |
| @tanstack/react-query | 5.104.3 | app | |
| tailwindcss, @tailwindcss/vite | 4.3.3 | app dev | |
| vitest | 5.0.4 | core, app, eval dev | |
| @cloudflare/vitest-plugin | 1.4.2 | app dev | peers `vitest ^4.1.0 \|\| ^5.0.0`; `experimental.newConfig` reads `cloudflare.config.ts` |
| msw | 3.0.3 | core, app dev | Node: `setupServer` from `msw/node`; unhandled requests use MSW 3's `onUnhandledFrame` (10.3) |
| @msw/cloudflare | 0.2.0 | app dev | Workers tests: `setupNetwork()` |
| happy-dom | 21.0.1 | app dev | test DOM environment for SPA tests (`vitest.web.config.ts` `environment: "happy-dom"`); no jsdom |
| @testing-library/react | 16.3.3 | app dev | |
| @testing-library/dom | 10.4.2 | app dev | peer of @testing-library/react |
| @testing-library/user-event | 14.6.8 | app dev | rev 2.1 (12.4), declared by plan 03 |
| axe-core | 4.14.0 | app dev | rev 2.1 (12.4), accessibility checks in SPA tests, declared by plan 03 |
| eslint | 10.12.0 | root dev | |
| @eslint/js | 10.0.1 | root dev | |
| typescript-eslint | 8.71.2 | root dev | |
| eslint-plugin-react-hooks | 7.1.1 | root dev | |
| globals | 17.13.0 | root dev | |
| prettier | 3.9.10 | root dev | |
| @types/node | 24.19.2 | root dev | matches the Node 24 runtime of tooling and core tests |

GitHub Actions (plan 06, pinned by full commit SHA, kept current by Dependabot): `actions/checkout` v7.0.1, `pnpm/action-setup` v6.1.0, `actions/setup-node` v7.1.0, `github/codeql-action` v4.38.3. Script tests use the built-in `node:test` (no dependency). Dependabot ignores `typescript >= 6.1.0` while `typescript-eslint` 8.71.2 peers `< 6.1.0`.

Not used on purpose: Wrangler (only pulled in transitively by `@cloudflare/vitest-plugin`), `@cloudflare/workers-types` (runtime types come from `cf workers types`, which includes runtime types by default), `@hono/zod-validator` (routes call `schema.safeParse` directly), any YAML parser, any date library, any UI component library, any icon library, CSS-in-JS or jest-dom (the UI plan may add one only by updating this table).

---

## 3. Configuration files

### 3.1 Cloudflare resources

| Resource | Name | Notes |
|---|---|---|
| Worker | `clearbox` | `workers.dev` enabled, preview URLs disabled, protected by a Worker-level Access app ("All traffic") |
| D1 | `clearbox` | created with `cf d1 create --name clearbox --jurisdiction eu`; UUID stored outside the repo |
| Cron Triggers | `* * * * *` (tick), `0 2 * * *` (nightly) | 2 of the account-wide 5 on Free |
| Access application | `Clearbox` | self-hosted, destination `{ "type": "worker", "worker_id": "<worker-id>" }`, policy allow `email == OWNER_EMAIL` |

No Workflows, KV, R2, Queues or Durable Objects.

### 3.2 `app/cloudflare.config.ts`

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

Decisions encoded here:

- **No Smart Placement**: it only affects `fetch`, and the heavy traffic runs in `scheduled` (research C6).
- **`redactQueryString: true`**: OAuth callbacks carry `code` and `state` in the query string; they must never reach logs.
- **`DEV_AUTH_BYPASS` is a mode-derived var**, not a secret, so a production build always has `"false"`. The bypass is additionally limited to `localhost`/`127.0.0.1` hostnames (section 7.1).
- Build and deploy always use `--no-provision` (research C14). `remoteD1Id()` throws in production mode instead of letting `cf` auto-create a non-EU database.
- Node.js compat is on by default for this compatibility date (research C10); no flags.

### 3.3 `app/vite.config.ts`

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

`experimental.headersAndRedirectsDevModeSupport` stays **off**: the strict CSP in `public/_headers` would block Vite's dev-time inline React refresh script. CSP applies to production asset responses only.

### 3.4 `app/public/_headers` (asset responses, including the SPA `index.html` fallback)

```txt
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
```

Worker responses (`/api/*`, `/oauth/*`) get headers from `hono/secure-headers` in `src/worker/middleware/headers.ts`:

```ts
secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
  crossOriginOpenerPolicy: "same-origin",
})
```

and every `/api/*` response sets `Cache-Control: no-store`.

### 3.5 TypeScript configs

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": false,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": []
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts"]
}
```

(`node` types are only for tests and config; `src/` must not import `node:*`, enforced by ESLint.)

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

If `tsc -b` rejects `composite` together with `noEmit` under TypeScript 6.0.3, drop `composite` and replace `tsc -b` in the app scripts with `tsc -p tsconfig.worker.json && tsc -p tsconfig.web.json && tsc -p tsconfig.node.json` (equivalent coverage; record the switch here).

`eval/tsconfig.json`: extends base, `"types": ["node"]`, includes `src`.

`app/test/worker/env.d.ts`:

```ts
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
```

### 3.6 Vitest configs

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", setupFiles: ["test/setup/msw.ts"] },
});
```

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

The test keys above are fixed, public, synthetic values (bytes 0..31 and 31..0). They must never be used outside tests.

`app/vitest.web.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: { include: ["test/web/**/*.test.{ts,tsx}"], environment: "happy-dom", setupFiles: ["test/web/setup.ts"] },
});
```

Fallback if `experimental.newConfig` breaks: replace it with `main: "./src/worker/index.ts"` plus `miniflare: { d1Databases: { DB: "00000000-0000-4000-8000-000000000000" }, compatibilityDate: "2026-10-12", bindings: {...} }` (still no Wrangler file).

### 3.7 Secrets and vars

| Name | Kind | Format | Purpose |
|---|---|---|---|
| `ENVIRONMENT` | var (mode-derived) | `development` \| `test` \| `production` | feature gates (dev bypass) |
| `DEV_AUTH_BYPASS` | var (mode-derived) | `"true"` \| `"false"` | local dev without Access; honored only per 7.1 |
| `FREE_TIER` | var | `"true"` \| `"false"` | `"false"` raises page size to 100 and disables the D1 write budget gate |
| `AZURE_DECISION_ENDPOINT` | secret | `https://<foundry-account>.services.ai.azure.com` (account root, no trailing slash, no path) | Decision-1 base URL |
| `AZURE_DECISION_KEY` | secret | Azure key string | `api-key` header |
| `AZURE_DECISION_DEPLOYMENT` | secret | deployment name, e.g. `decision-1` (must not be `Microsoft-Decision-1`) | `model` field |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secret | Google web client | Gmail OAuth. Empty string = Gmail disabled |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | secret | Entra app (client) ID GUID / secret value | Outlook OAuth. Empty string = Outlook disabled |
| `TOKEN_ENC_KEY` | secret | standard base64 of exactly 32 random bytes (`pnpm gen-key`) | AES-256-GCM key for refresh and access tokens |
| `STATE_SIGNING_KEY` | secret | standard base64 of exactly 32 random bytes | HMAC-SHA-256 for the OAuth state cookie |
| `OWNER_EMAIL` | secret | lowercase email | the only identity allowed |
| `ACCESS_TEAM_DOMAIN` | secret | `https://<team>.cloudflareaccess.com` (full origin, equals JWT `iss`) | JWKS URL and issuer |
| `ACCESS_AUD` | secret | Access application AUD tag | JWT audience |

`readConfig(env)` in `src/worker/env.ts` validates every value with zod at first use per isolate. Missing or malformed `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` makes every `/api/*` and `/oauth/*` request fail with `500 access_misconfigured` and makes `scheduled` log `config.invalid` and return (fail closed). Missing Decision secrets only block ticks (issue `decision_not_configured`).

Local secrets: **`app/.dev.vars`** (gitignored), dotenv format, one `KEY=value` per line, same names as above. `app/.dev.vars.example` is committed with placeholder values:

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

Never put Worker secrets in `.env` (the `cf` CLI reads project `.env` for its own credentials). Production secrets are set by `scripts/setup-cf.ts` through `cf deploy --no-provision --secrets-file <gitignored temp file>` and the temp file is deleted afterwards; single-secret fallback is `npx wrangler secret put <NAME> --name clearbox`.

### 3.8 Lint and format

`.prettierrc.json`:

```json
{ "printWidth": 110, "singleQuote": false, "trailingComma": "all", "semi": true, "arrowParens": "always" }
```

`eslint.config.js` (flat config, `defineConfig` from `eslint/config`) contains, in order:

1. Ignores: `**/dist/**`, `**/.cloudflare/**`, `**/coverage/**`, `pnpm-lock.yaml`.
2. `js.configs.recommended`, `...tseslint.configs.strict`, `...tseslint.configs.stylistic`.
3. For `app/src/web/**`: `reactHooks.configs.flat.recommended`, `globals.browser`.
4. `no-restricted-imports` per area:
   - `packages/core/src/**`: forbid `cloudflare:*`, `hono`, `hono/*`, `@cloudflare/*`, `node:*`, `react`, `react-dom`.
   - `app/src/web/**`: forbid `../worker/*`, `**/worker/**`, `cloudflare:*`, `hono`.
   - `app/src/worker/**`: forbid `react`, `react-dom`, `**/web/**`.
5. Rules: `@typescript-eslint/consistent-type-imports: error`, `@typescript-eslint/no-explicit-any: error`, `"no-console": "error"` (rev 2.2: ESLint 10 rejects the former `["error", { allow: [] }]`, "should NOT have fewer than 1 items"; plain `"error"` is equivalent), turned off for `app/src/worker/log.ts`, `scripts/**`, `eval/**`. The SPA's single `console.error` (`src/web/lib/report.ts`) carries one `eslint-disable-next-line no-console` comment.
6. Tests and config files (`**/test/**`, `**/*.config.ts`, `**/*.config.js`): Node globals, `@typescript-eslint/no-non-null-assertion` off.
7. Appended by plan 05 for `app/src/web/**`: `no-restricted-syntax` bans `style={...}` other than a direct `cssVars({...})` call, `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment and `insertAdjacentHTML`.

`.prettierignore`: `pnpm-lock.yaml`, `.cloudflare/`, `dist/`, `coverage/`, `*.md`, `docs/design/`, `.impeccable/` (Markdown is not reformatted: it contains lead-owned files and `docs/design/*.html` does not parse).

`scripts/check-text.ts` scans text files from `git ls-files --cached --others --exclude-standard` (tracked plus untracked non-ignored; skips `pnpm-lock.yaml`, binaries and files over 2 MB) and fails on: U+2014 (em dash); PEM private-key blocks `/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/`; `AZURE_DECISION_KEY=[A-Za-z0-9]{20,}`; dotenv literal assignments of Clearbox secrets (`AZURE_DECISION_KEY`, `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_SECRET`, `ACCESS_AUD` with a value not starting with `<`); AWS access key ids; GitHub tokens; Google API keys; Google OAuth client secrets (`GOCSPX-`); Entra client secrets; Slack tokens; Azure storage account keys; JWTs. A line containing `check-text: allow` is exempt from the secret rules, never from the em dash rule. Plan 01 creates the file with the first three rules; plan 06 Task 1 replaces it with this full set (rev 2.2). Tests build secret-shaped inputs at runtime so they never match.

### 3.9 `.gitignore` (final content)

```gitignore
.superpowers/
.impeccable/
node_modules/
dist/
coverage/
.cloudflare/
.wrangler/
.dev.vars
.dev.vars.*
!.dev.vars.example
.env
.env.*
app/clearbox.local.json
*.secrets.json
eval/private/
```

Plan 01 writes every line except `eval/private/`, which plan 06 appends (rev 2.2). `*.secrets.json` covers `app/deploy.secrets.json`, the temporary `--secrets-file` written by `setup:cf`.

---

## 4. `@clearbox/core` types and interfaces

Everything in this section is exported from `packages/core/src/index.ts`. File locations are in section 1.1. Identifiers are camelCase in TypeScript; the only snake_case object is `DecisionState`, because it is the JSON sent to Decision-1.

### 4.1 Mail model (`model/mail.ts`)

```ts
export type ProviderKind = "gmail" | "outlook";

/** Opaque account id: "acc_" + 16 lowercase hex chars (8 random bytes). */
export type AccountId = string;

export interface AccountRef {
  id: AccountId;
  provider: ProviderKind;
  /** Lowercased primary address of the mailbox. */
  email: string;
}

export interface MailAddress {
  /** Lowercased address, or null when unparseable. */
  address: string | null;
  /** Decoded display name (RFC 2047), or null. */
  name: string | null;
}

export type MailCategory =
  | "primary" | "promotions" | "social" | "updates" | "forums" // Gmail CATEGORY_*
  | "focused" | "other";                                          // Outlook inferenceClassification

export type OwnerPosition = "to" | "cc" | "bcc_or_list";

export type AuthVerdict = "pass" | "fail" | "none";

/** Normalized metadata for one message. No body content beyond the provider snippet. */
export interface MailMessage {
  /** Gmail message id, or Graph immutable id. Case-sensitive. */
  providerMessageId: string;
  /** Gmail threadId or Graph conversationId. */
  threadId: string | null;
  internetMessageId: string | null;
  /** Epoch ms. Gmail internalDate, Graph receivedDateTime. */
  receivedAt: number;
  from: MailAddress;
  to: string[];          // lowercased addresses
  cc: string[];
  deliveredTo: string[]; // Gmail Delivered-To values; [] for Graph
  subject: string;       // decoded, unfolded, "" when absent
  snippet: string;       // plain text, entities decoded, whitespace collapsed, max 255 chars
  isRead: boolean;
  /** Owner-set: Gmail STARRED or Graph flag.flagStatus === "flagged". */
  starred: boolean;
  /** Provider-set: Gmail IMPORTANT label or Graph importance === "high". Signal only, never a guardrail. */
  providerImportant: boolean;
  category: MailCategory | null;
  hasAttachments: boolean;
  /** True when hasAttachments comes from the Gmail multipart/mixed heuristic. */
  attachmentsApprox: boolean;
  /** Approximate thread depth: Gmail References count + 1; Graph (conversationIndex bytes - 22) / 5 + 1. */
  threadDepth: number | null;
  headers: MailHeaders;
  /** Graph webLink. Gmail: null (deep link built in the app from account email + id). */
  webLink: string | null;
  /** Raw provider labels (Gmail labelIds). [] for Graph. */
  labels: string[];
}

export interface MailHeaders {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  listId: string | null;
  precedence: string | null;
  autoSubmitted: string | null;
  /** Only the receiving provider's results: Gmail authserv-id "mx.google.com"; Microsoft the first entry. */
  authenticationResults: string | null;
  returnPath: string | null;
  contentType: string | null;
  references: string | null;
  inReplyTo: string | null;
}
```

### 4.2 Actions (`model/actions.ts`)

```ts
/** Actions the owner can execute. */
export type ActionKind = "delete" | "archive" | "keep";
/** Actions the system can suggest. */
export type SuggestedAction = ActionKind | "unsure";
/** Highest action the guardrails allow. */
export type Ceiling = ActionKind;

export const ACTION_KINDS = ["delete", "archive", "keep"] as const;
export const SUGGESTED_ACTIONS = ["delete", "archive", "keep", "unsure"] as const;

/** keep < archive < delete. "unsure" is not ranked and is always allowed. */
export const ACTION_RANK: Readonly<Record<ActionKind, number>> = { keep: 0, archive: 1, delete: 2 };

export function isAllowedByCeiling(action: SuggestedAction, ceiling: Ceiling): boolean {
  return action === "unsure" || ACTION_RANK[action] <= ACTION_RANK[ceiling];
}

export function minCeiling(a: Ceiling, b: Ceiling): Ceiling {
  return ACTION_RANK[a] <= ACTION_RANK[b] ? a : b;
}

/** Probability per suggested action; values in [0,1], sum 1 (tolerance 1e-9 after normalization). */
export type ActionDistribution = Record<SuggestedAction, number>;
```

### 4.3 Mail provider (`providers/provider.ts`)

```ts
import type { FetchLike } from "../http/fetch.ts";
import type { TokenSource } from "./token.ts";

/**
 * Cursors are opaque strings to callers and stored verbatim in D1.
 * Each provider encodes them as JSON with a version field (shapes in 4.3.1).
 */
export type BackfillCursor = string;
export type SentCursor = string;
export type IncrementalCursor = string;

export interface ProviderDeps {
  fetch: FetchLike;
  tokens: TokenSource;
  now: () => number;
}

export interface GraphProviderDeps extends ProviderDeps {
  /** Resolved at connect; null when no archive folder could be resolved or created. */
  archiveFolderId: string | null;
}

export interface BootstrapResult {
  email: string;               // lowercased
  providerUserId: string;      // Gmail: email; Graph: /me id
  aliases: string[];           // lowercased, excluding email; Gmail sendAs, Graph: [] (proxyAddresses need extra scopes)
  archiveFolderId: string | null; // Graph only; Gmail null
  incrementalCursor: IncrementalCursor; // taken BEFORE any backfill
}

export interface InboxPage {
  messages: MailMessage[];     // newest first
  /** null when the backfill reached the oldest inbox message. */
  nextCursor: BackfillCursor | null;
}

export interface SentItem {
  threadId: string | null;     // Gmail threadId / Graph conversationId
  recipients: string[];        // lowercased To + Cc + Bcc
  sentAt: number;
}

export interface SentPage {
  items: SentItem[];
  nextCursor: SentCursor | null;
}

export interface ChangesPage {
  /** New inbox messages, full metadata, at most maxMessages. */
  added: MailMessage[];
  /** Provider ids that left the inbox (trashed, archived, moved, deleted) outside Clearbox. */
  removedIds: string[];
  /** New sent messages (for correspondents and replied threads), at most maxMessages. */
  sent: SentItem[];
  nextCursor: IncrementalCursor;
  /** True when the provider reported no further changes after nextCursor. */
  caughtUp: boolean;
}

export type ActionErrorCode =
  | "not_found"            // message gone (Gmail 404 notFound, Graph 404 ErrorItemNotFound)
  | "rate_limited"         // 429 / 403 rateLimitExceeded inside a batch
  | "unavailable"          // 5xx / network inside a batch
  | "archive_unavailable"  // Graph account without archive folder
  | "bad_request"          // 400
  | "unknown";

export type ActionResult =
  | { id: string; ok: true; newId: string }
  | { id: string; ok: false; error: ActionErrorCode; retryAfterMs: number | null };

export type RestoreFrom = "trash" | "archive";
export interface RestoreItem { id: string; from: RestoreFrom }

/**
 * No hard-delete method exists, by design.
 * Whole-call failures throw (4.12): ProviderAuthError, ProviderConfigError,
 * ProviderRateLimitError, ProviderUnavailableError, CursorExpiredError, ProviderResponseError.
 * Per-item failures are returned in ActionResult.
 * Every method issues its requests sequentially (never concurrent requests to one mailbox).
 */
export interface MailProvider {
  readonly kind: ProviderKind;
  /** Called once at connect time. */
  bootstrap(): Promise<BootstrapResult>;
  /** Inbox backfill, newest to oldest. cursor null = start at newest. */
  listInboxPage(cursor: BackfillCursor | null, pageSize: number): Promise<InboxPage>;
  /** Sent mail scan for correspondents and replied threads, newest first. */
  listSentPage(cursor: SentCursor | null, pageSize: number): Promise<SentPage>;
  /** Incremental changes since cursor. Throws CursorExpiredError when the cursor is no longer valid. */
  syncChanges(cursor: IncrementalCursor, maxMessages: number): Promise<ChangesPage>;
  /** New incremental cursor after expiry; watermark = newest receivedAt already ingested (epoch ms) or null. */
  resyncCursor(watermark: number | null): Promise<IncrementalCursor>;
  /**
   * Rev 2.2 (12.1 A4): inbox message count (Gmail GET labels/INBOX messagesTotal, Graph GET
   * mailFolders/inbox?$select=totalItemCount), one request. Best effort: null on rate limit, 5xx, network or
   * shape errors; ProviderAuthError, ProviderConfigError and SubrequestBudgetError still throw.
   */
  inboxEstimate(): Promise<number | null>;
  /** Move to Trash / Deleted Items. Max 100 ids per call. */
  trash(ids: readonly string[]): Promise<ActionResult[]>;
  /** Gmail: remove INBOX; Graph: move to archiveFolderId. Max 100 ids per call. */
  archive(ids: readonly string[]): Promise<ActionResult[]>;
  /** Back to inbox. Gmail trash: untrash, then add INBOX if missing. Graph: move to "inbox". Max 100 per call. */
  restore(items: readonly RestoreItem[]): Promise<ActionResult[]>;
}

export declare function createGmailProvider(deps: ProviderDeps): MailProvider;
export declare function createGraphProvider(deps: GraphProviderDeps): MailProvider;
```

#### 4.3.1 Cursor JSON shapes (provider-internal, documented for debugging and tests)

| Provider | Cursor | JSON |
|---|---|---|
| Gmail | backfill | `{"v":1,"pageToken":"<nextPageToken>"}` for `messages.list?labelIds=INBOX&maxResults=<pageSize>` |
| Gmail | sent | `{"v":1,"pageToken":"<nextPageToken>"}` for `messages.list?labelIds=SENT&maxResults=100` |
| Gmail | incremental | `{"v":1,"historyId":"<id>","catchupAfter":<epoch s or null>,"catchupPageToken":"<token or null>"}`: `historyId` is the id of the last fully processed history record (or the getProfile historyId at bootstrap). `catchupAfter` is set only by `resyncCursor(watermark)`: `syncChanges` first drains `messages.list?labelIds=INBOX&q=after:<catchupAfter>` (newest first, paged by `catchupPageToken`, known ids are deduplicated by the caller) and then continues with history |
| Graph | backfill | `{"v":1,"before":"<ISO>","seenAtBefore":["<id>",...]}`: keyset on `receivedDateTime le before`, `$orderby=receivedDateTime desc`, dropping ids already seen at exactly `before` |
| Graph | sent | `{"v":1,"nextLink":"<@odata.nextLink>"}` |
| Graph | incremental | `{"v":1,"inboxDeltaLink":"<url>","sentDeltaLink":"<url>","watermark":"<ISO>"}` |

#### 4.3.2 Provider request rules (normative)

Gmail (`https://gmail.googleapis.com`):

- List: `GET /gmail/v1/users/me/messages?labelIds=INBOX&maxResults=<n>[&pageToken=]` (never `q=in:inbox`).
- Metadata: one `POST /batch/gmail/v1` (max 50 parts) of `GET /gmail/v1/users/me/messages/{id}?format=metadata` with repeated `metadataHeaders` = `From, To, Cc, Delivered-To, Subject, Date, Message-ID, References, In-Reply-To, List-Unsubscribe, List-Unsubscribe-Post, List-Id, Precedence, Auto-Submitted, Authentication-Results, Return-Path, Content-Type` and `fields=id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,headers)`. Parts are mapped by `Content-ID`; failed parts are retried once inside the same call only for 429/5xx, then dropped (the message is picked up again by a later page or catch-up).
- `hasAttachments` = top-level `payload.mimeType` (fallback `Content-Type` header) starts with `multipart/mixed`; `attachmentsApprox = true`.
- Bootstrap: `GET /gmail/v1/users/me/profile` (email + historyId, taken before backfill), `GET /gmail/v1/users/me/settings/sendAs` (aliases).
- Incremental: `GET /gmail/v1/users/me/history?startHistoryId=<id>&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved&historyTypes=messageDeleted&maxResults=100`. Process records in order; stop after collecting `maxMessages` inbox-added ids or `maxMessages` sent-added ids; `nextCursor.historyId` = id of the last fully processed record, or response `historyId` when all records were processed and there is no `nextPageToken` (then `caughtUp = true`). Inbox removal = `labelsRemoved` containing `INBOX`, `labelsAdded` containing `TRASH`, or `messagesDeleted`. HTTP 404 throws `CursorExpiredError`.
- Actions: trash = batch of `POST .../messages/{id}/trash` (max 50 per batch request); archive = `POST .../messages/batchModify {"ids":[...],"removeLabelIds":["INBOX"]}`; restore from trash = batch `untrash`, then `batchModify {"addLabelIds":["INBOX"]}` for returned messages lacking `INBOX`; restore from archive = `batchModify` add `INBOX`. `newId` = same id.
- Errors: 401 `authError` refresh once then `ProviderAuthError`; 403 `rateLimitExceeded`/`userRateLimitExceeded` and 429 `ProviderRateLimitError`; 403 `dailyLimitExceeded` `ProviderRateLimitError` with `retryAfterMs` until next UTC midnight; 403 `domainPolicy` `ProviderAuthError("domain_policy")`; 5xx `ProviderUnavailableError`.

Graph (`https://graph.microsoft.com/v1.0`):

- **Every request and every `$batch` sub-request** carries `Prefer: IdType="ImmutableId"`. Delta requests also carry `Prefer: odata.maxpagesize=<n>` (two `Prefer` values appended to the same `Headers`).
- Inbox `$select`: `id,conversationId,conversationIndex,internetMessageId,from,toRecipients,ccRecipients,subject,bodyPreview,receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification,webLink,internetMessageHeaders`.
- Backfill: `GET /me/mailFolders/inbox/messages?$select=...&$top=<n+seen>&$orderby=receivedDateTime desc[&$filter=receivedDateTime le <before>]`.
- Header fallback: when any listed message lacks `internetMessageHeaders`, fetch them with `$batch` (max 20 per batch) of `GET /me/messages/{id}?$select=internetMessageHeaders`.
- Bootstrap: `GET /me?$select=id,mail,userPrincipalName` (email = `mail ?? userPrincipalName`, lowercased); archive folder: `GET /me/mailFolders/archive?$select=id`, on 404 `POST /me/mailFolders {"displayName":"Archive"}`, on failure `archiveFolderId = null`; incremental cursor: first page of `GET /me/mailFolders/inbox/messages/delta?$select=<inbox select without internetMessageHeaders>&$filter=receivedDateTime ge <bootstrap time ISO>` and the same for `sentitems` with `$select=id,conversationId,toRecipients,ccRecipients,bccRecipients,receivedDateTime`, followed to their `@odata.deltaLink`.
- Incremental: one page of the inbox delta link and one page of the sent delta link per call. `@removed` items become `removedIds`. `syncStateNotFound` (any 4xx with that code) and `410 Gone` throw `CursorExpiredError`; `resyncCursor(watermark)` re-runs the filtered delta bootstrap from `watermark` (or now).
- Sent backfill: `GET /me/mailFolders/sentitems/messages?$select=conversationId,toRecipients,ccRecipients,bccRecipients,sentDateTime&$top=100&$orderby=sentDateTime desc`.
- Actions: `$batch` (max 20) of `POST /me/messages/{id}/move` with `destinationId` = `"deleteditems"` (trash), `archiveFolderId` (archive), `"inbox"` (restore). `newId` = response body `id`.
- Errors: 401 refresh once then `ProviderAuthError`; 429 `ProviderRateLimitError` honoring `Retry-After` seconds; 503/504 `ProviderUnavailableError`.

### 4.4 Tokens and OAuth (`providers/token.ts`, `providers/oauth.ts`, `providers/*/oauth.ts`)

```ts
// providers/token.ts
export interface TokenSource {
  /** Valid access token; refreshes when fewer than ACCESS_TOKEN_MIN_TTL_MS remain. */
  getAccessToken(): Promise<string>;
  /** Refresh unconditionally (after a 401). */
  forceRefresh(): Promise<string>;
}

/**
 * Rev 2.2: the single TokenUpdate (7.15). What a token source hands back for re-encryption and persistence.
 * Exported from @clearbox/core; the worker (plans 03 and 04) imports it and never redeclares it.
 */
export interface TokenUpdate {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  /** Non-null when the provider returned a new refresh token (Microsoft rotation). */
  refreshToken: string | null;
}

// providers/oauth.ts: OAuthClientConfig, AuthorizeParams and the scope constants (plan 01; plan 02 appends the shell
// functions). OAuthTokens lives in providers/token.ts with TokenSource and TokenUpdate.

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Exact redirect URI: `${origin}/oauth/google/callback` or `${origin}/oauth/microsoft/callback`. */
  redirectUri: string;
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

export interface AuthorizeParams { state: string; codeChallenge: string; loginHint?: string }

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"] as const;
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"] as const;

// Google (providers/google/oauth.ts)
export declare function buildGoogleAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string; // access_type=offline, prompt=consent, S256
export declare function exchangeGoogleCode(f: FetchLike, cfg: OAuthClientConfig, code: string, codeVerifier: string, now: number): Promise<OAuthTokens>;
export declare function refreshGoogleToken(f: FetchLike, cfg: OAuthClientConfig, refreshToken: string, now: number): Promise<OAuthTokens>;
export declare function revokeGoogleToken(f: FetchLike, token: string): Promise<boolean>;
export declare function hasGmailScope(granted: readonly string[]): boolean;

// Microsoft (providers/microsoft/oauth.ts), tenant "common", response_mode=query, prompt=select_account
export declare function buildMicrosoftAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string;
export declare function exchangeMicrosoftCode(f: FetchLike, cfg: OAuthClientConfig, code: string, codeVerifier: string, now: number): Promise<OAuthTokens>;
export declare function refreshMicrosoftToken(f: FetchLike, cfg: OAuthClientConfig, refreshToken: string, now: number): Promise<OAuthTokens>;
/** Case-insensitive; accepts "Mail.ReadWrite" with or without the https://graph.microsoft.com/ prefix. */
export declare function hasGraphScopes(granted: readonly string[]): boolean;
/** Microsoft has no revoke endpoint for these scopes; Disconnect shows these links. */
export const MICROSOFT_CONSENT_URLS = {
  personal: "https://account.live.com/consent/Manage",
  work: "https://myapps.microsoft.com",
} as const;
```

OAuth error classification (both providers, in `providers/*/oauth.ts`):

| Response | Thrown |
|---|---|
| `error = invalid_grant` (incl. `error_subtype = invalid_rapt`), `interaction_required`, `consent_required`; AADSTS 70008, 700082, 50173, 70000, 70043, 50076, 50079, 50078, 53003, 65001 | `ProviderAuthError` (account `needs_reauth`) |
| `error = invalid_client`, `unauthorized_client`, `deleted_client`; AADSTS 7000215, 7000222, 700016, 50194, 50011 | `ProviderConfigError` (account `config_error`, app issue `<provider>_client_invalid`) |
| AADSTS 90094 (admin consent required) | `ProviderAuthError("admin_consent_required")` |
| `temporarily_unavailable`, 5xx, network | `ProviderUnavailableError` |

### 4.5 Signals (`signals/signals.ts`)

```ts
import type { PriorCounts } from "../priors/priors.ts";

export interface SenderHistory {
  /** Messages from this sender already stored (senders table), excluding the current page. */
  seenCount: number;
  readCount: number;
  isCorrespondent: boolean;
  senderPrior: PriorCounts | null;
  domainPrior: PriorCounts | null;
}

export interface SignalContext {
  now: number;
  /** Lowercased primary address + aliases. */
  ownerAddresses: readonly string[];
  /** Thread ids (Gmail) / conversation ids (Graph) the owner has sent in. */
  repliedThreadIds: ReadonlySet<string>;
}

export interface Signals {
  senderAddress: string;        // "" when unknown
  senderDomain: string;         // registrable domain, "" when unknown
  senderName: string | null;
  senderKnown: boolean;         // address parsed
  ownerReplied: boolean;
  isCorrespondent: boolean;
  senderSeenCount: number;      // includes earlier messages on the same page
  senderOpenRate: number | null;   // readCount / seenCount, null when seenCount = 0
  ownerDeleteRate: number | null;  // senderPrior deletes / (deletes + keeps), null when no decisions
  ownerDecisions: number;          // senderPrior deletes + keeps
  hasListUnsubscribe: boolean;
  oneClickUnsubscribe: boolean;    // List-Unsubscribe-Post === "List-Unsubscribe=One-Click" and an https URI
  hasListId: boolean;
  precedenceBulk: boolean;         // bulk | list | junk
  autoSubmitted: boolean;          // any value except "no"
  espDomain: string | null;        // registrable domain of Return-Path, null for "<>" or missing
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
  category: MailCategory | null;
  starred: boolean;
  providerImportant: boolean;
  ageDays: number;                 // floor((now - receivedAt) / 86_400_000), min 0
  isRead: boolean;
  hasAttachments: boolean;
  attachmentsApprox: boolean;
  threadDepth: number | null;
  ownerPosition: OwnerPosition;    // "to" if any owner address in To (or Delivered-To when To lacks it), "cc" if in Cc, else "bcc_or_list"
}

export declare function extractSignals(msg: MailMessage, history: SenderHistory, ctx: SignalContext): Signals;
```

`signals_json` in D1 is `JSON.stringify(signals)` (no subject or snippet inside).

### 4.6 Policy (`policy/policy.ts`)

```ts
import { z } from "zod";

/** "user@example.com" or "@example.com" (whole domain, including subdomains). Lowercased, trimmed. */
export const SenderEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^(@|[^@\s]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "expected user@domain or @domain");

export const PolicySchema = z
  .object({
    allowlist: z.array(SenderEntrySchema).max(1000),
    denylist: z.array(SenderEntrySchema).max(1000),
    minAgeDays: z.int().min(0).max(365),
    storeSnippets: z.boolean(),
    labelSubjects: z.boolean(),
    recordPatterns: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(100),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  allowlist: [],
  denylist: [],
  minAgeDays: 3,
  storeSnippets: true,
  labelSubjects: true,
  recordPatterns: ["receipt", "invoice", "tax", "statement", "contract", "medical", "legal"],
};

/** Parses stored JSON; returns DEFAULT_POLICY when input is null; throws ZodError when invalid. */
export declare function parsePolicy(json: string | null): Policy;

/** True when address equals an entry, or an "@domain" entry equals the domain or is a parent domain of it. */
export declare function matchesSenderList(address: string, domain: string, list: readonly string[]): boolean;

/** Case-insensitive whole-word match of any pattern in subject + " " + snippet; returns the first match or null. */
export declare function matchRecordPattern(subject: string, snippet: string, patterns: readonly string[]): string | null;
```

### 4.7 Guardrails (`guardrails/guardrails.ts`)

```ts
export interface GuardrailInput {
  signals: Signals;
  subject: string;
  snippet: string;
}

export interface GuardrailResult {
  ceiling: Ceiling;
  /** Reasons for every cap that lowered the ceiling below "delete", in rule order. */
  reasons: Reason[];
  allowlisted: boolean;
  denylisted: boolean;
}

export declare function evaluateGuardrails(input: GuardrailInput, policy: Policy): GuardrailResult;
```

Rules, evaluated in this order; `ceiling` starts at `delete` and each matching rule applies `minCeiling`:

| # | Condition | Cap | Reason code | Skipped when denylisted |
|---|---|---|---|---|
| 1 | `signals.starred` | keep | `guard_starred` | no |
| 2 | `signals.ownerReplied` | keep | `guard_replied` | no |
| 3 | sender matches `policy.allowlist` | keep | `guard_allowlist` | no (allowlist beats denylist) |
| 4 | `signals.ageDays < policy.minAgeDays` | keep | `guard_too_recent` | no |
| 5 | `signals.isCorrespondent` | keep | `guard_correspondent` | yes |
| 6 | `signals.hasAttachments` | archive | `guard_attachment` | yes |
| 7 | `matchRecordPattern(...)` not null | archive | `guard_record_pattern` | yes |

`denylisted` = sender matches `policy.denylist` and not allowlisted; when true, add reason `deny_listed` (informational, not a cap). `providerImportant` is never a guardrail (Gmail IMPORTANT is automatic, Graph importance is sender-set).

### 4.8 Priors (`priors/priors.ts`)

```ts
export interface PriorCounts {
  deletes: number;   // owner chose delete
  keeps: number;     // owner chose archive or keep (not delete)
}

export interface Prior {
  source: "sender" | "domain" | "none";
  key: string | null;  // "user@example.com" or "@example.com"
  alpha: number;       // 1 + deletes
  beta: number;        // 1 + keeps
  n: number;           // alpha + beta - 2
  pDelete: number;     // alpha / (alpha + beta)
}

export const priorKeyForSender = (address: string): string => address;
export const priorKeyForDomain = (domain: string): string => `@${domain}`;

/** Sender prior when its n >= PRIOR_MIN_N, else domain prior when present, else sender prior (possibly n = 0), else "none" (alpha = beta = 1). */
export declare function selectPrior(sender: PriorCounts | null, domain: PriorCounts | null, address: string, domainName: string): Prior;

/** Delta to apply to both the sender key and the domain key for one owner action (undo passes the inverse). */
export declare function priorDelta(ownerAction: ActionKind, direction: 1 | -1): PriorCounts;
```

### 4.9 Decision-1 (`decision/*.ts`)

#### 4.9.1 State

```ts
export interface PastDecision {
  domain: string;
  subject: string;          // truncated to 60 chars, "" when labels have no subject
  owner_action: ActionKind;
}

/** Exactly the JSON object sent as `state`. Compact JSON, no indentation. */
export interface DecisionState {
  email: {
    from: string;           // sender address ("unknown" when not parseable)
    domain: string;
    subject: string;        // <= DECISION_SUBJECT_MAX_CHARS
    snippet: string;        // <= DECISION_SNIPPET_MAX_CHARS
    age_days: number;
    signals: {
      has_list_unsubscribe: boolean;
      precedence_bulk: boolean;
      auto_submitted: boolean;
      category: MailCategory | null;
      is_read: boolean;
      has_attachments: boolean;
      owner_position: OwnerPosition;
      thread_depth: number | null;
      provider_important: boolean;
      auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    };
  };
  sender_history: {
    messages_seen: number;
    open_rate: number | null;          // rounded to 2 decimals
    owner_delete_rate: number | null;  // rounded to 2 decimals
    owner_decisions: number;
    is_correspondent: boolean;
  };
  similar_past_decisions: PastDecision[]; // <= 5: same sender first, then same domain, newest first
}

export interface BuildStateInput {
  msg: MailMessage;
  signals: Signals;
  pastDecisions: PastDecision[];
}

/**
 * Token budget: JSON.stringify(state).length <= DECISION_STATE_MAX_CHARS (1,750 chars = 500 tokens at 3.5 chars/token).
 * Shrink order until it fits: drop similar_past_decisions from the end one by one,
 * then snippet to 150 chars, then snippet to "", then subject to 60 chars.
 */
export declare function buildDecisionState(input: BuildStateInput): DecisionState;
```

#### 4.9.2 Questions and request

```ts
export interface ChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface ScoreQuestion { type: "score"; instructions: string; criteria: string[] }
export interface NoulQuestion { type: "noul"; instructions: string }

export interface DecisionQuestions {
  action: ChoiceQuestion;     // keys delete, archive, keep, unsure; key ORDER shuffled per request
  importance: ScoreQuestion;  // ["Noise", "Low", "Moderate", "High", "Critical"], ascending, never shuffled
  is_record: NoulQuestion;
  is_expired: NoulQuestion;
  is_from_human: NoulQuestion;
}

export interface DecisionRequestBody {
  model: string;              // deployment name; NO other top-level fields
  state: DecisionState;
  questions: DecisionQuestions;
}

/** Texts are fixed in questions.ts and equal the spec 6.3 wording. */
export declare function buildDecisionQuestions(seed: number): DecisionQuestions;
export declare function buildDecisionRequest(state: DecisionState, deployment: string, seed: number): DecisionRequestBody;

/** seed = fnv1a32(`${accountId}:${providerMessageId}`); retries reuse the same order. */
export declare function decisionSeed(accountId: string, providerMessageId: string): number;
```

#### 4.9.3 Response validation (`decision/response.ts`)

```ts
import { z } from "zod";

const prob = z.number().finite().min(0).max(1);
const sumsToOne = (r: Record<string, number>) => Math.abs(Object.values(r).reduce((s, p) => s + p, 0) - 1) <= 0.01;

export const ChoiceAnswerSchema = z.looseObject({
  type: z.literal("choice"),
  choice: z.enum(["delete", "archive", "keep", "unsure"]),
  confidence: prob.optional(),
  probabilities: z.strictObject({ delete: prob, archive: prob, keep: prob, unsure: prob }).refine(sumsToOne),
});

export const ScoreAnswerSchema = z.looseObject({
  type: z.literal("score"),
  score: z.number().finite().min(0).max(4),
  confidence: prob.optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.enum(["0", "1", "2", "3", "4"]), prob).optional(),
});

export const NoulAnswerSchema = z.looseObject({ type: z.literal("noul"), noul: prob });

export const DecisionResponseSchema = z.looseObject({
  model: z.string().min(1),
  answers: z.looseObject({
    action: ChoiceAnswerSchema,
    importance: ScoreAnswerSchema,
    is_record: NoulAnswerSchema,
    is_expired: NoulAnswerSchema,
    is_from_human: NoulAnswerSchema,
  }),
  usage: z.looseObject({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative().optional() }),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
```

`confidence` is never used. An unknown answer `type` (for example a refusal) fails validation, which maps to `DecisionError("invalid_response")`.

#### 4.9.4 Engine

```ts
export interface DecisionFlags { isRecord: number; isExpired: number; isFromHuman: number }

export interface DecisionResult {
  /** From answers.action.probabilities, renormalized to sum exactly 1. */
  action: ActionDistribution;
  /** answers.importance.score, 0..4. */
  importance: number;
  flags: DecisionFlags;
  responseModel: string;       // e.g. "microsoft-decision-1"
  modelVersion: string;        // `${deployment}/${responseModel}`; FakeEngine: "fake/fake-1"
  inputTokens: number;
  requestId: string | null;    // apim-request-id header
  latencyMs: number;
}

export interface DecisionInput {
  /** Correlation key, e.g. providerMessageId. */
  key: string;
  state: DecisionState;
  seed: number;
}

export interface DecisionEngine {
  readonly name: "mai" | "fake";
  /** Throws DecisionError. Never retries internally (retries happen on a later tick). */
  decide(input: DecisionInput): Promise<DecisionResult>;
}

export interface MaiEngineConfig {
  endpoint: string;            // AZURE_DECISION_ENDPOINT
  deployment: string;          // AZURE_DECISION_DEPLOYMENT
  apiKey: string;              // AZURE_DECISION_KEY
  fetch: FetchLike;
  timeoutMs?: number;          // default DECISION_TIMEOUT_MS
  now?: () => number;
}

/** POST `${endpoint}/providers/microsoft/v1/systemone`, headers `api-key`, `content-type: application/json`. No api-version. */
export declare class MaiDecisionEngine implements DecisionEngine {
  readonly name: "mai";
  constructor(config: MaiEngineConfig);
  decide(input: DecisionInput): Promise<DecisionResult>;
}

export interface FakeEngineOptions {
  /** Per-key canned results or errors; anything else uses the built-in rules below. */
  overrides?: ReadonlyMap<string, DecisionResult | DecisionError>;
}

export declare class FakeEngine implements DecisionEngine {
  readonly name: "fake";
  constructor(options?: FakeEngineOptions);
  readonly calls: DecisionInput[];   // recorded inputs, for assertions
  decide(input: DecisionInput): Promise<DecisionResult>;
}

export type DecisionOutcome =
  | { key: string; ok: true; result: DecisionResult }
  | { key: string; ok: false; error: DecisionError };

/** Runs at most `concurrency` decide() calls at once; never rejects; preserves input order. */
export declare function decideAll(engine: DecisionEngine, inputs: readonly DecisionInput[], concurrency: number): Promise<DecisionOutcome[]>;
```

FakeEngine built-in rules (first match wins; flags and importance computed independently):

| Condition on `state` | action distribution (delete, archive, keep, unsure) |
|---|---|
| `sender_history.is_correspondent` | 0.02, 0.08, 0.85, 0.05 |
| subject matches `/receipt\|invoice\|order\|statement/i` | 0.05, 0.80, 0.10, 0.05 |
| `signals.has_list_unsubscribe && !signals.is_read` | 0.90, 0.04, 0.03, 0.03 |
| `signals.has_list_unsubscribe` | 0.60, 0.20, 0.10, 0.10 |
| otherwise | 0.15, 0.20, 0.30, 0.35 |

Flags: `isRecord` 0.90 if subject matches `/receipt|invoice|statement|order/i` else 0.05; `isExpired` 0.90 if subject matches `/expire|ends tonight|last chance|one-time code/i` else 0.10; `isFromHuman` 0.90 if `is_correspondent` else 0.05. `importance` 3 if `is_correspondent`, else 1 if subject matches the record regex, else 0.5. `inputTokens = Math.ceil(JSON.stringify(state).length / 3.5) + 250`, `latencyMs = 0`, `requestId = null`.

### 4.10 Fusion (`fusion/fusion.ts`)

```ts
export interface Thresholds {
  tauDelete: number;      // from settings, [TAU_DELETE_MIN, TAU_DELETE_MAX], default TAU_DELETE_DEFAULT
  deleteMargin: number;   // DELETE_MARGIN
  minConfidence: number;  // MIN_CONFIDENCE
}

export interface FusionInput {
  /** null when the model failed permanently for this message. */
  model: DecisionResult | null;
  prior: Prior;
  guard: GuardrailResult;
  signals: Signals;
  thresholds: Thresholds;
}

export interface Suggestion {
  action: SuggestedAction;
  /** distribution[action] after all steps; for model failure: 0. */
  confidence: number;
  /** Final distribution after prior, flags and ceiling folding; null when model is null. */
  distribution: ActionDistribution | null;
  /** Raw model P(delete); null when model is null. */
  modelDelete: number | null;
  /** distribution.delete minus the largest other entry; null when model is null. */
  margin: number | null;
  ceiling: Ceiling;
  ceilingApplied: boolean;
  importance: number | null;
  flags: DecisionFlags | null;
  reasons: Reason[];          // 0..3 entries, selection in 5.2
}

export declare function fuse(input: FusionInput): Suggestion;
```

### 4.11 Reasons (`model/reasons.ts`)

```ts
export const REASON_CODES = [
  "guard_starred", "guard_replied", "guard_allowlist", "guard_too_recent", "guard_correspondent",
  "guard_attachment", "guard_record_pattern", "deny_listed",
  "prior_sender_deleted", "prior_sender_kept", "prior_domain_deleted", "prior_domain_kept",
  "low_open_rate", "list_unsubscribe", "bulk_mail", "auto_sent", "category",
  "flag_expired", "flag_record", "flag_human", "old_unread", "auth_failed", "model_important",
  "model_unavailable", "low_confidence",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonParams = Readonly<Record<string, string | number>>;
export interface Reason { code: ReasonCode; params: ReasonParams }

/** English templates; {name} placeholders are replaced by params. No em dashes. */
export const REASON_TEMPLATES: Readonly<Record<ReasonCode, string>> = {
  guard_starred: "You starred or flagged this email",
  guard_replied: "You replied in this conversation",
  guard_allowlist: "Sender is on your keep list",
  guard_too_recent: "Received less than {minAgeDays} days ago",
  guard_correspondent: "You have written to this sender",
  guard_attachment: "Has attachments",
  guard_record_pattern: "Looks like a record ({pattern})",
  deny_listed: "Sender is on your delete list",
  prior_sender_deleted: "You deleted {deletes} of {total} from this sender",
  prior_sender_kept: "You kept {keeps} of {total} from this sender",
  prior_domain_deleted: "You deleted {deletes} of {total} from {domain}",
  prior_domain_kept: "You kept {keeps} of {total} from {domain}",
  low_open_rate: "Opened {openPct}% of {seen} emails from this sender",
  list_unsubscribe: "Has an unsubscribe link",
  bulk_mail: "Sent as bulk mail",
  auto_sent: "Sent automatically",
  category: "Filed under {category}",
  flag_expired: "Looks expired or time-bound",
  flag_record: "Looks like a record worth keeping",
  flag_human: "Looks personally written",
  old_unread: "Unread for {ageDays} days",
  auth_failed: "Failed sender authentication ({method})",
  model_important: "Rated {level} importance",
  model_unavailable: "Model unavailable, needs your review",
  low_confidence: "Not confident enough to suggest an action",
};

export declare function renderReason(reason: Reason): string;
```

### 4.12 Errors (`model/errors.ts`)

```ts
export class ClearboxError extends Error {
  readonly code: string;
  constructor(code: string, message?: string, options?: { cause?: unknown });
}

/** Refresh token invalid or user interaction required. Account -> needs_reauth. */
export class ProviderAuthError extends ClearboxError {
  readonly provider: ProviderKind;
  /** e.g. "invalid_grant", "interaction_required", "unauthorized", "domain_policy", "admin_consent_required", "AADSTS70008". */
  readonly reason: string;
}

/** Owner configuration problem (client id/secret wrong or expired). Account -> config_error; app issue raised. */
export class ProviderConfigError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly reason: string; // "invalid_client", "unauthorized_client", "deleted_client", "AADSTS7000222", ...
}

export class ProviderRateLimitError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly retryAfterMs: number; // from Retry-After, else backoffMs(attempt)
}

export class ProviderUnavailableError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly retryAfterMs: number | null;
}

/** Incremental cursor expired (Gmail history 404, Graph syncStateNotFound / 410) or backfill page token rejected (400). */
export class CursorExpiredError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly cursorKind: "backfill" | "sent" | "incremental";
}

/** Unexpected status or response shape. Not retryable within the tick; counts as a tick failure. */
export class ProviderResponseError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly status: number;
}

/** Thrown by countingFetch when a tick or request would exceed its subrequest limit. */
export class SubrequestBudgetError extends ClearboxError {
  readonly used: number;
  readonly limit: number;
}

/** Connect flow: granted scopes do not include the required scope. */
export class ScopeMissingError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly granted: string[];
}

export type DecisionErrorKind =
  | "auth"                 // 401, 403          scope config, not retryable
  | "deployment_not_found" // 404              scope config, not retryable
  | "bad_request"          // 400              scope item,   not retryable
  | "too_large"            // 413              scope item,   not retryable
  | "unprocessable"        // 422              scope item,   not retryable
  | "invalid_response"     // zod failure      scope item,   not retryable
  | "rate_limited"         // 429              scope item,   retryable
  | "server"               // 408, 500-504     scope item,   retryable
  | "timeout"              // > timeoutMs      scope item,   retryable
  | "network";             // fetch threw      scope item,   retryable

export class DecisionError extends ClearboxError {
  readonly kind: DecisionErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  /** "config": stop the tick and raise an app issue; "item": affects this message only. */
  readonly scope: "config" | "item";
  readonly retryAfterMs: number | null; // retry-after-ms, then retry-after, else null
  readonly requestId: string | null;
}
```

Constructors take a single options object matching the readonly fields plus `message?` and `cause?`. Error messages never contain email content, tokens or response bodies.

### 4.13 Constants (`model/constants.ts`)

```ts
// Fusion (spec 6.4)
export const PRIOR_MIN_N = 3;
export const PRIOR_LAMBDA_K = 5;
export const FLAG_THRESHOLD = 0.7;
export const RECORD_SHIFT = 0.5;
export const HUMAN_SHIFT = 0.5;
export const EXPIRED_SHIFT = 0.3;
export const EXPIRED_HUMAN_MAX = 0.5;
export const DELETE_MARGIN = 0.2;
export const MIN_CONFIDENCE = 0.55;
export const MAX_REASONS = 3;

// Calibration (spec 6.5)
export const TAU_DELETE_DEFAULT = 0.8;
export const TAU_DELETE_MIN = 0.8;
export const TAU_DELETE_MAX = 0.99;
export const TAU_STEP = 0.01;
export const CALIBRATION_WINDOW = 500;
export const CALIBRATION_MIN_DELETE_SUGGESTIONS = 50;
export const CALIBRATION_MIN_SUPPORT = 20;
export const CALIBRATION_TARGET_PRECISION = 0.98;

// Decision-1
export const DECISION_TIMEOUT_MS = 10_000;
export const DECISION_CONCURRENCY = 4;
export const DECISION_MAX_ATTEMPTS = 3;
export const DECISION_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const; // after attempt 1, after attempt 2
export const DECISION_STATE_MAX_CHARS = 1_750;
export const DECISION_SUBJECT_MAX_CHARS = 120;
export const DECISION_SNIPPET_MAX_CHARS = 300;
export const PAST_DECISIONS_MAX = 5;
export const PAST_DECISION_SUBJECT_MAX_CHARS = 60;
export const CHARS_PER_TOKEN_JSON = 3.5;
export const DECISION_TOKEN_TARGET = 800;

// Tick and providers
export const PAGE_SIZE_FREE = 25;
export const PAGE_SIZE_PAID = 100;
export const PAGE_SIZE_MIN = 5;
export const SENT_PAGE_SIZE = 100;
export const SENT_BACKFILL_MAX_MESSAGES = 1_000;
export const POLL_INTERVAL_MS = 30 * 60_000;
export const LEASE_TTL_MS = 5 * 60_000;
export const ACCESS_TOKEN_MIN_TTL_MS = 5 * 60_000;
export const TICK_SUBREQUEST_LIMIT = 45;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const DECISION_FAILURE_ABORT_RATIO = 0.5;

// D1 budget (Free: 100,000 rows written per day)
export const D1_DAILY_WRITE_LIMIT = 100_000;
export const BUDGET_ROWS_PER_DAY = 90_000;   // 90% cap for everything
export const INGEST_STOP_ROWS = 65_000;      // ticks are not claimed at or above this
export const PURGE_STOP_ROWS = 80_000;       // nightly purge stops at or above this
export const STORAGE_SOFT_LIMIT_BYTES = 450_000_000; // of 500 MB per D1 database on Free

// Retention
export const PENDING_TTL_MS = 90 * 86_400_000;
export const DECIDED_TTL_MS = 30 * 86_400_000;
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;
export const BATCH_RETENTION_MS = 7 * 86_400_000;
export const STALE_APPROVED_MS = 10 * 60_000;

// Owner actions
export const MAX_ITEMS_PER_ACTION_REQUEST = 100;
export const LABEL_SUBJECT_MAX_CHARS = 60;
export const MESSAGE_SUBJECT_MAX_CHARS = 200;
```

### 4.14 Calibration (`calibration/calibration.ts`)

```ts
export interface CalibrationSample {
  pDelete: number | null;   // labels.p_delete (fused, after ceiling)
  margin: number | null;    // labels.margin
  ceiling: Ceiling;
  ownerAction: ActionKind;
}

export interface CalibrationPoint { tau: number; support: number; precision: number | null }

export interface CalibrationResult {
  tauDelete: number;
  changed: boolean;
  outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target";
  deleteSuggestions: number;   // support at TAU_DELETE_MIN
  precisionAtTau: number | null;
  points: CalibrationPoint[];  // every tau evaluated, ascending
}

export declare function calibrateTauDelete(samples: readonly CalibrationSample[], currentTau: number): CalibrationResult;
```

### 4.15 HTTP utilities (`http/fetch.ts`, `util/*.ts`)

```ts
export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface SubrequestCounter {
  readonly used: number;
  readonly limit: number;
  /** Throws SubrequestBudgetError (extends ClearboxError, code "subrequest_budget") when used + n > limit. */
  reserve(n?: number): void;
}

export declare function createSubrequestCounter(limit: number, alreadyUsed?: number): SubrequestCounter;
/** Wraps fetch: every call reserves 1 from the counter first. */
export declare function countingFetch(base: FetchLike, counter: SubrequestCounter): FetchLike;
/** Retry-After: delta-seconds or HTTP date; also accepts retry-after-ms. Returns ms or null. */
export declare function parseRetryAfter(headers: Headers, now: number): number | null;
/** min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^(attempt-1)) + jitter(0..1000 ms); attempt >= 1. */
export declare function backoffMs(attempt: number, random?: () => number): number;

export declare function fnv1a32(text: string): number;
export declare function mulberry32(seed: number): () => number;
export declare function seededShuffle<T>(items: readonly T[], seed: number): T[];
export declare function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
```

---

## 5. Fusion and calibration algorithms

### 5.1 `fuse(input)` (spec 6.4, rev 2)

All arithmetic is IEEE double. `ORDER_NON_DELETE = ["keep", "archive", "unsure"]` is the tie-break order (safest first).

```text
function fuse({ model, prior, guard, signals, thresholds }):
  if model is null:
    return {
      action: "unsure", confidence: 0, distribution: null, modelDelete: null, margin: null,
      ceiling: guard.ceiling, ceilingApplied: false, importance: null, flags: null,
      reasons: selectReasons(...)            // starts with model_unavailable
    }

  m = model.action                           // renormalized, sums to 1

  # 1. Prior (selected by selectPrior: sender if n >= 3, else domain, else none with n = 0)
  lambda = prior.n / (prior.n + PRIOR_LAMBDA_K)          # 0 when n = 0

  # 2. Blend
  d = (1 - lambda) * m.delete + lambda * prior.pDelete

  # 3. Rebuild the distribution
  v.delete = d
  if m.delete < 1:
    scale = (1 - d) / (1 - m.delete)
    v.archive = m.archive * scale ; v.keep = m.keep * scale ; v.unsure = m.unsure * scale
  else:
    v.archive = 0 ; v.keep = 0 ; v.unsure = 1 - d

  # 4. Flag shifts, in this order; each moves mass between two entries
  f = model.flags
  if f.isRecord    >= FLAG_THRESHOLD: move(v, from "delete",  to "archive", amount 0.5 * v.delete)
  if f.isFromHuman >= FLAG_THRESHOLD: move(v, from "delete",  to "keep",    amount 0.5 * v.delete)
  if f.isExpired   >= FLAG_THRESHOLD and f.isFromHuman < EXPIRED_HUMAN_MAX:
                                      move(v, from "archive", to "delete",  amount 0.3 * v.archive)
  v = clampAndRenormalize(v)        # clamp each to [0,1], divide by the sum (guards float drift)

  # 5. Ceiling: fold mass of disallowed actions into the ceiling action
  unbounded = choose(v, thresholds)
  w = copy(v)
  for x in ["delete", "archive"]:
    if ACTION_RANK[x] > ACTION_RANK[guard.ceiling]:
      w[guard.ceiling] += w[x] ; w[x] = 0

  # 6. Thresholds
  chosen = choose(w, thresholds)
  ceilingApplied = not isAllowedByCeiling(unbounded.action, guard.ceiling)

  return {
    action: chosen.action, confidence: chosen.confidence, distribution: w,
    modelDelete: m.delete, margin: w.delete - max(w.archive, w.keep, w.unsure),
    ceiling: guard.ceiling, ceilingApplied, importance: model.importance, flags: f,
    reasons: selectReasons(...)       # 5.2
  }

function choose(dist, th):
  nextBest = max(dist.archive, dist.keep, dist.unsure)
  if dist.delete >= th.tauDelete and dist.delete - nextBest >= th.deleteMargin:
    return { action: "delete", confidence: dist.delete, lowConfidence: false }
  best = argmax of dist over ORDER_NON_DELETE (first wins on ties)
  if dist[best] < th.minConfidence:
    return { action: "unsure", confidence: dist.unsure, lowConfidence: true }
  return { action: best, confidence: dist[best], lowConfidence: false }
```

Edge cases (each needs a unit test):

| Case | Expected |
|---|---|
| No prior at all (`source = "none"`) | `lambda = 0`, `v = m` before flags |
| `m.delete = 1` | `v = {delete: d, unsure: 1 - d, archive: 0, keep: 0}` |
| `m.delete = 1` and `lambda = 0` | `v.unsure = 0`; delete if `1 >= tau` and margin `1 >= 0.20` |
| Sender `n = 2`, domain `n = 10` | domain prior used, `lambda = 10/15` |
| Sender `n = 2`, no domain prior | sender prior used with `lambda = 2/7` |
| Ceiling `keep` | archive and delete mass fold into keep; action `keep` unless keep mass `< 0.55` (then `unsure`) |
| Ceiling `archive`, model says delete 0.95 | delete mass folds into archive, action `archive`, `ceilingApplied = true` |
| `delete = 0.79`, `keep = 0.15`, tau 0.80 | not delete; best non-delete 0.15 < 0.55, so `unsure` with `lowConfidence` |
| `delete = 0.58`, `archive = 0.40`, tau 0.80 | below tau; archive 0.40 < 0.55, so `unsure` |
| `delete = 0.90`, `archive = 0.08`, tau 0.80 | margin 0.82 >= 0.20, so `delete` with confidence 0.90 |
| Tie `keep = archive = 0.5` | `keep` (tie-break), but 0.5 < 0.55 so `unsure` |
| Flags shift `delete` below tau | not delete |
| Model null | `unsure`, confidence 0, distribution null |

### 5.2 `selectReasons`

Collect candidates in this priority order, skip duplicates, keep the first `MAX_REASONS` (3):

1. `model_unavailable` when `model` is null.
2. Guardrail reasons (`guard.reasons`, rule order) when `ceilingApplied`, or when the action is `keep`/`archive` and `guard.ceiling !== "delete"`.
3. `deny_listed` when `guard.denylisted` and the action is `delete`.
4. `low_confidence` when `choose` returned `lowConfidence`.
5. Prior reason when `prior.n >= PRIOR_MIN_N`: if the action is `delete` or `prior.pDelete >= 0.5`, `prior_<source>_deleted {deletes: alpha - 1, total: n, domain}`; else `prior_<source>_kept {keeps: beta - 1, total: n, domain}`.
6. Signal reasons, by action:
   - `delete`, `unsure`: `flag_expired` (isExpired >= 0.7), `low_open_rate` (seenCount >= 5 and openRate <= 0.1; `openPct = round(openRate * 100)`), `list_unsubscribe`, `bulk_mail`, `auto_sent`, `category` (promotions, social, updates or forums; param is the capitalized name), `old_unread` (not read and ageDays >= 30), `auth_failed` (method = "DMARC" if dmarc fail, else "SPF" or "DKIM").
   - `archive`: `flag_record` (isRecord >= 0.7), then the `delete` list.
   - `keep`: `flag_human` (isFromHuman >= 0.7), `model_important` (importance >= 3; `level` = legend label at `round(importance)`).

Reasons are stored as codes plus params (`reasons_json`) and rendered with `renderReason` by the API.

### 5.3 `calibrateTauDelete(samples, currentTau)` (spec 6.5)

`samples` are the newest `CALIBRATION_WINDOW` (500) labels across all accounts, newest first, including labels later corrected by undo (their `ownerAction` is the corrected value).

```text
function calibrateTauDelete(samples, currentTau):
  base = samples where pDelete is not null and margin is not null
  wouldDelete(s, tau) = s.pDelete >= tau and s.margin >= DELETE_MARGIN
  deleteSuggestions = count(base where wouldDelete(s, TAU_DELETE_MIN))

  if deleteSuggestions < CALIBRATION_MIN_DELETE_SUGGESTIONS (50):
    return { tauDelete: currentTau, changed: false, outcome: "insufficient_data",
             deleteSuggestions, precisionAtTau: null, points: [] }

  points = []
  for i in 0 .. 19:
    tau = round2(TAU_DELETE_MIN + i * TAU_STEP)            # 0.80, 0.81, ..., 0.99
    S = base where wouldDelete(s, tau)
    support = |S|
    precision = support > 0 ? count(S where ownerAction == "delete") / support : null
    points.push({ tau, support, precision })

  chosen = first p in points (ascending tau) with p.support >= CALIBRATION_MIN_SUPPORT (20)
                                              and p.precision >= CALIBRATION_TARGET_PRECISION (0.98)
  if chosen exists: tau = chosen.tau, outcome = "calibrated", precisionAtTau = chosen.precision
  else:             tau = TAU_DELETE_MAX (0.99), outcome = "no_tau_meets_target",
                    precisionAtTau = points[19].precision
  return { tauDelete: tau, changed: tau != currentTau, outcome, deleteSuggestions, precisionAtTau, points }
```

`tauDelete` is always within `[0.80, 0.99]`. Because `labels.p_delete` is the post-ceiling fused value, suggestions whose ceiling blocked delete have `p_delete = 0` and never count as delete suggestions.

---

## 6. D1 schema

### 6.1 Migration `app/migrations/0001_init.sql` (complete)

D1 enforces foreign keys by default. No `ON DELETE CASCADE` anywhere: large deletes are chunked by the nightly purge (6.5) to stay inside the write budget and the 30 s query limit.

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

Index usage rule: queries over open suggestions filter with `account_id = ?` (or `account_id IN (...)`) **and** `status = 'pending'` or `status = 'awaiting_model'` as an equality, so the planner can use `suggestions_open` (verified with SQLite 3.54 `EXPLAIN QUERY PLAN`: `status = 'pending'` uses the OR-form partial index, while an `IN`-form partial index is skipped unless the query repeats the exact `IN` term). `app/test/worker/db/query-plans.test.ts` asserts `SEARCH ... USING ... INDEX suggestions_open` for the queue, group, cleanup and awaiting-model queries.

Isolation rule: every exported function in `src/worker/db/*.ts` that touches `messages`, `suggestions`, `labels`, `sender_priors`, `senders`, `correspondents` or `sent_threads` takes `accountId: AccountId` (or `accountIds: readonly AccountId[]`) as a parameter and every SQL string on those tables contains `account_id = ?` or `account_id IN (`. `app/test/worker/db-isolation.test.ts` asserts this by scanning the SQL string literals in those files. Exemptions (listed in the test): `src/worker/nightly/*.ts` (purge deletes by `message_id` lists, stale-approval recovery across accounts) and the calibration read of `labels` across accounts.

### 6.2 Status values

| Column | Values | Meaning |
|---|---|---|
| `accounts.status` | `active` | eligible for ticks unless `paused = 1` |
| | `needs_reauth` | `ProviderAuthError`; UI banner "Reconnect" |
| | `config_error` | `ProviderConfigError`; owner must fix client credentials, then Reconnect |
| | `disconnected` | tokens wiped, hidden in UI, rows purged by nightly job, then the row is deleted |
| `accounts.phase` | `sent_backfill` -> `inbox_backfill` -> `incremental` | 8.3 |
| `suggestions.status` | `awaiting_model` | ingested, Decision-1 failed transiently; retried by later ticks; not shown in queue |
| | `pending` | in the review queue |
| | `approved` | claimed by an execute request (transient) |
| | `executed` | owner decision applied (`final_action` delete/archive moved the message; keep is a no-op) |
| | `failed` | provider action failed permanently (`exec_error`) |
| | `dismissed` | message left the inbox outside Clearbox before review |
| | `undone` | executed then restored by undo |

Transitions: `awaiting_model -> pending`; `pending -> approved -> executed | failed | pending` (transient provider error returns it to `pending`); `pending | awaiting_model -> dismissed`; `executed -> undone`. Stale `approved` rows older than `STALE_APPROVED_MS` become `failed` with `exec_error = 'interrupted'` (nightly).

### 6.3 Settings keys

| Key | JSON value | Written by |
|---|---|---|
| `tau_delete` | number in [0.80, 0.99] | migration, nightly calibration |
| `policy` | `Policy` (absent = `DEFAULT_POLICY`) | `PUT /api/policy`, `PATCH /api/policy/senders` |
| `policy_version` | integer, +1 per policy change | same |
| `calibration` | `CalibrationResult` plus `ranAt` (epoch ms) | nightly |
| `issues` | `AppIssue[]` (7.2) | ticks, OAuth, nightly; cleared when the condition clears |
| `nightly` | `{ "ranAt": number, "purgedMessages": number, "purgedAccounts": number, "staleRecovered": number }` | nightly |

### 6.4 Rows written per email (D1 billing: each written row plus one per affected index entry)

| Event | Statement | Rows |
|---|---|---|
| Ingest | `messages` insert: row + `messages_account_provider_id` | 2 |
| | `suggestions` insert: row + `suggestions_open` (partial, open statuses only) | 2 |
| | `senders` upsert (WITHOUT ROWID, no secondary index), about 0.6 per email (distinct senders per page) | 0.6 |
| | Tick overhead amortized over 25: lease claim 1, account claim update 1, account final update 1, lease release 1, budget upsert 1 = 5 per tick | 0.2 |
| | **Ingest total** | **about 4.8** |
| Owner decision | `suggestions` update: row + removal from `suggestions_open` | 2 |
| | `labels` insert: row + 2 indexes | 3 |
| | `sender_priors` upserts (sender key + domain key, aggregated per batch), about 0.3 per email | 0.3 |
| | action batch + audit row, amortized over up to 100 items | about 0.02 |
| | **Decision total** | **about 5.3** |
| Purge (30 days after decision) | `suggestions` delete (row; no partial index entry for decided rows) | 1 |
| | `messages` delete: row + unique index | 2 |
| | **Purge total** | **3** |
| Lifecycle | ingest + decision + purge | **about 13.1** |

Daily budget (Free): `BUDGET_ROWS_PER_DAY = 90,000` (90% of 100,000). Gates: ticks are claimed only while `rows_written < INGEST_STOP_ROWS (65,000)`; the 02:00 UTC purge stops at `PURGE_STOP_ROWS (80,000)`; owner actions are refused with `budget_exhausted` only at `BUDGET_ROWS_PER_DAY`. This guarantees at least 25,000 rows (about 4,700 owner-decided emails) per day for the review session.

Throughput consequences: ticks cap ingestion at 1,440 x 25 = 36,000 emails/day; D1 is the binding limit. Before purges start (first 30 days, owner deciding as they go), ingestion is about 65,000 / 4.8, roughly **13,000 emails/day**. In steady state with purges and owner decisions, sustained throughput is about 90,000 / 13.1, roughly **6,800 emails/day**. Idle overhead is negligible: an account that is caught up is ticked only every `POLL_INTERVAL_MS` (30 min), and a minute with no due account writes nothing.

Storage: each tick records `meta.size_after` into `budget.db_size_bytes`; backfill (not incremental) pauses when it reaches `STORAGE_SOFT_LIMIT_BYTES` (450 MB of the 500 MB per-database Free limit) and raises issue `storage_near_limit`.

### 6.5 Retention and purge

- `suggestions.expires_at` = `created_at + PENDING_TTL_MS` (90 days) at insert; set to `decided_at + DECIDED_TTL_MS` (30 days) on any owner decision, and to `now + DECIDED_TTL_MS` on `dismissed`.
- Nightly purge deletes `suggestions` and their `messages` where `suggestions.expires_at < now`, in chunks (8.6).
- `labels`, `sender_priors`, `senders`, `correspondents`, `sent_threads`, `audit_log` are kept while the account exists. `action_batches` older than `BATCH_RETENTION_MS` (7 days) are deleted.
- Disconnected accounts: all account-owned rows are deleted in chunks by the nightly purge, then the `accounts` row; audit rows remain.

---

## 7. REST API contract

All types and zod schemas in this section live in `app/src/shared/api.ts` and are imported by both `src/worker/routes/*` and `src/web/api/*`. The web bundle imports only types plus the small zod schemas it reuses for forms.

### 7.1 Authentication, CSRF, headers

Middleware order in `createApp()`: `secureHeaders` -> `accessGuard` (all `/api/*` and `/oauth/*`) -> `csrfGuard` (mutating `/api/*`) -> routes -> `notFound` (`404 not_found` envelope) -> `onError` (`500 internal`, no stack in body).

`accessGuard`:

1. `cfg = readConfig(env)`; invalid -> `500 access_misconfigured`.
2. Dev bypass: if `ENVIRONMENT === "development"` and `DEV_AUTH_BYPASS === "true"` and `new URL(req.url).hostname` is `localhost` or `127.0.0.1`, the identity is `OWNER_EMAIL`; skip JWT. If `DEV_AUTH_BYPASS === "true"` in any other environment -> `500 access_misconfigured` (fail closed).
3. Token from header `Cf-Access-Jwt-Assertion` only (never the cookie); missing -> `401 unauthenticated`.
4. `jwtVerify(token, createRemoteJWKSet(new URL(`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)), { issuer: ACCESS_TEAM_DOMAIN, audience: ACCESS_AUD, algorithms: ["RS256"] })`; the JWKS object is cached in module scope keyed by the team domain. Any failure -> `403 forbidden`.
5. `payload.email` (string, lowercased) must equal `OWNER_EMAIL` lowercased; else `403 forbidden`. Service-token JWTs (no `email`) are rejected.
6. Sets `c.set("ownerEmail", email)`.

`csrfGuard`: for `POST`, `PUT`, `PATCH`, `DELETE` on `/api/*`, header `X-Clearbox-CSRF` must equal `1`; else `403 csrf_required`. No CORS headers are ever sent, so cross-origin scripts cannot add the header. `/oauth/*` routes are `GET` navigations protected by the signed state cookie instead.

All `/api/*` responses: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`. Request bodies over 64 KiB -> `413 payload_too_large`.

### 7.2 Common types

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
```

Pagination: `GET` list routes accept `?cursor=&limit=`; responses are `Page<T>`. `nextCursor = null` means the end. Cursors are only valid for the same filter parameters; a malformed cursor is `400 validation_failed`.

Errors: every non-2xx response body is `ApiErrorBody`. Zod failures map to `400 validation_failed`.

### 7.3 Route index

| Method | Path | Request | Response | Errors (besides 401/403/500) |
|---|---|---|---|---|
| GET | `/api/me` | none | `MeResponse` | |
| GET | `/api/accounts` | none | `AccountsResponse` | |
| PATCH | `/api/accounts/:id` | `PatchAccountBody` | `AccountView` | 404 |
| DELETE | `/api/accounts/:id` | none | `DisconnectResponse` | 404 |
| POST | `/api/accounts/:id/scan` | none | `TickReport` | 404, 409 account_busy, 409 account_inactive, 429 budget_exhausted |
| GET | `/api/queue/summary` | `SummaryQuery` | `QueueSummary` | 400 |
| GET | `/api/groups` | `GroupsQuery` | `Page<SenderGroup>` | 400 |
| GET | `/api/groups/:key` | `PageQuery` | `GroupDetail` | 400, 404 |
| POST | `/api/approve` | `ApproveBody` | `ActionResponse` | 400, 404 (groupKey), 429 budget_exhausted |
| POST | `/api/override` | `OverrideBody` | `ActionResponse` | 400, 429 budget_exhausted |
| GET | `/api/cleanup/preview` | `CleanupPreviewQuery` | `CleanupPreview` | 400 |
| POST | `/api/cleanup` | `CleanupBody` | `ActionResponse` | 400, 429 budget_exhausted |
| GET | `/api/batches` | `PageQuery` | `Page<ActionBatchView>` | 400 |
| POST | `/api/batches/:id/undo` | none | `UndoResponse` | 404, 410 undo_expired, 429 budget_exhausted |
| GET | `/api/activity` | `ActivityQuery` | `Page<ActivityEntry>` | 400 |
| GET | `/api/insights` | none | `Insights` | |
| GET | `/api/policy` | none | `PolicyResponse` | |
| PUT | `/api/policy` | `PutPolicyBody` | `PolicyResponse` | 400, 409 conflict |
| PATCH | `/api/policy/senders` | `PatchSenderBody` | `PolicyResponse` | 400 |
| GET | `/oauth/google/start` | `?loginHint=` | 302 to Google | redirect with `error` |
| GET | `/oauth/google/callback` | provider query | 302 to `/settings/accounts?...` | |
| GET | `/oauth/microsoft/start` | `?loginHint=` | 302 to Microsoft | redirect with `error` |
| GET | `/oauth/microsoft/callback` | provider query | 302 to `/settings/accounts?...` | |

### 7.4 Session

```ts
export interface MeResponse {
  email: string;                         // owner email
  environment: "development" | "test" | "production";
  freeTier: boolean;
  providers: { gmail: boolean; outlook: boolean };   // client id and secret configured
  issues: AppIssue[];
  tauDelete: number;
  serverTime: string;
}
```

### 7.5 Accounts

```ts
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
```

Disconnect: in one D1 batch set `status = 'disconnected'`, null all token columns, set every open suggestion of the account to `dismissed`, write audit `account_disconnected`; Gmail additionally calls revoke (best effort, before the batch). Rows are purged by the nightly job (6.5).

Scan now: runs `runTick(env, { trigger: "scan_now", accountId })` (8.1) inside the request. Pre-claim failures map to HTTP errors: unknown account `404`, status not active or paused `409 account_inactive`, lease held `409 account_busy` with `retryAt` = lease expiry, `backoff_until > now` `409 account_inactive` with `retryAt`, budget gate `429 budget_exhausted`.

### 7.6 Queue

```ts
export const SummaryQuerySchema = z.object({ accountId: z.string().optional() });

export interface QueueSummary {
  asOf: string;                            // server time; pass back as asOf to approve/cleanup
  pending: Record<SuggestedAction, number> & { total: number };
  awaitingModel: number;
  groups: number;                          // distinct (account, sender, action) among pending
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
```

Group membership is always `status = 'pending'`. All text fields are plain text; the UI must render them as text nodes only.

### 7.7 Actions (approve, override, Clean up)

```ts
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
```

Semantics (implemented once in `actions/execute.ts`):

- **approve `{ids}`**: exactly those suggestions; each must be `pending` (else `skipped/not_pending`) and not `unsure` (else `skipped/unsure_not_approvable`). Executes `action`.
- **approve `{groupKey, asOf}`**: pending suggestions of that `(account, sender, action)` with `created_at <= asOf`, highest confidence first, at most `MAX_ITEMS_PER_ACTION_REQUEST` (100). `unsure` groups are rejected with `400 validation_failed` (use override).
- **override**: owner chooses the action for exact ids that are `pending`; guardrail ceilings do not apply (explicit owner command). Reject in the UI = override to `keep`.
- **cleanup**: pending suggestions with `action in actions` (default all three), `confidence >= threshold` (default current `tauDelete`), optional `accountId`, `created_at <= asOf`, highest confidence first, at most 100 per call.
- Execution: claim (`pending -> approved`, guarded by `WHERE status = 'pending'`), group by account and action, call `trash` / `archive` (keep is a no-op), then one D1 batch: `executed` (+ `final_action`, `decided_via`, `decided_at`, `batch_id`, `label_id`, `expires_at = decided_at + 30 d`) or `failed` (`not_found`, `archive_unavailable`, `bad_request`, `unknown`) or back to `pending` (`rate_limited`, `unavailable`, outcome `retry_later`); for executed items a `labels` row (`source` = `approve` | `override` | `cleanup`, `subject_trunc` per policy) and aggregated `sender_priors` upserts; one `action_batches` row (`undo_expires_at = now + 24 h`) and one `audit_log` row. Provider `ProviderAuthError` / `ProviderConfigError` for an account marks that account and returns its items as `retry_later/account_inactive`.
- Idempotent: repeating a request skips items that are no longer `pending`.
- Graph `newId` different from the stored id updates `messages.provider_msg_id` in the same batch.

### 7.8 Undo

```ts
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
```

`GET /api/batches` lists batches newest first (last 7 days). Undo restores every `executed` suggestion of the batch: delete -> `restore(from: "trash")`, archive -> `restore(from: "archive")`, keep -> nothing. Restored items become `undone`; their label is updated to `owner_action = 'keep'`, `source = 'undo'`, and priors receive `priorDelta(original, -1)` plus `priorDelta("keep", +1)`. Sets `undone_at`; audit `undo`. After `undo_expires_at`: `410 undo_expired`.

### 7.9 Activity

```ts
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
```

Newest first (`id DESC`); cursor encodes the last id.

### 7.10 Insights

```ts
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
}
```

### 7.11 Policy

```ts
export interface PolicyResponse { policy: Policy; version: number; defaults: Policy }

export const PutPolicyBodySchema = z.strictObject({ policy: PolicySchema, expectedVersion: z.int().min(1) });
export const PatchSenderBodySchema = z.strictObject({
  entry: SenderEntrySchema,                // "user@example.com" or "@example.com"
  list: z.enum(["allow", "deny", "none"]), // "none" removes it from both lists
});
```

Every change increments `policy_version` and writes audit `policy_updated` (`result` = counts of list sizes only). Adding to one list removes the entry from the other. Policy changes apply to suggestions created afterwards; existing pending suggestions are not recomputed in v1.

### 7.12 OAuth state cookie

- Name `__Host-clearbox_oauth`; attributes `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`.
- Value: `base64url(JSON.stringify(payload)) + "." + base64url(HMAC-SHA-256(STATE_SIGNING_KEY, first part))`.
- Payload: `{ "p": "gmail" | "outlook", "n": <nonce: base64url of 16 random bytes>, "v": <PKCE verifier: base64url of 32 random bytes, 43 chars>, "e": <expiry epoch ms> }`.
- `state` query parameter sent to the provider = `n`.
- Callback checks, in order: cookie present, HMAC valid (`crypto.subtle.verify`), not expired, `p` matches the route, `state === n`. Any failure: `error=state_invalid`. The cookie is cleared (`Max-Age=0`) on every callback response.
- Redirect URIs are derived from the request origin: `${new URL(req.url).origin}/oauth/<google|microsoft>/callback`. Register exactly these in Google and Entra (production `https://clearbox.<subdomain>.workers.dev/...`, local `http://localhost:5173/...`).

### 7.13 OAuth routes

`GET /oauth/{google|microsoft}/start[?loginHint=<email>]`: if the provider's client id or secret is empty, redirect to `/settings/accounts?error=provider_not_configured&provider=<kind>`; otherwise set the cookie and `302` to the authorize URL (4.4).

`GET /oauth/{google|microsoft}/callback`, steps:

1. Provider `error` param -> `access_denied` (Microsoft `consent_required`/AADSTS 90094 -> `admin_consent_required`).
2. Verify cookie and state (7.12).
3. Exchange code (`code_verifier` from the cookie). `ProviderConfigError` -> `provider_config_error`; others -> `token_exchange_failed`.
4. Scope check (`hasGmailScope` / `hasGraphScopes`); missing -> revoke (Google, best effort) and `scope_missing`.
5. `refreshToken` null -> `no_refresh_token`.
6. `provider.bootstrap()` with a static `TokenSource` over the fresh access token; failure -> `profile_failed`.
7. Upsert: an existing non-disconnected row for `(provider, email)` is updated (new tokens, `status = 'active'`, `status_reason = NULL`, scopes, aliases, archive folder; cursors kept; audit `account_reconnected`). Otherwise insert a new row with a new `acc_` id, `phase = 'sent_backfill'`, `incremental_cursor` from bootstrap, `next_tick_at = 0`, audit `account_connected`. Clear issue `<provider>_client_invalid`.
8. Encrypt refresh and access tokens (7.15) before the write; tokens never appear in logs or responses.
9. `302 /settings/accounts?connected=<accountId>`; on any failure `302 /settings/accounts?error=<code>&provider=<kind>`.

Callback error codes: `access_denied`, `admin_consent_required`, `state_invalid`, `token_exchange_failed`, `provider_config_error`, `scope_missing`, `no_refresh_token`, `profile_failed`, `provider_not_configured`.

### 7.14 SPA paths the server depends on

Only these are fixed by the server; every other SPA route belongs to the UI plan:

- `/settings/accounts`: OAuth callbacks redirect here with `?connected=<accountId>` or `?error=<code>&provider=<kind>`. The SPA's `OAuthReturn` route forwards to `/accounts` (or `/setup` during first run) with the same query string (UI spec 3.5); `/accounts` is the Accounts page.
- Any unknown path serves `index.html` (SPA fallback); `/api/*` and `/oauth/*` never fall back.

### 7.15 Token encryption

- Key: `importKey("raw", base64decode(TOKEN_ENC_KEY) /* 32 bytes */, "AES-GCM", false, ["encrypt", "decrypt"])`.
- Per value: fresh 12-byte IV (`crypto.getRandomValues`), AAD = UTF-8 of `clearbox|<accountId>|<"refresh" | "access">|v<keyVersion>`. Ciphertext (including the 16-byte tag) stored as BLOB, IV as BLOB.
- The worker's `TokenSource` (`createD1TokenSource` in `src/worker/scan/token-source.ts`, plan 03) caches the decrypted access token in memory for the request or tick, refreshes when `access_expires_at - now < ACCESS_TOKEN_MIN_TTL_MS`, and exposes `update: TokenUpdate | null` (core's `TokenUpdate`, 4.4: `{ accessToken, accessExpiresAt, refreshToken | null }`) that the final batch re-encrypts and persists (`tokenUpdateStmt` for requests, `encryptTokenUpdate` in the tick's guarded account update). A missing or undecryptable refresh token throws `ProviderAuthError` (`no_refresh_token`, `token_decrypt_failed`); an unconfigured client throws `ProviderConfigError("client_not_configured")`. Microsoft refresh tokens are rotated and persisted on every refresh, including in the failure path. Encrypted access tokens in D1 are a rev 2 change (saves one subrequest per tick); they are protected exactly like refresh tokens.

---

## 8. Tick and nightly algorithms

### 8.1 Entry points

```ts
// src/worker/env.ts
export const CRON_TICK = "* * * * *";
export const CRON_NIGHTLY = "0 2 * * *";

// src/worker/index.ts
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case CRON_TICK: ctx.waitUntil(runTick(env, { trigger: "cron", now: controller.scheduledTime })); break;
      case CRON_NIGHTLY: ctx.waitUntil(runNightly(env, { now: controller.scheduledTime })); break;
    }
  },
} satisfies ExportedHandler<Env>;

// src/worker/scan/tick.ts
export interface TickOptions {
  trigger: "cron" | "scan_now";
  accountId?: string;                      // required for scan_now
  now: number;
  engine?: DecisionEngine;                 // tests inject FakeEngine; default makeDecisionEngine(env, countedFetch)
  fetch?: FetchLike;                       // tests may inject; default globalThis.fetch
}
export declare function runTick(env: Env, opts: TickOptions): Promise<TickReport>;

// src/worker/nightly/nightly.ts (rev 2.2: not in tick.ts)
export declare function runNightly(env: Env, opts: { now: number }): Promise<void>;
```

One tick processes **one account** and **at most one page** (`page_size`, default 25, max 25 on Free). The same `runTick` serves the cron and `POST /api/accounts/:id/scan`. There are no in-tick retries: failures set `attempts` and `backoff_until`, and the next eligible tick retries.

### 8.2 Steps

```text
runTick(env, opts):
  cfg = readConfig(env)                                  # { ok: true, config } | { ok: false, invalid }; invalid -> log config.invalid, return idle
  encKey = importEncKey(cfg.config.tokenEncKey)
  tickId = crypto.randomUUID(); now = opts.now
  counter = createSubrequestCounter(TICK_SUBREQUEST_LIMIT)      # 45; D1 calls reserve from it too
  f = countingFetch(opts.fetch ?? fetch, counter)

  # D1 call 1: claim (one db.batch)
  [claim, claimUpdate, account, settings, budgetToday, awaitingDue, leaseRow] = DB.batch([
    CLAIM_SQL(tickId, now, now + LEASE_TTL_MS, opts.accountId ?? null, force = trigger == "scan_now",
              today, INGEST_STOP_ROWS (or +infinity when FREE_TIER = "false")),
    UPDATE accounts SET tick_started_at = now,
        page_size = CASE WHEN tick_started_at IS NOT NULL
                          AND (tick_finished_at IS NULL OR tick_finished_at < tick_started_at)
                         THEN MAX(5, page_size / 2) ELSE page_size END,         # previous tick was killed (CPU/memory)
        updated_at = now
      WHERE id = (SELECT account_id FROM leases WHERE holder = tickId AND released_at IS NULL),
    SELECT * FROM accounts WHERE id = COALESCE((SELECT account_id FROM leases WHERE holder = tickId AND released_at IS NULL), opts.accountId),
    SELECT key, value FROM settings,
    SELECT * FROM budget WHERE date = today,
    SELECT COUNT(*) AS n FROM suggestions
      WHERE account_id = (SELECT account_id FROM leases WHERE holder = tickId AND released_at IS NULL)
        AND status = 'awaiting_model' AND (retry_after IS NULL OR retry_after <= now),
    SELECT holder, expires_at, released_at FROM leases WHERE name = 'account:' || opts.accountId   # rev 2.2: for the 7.5 mapping
  ])
  if claim returned no row:
    if trigger == "cron": log tick.idle; return { outcome: "idle", ... }     # nothing written
    else: throw ApiError mapped per 7.5 using account, budgetToday and the lease row

  # Kind selection
  if awaitingDue.n > 0:                                   kind = "redecide"
  elif account.phase == "sent_backfill":                 kind = "sent_backfill"
  elif account.phase == "incremental"
       or account.last_incremental_at is null
       or now - account.last_incremental_at >= POLL_INTERVAL_MS:  kind = "incremental"
  else:                                                  kind = "inbox_backfill"
  if kind == "inbox_backfill" and budgetToday.db_size_bytes >= STORAGE_SOFT_LIMIT_BYTES:
       raise issue storage_near_limit; kind = "incremental"
  if kind needs decisions (all except sent_backfill) and Decision secrets missing:
       fail(DecisionNotConfiguredError) -> issue decision_not_configured     # rev 2.2: local ClearboxError subclass in scan/failure.ts

  try:
    tokens = openTickTokens({ row: account, config: cfg, encKey, fetch: f, now })   # plan 03 createD1TokenSource + refreshFnFor(..., redirectUri ""); no fetch unless refresh needed
    provider = makeProvider(providerTargetOf(account), { fetch: f, tokens, now })     # plan 03 ProviderFactory

    # Provider fetch (sequential, never concurrent within the account)
    sent_backfill:  page = provider.listSentPage(account.sent_cursor, SENT_PAGE_SIZE)
    inbox_backfill: page = provider.listInboxPage(account.backfill_cursor, account.page_size)
    incremental:    page = provider.syncChanges(account.incremental_cursor, account.page_size)
                    on CursorExpiredError: cursor = provider.resyncCursor(account.watermark_received_at)
                                           page = provider.syncChanges(cursor, account.page_size)
    redecide:       no provider call
    inbox_backfill on CursorExpiredError(backfill): restart with cursor null (known ids are skipped)

    # D1 call 2: context (skipped for sent_backfill), one db.batch, all with account_id = ?
    known ids        : SELECT provider_msg_id FROM messages WHERE account_id = ? AND provider_msg_id IN (...)
    priors           : SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ? AND key IN (senders, @domains)
    sender stats     : SELECT address, seen_count, read_count FROM senders WHERE account_id = ? AND address IN (...)
    correspondents   : SELECT address FROM correspondents WHERE account_id = ? AND address IN (...)
    replied threads  : SELECT thread_id FROM sent_threads WHERE account_id = ? AND thread_id IN (...)
    labels by sender : newest <= 5 per sender (ROW_NUMBER() OVER (PARTITION BY sender ORDER BY id DESC))
    labels by domain : newest <= 5 per domain (same, PARTITION BY sender_domain)
    redecide only    : SELECT s.*, m.* FROM suggestions s JOIN messages m ON m.id = s.message_id
                       WHERE s.account_id = ? AND s.status = 'awaiting_model' AND (s.retry_after IS NULL OR s.retry_after <= ?)
                       ORDER BY s.created_at LIMIT page_size
    (every IN list <= 99 values: page size <= 25 keeps every statement under the 100 bound-parameter limit)

    # Pure processing
    fresh = page messages whose ids are not known (in page order)
    for each msg: history = context + counts accumulated from earlier messages in this page
                  signals = extractSignals(msg, history, ctx); guard = evaluateGuardrails(...)
                  prior = selectPrior(...); state = buildDecisionState(...)
                  input = { key: msg.providerMessageId, state, seed: decisionSeed(account.id, id) }
    (redecide rebuilds MailMessage fields from the messages row: subject, snippet (may be null -> ""), signals_json)

    # Decision-1 (at most page_size calls, concurrency DECISION_CONCURRENCY = 4)
    assert counter.used + inputs.length + 2 <= counter.limit    # 2 = D1 calls 3 and 4
    outcomes = decideAll(engine, inputs, DECISION_CONCURRENCY)
    if any outcome error.scope == "config":
       raise issue (decision_auth_failed | decision_deployment_not_found); fail(...)    # nothing ingested
    if inputs.length >= 4 and retryableFailures / inputs.length > DECISION_FAILURE_ABORT_RATIO:
       fail(DecisionError "server")                                                     # outage: nothing ingested
    per message:
       ok                -> fuse(model) -> status pending
       item, not retry   -> fuse(model = null) -> status pending, action unsure, reason model_unavailable
       item, retryable   -> status awaiting_model, decision_attempts = 1, retry_after = now + DECISION_RETRY_DELAYS_MS[0]
    redecide: ok -> pending; retryable and attempts + 1 < DECISION_MAX_ATTEMPTS -> retry_after = now + DELAYS[attempts];
              otherwise -> pending unsure (model_unavailable)

    # D1 call 3: write (one db.batch = one transaction)
    INSERT INTO messages (...) ON CONFLICT (account_id, provider_msg_id) DO NOTHING          # per fresh message
    INSERT INTO suggestions (message_id, ...) SELECT id, ... FROM messages
      WHERE account_id = ? AND provider_msg_id = ? ON CONFLICT (message_id) DO NOTHING      # per fresh message
    UPDATE suggestions SET ... WHERE message_id = ? AND account_id = ? AND status = 'awaiting_model'   # redecide
    INSERT INTO senders ... ON CONFLICT DO UPDATE SET seen_count = seen_count + ?, read_count = read_count + ?, last_seen_at = MAX(...)  # per distinct sender
    INSERT INTO correspondents / sent_threads ... ON CONFLICT DO UPDATE SET last_sent_at = MAX(...)  # sent items
    UPDATE suggestions SET status = 'dismissed', updated_at = ?, expires_at = ? + DECIDED_TTL_MS
      WHERE account_id = ? AND status IN ('pending', 'awaiting_model')
        AND message_id IN (SELECT id FROM messages WHERE account_id = ? AND provider_msg_id IN (...))  # removedIds
    UPDATE accounts SET <cursor for kind>, phase, backfill_done, sent_scanned, watermark_received_at,
        last_incremental_at (incremental), <token columns if TokenUpdate>, attempts = 0, backoff_until = NULL,
        last_error = NULL, status_reason = NULL, next_tick_at = <8.3>, last_tick_at = now,
        tick_finished_at = now, page_size = MIN(<25 or 100>, page_size + 5),
        messages_ingested = messages_ingested + <fresh count>, updated_at = now
      WHERE id = ?
    UPDATE leases SET released_at = now WHERE name = 'account:' || ? AND holder = tickId
    (settings 'issues' rewritten only when the set of issues changed)

  catch err:                                             # fail(): same shape, different account update
    D1 call 3': one db.batch:
      UPDATE accounts SET attempts = attempts + 1,
          backoff_until = now + (err.retryAfterMs ?? backoffMs(attempts + 1)),
          status = 'needs_reauth' if ProviderAuthError, 'config_error' if ProviderConfigError,
          status_reason = err.reason, last_error = err.code, <token columns if TokenUpdate>,
          last_tick_at = now, tick_finished_at = now, updated_at = now WHERE id = ?
      UPDATE leases SET released_at = now WHERE ...
      INSERT INTO audit_log (kind 'reauth_required' | 'config_error') when status changed
      settings 'issues' update when a config issue was raised

  # D1 call 4: budget (always, when a claim happened)
  INSERT INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
                      decision_input_tokens, provider_calls, db_size_bytes, updated_at)
    VALUES (today, sumRowsWritten(call1, call3) + 1, sumRowsRead(...), 1, ...)
    ON CONFLICT (date) DO UPDATE SET rows_written = rows_written + excluded.rows_written, ..., 
       db_size_bytes = excluded.db_size_bytes, updated_at = excluded.updated_at
  log tick.done; return TickReport
```

`CLAIM_SQL` (exact; `?1` holder, `?2` now, `?3` expires_at, `?4` accountId or NULL, `?5` force 0/1, `?6` today, `?7` ingest stop rows):

```sql
INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
SELECT 'account:' || a.id, a.id, ?1, ?2, ?3, NULL
FROM accounts a
WHERE a.status = 'active'
  AND a.paused = 0
  AND (?4 IS NULL OR a.id = ?4)
  AND (a.backoff_until IS NULL OR a.backoff_until <= ?2)
  AND (?5 = 1 OR a.next_tick_at <= ?2)
  AND COALESCE((SELECT b.rows_written FROM budget b WHERE b.date = ?6), 0) < ?7
  AND NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.name = 'account:' || a.id AND l.released_at IS NULL AND l.expires_at > ?2
  )
ORDER BY a.last_tick_at IS NOT NULL, a.last_tick_at
LIMIT 1
ON CONFLICT (name) DO UPDATE SET
  account_id = excluded.account_id, holder = excluded.holder, acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING account_id;
```

A worker test must exercise this statement against the real D1 SQLite (overlap, expiry, round robin, budget gate, scan-now force). SQLite documents a parse ambiguity only for upserts whose `SELECT` ends in a join without `WHERE`; this statement has a `WHERE` and ends in `LIMIT`, so it is valid. If D1 nevertheless rejects it, use the documented fallback: wrap the candidate in a subquery (`SELECT * FROM (SELECT ... LIMIT 1) WHERE true ON CONFLICT ...`), keep it inside D1 call 1, and update this section.

### 8.3 Phases, cursors and scheduling

| Situation after a successful tick | `phase` | `next_tick_at` |
|---|---|---|
| `sent_backfill`, more pages and `sent_scanned < SENT_BACKFILL_MAX_MESSAGES` | stays | `now` |
| `sent_backfill` finished (no next cursor or cap reached) | `inbox_backfill` | `now` |
| `inbox_backfill`, more pages | stays | `now` |
| `inbox_backfill`, `nextCursor = null` | `incremental`, `backfill_done = 1` | `now` |
| `incremental` during `inbox_backfill` phase | stays `inbox_backfill` | `now` |
| `incremental`, `caughtUp = false` | stays | `now` |
| `incremental`, `caughtUp = true`, phase `incremental` | stays | `now + POLL_INTERVAL_MS` |
| `redecide` | unchanged | `now` |

`watermark_received_at` = max `receivedAt` ingested so far (any kind). Round robin: the claim orders by `last_tick_at` (nulls first), so accounts with work alternate minute by minute; with one account and a backlog, the account is ticked every minute.

Backoff: `backoffMs(attempts)` = 1 min, 2, 4, ... capped at 6 h, plus jitter; `ProviderRateLimitError.retryAfterMs` wins when present. Accounts with `needs_reauth` or `config_error` are never claimed until reconnected (reconnect resets `status`, `attempts`, `backoff_until`).

### 8.4 Subrequest budget per tick (limit 45; D1 calls counted)

| Item | sent_backfill | inbox_backfill Gmail | inbox_backfill Graph | incremental Gmail | incremental Graph | redecide |
|---|---|---|---|---|---|---|
| D1 call 1 claim | 1 | 1 | 1 | 1 | 1 | 1 |
| Token refresh (only when < 5 min left) | 0-1 | 0-1 | 0-1 | 0-1 | 0-1 | 0 |
| 401 retry (refresh + repeat) | 0-2 | 0-2 | 0-2 | 0-2 | 0-2 | 0 |
| Provider list / sync | 1 | 1 | 1 | 1 (history) + 0-1 (catch-up list after resync) | 2 (inbox delta + sent delta) | 0 |
| Cursor resync | 0 | 0 | 0 | 0-1 (getProfile) | 0-2 (filtered delta bootstrap pages) | 0 |
| Metadata (Gmail batch <= 50 parts) / header fallback (Graph `$batch` <= 20) | Gmail 2 (100 sent To/Cc), Graph 0 | 1 | 0-2 | 1 | 0-2 | 0 |
| D1 call 2 context | 0 | 1 | 1 | 1 | 1 | 1 |
| Decision-1 calls | 0 | <= 25 | <= 25 | <= 25 | <= 25 | <= 25 |
| D1 call 3 write | 1 | 1 | 1 | 1 | 1 | 1 |
| D1 call 4 budget | 1 | 1 | 1 | 1 | 1 | 1 |
| **Worst case** | **9** | **34** | **35** | **36** | **38** | **29** |

The `scan_now` path adds 1 (Access JWKS fetch on a cold isolate): worst case 39. `countingFetch` enforces the limit; D1 calls reserve from the same counter through the `db/sql.ts` helper `withCount(counter, () => DB.batch(...))`. On Workers Paid (`FREE_TIER = "false"`) the page size is 100 and Decision-1 calls are capped at 100 per tick; the 45 limit applies only on Free.

CPU: Free allows 10 ms per invocation. Targets: pure processing of a 25-message page (parse, signals, guardrails, state building, fusion, SQL statement building) <= 6 ms in the Node benchmark `packages/core/test/bench/page-cpu.test.ts`. A killed tick (lease never released) halves `page_size` on the next claim (min 5); each successful tick grows it by 5 up to the maximum.

### 8.5 Owner action request budget

`approve`, `override`, `cleanup`, `undo` each touch at most 100 suggestions. Worst case with three accounts: JWKS 1 + D1 claim/load 1 + token refreshes 3 + Graph `$batch` 5 (100 / 20) or Gmail trash batches 2 (100 / 50) + Gmail `batchModify` 1 + D1 write 1 + D1 budget 1 = at most 16. These requests are allowed while `rows_written < BUDGET_ROWS_PER_DAY` and are counted in `budget.rows_written` by the same `D1 call 4` pattern.

### 8.6 Nightly job (`0 2 * * *`)

```text
runNightly(env, { now }):
  runId = crypto.randomUUID(); counter = createSubrequestCounter(TICK_SUBREQUEST_LIMIT)
  D1 call 1 (batch): claim lease 'nightly' (same upsert pattern, TTL 10 min); SELECT settings; SELECT budget today;
                     SELECT id FROM accounts WHERE status = 'disconnected'
  not claimed -> return

  D1 call 2 (batch):
    UPDATE suggestions SET status = 'failed', exec_error = 'interrupted', updated_at = now
      WHERE status = 'approved' AND updated_at < now - STALE_APPROVED_MS
    SELECT p_delete, margin, ceiling, owner_action FROM labels ORDER BY id DESC LIMIT CALIBRATION_WINDOW
  result = calibrateTauDelete(samples, settings.tau_delete)

  D1 call 3 (batch): upsert settings tau_delete, calibration (+ ranAt); audit 'calibration' (count = deleteSuggestions)

  Purge expired (at most 16 rounds; stop early when budget.rows_written + written >= PURGE_STOP_ROWS):
    D1 call: SELECT message_id FROM suggestions WHERE expires_at < now LIMIT 500
    if none: break
    D1 call (batch): DELETE FROM suggestions WHERE message_id IN (<= 90 ids)  x ceil(n / 90)
                     DELETE FROM messages    WHERE id IN (<= 90 ids)          x ceil(n / 90)

  Disconnected accounts (uses the remaining rounds, same stop rule), per account in table order
  suggestions, messages, labels, sender_priors, senders, correspondents, sent_threads:
    rowid tables:        DELETE FROM <t> WHERE rowid IN (SELECT rowid FROM <t> WHERE account_id = ? LIMIT 1000)
    WITHOUT ROWID tables: DELETE FROM <t> WHERE account_id = ? AND <pk2> IN (SELECT <pk2> FROM <t> WHERE account_id = ? LIMIT 1000)
    when all are empty: DELETE FROM leases WHERE account_id = ?; DELETE FROM accounts WHERE id = ?; audit 'account_purged'

  Final D1 call (batch): DELETE FROM action_batches WHERE created_at < now - BATCH_RETENTION_MS;
                         DELETE FROM budget WHERE date < <today - 90 days>;
                         settings 'nightly' summary; audit 'purge' (count = purged messages);
                         release lease
  D1 call: budget upsert (rows written by this run)
```

D1 calls: 3 + 2 per round x up to 19 rounds + 2 <= 44. Purge capacity: 16 rounds x 500 = 8,000 expired emails per night (about 24,000 rows).

---

## 9. Logging and metrics events

`src/worker/log.ts` is the only place that calls `console.log`. Every event is one JSON line:

```ts
export interface LogBase { app: "clearbox"; ts: string; evt: LogEventName }

export type LogEventName =
  | "tick.idle" | "tick.claimed" | "tick.done" | "tick.failed"
  | "decision.error" | "provider.error" | "account.status"
  | "oauth.connect" | "action.executed" | "undo.done"
  | "nightly.done" | "access.denied" | "config.invalid" | "budget.gate"
  | "issue.raised" | "issue.cleared" | "request.error";

export declare function logEvent(name: LogEventName, fields: Readonly<Record<string, string | number | boolean | null>>): void;
```

| Event | Fields |
|---|---|
| `tick.idle` | `tickId`, `trigger` |
| `tick.claimed` | `tickId`, `trigger`, `accountId`, `kind`, `phase`, `pageSize` |
| `tick.done` | `tickId`, `accountId`, `kind`, `fetched`, `skippedKnown`, `decided`, `deferred`, `unsure`, `removed`, `subrequests`, `rowsWritten`, `rowsRead`, `inputTokens`, `decisionP50Ms`, `decisionP95Ms`, `durationMs` |
| `tick.failed` | `tickId`, `accountId`, `kind`, `errorCode`, `attempts`, `retryAfterMs` |
| `decision.error` | `tickId`, `accountId`, `messageId` (internal integer or null), `kind`, `status`, `requestId` (apim-request-id) |
| `provider.error` | `tickId` or `requestId`, `accountId`, `provider`, `errorCode`, `status` |
| `account.status` | `accountId`, `from`, `to`, `reason` |
| `oauth.connect` | `provider`, `outcome` (`connected`, `reconnected`, error code), `accountId` |
| `action.executed` | `requestId`, `kind`, `batchId`, `executed`, `failed`, `skipped`, `retryLater` |
| `undo.done` | `requestId`, `batchId`, `restored`, `failed`, `skipped` |
| `nightly.done` | `runId`, `tauDelete`, `calibrationOutcome`, `purgedMessages`, `purgedAccounts`, `staleRecovered`, `rowsWritten` |
| `access.denied` | `reason` (`missing`, `invalid`, `wrong_email`, `misconfigured`, `csrf`), `route` (Hono route pattern, never the URL) |
| `config.invalid` | `missing` (comma-separated secret names) |
| `budget.gate` | `date`, `rowsWritten`, `gate` (`ingest`, `purge`, `owner`) |
| `issue.raised` / `issue.cleared` | `code`, `accountId` |
| `request.error` | `requestId`, `route` (Hono route pattern), `errorName` (the error class name only, never its message). Rev 2.2: logged by `onApiError` (`src/worker/middleware/errors.ts`) for every unexpected error before it answers `500 internal`. |

Allowed values: opaque ids (`acc_...`, internal integers, uuids, `apim-request-id`), counts, durations, enum codes, HTTP statuses. **Never** logged: any email address (including the owner's), display names, subjects, snippets, provider message or thread ids, tokens, cookies, full URLs or query strings, request or response bodies. `requestId` for HTTP requests is `crypto.randomUUID()` per request, returned in the `X-Request-Id` response header.

Metrics are derived from `tick.done` (Workers Logs) and from the `budget` table (served by `/api/insights`). No external metrics service.

---

## 10. Test strategy conventions

### 10.1 Locations and naming

| Area | Location | Runner / environment |
|---|---|---|
| Core unit tests | `packages/core/test/<module>/<file>.test.ts`, mirroring `src/` (e.g. `test/fusion/fusion.test.ts`) | Vitest, Node |
| Core provider tests | `packages/core/test/providers/{gmail,graph,oauth}.test.ts` | Vitest + `msw/node` |
| CPU benchmark | `packages/core/test/bench/page-cpu.test.ts` (fails when a 25-message page exceeds 6 ms median over 50 runs) | Vitest, Node |
| Worker tests | `app/test/worker/<area>/<file>.test.ts` (`access`, `csrf`, `oauth`, `crypto`, `db`, `tick`, `actions`, `nightly`, `routes`) | `@cloudflare/vitest-plugin` |
| SPA tests | `app/test/web/**/*.test.tsx` | Vitest, happy-dom, Testing Library, `msw/node` |
| Eval | `eval/` via `pnpm eval` (live Decision-1, never in CI) | Node |

Test files end in `.test.ts` / `.test.tsx`. One `describe` per exported function or route. No snapshot tests of probabilities; compare floats with `toBeCloseTo(x, 9)`. Time is always injected (`now` parameters); tests never depend on the wall clock.

### 10.2 Fixtures (synthetic only)

- Location: `packages/core/test/fixtures/{gmail,graph,oauth,decision}/*.json` plus builders in `packages/core/test/fixtures/builders.ts`: `makeMailMessage(overrides)`, `makeSignals(overrides)`, `makeSenderHistory(overrides)`, `makeDecisionResult(overrides)`, `makePolicy(overrides)`, `makeGmailMetadata(overrides)`, `makeGraphMessage(overrides)`.
- `packages/core/test/testing.ts` (exported as `@clearbox/core/testing`) re-exports the builders, the MSW handler factories and `FakeMailbox`; worker and web tests import from there.
- Only reserved domains: `example.com`, `example.net`, `example.org`, `*.test`, `*.example`. Owner is `owner@example.test`. No real message content, ids, names, tokens or keys. Shapes follow the research docs (`mail-providers.md` sections 2 to 4 and 8, `decision-1.md` section 4).
- Fixtures recorded from real mailboxes must be fully re-synthesized before commit (replace every address, subject, snippet, id and header value).

### 10.3 MSW conventions

- Handler factories live in `packages/core/test/msw/`: `gmail.ts`, `graph.ts`, `google-oauth.ts`, `microsoft-oauth.ts`, `decision.ts` (plus `failures.ts` and `fake-mailbox.ts`). The Access JWKS handler is worker-only: `app/test/worker/helpers/access.ts` (rev 2.2). Each exports `xxxHandlers(state)` returning an array of handlers over an in-memory `FakeMailbox` (`test/msw/fake-mailbox.ts`: messages, labels/folders, history records, delta tokens, sent items), so paging, history, delta, `$batch`, batch multipart, trash, archive and restore behave consistently.
- Error injection through `state.failNext({ method, path, status, headers, body, times })`.
- Rev 2.2: a global `http.all("*")` at the end of every handler set would shadow later sets when several are combined in one `server.use`. Instead each provider factory ends with an origin-scoped catch-all (for example `https://gmail.googleapis.com/*`) that throws `Unhandled request <METHOD> <origin><pathname>`, and the shared setup fails everything else (next two bullets).
- Core: `packages/core/test/setup/msw.ts` creates `export const server = setupServer()` (`msw/node`) with `beforeAll(listen)`, `afterEach(resetHandlers)`, `afterAll(close)`. MSW 3 renamed `onUnhandledRequest` to **`onUnhandledFrame`**, and its `"error"` strategy still lets the request reach the network, so the setup answers unhandled requests with `frame.errorWith()` (a 500, no network) and fails the test in `afterEach`.
- Worker: `app/test/worker/setup/network.ts` creates `export const network = setupNetwork(catchAll)` (`@msw/cloudflare`; the catch-all and, from plan 03 Task 5, the Access JWKS handler are initial handlers) with `enable` / `resetHandlers` / `disable`. The core factories run on `msw/node`, so worker tests install their own workerd-side handlers on `network` (plan 03 `test/worker/helpers/*`, plan 04 `provider-mock.ts` and `decision-mock.ts`).
- SPA: `app/test/web/msw/server.ts` (`msw/node`) serves a synthetic fake API (`installFakeApi`) for happy-dom tests.
- The Decision-1 handler validates the request body (only `model`, `state`, `questions` keys; all five questions present; `state` JSON length <= 1,750) and returns the documented response shape.

### 10.4 Worker test conventions

- Migrations: `app/test/worker/setup/apply-migrations.ts` runs `await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (migrations read by `readD1Migrations("migrations")` in `vitest.worker.config.ts`). Each test file starts with a migrated empty database (the plugin isolates storage per test file).
- Requests: `app/test/worker/helpers/request.ts` exports `apiFetch(path, init?, opts?)` that calls `exports.default.fetch(new Request("https://clearbox.example.test" + path, ...))` with a valid Access JWT and, for mutations, `X-Clearbox-CSRF: 1`; `opts` can drop or corrupt either.
- Access: `app/test/worker/helpers/access.ts` generates an RS256 key pair with `jose.generateKeyPair`, serves the JWKS at `https://test-team.cloudflareaccess.com/cdn-cgi/access/certs` via MSW, and exports `signAccessJwt(claims)`.
- Seeding: `app/test/worker/helpers/seed.ts` exports `seedAccount(overrides)` (encrypts synthetic tokens with the test `TOKEN_ENC_KEY`), `seedMessages(accountId, n, overrides)`, `seedSuggestions(...)`, `seedLabels(...)`.
- Ticks: call `runTick(env, { trigger, now, engine: new FakeEngine(), fetch })` directly; one test drives the cron path through `exports.default.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime }), env, ctx)` and `waitOnExecutionContext(ctx)` with the Decision-1 MSW handler.
- Required security tests: Access (missing, bad signature, wrong `aud`, wrong `iss`, expired, wrong email, service token, dev bypass only in development on localhost, bypass flag in production fails closed, missing secrets fail closed); CSRF; OAuth state (tampered, expired, provider mismatch, state mismatch, cookie cleared); AES-GCM round trip and AAD mismatch; approval invariants (no provider call without a `pending` suggestion id, cap 100, idempotent repeat, `unsure` not approvable); DB isolation scan (6.1); `scripts/check-text.ts` passes.

### 10.5 FakeEngine

Deterministic rules in 4.9.4; `overrides` inject exact results or `DecisionError`s per key (the provider message id); `calls` records inputs for assertions (for example, that option order differs between seeds and that state never exceeds 1,750 chars). FakeEngine never touches the network.

---

## 11. Naming and coding conventions

- **No em dashes** (U+2014) anywhere: code, comments, docs, UI copy, test names, commit messages. Use a comma, colon, period, parentheses or "to". En dashes in numeric ranges are allowed. Enforced by `scripts/check-text.ts` in `pnpm lint`.
- **ESM only.** `"type": "module"` everywhere. Relative imports use explicit `.ts`/`.tsx` extensions. `import type` for type-only imports (`verbatimModuleSyntax`). Named exports only; default exports only where a tool requires them (`cloudflare.config.ts`, `vite.config.ts`, `vitest.*.config.ts`, `eslint.config.js`, `src/worker/index.ts`).
- **Strict TypeScript** per `tsconfig.base.json`; no `any`, no `enum`, no `namespace`, no parameter properties, no non-null assertions outside tests. Use `as const` objects plus union types instead of enums.
- **Files:** kebab-case (`token-source.ts`); React components `PascalCase.tsx`; one responsibility per file; aim for under 300 lines, anything over 500 lines must be split. Tests mirror source paths.
- **Identifiers:** camelCase for TS values and fields, PascalCase for types and classes, SCREAMING_SNAKE_CASE for constants, snake_case only for SQL and the `DecisionState` JSON.
- **Time and ids:** epoch ms integers internally, ISO 8601 in the REST API, UTC everywhere. Account ids `acc_` + 16 hex; internal integer ids for messages, suggestions (= message id), labels, batches, audit rows.
- **SQL:** only in `src/worker/db/*.ts` (repository statement builders used by routes and actions) and, for the tick and nightly job (rev 2.2), in the plain `{ sql, params }` builders of `scan/claim.ts`, `scan/context.ts`, `scan/write-plan.ts`, `scan/failure.ts` and `nightly/*.ts`. Routes, actions, oauth and `scan/token-source.ts`/`providers.ts`/`tick-tokens.ts` hold no account-owned SQL (asserted by `db-isolation.test.ts`). Cross-account reads must carry the SQL comment `-- isolation-exempt: calibration` (the only allowed reason). Always `?N` parameters, never value interpolation; IN lists built by `placeholders(n)` with n <= 99; every account-owned query includes `account_id`.
- **Errors:** throw `ClearboxError` subclasses (core) or `ApiError` (worker routes); never throw strings; error messages carry no user data.
- **Pure core:** `@clearbox/core` receives `fetch`, `now` and token sources as parameters; it never reads globals like `Date.now()` or environment variables.
- **UI copy and terms:** English, sentence case, PRODUCT.md vocabulary (suggestion, sender group, confidence, reasons, guardrail, Clean up). Email content is rendered as plain text only; no `dangerouslySetInnerHTML`.
- **Dependencies:** adding one requires updating section 2 with an exact version verified on npm.
- **Public repo hygiene:** no environment-specific values in tracked files (Cloudflare account ids or names, `workers.dev` subdomains, Zero Trust team names, Azure subscription, resource group or resource names, personal emails). Use placeholders: `<your-account-id>`, `<subdomain>.workers.dev`, `<team>.cloudflareaccess.com`, `<foundry-account>`, `<resource-group>`, `<you@example.com>`.

## 12. Amendments (rev 2.1, 2026-10-15, from the UI design spec)

These amendments are binding and override earlier sections where they differ. Source: `docs/superpowers/specs/2026-10-15-clearbox-ui-design.md` section 9.3 and 9.4, accepted by the lead.

### 12.1 API additions (all read-only, all in v1)

| Id | Addition | Owner plan | Computation |
|---|---|---|---|
| A1 | `QueueSummary.groupsByAction: Record<SuggestedAction, number>` on `GET /api/queue/summary` | 03 | Count of distinct sender groups with at least one `pending` suggestion, per suggested action, in the requested account scope. Same query family as `groups`. |
| A2 | `CleanupPreview.groupsLeft: number` on the Clean up preview response | 03 | Pending sender groups in scope that keep at least one pending item after applying this Clean up (items below threshold, `unsure`, `keep`, or `awaiting_model`). |
| A3 | `Insights.weekly: { weekStart: string; cleaned: number; undone: number }[]` on `GET /api/insights` | 03 | Last 6 ISO weeks, Monday start, UTC, oldest first, zero-filled. `cleaned` = executed trash and archive items; `undone` = items restored by undo. Computed from `audit_log` / batch tables, no new table. |
| A4 | `AccountSync.inboxEstimate: number \| null` on account views | 03 (read; write at connect), 04 (refresh) | New column `accounts.inbox_estimate INTEGER NULL` added to migration 0001. Written at connect/bootstrap from the provider (Gmail `users.labels.get INBOX messagesTotal` is NOT allowed if it needs another scope; with `gmail.modify` it is allowed; Graph `mailFolders/inbox` `totalItemCount`) and refreshed by the tick at most once per day during backfill. Null when unknown. |
| A5 | `ActivityEntry.result` keys are fixed: approve, override and cleanup `{ executed, failed, skipped, retryLater, delete, archive, keep, groups }`; undo `{ restored, failed }`; policy_updated `{ allow, deny }`; calibration `{ tauDelete }` | 03, 04 (calibration) | Written into `audit_log.result` JSON with exactly these keys; missing numbers are 0. |
| A6 | `SenderGroup.latestSubject: string \| null` | 03 | Subject (plain text, already decoded) of the newest pending item in the group; null when snippets/subjects are not stored. |

A7 (`AccountView.label`) is deferred to v1.1.

### 12.2 Wording

Reason templates (section 4.11) use the UI verb "trash": "You trashed {n} of {m} from this sender", "You trashed {n} of {m} from {domain}". Reason ids are unchanged.

### 12.3 Product decisions

- Keep suggestions are excluded from Clean up. The Keep tab offers "Confirm all keeps" (approve all pending `keep` suggestions in scope, same caps as approve).
- Sender group rows display `confidence.avg`; group detail shows min and max.

### 12.4 Dependencies (dev, `app/`)

Add `axe-core` 4.14.0 and `@testing-library/user-event` 14.6.8 (plus `@testing-library/react` and `jsdom` or `happy-dom` at the versions plan 05 verifies on npm) for SPA component and accessibility tests. Resolved in rev 2.2: plan 03 declares `axe-core` 4.14.0, `@testing-library/user-event` 14.6.8, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2 and `happy-dom` 21.0.1 (no jsdom) in `app/package.json`; section 2 lists them.

### 12.5 Rev 2.2 (2026-10-15, integration of the six implementation plans)

Rev 2.2 makes this document match the reconciled plans `docs/superpowers/plans/2026-10-15-clearbox-0{1..6}-*.md` (index: `2026-10-15-clearbox-00-index.md`). It is binding and overrides earlier sections where they differ. Summary:

- **Layout (1.1):** added `scan/claim.ts`, `scan/context.ts`, `scan/failure.ts`, `scan/tick-tokens.ts`; removed `db/leases.ts` and `db/senders.ts` (their SQL lives in the scan builders); listed the SPA `api/*`, `lib/`, `state/`, `pages/review/`, `pages/gallery/` and component folders; `scripts/tsconfig.json`, `scripts/lib/*`, `scripts/test/*`; `eval/src/{fixtures,pipeline,report,io,export-labels}.ts`, `eval/vitest.config.ts`, `eval/test/`, `eval/private/`; `docs/security-review-checklist.md`. File owners: plan 03 owns `scan/token-source.ts` and `scan/providers.ts`; plan 04 only consumes them.
- **Scripts (1.3):** root scripts unchanged; `@clearbox/eval` adds `export-labels`, `typecheck`, `test`.
- **Dependencies (2):** `axe-core` 4.14.0, `@testing-library/user-event` 14.6.8 and `happy-dom` 21.0.1 as the test DOM (no jsdom); `zod` 4.6.7 also in eval; GitHub Actions pins; no other additions.
- **Lint (3.8):** `"no-console": "error"` (ESLint 10 rejects an empty `allow`); `.prettierignore` adds `*.md`, `docs/design/`, `.impeccable/`; plan 05 appends the SPA `no-restricted-syntax` block; `scripts/check-text.ts` is created by plan 01 and replaced by plan 06 with the full secret-pattern set and the `check-text: allow` marker.
- **`.gitignore` (3.9):** adds `.impeccable/` and `eval/private/`.
- **Core (4.3, 4.4):** `MailProvider.inboxEstimate(): Promise<number | null>` (plan 02); the single `TokenUpdate` lives in `providers/token.ts` and is exported from `@clearbox/core`; plans 03 and 04 import it.
- **Connect (12.1 A4):** `completeConnect` calls `inboxEstimate()` once after `bootstrap()` (best effort) and stores it with `setInboxEstimateStmt`; the tick refreshes it at most daily during backfill.
- **Token source (7.15, 8.2):** the worker token source is plan 03's `createD1TokenSource({ account, encKey, refresh, now })` with `refreshFnFor(PROVIDER_OAUTH, config, provider, fetch, now, redirectUri)` (`redirectUri` is `""` in the tick) and `update: TokenUpdate | null`; providers come from `makeProvider(target: { provider, archiveFolderId }, deps)`; `makeDecisionEngine(env, fetch)`.
- **Tick (8.2):** the claim batch has a 7th statement that reads the lease row (7.5 mapping); missing Decision-1 secrets fail with `DecisionNotConfiguredError` (code `decision_not_configured`), an outage with `DecisionOutageError` (code `decision_outage`); plan 04's other decisions C6 to C27 are adopted as written in its "Contract issues and decisions" table.
- **Logging (9):** new event `request.error` (`requestId`, `route`, `errorName`), logged by `onApiError` before `500 internal`.
- **Tests (10.3):** MSW 3 `onUnhandledFrame` with `frame.errorWith()`; origin-scoped catch-alls per handler factory instead of a global `http.all("*")`; worker tests install their own handlers on `@msw/cloudflare`'s `network`.
- **SQL (11, 6.1):** tick and nightly SQL may live in the `scan/*` and `nightly/*` builders; cross-account reads carry `-- isolation-exempt: calibration`, which plan 04 extends `db-isolation.test.ts` to check.
- **SPA routes (7.14):** `/settings/accounts` stays the server's OAuth landing path; the SPA forwards it to `/accounts`.
- **Build output:** `cf build` writes to `app/.cloudflare/output/v0/`.
- **Local typecheck and build (3.2):** `cf workers types` and `cf build` evaluate `cloudflare.config.ts` in production mode, so local and CI typecheck/build commands set `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000` (the public local id); it is never written to `app/clearbox.local.json`.
- **Other plan decisions adopted as written:** plan 01 "Contract issues and decisions" #1 to #26, plan 02 #1 to #29, plan 03 #1 to #33, plan 04 C1 to C27, plan 05 W1 to W25, plan 06 C1 to C17. Where one of those tables and this section disagree, this section wins.
