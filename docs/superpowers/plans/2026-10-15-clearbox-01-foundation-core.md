# Clearbox Plan 01: Foundation and Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the pnpm workspace and build `@clearbox/core`: the pure TypeScript model, provider interfaces, signals, policy, guardrails, priors, Decision-1 client (questions, token budget, validation, `MaiDecisionEngine`, `FakeEngine`), fusion, calibration and HTTP utilities that every other Clearbox plan imports.

**Architecture:** `packages/core` is a source-only ESM package (no build step) consumed by Vite, Vitest and Node type stripping. Every module is pure: time, `fetch`, randomness seeds and token sources are injected; nothing reads environment variables or imports Cloudflare, Hono, Node or React. Each module has one responsibility and a mirrored Vitest file; MSW 3 (`msw/node`) mocks the Decision-1 endpoint.

**Tech Stack:** Node 24.13.1, pnpm 12.11.2 (Corepack), TypeScript 6.0.3 (strict, `erasableSyntaxOnly`), zod 4.6.7, Vitest 5.0.4, MSW 3.0.3, ESLint 10.12.0 + typescript-eslint 8.71.2, Prettier 3.9.10.

**Source of truth:** `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` (sections 1.1 to 1.3, 2, 3.5, 3.6, 3.8, 3.9, 4, 5, 10, 11, and the binding amendments in 12, rev 2.1: only 12.2 touches this plan). Narrative: `docs/superpowers/specs/2026-10-15-clearbox-design.md` (rev 2). Decision-1 wire facts: `docs/superpowers/research/decision-1.md`.

## Global Constraints

- Node.js `24.13.1` (engines `>=24.13.0`), `.nvmrc` = `24`; pnpm `12.11.2` via `"packageManager": "pnpm@12.11.2"`.
- Exact dependency versions, no ranges: `typescript 6.0.3`, `zod 4.6.7`, `vitest 5.0.4`, `msw 3.0.3`, `eslint 10.12.0`, `@eslint/js 10.0.1`, `typescript-eslint 8.71.2`, `eslint-plugin-react-hooks 7.1.1`, `globals 17.13.0`, `prettier 3.9.10`, `@types/node 24.19.2`. Adding any other dependency requires updating contracts section 2 first (not allowed in this plan).
- ESM only, `"type": "module"` everywhere; relative imports use explicit `.ts` extensions; `import type` for type-only imports; named exports only (default exports only in `eslint.config.js` and `vitest.config.ts`).
- Strict TypeScript per `tsconfig.base.json`: no `any`, no `enum`, no `namespace`, no parameter properties, no non-null assertions outside tests.
- `packages/core/src/**` must not import `cloudflare:*`, `hono`, `hono/*`, `@cloudflare/*`, `node:*`, `react`, `react-dom` (ESLint-enforced). Only Web-standard globals: `fetch`, `Request`, `Response`, `Headers`, `URL`, `TextEncoder`, `TextDecoder`, `AbortSignal.timeout`, `atob`, `crypto`.
- Pure core: time (`now`), `fetch`, seeds and token sources are parameters; core never reads `Date.now()` or environment variables except the two documented defaults in "Contract issues" (#15).
- No em dash (U+2014) anywhere: code, comments, test names, docs, commit messages. Enforced by `scripts/check-text.ts`.
- Error messages never contain email content, addresses, tokens or response bodies.
- Tests: Vitest in Node; files `packages/core/test/<module>/<file>.test.ts` mirror `src/`; one `describe` per exported function; floats compared with `toBeCloseTo(x, 9)`; time always injected; fixtures synthetic only (`example.com`, `example.net`, `example.org`, `*.test`), owner `owner@example.test`.
- Files kebab-case, under 300 lines where possible (never over 500).
- Do not edit the contracts document, the design spec, `PRODUCT.md`, or anything under `app/` and `eval/` in this plan.

---

## Contract issues and decisions

Contracts is the source of truth. Where it has a gap or contradiction inside this plan's scope, this plan decides as follows (the lead should fold these back into contracts).

| # | Issue | Decision in this plan |
|---|---|---|
| 1 | `TokenUpdate` is listed for `providers/token.ts` (1.1) but not declared in 4.4. | Declared in `providers/token.ts` with the 7.15 shape `{ accessToken: string; accessExpiresAt: number; refreshToken: string \| null }` and exported from the barrel. (Plan 04 C5 declares an identical local type; it may import this one instead.) |
| 2 | 1.1 lists `applyOwnerAction` in `priors.ts`; 4.8 declares `priorDelta`. | Both exist: `priorDelta(ownerAction, direction)` per 4.8, plus `applyOwnerAction(counts \| null, ownerAction, direction): PriorCounts` (adds the delta, clamps at 0). |
| 3 | `normalizeDecisionResponse` is named in 1.1 without a signature. | `normalizeDecisionResponse(body: unknown, meta: NormalizeMeta): DecisionResult`, `NormalizeMeta = { deployment; requestId; latencyMs }`; throws `DecisionError("invalid_response")`. |
| 4 | `selectReasons` is named in 1.1 without a signature. | `selectReasons(ctx: ReasonContext): Reason[]` with `ReasonContext = { model, prior, guard, signals, action, ceilingApplied, lowConfidence }`. |
| 5 | 5.2 `model_important` uses "legend label at round(importance)", but `DecisionResult` has no legend. | Uses the fixed `IMPORTANCE_LEVELS` (`questions.ts`), lowercased: "Rated high importance". |
| 6 | 4.7 says `reasons` holds caps only, but also "add reason `deny_listed`". | `GuardrailResult.reasons` holds caps only; `deny_listed` is signalled by `denylisted: true` and added by `selectReasons` step 3 (delete only). Otherwise a keep suggestion would say "Sender is on your delete list". |
| 7 | 4.8 "domain prior when present": a row whose counts were undone back to 0 is "present". | A domain row with `deletes + keeps = 0` is treated as absent. |
| 8 | 4.6 `matchesSenderList(address, domain, list)`: if `domain` is the registrable domain, `@news.example.com` can never match. | `@domain` entries are checked against the address host and against `domain` (equal or parent). |
| 9 | 4.5 `ownerPosition`: "Delivered-To when To lacks it" would turn almost every Gmail message into `to`. | Delivered-To addresses join the owner address set (they identify forwarding aliases); then To, then Cc, else `bcc_or_list`. |
| 10 | `SenderHistory.seenCount` "excluding the current page" (4.5) vs 8.2 "context + counts from earlier messages in this page". | Follow 8.2: the caller accumulates; `extractSignals` uses `seenCount` verbatim and does not count the current message (same as plan 04 C11). |
| 11 | 4.9.1 shrink order can still exceed 1,750 chars for pathological input (huge escaped domain). | One extra final step: subject to `""`. |
| 12 | Error `code` values are unspecified except `subrequest_budget`. | `provider_auth`, `provider_config`, `provider_rate_limited`, `provider_unavailable`, `cursor_expired`, `provider_response`, `subrequest_budget`, `scope_missing`, `decision_<kind>`. `DecisionError` options accept `retryable`/`scope`; when omitted they default from `DECISION_ERROR_RULES[kind]` (exported). |
| 13 | 4.12 maps only listed HTTP statuses. | `decisionErrorKindForStatus`: unlisted 4xx are `bad_request` (not retryable), unlisted 5xx are `server` (retryable). |
| 14 | `decideAll` "never rejects": unspecified for non-`DecisionError` throws. | Wrapped as `DecisionError({ kind: "network", cause })` (retryable). |
| 15 | `MaiEngineConfig.now` and `backoffMs(random)` are optional, so a default is needed. | Defaults `Date.now` (latency and Retry-After dates only) and `Math.random` (jitter only). These are the only global reads in core. |
| 16 | Text, util and HTTP helper names are in 1.1 without signatures; ownership vs plan 02 unclear. | Plan 01 owns and defines `text/*`, `util/*`, `http/fetch.ts` (signatures under "Public surface"). Plan 02 owns `http/multipart.ts`, `providers/google/**`, `providers/microsoft/**`, adds the provider-agnostic OAuth functions to `providers/oauth.ts`, and appends its exports to `src/index.ts` and `test/testing.ts`. For amendment A4 (inbox total) plan 02 may add its method to `MailProvider` in `providers/provider.ts`; this plan does not pre-declare it so the name stays plan 02's. |
| 17 | 4.4 lists `GOOGLE_SCOPES`, `MICROSOFT_SCOPES`, `MICROSOFT_CONSENT_URLS` in the shared part of the block. | They live in `providers/oauth.ts` (with `OAuthClientConfig`, `AuthorizeParams`); `OAuthTokens`, `TokenSource`, `TokenUpdate` live in `providers/token.ts`. 4.3's `createGmailProvider`/`createGraphProvider` declarations belong to plan 02's files, not `provider.ts`. |
| 18 | 3.8 `no-console: ["error", { allow: [] }]` is rejected by ESLint 10 ("should NOT have fewer than 1 items"). | `"no-console": "error"` (equivalent). The config uses `defineConfig` from `eslint/config`; a test-file override allows non-null assertions (section 11 allows them in tests). |
| 19 | 10.3: MSW 3 renamed `onUnhandledRequest` to `onUnhandledFrame`, and its `"error"` strategy still lets the request reach the network (verified). A catch-all `http.all("*")` at the end of each handler set also breaks composing several sets in one `server.use`. | `test/setup/msw.ts` answers unhandled requests with `frame.errorWith()` (a 500, no network) and fails the test in `afterEach`. Handler factories do not append a catch-all. |
| 20 | `.prettierignore` (1.1) lacks Markdown: `prettier --check .` fails on the existing docs, `prettier --write .` would rewrite `PRODUCT.md` (lead-owned), and `docs/design/*.html` does not parse. | Adds `*.md`, `docs/design/`, `.impeccable/` to the contract list. |
| 21 | 4.9.3 `z.record(z.enum([...]), prob)`: zod 4 enum-keyed records are exhaustive. | Kept verbatim: when score `probabilities` is present it must contain all five keys `"0".."4"` (live responses do). A test pins this. |
| 22 | 3.8 says check-text fails on `-----BEGIN` blocks; contracts itself contains that string. | Pattern `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`. `scripts/check-text.ts` is created here (it is part of 3.8); plan 06 Task 1 later replaces it with a superset (more secret patterns, `check-text: allow` marker, untracked files). `setup-cf.ts` and `gen-key.ts` are plan 06's. |
| 23 | 10.2 builders: no override shape for nested `headers`. | `makeMailMessage(overrides: MailMessageOverrides)` where `headers` is `Partial<MailHeaders>`; extra helpers `makeMailHeaders`, `TEST_NOW`, `DAY_MS`. |
| 24 | 10.3 Decision-1 mock state is unspecified. | `DecisionMockState` (`requests`, `respond`, `failNext`) + `decisionHandlers(state)` + `makeDecisionResponseBody(probabilities?)` in `test/msw/decision.ts`, re-exported from `@clearbox/core/testing`. |
| 25 | 8.4 CPU benchmark covers "parse, signals, guardrails, state, fusion, SQL"; parse and SQL are other plans. | `test/bench/page-cpu.test.ts` covers signals, guardrails, prior, state, request JSON and fusion. Plan 02 may add mapping to it. |
| 26 | 12.2 (rev 2.1) rewrites the delete-prior templates as "You trashed {n} of {m} from this sender" / "... from {domain}" while keeping reason ids. | Placeholders keep the existing param names, so `selectReasons` and API rendering are unchanged: `prior_sender_deleted` = "You trashed {deletes} of {total} from this sender", `prior_domain_deleted` = "You trashed {deletes} of {total} from {domain}". The `_kept` templates are unchanged. |

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `package.json` | Create | Root scripts (contracts 1.3), shared dev tooling |
| `pnpm-workspace.yaml` | Create | `packages/*`, `app`, `eval` |
| `pnpm-lock.yaml` | Create (generated) | Committed lockfile |
| `.npmrc`, `.nvmrc`, `.editorconfig` | Create | pnpm flags, Node 24, editor defaults |
| `.gitignore` | Modify (replace) | Final content from contracts 3.9 |
| `.prettierrc.json`, `.prettierignore` | Create | Formatting (contracts 3.8, issue #20) |
| `eslint.config.js` | Create | Flat config for the whole repo (contracts 3.8) |
| `tsconfig.base.json` | Create | Shared strict compiler options (contracts 3.5) |
| `scripts/check-text.ts` | Create | Em dash and secret scan of tracked files |
| `packages/core/package.json`, `tsconfig.json`, `vitest.config.ts` | Create | Package manifest and test config (contracts 1.2, 3.5, 3.6) |
| `packages/core/src/model/mail.ts` | Create | Mail types |
| `packages/core/src/model/actions.ts` | Create | Action kinds, ranks, ceilings |
| `packages/core/src/model/reasons.ts` | Create | Reason codes, templates, `renderReason` |
| `packages/core/src/model/constants.ts` | Create | Every constant of contracts 4.13 |
| `packages/core/src/model/errors.ts` | Create | Error classes (contracts 4.12) |
| `packages/core/src/util/rng.ts` | Create | `fnv1a32`, `mulberry32`, `seededShuffle` |
| `packages/core/src/util/concurrency.ts` | Create | `mapWithConcurrency` |
| `packages/core/src/http/fetch.ts` | Create | `FetchLike`, subrequest counter, `countingFetch`, `parseRetryAfter`, `backoffMs` |
| `packages/core/src/text/rfc2047.ts` | Create | `unfoldHeader`, `decodeEncodedWords` |
| `packages/core/src/text/truncate.ts` | Create | `truncateChars`, `collapseWhitespace`, `decodeHtmlEntities` |
| `packages/core/src/text/address.ts` | Create | `parseAddress`, `parseAddressList`, `registrableDomain` |
| `packages/core/src/text/headers.ts` | Create | `headerValue`, `parseAuthResults`, `parseListUnsubscribe`, `isBulkPrecedence`, `isAutoSubmitted` |
| `packages/core/src/providers/provider.ts` | Create | `MailProvider` and page/cursor/result types |
| `packages/core/src/providers/token.ts` | Create | `TokenSource`, `TokenUpdate`, `OAuthTokens` |
| `packages/core/src/providers/oauth.ts` | Create | Shared OAuth config types and scope constants (plan 02 extends) |
| `packages/core/src/policy/policy.ts` | Create | zod policy schema, defaults, sender list and record pattern matching |
| `packages/core/src/priors/priors.ts` | Create | Beta priors |
| `packages/core/src/signals/signals.ts` | Create | `extractSignals` |
| `packages/core/src/guardrails/guardrails.ts` | Create | `evaluateGuardrails` |
| `packages/core/src/decision/engine.ts` | Create | `DecisionEngine`, `DecisionInput`, `DecisionResult` |
| `packages/core/src/decision/state.ts` | Create | `DecisionState`, `buildDecisionState` (token budget) |
| `packages/core/src/decision/questions.ts` | Create | Question texts, seeded option shuffle, request body, seed |
| `packages/core/src/decision/response.ts` | Create | zod response schemas, `normalizeDecisionResponse` |
| `packages/core/src/decision/mai-engine.ts` | Create | `MaiDecisionEngine` |
| `packages/core/src/decision/fake-engine.ts` | Create | `FakeEngine` |
| `packages/core/src/decision/run.ts` | Create | `decideAll` |
| `packages/core/src/fusion/fusion.ts` | Create | `fuse`, `selectReasons` |
| `packages/core/src/calibration/calibration.ts` | Create | `calibrateTauDelete` |
| `packages/core/src/index.ts` | Create | Public barrel |
| `packages/core/test/setup/msw.ts` | Create | Shared MSW server, unhandled-request guard |
| `packages/core/test/fixtures/builders.ts` | Create | Synthetic builders (contracts 10.2) |
| `packages/core/test/fixtures/decision/*.json` | Create | Synthetic Decision-1 responses and errors |
| `packages/core/test/msw/decision.ts` | Create | Decision-1 MSW handler factory |
| `packages/core/test/testing.ts` | Create | `@clearbox/core/testing` entry |
| `packages/core/test/**/*.test.ts` | Create | Unit tests mirroring `src/` plus `bench/page-cpu.test.ts` |

## Public surface of `@clearbox/core` (what later plans consume)

All names below are exported from `packages/core/src/index.ts` (Task 18). Types are `export type`.

- **Model:** types `ProviderKind`, `AccountId`, `AccountRef`, `MailAddress`, `MailCategory`, `OwnerPosition`, `AuthVerdict`, `MailMessage`, `MailHeaders`; `ActionKind`, `SuggestedAction`, `Ceiling`, `ActionDistribution`; values `ACTION_KINDS`, `SUGGESTED_ACTIONS`, `ACTION_RANK`, `isAllowedByCeiling(action, ceiling): boolean`, `minCeiling(a, b): Ceiling`; `REASON_CODES`, `ReasonCode`, `ReasonParams`, `Reason`, `REASON_TEMPLATES`, `renderReason(reason): string`; every constant of contracts 4.13 by name.
- **Errors:** `ClearboxError(code, message?, { cause? })`; `ProviderAuthError({ provider, reason })`, `ProviderConfigError({ provider, reason })`, `ProviderRateLimitError({ provider, retryAfterMs })`, `ProviderUnavailableError({ provider, retryAfterMs? })`, `CursorExpiredError({ provider, cursorKind })`, `ProviderResponseError({ provider, status })`, `SubrequestBudgetError({ used, limit })`, `ScopeMissingError({ provider, granted })`, `DecisionError({ kind, status?, retryable?, scope?, retryAfterMs?, requestId? })`; all options also take `message?`, `cause?`. `DecisionErrorKind`, `DecisionErrorOptions`, `DECISION_ERROR_RULES`.
- **HTTP and util:** `FetchLike`, `SubrequestCounter`, `createSubrequestCounter(limit, alreadyUsed = 0)`, `countingFetch(base, counter): FetchLike`, `parseRetryAfter(headers, now): number | null`, `backoffMs(attempt, random = Math.random)`, `fnv1a32(text)`, `mulberry32(seed)`, `seededShuffle(items, seed)`, `mapWithConcurrency(items, limit, fn)`.
- **Text:** `unfoldHeader(value)`, `decodeEncodedWords(input)`, `parseAddress(raw: string | null): MailAddress`, `parseAddressList(raw: string | null): MailAddress[]` (only parseable entries), `registrableDomain(hostOrAddress): string`, `RawHeader { name; value }`, `headerValue(headers: readonly RawHeader[], name): string | null`, `ParsedAuthResults { authservId: string | null; spf; dkim; dmarc }`, `parseAuthResults(value: string | null)`, `ListUnsubscribe { https: string[]; mailto: string[] }`, `parseListUnsubscribe(value)`, `isBulkPrecedence(value)`, `isAutoSubmitted(value)`, `truncateChars(text, max)`, `collapseWhitespace(text)`, `decodeHtmlEntities(text)`.
- **Providers (interfaces only):** `MailProvider`, `ProviderDeps`, `GraphProviderDeps`, `BootstrapResult`, `InboxPage`, `SentItem`, `SentPage`, `ChangesPage`, `BackfillCursor`, `SentCursor`, `IncrementalCursor`, `ActionErrorCode`, `ActionResult`, `RestoreFrom`, `RestoreItem`, `TokenSource`, `TokenUpdate`, `OAuthTokens`, `OAuthClientConfig`, `AuthorizeParams`, `GOOGLE_SCOPES`, `MICROSOFT_SCOPES`, `MICROSOFT_CONSENT_URLS`.
- **Pipeline:** `SenderHistory`, `SignalContext`, `Signals`, `extractSignals(msg, history, ctx)`; `SenderEntrySchema`, `PolicySchema`, `Policy`, `DEFAULT_POLICY`, `parsePolicy(json: string | null)`, `matchesSenderList(address, domain, list)`, `matchRecordPattern(subject, snippet, patterns)`; `GuardrailInput`, `GuardrailResult`, `evaluateGuardrails(input, policy)`; `PriorCounts`, `Prior`, `priorKeyForSender`, `priorKeyForDomain`, `selectPrior(sender, domain, address, domainName)`, `priorDelta(ownerAction, direction)`, `applyOwnerAction(counts, ownerAction, direction)`.
- **Decision-1:** `DecisionFlags`, `DecisionResult`, `DecisionInput`, `DecisionEngine`; `PastDecision`, `DecisionState`, `BuildStateInput`, `buildDecisionState(input)`; `ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `DecisionQuestions`, `DecisionRequestBody`, `IMPORTANCE_LEVELS`, `DECISION_QUESTIONS`, `buildDecisionQuestions(seed)`, `buildDecisionRequest(state, deployment, seed)`, `decisionSeed(accountId, providerMessageId)`; `ChoiceAnswerSchema`, `ScoreAnswerSchema`, `NoulAnswerSchema`, `DecisionResponseSchema`, `DecisionResponse`, `NormalizeMeta`, `normalizeDecisionResponse(body, meta)`; `MaiEngineConfig`, `MaiDecisionEngine`, `DECISION_PATH`, `decisionErrorKindForStatus(status)`; `FakeEngineOptions`, `FakeEngine`; `DecisionOutcome`, `decideAll(engine, inputs, concurrency)`.
- **Fusion and calibration:** `Thresholds`, `FusionInput`, `Suggestion`, `ReasonContext`, `fuse(input)`, `selectReasons(ctx)`; `CalibrationSample`, `CalibrationPoint`, `CalibrationResult`, `calibrateTauDelete(samples, currentTau)`.
- **`@clearbox/core/testing`:** `TEST_NOW`, `DAY_MS`, `makeMailHeaders`, `makeMailMessage`, `MailMessageOverrides`, `makeSenderHistory`, `makeSignals`, `makePolicy`, `makeDecisionResult`, `DecisionMockState`, `DecisionMockOptions`, `DecisionFailSpec`, `decisionHandlers`, `makeDecisionResponseBody`. Plan 02 appends `makeGmailMetadata`, `makeGraphMessage`, `FakeMailbox` and its handler factories.

All commands below run from the repository root unless stated otherwise.

---

### Task 1: Workspace scaffold, tooling and core package shell

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `tsconfig.base.json`, `scripts/check-text.ts`
- Modify (replace whole file): `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/test/setup/msw.ts`
- Test: `packages/core/test/setup/msw.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: root scripts `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`; package `@clearbox/core` with exports `"."` -> `./src/index.ts` and `"./testing"` -> `./test/testing.ts` (both files are created in later tasks); `server` (MSW `SetupServer`) exported from `packages/core/test/setup/msw.ts`, loaded for every core test by `vitest.config.ts`.

- [ ] **Step 1: Check the toolchain**

Run: `node --version && corepack enable && pnpm --version`
Expected: `v24.13.1` (any `v24.x >= 24.13.0` works) and `12.11.2`. If pnpm differs, run `corepack prepare pnpm@12.11.2 --activate`.

- [ ] **Step 2: Create the root files**

`package.json` (contracts 1.3, Prettier-formatted):

```json
{
  "name": "clearbox",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.11.2",
  "engines": {
    "node": ">=24.13.0"
  },
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

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - app
  - eval
```

`.npmrc`:

```ini
engine-strict=true
auto-install-peers=true
```

`.nvmrc`:

```text
24
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.gitignore` (replace the existing file entirely; contracts 3.9, rev 2.2; plan 06 later appends `eval/private/`):

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
```

`.prettierrc.json`:

```json
{ "printWidth": 110, "singleQuote": false, "trailingComma": "all", "semi": true, "arrowParens": "always" }
```

`.prettierignore` (contract list plus issue #20):

```text
pnpm-lock.yaml
.cloudflare/
dist/
coverage/
*.md
docs/design/
.impeccable/
```

`tsconfig.base.json` (contracts 3.5):

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

`eslint.config.js` (contracts 3.8, issue #18):

```js
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/.cloudflare/**", "**/coverage/**", "pnpm-lock.yaml"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.es2024 } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Contracts 3.8 (rev 2.2): plain "error"; ESLint 10 rejects an empty allow list.
      "no-console": "error",
    },
  },
  {
    files: ["app/src/web/**"],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["packages/core/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["cloudflare:*", "hono", "hono/*", "@cloudflare/*", "node:*", "react", "react-dom"],
              message: "@clearbox/core is pure TypeScript: no Cloudflare, Hono, Node or React imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/web/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../worker/*", "**/worker/**", "cloudflare:*", "hono"],
              message: "The SPA must not import Worker code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/worker/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "**/web/**"], message: "The Worker must not import SPA code." },
          ],
        },
      ],
    },
  },
  {
    files: ["app/src/worker/log.ts", "scripts/**", "eval/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
  {
    files: ["**/test/**", "**/*.config.ts", "**/*.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
```

`scripts/check-text.ts` (contracts 3.8, issue #22):

```ts
// Fails when any tracked text file contains an em dash, a private-key block or a real-looking Decision-1 key.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: "em dash (U+2014)", pattern: /\u2014/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Decision-1 key", pattern: /AZURE_DECISION_KEY=[A-Za-z0-9]{20,}/ },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "");

const problems: string[] = [];
for (const file of files) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // deleted in the working tree but still tracked
  }
  if (bytes.includes(0)) continue; // binary
  const lines = bytes.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) problems.push(`${file}:${String(index + 1)}: ${rule.name}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`check-text found ${String(problems.length)} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`check-text: ${String(files.length)} tracked files clean`);
```

- [ ] **Step 3: Create the core package shell**

`packages/core/package.json` (contracts 1.2):

```json
{
  "name": "@clearbox/core",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./test/testing.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "4.6.7"
  },
  "devDependencies": {
    "vitest": "5.0.4",
    "msw": "3.0.3"
  }
}
```

`packages/core/tsconfig.json` (contracts 3.5):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/core/vitest.config.ts` (contracts 3.6):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", setupFiles: ["test/setup/msw.ts"] },
});
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: ends with `Done in ...`; `pnpm-lock.yaml` is created; `packages/core/node_modules` contains `msw`, `vitest`, `zod`. (`app` and `eval` do not exist yet; pnpm ignores workspace globs that match nothing.)

- [ ] **Step 5: Write the failing harness test**

`packages/core/test/setup/msw.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "./msw.ts";

describe("shared MSW server", () => {
  it("serves handlers added with server.use", async () => {
    server.use(http.get("https://api.example.test/ping", () => HttpResponse.json({ pong: true })));
    const res = await fetch("https://api.example.test/ping");
    expect(await res.json()).toEqual({ pong: true });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/setup/msw.test.ts`
Expected: FAIL with `Error: Cannot find module '.../packages/core/test/setup/msw.ts'` (the setup file does not exist yet).

- [ ] **Step 7: Write the shared MSW setup**

MSW 3 renamed `onUnhandledRequest` to `onUnhandledFrame`, and its `"error"` strategy still lets an unmatched request reach the real network. The guard below answers unmatched requests with a 500 (no network) and fails the test in `afterEach`.

`packages/core/test/setup/msw.ts`:

```ts
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Shared MSW server for core tests. Tests add handlers with server.use(...). */
export const server = setupServer();

const unhandled: string[] = [];

beforeAll(() => {
  // MSW 3 renamed onUnhandledRequest to onUnhandledFrame, and its "error" strategy still lets the request reach
  // the network. errorWith() answers it with a 500 instead (no network); recording the message fails the test
  // in afterEach even when the code under test handles that 500.
  server.listen({
    async onUnhandledFrame({ frame }) {
      const message = await frame.getUnhandledMessage();
      unhandled.push(message);
      frame.errorWith(new Error(message));
    },
  });
});

afterEach(() => {
  server.resetHandlers();
  if (unhandled.length > 0) {
    const list = unhandled.splice(0).join("\n");
    throw new Error(`Unhandled request\n${list}`);
  }
});

afterAll(() => {
  server.close();
});
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/setup/msw.test.ts`
Expected: PASS, `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 9: Stage the task files and verify lint, format and the text scan**

`check-text` scans `git ls-files`, so stage exactly this task's files first (never `git add -A`: the repository root holds lead-owned untracked files).

Run: `git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .nvmrc .editorconfig .gitignore .prettierrc.json .prettierignore eslint.config.js tsconfig.base.json scripts/check-text.ts packages/core && pnpm lint && pnpm format:check && pnpm typecheck`
Expected: ESLint prints nothing, then `check-text: <N> tracked files clean`; `All matched files use Prettier code style!`; `tsc -p tsconfig.json` exits 0.

Then prove the scan catches violations:

Run: `node -e "require('fs').writeFileSync('zz-check.txt', 'bad \u2014 dash\n')" && git add zz-check.txt && node scripts/check-text.ts; echo "exit $?"; git rm -q --cached zz-check.txt && rm zz-check.txt`
Expected: `check-text found 1 problem(s):`, `zz-check.txt:1: em dash (U+2014)`, `exit 1`.

- [ ] **Step 10: Commit**

```bash
git commit -m "chore: scaffold pnpm workspace, tooling and @clearbox/core shell"
```

---

### Task 2: Core model types, actions, reasons and constants

**Files:**
- Create: `packages/core/src/model/mail.ts`, `packages/core/src/model/actions.ts`, `packages/core/src/model/reasons.ts`, `packages/core/src/model/constants.ts`
- Test: `packages/core/test/model/actions.test.ts`, `packages/core/test/model/reasons.test.ts`, `packages/core/test/model/constants.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (contracts 4.1, 4.2, 4.11, 4.13 verbatim):
  - `mail.ts`: types `ProviderKind = "gmail" | "outlook"`, `AccountId`, `AccountRef`, `MailAddress { address: string | null; name: string | null }`, `MailCategory`, `OwnerPosition = "to" | "cc" | "bcc_or_list"`, `AuthVerdict = "pass" | "fail" | "none"`, `MailMessage`, `MailHeaders`.
  - `actions.ts`: `ActionKind`, `SuggestedAction`, `Ceiling`, `ActionDistribution = Record<SuggestedAction, number>`, `ACTION_KINDS`, `SUGGESTED_ACTIONS`, `ACTION_RANK`, `isAllowedByCeiling(action: SuggestedAction, ceiling: Ceiling): boolean`, `minCeiling(a: Ceiling, b: Ceiling): Ceiling`.
  - `reasons.ts`: `REASON_CODES`, `ReasonCode`, `ReasonParams`, `Reason { code; params }`, `REASON_TEMPLATES`, `renderReason(reason: Reason): string` (unknown `{placeholders}` are left as they are). Templates are 4.11 with the 12.2 "trashed" wording for `prior_sender_deleted` and `prior_domain_deleted` (issue #26).
  - `constants.ts`: every constant of contracts 4.13 with the same name and value.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/model/actions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_RANK,
  SUGGESTED_ACTIONS,
  isAllowedByCeiling,
  minCeiling,
  type Ceiling,
  type SuggestedAction,
} from "../../src/model/actions.ts";

describe("ACTION_RANK", () => {
  it("orders keep < archive < delete", () => {
    expect(ACTION_RANK.keep).toBeLessThan(ACTION_RANK.archive);
    expect(ACTION_RANK.archive).toBeLessThan(ACTION_RANK.delete);
    expect(ACTION_KINDS).toEqual(["delete", "archive", "keep"]);
    expect(SUGGESTED_ACTIONS).toEqual(["delete", "archive", "keep", "unsure"]);
  });
});

describe("isAllowedByCeiling", () => {
  const cases: [SuggestedAction, Ceiling, boolean][] = [
    ["delete", "delete", true],
    ["archive", "delete", true],
    ["keep", "delete", true],
    ["unsure", "delete", true],
    ["delete", "archive", false],
    ["archive", "archive", true],
    ["keep", "archive", true],
    ["unsure", "archive", true],
    ["delete", "keep", false],
    ["archive", "keep", false],
    ["keep", "keep", true],
    ["unsure", "keep", true],
  ];
  it.each(cases)("%s under ceiling %s -> %s", (action, ceiling, expected) => {
    expect(isAllowedByCeiling(action, ceiling)).toBe(expected);
  });
});

describe("minCeiling", () => {
  it("returns the lower-ranked ceiling", () => {
    expect(minCeiling("delete", "archive")).toBe("archive");
    expect(minCeiling("archive", "delete")).toBe("archive");
    expect(minCeiling("keep", "archive")).toBe("keep");
    expect(minCeiling("delete", "delete")).toBe("delete");
  });
});
```

`packages/core/test/model/reasons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { REASON_CODES, REASON_TEMPLATES, renderReason } from "../../src/model/reasons.ts";

describe("REASON_TEMPLATES", () => {
  it("has exactly one template per reason code", () => {
    expect(Object.keys(REASON_TEMPLATES).sort()).toEqual([...REASON_CODES].sort());
  });

  it("contains no em dash", () => {
    for (const template of Object.values(REASON_TEMPLATES)) {
      expect(template).not.toContain("\u2014");
    }
  });
});

describe("renderReason", () => {
  it("renders a template without params", () => {
    expect(renderReason({ code: "list_unsubscribe", params: {} })).toBe("Has an unsubscribe link");
  });

  it("replaces every placeholder", () => {
    expect(
      renderReason({
        code: "prior_domain_deleted",
        params: { deletes: 14, total: 14, domain: "example.com" },
      }),
    ).toBe("You trashed 14 of 14 from example.com");
    expect(renderReason({ code: "prior_sender_deleted", params: { deletes: 3, total: 4 } })).toBe(
      "You trashed 3 of 4 from this sender",
    );
    expect(renderReason({ code: "low_open_rate", params: { openPct: 0, seen: 37 } })).toBe(
      "Opened 0% of 37 emails from this sender",
    );
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderReason({ code: "guard_too_recent", params: {} })).toBe(
      "Received less than {minAgeDays} days ago",
    );
  });
});
```

`packages/core/test/model/constants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as C from "../../src/model/constants.ts";

describe("constants", () => {
  it("match contracts 4.13 for the values core logic depends on", () => {
    expect(C.PRIOR_MIN_N).toBe(3);
    expect(C.PRIOR_LAMBDA_K).toBe(5);
    expect(C.FLAG_THRESHOLD).toBe(0.7);
    expect(C.DELETE_MARGIN).toBe(0.2);
    expect(C.MIN_CONFIDENCE).toBe(0.55);
    expect(C.MAX_REASONS).toBe(3);
    expect([C.TAU_DELETE_DEFAULT, C.TAU_DELETE_MIN, C.TAU_DELETE_MAX, C.TAU_STEP]).toEqual([
      0.8, 0.8, 0.99, 0.01,
    ]);
    expect(C.DECISION_RETRY_DELAYS_MS).toEqual([300_000, 1_800_000]);
    expect(C.DECISION_STATE_MAX_CHARS).toBe(1750);
    expect(C.TICK_SUBREQUEST_LIMIT).toBe(45);
    expect(C.BACKOFF_MAX_MS).toBe(21_600_000);
    expect(C.UNDO_WINDOW_MS).toBe(86_400_000);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/core exec vitest run test/model`
Expected: FAIL, 3 failed suites, each `Error: Cannot find module '../../src/model/<file>.ts'`.

- [ ] **Step 3: Write the model files**

`packages/core/src/model/mail.ts`:

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
  | "primary"
  | "promotions"
  | "social"
  | "updates"
  | "forums" // Gmail CATEGORY_*
  | "focused"
  | "other"; // Outlook inferenceClassification

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
  /** Lowercased addresses. */
  to: string[];
  cc: string[];
  /** Gmail Delivered-To values; [] for Graph. */
  deliveredTo: string[];
  /** Decoded, unfolded, "" when absent. */
  subject: string;
  /** Plain text, entities decoded, whitespace collapsed, max 255 chars. */
  snippet: string;
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

`packages/core/src/model/actions.ts`:

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

`packages/core/src/model/reasons.ts`:

```ts
export const REASON_CODES = [
  "guard_starred",
  "guard_replied",
  "guard_allowlist",
  "guard_too_recent",
  "guard_correspondent",
  "guard_attachment",
  "guard_record_pattern",
  "deny_listed",
  "prior_sender_deleted",
  "prior_sender_kept",
  "prior_domain_deleted",
  "prior_domain_kept",
  "low_open_rate",
  "list_unsubscribe",
  "bulk_mail",
  "auto_sent",
  "category",
  "flag_expired",
  "flag_record",
  "flag_human",
  "old_unread",
  "auth_failed",
  "model_important",
  "model_unavailable",
  "low_confidence",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonParams = Readonly<Record<string, string | number>>;
export interface Reason {
  code: ReasonCode;
  params: ReasonParams;
}

/** English templates; {name} placeholders are replaced by params. No em dashes. "trashed" wording per contracts 12.2. */
export const REASON_TEMPLATES: Readonly<Record<ReasonCode, string>> = {
  guard_starred: "You starred or flagged this email",
  guard_replied: "You replied in this conversation",
  guard_allowlist: "Sender is on your keep list",
  guard_too_recent: "Received less than {minAgeDays} days ago",
  guard_correspondent: "You have written to this sender",
  guard_attachment: "Has attachments",
  guard_record_pattern: "Looks like a record ({pattern})",
  deny_listed: "Sender is on your delete list",
  prior_sender_deleted: "You trashed {deletes} of {total} from this sender",
  prior_sender_kept: "You kept {keeps} of {total} from this sender",
  prior_domain_deleted: "You trashed {deletes} of {total} from {domain}",
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

/** Replaces every {name} placeholder with params[name]; unknown placeholders are left as they are. */
export function renderReason(reason: Reason): string {
  return REASON_TEMPLATES[reason.code].replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    const value = reason.params[name];
    return value === undefined ? whole : String(value);
  });
}
```

`packages/core/src/model/constants.ts`:

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
export const BUDGET_ROWS_PER_DAY = 90_000; // 90% cap for everything
export const INGEST_STOP_ROWS = 65_000; // ticks are not claimed at or above this
export const PURGE_STOP_ROWS = 80_000; // nightly purge stops at or above this
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

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/model`
Expected: PASS, `Test Files  3 passed (3)`, `Tests  20 passed (20)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: both exit 0 with no output besides the `tsc` banner.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/model packages/core/test/model
git commit -m "feat(core): add mail model, actions, reasons and constants"
```

---

### Task 3: Error classes

**Files:**
- Create: `packages/core/src/model/errors.ts`
- Test: `packages/core/test/model/errors.test.ts`

**Interfaces:**
- Consumes: `ProviderKind` from `model/mail.ts` (Task 2).
- Produces (contracts 4.12, issue #12): `ClearboxError` (`constructor(code: string, message?: string, options?: { cause?: unknown })`, readonly `code`, `name` = class name); subclasses taking ONE options object of their readonly fields plus `message?`, `cause?`:
  - `ProviderAuthError({ provider, reason })` code `provider_auth`
  - `ProviderConfigError({ provider, reason })` code `provider_config`
  - `ProviderRateLimitError({ provider, retryAfterMs: number })` code `provider_rate_limited`
  - `ProviderUnavailableError({ provider, retryAfterMs?: number | null })` code `provider_unavailable` (default `null`)
  - `CursorExpiredError({ provider, cursorKind: "backfill" | "sent" | "incremental" })` code `cursor_expired`
  - `ProviderResponseError({ provider, status })` code `provider_response`
  - `SubrequestBudgetError({ used, limit })` code `subrequest_budget`
  - `ScopeMissingError({ provider, granted: string[] })` code `scope_missing`
  - `DecisionError({ kind, status?, retryable?, scope?, retryAfterMs?, requestId? })` code `decision_<kind>`; `status`, `retryAfterMs`, `requestId` default `null`; `retryable` and `scope` default from `DECISION_ERROR_RULES[kind]`.
  - `DecisionErrorKind`, `DecisionErrorOptions`, `DECISION_ERROR_RULES: Readonly<Record<DecisionErrorKind, { retryable: boolean; scope: "config" | "item" }>>`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/model/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ClearboxError,
  CursorExpiredError,
  DECISION_ERROR_RULES,
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ScopeMissingError,
  SubrequestBudgetError,
  type DecisionErrorKind,
} from "../../src/model/errors.ts";

describe("ClearboxError", () => {
  it("carries code, message, name and cause", () => {
    const cause = new Error("root");
    const error = new ClearboxError("some_code", "Some message", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("some_code");
    expect(error.message).toBe("Some message");
    expect(error.name).toBe("ClearboxError");
    expect(error.cause).toBe(cause);
  });

  it("defaults the message to the code", () => {
    expect(new ClearboxError("x_code").message).toBe("x_code");
  });
});

describe("provider errors", () => {
  it("set code, name and fields", () => {
    const auth = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    expect(auth).toBeInstanceOf(ClearboxError);
    expect([auth.code, auth.name, auth.provider, auth.reason]).toEqual([
      "provider_auth",
      "ProviderAuthError",
      "gmail",
      "invalid_grant",
    ]);

    const config = new ProviderConfigError({ provider: "outlook", reason: "AADSTS7000222" });
    expect([config.code, config.reason]).toEqual(["provider_config", "AADSTS7000222"]);

    const rate = new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 30_000 });
    expect([rate.code, rate.retryAfterMs]).toEqual(["provider_rate_limited", 30_000]);

    const unavailable = new ProviderUnavailableError({ provider: "gmail" });
    expect([unavailable.code, unavailable.retryAfterMs]).toEqual(["provider_unavailable", null]);

    const cursor = new CursorExpiredError({ provider: "gmail", cursorKind: "incremental" });
    expect([cursor.code, cursor.cursorKind]).toEqual(["cursor_expired", "incremental"]);

    const response = new ProviderResponseError({ provider: "gmail", status: 418 });
    expect([response.code, response.status]).toEqual(["provider_response", 418]);

    const scope = new ScopeMissingError({ provider: "gmail", granted: ["openid"] });
    expect([scope.code, scope.granted]).toEqual(["scope_missing", ["openid"]]);

    const budget = new SubrequestBudgetError({ used: 45, limit: 45 });
    expect([budget.code, budget.used, budget.limit]).toEqual(["subrequest_budget", 45, 45]);
  });

  it("never puts user data in default messages", () => {
    const error = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    expect(error.message).toBe("gmail authorization failed (invalid_grant)");
  });
});

describe("DecisionError", () => {
  const expected: [DecisionErrorKind, boolean, "config" | "item"][] = [
    ["auth", false, "config"],
    ["deployment_not_found", false, "config"],
    ["bad_request", false, "item"],
    ["too_large", false, "item"],
    ["unprocessable", false, "item"],
    ["invalid_response", false, "item"],
    ["rate_limited", true, "item"],
    ["server", true, "item"],
    ["timeout", true, "item"],
    ["network", true, "item"],
  ];

  it.each(expected)("%s -> retryable %s, scope %s", (kind, retryable, scope) => {
    const error = new DecisionError({ kind });
    expect(error.retryable).toBe(retryable);
    expect(error.scope).toBe(scope);
    expect(error.code).toBe(`decision_${kind}`);
    expect(error.status).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    expect(error.requestId).toBeNull();
    expect(DECISION_ERROR_RULES[kind]).toEqual({ retryable, scope });
  });

  it("keeps explicit fields", () => {
    const error = new DecisionError({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 2000,
      requestId: "req-1",
    });
    expect([error.status, error.retryAfterMs, error.requestId]).toEqual([429, 2000, "req-1"]);
    expect(error.message).toBe("Decision-1 request failed (rate_limited, HTTP 429)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/model/errors.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/model/errors.ts'`.

- [ ] **Step 3: Write the error classes**

`packages/core/src/model/errors.ts`:

```ts
import type { ProviderKind } from "./mail.ts";

interface ErrorExtras {
  message?: string;
  cause?: unknown;
}

function causeOption(extras: ErrorExtras): { cause?: unknown } {
  return "cause" in extras ? { cause: extras.cause } : {};
}

/** Base class for every error thrown by @clearbox/core. Messages never carry user data. */
export class ClearboxError extends Error {
  readonly code: string;

  constructor(code: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Refresh token invalid or user interaction required. Account -> needs_reauth. */
export class ProviderAuthError extends ClearboxError {
  readonly provider: ProviderKind;
  /** e.g. "invalid_grant", "interaction_required", "unauthorized", "domain_policy", "admin_consent_required", "AADSTS70008". */
  readonly reason: string;

  constructor(options: { provider: ProviderKind; reason: string } & ErrorExtras) {
    super(
      "provider_auth",
      options.message ?? `${options.provider} authorization failed (${options.reason})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.reason = options.reason;
  }
}

/** Owner configuration problem (client id/secret wrong or expired). Account -> config_error; app issue raised. */
export class ProviderConfigError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly reason: string;

  constructor(options: { provider: ProviderKind; reason: string } & ErrorExtras) {
    super(
      "provider_config",
      options.message ?? `${options.provider} client configuration rejected (${options.reason})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.reason = options.reason;
  }
}

export class ProviderRateLimitError extends ClearboxError {
  readonly provider: ProviderKind;
  /** From Retry-After, else backoffMs(attempt). */
  readonly retryAfterMs: number;

  constructor(options: { provider: ProviderKind; retryAfterMs: number } & ErrorExtras) {
    super(
      "provider_rate_limited",
      options.message ?? `${options.provider} rate limited`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderUnavailableError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly retryAfterMs: number | null;

  constructor(options: { provider: ProviderKind; retryAfterMs?: number | null } & ErrorExtras) {
    super("provider_unavailable", options.message ?? `${options.provider} unavailable`, causeOption(options));
    this.provider = options.provider;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Incremental cursor expired (Gmail history 404, Graph syncStateNotFound / 410) or backfill page token rejected (400). */
export class CursorExpiredError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly cursorKind: "backfill" | "sent" | "incremental";

  constructor(
    options: { provider: ProviderKind; cursorKind: "backfill" | "sent" | "incremental" } & ErrorExtras,
  ) {
    super(
      "cursor_expired",
      options.message ?? `${options.provider} ${options.cursorKind} cursor expired`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.cursorKind = options.cursorKind;
  }
}

/** Unexpected status or response shape. Not retryable within the tick; counts as a tick failure. */
export class ProviderResponseError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly status: number;

  constructor(options: { provider: ProviderKind; status: number } & ErrorExtras) {
    super(
      "provider_response",
      options.message ?? `${options.provider} unexpected response (${String(options.status)})`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.status = options.status;
  }
}

/** Thrown by countingFetch when a tick or request would exceed its subrequest limit. */
export class SubrequestBudgetError extends ClearboxError {
  readonly used: number;
  readonly limit: number;

  constructor(options: { used: number; limit: number } & ErrorExtras) {
    super(
      "subrequest_budget",
      options.message ?? `Subrequest budget exhausted (${String(options.used)} of ${String(options.limit)})`,
      causeOption(options),
    );
    this.used = options.used;
    this.limit = options.limit;
  }
}

/** Connect flow: granted scopes do not include the required scope. */
export class ScopeMissingError extends ClearboxError {
  readonly provider: ProviderKind;
  readonly granted: string[];

  constructor(options: { provider: ProviderKind; granted: string[] } & ErrorExtras) {
    super(
      "scope_missing",
      options.message ?? `${options.provider} required scope not granted`,
      causeOption(options),
    );
    this.provider = options.provider;
    this.granted = options.granted;
  }
}

export type DecisionErrorKind =
  | "auth" // 401, 403          scope config, not retryable
  | "deployment_not_found" // 404              scope config, not retryable
  | "bad_request" // 400              scope item,   not retryable
  | "too_large" // 413              scope item,   not retryable
  | "unprocessable" // 422              scope item,   not retryable
  | "invalid_response" // zod failure      scope item,   not retryable
  | "rate_limited" // 429              scope item,   retryable
  | "server" // 408, 500-504     scope item,   retryable
  | "timeout" // > timeoutMs      scope item,   retryable
  | "network"; // fetch threw      scope item,   retryable

/** Default retryability and scope per kind (contracts 4.12). */
export const DECISION_ERROR_RULES: Readonly<
  Record<DecisionErrorKind, { retryable: boolean; scope: "config" | "item" }>
> = {
  auth: { retryable: false, scope: "config" },
  deployment_not_found: { retryable: false, scope: "config" },
  bad_request: { retryable: false, scope: "item" },
  too_large: { retryable: false, scope: "item" },
  unprocessable: { retryable: false, scope: "item" },
  invalid_response: { retryable: false, scope: "item" },
  rate_limited: { retryable: true, scope: "item" },
  server: { retryable: true, scope: "item" },
  timeout: { retryable: true, scope: "item" },
  network: { retryable: true, scope: "item" },
};

export interface DecisionErrorOptions extends ErrorExtras {
  kind: DecisionErrorKind;
  status?: number | null;
  /** Defaults to DECISION_ERROR_RULES[kind].retryable. */
  retryable?: boolean;
  /** Defaults to DECISION_ERROR_RULES[kind].scope. */
  scope?: "config" | "item";
  retryAfterMs?: number | null;
  requestId?: string | null;
}

export class DecisionError extends ClearboxError {
  readonly kind: DecisionErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  /** "config": stop the tick and raise an app issue; "item": affects this message only. */
  readonly scope: "config" | "item";
  /** retry-after-ms, then retry-after, else null. */
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;

  constructor(options: DecisionErrorOptions) {
    const status = options.status ?? null;
    super(
      `decision_${options.kind}`,
      options.message ??
        `Decision-1 request failed (${options.kind}${status === null ? "" : `, HTTP ${String(status)}`})`,
      causeOption(options),
    );
    const rule = DECISION_ERROR_RULES[options.kind];
    this.kind = options.kind;
    this.status = status;
    this.retryable = options.retryable ?? rule.retryable;
    this.scope = options.scope ?? rule.scope;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.requestId = options.requestId ?? null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/model/errors.test.ts`
Expected: PASS, `Tests  15 passed (15)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/model/errors.ts packages/core/test/model/errors.test.ts
git commit -m "feat(core): add ClearboxError hierarchy and DecisionError rules"
```

---

### Task 4: Randomness, concurrency and HTTP utilities

**Files:**
- Create: `packages/core/src/util/rng.ts`, `packages/core/src/util/concurrency.ts`, `packages/core/src/http/fetch.ts`
- Test: `packages/core/test/util/rng.test.ts`, `packages/core/test/util/concurrency.test.ts`, `packages/core/test/http/fetch.test.ts`

**Interfaces:**
- Consumes: `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS` (Task 2); `SubrequestBudgetError` (Task 3); `server` from `test/setup/msw.ts` (Task 1).
- Produces (contracts 4.15):
  - `fnv1a32(text: string): number` (unsigned 32-bit FNV-1a over UTF-8 bytes)
  - `mulberry32(seed: number): () => number` (floats in [0, 1))
  - `seededShuffle<T>(items: readonly T[], seed: number): T[]` (Fisher-Yates with `mulberry32(seed)`, returns a new array)
  - `mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` (keeps order; rejects with the first error; `RangeError` for `limit < 1`)
  - `FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>`
  - `SubrequestCounter { readonly used; readonly limit; reserve(n?: number): void }`, `createSubrequestCounter(limit: number, alreadyUsed = 0): SubrequestCounter`
  - `countingFetch(base: FetchLike, counter: SubrequestCounter): FetchLike` (reserves 1 before each call; a failed reservation rejects with `SubrequestBudgetError`)
  - `parseRetryAfter(headers: Headers, now: number): number | null` (`retry-after-ms` first, then `retry-after` seconds or HTTP date, never negative)
  - `backoffMs(attempt: number, random: () => number = Math.random): number`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/util/rng.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fnv1a32, mulberry32, seededShuffle } from "../../src/util/rng.ts";

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    expect(fnv1a32("\u00e9")).toBe(fnv1a32("\u00e9"));
    expect(fnv1a32("\u00e9")).not.toBe(fnv1a32("e"));
  });
});

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("differs between seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("seededShuffle", () => {
  const items = ["delete", "archive", "keep", "unsure"] as const;

  it("returns a permutation and leaves the input untouched", () => {
    const input = [...items];
    const out = seededShuffle(input, 7);
    expect([...out].sort()).toEqual([...items].sort());
    expect(input).toEqual([...items]);
  });

  it("is deterministic for a seed", () => {
    expect(seededShuffle(items, 123)).toEqual(seededShuffle(items, 123));
  });

  it("produces every ordering across many seeds (no stuck positions)", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 2000; seed++) orders.add(seededShuffle(items, seed).join(","));
    expect(orders.size).toBe(24);
  });

  it("handles empty and single-item arrays", () => {
    expect(seededShuffle([], 1)).toEqual([]);
    expect(seededShuffle(["x"], 1)).toEqual(["x"]);
  });
});
```

`packages/core/test/util/concurrency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/util/concurrency.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("keeps input order in the results", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${String(i)}:${String(ms)}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than limit calls at once", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, () => deferred());
    const run = mapWithConcurrency(gates, 4, async (gate) => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return true;
    });
    for (const gate of gates) {
      await Promise.resolve();
      gate.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await run;
    expect(peak).toBe(4);
  });

  it("returns [] for no items", async () => {
    expect(await mapWithConcurrency([], 3, () => Promise.resolve(1))).toEqual([]);
  });

  it("rejects with the first error", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) =>
        n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
      ),
    ).rejects.toThrow("boom");
  });

  it("rejects a non-positive limit", async () => {
    await expect(mapWithConcurrency([1], 0, (n) => Promise.resolve(n))).rejects.toThrow(RangeError);
  });
});
```

`packages/core/test/http/fetch.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { backoffMs, countingFetch, createSubrequestCounter, parseRetryAfter } from "../../src/http/fetch.ts";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../../src/model/constants.ts";
import { SubrequestBudgetError } from "../../src/model/errors.ts";
import { server } from "../setup/msw.ts";

describe("createSubrequestCounter", () => {
  it("counts reservations up to the limit", () => {
    const counter = createSubrequestCounter(3, 1);
    counter.reserve();
    counter.reserve(1);
    expect(counter.used).toBe(3);
    expect(counter.limit).toBe(3);
  });

  it("throws SubrequestBudgetError when used + n > limit and does not count it", () => {
    const counter = createSubrequestCounter(2);
    counter.reserve(2);
    try {
      counter.reserve();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SubrequestBudgetError);
      expect((error as SubrequestBudgetError).code).toBe("subrequest_budget");
      expect((error as SubrequestBudgetError).used).toBe(2);
      expect((error as SubrequestBudgetError).limit).toBe(2);
    }
    expect(counter.used).toBe(2);
  });
});

describe("countingFetch", () => {
  it("reserves one subrequest per call before fetching", async () => {
    server.use(http.get("https://api.example.test/ping", () => HttpResponse.json({ ok: true })));
    const counter = createSubrequestCounter(1);
    const f = countingFetch(fetch, counter);
    const res = await f("https://api.example.test/ping");
    expect(await res.json()).toEqual({ ok: true });
    expect(counter.used).toBe(1);
    await expect(f("https://api.example.test/ping")).rejects.toBeInstanceOf(SubrequestBudgetError);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);

  it("prefers retry-after-ms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "1500", "retry-after": "9" }), now)).toBe(1500);
  });

  it("reads delta-seconds", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
  });

  it("reads an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 15 Oct 2026 12:01:00 GMT" }), now)).toBe(
      60_000,
    );
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 15 Oct 2026 11:00:00 GMT" }), now)).toBe(0);
  });

  it("returns null when absent or malformed", () => {
    expect(parseRetryAfter(new Headers(), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "abc" }), now)).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from the base and caps at the max, plus jitter", () => {
    const zero = () => 0;
    expect(backoffMs(1, zero)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, zero)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3, zero)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(20, zero)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(1, () => 0.999)).toBe(BACKOFF_BASE_MS + 999);
  });

  it("treats attempt < 1 as 1", () => {
    expect(backoffMs(0, () => 0)).toBe(BACKOFF_BASE_MS);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/core exec vitest run test/util test/http`
Expected: FAIL, 3 failed suites with `Cannot find module '../../src/util/rng.ts'`, `'../../src/util/concurrency.ts'`, `'../../src/http/fetch.ts'`.

- [ ] **Step 3: Write the implementations**

`packages/core/src/util/rng.ts`:

```ts
/** 32-bit FNV-1a over the UTF-8 bytes of text; returns an unsigned 32-bit integer. */
export function fnv1a32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG: deterministic floats in [0, 1) for a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle driven by mulberry32(seed). Returns a new array; the input is not modified. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
```

`packages/core/src/util/concurrency.ts`:

```ts
/**
 * Runs fn over items with at most `limit` calls in flight. Results keep input order.
 * Rejects with the first error (remaining queued items are not started after a rejection).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

`packages/core/src/http/fetch.ts`:

```ts
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../model/constants.ts";
import { SubrequestBudgetError } from "../model/errors.ts";

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface SubrequestCounter {
  readonly used: number;
  readonly limit: number;
  /** Throws SubrequestBudgetError (extends ClearboxError, code "subrequest_budget") when used + n > limit. */
  reserve(n?: number): void;
}

export function createSubrequestCounter(limit: number, alreadyUsed = 0): SubrequestCounter {
  let used = alreadyUsed;
  return {
    get used() {
      return used;
    },
    limit,
    reserve(n = 1) {
      if (used + n > limit) {
        throw new SubrequestBudgetError({ used, limit });
      }
      used += n;
    },
  };
}

/** Wraps fetch: every call reserves 1 from the counter first. */
export function countingFetch(base: FetchLike, counter: SubrequestCounter): FetchLike {
  return (input, init) => {
    try {
      counter.reserve(1);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return base(input, init);
  };
}

/** Retry-After: delta-seconds or HTTP date; also accepts retry-after-ms (preferred). Returns ms (>= 0) or null. */
export function parseRetryAfter(headers: Headers, now: number): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\s*\d+(\.\d+)?\s*$/.test(ms)) {
    return Math.max(0, Math.round(Number(ms)));
  }
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^(attempt-1)) + jitter(0..1000 ms); attempt >= 1. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  return base + Math.floor(random() * 1000);
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/util test/http`
Expected: PASS, `Test Files  3 passed (3)`, `Tests  22 passed (22)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/util packages/core/src/http packages/core/test/util packages/core/test/http
git commit -m "feat(core): add seeded RNG, concurrency limiter and fetch utilities"
```

---

### Task 5: Header and text utilities

**Files:**
- Create: `packages/core/src/text/rfc2047.ts`, `packages/core/src/text/truncate.ts`, `packages/core/src/text/address.ts`, `packages/core/src/text/headers.ts`
- Test: `packages/core/test/text/rfc2047.test.ts`, `packages/core/test/text/truncate.test.ts`, `packages/core/test/text/address.test.ts`, `packages/core/test/text/headers.test.ts`

**Interfaces:**
- Consumes: `MailAddress`, `AuthVerdict` (Task 2).
- Produces (issue #16; plan 02 mappers and Task 9 signals use these):
  - `unfoldHeader(value: string): string`; `decodeEncodedWords(input: string): string` (B and Q, adjacent words joined, unknown charsets left raw)
  - `truncateChars(text: string, max: number): string` (code points); `collapseWhitespace(text: string): string`; `decodeHtmlEntities(text: string): string`
  - `parseAddress(raw: string | null): MailAddress`; `parseAddressList(raw: string | null): MailAddress[]` (only entries with a parseable address); `registrableDomain(hostOrAddress: string): string` (`""` for empty)
  - `RawHeader { name: string; value: string }`; `headerValue(headers: readonly RawHeader[], name: string): string | null`
  - `ParsedAuthResults { authservId: string | null; spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict }`; `parseAuthResults(value: string | null): ParsedAuthResults` (plan 02 uses `authservId` to keep only `mx.google.com` results on Gmail)
  - `ListUnsubscribe { https: string[]; mailto: string[] }`; `parseListUnsubscribe(value: string | null): ListUnsubscribe`
  - `isBulkPrecedence(value: string | null): boolean`; `isAutoSubmitted(value: string | null): boolean`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/text/rfc2047.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeEncodedWords, unfoldHeader } from "../../src/text/rfc2047.ts";

describe("unfoldHeader", () => {
  it("removes CRLF and LF folds but keeps the whitespace", () => {
    expect(unfoldHeader("Weekly\r\n picks")).toBe("Weekly picks");
    expect(unfoldHeader("a\n\tb")).toBe("a\tb");
    expect(unfoldHeader("  plain  ")).toBe("plain");
  });
});

describe("decodeEncodedWords", () => {
  it("decodes B (base64) UTF-8 words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6kgb2ZmZXJz?=")).toBe("Caf\u00e9 offers");
  });

  it("decodes Q words with underscores and hex escapes", () => {
    expect(decodeEncodedWords("=?utf-8?Q?Caf=C3=A9_offers?=")).toBe("Caf\u00e9 offers");
  });

  it("decodes ISO-8859-1", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9?=")).toBe("Caf\u00e9");
  });

  it("drops whitespace between adjacent encoded words only", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Hello?= =?UTF-8?Q?_world?= and more")).toBe("Hello world and more");
  });

  it("keeps plain text and undecodable words as they are", () => {
    expect(decodeEncodedWords("Plain subject")).toBe("Plain subject");
    expect(decodeEncodedWords("=?x-unknown-charset?Q?abc?=")).toBe("=?x-unknown-charset?Q?abc?=");
  });
});
```

`packages/core/test/text/truncate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collapseWhitespace, decodeHtmlEntities, truncateChars } from "../../src/text/truncate.ts";

describe("truncateChars", () => {
  it("keeps short strings", () => {
    expect(truncateChars("abc", 5)).toBe("abc");
  });

  it("cuts at code points, never splitting surrogate pairs", () => {
    expect(truncateChars("a\u{1F600}b", 2)).toBe("a\u{1F600}");
    expect(truncateChars("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}\u{1F600}");
  });

  it("returns empty for max <= 0", () => {
    expect(truncateChars("abc", 0)).toBe("");
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(collapseWhitespace("  a \n\t b  ")).toBe("a b");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &lt;3 &#39;hi&#x27; &quot;x&quot;")).toBe(
      `Tom & Jerry <3 'hi' "x"`,
    );
  });

  it("leaves unknown or invalid entities", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800;")).toBe("&bogus; &#0; &#xD800;");
  });
});
```

`packages/core/test/text/address.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAddress, parseAddressList, registrableDomain } from "../../src/text/address.ts";

describe("parseAddress", () => {
  it("parses quoted display names", () => {
    expect(parseAddress('"Shop, Inc." <News@Shop.Example.com>')).toEqual({
      address: "news@shop.example.com",
      name: "Shop, Inc.",
    });
  });

  it("parses unquoted names, bare and bracketed addresses, and comments", () => {
    expect(parseAddress("Example Shop <deals@example.com>")).toEqual({
      address: "deals@example.com",
      name: "Example Shop",
    });
    expect(parseAddress("<deals@example.com>")).toEqual({ address: "deals@example.com", name: null });
    expect(parseAddress("deals@example.com")).toEqual({ address: "deals@example.com", name: null });
    expect(parseAddress("deals@example.com (Example Deals)")).toEqual({
      address: "deals@example.com",
      name: "Example Deals",
    });
  });

  it("decodes RFC 2047 display names", () => {
    expect(parseAddress("=?UTF-8?B?Q2Fmw6k=?= <cafe@example.org>")).toEqual({
      address: "cafe@example.org",
      name: "Caf\u00e9",
    });
  });

  it("returns a null address when unparseable", () => {
    expect(parseAddress("undisclosed-recipients:;").address).toBeNull();
    expect(parseAddress("<>")).toEqual({ address: null, name: null });
    expect(parseAddress(null)).toEqual({ address: null, name: null });
  });
});

describe("parseAddressList", () => {
  it("splits on commas outside quotes and brackets", () => {
    const list = parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.net, Team <team@example.org>');
    expect(list.map((a) => a.address)).toEqual(["jane@example.com", "bob@example.net", "team@example.org"]);
    expect(list[0]?.name).toBe("Doe, Jane");
  });

  it("drops group names and empty groups", () => {
    expect(parseAddressList("friends: a@example.com, b@example.com;").map((a) => a.address)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });
});

describe("registrableDomain", () => {
  it("keeps the last two labels", () => {
    expect(registrableDomain("mail.news.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("News@Mail.Example.COM.")).toBe("example.com");
  });

  it("keeps three labels under known multi-part suffixes", () => {
    expect(registrableDomain("mail.shop.co.uk")).toBe("shop.co.uk");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
  });

  it("handles empty, single-label and IP hosts", () => {
    expect(registrableDomain("")).toBe("");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("192.0.2.1")).toBe("192.0.2.1");
  });
});
```

`packages/core/test/text/headers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  headerValue,
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "../../src/text/headers.ts";

describe("headerValue", () => {
  const headers = [
    { name: "Subject", value: "Hello\r\n world" },
    { name: "subject", value: "second" },
  ];

  it("matches case-insensitively, returns the first, unfolded", () => {
    expect(headerValue(headers, "SUBJECT")).toBe("Hello world");
  });

  it("returns null when absent", () => {
    expect(headerValue(headers, "List-Id")).toBeNull();
  });
});

describe("parseAuthResults", () => {
  it("parses a Gmail header with an authserv-id", () => {
    const value =
      "mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass (google.com: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com";
    expect(parseAuthResults(value)).toEqual({
      authservId: "mx.google.com",
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    });
  });

  it("parses a Microsoft header without an authserv-id", () => {
    const value =
      "spf=softfail (sender IP is 192.0.2.1) smtp.mailfrom=example.net; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=example.net;compauth=fail reason=001";
    expect(parseAuthResults(value)).toEqual({ authservId: null, spf: "fail", dkim: "none", dmarc: "fail" });
  });

  it("treats any passing DKIM signature as pass and ignores text inside comments", () => {
    const value =
      "mx.google.com; dkim=fail header.d=a.example; dkim=pass header.d=b.example; spf=neutral (dmarc=pass in a comment)";
    expect(parseAuthResults(value)).toEqual({
      authservId: "mx.google.com",
      spf: "none",
      dkim: "pass",
      dmarc: "none",
    });
  });

  it("returns none for a missing header", () => {
    expect(parseAuthResults(null)).toEqual({ authservId: null, spf: "none", dkim: "none", dmarc: "none" });
  });
});

describe("parseListUnsubscribe", () => {
  it("splits https and mailto URIs", () => {
    expect(
      parseListUnsubscribe("<mailto:unsub@example.com?subject=unsubscribe>,\r\n <https://example.com/u/abc>"),
    ).toEqual({
      https: ["https://example.com/u/abc"],
      mailto: ["mailto:unsub@example.com?subject=unsubscribe"],
    });
  });

  it("ignores http and unbracketed values", () => {
    expect(parseListUnsubscribe("<http://example.com/u>, https://example.com/x")).toEqual({
      https: [],
      mailto: [],
    });
    expect(parseListUnsubscribe(null)).toEqual({ https: [], mailto: [] });
  });
});

describe("isBulkPrecedence", () => {
  it("accepts bulk, list and junk only", () => {
    expect(["bulk", " List ", "JUNK"].map(isBulkPrecedence)).toEqual([true, true, true]);
    expect(["first-class", "", null].map((v) => isBulkPrecedence(v))).toEqual([false, false, false]);
  });
});

describe("isAutoSubmitted", () => {
  it("is true for any value except no", () => {
    expect(isAutoSubmitted("auto-generated")).toBe(true);
    expect(isAutoSubmitted("auto-replied; owner-email=x@example.com")).toBe(true);
    expect(isAutoSubmitted("no")).toBe(false);
    expect(isAutoSubmitted(" No ")).toBe(false);
    expect(isAutoSubmitted(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/core exec vitest run test/text`
Expected: FAIL, 4 failed suites with `Cannot find module '../../src/text/<file>.ts'`.

- [ ] **Step 3: Write the implementations**

`packages/core/src/text/rfc2047.ts`:

```ts
/** RFC 5322 unfolding: removes CRLF (or LF) that is followed by whitespace, then trims. */
export function unfoldHeader(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, "").trim();
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
const ADJACENT_GAP = /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g;

function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  try {
    const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function qToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "_") {
      out.push(0x20);
    } else if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeBytes(bytes: Uint8Array, charset: string): string | null {
  const label = charset.toLowerCase().split("*")[0] ?? "";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    if (label === "us-ascii" || label === "ascii" || label === "iso-8859-1" || label === "latin1") {
      return String.fromCharCode(...bytes);
    }
    return null;
  }
}

/** Decodes RFC 2047 encoded words (B and Q). Whitespace between adjacent encoded words is dropped. Undecodable words stay raw. */
export function decodeEncodedWords(input: string): string {
  if (!input.includes("=?")) return input;
  const joined = input.replace(ADJACENT_GAP, "$1");
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toUpperCase() === "B" ? base64ToBytes(text) : qToBytes(text);
    if (bytes === null) return whole;
    return decodeBytes(bytes, charset) ?? whole;
  });
}
```

`packages/core/src/text/truncate.ts`:

```ts
/** Truncates to at most max Unicode code points (never splits a surrogate pair). */
export function truncateChars(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count === max) break;
    out += ch;
    count++;
  }
  return out;
}

/** Collapses every run of whitespace to one space and trims both ends. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  euro: "\u20ac",
};

/** Decodes numeric (&#39; &#x27;) and common named HTML entities. Unknown or invalid entities stay as they are. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return whole;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
```

`packages/core/src/text/address.ts`:

```ts
import type { MailAddress } from "../model/mail.ts";
import { decodeEncodedWords, unfoldHeader } from "./rfc2047.ts";

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function cleanName(raw: string): string | null {
  let name = raw.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  name = decodeEncodedWords(name).replace(/\s+/g, " ").trim();
  return name === "" ? null : name;
}

function normalizeAddress(raw: string): string | null {
  const candidate = raw
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return ADDRESS.test(candidate) ? candidate : null;
}

/** Parses one mailbox: `"Name" <a@b>`, `Name <a@b>`, `<a@b>`, `a@b`, `a@b (Name)`. */
export function parseAddress(raw: string | null): MailAddress {
  if (raw === null) return { address: null, name: null };
  const value = unfoldHeader(raw);
  const angle = /<([^<>]*)>/.exec(value);
  if (angle) {
    const before = value.slice(0, angle.index);
    return { address: normalizeAddress(angle[1] ?? ""), name: cleanName(before) };
  }
  const comment = /\(([^()]*)\)/.exec(value);
  const bare = comment ? value.replace(comment[0], "") : value;
  return { address: normalizeAddress(bare), name: comment ? cleanName(comment[1] ?? "") : null };
}

/** Splits on commas outside quotes, angle brackets and comments; drops group names ("team: a, b;"). */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "\\" && quoted) {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && ch === "(") paren++;
    else if (!quoted && ch === ")") paren = Math.max(0, paren - 1);
    if (!quoted && angle === 0 && paren === 0 && (ch === "," || ch === ";")) {
      parts.push(current);
      current = "";
      continue;
    }
    if (!quoted && angle === 0 && paren === 0 && ch === ":") {
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Parses an address list header; returns only entries with a parseable address. */
export function parseAddressList(raw: string | null): MailAddress[] {
  if (raw === null) return [];
  return splitList(unfoldHeader(raw))
    .map((part) => parseAddress(part))
    .filter((a) => a.address !== null);
}

/** Second-level labels under which registrations happen (small built-in list). */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "com.br",
  "net.br",
  "org.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.mx",
  "com.ar",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.my",
  "com.ph",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "co.id",
  "co.il",
  "co.th",
]);

/** Registrable domain of a host or address: last two labels, or last three under a known multi-part suffix. "" when empty. */
export function registrableDomain(hostOrAddress: string): string {
  const at = hostOrAddress.lastIndexOf("@");
  const host = (at >= 0 ? hostOrAddress.slice(at + 1) : hostOrAddress)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "") return "";
  if (/^\[.*\]$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".").filter((l) => l !== "");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}
```

`packages/core/src/text/headers.ts`:

```ts
import type { AuthVerdict } from "../model/mail.ts";
import { unfoldHeader } from "./rfc2047.ts";

/** A raw header as both providers return it (Gmail payload.headers, Graph internetMessageHeaders). */
export interface RawHeader {
  name: string;
  value: string;
}

/** First header with this name (case-insensitive), unfolded; null when absent. */
export function headerValue(headers: readonly RawHeader[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === wanted);
  return found ? unfoldHeader(found.value) : null;
}

export interface ParsedAuthResults {
  /** authserv-id (lowercased) when the header starts with one, else null (Microsoft style). */
  authservId: string | null;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
}

const FAIL_RESULTS: ReadonlySet<string> = new Set(["fail", "softfail", "hardfail", "permerror"]);

function stripComments(value: string): string {
  let out = value;
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out.replace(/\([^()]*\)/g, " ");
  }
  return out;
}

/** Parses one Authentication-Results value. Per method: pass if any pass, else fail if any fail/softfail/permerror, else none. */
export function parseAuthResults(value: string | null): ParsedAuthResults {
  const result: ParsedAuthResults = { authservId: null, spf: "none", dkim: "none", dmarc: "none" };
  if (value === null) return result;
  const clean = stripComments(unfoldHeader(value));
  const segments = clean.split(";").map((s) => s.trim());
  const first = segments[0] ?? "";
  if (first !== "" && !first.includes("=")) {
    result.authservId = (first.split(/\s+/)[0] ?? "").toLowerCase();
  }
  for (const method of ["spf", "dkim", "dmarc"] as const) {
    const verdicts = [...clean.matchAll(new RegExp(`(?:^|[\\s;])${method}\\s*=\\s*([a-z]+)`, "gi"))].map(
      (m) => (m[1] ?? "").toLowerCase(),
    );
    if (verdicts.includes("pass")) result[method] = "pass";
    else if (verdicts.some((v) => FAIL_RESULTS.has(v))) result[method] = "fail";
  }
  return result;
}

export interface ListUnsubscribe {
  https: string[];
  mailto: string[];
}

/** Extracts the <...> URIs of a List-Unsubscribe header, split into https and mailto. */
export function parseListUnsubscribe(value: string | null): ListUnsubscribe {
  const out: ListUnsubscribe = { https: [], mailto: [] };
  if (value === null) return out;
  for (const match of unfoldHeader(value).matchAll(/<\s*([^<>\s]+)\s*>/g)) {
    const uri = match[1] ?? "";
    if (/^https:\/\//i.test(uri)) out.https.push(uri);
    else if (/^mailto:/i.test(uri)) out.mailto.push(uri);
  }
  return out;
}

/** Precedence: bulk, list or junk (case-insensitive). */
export function isBulkPrecedence(value: string | null): boolean {
  return value !== null && /^(bulk|list|junk)$/i.test(value.trim());
}

/** Auto-Submitted: any value except "no" (parameters after ";" are ignored). */
export function isAutoSubmitted(value: string | null): boolean {
  if (value === null) return false;
  const token = (value.split(";")[0] ?? "").trim().toLowerCase();
  return token !== "" && token !== "no";
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/text`
Expected: PASS, `Test Files  4 passed (4)`, `Tests  31 passed (31)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/text packages/core/test/text
git commit -m "feat(core): add RFC 2047, address and header parsing utilities"
```

---

### Task 6: Provider, token and shared OAuth interfaces

**Files:**
- Create: `packages/core/src/providers/provider.ts`, `packages/core/src/providers/token.ts`, `packages/core/src/providers/oauth.ts`
- Test: `packages/core/test/providers/types.test.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 4); `MailMessage`, `ProviderKind` (Task 2).
- Produces (contracts 4.3 and the shared part of 4.4; issues #1, #17):
  - `provider.ts`: `BackfillCursor`, `SentCursor`, `IncrementalCursor` (all `string`), `ProviderDeps { fetch; tokens; now }`, `GraphProviderDeps extends ProviderDeps { archiveFolderId: string | null }`, `BootstrapResult`, `InboxPage`, `SentItem`, `SentPage`, `ChangesPage`, `ActionErrorCode`, `ActionResult`, `RestoreFrom`, `RestoreItem`, `MailProvider` (no hard-delete method).
  - `token.ts`: `TokenSource { getAccessToken(); forceRefresh() }`, `TokenUpdate { accessToken; accessExpiresAt; refreshToken: string | null }`, `OAuthTokens`.
  - `oauth.ts`: `OAuthClientConfig`, `AuthorizeParams`, `GOOGLE_SCOPES`, `MICROSOFT_SCOPES`, `MICROSOFT_CONSENT_URLS`. Plan 02 appends `buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken` to this file and creates `createGmailProvider` / `createGraphProvider` in its own files.

- [ ] **Step 1: Write the failing test**

`packages/core/test/providers/types.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FetchLike } from "../../src/http/fetch.ts";
import {
  GOOGLE_SCOPES,
  MICROSOFT_CONSENT_URLS,
  MICROSOFT_SCOPES,
  type AuthorizeParams,
  type OAuthClientConfig,
} from "../../src/providers/oauth.ts";
import type {
  ActionResult,
  ChangesPage,
  GraphProviderDeps,
  MailProvider,
  ProviderDeps,
  RestoreItem,
} from "../../src/providers/provider.ts";
import type { OAuthTokens, TokenSource, TokenUpdate } from "../../src/providers/token.ts";

/** A minimal in-memory provider proves the interface is implementable as declared. */
function stubProvider(): MailProvider {
  const ok = (ids: readonly string[]): Promise<ActionResult[]> =>
    Promise.resolve(ids.map((id) => ({ id, ok: true as const, newId: id })));
  return {
    kind: "gmail",
    bootstrap: () =>
      Promise.resolve({
        email: "owner@example.test",
        providerUserId: "owner@example.test",
        aliases: [],
        archiveFolderId: null,
        incrementalCursor: '{"v":1,"historyId":"1","catchupAfter":null,"catchupPageToken":null}',
      }),
    listInboxPage: () => Promise.resolve({ messages: [], nextCursor: null }),
    listSentPage: () => Promise.resolve({ items: [], nextCursor: null }),
    syncChanges: (cursor) =>
      Promise.resolve<ChangesPage>({
        added: [],
        removedIds: [],
        sent: [],
        nextCursor: cursor,
        caughtUp: true,
      }),
    resyncCursor: () => Promise.resolve("{}"),
    trash: ok,
    archive: ok,
    restore: (items: readonly RestoreItem[]) => ok(items.map((i) => i.id)),
  };
}

describe("provider interfaces", () => {
  it("can be implemented and has no hard-delete method", async () => {
    const provider = stubProvider();
    expect(await provider.trash(["a"])).toEqual([{ id: "a", ok: true, newId: "a" }]);
    expect("delete" in provider).toBe(false);
    expectTypeOf<MailProvider>().not.toHaveProperty("delete");
  });

  it("declares dependency, token and OAuth shapes", () => {
    expectTypeOf<ProviderDeps>().toHaveProperty("fetch").toEqualTypeOf<FetchLike>();
    expectTypeOf<ProviderDeps>().toHaveProperty("tokens").toEqualTypeOf<TokenSource>();
    expectTypeOf<GraphProviderDeps>().toHaveProperty("archiveFolderId").toEqualTypeOf<string | null>();
    expectTypeOf<TokenUpdate>().toEqualTypeOf<{
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string | null;
    }>();
    expectTypeOf<OAuthTokens>().toHaveProperty("refreshTokenExpiresAt").toEqualTypeOf<number | null>();
    expectTypeOf<OAuthClientConfig>().toHaveProperty("redirectUri").toEqualTypeOf<string>();
    expectTypeOf<AuthorizeParams>().toHaveProperty("loginHint").toEqualTypeOf<string | undefined>();
  });

  it("exports scope and consent constants", () => {
    expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(MICROSOFT_SCOPES).toEqual(["offline_access", "User.Read", "Mail.ReadWrite"]);
    expect(MICROSOFT_CONSENT_URLS).toEqual({
      personal: "https://account.live.com/consent/Manage",
      work: "https://myapps.microsoft.com",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/types.test.ts`
Expected: FAIL with `Cannot find module '../../src/providers/oauth.ts'`.

- [ ] **Step 3: Write the interfaces**

`packages/core/src/providers/provider.ts`:

```ts
import type { FetchLike } from "../http/fetch.ts";
import type { MailMessage, ProviderKind } from "../model/mail.ts";
import type { TokenSource } from "./token.ts";

/**
 * Cursors are opaque strings to callers and stored verbatim in D1.
 * Each provider encodes them as JSON with a version field (shapes in contracts 4.3.1).
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
  /** Lowercased. */
  email: string;
  /** Gmail: email; Graph: /me id. */
  providerUserId: string;
  /** Lowercased, excluding email; Gmail sendAs, Graph: []. */
  aliases: string[];
  /** Graph only; Gmail null. */
  archiveFolderId: string | null;
  /** Taken BEFORE any backfill. */
  incrementalCursor: IncrementalCursor;
}

export interface InboxPage {
  /** Newest first. */
  messages: MailMessage[];
  /** null when the backfill reached the oldest inbox message. */
  nextCursor: BackfillCursor | null;
}

export interface SentItem {
  /** Gmail threadId / Graph conversationId. */
  threadId: string | null;
  /** Lowercased To + Cc + Bcc. */
  recipients: string[];
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
  | "not_found" // message gone (Gmail 404 notFound, Graph 404 ErrorItemNotFound)
  | "rate_limited" // 429 / 403 rateLimitExceeded inside a batch
  | "unavailable" // 5xx / network inside a batch
  | "archive_unavailable" // Graph account without archive folder
  | "bad_request" // 400
  | "unknown";

export type ActionResult =
  | { id: string; ok: true; newId: string }
  | { id: string; ok: false; error: ActionErrorCode; retryAfterMs: number | null };

export type RestoreFrom = "trash" | "archive";
export interface RestoreItem {
  id: string;
  from: RestoreFrom;
}

/**
 * No hard-delete method exists, by design.
 * Whole-call failures throw: ProviderAuthError, ProviderConfigError, ProviderRateLimitError,
 * ProviderUnavailableError, CursorExpiredError, ProviderResponseError.
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
  /** Move to Trash / Deleted Items. Max 100 ids per call. */
  trash(ids: readonly string[]): Promise<ActionResult[]>;
  /** Gmail: remove INBOX; Graph: move to archiveFolderId. Max 100 ids per call. */
  archive(ids: readonly string[]): Promise<ActionResult[]>;
  /** Back to inbox. Gmail trash: untrash, then add INBOX if missing. Graph: move to "inbox". Max 100 per call. */
  restore(items: readonly RestoreItem[]): Promise<ActionResult[]>;
}
```

`packages/core/src/providers/token.ts`:

```ts
export interface TokenSource {
  /** Valid access token; refreshes when fewer than ACCESS_TOKEN_MIN_TTL_MS remain. */
  getAccessToken(): Promise<string>;
  /** Refresh unconditionally (after a 401). */
  forceRefresh(): Promise<string>;
}

/** What a token source hands back to the tick for re-encryption and persistence (contracts 7.15). */
export interface TokenUpdate {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  /** Non-null when the provider returned a new refresh token (Microsoft rotation). */
  refreshToken: string | null;
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
```

`packages/core/src/providers/oauth.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes, including the type assertions**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/types.test.ts && pnpm typecheck`
Expected: PASS, `Tests  3 passed (3)`; `tsc` exits 0 (the `expectTypeOf` checks are enforced by `tsc`).

- [ ] **Step 5: Lint**

Run: `pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers packages/core/test/providers
git commit -m "feat(core): add MailProvider, token and shared OAuth interfaces"
```

---

### Task 7: Policy schema, defaults and matchers

**Files:**
- Create: `packages/core/src/policy/policy.ts`
- Test: `packages/core/test/policy/policy.test.ts`

**Interfaces:**
- Consumes: `zod` 4.6.7.
- Produces (contracts 4.6, issue #8): `SenderEntrySchema`, `PolicySchema` (strict), `Policy`, `DEFAULT_POLICY`, `parsePolicy(json: string | null): Policy` (null returns a fresh copy of the defaults; invalid JSON or invalid policy throws `ZodError`), `matchesSenderList(address: string, domain: string, list: readonly string[]): boolean`, `matchRecordPattern(subject: string, snippet: string, patterns: readonly string[]): string | null` (returns the first pattern in list order that matches as a whole word, case-insensitive). Plan 03 imports `PolicySchema` and `SenderEntrySchema` into `app/src/shared/api.ts`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/policy/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DEFAULT_POLICY,
  PolicySchema,
  SenderEntrySchema,
  matchRecordPattern,
  matchesSenderList,
  parsePolicy,
} from "../../src/policy/policy.ts";

describe("SenderEntrySchema", () => {
  it("accepts addresses and @domains, trimming and lowercasing", () => {
    expect(SenderEntrySchema.parse("  News@Example.COM ")).toBe("news@example.com");
    expect(SenderEntrySchema.parse("@Example.co.uk")).toBe("@example.co.uk");
  });

  it.each(["example.com", "@localhost", "a@b", "two@@example.com", "sp ace@example.com", "@"])(
    "rejects %j",
    (value) => {
      expect(SenderEntrySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("PolicySchema", () => {
  it("accepts DEFAULT_POLICY", () => {
    expect(PolicySchema.parse(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });

  it("rejects unknown keys (strict)", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, extra: true }).success).toBe(false);
  });

  it("enforces minAgeDays bounds and integer", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: -1 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 366 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 1.5 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, minAgeDays: 0 }).success).toBe(true);
  });

  it("enforces list sizes and pattern lengths", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `u${String(i)}@example.com`);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, allowlist: many }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, recordPatterns: ["x"] }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, recordPatterns: ["a".repeat(41)] }).success).toBe(
      false,
    );
  });

  it("normalizes record patterns", () => {
    expect(PolicySchema.parse({ ...DEFAULT_POLICY, recordPatterns: [" Receipt "] }).recordPatterns).toEqual([
      "receipt",
    ]);
  });
});

describe("parsePolicy", () => {
  it("returns a copy of DEFAULT_POLICY for null", () => {
    const policy = parsePolicy(null);
    expect(policy).toEqual(DEFAULT_POLICY);
    policy.allowlist.push("x@example.com");
    expect(DEFAULT_POLICY.allowlist).toEqual([]);
  });

  it("parses stored JSON", () => {
    const stored = { ...DEFAULT_POLICY, denylist: ["@spam.example.com"], minAgeDays: 7 };
    expect(parsePolicy(JSON.stringify(stored))).toEqual(stored);
  });

  it("throws ZodError for invalid JSON or an invalid policy", () => {
    expect(() => parsePolicy("{not json")).toThrow(ZodError);
    expect(() => parsePolicy(JSON.stringify({ ...DEFAULT_POLICY, minAgeDays: "3" }))).toThrow(ZodError);
  });
});

describe("matchesSenderList", () => {
  const list = ["boss@example.com", "@example.org"];

  it("matches exact addresses", () => {
    expect(matchesSenderList("boss@example.com", "example.com", list)).toBe(true);
    expect(matchesSenderList("other@example.com", "example.com", list)).toBe(false);
  });

  it("matches @domain entries for the domain and its subdomains", () => {
    expect(matchesSenderList("a@example.org", "example.org", list)).toBe(true);
    expect(matchesSenderList("a@mail.example.org", "example.org", list)).toBe(true);
    expect(matchesSenderList("a@notexample.org", "notexample.org", list)).toBe(false);
  });

  it("matches subdomain entries against the full host, not only the registrable domain", () => {
    expect(matchesSenderList("a@news.example.net", "example.net", ["@news.example.net"])).toBe(true);
    expect(matchesSenderList("a@shop.example.net", "example.net", ["@news.example.net"])).toBe(false);
  });

  it("never matches an unknown sender", () => {
    expect(matchesSenderList("", "", list)).toBe(false);
  });
});

describe("matchRecordPattern", () => {
  const patterns = DEFAULT_POLICY.recordPatterns;

  it("matches whole words case-insensitively in subject or snippet", () => {
    expect(matchRecordPattern("Your RECEIPT for order 42", "", patterns)).toBe("receipt");
    expect(matchRecordPattern("Hello", "Attached is the invoice.", patterns)).toBe("invoice");
  });

  it("ignores partial words", () => {
    expect(matchRecordPattern("Syntax tips", "Taxonomy update", patterns)).toBeNull();
    expect(matchRecordPattern("Receipts", "", ["receipt"])).toBeNull();
  });

  it("returns the first pattern in list order", () => {
    expect(matchRecordPattern("tax invoice", "", patterns)).toBe("invoice");
  });

  it("escapes regex characters in patterns", () => {
    expect(matchRecordPattern("see c++ notes", "", ["c++"])).toBe("c++");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/policy`
Expected: FAIL with `Cannot find module '../../src/policy/policy.ts'`.

- [ ] **Step 3: Write the policy module**

`packages/core/src/policy/policy.ts`:

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

const PolicyJsonSchema = z
  .string()
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.issues.push({ code: "custom", message: "policy is not valid JSON", input: text });
      return z.NEVER;
    }
  })
  .pipe(PolicySchema);

/** Parses stored JSON; returns a copy of DEFAULT_POLICY when input is null; throws ZodError when invalid. */
export function parsePolicy(json: string | null): Policy {
  if (json === null) return structuredClone(DEFAULT_POLICY);
  return PolicyJsonSchema.parse(json);
}

function hostOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

function domainMatches(entryDomain: string, host: string): boolean {
  return host !== "" && (host === entryDomain || host.endsWith(`.${entryDomain}`));
}

/**
 * True when address equals an entry, or an "@domain" entry equals the domain or is a parent domain of it.
 * "@domain" entries are checked against both the address host and the given (registrable) domain.
 */
export function matchesSenderList(address: string, domain: string, list: readonly string[]): boolean {
  const addr = address.trim().toLowerCase();
  const host = hostOf(addr);
  const dom = domain.trim().toLowerCase();
  return list.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith("@")) {
      const entryDomain = entry.slice(1);
      return domainMatches(entryDomain, host) || domainMatches(entryDomain, dom);
    }
    return addr !== "" && entry === addr;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word match of any pattern in subject + " " + snippet; returns the first matching pattern (list order) or null. */
export function matchRecordPattern(
  subject: string,
  snippet: string,
  patterns: readonly string[],
): string | null {
  const text = `${subject} ${snippet}`;
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === "") continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(text)) return pattern;
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/policy`
Expected: PASS, `Tests  23 passed (23)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/policy packages/core/test/policy
git commit -m "feat(core): add policy schema, defaults and sender matching"
```

---

### Task 8: Sender and domain priors

**Files:**
- Create: `packages/core/src/priors/priors.ts`
- Test: `packages/core/test/priors/priors.test.ts`

**Interfaces:**
- Consumes: `ActionKind` (Task 2), `PRIOR_MIN_N` (Task 2).
- Produces (contracts 4.8, issues #2, #7): `PriorCounts { deletes; keeps }`, `Prior { source: "sender" | "domain" | "none"; key: string | null; alpha; beta; n; pDelete }`, `priorKeyForSender(address): string`, `priorKeyForDomain(domain): string` (`"@" + domain`), `selectPrior(sender: PriorCounts | null, domain: PriorCounts | null, address: string, domainName: string): Prior`, `priorDelta(ownerAction: ActionKind, direction: 1 | -1): PriorCounts`, `applyOwnerAction(counts: PriorCounts | null, ownerAction: ActionKind, direction: 1 | -1): PriorCounts`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/priors/priors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyOwnerAction,
  priorDelta,
  priorKeyForDomain,
  priorKeyForSender,
  selectPrior,
} from "../../src/priors/priors.ts";

describe("prior keys", () => {
  it("uses the address and @domain", () => {
    expect(priorKeyForSender("a@example.com")).toBe("a@example.com");
    expect(priorKeyForDomain("example.com")).toBe("@example.com");
  });
});

describe("selectPrior", () => {
  it("uses the sender prior when its n >= 3", () => {
    const prior = selectPrior(
      { deletes: 3, keeps: 0 },
      { deletes: 0, keeps: 10 },
      "a@example.com",
      "example.com",
    );
    expect(prior).toEqual({ source: "sender", key: "a@example.com", alpha: 4, beta: 1, n: 3, pDelete: 0.8 });
  });

  it("falls back to the domain prior when the sender has n < 3 (sender 2, domain 10)", () => {
    const prior = selectPrior(
      { deletes: 2, keeps: 0 },
      { deletes: 8, keeps: 2 },
      "a@example.com",
      "example.com",
    );
    expect(prior.source).toBe("domain");
    expect(prior.key).toBe("@example.com");
    expect(prior.n).toBe(10);
    expect(prior.pDelete).toBeCloseTo(9 / 12, 9);
  });

  it("uses the sender prior with n < 3 when there is no domain prior", () => {
    const prior = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com");
    expect(prior).toEqual({ source: "sender", key: "a@example.com", alpha: 3, beta: 1, n: 2, pDelete: 0.75 });
  });

  it("treats a domain row with zero counts as absent", () => {
    const prior = selectPrior(
      { deletes: 1, keeps: 0 },
      { deletes: 0, keeps: 0 },
      "a@example.com",
      "example.com",
    );
    expect(prior.source).toBe("sender");
  });

  it("uses the domain prior when only the domain is known", () => {
    expect(selectPrior(null, { deletes: 1, keeps: 1 }, "a@example.com", "example.com").source).toBe("domain");
  });

  it("returns none with alpha = beta = 1 when nothing is known", () => {
    expect(selectPrior(null, null, "a@example.com", "example.com")).toEqual({
      source: "none",
      key: null,
      alpha: 1,
      beta: 1,
      n: 0,
      pDelete: 0.5,
    });
  });
});

describe("priorDelta", () => {
  it("counts delete as deletes and archive/keep as keeps", () => {
    expect(priorDelta("delete", 1)).toEqual({ deletes: 1, keeps: 0 });
    expect(priorDelta("archive", 1)).toEqual({ deletes: 0, keeps: 1 });
    expect(priorDelta("keep", 1)).toEqual({ deletes: 0, keeps: 1 });
  });

  it("returns the inverse for undo", () => {
    expect(priorDelta("delete", -1)).toEqual({ deletes: -1, keeps: 0 });
    expect(priorDelta("keep", -1)).toEqual({ deletes: 0, keeps: -1 });
  });
});

describe("applyOwnerAction", () => {
  it("adds the delta to existing counts", () => {
    expect(applyOwnerAction({ deletes: 2, keeps: 1 }, "delete", 1)).toEqual({ deletes: 3, keeps: 1 });
    expect(applyOwnerAction(null, "archive", 1)).toEqual({ deletes: 0, keeps: 1 });
  });

  it("undo followed by redo restores the counts and never goes below zero", () => {
    const start = { deletes: 1, keeps: 0 };
    const undone = applyOwnerAction(start, "delete", -1);
    expect(undone).toEqual({ deletes: 0, keeps: 0 });
    expect(applyOwnerAction(undone, "delete", -1)).toEqual({ deletes: 0, keeps: 0 });
    expect(applyOwnerAction(undone, "delete", 1)).toEqual(start);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/priors`
Expected: FAIL with `Cannot find module '../../src/priors/priors.ts'`.

- [ ] **Step 3: Write the priors module**

`packages/core/src/priors/priors.ts`:

```ts
import type { ActionKind } from "../model/actions.ts";
import { PRIOR_MIN_N } from "../model/constants.ts";

export interface PriorCounts {
  /** Owner chose delete. */
  deletes: number;
  /** Owner chose archive or keep (not delete). */
  keeps: number;
}

export interface Prior {
  source: "sender" | "domain" | "none";
  /** "user@example.com" or "@example.com". */
  key: string | null;
  /** 1 + deletes. */
  alpha: number;
  /** 1 + keeps. */
  beta: number;
  /** alpha + beta - 2. */
  n: number;
  /** alpha / (alpha + beta). */
  pDelete: number;
}

export const priorKeyForSender = (address: string): string => address;
export const priorKeyForDomain = (domain: string): string => `@${domain}`;

function toPrior(source: "sender" | "domain" | "none", key: string | null, counts: PriorCounts): Prior {
  const alpha = 1 + counts.deletes;
  const beta = 1 + counts.keeps;
  return { source, key, alpha, beta, n: alpha + beta - 2, pDelete: alpha / (alpha + beta) };
}

function total(counts: PriorCounts | null): number {
  return counts === null ? 0 : counts.deletes + counts.keeps;
}

/**
 * Sender prior when its n >= PRIOR_MIN_N, else domain prior when present (n > 0),
 * else sender prior (possibly n = 0), else "none" (alpha = beta = 1).
 */
export function selectPrior(
  sender: PriorCounts | null,
  domain: PriorCounts | null,
  address: string,
  domainName: string,
): Prior {
  if (sender !== null && total(sender) >= PRIOR_MIN_N) {
    return toPrior("sender", priorKeyForSender(address), sender);
  }
  if (domain !== null && total(domain) > 0) {
    return toPrior("domain", priorKeyForDomain(domainName), domain);
  }
  if (sender !== null) {
    return toPrior("sender", priorKeyForSender(address), sender);
  }
  return toPrior("none", null, { deletes: 0, keeps: 0 });
}

/** Delta to apply to both the sender key and the domain key for one owner action (undo passes the inverse). */
export function priorDelta(ownerAction: ActionKind, direction: 1 | -1): PriorCounts {
  return ownerAction === "delete" ? { deletes: direction, keeps: 0 } : { deletes: 0, keeps: direction };
}

/** Applies priorDelta to stored counts (null = no row yet); counts never drop below 0. */
export function applyOwnerAction(
  counts: PriorCounts | null,
  ownerAction: ActionKind,
  direction: 1 | -1,
): PriorCounts {
  const base = counts ?? { deletes: 0, keeps: 0 };
  const delta = priorDelta(ownerAction, direction);
  return {
    deletes: Math.max(0, base.deletes + delta.deletes),
    keeps: Math.max(0, base.keeps + delta.keeps),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/priors`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/priors packages/core/test/priors
git commit -m "feat(core): add Beta sender and domain priors"
```

---

### Task 9: Signal extraction and test builders

**Files:**
- Create: `packages/core/src/signals/signals.ts`, `packages/core/test/fixtures/builders.ts`
- Test: `packages/core/test/signals/signals.test.ts`

**Interfaces:**
- Consumes: `MailMessage`, `MailCategory`, `OwnerPosition`, `AuthVerdict` (Task 2); `PriorCounts` (Task 8); `parseAddress`, `registrableDomain`, `parseAuthResults`, `parseListUnsubscribe`, `isBulkPrecedence`, `isAutoSubmitted` (Task 5); `DEFAULT_POLICY`, `Policy` (Task 7).
- Produces:
  - `signals.ts` (contracts 4.5, issues #9, #10): `SenderHistory`, `SignalContext { now; ownerAddresses; repliedThreadIds }`, `Signals`, `extractSignals(msg: MailMessage, history: SenderHistory, ctx: SignalContext): Signals`.
  - `test/fixtures/builders.ts` (contracts 10.2, issue #23): `TEST_NOW` (2026-10-15T00:00:00Z epoch ms), `DAY_MS`, `makeMailHeaders(overrides?)`, `MailMessageOverrides`, `makeMailMessage(overrides?)`, `makeSenderHistory(overrides?)`, `makeSignals(overrides?)`, `makePolicy(overrides?)`. Task 11 appends `makeDecisionResult`.

- [ ] **Step 1: Write the builders**

The builders are test infrastructure used by the failing test below. `packages/core/test/fixtures/builders.ts`:

```ts
import type { MailHeaders, MailMessage } from "../../src/model/mail.ts";
import { DEFAULT_POLICY, type Policy } from "../../src/policy/policy.ts";
import type { SenderHistory, Signals } from "../../src/signals/signals.ts";

/** Fixed test clock: 2026-10-15T00:00:00.000Z. */
export const TEST_NOW = Date.UTC(2026, 9, 15);
export const DAY_MS = 86_400_000;

export function makeMailHeaders(overrides: Partial<MailHeaders> = {}): MailHeaders {
  return {
    listUnsubscribe: null,
    listUnsubscribePost: null,
    listId: null,
    precedence: null,
    autoSubmitted: null,
    authenticationResults: null,
    returnPath: null,
    contentType: null,
    references: null,
    inReplyTo: null,
    ...overrides,
  };
}

export type MailMessageOverrides = Partial<Omit<MailMessage, "headers">> & { headers?: Partial<MailHeaders> };

/** A plain, read, 10-day-old message from a synthetic shop sender to owner@example.test. */
export function makeMailMessage(overrides: MailMessageOverrides = {}): MailMessage {
  const { headers, ...rest } = overrides;
  return {
    providerMessageId: "msg-0001",
    threadId: "thr-0001",
    internetMessageId: "<0001@mail.example.com>",
    receivedAt: TEST_NOW - 10 * DAY_MS,
    from: { address: "news@shop.example.com", name: "Example Shop" },
    to: ["owner@example.test"],
    cc: [],
    deliveredTo: [],
    subject: "Weekly picks from Example Shop",
    snippet: "New arrivals this week.",
    isRead: true,
    starred: false,
    providerImportant: false,
    category: null,
    hasAttachments: false,
    attachmentsApprox: false,
    threadDepth: 1,
    webLink: null,
    labels: [],
    ...rest,
    headers: makeMailHeaders(headers),
  };
}

export function makeSenderHistory(overrides: Partial<SenderHistory> = {}): SenderHistory {
  return {
    seenCount: 0,
    readCount: 0,
    isCorrespondent: false,
    senderPrior: null,
    domainPrior: null,
    ...overrides,
  };
}

/** Neutral signals: known sender, nothing bulk, nothing protected, 10 days old, read. */
export function makeSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    senderAddress: "news@shop.example.com",
    senderDomain: "example.com",
    senderName: "Example Shop",
    senderKnown: true,
    ownerReplied: false,
    isCorrespondent: false,
    senderSeenCount: 0,
    senderOpenRate: null,
    ownerDeleteRate: null,
    ownerDecisions: 0,
    hasListUnsubscribe: false,
    oneClickUnsubscribe: false,
    hasListId: false,
    precedenceBulk: false,
    autoSubmitted: false,
    espDomain: null,
    auth: { spf: "none", dkim: "none", dmarc: "none" },
    category: null,
    starred: false,
    providerImportant: false,
    ageDays: 10,
    isRead: true,
    hasAttachments: false,
    attachmentsApprox: false,
    threadDepth: 1,
    ownerPosition: "to",
    ...overrides,
  };
}

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...DEFAULT_POLICY,
    allowlist: [...DEFAULT_POLICY.allowlist],
    denylist: [...DEFAULT_POLICY.denylist],
    recordPatterns: [...DEFAULT_POLICY.recordPatterns],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/signals/signals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractSignals, type SignalContext } from "../../src/signals/signals.ts";
import { DAY_MS, TEST_NOW, makeMailMessage, makeSenderHistory } from "../fixtures/builders.ts";

const ctx: SignalContext = {
  now: TEST_NOW,
  ownerAddresses: ["owner@example.test", "alias@example.test"],
  repliedThreadIds: new Set(["thr-replied"]),
};

describe("extractSignals", () => {
  it("derives sender fields", () => {
    const s = extractSignals(makeMailMessage(), makeSenderHistory(), ctx);
    expect(s.senderAddress).toBe("news@shop.example.com");
    expect(s.senderDomain).toBe("example.com");
    expect(s.senderName).toBe("Example Shop");
    expect(s.senderKnown).toBe(true);
  });

  it("handles an unknown sender", () => {
    const s = extractSignals(
      makeMailMessage({ from: { address: null, name: "???" } }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.senderAddress, s.senderDomain, s.senderKnown]).toEqual(["", "", false]);
  });

  it("detects owner replies by thread id", () => {
    expect(
      extractSignals(makeMailMessage({ threadId: "thr-replied" }), makeSenderHistory(), ctx).ownerReplied,
    ).toBe(true);
    expect(extractSignals(makeMailMessage({ threadId: null }), makeSenderHistory(), ctx).ownerReplied).toBe(
      false,
    );
  });

  it("computes history rates", () => {
    const s = extractSignals(
      makeMailMessage(),
      makeSenderHistory({
        seenCount: 20,
        readCount: 1,
        isCorrespondent: true,
        senderPrior: { deletes: 3, keeps: 1 },
      }),
      ctx,
    );
    expect(s.senderSeenCount).toBe(20);
    expect(s.senderOpenRate).toBeCloseTo(0.05, 9);
    expect(s.ownerDeleteRate).toBeCloseTo(0.75, 9);
    expect(s.ownerDecisions).toBe(4);
    expect(s.isCorrespondent).toBe(true);
  });

  it("leaves rates null without history", () => {
    const s = extractSignals(
      makeMailMessage(),
      makeSenderHistory({ senderPrior: { deletes: 0, keeps: 0 } }),
      ctx,
    );
    expect([s.senderOpenRate, s.ownerDeleteRate, s.ownerDecisions]).toEqual([null, null, 0]);
  });

  it("reads bulk headers", () => {
    const s = extractSignals(
      makeMailMessage({
        headers: {
          listUnsubscribe: "<https://shop.example.com/u/1>, <mailto:u@shop.example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
          listId: "<deals.shop.example.com>",
          precedence: "bulk",
          autoSubmitted: "auto-generated",
          returnPath: "<bounce-123@mailer.esp.example.net>",
          authenticationResults: "mx.google.com; spf=pass smtp.mailfrom=x; dkim=fail; dmarc=fail",
        },
      }),
      makeSenderHistory(),
      ctx,
    );
    expect(s.hasListUnsubscribe).toBe(true);
    expect(s.oneClickUnsubscribe).toBe(true);
    expect(s.hasListId).toBe(true);
    expect(s.precedenceBulk).toBe(true);
    expect(s.autoSubmitted).toBe(true);
    expect(s.espDomain).toBe("example.net");
    expect(s.auth).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
  });

  it("requires an https URI for one-click unsubscribe and treats <> Return-Path as no ESP", () => {
    const s = extractSignals(
      makeMailMessage({
        headers: {
          listUnsubscribe: "<mailto:u@shop.example.com>",
          listUnsubscribePost: "List-Unsubscribe=One-Click",
          returnPath: "<>",
        },
      }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.hasListUnsubscribe, s.oneClickUnsubscribe, s.espDomain]).toEqual([true, false, null]);
  });

  it("computes age in whole days, never negative", () => {
    expect(
      extractSignals(makeMailMessage({ receivedAt: TEST_NOW - 3 * DAY_MS - 1 }), makeSenderHistory(), ctx)
        .ageDays,
    ).toBe(3);
    expect(
      extractSignals(makeMailMessage({ receivedAt: TEST_NOW + DAY_MS }), makeSenderHistory(), ctx).ageDays,
    ).toBe(0);
  });

  it("passes message flags through", () => {
    const s = extractSignals(
      makeMailMessage({
        starred: true,
        providerImportant: true,
        category: "promotions",
        isRead: false,
        hasAttachments: true,
        attachmentsApprox: true,
        threadDepth: 4,
      }),
      makeSenderHistory(),
      ctx,
    );
    expect([s.starred, s.providerImportant, s.category, s.isRead]).toEqual([true, true, "promotions", false]);
    expect([s.hasAttachments, s.attachmentsApprox, s.threadDepth]).toEqual([true, true, 4]);
  });

  describe("ownerPosition", () => {
    it("is to when an owner address or alias is in To", () => {
      expect(
        extractSignals(makeMailMessage({ to: ["alias@example.test"] }), makeSenderHistory(), ctx)
          .ownerPosition,
      ).toBe("to");
    });

    it("is cc when an owner address is only in Cc", () => {
      const msg = makeMailMessage({ to: ["someone@example.com"], cc: ["owner@example.test"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("cc");
    });

    it("counts Delivered-To addresses as owner addresses", () => {
      const msg = makeMailMessage({ to: ["old@example.org"], deliveredTo: ["old@example.org"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("to");
    });

    it("is bcc_or_list otherwise", () => {
      const msg = makeMailMessage({ to: ["list@example.com"], deliveredTo: ["owner@example.test"] });
      expect(extractSignals(msg, makeSenderHistory(), ctx).ownerPosition).toBe("bcc_or_list");
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/signals`
Expected: FAIL with `Cannot find module '../../src/signals/signals.ts'`.

- [ ] **Step 4: Write the signal extractor**

`packages/core/src/signals/signals.ts`:

```ts
import type { AuthVerdict, MailCategory, MailMessage, OwnerPosition } from "../model/mail.ts";
import type { PriorCounts } from "../priors/priors.ts";
import { parseAddress, registrableDomain } from "../text/address.ts";
import {
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "../text/headers.ts";

export interface SenderHistory {
  /** Messages from this sender already stored, plus earlier messages from the same sender on the current page (the caller accumulates). */
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
  /** "" when unknown. */
  senderAddress: string;
  /** Registrable domain, "" when unknown. */
  senderDomain: string;
  senderName: string | null;
  /** Address parsed. */
  senderKnown: boolean;
  ownerReplied: boolean;
  isCorrespondent: boolean;
  /** Includes earlier messages on the same page. */
  senderSeenCount: number;
  /** readCount / seenCount, null when seenCount = 0. */
  senderOpenRate: number | null;
  /** senderPrior deletes / (deletes + keeps), null when no decisions. */
  ownerDeleteRate: number | null;
  /** senderPrior deletes + keeps. */
  ownerDecisions: number;
  hasListUnsubscribe: boolean;
  /** List-Unsubscribe-Post === "List-Unsubscribe=One-Click" and an https URI. */
  oneClickUnsubscribe: boolean;
  hasListId: boolean;
  /** bulk | list | junk. */
  precedenceBulk: boolean;
  /** Any value except "no". */
  autoSubmitted: boolean;
  /** Registrable domain of Return-Path, null for "<>" or missing. */
  espDomain: string | null;
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
  category: MailCategory | null;
  starred: boolean;
  providerImportant: boolean;
  /** floor((now - receivedAt) / 86_400_000), min 0. */
  ageDays: number;
  isRead: boolean;
  hasAttachments: boolean;
  attachmentsApprox: boolean;
  threadDepth: number | null;
  /** "to" if an owner address (or a Delivered-To address) is in To, "cc" if in Cc, else "bcc_or_list". */
  ownerPosition: OwnerPosition;
}

const DAY_MS = 86_400_000;

function ownerPosition(msg: MailMessage, ownerAddresses: readonly string[]): OwnerPosition {
  const owners = new Set([...ownerAddresses, ...msg.deliveredTo].map((a) => a.toLowerCase()));
  if (msg.to.some((a) => owners.has(a.toLowerCase()))) return "to";
  if (msg.cc.some((a) => owners.has(a.toLowerCase()))) return "cc";
  return "bcc_or_list";
}

function espDomain(returnPath: string | null): string | null {
  if (returnPath === null) return null;
  const parsed = parseAddress(returnPath);
  if (parsed.address === null) return null;
  const domain = registrableDomain(parsed.address);
  return domain === "" ? null : domain;
}

export function extractSignals(msg: MailMessage, history: SenderHistory, ctx: SignalContext): Signals {
  const address = msg.from.address ?? "";
  const headers = msg.headers;
  const unsubscribe = parseListUnsubscribe(headers.listUnsubscribe);
  const oneClickPost =
    (headers.listUnsubscribePost ?? "").trim().toLowerCase() === "list-unsubscribe=one-click";
  const auth = parseAuthResults(headers.authenticationResults);
  const prior = history.senderPrior;
  const ownerDecisions = prior === null ? 0 : prior.deletes + prior.keeps;

  return {
    senderAddress: address,
    senderDomain: address === "" ? "" : registrableDomain(address),
    senderName: msg.from.name,
    senderKnown: msg.from.address !== null,
    ownerReplied: msg.threadId !== null && ctx.repliedThreadIds.has(msg.threadId),
    isCorrespondent: history.isCorrespondent,
    senderSeenCount: history.seenCount,
    senderOpenRate: history.seenCount > 0 ? history.readCount / history.seenCount : null,
    ownerDeleteRate: prior !== null && ownerDecisions > 0 ? prior.deletes / ownerDecisions : null,
    ownerDecisions,
    hasListUnsubscribe: unsubscribe.https.length + unsubscribe.mailto.length > 0,
    oneClickUnsubscribe: oneClickPost && unsubscribe.https.length > 0,
    hasListId: (headers.listId ?? "").trim() !== "",
    precedenceBulk: isBulkPrecedence(headers.precedence),
    autoSubmitted: isAutoSubmitted(headers.autoSubmitted),
    espDomain: espDomain(headers.returnPath),
    auth: { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc },
    category: msg.category,
    starred: msg.starred,
    providerImportant: msg.providerImportant,
    ageDays: Math.max(0, Math.floor((ctx.now - msg.receivedAt) / DAY_MS)),
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    attachmentsApprox: msg.attachmentsApprox,
    threadDepth: msg.threadDepth,
    ownerPosition: ownerPosition(msg, ctx.ownerAddresses),
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/signals`
Expected: PASS, `Tests  13 passed (13)`.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/signals packages/core/test/signals packages/core/test/fixtures/builders.ts
git commit -m "feat(core): add signal extraction and synthetic test builders"
```

---

### Task 10: Guardrails

**Files:**
- Create: `packages/core/src/guardrails/guardrails.ts`
- Test: `packages/core/test/guardrails/guardrails.test.ts`

**Interfaces:**
- Consumes: `Ceiling`, `minCeiling` (Task 2); `Reason` (Task 2); `Policy`, `matchesSenderList`, `matchRecordPattern` (Task 7); `Signals` (Task 9); `makeSignals`, `makePolicy` (Task 9 builders).
- Produces (contracts 4.7, issue #6): `GuardrailInput { signals; subject; snippet }`, `GuardrailResult { ceiling; reasons; allowlisted; denylisted }`, `evaluateGuardrails(input: GuardrailInput, policy: Policy): GuardrailResult`. Rules in order: starred, replied, allowlist, too recent (all keep, never lifted), then (skipped when denylisted) correspondent (keep), attachment (archive), record pattern (archive). `reasons` holds caps only.

- [ ] **Step 1: Write the failing test (full ceiling matrix)**

`packages/core/test/guardrails/guardrails.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateGuardrails, type GuardrailInput } from "../../src/guardrails/guardrails.ts";
import type { Ceiling } from "../../src/model/actions.ts";
import type { ReasonCode } from "../../src/model/reasons.ts";
import type { Signals } from "../../src/signals/signals.ts";
import { makePolicy, makeSignals } from "../fixtures/builders.ts";

function input(signals: Partial<Signals> = {}, subject = "Weekly picks", snippet = ""): GuardrailInput {
  return { signals: makeSignals(signals), subject, snippet };
}

const SENDER = { senderAddress: "news@shop.example.com", senderDomain: "example.com" };
const ALLOW = makePolicy({ allowlist: ["news@shop.example.com"] });
const DENY = makePolicy({ denylist: ["@example.com"] });

describe("evaluateGuardrails", () => {
  it("allows delete when nothing matches", () => {
    expect(evaluateGuardrails(input(), makePolicy())).toEqual({
      ceiling: "delete",
      reasons: [],
      allowlisted: false,
      denylisted: false,
    });
  });

  // Ceiling matrix: every rule alone, with and without the denylist.
  const matrix: {
    name: string;
    signals: Partial<Signals>;
    subject?: string;
    policy: "plain" | "allow";
    ceiling: Ceiling;
    code: ReasonCode;
    deniedCeiling: Ceiling;
  }[] = [
    {
      name: "starred",
      signals: { starred: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_starred",
      deniedCeiling: "keep",
    },
    {
      name: "owner replied",
      signals: { ownerReplied: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_replied",
      deniedCeiling: "keep",
    },
    {
      name: "too recent",
      signals: { ageDays: 2 },
      policy: "plain",
      ceiling: "keep",
      code: "guard_too_recent",
      deniedCeiling: "keep",
    },
    {
      name: "correspondent",
      signals: { isCorrespondent: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_correspondent",
      deniedCeiling: "delete",
    },
    {
      name: "attachment",
      signals: { hasAttachments: true },
      policy: "plain",
      ceiling: "archive",
      code: "guard_attachment",
      deniedCeiling: "delete",
    },
    {
      name: "record pattern",
      signals: {},
      subject: "Your invoice #42",
      policy: "plain",
      ceiling: "archive",
      code: "guard_record_pattern",
      deniedCeiling: "delete",
    },
  ];

  it.each(matrix)("$name caps at $ceiling ($code), denylisted -> $deniedCeiling", (row) => {
    const plain = evaluateGuardrails(input({ ...SENDER, ...row.signals }, row.subject), makePolicy());
    expect(plain.ceiling).toBe(row.ceiling);
    expect(plain.reasons.map((r) => r.code)).toEqual([row.code]);

    const denied = evaluateGuardrails(input({ ...SENDER, ...row.signals }, row.subject), DENY);
    expect(denied.denylisted).toBe(true);
    expect(denied.ceiling).toBe(row.deniedCeiling);
  });

  it("allowlist caps at keep and beats the denylist", () => {
    const result = evaluateGuardrails(
      input(SENDER),
      makePolicy({ allowlist: ALLOW.allowlist, denylist: DENY.denylist }),
    );
    expect(result).toMatchObject({ ceiling: "keep", allowlisted: true, denylisted: false });
    expect(result.reasons.map((r) => r.code)).toEqual(["guard_allowlist"]);
  });

  it("denylist alone does not cap and adds no cap reason", () => {
    const result = evaluateGuardrails(input(SENDER), DENY);
    expect(result).toEqual({ ceiling: "delete", reasons: [], allowlisted: false, denylisted: true });
  });

  it("reports every cap in rule order with params", () => {
    const result = evaluateGuardrails(
      input(
        { starred: true, ownerReplied: true, ageDays: 0, isCorrespondent: true, hasAttachments: true },
        "Tax statement",
      ),
      makePolicy({ minAgeDays: 3 }),
    );
    expect(result.ceiling).toBe("keep");
    expect(result.reasons).toEqual([
      { code: "guard_starred", params: {} },
      { code: "guard_replied", params: {} },
      { code: "guard_too_recent", params: { minAgeDays: 3 } },
      { code: "guard_correspondent", params: {} },
      { code: "guard_attachment", params: {} },
      { code: "guard_record_pattern", params: { pattern: "tax" } },
    ]);
  });

  it("minAgeDays 0 never triggers too recent", () => {
    expect(evaluateGuardrails(input({ ageDays: 0 }), makePolicy({ minAgeDays: 0 })).ceiling).toBe("delete");
  });

  it("matches record patterns in the snippet", () => {
    expect(evaluateGuardrails(input({}, "Hello", "your medical results"), makePolicy()).ceiling).toBe(
      "archive",
    );
  });

  it("ignores providerImportant", () => {
    expect(evaluateGuardrails(input({ providerImportant: true }), makePolicy()).ceiling).toBe("delete");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/guardrails`
Expected: FAIL with `Cannot find module '../../src/guardrails/guardrails.ts'`.

- [ ] **Step 3: Write the guardrails**

`packages/core/src/guardrails/guardrails.ts`:

```ts
import { minCeiling, type Ceiling } from "../model/actions.ts";
import type { Reason } from "../model/reasons.ts";
import { matchesSenderList, matchRecordPattern, type Policy } from "../policy/policy.ts";
import type { Signals } from "../signals/signals.ts";

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

export function evaluateGuardrails(input: GuardrailInput, policy: Policy): GuardrailResult {
  const { signals } = input;
  const allowlisted = matchesSenderList(signals.senderAddress, signals.senderDomain, policy.allowlist);
  const denylisted =
    !allowlisted && matchesSenderList(signals.senderAddress, signals.senderDomain, policy.denylist);

  let ceiling: Ceiling = "delete";
  const reasons: Reason[] = [];
  const cap = (to: Ceiling, reason: Reason): void => {
    ceiling = minCeiling(ceiling, to);
    reasons.push(reason);
  };

  if (signals.starred) cap("keep", { code: "guard_starred", params: {} });
  if (signals.ownerReplied) cap("keep", { code: "guard_replied", params: {} });
  if (allowlisted) cap("keep", { code: "guard_allowlist", params: {} });
  if (signals.ageDays < policy.minAgeDays) {
    cap("keep", { code: "guard_too_recent", params: { minAgeDays: policy.minAgeDays } });
  }
  if (!denylisted) {
    if (signals.isCorrespondent) cap("keep", { code: "guard_correspondent", params: {} });
    if (signals.hasAttachments) cap("archive", { code: "guard_attachment", params: {} });
    const pattern = matchRecordPattern(input.subject, input.snippet, policy.recordPatterns);
    if (pattern !== null) cap("archive", { code: "guard_record_pattern", params: { pattern } });
  }

  return { ceiling, reasons, allowlisted, denylisted };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/guardrails`
Expected: PASS, `Tests  13 passed (13)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/guardrails packages/core/test/guardrails
git commit -m "feat(core): add guardrail ceilings with denylist precedence"
```

---

### Task 11: Decision engine contract and state builder with token budget

**Files:**
- Create: `packages/core/src/decision/engine.ts`, `packages/core/src/decision/state.ts`
- Modify: `packages/core/test/fixtures/builders.ts` (add one import and `makeDecisionResult`)
- Test: `packages/core/test/decision/state.test.ts`

**Interfaces:**
- Consumes: `ActionDistribution`, `ActionKind`, `MailMessage`, `MailCategory`, `OwnerPosition`, `AuthVerdict`, `DECISION_*` and `PAST_DECISION*` constants (Task 2); `Signals` (Task 9); `truncateChars` (Task 5).
- Produces (contracts 4.9.1, 4.9.4; issue #11):
  - `engine.ts`: `DecisionFlags { isRecord; isExpired; isFromHuman }`, `DecisionResult`, `DecisionInput { key; state; seed }`, `DecisionEngine { readonly name: "mai" | "fake"; decide(input): Promise<DecisionResult> }`.
  - `state.ts`: `PastDecision { domain; subject; owner_action }`, `DecisionState`, `BuildStateInput { msg; signals; pastDecisions }`, `buildDecisionState(input: BuildStateInput): DecisionState` (compact JSON <= 1,750 chars; shrink order: drop past decisions from the end, snippet 150, snippet `""`, subject 60, subject `""`).
  - builders: `makeDecisionResult(overrides?: Partial<DecisionResult>): DecisionResult`.

- [ ] **Step 1: Add `makeDecisionResult` to the builders**

In `packages/core/test/fixtures/builders.ts`, add this line as the first import:

```ts
import type { DecisionResult } from "../../src/decision/engine.ts";
```

and append at the end of the file:

```ts
/** A keep-leaning model result with low flags and importance 1. */
export function makeDecisionResult(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    action: { delete: 0.1, archive: 0.2, keep: 0.6, unsure: 0.1 },
    importance: 1,
    flags: { isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 },
    responseModel: "microsoft-decision-1",
    modelVersion: "decision-1/microsoft-decision-1",
    inputTokens: 500,
    requestId: null,
    latencyMs: 0,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/decision/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDecisionState, type PastDecision } from "../../src/decision/state.ts";
import { DECISION_STATE_MAX_CHARS } from "../../src/model/constants.ts";
import { makeMailMessage, makeSignals } from "../fixtures/builders.ts";

function past(n: number, subject = "Flash sale: boots 30% off"): PastDecision[] {
  return Array.from({ length: n }, () => ({
    domain: "shop.example.com",
    subject,
    owner_action: "delete" as const,
  }));
}

describe("buildDecisionState", () => {
  it("maps message and signals to the snake_case state", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Last chance", snippet: "Ends tonight" }),
      signals: makeSignals({
        hasListUnsubscribe: true,
        precedenceBulk: true,
        category: "promotions",
        isRead: false,
        ageDays: 41,
        senderSeenCount: 37,
        senderOpenRate: 1 / 3,
        ownerDeleteRate: 0.666666,
        ownerDecisions: 14,
        auth: { spf: "pass", dkim: "pass", dmarc: "fail" },
      }),
      pastDecisions: past(1),
    });
    expect(state).toEqual({
      email: {
        from: "news@shop.example.com",
        domain: "example.com",
        subject: "Last chance",
        snippet: "Ends tonight",
        age_days: 41,
        signals: {
          has_list_unsubscribe: true,
          precedence_bulk: true,
          auto_submitted: false,
          category: "promotions",
          is_read: false,
          has_attachments: false,
          owner_position: "to",
          thread_depth: 1,
          provider_important: false,
          auth: { spf: "pass", dkim: "pass", dmarc: "fail" },
        },
      },
      sender_history: {
        messages_seen: 37,
        open_rate: 0.33,
        owner_delete_rate: 0.67,
        owner_decisions: 14,
        is_correspondent: false,
      },
      similar_past_decisions: past(1),
    });
  });

  it("uses 'unknown' for an unparseable sender", () => {
    const state = buildDecisionState({
      msg: makeMailMessage(),
      signals: makeSignals({ senderAddress: "", senderDomain: "" }),
      pastDecisions: [],
    });
    expect(state.email.from).toBe("unknown");
    expect(state.email.domain).toBe("");
  });

  it("caps subject, snippet, past decision count and past subjects", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "s".repeat(500), snippet: "n".repeat(500) }),
      signals: makeSignals(),
      pastDecisions: past(9, "p".repeat(100)),
    });
    expect(state.email.subject).toHaveLength(120);
    expect(state.similar_past_decisions.length).toBeLessThanOrEqual(5);
    for (const d of state.similar_past_decisions) expect(d.subject).toHaveLength(60);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("keeps everything when the state already fits", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: "n".repeat(300) }),
      signals: makeSignals(),
      pastDecisions: past(5, "short"),
    });
    expect(state.similar_past_decisions).toHaveLength(5);
    expect(state.email.snippet).toHaveLength(300);
  });

  it("drops past decisions from the end first", () => {
    const decisions = Array.from({ length: 5 }, (_, i) => ({
      domain: `d${String(i)}.example.com`,
      subject: "\u0001".repeat(60),
      owner_action: "keep" as const,
    }));
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: "n".repeat(300) }),
      signals: makeSignals(),
      pastDecisions: decisions,
    });
    expect(state.similar_past_decisions.length).toBeLessThan(5);
    expect(state.similar_past_decisions.map((d) => d.domain)).toEqual(
      decisions.slice(0, state.similar_past_decisions.length).map((d) => d.domain),
    );
    expect(state.email.snippet).toHaveLength(300);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  // JSON escapes each U+0001 as 6 chars, so these fields are expensive. The base state is about 520 chars.
  const heavy = (n: number): string => "\u0001".repeat(n);

  it("then shrinks the snippet to 150 chars", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: heavy(250) }),
      signals: makeSignals(),
      pastDecisions: past(5),
    });
    expect(state.similar_past_decisions).toEqual([]);
    expect(state.email.snippet).toHaveLength(150);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("then empties the snippet", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals(),
      pastDecisions: [],
    });
    expect(state.email.snippet).toBe("");
    expect(state.email.subject).toHaveLength(120);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("then shrinks the subject to 60 chars", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals({ senderDomain: heavy(100) }),
      pastDecisions: [],
    });
    expect(state.email.snippet).toBe("");
    expect(state.email.subject).toHaveLength(60);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("finally empties the subject", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals({ senderDomain: heavy(200) }),
      pastDecisions: [],
    });
    expect(state.email.subject).toBe("");
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/state.test.ts`
Expected: FAIL with `Cannot find module '../../src/decision/state.ts'`.

- [ ] **Step 4: Write the engine contract**

`packages/core/src/decision/engine.ts`:

```ts
import type { ActionDistribution } from "../model/actions.ts";
import type { DecisionState } from "./state.ts";

export interface DecisionFlags {
  isRecord: number;
  isExpired: number;
  isFromHuman: number;
}

export interface DecisionResult {
  /** From answers.action.probabilities, renormalized to sum exactly 1. */
  action: ActionDistribution;
  /** answers.importance.score, 0..4. */
  importance: number;
  flags: DecisionFlags;
  /** e.g. "microsoft-decision-1". */
  responseModel: string;
  /** `${deployment}/${responseModel}`; FakeEngine: "fake/fake-1". */
  modelVersion: string;
  inputTokens: number;
  /** apim-request-id header. */
  requestId: string | null;
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
```

- [ ] **Step 5: Write the state builder**

`packages/core/src/decision/state.ts`:

```ts
import type { ActionKind } from "../model/actions.ts";
import {
  DECISION_SNIPPET_MAX_CHARS,
  DECISION_STATE_MAX_CHARS,
  DECISION_SUBJECT_MAX_CHARS,
  PAST_DECISION_SUBJECT_MAX_CHARS,
  PAST_DECISIONS_MAX,
} from "../model/constants.ts";
import type { AuthVerdict, MailCategory, MailMessage, OwnerPosition } from "../model/mail.ts";
import type { Signals } from "../signals/signals.ts";
import { truncateChars } from "../text/truncate.ts";

export interface PastDecision {
  domain: string;
  /** Truncated to 60 chars, "" when labels have no subject. */
  subject: string;
  owner_action: ActionKind;
}

/** Exactly the JSON object sent as `state`. Compact JSON, no indentation. */
export interface DecisionState {
  email: {
    /** Sender address ("unknown" when not parseable). */
    from: string;
    domain: string;
    /** <= DECISION_SUBJECT_MAX_CHARS. */
    subject: string;
    /** <= DECISION_SNIPPET_MAX_CHARS. */
    snippet: string;
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
    /** Rounded to 2 decimals. */
    open_rate: number | null;
    /** Rounded to 2 decimals. */
    owner_delete_rate: number | null;
    owner_decisions: number;
    is_correspondent: boolean;
  };
  /** <= 5: same sender first, then same domain, newest first. */
  similar_past_decisions: PastDecision[];
}

export interface BuildStateInput {
  msg: MailMessage;
  signals: Signals;
  pastDecisions: PastDecision[];
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function stateLength(state: DecisionState): number {
  return JSON.stringify(state).length;
}

/**
 * Token budget: JSON.stringify(state).length <= DECISION_STATE_MAX_CHARS (1,750 chars = 500 tokens at 3.5 chars/token).
 * Shrink order until it fits: drop similar_past_decisions from the end one by one,
 * then snippet to 150 chars, then snippet to "", then subject to 60 chars, then subject to "".
 */
export function buildDecisionState(input: BuildStateInput): DecisionState {
  const { msg, signals } = input;
  const state: DecisionState = {
    email: {
      from: signals.senderAddress === "" ? "unknown" : signals.senderAddress,
      domain: signals.senderDomain,
      subject: truncateChars(msg.subject, DECISION_SUBJECT_MAX_CHARS),
      snippet: truncateChars(msg.snippet, DECISION_SNIPPET_MAX_CHARS),
      age_days: signals.ageDays,
      signals: {
        has_list_unsubscribe: signals.hasListUnsubscribe,
        precedence_bulk: signals.precedenceBulk,
        auto_submitted: signals.autoSubmitted,
        category: signals.category,
        is_read: signals.isRead,
        has_attachments: signals.hasAttachments,
        owner_position: signals.ownerPosition,
        thread_depth: signals.threadDepth,
        provider_important: signals.providerImportant,
        auth: { ...signals.auth },
      },
    },
    sender_history: {
      messages_seen: signals.senderSeenCount,
      open_rate: round2(signals.senderOpenRate),
      owner_delete_rate: round2(signals.ownerDeleteRate),
      owner_decisions: signals.ownerDecisions,
      is_correspondent: signals.isCorrespondent,
    },
    similar_past_decisions: input.pastDecisions.slice(0, PAST_DECISIONS_MAX).map((d) => ({
      domain: d.domain,
      subject: truncateChars(d.subject, PAST_DECISION_SUBJECT_MAX_CHARS),
      owner_action: d.owner_action,
    })),
  };

  while (stateLength(state) > DECISION_STATE_MAX_CHARS && state.similar_past_decisions.length > 0) {
    state.similar_past_decisions.pop();
  }
  const shrinkSteps: (() => void)[] = [
    () => (state.email.snippet = truncateChars(state.email.snippet, 150)),
    () => (state.email.snippet = ""),
    () => (state.email.subject = truncateChars(state.email.subject, 60)),
    () => (state.email.subject = ""),
  ];
  for (const step of shrinkSteps) {
    if (stateLength(state) <= DECISION_STATE_MAX_CHARS) break;
    step();
  }
  return state;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/state.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0 (the builders now compile against `engine.ts`).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/decision/engine.ts packages/core/src/decision/state.ts packages/core/test/decision/state.test.ts packages/core/test/fixtures/builders.ts
git commit -m "feat(core): add DecisionEngine contract and token-budgeted state builder"
```

---

### Task 12: Decision-1 questions, seeded option shuffle and request body

**Files:**
- Create: `packages/core/src/decision/questions.ts`
- Test: `packages/core/test/decision/questions.test.ts`

**Interfaces:**
- Consumes: `fnv1a32`, `seededShuffle` (Task 4); `DecisionState`, `buildDecisionState` (Task 11).
- Produces (contracts 4.9.2, issue #5): `ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `DecisionQuestions`, `DecisionRequestBody { model; state; questions }` (no other top-level fields), `IMPORTANCE_LEVELS = ["Noise", "Low", "Moderate", "High", "Critical"]`, `DECISION_QUESTIONS` (canonical texts, design spec 6.3), `buildDecisionQuestions(seed: number): DecisionQuestions` (only `action.criteria` key order depends on the seed), `buildDecisionRequest(state, deployment, seed): DecisionRequestBody`, `decisionSeed(accountId, providerMessageId): number` (FNV-1a of the string `accountId + ":" + providerMessageId`).

- [ ] **Step 1: Write the failing test**

`packages/core/test/decision/questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DECISION_QUESTIONS,
  IMPORTANCE_LEVELS,
  buildDecisionQuestions,
  buildDecisionRequest,
  decisionSeed,
} from "../../src/decision/questions.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { fnv1a32 } from "../../src/util/rng.ts";
import { makeMailMessage, makeSignals } from "../fixtures/builders.ts";

const SPEC_CRITERIA = {
  delete:
    "No future value: promotions, expired notifications, ignored newsletters, superseded automated alerts",
  archive: "Worth keeping as a record but needs no attention: receipts, confirmations, completed threads",
  keep: "Needs attention or is personally important to the owner",
  unsure: "Cannot tell from the information given",
};

describe("DECISION_QUESTIONS", () => {
  it("uses the design spec 6.3 wording", () => {
    expect(DECISION_QUESTIONS.action.instructions).toBe("What should the mailbox owner do with this email?");
    expect(DECISION_QUESTIONS.action.criteria).toEqual(SPEC_CRITERIA);
    expect(DECISION_QUESTIONS.importance).toEqual({
      type: "score",
      instructions: "How important is this email to the owner?",
      criteria: ["Noise", "Low", "Moderate", "High", "Critical"],
    });
    expect(DECISION_QUESTIONS.is_record.instructions).toBe(
      "Is this a record the owner may need later (receipt, invoice, contract, statement, ticket, account notice)?",
    );
    expect(DECISION_QUESTIONS.is_expired.instructions).toBe(
      "Is the content time-bound, and has that time passed (one-time code, ended sale, past event)?",
    );
    expect(DECISION_QUESTIONS.is_from_human.instructions).toBe(
      "Was this written personally by a human to the owner, not generated by an automated system?",
    );
    expect(IMPORTANCE_LEVELS).toEqual(["Noise", "Low", "Moderate", "High", "Critical"]);
  });
});

describe("buildDecisionQuestions", () => {
  it("keeps keys and texts, shuffling only the action key order", () => {
    const q = buildDecisionQuestions(12345);
    expect(Object.keys(q)).toEqual(["action", "importance", "is_record", "is_expired", "is_from_human"]);
    expect([...Object.keys(q.action.criteria)].sort()).toEqual(["archive", "delete", "keep", "unsure"]);
    for (const [key, text] of Object.entries(q.action.criteria)) {
      expect(text).toBe(SPEC_CRITERIA[key as keyof typeof SPEC_CRITERIA]);
    }
  });

  it("is deterministic per seed", () => {
    expect(JSON.stringify(buildDecisionQuestions(99))).toBe(JSON.stringify(buildDecisionQuestions(99)));
  });

  it("varies the option order across seeds", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 200; seed++)
      orders.add(Object.keys(buildDecisionQuestions(seed).action.criteria).join(","));
    expect(orders.size).toBe(24);
  });

  it("never shuffles importance levels", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(buildDecisionQuestions(seed).importance.criteria).toEqual([...IMPORTANCE_LEVELS]);
    }
  });

  it("does not mutate the shared DECISION_QUESTIONS", () => {
    const q = buildDecisionQuestions(1);
    q.importance.criteria.reverse();
    expect(DECISION_QUESTIONS.importance.criteria).toEqual([...IMPORTANCE_LEVELS]);
  });
});

describe("buildDecisionRequest", () => {
  it("has exactly model, state and questions", () => {
    const state = buildDecisionState({ msg: makeMailMessage(), signals: makeSignals(), pastDecisions: [] });
    const body = buildDecisionRequest(state, "decision-1", 7);
    expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
    expect(body.model).toBe("decision-1");
    expect(body.state).toBe(state);
    expect(body.questions).toEqual(buildDecisionQuestions(7));
  });
});

describe("decisionSeed", () => {
  it("is fnv1a32 of accountId:providerMessageId", () => {
    expect(decisionSeed("acc_0123456789abcdef", "msg-1")).toBe(fnv1a32("acc_0123456789abcdef:msg-1"));
    expect(decisionSeed("acc_0123456789abcdef", "msg-1")).not.toBe(
      decisionSeed("acc_0123456789abcdef", "msg-2"),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/questions.test.ts`
Expected: FAIL with `Cannot find module '../../src/decision/questions.ts'`.

- [ ] **Step 3: Write the questions module**

`packages/core/src/decision/questions.ts`:

```ts
import { fnv1a32, seededShuffle } from "../util/rng.ts";
import type { DecisionState } from "./state.ts";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export interface DecisionQuestions {
  /** Keys delete, archive, keep, unsure; key ORDER shuffled per request. */
  action: ChoiceQuestion;
  /** ["Noise", "Low", "Moderate", "High", "Critical"], ascending, never shuffled. */
  importance: ScoreQuestion;
  is_record: NoulQuestion;
  is_expired: NoulQuestion;
  is_from_human: NoulQuestion;
}

export interface DecisionRequestBody {
  /** Deployment name; NO other top-level fields. */
  model: string;
  state: DecisionState;
  questions: DecisionQuestions;
}

/** Importance levels, ascending; index = score. */
export const IMPORTANCE_LEVELS = ["Noise", "Low", "Moderate", "High", "Critical"] as const;

/** Fixed texts, equal to design spec 6.3. Canonical (unshuffled) option order: delete, archive, keep, unsure. */
export const DECISION_QUESTIONS: Readonly<DecisionQuestions> = {
  action: {
    type: "choice",
    instructions: "What should the mailbox owner do with this email?",
    criteria: {
      delete:
        "No future value: promotions, expired notifications, ignored newsletters, superseded automated alerts",
      archive: "Worth keeping as a record but needs no attention: receipts, confirmations, completed threads",
      keep: "Needs attention or is personally important to the owner",
      unsure: "Cannot tell from the information given",
    },
  },
  importance: {
    type: "score",
    instructions: "How important is this email to the owner?",
    criteria: [...IMPORTANCE_LEVELS],
  },
  is_record: {
    type: "noul",
    instructions:
      "Is this a record the owner may need later (receipt, invoice, contract, statement, ticket, account notice)?",
  },
  is_expired: {
    type: "noul",
    instructions:
      "Is the content time-bound, and has that time passed (one-time code, ended sale, past event)?",
  },
  is_from_human: {
    type: "noul",
    instructions:
      "Was this written personally by a human to the owner, not generated by an automated system?",
  },
};

/** Texts are fixed; only the key order of `action.criteria` depends on the seed. */
export function buildDecisionQuestions(seed: number): DecisionQuestions {
  const canonical = DECISION_QUESTIONS.action.criteria;
  const keys = seededShuffle(Object.keys(canonical), seed);
  const criteria: Record<string, string> = {};
  for (const key of keys) criteria[key] = canonical[key] as string;
  return {
    action: { ...DECISION_QUESTIONS.action, criteria },
    importance: { ...DECISION_QUESTIONS.importance, criteria: [...IMPORTANCE_LEVELS] },
    is_record: { ...DECISION_QUESTIONS.is_record },
    is_expired: { ...DECISION_QUESTIONS.is_expired },
    is_from_human: { ...DECISION_QUESTIONS.is_from_human },
  };
}

export function buildDecisionRequest(
  state: DecisionState,
  deployment: string,
  seed: number,
): DecisionRequestBody {
  return { model: deployment, state, questions: buildDecisionQuestions(seed) };
}

/** seed = fnv1a32(`${accountId}:${providerMessageId}`); retries reuse the same order. */
export function decisionSeed(accountId: string, providerMessageId: string): number {
  return fnv1a32(`${accountId}:${providerMessageId}`);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/questions.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/decision/questions.ts packages/core/test/decision/questions.test.ts
git commit -m "feat(core): add Decision-1 questions with seeded option shuffle"
```

---

### Task 13: Decision-1 response validation

**Files:**
- Create: `packages/core/src/decision/response.ts`
- Create: `packages/core/test/fixtures/decision/response-delete.json`, `packages/core/test/fixtures/decision/response-minimal.json`, `packages/core/test/fixtures/decision/error-deployment-not-found.json`, `packages/core/test/fixtures/decision/error-unprocessable.json`
- Test: `packages/core/test/decision/response.test.ts`

**Interfaces:**
- Consumes: `zod`; `ActionDistribution` (Task 2); `DecisionError` (Task 3); `DecisionResult` (Task 11).
- Produces (contracts 4.9.3 verbatim, issues #3, #21): `ChoiceAnswerSchema`, `ScoreAnswerSchema`, `NoulAnswerSchema`, `DecisionResponseSchema`, `DecisionResponse`, `NormalizeMeta { deployment: string; requestId: string | null; latencyMs: number }`, `normalizeDecisionResponse(body: unknown, meta: NormalizeMeta): DecisionResult` (renormalizes `answers.action.probabilities` to sum to 1, `importance = answers.importance.score`, flags from `noul`, `modelVersion = deployment + "/" + model`; ignores `confidence`; throws `DecisionError({ kind: "invalid_response" })`). The JSON fixtures follow research `decision-1.md` sections 4.3 and 5 and are synthetic.

- [ ] **Step 1: Write the fixtures**

`packages/core/test/fixtures/decision/response-delete.json` (the documented Clearbox response shape):

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "action": {
      "type": "choice",
      "choice": "delete",
      "confidence": 0.93,
      "probabilities": { "keep": 0.01, "delete": 0.95, "unsure": 0.02, "archive": 0.02 }
    },
    "importance": {
      "type": "score",
      "score": 0.21,
      "confidence": 0.7,
      "legend": { "0": "Noise", "1": "Low", "2": "Moderate", "3": "High", "4": "Critical" },
      "probabilities": { "0": 0.81, "1": 0.17, "2": 0.02, "3": 0.0, "4": 0.0 }
    },
    "is_record": { "type": "noul", "noul": 0.03 },
    "is_expired": { "type": "noul", "noul": 0.91 },
    "is_from_human": { "type": "noul", "noul": 0.01 }
  },
  "usage": { "input_tokens": 520, "output_tokens": 5 }
}
```

`packages/core/test/fixtures/decision/response-minimal.json` (only required fields; probabilities sum to 1.004):

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "action": {
      "type": "choice",
      "choice": "keep",
      "probabilities": { "delete": 0.1, "archive": 0.2, "keep": 0.6, "unsure": 0.104 }
    },
    "importance": { "type": "score", "score": 3.4 },
    "is_record": { "type": "noul", "noul": 0 },
    "is_expired": { "type": "noul", "noul": 1 },
    "is_from_human": { "type": "noul", "noul": 0.97 }
  },
  "usage": { "input_tokens": 431 }
}
```

`packages/core/test/fixtures/decision/error-deployment-not-found.json` (Azure 404 envelope):

```json
{ "error": { "code": "DeploymentNotFound", "message": "The API deployment decision-x does not exist." } }
```

`packages/core/test/fixtures/decision/error-unprocessable.json` (backend 422 body):

```json
{ "detail": "invalid TypeSafe request: too many tokens" }
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/decision/response.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ChoiceAnswerSchema,
  DecisionResponseSchema,
  NoulAnswerSchema,
  ScoreAnswerSchema,
  normalizeDecisionResponse,
} from "../../src/decision/response.ts";
import { DecisionError } from "../../src/model/errors.ts";
import deleteFixture from "../fixtures/decision/response-delete.json" with { type: "json" };
import minimalFixture from "../fixtures/decision/response-minimal.json" with { type: "json" };

const meta = { deployment: "decision-1", requestId: "req-1", latencyMs: 12 };

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("DecisionResponseSchema", () => {
  it("accepts the documented full response (research decision-1.md 4.3)", () => {
    expect(DecisionResponseSchema.safeParse(deleteFixture).success).toBe(true);
  });

  it("accepts a response without confidence, legend, score probabilities or output_tokens", () => {
    expect(DecisionResponseSchema.safeParse(minimalFixture).success).toBe(true);
  });

  it("tolerates unknown extra fields (loose objects)", () => {
    const body = {
      ...clone(deleteFixture),
      id: "x",
      answers: { ...clone(deleteFixture).answers, extra: { type: "noul", noul: 1 } },
    };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects a refusal or other unknown answer type", () => {
    const body = clone(deleteFixture) as Record<string, unknown> & { answers: Record<string, unknown> };
    body.answers.action = { type: "refusal", reason: "declined" };
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a missing question", () => {
    const body = clone(deleteFixture) as { answers: Partial<typeof deleteFixture.answers> };
    delete body.answers.is_expired;
    expect(DecisionResponseSchema.safeParse(body).success).toBe(false);
  });

  it("rejects missing usage.input_tokens", () => {
    expect(
      DecisionResponseSchema.safeParse({ ...clone(deleteFixture), usage: { output_tokens: 3 } }).success,
    ).toBe(false);
  });
});

describe("ChoiceAnswerSchema", () => {
  const ok = {
    type: "choice",
    choice: "delete",
    probabilities: { delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1 },
  };

  it("accepts four probabilities summing to 1 within 0.01", () => {
    expect(ChoiceAnswerSchema.safeParse(ok).success).toBe(true);
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.705, archive: 0.1, keep: 0.1, unsure: 0.1 },
      }).success,
    ).toBe(true);
  });

  it("rejects sums off by more than 0.01", () => {
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.8, archive: 0.1, keep: 0.1, unsure: 0.1 },
      }).success,
    ).toBe(false);
  });

  it("rejects missing or extra option keys", () => {
    expect(
      ChoiceAnswerSchema.safeParse({ ...ok, probabilities: { delete: 0.8, archive: 0.1, keep: 0.1 } })
        .success,
    ).toBe(false);
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1, snooze: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range probabilities and unknown choices", () => {
    expect(
      ChoiceAnswerSchema.safeParse({
        ...ok,
        probabilities: { delete: 1.2, archive: -0.2, keep: 0, unsure: 0 },
      }).success,
    ).toBe(false);
    expect(ChoiceAnswerSchema.safeParse({ ...ok, choice: "snooze" }).success).toBe(false);
  });
});

describe("ScoreAnswerSchema", () => {
  it("accepts scores 0..4 and index-keyed probabilities", () => {
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 0 }).success).toBe(true);
    const probabilities = { "0": 0.1, "1": 0, "2": 0, "3": 0, "4": 0.9 };
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 4, probabilities }).success).toBe(true);
  });

  it("requires all five level keys when probabilities are present (zod 4 enum records are exhaustive)", () => {
    expect(
      ScoreAnswerSchema.safeParse({ type: "score", score: 4, probabilities: { "0": 0.1, "4": 0.9 } }).success,
    ).toBe(false);
  });

  it("rejects scores outside 0..4 and label-keyed probabilities", () => {
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 4.01 }).success).toBe(false);
    expect(ScoreAnswerSchema.safeParse({ type: "score", score: 1, probabilities: { High: 1 } }).success).toBe(
      false,
    );
  });
});

describe("NoulAnswerSchema", () => {
  it("accepts a probability and rejects anything else", () => {
    expect(NoulAnswerSchema.safeParse({ type: "noul", noul: 0.5 }).success).toBe(true);
    expect(NoulAnswerSchema.safeParse({ type: "noul", noul: 1.5 }).success).toBe(false);
    expect(NoulAnswerSchema.safeParse({ type: "noul", probabilities: { true: 1 } }).success).toBe(false);
  });
});

describe("normalizeDecisionResponse", () => {
  it("maps answers to a DecisionResult", () => {
    const result = normalizeDecisionResponse(deleteFixture, meta);
    expect(result.action.delete).toBeCloseTo(0.95, 9);
    expect(result.action.archive).toBeCloseTo(0.02, 9);
    expect(result.importance).toBeCloseTo(0.21, 9);
    expect(result.flags).toEqual({ isRecord: 0.03, isExpired: 0.91, isFromHuman: 0.01 });
    expect(result.responseModel).toBe("microsoft-decision-1");
    expect(result.modelVersion).toBe("decision-1/microsoft-decision-1");
    expect(result.inputTokens).toBe(520);
    expect(result.requestId).toBe("req-1");
    expect(result.latencyMs).toBe(12);
  });

  it("renormalizes probabilities to sum to 1", () => {
    const result = normalizeDecisionResponse(minimalFixture, meta);
    const sum = result.action.delete + result.action.archive + result.action.keep + result.action.unsure;
    expect(sum).toBeCloseTo(1, 9);
    expect(result.action.keep).toBeCloseTo(0.6 / 1.004, 9);
    expect(result.importance).toBeCloseTo(3.4, 9);
  });

  it("throws DecisionError invalid_response, not retryable, item scope", () => {
    try {
      normalizeDecisionResponse({ model: "microsoft-decision-1", answers: {} }, meta);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionError);
      const e = error as DecisionError;
      expect([e.kind, e.retryable, e.scope, e.requestId]).toEqual([
        "invalid_response",
        false,
        "item",
        "req-1",
      ]);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/response.test.ts`
Expected: FAIL with `Cannot find module '../../src/decision/response.ts'`.

- [ ] **Step 4: Write the response module**

`packages/core/src/decision/response.ts`:

```ts
import { z } from "zod";
import type { ActionDistribution } from "../model/actions.ts";
import { DecisionError } from "../model/errors.ts";
import type { DecisionResult } from "./engine.ts";

const prob = z.number().finite().min(0).max(1);
const sumsToOne = (r: Record<string, number>) =>
  Math.abs(Object.values(r).reduce((s, p) => s + p, 0) - 1) <= 0.01;

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
  usage: z.looseObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative().optional(),
  }),
});

export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export interface NormalizeMeta {
  /** AZURE_DECISION_DEPLOYMENT, used for modelVersion. */
  deployment: string;
  requestId: string | null;
  latencyMs: number;
}

function renormalize(p: {
  delete: number;
  archive: number;
  keep: number;
  unsure: number;
}): ActionDistribution {
  const sum = p.delete + p.archive + p.keep + p.unsure;
  return { delete: p.delete / sum, archive: p.archive / sum, keep: p.keep / sum, unsure: p.unsure / sum };
}

/**
 * Validates a parsed response body against DecisionResponseSchema and maps it to a DecisionResult.
 * Throws DecisionError("invalid_response") on any validation failure. `confidence` is never used.
 */
export function normalizeDecisionResponse(body: unknown, meta: NormalizeMeta): DecisionResult {
  const parsed = DecisionResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DecisionError({
      kind: "invalid_response",
      status: 200,
      requestId: meta.requestId,
      message: "Decision-1 response failed validation",
    });
  }
  const { answers, model, usage } = parsed.data;
  return {
    action: renormalize(answers.action.probabilities),
    importance: answers.importance.score,
    flags: {
      isRecord: answers.is_record.noul,
      isExpired: answers.is_expired.noul,
      isFromHuman: answers.is_from_human.noul,
    },
    responseModel: model,
    modelVersion: `${meta.deployment}/${model}`,
    inputTokens: usage.input_tokens,
    requestId: meta.requestId,
    latencyMs: meta.latencyMs,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/response.test.ts`
Expected: PASS, `Tests  17 passed (17)`.

- [ ] **Step 6: Typecheck, lint and format**

Run: `pnpm typecheck && pnpm exec eslint packages/core && pnpm exec prettier --check packages/core`
Expected: exit 0 (`prettier --check` also covers the JSON fixtures).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/decision/response.ts packages/core/test/decision/response.test.ts packages/core/test/fixtures/decision
git commit -m "feat(core): validate Decision-1 responses with zod and normalize results"
```

---

### Task 14: MaiDecisionEngine and the Decision-1 MSW mock

**Files:**
- Create: `packages/core/src/decision/mai-engine.ts`, `packages/core/test/msw/decision.ts`
- Test: `packages/core/test/decision/mai-engine.test.ts`

**Interfaces:**
- Consumes: `FetchLike`, `parseRetryAfter` (Task 4); `DECISION_TIMEOUT_MS`, `DECISION_STATE_MAX_CHARS` (Task 2); `DecisionError`, `DecisionErrorKind` (Task 3); `DecisionEngine`, `DecisionInput`, `DecisionResult` (Task 11); `buildDecisionRequest`, `DecisionRequestBody` (Task 12); `normalizeDecisionResponse` (Task 13); `server` (Task 1); fixtures (Task 13).
- Produces:
  - `mai-engine.ts` (contracts 4.9.4, issues #13, #15): `MaiEngineConfig { endpoint; deployment; apiKey; fetch; timeoutMs?; now? }`, `DECISION_PATH = "/providers/microsoft/v1/systemone"`, `decisionErrorKindForStatus(status: number): DecisionErrorKind`, `class MaiDecisionEngine implements DecisionEngine` (`name = "mai"`, `constructor(config)`, `decide(input)`): POST with headers `api-key` and `content-type: application/json`, no `api-version`, `AbortSignal.timeout(timeoutMs)`, no internal retries. Errors: 401/403 `auth`, 404 `deployment_not_found`, 400 `bad_request`, 413 `too_large`, 422 `unprocessable`, 429 `rate_limited`, 408 and 5xx `server`, abort `timeout`, fetch throw `network`, bad JSON or schema `invalid_response`; `requestId` = `apim-request-id`; `retryAfterMs` from `retry-after-ms` then `retry-after`.
  - `test/msw/decision.ts` (contracts 10.3, issues #19, #24): `DecisionMockOptions { endpoint?; deployment?; apiKey? }` (defaults `https://decision.example.test`, `decision-1`, `test-key`, matching the worker test bindings in contracts 3.6), `DecisionFailSpec { method?; path?; status; headers?; body?; times? }`, `class DecisionMockState` (`requests: DecisionRequestBody[]`, `respond: (body) => unknown`, `failNext(spec)`), `decisionHandlers(state): HttpHandler[]` (validates `api-key` (401), only `model`/`state`/`questions` keys, all five questions, state length <= 1,750 (400 `unrecognized_request_argument`), `model === deployment` (404 `DeploymentNotFound`); sets `apim-request-id` `apim-0001`, `apim-0002`, ...), `makeDecisionResponseBody(probabilities?)`.

- [ ] **Step 1: Write the Decision-1 MSW mock**

`packages/core/test/msw/decision.ts`:

```ts
import { http, HttpResponse } from "msw";
import type { DecisionRequestBody } from "../../src/decision/questions.ts";
import { DECISION_STATE_MAX_CHARS } from "../../src/model/constants.ts";

export interface DecisionFailSpec {
  /** Accepted for parity with other handler factories; the Decision-1 mock has one route. */
  method?: string;
  path?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** How many upcoming requests fail this way (default 1). */
  times?: number;
}

export interface DecisionMockOptions {
  endpoint?: string;
  deployment?: string;
  apiKey?: string;
}

const QUESTION_KEYS = ["action", "importance", "is_record", "is_expired", "is_from_human"] as const;

/** Synthetic response in the documented shape (research decision-1.md 4.3). */
export function makeDecisionResponseBody(
  probabilities: { delete: number; archive: number; keep: number; unsure: number } = {
    delete: 0.95,
    archive: 0.02,
    keep: 0.01,
    unsure: 0.02,
  },
): Record<string, unknown> {
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["unsure"])[0];
  return {
    model: "microsoft-decision-1",
    answers: {
      action: { type: "choice", choice, confidence: 0.9, probabilities },
      importance: {
        type: "score",
        score: 0.21,
        confidence: 0.7,
        legend: { "0": "Noise", "1": "Low", "2": "Moderate", "3": "High", "4": "Critical" },
        probabilities: { "0": 0.81, "1": 0.17, "2": 0.02, "3": 0, "4": 0 },
      },
      is_record: { type: "noul", noul: 0.03 },
      is_expired: { type: "noul", noul: 0.91 },
      is_from_human: { type: "noul", noul: 0.01 },
    },
    usage: { input_tokens: 520, output_tokens: 5 },
  };
}

/** In-memory state behind decisionHandlers: request log, failure injection and a replaceable responder. */
export class DecisionMockState {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly requests: DecisionRequestBody[] = [];
  respond: (body: DecisionRequestBody) => unknown = () => makeDecisionResponseBody();
  #failures: DecisionFailSpec[] = [];
  #counter = 0;

  constructor(options: DecisionMockOptions = {}) {
    this.endpoint = options.endpoint ?? "https://decision.example.test";
    this.deployment = options.deployment ?? "decision-1";
    this.apiKey = options.apiKey ?? "test-key";
  }

  failNext(spec: DecisionFailSpec): void {
    this.#failures.push({ ...spec, times: spec.times ?? 1 });
  }

  takeFailure(): DecisionFailSpec | null {
    const next = this.#failures[0];
    if (next === undefined) return null;
    const times = (next.times ?? 1) - 1;
    if (times <= 0) this.#failures.shift();
    else next.times = times;
    return next;
  }

  nextRequestId(): string {
    this.#counter += 1;
    return `apim-${String(this.#counter).padStart(4, "0")}`;
  }
}

function azureError(status: number, code: string, message: string, requestId: string): Response {
  return HttpResponse.json(
    { error: { code, message } },
    { status, headers: { "apim-request-id": requestId } },
  );
}

function validationProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "model,questions,state") return `unexpected top-level fields: ${keys.join(",")}`;
  const { questions, state } = body as { questions: unknown; state: unknown };
  if (typeof questions !== "object" || questions === null) return "questions must be an object";
  for (const key of QUESTION_KEYS) {
    if (!(key in questions)) return `missing question ${key}`;
  }
  if (JSON.stringify(state).length > DECISION_STATE_MAX_CHARS) return "state exceeds the token budget";
  return null;
}

/** MSW handlers for POST {endpoint}/providers/microsoft/v1/systemone. */
export function decisionHandlers(state: DecisionMockState) {
  return [
    http.post(`${state.endpoint}/providers/microsoft/v1/systemone`, async ({ request }) => {
      const requestId = state.nextRequestId();
      if (request.headers.get("api-key") !== state.apiKey) {
        return azureError(401, "Unauthorized", "Access denied due to invalid key.", requestId);
      }
      const body = (await request.json()) as unknown;
      const failure = state.takeFailure();
      if (failure !== null) {
        const headers = { "apim-request-id": requestId, ...failure.headers };
        return failure.body === undefined
          ? new HttpResponse(null, { status: failure.status, headers })
          : HttpResponse.json(failure.body, { status: failure.status, headers });
      }
      const problem = validationProblem(body);
      if (problem !== null) return azureError(400, "unrecognized_request_argument", problem, requestId);
      const typed = body as DecisionRequestBody;
      if (typed.model !== state.deployment) {
        return azureError(
          404,
          "DeploymentNotFound",
          `The API deployment ${typed.model} does not exist.`,
          requestId,
        );
      }
      state.requests.push(typed);
      return HttpResponse.json(state.respond(typed) as Record<string, unknown>, {
        headers: { "apim-request-id": requestId, "x-request-id": requestId },
      });
    }),
  ];
}
```

- [ ] **Step 2: Write the failing test (status mapping, retry headers, timeout, network, validation)**

`packages/core/test/decision/mai-engine.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import type { DecisionInput } from "../../src/decision/engine.ts";
import { MaiDecisionEngine, decisionErrorKindForStatus } from "../../src/decision/mai-engine.ts";
import { buildDecisionQuestions } from "../../src/decision/questions.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError, type DecisionErrorKind } from "../../src/model/errors.ts";
import errorNotFound from "../fixtures/decision/error-deployment-not-found.json" with { type: "json" };
import errorUnprocessable from "../fixtures/decision/error-unprocessable.json" with { type: "json" };
import { makeMailMessage, makeSignals } from "../fixtures/builders.ts";
import { DecisionMockState, decisionHandlers, makeDecisionResponseBody } from "../msw/decision.ts";
import { server } from "../setup/msw.ts";

const ENDPOINT = "https://decision.example.test";

function input(seed = 42): DecisionInput {
  return {
    key: "msg-1",
    seed,
    state: buildDecisionState({ msg: makeMailMessage(), signals: makeSignals(), pastDecisions: [] }),
  };
}

function engine(
  overrides: Partial<ConstructorParameters<typeof MaiDecisionEngine>[0]> = {},
): MaiDecisionEngine {
  let t = 1_000;
  return new MaiDecisionEngine({
    endpoint: ENDPOINT,
    deployment: "decision-1",
    apiKey: "test-key",
    fetch: (i, init) => fetch(i, init),
    now: () => (t += 25),
    ...overrides,
  });
}

async function decideError(e: MaiDecisionEngine): Promise<DecisionError> {
  try {
    await e.decide(input());
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionError);
    return error as DecisionError;
  }
  throw new Error("expected decide() to throw");
}

let mock: DecisionMockState;

beforeEach(() => {
  mock = new DecisionMockState({ endpoint: ENDPOINT });
  server.use(...decisionHandlers(mock));
});

describe("MaiDecisionEngine", () => {
  it("posts exactly { model, state, questions } with api-key and returns a DecisionResult", async () => {
    const result = await engine().decide(input(42));
    expect(mock.requests).toHaveLength(1);
    const sent = mock.requests[0];
    expect(Object.keys(sent ?? {})).toEqual(["model", "state", "questions"]);
    expect(sent?.model).toBe("decision-1");
    expect(sent?.questions).toEqual(buildDecisionQuestions(42));
    expect(result.action.delete).toBeCloseTo(0.95, 9);
    expect(result.modelVersion).toBe("decision-1/microsoft-decision-1");
    expect(result.requestId).toBe("apim-0001");
    expect(result.latencyMs).toBe(25);
    expect(result.inputTokens).toBe(520);
  });

  it("strips a trailing slash from the endpoint", async () => {
    await engine({ endpoint: `${ENDPOINT}/` }).decide(input());
    expect(mock.requests).toHaveLength(1);
  });

  it("sends the same option order for the same seed (retries reproduce it)", async () => {
    const e = engine();
    await e.decide(input(7));
    await e.decide(input(7));
    const [a, b] = mock.requests;
    expect(Object.keys(a?.questions.action.criteria ?? {})).toEqual(
      Object.keys(b?.questions.action.criteria ?? {}),
    );
  });

  it("maps a wrong key to auth (config scope, not retryable)", async () => {
    const error = await decideError(engine({ apiKey: "wrong" }));
    expect([error.kind, error.status, error.scope, error.retryable]).toEqual(["auth", 401, "config", false]);
  });

  it("maps an unknown deployment to deployment_not_found", async () => {
    const error = await decideError(engine({ deployment: "decision-x" }));
    expect([error.kind, error.status, error.scope]).toEqual(["deployment_not_found", 404, "config"]);
  });

  const statusCases: [number, DecisionErrorKind, boolean, "config" | "item"][] = [
    [400, "bad_request", false, "item"],
    [401, "auth", false, "config"],
    [403, "auth", false, "config"],
    [404, "deployment_not_found", false, "config"],
    [408, "server", true, "item"],
    [413, "too_large", false, "item"],
    [422, "unprocessable", false, "item"],
    [429, "rate_limited", true, "item"],
    [500, "server", true, "item"],
    [502, "server", true, "item"],
    [503, "server", true, "item"],
    [504, "server", true, "item"],
  ];

  it.each(statusCases)("HTTP %i -> %s (retryable %s, scope %s)", async (status, kind, retryable, scope) => {
    mock.failNext({ status, body: status === 422 ? errorUnprocessable : errorNotFound });
    const error = await decideError(engine());
    expect([error.kind, error.status, error.retryable, error.scope]).toEqual([
      kind,
      status,
      retryable,
      scope,
    ]);
    expect(error.requestId).toBe("apim-0001");
    expect(error.message).not.toContain("TypeSafe");
  });

  it("honors retry-after-ms, then retry-after", async () => {
    mock.failNext({ status: 429, headers: { "retry-after-ms": "1500" } });
    expect((await decideError(engine())).retryAfterMs).toBe(1500);
    mock.failNext({ status: 429, headers: { "retry-after": "7" } });
    expect((await decideError(engine())).retryAfterMs).toBe(7000);
    mock.failNext({ status: 503 });
    expect((await decideError(engine())).retryAfterMs).toBeNull();
  });

  it("maps an invalid body to invalid_response", async () => {
    mock.respond = () => ({ model: "microsoft-decision-1", answers: {} });
    const error = await decideError(engine());
    expect([error.kind, error.retryable, error.requestId]).toEqual(["invalid_response", false, "apim-0001"]);
  });

  it("maps non-JSON success bodies to invalid_response", async () => {
    server.use(http.post(`${ENDPOINT}/providers/microsoft/v1/systemone`, () => new HttpResponse("not json")));
    expect((await decideError(engine())).kind).toBe("invalid_response");
  });

  it("maps a refusal answer to invalid_response", async () => {
    mock.respond = () => {
      const body = makeDecisionResponseBody() as { answers: Record<string, unknown> };
      body.answers.action = { type: "refusal" };
      return body;
    };
    expect((await decideError(engine())).kind).toBe("invalid_response");
  });

  it("maps a thrown fetch to network (retryable)", async () => {
    const error = await decideError(engine({ fetch: () => Promise.reject(new TypeError("fetch failed")) }));
    expect([error.kind, error.retryable, error.status]).toEqual(["network", true, null]);
  });

  it("maps a timeout to timeout (retryable)", async () => {
    server.use(
      http.post(`${ENDPOINT}/providers/microsoft/v1/systemone`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json(makeDecisionResponseBody());
      }),
    );
    const error = await decideError(engine({ timeoutMs: 20 }));
    expect([error.kind, error.retryable]).toEqual(["timeout", true]);
  });

  it("never retries internally", async () => {
    let calls = 0;
    const counting = (i: Request | string | URL, init?: RequestInit) => {
      calls++;
      return fetch(i, init);
    };
    mock.failNext({ status: 503, times: 5 });
    await decideError(engine({ fetch: counting }));
    expect(calls).toBe(1);
  });
});

describe("decisionErrorKindForStatus", () => {
  it("maps unlisted 4xx to bad_request and unlisted 5xx to server", () => {
    expect(decisionErrorKindForStatus(405)).toBe("bad_request");
    expect(decisionErrorKindForStatus(409)).toBe("bad_request");
    expect(decisionErrorKindForStatus(507)).toBe("server");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/mai-engine.test.ts`
Expected: FAIL with `Cannot find module '../../src/decision/mai-engine.ts'`.

- [ ] **Step 4: Write the engine**

`packages/core/src/decision/mai-engine.ts`:

```ts
import type { FetchLike } from "../http/fetch.ts";
import { parseRetryAfter } from "../http/fetch.ts";
import { DECISION_TIMEOUT_MS } from "../model/constants.ts";
import { DecisionError, type DecisionErrorKind } from "../model/errors.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";
import { buildDecisionRequest } from "./questions.ts";
import { normalizeDecisionResponse } from "./response.ts";

export interface MaiEngineConfig {
  /** AZURE_DECISION_ENDPOINT (account root, e.g. https://<foundry-account>.services.ai.azure.com). */
  endpoint: string;
  /** AZURE_DECISION_DEPLOYMENT. */
  deployment: string;
  /** AZURE_DECISION_KEY. */
  apiKey: string;
  fetch: FetchLike;
  /** Default DECISION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Clock for latency and Retry-After dates. Default Date.now. */
  now?: () => number;
}

export const DECISION_PATH = "/providers/microsoft/v1/systemone";

/** HTTP status to error kind. Unlisted 4xx are bad_request (not retryable); unlisted 5xx are server (retryable). */
export function decisionErrorKindForStatus(status: number): DecisionErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "deployment_not_found";
  if (status === 408) return "server";
  if (status === 413) return "too_large";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** POST `${endpoint}/providers/microsoft/v1/systemone`, headers `api-key`, `content-type: application/json`. No api-version. */
export class MaiDecisionEngine implements DecisionEngine {
  readonly name = "mai" as const;
  readonly #config: MaiEngineConfig;
  readonly #url: string;

  constructor(config: MaiEngineConfig) {
    this.#config = config;
    this.#url = `${config.endpoint.replace(/\/+$/, "")}${DECISION_PATH}`;
  }

  async decide(input: DecisionInput): Promise<DecisionResult> {
    const { deployment, apiKey } = this.#config;
    const now = this.#config.now ?? Date.now;
    const timeoutMs = this.#config.timeoutMs ?? DECISION_TIMEOUT_MS;
    const body = JSON.stringify(buildDecisionRequest(input.state, deployment, input.seed));
    const started = now();

    let response: Response;
    try {
      response = await this.#config.fetch(this.#url, {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = isTimeout(error) ? "timeout" : "network";
      throw new DecisionError({ kind, cause: error });
    }

    const requestId = response.headers.get("apim-request-id");
    if (!response.ok) {
      await response.body?.cancel();
      throw new DecisionError({
        kind: decisionErrorKindForStatus(response.status),
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers, now()),
        requestId,
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      const kind = isTimeout(error) ? "timeout" : "invalid_response";
      throw new DecisionError({ kind, status: response.status, requestId, cause: error });
    }
    return normalizeDecisionResponse(json, { deployment, requestId, latencyMs: now() - started });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/mai-engine.test.ts`
Expected: PASS, `Tests  25 passed (25)`, and no `Unhandled request` errors.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/decision/mai-engine.ts packages/core/test/msw/decision.ts packages/core/test/decision/mai-engine.test.ts
git commit -m "feat(core): add MaiDecisionEngine with error classification and MSW mock"
```

---

### Task 15: FakeEngine and decideAll

**Files:**
- Create: `packages/core/src/decision/fake-engine.ts`, `packages/core/src/decision/run.ts`
- Test: `packages/core/test/decision/fake-engine.test.ts`, `packages/core/test/decision/run.test.ts`

**Interfaces:**
- Consumes: `ActionDistribution` (Task 2); `DecisionError` (Task 3); `mapWithConcurrency` (Task 4); `DecisionEngine`, `DecisionInput`, `DecisionResult`, `buildDecisionState` (Task 11); builders (Tasks 9, 11).
- Produces (contracts 4.9.4, 10.5, issue #14):
  - `FakeEngineOptions { overrides?: ReadonlyMap<string, DecisionResult | DecisionError> }`, `class FakeEngine implements DecisionEngine` (`name = "fake"`, `calls: DecisionInput[]`, rule table of 4.9.4, `modelVersion = "fake/fake-1"`, never touches the network; an override `DecisionError` is thrown as a rejection).
  - `DecisionOutcome = { key; ok: true; result } | { key; ok: false; error: DecisionError }`, `decideAll(engine: DecisionEngine, inputs: readonly DecisionInput[], concurrency: number): Promise<DecisionOutcome[]>` (at most `concurrency` in flight, input order, never rejects).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/decision/fake-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DecisionInput } from "../../src/decision/engine.ts";
import { FakeEngine } from "../../src/decision/fake-engine.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError } from "../../src/model/errors.ts";
import type { MailMessageOverrides } from "../fixtures/builders.ts";
import { makeDecisionResult, makeMailMessage, makeSignals } from "../fixtures/builders.ts";
import type { Signals } from "../../src/signals/signals.ts";

function input(msg: MailMessageOverrides = {}, signals: Partial<Signals> = {}, key = "msg-1"): DecisionInput {
  return {
    key,
    seed: 1,
    state: buildDecisionState({
      msg: makeMailMessage(msg),
      signals: makeSignals(signals),
      pastDecisions: [],
    }),
  };
}

describe("FakeEngine", () => {
  it("is named fake and records calls", async () => {
    const engine = new FakeEngine();
    const i = input();
    await engine.decide(i);
    expect(engine.name).toBe("fake");
    expect(engine.calls).toEqual([i]);
  });

  it.each([
    ["correspondent", {}, { isCorrespondent: true }, [0.02, 0.08, 0.85, 0.05]],
    ["record subject", { subject: "Your order receipt" }, {}, [0.05, 0.8, 0.1, 0.05]],
    ["unread list mail", {}, { hasListUnsubscribe: true, isRead: false }, [0.9, 0.04, 0.03, 0.03]],
    ["read list mail", {}, { hasListUnsubscribe: true, isRead: true }, [0.6, 0.2, 0.1, 0.1]],
    ["otherwise", {}, {}, [0.15, 0.2, 0.3, 0.35]],
  ] as const)("rule: %s", async (_name, msg, signals, expected) => {
    const result = await new FakeEngine().decide(input(msg, signals));
    expect([result.action.delete, result.action.archive, result.action.keep, result.action.unsure]).toEqual(
      expected,
    );
  });

  it("first matching rule wins (correspondent before record subject)", async () => {
    const result = await new FakeEngine().decide(input({ subject: "Invoice" }, { isCorrespondent: true }));
    expect(result.action.keep).toBe(0.85);
  });

  it("computes flags and importance independently", async () => {
    const r1 = await new FakeEngine().decide(input({ subject: "Statement ready, last chance" }));
    expect(r1.flags).toEqual({ isRecord: 0.9, isExpired: 0.9, isFromHuman: 0.05 });
    expect(r1.importance).toBe(1);

    const r2 = await new FakeEngine().decide(input({ subject: "Lunch?" }, { isCorrespondent: true }));
    expect(r2.flags).toEqual({ isRecord: 0.05, isExpired: 0.1, isFromHuman: 0.9 });
    expect(r2.importance).toBe(3);

    const r3 = await new FakeEngine().decide(input({ subject: "Hello" }));
    expect(r3.importance).toBe(0.5);
  });

  it("fills metadata deterministically", async () => {
    const i = input();
    const result = await new FakeEngine().decide(i);
    expect(result.responseModel).toBe("fake-1");
    expect(result.modelVersion).toBe("fake/fake-1");
    expect(result.inputTokens).toBe(Math.ceil(JSON.stringify(i.state).length / 3.5) + 250);
    expect([result.latencyMs, result.requestId]).toEqual([0, null]);
  });

  it("returns overrides and throws override errors per key", async () => {
    const canned = makeDecisionResult({ importance: 4 });
    const failure = new DecisionError({ kind: "rate_limited", status: 429 });
    const engine = new FakeEngine({
      overrides: new Map<string, typeof canned | DecisionError>([
        ["ok-key", canned],
        ["bad-key", failure],
      ]),
    });
    expect(await engine.decide(input({}, {}, "ok-key"))).toBe(canned);
    await expect(engine.decide(input({}, {}, "bad-key"))).rejects.toBe(failure);
    expect(engine.calls.map((c) => c.key)).toEqual(["ok-key", "bad-key"]);
  });
});
```

`packages/core/test/decision/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DecisionEngine, DecisionInput, DecisionResult } from "../../src/decision/engine.ts";
import { FakeEngine } from "../../src/decision/fake-engine.ts";
import { decideAll } from "../../src/decision/run.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError } from "../../src/model/errors.ts";
import { makeDecisionResult, makeMailMessage, makeSignals } from "../fixtures/builders.ts";

function inputs(n: number): DecisionInput[] {
  const state = buildDecisionState({ msg: makeMailMessage(), signals: makeSignals(), pastDecisions: [] });
  return Array.from({ length: n }, (_, i) => ({ key: `msg-${String(i)}`, seed: i, state }));
}

describe("decideAll", () => {
  it("returns one settled outcome per input, in input order", async () => {
    const failure = new DecisionError({ kind: "server", status: 503 });
    const engine = new FakeEngine({ overrides: new Map([["msg-1", failure]]) });
    const outcomes = await decideAll(engine, inputs(3), 4);
    expect(outcomes.map((o) => [o.key, o.ok])).toEqual([
      ["msg-0", true],
      ["msg-1", false],
      ["msg-2", true],
    ]);
    const second = outcomes[1];
    expect(second?.ok === false ? second.error : null).toBe(failure);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const engine: DecisionEngine = {
      name: "fake",
      async decide(): Promise<DecisionResult> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return makeDecisionResult();
      },
    };
    await decideAll(engine, inputs(10), 4);
    expect(peak).toBe(4);
  });

  it("wraps unexpected errors as retryable network DecisionErrors and never rejects", async () => {
    const engine: DecisionEngine = { name: "fake", decide: () => Promise.reject(new TypeError("boom")) };
    const [outcome] = await decideAll(engine, inputs(1), 4);
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) {
      expect(outcome.error.kind).toBe("network");
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it("handles an empty input list", async () => {
    expect(await decideAll(new FakeEngine(), [], 4)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/fake-engine.test.ts test/decision/run.test.ts`
Expected: FAIL, 2 failed suites with `Cannot find module '../../src/decision/fake-engine.ts'`.

- [ ] **Step 3: Write FakeEngine**

`packages/core/src/decision/fake-engine.ts`:

```ts
import type { ActionDistribution } from "../model/actions.ts";
import { DecisionError } from "../model/errors.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";

export interface FakeEngineOptions {
  /** Per-key canned results or errors; anything else uses the built-in rules. */
  overrides?: ReadonlyMap<string, DecisionResult | DecisionError>;
}

const RECORD_FOR_ACTION = /receipt|invoice|order|statement/i;
const RECORD_FLAG = /receipt|invoice|statement|order/i;
const EXPIRED_FLAG = /expire|ends tonight|last chance|one-time code/i;

function dist(d: number, a: number, k: number, u: number): ActionDistribution {
  return { delete: d, archive: a, keep: k, unsure: u };
}

/** Deterministic, rule-based engine for tests and local development (contracts 4.9.4). Never touches the network. */
export class FakeEngine implements DecisionEngine {
  readonly name = "fake" as const;
  readonly calls: DecisionInput[] = [];
  readonly #overrides: ReadonlyMap<string, DecisionResult | DecisionError>;

  constructor(options: FakeEngineOptions = {}) {
    this.#overrides = options.overrides ?? new Map();
  }

  decide(input: DecisionInput): Promise<DecisionResult> {
    this.calls.push(input);
    const override = this.#overrides.get(input.key);
    if (override instanceof DecisionError) return Promise.reject(override);
    if (override !== undefined) return Promise.resolve(override);
    return Promise.resolve(FakeEngine.rules(input));
  }

  private static rules(input: DecisionInput): DecisionResult {
    const { email, sender_history: history } = input.state;
    const subject = email.subject;
    const s = email.signals;

    let action: ActionDistribution;
    if (history.is_correspondent) action = dist(0.02, 0.08, 0.85, 0.05);
    else if (RECORD_FOR_ACTION.test(subject)) action = dist(0.05, 0.8, 0.1, 0.05);
    else if (s.has_list_unsubscribe && !s.is_read) action = dist(0.9, 0.04, 0.03, 0.03);
    else if (s.has_list_unsubscribe) action = dist(0.6, 0.2, 0.1, 0.1);
    else action = dist(0.15, 0.2, 0.3, 0.35);

    const isRecordSubject = RECORD_FLAG.test(subject);
    return {
      action,
      importance: history.is_correspondent ? 3 : isRecordSubject ? 1 : 0.5,
      flags: {
        isRecord: isRecordSubject ? 0.9 : 0.05,
        isExpired: EXPIRED_FLAG.test(subject) ? 0.9 : 0.1,
        isFromHuman: history.is_correspondent ? 0.9 : 0.05,
      },
      responseModel: "fake-1",
      modelVersion: "fake/fake-1",
      inputTokens: Math.ceil(JSON.stringify(input.state).length / 3.5) + 250,
      requestId: null,
      latencyMs: 0,
    };
  }
}
```

- [ ] **Step 4: Write decideAll**

`packages/core/src/decision/run.ts`:

```ts
import { DecisionError } from "../model/errors.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import type { DecisionEngine, DecisionInput, DecisionResult } from "./engine.ts";

export type DecisionOutcome =
  { key: string; ok: true; result: DecisionResult } | { key: string; ok: false; error: DecisionError };

function toDecisionError(error: unknown): DecisionError {
  return error instanceof DecisionError ? error : new DecisionError({ kind: "network", cause: error });
}

/** Runs at most `concurrency` decide() calls at once; never rejects; preserves input order. Non-DecisionError throws become kind "network". */
export async function decideAll(
  engine: DecisionEngine,
  inputs: readonly DecisionInput[],
  concurrency: number,
): Promise<DecisionOutcome[]> {
  return mapWithConcurrency(inputs, Math.max(1, concurrency), async (input): Promise<DecisionOutcome> => {
    try {
      return { key: input.key, ok: true, result: await engine.decide(input) };
    } catch (error) {
      return { key: input.key, ok: false, error: toDecisionError(error) };
    }
  });
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/decision/fake-engine.test.ts test/decision/run.test.ts`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  14 passed (14)`.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/decision/fake-engine.ts packages/core/src/decision/run.ts packages/core/test/decision/fake-engine.test.ts packages/core/test/decision/run.test.ts
git commit -m "feat(core): add deterministic FakeEngine and concurrency-limited decideAll"
```

---

### Task 16: Fusion and reason selection

**Files:**
- Create: `packages/core/src/fusion/fusion.ts`
- Test: `packages/core/test/fusion/fusion.test.ts`

**Interfaces:**
- Consumes: `ACTION_RANK`, `isAllowedByCeiling`, `ActionDistribution`, `Ceiling`, `SuggestedAction`, fusion constants, `Reason` (Task 2); `DecisionFlags`, `DecisionResult` (Task 11); `IMPORTANCE_LEVELS` (Task 12); `GuardrailResult` (Task 10); `Prior`, `selectPrior` (Task 8); `Signals` (Task 9); builders.
- Produces (contracts 4.10, 5.1, 5.2; issues #4, #5, #6): `Thresholds { tauDelete; deleteMargin; minConfidence }`, `FusionInput { model: DecisionResult | null; prior; guard; signals; thresholds }`, `Suggestion { action; confidence; distribution; modelDelete; margin; ceiling; ceilingApplied; importance; flags; reasons }`, `ReasonContext`, `fuse(input: FusionInput): Suggestion`, `selectReasons(ctx: ReasonContext): Reason[]` (at most 3, no duplicate codes, priority order of 5.2).

- [ ] **Step 1: Write the failing test (every 5.1 edge case, flag shifts, thresholds, 5.2 reasons)**

`packages/core/test/fusion/fusion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DecisionResult } from "../../src/decision/engine.ts";
import {
  fuse,
  selectReasons,
  type FusionInput,
  type ReasonContext,
  type Thresholds,
} from "../../src/fusion/fusion.ts";
import type { GuardrailResult } from "../../src/guardrails/guardrails.ts";
import type { ActionDistribution, Ceiling } from "../../src/model/actions.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import type { Reason } from "../../src/model/reasons.ts";
import { selectPrior, type Prior } from "../../src/priors/priors.ts";
import { makeDecisionResult, makeSignals } from "../fixtures/builders.ts";

const TH: Thresholds = {
  tauDelete: TAU_DELETE_DEFAULT,
  deleteMargin: DELETE_MARGIN,
  minConfidence: MIN_CONFIDENCE,
};
const NO_PRIOR: Prior = selectPrior(null, null, "news@shop.example.com", "example.com");
const LOW_FLAGS = { isRecord: 0.1, isExpired: 0.1, isFromHuman: 0.1 };

function dist(d: number, a: number, k: number, u: number): ActionDistribution {
  return { delete: d, archive: a, keep: k, unsure: u };
}

function guard(ceiling: Ceiling = "delete", reasons: Reason[] = [], denylisted = false): GuardrailResult {
  return { ceiling, reasons, allowlisted: false, denylisted };
}

function model(action: ActionDistribution, overrides: Partial<DecisionResult> = {}): DecisionResult {
  return makeDecisionResult({ action, flags: LOW_FLAGS, importance: 0, ...overrides });
}

function input(overrides: Partial<FusionInput> = {}): FusionInput {
  return {
    model: model(dist(0.5, 0.2, 0.2, 0.1)),
    prior: NO_PRIOR,
    guard: guard(),
    signals: makeSignals(),
    thresholds: TH,
    ...overrides,
  };
}

function expectDist(actual: ActionDistribution | null, expected: ActionDistribution): void {
  expect(actual).not.toBeNull();
  expect(actual?.delete).toBeCloseTo(expected.delete, 9);
  expect(actual?.archive).toBeCloseTo(expected.archive, 9);
  expect(actual?.keep).toBeCloseTo(expected.keep, 9);
  expect(actual?.unsure).toBeCloseTo(expected.unsure, 9);
}

function sum(d: ActionDistribution | null): number {
  return d === null ? Number.NaN : d.delete + d.archive + d.keep + d.unsure;
}

describe("fuse", () => {
  describe("contracts 5.1 edge cases", () => {
    it("no prior: lambda = 0 and v = m before flags", () => {
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)) }));
      expectDist(s.distribution, dist(0.5, 0.2, 0.2, 0.1));
      expect(s.modelDelete).toBeCloseTo(0.5, 9);
    });

    it("m.delete = 1: v = {delete: d, unsure: 1 - d, archive: 0, keep: 0}", () => {
      const prior = selectPrior({ deletes: 0, keeps: 2 }, null, "a@example.com", "example.com"); // n 2, p 0.25
      const s = fuse(input({ model: model(dist(1, 0, 0, 0)), prior }));
      const d = (5 / 7) * 1 + (2 / 7) * 0.25;
      expectDist(s.distribution, dist(d, 0, 0, 1 - d));
      expect(s.action).toBe("unsure");
    });

    it("m.delete = 1 and lambda = 0: v.unsure = 0 and delete wins with margin 1", () => {
      const s = fuse(input({ model: model(dist(1, 0, 0, 0)) }));
      expectDist(s.distribution, dist(1, 0, 0, 0));
      expect(s.action).toBe("delete");
      expect(s.confidence).toBeCloseTo(1, 9);
      expect(s.margin).toBeCloseTo(1, 9);
    });

    it("sender n = 2, domain n = 10: domain prior used with lambda = 10/15", () => {
      const prior = selectPrior(
        { deletes: 2, keeps: 0 },
        { deletes: 10, keeps: 0 },
        "a@example.com",
        "example.com",
      );
      expect(prior.source).toBe("domain");
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)), prior }));
      const lambda = 10 / 15;
      const d = (1 - lambda) * 0.5 + lambda * (11 / 12);
      const scale = (1 - d) / 0.5;
      expectDist(s.distribution, dist(d, 0.2 * scale, 0.2 * scale, 0.1 * scale));
    });

    it("sender n = 2, no domain prior: sender prior used with lambda = 2/7", () => {
      const prior = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com"); // p 0.75
      const s = fuse(input({ model: model(dist(0.5, 0.2, 0.2, 0.1)), prior }));
      const d = (5 / 7) * 0.5 + (2 / 7) * 0.75;
      expect(s.distribution?.delete).toBeCloseTo(d, 9);
      expect(sum(s.distribution)).toBeCloseTo(1, 9);
    });

    it("ceiling keep: archive and delete mass fold into keep", () => {
      const s = fuse(input({ model: model(dist(0.9, 0.05, 0.03, 0.02)), guard: guard("keep") }));
      expectDist(s.distribution, dist(0, 0, 0.98, 0.02));
      expect(s.action).toBe("keep");
      expect(s.confidence).toBeCloseTo(0.98, 9);
      expect(s.ceilingApplied).toBe(true);
    });

    it("ceiling keep: unsure when the folded keep mass is below 0.55", () => {
      const s = fuse(input({ model: model(dist(0.2, 0.1, 0.2, 0.5)), guard: guard("keep") }));
      expectDist(s.distribution, dist(0, 0, 0.5, 0.5));
      expect(s.action).toBe("unsure");
      expect(s.confidence).toBeCloseTo(0.5, 9);
    });

    it("ceiling archive, model delete 0.95: delete folds into archive, ceilingApplied", () => {
      const reasons: Reason[] = [{ code: "guard_attachment", params: {} }];
      const s = fuse(input({ model: model(dist(0.95, 0.02, 0.02, 0.01)), guard: guard("archive", reasons) }));
      expectDist(s.distribution, dist(0, 0.97, 0.02, 0.01));
      expect(s.action).toBe("archive");
      expect(s.ceilingApplied).toBe(true);
      expect(s.ceiling).toBe("archive");
      expect(s.reasons[0]).toEqual({ code: "guard_attachment", params: {} });
    });

    it("delete 0.79, keep 0.15, tau 0.80: unsure with low confidence", () => {
      const s = fuse(input({ model: model(dist(0.79, 0.03, 0.15, 0.03)) }));
      expect(s.action).toBe("unsure");
      expect(s.confidence).toBeCloseTo(0.03, 9);
      expect(s.reasons.map((r) => r.code)).toContain("low_confidence");
    });

    it("delete 0.58, archive 0.40, tau 0.80: unsure", () => {
      const s = fuse(input({ model: model(dist(0.58, 0.4, 0.01, 0.01)) }));
      expect(s.action).toBe("unsure");
    });

    it("delete 0.90, archive 0.08, tau 0.80: delete with confidence 0.90 and margin 0.82", () => {
      const s = fuse(input({ model: model(dist(0.9, 0.08, 0.01, 0.01)) }));
      expect(s.action).toBe("delete");
      expect(s.confidence).toBeCloseTo(0.9, 9);
      expect(s.margin).toBeCloseTo(0.82, 9);
      expect(s.ceilingApplied).toBe(false);
    });

    it("tie keep = archive = 0.5: keep wins the tie but 0.5 < 0.55 gives unsure", () => {
      const s = fuse(input({ model: model(dist(0, 0.5, 0.5, 0)) }));
      expect(s.action).toBe("unsure");
      const lower = fuse(
        input({ model: model(dist(0, 0.5, 0.5, 0)), thresholds: { ...TH, minConfidence: 0.5 } }),
      );
      expect(lower.action).toBe("keep");
    });

    it("flags shift delete below tau: not delete", () => {
      const s = fuse(
        input({ model: model(dist(0.9, 0.05, 0.03, 0.02), { flags: { ...LOW_FLAGS, isRecord: 0.8 } }) }),
      );
      expect(s.distribution?.delete).toBeCloseTo(0.45, 9);
      expect(s.distribution?.archive).toBeCloseTo(0.5, 9);
      expect(s.action).not.toBe("delete");
    });

    it("model null: unsure, confidence 0, distribution null", () => {
      const s = fuse(input({ model: null, guard: guard("archive") }));
      expect(s).toMatchObject({
        action: "unsure",
        confidence: 0,
        distribution: null,
        modelDelete: null,
        margin: null,
        ceiling: "archive",
        ceilingApplied: false,
        importance: null,
        flags: null,
      });
      expect(s.reasons[0]?.code).toBe("model_unavailable");
    });
  });

  describe("flag shifts", () => {
    it("is_from_human moves half of delete to keep", () => {
      const s = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isFromHuman: 0.7 } }) }),
      );
      expectDist(s.distribution, dist(0.3, 0.1, 0.5, 0.1));
    });

    it("record then human apply in order", () => {
      const flags = { isRecord: 0.9, isExpired: 0.1, isFromHuman: 0.9 };
      const s = fuse(input({ model: model(dist(0.8, 0.1, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.2, 0.5, 0.25, 0.05));
    });

    it("is_expired moves 30% of archive to delete when not from a human", () => {
      const flags = { isRecord: 0.1, isExpired: 0.9, isFromHuman: 0.4 };
      const s = fuse(input({ model: model(dist(0.5, 0.4, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.62, 0.28, 0.05, 0.05));
    });

    it("is_expired does nothing when is_from_human >= 0.5", () => {
      const flags = { isRecord: 0.1, isExpired: 0.9, isFromHuman: 0.5 };
      const s = fuse(input({ model: model(dist(0.5, 0.4, 0.05, 0.05), { flags }) }));
      expectDist(s.distribution, dist(0.5, 0.4, 0.05, 0.05));
    });

    it("flags exactly at 0.7 apply, just below do not", () => {
      const at = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isRecord: 0.7 } }) }),
      );
      const below = fuse(
        input({ model: model(dist(0.6, 0.1, 0.2, 0.1), { flags: { ...LOW_FLAGS, isRecord: 0.69 } }) }),
      );
      expect(at.distribution?.delete).toBeCloseTo(0.3, 9);
      expect(below.distribution?.delete).toBeCloseTo(0.6, 9);
    });
  });

  describe("thresholds", () => {
    it("delete needs both tau and margin", () => {
      expect(fuse(input({ model: model(dist(0.8, 0.1, 0.05, 0.05)) })).action).toBe("delete");
      const lowTau = { ...TH, tauDelete: 0.5 };
      expect(fuse(input({ model: model(dist(0.58, 0.4, 0.02, 0)), thresholds: lowTau })).action).not.toBe(
        "delete",
      );
      expect(fuse(input({ model: model(dist(0.65, 0.35, 0, 0)), thresholds: lowTau })).action).toBe("delete");
      expect(
        fuse(input({ model: model(dist(0.85, 0.1, 0.05, 0)), thresholds: { ...TH, tauDelete: 0.9 } })).action,
      ).not.toBe("delete");
    });

    it("picks the best non-delete action when confident", () => {
      expect(fuse(input({ model: model(dist(0.1, 0.7, 0.1, 0.1)) })).action).toBe("archive");
      expect(fuse(input({ model: model(dist(0.1, 0.1, 0.7, 0.1)) })).action).toBe("keep");
      expect(fuse(input({ model: model(dist(0.1, 0.1, 0.1, 0.7)) })).action).toBe("unsure");
    });

    it("ceilingApplied is false when the unbounded choice was allowed", () => {
      const s = fuse(input({ model: model(dist(0.1, 0.1, 0.7, 0.1)), guard: guard("keep") }));
      expect(s.action).toBe("keep");
      expect(s.ceilingApplied).toBe(false);
    });

    it("always returns a distribution summing to 1 and copies importance and flags", () => {
      const flags = { isRecord: 0.9, isExpired: 0.9, isFromHuman: 0.2 };
      const s = fuse(
        input({
          model: model(dist(0.4, 0.3, 0.2, 0.1), { flags, importance: 2.5 }),
          guard: guard("archive"),
        }),
      );
      expect(sum(s.distribution)).toBeCloseTo(1, 9);
      expect(s.importance).toBe(2.5);
      expect(s.flags).toEqual(flags);
    });
  });
});

describe("selectReasons", () => {
  function ctx(overrides: Partial<ReasonContext> = {}): ReasonContext {
    return {
      model: model(dist(0.9, 0.05, 0.03, 0.02)),
      prior: NO_PRIOR,
      guard: guard(),
      signals: makeSignals(),
      action: "delete",
      ceilingApplied: false,
      lowConfidence: false,
      ...overrides,
    };
  }
  const codes = (c: ReasonContext): string[] => selectReasons(c).map((r) => r.code);
  const capped = guard("archive", [{ code: "guard_attachment", params: {} }]);

  it("starts with model_unavailable when the model is null", () => {
    expect(codes(ctx({ model: null, action: "unsure" }))[0]).toBe("model_unavailable");
  });

  it("includes guardrail reasons when the ceiling was applied", () => {
    expect(codes(ctx({ guard: capped, action: "archive", ceilingApplied: true }))[0]).toBe(
      "guard_attachment",
    );
  });

  it("includes guardrail reasons for keep/archive under a lowered ceiling even when not applied", () => {
    expect(codes(ctx({ guard: capped, action: "keep" }))).toContain("guard_attachment");
  });

  it("omits guardrail reasons for unsure when the ceiling was not applied", () => {
    expect(codes(ctx({ guard: capped, action: "unsure" }))).not.toContain("guard_attachment");
  });

  it("adds deny_listed only for delete", () => {
    expect(codes(ctx({ guard: guard("delete", [], true), action: "delete" }))).toContain("deny_listed");
    expect(codes(ctx({ guard: guard("delete", [], true), action: "unsure" }))).not.toContain("deny_listed");
  });

  it("adds low_confidence", () => {
    expect(codes(ctx({ action: "unsure", lowConfidence: true }))[0]).toBe("low_confidence");
  });

  it("adds the sender prior as deleted for delete or pDelete >= 0.5, else kept", () => {
    const deleting = selectPrior({ deletes: 14, keeps: 0 }, null, "a@example.com", "example.com");
    expect(selectReasons(ctx({ prior: deleting }))[0]).toEqual({
      code: "prior_sender_deleted",
      params: { deletes: 14, total: 14, domain: "example.com" },
    });
    const keeping = selectPrior({ deletes: 1, keeps: 4 }, null, "a@example.com", "example.com");
    expect(selectReasons(ctx({ prior: keeping, action: "keep", model: model(dist(0, 0, 1, 0)) }))[0]).toEqual(
      {
        code: "prior_sender_kept",
        params: { keeps: 4, total: 5, domain: "example.com" },
      },
    );
  });

  it("uses the domain prior codes and skips priors with n < 3", () => {
    const domain = selectPrior(null, { deletes: 3, keeps: 1 }, "a@example.com", "example.com");
    expect(codes(ctx({ prior: domain }))[0]).toBe("prior_domain_deleted");
    const weak = selectPrior({ deletes: 2, keeps: 0 }, null, "a@example.com", "example.com");
    expect(codes(ctx({ prior: weak })).some((c) => c.startsWith("prior_"))).toBe(false);
  });

  it("lists delete-side signal reasons in order", () => {
    const signals = makeSignals({
      senderSeenCount: 37,
      senderOpenRate: 0,
      hasListUnsubscribe: true,
      precedenceBulk: true,
    });
    const reasons = selectReasons(
      ctx({
        signals,
        model: model(dist(0.9, 0.05, 0.03, 0.02), { flags: { ...LOW_FLAGS, isExpired: 0.9 } }),
      }),
    );
    expect(reasons).toEqual([
      { code: "flag_expired", params: {} },
      { code: "low_open_rate", params: { openPct: 0, seen: 37 } },
      { code: "list_unsubscribe", params: {} },
    ]);
  });

  it("formats category, old unread and auth failures", () => {
    const signals = makeSignals({
      category: "promotions",
      isRead: false,
      ageDays: 45,
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
    });
    expect(selectReasons(ctx({ signals }))).toEqual([
      { code: "category", params: { category: "Promotions" } },
      { code: "old_unread", params: { ageDays: 45 } },
      { code: "auth_failed", params: { method: "DMARC" } },
    ]);
    const spfOnly = makeSignals({ auth: { spf: "fail", dkim: "pass", dmarc: "none" } });
    expect(selectReasons(ctx({ signals: spfOnly }))).toEqual([
      { code: "auth_failed", params: { method: "SPF" } },
    ]);
  });

  it("does not use low_open_rate below 5 messages or above 10%, nor category primary", () => {
    const signals = makeSignals({ senderSeenCount: 4, senderOpenRate: 0, category: "primary" });
    expect(codes(ctx({ signals }))).toEqual([]);
    const opened = makeSignals({ senderSeenCount: 20, senderOpenRate: 0.11 });
    expect(codes(ctx({ signals: opened }))).toEqual([]);
  });

  it("puts flag_record first for archive", () => {
    const c = ctx({
      action: "archive",
      model: model(dist(0.1, 0.8, 0.05, 0.05), { flags: { ...LOW_FLAGS, isRecord: 0.9 } }),
      signals: makeSignals({ hasListUnsubscribe: true }),
    });
    expect(codes(c)).toEqual(["flag_record", "list_unsubscribe"]);
  });

  it("uses flag_human and model_important for keep", () => {
    const c = ctx({
      action: "keep",
      model: model(dist(0, 0, 1, 0), { flags: { ...LOW_FLAGS, isFromHuman: 0.95 }, importance: 3.6 }),
      signals: makeSignals({ hasListUnsubscribe: true }),
    });
    expect(selectReasons(c)).toEqual([
      { code: "flag_human", params: {} },
      { code: "model_important", params: { level: "critical" } },
    ]);
  });

  it("keeps at most 3 reasons without duplicate codes", () => {
    const g = guard("keep", [
      { code: "guard_starred", params: {} },
      { code: "guard_starred", params: {} },
      { code: "guard_replied", params: {} },
      { code: "guard_correspondent", params: {} },
      { code: "guard_too_recent", params: { minAgeDays: 3 } },
    ]);
    const reasons = selectReasons(ctx({ guard: g, action: "keep", ceilingApplied: true }));
    expect(reasons.map((r) => r.code)).toEqual(["guard_starred", "guard_replied", "guard_correspondent"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/fusion`
Expected: FAIL with `Cannot find module '../../src/fusion/fusion.ts'`.

- [ ] **Step 3: Write fusion**

`packages/core/src/fusion/fusion.ts`:

```ts
import type { DecisionFlags, DecisionResult } from "../decision/engine.ts";
import { IMPORTANCE_LEVELS } from "../decision/questions.ts";
import type { GuardrailResult } from "../guardrails/guardrails.ts";
import {
  ACTION_RANK,
  isAllowedByCeiling,
  type ActionDistribution,
  type Ceiling,
  type SuggestedAction,
} from "../model/actions.ts";
import {
  EXPIRED_HUMAN_MAX,
  EXPIRED_SHIFT,
  FLAG_THRESHOLD,
  HUMAN_SHIFT,
  MAX_REASONS,
  PRIOR_LAMBDA_K,
  PRIOR_MIN_N,
  RECORD_SHIFT,
} from "../model/constants.ts";
import type { Reason } from "../model/reasons.ts";
import type { Prior } from "../priors/priors.ts";
import type { Signals } from "../signals/signals.ts";

export interface Thresholds {
  /** From settings, [TAU_DELETE_MIN, TAU_DELETE_MAX], default TAU_DELETE_DEFAULT. */
  tauDelete: number;
  /** DELETE_MARGIN. */
  deleteMargin: number;
  /** MIN_CONFIDENCE. */
  minConfidence: number;
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
  /** 0..3 entries, selection in contracts 5.2. */
  reasons: Reason[];
}

export interface ReasonContext {
  model: DecisionResult | null;
  prior: Prior;
  guard: GuardrailResult;
  signals: Signals;
  /** The suggested action after thresholds. */
  action: SuggestedAction;
  ceilingApplied: boolean;
  /** True when the threshold step fell back to "unsure" for lack of confidence. */
  lowConfidence: boolean;
}

const ORDER_NON_DELETE = ["keep", "archive", "unsure"] as const;
const SIGNAL_CATEGORIES: ReadonlySet<string> = new Set(["promotions", "social", "updates", "forums"]);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function deleteSideReasons(ctx: ReasonContext): Reason[] {
  const { model, signals: s } = ctx;
  const out: Reason[] = [];
  if (model !== null && model.flags.isExpired >= FLAG_THRESHOLD)
    out.push({ code: "flag_expired", params: {} });
  if (s.senderSeenCount >= 5 && s.senderOpenRate !== null && s.senderOpenRate <= 0.1) {
    out.push({
      code: "low_open_rate",
      params: { openPct: Math.round(s.senderOpenRate * 100), seen: s.senderSeenCount },
    });
  }
  if (s.hasListUnsubscribe) out.push({ code: "list_unsubscribe", params: {} });
  if (s.precedenceBulk) out.push({ code: "bulk_mail", params: {} });
  if (s.autoSubmitted) out.push({ code: "auto_sent", params: {} });
  if (s.category !== null && SIGNAL_CATEGORIES.has(s.category)) {
    out.push({ code: "category", params: { category: capitalize(s.category) } });
  }
  if (!s.isRead && s.ageDays >= 30) out.push({ code: "old_unread", params: { ageDays: s.ageDays } });
  const failed =
    s.auth.dmarc === "fail"
      ? "DMARC"
      : s.auth.spf === "fail"
        ? "SPF"
        : s.auth.dkim === "fail"
          ? "DKIM"
          : null;
  if (failed !== null) out.push({ code: "auth_failed", params: { method: failed } });
  return out;
}

function signalReasons(ctx: ReasonContext): Reason[] {
  const { model, action } = ctx;
  if (action === "delete" || action === "unsure") return deleteSideReasons(ctx);
  if (action === "archive") {
    const out: Reason[] = [];
    if (model !== null && model.flags.isRecord >= FLAG_THRESHOLD)
      out.push({ code: "flag_record", params: {} });
    return [...out, ...deleteSideReasons(ctx)];
  }
  const out: Reason[] = [];
  if (model !== null && model.flags.isFromHuman >= FLAG_THRESHOLD)
    out.push({ code: "flag_human", params: {} });
  if (model !== null && model.importance >= 3) {
    const index = Math.min(IMPORTANCE_LEVELS.length - 1, Math.round(model.importance));
    out.push({
      code: "model_important",
      params: { level: (IMPORTANCE_LEVELS[index] ?? "High").toLowerCase() },
    });
  }
  return out;
}

function priorReason(ctx: ReasonContext): Reason | null {
  const { prior, action, signals } = ctx;
  if (prior.source === "none" || prior.n < PRIOR_MIN_N) return null;
  const domain = signals.senderDomain;
  if (action === "delete" || prior.pDelete >= 0.5) {
    const code = prior.source === "sender" ? "prior_sender_deleted" : "prior_domain_deleted";
    return { code, params: { deletes: prior.alpha - 1, total: prior.n, domain } };
  }
  const code = prior.source === "sender" ? "prior_sender_kept" : "prior_domain_kept";
  return { code, params: { keeps: prior.beta - 1, total: prior.n, domain } };
}

/** Up to MAX_REASONS reasons in the priority order of contracts 5.2, without duplicate codes. */
export function selectReasons(ctx: ReasonContext): Reason[] {
  const candidates: Reason[] = [];
  if (ctx.model === null) candidates.push({ code: "model_unavailable", params: {} });
  const holdsBack = (ctx.action === "keep" || ctx.action === "archive") && ctx.guard.ceiling !== "delete";
  if (ctx.ceilingApplied || holdsBack) candidates.push(...ctx.guard.reasons);
  if (ctx.guard.denylisted && ctx.action === "delete") candidates.push({ code: "deny_listed", params: {} });
  if (ctx.lowConfidence) candidates.push({ code: "low_confidence", params: {} });
  const prior = priorReason(ctx);
  if (prior !== null) candidates.push(prior);
  candidates.push(...signalReasons(ctx));

  const seen = new Set<string>();
  const out: Reason[] = [];
  for (const reason of candidates) {
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    out.push(reason);
    if (out.length === MAX_REASONS) break;
  }
  return out;
}

interface Choice {
  action: SuggestedAction;
  confidence: number;
  lowConfidence: boolean;
}

function choose(dist: ActionDistribution, th: Thresholds): Choice {
  const nextBest = Math.max(dist.archive, dist.keep, dist.unsure);
  if (dist.delete >= th.tauDelete && dist.delete - nextBest >= th.deleteMargin) {
    return { action: "delete", confidence: dist.delete, lowConfidence: false };
  }
  let best: (typeof ORDER_NON_DELETE)[number] = ORDER_NON_DELETE[0];
  for (const candidate of ORDER_NON_DELETE) {
    if (dist[candidate] > dist[best]) best = candidate;
  }
  if (dist[best] < th.minConfidence) {
    return { action: "unsure", confidence: dist.unsure, lowConfidence: true };
  }
  return { action: best, confidence: dist[best], lowConfidence: false };
}

function move(v: ActionDistribution, from: SuggestedAction, to: SuggestedAction, amount: number): void {
  v[from] -= amount;
  v[to] += amount;
}

function clampAndRenormalize(v: ActionDistribution): ActionDistribution {
  const c = {
    delete: Math.min(1, Math.max(0, v.delete)),
    archive: Math.min(1, Math.max(0, v.archive)),
    keep: Math.min(1, Math.max(0, v.keep)),
    unsure: Math.min(1, Math.max(0, v.unsure)),
  };
  const sum = c.delete + c.archive + c.keep + c.unsure;
  if (sum === 0) return { delete: 0, archive: 0, keep: 0, unsure: 1 };
  return { delete: c.delete / sum, archive: c.archive / sum, keep: c.keep / sum, unsure: c.unsure / sum };
}

/** Deterministic fusion of model, prior, flags and guardrail ceiling (contracts 5.1). */
export function fuse(input: FusionInput): Suggestion {
  const { model, prior, guard, signals, thresholds } = input;
  if (model === null) {
    return {
      action: "unsure",
      confidence: 0,
      distribution: null,
      modelDelete: null,
      margin: null,
      ceiling: guard.ceiling,
      ceilingApplied: false,
      importance: null,
      flags: null,
      reasons: selectReasons({
        model: null,
        prior,
        guard,
        signals,
        action: "unsure",
        ceilingApplied: false,
        lowConfidence: false,
      }),
    };
  }

  const m = model.action;
  const lambda = prior.n / (prior.n + PRIOR_LAMBDA_K);
  const d = (1 - lambda) * m.delete + lambda * prior.pDelete;

  let v: ActionDistribution;
  if (m.delete < 1) {
    const scale = (1 - d) / (1 - m.delete);
    v = { delete: d, archive: m.archive * scale, keep: m.keep * scale, unsure: m.unsure * scale };
  } else {
    v = { delete: d, archive: 0, keep: 0, unsure: 1 - d };
  }

  const f = model.flags;
  if (f.isRecord >= FLAG_THRESHOLD) move(v, "delete", "archive", RECORD_SHIFT * v.delete);
  if (f.isFromHuman >= FLAG_THRESHOLD) move(v, "delete", "keep", HUMAN_SHIFT * v.delete);
  if (f.isExpired >= FLAG_THRESHOLD && f.isFromHuman < EXPIRED_HUMAN_MAX) {
    move(v, "archive", "delete", EXPIRED_SHIFT * v.archive);
  }
  v = clampAndRenormalize(v);

  const unbounded = choose(v, thresholds);
  const w: ActionDistribution = { ...v };
  for (const x of ["delete", "archive"] as const) {
    if (ACTION_RANK[x] > ACTION_RANK[guard.ceiling]) {
      w[guard.ceiling] += w[x];
      w[x] = 0;
    }
  }

  const chosen = choose(w, thresholds);
  const ceilingApplied = !isAllowedByCeiling(unbounded.action, guard.ceiling);

  return {
    action: chosen.action,
    confidence: chosen.confidence,
    distribution: w,
    modelDelete: m.delete,
    margin: w.delete - Math.max(w.archive, w.keep, w.unsure),
    ceiling: guard.ceiling,
    ceilingApplied,
    importance: model.importance,
    flags: f,
    reasons: selectReasons({
      model,
      prior,
      guard,
      signals,
      action: chosen.action,
      ceilingApplied,
      lowConfidence: chosen.lowConfidence,
    }),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/fusion`
Expected: PASS, `Tests  37 passed (37)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/fusion packages/core/test/fusion
git commit -m "feat(core): add deterministic fusion with ceiling folding and reasons"
```

---

### Task 17: Threshold calibration

**Files:**
- Create: `packages/core/src/calibration/calibration.ts`
- Test: `packages/core/test/calibration/calibration.test.ts`

**Interfaces:**
- Consumes: `ActionKind`, `Ceiling`, calibration constants, `DELETE_MARGIN` (Task 2).
- Produces (contracts 4.14, 5.3): `CalibrationSample { pDelete; margin; ceiling; ownerAction }`, `CalibrationPoint { tau; support; precision }`, `CalibrationResult { tauDelete; changed; outcome; deleteSuggestions; precisionAtTau; points }`, `calibrateTauDelete(samples: readonly CalibrationSample[], currentTau: number): CalibrationResult` (grid 0.80..0.99 step 0.01, rounded to 2 decimals; smallest tau with support >= 20 and precision >= 0.98, else 0.99; fewer than 50 delete suggestions at 0.80 keeps `currentTau`).

- [ ] **Step 1: Write the failing test (grid search)**

`packages/core/test/calibration/calibration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calibrateTauDelete, type CalibrationSample } from "../../src/calibration/calibration.ts";
import type { ActionKind } from "../../src/model/actions.ts";

function samples(
  n: number,
  pDelete: number | null,
  ownerAction: ActionKind,
  margin: number | null = 0.5,
): CalibrationSample[] {
  return Array.from({ length: n }, () => ({ pDelete, margin, ceiling: "delete" as const, ownerAction }));
}

describe("calibrateTauDelete", () => {
  it("returns insufficient_data below 50 delete suggestions at tau 0.80", () => {
    const result = calibrateTauDelete([...samples(49, 0.9, "delete"), ...samples(100, 0.5, "keep")], 0.85);
    expect(result).toEqual({
      tauDelete: 0.85,
      changed: false,
      outcome: "insufficient_data",
      deleteSuggestions: 49,
      precisionAtTau: null,
      points: [],
    });
  });

  it("ignores samples without pDelete or margin, and samples under the delete margin", () => {
    const result = calibrateTauDelete(
      [
        ...samples(30, 0.9, "delete"),
        ...samples(30, null, "delete"),
        ...samples(30, 0.9, "delete", null),
        ...samples(30, 0.9, "delete", 0.19),
      ],
      0.8,
    );
    expect(result.outcome).toBe("insufficient_data");
    expect(result.deleteSuggestions).toBe(30);
  });

  it("evaluates every tau from 0.80 to 0.99 in ascending order", () => {
    const result = calibrateTauDelete(samples(60, 0.9, "delete"), 0.8);
    expect(result.points.map((p) => p.tau)).toEqual([
      0.8, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96,
      0.97, 0.98, 0.99,
    ]);
    expect(result.points[10]).toEqual({ tau: 0.9, support: 60, precision: 1 });
    expect(result.points[11]).toEqual({ tau: 0.91, support: 0, precision: null });
  });

  it("picks the smallest tau meeting support >= 20 and precision >= 0.98", () => {
    const data = [
      ...samples(50, 0.82, "delete"),
      ...samples(10, 0.82, "keep"),
      ...samples(30, 0.95, "delete"),
    ];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.outcome).toBe("calibrated");
    expect(result.tauDelete).toBe(0.83);
    expect(result.changed).toBe(true);
    expect(result.deleteSuggestions).toBe(90);
    expect(result.precisionAtTau).toBe(1);
    expect(result.points[0]?.precision).toBeCloseTo(80 / 90, 9);
  });

  it("accepts precision exactly 0.98", () => {
    const data = [...samples(49, 0.9, "delete"), ...samples(1, 0.9, "archive")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.tauDelete).toBe(0.8);
    expect(result.precisionAtTau).toBeCloseTo(0.98, 9);
    expect(result.changed).toBe(false);
  });

  it("requires at least 20 supporting labels", () => {
    const data = [...samples(40, 0.85, "keep"), ...samples(19, 0.97, "delete")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.outcome).toBe("no_tau_meets_target");
    expect(result.tauDelete).toBe(0.99);
  });

  it("falls back to 0.99 with the precision at 0.99 when no tau qualifies", () => {
    const data = [...samples(40, 0.995, "keep"), ...samples(20, 0.995, "delete")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result).toMatchObject({ tauDelete: 0.99, outcome: "no_tau_meets_target", changed: true });
    expect(result.precisionAtTau).toBeCloseTo(20 / 60, 9);
  });

  it("never returns a tau outside [0.80, 0.99]", () => {
    for (const p of [0.5, 0.8, 0.9, 1]) {
      const result = calibrateTauDelete(samples(100, p, "delete"), 0.9);
      expect(result.tauDelete).toBeGreaterThanOrEqual(0.8);
      expect(result.tauDelete).toBeLessThanOrEqual(0.99);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/calibration`
Expected: FAIL with `Cannot find module '../../src/calibration/calibration.ts'`.

- [ ] **Step 3: Write calibration**

`packages/core/src/calibration/calibration.ts`:

```ts
import type { ActionKind, Ceiling } from "../model/actions.ts";
import {
  CALIBRATION_MIN_DELETE_SUGGESTIONS,
  CALIBRATION_MIN_SUPPORT,
  CALIBRATION_TARGET_PRECISION,
  DELETE_MARGIN,
  TAU_DELETE_MAX,
  TAU_DELETE_MIN,
  TAU_STEP,
} from "../model/constants.ts";

export interface CalibrationSample {
  /** labels.p_delete (fused, after ceiling). */
  pDelete: number | null;
  /** labels.margin. */
  margin: number | null;
  ceiling: Ceiling;
  ownerAction: ActionKind;
}

export interface CalibrationPoint {
  tau: number;
  support: number;
  precision: number | null;
}

export interface CalibrationResult {
  tauDelete: number;
  changed: boolean;
  outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target";
  /** Support at TAU_DELETE_MIN. */
  deleteSuggestions: number;
  precisionAtTau: number | null;
  /** Every tau evaluated, ascending. */
  points: CalibrationPoint[];
}

interface ScoredSample {
  pDelete: number;
  margin: number;
  ownerAction: ActionKind;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function wouldDelete(s: ScoredSample, tau: number): boolean {
  return s.pDelete >= tau && s.margin >= DELETE_MARGIN;
}

/** Grid search for the smallest tau with enough support and precision >= target (contracts 5.3). */
export function calibrateTauDelete(
  samples: readonly CalibrationSample[],
  currentTau: number,
): CalibrationResult {
  const base: ScoredSample[] = [];
  for (const s of samples) {
    if (s.pDelete !== null && s.margin !== null) {
      base.push({ pDelete: s.pDelete, margin: s.margin, ownerAction: s.ownerAction });
    }
  }
  const deleteSuggestions = base.filter((s) => wouldDelete(s, TAU_DELETE_MIN)).length;

  if (deleteSuggestions < CALIBRATION_MIN_DELETE_SUGGESTIONS) {
    return {
      tauDelete: currentTau,
      changed: false,
      outcome: "insufficient_data",
      deleteSuggestions,
      precisionAtTau: null,
      points: [],
    };
  }

  const steps = Math.round((TAU_DELETE_MAX - TAU_DELETE_MIN) / TAU_STEP);
  const points: CalibrationPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const tau = round2(TAU_DELETE_MIN + i * TAU_STEP);
    const selected = base.filter((s) => wouldDelete(s, tau));
    const support = selected.length;
    const correct = selected.filter((s) => s.ownerAction === "delete").length;
    points.push({ tau, support, precision: support > 0 ? correct / support : null });
  }

  const chosen = points.find(
    (p) =>
      p.support >= CALIBRATION_MIN_SUPPORT &&
      p.precision !== null &&
      p.precision >= CALIBRATION_TARGET_PRECISION,
  );
  const last = points[points.length - 1];
  const tauDelete = chosen ? chosen.tau : TAU_DELETE_MAX;
  return {
    tauDelete,
    changed: tauDelete !== currentTau,
    outcome: chosen ? "calibrated" : "no_tau_meets_target",
    deleteSuggestions,
    precisionAtTau: chosen ? chosen.precision : (last?.precision ?? null),
    points,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/calibration`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm exec eslint packages/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/calibration packages/core/test/calibration
git commit -m "feat(core): add tau_delete calibration grid search"
```

---

### Task 18: Public barrel, testing entry and CPU benchmark

**Files:**
- Create: `packages/core/src/index.ts`, `packages/core/test/testing.ts`
- Test: `packages/core/test/index.test.ts`, `packages/core/test/bench/page-cpu.test.ts`

**Interfaces:**
- Consumes: every module of Tasks 2 to 17; builders (Tasks 9, 11); Decision-1 mock (Task 14).
- Produces: the `@clearbox/core` barrel and the `@clearbox/core/testing` entry exactly as listed under "Public surface" above. Plan 02 appends its provider exports to `src/index.ts` and its fixtures and MSW factories to `test/testing.ts`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";
import * as testing from "./testing.ts";

const RUNTIME_EXPORTS = [
  "ACTION_KINDS",
  "ACTION_RANK",
  "SUGGESTED_ACTIONS",
  "isAllowedByCeiling",
  "minCeiling",
  "REASON_CODES",
  "REASON_TEMPLATES",
  "renderReason",
  "ClearboxError",
  "ProviderAuthError",
  "ProviderConfigError",
  "ProviderRateLimitError",
  "ProviderUnavailableError",
  "CursorExpiredError",
  "ProviderResponseError",
  "SubrequestBudgetError",
  "ScopeMissingError",
  "DecisionError",
  "DECISION_ERROR_RULES",
  "PRIOR_MIN_N",
  "TAU_DELETE_DEFAULT",
  "DECISION_CONCURRENCY",
  "DECISION_RETRY_DELAYS_MS",
  "TICK_SUBREQUEST_LIMIT",
  "MESSAGE_SUBJECT_MAX_CHARS",
  "createSubrequestCounter",
  "countingFetch",
  "parseRetryAfter",
  "backoffMs",
  "fnv1a32",
  "mulberry32",
  "seededShuffle",
  "mapWithConcurrency",
  "decodeEncodedWords",
  "unfoldHeader",
  "parseAddress",
  "parseAddressList",
  "registrableDomain",
  "headerValue",
  "parseAuthResults",
  "parseListUnsubscribe",
  "isBulkPrecedence",
  "isAutoSubmitted",
  "truncateChars",
  "collapseWhitespace",
  "decodeHtmlEntities",
  "GOOGLE_SCOPES",
  "MICROSOFT_SCOPES",
  "MICROSOFT_CONSENT_URLS",
  "extractSignals",
  "SenderEntrySchema",
  "PolicySchema",
  "DEFAULT_POLICY",
  "parsePolicy",
  "matchesSenderList",
  "matchRecordPattern",
  "evaluateGuardrails",
  "priorKeyForSender",
  "priorKeyForDomain",
  "selectPrior",
  "priorDelta",
  "applyOwnerAction",
  "buildDecisionState",
  "DECISION_QUESTIONS",
  "IMPORTANCE_LEVELS",
  "buildDecisionQuestions",
  "buildDecisionRequest",
  "decisionSeed",
  "ChoiceAnswerSchema",
  "ScoreAnswerSchema",
  "NoulAnswerSchema",
  "DecisionResponseSchema",
  "normalizeDecisionResponse",
  "MaiDecisionEngine",
  "DECISION_PATH",
  "decisionErrorKindForStatus",
  "FakeEngine",
  "decideAll",
  "fuse",
  "selectReasons",
  "calibrateTauDelete",
] as const;

describe("@clearbox/core barrel", () => {
  it.each(RUNTIME_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
    expect((core as Record<string, unknown>)[name]).toBeDefined();
  });
});

describe("@clearbox/core/testing", () => {
  it("exports builders and the Decision-1 mock", () => {
    for (const name of [
      "makeMailMessage",
      "makeSignals",
      "makeSenderHistory",
      "makeDecisionResult",
      "makePolicy",
      "decisionHandlers",
      "DecisionMockState",
    ]) {
      expect(testing).toHaveProperty(name);
    }
  });
});
```

`packages/core/test/bench/page-cpu.test.ts` (contracts 8.4 and 10.1: fails when a 25-message page exceeds 6 ms median over 50 runs; issue #25):

```ts
import { describe, expect, it } from "vitest";
import { buildDecisionRequest, decisionSeed } from "../../src/decision/questions.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { fuse } from "../../src/fusion/fusion.ts";
import { evaluateGuardrails } from "../../src/guardrails/guardrails.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import { DEFAULT_POLICY } from "../../src/policy/policy.ts";
import { selectPrior } from "../../src/priors/priors.ts";
import { extractSignals } from "../../src/signals/signals.ts";
import {
  DAY_MS,
  TEST_NOW,
  makeDecisionResult,
  makeMailMessage,
  makeSenderHistory,
} from "../fixtures/builders.ts";

const PAGE = Array.from({ length: 25 }, (_, i) =>
  makeMailMessage({
    providerMessageId: `msg-${String(i)}`,
    threadId: `thr-${String(i)}`,
    receivedAt: TEST_NOW - (i + 1) * DAY_MS,
    from: {
      address: `sender${String(i % 7)}@news${String(i % 3)}.example.com`,
      name: "=?UTF-8?B?Q2Fmw6k=?=",
    },
    subject: i % 4 === 0 ? "Your receipt for order 1234" : `Weekly deals number ${String(i)} ends tonight`,
    snippet: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
    category: i % 2 === 0 ? "promotions" : "updates",
    isRead: i % 3 === 0,
    headers: {
      listUnsubscribe: "<https://news.example.com/u/1>, <mailto:u@news.example.com>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      precedence: "bulk",
      returnPath: "<bounce@mailer.esp.example.net>",
      authenticationResults:
        "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=x; dmarc=pass",
    },
  }),
);
const PAST = Array.from({ length: 5 }, () => ({
  domain: "example.com",
  subject: "Flash sale: boots 30% off",
  owner_action: "delete" as const,
}));
const RESULT = makeDecisionResult({ action: { delete: 0.9, archive: 0.04, keep: 0.03, unsure: 0.03 } });
const TH = { tauDelete: TAU_DELETE_DEFAULT, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE };
const ctx = { now: TEST_NOW, ownerAddresses: ["owner@example.test"], repliedThreadIds: new Set(["thr-3"]) };

function processPage(): number {
  let checksum = 0;
  for (const msg of PAGE) {
    const history = makeSenderHistory({ seenCount: 12, readCount: 1, senderPrior: { deletes: 4, keeps: 1 } });
    const signals = extractSignals(msg, history, ctx);
    const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, DEFAULT_POLICY);
    const prior = selectPrior(
      history.senderPrior,
      history.domainPrior,
      signals.senderAddress,
      signals.senderDomain,
    );
    const state = buildDecisionState({ msg, signals, pastDecisions: PAST });
    const body = JSON.stringify(
      buildDecisionRequest(state, "decision-1", decisionSeed("acc_0123456789abcdef", msg.providerMessageId)),
    );
    const suggestion = fuse({ model: RESULT, prior, guard, signals, thresholds: TH });
    checksum += body.length + suggestion.confidence;
  }
  return checksum;
}

describe("page CPU budget", () => {
  it("processes a 25-message page in <= 6 ms median over 50 runs", () => {
    for (let i = 0; i < 5; i++) processPage();
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      processPage();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[25] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThanOrEqual(6);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @clearbox/core exec vitest run test/index.test.ts test/bench`
Expected: `test/index.test.ts` FAILS with `Cannot find module '../src/index.ts'`; the benchmark already PASSES (it only needs the modules from earlier tasks).

- [ ] **Step 3: Write the barrel**

`packages/core/src/index.ts`:

```ts
export type {
  AccountId,
  AccountRef,
  AuthVerdict,
  MailAddress,
  MailCategory,
  MailHeaders,
  MailMessage,
  OwnerPosition,
  ProviderKind,
} from "./model/mail.ts";
export {
  ACTION_KINDS,
  ACTION_RANK,
  SUGGESTED_ACTIONS,
  isAllowedByCeiling,
  minCeiling,
} from "./model/actions.ts";
export type { ActionDistribution, ActionKind, Ceiling, SuggestedAction } from "./model/actions.ts";
export { REASON_CODES, REASON_TEMPLATES, renderReason } from "./model/reasons.ts";
export type { Reason, ReasonCode, ReasonParams } from "./model/reasons.ts";
export {
  ClearboxError,
  CursorExpiredError,
  DECISION_ERROR_RULES,
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ScopeMissingError,
  SubrequestBudgetError,
} from "./model/errors.ts";
export type { DecisionErrorKind, DecisionErrorOptions } from "./model/errors.ts";
export * from "./model/constants.ts";

export { backoffMs, countingFetch, createSubrequestCounter, parseRetryAfter } from "./http/fetch.ts";
export type { FetchLike, SubrequestCounter } from "./http/fetch.ts";
export { fnv1a32, mulberry32, seededShuffle } from "./util/rng.ts";
export { mapWithConcurrency } from "./util/concurrency.ts";

export { decodeEncodedWords, unfoldHeader } from "./text/rfc2047.ts";
export { parseAddress, parseAddressList, registrableDomain } from "./text/address.ts";
export {
  headerValue,
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "./text/headers.ts";
export type { ListUnsubscribe, ParsedAuthResults, RawHeader } from "./text/headers.ts";
export { collapseWhitespace, decodeHtmlEntities, truncateChars } from "./text/truncate.ts";

export type {
  ActionErrorCode,
  ActionResult,
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  GraphProviderDeps,
  IncrementalCursor,
  InboxPage,
  MailProvider,
  ProviderDeps,
  RestoreFrom,
  RestoreItem,
  SentCursor,
  SentItem,
  SentPage,
} from "./providers/provider.ts";
export type { OAuthTokens, TokenSource, TokenUpdate } from "./providers/token.ts";
export { GOOGLE_SCOPES, MICROSOFT_CONSENT_URLS, MICROSOFT_SCOPES } from "./providers/oauth.ts";
export type { AuthorizeParams, OAuthClientConfig } from "./providers/oauth.ts";

export { extractSignals } from "./signals/signals.ts";
export type { SenderHistory, SignalContext, Signals } from "./signals/signals.ts";
export {
  DEFAULT_POLICY,
  PolicySchema,
  SenderEntrySchema,
  matchRecordPattern,
  matchesSenderList,
  parsePolicy,
} from "./policy/policy.ts";
export type { Policy } from "./policy/policy.ts";
export { evaluateGuardrails } from "./guardrails/guardrails.ts";
export type { GuardrailInput, GuardrailResult } from "./guardrails/guardrails.ts";
export {
  applyOwnerAction,
  priorDelta,
  priorKeyForDomain,
  priorKeyForSender,
  selectPrior,
} from "./priors/priors.ts";
export type { Prior, PriorCounts } from "./priors/priors.ts";

export type { DecisionEngine, DecisionFlags, DecisionInput, DecisionResult } from "./decision/engine.ts";
export { buildDecisionState } from "./decision/state.ts";
export type { BuildStateInput, DecisionState, PastDecision } from "./decision/state.ts";
export {
  DECISION_QUESTIONS,
  IMPORTANCE_LEVELS,
  buildDecisionQuestions,
  buildDecisionRequest,
  decisionSeed,
} from "./decision/questions.ts";
export type {
  ChoiceQuestion,
  DecisionQuestions,
  DecisionRequestBody,
  NoulQuestion,
  ScoreQuestion,
} from "./decision/questions.ts";
export {
  ChoiceAnswerSchema,
  DecisionResponseSchema,
  NoulAnswerSchema,
  ScoreAnswerSchema,
  normalizeDecisionResponse,
} from "./decision/response.ts";
export type { DecisionResponse, NormalizeMeta } from "./decision/response.ts";
export { DECISION_PATH, MaiDecisionEngine, decisionErrorKindForStatus } from "./decision/mai-engine.ts";
export type { MaiEngineConfig } from "./decision/mai-engine.ts";
export { FakeEngine } from "./decision/fake-engine.ts";
export type { FakeEngineOptions } from "./decision/fake-engine.ts";
export { decideAll } from "./decision/run.ts";
export type { DecisionOutcome } from "./decision/run.ts";

export { fuse, selectReasons } from "./fusion/fusion.ts";
export type { FusionInput, ReasonContext, Suggestion, Thresholds } from "./fusion/fusion.ts";
export { calibrateTauDelete } from "./calibration/calibration.ts";
export type { CalibrationPoint, CalibrationResult, CalibrationSample } from "./calibration/calibration.ts";
```

- [ ] **Step 4: Write the testing entry**

`packages/core/test/testing.ts`:

```ts
// Public test helpers, exported as "@clearbox/core/testing" for worker and web tests.
export {
  DAY_MS,
  TEST_NOW,
  makeDecisionResult,
  makeMailHeaders,
  makeMailMessage,
  makePolicy,
  makeSenderHistory,
  makeSignals,
} from "./fixtures/builders.ts";
export type { MailMessageOverrides } from "./fixtures/builders.ts";
export { DecisionMockState, decisionHandlers, makeDecisionResponseBody } from "./msw/decision.ts";
export type { DecisionFailSpec, DecisionMockOptions } from "./msw/decision.ts";
```

- [ ] **Step 5: Run them to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/index.test.ts test/bench`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  83 passed (83)`.

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm test && git add packages/core && pnpm lint && pnpm format:check`
Expected:
- `tsc -p tsconfig.json` exits 0.
- `Test Files  27 passed (27)`, `Tests  353 passed (353)`.
- ESLint silent, `check-text: <N> tracked files clean`.
- `All matched files use Prettier code style!`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/testing.ts packages/core/test/index.test.ts packages/core/test/bench
git commit -m "feat(core): add public barrel, testing entry and page CPU benchmark"
```

---

## Self-review

**1. Spec coverage**

| Contracts requirement | Task |
|---|---|
| 1.1 root files (`package.json`, workspace, `.npmrc`, `.nvmrc`, `.editorconfig`, `.gitignore`, Prettier, ESLint, `tsconfig.base.json`) | 1 |
| 1.2 core package manifest, `.ts` import extensions, erasable syntax | 1 (manifest), all tasks (imports) |
| 1.3 root scripts | 1 |
| 3.5 base and core tsconfig; 3.6 core Vitest config; 3.8 ESLint, Prettier, check-text; 3.9 `.gitignore` | 1 |
| 4.1 mail model; 4.2 actions; 4.11 reasons (with 12.2 wording); 4.13 constants | 2 |
| 4.12 errors | 3 |
| 4.15 fetch, counter, Retry-After, backoff, RNG, concurrency | 4 |
| 1.1 `text/*` helpers (RFC 2047, addresses, headers, truncation) | 5 |
| 4.3 provider interfaces; 4.4 shared token and OAuth types | 6 |
| 4.6 policy | 7 |
| 4.8 priors | 8 |
| 4.5 signals; 10.2 builders | 9, 11 |
| 4.7 guardrails (ceiling matrix) | 10 |
| 4.9.1 state and token budget | 11 |
| 4.9.2 questions, shuffle, request, seed | 12 |
| 4.9.3 response validation (choice, score, noul shapes of research 4.1 to 4.3) | 13 |
| 4.9.4 `MaiDecisionEngine` (retry and no-retry statuses, timeout, no internal retries); 10.3 Decision-1 mock | 14 |
| 4.9.4 `FakeEngine`, `decideAll`; 10.5 | 15 |
| 4.10, 5.1 (all 13 edge cases), 5.2 | 16 |
| 4.14, 5.3 | 17 |
| Section 4 barrel; 10.2 `@clearbox/core/testing`; 8.4 CPU benchmark | 18 |

Amendments 12.1 (A1 to A6), 12.3 and 12.4 do not touch `@clearbox/core`; no core change is needed for them.

Out of scope here (other plans): `providers/google/**`, `providers/microsoft/**`, `http/multipart.ts`, the OAuth shell functions in `providers/oauth.ts`, Gmail/Graph/OAuth/JWKS MSW factories and `FakeMailbox` (plan 02); `app/` (plans 03 onward); `eval/`, `scripts/setup-cf.ts`, `scripts/gen-key.ts`, `.github/`, `README.md`, `LICENSE`, `SECURITY.md`, `infra/`, setup docs (other plans).

**2. Placeholder scan:** every code step embeds the complete file; no TBD, TODO or "similar to" references. Every command has an expected result.

**3. Type consistency:** names in each task's Interfaces block match the code it embeds and the barrel in Task 18; the barrel test enumerates every runtime export; `pnpm typecheck` covers the type-only exports. All code in this plan was compiled, linted, formatted and run (353 tests passing) against the pinned versions before the plan was written.
