# Clearbox Scan Pipeline (plan 04 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cron-driven scan tick (claim, fetch one page, decide, fuse, write, budget), the `POST /api/accounts/:id/scan` route that runs the same tick on demand, and the nightly job (calibration, stale recovery, bounded purge, housekeeping), all inside the Workers Free limits.

**Architecture:** `runTick` in `app/src/worker/scan/tick.ts` is a thin orchestrator over pure, separately tested stages: SQL statement builders (`claim.ts`, `context.ts`, `write-plan.ts`, `failure.ts`) that return plain `{ sql, params }` objects, a pure ingest stage (`ingest.ts`) that turns a provider page plus D1 context into fused suggestions, and small factories for tokens, providers and the Decision-1 engine. Every external call (provider, OAuth, Decision-1) and every D1 call reserves from one `SubrequestCounter`, with two calls held back so the final write and the budget upsert always fit. `runNightly` in `app/src/worker/nightly/nightly.ts` reuses the same statement toolkit and a bounded purge in `nightly/purge.ts`.

**Tech Stack:** TypeScript 6.0.3, Cloudflare Workers + D1 (Free plan), Hono 4.13.13, `@clearbox/core` (plan 01), Vitest 5.0.4 with `@cloudflare/vitest-plugin` 1.4.2, MSW 3.0.3 with `@msw/cloudflare` 0.2.0.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` (sections 4, 5, 6, 7.5, 8, 9, 10). Names, SQL and signatures below follow it; every deviation is listed in "Contract issues and decisions".
- Node.js 24.13.1 (`engines >=24.13.0`), pnpm 12.11.2, TypeScript 6.0.3, vitest 5.0.4, @cloudflare/vitest-plugin 1.4.2, msw 3.0.3, @msw/cloudflare 0.2.0, hono 4.13.13. No new dependencies.
- No em dashes (U+2014) anywhere: code, comments, test names, docs, commit messages.
- ESM only, relative imports with explicit `.ts` extensions, `import type` for type-only imports, named exports only (default export only in `src/worker/index.ts`).
- Strict TypeScript per `tsconfig.base.json`: no `any`, no `enum`, no `namespace`, no parameter properties (`erasableSyntaxOnly`), no non-null assertions outside tests.
- SQL: `?N` numbered parameters only, never value interpolation; IN lists of at most 90 values (`IN_LIST_MAX`, under the 100 bound-parameter limit); every query on `messages`, `suggestions`, `labels`, `sender_priors`, `senders`, `correspondents`, `sent_threads` filters on `account_id` except the nightly cross-account statements exempted by contracts 6.1.
- Open-suggestion queries use `account_id = ?` and `status = 'pending'` or `status = 'awaiting_model'` as equalities (OR form), so `suggestions_open` is usable.
- Workers Free: 10 ms CPU per invocation, tick budget `TICK_SUBREQUEST_LIMIT = 45` subrequests counting D1 calls, D1 daily write gates `INGEST_STOP_ROWS = 65_000`, `PURGE_STOP_ROWS = 80_000`, `BUDGET_ROWS_PER_DAY = 90_000`.
- One tick = one account, at most one page (`page_size`, max 25 on Free, 100 when `FREE_TIER = "false"`), at most 4 concurrent Decision-1 calls, no in-tick retries.
- Time is always injected (`now`); tests never depend on the wall clock. Floats compared with `toBeCloseTo`.
- Logs (`logEvent`) carry only opaque ids, counts, durations, enum codes and HTTP statuses: never addresses, names, subjects, snippets, provider message or thread ids, tokens or URLs.
- No code path in this plan calls `trash`, `archive` or `restore`.
- Do not edit the contracts document. Report contract issues to the lead.
- `cf workers types` and `cf build` (inside `typecheck`, `build`, `deploy:cf`) evaluate `app/cloudflare.config.ts` in production mode, which throws without a D1 id (contracts 3.2). Local typecheck and build commands therefore run with `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000` (the public local id; plan 06 CI does the same). Never write that id into `app/clearbox.local.json`.

---

## Contract issues and decisions

| # | Issue in contracts | Decision in this plan |
|---|---|---|
| C1 | 8.1 declares `runNightly` in the `scan/tick.ts` block, but 1.1 assigns it to `src/worker/nightly/nightly.ts`. | `runNightly` lives in `nightly/nightly.ts`; `index.ts` imports it from there. |
| C2 | Contracts names no repository functions for tick or nightly SQL, and section 11 allows SQL in `scan/write-plan.ts` only (among scan files). 1.1 has no files for claim, context reads or failure handling. | Three extra files: `scan/claim.ts`, `scan/context.ts`, `scan/failure.ts`. All tick SQL lives in `scan/*.ts` builders returning `{ sql, params }`; nightly SQL in `nightly/*.ts`. Lead: add these files to 1.1 and extend the section 11 SQL locations to `scan/*.ts`. |
| C3 | `makeDecisionEngine(env)` cannot count Decision-1 calls against the tick counter without the tick's fetch. | `makeDecisionEngine(env: Env, fetch: FetchLike): DecisionEngine \| null` (null when any Decision secret is empty). |
| C4 | Contracts 8.2 `new D1TokenSource(account, cfg, f, now)` is not what plan 03 built: plan 03 owns `scan/token-source.ts` and `scan/providers.ts` (its Tasks 5 and 8) because owner actions and OAuth need them first. | This plan creates neither file. It uses plan 03's `createD1TokenSource` with `refreshFnFor(PROVIDER_OAUTH, config, provider, tickFetch, now, "")` (refresh grants send no redirect URI; a cron has no origin) and plan 03's `makeProvider(target, deps)`. Its own additions live in the new file `scan/tick-tokens.ts` (`openTickTokens`, `tokenAccountOf`, `providerTargetOf`, `TokenColumns`, `encryptTokenUpdate`). |
| C5 | `TokenUpdate` is listed in 1.1 for `providers/token.ts` but was not declared in 4.4. | One `TokenUpdate`: plan 01's, exported from `@clearbox/core` (contracts 4.4, rev 2.2). Plans 03 and 04 import it. |
| C6 | 7.5 maps pre-claim failures "using the lease row", but the 8.2 claim batch does not read it. | The claim batch has a 7th statement: `SELECT holder, expires_at, released_at FROM leases WHERE name = 'account:' \|\| ?1`. |
| C7 | A caught-up account gets `next_tick_at = now + 30 min`, which delays `awaiting_model` retries due in 5 min. | The success account update sets `next_tick_at = MIN(<8.3 value>, MIN(retry_after) of the account's awaiting rows)`. |
| C8 | The budget gate writes nothing on an idle cron, so `next_tick_at` cannot be moved to the next UTC day; `budget_exhausted_today` has no raiser. | Gated cron ticks write nothing and return `TickReport.nextTickAt` = next UTC midnight and log `budget.gate`; the claim gate itself defers the account until the new day. Ticks never raise `budget_exhausted_today` (it would cost writes when the budget is gone); `/api/me` (plan 03) can derive it from `budget`. |
| C9 | "abort gracefully before the limit" is unspecified. | Two D1 calls are always reserved for the final write and the budget upsert. Decision-1 calls are capped to the remaining room; if not all fresh messages fit, the processed prefix is written and the cursor is NOT advanced (`next_tick_at = now`), so the next tick re-reads the page and skips known ids. If nothing fits, `SubrequestBudgetError` goes to the failure path, which halves `page_size` and sets no backoff (deviation from the 8.2 backoff formula). |
| C10 | `fail(DecisionError "server")` and missing secrets require constructing `DecisionError` with fields that have no meaning there. | Local `ClearboxError` subclasses `DecisionOutageError` (code `decision_outage`) and `DecisionNotConfiguredError` (code `decision_not_configured`) in `scan/failure.ts`. |
| C11 | 4.5 says `SenderHistory.seenCount` excludes the current page; 8.2 says history includes counts from earlier messages on the page. | Follow 8.2: history = stored counters + earlier messages on the same page. |
| C12 | Context keys need the same sender address and domain that `extractSignals` derives. | Sender address and domain for context keys come from an identity pass `extractSignals(msg, EMPTY_HISTORY, ctx)` (plan 01 also exports `registrableDomain`, but the identity pass guarantees the keys match the signals). |
| C13 | Tests need a smaller subrequest limit and stage timings; `TickOptions` is normative. | `runTick(env, opts)` is unchanged; `runTickInternal(env, opts, internals: TickInternals)` is also exported for tests and the benchmark. |
| C14 | The Paid-plan tick subrequest limit is unspecified. | `PAID_TICK_SUBREQUEST_LIMIT = 500` (local constant in `tick.ts`). |
| C15 | `CursorExpiredError` for the sent cursor has no rule. | Restart the sent scan from `null` (same as inbox backfill). |
| C16 | Upserts that change nothing still cost D1 writes. | Correspondent and thread upserts only update when `excluded.last_sent_at` is newer; the unknown sender `""` gets no `senders` row. |
| C17 | `TickReport.subrequests` scope unspecified. | It counts every subrequest including D1 calls (the same counter as the limit). |
| C18 | Nightly purge of disconnected accounts would violate `suggestions.message_id` FK if messages are deleted first; lease rows of deleted accounts are never cleaned. | Each round deletes suggestions first, then only messages with no suggestion; an account is finalized when every table returned fewer than 1,000 deletes. Final batch also deletes account leases whose account no longer exists. |
| C19 | A disconnect during a running tick could get tokens written back. | Both account updates (success and failure) are guarded with `AND status <> 'disconnected'`. |
| C20 | 8.4 names a Node core benchmark (`packages/core/test/bench/page-cpu.test.ts`, owned by plan 01). This plan needs a worker-level end-to-end measurement. | `app/test/worker/tick/tick-cpu.test.ts` runs in local workerd, whose timers advance during CPU work (Cloudflare "Performance and timers" docs), and asserts pure stages < 8 ms median and wall minus awaited I/O < 10 ms median. |
| C21 | 10.4 drives the cron path through `exports.default.scheduled`; its typing is not guaranteed. | The scheduled test imports the worker module's default export directly and calls `scheduled(controller, env, ctx)`. |
| C22 | If D1 rejects `CLAIM_SQL`, 8.2 says "update this section". | Task 2 includes the documented fallback; the implementer applies it and reports to the lead instead of editing contracts. |
| C23 | Plan 03's `sumRowsWritten`/`sumRowsRead` take `D1Result[]`; this plan's builders return plain `{ sql, params }` and parse a structural `BatchResult`. | `sumMeta(results, field)` in `scan/write-plan.ts`; from `db/sql.ts` this plan uses `withCount`, `chunk`, `utcDate`, `nextUtcMidnight`, `toIso`. |
| C24 | Plan 02's `FakeMailbox` and MSW factories in `@clearbox/core/testing` run on `msw/node` and plan 01's Node `setupServer`; worker tests run in workerd with `@msw/cloudflare`. | Worker tests use this plan's own MSW handlers in `app/test/worker/helpers/provider-mock.ts` (Graph JSON, Microsoft and Google token endpoints, Decision-1), installed on plan 03's `network`. |
| C25 | Re-deciding an `awaiting_model` row needs a guardrail result that is not stored. | Recomputed from stored `signals_json`, stored subject and snippet, and the current policy. |
| C26 | Amendment 12.1 A4: the tick refreshes `accounts.inbox_estimate` "at most once per day during backfill", but there is no column recording when it was last refreshed. | Plan 02's `MailProvider.inboxEstimate(): Promise<number \| null>` (Gmail `users.labels.get INBOX` `messagesTotal`, Graph `mailFolders/inbox` `totalItemCount`), pinned in Task 1. The tick fetches it on `sent_backfill` and `inbox_backfill` ticks when `inbox_estimate IS NULL` or when `last_tick_at` falls on an earlier UTC day (first backfill tick of each day), so at most one extra subrequest per account per day; failures are ignored (best effort, the value is kept). Plan 03's `completeConnect` writes it once at connect (best effort). |
| C27 | Amendment 12.1 A5 fixes the calibration audit result keys. | The nightly `calibration` audit row has `result_json = {"tauDelete": <number>}` exactly. Tick audit rows `reauth_required` / `config_error` (keys not fixed by A5) carry `{"reason": <code>}`. |

## Upstream surfaces (reconciled against plans 01 to 03, pinned by Task 1)

Every name below is the producer's exact export. Task 1 Step 1 adds a type-level test that fails `pnpm typecheck` if a producer changes.

| From | Symbol | Signature | Used in |
|---|---|---|---|
| plan 03 Task 3 `src/worker/env.ts` | `readConfig`, `AppConfig` | `readConfig(env: Env): { ok: true; config: AppConfig } \| { ok: false; invalid: string[] }`; `AppConfig.tokenEncKey: Uint8Array<ArrayBuffer>` | `scan/tick.ts`, `scan/tick-tokens.ts` |
| plan 03 Tasks 3, 5 `src/worker/env.ts` | `AppEnv`, `CRON_TICK`, `CRON_NIGHTLY` | Hono env type; cron strings per contracts 8.1 (plan 03's `index.ts` already routes them) | route |
| plan 03 Task 4 `src/worker/crypto/aead.ts` | `importEncKey`, `encryptToken`, `decryptToken`, `EncryptedValue` | `importEncKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey>`; `encryptToken(key, plaintext, ctx: { accountId; kind: "refresh" \| "access"; keyVersion }): Promise<EncryptedValue>`; `decryptToken(key, value: EncryptedValue, ctx): Promise<string>`; `EncryptedValue = { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }` | `scan/tick.ts`, `scan/tick-tokens.ts`, test helpers |
| plan 03 Task 3 `src/worker/crypto/base64.ts` | `bytesFromBlob`, `base64ToBytes` | `bytesFromBlob(value: unknown): Uint8Array<ArrayBuffer> \| null` | `scan/tick-tokens.ts`, `tick-db.ts` |
| plan 03 Task 5 `src/worker/middleware/errors.ts` | `ApiError` | `new ApiError(status: ContentfulStatusCode, code: ApiErrorCode, message: string, options?: { details?: unknown; retryAt?: string })`, readonly `status`, `code`, `retryAt` | `scan/claim.ts` |
| plan 03 Task 6 `src/worker/db/sql.ts` | `withCount`, `chunk`, `utcDate`, `nextUtcMidnight`, `toIso` | `withCount<T>(counter: SubrequestCounter, fn: () => Promise<T>): Promise<T>`; `chunk<T>(items: readonly T[], size: number): T[][]` (`chunk([], n)` is `[]`); date helpers on epoch ms | tick, context, nightly, `write-plan.ts` re-exports |
| plan 03 Task 3 `src/worker/log.ts` | `logEvent` | `logEvent(name: LogEventName, fields: LogFields): void` (contracts 9) | tick, nightly |
| plan 03 Task 10 `src/worker/routes/accounts.ts` | `accountsRoutes` | `Hono<AppEnv>` mounted at `/api/accounts`; ends with the comment `// Plan 04 adds: accountsRoutes.post("/:id/scan", ...)` | Task 11 |
| plan 03 Task 8 `src/worker/scan/token-source.ts` | `createD1TokenSource`, `refreshFnFor`, `D1TokenSource`, `TokenAccount` | `createD1TokenSource({ account: TokenAccount; encKey: CryptoKey; refresh: RefreshFn; now: () => number }): D1TokenSource` (`update: TokenUpdate \| null`, `refreshCount`); `refreshFnFor(oauth, config, provider, fetch, now, redirectUri): RefreshFn` | `scan/tick-tokens.ts` |
| plan 03 Task 5 `src/worker/scan/providers.ts` | `makeProvider`, `PROVIDER_OAUTH`, `ProviderTarget`, `ProviderOAuthMap` | `makeProvider: (target: { provider; archiveFolderId }, deps: ProviderDeps) => MailProvider` | `scan/tick.ts`, `scan/tick-tokens.ts` |
| plan 03 test helpers | `network`, `apiFetch`, `testEncKey` | `network` from `test/worker/setup/network.ts` (`@msw/cloudflare` `setupNetwork` with a catch-all and the Access JWKS handler); `apiFetch(path, init?, opts?)` from `test/worker/helpers/request.ts`; `testEncKey(): Promise<CryptoKey>` from `test/worker/helpers/seed.ts` | tests |
| plan 01 `@clearbox/core` | errors and pipeline (contracts 4) | error classes take one options object of their readonly fields plus `message?`, `cause?` (`new ProviderAuthError({ provider, reason })`, `new DecisionError({ kind, status?, retryable?, scope?, retryAfterMs?, requestId? })`); `ClearboxError(code, message?, { cause? })`; `TokenUpdate` | `failure.ts`, tests, `tick-tokens.ts` |
| plan 01 `@clearbox/core/testing` | `makeMailMessage(overrides: MailMessageOverrides)` | contracts 10.2 | `ingest.test.ts` |
| plan 02 | `createGmailProvider`, `createGraphProvider`, `refreshGoogleToken`, `refreshMicrosoftToken` | `(deps: ProviderDeps)`, `(deps: GraphProviderDeps)`, `(f, cfg, refreshToken, now): Promise<OAuthTokens>` (reached through plan 03's `makeProvider` and `PROVIDER_OAUTH`) | Task 1 surface test |
| plan 02 Task 3 | `MailProvider.inboxEstimate` (amendment A4) | `inboxEstimate(): Promise<number \| null>` | `scan/tick.ts` (`fetchInboxEstimate`) |
| plan 03 migration 0001 | `accounts.inbox_estimate INTEGER NULL` (amendment A4) | column exists; plan 03's `completeConnect` writes it best effort at connect | `write-plan.ts`, `claim.ts` |

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `app/src/worker/scan/write-plan.ts` | Create (Task 2), extend (Task 5) | Statement toolkit (`Stmt`, `stmt`, `numbered`, `rowsOf`, `sumMeta`, dates) and pure builders for the tick write batch, issues, audit, budget upsert and phase scheduling |
| `app/src/worker/scan/claim.ts` | Create (Task 2) | `CLAIM_SQL`, claim batch, claim parsing, settings parsing, scan-now error mapping |
| `app/src/worker/scan/tick-tokens.ts` | Create (Task 3) | `TickTokenRow`, `tokenAccountOf`, `openTickTokens` (plan 03's `createD1TokenSource` + `refreshFnFor` for a claimed row), `providerTargetOf`, `TokenColumns`, `encryptTokenUpdate` |
| `app/src/worker/scan/token-source.ts`, `app/src/worker/scan/providers.ts` | Consume only (plan 03 owns them) | `createD1TokenSource`, `refreshFnFor`, `makeProvider`, `PROVIDER_OAUTH` |
| `app/src/worker/scan/engine.ts` | Create (Task 3) | `makeDecisionEngine(env, fetch)` |
| `app/src/worker/scan/context.ts` | Create (Task 4) | Context read statements and parsing (fresh page and redecide) |
| `app/src/worker/scan/ingest.ts` | Create (Task 4) | Pure: identity pass, signals, guardrails, priors, state, Decision-1 stage, fusion into `FinalItem`s |
| `app/src/worker/scan/failure.ts` | Create (Task 6) | Error classification to account status and backoff, failure write batch, local error classes |
| `app/src/worker/scan/tick.ts` | Replace plan 03 stub (Task 7), extend (Task 8) | `runTick`, `runTickInternal`, `selectKind`, orchestration |
| `app/src/worker/nightly/purge.ts` | Create (Task 9) | Bounded expired purge and disconnected-account purge |
| `app/src/worker/nightly/nightly.ts` | Replace plan 03 stub (Task 10) | `runNightly`: lease, stale recovery, calibration, purge, housekeeping, budget |
| `app/src/worker/index.ts` | No change (plan 03 Task 5 already routes `CRON_TICK` and `CRON_NIGHTLY`) | verified by `scheduled.test.ts` (Task 11) |
| `app/src/worker/routes/accounts.ts` | Modify (Task 11) | Add `POST /:id/scan` |
| `docs/runbook.md` | Create (Task 12) | Only the section "Checking tick CPU time after deploy"; plan 06 Task 12 replaces the file with the full runbook and keeps this section |
| `app/test/worker/helpers/tick-db.ts` | Create (Task 1) | DB reset, seeding, token decryption helpers |
| `app/test/worker/helpers/provider-mock.ts` | Create (Task 1) | MSW Graph and OAuth token mock, `useNetwork` |
| `app/test/worker/helpers/decision-mock.ts` | Create (Task 1) | MSW Decision-1 mock, `decisionError` builder |
| `app/test/worker/tick/*.test.ts` | Create | Tick unit and integration tests (including `tick-tokens.test.ts`), benchmark |
| `app/test/worker/nightly/*.test.ts` | Create | Nightly tests |
| `app/test/worker/routes/scan.test.ts` | Create | Scan-now route tests |
| `app/test/worker/db-isolation.test.ts` | Modify (Task 10, append one `describe`) | Nightly cross-account `labels` reads must carry `-- isolation-exempt: calibration` |

All test commands run from the repository root; `pnpm --filter @clearbox/app exec` runs them with `app/` as the working directory.

---

### Task 1: Scan test harness and upstream surface check

**Files:**
- Create: `app/test/worker/tick/surface.test.ts`
- Create: `app/test/worker/helpers/tick-db.ts`
- Create: `app/test/worker/helpers/provider-mock.ts`
- Create: `app/test/worker/helpers/decision-mock.ts`
- Test: `app/test/worker/tick/harness.test.ts`

**Interfaces:**
- Consumes: plan 03 `readConfig`, `importEncKey`, `encryptToken`, `decryptToken`, `EncryptedValue`, `bytesFromBlob`, `ApiError`, `withCount`, `chunk`, `logEvent`, `accountsRoutes`, `createD1TokenSource`, `refreshFnFor`, `makeProvider`, `PROVIDER_OAUTH`, test helpers `network` (`test/worker/setup/network.ts`), `apiFetch` (`test/worker/helpers/request.ts`), `testEncKey` (`test/worker/helpers/seed.ts`); plan 01 core exports and `@clearbox/core/testing`; plan 02 provider and OAuth exports.
- Produces (test helpers used by every later task):
  - `tick-db.ts`: `NOW`, `MINUTE`, `DAY`, `ACCOUNT_A`, `ACCOUNT_B`, `OWNER`, `resetDb(): Promise<void>`, `graphDeltaLink(folder, token): string`, `graphCursor(inboxToken, sentToken, watermark): string`, `GMAIL_CURSOR`, `seedTickAccount(s?: SeedAccount): Promise<string>`, `one<T>(sql, ...params): Promise<T | null>`, `all<T>(sql, ...params): Promise<T[]>`, `count(table, where?, ...params): Promise<number>`, `decryptAccountToken(accountId, kind): Promise<string | null>`, `setBudget(date, rowsWritten, dbSizeBytes?)`, `seedMessage(accountId, m: SeedMessage): Promise<number>`, `seedExpiredBulk(accountId, n, expiresAt)`, `seedLabel(accountId, l: SeedLabel)`, `interface AccountSnapshot`, `getAccount(id): Promise<AccountSnapshot>`, `bytes(v): Uint8Array<ArrayBuffer> | null`. Keys come from plan 03's `testEncKey()` (`test/worker/helpers/seed.ts`).
  - `provider-mock.ts`: `FakeMail`, `FakeSent`, `mail(i, overrides?)`, `class ProviderMock` (`inbox`, `sent`, `inboxDelta`, `sentDelta`, `expiredTokens`, `inboxTotal`, `microsoftToken`, `googleToken`, `calls`, `failNext(f)`, `handlers()`), `useNetwork(...groups)`, `useNetworkOpen(...groups)`.
  - `decision-mock.ts`: `class DecisionMock` (`calls`, `status`, `handlers()`), `decisionError(kind, status, retryable, scope): DecisionError`.

- [ ] **Step 1: Write the upstream surface test**

`app/test/worker/tick/surface.test.ts`:

```ts
import * as core from "@clearbox/core";
import type { MailProvider, TokenUpdate } from "@clearbox/core";
import { DecisionError, ProviderAuthError, ProviderConfigError, ProviderRateLimitError, createSubrequestCounter } from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { decryptToken, encryptToken, importEncKey } from "../../../src/worker/crypto/aead.ts";
import type { EncryptedValue } from "../../../src/worker/crypto/aead.ts";
import { chunk, withCount } from "../../../src/worker/db/sql.ts";
import { readConfig } from "../../../src/worker/env.ts";
import type { AppConfig } from "../../../src/worker/env.ts";
import { logEvent } from "../../../src/worker/log.ts";
import { ApiError } from "../../../src/worker/middleware/errors.ts";
import { accountsRoutes } from "../../../src/worker/routes/accounts.ts";
import { PROVIDER_OAUTH, makeProvider } from "../../../src/worker/scan/providers.ts";
import { createD1TokenSource, refreshFnFor } from "../../../src/worker/scan/token-source.ts";
import type { D1TokenSource } from "../../../src/worker/scan/token-source.ts";
import { apiFetch } from "../helpers/request.ts";
import { network } from "../setup/network.ts";

const CORE_FUNCTIONS = [
  "extractSignals", "evaluateGuardrails", "selectPrior", "priorKeyForSender", "priorKeyForDomain",
  "buildDecisionState", "decisionSeed", "decideAll", "fuse", "parsePolicy", "calibrateTauDelete",
  "createSubrequestCounter", "countingFetch", "backoffMs", "createGmailProvider", "createGraphProvider",
  "refreshGoogleToken", "refreshMicrosoftToken",
] as const;

describe("upstream surfaces used by the scan pipeline", () => {
  it("core exports every function the pipeline calls", () => {
    const exported = core as unknown as Record<string, unknown>;
    for (const name of CORE_FUNCTIONS) expect(typeof exported[name], name).toBe("function");
    expect(typeof makeMailMessage).toBe("function");
  });

  it("plan 01 to 03 signatures match what this plan calls (checked by pnpm typecheck)", () => {
    const key = {} as CryptoKey;
    const ctx = { accountId: "acc_0000000000000000", kind: "refresh" as const, keyVersion: 1 };
    const value: EncryptedValue = { ciphertext: new Uint8Array(16), iv: new Uint8Array(12) };
    const tokens = { getAccessToken: async () => "t", forceRefresh: async () => "t" };
    expectTypeOf(readConfig).returns.toEqualTypeOf<{ ok: true; config: AppConfig } | { ok: false; invalid: string[] }>();
    expectTypeOf(importEncKey).toBeCallableWith(new Uint8Array(32));
    expectTypeOf(importEncKey).returns.resolves.toEqualTypeOf<CryptoKey>();
    expectTypeOf(encryptToken).toBeCallableWith(key, "token", ctx);
    expectTypeOf(encryptToken).returns.resolves.toEqualTypeOf<EncryptedValue>();
    expectTypeOf(decryptToken).toBeCallableWith(key, value, ctx);
    expectTypeOf(decryptToken).returns.resolves.toEqualTypeOf<string>();
    expectTypeOf(withCount<number>).toBeCallableWith(createSubrequestCounter(1), async () => 1);
    expectTypeOf(chunk<number>).toBeCallableWith([1, 2, 3], 2);
    expectTypeOf(chunk<number>).returns.toEqualTypeOf<number[][]>();
    expectTypeOf(logEvent).toBeCallableWith("tick.idle", { tickId: "t", trigger: "cron" });
    expectTypeOf(ApiError).toBeConstructibleWith(409, "account_busy", "busy", { retryAt: "2026-10-15T12:00:00.000Z" });
    expectTypeOf<ApiError>().toHaveProperty("status");
    expectTypeOf<ApiError>().toHaveProperty("code");
    expectTypeOf<D1TokenSource["update"]>().toEqualTypeOf<TokenUpdate | null>();
    expectTypeOf(createD1TokenSource).returns.toEqualTypeOf<D1TokenSource>();
    expectTypeOf(refreshFnFor).toBeCallableWith(PROVIDER_OAUTH, {} as AppConfig, "gmail", fetch, () => 0, "");
    expectTypeOf(makeProvider).toBeCallableWith({ provider: "outlook", archiveFolderId: null }, { fetch, tokens, now: () => 0 });
    expectTypeOf(accountsRoutes.post).toBeFunction();
    expectTypeOf(network.use).toBeFunction();
    expectTypeOf(apiFetch).toBeCallableWith("/api/accounts", { method: "POST" });
    expectTypeOf(ProviderAuthError).toBeConstructibleWith({ provider: "gmail", reason: "invalid_grant" });
    expectTypeOf(ProviderConfigError).toBeConstructibleWith({ provider: "outlook", reason: "invalid_client" });
    expectTypeOf(ProviderRateLimitError).toBeConstructibleWith({ provider: "outlook", retryAfterMs: 1000 });
    expectTypeOf(DecisionError).toBeConstructibleWith({
      kind: "server", status: 503, retryable: true, scope: "item", retryAfterMs: null, requestId: null,
    });
    expectTypeOf(core.ClearboxError).toBeConstructibleWith("decision_outage", "message");
    expectTypeOf(core.ProviderUnavailableError).toBeConstructibleWith({ provider: "outlook", retryAfterMs: null, cause: new Error("x") });
    expectTypeOf<MailProvider["inboxEstimate"]>().toEqualTypeOf<() => Promise<number | null>>();
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 90)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the surface test and the typecheck**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/surface.test.ts && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: `Test Files  1 passed (1)` and a clean `tsc -b`. Every signature in this file was reconciled against plans 01 to 03 (see "Upstream surfaces"). A typecheck error here means an upstream plan changed after reconciliation: stop and report it to the lead instead of adapting call sites.

- [ ] **Step 3: Write `tick-db.ts`**

`app/test/worker/helpers/tick-db.ts`:

```ts
import type { ProviderKind } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { decryptToken, encryptToken } from "../../../src/worker/crypto/aead.ts";
import { bytesFromBlob } from "../../../src/worker/crypto/base64.ts";
import { testEncKey } from "./seed.ts";

export const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const ACCOUNT_A = "acc_00000000000000a1";
export const ACCOUNT_B = "acc_00000000000000b2";
export const OWNER = "owner@example.test";

const TABLES = [
  "suggestions", "messages", "labels", "sender_priors", "senders", "correspondents", "sent_threads",
  "action_batches", "audit_log", "budget", "leases", "accounts", "settings",
] as const;

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('tau_delete', '0.8', 0), ('policy_version', '1', 0)",
    ),
  ]);
}

export function graphDeltaLink(folder: "inbox" | "sentitems", token: string): string {
  return `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
}

export function graphCursor(inboxToken: string, sentToken: string, watermark: number): string {
  return JSON.stringify({
    v: 1,
    inboxDeltaLink: graphDeltaLink("inbox", inboxToken),
    sentDeltaLink: graphDeltaLink("sentitems", sentToken),
    watermark: new Date(watermark).toISOString(),
  });
}

export const GMAIL_CURSOR = JSON.stringify({ v: 1, historyId: "1000", catchupAfter: null, catchupPageToken: null });

export interface SeedAccount {
  id?: string;
  provider?: ProviderKind;
  email?: string;
  status?: "active" | "needs_reauth" | "config_error" | "disconnected";
  paused?: boolean;
  phase?: "sent_backfill" | "inbox_backfill" | "incremental";
  pageSize?: number;
  accessToken?: string | null;
  accessExpiresAt?: number;
  refreshToken?: string;
  sentCursor?: string | null;
  sentScanned?: number;
  backfillCursor?: string | null;
  incrementalCursor?: string;
  lastIncrementalAt?: number | null;
  lastTickAt?: number | null;
  nextTickAt?: number;
  backoffUntil?: number | null;
  attempts?: number;
  watermark?: number | null;
  aliases?: string[];
  tickStartedAt?: number | null;
  tickFinishedAt?: number | null;
}

/** D1 BLOB column to bytes (plan 03's bytesFromBlob). */
export function bytes(v: unknown): Uint8Array<ArrayBuffer> | null {
  return bytesFromBlob(v);
}

export async function seedTickAccount(s: SeedAccount = {}): Promise<string> {
  const id = s.id ?? ACCOUNT_A;
  const provider = s.provider ?? "outlook";
  const disconnected = s.status === "disconnected";
  const key = await testEncKey();
  const refresh = disconnected
    ? null
    : await encryptToken(key, s.refreshToken ?? "refresh-1", { accountId: id, kind: "refresh", keyVersion: 1 });
  const accessPlain = s.accessToken === undefined ? "access-1" : s.accessToken;
  const access =
    disconnected || accessPlain === null
      ? null
      : await encryptToken(key, accessPlain, { accountId: id, kind: "access", keyVersion: 1 });
  const cursor = s.incrementalCursor ?? (provider === "gmail" ? GMAIL_CURSOR : graphCursor("inbox-1", "sent-1", NOW - DAY));
  const values: unknown[] = [
    id, provider, s.email ?? OWNER, s.email ?? OWNER, s.status ?? "active", s.paused ? 1 : 0, 1,
    refresh?.ciphertext ?? null, refresh?.iv ?? null, access?.ciphertext ?? null, access?.iv ?? null,
    access ? (s.accessExpiresAt ?? NOW + 60 * MINUTE) : null,
    provider === "gmail" ? "https://www.googleapis.com/auth/gmail.modify" : "Mail.ReadWrite User.Read offline_access",
    JSON.stringify(s.aliases ?? []), provider === "outlook" ? "archive-folder-1" : null,
    s.phase ?? "inbox_backfill", s.sentCursor ?? null, s.sentScanned ?? 0, s.backfillCursor ?? null, 0, cursor,
    s.lastIncrementalAt === undefined ? NOW - MINUTE : s.lastIncrementalAt, s.watermark ?? null, s.pageSize ?? 25,
    s.attempts ?? 0, s.backoffUntil ?? null, s.nextTickAt ?? 0, s.lastTickAt ?? null,
    s.tickStartedAt ?? null, s.tickFinishedAt ?? null, NOW - DAY, NOW - DAY,
  ];
  const placeholders = values.map((_, i) => `?${i + 1}`).join(", ");
  await env.DB.prepare(
    `INSERT INTO accounts (id, provider, email, provider_user_id, status, paused, key_version,
       enc_refresh_token, refresh_iv, enc_access_token, access_iv, access_expires_at, granted_scopes,
       owner_aliases_json, archive_folder_id, phase, sent_cursor, sent_scanned, backfill_cursor, backfill_done,
       incremental_cursor, last_incremental_at, watermark_received_at, page_size, attempts, backoff_until,
       next_tick_at, last_tick_at, tick_started_at, tick_finished_at, created_at, updated_at)
     VALUES (${placeholders})`,
  )
    .bind(...values)
    .run();
  return id;
}

export async function one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...params).first<T>();
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...params).run<T>();
  return r.results;
}

export async function count(table: string, where = "1 = 1", ...params: unknown[]): Promise<number> {
  const r = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params);
  return r?.n ?? 0;
}

export interface AccountSnapshot {
  id: string;
  status: string;
  status_reason: string | null;
  phase: string;
  page_size: number;
  attempts: number;
  backoff_until: number | null;
  next_tick_at: number;
  last_tick_at: number | null;
  last_error: string | null;
  backfill_cursor: string | null;
  backfill_done: number;
  sent_cursor: string | null;
  sent_scanned: number;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
  messages_ingested: number;
  inbox_estimate: number | null;
  updated_at: number;
}

export async function getAccount(id: string): Promise<AccountSnapshot> {
  const row = await one<AccountSnapshot>("SELECT * FROM accounts WHERE id = ?1", id);
  if (row === null) throw new Error(`account ${id} missing`);
  return row;
}

export async function decryptAccountToken(accountId: string, kind: "refresh" | "access"): Promise<string | null> {
  const row = await one<Record<string, unknown>>(
    "SELECT key_version, enc_refresh_token, refresh_iv, enc_access_token, access_iv FROM accounts WHERE id = ?1",
    accountId,
  );
  if (row === null) return null;
  const ct = bytes(kind === "refresh" ? row.enc_refresh_token : row.enc_access_token);
  const iv = bytes(kind === "refresh" ? row.refresh_iv : row.access_iv);
  if (ct === null || iv === null) return null;
  const key = await testEncKey();
  return decryptToken(key, { ciphertext: ct, iv }, { accountId, kind, keyVersion: Number(row.key_version) });
}

export async function setBudget(date: string, rowsWritten: number, dbSizeBytes = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO budget (date, rows_written, db_size_bytes, updated_at) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (date) DO UPDATE SET rows_written = excluded.rows_written, db_size_bytes = excluded.db_size_bytes`,
  )
    .bind(date, rowsWritten, dbSizeBytes)
    .run();
}

export interface SeedMessage {
  providerId: string;
  sender?: string;
  domain?: string;
  status?: "awaiting_model" | "pending" | "approved" | "executed" | "failed" | "dismissed" | "undone";
  action?: "delete" | "archive" | "keep" | "unsure" | null;
  finalAction?: "delete" | "archive" | "keep" | null;
  receivedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  decisionAttempts?: number;
  retryAfter?: number | null;
}

export async function seedMessage(accountId: string, m: SeedMessage): Promise<number> {
  const sender = m.sender ?? "news@shop.example";
  const domain = m.domain ?? "shop.example";
  const created = m.createdAt ?? NOW - DAY;
  const msg = await one<{ id: number }>(
    `INSERT INTO messages (account_id, provider_msg_id, sender, sender_domain, subject, snippet, received_at,
       is_read, signals_json, created_at)
     VALUES (?1, ?2, ?3, ?4, 'Seeded subject', 'Seeded snippet', ?5, 0, '{}', ?6) RETURNING id`,
    accountId, m.providerId, sender, domain, m.receivedAt ?? NOW - 10 * DAY, created,
  );
  if (msg === null) throw new Error("message insert failed");
  const status = m.status ?? "pending";
  const action = m.action === undefined ? (status === "awaiting_model" ? null : "delete") : m.action;
  const finalAction = m.finalAction ?? (status === "executed" || status === "undone" ? "delete" : null);
  await env.DB.prepare(
    `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, ceiling,
       policy_version, decision_attempts, retry_after, final_action, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'delete', 1, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      msg.id, accountId, sender, domain, status, action, action === null ? null : 0.9,
      m.decisionAttempts ?? 0, m.retryAfter ?? null, finalAction, created, m.updatedAt ?? created,
      m.expiresAt ?? NOW + 30 * DAY,
    )
    .run();
  return msg.id;
}

export async function seedExpiredBulk(accountId: string, n: number, expiresAt: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?2)
       INSERT INTO messages (account_id, provider_msg_id, sender, sender_domain, subject, received_at, is_read,
         signals_json, created_at)
       SELECT ?1, 'bulk-' || i, 'bulk@shop.example', 'shop.example', 'Bulk', ?3, 0, '{}', ?3 FROM seq`,
    ).bind(accountId, n, NOW - 40 * DAY),
    env.DB.prepare(
      `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, ceiling,
         policy_version, created_at, updated_at, expires_at)
       SELECT id, account_id, sender, sender_domain, 'pending', 'delete', 'delete', 1, ?2, ?2, ?3
       FROM messages WHERE account_id = ?1 AND provider_msg_id LIKE 'bulk-%'`,
    ).bind(accountId, NOW - 40 * DAY, expiresAt),
  ]);
}

export interface SeedLabel {
  sender?: string;
  domain?: string;
  subject?: string | null;
  pDelete: number | null;
  margin: number | null;
  ownerAction: "delete" | "archive" | "keep";
  suggested?: "delete" | "archive" | "keep" | "unsure";
  ceiling?: "delete" | "archive" | "keep";
}

export async function seedLabel(accountId: string, l: SeedLabel): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action,
       owner_action, source, p_delete, margin, ceiling, policy_version, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 'approve', ?7, ?8, ?9, 1, ?10, ?10)`,
  )
    .bind(
      accountId, l.sender ?? "news@shop.example", l.domain ?? "shop.example", l.subject ?? "Label subject",
      l.suggested ?? "delete", l.ownerAction, l.pDelete, l.margin, l.ceiling ?? "delete", NOW - DAY,
    )
    .run();
}
```

- [ ] **Step 4: Write `provider-mock.ts`**

`app/test/worker/helpers/provider-mock.ts`:

```ts
import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";
import { network } from "../setup/network.ts";
import { DAY, MINUTE, NOW, OWNER, graphDeltaLink } from "./tick-db.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface FakeMail {
  id: string;
  conversationId: string;
  receivedAt: number;
  from: string;
  fromName?: string;
  to?: string[];
  subject?: string;
  preview?: string;
  isRead?: boolean;
  listUnsubscribe?: boolean;
  hasAttachments?: boolean;
  flagged?: boolean;
}

export interface FakeSent {
  conversationId: string;
  to: string[];
  sentAt: number;
}

export interface DeltaPage {
  added: FakeMail[];
  removed: string[];
  next: string;
}

export interface SentDeltaPage {
  items: FakeSent[];
  next: string;
}

export interface InjectedFailure {
  method: string;
  pathIncludes: string;
  status: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  times: number;
}

export interface TokenReply {
  status: number;
  body: Record<string, string | number>;
}

/** Message i: newest first by ascending i, five days old or more, four senders on two domains. */
export function mail(i: number, overrides: Partial<FakeMail> = {}): FakeMail {
  return {
    id: `msg-${String(i).padStart(3, "0")}`,
    conversationId: `conv-${i}`,
    receivedAt: NOW - 5 * DAY - i * MINUTE,
    from: `sender${i % 4}@shop${i % 2}.example`,
    fromName: `Shop ${i % 4}`,
    subject: `Weekly deals ${i}`,
    preview: `Deals of the week number ${i}`,
    ...overrides,
  };
}

function headersOf(m: FakeMail): { name: string; value: string }[] {
  const domain = m.from.split("@")[1] ?? "example.net";
  const list = [
    {
      name: "Authentication-Results",
      value: `spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
    },
  ];
  if (m.listUnsubscribe) {
    list.push(
      { name: "List-Unsubscribe", value: `<https://${domain}/unsubscribe>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    );
  }
  return list;
}

function graphMessage(m: FakeMail, withHeaders: boolean): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    internetMessageId: `<${m.id}@example.net>`,
    receivedDateTime: new Date(m.receivedAt).toISOString(),
    subject: m.subject ?? "Hello",
    bodyPreview: m.preview ?? "Preview text",
    isRead: m.isRead ?? false,
    importance: "normal",
    hasAttachments: m.hasAttachments ?? false,
    inferenceClassification: "other",
    flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
    from: { emailAddress: { name: m.fromName ?? "Sender", address: m.from } },
    toRecipients: (m.to ?? [OWNER]).map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    webLink: `https://outlook.example.test/owa/?ItemID=${m.id}`,
    ...(withHeaders ? { internetMessageHeaders: headersOf(m) } : {}),
  };
}

function sentMessage(s: FakeSent, index: number): Record<string, unknown> {
  return {
    id: `sent-${index}`,
    conversationId: s.conversationId,
    toRecipients: s.to.map((address) => ({ emailAddress: { address } })),
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: new Date(s.sentAt).toISOString(),
    receivedDateTime: new Date(s.sentAt).toISOString(),
  };
}

export class ProviderMock {
  inbox: FakeMail[] = [];
  sent: FakeSent[] = [];
  readonly inboxDelta = new Map<string, DeltaPage>();
  readonly sentDelta = new Map<string, SentDeltaPage>();
  readonly expiredTokens = new Set<string>();
  /** Inbox total reported by the provider (amendment A4); null = number of fake inbox messages. */
  inboxTotal: number | null = null;
  microsoftToken: TokenReply = {
    status: 200,
    body: {
      token_type: "Bearer",
      scope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read offline_access",
      expires_in: 3599,
      access_token: "ms-access-2",
      refresh_token: "ms-refresh-2",
    },
  };
  googleToken: TokenReply = {
    status: 200,
    body: {
      access_token: "g-access-2",
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    },
  };
  readonly calls: string[] = [];
  readonly failures: InjectedFailure[] = [];

  failNext(f: Omit<InjectedFailure, "times"> & { times?: number }): void {
    this.failures.push({ times: 1, ...f });
  }

  handlers(): HttpHandler[] {
    return [
      http.all("*", ({ request }) => {
        const url = new URL(request.url);
        this.calls.push(`${request.method} ${url.origin}${url.pathname}`);
        const failure = this.failures.find(
          (f) => f.times > 0 && f.method === request.method && url.pathname.includes(f.pathIncludes),
        );
        if (failure === undefined) return undefined;
        failure.times -= 1;
        return HttpResponse.json(failure.body ?? { error: { code: "Injected", message: "injected" } }, {
          status: failure.status,
          headers: failure.headers ?? {},
        });
      }),
      http.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", () =>
        HttpResponse.json(this.microsoftToken.body, { status: this.microsoftToken.status }),
      ),
      http.post("https://oauth2.googleapis.com/token", () =>
        HttpResponse.json(this.googleToken.body, { status: this.googleToken.status }),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox`, () =>
        HttpResponse.json({ id: "inbox-folder", displayName: "Inbox", totalItemCount: this.inboxTotal ?? this.inbox.length }),
      ),
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX", () =>
        HttpResponse.json({ id: "INBOX", name: "INBOX", messagesTotal: this.inboxTotal ?? this.inbox.length }),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, ({ request }) =>
        this.inboxDeltaReply(new URL(request.url)),
      ),
      http.get(`${GRAPH}/me/mailFolders/sentitems/messages/delta`, ({ request }) =>
        this.sentDeltaReply(new URL(request.url)),
      ),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages`, ({ request }) => this.inboxListReply(new URL(request.url))),
      http.get(`${GRAPH}/me/mailFolders/sentitems/messages`, ({ request }) =>
        this.sentListReply(new URL(request.url)),
      ),
      http.post(/^https:\/\/graph\.microsoft\.com\/v1\.0\/\$batch$/, async ({ request }) =>
        this.batchReply((await request.json()) as { requests: { id: string; method: string; url: string }[] }),
      ),
    ];
  }

  private inboxListReply(url: URL): Response {
    const top = Number(url.searchParams.get("$top") ?? "10");
    const filter = url.searchParams.get("$filter") ?? "";
    const le = /receivedDateTime le '?([0-9T:.\-Z]+)'?/.exec(filter)?.[1];
    const before = le === undefined ? Number.POSITIVE_INFINITY : Date.parse(le);
    const sorted = [...this.inbox].sort((a, b) => b.receivedAt - a.receivedAt).filter((m) => m.receivedAt <= before);
    const page = sorted.slice(0, top);
    return HttpResponse.json({
      value: page.map((m) => graphMessage(m, true)),
      ...(sorted.length > top ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages?$skip=${top}` } : {}),
    });
  }

  private sentListReply(url: URL): Response {
    const top = Number(url.searchParams.get("$top") ?? "10");
    const skip = Number(url.searchParams.get("$skip") ?? "0");
    const sorted = [...this.sent].sort((a, b) => b.sentAt - a.sentAt);
    const page = sorted.slice(skip, skip + top);
    const more = skip + top < sorted.length;
    return HttpResponse.json({
      value: page.map((s, i) => sentMessage(s, skip + i)),
      ...(more
        ? { "@odata.nextLink": `${GRAPH}/me/mailFolders/sentitems/messages?$top=${top}&$skip=${skip + top}` }
        : {}),
    });
  }

  private inboxDeltaReply(url: URL): Response {
    const token = url.searchParams.get("$deltatoken");
    if (token === null) {
      return HttpResponse.json({ value: [], "@odata.deltaLink": graphDeltaLink("inbox", "resync-inbox") });
    }
    if (this.expiredTokens.has(token)) {
      return HttpResponse.json(
        { error: { code: "syncStateNotFound", message: "The sync state is not found." } },
        { status: 410 },
      );
    }
    const page = this.inboxDelta.get(token) ?? { added: [], removed: [], next: token };
    return HttpResponse.json({
      value: [
        ...page.added.map((m) => graphMessage(m, false)),
        ...page.removed.map((id) => ({ id, "@removed": { reason: "deleted" } })),
      ],
      "@odata.deltaLink": graphDeltaLink("inbox", page.next),
    });
  }

  private sentDeltaReply(url: URL): Response {
    const token = url.searchParams.get("$deltatoken");
    if (token === null) {
      return HttpResponse.json({ value: [], "@odata.deltaLink": graphDeltaLink("sentitems", "resync-sent") });
    }
    if (this.expiredTokens.has(token)) {
      return HttpResponse.json(
        { error: { code: "syncStateNotFound", message: "The sync state is not found." } },
        { status: 410 },
      );
    }
    const page = this.sentDelta.get(token) ?? { items: [], next: token };
    return HttpResponse.json({
      value: page.items.map((s, i) => sentMessage(s, i)),
      "@odata.deltaLink": graphDeltaLink("sentitems", page.next),
    });
  }

  private batchReply(body: { requests: { id: string; method: string; url: string }[] }): Response {
    const known = [...this.inbox, ...[...this.inboxDelta.values()].flatMap((p) => p.added)];
    const responses = body.requests.map((r) => {
      const match = /\/me\/messages\/([^?/]+)/.exec(r.url);
      const id = match?.[1] === undefined ? "" : decodeURIComponent(match[1]);
      const found = known.find((m) => m.id === id);
      return found === undefined || r.method !== "GET"
        ? { id: r.id, status: 404, body: { error: { code: "ErrorItemNotFound", message: "Not found" } } }
        : {
            id: r.id,
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { id: found.id, internetMessageHeaders: headersOf(found) },
          };
    });
    return HttpResponse.json({ responses });
  }
}

const unhandled = http.all("*", ({ request }) => {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
});

/** Installs handler groups in order, followed by a catch-all that fails unmocked requests. */
export function useNetwork(...groups: HttpHandler[][]): void {
  network.use(...groups.flat(), unhandled);
}

/** Same without the catch-all, for route tests whose Access JWKS mock is installed by plan 03 helpers. */
export function useNetworkOpen(...groups: HttpHandler[][]): void {
  network.use(...groups.flat());
}
```

- [ ] **Step 5: Write `decision-mock.ts`**

`app/test/worker/helpers/decision-mock.ts`:

```ts
import { DecisionError } from "@clearbox/core";
import type { DecisionErrorKind } from "@clearbox/core";
import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";

export const DECISION_URL = "https://decision.example.test/providers/microsoft/v1/systemone";

const OK_BODY = {
  model: "microsoft-decision-1",
  answers: {
    action: { type: "choice", choice: "delete", probabilities: { delete: 0.9, archive: 0.04, keep: 0.03, unsure: 0.03 } },
    importance: { type: "score", score: 0.5 },
    is_record: { type: "noul", noul: 0.05 },
    is_expired: { type: "noul", noul: 0.1 },
    is_from_human: { type: "noul", noul: 0.05 },
  },
  usage: { input_tokens: 420, output_tokens: 5 },
};

export class DecisionMock {
  calls = 0;
  status = 200;

  handlers(): HttpHandler[] {
    return [
      http.post(DECISION_URL, () => {
        this.calls += 1;
        if (this.status !== 200) {
          return HttpResponse.json({ error: { code: "Injected", message: "injected" } }, { status: this.status });
        }
        return HttpResponse.json(OK_BODY, { headers: { "apim-request-id": `req-${this.calls}` } });
      }),
    ];
  }
}

export function decisionError(
  kind: DecisionErrorKind,
  status: number | null,
  retryable: boolean,
  scope: "config" | "item",
): DecisionError {
  return new DecisionError({ kind, status, retryable, scope, retryAfterMs: null, requestId: null });
}
```

- [ ] **Step 6: Write the harness smoke test**

`app/test/worker/tick/harness.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, count, decryptAccountToken, getAccount, resetDb, seedMessage, seedTickAccount } from "../helpers/tick-db.ts";

describe("scan test harness", () => {
  beforeEach(resetDb);

  it("seeds an account with encrypted tokens that decrypt back", async () => {
    await seedTickAccount({ refreshToken: "refresh-x", accessToken: "access-x" });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("refresh-x");
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("access-x");
    expect((await getAccount(ACCOUNT_A)).phase).toBe("inbox_backfill");
  });

  it("seeds messages with suggestions", async () => {
    await seedTickAccount();
    await seedMessage(ACCOUNT_A, { providerId: "p-1" });
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(1);
  });

  it("serves a Graph inbox page newest first", async () => {
    const mock = new ProviderMock();
    mock.inbox = [mail(2), mail(0), mail(1)];
    useNetwork(mock.handlers());
    const res = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=2");
    const body = (await res.json()) as { value: { id: string }[] };
    expect(body.value.map((m) => m.id)).toEqual(["msg-000", "msg-001"]);
    expect(mock.calls).toEqual(["GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"]);
  });
});
```

- [ ] **Step 7: Run the harness tests**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/harness.test.ts`
Expected: `Tests  3 passed (3)`.

- [ ] **Step 8: Commit**

```bash
git add app/test/worker/tick/surface.test.ts app/test/worker/tick/harness.test.ts app/test/worker/helpers/tick-db.ts app/test/worker/helpers/provider-mock.ts app/test/worker/helpers/decision-mock.ts
git commit -m "test(scan): add tick test harness and upstream surface check"
```

---

### Task 2: Statement toolkit and account claim

**Files:**
- Create: `app/src/worker/scan/write-plan.ts` (toolkit part; Task 5 extends it)
- Create: `app/src/worker/scan/claim.ts`
- Test: `app/test/worker/tick/claim.test.ts`

**Interfaces:**
- Consumes: `LEASE_TTL_MS`, `DEFAULT_POLICY`, `parsePolicy`, `TAU_DELETE_*` (core); `ApiError` (plan 03); `AppIssue`, `AccountPhase` (`src/shared/api.ts`).
- Produces:
  - `write-plan.ts`: `type SqlValue = string | number | null | Uint8Array`; `interface Stmt { sql: string; params: SqlValue[] }`; `interface BatchResult { results?: unknown[]; meta?: { changes?: number; rows_read?: number; rows_written?: number; size_after?: number } }`; `IN_LIST_MAX = 90`; `stmt(sql, ...params): Stmt`; `numbered(start, count): string`; `rowsOf<T>(r: BatchResult | undefined): T[]`; `sumMeta(results, field): number`; `lastSizeAfter(results): number`; re-exports of plan 03's `utcDate(ms): string`, `nextUtcMidnight(ms): number` and `toIso` as `isoOf(ms): string` (from `db/sql.ts`).
  - `claim.ts`: `CLAIM_SQL`; `interface ClaimParams { tickId; now; accountId: string | null; force: boolean; today: string; stopRows: number }`; `claimStatements(p): Stmt[]` (7 statements, order fixed); `interface TickAccountRow` (accounts row); `interface BudgetRow`; `interface LeaseRow`; `interface SettingRow`; `interface ClaimResult { claimedAccountId; account; settings; budget; awaitingDue; lease; rowsWritten; rowsRead }`; `parseClaim(results): ClaimResult`; `interface TickSettings { policy; policyVersion; tauDelete; issues }`; `parseTickSettings(rows): TickSettings`; `scanNowError(c, now, stopRows): ApiError`.

- [ ] **Step 1: Write the failing claim tests**

`app/test/worker/tick/claim.test.ts`:

```ts
import { INGEST_STOP_ROWS, LEASE_TTL_MS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { claimStatements, parseClaim, parseTickSettings, scanNowError } from "../../../src/worker/scan/claim.ts";
import type { ClaimParams } from "../../../src/worker/scan/claim.ts";
import { nextUtcMidnight, utcDate } from "../../../src/worker/scan/write-plan.ts";
import {
  ACCOUNT_A, ACCOUNT_B, MINUTE, NOW, getAccount, one, resetDb, seedMessage, seedTickAccount, setBudget,
} from "../helpers/tick-db.ts";

async function claim(p: Partial<ClaimParams> = {}) {
  const params: ClaimParams = {
    tickId: crypto.randomUUID(), now: NOW, accountId: null, force: false, today: utcDate(NOW),
    stopRows: INGEST_STOP_ROWS, ...p,
  };
  const res = await env.DB.batch(claimStatements(params).map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  return { params, claim: parseClaim(res) };
}

describe("claimStatements", () => {
  beforeEach(resetDb);

  it("claims the due account and loads account, settings and budget", async () => {
    await seedTickAccount();
    await setBudget(utcDate(NOW), 10);
    const { params, claim: c } = await claim();
    expect(c.claimedAccountId).toBe(ACCOUNT_A);
    expect(c.account?.id).toBe(ACCOUNT_A);
    expect(c.settings.map((s) => s.key).sort()).toEqual(["policy_version", "tau_delete"]);
    expect(c.budget?.rows_written).toBe(10);
    const lease = await one<{ holder: string; expires_at: number }>("SELECT * FROM leases WHERE name = ?1", `account:${ACCOUNT_A}`);
    expect(lease).toMatchObject({ holder: params.tickId, expires_at: NOW + LEASE_TTL_MS });
    expect((await getAccount(ACCOUNT_A)).page_size).toBe(25);
    expect(c.rowsWritten).toBeGreaterThan(0);
  });

  it("does not claim while an unexpired lease is held, and reclaims after expiry or release", async () => {
    await seedTickAccount();
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_A);
    expect((await claim({ now: NOW + MINUTE })).claim.claimedAccountId).toBeNull();
    expect((await claim({ now: NOW + LEASE_TTL_MS })).claim.claimedAccountId).toBe(ACCOUNT_A);
    await env.DB.prepare("UPDATE leases SET released_at = ?1").bind(NOW + LEASE_TTL_MS + 1).run();
    expect((await claim({ now: NOW + LEASE_TTL_MS + 2 })).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("is atomic under two concurrent claims", async () => {
    await seedTickAccount();
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a.claim.claimedAccountId, b.claim.claimedAccountId].filter((x) => x !== null)).toEqual([ACCOUNT_A]);
  });

  it("orders by last_tick_at with never-ticked accounts first", async () => {
    await seedTickAccount({ id: ACCOUNT_A, lastTickAt: NOW - MINUTE });
    await seedTickAccount({ id: ACCOUNT_B, email: "second@example.test", lastTickAt: null });
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_B);
    expect((await claim()).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("skips paused, inactive, backing-off and not-yet-due accounts; force ignores only next_tick_at", async () => {
    await seedTickAccount({ id: ACCOUNT_A, paused: true });
    await seedTickAccount({ id: ACCOUNT_B, email: "b@example.test", nextTickAt: NOW + MINUTE });
    expect((await claim()).claim.claimedAccountId).toBeNull();
    expect((await claim({ accountId: ACCOUNT_B, force: true })).claim.claimedAccountId).toBe(ACCOUNT_B);
    await resetDb();
    await seedTickAccount({ status: "needs_reauth" });
    expect((await claim({ accountId: ACCOUNT_A, force: true })).claim.claimedAccountId).toBeNull();
    await resetDb();
    await seedTickAccount({ backoffUntil: NOW + MINUTE });
    expect((await claim({ accountId: ACCOUNT_A, force: true })).claim.claimedAccountId).toBeNull();
  });

  it("stops claiming at the ingest write gate", async () => {
    await seedTickAccount();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    const gated = await claim();
    expect(gated.claim.claimedAccountId).toBeNull();
    expect(gated.claim.rowsWritten).toBe(0);
    expect((await claim({ stopRows: Number.MAX_SAFE_INTEGER })).claim.claimedAccountId).toBe(ACCOUNT_A);
  });

  it("halves page_size when the previous tick never finished", async () => {
    await seedTickAccount({ tickStartedAt: NOW - 10 * MINUTE, tickFinishedAt: NOW - 20 * MINUTE });
    await claim();
    const a = await getAccount(ACCOUNT_A);
    expect(a.page_size).toBe(12);
  });

  it("counts only due awaiting_model suggestions", async () => {
    await seedTickAccount();
    await seedMessage(ACCOUNT_A, { providerId: "due", status: "awaiting_model", retryAfter: NOW - 1 });
    await seedMessage(ACCOUNT_A, { providerId: "later", status: "awaiting_model", retryAfter: NOW + MINUTE });
    expect((await claim()).claim.awaitingDue).toBe(1);
  });
});

describe("scanNowError", () => {
  beforeEach(resetDb);

  it("maps every pre-claim failure to the 7.5 HTTP errors", async () => {
    let c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({ status: 404, code: "not_found" });

    await seedTickAccount({ paused: true });
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    expect(scanNowError(c, NOW, INGEST_STOP_ROWS)).toMatchObject({ status: 409, code: "account_inactive" });

    await env.DB.prepare("UPDATE accounts SET paused = 0").run();
    await claim({ accountId: ACCOUNT_A, force: true });
    c = (await claim({ accountId: ACCOUNT_A, force: true, now: NOW + MINUTE })).claim;
    expect(scanNowError(c, NOW + MINUTE, INGEST_STOP_ROWS)).toMatchObject({ status: 409, code: "account_busy" });

    await env.DB.prepare("DELETE FROM leases").run();
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    c = (await claim({ accountId: ACCOUNT_A, force: true })).claim;
    const err = scanNowError(c, NOW, INGEST_STOP_ROWS);
    expect(err).toMatchObject({ status: 429, code: "budget_exhausted" });
    expect(nextUtcMidnight(NOW)).toBe(Date.UTC(2026, 9, 16));
  });
});

describe("parseTickSettings", () => {
  it("falls back to defaults and clamps tau_delete", () => {
    const s = parseTickSettings([
      { key: "tau_delete", value: "1.5" },
      { key: "policy", value: "{\"not\":\"a policy\"}" },
      { key: "issues", value: "[{\"code\":\"storage_near_limit\",\"since\":\"2026-10-15T00:00:00.000Z\",\"accountId\":null}]" },
    ]);
    expect(s.tauDelete).toBe(0.99);
    expect(s.policy.minAgeDays).toBe(3);
    expect(s.policyVersion).toBe(1);
    expect(s.issues).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/claim.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/scan/claim.ts` (module does not exist).

- [ ] **Step 3: Write the statement toolkit**

`app/src/worker/scan/write-plan.ts`:

```ts
export type SqlValue = string | number | null | Uint8Array;

/** A D1 statement as plain data; `tick.ts` binds it with `db.prepare(sql).bind(...params)`. */
export interface Stmt {
  sql: string;
  params: SqlValue[];
}

/** Structural subset of D1Result, so builders and parsers stay free of Workers types. */
export interface BatchResult {
  results?: unknown[];
  meta?: { changes?: number; rows_read?: number; rows_written?: number; size_after?: number };
}

/** Values per IN list; keeps every statement under D1's 100 bound parameters. */
export const IN_LIST_MAX = 90;

export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

/** "?start, ?start+1, ..." for IN lists that follow fixed leading parameters. */
export function numbered(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

export function rowsOf<T>(r: BatchResult | undefined): T[] {
  return (r?.results ?? []) as T[];
}

export function sumMeta(results: readonly BatchResult[], field: "changes" | "rows_read" | "rows_written"): number {
  let total = 0;
  for (const r of results) total += r.meta?.[field] ?? 0;
  return total;
}

export function lastSizeAfter(results: readonly BatchResult[]): number {
  for (let i = results.length - 1; i >= 0; i--) {
    const size = results[i]?.meta?.size_after;
    if (typeof size === "number" && size > 0) return size;
  }
  return 0;
}

// Date helpers are plan 03's (db/sql.ts); re-exported so scan and nightly builders import one module.
export { nextUtcMidnight, toIso as isoOf, utcDate } from "../db/sql.ts";
```

- [ ] **Step 4: Write `claim.ts`**

`app/src/worker/scan/claim.ts`:

```ts
import { DEFAULT_POLICY, LEASE_TTL_MS, TAU_DELETE_DEFAULT, TAU_DELETE_MAX, TAU_DELETE_MIN, parsePolicy } from "@clearbox/core";
import type { Policy, ProviderKind } from "@clearbox/core";
import type { AccountPhase, AppIssue } from "../../shared/api.ts";
import { ApiError } from "../middleware/errors.ts";
import { isoOf, nextUtcMidnight, rowsOf, stmt, sumMeta } from "./write-plan.ts";
import type { BatchResult, Stmt } from "./write-plan.ts";

/** Contracts 8.2, verbatim. ?1 holder, ?2 now, ?3 expires_at, ?4 accountId or NULL, ?5 force, ?6 today, ?7 stop rows. */
export const CLAIM_SQL = `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
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
RETURNING account_id`;

const HELD = "(SELECT account_id FROM leases WHERE holder = ?1 AND released_at IS NULL)";

export interface ClaimParams {
  tickId: string;
  now: number;
  accountId: string | null;
  force: boolean;
  today: string;
  stopRows: number;
}

export function claimStatements(p: ClaimParams): Stmt[] {
  return [
    stmt(CLAIM_SQL, p.tickId, p.now, p.now + LEASE_TTL_MS, p.accountId, p.force ? 1 : 0, p.today, p.stopRows),
    stmt(
      `UPDATE accounts SET tick_started_at = ?2,
         page_size = CASE WHEN tick_started_at IS NOT NULL
                           AND (tick_finished_at IS NULL OR tick_finished_at < tick_started_at)
                          THEN MAX(5, page_size / 2) ELSE page_size END,
         updated_at = ?2
       WHERE id = ${HELD}`,
      p.tickId,
      p.now,
    ),
    stmt(`SELECT * FROM accounts WHERE id = COALESCE(${HELD}, ?2)`, p.tickId, p.accountId),
    stmt("SELECT key, value FROM settings"),
    stmt("SELECT * FROM budget WHERE date = ?1", p.today),
    stmt(
      `SELECT COUNT(*) AS n FROM suggestions
       WHERE account_id = ${HELD} AND status = 'awaiting_model' AND (retry_after IS NULL OR retry_after <= ?2)`,
      p.tickId,
      p.now,
    ),
    stmt("SELECT holder, expires_at, released_at FROM leases WHERE name = 'account:' || ?1", p.accountId),
  ];
}

export interface TickAccountRow {
  id: string;
  provider: ProviderKind;
  email: string;
  status: string;
  status_reason: string | null;
  paused: number;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
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
  inbox_estimate: number | null;
}

export interface BudgetRow {
  date: string;
  rows_written: number;
  db_size_bytes: number;
}

export interface LeaseRow {
  holder: string;
  expires_at: number;
  released_at: number | null;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface ClaimResult {
  claimedAccountId: string | null;
  account: TickAccountRow | null;
  settings: SettingRow[];
  budget: BudgetRow | null;
  awaitingDue: number;
  lease: LeaseRow | null;
  rowsWritten: number;
  rowsRead: number;
}

export function parseClaim(results: readonly BatchResult[]): ClaimResult {
  return {
    claimedAccountId: rowsOf<{ account_id: string }>(results[0])[0]?.account_id ?? null,
    account: rowsOf<TickAccountRow>(results[2])[0] ?? null,
    settings: rowsOf<SettingRow>(results[3]),
    budget: rowsOf<BudgetRow>(results[4])[0] ?? null,
    awaitingDue: rowsOf<{ n: number }>(results[5])[0]?.n ?? 0,
    lease: rowsOf<LeaseRow>(results[6])[0] ?? null,
    rowsWritten: sumMeta(results, "rows_written"),
    rowsRead: sumMeta(results, "rows_read"),
  };
}

export interface TickSettings {
  policy: Policy;
  policyVersion: number;
  tauDelete: number;
  issues: AppIssue[];
}

export function parseTickSettings(rows: readonly SettingRow[]): TickSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  let policy: Policy;
  try {
    policy = parsePolicy(map.get("policy") ?? null);
  } catch {
    policy = DEFAULT_POLICY;
  }
  const tau = Number(map.get("tau_delete") ?? TAU_DELETE_DEFAULT);
  const version = Number(map.get("policy_version") ?? 1);
  let issues: AppIssue[] = [];
  const raw = map.get("issues");
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) issues = parsed as AppIssue[];
    } catch {
      issues = [];
    }
  }
  return {
    policy,
    policyVersion: Number.isInteger(version) && version >= 1 ? version : 1,
    tauDelete: Number.isFinite(tau) ? Math.min(TAU_DELETE_MAX, Math.max(TAU_DELETE_MIN, tau)) : TAU_DELETE_DEFAULT,
    issues,
  };
}

/** Contracts 7.5: why a scan-now request could not claim its account. */
export function scanNowError(c: ClaimResult, now: number, stopRows: number): ApiError {
  const a = c.account;
  if (a === null || a.status === "disconnected") return new ApiError(404, "not_found", "Account not found");
  if (a.status !== "active" || a.paused === 1) {
    return new ApiError(409, "account_inactive", "Account is not active");
  }
  if (c.lease !== null && c.lease.released_at === null && c.lease.expires_at > now) {
    return new ApiError(409, "account_busy", "A scan is already running for this account", {
      retryAt: isoOf(c.lease.expires_at),
    });
  }
  if (a.backoff_until !== null && a.backoff_until > now) {
    return new ApiError(409, "account_inactive", "Account is waiting after an error", { retryAt: isoOf(a.backoff_until) });
  }
  if ((c.budget?.rows_written ?? 0) >= stopRows) {
    return new ApiError(429, "budget_exhausted", "Daily database write budget reached", {
      retryAt: isoOf(nextUtcMidnight(now)),
    });
  }
  return new ApiError(409, "account_busy", "Account could not be claimed", { retryAt: isoOf(now + 60_000) });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/claim.test.ts`
Expected: `Tests  10 passed (10)`.

If every claim test fails with a D1 SQL parse error near `ON CONFLICT`, D1 rejects the upsert-after-`LIMIT` form. Replace the `FROM accounts a ... LIMIT 1` part of `CLAIM_SQL` with the contracts fallback and rerun:

```ts
export const CLAIM_SQL = `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
SELECT name, account_id, holder, acquired_at, expires_at, released_at FROM (
  SELECT 'account:' || a.id AS name, a.id AS account_id, ?1 AS holder, ?2 AS acquired_at, ?3 AS expires_at,
         NULL AS released_at
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
) WHERE true
ON CONFLICT (name) DO UPDATE SET
  account_id = excluded.account_id, holder = excluded.holder, acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING account_id`;
```

Report the switch to the lead (contracts 8.2 asks for the section to be updated).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/scan/write-plan.ts app/src/worker/scan/claim.ts app/test/worker/tick/claim.test.ts
git commit -m "feat(scan): add statement toolkit and account claim batch"
```

---

### Task 3: Tick token adapter and Decision-1 engine factory

Plan 03 owns `app/src/worker/scan/token-source.ts` and `app/src/worker/scan/providers.ts` (its Tasks 5 and 8). This task does not create or edit them: it consumes their exports by their exact names and adds two new files, `scan/tick-tokens.ts` (the adapter from a claimed `accounts` row to plan 03's token source, plus the token columns the tick write batch persists) and `scan/engine.ts`.

**Files:**
- Create: `app/src/worker/scan/tick-tokens.ts`
- Create: `app/src/worker/scan/engine.ts`
- Test: `app/test/worker/tick/tick-tokens.test.ts`

**Interfaces:**
- Consumes: from plan 03 `scan/token-source.ts`: `createD1TokenSource(opts: D1TokenSourceOptions): D1TokenSource` (`opts = { account: TokenAccount; encKey: CryptoKey; refresh: RefreshFn; now: () => number }`; the source exposes `update: TokenUpdate | null` and `refreshCount`), `refreshFnFor(oauth, config, provider, fetch, now, redirectUri): RefreshFn` (throws `ProviderConfigError({ reason: "client_not_configured" })` when the client is not configured), types `D1TokenSource`, `TokenAccount`; from plan 03 `scan/providers.ts`: `PROVIDER_OAUTH`, types `ProviderOAuthMap`, `ProviderTarget`; from plan 03 `crypto/aead.ts`: `encryptToken(key, plaintext, ctx: TokenContext): Promise<EncryptedValue>`, types `EncryptedValue`; from plan 03 `crypto/base64.ts`: `bytesFromBlob(value: unknown): Uint8Array<ArrayBuffer> | null`; from plan 03 `env.ts`: type `AppConfig`; from core: `MaiDecisionEngine`, types `TokenUpdate`, `FetchLike`, `ProviderKind`, `DecisionEngine`; test helpers from plan 03: `testEncKey()` (`test/worker/helpers/seed.ts`), `readConfig`.
- Produces:
  - `tick-tokens.ts`: `interface TickTokenRow { id: string; provider: ProviderKind; key_version: number; enc_refresh_token: unknown; refresh_iv: unknown; enc_access_token: unknown; access_iv: unknown; access_expires_at: number | null }`; `tokenAccountOf(row: TickTokenRow): TokenAccount`; `interface TickTokenOptions { row: TickTokenRow; config: AppConfig; encKey: CryptoKey; fetch: FetchLike; now: number; oauth?: ProviderOAuthMap }`; `openTickTokens(o: TickTokenOptions): D1TokenSource`; `providerTargetOf(row: { provider: ProviderKind; archive_folder_id: string | null }): ProviderTarget`; `interface TokenColumns { encAccess: Uint8Array<ArrayBuffer>; accessIv: Uint8Array<ArrayBuffer>; accessExpiresAt: number; encRefresh: Uint8Array<ArrayBuffer> | null; refreshIv: Uint8Array<ArrayBuffer> | null }`; `encryptTokenUpdate(encKey: CryptoKey, account: { id: string; key_version: number }, update: TokenUpdate): Promise<TokenColumns>`.
  - `engine.ts`: `makeDecisionEngine(env: Env, fetch: FetchLike): DecisionEngine | null`.
  - The tick builds its provider with plan 03's `makeProvider(providerTargetOf(account), deps)` (a `ProviderFactory`).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/tick/tick-tokens.test.ts`:

```ts
import { ProviderAuthError, ProviderConfigError } from "@clearbox/core";
import type { FetchLike } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../../../src/worker/crypto/aead.ts";
import { readConfig } from "../../../src/worker/env.ts";
import type { AppConfig } from "../../../src/worker/env.ts";
import type { TickAccountRow } from "../../../src/worker/scan/claim.ts";
import { makeDecisionEngine } from "../../../src/worker/scan/engine.ts";
import { makeProvider } from "../../../src/worker/scan/providers.ts";
import { encryptTokenUpdate, openTickTokens, providerTargetOf, tokenAccountOf } from "../../../src/worker/scan/tick-tokens.ts";
import { testEncKey } from "../helpers/seed.ts";
import { ACCOUNT_A, MINUTE, NOW, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

async function loadAccount(): Promise<TickAccountRow> {
  const row = await one<TickAccountRow>("SELECT * FROM accounts WHERE id = ?1", ACCOUNT_A);
  if (row === null) throw new Error("missing account");
  return row;
}

function config(overrides: Partial<Env> = {}): AppConfig {
  const result = readConfig({ ...env, ...overrides } as Env);
  if (!result.ok) throw new Error(`invalid test config: ${result.invalid.join(",")}`);
  return result.config;
}

function stubFetch(body: Record<string, unknown>, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json(body, { status });
    },
  };
}

const failingFetch: FetchLike = async () => {
  throw new Error("no network expected");
};

async function open(fetch: FetchLike, cfg: AppConfig = config()) {
  return openTickTokens({ row: await loadAccount(), config: cfg, encKey: await testEncKey(), fetch, now: NOW });
}

describe("openTickTokens (plan 03 createD1TokenSource over a claimed row)", () => {
  beforeEach(resetDb);

  it("returns the stored access token without any request while it is fresh", async () => {
    await seedTickAccount({ accessToken: "access-1", accessExpiresAt: NOW + 60 * MINUTE });
    const ts = await open(failingFetch);
    expect(await ts.getAccessToken()).toBe("access-1");
    expect(ts.update).toBeNull();
  });

  it("refreshes a Microsoft token near expiry and captures the rotated refresh token", async () => {
    await seedTickAccount({ provider: "outlook", accessExpiresAt: NOW + MINUTE });
    const stub = stubFetch({ token_type: "Bearer", scope: "Mail.ReadWrite User.Read offline_access", expires_in: 3599,
      access_token: "ms-access-2", refresh_token: "ms-refresh-2" });
    const ts = await open(stub.fetch);
    expect(await ts.getAccessToken()).toBe("ms-access-2");
    expect(await ts.getAccessToken()).toBe("ms-access-2");
    expect(stub.urls).toHaveLength(1);
    expect(ts.update).toEqual({ accessToken: "ms-access-2", accessExpiresAt: NOW + 3_599_000, refreshToken: "ms-refresh-2" });
  });

  it("refreshes Google without a new refresh token", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const stub = stubFetch({ access_token: "g-access-2", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify", token_type: "Bearer" });
    const ts = await open(stub.fetch);
    expect(await ts.getAccessToken()).toBe("g-access-2");
    expect(ts.update?.refreshToken).toBeNull();
    const cols = await encryptTokenUpdate(await testEncKey(), { id: ACCOUNT_A, key_version: 1 },
      ts.update ?? { accessToken: "", accessExpiresAt: 0, refreshToken: null });
    expect(cols.encRefresh).toBeNull();
    expect(cols.refreshIv).toBeNull();
  });

  it("forceRefresh refreshes even when the token is fresh", async () => {
    await seedTickAccount({ provider: "outlook" });
    const stub = stubFetch({ token_type: "Bearer", scope: "Mail.ReadWrite", expires_in: 3599, access_token: "ms-access-3", refresh_token: "ms-refresh-3" });
    const ts = await open(stub.fetch);
    expect(await ts.forceRefresh()).toBe("ms-access-3");
  });

  it("propagates invalid_grant as ProviderAuthError", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const stub = stubFetch({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const ts = await open(stub.fetch);
    await expect(ts.getAccessToken()).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("fails with ProviderConfigError without a request when the provider client is not configured", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null });
    const ts = await open(failingFetch, config({ GOOGLE_CLIENT_ID: "" }));
    await expect(ts.getAccessToken()).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("encryptTokenUpdate produces columns that decrypt with the account AAD", async () => {
    const key = await testEncKey();
    const cols = await encryptTokenUpdate(key, { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-1", accessExpiresAt: NOW, refreshToken: "r-1" });
    const ctx = (kind: "refresh" | "access") => ({ accountId: ACCOUNT_A, kind, keyVersion: 1 });
    expect(await decryptToken(key, { ciphertext: cols.encAccess, iv: cols.accessIv }, ctx("access"))).toBe("a-1");
    const enc = cols.encRefresh;
    const iv = cols.refreshIv;
    if (enc === null || iv === null) throw new Error("refresh columns missing");
    expect(await decryptToken(key, { ciphertext: enc, iv }, ctx("refresh"))).toBe("r-1");
  });

  it("tokenAccountOf maps the claimed row to plan 03's TokenAccount", async () => {
    await seedTickAccount({ provider: "outlook", accessToken: null });
    const account = tokenAccountOf(await loadAccount());
    expect(account).toMatchObject({ id: ACCOUNT_A, provider: "outlook", keyVersion: 1, accessToken: null, accessExpiresAt: null });
    expect(account.refreshToken?.iv).toHaveLength(12);
  });
});

describe("factories", () => {
  it("plan 03 makeProvider picks the provider implementation from the claimed row", () => {
    const deps = { fetch: failingFetch, tokens: { getAccessToken: async () => "t", forceRefresh: async () => "t" }, now: () => NOW };
    expect(makeProvider(providerTargetOf({ provider: "gmail", archive_folder_id: null }), deps).kind).toBe("gmail");
    expect(makeProvider(providerTargetOf({ provider: "outlook", archive_folder_id: "f" }), deps).kind).toBe("outlook");
  });

  it("makeDecisionEngine returns null when any Decision secret is empty", () => {
    expect(makeDecisionEngine(env, failingFetch)?.name).toBe("mai");
    expect(makeDecisionEngine({ ...env, AZURE_DECISION_KEY: "" }, failingFetch)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-tokens.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/scan/engine.ts`.

- [ ] **Step 3: Write `tick-tokens.ts`**

`app/src/worker/scan/tick-tokens.ts`:

```ts
import type { FetchLike, ProviderKind, TokenUpdate } from "@clearbox/core";
import { encryptToken } from "../crypto/aead.ts";
import type { EncryptedValue } from "../crypto/aead.ts";
import { bytesFromBlob } from "../crypto/base64.ts";
import type { AppConfig } from "../env.ts";
import { PROVIDER_OAUTH } from "./providers.ts";
import type { ProviderOAuthMap, ProviderTarget } from "./providers.ts";
import { createD1TokenSource, refreshFnFor } from "./token-source.ts";
import type { D1TokenSource, TokenAccount } from "./token-source.ts";

/** The token columns of a claimed accounts row, as D1 returns them (BLOBs untyped). */
export interface TickTokenRow {
  id: string;
  provider: ProviderKind;
  key_version: number;
  enc_refresh_token: unknown;
  refresh_iv: unknown;
  enc_access_token: unknown;
  access_iv: unknown;
  access_expires_at: number | null;
}

function pair(ciphertext: unknown, iv: unknown): EncryptedValue | null {
  const c = bytesFromBlob(ciphertext);
  const i = bytesFromBlob(iv);
  return c && i ? { ciphertext: c, iv: i } : null;
}

export function tokenAccountOf(row: TickTokenRow): TokenAccount {
  return {
    id: row.id,
    provider: row.provider,
    keyVersion: row.key_version,
    refreshToken: pair(row.enc_refresh_token, row.refresh_iv),
    accessToken: pair(row.enc_access_token, row.access_iv),
    accessExpiresAt: row.access_expires_at,
  };
}

export interface TickTokenOptions {
  row: TickTokenRow;
  config: AppConfig;
  encKey: CryptoKey;
  /** The tick's counted fetch: refreshes reserve from the tick subrequest counter. */
  fetch: FetchLike;
  now: number;
  /** Tests may inject; default PROVIDER_OAUTH (plan 02 helpers). */
  oauth?: ProviderOAuthMap;
}

/** Plan 03's D1 token source for one tick. Refresh grants send no redirect URI and a cron has no origin, so "". */
export function openTickTokens(o: TickTokenOptions): D1TokenSource {
  const now = () => o.now;
  return createD1TokenSource({
    account: tokenAccountOf(o.row),
    encKey: o.encKey,
    refresh: refreshFnFor(o.oauth ?? PROVIDER_OAUTH, o.config, o.row.provider, o.fetch, now, ""),
    now,
  });
}

export function providerTargetOf(row: { provider: ProviderKind; archive_folder_id: string | null }): ProviderTarget {
  return { provider: row.provider, archiveFolderId: row.archive_folder_id };
}

/** Encrypted columns for the tick's guarded account update (contracts 7.15; never written to a disconnected account). */
export interface TokenColumns {
  encAccess: Uint8Array<ArrayBuffer>;
  accessIv: Uint8Array<ArrayBuffer>;
  accessExpiresAt: number;
  encRefresh: Uint8Array<ArrayBuffer> | null;
  refreshIv: Uint8Array<ArrayBuffer> | null;
}

export async function encryptTokenUpdate(
  encKey: CryptoKey,
  account: { id: string; key_version: number },
  update: TokenUpdate,
): Promise<TokenColumns> {
  const ctx = (kind: "refresh" | "access") => ({ accountId: account.id, kind, keyVersion: account.key_version });
  const access = await encryptToken(encKey, update.accessToken, ctx("access"));
  const refresh = update.refreshToken === null ? null : await encryptToken(encKey, update.refreshToken, ctx("refresh"));
  return {
    encAccess: access.ciphertext,
    accessIv: access.iv,
    accessExpiresAt: update.accessExpiresAt,
    encRefresh: refresh?.ciphertext ?? null,
    refreshIv: refresh?.iv ?? null,
  };
}
```

- [ ] **Step 4: Write `engine.ts`**

`app/src/worker/scan/engine.ts`:

```ts
import { MaiDecisionEngine } from "@clearbox/core";
import type { DecisionEngine, FetchLike } from "@clearbox/core";

/** Null when any Decision-1 secret is empty; the tick then raises issue decision_not_configured. */
export function makeDecisionEngine(env: Env, fetch: FetchLike): DecisionEngine | null {
  const endpoint = env.AZURE_DECISION_ENDPOINT;
  const apiKey = env.AZURE_DECISION_KEY;
  const deployment = env.AZURE_DECISION_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) return null;
  return new MaiDecisionEngine({ endpoint: endpoint.replace(/\/+$/, ""), deployment, apiKey, fetch });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-tokens.test.ts`
Expected: `Tests  10 passed (10)`.

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/db-isolation.test.ts test/worker/oauth/token-source.test.ts`
Expected: PASS (plan 03's token source and isolation suites are unchanged; `tick-tokens.ts` has no SQL).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/scan/tick-tokens.ts app/src/worker/scan/engine.ts app/test/worker/tick/tick-tokens.test.ts
git commit -m "feat(scan): adapt plan 03's token source to the tick and add the Decision-1 engine factory"
```

---

### Task 4: Pure ingest stage and context reads

**Files:**
- Create: `app/src/worker/scan/ingest.ts`
- Create: `app/src/worker/scan/context.ts`
- Test: `app/test/worker/tick/ingest.test.ts`
- Test: `app/test/worker/tick/context.test.ts`

**Interfaces:**
- Consumes: core `extractSignals`, `evaluateGuardrails`, `selectPrior`, `priorKeyForSender`, `priorKeyForDomain`, `buildDecisionState`, `decisionSeed`, `decideAll`, `fuse`, constants; `chunk` (plan 03); `Stmt`, `stmt`, `numbered`, `rowsOf`, `IN_LIST_MAX`, `BatchResult` (Task 2).
- Produces:
  - `ingest.ts`: `interface LabelRow { id; sender; sender_domain; subject_trunc; owner_action }`; `interface PageContext { known; priors; senders; correspondents; repliedThreads; labelsBySender; labelsByDomain }`; `emptyContext(): PageContext`; `interface IngestSettings { policy; thresholds; ownerAddresses; now; accountId }`; `interface Identity { address; domain }`; `identify(messages, s): Identity[]`; `interface FreshKeys { providerIds; senders; domains; threadIds }`; `freshKeys(messages, ids): FreshKeys`; `interface PreparedItem { msg; signals; guard; prior; input; existingMessageId: number | null; previousAttempts: number }`; `prepareFresh(messages, ids, ctx, extraSent, s): { items: PreparedItem[]; skippedKnown: number }`; `interface RedecideRow`; `prepareRedecide(rows, ctx, s): PreparedItem[]`; `interface DecideStage { processed; outcomes; partial; configError; outage; retryableFailures }`; `emptyStage(): DecideStage`; `decideStage(engine, items, counter): Promise<DecideStage>`; `interface FinalItem { msg; signals; guard; existingMessageId; attempts; status: "pending" | "awaiting_model"; suggestion: Suggestion | null; retryAfter: number | null; modelVersion: string | null; result: DecisionResult | null; error: DecisionError | null }`; `finalize(stage, thresholds, now): FinalItem[]`; `truncateText(text, max): string`.
  - `context.ts`: `type ContextTag`; `interface TaggedStmt { tag; stmt }`; `freshContextStatements(accountId, keys): TaggedStmt[]`; `redecideContextStatements(accountId, now, limit): TaggedStmt[]`; `parseContext(tagged, results): { ctx: PageContext; redecideRows: RedecideRow[] }`.

- [ ] **Step 1: Write the failing ingest tests**

`app/test/worker/tick/ingest.test.ts`:

```ts
import {
  DEFAULT_POLICY, DELETE_MARGIN, FakeEngine, MIN_CONFIDENCE, SubrequestBudgetError, createSubrequestCounter,
} from "@clearbox/core";
import type { MailMessage } from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { describe, expect, it } from "vitest";
import {
  decideStage, emptyContext, finalize, freshKeys, identify, prepareFresh,
} from "../../../src/worker/scan/ingest.ts";
import type { IngestSettings, PageContext } from "../../../src/worker/scan/ingest.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ACCOUNT_A, DAY, MINUTE, NOW, OWNER } from "../helpers/tick-db.ts";

const S: IngestSettings = {
  policy: DEFAULT_POLICY,
  thresholds: { tauDelete: 0.8, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
  ownerAddresses: [OWNER],
  now: NOW,
  accountId: ACCOUNT_A,
};

function msg(id: string, from: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return makeMailMessage({
    providerMessageId: id,
    threadId: `t-${id}`,
    receivedAt: NOW - 10 * DAY,
    from: { address: from, name: "Shop" },
    to: [OWNER],
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    isRead: false,
    ...overrides,
  });
}

function prepared(messages: MailMessage[], ctx: PageContext = emptyContext()) {
  return prepareFresh(messages, identify(messages, S), ctx, [], S).items;
}

describe("identify and freshKeys", () => {
  it("derives lowercased sender and registrable domain, and dedupes keys", () => {
    const messages = [msg("a", "News@Mail.Shop.example"), msg("b", "news@mail.shop.example")];
    const ids = identify(messages, S);
    expect(ids[0]).toEqual({ address: "news@mail.shop.example", domain: "shop.example" });
    expect(freshKeys(messages, ids)).toEqual({
      providerIds: ["a", "b"], senders: ["news@mail.shop.example"], domains: ["shop.example"], threadIds: ["t-a", "t-b"],
    });
  });
});

describe("prepareFresh", () => {
  it("skips known ids and accumulates sender counts across the page", () => {
    const ctx: PageContext = { ...emptyContext(), known: new Set(["k"]), senders: new Map([["news@shop.example", { seen: 2, read: 1 }]]) };
    const messages = [msg("k", "news@shop.example"), msg("a", "news@shop.example"), msg("b", "news@shop.example"), msg("c", "news@shop.example")];
    const { items, skippedKnown } = prepareFresh(messages, identify(messages, S), ctx, [], S);
    expect(skippedKnown).toBe(1);
    expect(items.map((i) => i.msg.providerMessageId)).toEqual(["a", "b", "c"]);
    const first = items[0]?.signals.senderSeenCount ?? 0;
    expect(items[2]?.signals.senderSeenCount).toBe(first + 2);
    expect(items[0]?.input.key).toBe("a");
  });

  it("treats sent items on the same page as correspondents and replied threads", () => {
    const messages = [msg("a", "alice@example.net")];
    const sent = [{ threadId: "t-a", recipients: ["alice@example.net", OWNER], sentAt: NOW - DAY }];
    const { items } = prepareFresh(messages, identify(messages, S), emptyContext(), sent, S);
    expect(items[0]?.signals.isCorrespondent).toBe(true);
    expect(items[0]?.signals.ownerReplied).toBe(true);
    expect(items[0]?.guard.ceiling).toBe("keep");
  });

  it("puts same-sender labels before same-domain labels, at most five", () => {
    const label = (id: number, sender: string) => ({ id, sender, sender_domain: "shop.example", subject_trunc: `L${id}`, owner_action: "delete" as const });
    const ctx: PageContext = {
      ...emptyContext(),
      labelsBySender: new Map([["news@shop.example", [label(9, "news@shop.example"), label(8, "news@shop.example")]]]),
      labelsByDomain: new Map([["shop.example", [label(9, "news@shop.example"), label(7, "x@shop.example"), label(6, "y@shop.example"), label(5, "z@shop.example"), label(4, "w@shop.example")]]]),
    };
    const items = prepared([msg("a", "news@shop.example")], ctx);
    const past = items[0]?.input.state.similar_past_decisions ?? [];
    expect(past.map((p) => p.subject)).toEqual(["L9", "L8", "L7", "L6", "L5"]);
  });
});

describe("decideStage", () => {
  it("decides only what fits in the remaining subrequests and marks the stage partial", async () => {
    const items = prepared(["a", "b", "c", "d", "e"].map((id) => msg(id, `${id}@shop.example`)));
    const stage = await decideStage(new FakeEngine(), items, createSubrequestCounter(3));
    expect(stage.processed).toHaveLength(3);
    expect(stage.partial).toBe(true);
  });

  it("throws SubrequestBudgetError when no decision fits", async () => {
    const counter = createSubrequestCounter(1);
    counter.reserve(1);
    const items = prepared([msg("a", "a@shop.example")]);
    await expect(decideStage(new FakeEngine(), items, counter)).rejects.toBeInstanceOf(SubrequestBudgetError);
  });

  it("flags an outage only when at least four calls ran and most failed transiently", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const items = prepared(ids.map((id) => msg(id, `${id}@shop.example`)));
    const err = decisionError("server", 503, true, "item");
    const all = await decideStage(new FakeEngine({ overrides: new Map(ids.map((id) => [id, err])) }), items, createSubrequestCounter(45));
    expect(all.outage).toBe(true);
    const one = await decideStage(new FakeEngine({ overrides: new Map([["a", err]]) }), items, createSubrequestCounter(45));
    expect(one.outage).toBe(false);
    const three = await decideStage(new FakeEngine({ overrides: new Map(ids.slice(0, 3).map((id) => [id, err])) }), items.slice(0, 3), createSubrequestCounter(45));
    expect(three.outage).toBe(false);
  });

  it("reports the first configuration error", async () => {
    const items = prepared([msg("a", "a@shop.example")]);
    const stage = await decideStage(new FakeEngine({ overrides: new Map([["a", decisionError("auth", 401, false, "config")]]) }), items, createSubrequestCounter(45));
    expect(stage.configError?.kind).toBe("auth");
  });
});

describe("finalize", () => {
  it("maps outcomes to pending, awaiting_model and unsure per the retry schedule", async () => {
    const items = prepared(["ok", "retry", "bad"].map((id) => msg(id, `${id}@shop.example`)));
    const engine = new FakeEngine({ overrides: new Map([
      ["retry", decisionError("timeout", null, true, "item")],
      ["bad", decisionError("unprocessable", 422, false, "item")],
    ]) });
    const finals = finalize(await decideStage(engine, items, createSubrequestCounter(45)), S.thresholds, NOW);
    expect(finals[0]).toMatchObject({ status: "pending", attempts: 1, retryAfter: null, modelVersion: "fake/fake-1" });
    expect(finals[1]).toMatchObject({ status: "awaiting_model", attempts: 1, retryAfter: NOW + 5 * MINUTE, suggestion: null });
    expect(finals[2]?.status).toBe("pending");
    expect(finals[2]?.suggestion?.action).toBe("unsure");
    expect(finals[2]?.suggestion?.reasons.map((r) => r.code)).toContain("model_unavailable");
  });

  it("retries a re-decided item once more after 30 minutes, then falls back to unsure", async () => {
    const [base] = prepared([msg("r", "r@shop.example")]);
    if (base === undefined) throw new Error("no item");
    const engine = new FakeEngine({ overrides: new Map([["r", decisionError("server", 500, true, "item")]]) });
    const second = finalize(await decideStage(engine, [{ ...base, existingMessageId: 7, previousAttempts: 1 }], createSubrequestCounter(45)), S.thresholds, NOW);
    expect(second[0]).toMatchObject({ status: "awaiting_model", attempts: 2, retryAfter: NOW + 30 * MINUTE });
    const third = finalize(await decideStage(engine, [{ ...base, existingMessageId: 7, previousAttempts: 2 }], createSubrequestCounter(45)), S.thresholds, NOW);
    expect(third[0]).toMatchObject({ status: "pending", attempts: 3, retryAfter: null });
    expect(third[0]?.suggestion?.action).toBe("unsure");
  });
});
```

- [ ] **Step 2: Write the failing context tests**

`app/test/worker/tick/context.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { freshContextStatements, parseContext, redecideContextStatements } from "../../../src/worker/scan/context.ts";
import { ACCOUNT_A, ACCOUNT_B, NOW, MINUTE, all, resetDb, seedLabel, seedMessage, seedTickAccount } from "../helpers/tick-db.ts";

async function exec(tagged: ReturnType<typeof freshContextStatements>) {
  const res = await env.DB.batch(tagged.map((t) => env.DB.prepare(t.stmt.sql).bind(...t.stmt.params)));
  return parseContext(tagged, res);
}

describe("context reads", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
    await seedTickAccount({ id: ACCOUNT_B, email: "other@example.test" });
  });

  it("loads known ids, priors, sender stats, correspondents, threads and newest five labels, for this account only", async () => {
    await seedMessage(ACCOUNT_A, { providerId: "known-1" });
    await seedMessage(ACCOUNT_B, { providerId: "known-2" });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at) VALUES (?1, 'news@shop.example', 4, 1, 0), (?1, '@shop.example', 9, 2, 0)").bind(ACCOUNT_A),
      env.DB.prepare("INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at) VALUES (?1, 'news@shop.example', 'shop.example', 7, 1, 0)").bind(ACCOUNT_A),
      env.DB.prepare("INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, 'news@shop.example', 0)").bind(ACCOUNT_A),
      env.DB.prepare("INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, 't-1', 0)").bind(ACCOUNT_A),
    ]);
    for (let i = 0; i < 7; i++) await seedLabel(ACCOUNT_A, { subject: `L${i}`, pDelete: 0.9, margin: 0.8, ownerAction: "delete" });
    const { ctx } = await exec(freshContextStatements(ACCOUNT_A, {
      providerIds: ["known-1", "known-2", "new"], senders: ["news@shop.example"], domains: ["shop.example"], threadIds: ["t-1", "t-2"],
    }));
    expect([...ctx.known]).toEqual(["known-1"]);
    expect(ctx.priors.get("news@shop.example")).toEqual({ deletes: 4, keeps: 1 });
    expect(ctx.priors.get("@shop.example")).toEqual({ deletes: 9, keeps: 2 });
    expect(ctx.senders.get("news@shop.example")).toEqual({ seen: 7, read: 1 });
    expect(ctx.correspondents.has("news@shop.example")).toBe(true);
    expect([...ctx.repliedThreads]).toEqual(["t-1"]);
    expect(ctx.labelsBySender.get("news@shop.example")?.map((l) => l.subject_trunc)).toEqual(["L6", "L5", "L4", "L3", "L2"]);
    expect(ctx.labelsByDomain.get("shop.example")).toHaveLength(5);
  });

  it("chunks IN lists at 90 values, always scopes by account_id and skips empty lists", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const tagged = freshContextStatements(ACCOUNT_A, { providerIds: ids, senders: [], domains: [], threadIds: [] });
    expect(tagged.map((t) => t.tag)).toEqual(["known", "known", "known"]);
    for (const t of tagged) {
      expect(t.stmt.sql).toContain("account_id = ?1");
      expect(t.stmt.params.length).toBeLessThanOrEqual(91);
    }
  });

  it("loads only due awaiting_model rows for redecide, using the open-suggestions index", async () => {
    await seedMessage(ACCOUNT_A, { providerId: "due", status: "awaiting_model", retryAfter: NOW - 1, decisionAttempts: 1 });
    await seedMessage(ACCOUNT_A, { providerId: "later", status: "awaiting_model", retryAfter: NOW + MINUTE, decisionAttempts: 1 });
    await seedMessage(ACCOUNT_A, { providerId: "pending" });
    const tagged = redecideContextStatements(ACCOUNT_A, NOW, 25);
    const { redecideRows } = await exec(tagged);
    expect(redecideRows.map((r) => r.provider_msg_id)).toEqual(["due"]);
    expect(redecideRows[0]?.decision_attempts).toBe(1);
    const first = tagged[0];
    if (first === undefined) throw new Error("no redecide statement");
    const plan = await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${first.stmt.sql}`, ...first.stmt.params);
    expect(plan.map((p) => p.detail).join("\n")).toMatch(/USING (COVERING )?INDEX suggestions_open/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/ingest.test.ts test/worker/tick/context.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/scan/ingest.ts` and `.../context.ts`.

- [ ] **Step 4: Write `ingest.ts`**

`app/src/worker/scan/ingest.ts`:

```ts
import {
  DECISION_CONCURRENCY, DECISION_FAILURE_ABORT_RATIO, DECISION_MAX_ATTEMPTS, DECISION_RETRY_DELAYS_MS,
  PAST_DECISIONS_MAX, PAST_DECISION_SUBJECT_MAX_CHARS, buildDecisionState, decideAll, decisionSeed,
  evaluateGuardrails, extractSignals, fuse, priorKeyForDomain, priorKeyForSender, selectPrior,
} from "@clearbox/core";
import type {
  ActionKind, DecisionEngine, DecisionError, DecisionInput, DecisionOutcome, DecisionResult, GuardrailResult,
  MailMessage, PastDecision, Policy, Prior, PriorCounts, SenderHistory, SentItem, SignalContext, Signals,
  SubrequestCounter, Suggestion, Thresholds,
} from "@clearbox/core";

export interface LabelRow {
  id: number;
  sender: string;
  sender_domain: string;
  subject_trunc: string | null;
  owner_action: ActionKind;
}

export interface PageContext {
  known: ReadonlySet<string>;
  priors: ReadonlyMap<string, PriorCounts>;
  senders: ReadonlyMap<string, { seen: number; read: number }>;
  correspondents: ReadonlySet<string>;
  repliedThreads: ReadonlySet<string>;
  /** Newest first. */
  labelsBySender: ReadonlyMap<string, LabelRow[]>;
  /** Newest first. */
  labelsByDomain: ReadonlyMap<string, LabelRow[]>;
}

export function emptyContext(): PageContext {
  return {
    known: new Set(), priors: new Map(), senders: new Map(), correspondents: new Set(), repliedThreads: new Set(),
    labelsBySender: new Map(), labelsByDomain: new Map(),
  };
}

export interface IngestSettings {
  policy: Policy;
  thresholds: Thresholds;
  ownerAddresses: readonly string[];
  now: number;
  accountId: string;
}

export interface Identity {
  address: string;
  domain: string;
}

const EMPTY_HISTORY: SenderHistory = {
  seenCount: 0, readCount: 0, isCorrespondent: false, senderPrior: null, domainPrior: null,
};

/** Sender address and registrable domain, needed for the context query before real signals exist. */
export function identify(messages: readonly MailMessage[], s: IngestSettings): Identity[] {
  const ctx: SignalContext = { now: s.now, ownerAddresses: s.ownerAddresses, repliedThreadIds: new Set<string>() };
  return messages.map((m) => {
    const sig = extractSignals(m, EMPTY_HISTORY, ctx);
    return { address: sig.senderAddress, domain: sig.senderDomain };
  });
}

export interface FreshKeys {
  providerIds: string[];
  senders: string[];
  domains: string[];
  threadIds: string[];
}

export function freshKeys(messages: readonly MailMessage[], ids: readonly Identity[]): FreshKeys {
  const providerIds = new Set<string>();
  const senders = new Set<string>();
  const domains = new Set<string>();
  const threadIds = new Set<string>();
  messages.forEach((m, i) => {
    providerIds.add(m.providerMessageId);
    const id = ids[i];
    if (id !== undefined && id.address !== "") senders.add(id.address);
    if (id !== undefined && id.domain !== "") domains.add(id.domain);
    if (m.threadId !== null) threadIds.add(m.threadId);
  });
  return { providerIds: [...providerIds], senders: [...senders], domains: [...domains], threadIds: [...threadIds] };
}

export interface PreparedItem {
  msg: MailMessage;
  signals: Signals;
  guard: GuardrailResult;
  prior: Prior;
  input: DecisionInput;
  /** messages.id for a re-decided suggestion; null for a fresh message. */
  existingMessageId: number | null;
  previousAttempts: number;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

function pastDecisions(address: string, domain: string, ctx: PageContext): PastDecision[] {
  const out: PastDecision[] = [];
  const used = new Set<number>();
  const add = (rows: readonly LabelRow[] | undefined): void => {
    for (const l of rows ?? []) {
      if (out.length >= PAST_DECISIONS_MAX) return;
      if (used.has(l.id)) continue;
      used.add(l.id);
      out.push({
        domain: l.sender_domain,
        subject: truncateText(l.subject_trunc ?? "", PAST_DECISION_SUBJECT_MAX_CHARS),
        owner_action: l.owner_action,
      });
    }
  };
  if (address !== "") add(ctx.labelsBySender.get(address));
  if (domain !== "") add(ctx.labelsByDomain.get(domain));
  return out;
}

function prepareOne(
  msg: MailMessage,
  signals: Signals,
  history: SenderHistory,
  ctx: PageContext,
  s: IngestSettings,
  existingMessageId: number | null,
  previousAttempts: number,
): PreparedItem {
  const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, s.policy);
  const prior = selectPrior(history.senderPrior, history.domainPrior, signals.senderAddress, signals.senderDomain);
  const state = buildDecisionState({
    msg,
    signals,
    pastDecisions: pastDecisions(signals.senderAddress, signals.senderDomain, ctx),
  });
  const input: DecisionInput = {
    key: msg.providerMessageId,
    state,
    seed: decisionSeed(s.accountId, msg.providerMessageId),
  };
  return { msg, signals, guard, prior, input, existingMessageId, previousAttempts };
}

export function prepareFresh(
  messages: readonly MailMessage[],
  ids: readonly Identity[],
  ctx: PageContext,
  extraSent: readonly SentItem[],
  s: IngestSettings,
): { items: PreparedItem[]; skippedKnown: number } {
  const owners = new Set(s.ownerAddresses);
  const correspondents = new Set(ctx.correspondents);
  const replied = new Set(ctx.repliedThreads);
  for (const item of extraSent) {
    if (item.threadId !== null) replied.add(item.threadId);
    for (const r of item.recipients) if (!owners.has(r)) correspondents.add(r);
  }
  const sctx: SignalContext = { now: s.now, ownerAddresses: s.ownerAddresses, repliedThreadIds: replied };
  const pageCounts = new Map<string, { seen: number; read: number }>();
  const seen = new Set<string>();
  const items: PreparedItem[] = [];
  let skippedKnown = 0;
  messages.forEach((msg, i) => {
    if (ctx.known.has(msg.providerMessageId) || seen.has(msg.providerMessageId)) {
      skippedKnown += 1;
      return;
    }
    seen.add(msg.providerMessageId);
    const id = ids[i] ?? { address: "", domain: "" };
    const stored = ctx.senders.get(id.address) ?? { seen: 0, read: 0 };
    const page = pageCounts.get(id.address) ?? { seen: 0, read: 0 };
    const history: SenderHistory = {
      seenCount: stored.seen + page.seen,
      readCount: stored.read + page.read,
      isCorrespondent: id.address !== "" && correspondents.has(id.address),
      senderPrior: id.address === "" ? null : (ctx.priors.get(priorKeyForSender(id.address)) ?? null),
      domainPrior: id.domain === "" ? null : (ctx.priors.get(priorKeyForDomain(id.domain)) ?? null),
    };
    if (id.address !== "") pageCounts.set(id.address, { seen: page.seen + 1, read: page.read + (msg.isRead ? 1 : 0) });
    items.push(prepareOne(msg, extractSignals(msg, history, sctx), history, ctx, s, null, 0));
  });
  return { items, skippedKnown };
}

export interface RedecideRow {
  message_id: number;
  sender: string;
  sender_domain: string;
  decision_attempts: number;
  provider_msg_id: string;
  thread_id: string | null;
  internet_message_id: string | null;
  sender_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  is_read: number;
  signals_json: string;
  web_link: string | null;
}

function messageFromRow(row: RedecideRow, signals: Signals): MailMessage {
  return {
    providerMessageId: row.provider_msg_id,
    threadId: row.thread_id,
    internetMessageId: row.internet_message_id,
    receivedAt: row.received_at,
    from: { address: row.sender === "" ? null : row.sender, name: row.sender_name },
    to: [],
    cc: [],
    deliveredTo: [],
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    isRead: row.is_read === 1,
    starred: signals.starred,
    providerImportant: signals.providerImportant,
    category: signals.category,
    hasAttachments: signals.hasAttachments,
    attachmentsApprox: signals.attachmentsApprox,
    threadDepth: signals.threadDepth,
    headers: {
      listUnsubscribe: null, listUnsubscribePost: null, listId: null, precedence: null, autoSubmitted: null,
      authenticationResults: null, returnPath: null, contentType: null, references: null, inReplyTo: null,
    },
    webLink: row.web_link,
    labels: [],
  };
}

/** Rebuilds inputs from stored rows; guardrails are recomputed with the current policy. */
export function prepareRedecide(rows: readonly RedecideRow[], ctx: PageContext, s: IngestSettings): PreparedItem[] {
  return rows.map((row) => {
    const signals = JSON.parse(row.signals_json) as Signals;
    const history: SenderHistory = {
      seenCount: signals.senderSeenCount,
      readCount: 0,
      isCorrespondent: signals.isCorrespondent,
      senderPrior: row.sender === "" ? null : (ctx.priors.get(priorKeyForSender(row.sender)) ?? null),
      domainPrior: row.sender_domain === "" ? null : (ctx.priors.get(priorKeyForDomain(row.sender_domain)) ?? null),
    };
    return prepareOne(messageFromRow(row, signals), signals, history, ctx, s, row.message_id, row.decision_attempts);
  });
}

export interface DecideStage {
  processed: PreparedItem[];
  outcomes: DecisionOutcome[];
  /** True when not every item fitted in the remaining subrequests. */
  partial: boolean;
  configError: DecisionError | null;
  outage: boolean;
  retryableFailures: number;
}

export function emptyStage(): DecideStage {
  return { processed: [], outcomes: [], partial: false, configError: null, outage: false, retryableFailures: 0 };
}

export async function decideStage(
  engine: DecisionEngine,
  items: readonly PreparedItem[],
  counter: SubrequestCounter,
): Promise<DecideStage> {
  if (items.length === 0) return emptyStage();
  const room = counter.limit - counter.used;
  if (room <= 0) counter.reserve(1); // throws SubrequestBudgetError
  const processed = items.slice(0, Math.max(room, 0));
  const outcomes = await decideAll(engine, processed.map((p) => p.input), DECISION_CONCURRENCY);
  let retryable = 0;
  let configError: DecisionError | null = null;
  for (const o of outcomes) {
    if (o.ok) continue;
    if (o.error.scope === "config") configError ??= o.error;
    else if (o.error.retryable) retryable += 1;
  }
  return {
    processed,
    outcomes,
    partial: processed.length < items.length,
    configError,
    outage: processed.length >= 4 && retryable / processed.length > DECISION_FAILURE_ABORT_RATIO,
    retryableFailures: retryable,
  };
}

export interface FinalItem {
  msg: MailMessage;
  signals: Signals;
  guard: GuardrailResult;
  existingMessageId: number | null;
  /** decision_attempts after this tick. */
  attempts: number;
  status: "pending" | "awaiting_model";
  /** null while awaiting_model. */
  suggestion: Suggestion | null;
  retryAfter: number | null;
  modelVersion: string | null;
  result: DecisionResult | null;
  error: DecisionError | null;
}

export function finalize(stage: DecideStage, thresholds: Thresholds, now: number): FinalItem[] {
  return stage.processed.map((item, i): FinalItem => {
    const outcome = stage.outcomes[i];
    const attempts = item.previousAttempts + 1;
    const base = {
      msg: item.msg, signals: item.signals, guard: item.guard, existingMessageId: item.existingMessageId, attempts,
    };
    const fuseWith = (model: DecisionResult | null): Suggestion =>
      fuse({ model, prior: item.prior, guard: item.guard, signals: item.signals, thresholds });
    if (outcome?.ok === true) {
      return {
        ...base, status: "pending", suggestion: fuseWith(outcome.result), retryAfter: null,
        modelVersion: outcome.result.modelVersion, result: outcome.result, error: null,
      };
    }
    const error = outcome !== undefined && !outcome.ok ? outcome.error : null;
    const fresh = item.existingMessageId === null;
    if (error !== null && error.retryable && (fresh || attempts < DECISION_MAX_ATTEMPTS)) {
      const delay = DECISION_RETRY_DELAYS_MS[Math.min(attempts - 1, DECISION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      return {
        ...base, status: "awaiting_model", suggestion: null, retryAfter: now + delay, modelVersion: null,
        result: null, error,
      };
    }
    return {
      ...base, status: "pending", suggestion: fuseWith(null), retryAfter: null, modelVersion: null, result: null, error,
    };
  });
}
```

- [ ] **Step 5: Write `context.ts`**

`app/src/worker/scan/context.ts`:

```ts
import { priorKeyForDomain, priorKeyForSender } from "@clearbox/core";
import type { PriorCounts } from "@clearbox/core";
import { chunk } from "../db/sql.ts";
import type { FreshKeys, LabelRow, PageContext, RedecideRow } from "./ingest.ts";
import { IN_LIST_MAX, numbered, rowsOf, stmt } from "./write-plan.ts";
import type { BatchResult, SqlValue, Stmt } from "./write-plan.ts";

export type ContextTag =
  | "known" | "priors" | "senders" | "correspondents" | "threads" | "labels_sender" | "labels_domain" | "redecide";

export interface TaggedStmt {
  tag: ContextTag;
  stmt: Stmt;
}

const LABEL_COLUMNS = "id, sender, sender_domain, subject_trunc, owner_action";

function labelsSql(partition: "sender" | "sender_domain", inClause: string): string {
  return `SELECT ${LABEL_COLUMNS} FROM (
    SELECT ${LABEL_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY id DESC) AS rn
    FROM labels WHERE account_id = ?1 AND ${partition} IN (${inClause})
  ) WHERE rn <= 5`;
}

function inList(
  tag: ContextTag,
  build: (placeholders: string) => string,
  accountId: string,
  values: readonly string[],
): TaggedStmt[] {
  if (values.length === 0) return [];
  return chunk(values, IN_LIST_MAX).map((c) => ({
    tag,
    stmt: stmt(build(numbered(2, c.length)), accountId, ...(c as SqlValue[])),
  }));
}

export function freshContextStatements(accountId: string, keys: FreshKeys): TaggedStmt[] {
  const priorKeys = [...keys.senders.map(priorKeyForSender), ...keys.domains.map(priorKeyForDomain)];
  return [
    ...inList("known", (p) => `SELECT provider_msg_id FROM messages WHERE account_id = ?1 AND provider_msg_id IN (${p})`, accountId, keys.providerIds),
    ...inList("priors", (p) => `SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 AND key IN (${p})`, accountId, priorKeys),
    ...inList("senders", (p) => `SELECT address, seen_count, read_count FROM senders WHERE account_id = ?1 AND address IN (${p})`, accountId, keys.senders),
    ...inList("correspondents", (p) => `SELECT address FROM correspondents WHERE account_id = ?1 AND address IN (${p})`, accountId, keys.senders),
    ...inList("threads", (p) => `SELECT thread_id FROM sent_threads WHERE account_id = ?1 AND thread_id IN (${p})`, accountId, keys.threadIds),
    ...inList("labels_sender", (p) => labelsSql("sender", p), accountId, keys.senders),
    ...inList("labels_domain", (p) => labelsSql("sender_domain", p), accountId, keys.domains),
  ];
}

const DUE = "s.account_id = ?1 AND s.status = 'awaiting_model' AND (s.retry_after IS NULL OR s.retry_after <= ?2)";

export function redecideContextStatements(accountId: string, now: number, limit: number): TaggedStmt[] {
  return [
    {
      tag: "redecide",
      stmt: stmt(
        `SELECT s.message_id, s.sender, s.sender_domain, s.decision_attempts, m.provider_msg_id, m.thread_id,
           m.internet_message_id, m.sender_name, m.subject, m.snippet, m.received_at, m.is_read, m.signals_json, m.web_link
         FROM suggestions s JOIN messages m ON m.id = s.message_id
         WHERE ${DUE}
         ORDER BY s.created_at LIMIT ?3`,
        accountId, now, limit,
      ),
    },
    {
      tag: "priors",
      stmt: stmt(
        `SELECT key, deletes, keeps FROM sender_priors WHERE account_id = ?1 AND (
           key IN (SELECT s.sender FROM suggestions s WHERE ${DUE})
           OR key IN (SELECT '@' || s.sender_domain FROM suggestions s WHERE ${DUE}))`,
        accountId, now,
      ),
    },
    { tag: "labels_sender", stmt: stmt(labelsSql("sender", `SELECT s.sender FROM suggestions s WHERE ${DUE}`), accountId, now) },
    { tag: "labels_domain", stmt: stmt(labelsSql("sender_domain", `SELECT s.sender_domain FROM suggestions s WHERE ${DUE}`), accountId, now) },
  ];
}

function push(map: Map<string, LabelRow[]>, key: string, row: LabelRow): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [row]);
  else if (!list.some((l) => l.id === row.id)) list.push(row);
}

export function parseContext(
  tagged: readonly TaggedStmt[],
  results: readonly BatchResult[],
): { ctx: PageContext; redecideRows: RedecideRow[] } {
  const known = new Set<string>();
  const priors = new Map<string, PriorCounts>();
  const senders = new Map<string, { seen: number; read: number }>();
  const correspondents = new Set<string>();
  const repliedThreads = new Set<string>();
  const labelsBySender = new Map<string, LabelRow[]>();
  const labelsByDomain = new Map<string, LabelRow[]>();
  let redecideRows: RedecideRow[] = [];
  tagged.forEach((t, i) => {
    const r = results[i];
    switch (t.tag) {
      case "known":
        for (const row of rowsOf<{ provider_msg_id: string }>(r)) known.add(row.provider_msg_id);
        break;
      case "priors":
        for (const row of rowsOf<{ key: string; deletes: number; keeps: number }>(r)) {
          priors.set(row.key, { deletes: row.deletes, keeps: row.keeps });
        }
        break;
      case "senders":
        for (const row of rowsOf<{ address: string; seen_count: number; read_count: number }>(r)) {
          senders.set(row.address, { seen: row.seen_count, read: row.read_count });
        }
        break;
      case "correspondents":
        for (const row of rowsOf<{ address: string }>(r)) correspondents.add(row.address);
        break;
      case "threads":
        for (const row of rowsOf<{ thread_id: string }>(r)) repliedThreads.add(row.thread_id);
        break;
      case "labels_sender":
        for (const row of rowsOf<LabelRow>(r)) push(labelsBySender, row.sender, row);
        break;
      case "labels_domain":
        for (const row of rowsOf<LabelRow>(r)) push(labelsByDomain, row.sender_domain, row);
        break;
      case "redecide":
        redecideRows = rowsOf<RedecideRow>(r);
        break;
    }
  });
  for (const list of [...labelsBySender.values(), ...labelsByDomain.values()]) list.sort((a, b) => b.id - a.id);
  return {
    ctx: { known, priors, senders, correspondents, repliedThreads, labelsBySender, labelsByDomain },
    redecideRows,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/ingest.test.ts test/worker/tick/context.test.ts`
Expected: `Tests  13 passed (13)`.

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/scan/ingest.ts app/src/worker/scan/context.ts app/test/worker/tick/ingest.test.ts app/test/worker/tick/context.test.ts
git commit -m "feat(scan): add pure ingest stage and context reads"
```

---

### Task 5: Tick write plan, scheduling and budget statements

**Files:**
- Modify: `app/src/worker/scan/write-plan.ts` (add imports at the top, append the builders)
- Test: `app/test/worker/tick/write-plan.test.ts`

**Interfaces:**
- Consumes: `FinalItem`, `truncateText` (Task 4); `TokenColumns` (Task 3); `chunk` (plan 03); core constants `DECIDED_TTL_MS`, `PENDING_TTL_MS`, `POLL_INTERVAL_MS`, `SENT_BACKFILL_MAX_MESSAGES`, `MESSAGE_SUBJECT_MAX_CHARS`.
- Produces (all in `write-plan.ts`):
  - `settingStmt(key, valueJson, now): Stmt`; `type AuditKind = "reauth_required" | "config_error" | "calibration" | "purge" | "account_purged"`; `auditStmt(ts, accountId, kind, count, result): Stmt`; `leaseReleaseStmt(accountId, tickId, now): Stmt`.
  - `interface BudgetDelta { date; rowsWritten; rowsRead; ticks; messagesIngested; decisionCalls; decisionFailures; decisionInputTokens; providerCalls; dbSizeBytes; now }`; `budgetUpsertStmt(d): Stmt` (reusable by owner actions, contracts 8.5).
  - `interface IssueRaise { code: AppIssueCode; accountId: string | null }`; `interface IssueChange { issues; changed; raised; cleared }`; `applyIssues(current, raise, clear, now): IssueChange`; `issuesStmt(issues, now): Stmt`.
  - `interface AccountCursorState` (8 cursor columns); `type PageOutcome`; `interface AccountAdvance extends AccountCursorState { nextTickAt: number }`; `computeAdvance(cur, outcome, maxReceivedAt, now): AccountAdvance`.
  - `interface SuccessWriteInput` (includes `inboxEstimate: number | null`, amendment A4, written with `COALESCE`); `interface SuccessWrite { stmts: Stmt[]; dismissals: number[]; nextTickIndex: number }`; `buildSuccessWrite(i): SuccessWrite`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/tick/write-plan.test.ts`:

```ts
import { DEFAULT_POLICY, DELETE_MARGIN, FakeEngine, MIN_CONFIDENCE, POLL_INTERVAL_MS, createSubrequestCounter } from "@clearbox/core";
import type { DecisionError, MailMessage } from "@clearbox/core";
import { makeMailMessage } from "@clearbox/core/testing";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decideStage, emptyContext, finalize, identify, prepareFresh } from "../../../src/worker/scan/ingest.ts";
import type { IngestSettings } from "../../../src/worker/scan/ingest.ts";
import { encryptTokenUpdate } from "../../../src/worker/scan/tick-tokens.ts";
import { testEncKey } from "../helpers/seed.ts";
import { applyIssues, budgetUpsertStmt, buildSuccessWrite, computeAdvance, utcDate } from "../../../src/worker/scan/write-plan.ts";
import type { AccountCursorState, Stmt, SuccessWriteInput } from "../../../src/worker/scan/write-plan.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import {
  ACCOUNT_A, DAY, MINUTE, NOW, OWNER, count, decryptAccountToken, getAccount, one, resetDb, seedMessage, seedTickAccount,
} from "../helpers/tick-db.ts";

const S: IngestSettings = {
  policy: DEFAULT_POLICY,
  thresholds: { tauDelete: 0.8, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
  ownerAddresses: [OWNER],
  now: NOW,
  accountId: ACCOUNT_A,
};

const CUR: AccountCursorState = {
  phase: "inbox_backfill", backfill_done: 0, sent_cursor: null, sent_scanned: 0, backfill_cursor: "b-1",
  incremental_cursor: "i-1", last_incremental_at: NOW - MINUTE, watermark_received_at: NOW - 9 * DAY,
};

function m(id: string, from: string, overrides: Partial<MailMessage> = {}): MailMessage {
  return makeMailMessage({
    providerMessageId: id, threadId: `t-${id}`, receivedAt: NOW - 10 * DAY, from: { address: from, name: null },
    to: [OWNER], subject: `Subject ${id}`, snippet: `Snippet ${id}`, isRead: false, ...overrides,
  });
}

async function finals(messages: MailMessage[], overrides = new Map<string, DecisionError>()) {
  const { items } = prepareFresh(messages, identify(messages, S), emptyContext(), [], S);
  return finalize(await decideStage(new FakeEngine({ overrides }), items, createSubrequestCounter(45)), S.thresholds, NOW);
}

async function exec(stmts: Stmt[]) {
  return env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
}

function input(overrides: Partial<SuccessWriteInput>): SuccessWriteInput {
  return {
    accountId: ACCOUNT_A, tickId: "tick-1", now: NOW, policyVersion: 1, storeSnippets: true, items: [], sent: [],
    ownerAddresses: [OWNER], removedIds: [], issues: null, tokens: null, maxPageSize: 25, inboxEstimate: null,
    advance: computeAdvance(CUR, { kind: "redecide" }, null, NOW), ...overrides,
  };
}

describe("computeAdvance", () => {
  it("follows the contracts 8.3 phase table", () => {
    const sent = { ...CUR, phase: "sent_backfill" as const };
    expect(computeAdvance(sent, { kind: "sent_backfill", itemCount: 100, nextCursor: "s-2" }, null, NOW))
      .toMatchObject({ phase: "sent_backfill", sent_cursor: "s-2", sent_scanned: 100, nextTickAt: NOW });
    expect(computeAdvance({ ...sent, sent_scanned: 900 }, { kind: "sent_backfill", itemCount: 100, nextCursor: "s-2" }, null, NOW).phase).toBe("inbox_backfill");
    expect(computeAdvance(sent, { kind: "sent_backfill", itemCount: 3, nextCursor: null }, null, NOW).phase).toBe("inbox_backfill");
    expect(computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: "b-2", partial: false }, NOW - DAY, NOW))
      .toMatchObject({ phase: "inbox_backfill", backfill_cursor: "b-2", watermark_received_at: NOW - DAY, nextTickAt: NOW });
    expect(computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: null, partial: false }, null, NOW))
      .toMatchObject({ phase: "incremental", backfill_done: 1, backfill_cursor: null });
    expect(computeAdvance(CUR, { kind: "inbox_backfill", nextCursor: null, partial: true }, null, NOW))
      .toMatchObject({ phase: "inbox_backfill", backfill_cursor: "b-1", nextTickAt: NOW });
    expect(computeAdvance(CUR, { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false }, null, NOW))
      .toMatchObject({ phase: "inbox_backfill", incremental_cursor: "i-2", last_incremental_at: NOW, nextTickAt: NOW });
    const inc = { ...CUR, phase: "incremental" as const };
    expect(computeAdvance(inc, { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: false, partial: false }, null, NOW).nextTickAt).toBe(NOW);
    expect(computeAdvance(inc, { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false }, null, NOW).nextTickAt).toBe(NOW + POLL_INTERVAL_MS);
    expect(computeAdvance(inc, { kind: "incremental", startCursor: "r-1", nextCursor: "i-2", caughtUp: true, partial: true }, null, NOW))
      .toMatchObject({ incremental_cursor: "r-1", nextTickAt: NOW });
    expect(computeAdvance(inc, { kind: "redecide" }, null, NOW)).toMatchObject({ phase: "incremental", nextTickAt: NOW });
  });
});

describe("applyIssues", () => {
  it("raises, clears and reports a change only when the set changes", () => {
    const first = applyIssues([], [{ code: "storage_near_limit", accountId: null }], [], NOW);
    expect(first.changed).toBe(true);
    expect(first.issues).toEqual([{ code: "storage_near_limit", since: new Date(NOW).toISOString(), accountId: null }]);
    expect(applyIssues(first.issues, [{ code: "storage_near_limit", accountId: null }], ["decision_auth_failed"], NOW + 1).changed).toBe(false);
    expect(applyIssues(first.issues, [], ["storage_near_limit"], NOW)).toMatchObject({ changed: true, issues: [], cleared: ["storage_near_limit"] });
  });
});

describe("buildSuccessWrite", () => {
  beforeEach(resetDb);

  it("writes rows, dismissals, cursor and tokens, releases the lease, and replayed inserts are no-ops", async () => {
    await seedTickAccount({ phase: "incremental" });
    await env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'tick-1', ?3, ?4)")
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE).run();
    const gone = await seedMessage(ACCOUNT_A, { providerId: "gone" });
    const items = await finals(
      [m("a", "news@shop.example"), m("b", "news@shop.example", { isRead: true }), m("c", "deals@other.example")],
      new Map([["c", decisionError("server", 503, true, "item")]]),
    );
    const advance = computeAdvance({ ...CUR, phase: "incremental" },
      { kind: "incremental", startCursor: "i-1", nextCursor: "i-2", caughtUp: true, partial: false }, NOW - 10 * DAY, NOW);
    const tokens = await encryptTokenUpdate(await testEncKey(), { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-9", accessExpiresAt: NOW + 3_600_000, refreshToken: "r-9" });
    const write = buildSuccessWrite(input({
      items, advance, tokens, storeSnippets: false, removedIds: ["gone"], inboxEstimate: 1234,
      sent: [{ threadId: "t-x", recipients: ["friend@example.net", OWNER], sentAt: NOW - DAY }],
    }));
    const res = await exec(write.stmts);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(4);
    expect(await count("suggestions", "status = 'pending'")).toBe(2);
    expect(await count("suggestions", "status = 'awaiting_model' AND retry_after = ?1 AND decision_attempts = 1", NOW + 5 * MINUTE)).toBe(1);
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", gone)).toEqual({ status: "dismissed" });
    expect(write.dismissals.reduce((n, i) => n + (res[i]?.meta.changes ?? 0), 0)).toBe(1);
    expect(await one("SELECT seen_count, read_count FROM senders WHERE account_id = ?1 AND address = 'news@shop.example'", ACCOUNT_A))
      .toEqual({ seen_count: 2, read_count: 1 });
    expect(await count("correspondents", "address = 'friend@example.net'")).toBe(1);
    expect(await count("correspondents", "address = ?1", OWNER)).toBe(0);
    expect(await count("sent_threads", "thread_id = 't-x'")).toBe(1);
    expect(await one("SELECT snippet FROM messages WHERE provider_msg_id = 'a'")).toEqual({ snippet: null });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      incremental_cursor: "i-2", last_incremental_at: NOW, messages_ingested: 3, attempts: 0, last_tick_at: NOW,
      next_tick_at: NOW + 5 * MINUTE, inbox_estimate: 1234,
    });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("r-9");
    expect(await one("SELECT released_at FROM leases WHERE holder = 'tick-1'")).toEqual({ released_at: NOW });
    expect(res[write.nextTickIndex]?.results[0]).toEqual({ next_tick_at: NOW + 5 * MINUTE });

    await exec(write.stmts.slice(0, 6));
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(4);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(4);
  });

  it("never writes tokens back to a disconnected account", async () => {
    await seedTickAccount({ status: "disconnected" });
    const tokens = await encryptTokenUpdate(await testEncKey(), { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-9", accessExpiresAt: NOW, refreshToken: "r-9" });
    await exec(buildSuccessWrite(input({ tokens })).stmts);
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBeNull();
  });

  it("budgetUpsertStmt accumulates counters per UTC day and keeps the last known size", async () => {
    const d = {
      date: utcDate(NOW), rowsWritten: 10, rowsRead: 5, ticks: 1, messagesIngested: 3, decisionCalls: 3,
      decisionFailures: 1, decisionInputTokens: 900, providerCalls: 2, dbSizeBytes: 1000, now: NOW,
    };
    await exec([budgetUpsertStmt(d)]);
    await exec([budgetUpsertStmt({ ...d, dbSizeBytes: 0 })]);
    expect(await one("SELECT rows_written, ticks, decision_failures, db_size_bytes FROM budget WHERE date = ?1", d.date))
      .toEqual({ rows_written: 20, ticks: 2, decision_failures: 2, db_size_bytes: 1000 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/write-plan.test.ts`
Expected: FAIL with `does not provide an export named 'applyIssues'` (or `applyIssues is not a function`).

- [ ] **Step 3: Add the imports at the top of `write-plan.ts`**

Insert above `export type SqlValue`:

```ts
import {
  DECIDED_TTL_MS, MESSAGE_SUBJECT_MAX_CHARS, PENDING_TTL_MS, POLL_INTERVAL_MS, SENT_BACKFILL_MAX_MESSAGES,
} from "@clearbox/core";
import type { SentItem } from "@clearbox/core";
import type { AccountPhase, AppIssue, AppIssueCode } from "../../shared/api.ts";
import { chunk } from "../db/sql.ts";
import { truncateText } from "./ingest.ts";
import type { FinalItem } from "./ingest.ts";
import type { TokenColumns } from "./tick-tokens.ts";
```

- [ ] **Step 4: Append the builders to `write-plan.ts`**

```ts
export function settingStmt(key: string, valueJson: string, now: number): Stmt {
  return stmt(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, valueJson, now,
  );
}

export type AuditKind = "reauth_required" | "config_error" | "calibration" | "purge" | "account_purged";

/** result holds counts and codes only (contracts 6.1 audit_log). */
export function auditStmt(
  ts: number,
  accountId: string | null,
  kind: AuditKind,
  count: number,
  result: Readonly<Record<string, string | number>>,
): Stmt {
  return stmt(
    "INSERT INTO audit_log (ts, account_id, kind, count, result_json) VALUES (?1, ?2, ?3, ?4, ?5)",
    ts, accountId, kind, count, JSON.stringify(result),
  );
}

export function leaseReleaseStmt(accountId: string, tickId: string, now: number): Stmt {
  return stmt("UPDATE leases SET released_at = ?3 WHERE name = 'account:' || ?1 AND holder = ?2", accountId, tickId, now);
}

export interface BudgetDelta {
  date: string;
  rowsWritten: number;
  rowsRead: number;
  ticks: number;
  messagesIngested: number;
  decisionCalls: number;
  decisionFailures: number;
  decisionInputTokens: number;
  providerCalls: number;
  /** 0 = unknown, keeps the stored value. */
  dbSizeBytes: number;
  now: number;
}

export function budgetUpsertStmt(d: BudgetDelta): Stmt {
  return stmt(
    `INSERT INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
       decision_input_tokens, provider_calls, db_size_bytes, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (date) DO UPDATE SET
       rows_written = rows_written + excluded.rows_written,
       rows_read = rows_read + excluded.rows_read,
       ticks = ticks + excluded.ticks,
       messages_ingested = messages_ingested + excluded.messages_ingested,
       decision_calls = decision_calls + excluded.decision_calls,
       decision_failures = decision_failures + excluded.decision_failures,
       decision_input_tokens = decision_input_tokens + excluded.decision_input_tokens,
       provider_calls = provider_calls + excluded.provider_calls,
       db_size_bytes = CASE WHEN excluded.db_size_bytes > 0 THEN excluded.db_size_bytes ELSE db_size_bytes END,
       updated_at = excluded.updated_at`,
    d.date, d.rowsWritten, d.rowsRead, d.ticks, d.messagesIngested, d.decisionCalls, d.decisionFailures,
    d.decisionInputTokens, d.providerCalls, d.dbSizeBytes, d.now,
  );
}

export interface IssueRaise {
  code: AppIssueCode;
  accountId: string | null;
}

export interface IssueChange {
  issues: AppIssue[];
  changed: boolean;
  raised: AppIssueCode[];
  cleared: AppIssueCode[];
}

/** Clears first, then raises; a code that is both raised and cleared stays raised. */
export function applyIssues(
  current: readonly AppIssue[],
  raise: readonly IssueRaise[],
  clear: readonly AppIssueCode[],
  now: number,
): IssueChange {
  const raisedCodes = new Set(raise.map((r) => r.code));
  const clearSet = new Set(clear.filter((c) => !raisedCodes.has(c)));
  const issues = current.filter((i) => !clearSet.has(i.code));
  const cleared = [...new Set(current.filter((i) => clearSet.has(i.code)).map((i) => i.code))];
  const raised: AppIssueCode[] = [];
  for (const r of raise) {
    if (issues.some((i) => i.code === r.code && i.accountId === r.accountId)) continue;
    issues.push({ code: r.code, since: isoOf(now), accountId: r.accountId });
    raised.push(r.code);
  }
  return { issues, changed: raised.length > 0 || cleared.length > 0, raised, cleared };
}

export function issuesStmt(issues: readonly AppIssue[], now: number): Stmt {
  return settingStmt("issues", JSON.stringify(issues), now);
}

export interface AccountCursorState {
  phase: AccountPhase;
  backfill_done: number;
  sent_cursor: string | null;
  sent_scanned: number;
  backfill_cursor: string | null;
  incremental_cursor: string;
  last_incremental_at: number | null;
  watermark_received_at: number | null;
}

export type PageOutcome =
  | { kind: "sent_backfill"; itemCount: number; nextCursor: string | null }
  | { kind: "inbox_backfill"; nextCursor: string | null; partial: boolean }
  | { kind: "incremental"; startCursor: string; nextCursor: string; caughtUp: boolean; partial: boolean }
  | { kind: "redecide" };

export interface AccountAdvance extends AccountCursorState {
  nextTickAt: number;
}

/** Contracts 8.3. A partial page (subrequest squeeze) keeps the cursor so the next tick resumes it. */
export function computeAdvance(
  cur: AccountCursorState,
  out: PageOutcome,
  maxReceivedAt: number | null,
  now: number,
): AccountAdvance {
  const next: AccountAdvance = {
    phase: cur.phase,
    backfill_done: cur.backfill_done,
    sent_cursor: cur.sent_cursor,
    sent_scanned: cur.sent_scanned,
    backfill_cursor: cur.backfill_cursor,
    incremental_cursor: cur.incremental_cursor,
    last_incremental_at: cur.last_incremental_at,
    watermark_received_at:
      maxReceivedAt === null ? cur.watermark_received_at : Math.max(cur.watermark_received_at ?? 0, maxReceivedAt),
    nextTickAt: now,
  };
  switch (out.kind) {
    case "sent_backfill": {
      next.sent_cursor = out.nextCursor;
      next.sent_scanned = cur.sent_scanned + out.itemCount;
      if (out.nextCursor === null || next.sent_scanned >= SENT_BACKFILL_MAX_MESSAGES) next.phase = "inbox_backfill";
      return next;
    }
    case "inbox_backfill":
      if (out.partial) return next;
      next.backfill_cursor = out.nextCursor;
      if (out.nextCursor === null) {
        next.phase = "incremental";
        next.backfill_done = 1;
      }
      return next;
    case "incremental":
      next.incremental_cursor = out.partial ? out.startCursor : out.nextCursor;
      next.last_incremental_at = now;
      if (cur.phase === "incremental" && out.caughtUp && !out.partial) next.nextTickAt = now + POLL_INTERVAL_MS;
      return next;
    case "redecide":
      return next;
  }
}

const MESSAGE_INSERT = `INSERT INTO messages (account_id, provider_msg_id, thread_id, internet_message_id, sender,
    sender_name, sender_domain, subject, snippet, received_at, is_read, signals_json, web_link, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
  ON CONFLICT (account_id, provider_msg_id) DO NOTHING`;

const SUGGESTION_INSERT = `INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action,
    confidence, p_delete, p_archive, p_keep, p_unsure, model_p_delete, margin, importance, flags_json, ceiling,
    ceiling_applied, reasons_json, model_version, policy_version, decision_attempts, retry_after, created_at,
    updated_at, expires_at)
  SELECT m.id, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
    ?23, ?23, ?24
  FROM messages m WHERE m.account_id = ?1 AND m.provider_msg_id = ?2
  ON CONFLICT (message_id) DO NOTHING`;

const SUGGESTION_REDECIDE = `UPDATE suggestions SET status = ?3, action = ?4, confidence = ?5, p_delete = ?6,
    p_archive = ?7, p_keep = ?8, p_unsure = ?9, model_p_delete = ?10, margin = ?11, importance = ?12,
    flags_json = ?13, ceiling = ?14, ceiling_applied = ?15, reasons_json = ?16, model_version = ?17,
    decision_attempts = ?18, retry_after = ?19, updated_at = ?20
  WHERE message_id = ?1 AND account_id = ?2 AND status = 'awaiting_model'`;

const SENDER_UPSERT = `INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (account_id, address) DO UPDATE SET seen_count = seen_count + excluded.seen_count,
    read_count = read_count + excluded.read_count, last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`;

const CORRESPONDENT_UPSERT = `INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (account_id, address) DO UPDATE SET last_sent_at = excluded.last_sent_at
  WHERE excluded.last_sent_at > correspondents.last_sent_at`;

const THREAD_UPSERT = `INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (account_id, thread_id) DO UPDATE SET last_sent_at = excluded.last_sent_at
  WHERE excluded.last_sent_at > sent_threads.last_sent_at`;

function dismissSql(n: number): string {
  return `UPDATE suggestions SET status = 'dismissed', updated_at = ?1, expires_at = ?2
    WHERE account_id = ?3 AND (status = 'pending' OR status = 'awaiting_model')
      AND message_id IN (SELECT id FROM messages WHERE account_id = ?3 AND provider_msg_id IN (${numbered(4, n)}))`;
}

const ACCOUNT_SUCCESS = `UPDATE accounts SET phase = ?2, backfill_done = MAX(backfill_done, ?3), sent_cursor = ?4,
    sent_scanned = ?5, backfill_cursor = ?6, incremental_cursor = ?7, last_incremental_at = ?8,
    watermark_received_at = ?9,
    enc_access_token = COALESCE(?10, enc_access_token), access_iv = COALESCE(?11, access_iv),
    access_expires_at = COALESCE(?12, access_expires_at),
    enc_refresh_token = COALESCE(?13, enc_refresh_token), refresh_iv = COALESCE(?14, refresh_iv),
    attempts = 0, backoff_until = NULL, last_error = NULL, status_reason = NULL,
    next_tick_at = MIN(?15, COALESCE((SELECT MIN(retry_after) FROM suggestions
      WHERE account_id = ?1 AND status = 'awaiting_model'), ?15)),
    last_tick_at = ?16, tick_finished_at = ?16, page_size = MIN(?17, page_size + 5),
    messages_ingested = messages_ingested + ?18, inbox_estimate = COALESCE(?19, inbox_estimate), updated_at = ?16
  WHERE id = ?1 AND status <> 'disconnected'`;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function suggestionColumns(it: FinalItem): SqlValue[] {
  const s = it.suggestion;
  const d = s?.distribution ?? null;
  return [
    s?.action ?? null,
    s === null ? null : clamp01(s.confidence),
    d === null ? null : clamp01(d.delete),
    d === null ? null : clamp01(d.archive),
    d === null ? null : clamp01(d.keep),
    d === null ? null : clamp01(d.unsure),
    s === null || s.modelDelete === null ? null : clamp01(s.modelDelete),
    s?.margin ?? null,
    s?.importance ?? null,
    s?.flags ? JSON.stringify(s.flags) : null,
    s?.ceiling ?? it.guard.ceiling,
    s?.ceilingApplied ? 1 : 0,
    JSON.stringify(s?.reasons ?? []),
  ];
}

export interface SuccessWriteInput {
  accountId: string;
  tickId: string;
  now: number;
  policyVersion: number;
  storeSnippets: boolean;
  /** Fresh items (existingMessageId null) are inserted; re-decided items update their suggestion. */
  items: readonly FinalItem[];
  sent: readonly SentItem[];
  ownerAddresses: readonly string[];
  removedIds: readonly string[];
  /** Full issue list when it changed, else null. */
  issues: readonly AppIssue[] | null;
  advance: AccountAdvance;
  tokens: TokenColumns | null;
  maxPageSize: number;
  /** Amendment A4: fresh provider inbox total, or null to keep the stored value. */
  inboxEstimate: number | null;
}

export interface SuccessWrite {
  stmts: Stmt[];
  /** Indexes of dismissal statements (sum their meta.changes for TickReport.removed). */
  dismissals: number[];
  /** Index of the trailing SELECT next_tick_at. */
  nextTickIndex: number;
}

/** One D1 batch = one transaction (contracts 8.2, D1 call 3). */
export function buildSuccessWrite(i: SuccessWriteInput): SuccessWrite {
  const stmts: Stmt[] = [];
  const fresh = i.items.filter((it) => it.existingMessageId === null);
  for (const it of fresh) {
    const sig = it.signals;
    stmts.push(stmt(
      MESSAGE_INSERT, i.accountId, it.msg.providerMessageId, it.msg.threadId, it.msg.internetMessageId,
      sig.senderAddress, sig.senderName, sig.senderDomain, truncateText(it.msg.subject, MESSAGE_SUBJECT_MAX_CHARS),
      i.storeSnippets ? it.msg.snippet : null, it.msg.receivedAt, it.msg.isRead ? 1 : 0, JSON.stringify(sig),
      it.msg.webLink, i.now,
    ));
  }
  for (const it of fresh) {
    stmts.push(stmt(
      SUGGESTION_INSERT, i.accountId, it.msg.providerMessageId, it.signals.senderAddress, it.signals.senderDomain,
      it.status, ...suggestionColumns(it), it.modelVersion, i.policyVersion, it.attempts, it.retryAfter, i.now,
      i.now + PENDING_TTL_MS,
    ));
  }
  for (const it of i.items) {
    if (it.existingMessageId === null) continue;
    stmts.push(stmt(
      SUGGESTION_REDECIDE, it.existingMessageId, i.accountId, it.status, ...suggestionColumns(it), it.modelVersion,
      it.attempts, it.retryAfter, i.now,
    ));
  }
  const senders = new Map<string, { domain: string; seen: number; read: number; last: number }>();
  for (const it of fresh) {
    const address = it.signals.senderAddress;
    if (address === "") continue;
    const cur = senders.get(address) ?? { domain: it.signals.senderDomain, seen: 0, read: 0, last: 0 };
    senders.set(address, {
      domain: cur.domain, seen: cur.seen + 1, read: cur.read + (it.msg.isRead ? 1 : 0),
      last: Math.max(cur.last, it.msg.receivedAt),
    });
  }
  for (const [address, d] of senders) stmts.push(stmt(SENDER_UPSERT, i.accountId, address, d.domain, d.seen, d.read, d.last));
  const owners = new Set(i.ownerAddresses);
  const addresses = new Map<string, number>();
  const threads = new Map<string, number>();
  for (const item of i.sent) {
    for (const raw of item.recipients) {
      const address = raw.toLowerCase();
      if (address === "" || owners.has(address)) continue;
      addresses.set(address, Math.max(addresses.get(address) ?? 0, item.sentAt));
    }
    if (item.threadId !== null) threads.set(item.threadId, Math.max(threads.get(item.threadId) ?? 0, item.sentAt));
  }
  for (const [address, at] of addresses) stmts.push(stmt(CORRESPONDENT_UPSERT, i.accountId, address, at));
  for (const [thread, at] of threads) stmts.push(stmt(THREAD_UPSERT, i.accountId, thread, at));
  const dismissals: number[] = [];
  if (i.removedIds.length > 0) {
    for (const c of chunk(i.removedIds, IN_LIST_MAX)) {
      dismissals.push(stmts.length);
      stmts.push(stmt(dismissSql(c.length), i.now, i.now + DECIDED_TTL_MS, i.accountId, ...c));
    }
  }
  if (i.issues !== null) stmts.push(issuesStmt(i.issues, i.now));
  const a = i.advance;
  const t = i.tokens;
  stmts.push(stmt(
    ACCOUNT_SUCCESS, i.accountId, a.phase, a.backfill_done, a.sent_cursor, a.sent_scanned, a.backfill_cursor,
    a.incremental_cursor, a.last_incremental_at, a.watermark_received_at, t?.encAccess ?? null, t?.accessIv ?? null,
    t?.accessExpiresAt ?? null, t?.encRefresh ?? null, t?.refreshIv ?? null, a.nextTickAt, i.now, i.maxPageSize,
    fresh.length, i.inboxEstimate,
  ));
  stmts.push(leaseReleaseStmt(i.accountId, i.tickId, i.now));
  const nextTickIndex = stmts.length;
  stmts.push(stmt("SELECT next_tick_at FROM accounts WHERE id = ?1", i.accountId));
  return { stmts, dismissals, nextTickIndex };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/write-plan.test.ts test/worker/tick/claim.test.ts test/worker/tick/context.test.ts`
Expected: `Tests  18 passed (18)` (5 new plus the 13 from Tasks 2 and 4 that share `write-plan.ts`).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/scan/write-plan.ts app/test/worker/tick/write-plan.test.ts
git commit -m "feat(scan): add tick write plan, phase scheduling and budget statements"
```

---

### Task 6: Failure classification and failure write

**Files:**
- Create: `app/src/worker/scan/failure.ts`
- Test: `app/test/worker/tick/failure.test.ts`

**Interfaces:**
- Consumes: core error classes and `backoffMs`; `auditStmt`, `issuesStmt`, `leaseReleaseStmt`, `stmt` (Task 5); `TokenColumns` (Task 3).
- Produces:
  - `class DecisionNotConfiguredError extends ClearboxError` (code `decision_not_configured`, no constructor arguments).
  - `class DecisionOutageError extends ClearboxError` (code `decision_outage`, `constructor(failures: number, total: number)`).
  - `interface FailurePlan { errorCode: string; status: "active" | "needs_reauth" | "config_error"; statusReason: string | null; backoffUntil: number | null; retryAfterMs: number | null; halvePageSize: boolean; audit: "reauth_required" | "config_error" | null; raise: AppIssueCode[]; provider: { status: number | null } | null }`.
  - `classifyFailure(err: unknown, c: { provider: ProviderKind; attempts: number; now: number; random?: () => number }): FailurePlan`.
  - `interface FailureWriteInput { accountId; tickId; now; plan; tokens: TokenColumns | null; issues: readonly AppIssue[] | null }`; `buildFailureWrite(i): Stmt[]` (account update, lease release, optional audit, optional issues).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/tick/failure.test.ts`:

```ts
import {
  ProviderAuthError, ProviderConfigError, ProviderRateLimitError, ProviderUnavailableError, SubrequestBudgetError,
  createSubrequestCounter,
} from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DecisionNotConfiguredError, DecisionOutageError, buildFailureWrite, classifyFailure,
} from "../../../src/worker/scan/failure.ts";
import { encryptTokenUpdate } from "../../../src/worker/scan/tick-tokens.ts";
import { testEncKey } from "../helpers/seed.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ACCOUNT_A, MINUTE, NOW, decryptAccountToken, getAccount, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

const C = { provider: "outlook" as const, attempts: 0, now: NOW, random: () => 0 };

function budgetError(): SubrequestBudgetError {
  try {
    createSubrequestCounter(0).reserve(1);
  } catch (err) {
    if (err instanceof SubrequestBudgetError) return err;
  }
  throw new Error("expected SubrequestBudgetError");
}

describe("classifyFailure", () => {
  it("halves the page and sets no backoff for a subrequest budget error, even when wrapped", () => {
    const direct = classifyFailure(budgetError(), C);
    expect(direct).toMatchObject({ errorCode: "subrequest_budget", backoffUntil: null, halvePageSize: true, status: "active" });
    const wrapped = new ProviderUnavailableError({ provider: "outlook", retryAfterMs: null, cause: budgetError() });
    expect(classifyFailure(wrapped, C)).toMatchObject({ errorCode: "subrequest_budget", halvePageSize: true });
  });

  it("maps auth and config errors to account statuses, audits and issues", () => {
    const auth = classifyFailure(new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" }), { ...C, provider: "gmail" });
    expect(auth).toMatchObject({ status: "needs_reauth", statusReason: "invalid_grant", audit: "reauth_required", raise: [] });
    const cfg = classifyFailure(new ProviderConfigError({ provider: "outlook", reason: "AADSTS7000222" }), C);
    expect(cfg).toMatchObject({ status: "config_error", statusReason: "AADSTS7000222", audit: "config_error", raise: ["microsoft_client_invalid"] });
    const gcfg = classifyFailure(new ProviderConfigError({ provider: "gmail", reason: "invalid_client" }), { ...C, provider: "gmail" });
    expect(gcfg.raise).toEqual(["google_client_invalid"]);
  });

  it("honors Retry-After and otherwise backs off exponentially from the attempt count", () => {
    expect(classifyFailure(new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 120_000 }), C).backoffUntil).toBe(NOW + 120_000);
    expect(classifyFailure(new ProviderUnavailableError({ provider: "outlook", retryAfterMs: null }), C).backoffUntil).toBe(NOW + MINUTE);
    expect(classifyFailure(new ProviderUnavailableError({ provider: "outlook", retryAfterMs: null }), { ...C, attempts: 2 }).backoffUntil).toBe(NOW + 4 * MINUTE);
  });

  it("raises Decision-1 configuration issues", () => {
    expect(classifyFailure(decisionError("auth", 401, false, "config"), C).raise).toEqual(["decision_auth_failed"]);
    expect(classifyFailure(decisionError("deployment_not_found", 404, false, "config"), C).raise).toEqual(["decision_deployment_not_found"]);
    expect(classifyFailure(new DecisionNotConfiguredError(), C)).toMatchObject({ errorCode: "decision_not_configured", raise: ["decision_not_configured"] });
    expect(classifyFailure(new DecisionOutageError(5, 5), C)).toMatchObject({ errorCode: "decision_outage", raise: [], backoffUntil: NOW + MINUTE });
  });

  it("treats unknown errors as internal", () => {
    expect(classifyFailure(new Error("boom"), C)).toMatchObject({ errorCode: "internal", status: "active", provider: null });
  });
});

describe("buildFailureWrite", () => {
  beforeEach(resetDb);

  it("marks the account, persists rotated tokens, audits the status change and releases the lease", async () => {
    await seedTickAccount();
    await env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'tick-1', ?3, ?4)")
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE).run();
    const err = new ProviderAuthError({ provider: "outlook", reason: "AADSTS70008" });
    const plan = classifyFailure(err, C);
    const tokens = await encryptTokenUpdate(await testEncKey(), { id: ACCOUNT_A, key_version: 1 },
      { accessToken: "a-2", accessExpiresAt: NOW + 3_600_000, refreshToken: "r-2" });
    const stmts = buildFailureWrite({ accountId: ACCOUNT_A, tickId: "tick-1", now: NOW, plan, tokens, issues: null });
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    expect(await getAccount(ACCOUNT_A)).toMatchObject({
      status: "needs_reauth", status_reason: "AADSTS70008", attempts: 1, last_error: err.code, last_tick_at: NOW,
    });
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("r-2");
    expect(await one("SELECT released_at FROM leases WHERE holder = 'tick-1'")).toEqual({ released_at: NOW });
    expect(await one("SELECT kind, result_json FROM audit_log WHERE account_id = ?1", ACCOUNT_A))
      .toEqual({ kind: "reauth_required", result_json: "{\"reason\":\"AADSTS70008\"}" });
  });

  it("halves page_size without a backoff on a subrequest budget failure", async () => {
    await seedTickAccount({ pageSize: 25 });
    const plan = classifyFailure(budgetError(), C);
    const stmts = buildFailureWrite({ accountId: ACCOUNT_A, tickId: "tick-1", now: NOW, plan, tokens: null, issues: null });
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ page_size: 12, backoff_until: null, attempts: 1, status: "active" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/failure.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/scan/failure.ts`.

- [ ] **Step 3: Write `failure.ts`**

`app/src/worker/scan/failure.ts`:

```ts
import {
  ClearboxError, CursorExpiredError, DecisionError, ProviderAuthError, ProviderConfigError, ProviderRateLimitError,
  ProviderResponseError, ProviderUnavailableError, SubrequestBudgetError, backoffMs,
} from "@clearbox/core";
import type { ProviderKind } from "@clearbox/core";
import type { AppIssue, AppIssueCode } from "../../shared/api.ts";
import type { TokenColumns } from "./tick-tokens.ts";
import { auditStmt, issuesStmt, leaseReleaseStmt, stmt } from "./write-plan.ts";
import type { Stmt } from "./write-plan.ts";

export class DecisionNotConfiguredError extends ClearboxError {
  constructor() {
    super("decision_not_configured", "Decision-1 endpoint, key or deployment is not configured");
  }
}

/** Most Decision-1 calls of a tick failed transiently: nothing is ingested and the account backs off. */
export class DecisionOutageError extends ClearboxError {
  readonly failures: number;
  readonly total: number;

  constructor(failures: number, total: number) {
    super("decision_outage", "Most Decision-1 calls failed transiently");
    this.failures = failures;
    this.total = total;
  }
}

export interface FailurePlan {
  errorCode: string;
  status: "active" | "needs_reauth" | "config_error";
  statusReason: string | null;
  backoffUntil: number | null;
  retryAfterMs: number | null;
  halvePageSize: boolean;
  audit: "reauth_required" | "config_error" | null;
  raise: AppIssueCode[];
  /** Set for provider failures (for the provider.error log event). */
  provider: { status: number | null } | null;
}

export interface ClassifyContext {
  provider: ProviderKind;
  attempts: number;
  now: number;
  random?: () => number;
}

/** Providers may wrap a fetch failure; the budget error can sit in the cause chain. */
function findBudgetError(err: unknown): SubrequestBudgetError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof SubrequestBudgetError) return cur;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return null;
}

export function classifyFailure(err: unknown, c: ClassifyContext): FailurePlan {
  const plan = (errorCode: string, retryAfterMs: number | null, extra: Partial<FailurePlan> = {}): FailurePlan => ({
    errorCode,
    status: "active",
    statusReason: null,
    retryAfterMs,
    backoffUntil: c.now + (retryAfterMs ?? backoffMs(c.attempts + 1, c.random)),
    halvePageSize: false,
    audit: null,
    raise: [],
    provider: null,
    ...extra,
  });
  const budget = findBudgetError(err);
  if (budget !== null) return plan(budget.code, null, { backoffUntil: null, halvePageSize: true });
  if (err instanceof ProviderAuthError) {
    return plan(err.code, null, {
      status: "needs_reauth", statusReason: err.reason, audit: "reauth_required", provider: { status: null },
    });
  }
  if (err instanceof ProviderConfigError) {
    return plan(err.code, null, {
      status: "config_error",
      statusReason: err.reason,
      audit: "config_error",
      raise: [err.provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid"],
      provider: { status: null },
    });
  }
  if (err instanceof ProviderRateLimitError) return plan(err.code, err.retryAfterMs, { provider: { status: 429 } });
  if (err instanceof ProviderUnavailableError) return plan(err.code, err.retryAfterMs, { provider: { status: null } });
  if (err instanceof ProviderResponseError) return plan(err.code, null, { provider: { status: err.status } });
  if (err instanceof CursorExpiredError) return plan(err.code, null, { provider: { status: null } });
  if (err instanceof DecisionNotConfiguredError) return plan(err.code, null, { raise: ["decision_not_configured"] });
  if (err instanceof DecisionError) {
    const raise: AppIssueCode[] =
      err.kind === "auth" ? ["decision_auth_failed"] : err.kind === "deployment_not_found" ? ["decision_deployment_not_found"] : [];
    return plan(err.code, err.retryAfterMs, { raise });
  }
  if (err instanceof ClearboxError) return plan(err.code, null);
  return plan("internal", null);
}

const ACCOUNT_FAILURE = `UPDATE accounts SET attempts = attempts + 1, backoff_until = ?2, status = ?3,
    status_reason = ?4, last_error = ?5,
    enc_access_token = COALESCE(?6, enc_access_token), access_iv = COALESCE(?7, access_iv),
    access_expires_at = COALESCE(?8, access_expires_at),
    enc_refresh_token = COALESCE(?9, enc_refresh_token), refresh_iv = COALESCE(?10, refresh_iv),
    page_size = CASE WHEN ?11 = 1 THEN MAX(5, page_size / 2) ELSE page_size END,
    last_tick_at = ?12, tick_finished_at = ?12, updated_at = ?12
  WHERE id = ?1 AND status <> 'disconnected'`;

export interface FailureWriteInput {
  accountId: string;
  tickId: string;
  now: number;
  plan: FailurePlan;
  /** Rotated tokens captured before the failure (Microsoft rotation must never be lost). */
  tokens: TokenColumns | null;
  issues: readonly AppIssue[] | null;
}

/** Contracts 8.2 "D1 call 3'": one batch, nothing ingested. */
export function buildFailureWrite(i: FailureWriteInput): Stmt[] {
  const t = i.tokens;
  const stmts: Stmt[] = [
    stmt(
      ACCOUNT_FAILURE, i.accountId, i.plan.backoffUntil, i.plan.status, i.plan.statusReason, i.plan.errorCode,
      t?.encAccess ?? null, t?.accessIv ?? null, t?.accessExpiresAt ?? null, t?.encRefresh ?? null, t?.refreshIv ?? null,
      i.plan.halvePageSize ? 1 : 0, i.now,
    ),
    leaseReleaseStmt(i.accountId, i.tickId, i.now),
  ];
  if (i.plan.audit !== null) {
    stmts.push(auditStmt(i.now, i.accountId, i.plan.audit, 1, { reason: i.plan.statusReason ?? i.plan.errorCode }));
  }
  if (i.issues !== null) stmts.push(issuesStmt(i.issues, i.now));
  return stmts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/failure.test.ts`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add app/src/worker/scan/failure.ts app/test/worker/tick/failure.test.ts
git commit -m "feat(scan): classify tick failures and build the failure write batch"
```

---

### Task 7: `runTick` success path

**Files:**
- Replace: `app/src/worker/scan/tick.ts` (plan 03's temporary stub)
- Test: `app/test/worker/tick/tick-backfill.test.ts`
- Test: `app/test/worker/tick/tick-incremental.test.ts`
- Test: `app/test/worker/tick/tick-scheduling.test.ts`
- Test: `app/test/worker/tick/tick-decisions.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2 to 6; `readConfig`, `importEncKey`, `withCount`, `logEvent`, `makeProvider` (plan 03); `TickKind`, `TickReport`, `AccountPhase`, `AppIssueCode` (`src/shared/api.ts`); `MailProvider.inboxEstimate` (plan 02, amendment A4).
- Produces:
  - `interface TickOptions { trigger: "cron" | "scan_now"; accountId?: string; now: number; engine?: DecisionEngine; fetch?: FetchLike }` (contracts 8.1).
  - `runTick(env: Env, opts: TickOptions): Promise<TickReport>`; throws `ApiError` only for `scan_now` pre-claim failures (contracts 7.5).
  - `interface TickTimings { wallMs: number; ioMs: number; pureMs: number }`; `interface TickInternals { subrequestLimit?: number; timings?: TickTimings }`; `runTickInternal(env, opts, internals): Promise<TickReport>` (tests and benchmark only).
  - `selectKind(account: Pick<TickAccountRow, "phase" | "last_incremental_at">, awaitingDue: number, now: number): TickKind`.

- [ ] **Step 1: Write the failing backfill tests**

`app/test/worker/tick/tick-backfill.test.ts`:

```ts
import { FakeEngine } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, MINUTE, NOW, OWNER, count, getAccount, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

const INBOX_FOLDER = "GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox";

describe("runTick: inbox backfill", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 30 }, (_, i) => mail(i, { listUnsubscribe: i % 2 === 0 }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("ingests one page, writes suggestions and counters, advances the cursor and records the budget", async () => {
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({
      outcome: "processed", accountId: ACCOUNT_A, kind: "inbox_backfill", phase: "inbox_backfill", fetched: 25,
      skippedKnown: 0, decided: 25, deferred: 0, errorCode: null, nextTickAt: new Date(NOW).toISOString(),
    });
    expect(report.subrequests).toBeGreaterThanOrEqual(5);
    expect(report.subrequests).toBeLessThanOrEqual(45);
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1 AND status = 'pending'", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1 AND action = 'delete'", ACCOUNT_A)).toBe(13);
    expect(await one("SELECT SUM(seen_count) AS n FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual({ n: 25 });
    const account = await getAccount(ACCOUNT_A);
    expect(account).toMatchObject({ last_tick_at: NOW, next_tick_at: NOW, messages_ingested: 25, attempts: 0, inbox_estimate: 30 });
    expect(account.backfill_cursor).not.toBeNull();
    expect(await one("SELECT released_at FROM leases WHERE account_id = ?1", ACCOUNT_A)).toEqual({ released_at: NOW });
    expect(await one("SELECT ticks, messages_ingested, rows_written FROM budget WHERE date = ?1", utcDate(NOW)))
      .toEqual({ ticks: 1, messages_ingested: 25, rows_written: report.rowsWritten });
  });

  it("finishes the backfill on later ticks and refreshes the inbox estimate at most once per UTC day", async () => {
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    for (let t = 1; t <= 4 && (await getAccount(ACCOUNT_A)).phase !== "incremental"; t++) {
      await runTick(env, { trigger: "cron", now: NOW + t * MINUTE, engine: new FakeEngine() });
    }
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(30);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "incremental", backfill_done: 1 });
    expect(mock.calls.filter((c) => c === INBOX_FOLDER)).toHaveLength(1);
  });

  it("is idempotent: re-reading the same page writes no duplicate rows", async () => {
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    await env.DB.prepare("UPDATE accounts SET backfill_cursor = NULL WHERE id = ?1").bind(ACCOUNT_A).run();
    const again = await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: new FakeEngine() });
    expect(again).toMatchObject({ fetched: 25, skippedKnown: 25, decided: 0 });
    expect(await count("messages", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await count("suggestions", "account_id = ?1", ACCOUNT_A)).toBe(25);
    expect(await one("SELECT SUM(seen_count) AS n FROM senders WHERE account_id = ?1", ACCOUNT_A)).toEqual({ n: 25 });
  });

  it("returns idle and writes nothing when the configuration is invalid", async () => {
    const before = await getAccount(ACCOUNT_A);
    const report = await runTick({ ...env, TOKEN_ENC_KEY: "" }, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report.outcome).toBe("idle");
    expect(await getAccount(ACCOUNT_A)).toEqual(before);
    expect(await count("leases")).toBe(0);
  });
});

describe("runTick: sent backfill", () => {
  beforeEach(resetDb);

  it("builds correspondents and replied threads, then moves to inbox backfill", async () => {
    const mock = new ProviderMock();
    mock.inboxTotal = 1234;
    mock.sent = Array.from({ length: 150 }, (_, i) => ({
      conversationId: `conv-s-${i}`, to: [`friend${i % 40}@example.net`, OWNER], sentAt: NOW - (i + 1) * MINUTE,
    }));
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "sent_backfill", lastIncrementalAt: null });
    const first = await runTick(env, { trigger: "cron", now: NOW });
    expect(first).toMatchObject({ outcome: "processed", kind: "sent_backfill", fetched: 100, decided: 0 });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "sent_backfill", sent_scanned: 100, inbox_estimate: 1234 });
    expect(await count("correspondents", "account_id = ?1", ACCOUNT_A)).toBe(40);
    expect(await count("correspondents", "address = ?1", OWNER)).toBe(0);
    const second = await runTick(env, { trigger: "cron", now: NOW + MINUTE });
    expect(second.fetched).toBe(50);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ phase: "inbox_backfill", sent_scanned: 150 });
    expect(await count("sent_threads", "account_id = ?1", ACCOUNT_A)).toBe(150);
    expect(await count("suggestions")).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing incremental test**

`app/test/worker/tick/tick-incremental.test.ts`:

```ts
import { FakeEngine, POLL_INTERVAL_MS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, DAY, NOW, count, getAccount, graphCursor, one, resetDb, seedMessage, seedTickAccount } from "../helpers/tick-db.ts";

describe("runTick: incremental", () => {
  beforeEach(resetDb);

  it("resyncs an expired cursor, ingests added mail, applies sent items and dismisses removed mail", async () => {
    const mock = new ProviderMock();
    mock.expiredTokens.add("expired-inbox");
    mock.inboxDelta.set("resync-inbox", {
      added: [mail(1, { from: "alice@example.net", conversationId: "conv-a" }), mail(2, { listUnsubscribe: true })],
      removed: ["gone-1"],
      next: "inbox-2",
    });
    mock.sentDelta.set("resync-sent", { items: [{ conversationId: "conv-x", to: ["alice@example.net"], sentAt: NOW - DAY }], next: "sent-2" });
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "incremental", incrementalCursor: graphCursor("expired-inbox", "sent-1", NOW - 2 * DAY) });
    const gone = await seedMessage(ACCOUNT_A, { providerId: "gone-1" });

    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });

    expect(report).toMatchObject({ outcome: "processed", kind: "incremental", fetched: 2, decided: 2, removed: 1 });
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", gone)).toEqual({ status: "dismissed" });
    expect(await count("correspondents", "account_id = ?1 AND address = 'alice@example.net'", ACCOUNT_A)).toBe(1);
    expect(await one(
      "SELECT s.ceiling FROM suggestions s JOIN messages m ON m.id = s.message_id WHERE m.account_id = ?1 AND m.provider_msg_id = 'msg-001'",
      ACCOUNT_A,
    )).toEqual({ ceiling: "keep" });
    const account = await getAccount(ACCOUNT_A);
    expect(account.incremental_cursor).toContain("inbox-2");
    expect(account).toMatchObject({ last_incremental_at: NOW, next_tick_at: NOW + POLL_INTERVAL_MS, phase: "incremental" });
    expect(mock.calls).toContain("GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta");
  });
});
```

- [ ] **Step 3: Write the failing scheduling tests**

`app/test/worker/tick/tick-scheduling.test.ts`:

```ts
import { FakeEngine, INGEST_STOP_ROWS, STORAGE_SOFT_LIMIT_BYTES } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick, runTickInternal, selectKind } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, MINUTE, NOW, count, getAccount, one, resetDb, seedTickAccount, setBudget } from "../helpers/tick-db.ts";

describe("selectKind", () => {
  it("prefers due re-decisions, then the sent scan, then interleaves incremental polls with backfill", () => {
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW }, 1, NOW)).toBe("redecide");
    expect(selectKind({ phase: "sent_backfill", last_incremental_at: null }, 0, NOW)).toBe("sent_backfill");
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: null }, 0, NOW)).toBe("incremental");
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW - 31 * MINUTE }, 0, NOW)).toBe("incremental");
    expect(selectKind({ phase: "inbox_backfill", last_incremental_at: NOW - MINUTE }, 0, NOW)).toBe("inbox_backfill");
    expect(selectKind({ phase: "incremental", last_incremental_at: NOW }, 0, NOW)).toBe("incremental");
  });
});

describe("runTick: leases, gates and the subrequest budget", () => {
  let mock: ProviderMock;
  let decision: DecisionMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("lets only one of two concurrent ticks claim the account", async () => {
    const reports = await Promise.all([
      runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }),
      runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }),
    ]);
    expect(reports.map((r) => r.outcome).sort()).toEqual(["idle", "processed"]);
    expect(await count("messages")).toBe(5);
  });

  it("refuses scan-now while another tick holds the lease", async () => {
    await env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'other', ?3, ?4)")
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, NOW, NOW + 5 * MINUTE).run();
    await expect(runTick(env, { trigger: "scan_now", accountId: ACCOUNT_A, now: NOW, engine: new FakeEngine() }))
      .rejects.toMatchObject({ status: 409, code: "account_busy" });
    expect((await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() })).outcome).toBe("idle");
  });

  it("writes nothing when the daily ingest budget is exhausted and reports the next UTC day", async () => {
    await setBudget(utcDate(NOW), INGEST_STOP_ROWS);
    const before = await getAccount(ACCOUNT_A);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "idle", nextTickAt: "2026-10-16T00:00:00.000Z", rowsWritten: 0 });
    expect(await getAccount(ACCOUNT_A)).toEqual(before);
    expect(await count("leases")).toBe(0);
    expect(await one("SELECT rows_written, ticks FROM budget WHERE date = ?1", utcDate(NOW))).toEqual({ rows_written: INGEST_STOP_ROWS, ticks: 0 });
    await expect(runTick(env, { trigger: "scan_now", accountId: ACCOUNT_A, now: NOW, engine: new FakeEngine() }))
      .rejects.toMatchObject({ status: 429, code: "budget_exhausted" });
  });

  it("decides only what fits in the subrequest budget, keeps the cursor and finishes on the next tick", async () => {
    const first = await runTickInternal(env, { trigger: "cron", now: NOW }, { subrequestLimit: 9 });
    expect(first).toMatchObject({ outcome: "processed", decided: 3, nextTickAt: new Date(NOW).toISOString() });
    expect(first.subrequests).toBeLessThanOrEqual(9);
    expect(await count("messages")).toBe(3);
    expect((await getAccount(ACCOUNT_A)).backfill_cursor).toBeNull();
    const second = await runTickInternal(env, { trigger: "cron", now: NOW + MINUTE }, { subrequestLimit: 9 });
    expect(second).toMatchObject({ skippedKnown: 3, decided: 2 });
    expect(second.subrequests).toBeLessThanOrEqual(9);
    expect(await count("messages")).toBe(5);
    expect(decision.calls).toBe(5);
  });

  it("switches backfill to incremental and raises storage_near_limit near the database size limit", async () => {
    await setBudget(utcDate(NOW), 0, STORAGE_SOFT_LIMIT_BYTES);
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report.kind).toBe("incremental");
    const issues = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'");
    expect(JSON.parse(issues?.value ?? "[]")).toEqual([expect.objectContaining({ code: "storage_near_limit", accountId: null })]);
  });
});
```

- [ ] **Step 4: Write the failing Decision-1 outcome tests**

`app/test/worker/tick/tick-decisions.test.ts`:

```ts
import { FakeEngine } from "@clearbox/core";
import type { DecisionError } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/worker/scan/tick.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { ACCOUNT_A, DAY, MINUTE, NOW, getAccount, graphCursor, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

const RETRYABLE = decisionError("server", 503, true, "item");

function engine(failing: Record<string, DecisionError> = {}): FakeEngine {
  return new FakeEngine({ overrides: new Map(Object.entries(failing)) });
}

async function suggestion(providerId: string) {
  return one<{ status: string; action: string | null; decision_attempts: number; retry_after: number | null; reasons_json: string }>(
    `SELECT s.status, s.action, s.decision_attempts, s.retry_after, s.reasons_json
     FROM suggestions s JOIN messages m ON m.id = s.message_id
     WHERE m.account_id = ?1 AND m.provider_msg_id = ?2`,
    ACCOUNT_A, providerId,
  );
}

describe("runTick: Decision-1 outcomes", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inboxDelta.set("inbox-1", {
      added: Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true })),
      removed: [],
      next: "inbox-2",
    });
    useNetwork(mock.handlers());
    await seedTickAccount({ phase: "incremental", incrementalCursor: graphCursor("inbox-1", "sent-1", NOW - DAY) });
  });

  it("defers an isolated transient failure, schedules the retry and re-decides it 5 minutes later", async () => {
    const first = await runTick(env, { trigger: "cron", now: NOW, engine: engine({ "msg-002": RETRYABLE }) });
    expect(first).toMatchObject({ kind: "incremental", decided: 4, deferred: 1 });
    expect(await suggestion("msg-002")).toMatchObject({ status: "awaiting_model", decision_attempts: 1, retry_after: NOW + 5 * MINUTE });
    // Caught up would mean a 30-minute poll; the pending retry pulls the next tick forward (C7).
    expect((await getAccount(ACCOUNT_A)).next_tick_at).toBe(NOW + 5 * MINUTE);
    expect((await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: engine() })).outcome).toBe("idle");

    const redecide = await runTick(env, { trigger: "cron", now: NOW + 5 * MINUTE, engine: engine() });
    expect(redecide).toMatchObject({ kind: "redecide", decided: 1, deferred: 0, fetched: 0 });
    expect(await suggestion("msg-002")).toMatchObject({ status: "pending", decision_attempts: 2, retry_after: null });
  });

  it("falls back to unsure after three failed attempts", async () => {
    const failing = engine({ "msg-002": RETRYABLE });
    await runTick(env, { trigger: "cron", now: NOW, engine: failing });
    await runTick(env, { trigger: "cron", now: NOW + 5 * MINUTE, engine: failing });
    expect(await suggestion("msg-002")).toMatchObject({ status: "awaiting_model", decision_attempts: 2, retry_after: NOW + 35 * MINUTE });
    const last = await runTick(env, { trigger: "cron", now: NOW + 35 * MINUTE, engine: failing });
    expect(last).toMatchObject({ kind: "redecide", unsure: 1 });
    const row = await suggestion("msg-002");
    expect(row).toMatchObject({ status: "pending", action: "unsure", decision_attempts: 3 });
    expect(row?.reasons_json).toContain("model_unavailable");
  });

  it("stores a non-retryable item failure as unsure right away", async () => {
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: engine({ "msg-003": decisionError("unprocessable", 422, false, "item") }) });
    expect(report).toMatchObject({ decided: 4, deferred: 0 });
    expect(report.unsure).toBeGreaterThanOrEqual(1);
    expect(await suggestion("msg-003")).toMatchObject({ status: "pending", action: "unsure", decision_attempts: 1 });
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-backfill.test.ts test/worker/tick/tick-incremental.test.ts test/worker/tick/tick-scheduling.test.ts test/worker/tick/tick-decisions.test.ts`
Expected: FAIL. With plan 03's stub, `runTickInternal` and `selectKind` are not exported (`does not provide an export named 'runTickInternal'`) and the stub's `runTick` returns no report.

- [ ] **Step 6: Write `tick.ts`**

Replace the whole content of `app/src/worker/scan/tick.ts`:

```ts
import {
  CursorExpiredError, DELETE_MARGIN, INGEST_STOP_ROWS, MIN_CONFIDENCE, PAGE_SIZE_FREE, PAGE_SIZE_PAID,
  POLL_INTERVAL_MS, SENT_PAGE_SIZE, STORAGE_SOFT_LIMIT_BYTES, TICK_SUBREQUEST_LIMIT, countingFetch,
  createSubrequestCounter,
} from "@clearbox/core";
import type {
  ChangesPage, DecisionEngine, FetchLike, InboxPage, MailMessage, MailProvider, SentItem, SentPage, SubrequestCounter,
} from "@clearbox/core";
import type { AccountPhase, AppIssueCode, TickKind, TickReport } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { withCount } from "../db/sql.ts";
import { readConfig } from "../env.ts";
import { logEvent } from "../log.ts";
import { claimStatements, parseClaim, parseTickSettings, scanNowError } from "./claim.ts";
import type { TickAccountRow, TickSettings } from "./claim.ts";
import { freshContextStatements, parseContext, redecideContextStatements } from "./context.ts";
import { makeDecisionEngine } from "./engine.ts";
import { DecisionNotConfiguredError, DecisionOutageError } from "./failure.ts";
import { decideStage, emptyStage, finalize, freshKeys, identify, prepareFresh, prepareRedecide } from "./ingest.ts";
import type { DecideStage, FinalItem, IngestSettings, PreparedItem } from "./ingest.ts";
import { makeProvider } from "./providers.ts";
import { encryptTokenUpdate, openTickTokens, providerTargetOf } from "./tick-tokens.ts";
import type { D1TokenSource } from "./token-source.ts";
import {
  applyIssues, budgetUpsertStmt, buildSuccessWrite, computeAdvance, isoOf, lastSizeAfter, nextUtcMidnight, rowsOf,
  sumMeta, utcDate,
} from "./write-plan.ts";
import type { AccountAdvance, BatchResult, IssueChange, IssueRaise, PageOutcome, Stmt, SuccessWrite } from "./write-plan.ts";

/** Contracts 8.1. */
export interface TickOptions {
  trigger: "cron" | "scan_now";
  /** Required for scan_now. */
  accountId?: string;
  now: number;
  /** Tests inject FakeEngine; default makeDecisionEngine(env, countingFetch). */
  engine?: DecisionEngine;
  /** Tests may inject; default globalThis.fetch. */
  fetch?: FetchLike;
}

/** Filled by runTickInternal: pure compute, awaited I/O, and total wall time, in ms. */
export interface TickTimings {
  wallMs: number;
  ioMs: number;
  pureMs: number;
}

export interface TickInternals {
  subrequestLimit?: number;
  timings?: TickTimings;
}

/** The final write and the budget upsert always fit (contracts C9 decision). */
const FINAL_D1_CALLS = 2;
const PAID_TICK_SUBREQUEST_LIMIT = 500;
const DECISION_ISSUES: readonly AppIssueCode[] = [
  "decision_not_configured", "decision_auth_failed", "decision_deployment_not_found",
];

class Stopwatch {
  readonly t: TickTimings;

  constructor(t?: TickTimings) {
    this.t = t ?? { wallMs: 0, ioMs: 0, pureMs: 0 };
  }

  pure<T>(fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.t.pureMs += performance.now() - start;
    }
  }

  async io<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.t.ioMs += performance.now() - start;
    }
  }
}

type Runner = (counter: SubrequestCounter, stmts: readonly Stmt[]) => Promise<BatchResult[]>;

function runner(db: D1Database, watch: Stopwatch): Runner {
  return (counter, stmts) =>
    watch.io(() => withCount(counter, () => db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)))));
}

function tally(f: FetchLike): { fetch: FetchLike; count: () => number } {
  let n = 0;
  return {
    fetch: (input, init) => {
      n += 1;
      return f(input, init);
    },
    count: () => n,
  };
}

export function selectKind(
  a: Pick<TickAccountRow, "phase" | "last_incremental_at">,
  awaitingDue: number,
  now: number,
): TickKind {
  if (awaitingDue > 0) return "redecide";
  if (a.phase === "sent_backfill") return "sent_backfill";
  if (a.phase === "incremental" || a.last_incremental_at === null || now - a.last_incremental_at >= POLL_INTERVAL_MS) {
    return "incremental";
  }
  return "inbox_backfill";
}

function ownerAddresses(a: TickAccountRow): string[] {
  let aliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(a.owner_aliases_json);
    if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    aliases = [];
  }
  return [a.email, ...aliases].map((x) => x.toLowerCase());
}

/** Amendment A4: during backfill, refresh when unknown or on the first tick of a UTC day. */
function shouldRefreshEstimate(a: TickAccountRow, kind: TickKind, now: number): boolean {
  if (kind !== "sent_backfill" && kind !== "inbox_backfill") return false;
  return a.inbox_estimate === null || a.last_tick_at === null || utcDate(a.last_tick_at) !== utcDate(now);
}

/** Best effort: any failure keeps the stored estimate. */
async function fetchInboxEstimate(provider: MailProvider): Promise<number | null> {
  try {
    return await provider.inboxEstimate();
  } catch {
    return null;
  }
}

type Fetched =
  | { kind: "sent_backfill"; page: SentPage }
  | { kind: "inbox_backfill"; page: InboxPage }
  | { kind: "incremental"; page: ChangesPage; startCursor: string }
  | { kind: "redecide" };

/** One provider page; sequential requests only. Expired cursors restart (backfill, sent) or resync (incremental). */
async function fetchPage(kind: TickKind, provider: MailProvider, a: TickAccountRow): Promise<Fetched> {
  switch (kind) {
    case "sent_backfill":
      try {
        return { kind, page: await provider.listSentPage(a.sent_cursor, SENT_PAGE_SIZE) };
      } catch (err) {
        if (!(err instanceof CursorExpiredError) || a.sent_cursor === null) throw err;
        return { kind, page: await provider.listSentPage(null, SENT_PAGE_SIZE) };
      }
    case "inbox_backfill":
      try {
        return { kind, page: await provider.listInboxPage(a.backfill_cursor, a.page_size) };
      } catch (err) {
        if (!(err instanceof CursorExpiredError) || a.backfill_cursor === null) throw err;
        return { kind, page: await provider.listInboxPage(null, a.page_size) };
      }
    case "incremental":
      try {
        return { kind, page: await provider.syncChanges(a.incremental_cursor, a.page_size), startCursor: a.incremental_cursor };
      } catch (err) {
        if (!(err instanceof CursorExpiredError)) throw err;
        const cursor = await provider.resyncCursor(a.watermark_received_at);
        return { kind, page: await provider.syncChanges(cursor, a.page_size), startCursor: cursor };
      }
    case "redecide":
      return { kind };
  }
}

interface DecisionStats {
  decided: number;
  deferred: number;
  unsure: number;
  calls: number;
  failures: number;
  inputTokens: number;
  latencies: number[];
}

function emptyStats(): DecisionStats {
  return { decided: 0, deferred: 0, unsure: 0, calls: 0, failures: 0, inputTokens: 0, latencies: [] };
}

function decisionStats(stage: DecideStage, finals: readonly FinalItem[]): DecisionStats {
  const stats = emptyStats();
  stats.calls = stage.outcomes.length;
  for (const o of stage.outcomes) {
    if (o.ok) {
      stats.decided += 1;
      stats.inputTokens += o.result.inputTokens;
      stats.latencies.push(o.result.latencyMs);
    } else {
      stats.failures += 1;
    }
  }
  stats.deferred = finals.filter((f) => f.status === "awaiting_model").length;
  stats.unsure = finals.filter((f) => f.status === "pending" && f.suggestion?.action === "unsure").length;
  return stats;
}

function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function logDecisionErrors(stage: DecideStage, tickId: string, accountId: string): void {
  for (const o of stage.outcomes) {
    if (o.ok) continue;
    logEvent("decision.error", {
      tickId, accountId, messageId: null, kind: o.error.kind, status: o.error.status, requestId: o.error.requestId,
    });
  }
}

interface ProcessParams {
  env: Env;
  account: TickAccountRow;
  kind: TickKind;
  now: number;
  tickId: string;
  settings: TickSettings;
  engine: DecisionEngine | undefined;
  providerFetch: FetchLike;
  decisionFetch: FetchLike;
  tokens: D1TokenSource;
  encKey: CryptoKey;
  work: SubrequestCounter;
  run: Runner;
  watch: Stopwatch;
  raise: IssueRaise[];
  clear: AppIssueCode[];
  maxPageSize: number;
}

interface Processed {
  write: SuccessWrite;
  advance: AccountAdvance;
  issues: IssueChange;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  freshCount: number;
  rowsRead: number;
}

/** Fetch, context, decide, fuse and build the write batch. Throws on any tick-level failure. */
async function processAccount(p: ProcessParams): Promise<Processed> {
  const { account, kind, now, watch } = p;
  const needsEngine = kind !== "sent_backfill";
  const engine = needsEngine ? (p.engine ?? makeDecisionEngine(p.env, p.decisionFetch)) : null;
  if (needsEngine && engine === null) throw new DecisionNotConfiguredError();
  const provider = makeProvider(providerTargetOf(account), { fetch: p.providerFetch, tokens: p.tokens, now: () => now });
  const inboxEstimate = shouldRefreshEstimate(account, kind, now) ? await fetchInboxEstimate(provider) : null;
  const fetched = await fetchPage(kind, provider, account);
  const s: IngestSettings = {
    policy: p.settings.policy,
    thresholds: { tauDelete: p.settings.tauDelete, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE },
    ownerAddresses: ownerAddresses(account),
    now,
    accountId: account.id,
  };

  let items: PreparedItem[] = [];
  let sent: readonly SentItem[] = [];
  let removedIds: readonly string[] = [];
  let fetchedCount = 0;
  let skippedKnown = 0;
  let rowsRead = 0;
  if (fetched.kind === "sent_backfill") {
    sent = fetched.page.items;
    fetchedCount = sent.length;
  } else if (fetched.kind === "redecide") {
    const tagged = redecideContextStatements(account.id, now, account.page_size);
    const res = await p.run(p.work, tagged.map((t) => t.stmt));
    rowsRead += sumMeta(res, "rows_read");
    items = watch.pure(() => {
      const parsed = parseContext(tagged, res);
      return prepareRedecide(parsed.redecideRows, parsed.ctx, s);
    });
  } else {
    const messages: readonly MailMessage[] = fetched.kind === "inbox_backfill" ? fetched.page.messages : fetched.page.added;
    if (fetched.kind === "incremental") {
      sent = fetched.page.sent;
      removedIds = fetched.page.removedIds;
    }
    fetchedCount = messages.length;
    if (messages.length > 0) {
      const ids = watch.pure(() => identify(messages, s));
      const tagged = freshContextStatements(account.id, watch.pure(() => freshKeys(messages, ids)));
      const res = await p.run(p.work, tagged.map((t) => t.stmt));
      rowsRead += sumMeta(res, "rows_read");
      const prepared = watch.pure(() => prepareFresh(messages, ids, parseContext(tagged, res).ctx, sent, s));
      items = prepared.items;
      skippedKnown = prepared.skippedKnown;
    }
  }

  const stage = engine === null || items.length === 0 ? emptyStage() : await decideStage(engine, items, p.work);
  logDecisionErrors(stage, p.tickId, account.id);
  if (stage.configError !== null) throw stage.configError;
  if (stage.outage) throw new DecisionOutageError(stage.retryableFailures, stage.processed.length);
  const finals = watch.pure(() => finalize(stage, s.thresholds, now));
  const fresh = finals.filter((f) => f.existingMessageId === null);
  const maxReceived = fresh.reduce<number | null>((m, f) => (m === null || f.msg.receivedAt > m ? f.msg.receivedAt : m), null);
  const outcome: PageOutcome =
    fetched.kind === "sent_backfill"
      ? { kind: "sent_backfill", itemCount: fetched.page.items.length, nextCursor: fetched.page.nextCursor }
      : fetched.kind === "inbox_backfill"
        ? { kind: "inbox_backfill", nextCursor: fetched.page.nextCursor, partial: stage.partial }
        : fetched.kind === "incremental"
          ? {
              kind: "incremental", startCursor: fetched.startCursor, nextCursor: fetched.page.nextCursor,
              caughtUp: fetched.page.caughtUp, partial: stage.partial,
            }
          : { kind: "redecide" };
  const advance = computeAdvance(account, outcome, maxReceived, now);
  const stats = decisionStats(stage, finals);

  const clear = [...p.clear];
  if (stats.decided > 0) clear.push(...DECISION_ISSUES);
  const update = p.tokens.update;
  if (update !== null) clear.push(account.provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid");
  const issues = applyIssues(p.settings.issues, p.raise, clear, now);
  const tokens = update === null ? null : await encryptTokenUpdate(p.encKey, account, update);
  const write = watch.pure(() =>
    buildSuccessWrite({
      accountId: account.id, tickId: p.tickId, now, policyVersion: p.settings.policyVersion,
      storeSnippets: p.settings.policy.storeSnippets, items: finals, sent, ownerAddresses: s.ownerAddresses, removedIds,
      issues: issues.changed ? issues.issues : null, advance, tokens, maxPageSize: p.maxPageSize, inboxEstimate,
    }),
  );
  return { write, advance, issues, stats, fetched: fetchedCount, skippedKnown, freshCount: fresh.length, rowsRead };
}

interface TickResult {
  outcome: "processed" | "error";
  phase: AccountPhase;
  nextTickAt: number | null;
  errorCode: string | null;
  freshCount: number;
  rowsWritten: number;
  rowsRead: number;
  dbSize: number;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  removed: number;
  issues: IssueChange | null;
}

function successResult(p: Processed, res: readonly BatchResult[]): TickResult {
  return {
    outcome: "processed",
    phase: p.advance.phase,
    nextTickAt: rowsOf<{ next_tick_at: number }>(res[p.write.nextTickIndex])[0]?.next_tick_at ?? p.advance.nextTickAt,
    errorCode: null,
    freshCount: p.freshCount,
    rowsWritten: sumMeta(res, "rows_written"),
    rowsRead: p.rowsRead + sumMeta(res, "rows_read"),
    dbSize: lastSizeAfter(res),
    stats: p.stats,
    fetched: p.fetched,
    skippedKnown: p.skippedKnown,
    removed: p.write.dismissals.reduce((n, i) => n + (res[i]?.meta?.changes ?? 0), 0),
    issues: p.issues,
  };
}

function idleReport(subrequests: number, nextTickAt: number | null): TickReport {
  return {
    outcome: "idle", accountId: null, kind: null, phase: null, fetched: 0, skippedKnown: 0, decided: 0, deferred: 0,
    unsure: 0, removed: 0, subrequests, rowsWritten: 0, nextTickAt: nextTickAt === null ? null : isoOf(nextTickAt),
    errorCode: null,
  };
}

interface FinishParams {
  run: Runner;
  final: SubrequestCounter;
  claimRowsWritten: number;
  claimRowsRead: number;
  result: TickResult;
  account: TickAccountRow;
  kind: TickKind;
  tickId: string;
  today: string;
  now: number;
  providerCalls: number;
  startedAt: number;
}

/** D1 call 4 (budget), logs and the report. */
async function finishTick(f: FinishParams): Promise<TickReport> {
  const r = f.result;
  const rowsWritten = f.claimRowsWritten + r.rowsWritten + 1;
  try {
    await f.run(f.final, [
      budgetUpsertStmt({
        date: f.today, rowsWritten, rowsRead: f.claimRowsRead + r.rowsRead, ticks: 1, messagesIngested: r.freshCount,
        decisionCalls: r.stats.calls, decisionFailures: r.stats.failures, decisionInputTokens: r.stats.inputTokens,
        providerCalls: f.providerCalls, dbSizeBytes: r.dbSize, now: f.now,
      }),
    ]);
  } catch {
    logEvent("tick.failed", {
      tickId: f.tickId, accountId: f.account.id, kind: f.kind, errorCode: "budget_write_failed",
      attempts: f.account.attempts, retryAfterMs: null,
    });
  }
  for (const code of r.issues?.raised ?? []) logEvent("issue.raised", { code, accountId: null });
  for (const code of r.issues?.cleared ?? []) logEvent("issue.cleared", { code, accountId: null });
  if (r.outcome === "processed") {
    logEvent("tick.done", {
      tickId: f.tickId, accountId: f.account.id, kind: f.kind, fetched: r.fetched, skippedKnown: r.skippedKnown,
      decided: r.stats.decided, deferred: r.stats.deferred, unsure: r.stats.unsure, removed: r.removed,
      subrequests: f.final.used, rowsWritten, rowsRead: f.claimRowsRead + r.rowsRead, inputTokens: r.stats.inputTokens,
      decisionP50Ms: percentile(r.stats.latencies, 0.5), decisionP95Ms: percentile(r.stats.latencies, 0.95),
      durationMs: Math.round(performance.now() - f.startedAt),
    });
  }
  return {
    outcome: r.outcome, accountId: f.account.id, kind: f.kind, phase: r.phase, fetched: r.fetched,
    skippedKnown: r.skippedKnown, decided: r.stats.decided, deferred: r.stats.deferred, unsure: r.stats.unsure,
    removed: r.removed, subrequests: f.final.used, rowsWritten,
    nextTickAt: r.nextTickAt === null ? null : isoOf(r.nextTickAt), errorCode: r.errorCode,
  };
}

async function tick(env: Env, opts: TickOptions, internals: TickInternals, watch: Stopwatch): Promise<TickReport> {
  const startedAt = performance.now();
  const config = readConfig(env);
  if (!config.ok) {
    logEvent("config.invalid", { missing: config.invalid.join(",") });
    return idleReport(0, null);
  }
  const now = opts.now;
  const tickId = crypto.randomUUID();
  const freeTier = env.FREE_TIER !== "false";
  const limit = internals.subrequestLimit ?? (freeTier ? TICK_SUBREQUEST_LIMIT : PAID_TICK_SUBREQUEST_LIMIT);
  const stopRows = freeTier ? INGEST_STOP_ROWS : Number.MAX_SAFE_INTEGER;
  const work = createSubrequestCounter(Math.max(1, limit - FINAL_D1_CALLS));
  const base: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const counted = countingFetch((input, init) => watch.io(() => base(input, init)), work);
  const providerFetch = tally(counted);
  const decisionFetch = tally(counted);
  const run = runner(env.DB, watch);
  const today = utcDate(now);

  // D1 call 1: claim.
  const claimResults = await run(
    work,
    claimStatements({ tickId, now, accountId: opts.accountId ?? null, force: opts.trigger === "scan_now", today, stopRows }),
  );
  const claim = parseClaim(claimResults);
  const account = claim.account;
  if (claim.claimedAccountId === null || account === null) {
    if (opts.trigger === "scan_now") throw scanNowError(claim, now, stopRows);
    const rowsWritten = claim.budget?.rows_written ?? 0;
    const gated = rowsWritten >= stopRows;
    if (gated) logEvent("budget.gate", { date: today, rowsWritten, gate: "ingest" });
    logEvent("tick.idle", { tickId, trigger: opts.trigger });
    return idleReport(work.used, gated ? nextUtcMidnight(now) : null);
  }

  const settings = parseTickSettings(claim.settings);
  let kind = selectKind(account, claim.awaitingDue, now);
  const raise: IssueRaise[] = [];
  const clear: AppIssueCode[] = [];
  if ((claim.budget?.db_size_bytes ?? 0) >= STORAGE_SOFT_LIMIT_BYTES) {
    if (kind === "inbox_backfill") {
      raise.push({ code: "storage_near_limit", accountId: null });
      kind = "incremental";
    }
  } else {
    clear.push("storage_near_limit");
  }
  logEvent("tick.claimed", {
    tickId, trigger: opts.trigger, accountId: account.id, kind, phase: account.phase, pageSize: account.page_size,
  });
  const encKey = await importEncKey(config.config.tokenEncKey);
  const tokens = openTickTokens({ row: account, config: config.config, encKey, fetch: providerFetch.fetch, now });
  const params: ProcessParams = {
    env, account, kind, now, tickId, settings, engine: opts.engine, providerFetch: providerFetch.fetch,
    decisionFetch: decisionFetch.fetch, tokens, encKey, work, run, watch, raise, clear,
    maxPageSize: freeTier ? PAGE_SIZE_FREE : PAGE_SIZE_PAID,
  };

  // Success path. Task 8 wraps these four statements in the failure handler.
  const processed = await processAccount(params);
  const final = createSubrequestCounter(limit, work.used);
  const finalResults = await run(final, processed.write.stmts);
  const result = successResult(processed, finalResults);

  return finishTick({
    run, final, claimRowsWritten: claim.rowsWritten, claimRowsRead: claim.rowsRead, result, account, kind, tickId,
    today, now, providerCalls: providerFetch.count(), startedAt,
  });
}

export async function runTickInternal(env: Env, opts: TickOptions, internals: TickInternals): Promise<TickReport> {
  const watch = new Stopwatch(internals.timings);
  const start = performance.now();
  try {
    return await tick(env, opts, internals, watch);
  } finally {
    watch.t.wallMs += performance.now() - start;
  }
}

/** The single tick code path for the cron and POST /api/accounts/:id/scan (contracts 8.1). */
export function runTick(env: Env, opts: TickOptions): Promise<TickReport> {
  return runTickInternal(env, opts, {});
}
```

- [ ] **Step 7: Run the tick tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/`
Expected: every file in `test/worker/tick/` passes (`Test Files  12 passed (12)`: surface, harness, claim, tick-tokens, ingest, context, write-plan, failure, tick-backfill, tick-incremental, tick-scheduling, tick-decisions).

If `tick-backfill` reports a delete count other than 13, check that the Graph provider (plan 02) maps `List-Unsubscribe` from `internetMessageHeaders`; this assertion is the end-to-end check of that mapping, do not weaken it.

- [ ] **Step 8: Typecheck and lint**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add app/src/worker/scan/tick.ts app/test/worker/tick/tick-backfill.test.ts app/test/worker/tick/tick-incremental.test.ts app/test/worker/tick/tick-scheduling.test.ts app/test/worker/tick/tick-decisions.test.ts
git commit -m "feat(scan): run one tick per minute: claim, fetch, decide, fuse, write, budget"
```

---

### Task 8: Tick failure path (backoff, re-auth, config errors, outages)

**Files:**
- Modify: `app/src/worker/scan/tick.ts` (one import line, the success block in `tick()`, one new function)
- Test: `app/test/worker/tick/tick-failures.test.ts`

**Interfaces:**
- Consumes: `classifyFailure`, `buildFailureWrite` (Task 6); `encryptTokenUpdate`, the `D1TokenSource.update` getter (Task 3, plan 03); `applyIssues` (Task 5).
- Produces: `runTick` never throws for claimed accounts: any failure after the claim is persisted as `attempts + 1`, `backoff_until`, `status` (`needs_reauth`, `config_error` or unchanged), `status_reason`, `last_error`, rotated tokens, lease release, audit row and issues, and returned as `TickReport { outcome: "error", errorCode }`.

- [ ] **Step 1: Write the failing tests**

`app/test/worker/tick/tick-failures.test.ts`:

```ts
import { FakeEngine } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick, runTickInternal } from "../../../src/worker/scan/tick.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { decisionError } from "../helpers/decision-mock.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import {
  ACCOUNT_A, MINUTE, NOW, count, decryptAccountToken, getAccount, one, resetDb, seedTickAccount,
} from "../helpers/tick-db.ts";

async function issueCodes(): Promise<string[]> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'issues'");
  return (JSON.parse(row?.value ?? "[]") as { code: string }[]).map((i) => i.code);
}

describe("runTick: failures", () => {
  let mock: ProviderMock;

  beforeEach(async () => {
    await resetDb();
    mock = new ProviderMock();
    mock.inbox = Array.from({ length: 5 }, (_, i) => mail(i, { listUnsubscribe: true }));
    useNetwork(mock.handlers());
  });

  it("backs off for the provider's Retry-After and retries after it", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    mock.failNext({ method: "GET", pathIncludes: "/inbox/messages", status: 429, headers: { "Retry-After": "120" },
      body: { error: { code: "TooManyRequests", message: "Please retry again later." } } });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "error", nextTickAt: new Date(NOW + 120_000).toISOString() });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ status: "active", attempts: 1, backoff_until: NOW + 120_000 });
    expect((await getAccount(ACCOUNT_A)).last_error).not.toBeNull();
    expect(await count("messages")).toBe(0);
    expect(await one("SELECT released_at FROM leases WHERE account_id = ?1", ACCOUNT_A)).toEqual({ released_at: NOW });
    expect(await one("SELECT ticks FROM budget WHERE date = ?1", utcDate(NOW))).toEqual({ ticks: 1 });
    expect((await runTick(env, { trigger: "cron", now: NOW + MINUTE, engine: new FakeEngine() })).outcome).toBe("idle");
    const retried = await runTick(env, { trigger: "cron", now: NOW + 121_000, engine: new FakeEngine() });
    expect(retried.outcome).toBe("processed");
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ attempts: 0, backoff_until: null, last_error: null });
  });

  it("marks a Gmail account needs_reauth on invalid_grant and stops ticking it", async () => {
    await seedTickAccount({ provider: "gmail", accessToken: null, phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    mock.googleToken = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report).toMatchObject({ outcome: "error", nextTickAt: null });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ status: "needs_reauth", status_reason: "invalid_grant", attempts: 1 });
    expect(await one("SELECT kind FROM audit_log WHERE account_id = ?1", ACCOUNT_A)).toEqual({ kind: "reauth_required" });
    expect((await runTick(env, { trigger: "cron", now: NOW + 7 * 60 * MINUTE, engine: new FakeEngine() })).outcome).toBe("idle");
  });

  it("marks an Outlook account config_error on an expired client secret and raises an app issue", async () => {
    await seedTickAccount({ provider: "outlook", accessToken: null, phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    mock.microsoftToken = { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000222: The provided client secret keys are expired." } };
    await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ status: "config_error" });
    expect(await issueCodes()).toContain("microsoft_client_invalid");
    expect(await one("SELECT kind FROM audit_log WHERE account_id = ?1", ACCOUNT_A)).toEqual({ kind: "config_error" });
  });

  it("persists a rotated Microsoft refresh token even when the page fetch then fails", async () => {
    await seedTickAccount({ provider: "outlook", accessToken: null, phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    mock.failNext({ method: "GET", pathIncludes: "/inbox/messages", status: 503, times: 2 });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine: new FakeEngine() });
    expect(report.outcome).toBe("error");
    expect(await decryptAccountToken(ACCOUNT_A, "refresh")).toBe("ms-refresh-2");
    expect(await decryptAccountToken(ACCOUNT_A, "access")).toBe("ms-access-2");
    expect((await getAccount(ACCOUNT_A)).status).toBe("active");
  });

  it("aborts without ingesting when most Decision-1 calls fail transiently", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const err = decisionError("server", 503, true, "item");
    const engine = new FakeEngine({ overrides: new Map(mock.inbox.map((m) => [m.id, err])) });
    const report = await runTick(env, { trigger: "cron", now: NOW, engine });
    expect(report).toMatchObject({ outcome: "error", errorCode: "decision_outage" });
    expect(await count("messages")).toBe(0);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ attempts: 1, backfill_cursor: null });
    expect((await getAccount(ACCOUNT_A)).backoff_until).toBeGreaterThan(NOW);
  });

  it("raises decision_auth_failed on a Decision-1 configuration error and ingests nothing", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const engine = new FakeEngine({ overrides: new Map([["msg-000", decisionError("auth", 401, false, "config")]]) });
    expect((await runTick(env, { trigger: "cron", now: NOW, engine })).outcome).toBe("error");
    expect(await count("messages")).toBe(0);
    expect(await issueCodes()).toContain("decision_auth_failed");
  });

  it("raises decision_not_configured without Decision secrets, still scans sent mail, and clears the issue once decisions work", async () => {
    const noDecision = { ...env, AZURE_DECISION_KEY: "" };
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    expect(await runTick(noDecision, { trigger: "cron", now: NOW })).toMatchObject({ outcome: "error", errorCode: "decision_not_configured" });
    expect(await issueCodes()).toContain("decision_not_configured");
    const retried = await runTick(env, { trigger: "cron", now: NOW + 7 * 60 * MINUTE, engine: new FakeEngine() });
    expect(retried.outcome).toBe("processed");
    expect(await issueCodes()).not.toContain("decision_not_configured");

    await resetDb();
    mock.sent = [{ conversationId: "c-1", to: ["friend@example.net"], sentAt: NOW - MINUTE }];
    await seedTickAccount({ phase: "sent_backfill", lastIncrementalAt: null });
    expect((await runTick(noDecision, { trigger: "cron", now: NOW })).outcome).toBe("processed");
  });

  it("halves the page without backoff when the subrequest budget runs out mid-tick", async () => {
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
    const report = await runTickInternal(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }, { subrequestLimit: 4 });
    expect(report).toMatchObject({ outcome: "error", errorCode: "subrequest_budget" });
    expect(report.subrequests).toBeLessThanOrEqual(4);
    expect(await getAccount(ACCOUNT_A)).toMatchObject({ page_size: 12, backoff_until: null, attempts: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-failures.test.ts`
Expected: FAIL: the tests reject with the provider or Decision errors (for example `ProviderRateLimitError`), because `tick()` has no failure handler yet.

- [ ] **Step 3: Import the failure helpers**

In `app/src/worker/scan/tick.ts` replace:

```ts
import { DecisionNotConfiguredError, DecisionOutageError } from "./failure.ts";
```

with:

```ts
import { DecisionNotConfiguredError, DecisionOutageError, buildFailureWrite, classifyFailure } from "./failure.ts";
```

- [ ] **Step 4: Wrap the success block**

In `tick()` replace:

```ts
  // Success path. Task 8 wraps these four statements in the failure handler.
  const processed = await processAccount(params);
  const final = createSubrequestCounter(limit, work.used);
  const finalResults = await run(final, processed.write.stmts);
  const result = successResult(processed, finalResults);
```

with:

```ts
  let final = createSubrequestCounter(limit, work.used);
  let result: TickResult;
  try {
    const processed = await processAccount(params);
    final = createSubrequestCounter(limit, work.used);
    const finalResults = await run(final, processed.write.stmts);
    result = successResult(processed, finalResults);
  } catch (err) {
    final = createSubrequestCounter(limit, Math.max(work.used, final.used));
    result = await failTick({ err, account, kind, tickId, now, settings, tokens, encKey, run, final, raise, clear });
  }
```

- [ ] **Step 5: Add `failTick` above `tick()`**

```ts
interface FailParams {
  err: unknown;
  account: TickAccountRow;
  kind: TickKind;
  tickId: string;
  now: number;
  settings: TickSettings;
  tokens: D1TokenSource;
  encKey: CryptoKey;
  run: Runner;
  final: SubrequestCounter;
  raise: readonly IssueRaise[];
  clear: readonly AppIssueCode[];
}

/** Contracts 8.2 catch branch: persist the failure, keep rotated tokens, release the lease. */
async function failTick(f: FailParams): Promise<TickResult> {
  const plan = classifyFailure(f.err, { provider: f.account.provider, attempts: f.account.attempts, now: f.now });
  const issues = applyIssues(
    f.settings.issues,
    [...f.raise, ...plan.raise.map((code) => ({ code, accountId: null }))],
    f.clear,
    f.now,
  );
  const update = f.tokens.update;
  const tokens = update === null ? null : await encryptTokenUpdate(f.encKey, f.account, update);
  const res = await f.run(
    f.final,
    buildFailureWrite({
      accountId: f.account.id, tickId: f.tickId, now: f.now, plan, tokens, issues: issues.changed ? issues.issues : null,
    }),
  );
  if (plan.provider !== null) {
    logEvent("provider.error", {
      tickId: f.tickId, accountId: f.account.id, provider: f.account.provider, errorCode: plan.errorCode,
      status: plan.provider.status,
    });
  }
  if (plan.status !== "active") {
    logEvent("account.status", { accountId: f.account.id, from: "active", to: plan.status, reason: plan.statusReason });
  }
  logEvent("tick.failed", {
    tickId: f.tickId, accountId: f.account.id, kind: f.kind, errorCode: plan.errorCode,
    attempts: f.account.attempts + 1, retryAfterMs: plan.retryAfterMs,
  });
  return {
    outcome: "error",
    phase: f.account.phase,
    nextTickAt: plan.status !== "active" ? null : (plan.backoffUntil ?? f.now),
    errorCode: plan.errorCode,
    freshCount: 0,
    rowsWritten: sumMeta(res, "rows_written"),
    rowsRead: sumMeta(res, "rows_read"),
    dbSize: lastSizeAfter(res),
    stats: emptyStats(),
    fetched: 0,
    skippedKnown: 0,
    removed: 0,
    issues,
  };
}
```

- [ ] **Step 6: Run all tick tests**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/`
Expected: `Test Files  13 passed (13)`.

- [ ] **Step 7: Commit**

```bash
git add app/src/worker/scan/tick.ts app/test/worker/tick/tick-failures.test.ts
git commit -m "feat(scan): persist tick failures with backoff, re-auth and config error statuses"
```

---

### Task 9: Bounded nightly purge

**Files:**
- Create: `app/src/worker/nightly/purge.ts`
- Test: `app/test/worker/nightly/purge.test.ts`

**Interfaces:**
- Consumes: `stmt`, `numbered`, `rowsOf`, `sumMeta`, `auditStmt`, `Stmt`, `BatchResult` (Tasks 2 and 5); `chunk`, `withCount` (plan 03).
- Produces:
  - `type NightlyRunner = (counter: SubrequestCounter, stmts: readonly Stmt[]) => Promise<BatchResult[]>`.
  - `PURGE_SELECT_LIMIT = 500`, `PURGE_DELETE_CHUNK = 90`, `ACCOUNT_DELETE_LIMIT = 1000`.
  - `interface PurgeState { rounds; rowsWritten; rowsRead; purgedMessages; purgedAccounts; stoppedByBudget }`; `newPurgeState(): PurgeState`.
  - `interface PurgeLimits { startRows: number; stopRows: number; maxRounds: number }`.
  - `purgeExpired(run, counter, now, state, limits): Promise<void>`; `purgeDisconnected(run, counter, accountIds, now, state, limits): Promise<void>`. Both stop before a round when `state.rounds >= maxRounds`, when fewer than 2 subrequests remain, or when `startRows + state.rowsWritten >= stopRows` (sets `stoppedByBudget`).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/nightly/purge.test.ts`:

```ts
import { PURGE_STOP_ROWS, createSubrequestCounter } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { withCount } from "../../../src/worker/db/sql.ts";
import { newPurgeState, purgeDisconnected, purgeExpired } from "../../../src/worker/nightly/purge.ts";
import type { NightlyRunner } from "../../../src/worker/nightly/purge.ts";
import { ACCOUNT_A, ACCOUNT_B, DAY, NOW, count, one, resetDb, seedExpiredBulk, seedLabel, seedMessage, seedTickAccount } from "../helpers/tick-db.ts";

const run: NightlyRunner = (counter, stmts) =>
  withCount(counter, () => env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params))));

const LIMITS = { startRows: 0, stopRows: PURGE_STOP_ROWS, maxRounds: 16 };
const ACCOUNT_TABLES = ["suggestions", "messages", "labels", "sender_priors", "senders", "correspondents", "sent_threads"];

describe("purgeExpired", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount();
    await seedExpiredBulk(ACCOUNT_A, 600, NOW - DAY);
    await seedMessage(ACCOUNT_A, { providerId: "keep-1", expiresAt: NOW + DAY });
    await seedMessage(ACCOUNT_A, { providerId: "keep-2", expiresAt: NOW + DAY });
  });

  it("deletes expired suggestions and their messages in rounds of 500", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, LIMITS);
    expect(await count("messages")).toBe(2);
    expect(await count("suggestions")).toBe(2);
    expect(state).toMatchObject({ rounds: 2, purgedMessages: 600, stoppedByBudget: false });
    expect(state.rowsWritten).toBeGreaterThanOrEqual(1800);
  });

  it("stops at the round limit", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, { ...LIMITS, maxRounds: 1 });
    expect(await count("messages")).toBe(102);
  });

  it("stops at the purge write gate", async () => {
    const state = newPurgeState();
    await purgeExpired(run, createSubrequestCounter(43), NOW, state, { ...LIMITS, startRows: PURGE_STOP_ROWS });
    expect(await count("messages")).toBe(602);
    expect(state.stoppedByBudget).toBe(true);
  });
});

describe("purgeDisconnected", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
    await seedTickAccount({ id: ACCOUNT_B, email: "gone@example.test", status: "disconnected" });
    for (const id of [ACCOUNT_A, ACCOUNT_B]) {
      await seedMessage(id, { providerId: "m-1" });
      await seedLabel(id, { pDelete: 0.9, margin: 0.8, ownerAction: "delete" });
      await env.DB.batch([
        env.DB.prepare("INSERT INTO sender_priors (account_id, key, deletes, keeps, updated_at) VALUES (?1, '@shop.example', 1, 0, 0)").bind(id),
        env.DB.prepare("INSERT INTO senders (account_id, address, domain, seen_count, read_count, last_seen_at) VALUES (?1, 'a@shop.example', 'shop.example', 1, 0, 0)").bind(id),
        env.DB.prepare("INSERT INTO correspondents (account_id, address, last_sent_at) VALUES (?1, 'b@example.net', 0)").bind(id),
        env.DB.prepare("INSERT INTO sent_threads (account_id, thread_id, last_sent_at) VALUES (?1, 't-1', 0)").bind(id),
        env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at) VALUES ('account:' || ?1, ?1, 'h', 0, 1, 1)").bind(id),
      ]);
    }
  });

  it("deletes every row of a disconnected account, then the account, and leaves other accounts alone", async () => {
    await seedExpiredBulk(ACCOUNT_B, 1200, NOW + DAY);
    const state = newPurgeState();
    await purgeDisconnected(run, createSubrequestCounter(43), [ACCOUNT_B], NOW, state, { ...LIMITS, maxRounds: 19 });
    for (const t of ACCOUNT_TABLES) {
      expect(await count(t, "account_id = ?1", ACCOUNT_B), t).toBe(0);
      expect(await count(t, "account_id = ?1", ACCOUNT_A), t).toBe(1);
    }
    expect(await count("accounts", "id = ?1", ACCOUNT_B)).toBe(0);
    expect(await count("leases", "account_id = ?1", ACCOUNT_B)).toBe(0);
    expect(await one("SELECT kind, account_id FROM audit_log")).toEqual({ kind: "account_purged", account_id: ACCOUNT_B });
    expect(state).toMatchObject({ rounds: 2, purgedAccounts: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/nightly/purge.test.ts`
Expected: FAIL with `Failed to load url ../../../src/worker/nightly/purge.ts`.

- [ ] **Step 3: Write `purge.ts`**

`app/src/worker/nightly/purge.ts`:

```ts
import type { SubrequestCounter } from "@clearbox/core";
import { chunk } from "../db/sql.ts";
import { auditStmt, numbered, rowsOf, stmt, sumMeta } from "../scan/write-plan.ts";
import type { BatchResult, Stmt } from "../scan/write-plan.ts";

export type NightlyRunner = (counter: SubrequestCounter, stmts: readonly Stmt[]) => Promise<BatchResult[]>;

export const PURGE_SELECT_LIMIT = 500;
export const PURGE_DELETE_CHUNK = 90;
/** Must equal the LIMIT literal in ACCOUNT_TABLE_DELETES. */
export const ACCOUNT_DELETE_LIMIT = 1000;

export interface PurgeState {
  rounds: number;
  rowsWritten: number;
  rowsRead: number;
  purgedMessages: number;
  purgedAccounts: number;
  stoppedByBudget: boolean;
}

export function newPurgeState(): PurgeState {
  return { rounds: 0, rowsWritten: 0, rowsRead: 0, purgedMessages: 0, purgedAccounts: 0, stoppedByBudget: false };
}

export interface PurgeLimits {
  startRows: number;
  stopRows: number;
  maxRounds: number;
}

/** A round needs at most two D1 calls. */
function canRun(state: PurgeState, limits: PurgeLimits, counter: SubrequestCounter): boolean {
  if (state.rounds >= limits.maxRounds) return false;
  if (counter.limit - counter.used < 2) return false;
  if (limits.startRows + state.rowsWritten >= limits.stopRows) {
    state.stoppedByBudget = true;
    return false;
  }
  return true;
}

function track(state: PurgeState, res: readonly BatchResult[]): void {
  state.rowsWritten += sumMeta(res, "rows_written");
  state.rowsRead += sumMeta(res, "rows_read");
}

/** Contracts 8.6: expired suggestions and their messages, suggestions first (FK). Cross-account by design. */
export async function purgeExpired(
  run: NightlyRunner,
  counter: SubrequestCounter,
  now: number,
  state: PurgeState,
  limits: PurgeLimits,
): Promise<void> {
  while (canRun(state, limits, counter)) {
    const selected = await run(counter, [
      stmt("SELECT message_id FROM suggestions WHERE expires_at < ?1 LIMIT ?2", now, PURGE_SELECT_LIMIT),
    ]);
    track(state, selected);
    const ids = rowsOf<{ message_id: number }>(selected[0]).map((r) => r.message_id);
    if (ids.length === 0) return;
    state.rounds += 1;
    const chunks = chunk(ids, PURGE_DELETE_CHUNK);
    const res = await run(counter, [
      ...chunks.map((c) => stmt(`DELETE FROM suggestions WHERE message_id IN (${numbered(1, c.length)})`, ...c)),
      ...chunks.map((c) => stmt(`DELETE FROM messages WHERE id IN (${numbered(1, c.length)})`, ...c)),
    ]);
    track(state, res);
    state.purgedMessages += res.slice(chunks.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    if (ids.length < PURGE_SELECT_LIMIT) return;
  }
}

/** Order matters: suggestions before messages (FK), messages only once no suggestion references them. */
const ACCOUNT_TABLE_DELETES: readonly string[] = [
  "DELETE FROM suggestions WHERE rowid IN (SELECT rowid FROM suggestions WHERE account_id = ?1 LIMIT 1000)",
  `DELETE FROM messages WHERE rowid IN (SELECT m.rowid FROM messages m WHERE m.account_id = ?1
     AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.message_id = m.id) LIMIT 1000)`,
  "DELETE FROM labels WHERE rowid IN (SELECT rowid FROM labels WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM sender_priors WHERE account_id = ?1 AND key IN (SELECT key FROM sender_priors WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM senders WHERE account_id = ?1 AND address IN (SELECT address FROM senders WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM correspondents WHERE account_id = ?1 AND address IN (SELECT address FROM correspondents WHERE account_id = ?1 LIMIT 1000)",
  "DELETE FROM sent_threads WHERE account_id = ?1 AND thread_id IN (SELECT thread_id FROM sent_threads WHERE account_id = ?1 LIMIT 1000)",
];

/** Contracts 8.6: disconnected accounts, in table order, then the leases and the account row. */
export async function purgeDisconnected(
  run: NightlyRunner,
  counter: SubrequestCounter,
  accountIds: readonly string[],
  now: number,
  state: PurgeState,
  limits: PurgeLimits,
): Promise<void> {
  for (const accountId of accountIds) {
    for (;;) {
      if (!canRun(state, limits, counter)) return;
      state.rounds += 1;
      const res = await run(counter, ACCOUNT_TABLE_DELETES.map((sql) => stmt(sql, accountId)));
      track(state, res);
      state.purgedMessages += res[1]?.meta?.changes ?? 0;
      if (res.some((r) => (r.meta?.changes ?? 0) >= ACCOUNT_DELETE_LIMIT)) continue;
      const finish = await run(counter, [
        stmt("DELETE FROM leases WHERE account_id = ?1", accountId),
        stmt("DELETE FROM accounts WHERE id = ?1 AND status = 'disconnected'", accountId),
        auditStmt(now, accountId, "account_purged", 1, {}),
      ]);
      track(state, finish);
      state.purgedAccounts += finish[1]?.meta?.changes ?? 0;
      break;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/nightly/purge.test.ts`
Expected: `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add app/src/worker/nightly/purge.ts app/test/worker/nightly/purge.test.ts
git commit -m "feat(nightly): add bounded purge of expired rows and disconnected accounts"
```

---

### Task 10: Nightly job (`runNightly`)

**Files:**
- Replace: `app/src/worker/nightly/nightly.ts` (plan 03's temporary stub)
- Modify: `app/test/worker/db-isolation.test.ts` (plan 03 file: append one `describe` block)
- Test: `app/test/worker/nightly/nightly.test.ts`

**Interfaces:**
- Consumes: `calibrateTauDelete`, `createSubrequestCounter`, constants (core); `purgeExpired`, `purgeDisconnected`, `newPurgeState`, `NightlyRunner` (Task 9); `settingStmt`, `auditStmt`, `budgetUpsertStmt`, `stmt`, `rowsOf`, `sumMeta`, `lastSizeAfter`, `utcDate` (Tasks 2 and 5); `withCount`, `logEvent` (plan 03).
- Produces: `interface NightlyOptions { now: number }`; `runNightly(env: Env, opts: NightlyOptions): Promise<void>` (contracts 8.1, 8.6); constants `NIGHTLY_LEASE_TTL_MS = 600_000`, `PURGE_EXPIRED_MAX_ROUNDS = 16`, `PURGE_TOTAL_MAX_ROUNDS = 19`. Writes settings `tau_delete`, `calibration` (`CalibrationResult & { ranAt }`), `nightly` (`{ ranAt, purgedMessages, purgedAccounts, staleRecovered }`); audit rows `calibration` (`count = deleteSuggestions`, `result = { tauDelete }`, amendment A5) and `purge` (`count = purgedMessages`, `result = { purgedAccounts, staleRecovered }`).

- [ ] **Step 1: Write the failing tests**

`app/test/worker/nightly/nightly.test.ts`:

```ts
import { PURGE_STOP_ROWS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runNightly } from "../../../src/worker/nightly/nightly.ts";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import {
  ACCOUNT_A, ACCOUNT_B, DAY, MINUTE, NOW, count, one, resetDb, seedLabel, seedMessage, seedTickAccount, setBudget,
} from "../helpers/tick-db.ts";

async function setting<T>(key: string): Promise<T | null> {
  const row = await one<{ value: string }>("SELECT value FROM settings WHERE key = ?1", key);
  return row === null ? null : (JSON.parse(row.value) as T);
}

describe("runNightly", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTickAccount({ id: ACCOUNT_A });
  });

  it("calibrates tau_delete from the newest labels and audits it with the A5 result key", async () => {
    for (let i = 0; i < 60; i++) {
      await seedLabel(ACCOUNT_A, { pDelete: 0.85, margin: 0.5, ownerAction: i < 10 ? "keep" : "delete" });
    }
    for (let i = 0; i < 50; i++) await seedLabel(ACCOUNT_A, { pDelete: 0.95, margin: 0.9, ownerAction: "delete" });
    await runNightly(env, { now: NOW });
    expect(await setting<number>("tau_delete")).toBeCloseTo(0.86, 9);
    expect(await setting<{ outcome: string; ranAt: number }>("calibration")).toMatchObject({ outcome: "calibrated", ranAt: NOW });
    const audit = await one<{ count: number; result_json: string }>("SELECT count, result_json FROM audit_log WHERE kind = 'calibration'");
    expect(audit?.count).toBe(110);
    expect(JSON.parse(audit?.result_json ?? "{}")).toEqual({ tauDelete: 0.86 });
  });

  it("keeps tau_delete with too few labels", async () => {
    await seedLabel(ACCOUNT_A, { pDelete: 0.95, margin: 0.9, ownerAction: "delete" });
    await runNightly(env, { now: NOW });
    expect(await setting<number>("tau_delete")).toBe(0.8);
    expect(await setting<{ outcome: string }>("calibration")).toMatchObject({ outcome: "insufficient_data" });
  });

  it("recovers stale approvals, purges expired rows and records the summary", async () => {
    const stale = await seedMessage(ACCOUNT_A, { providerId: "stale", status: "approved", updatedAt: NOW - 11 * MINUTE });
    const fresh = await seedMessage(ACCOUNT_A, { providerId: "fresh", status: "approved", updatedAt: NOW - MINUTE });
    for (const id of ["x-1", "x-2", "x-3"]) await seedMessage(ACCOUNT_A, { providerId: id, expiresAt: NOW - 1 });
    await runNightly(env, { now: NOW });
    expect(await one("SELECT status, exec_error FROM suggestions WHERE message_id = ?1", stale)).toEqual({ status: "failed", exec_error: "interrupted" });
    expect(await one("SELECT status FROM suggestions WHERE message_id = ?1", fresh)).toEqual({ status: "approved" });
    expect(await count("messages", "provider_msg_id LIKE 'x-%'")).toBe(0);
    expect(await setting("nightly")).toEqual({ ranAt: NOW, purgedMessages: 3, purgedAccounts: 0, staleRecovered: 1 });
    expect(await one("SELECT count FROM audit_log WHERE kind = 'purge'")).toEqual({ count: 3 });
    expect(await one("SELECT released_at FROM leases WHERE name = 'nightly'")).toEqual({ released_at: NOW });
    expect((await one<{ rows_written: number }>("SELECT rows_written FROM budget WHERE date = ?1", utcDate(NOW)))?.rows_written).toBeGreaterThan(0);
  });

  it("purges a disconnected account end to end", async () => {
    await seedTickAccount({ id: ACCOUNT_B, email: "gone@example.test", status: "disconnected" });
    await seedMessage(ACCOUNT_B, { providerId: "b-1" });
    await runNightly(env, { now: NOW });
    expect(await count("accounts", "id = ?1", ACCOUNT_B)).toBe(0);
    expect(await count("messages", "account_id = ?1", ACCOUNT_B)).toBe(0);
    expect(await setting("nightly")).toMatchObject({ purgedAccounts: 1 });
  });

  it("skips the purge at the purge write gate but still calibrates", async () => {
    await setBudget(utcDate(NOW), PURGE_STOP_ROWS);
    await seedMessage(ACCOUNT_A, { providerId: "x-1", expiresAt: NOW - 1 });
    await runNightly(env, { now: NOW });
    expect(await count("messages", "provider_msg_id = 'x-1'")).toBe(1);
    expect(await setting("calibration")).not.toBeNull();
  });

  it("does nothing while another run holds the nightly lease", async () => {
    await env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES ('nightly', NULL, 'other', ?1, ?2)")
      .bind(NOW, NOW + 10 * MINUTE).run();
    await runNightly(env, { now: NOW });
    expect(await setting("nightly")).toBeNull();
    expect(await setting("calibration")).toBeNull();
  });

  it("deletes old action batches, old budget rows and leases of deleted accounts", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO action_batches (created_at, kind, suggestion_ids_json, requested_count, undo_expires_at) VALUES (?1, 'approve', '[]', 0, ?1), (?2, 'approve', '[]', 0, ?2)")
        .bind(NOW - 8 * DAY, NOW - DAY),
      env.DB.prepare("INSERT INTO budget (date, rows_written, updated_at) VALUES (?1, 5, 0)").bind(utcDate(NOW - 91 * DAY)),
      env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at) VALUES ('account:acc_00000000000000ff', 'acc_00000000000000ff', 'h', 0, 1, 1)"),
    ]);
    await runNightly(env, { now: NOW });
    expect(await count("action_batches")).toBe(1);
    expect(await count("budget", "date = ?1", utcDate(NOW - 91 * DAY))).toBe(0);
    expect(await count("leases", "account_id = 'acc_00000000000000ff'")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/nightly/nightly.test.ts`
Expected: FAIL: plan 03's stub `runNightly` writes nothing (`expected null to be close to 0.86`), or the import fails if the stub is missing.

- [ ] **Step 3: Write `nightly.ts`**

Replace the whole content of `app/src/worker/nightly/nightly.ts`:

```ts
import {
  BATCH_RETENTION_MS, CALIBRATION_WINDOW, PURGE_STOP_ROWS, STALE_APPROVED_MS, TAU_DELETE_DEFAULT, TICK_SUBREQUEST_LIMIT,
  calibrateTauDelete, createSubrequestCounter,
} from "@clearbox/core";
import type { ActionKind, CalibrationSample, Ceiling } from "@clearbox/core";
import { withCount } from "../db/sql.ts";
import { logEvent } from "../log.ts";
import { auditStmt, budgetUpsertStmt, lastSizeAfter, rowsOf, settingStmt, stmt, sumMeta, utcDate } from "../scan/write-plan.ts";
import type { BatchResult } from "../scan/write-plan.ts";
import { newPurgeState, purgeDisconnected, purgeExpired } from "./purge.ts";
import type { NightlyRunner } from "./purge.ts";

export const NIGHTLY_LEASE_TTL_MS = 10 * 60_000;
export const PURGE_EXPIRED_MAX_ROUNDS = 16;
export const PURGE_TOTAL_MAX_ROUNDS = 19;
const BUDGET_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const FINAL_D1_CALLS = 2;

const NIGHTLY_CLAIM = `INSERT INTO leases (name, account_id, holder, acquired_at, expires_at, released_at)
VALUES ('nightly', NULL, ?1, ?2, ?3, NULL)
ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at,
  expires_at = excluded.expires_at, released_at = NULL
WHERE leases.released_at IS NOT NULL OR leases.expires_at <= excluded.acquired_at
RETURNING holder`;

interface LabelSampleRow {
  p_delete: number | null;
  margin: number | null;
  ceiling: Ceiling;
  owner_action: ActionKind;
}

export interface NightlyOptions {
  now: number;
}

function parseTau(value: string | undefined): number {
  const n = Number(value ?? TAU_DELETE_DEFAULT);
  return Number.isFinite(n) ? n : TAU_DELETE_DEFAULT;
}

/** Contracts 8.6: lease, stale recovery, calibration, bounded purge, housekeeping, budget. At most 45 D1 calls. */
export async function runNightly(env: Env, opts: NightlyOptions): Promise<void> {
  const now = opts.now;
  const runId = crypto.randomUUID();
  const today = utcDate(now);
  const db = env.DB;
  const run: NightlyRunner = (counter, stmts) =>
    withCount(counter, () => db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params))));
  const work = createSubrequestCounter(TICK_SUBREQUEST_LIMIT - FINAL_D1_CALLS);
  const results: BatchResult[] = [];

  const claim = await run(work, [
    stmt(NIGHTLY_CLAIM, runId, now, now + NIGHTLY_LEASE_TTL_MS),
    stmt("SELECT value FROM settings WHERE key = 'tau_delete'"),
    stmt("SELECT rows_written FROM budget WHERE date = ?1", today),
    stmt("SELECT id FROM accounts WHERE status = 'disconnected' ORDER BY id"),
  ]);
  if (rowsOf(claim[0]).length === 0) return;
  results.push(...claim);
  const tau = parseTau(rowsOf<{ value: string }>(claim[1])[0]?.value);
  const startRows = rowsOf<{ rows_written: number }>(claim[2])[0]?.rows_written ?? 0;
  const disconnected = rowsOf<{ id: string }>(claim[3]).map((r) => r.id);

  const reads = await run(work, [
    stmt(
      "UPDATE suggestions SET status = 'failed', exec_error = 'interrupted', updated_at = ?1 WHERE status = 'approved' AND updated_at < ?2",
      now, now - STALE_APPROVED_MS,
    ),
    // Cross-account read exempted by contracts 6.1; the trailing SQL comment is the marker plan 03's isolation test reads.
    stmt(
      "SELECT p_delete, margin, ceiling, owner_action FROM labels ORDER BY id DESC LIMIT ?1 -- isolation-exempt: calibration",
      CALIBRATION_WINDOW,
    ),
  ]);
  results.push(...reads);
  const staleRecovered = reads[0]?.meta?.changes ?? 0;
  const samples: CalibrationSample[] = rowsOf<LabelSampleRow>(reads[1]).map((r) => ({
    pDelete: r.p_delete, margin: r.margin, ceiling: r.ceiling, ownerAction: r.owner_action,
  }));
  const calibration = calibrateTauDelete(samples, tau);

  results.push(...(await run(work, [
    settingStmt("tau_delete", JSON.stringify(calibration.tauDelete), now),
    settingStmt("calibration", JSON.stringify({ ...calibration, ranAt: now }), now),
    auditStmt(now, null, "calibration", calibration.deleteSuggestions, { tauDelete: calibration.tauDelete }),
  ])));

  const state = newPurgeState();
  const stopRows = env.FREE_TIER !== "false" ? PURGE_STOP_ROWS : Number.MAX_SAFE_INTEGER;
  const base = startRows + sumMeta(results, "rows_written");
  await purgeExpired(run, work, now, state, { startRows: base, stopRows, maxRounds: PURGE_EXPIRED_MAX_ROUNDS });
  await purgeDisconnected(run, work, disconnected, now, state, { startRows: base, stopRows, maxRounds: PURGE_TOTAL_MAX_ROUNDS });
  if (state.stoppedByBudget) logEvent("budget.gate", { date: today, rowsWritten: base + state.rowsWritten, gate: "purge" });

  const final = createSubrequestCounter(TICK_SUBREQUEST_LIMIT, work.used);
  const summary = {
    ranAt: now, purgedMessages: state.purgedMessages, purgedAccounts: state.purgedAccounts, staleRecovered,
  };
  results.push(...(await run(final, [
    stmt("DELETE FROM action_batches WHERE created_at < ?1", now - BATCH_RETENTION_MS),
    stmt("DELETE FROM budget WHERE date < ?1", utcDate(now - BUDGET_KEEP_DAYS * DAY_MS)),
    stmt("DELETE FROM leases WHERE account_id IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts)"),
    settingStmt("nightly", JSON.stringify(summary), now),
    auditStmt(now, null, "purge", state.purgedMessages, { purgedAccounts: state.purgedAccounts, staleRecovered }),
    stmt("UPDATE leases SET released_at = ?2 WHERE name = 'nightly' AND holder = ?1", runId, now),
  ])));
  const rowsWritten = sumMeta(results, "rows_written") + state.rowsWritten + 1;
  await run(final, [
    budgetUpsertStmt({
      date: today, rowsWritten, rowsRead: sumMeta(results, "rows_read") + state.rowsRead, ticks: 0, messagesIngested: 0,
      decisionCalls: 0, decisionFailures: 0, decisionInputTokens: 0, providerCalls: 0,
      dbSizeBytes: lastSizeAfter(results), now,
    }),
  ]);
  logEvent("nightly.done", {
    runId, tauDelete: calibration.tauDelete, calibrationOutcome: calibration.outcome,
    purgedMessages: state.purgedMessages, purgedAccounts: state.purgedAccounts, staleRecovered, rowsWritten,
  });
}
```

- [ ] **Step 4: Run the nightly tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/nightly/`
Expected: `Test Files  2 passed (2)`, `Tests  11 passed (11)`.

- [ ] **Step 5: Extend plan 03's isolation test to the nightly calibration read**

Contracts 6.1 exempts `src/worker/nightly/*.ts` as a whole, but the one cross-account `labels` read must still be marked (plan 03 decision 7). Append this block to the end of `app/test/worker/db-isolation.test.ts` (it reuses that file's `literals`, `isScoped` and `EXEMPT` helpers):

```ts
const nightlySources = import.meta.glob("../../src/worker/nightly/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("nightly cross-account labels reads (contracts 6.1 exemption)", () => {
  it("marks every unscoped labels read with isolation-exempt: calibration", () => {
    const offenders: string[] = [];
    let marked = 0;
    for (const [path, src] of Object.entries(nightlySources)) {
      for (const sql of literals(src)) {
        if (!/\bFROM\s+labels\b/i.test(sql) || isScoped(sql)) continue;
        if (EXEMPT.exec(sql)?.[1] === "calibration") marked += 1;
        else offenders.push(`${path}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(marked).toBe(1);
  });
});
```

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/db-isolation.test.ts`
Expected: PASS (plan 03's tests plus the new one).

- [ ] **Step 6: Commit**

```bash
git add app/src/worker/nightly/nightly.ts app/test/worker/nightly/nightly.test.ts app/test/worker/db-isolation.test.ts
git commit -m "feat(nightly): calibrate tau_delete, recover stale approvals, purge and housekeep"
```

---

### Task 11: Wire the crons and `POST /api/accounts/:id/scan`

**Files:**
- Verify only: `app/src/worker/index.ts` (plan 03 Task 5 already routes `CRON_TICK` to `runTick` and `CRON_NIGHTLY` to `runNightly`; no edit)
- Modify: `app/src/worker/routes/accounts.ts` (plan 03's `accountsRoutes`: add the scan-now route)
- Test: `app/test/worker/tick/scheduled.test.ts`
- Test: `app/test/worker/routes/scan.test.ts`

**Interfaces:**
- Consumes: `runTick` (Task 7/8), `runNightly` (Task 10), plan 03's worker default export (`src/worker/index.ts`), `accountsRoutes` and `AppEnv` deps (`c.get("deps").now`, `c.get("deps").fetch`), `apiFetch` (plan 03 test helper).
- Produces: `POST /api/accounts/:id/scan` returning `TickReport` (200) or `ApiErrorBody` with 404 `not_found`, 409 `account_busy` (with `retryAt`), 409 `account_inactive`, 429 `budget_exhausted` (with `retryAt`), per contracts 7.5. Cron `* * * * *` runs one tick; cron `0 2 * * *` runs the nightly job.

- [ ] **Step 1: Write the failing scheduled-handler test**

`app/test/worker/tick/scheduled.test.ts`:

```ts
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../../src/worker/index.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { MINUTE, NOW, count, one, resetDb, seedTickAccount } from "../helpers/tick-db.ts";

async function fire(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime: NOW }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled handler", () => {
  let decision: DecisionMock;

  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = [mail(0, { listUnsubscribe: true }), mail(1), mail(2)];
    decision = new DecisionMock();
    useNetwork(mock.handlers(), decision.handlers());
    await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
  });

  it("runs one tick on the minute cron with the real Decision-1 engine", async () => {
    await fire("* * * * *");
    expect(await count("messages")).toBe(3);
    expect(decision.calls).toBe(3);
    expect(await count("suggestions", "model_version LIKE 'decision-1/%'")).toBe(3);
  });

  it("runs the nightly job on the 02:00 cron", async () => {
    await fire("0 2 * * *");
    expect(await one("SELECT key FROM settings WHERE key = 'nightly'")).toEqual({ key: "nightly" });
    expect(await count("messages")).toBe(0);
  });

  it("ignores any other cron", async () => {
    await fire("*/5 * * * *");
    expect(await count("messages")).toBe(0);
    expect(await count("leases")).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing route test**

`app/test/worker/routes/scan.test.ts`:

```ts
import type { ApiErrorBody, TickReport } from "../../../src/shared/api.ts";
import { INGEST_STOP_ROWS } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { utcDate } from "../../../src/worker/scan/write-plan.ts";
import { DecisionMock } from "../helpers/decision-mock.ts";
import { ProviderMock, mail, useNetworkOpen } from "../helpers/provider-mock.ts";
import { apiFetch } from "../helpers/request.ts";
import { ACCOUNT_A, MINUTE, resetDb, seedTickAccount, setBudget } from "../helpers/tick-db.ts";

const path = (id: string) => `/api/accounts/${id}/scan`;

describe("POST /api/accounts/:id/scan", () => {
  beforeEach(async () => {
    await resetDb();
    const mock = new ProviderMock();
    mock.inbox = [mail(0), mail(1)];
    useNetworkOpen(mock.handlers(), new DecisionMock().handlers());
  });

  it("runs one forced tick and returns the TickReport", async () => {
    await seedTickAccount({ nextTickAt: Date.now() + 60 * MINUTE });
    const res = await apiFetch(path(ACCOUNT_A), { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TickReport;
    expect(body).toMatchObject({ outcome: "processed", accountId: ACCOUNT_A });
    expect(body.subrequests).toBeLessThanOrEqual(45);
  });

  it("returns 404 for an unknown account", async () => {
    const res = await apiFetch(path("acc_00000000000000ff"), { method: "POST" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("not_found");
  });

  it("returns 409 account_inactive for a paused account", async () => {
    await seedTickAccount({ paused: true });
    const res = await apiFetch(path(ACCOUNT_A), { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("account_inactive");
  });

  it("returns 409 account_busy with retryAt while a tick holds the lease", async () => {
    await seedTickAccount();
    const expires = Date.now() + 5 * MINUTE;
    await env.DB.prepare("INSERT INTO leases (name, account_id, holder, acquired_at, expires_at) VALUES (?1, ?2, 'other', ?3, ?4)")
      .bind(`account:${ACCOUNT_A}`, ACCOUNT_A, Date.now(), expires).run();
    const res = await apiFetch(path(ACCOUNT_A), { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error).toMatchObject({ code: "account_busy", retryAt: new Date(expires).toISOString() });
  });

  it("returns 429 budget_exhausted at the daily ingest gate", async () => {
    await seedTickAccount();
    await setBudget(utcDate(Date.now()), INGEST_STOP_ROWS);
    const res = await apiFetch(path(ACCOUNT_A), { method: "POST" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe("budget_exhausted");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/scheduled.test.ts test/worker/routes/scan.test.ts`
Expected: `scheduled.test.ts` PASSES already (plan 03's `index.ts` routes the crons and Tasks 7 to 10 replaced both stubs); `scan.test.ts` FAILS: the route returns `404 not_found` for every request because `/api/accounts/:id/scan` is not registered.

- [ ] **Step 4: Confirm the cron routing (no edit)**

Open `app/src/worker/index.ts` and confirm it is plan 03 Task 5 Step 12's version: `scheduled` switches on `controller.cron` and calls `runTick(env, { trigger: "cron", now: controller.scheduledTime })` for `CRON_TICK` and `runNightly(env, { now: controller.scheduledTime })` for `CRON_NIGHTLY`, each inside `ctx.waitUntil`. Do not edit the file.

- [ ] **Step 5: Register the scan-now route on plan 03's `accountsRoutes`**

In `app/src/worker/routes/accounts.ts` add this import after the `../middleware/errors.ts` import:

```ts
import { runTick } from "../scan/tick.ts";
```

and replace the last line of the file, `// Plan 04 adds: accountsRoutes.post("/:id/scan", ...) (contracts 7.5 scan now).`, with:

```ts
/** Contracts 7.5: one forced tick for this account. A failed claim throws ApiError (404, 409, 429) for onApiError. */
accountsRoutes.post("/:id/scan", async (c) => {
  const deps = c.get("deps");
  const report = await runTick(c.env, {
    trigger: "scan_now",
    accountId: c.req.param("id"),
    now: deps.now(),
    fetch: deps.fetch,
  });
  return c.json(report);
});
```

`accountsRoutes` is mounted at `/api/accounts` by `createApp`, so the full path is `/api/accounts/:id/scan`; the Access and CSRF middleware already cover it (contracts 7.1).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/scheduled.test.ts test/worker/routes/scan.test.ts`
Expected: `Tests  8 passed (8)`.

- [ ] **Step 7: Run the whole worker suite, typecheck and lint**

Run: `pnpm --filter @clearbox/app test:worker && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck && pnpm lint`
Expected: all worker test files pass (plan 03's suites included), no type or lint errors. In particular plan 03's `test/worker/db-isolation.test.ts` still passes: this plan adds no SQL to `src/worker/db/*.ts`, and `routes/accounts.ts` gains no SQL.

- [ ] **Step 8: Commit**

```bash
git add app/src/worker/routes/accounts.ts app/test/worker/tick/scheduled.test.ts app/test/worker/routes/scan.test.ts
git commit -m "feat(worker): route crons to tick and nightly, add POST /api/accounts/:id/scan"
```

---

### Task 12: CPU benchmark per tick and post-deploy CPU check

**Files:**
- Test: `app/test/worker/tick/tick-cpu.test.ts`
- Create: `docs/runbook.md` (only the CPU section below; plan 06 Task 12 later replaces the file with the full runbook and keeps this section as section 15)

**Interfaces:**
- Consumes: `runTickInternal`, `TickTimings` (Task 7); `ProviderMock`, `mail`, `useNetwork`, `seedTickAccount`, `resetDb` (Task 1); `network` (plan 03).
- Produces: a guard test that fails when the pure compute of one 25-message tick exceeds 8 ms (median of 20 measured runs), plus a logged proxy measurement (wall time minus awaited I/O) that must stay under the 10 ms Free CPU limit. Method: Cloudflare's "Performance and timers" docs state that in local development (workerd) timers advance during CPU work, unlike production where they only advance after I/O; so `performance.now()` around the pure stages inside the Vitest workerd pool measures CPU time (research cloudflare.md section 7: Miniflare does not enforce the 10 ms limit, measure with `performance.now()` around pure code).

- [ ] **Step 1: Write the benchmark test**

`app/test/worker/tick/tick-cpu.test.ts`:

```ts
import { FakeEngine } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runTickInternal } from "../../../src/worker/scan/tick.ts";
import type { TickTimings } from "../../../src/worker/scan/tick.ts";
import { ProviderMock, mail, useNetwork } from "../helpers/provider-mock.ts";
import { MINUTE, NOW, resetDb, seedTickAccount } from "../helpers/tick-db.ts";
import { network } from "../setup/network.ts";

const RUNS = 21; // first run is warm-up
const PURE_BUDGET_MS = 8;
const PROXY_BUDGET_MS = 10;

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("tick CPU (25-message page, FakeEngine, MSW Graph provider)", () => {
  it("runs where timers advance during synchronous work (local workerd)", () => {
    const start = performance.now();
    let spins = 0;
    for (let i = 0; i < 5_000_000 && performance.now() - start < 2; i++) spins += 1;
    expect(spins).toBeGreaterThan(0);
    expect(performance.now() - start, "timers are frozen in this runtime; run the benchmark under local workerd").toBeGreaterThan(0);
  });

  it("keeps pure compute under 8 ms and wall minus I/O under 10 ms per tick", async () => {
    const pure: number[] = [];
    const proxy: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      network.resetHandlers();
      await resetDb();
      await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
      const mock = new ProviderMock();
      mock.inbox = Array.from({ length: 25 }, (_, i) => mail(i, { listUnsubscribe: i % 2 === 0, isRead: i % 3 === 0 }));
      useNetwork(mock.handlers());
      const timings: TickTimings = { wallMs: 0, ioMs: 0, pureMs: 0 };
      const report = await runTickInternal(env, { trigger: "cron", now: NOW, engine: new FakeEngine() }, { timings });
      expect(report).toMatchObject({ outcome: "processed", fetched: 25, decided: 25 });
      if (run === 0) continue;
      pure.push(timings.pureMs);
      proxy.push(timings.wallMs - timings.ioMs);
    }
    // eslint-disable-next-line no-console
    console.info(`tick CPU: pure median ${median(pure).toFixed(2)} ms, wall minus I/O median ${median(proxy).toFixed(2)} ms`);
    expect(median(pure)).toBeLessThan(PURE_BUDGET_MS);
    expect(median(proxy)).toBeLessThan(PROXY_BUDGET_MS);
  });
});
```

What the two numbers cover:

- `pureMs`: identity pass, context parsing, signals, guardrails, priors, Decision-1 state building, fusion and reasons, write-plan building (the `watch.pure` sections in `tick.ts`).
- `wallMs - ioMs`: everything that is not an awaited `fetch` or D1 batch: the pure stages plus provider JSON parsing and mapping (plan 02), token decryption, `FakeEngine`, claim and settings parsing, and Vitest overhead. It is an upper-bound proxy for production CPU. With the real `MaiDecisionEngine`, concurrent Decision-1 fetches overlap and `ioMs` double-counts them, so the proxy is only meaningful with `FakeEngine`.

- [ ] **Step 2: Run the benchmark**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-cpu.test.ts`
Expected: `Tests  2 passed (2)` and a line like `tick CPU: pure median 2.10 ms, wall minus I/O median 4.80 ms`.

If the pure median is at or above 8 ms, profile before changing budgets: the usual causes are repeated `JSON.stringify(signals)` (computed once per message in `buildSuccessWrite`), `buildDecisionState` shrinking loops (plan 01), and regex-heavy header parsing (plan 02). Do not raise `PURE_BUDGET_MS`.

- [ ] **Step 3: Document the post-deploy CPU check**

Create `docs/runbook.md` with exactly this content:

````markdown
# Clearbox runbook

## Checking tick CPU time after deploy

Workers Free allows 10 ms of CPU per cron invocation. Locally, `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-cpu.test.ts` guards the compute of one 25-message tick (pure stages under 8 ms). After a deploy, check the real numbers:

1. Cloudflare dashboard, Workers & Pages, `clearbox`, Observability, Query builder (Workers Logs must be enabled; `cloudflare.config.ts` enables invocation logs).
2. Filter invocation logs to the tick cron: `$metadata.message` equals `* * * * *` (cron invocations use the cron schedule as their message).
3. Visualize `$workers.cpuTimeMs` with P50, P99 and Max over the last 24 hours. P99 should stay well below 10; anything above 8 needs attention.
4. Find the slow ticks: filter `$workers.cpuTimeMs` greater than `8` and match them by time to the `tick.done` events (`evt = "tick.done"`), which carry `kind`, `fetched`, `decided` and `durationMs`.
5. Signs of CPU kills: `tick.claimed` without a matching `tick.done` or `tick.failed`, and accounts whose `page_size` dropped below 25 (each killed tick halves it on the next claim, minimum 5; successful ticks grow it back by 5).

If ticks are being killed, the adaptive page size recovers on its own. If it stays low for days, lower the work per page (see the benchmark notes in `docs/superpowers/plans/2026-10-15-clearbox-04-scan-pipeline.md`, Task 12) or move to Workers Paid and set `FREE_TIER=false`.
````

- [ ] **Step 4: Run the full app suite and repo checks**

Run: `pnpm --filter @clearbox/app test:worker && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm lint`
Expected: all worker tests pass; no type errors; ESLint and `scripts/check-text.ts` pass (no em dashes in any new file).

- [ ] **Step 5: Commit**

```bash
git add app/test/worker/tick/tick-cpu.test.ts docs/runbook.md
git commit -m "test(scan): add per-tick CPU benchmark and document the Workers Logs CPU check"
```

---

## Self-review

Spec coverage (contracts sections in scope):

| Requirement | Task |
|---|---|
| 8.1 entry points, cron routing by `controller.cron`, `TickOptions`, `runTick`, `runNightly` | 7, 10, 11 |
| 8.2 claim batch with exact `CLAIM_SQL`, lease, page-size halving, awaiting count | 2 |
| 8.2 kind selection, storage soft limit, Decision secrets check | 7 |
| 8.2 token load, refresh only below 5 minutes, rotated token persistence (success and failure) | 3, 5, 8 |
| 8.2 provider fetch, cursor resync, backfill restart | 7 |
| 8.2 context batch (known ids, priors, senders, correspondents, threads, labels newest 5, redecide rows) | 4 |
| 8.2 signals, guardrails, priors, state, `decideAll` concurrency 4, config error abort, outage abort, awaiting_model and retry schedule | 4, 7, 8 |
| 8.2 one write batch, idempotent inserts, senders, correspondents, sent threads, dismissals, account update, lease release | 5, 7 |
| 8.2 failure batch, statuses `needs_reauth` / `config_error`, audit, issues | 6, 8 |
| 8.2 budget upsert with real `meta.rows_written` | 5, 7 |
| 8.3 phase table and scheduling, round robin | 2, 5 |
| 8.4 subrequest budget <= 45 counting D1, graceful abort | 7, 8 |
| 8.5 shared helpers (`budgetUpsertStmt`) | 5 |
| 8.6 nightly lease, stale recovery, calibration, purge rounds, disconnected accounts, housekeeping, budget | 9, 10 |
| 7.5 scan-now route and pre-claim error mapping | 2, 11 |
| 9 log events (`tick.*`, `decision.error`, `provider.error`, `account.status`, `budget.gate`, `issue.*`, `config.invalid`, `nightly.done`) | 7, 8, 10 |
| 10.4 cron path test through `scheduled` | 11 |
| Amendment 12.1 A4 (`inbox_estimate`) and A5 (calibration `{ tauDelete }`) | 5, 7, 10 |
| CPU benchmark and Workers Logs check | 12 |

Type consistency checked across tasks: `Stmt`, `BatchResult`, `TickAccountRow`, `PreparedItem`, `FinalItem`, `DecideStage`, `AccountAdvance`, `SuccessWriteInput.inboxEstimate`, `FailurePlan`, `TokenColumns`, `NightlyRunner`, `TickTimings` keep the same names and fields wherever they are used. Test counts per command were recomputed after the amendment edits.

## Open items for the lead

Resolved by the integration pass (contracts rev 2.2): C2 (the `scan/claim.ts`, `scan/context.ts`, `scan/failure.ts`, `scan/tick-tokens.ts` files and SQL in `scan/*.ts` and `nightly/*.ts` are in contracts 1.1 and 11), C26 (plan 02 exposes `MailProvider.inboxEstimate()`), connect-time `inbox_estimate` (plan 03 `completeConnect`), and every upstream signature (pinned by Task 1).

Still open:

1. `SELECT message_id FROM suggestions WHERE expires_at < ?` has no index; on a large table each nightly purge round scans until 500 matches. Fine at Free-plan volumes (rows read are cheap: 5M per day), but an index `suggestions (expires_at)` would cost one written row per suggestion insert and update; left out deliberately.
2. If D1 rejects `CLAIM_SQL` (Task 2 Step 5 fallback), report it so contracts 8.2 is updated.

## Execution notes

Executed on branch `feat/clearbox-04-scan-pipeline` (stacked on `feat/clearbox-03-worker-platform`) with superpowers:subagent-driven-development: one implementer per task, a spec and quality review after each task (fix rounds on Tasks 7 and 8), a final whole-branch review and one fix wave. No dependency was added and `packages/core` was not edited. No Produces name or signature changed: `runTick(env, opts)`, `TickOptions`, `runNightly(env, { now })`, `POST /api/accounts/:id/scan` and its codes (404 `not_found`, 409 `account_busy` with `retryAt`, 409 `account_inactive`, 429 `budget_exhausted` with `retryAt`), `scan/{claim,context,ingest,write-plan,failure,tick-tokens,engine}.ts`, `nightly/purge.ts`, `docs/runbook.md` (CPU section) and `messages.signals_json = JSON.stringify(Signals)`.

### Gate 04 result

`pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/surface.test.ts test/worker/db-isolation.test.ts && pnpm test && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm lint && pnpm format:check && git diff --quiet HEAD && echo committed` passes: surface and isolation `Test Files  2 passed (2)`, `Tests  11 passed (11)`; core `Test Files  40 passed (40)`, `Tests  635 passed (635)`; app worker `Test Files  49 passed (49)`, `Tests  387 passed (387)`; app web `Test Files  1 passed (1)`, `Tests  1 passed (1)`; `check-text: 265 tracked files clean`; `All matched files use Prettier code style!`; `committed`.

Counts: plan 03 left the worker run at 28 files and 220 tests. The plan as written adds 18 files and 95 tests (46 / 315). This branch has 21 new files (the 18 planned plus `tick/tick-edges.test.ts` and `tick/tick-fence.test.ts` from the final fix wave and `tick/tick-retention.test.ts` from the lead retention decision) and 167 new tests: the extra 72 are regression tests for the lead notes, the fix rounds and the final review (for example `receivedAt = 0`, duplicate ids on a page, empty key lists, `key_version` 2 refresh, `dismissSql` on `awaiting_model`, stale Graph URLs, Gmail worst-case subrequests, lease fencing, scan-now `retryAt` values, storage gate and page size edges, the incremental retention skip). Core and web are unchanged.

CPU benchmark (`test/worker/tick/tick-cpu.test.ts`, 25-message page, `FakeEngine`, MSW Graph provider, local workerd on an Apple M4, 20 samples after one warm-up): median pure stages 1 to 2 ms (budget 8), median wall minus awaited I/O 4 to 5 ms (budget 10) across four runs. workerd timers are whole milliseconds, so medians move by about 1 ms between runs.

### Live-verification outcomes (index items)

| # | Outcome |
|---|---|
| 8 | Local D1 (workerd) accepts the primary `CLAIM_SQL` (upsert after `LIMIT`); the Task 2 Step 5 fallback was not needed and contracts 8.2 needs no change. Production D1 is still unverified. |
| new | Local D1 reports one written row per deleted row in `meta.rows_written` (the purge test asserts `>= 1200` for 600 suggestions plus 600 messages, not the planned `>= 1800`). Production D1 may also count index writes. |
| new | A D1 `batch()` should count as one subrequest and one query against the Free per-invocation limits; the tick success batch can hold more than 50 statements. Confirm after the first deploy (plan 06). |

### Lead notes from earlier layers

| # | Handling |
|---|---|
| 1 | `ingest.ts` `prepareOne`: `receivedAt <= 0` forces `ageDays: 0` for guardrails, the Decision state and the stored signals, so `guard_too_recent` caps the item at keep; the redecide path applies the same rule. Tested. |
| 2 | Documented next to the reserved-call constants (worst case per Gmail metadata chunk: 3 batch POSTs plus one refresh); Decision-1 room is sized from the counter after the fetch. A Gmail worst-case tick test writes with 35 subrequests (limit 45). |
| 3 | `fetchPage` routes `CursorExpiredError("incremental")` to `resyncCursor` once and rethrows a second failure; unit tests with a scripted `MailProvider`. |
| 4 | Known and repeated `providerMessageId`s are skipped before Decision-1 and before writing (`skippedKnown`); tested in ingest and in a Graph delta tick. |
| 5 | `ProviderResponseError` with `status === 0` is a stale cursor: sent and backfill restart from `null`, incremental resyncs from the watermark. Tested with a lookalike-host delta link. |
| 6 | Not applicable: plan 04 never calls `trash`, `archive` or `restore`. A second Graph 401 (`ProviderAuthError("unauthorized")`) classifies as `needs_reauth`. |
| 7 | Core untouched. |
| 8 | `dismissSql` sets `action = COALESCE(action, 'unsure')`; a batch test dismisses an `awaiting_model` row. |
| 9 | Stale-`approved` recovery runs one `UPDATE ... WHERE account_id = ?1 ...` per account in one batch (none when there are no accounts). The isolation test now checks every owned-table literal in `nightly/*.ts` (exemptions `calibration`, `purge_expired`, `purge_disconnected`) and in `scan/*.ts` (no exemptions); both were proven to fail on a mutation. |
| 10 | `encryptTokenUpdate` encrypts under the row's `key_version` (comment points to `tokenUpdateStmt`, decision 23); tested with a version-2 row. Seed helpers default to `CURRENT_KEY_VERSION`. |
| 11 | Provider calls stay sequential per account (comments in `openTickTokens` and `fetchPage`). |
| 12 | Context builders, `removedIds` dismissals and `batchRunner` emit nothing for empty lists; nightly skips recovery with no accounts. |
| 13 | `provider-mock.ts` records unmocked requests (`useNetwork` and `useNetworkOpen`); every tick, nightly, scheduled, scan-route and benchmark test calls `expectNoUnhandled()` in `afterEach`, and the benchmark asserts `errorCode: null` per tick. |
| 14 | See "Counts" above. |

### Deviations (fix forward)

| # | Task | Change | Why |
|---|---|---|---|
| 1 | 4 | `withLowerSender` lowercases the sender address before the identity pass and signals | Core `extractSignals` does not lowercase while `registrableDomain` does; context keys, prior keys and stored senders must match (C12) |
| 2 | 7 | Graph test mock pages with `lt` (as the provider does) and answers the first filtered delta round after a resync with mail; it records the resync `$filter` | The planned mock ignored `lt` (backfill never advanced) and returned nothing after a resync |
| 3 | 7 | A partial incremental poll keeps `last_incremental_at` (`computeAdvance`) | Otherwise the interleave returned to backfill and the rest of the page waited up to 30 minutes (C9 intent) |
| 4 | 7 | `Stopwatch.io` measures the union of concurrent I/O intervals; `freeTier` comes from the validated config; `fetchPage` is exported for unit tests; one shared `batchRunner` (tick and nightly) | Concurrent Decision-1 calls were double counted, which made the C20 check too lenient; typecheck; duplication |
| 5 | 8 | `tick.ts` split into `fetch.ts`, `tick-stats.ts`, `tick-process.ts`, `tick-finish.ts`; `write-plan.ts` is a barrel over `stmt.ts`, `plan-builders.ts`, `success-write.ts` (every symbol still importable from `write-plan.ts`) | Contracts section 11: files over 500 lines must be split. Lead: add these files to contracts 1.1 |
| 6 | 8 | `decision_not_configured` clears as soon as the engine is configured; `failTick` clears `<provider>_client_invalid` after a successful refresh; if the failure write itself fails, `runTick` logs `tick.failed` and returns an error report instead of throwing (lease expires by TTL) | A quiet account kept the banner forever; brief contract "never throws after a claim" |
| 7 | 10 | The nightly claim batch reads `id, status` of every account: per-account stale recovery and disconnected-only purge | Lead note 9; `purgeDisconnected` does not re-check status |
| 8 | final | Success and failure account updates and the sender upserts are fenced on the held lease (`EXISTS (SELECT 1 FROM leases WHERE name = 'account:' \|\| ? AND holder = ? AND released_at IS NULL)`) | A tick stalled past `LEASE_TTL_MS` could commit after another tick took the lease (double counted senders, cursor regression) |
| 9 | final | Retry-After clamped to `BACKOFF_MAX_MS`; an unknown DB size (no budget row yet today) neither raises nor clears `storage_near_limit`; a storage-gated backfill account polls at the incremental interval; a subrequest budget failure at the page-size floor backs off normally; the stored `page_size` is clamped to the tier maximum | Unbounded backoff, daily issue flapping, minute polling, endless retries, `FREE_TIER` flips |
| 10 | final | `docs/runbook.md` step 5 also mentions page-size halving on subrequest budget failures | Accuracy |

C27 kept: tick audit rows `reauth_required` / `config_error` store `{"reason": <code>}` through the local `auditStmt` in `scan/plan-builders.ts`, while plan 03's `db/audit.ts` normalizes those kinds to `{}`. A5 does not fix these keys; plan 05 should not rely on either shape.

### Lead decision: incremental retention skip

- Rule: during an `incremental` tick, `processAccount` drops every inbox `added` message with `receivedAt < now - DECIDED_TTL_MS` (30 days, from `@clearbox/core`; the earliest a message row can be purged) before `identify` and the context reads, so dropped items cost no D1 reads and no Decision-1 calls. Younger mail is either still stored (skipped as known) or genuinely new.
- Exception: `receivedAt <= 0` means the date is unknown (provider mapper fallback) and is kept; `guard_too_recent` caps it at keep.
- Scope: inbox `added` of incremental ticks for both providers. Unaffected: `inbox_backfill`, `sent_backfill`, incremental `sent` items, `removedIds`, `redecide`. `fetched` still counts what the provider returned.
- Why: Graph delta reports updates (read, flagged, categories) of old mail in `added`, and Gmail history can re-report it (for example an INBOX label re-added); after the nightly purge deletes the row, the known-id check no longer catches it and it would return as a new pending suggestion.
- Logging: `tick.done` carries `skippedOld` (a count, no ids). `TickReport` is unchanged (frozen for plan 05).
- Implementation: pure `dropBeyondRetention(messages, now)` in `app/src/worker/scan/ingest.ts`.
- Tests: `dropBeyondRetention` unit tests in `ingest.test.ts`; `tick-retention.test.ts` covers a Graph delta re-report of a 40-day-old message skipped next to a fresh one that is ingested and decided, the same rule on Gmail history, `skippedOld: 0` when nothing is old, and an `inbox_backfill` page where a 40-day-old message is still ingested.

### Notes for later plans

- Plan 05:
  - Scan-now returns `TickReport` (`outcome` `processed`, `idle` or `error`). With an invalid server config it returns 200 with an idle report (contracts 8.2), but Access already fails `/api/*` with 500 `access_misconfigured` in that case.
  - `account_inactive` (409) is returned both for `needs_reauth`/`config_error` (no `retryAt`) and for an account in backoff (with `retryAt` = `backoff_until`).
  - Decision issues `decision_auth_failed` and `decision_deployment_not_found` clear only after a successful decision, so they can stay up on a quiet account after the owner fixes them.
- Plan 06:
  - Runbook: keep the CPU section; it now mentions page-size halving on subrequest budget failures.
  - Contracts 1.1 / 11 should list the extra scan files (deviation 5).
  - Graph delta re-reports of old mail: resolved, see "Lead decision: incremental retention skip" under Execution notes.
  - Lost-lease fencing covers account and sender writes only; message and suggestion inserts stay idempotent but unfenced, so after a stall over 5 minutes some sender counters can stay low. A fenced tick still reports `processed` and drops a rotated refresh token (Microsoft keeps the previous token valid).
  - Global `settings.issues` is read at claim and written at the end of a tick; concurrent ticks on different accounts can lose an issue update, which the next tick repairs.
  - Confirm on Linux CI that the benchmark margin holds (local medians 1 to 2 ms against 8).

### Deferred minor findings (triaged by the final review as safe to defer)

Test hygiene and coverage gaps (order-dependent harness test, `page_size` floor and no-halve, `numbered(start, 0)`, `pair()` null, Decision `retryAfterMs`, budget write failure, D1 call saturation in nightly, bound account ids in the recovery test, mid-run purge write gate, 401/403 on scan-now, timer granularity); `parseTickSettings` silent fallbacks; duplicated encrypt block in `encryptTokenUpdate` (plan-mandated); sent recipients not lowercased; unvalidated `signals_json` on redecide; unbounded redecide priors and labels subqueries; `applyIssues` clears by code only; audit row written for an account disconnected mid-tick; unused `ClassifyContext.provider`; `fetchInboxEstimate` swallows all errors (best effort, C26); `purgeDisconnected` table deletes not status-guarded (callers pass disconnected ids only); purge `LIMIT 1000` repeated in literals; benchmark uses `FakeEngine` (Decision request building and parsing not measured).
