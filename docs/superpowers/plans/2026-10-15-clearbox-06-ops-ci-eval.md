# Clearbox 06: Ops, Docs, CI and Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Clearbox deployable, operable and measurable: an idempotent `pnpm setup:cf`, Azure IaC for Microsoft-Decision-1, setup guides, runbook and security docs, CI with CodeQL and Dependabot, a text hygiene gate, and an offline eval harness against the live Decision-1 deployment.

**Architecture:** Repository scripts are plain TypeScript run by Node 24 type stripping (no build step); every shell call in `setup:cf` goes through an injectable `CommandRunner` and every prompt through a `Prompter`, so the orchestration is unit-tested with fakes and `node:test`. Azure resources are two Bicep files driven by `deploy-decision.sh` (what-if, confirm, create). The `@clearbox/eval` workspace package runs the real `@clearbox/core` pipeline (signals, guardrails, `MaiDecisionEngine`, fusion) over JSONL fixtures and writes a markdown report into the git-ignored `eval/private/`.

**Tech Stack:** Node.js 24.13 (type stripping, `node:test`), pnpm 12.11.2, TypeScript 6.0.3, Vitest 5.0.4, zod 4.6.7, `cf` 1.0.0-beta.17, Azure CLI with Bicep (`Microsoft.CognitiveServices@2026-07-01`), bash plus ShellCheck, GitHub Actions (checkout v7.0.1, pnpm/action-setup v6.1.0, setup-node v7.1.0, codeql-action v4.38.3, all pinned by commit SHA), Dependabot.

## Global Constraints

Copied from `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` (the source of truth; section numbers in brackets). Every task implicitly includes these.

- Node.js `>=24.13.0`, `packageManager` `pnpm@12.11.2`, `.nvmrc` `24` [1.1, 1.3, 2].
- Root scripts are fixed: `"lint": "eslint . && node scripts/check-text.ts"`, `"setup:cf": "node scripts/setup-cf.ts"`, `"deploy:cf": "pnpm --filter @clearbox/app deploy:cf"`, `"gen-key": "node scripts/gen-key.ts"`, `"eval": "pnpm --filter @clearbox/eval eval"` [1.3].
- `app/package.json`: `"deploy:cf": "cf workers types && tsc -b && cf deploy --no-provision"`, `"db:migrate:local": "cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local --persist-to .cloudflare/state"` [1.3].
- `eval/package.json` script `"eval": "node src/run.ts"`; reads `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_KEY`, `AZURE_DECISION_DEPLOYMENT` from the process environment, never from files in the repo [1.3].
- Exact dependency versions only; adding a dependency requires an exact verified version [2, 11]. Versions used here: `typescript` 6.0.3, `@types/node` 24.19.2, `vitest` 5.0.4, `zod` 4.6.7, `cf` 1.0.0-beta.17.
- Cloudflare: Worker `clearbox`, D1 `clearbox` created with `cf d1 create --name clearbox --jurisdiction eu`, crons `* * * * *` and `0 2 * * *`, Access application `Clearbox` with destination `{ "type": "worker", "worker_id": "<worker-id>" }` and policy allow `email == OWNER_EMAIL` [3.1].
- Build and deploy always use `--no-provision`; production config throws without a D1 id from `CLEARBOX_D1_ID` or `app/clearbox.local.json` (`{ "d1DatabaseId": "<uuid>" }`, git-ignored) [3.2].
- Secrets exactly: `AZURE_DECISION_ENDPOINT` (`https://<foundry-account>.services.ai.azure.com`, no trailing slash, no path), `AZURE_DECISION_KEY`, `AZURE_DECISION_DEPLOYMENT` (e.g. `decision-1`, must not be `Microsoft-Decision-1`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (empty string = provider disabled), `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY` (standard base64 of exactly 32 random bytes), `OWNER_EMAIL` (lowercase), `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `ACCESS_AUD` [3.7].
- Production secrets are set by `scripts/setup-cf.ts` through `cf deploy --no-provision --secrets-file <gitignored temp file>`, deleted afterwards; single-secret fallback `npx wrangler secret put <NAME> --name clearbox`. Never put Worker secrets in `.env` [3.7].
- `scripts/check-text.ts` scans `git ls-files` text files and fails on U+2014, on `-----BEGIN` private-key blocks, and on `AZURE_DECISION_KEY=[A-Za-z0-9]{20,}` [3.8].
- ESLint: `no-console` is allowed in `scripts/**` and `eval/**`; `consistent-type-imports` and `no-explicit-any` are errors [3.8]. Prettier: `printWidth` 110, double quotes, trailing commas `all` [3.8].
- Erasable TypeScript only (no `enum`, `namespace`, parameter properties); relative imports use explicit `.ts` [1.2, 11].
- Decision-1: `POST ${endpoint}/providers/microsoft/v1/systemone`, header `api-key`, deployment `decision-1` of model `Microsoft-Decision-1`, format `Microsoft`, version `1`, SKU `DataZoneStandard`, capacity 300 RPM, `NoAutoUpgrade`, region `swedencentral`, retirement 2027-02-04 [4.9, design 3, 12].
- Redirect URIs are `${origin}/oauth/google/callback` and `${origin}/oauth/microsoft/callback`; production `https://clearbox.<subdomain>.workers.dev/...`, local `http://localhost:5173/...` [7.12].
- Logs never contain email addresses, subjects, snippets, provider ids, tokens, URLs or bodies [9].
- Eval runs via `pnpm eval` against the live deployment and never in CI [10.1]. Fixtures are synthetic only: `example.com`, `example.net`, `example.org`, `*.test`, `*.example`; owner `owner@example.test` [10.2].
- No em dashes (U+2014) anywhere, including commit messages [11]. No environment-specific values in tracked files: use `<your-account-id>`, `<subdomain>.workers.dev`, `<team>.cloudflareaccess.com`, `<foundry-account>`, `<resource-group>`, `<you@example.com>` [11].
- Amendments rev 2.1 [12]: `axe-core` 4.14.0 and `@testing-library/user-event` 14.6.8 are app dev dependencies (covered by the Dependabot `test` group here). Reason templates use "trashed" (docs here never quote templates).

---

## Contract issues and decisions

Decisions taken in this plan where the contracts document is silent or conflicts with the plan brief. The contracts document was not edited; plan 00 (index) should fold these into contracts section 1.1, 2 and 3.9.

| #   | Issue                                                                                                                                                                                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Contracts 1.1 lists only `scripts/{check-text,setup-cf,gen-key}.ts`, `eval/src/{run,metrics}.ts`, `eval/fixtures/emails.jsonl`; "files not listed must not be created without updating this section". | Add focused files: `scripts/tsconfig.json`, `scripts/lib/{is-main,run,prompt,setup-config}.ts`, `scripts/test/*.test.ts`, `eval/vitest.config.ts`, `eval/src/{fixtures,pipeline,report,io,export-labels}.ts`, `eval/test/*.test.ts`, `docs/security-review-checklist.md`. Each has one responsibility; tests follow section 10 naming.                                                                                                                                                                                                                                |
| C2  | The plan brief names `infra/azure/provision.sh`; contracts 1.1 names `infra/azure/decision.bicep`, `decision-existing.bicep`, `deploy-decision.sh` ("az CLI equivalent of the Bicep files").          | Contract names win. `deploy-decision.sh` drives the Bicep files through `az deployment group what-if` then `create` (what-if only exists for ARM deployments). The imperative `az cognitiveservices` equivalent is documented in `docs/setup-azure.md` section 4.                                                                                                                                                                                                                                                                                                     |
| C3  | Root `pnpm -r test` and `pnpm -r typecheck` skip the root package, and contracts 1.3 fixes the root scripts, so nothing would run tests or typecheck for `scripts/`.                                  | Script tests use the built-in `node:test` (no new dependency) and CI runs `node --test "scripts/test/*.test.ts"` and `pnpm exec tsc -p scripts/tsconfig.json` as explicit steps. No root script is added.                                                                                                                                                                                                                                                                                                                                                             |
| C4  | Contracts 1.3 gives `@clearbox/eval` only the `eval` script; section 2 does not list `zod` for eval.                                                                                                  | `eval/package.json` adds `export-labels`, `typecheck` and `test` scripts (so `pnpm -r typecheck/test` cover eval) and depends on `zod` 4.6.7 (same pinned version as core and app).                                                                                                                                                                                                                                                                                                                                                                                   |
| C5  | Contracts 3.9 ("final content") has no git-ignored location for exported owner labels or eval reports.                                                                                                | Append `eval/private/` to `.gitignore`. `export-labels` always, and `pnpm eval` whenever a fixture has `source: "owner"`, refuse to write unless `git check-ignore` confirms the output path (fail closed).                                                                                                                                                                                                                                                                                                                                                           |
| C6  | Contracts 3.8 lists three `check-text` patterns; the brief asks for common secret patterns.                                                                                                           | Keep the three and add: dotenv literal assignments of Clearbox secrets (values starting with `<` are placeholders and allowed), AWS key ids, GitHub tokens, Google API keys, Google OAuth client secrets, Entra client secrets, Slack tokens, Azure storage keys, JWTs. A line containing `check-text: allow` is exempt from secret rules (never from the em dash rule). Scans tracked plus untracked non-ignored files, skips `pnpm-lock.yaml`, binaries and files over 2 MB. Plan 01 creates `scripts/check-text.ts` (three rules); Task 1 replaces it with this superset. Verified by the integration pass: no file or plan in plans 01 to 05 trips these rules (synthetic keys are YAML/TS values, not dotenv lines; JWTs and tokens are built at runtime), so no other plan needs the marker. |
| C7  | Contracts 3.2 defines `app/clearbox.local.json` as `{ "d1DatabaseId": "<uuid>" }`.                                                                                                                    | `setup:cf` also stores optional `appOrigin` (the Worker URL) to print redirect URIs on re-runs. `remoteD1Id()` ignores the extra key.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C8  | Contracts 3.7 says "gitignored temp file" without a path.                                                                                                                                             | `app/deploy.secrets.json` (matched by `*.secrets.json`), mode 600, verified with `git check-ignore` before writing, deleted in `finally`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| C9  | Research leaves open whether `cf deploy --secrets-file` keeps secrets that are not in the file (cloudflare.md Q5).                                                                                    | Assume merge semantics (documented Wrangler behavior), and verify after every deploy with `cf workers secrets list --worker clearbox` (prints missing names). `TOKEN_ENC_KEY` and `STATE_SIGNING_KEY` are generated only when absent, or on explicit `--rotate-token-key` / `--rotate-state-key`.                                                                                                                                                                                                                                                                     |
| C10 | Before the D1 database exists, a `cf` command run inside `app/` might evaluate `cloudflare.config.ts` and throw.                                                                                      | Account-level `cf` commands run from the repository root using the pinned binary `app/node_modules/.bin/cf`; migrations use `--dir app/migrations`; deploy runs `pnpm run deploy:cf --secrets-file <abs path>` in `app/` (pnpm appends the arguments to the script, so they reach `cf deploy --no-provision`) with `CLEARBOX_D1_ID` set.                                                                                                                                                                                                                              |
| C11 | The Access application needs the Worker id, so `ACCESS_AUD` cannot exist before the first deploy.                                                                                                     | First run deploys twice: everything except `ACCESS_AUD`, then only `ACCESS_AUD` after the owner creates the Access application. The Worker fails closed in between. If `cf deploy` refuses a version with a declared but missing secret (unverified), the documented workaround is a placeholder AUD (rejected by every JWT).                                                                                                                                                                                                                                         |
| C12 | Contracts have `accounts.key_version` and AAD `v<keyVersion>` but only one `TOKEN_ENC_KEY` secret.                                                                                                    | v1 rotation is reconnect-based (runbook section 2): pause accounts, rotate, Reconnect each account, resume. `key_version` stays 1 and is reserved for a future dual-key scheme. Relies on plan 03/04 treating a decrypt failure as a safe tick failure and allowing Reconnect of a paused account.                                                                                                                                                                                                                                                                    |
| C13 | The brief points to "the location contracts 10.2 specifies" for eval fixtures; 10.2 covers core fixtures.                                                                                             | Use `eval/fixtures/emails.jsonl` from 1.1 and enforce the 10.2 synthetic-domain rule in the loader.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C14 | Eval scope.                                                                                                                                                                                           | Eval runs signals, guardrails (`DEFAULT_POLICY`), `MaiDecisionEngine` and `fuse` with no prior (`selectPrior(null, null, ...)`) and no `similar_past_decisions`, so it measures the model plus deterministic layers. Owner-label export uses `labels` joined to unpurged `messages` (`signals_json`), so only labels decided in the last 30 days are exportable.                                                                                                                                                                                                      |
| C15 | `DecisionError` constructor shape (4.12: "single options object matching the readonly fields").                                                                                                       | Eval tests construct `new DecisionError({ kind, status, retryable, scope, retryAfterMs, requestId })`, which is plan 01's `DecisionErrorOptions` (the `code` is derived as `decision_<kind>`; verified by the integration pass).                                                                                                                                                                                                                                                                                                                                                                                                      |
| C16 | `cf workers types` and `cf build` evaluate `cloudflare.config.ts` in production mode, which throws without a D1 id.                                                                                   | CI sets `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000` (the public local id). CI never deploys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C17 | `typescript-eslint` 8.71.2 peers `typescript <6.1.0` (contracts 2).                                                                                                                                   | Dependabot ignores `typescript >=6.1.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Interfaces consumed from other plans

| From                       | Interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan 01                    | Root `package.json` scripts and dev dependencies [1.3], `pnpm-workspace.yaml` (includes `eval`), `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.nvmrc`, `.gitignore` [3.9], `scripts/check-text.ts` (replaced by Task 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Plan 01 (`@clearbox/core`) | `extractSignals(msg, history, ctx)`, `evaluateGuardrails({ signals, subject, snippet }, policy)`, `DEFAULT_POLICY`, `selectPrior(sender, domain, address, domainName)`, `buildDecisionState({ msg, signals, pastDecisions })`, `buildDecisionQuestions(seed)`, `decisionSeed(accountId, providerMessageId)`, `fnv1a32(text)`, `MaiDecisionEngine(config)`, `FakeEngine({ overrides })` with `.calls`, `DecisionError`, `fuse(input)`, `mapWithConcurrency(items, limit, fn)`, `TAU_DELETE_DEFAULT`, `DELETE_MARGIN`, `MIN_CONFIDENCE`; types `MailMessage`, `MailHeaders`, `Signals`, `ActionKind`, `SuggestedAction`, `Ceiling`, `DecisionEngine`, `DecisionInput`, `DecisionResult`, `DecisionState`, `GuardrailResult`, `Prior`, `Thresholds` (contracts 4.1 to 4.15). |
| Plan 03                    | `app/package.json` scripts `deploy:cf` and `db:migrate:local`, `app/cloudflare.config.ts` (`CLEARBOX_D1_ID` / `app/clearbox.local.json`), `app/.dev.vars.example`, `app/migrations/0001_init.sql`, `/oauth/{google,microsoft}/callback`, fail-closed `access_misconfigured`, account pause and Reconnect, the test files named in the security checklist.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plans 03 and 04            | Schema `app/migrations/0001_init.sql` (plan 03): `labels` (`id`, `account_id`, `message_id`, `owner_action`, `subject_trunc`) written by plan 03's owner actions (`actions/learn.ts`); `messages.signals_json` = `JSON.stringify(Signals)` written by plan 04's tick (`scan/write-plan.ts`); nightly purge and calibration (plan 04).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plan 05                    | UI names used in docs (UI spec 3.5, 5.5): the **Accounts** page at `/accounts` (Connect Gmail, Connect Outlook, Reconnect, Pause, Resume, Disconnect, Scan now), Activity (Undo), Insights, app banners ("Google sign-in is misconfigured.", "Microsoft sign-in is misconfigured."). OAuth callbacks land on `/settings/accounts`, which the SPA forwards to `/accounts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

This plan produces no runtime interfaces for other plans. It produces the commands `pnpm setup:cf`, `pnpm gen-key`, `pnpm lint` (text gate), `pnpm eval`, `pnpm --filter @clearbox/eval export-labels`, and `infra/azure/deploy-decision.sh`.

## File Structure

| Path                                                                                 | Responsibility                                                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `scripts/tsconfig.json`                                                              | Typecheck config for repository scripts (Node types)                                                                 |
| `scripts/lib/is-main.ts`                                                             | `isMain(import.meta.url)`: run `main()` only when executed directly                                                  |
| `scripts/gen-key.ts`                                                                 | `generateKey()`, `isValidKey()`; prints a key                                                                        |
| `scripts/check-text.ts` (replace plan 01's file) | `TEXT_RULES`, `scanText()`, `isProbablyBinary()`; repo scan used by `pnpm lint` |
| `scripts/lib/run.ts`                                                                 | `CommandRunner` interface and the `spawn`-based implementation (no shell)                                            |
| `scripts/lib/prompt.ts`                                                              | `Prompter` interface and the raw-mode terminal implementation (hidden input)                                         |
| `scripts/lib/setup-config.ts`                                                        | Pure setup helpers: secret specs and validators, `cf` JSON parsing, local config, redirect URIs, Access instructions |
| `scripts/setup-cf.ts`                                                                | `runSetup(deps)` orchestration and CLI entry                                                                         |
| `scripts/test/*.test.ts`                                                             | `node:test` suites for the four modules above                                                                        |
| `infra/azure/decision.bicep`                                                         | New AIServices account (swedencentral) plus the `decision-1` deployment                                              |
| `infra/azure/decision-existing.bicep`                                                | Deployment only, into an existing account                                                                            |
| `infra/azure/deploy-decision.sh`                                                     | what-if, confirm, create, verify, optional smoke test; never prints keys                                             |
| `eval/package.json`, `eval/tsconfig.json`, `eval/vitest.config.ts`                   | `@clearbox/eval` workspace package                                                                                   |
| `eval/fixtures/emails.jsonl`                                                         | 40 synthetic labeled emails                                                                                          |
| `eval/src/fixtures.ts`                                                               | Fixture schema, loader, reserved-domain guard, `toMailMessage`                                                       |
| `eval/src/metrics.ts`                                                                | Precision/recall, Wilson bound, confusion, reliability, threshold sweep, shuffle robustness, percentiles             |
| `eval/src/pipeline.ts`                                                               | Per-fixture core pipeline, pacing, eval-only retries, shuffle seed                                                   |
| `eval/src/report.ts`                                                                 | `summarize(rows)` and the markdown report                                                                            |
| `eval/src/io.ts`                                                                     | Paths, `isMain`, `assertGitIgnored`, `readD1Id`                                                                      |
| `eval/src/run.ts`                                                                    | `pnpm eval` CLI                                                                                                      |
| `eval/src/export-labels.ts`                                                          | D1 owner-label export to the git-ignored `eval/private/`                                                             |
| `eval/test/*.test.ts`                                                                | Vitest suites                                                                                                        |
| `.gitignore`                                                                         | Modify: add `eval/private/`                                                                                          |
| `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml` | CI, CodeQL, dependency updates                                                                                       |
| `README.md`, `SECURITY.md`, `LICENSE` | Project overview, security policy and threat model summary, MIT license |
| `docs/setup-{cloudflare,azure,google,microsoft}.md`                                  | Setup guides                                                                                                         |
| `docs/runbook.md` (replace plan 04's one-section file), `docs/security-review-checklist.md` | Operations and the pre-deploy gate |

Execution order: this plan runs after plans 01 to 05 (index plan 00). Tasks 1 to 4, 10 and 11 need only plan 01's scaffold; Task 12 replaces plan 04's `docs/runbook.md`; Tasks 5 to 9 need `@clearbox/core` from plan 01; Task 13 needs plans 01 to 05 merged.

---

### Task 1: Text hygiene gate and key generator

**Files:**

- Create: `scripts/tsconfig.json`, `scripts/lib/is-main.ts`, `scripts/gen-key.ts`
- Replace: `scripts/check-text.ts` (plan 01 Task 1 created it with three rules; this task replaces the whole file with the extended gate below, keeping those three rules, the `node scripts/check-text.ts` entry point and exit code 1 on findings)
- Test: `scripts/test/gen-key.test.ts`, `scripts/test/check-text.test.ts`

**Interfaces:**

- Consumes: root `package.json` scripts `lint` (`eslint . && node scripts/check-text.ts`) and `gen-key` (`node scripts/gen-key.ts`) from plan 01; `tsconfig.base.json`; plan 01's `scripts/check-text.ts` (rules: em dash, `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`, `/AZURE_DECISION_KEY=[A-Za-z0-9]{20,}/`), which this task replaces.
- Produces: `isMain(importMetaUrl: string): boolean`; `KEY_BYTES = 32`; `generateKey(random?: (size: number) => Uint8Array): string`; `isValidKey(value: string): boolean`; `TextRule { id; description; pattern: RegExp; allowable: boolean }`; `Finding { path; line; column; rule }`; `ALLOW_MARKER = "check-text: allow"`; `TEXT_RULES`; `scanText(path: string, text: string, rules?): Finding[]`; `isProbablyBinary(bytes: Uint8Array): boolean`; `describeRule(id: string): string`.

- [ ] **Step 1: Add the scripts tsconfig**

Create `scripts/tsconfig.json` with exactly this content:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["*.ts", "lib", "test"]
}
```

- [ ] **Step 2: Write the failing tests**

Test inputs that look like secrets are assembled at runtime (`join(...)`), so the test file never matches its own rules.

Create `scripts/test/gen-key.test.ts` with exactly this content:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KEY_BYTES, generateKey, isValidKey } from "../gen-key.ts";

describe("generateKey", () => {
  it("returns standard base64 of 32 bytes", () => {
    const key = generateKey();
    assert.equal(key.length, 44);
    assert.equal(Buffer.from(key, "base64").length, KEY_BYTES);
    assert.ok(isValidKey(key));
  });

  it("uses the injected random source", () => {
    const key = generateKey((size) => new Uint8Array(size).fill(7));
    assert.equal(key, Buffer.alloc(32, 7).toString("base64"));
  });

  it("rejects a short random source", () => {
    assert.throws(() => generateKey((size) => new Uint8Array(size - 1)), /expected 32 random bytes/);
  });

  it("returns different keys on each call", () => {
    assert.notEqual(generateKey(), generateKey());
  });
});

describe("isValidKey", () => {
  it("rejects wrong lengths and alphabets", () => {
    assert.equal(isValidKey(Buffer.alloc(16, 1).toString("base64")), false);
    assert.equal(isValidKey(Buffer.alloc(32, 1).toString("base64url")), false);
    assert.equal(isValidKey(""), false);
  });
});
```

Create `scripts/test/check-text.test.ts` with exactly this content:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALLOW_MARKER, isProbablyBinary, scanText } from "../check-text.ts";

// Secret-shaped inputs are assembled at runtime so this file never matches its own rules.
const join = (...parts: string[]): string => parts.join("");

function rulesFor(text: string): string[] {
  return scanText("x.txt", text).map((f) => f.rule);
}

describe("scanText", () => {
  it("flags an em dash with line and column", () => {
    const findings = scanText("doc.md", `first line\nsecond ${"\u2014"} line`);
    assert.deepEqual(findings, [{ path: "doc.md", line: 2, column: 8, rule: "em-dash" }]);
  });

  it("allows en dashes and plain hyphens", () => {
    assert.deepEqual(rulesFor("ranges 1\u20135 and a - b"), []);
  });

  it("never exempts em dashes, even with the allow marker", () => {
    assert.deepEqual(rulesFor(`a ${"\u2014"} b // ${ALLOW_MARKER}`), ["em-dash"]);
  });

  it("flags private key blocks", () => {
    assert.deepEqual(rulesFor(join("-----", "BEGIN RSA PRIVATE KEY", "-----")), ["private-key"]);
    assert.deepEqual(rulesFor(join("-----", "BEGIN PRIVATE KEY", "-----")), ["private-key"]);
  });

  it("flags a real-looking AZURE_DECISION_KEY", () => {
    const rules = rulesFor(join("AZURE_DECISION_KEY", "=", "a1B2c3D4e5F6g7H8i9J0k1L2"));
    assert.ok(rules.includes("azure-decision-key"));
  });

  it("accepts placeholder dotenv values", () => {
    assert.deepEqual(
      rulesFor("AZURE_DECISION_KEY=<key>\nTOKEN_ENC_KEY=<pnpm gen-key>\nACCESS_AUD=<access-aud-tag>"),
      [],
    );
  });

  it("flags literal Clearbox secrets in dotenv files", () => {
    assert.deepEqual(rulesFor(join("TOKEN_ENC_KEY", "=", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")), [
      "clearbox-secret-assignment",
    ]);
  });

  it("flags common provider token shapes", () => {
    const cases: [string, string][] = [
      [join("AKIA", "ABCDEFGHIJKLMNOP"), "aws-access-key"],
      [join("ghp", "_", "a".repeat(36)), "github-token"],
      [join("github", "_pat_", "b".repeat(30)), "github-token"],
      [join("AIza", "c".repeat(35)), "google-api-key"],
      [join("GOCSPX", "-", "d".repeat(28)), "google-oauth-secret"],
      [join("abc", "8Q~", "e".repeat(32)), "entra-client-secret"],
      [join("xoxb", "-", "1234567890-abc"), "slack-token"],
      [join("AccountKey", "=", "f".repeat(86), "=="), "azure-storage-key"],
      [join("eyJ", "hbGciOiJSUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "g".repeat(20)), "jwt"],
    ];
    for (const [text, rule] of cases) assert.deepEqual(rulesFor(text), [rule], rule);
  });

  it("exempts allowable rules on lines with the allow marker", () => {
    assert.deepEqual(rulesFor(`${join("AKIA", "ABCDEFGHIJKLMNOP")} // ${ALLOW_MARKER}`), []);
  });

  it("does not flag the synthetic base64 test keys or ordinary prose", () => {
    const text =
      'TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",\nThe key is set by pnpm setup:cf.';
    assert.deepEqual(rulesFor(text), []);
  });
});

describe("isProbablyBinary", () => {
  it("detects NUL bytes", () => {
    assert.equal(isProbablyBinary(new Uint8Array([72, 0, 73])), true);
    assert.equal(isProbablyBinary(new TextEncoder().encode("plain text")), false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test "scripts/test/gen-key.test.ts" "scripts/test/check-text.test.ts"`
Expected: FAIL: `ERR_MODULE_NOT_FOUND` for `scripts/gen-key.ts`, and `check-text.test.ts` fails with `does not provide an export named 'ALLOW_MARKER'` (plan 01's `scripts/check-text.ts` exports nothing).

- [ ] **Step 4: Implement**

Create `scripts/lib/is-main.ts` with exactly this content:

```ts
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** True when the module at `importMetaUrl` is the script Node was started with. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
```

Create `scripts/gen-key.ts` with exactly this content:

```ts
import { randomBytes } from "node:crypto";
import { isMain } from "./lib/is-main.ts";

export const KEY_BYTES = 32;

/** Standard base64 of exactly 32 random bytes (TOKEN_ENC_KEY, STATE_SIGNING_KEY). */
export function generateKey(random: (size: number) => Uint8Array = (size) => randomBytes(size)): string {
  const bytes = random(KEY_BYTES);
  if (bytes.length !== KEY_BYTES) throw new Error(`expected ${KEY_BYTES} random bytes, got ${bytes.length}`);
  return Buffer.from(bytes).toString("base64");
}

export function isValidKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === KEY_BYTES;
}

if (isMain(import.meta.url)) {
  console.log(generateKey());
}
```

Replace the whole of `scripts/check-text.ts` (plan 01's version) with exactly this content:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { isMain } from "./lib/is-main.ts";

export interface TextRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** When true, a line containing ALLOW_MARKER is exempt (synthetic test values). */
  allowable: boolean;
}

export interface Finding {
  path: string;
  line: number;
  column: number;
  rule: string;
}

export const ALLOW_MARKER = "check-text: allow";
export const MAX_FILE_BYTES = 2_000_000;
export const SKIPPED_FILES: readonly string[] = ["pnpm-lock.yaml"];

export const TEXT_RULES: readonly TextRule[] = [
  {
    id: "em-dash",
    description: "U+2014 em dash; use a comma, colon, period or parentheses",
    pattern: /\u2014/g,
    allowable: false,
  },
  {
    id: "private-key",
    description: "PEM private key block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    allowable: true,
  },
  {
    id: "azure-decision-key",
    description: "AZURE_DECISION_KEY with a real-looking value",
    pattern: /AZURE_DECISION_KEY=[A-Za-z0-9]{20,}/g,
    allowable: true,
  },
  {
    id: "clearbox-secret-assignment",
    description: "Clearbox secret assigned a literal value in dotenv format",
    pattern:
      /^\s*(?:export\s+)?(?:AZURE_DECISION_KEY|TOKEN_ENC_KEY|STATE_SIGNING_KEY|GOOGLE_CLIENT_SECRET|MS_CLIENT_SECRET|ACCESS_AUD)=(?!<)\S{8,}/g,
    allowable: true,
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    allowable: true,
  },
  {
    id: "github-token",
    description: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    allowable: true,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    allowable: true,
  },
  {
    id: "google-oauth-secret",
    description: "Google OAuth client secret",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
    allowable: true,
  },
  {
    id: "entra-client-secret",
    description: "Microsoft Entra client secret",
    pattern: /\b[A-Za-z0-9_.-]{3}\dQ~[A-Za-z0-9_.~-]{31,34}/g,
    allowable: true,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    allowable: true,
  },
  {
    id: "azure-storage-key",
    description: "Azure storage account key",
    pattern: /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/g,
    allowable: true,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    allowable: true,
  },
];

export function scanText(path: string, text: string, rules: readonly TextRule[] = TEXT_RULES): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const allowed = line.includes(ALLOW_MARKER);
    for (const rule of rules) {
      if (allowed && rule.allowable) continue;
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({ path, line: index + 1, column: (match.index ?? 0) + 1, rule: rule.id });
      }
    }
  });
  return findings;
}

/** NUL byte in the first 8 KB means binary. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export function describeRule(id: string): string {
  return TEXT_RULES.find((rule) => rule.id === id)?.description ?? id;
}

function listFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter((path) => path.length > 0))];
}

function main(): number {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const findings: Finding[] = [];
  let scanned = 0;
  for (const path of listFiles(root)) {
    if (SKIPPED_FILES.includes(path)) continue;
    const full = join(root, path);
    let bytes: Buffer;
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      bytes = readFileSync(full);
    } catch {
      continue; // deleted but still tracked
    }
    if (isProbablyBinary(bytes)) continue;
    scanned++;
    findings.push(...scanText(path, bytes.toString("utf8")));
  }
  for (const f of findings)
    console.error(`${f.path}:${f.line}:${f.column} ${f.rule}: ${describeRule(f.rule)}`);
  if (findings.length > 0) {
    console.error(
      `check-text: ${findings.length} finding(s). Remove the value, or for a synthetic test value add "${ALLOW_MARKER}" on the same line (never for em dashes).`,
    );
    return 1;
  }
  console.log(`check-text: ${scanned} files clean`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "scripts/test/gen-key.test.ts" "scripts/test/check-text.test.ts"`
Expected: PASS, `ℹ tests 16`, `ℹ fail 0`.

- [ ] **Step 6: Typecheck, run the gate on the repository, try the key generator**

Run: `pnpm exec tsc -p scripts/tsconfig.json && node scripts/check-text.ts && pnpm gen-key | wc -c`
Expected: no tsc output; `check-text: <n> files clean`; `45` (44 base64 characters plus newline). If `check-text` reports findings in files from other plans, fix those files (or add `check-text: allow` to synthetic test lines) before continuing.

- [ ] **Step 7: Format and lint**

Run: `pnpm exec prettier --write scripts && pnpm lint`
Expected: ESLint prints nothing, then `check-text: <n> files clean`.

- [ ] **Step 8: Commit**

```bash
git add scripts/tsconfig.json scripts/lib/is-main.ts scripts/gen-key.ts scripts/check-text.ts scripts/test/gen-key.test.ts scripts/test/check-text.test.ts
git commit -m "feat(scripts): add text hygiene gate and key generator"
```

### Task 2: setup:cf building blocks

**Files:**

- Create: `scripts/lib/run.ts`, `scripts/lib/prompt.ts`, `scripts/lib/setup-config.ts`
- Test: `scripts/test/setup-config.test.ts`

**Interfaces:**

- Consumes: `isValidKey` from Task 1.
- Produces:
  - `RunOptions { cwd?: string; inherit?: boolean; env?: Readonly<Record<string, string>> }`, `RunResult { code: number; stdout: string; stderr: string }`, `CommandRunner { run(command, args: readonly string[], options?): Promise<RunResult> }`, `createNodeRunner(): CommandRunner`.
  - `Prompter { ask(question, defaultValue?): Promise<string>; askSecret(question): Promise<string>; confirm(question, defaultYes: boolean): Promise<boolean> }`, `createTerminalPrompter(input?, output?): Prompter`.
  - Constants `WORKER_NAME`, `D1_NAME`, `MIN_NODE_VERSION = "24.13.0"`, `MIN_PNPM_VERSION = "12.0.0"`, `LOCAL_CONFIG_PATH = "app/clearbox.local.json"`, `SECRETS_FILE_PATH = "app/deploy.secrets.json"`, `MIGRATIONS_DIR`, `FIRST_MIGRATION_PATH`, `CF_BIN_PATH = "app/node_modules/.bin/cf"`; `class SetupError`; `SECRET_NAMES` (contracts 3.7 order), `SecretName`, `SecretValues`, `SecretSpec`, `SECRET_SPECS`, `specFor(name)`; `normalizeEndpoint`, `validateEndpoint`, `validateDeploymentName`, `normalizeTeamDomain`, `validateTeamDomain`; `compareVersions(a, b): -1 | 0 | 1`; `parseJsonOutput(stdout): unknown`; `DatabaseInfo { uuid; name; jurisdiction: string | null }`, `extractDatabases(json)`, `extractSecretNames(json): Set<string>`, `extractWorkerId(json): string | null`; `LocalConfig { d1DatabaseId?; appOrigin? }`, `parseLocalConfig(text | null)`, `serializeLocalConfig(config)`; `normalizeOrigin(raw): string | null`; `redirectUris(origin)`; `renderSecretsFile(values)`; `accessInstructions({ workerId, ownerEmail, teamDomain })`; `oauthInstructions(origin)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/setup-config.test.ts` with exactly this content:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SECRET_NAMES,
  SECRET_SPECS,
  SetupError,
  accessInstructions,
  compareVersions,
  extractDatabases,
  extractSecretNames,
  extractWorkerId,
  normalizeEndpoint,
  normalizeOrigin,
  normalizeTeamDomain,
  oauthInstructions,
  parseJsonOutput,
  parseLocalConfig,
  redirectUris,
  renderSecretsFile,
  serializeLocalConfig,
  specFor,
  validateDeploymentName,
  validateEndpoint,
  validateTeamDomain,
} from "../lib/setup-config.ts";

describe("SECRET_SPECS", () => {
  it("covers every secret from contracts 3.7 exactly once, in order", () => {
    assert.deepEqual(
      SECRET_SPECS.map((s) => s.name),
      [...SECRET_NAMES],
    );
  });

  it("generates only the two keys", () => {
    assert.deepEqual(
      SECRET_SPECS.filter((s) => s.source === "generated").map((s) => s.name),
      ["TOKEN_ENC_KEY", "STATE_SIGNING_KEY"],
    );
  });

  it("hides every credential prompt", () => {
    for (const name of ["AZURE_DECISION_KEY", "GOOGLE_CLIENT_SECRET", "MS_CLIENT_SECRET"] as const) {
      assert.equal(specFor(name).hidden, true, name);
    }
  });
});

describe("endpoint", () => {
  it("normalizes a trailing slash and case", () => {
    assert.equal(
      normalizeEndpoint(" https://My-Acct.services.ai.azure.com/ "),
      "https://my-acct.services.ai.azure.com",
    );
  });

  it("accepts only the account root", () => {
    assert.equal(validateEndpoint("https://acct.services.ai.azure.com"), null);
    assert.notEqual(validateEndpoint("https://acct.services.ai.azure.com/api/projects/p"), null);
    assert.notEqual(validateEndpoint("https://acct.cognitiveservices.azure.com"), null);
    assert.notEqual(validateEndpoint("http://acct.services.ai.azure.com"), null);
  });
});

describe("validateDeploymentName", () => {
  it("rejects the reserved model name", () => {
    assert.match(validateDeploymentName("Microsoft-Decision-1") ?? "", /deployment name/);
    assert.equal(validateDeploymentName("decision-1"), null);
    assert.notEqual(validateDeploymentName("bad name"), null);
  });
});

describe("team domain", () => {
  it("expands short forms", () => {
    assert.equal(normalizeTeamDomain("my-team"), "https://my-team.cloudflareaccess.com");
    assert.equal(
      normalizeTeamDomain("My-Team.cloudflareaccess.com/"),
      "https://my-team.cloudflareaccess.com",
    );
    assert.equal(
      normalizeTeamDomain("https://my-team.cloudflareaccess.com"),
      "https://my-team.cloudflareaccess.com",
    );
    assert.equal(validateTeamDomain("https://my-team.cloudflareaccess.com"), null);
    assert.notEqual(validateTeamDomain("https://example.com"), null);
  });
});

describe("secret validators", () => {
  it("validates client ids", () => {
    assert.equal(specFor("GOOGLE_CLIENT_ID").validate("1234-abc.apps.googleusercontent.com"), null);
    assert.notEqual(specFor("GOOGLE_CLIENT_ID").validate("not-a-client"), null);
    assert.equal(specFor("MS_CLIENT_ID").validate("0d9f1c2e-1111-4222-8333-444455556666"), null);
    assert.notEqual(specFor("MS_CLIENT_ID").validate("0d9f1c2e"), null);
  });

  it("lowercases the owner email", () => {
    const spec = specFor("OWNER_EMAIL");
    assert.equal(spec.normalize(" Owner@Example.TEST "), "owner@example.test");
    assert.equal(spec.validate("owner@example.test"), null);
    assert.notEqual(spec.validate("owner"), null);
  });
});

describe("compareVersions", () => {
  it("compares numerically and ignores prerelease tags", () => {
    assert.equal(compareVersions("24.13.1", "24.13.0"), 1);
    assert.equal(compareVersions("v24.9.0", "24.13.0"), -1);
    assert.equal(compareVersions("12.11.2\n", "12.0.0"), 1);
    assert.equal(compareVersions("1.0.0-beta.17", "1.0.0"), 0);
  });
});

describe("parseJsonOutput", () => {
  it("parses plain JSON and JSON after a banner", () => {
    assert.deepEqual(parseJsonOutput('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(parseJsonOutput('Fetching...\n{"id":"x"}'), { id: "x" });
  });

  it("throws SetupError on garbage", () => {
    assert.throws(() => parseJsonOutput("not json"), SetupError);
  });
});

describe("extractors", () => {
  it("reads databases from arrays, wrapped results and single objects", () => {
    const db = { uuid: "11111111-2222-4333-8444-555555555555", name: "clearbox", jurisdiction: "eu" };
    assert.deepEqual(extractDatabases([db]), [db]);
    assert.deepEqual(extractDatabases({ result: [db] }), [db]);
    assert.deepEqual(extractDatabases({ uuid: db.uuid, name: "clearbox" }), [{ ...db, jurisdiction: null }]);
    assert.deepEqual(extractDatabases([{ name: "no-id" }]), []);
  });

  it("reads secret names and worker ids", () => {
    assert.deepEqual(
      [...extractSecretNames([{ name: "A", type: "secret_text" }, { name: "B" }])],
      ["A", "B"],
    );
    assert.equal(extractWorkerId({ id: "w-1", name: "clearbox" }), "w-1");
    assert.equal(extractWorkerId({}), null);
  });
});

describe("local config", () => {
  it("round-trips and drops invalid fields", () => {
    const config = {
      d1DatabaseId: "11111111-2222-4333-8444-555555555555",
      appOrigin: "https://c.example.workers.dev",
    };
    assert.deepEqual(parseLocalConfig(serializeLocalConfig(config)), config);
    assert.deepEqual(parseLocalConfig('{"d1DatabaseId":"nope","appOrigin":"http://x"}'), {});
    assert.deepEqual(parseLocalConfig(null), {});
    assert.throws(() => parseLocalConfig("{"), SetupError);
  });
});

describe("origin and redirect URIs", () => {
  it("normalizes origins", () => {
    assert.equal(normalizeOrigin("https://clearbox.sub.workers.dev/"), "https://clearbox.sub.workers.dev");
    assert.equal(normalizeOrigin("https://clearbox.sub.workers.dev/path"), null);
    assert.equal(normalizeOrigin("http://clearbox.sub.workers.dev"), null);
    assert.equal(normalizeOrigin("nonsense"), null);
  });

  it("derives the callback paths from contracts 7.12", () => {
    assert.deepEqual(redirectUris("https://c.example.workers.dev"), {
      google: "https://c.example.workers.dev/oauth/google/callback",
      microsoft: "https://c.example.workers.dev/oauth/microsoft/callback",
    });
    assert.match(oauthInstructions("https://c.example.workers.dev"), /oauth\/microsoft\/callback/);
  });
});

describe("renderSecretsFile", () => {
  it("writes only provided values in contract order", () => {
    const text = renderSecretsFile({
      OWNER_EMAIL: "o@example.test",
      AZURE_DECISION_DEPLOYMENT: "decision-1",
    });
    assert.deepEqual(Object.keys(JSON.parse(text) as object), ["AZURE_DECISION_DEPLOYMENT", "OWNER_EMAIL"]);
  });
});

describe("accessInstructions", () => {
  it("fills in the worker id and owner email", () => {
    const text = accessInstructions({ workerId: "w-1", ownerEmail: "o@example.test", teamDomain: null });
    assert.match(text, /"worker_id":"w-1"/);
    assert.match(text, /"email":"o@example.test"/);
    assert.match(text, /All traffic/);
    assert.match(text, /AUD/);
  });

  it("uses placeholders when values are unknown", () => {
    assert.match(
      accessInstructions({ workerId: null, ownerEmail: null, teamDomain: null }),
      /<you@example.com>/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "scripts/test/setup-config.test.ts"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/lib/setup-config.ts`.

- [ ] **Step 3: Implement the runner and the prompter**

The prompter reads the terminal in raw mode so hidden answers are never echoed. It is exercised through the fake in Task 3; the real one is only used interactively.

Create `scripts/lib/run.ts` with exactly this content:

```ts
import { spawn } from "node:child_process";
import process from "node:process";

export interface RunOptions {
  cwd?: string;
  /** Inherit stdio so the command can prompt the user. stdout and stderr are then not captured. */
  inherit?: boolean;
  env?: Readonly<Record<string, string>>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Real runner: spawn without a shell, so arguments are never interpreted. */
export function createNodeRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
          shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    },
  };
}
```

Create `scripts/lib/prompt.ts` with exactly this content:

```ts
import process from "node:process";

export interface Prompter {
  /** Visible input; returns the trimmed answer, or `defaultValue` when the answer is empty. */
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Hidden input (nothing is echoed); returns the trimmed answer. */
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
}

type Input = typeof process.stdin;
type Output = typeof process.stdout;

function readLine(input: Input, output: Output, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!hidden) output.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        if (!hidden) output.write(ch);
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createTerminalPrompter(
  input: Input = process.stdin,
  output: Output = process.stdout,
): Prompter {
  if (!input.isTTY) throw new Error("pnpm setup:cf is interactive. Run it in a terminal.");
  return {
    async ask(question, defaultValue) {
      output.write(defaultValue === undefined ? `${question}: ` : `${question} [${defaultValue}]: `);
      const answer = (await readLine(input, output, false)).trim();
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    async askSecret(question) {
      output.write(`${question} (input hidden): `);
      return (await readLine(input, output, true)).trim();
    },
    async confirm(question, defaultYes) {
      output.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `);
      const answer = (await readLine(input, output, false)).trim().toLowerCase();
      if (answer === "") return defaultYes;
      return answer === "y" || answer === "yes";
    },
  };
}
```

- [ ] **Step 4: Implement the pure helpers**

Create `scripts/lib/setup-config.ts` with exactly this content:

```ts
import { isValidKey } from "../gen-key.ts";

export const WORKER_NAME = "clearbox";
export const D1_NAME = "clearbox";
export const MIN_NODE_VERSION = "24.13.0";
export const MIN_PNPM_VERSION = "12.0.0";
export const LOCAL_CONFIG_PATH = "app/clearbox.local.json";
export const SECRETS_FILE_PATH = "app/deploy.secrets.json";
export const MIGRATIONS_DIR = "app/migrations";
export const FIRST_MIGRATION_PATH = "app/migrations/0001_init.sql";
export const CF_BIN_PATH = "app/node_modules/.bin/cf";

export class SetupError extends Error {
  override name = "SetupError";
}

export const SECRET_NAMES = [
  "AZURE_DECISION_ENDPOINT",
  "AZURE_DECISION_KEY",
  "AZURE_DECISION_DEPLOYMENT",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "TOKEN_ENC_KEY",
  "STATE_SIGNING_KEY",
  "OWNER_EMAIL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];
export type SecretValues = Partial<Record<SecretName, string>>;

export interface SecretSpec {
  name: SecretName;
  source: "generated" | "prompt";
  hidden: boolean;
  label: string;
  help: string;
  defaultValue: string | null;
  allowEmpty: boolean;
  normalize: (raw: string) => string;
  /** Error message, or null when valid. Never called with "". */
  validate: (value: string) => string | null;
}

const trim = (raw: string): string => raw.trim();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

export function validateEndpoint(value: string): string | null {
  return /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.services\.ai\.azure\.com$/.test(value)
    ? null
    : "Use the Foundry account root, for example https://<foundry-account>.services.ai.azure.com (no path, no trailing slash).";
}

export function validateDeploymentName(value: string): string | null {
  if (value.toLowerCase() === "microsoft-decision-1") {
    return "Use the deployment name (for example decision-1), not the model name Microsoft-Decision-1.";
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? null
    : "Deployment names use letters, digits, '.', '_' and '-'.";
}

export function normalizeTeamDomain(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/\/+$/, "");
  if (value === "") return "";
  if (!value.includes("://"))
    value = `https://${value.includes(".") ? value : `${value}.cloudflareaccess.com`}`;
  return value;
}

export function validateTeamDomain(value: string): string | null {
  return /^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(value)
    ? null
    : "Use your Zero Trust team domain, for example https://<team>.cloudflareaccess.com.";
}

export const SECRET_SPECS: readonly SecretSpec[] = [
  {
    name: "AZURE_DECISION_ENDPOINT",
    source: "prompt",
    hidden: false,
    label: "AZURE_DECISION_ENDPOINT",
    help: "Decision-1 base URL printed by infra/azure/deploy-decision.sh (account root).",
    defaultValue: null,
    allowEmpty: false,
    normalize: normalizeEndpoint,
    validate: validateEndpoint,
  },
  {
    name: "AZURE_DECISION_KEY",
    source: "prompt",
    hidden: true,
    label: "AZURE_DECISION_KEY",
    help: "Foundry account key (key1). See docs/setup-azure.md for how to copy it without printing it.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) =>
      /^\S{16,}$/.test(v) ? null : "Paste the full key1 or key2 value of the Foundry account.",
  },
  {
    name: "AZURE_DECISION_DEPLOYMENT",
    source: "prompt",
    hidden: false,
    label: "AZURE_DECISION_DEPLOYMENT",
    help: "Name of the Microsoft-Decision-1 deployment (not the model name).",
    defaultValue: "decision-1",
    allowEmpty: false,
    normalize: trim,
    validate: validateDeploymentName,
  },
  {
    name: "GOOGLE_CLIENT_ID",
    source: "prompt",
    hidden: false,
    label: "GOOGLE_CLIENT_ID",
    help: "Google OAuth web client id (docs/setup-google.md). Leave empty to disable Gmail.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) =>
      /^[\w-]+\.apps\.googleusercontent\.com$/.test(v) ? null : "Expected <id>.apps.googleusercontent.com.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    source: "prompt",
    hidden: true,
    label: "GOOGLE_CLIENT_SECRET",
    help: "Google OAuth client secret. Leave empty only when GOOGLE_CLIENT_ID is empty.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) => (/^\S{10,}$/.test(v) ? null : "Paste the full client secret."),
  },
  {
    name: "MS_CLIENT_ID",
    source: "prompt",
    hidden: false,
    label: "MS_CLIENT_ID",
    help: "Entra application (client) ID (docs/setup-microsoft.md). Leave empty to disable Outlook.",
    defaultValue: null,
    allowEmpty: true,
    normalize: (raw) => raw.trim().toLowerCase(),
    validate: (v) => (GUID.test(v) ? null : "Expected a GUID such as 00000000-0000-0000-0000-000000000000."),
  },
  {
    name: "MS_CLIENT_SECRET",
    source: "prompt",
    hidden: true,
    label: "MS_CLIENT_SECRET",
    help: "Entra client secret VALUE (not the secret ID). Leave empty only when MS_CLIENT_ID is empty.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) => (/^\S{10,}$/.test(v) ? null : "Paste the full client secret value."),
  },
  {
    name: "TOKEN_ENC_KEY",
    source: "generated",
    hidden: true,
    label: "TOKEN_ENC_KEY",
    help: "AES-256-GCM key for OAuth tokens.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) => (isValidKey(v) ? null : "Expected base64 of 32 bytes."),
  },
  {
    name: "STATE_SIGNING_KEY",
    source: "generated",
    hidden: true,
    label: "STATE_SIGNING_KEY",
    help: "HMAC-SHA-256 key for the OAuth state cookie.",
    defaultValue: null,
    allowEmpty: false,
    normalize: trim,
    validate: (v) => (isValidKey(v) ? null : "Expected base64 of 32 bytes."),
  },
  {
    name: "OWNER_EMAIL",
    source: "prompt",
    hidden: false,
    label: "OWNER_EMAIL",
    help: "The only email allowed to use this deployment (must match your Access login).",
    defaultValue: null,
    allowEmpty: false,
    normalize: (raw) => raw.trim().toLowerCase(),
    validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address."),
  },
  {
    name: "ACCESS_TEAM_DOMAIN",
    source: "prompt",
    hidden: false,
    label: "ACCESS_TEAM_DOMAIN",
    help: "Zero Trust team domain, for example https://<team>.cloudflareaccess.com (or just <team>).",
    defaultValue: null,
    allowEmpty: false,
    normalize: normalizeTeamDomain,
    validate: validateTeamDomain,
  },
  {
    name: "ACCESS_AUD",
    source: "prompt",
    hidden: false,
    label: "ACCESS_AUD",
    help: "Access application AUD tag. Press Enter if you have not created the Access application yet.",
    defaultValue: null,
    allowEmpty: true,
    normalize: trim,
    validate: (v) =>
      /^[A-Za-z0-9-]{32,128}$/.test(v) ? null : "Paste the AUD tag of the Clearbox Access application.",
  },
];

export function specFor(name: SecretName): SecretSpec {
  const spec = SECRET_SPECS.find((s) => s.name === name);
  if (spec === undefined) throw new Error(`unknown secret ${name}`);
  return spec;
}

/** Compares the numeric x.y.z part of two versions (prerelease suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]
      ?.split(".")
      .map((p) => Number.parseInt(p, 10) || 0) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Parses cf JSON output, tolerating text printed before the JSON document. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // fall through
      }
    }
    throw new SetupError("Could not parse cf output as JSON.");
  }
}

function unwrap(json: unknown): unknown {
  if (json !== null && typeof json === "object" && !Array.isArray(json) && "result" in json) {
    return (json as { result: unknown }).result;
  }
  return json;
}

function asRecords(json: unknown): Record<string, unknown>[] {
  const value = unwrap(json);
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object");
}

export interface DatabaseInfo {
  uuid: string;
  name: string;
  jurisdiction: string | null;
}

export function extractDatabases(json: unknown): DatabaseInfo[] {
  const out: DatabaseInfo[] = [];
  for (const r of asRecords(json)) {
    const uuid = typeof r.uuid === "string" ? r.uuid : typeof r.id === "string" ? r.id : null;
    if (uuid === null || typeof r.name !== "string") continue;
    out.push({
      uuid,
      name: r.name,
      jurisdiction: typeof r.jurisdiction === "string" ? r.jurisdiction : null,
    });
  }
  return out;
}

export function extractSecretNames(json: unknown): Set<string> {
  return new Set(asRecords(json).flatMap((r) => (typeof r.name === "string" ? [r.name] : [])));
}

export function extractWorkerId(json: unknown): string | null {
  const record = asRecords(json)[0];
  return record !== undefined && typeof record.id === "string" ? record.id : null;
}

export interface LocalConfig {
  d1DatabaseId?: string;
  appOrigin?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLocalConfig(text: string | null): LocalConfig {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupError(`${LOCAL_CONFIG_PATH} is not valid JSON. Fix or delete it.`);
  }
  const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const config: LocalConfig = {};
  if (typeof record.d1DatabaseId === "string" && UUID.test(record.d1DatabaseId)) {
    config.d1DatabaseId = record.d1DatabaseId;
  }
  if (typeof record.appOrigin === "string") {
    const origin = normalizeOrigin(record.appOrigin);
    if (origin !== null) config.appOrigin = origin;
  }
  return config;
}

export function serializeLocalConfig(config: LocalConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** https origin without path, query or fragment; null when invalid. */
export function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

export function redirectUris(origin: string): { google: string; microsoft: string } {
  return { google: `${origin}/oauth/google/callback`, microsoft: `${origin}/oauth/microsoft/callback` };
}

export function renderSecretsFile(values: SecretValues): string {
  const ordered: Record<string, string> = {};
  for (const name of SECRET_NAMES) {
    const value = values[name];
    if (value !== undefined) ordered[name] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface AccessInstructionInput {
  workerId: string | null;
  ownerEmail: string | null;
  teamDomain: string | null;
}

export function accessInstructions(input: AccessInstructionInput): string {
  const workerId = input.workerId ?? "<worker-id from: ./app/node_modules/.bin/cf workers get clearbox>";
  const email = input.ownerEmail ?? "<you@example.com>";
  const team = input.teamDomain ?? "https://<team>.cloudflareaccess.com";
  const body = JSON.stringify({
    type: "self_hosted",
    name: "Clearbox",
    destinations: [{ type: "worker", worker_id: workerId }],
    policies: [{ decision: "allow", include: [{ email: { email } }] }],
  });
  return [
    "Cloudflare Access (required: the Worker rejects every request until ACCESS_AUD is set)",
    "",
    "Option A, dashboard:",
    "  1. Workers & Pages > clearbox > Settings > Access (or the Access tab) > Protect this Worker behind Access.",
    '  2. Choose "All traffic" (this also protects the workers.dev URL), then Apply Access.',
    `  3. Zero Trust > Access controls > Applications > the new application > Policies: allow only Emails = ${email}.`,
    "  4. Same application > Configure > Additional settings: copy the Application Audience (AUD) tag.",
    "",
    "Option B, CLI (run from the repository root; the response contains the aud value):",
    `  ./app/node_modules/.bin/cf zero-trust access applications create --body '${body}'`,
    "",
    `The JWT issuer must match ACCESS_TEAM_DOMAIN (${team}).`,
  ].join("\n");
}

export function oauthInstructions(origin: string): string {
  const uris = redirectUris(origin);
  return [
    "OAuth redirect URIs (register exactly these, character for character):",
    `  Google (docs/setup-google.md):       ${uris.google}`,
    `  Microsoft (docs/setup-microsoft.md): ${uris.microsoft}`,
    "  Local development (optional):      http://localhost:5173/oauth/google/callback",
    "                                      http://localhost:5173/oauth/microsoft/callback",
    "",
    `Next: open ${origin}, sign in through Access, then open Accounts and choose Connect Gmail or Connect Outlook.`,
  ].join("\n");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test "scripts/test/setup-config.test.ts"`
Expected: PASS, `ℹ tests 20`, `ℹ fail 0`.

- [ ] **Step 6: Typecheck, format, lint**

Run: `pnpm exec tsc -p scripts/tsconfig.json && pnpm exec prettier --write scripts && pnpm lint`
Expected: no errors, `check-text: <n> files clean`.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/run.ts scripts/lib/prompt.ts scripts/lib/setup-config.ts scripts/test/setup-config.test.ts
git commit -m "feat(scripts): add setup:cf runner, prompter and config helpers"
```

### Task 3: setup:cf orchestration

**Files:**

- Create: `scripts/setup-cf.ts`
- Test: `scripts/test/setup-cf.test.ts`

**Interfaces:**

- Consumes: everything Task 2 produces; `generateKey` and `isMain` from Task 1; plan 03's `app/package.json` script `deploy:cf`, `app/migrations/0001_init.sql`, and `app/cloudflare.config.ts` reading `CLEARBOX_D1_ID`.
- Produces: `SetupFs { readText(path): string | null; writeText(path, text, mode: number): void; remove(path): void; exists(path): boolean }`, `SetupFlags { rotateTokenKey: boolean; rotateStateKey: boolean }`, `SetupDeps { repoRoot; runner; prompter; fs; log; generateKey; nodeVersion; flags }`, `SetupResult { databaseId; databaseCreated; uploadedSecrets: SecretName[]; deploys; accessPending }`, `runSetup(deps: SetupDeps): Promise<SetupResult>`; CLI flags `--rotate-token-key`, `--rotate-state-key`.

Flow of `runSetup` (each step is covered by the tests):

1. Remove a stale `app/deploy.secrets.json`; check Node >= 24.13.0, `pnpm --version` >= 12, `app/node_modules/.bin/cf` and `app/migrations/0001_init.sql` exist, `cf auth whoami` succeeds.
2. Database: id from `app/clearbox.local.json` (then `cf d1 get` must succeed and jurisdiction must be `eu` or unreported), else `cf d1 list --name clearbox` (reuse after confirmation), else `cf d1 create --name clearbox --jurisdiction eu`. Write the id to `app/clearbox.local.json` (mode 600).
3. `cf d1 migrations apply <id> --dir <root>/app/migrations` with inherited stdio (may prompt).
4. `cf workers secrets list --worker clearbox` gives existing names (none when the Worker does not exist). Generate missing keys; prompt for missing values; ask before replacing existing ones; an empty Google or Microsoft client id sets its secret to `""`; an empty `ACCESS_AUD` is never uploaded.
5. `git check-ignore -q app/deploy.secrets.json`, write the file (mode 600), `pnpm run deploy:cf --secrets-file <abs>` in `app/` with `CLEARBOX_D1_ID`, delete the file in `finally`.
6. List secrets again and warn about missing names; `cf workers get clearbox` for the Access instructions; ask for the Worker URL once and store it as `appOrigin`.
7. Print Access instructions; when `ACCESS_AUD` is pending, prompt and deploy again with only `ACCESS_AUD`.
8. Print the OAuth redirect URIs.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/setup-cf.test.ts` with exactly this content:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Prompter } from "../lib/prompt.ts";
import type { CommandRunner, RunOptions, RunResult } from "../lib/run.ts";
import { SECRET_NAMES, SetupError } from "../lib/setup-config.ts";
import { runSetup, type SetupDeps, type SetupFlags, type SetupFs } from "../setup-cf.ts";

const ROOT = "/repo";
const CF = join(ROOT, "app/node_modules/.bin/cf");
const LOCAL = join(ROOT, "app/clearbox.local.json");
const SECRETS = join(ROOT, "app/deploy.secrets.json");
const DB_ID = "11111111-2222-4333-8444-555555555555";
const AZURE_KEY = "azure-key-value-0123456789abcdef";
const MS_SECRET = "ms-secret-value-0123456789";
const AUD = "f".repeat(64);

interface Call {
  command: string;
  args: string[];
  options: RunOptions;
}

function fakeRunner(respond: (call: Call) => Partial<RunResult> | undefined): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      async run(command, args, options = {}) {
        const call = { command, args: [...args], options };
        calls.push(call);
        const r = respond(call) ?? {};
        return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    },
  };
}

type Answer = string | boolean;

function fakePrompter(answers: Answer[]): Prompter & { remaining: () => number } {
  const queue = [...answers];
  const next = (question: string, kind: "string" | "boolean"): Answer => {
    const answer = queue.shift();
    if (answer === undefined || typeof answer !== kind)
      throw new Error(`unexpected ${kind} prompt: ${question}`);
    return answer;
  };
  return {
    async ask(question, defaultValue) {
      const answer = next(question, "string") as string;
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    async askSecret(question) {
      return next(question, "string") as string;
    },
    async confirm(question) {
      return next(question, "boolean") as boolean;
    },
    remaining: () => queue.length,
  };
}

function fakeFs(
  initial: Record<string, string>,
): SetupFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text, mode) => {
      files.set(path, text);
      modes.set(path, mode);
    },
    remove: (path) => {
      files.delete(path);
    },
    exists: (path) => files.has(path),
  };
}

const INSTALLED = { [CF]: "", [join(ROOT, "app/migrations/0001_init.sql")]: "-- sql" };

function keyFactory(): { generate: () => string; issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    generate: () => {
      const key = Buffer.alloc(32, issued.length + 1).toString("base64");
      issued.push(key);
      return key;
    },
  };
}

function deps(over: {
  runner: CommandRunner;
  prompter: Prompter;
  fs: SetupFs;
  generateKey?: () => string;
  flags?: SetupFlags;
  logs?: string[];
}): SetupDeps {
  const logs = over.logs ?? [];
  return {
    repoRoot: ROOT,
    runner: over.runner,
    prompter: over.prompter,
    fs: over.fs,
    log: (line) => logs.push(line),
    generateKey: over.generateKey ?? (() => Buffer.alloc(32, 9).toString("base64")),
    nodeVersion: "24.13.1",
    flags: over.flags ?? { rotateTokenKey: false, rotateStateKey: false },
  };
}

const isCf = (call: Call, ...prefix: string[]): boolean =>
  call.command === CF && prefix.every((p, i) => call.args[i] === p);

describe("runSetup, first run", () => {
  it("creates an EU database, uploads secrets through a temporary file and deploys twice", async () => {
    const fs = fakeFs({ ...INSTALLED });
    const uploads: Record<string, string>[] = [];
    let secretsListed = 0;
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2\n" };
      if (isCf(call, "d1", "list")) return { stdout: "[]" };
      if (isCf(call, "d1", "create")) return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox" }) };
      if (isCf(call, "workers", "secrets", "list")) {
        secretsListed++;
        if (secretsListed === 1) return { code: 1, stderr: "not found" };
        return {
          stdout: JSON.stringify(SECRET_NAMES.filter((n) => n !== "ACCESS_AUD").map((name) => ({ name }))),
        };
      }
      if (isCf(call, "workers", "get")) return { stdout: JSON.stringify({ id: "worker-123" }) };
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") {
        const file = call.args[3];
        assert.equal(file, SECRETS);
        uploads.push(JSON.parse(fs.files.get(SECRETS) ?? "{}") as Record<string, string>);
        assert.equal(fs.modes.get(SECRETS), 0o600);
      }
      return undefined;
    });
    const prompter = fakePrompter([
      "https://acct.services.ai.azure.com/", // endpoint
      AZURE_KEY, // key (hidden)
      "", // deployment -> default decision-1
      "", // GOOGLE_CLIENT_ID empty -> Gmail disabled, secret auto-empty
      "0d9f1c2e-1111-4222-8333-444455556666", // MS_CLIENT_ID
      MS_SECRET, // MS_CLIENT_SECRET (hidden)
      "Owner@Example.test", // OWNER_EMAIL
      "my-team", // ACCESS_TEAM_DOMAIN
      "", // ACCESS_AUD not yet
      "https://clearbox.sub.workers.dev/", // Worker URL
      AUD, // ACCESS_AUD after the Access instructions
    ]);
    const keys = keyFactory();
    const logs: string[] = [];
    const result = await runSetup(deps({ runner, prompter, fs, generateKey: keys.generate, logs }));

    assert.equal(prompter.remaining(), 0);
    assert.deepEqual(result, {
      databaseId: DB_ID,
      databaseCreated: true,
      uploadedSecrets: [...SECRET_NAMES],
      deploys: 2,
      accessPending: false,
    });
    const create = calls.find((c) => isCf(c, "d1", "create"));
    assert.deepEqual(create?.args, ["d1", "create", "--name", "clearbox", "--jurisdiction", "eu"]);
    assert.equal(create?.options.cwd, ROOT);
    const migrate = calls.find((c) => isCf(c, "d1", "migrations", "apply"));
    assert.deepEqual(migrate?.args, [
      "d1",
      "migrations",
      "apply",
      DB_ID,
      "--dir",
      join(ROOT, "app/migrations"),
    ]);
    assert.equal(migrate?.options.inherit, true);

    assert.deepEqual(uploads[0], {
      AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com",
      AZURE_DECISION_KEY: AZURE_KEY,
      AZURE_DECISION_DEPLOYMENT: "decision-1",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      MS_CLIENT_ID: "0d9f1c2e-1111-4222-8333-444455556666",
      MS_CLIENT_SECRET: MS_SECRET,
      TOKEN_ENC_KEY: keys.issued[0],
      STATE_SIGNING_KEY: keys.issued[1],
      OWNER_EMAIL: "owner@example.test",
      ACCESS_TEAM_DOMAIN: "https://my-team.cloudflareaccess.com",
    });
    assert.deepEqual(uploads[1], { ACCESS_AUD: AUD });
    const deploysCalls = calls.filter((c) => c.command === "pnpm" && c.args[1] === "deploy:cf");
    for (const d of deploysCalls) {
      assert.equal(d.options.cwd, join(ROOT, "app"));
      assert.deepEqual(d.options.env, { CLEARBOX_D1_ID: DB_ID });
    }
    assert.equal(fs.files.has(SECRETS), false, "temporary secrets file is deleted");
    assert.deepEqual(JSON.parse(fs.files.get(LOCAL) ?? "{}"), {
      d1DatabaseId: DB_ID,
      appOrigin: "https://clearbox.sub.workers.dev",
    });
    const output = logs.join("\n");
    for (const secret of [AZURE_KEY, MS_SECRET, ...keys.issued]) assert.equal(output.includes(secret), false);
    assert.match(output, /"worker_id":"worker-123"/);
    assert.match(output, /https:\/\/clearbox\.sub\.workers\.dev\/oauth\/google\/callback/);
  });
});

describe("runSetup, re-run", () => {
  it("reuses the database and never regenerates keys", async () => {
    const fs = fakeFs({
      ...INSTALLED,
      [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID, appOrigin: "https://clearbox.sub.workers.dev" }),
    });
    const { runner, calls } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list"))
        return { stdout: JSON.stringify(SECRET_NAMES.map((name) => ({ name }))) };
      if (isCf(call, "workers", "get")) return { stdout: JSON.stringify({ id: "worker-123" }) };
      return undefined;
    });
    const prompter = fakePrompter(Array<boolean>(10).fill(false));
    let generated = 0;
    const result = await runSetup(
      deps({
        runner,
        prompter,
        fs,
        generateKey: () => {
          generated++;
          return "unused";
        },
      }),
    );
    assert.equal(generated, 0);
    assert.equal(prompter.remaining(), 0);
    assert.equal(result.databaseCreated, false);
    assert.deepEqual(result.uploadedSecrets, []);
    assert.equal(
      calls.some((c) => isCf(c, "d1", "create") || isCf(c, "d1", "list")),
      false,
    );
    const deploy = calls.filter((c) => c.command === "pnpm" && c.args[1] === "deploy:cf");
    assert.deepEqual(
      deploy.map((c) => c.args),
      [["run", "deploy:cf"]],
    );
  });

  it("rotates TOKEN_ENC_KEY only after typed confirmation", async () => {
    const fs = fakeFs({
      ...INSTALLED,
      [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID, appOrigin: "https://c.example.workers.dev" }),
    });
    const uploads: string[] = [];
    const { runner } = fakeRunner((call) => {
      if (call.command === "pnpm" && call.args[0] === "--version") return { stdout: "12.11.2" };
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list"))
        return { stdout: JSON.stringify(SECRET_NAMES.map((name) => ({ name }))) };
      if (call.command === "pnpm" && call.args[1] === "deploy:cf") uploads.push(fs.files.get(SECRETS) ?? "");
      return undefined;
    });
    const answers: Answer[] = [...Array<boolean>(7).fill(false), "rotate", ...Array<boolean>(3).fill(false)];
    const keys = keyFactory();
    const result = await runSetup(
      deps({
        runner,
        prompter: fakePrompter(answers),
        fs,
        generateKey: keys.generate,
        flags: { rotateTokenKey: true, rotateStateKey: false },
      }),
    );
    assert.deepEqual(result.uploadedSecrets, ["TOKEN_ENC_KEY"]);
    assert.deepEqual(JSON.parse(uploads[0] ?? "{}"), { TOKEN_ENC_KEY: keys.issued[0] });
  });
});

describe("runSetup, failures", () => {
  const base = (call: Call): Partial<RunResult> | undefined =>
    call.command === "pnpm" && call.args[0] === "--version" ? { stdout: "12.11.2" } : undefined;

  it("stops when cf is not logged in", async () => {
    const { runner } = fakeRunner((call) => (isCf(call, "auth", "whoami") ? { code: 1 } : base(call)));
    await assert.rejects(
      runSetup(deps({ runner, prompter: fakePrompter([]), fs: fakeFs({ ...INSTALLED }) })),
      /not logged in/,
    );
  });

  it("refuses a database outside the EU jurisdiction", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    const { runner } = fakeRunner((call) =>
      isCf(call, "d1", "get")
        ? { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "us" }) }
        : base(call),
    );
    await assert.rejects(runSetup(deps({ runner, prompter: fakePrompter([]), fs })), (e: unknown) => {
      assert.ok(e instanceof SetupError);
      assert.match(e.message, /jurisdiction "us"/);
      return true;
    });
  });

  it("requires Node.js 24.13 or newer", async () => {
    const { runner } = fakeRunner(base);
    const d = {
      ...deps({ runner, prompter: fakePrompter([]), fs: fakeFs({ ...INSTALLED }) }),
      nodeVersion: "22.18.0",
    };
    await assert.rejects(runSetup(d), /Node.js 24.13.0/);
  });

  it("refuses to write secrets to a path git does not ignore", async () => {
    const fs = fakeFs({ ...INSTALLED, [LOCAL]: JSON.stringify({ d1DatabaseId: DB_ID }) });
    const { runner } = fakeRunner((call) => {
      if (isCf(call, "d1", "get"))
        return { stdout: JSON.stringify({ uuid: DB_ID, name: "clearbox", jurisdiction: "eu" }) };
      if (isCf(call, "workers", "secrets", "list")) return { code: 1 };
      if (call.command === "git") return { code: 1 };
      return base(call);
    });
    const prompter = fakePrompter([
      "https://acct.services.ai.azure.com",
      AZURE_KEY,
      "",
      "",
      "",
      "owner@example.test",
      "my-team",
      AUD,
    ]);
    await assert.rejects(runSetup(deps({ runner, prompter, fs })), /not git-ignored/);
    assert.equal(fs.files.has(SECRETS), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "scripts/test/setup-cf.test.ts"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/setup-cf.ts`.

- [ ] **Step 3: Implement**

Create `scripts/setup-cf.ts` with exactly this content:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateKey } from "./gen-key.ts";
import { isMain } from "./lib/is-main.ts";
import { createTerminalPrompter, type Prompter } from "./lib/prompt.ts";
import { createNodeRunner, type CommandRunner, type RunResult } from "./lib/run.ts";
import {
  CF_BIN_PATH,
  D1_NAME,
  FIRST_MIGRATION_PATH,
  LOCAL_CONFIG_PATH,
  MIGRATIONS_DIR,
  MIN_NODE_VERSION,
  MIN_PNPM_VERSION,
  SECRET_NAMES,
  SECRET_SPECS,
  SECRETS_FILE_PATH,
  SetupError,
  WORKER_NAME,
  accessInstructions,
  compareVersions,
  extractDatabases,
  extractSecretNames,
  extractWorkerId,
  normalizeOrigin,
  oauthInstructions,
  parseJsonOutput,
  parseLocalConfig,
  renderSecretsFile,
  serializeLocalConfig,
  specFor,
  type LocalConfig,
  type SecretName,
  type SecretSpec,
  type SecretValues,
} from "./lib/setup-config.ts";

export interface SetupFs {
  readText(path: string): string | null;
  writeText(path: string, text: string, mode: number): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export interface SetupFlags {
  rotateTokenKey: boolean;
  rotateStateKey: boolean;
}

export interface SetupDeps {
  repoRoot: string;
  runner: CommandRunner;
  prompter: Prompter;
  fs: SetupFs;
  log: (line: string) => void;
  generateKey: () => string;
  nodeVersion: string;
  flags: SetupFlags;
}

export interface SetupResult {
  databaseId: string;
  databaseCreated: boolean;
  uploadedSecrets: SecretName[];
  deploys: number;
  accessPending: boolean;
}

type Cf = (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<RunResult>;

const MAX_ATTEMPTS = 3;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function checkPrerequisites(deps: SetupDeps, cf: Cf): Promise<void> {
  if (compareVersions(deps.nodeVersion, MIN_NODE_VERSION) < 0) {
    throw new SetupError(`Node.js ${MIN_NODE_VERSION} or newer is required (found ${deps.nodeVersion}).`);
  }
  const pnpm = await deps.runner.run("pnpm", ["--version"], { cwd: deps.repoRoot });
  if (pnpm.code !== 0 || compareVersions(pnpm.stdout, MIN_PNPM_VERSION) < 0) {
    throw new SetupError(`pnpm ${MIN_PNPM_VERSION} or newer is required. Run: corepack enable`);
  }
  if (!deps.fs.exists(join(deps.repoRoot, CF_BIN_PATH))) {
    throw new SetupError("The cf CLI is not installed in app/. Run: pnpm install");
  }
  if (!deps.fs.exists(join(deps.repoRoot, FIRST_MIGRATION_PATH))) {
    throw new SetupError(`${FIRST_MIGRATION_PATH} is missing.`);
  }
  const who = await cf(["auth", "whoami"]);
  if (who.code !== 0) {
    throw new SetupError(
      "cf is not logged in. Run ./app/node_modules/.bin/cf auth login (or export CLOUDFLARE_API_TOKEN), then re-run.",
    );
  }
  deps.log("Prerequisites OK (Node.js, pnpm, cf, cf login).");
  deps.log("Note: Clearbox uses 2 of the 5 Cron Triggers allowed per account on Workers Free.");
}

async function checkJurisdiction(deps: SetupDeps, cf: Cf, id: string): Promise<void> {
  const got = await cf(["d1", "get", id]);
  if (got.code !== 0) {
    throw new SetupError(
      `D1 database ${id} was not found. Fix d1DatabaseId in ${LOCAL_CONFIG_PATH}, or delete the file to look the database up by name.`,
    );
  }
  const info = extractDatabases(parseJsonOutput(got.stdout))[0];
  const jurisdiction = info?.jurisdiction ?? null;
  if (jurisdiction === null) {
    deps.log("Warning: cf did not report the D1 jurisdiction. Confirm in the dashboard that it is EU.");
  } else if (jurisdiction !== "eu") {
    throw new SetupError(
      `D1 database ${id} has jurisdiction "${jurisdiction}". Clearbox requires an EU database: create a new one or delete this one, then re-run.`,
    );
  }
}

async function ensureDatabase(
  deps: SetupDeps,
  cf: Cf,
  local: LocalConfig,
): Promise<{ id: string; created: boolean }> {
  if (local.d1DatabaseId !== undefined) {
    await checkJurisdiction(deps, cf, local.d1DatabaseId);
    deps.log(`Using D1 database ${local.d1DatabaseId} from ${LOCAL_CONFIG_PATH}.`);
    return { id: local.d1DatabaseId, created: false };
  }
  const listed = await cf(["d1", "list", "--name", D1_NAME]);
  if (listed.code !== 0) throw new SetupError(`cf d1 list failed: ${firstLine(listed.stderr)}`);
  const existing = extractDatabases(parseJsonOutput(listed.stdout)).find((db) => db.name === D1_NAME);
  if (existing !== undefined) {
    await checkJurisdiction(deps, cf, existing.uuid);
    const reuse = await deps.prompter.confirm(
      `Found an existing D1 database named "${D1_NAME}" (${existing.uuid}). Use it?`,
      true,
    );
    if (!reuse) throw new SetupError("Aborted. Rename or delete the existing database, then re-run.");
    return { id: existing.uuid, created: false };
  }
  deps.log(`Creating D1 database "${D1_NAME}" in the EU jurisdiction...`);
  const created = await cf(["d1", "create", "--name", D1_NAME, "--jurisdiction", "eu"]);
  if (created.code !== 0) throw new SetupError(`cf d1 create failed: ${firstLine(created.stderr)}`);
  const db = extractDatabases(parseJsonOutput(created.stdout))[0];
  if (db === undefined) throw new SetupError("cf d1 create did not return a database id.");
  deps.log(`Created D1 database ${db.uuid}.`);
  return { id: db.uuid, created: true };
}

async function listSecretNames(cf: Cf): Promise<Set<string>> {
  const res = await cf(["workers", "secrets", "list", "--worker", WORKER_NAME]);
  if (res.code !== 0) return new Set(); // Worker not deployed yet
  return extractSecretNames(parseJsonOutput(res.stdout));
}

async function promptValue(deps: SetupDeps, spec: SecretSpec): Promise<string> {
  deps.log(spec.help);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const raw = spec.hidden
      ? await deps.prompter.askSecret(spec.label)
      : await deps.prompter.ask(spec.label, spec.defaultValue ?? undefined);
    const value = spec.normalize(raw);
    if (value === "") {
      if (spec.allowEmpty) return "";
      deps.log("A value is required.");
      continue;
    }
    const error = spec.validate(value);
    if (error === null) return value;
    deps.log(error);
  }
  throw new SetupError(`Too many invalid values for ${spec.name}.`);
}

interface Collected {
  values: SecretValues;
  accessPending: boolean;
  ownerEmail: string | null;
  teamDomain: string | null;
}

async function collectSecrets(deps: SetupDeps, existing: ReadonlySet<string>): Promise<Collected> {
  const values: SecretValues = {};
  let accessPending = false;
  for (const spec of SECRET_SPECS) {
    const present = existing.has(spec.name);
    if (spec.source === "generated") {
      const rotate = spec.name === "TOKEN_ENC_KEY" ? deps.flags.rotateTokenKey : deps.flags.rotateStateKey;
      if (!present) {
        values[spec.name] = deps.generateKey();
        deps.log(`Generated ${spec.name} (not shown and not written to disk).`);
      } else if (rotate) {
        if (spec.name === "TOKEN_ENC_KEY") {
          deps.log(
            "Rotating TOKEN_ENC_KEY makes every stored OAuth token unreadable: each account must Reconnect.",
          );
          const typed = await deps.prompter.ask('Type "rotate" to continue');
          if (typed !== "rotate") throw new SetupError("TOKEN_ENC_KEY rotation cancelled.");
        }
        values[spec.name] = deps.generateKey();
        deps.log(`Generated a new ${spec.name}.`);
      } else {
        deps.log(`${spec.name} is already set; keeping it.`);
      }
      continue;
    }
    const disabledPair =
      (spec.name === "GOOGLE_CLIENT_SECRET" && values.GOOGLE_CLIENT_ID === "") ||
      (spec.name === "MS_CLIENT_SECRET" && values.MS_CLIENT_ID === "");
    if (disabledPair) {
      values[spec.name] = "";
      continue;
    }
    if (present && !(await deps.prompter.confirm(`${spec.name} is already set. Replace it?`, false)))
      continue;
    const value = await promptValue(deps, spec);
    if (spec.name === "ACCESS_AUD" && value === "") {
      accessPending = !present;
      continue;
    }
    values[spec.name] = value;
  }
  return {
    values,
    accessPending,
    ownerEmail: values.OWNER_EMAIL ?? null,
    teamDomain: values.ACCESS_TEAM_DOMAIN ?? null,
  };
}

async function deploy(
  deps: SetupDeps,
  values: SecretValues,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const file = join(deps.repoRoot, SECRETS_FILE_PATH);
  const names = Object.keys(values);
  const args = ["run", "deploy:cf"];
  if (names.length > 0) {
    const ignored = await deps.runner.run("git", ["check-ignore", "-q", SECRETS_FILE_PATH], {
      cwd: deps.repoRoot,
    });
    if (ignored.code !== 0) {
      throw new SetupError(`${SECRETS_FILE_PATH} is not git-ignored. Refusing to write secrets there.`);
    }
    deps.fs.writeText(file, renderSecretsFile(values), 0o600);
    args.push("--secrets-file", file);
  }
  deps.log(
    names.length > 0 ? `Deploying with secrets: ${names.join(", ")}` : "Deploying (no secret changes)...",
  );
  try {
    const res = await deps.runner.run("pnpm", args, { cwd: join(deps.repoRoot, "app"), env, inherit: true });
    if (res.code !== 0) throw new SetupError("Deploy failed. Fix the error above and re-run pnpm setup:cf.");
  } finally {
    if (names.length > 0) deps.fs.remove(file);
  }
}

function workerIdFrom(stdout: string): string | null {
  try {
    return extractWorkerId(parseJsonOutput(stdout));
  } catch {
    return null; // the instructions fall back to a placeholder
  }
}

async function resolveOrigin(deps: SetupDeps, local: LocalConfig): Promise<string> {
  if (local.appOrigin !== undefined) return local.appOrigin;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const origin = normalizeOrigin(
      await deps.prompter.ask("Worker URL printed by the deploy (https://clearbox.<subdomain>.workers.dev)"),
    );
    if (origin !== null) return origin;
    deps.log("Enter an https URL without a path.");
  }
  throw new SetupError("No valid Worker URL entered.");
}

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const cfBin = join(deps.repoRoot, CF_BIN_PATH);
  // Account-level cf commands run from the repo root (no cloudflare.config.ts there).
  const cf: Cf = (args, env = {}) => deps.runner.run(cfBin, args, { cwd: deps.repoRoot, env });
  const localPath = join(deps.repoRoot, LOCAL_CONFIG_PATH);
  const secretsPath = join(deps.repoRoot, SECRETS_FILE_PATH);
  if (deps.fs.exists(secretsPath)) deps.fs.remove(secretsPath);

  await checkPrerequisites(deps, cf);

  const local = parseLocalConfig(deps.fs.readText(localPath));
  const db = await ensureDatabase(deps, cf, local);
  let config: LocalConfig = { ...local, d1DatabaseId: db.id };
  deps.fs.writeText(localPath, serializeLocalConfig(config), 0o600);
  const env = { CLEARBOX_D1_ID: db.id };

  deps.log("Applying D1 migrations to the remote database...");
  const migrated = await deps.runner.run(
    cfBin,
    ["d1", "migrations", "apply", db.id, "--dir", join(deps.repoRoot, MIGRATIONS_DIR)],
    { cwd: deps.repoRoot, env, inherit: true },
  );
  if (migrated.code !== 0)
    throw new SetupError("cf d1 migrations apply failed. Fix the error above and re-run.");

  const collected = await collectSecrets(deps, await listSecretNames(cf));
  const uploaded: SecretName[] = SECRET_NAMES.filter((name) => collected.values[name] !== undefined);
  await deploy(deps, collected.values, env);
  let deploys = 1;

  const after = await listSecretNames(cf);
  const missing = SECRET_NAMES.filter(
    (n) => !after.has(n) && !(n === "ACCESS_AUD" && collected.accessPending),
  );
  if (missing.length > 0) deps.log(`Warning: secrets not reported on the Worker: ${missing.join(", ")}`);

  const worker = await cf(["workers", "get", WORKER_NAME]);
  const workerId = worker.code === 0 ? workerIdFrom(worker.stdout) : null;
  const origin = await resolveOrigin(deps, config);
  config = { ...config, appOrigin: origin };
  deps.fs.writeText(localPath, serializeLocalConfig(config), 0o600);

  deps.log("");
  deps.log(
    accessInstructions({ workerId, ownerEmail: collected.ownerEmail, teamDomain: collected.teamDomain }),
  );
  let accessPending = collected.accessPending;
  if (accessPending) {
    deps.log("");
    const aud = await promptValue(deps, specFor("ACCESS_AUD"));
    if (aud === "") {
      deps.log("ACCESS_AUD is still unset. Re-run pnpm setup:cf after creating the Access application.");
    } else {
      await deploy(deps, { ACCESS_AUD: aud }, env);
      deploys++;
      uploaded.push("ACCESS_AUD");
      accessPending = false;
    }
  }
  deps.log("");
  deps.log(oauthInstructions(origin));
  return {
    databaseId: db.id,
    databaseCreated: db.created,
    uploadedSecrets: uploaded,
    deploys,
    accessPending,
  };
}

const nodeFs: SetupFs = {
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeText: (path, text, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
  },
  remove: (path) => rmSync(path, { force: true }),
  exists: (path) => existsSync(path),
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "rotate-token-key": { type: "boolean", default: false },
      "rotate-state-key": { type: "boolean", default: false },
    },
  });
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await runSetup({
      repoRoot,
      runner: createNodeRunner(),
      prompter: createTerminalPrompter(),
      fs: nodeFs,
      log: (line) => console.log(line),
      generateKey: () => generateKey(),
      nodeVersion: process.versions.node,
      flags: { rotateTokenKey: values["rotate-token-key"], rotateStateKey: values["rotate-state-key"] },
    });
    return 0;
  } catch (error) {
    if (error instanceof SetupError || (error instanceof Error && error.message === "Cancelled")) {
      console.error(`setup:cf: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
```

- [ ] **Step 4: Run all script tests**

Run: `node --test "scripts/test/*.test.ts"`
Expected: PASS, `ℹ tests 43`, `ℹ fail 0`.

- [ ] **Step 5: Check the git-ignore assumptions and typecheck**

Run: `git check-ignore -v app/deploy.secrets.json app/clearbox.local.json && pnpm exec tsc -p scripts/tsconfig.json`
Expected: two lines, `.gitignore:<n>:*.secrets.json	app/deploy.secrets.json` and `.gitignore:<n>:app/clearbox.local.json	app/clearbox.local.json`; no tsc output.

- [ ] **Step 6: Non-interactive guard**

Run: `echo | pnpm setup:cf; echo "exit $?"`
Expected: an error containing `pnpm setup:cf is interactive. Run it in a terminal.` and a non-zero exit. (The real flow is exercised in Task 13 against a Cloudflare account.)

- [ ] **Step 7: Format, lint, commit**

Run: `pnpm exec prettier --write scripts && pnpm lint`
Expected: clean.

```bash
git add scripts/setup-cf.ts scripts/test/setup-cf.test.ts
git commit -m "feat(scripts): add idempotent pnpm setup:cf"
```

### Task 4: Azure infrastructure for Microsoft-Decision-1

**Files:**

- Create: `infra/azure/decision.bicep`, `infra/azure/decision-existing.bicep`, `infra/azure/deploy-decision.sh`

**Interfaces:**

- Consumes: nothing from other plans.
- Produces: Bicep parameters `accountName`, `deploymentName` (default `decision-1`), `capacityRpm` (default 300), `location` (`swedencentral` only, new-account template), `tags`; outputs `decisionEndpoint`, `deploymentName` (plus `accountLocation` in the existing-account template); script flags `--resource-group`, `--account`, `--existing`, `--deployment`, `--capacity`, `--subscription`, `--create-group`, `--yes`, `--smoke-test`, `--dry-run`; ARM deployment name `clearbox-decision`.

- [ ] **Step 1: Write the new-account template**

Create `infra/azure/decision.bicep` with exactly this content:

```bicep
// Creates (or updates) an AIServices account in swedencentral and a Microsoft-Decision-1 deployment.
// For an account that already exists, use decision-existing.bicep instead so its settings are not overwritten.
targetScope = 'resourceGroup'

@description('Azure region. Restricted to swedencentral: Microsoft-Decision-1 DataZoneStandard (EU data zone).')
@allowed([
  'swedencentral'
])
param location string = 'swedencentral'

@description('Globally unique AIServices account name; also used as the custom subdomain of the endpoint.')
@minLength(2)
@maxLength(64)
param accountName string

@description('Deployment name sent as "model" in requests. Must NOT be Microsoft-Decision-1 (reserved word).')
@minLength(1)
@maxLength(64)
param deploymentName string = 'decision-1'

@description('Requests per minute. For this model 1 capacity unit = 1 request per minute.')
@minValue(1)
@maxValue(1000)
param capacityRpm int = 300

@description('Optional resource tags.')
param tags object = {}

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  tags: tags
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    // The Cloudflare Worker authenticates with the api-key header, so local auth must stay enabled.
    disableLocalAuth: false
    allowProjectManagement: true
  }
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'DataZoneStandard'
    capacity: capacityRpm
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1'
      version: '1'
    }
    // Keep behavior stable for calibration; plan the move before version 1 retires on 2027-02-04.
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

@description('Value for the AZURE_DECISION_ENDPOINT secret.')
output decisionEndpoint string = 'https://${accountName}.services.ai.azure.com'

@description('Value for the AZURE_DECISION_DEPLOYMENT secret.')
output deploymentName string = decision.name
```

- [ ] **Step 2: Write the existing-account template**

Create `infra/azure/decision-existing.bicep` with exactly this content:

```bicep
// Adds the Microsoft-Decision-1 deployment to an AIServices account that already exists.
// The account must be in swedencentral, have a custom subdomain and keep local (key) auth enabled.
targetScope = 'resourceGroup'

@description('Name of the existing AIServices account in this resource group.')
@minLength(2)
@maxLength(64)
param accountName string

@description('Deployment name sent as "model" in requests. Must NOT be Microsoft-Decision-1 (reserved word).')
@minLength(1)
@maxLength(64)
param deploymentName string = 'decision-1'

@description('Requests per minute. For this model 1 capacity unit = 1 request per minute.')
@minValue(1)
@maxValue(1000)
param capacityRpm int = 300

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: accountName
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'DataZoneStandard'
    capacity: capacityRpm
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1'
      version: '1'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

@description('Value for the AZURE_DECISION_ENDPOINT secret (uses the account custom subdomain).')
output decisionEndpoint string = 'https://${account.properties.customSubDomainName}.services.ai.azure.com'

@description('Value for the AZURE_DECISION_DEPLOYMENT secret.')
output deploymentName string = decision.name

@description('Region of the account; must be swedencentral for the EU data zone.')
output accountLocation string = account.location
```

- [ ] **Step 3: Build both templates**

Run: `az bicep build --file infra/azure/decision.bicep --stdout > /dev/null && az bicep build --file infra/azure/decision-existing.bicep --stdout > /dev/null && echo BICEP OK`
Expected: `BICEP OK` (an "upgrade available" warning is fine; any `Error BCP...` is not).

- [ ] **Step 4: Write the script**

Create `infra/azure/deploy-decision.sh` with exactly this content:

```bash
#!/usr/bin/env bash
# Deploys Microsoft-Decision-1 for Clearbox with the Bicep files in this directory.
# Runs `az deployment group what-if` first and asks before applying. Never prints API keys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCATION="swedencentral"
DEPLOYMENT_NAME="decision-1"
CAPACITY=300
ARM_DEPLOYMENT="clearbox-decision"
RESOURCE_GROUP=""
ACCOUNT=""
SUBSCRIPTION=""
EXISTING=false
CREATE_GROUP=false
ASSUME_YES=false
SMOKE_TEST=false
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> [options]

Creates an AIServices account in swedencentral (unless --existing) and a Microsoft-Decision-1
deployment (SKU DataZoneStandard, NoAutoUpgrade) for Clearbox.

Options:
  --existing            Only add the deployment to an existing AIServices account (decision-existing.bicep).
  --deployment <name>   Deployment name, sent as "model" by Clearbox. Default: decision-1.
  --capacity <rpm>      Requests per minute (1 capacity unit = 1 RPM). Default: 300.
  --subscription <id>   Run `az account set --subscription <id>` first.
  --create-group        Create the resource group in swedencentral when it does not exist (new account only).
  --yes                 Apply without asking after the what-if preview.
  --smoke-test          After deploying, send one synthetic request (the key is never printed).
  --dry-run             Print the az commands instead of running them.
  -h, --help            Show this help.
USAGE
}

die() {
  echo "deploy-decision: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --deployment) DEPLOYMENT_NAME="${2:-}"; shift 2 ;;
    --capacity) CAPACITY="${2:-}"; shift 2 ;;
    --subscription) SUBSCRIPTION="${2:-}"; shift 2 ;;
    --existing) EXISTING=true; shift ;;
    --create-group) CREATE_GROUP=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --smoke-test) SMOKE_TEST=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ -n "$RESOURCE_GROUP" ]] || die "--resource-group is required"
[[ -n "$ACCOUNT" ]] || die "--account is required"
[[ "$ACCOUNT" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || die "--account must be 2-64 lowercase letters, digits or '-'"
[[ "$DEPLOYMENT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || die "--deployment has invalid characters"
shopt -s nocasematch
[[ "$DEPLOYMENT_NAME" != "microsoft-decision-1" ]] || die "--deployment must not be Microsoft-Decision-1 (reserved word); use decision-1"
shopt -u nocasematch
if ! [[ "$CAPACITY" =~ ^[0-9]+$ ]] || ((CAPACITY < 1 || CAPACITY > 1000)); then
  die "--capacity must be 1-1000"
fi
if [[ "$EXISTING" == true && "$CREATE_GROUP" == true ]]; then
  die "--create-group cannot be combined with --existing"
fi

if [[ "$EXISTING" == true ]]; then
  TEMPLATE="$SCRIPT_DIR/decision-existing.bicep"
else
  TEMPLATE="$SCRIPT_DIR/decision.bicep"
fi
PARAMS=(--parameters "accountName=$ACCOUNT" "deploymentName=$DEPLOYMENT_NAME" "capacityRpm=$CAPACITY")

# Runs a command, or prints it in --dry-run mode.
run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Runs a command and prints its stdout, or prints the command and a placeholder in --dry-run mode.
capture() {
  if [[ "$DRY_RUN" == true ]]; then
    {
      printf '+'
      printf ' %q' "$@"
      printf '\n'
    } >&2
    echo "<dry-run>"
  else
    "$@"
  fi
}

if [[ "$DRY_RUN" != true ]]; then
  command -v az >/dev/null 2>&1 || die "Azure CLI (az) is not installed"
  az account show --output none 2>/dev/null || die "not logged in; run: az login"
fi
if [[ -n "$SUBSCRIPTION" ]]; then
  run az account set --subscription "$SUBSCRIPTION"
fi

echo "== Checking target"
if [[ "$EXISTING" == true ]]; then
  INFO="$(capture az cognitiveservices account show --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
    --query "[location, kind, properties.customSubDomainName, to_string(properties.disableLocalAuth)]" --output tsv)" \
    || die "account $ACCOUNT not found in resource group $RESOURCE_GROUP"
  if [[ "$DRY_RUN" != true ]]; then
    read -r ACCOUNT_LOCATION ACCOUNT_KIND ACCOUNT_SUBDOMAIN LOCAL_AUTH_DISABLED <<<"$(echo "$INFO" | tr '\n' ' ')"
    [[ "$ACCOUNT_LOCATION" == "$LOCATION" ]] || die "account is in $ACCOUNT_LOCATION; Clearbox needs $LOCATION (EU data zone)"
    [[ "$ACCOUNT_KIND" == "AIServices" ]] || die "account kind is $ACCOUNT_KIND; expected AIServices"
    [[ -n "$ACCOUNT_SUBDOMAIN" && "$ACCOUNT_SUBDOMAIN" != "None" ]] || die "account has no custom subdomain"
    [[ "$LOCAL_AUTH_DISABLED" != "true" ]] || die "account has local (key) auth disabled; Clearbox authenticates with api-key"
  fi
else
  if ! capture az group show --name "$RESOURCE_GROUP" --output none >/dev/null 2>&1; then
    [[ "$CREATE_GROUP" == true ]] || die "resource group $RESOURCE_GROUP not found (pass --create-group to create it)"
    run az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  fi
fi

echo "== Quota (AIServices.DataZoneStandard.Microsoft-Decision-1 in $LOCATION)"
QUOTA="$(capture az cognitiveservices usage list --location "$LOCATION" \
  --query "[?name.value=='AIServices.DataZoneStandard.Microsoft-Decision-1'] | [0].[limit, currentValue]" --output tsv || true)"
if [[ "$DRY_RUN" != true ]]; then
  read -r QUOTA_LIMIT QUOTA_USED <<<"$(echo "$QUOTA" | tr '\n' ' ')"
  if [[ -z "${QUOTA_LIMIT:-}" ]]; then
    echo "warning: no quota entry found; the model may not be offered to this subscription in $LOCATION" >&2
  else
    echo "limit ${QUOTA_LIMIT%.*} RPM, in use ${QUOTA_USED%.*} RPM, requested $CAPACITY RPM"
    if ((${QUOTA_LIMIT%.*} - ${QUOTA_USED%.*} < CAPACITY)); then
      echo "warning: requested capacity exceeds the free quota (fine when resizing this same deployment)" >&2
    fi
  fi
fi

echo "== What-if ($TEMPLATE)"
run az deployment group what-if --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --template-file "$TEMPLATE" "${PARAMS[@]}"

if [[ "$ASSUME_YES" != true && "$DRY_RUN" != true ]]; then
  read -r -p "Apply these changes? [y/N] " ANSWER
  [[ "$ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]] || die "cancelled"
fi

echo "== Deploying"
run az deployment group create --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --template-file "$TEMPLATE" "${PARAMS[@]}" --output none
ENDPOINT="$(capture az deployment group show --resource-group "$RESOURCE_GROUP" --name "$ARM_DEPLOYMENT" \
  --query properties.outputs.decisionEndpoint.value --output tsv)"

echo "== Verifying"
run az cognitiveservices account deployment show --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
  --deployment-name "$DEPLOYMENT_NAME" \
  --query "{state:properties.provisioningState, model:properties.model.name, version:properties.model.version, sku:sku.name, rpm:sku.capacity, upgrade:properties.versionUpgradeOption}" \
  --output table

if [[ "$SMOKE_TEST" == true ]]; then
  echo "== Smoke test (synthetic data)"
  if [[ "$DRY_RUN" == true ]]; then
    echo "+ curl POST $ENDPOINT/providers/microsoft/v1/systemone (key read into a variable, never printed)"
  else
    DECISION_KEY="$(az cognitiveservices account keys list --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT" \
      --query key1 --output tsv)"
    BODY="{\"model\":\"$DEPLOYMENT_NAME\",\"state\":{\"email\":{\"from\":\"codes@login.example.com\",\"subject\":\"Your one-time code is 482913\",\"age_days\":12}},\"questions\":{\"action\":{\"type\":\"choice\",\"instructions\":\"What should the mailbox owner do with this email?\",\"criteria\":{\"delete\":\"No future value\",\"keep\":\"Needs attention\"}},\"is_expired\":{\"type\":\"noul\",\"instructions\":\"Has this time-bound content expired?\"}}}"
    RESPONSE="$(curl --silent --show-error --max-time 30 --write-out '\n%{http_code}' \
      --header @<(printf 'api-key: %s\n' "$DECISION_KEY") \
      --header 'content-type: application/json' \
      --data "$BODY" "$ENDPOINT/providers/microsoft/v1/systemone")"
    unset DECISION_KEY
    STATUS="${RESPONSE##*$'\n'}"
    echo "HTTP $STATUS"
    if [[ "$STATUS" == "200" ]]; then
      echo "${RESPONSE%$'\n'*}" | grep -o '"model":"[^"]*"' | head -n 1 || true
    else
      die "smoke test failed with HTTP $STATUS (see docs/runbook.md, Decision-1 outage)"
    fi
  fi
fi

cat <<EOF2

Done. Worker secrets (enter them when pnpm setup:cf asks):
  AZURE_DECISION_ENDPOINT   = $ENDPOINT
  AZURE_DECISION_DEPLOYMENT = $DEPLOYMENT_NAME
  AZURE_DECISION_KEY        = not printed. Copy it to the clipboard and paste it at the hidden prompt:
    az cognitiveservices account keys list --resource-group $RESOURCE_GROUP --name $ACCOUNT --query key1 --output tsv | pbcopy
    (Linux: replace pbcopy with: xclip -selection clipboard)
EOF2
```

Run: `chmod +x infra/azure/deploy-decision.sh`

- [ ] **Step 5: Lint and dry-run the script**

Run: `shellcheck infra/azure/deploy-decision.sh && infra/azure/deploy-decision.sh --resource-group rg-example --account foundry-example --existing --dry-run --smoke-test`
Expected: no ShellCheck output, then lines starting with `+ az cognitiveservices account show`, `+ az cognitiveservices usage list`, `+ az deployment group what-if ... decision-existing.bicep --parameters accountName=foundry-example deploymentName=decision-1 capacityRpm=300`, `+ az deployment group create ...`, `+ az cognitiveservices account deployment show ...`, the smoke-test line, and the final secrets block where `AZURE_DECISION_KEY` reads `not printed`.

- [ ] **Step 6: Check the guards**

Run: `infra/azure/deploy-decision.sh --resource-group rg --account acct --deployment Microsoft-Decision-1 --dry-run; echo "exit $?"; infra/azure/deploy-decision.sh --resource-group rg --account acct --existing --create-group --dry-run; echo "exit $?"`
Expected: `deploy-decision: --deployment must not be Microsoft-Decision-1 (reserved word); use decision-1`, `exit 1`, then `deploy-decision: --create-group cannot be combined with --existing`, `exit 1`.

- [ ] **Step 7: Commit**

```bash
git add infra/azure/decision.bicep infra/azure/decision-existing.bicep infra/azure/deploy-decision.sh
git commit -m "feat(infra): add Microsoft-Decision-1 Bicep and deploy script"
```

### Task 5: Eval package and synthetic fixtures

**Files:**

- Create (overwrite if plan 01 scaffolded them): `eval/package.json`, `eval/tsconfig.json`, `eval/vitest.config.ts`
- Create: `eval/src/fixtures.ts`, `eval/fixtures/emails.jsonl`
- Modify: `.gitignore` (append `eval/private/`)
- Test: `eval/test/fixtures.test.ts`

**Interfaces:**

- Consumes: types `MailHeaders`, `MailMessage`, `Signals` from `@clearbox/core`; `zod` 4.6.7.
- Produces: `OWNER_ADDRESS = "owner@example.test"`, `DAY_MS`, `FIXTURE_CATEGORIES` (`promotion`, `newsletter`, `receipt`, `otp`, `human`, `github`, `security_alert`, `calendar`, `other`), `FixtureCategory`, `SignalsSchema`, `EvalFixtureSchema`, `EvalFixture { id; source: "synthetic" | "owner"; category; label: ActionKind; input: MessageInput | { kind: "signals"; subject; snippet; signals }; history: { seenCount; readCount; isCorrespondent } }`, `MessageInput`, `isReservedDomain(domain)`, `domainsIn(input: MessageInput): string[]`, `parseFixtures(text, origin): EvalFixture[]`, `loadFixtures(path)`, `threadIdFor(fixture)`, `toMailMessage(fixture, now): MailMessage`.

Fixture format (one JSON object per line): `id` (`syn-NNN` or `owner-<labelId>`), `source`, `category`, `label` (the action the owner would take: `delete`, `archive`, `keep`), `input`, optional `history`. `input.kind = "message"` describes the email as the provider layer would normalize it (defaults: `to` = owner, `cc` = [], `starred` false, `providerImportant` false, `category` null, `hasAttachments` false, `threadDepth` 1, `ownerReplied` false, headers null). `input.kind = "signals"` carries a stored `Signals` object (owner exports).

- [ ] **Step 1: Package files**

Create `eval/package.json` with exactly this content:

```json
{
  "name": "@clearbox/eval",
  "private": true,
  "type": "module",
  "scripts": {
    "eval": "node src/run.ts",
    "export-labels": "node src/export-labels.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@clearbox/core": "workspace:*",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "vitest": "5.0.4"
  }
}
```

Create `eval/tsconfig.json` with exactly this content:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts"]
}
```

Create `eval/vitest.config.ts` with exactly this content:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

Append one line to `.gitignore`, directly after `*.secrets.json`:

```gitignore
eval/private/
```

Run: `pnpm install && git check-ignore -v eval/private/owner-labels.jsonl`
Expected: install succeeds; `.gitignore:<n>:eval/private/	eval/private/owner-labels.jsonl`.

- [ ] **Step 2: Add the 40 synthetic fixtures**

Distribution: promotion 7, newsletter 6, receipt 5, otp 4, human 6, github 5, security_alert 4, calendar 3; labels delete 18, archive 10, keep 12. All domains are reserved names.

Create `eval/fixtures/emails.jsonl` with exactly this content:

```jsonl
{"id":"syn-001","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"deals@shop.example.com","name":"Northwind Outfitters"},"subject":"Last chance: 40% off all winter jackets ends tonight","snippet":"Our biggest sale of the season ends at midnight. Free shipping on orders over $50.","ageDays":41,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://shop.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@shop.example.com>","listId":"<news.shop.example.com>","precedence":"bulk","returnPath":"<bounces@shop.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=shop.example.com; dkim=pass header.d=shop.example.com; dmarc=pass header.from=shop.example.com","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":37,"readCount":0,"isCorrespondent":false}}
{"id":"syn-002","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"offers@travel.example.net","name":"Skyline Travel"},"subject":"Flash fares to Lisbon from $199, book by Sunday","snippet":"Limited seats on spring departures. Prices shown include taxes and fees.","ageDays":22,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://travel.example.net/unsubscribe/u-7f3a>, <mailto:unsubscribe@travel.example.net>","listId":"<news.travel.example.net>","precedence":"bulk","returnPath":"<bounces@travel.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=travel.example.net; dkim=pass header.d=travel.example.net; dmarc=pass header.from=travel.example.net","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":18,"readCount":1,"isCorrespondent":false}}
{"id":"syn-003","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"hello@coffee.example.org","name":"Bean Street Roasters"},"subject":"Your weekend treat: buy one bag, get one free","snippet":"Stock up on our single-origin beans this weekend only. Use code BOGO at checkout.","ageDays":15,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://coffee.example.org/unsubscribe/u-7f3a>, <mailto:unsubscribe@coffee.example.org>","listId":"<news.coffee.example.org>","precedence":"bulk","returnPath":"<bounces@coffee.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=coffee.example.org; dkim=pass header.d=coffee.example.org; dmarc=pass header.from=coffee.example.org","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":25,"readCount":2,"isCorrespondent":false}}
{"id":"syn-004","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"promo@electronics.example.com","name":"Volt Electronics"},"subject":"Black Friday early access is live","snippet":"Members get 24 hours of early access to doorbusters on headphones, TVs and laptops.","ageDays":60,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://electronics.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@electronics.example.com>","listId":"<news.electronics.example.com>","precedence":"bulk","returnPath":"<bounces@electronics.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=electronics.example.com; dkim=pass header.d=electronics.example.com; dmarc=pass header.from=electronics.example.com","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":52,"readCount":0,"isCorrespondent":false}}
{"id":"syn-005","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"news@fitness.example.net","name":"PulseFit"},"subject":"We miss you! Come back for 3 months at half price","snippet":"It has been a while since your last class. Rejoin today and save 50% on your first three months.","ageDays":33,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://fitness.example.net/unsubscribe/u-7f3a>, <mailto:unsubscribe@fitness.example.net>","listId":"<news.fitness.example.net>","precedence":"bulk","returnPath":"<bounces@fitness.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=fitness.example.net; dkim=pass header.d=fitness.example.net; dmarc=pass header.from=fitness.example.net","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":9,"readCount":0,"isCorrespondent":false}}
{"id":"syn-006","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"rewards@grocer.example.com","name":"FreshCart Rewards"},"subject":"You have 120 points expiring soon","snippet":"Redeem your points before the end of the month for discounts on your next order.","ageDays":70,"isRead":true,"category":"promotions","headers":{"listUnsubscribe":"<https://grocer.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@grocer.example.com>","listId":"<news.grocer.example.com>","precedence":"bulk","returnPath":"<bounces@grocer.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=grocer.example.com; dkim=pass header.d=grocer.example.com; dmarc=pass header.from=grocer.example.com","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":30,"readCount":12,"isCorrespondent":false}}
{"id":"syn-007","source":"synthetic","category":"promotion","label":"delete","input":{"kind":"message","from":{"address":"sale@furniture.example.org","name":"Oak & Pine"},"subject":"Spring collection preview: 25% off sofas","snippet":"Discover new fabrics and colors. Offer valid through April 30 in stores and online.","ageDays":120,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://furniture.example.org/unsubscribe/u-7f3a>, <mailto:unsubscribe@furniture.example.org>","listId":"<news.furniture.example.org>","precedence":"bulk","returnPath":"<bounces@furniture.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=furniture.example.org; dkim=pass header.d=furniture.example.org; dmarc=pass header.from=furniture.example.org","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":14,"readCount":0,"isCorrespondent":false}}
{"id":"syn-008","source":"synthetic","category":"newsletter","label":"delete","input":{"kind":"message","from":{"address":"digest@news.example.com","name":"Morning Brief"},"subject":"Morning Brief: markets, weather and 5 stories to read","snippet":"Stocks closed higher on Tuesday. Rain expected across the region by Thursday.","ageDays":28,"isRead":false,"category":"updates","headers":{"listUnsubscribe":"<https://news.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@news.example.com>","listId":"<morning-brief.news.example.com>","precedence":"bulk","returnPath":"<bounces@news.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=news.example.com; dkim=pass header.d=news.example.com; dmarc=pass header.from=news.example.com","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":90,"readCount":2,"isCorrespondent":false}}
{"id":"syn-009","source":"synthetic","category":"newsletter","label":"delete","input":{"kind":"message","from":{"address":"weekly@gadgets.example.net","name":"Gadget Weekly"},"subject":"Gadget Weekly #212: foldable phones revisited","snippet":"This week we test three foldable phones and round up the best budget earbuds.","ageDays":45,"isRead":false,"category":"updates","headers":{"listUnsubscribe":"<https://gadgets.example.net/unsubscribe/u-7f3a>, <mailto:unsubscribe@gadgets.example.net>","listId":"<news.gadgets.example.net>","precedence":"bulk","returnPath":"<bounces@gadgets.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=gadgets.example.net; dkim=pass header.d=gadgets.example.net; dmarc=pass header.from=gadgets.example.net","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":40,"readCount":0,"isCorrespondent":false}}
{"id":"syn-010","source":"synthetic","category":"newsletter","label":"delete","input":{"kind":"message","from":{"address":"community@forum.example.org","name":"Hobby Forum"},"subject":"Top threads this week in Model Trains","snippet":"See what members are building: a 1:87 scale station, track planning tips and more.","ageDays":19,"isRead":false,"category":"forums","headers":{"listUnsubscribe":"<https://forum.example.org/unsubscribe/u-7f3a>, <mailto:unsubscribe@forum.example.org>","listId":"<news.forum.example.org>","precedence":"list","returnPath":"<bounces@forum.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=forum.example.org; dkim=pass header.d=forum.example.org; dmarc=pass header.from=forum.example.org","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":26,"readCount":1,"isCorrespondent":false}}
{"id":"syn-011","source":"synthetic","category":"newsletter","label":"keep","input":{"kind":"message","from":{"address":"letters@writer.example.com","name":"Dana Writes"},"subject":"Essay: what I learned from a year of slow reading","snippet":"A long note on attention, libraries and the books that changed my mind this year.","ageDays":4,"isRead":true,"category":"updates","headers":{"listUnsubscribe":"<https://writer.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@writer.example.com>","listId":"<news.writer.example.com>","precedence":"bulk","returnPath":"<bounces@writer.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=writer.example.com; dkim=pass header.d=writer.example.com; dmarc=pass header.from=writer.example.com"}},"history":{"seenCount":30,"readCount":28,"isCorrespondent":false}}
{"id":"syn-012","source":"synthetic","category":"newsletter","label":"keep","input":{"kind":"message","from":{"address":"updates@school.example.net","name":"Maple Elementary"},"subject":"Class newsletter: field trip permission due Friday","snippet":"Please return the signed permission slip for the museum trip by Friday, October 23.","ageDays":5,"isRead":false,"category":"updates","headers":{"listUnsubscribe":"<https://school.example.net/unsubscribe/u-7f3a>, <mailto:unsubscribe@school.example.net>","listId":"<news.school.example.net>","returnPath":"<bounces@school.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=school.example.net; dkim=pass header.d=school.example.net; dmarc=pass header.from=school.example.net","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":20,"readCount":19,"isCorrespondent":false}}
{"id":"syn-013","source":"synthetic","category":"newsletter","label":"archive","input":{"kind":"message","from":{"address":"release-notes@tool.example.com","name":"Toolkit Team"},"subject":"Toolkit 4.2 release notes","snippet":"New features include offline mode, faster sync and a redesigned settings page.","ageDays":12,"isRead":true,"category":"updates","headers":{"listUnsubscribe":"<https://tool.example.com/unsubscribe/u-7f3a>, <mailto:unsubscribe@tool.example.com>","listId":"<news.tool.example.com>","precedence":"bulk","returnPath":"<bounces@tool.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=tool.example.com; dkim=pass header.d=tool.example.com; dmarc=pass header.from=tool.example.com"}},"history":{"seenCount":12,"readCount":8,"isCorrespondent":false}}
{"id":"syn-014","source":"synthetic","category":"receipt","label":"archive","input":{"kind":"message","from":{"address":"orders@shop.example.com","name":"Northwind Outfitters"},"subject":"Your order #48213 has shipped","snippet":"Your package with 2 items is on its way. Estimated delivery: Monday.","ageDays":9,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@shop.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=shop.example.com; dkim=pass header.d=shop.example.com; dmarc=pass header.from=shop.example.com"}},"history":{"seenCount":37,"readCount":3,"isCorrespondent":false}}
{"id":"syn-015","source":"synthetic","category":"receipt","label":"archive","input":{"kind":"message","from":{"address":"receipts@ride.example.net","name":"CityRide"},"subject":"Your receipt for Tuesday evening trip","snippet":"Total $18.40 charged to card ending 4242. Thanks for riding with CityRide.","ageDays":30,"isRead":false,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@ride.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=ride.example.net; dkim=pass header.d=ride.example.net; dmarc=pass header.from=ride.example.net"}},"history":{"seenCount":15,"readCount":2,"isCorrespondent":false}}
{"id":"syn-016","source":"synthetic","category":"receipt","label":"archive","input":{"kind":"message","from":{"address":"billing@cloudhost.example.org","name":"CloudHost Billing"},"subject":"Invoice INV-2026-0912 for September","snippet":"Your invoice for September is attached. Amount due: $12.00. Payment will be collected automatically.","ageDays":35,"isRead":false,"category":"updates","hasAttachments":true,"headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@cloudhost.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=cloudhost.example.org; dkim=pass header.d=cloudhost.example.org; dmarc=pass header.from=cloudhost.example.org"}},"history":{"seenCount":10,"readCount":4,"isCorrespondent":false}}
{"id":"syn-017","source":"synthetic","category":"receipt","label":"archive","input":{"kind":"message","from":{"address":"payments@utility.example.com","name":"Metro Power"},"subject":"Payment received, thank you","snippet":"We received your payment of $64.10 for account ending 0193 on October 2.","ageDays":13,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@utility.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=utility.example.com; dkim=pass header.d=utility.example.com; dmarc=pass header.from=utility.example.com"}},"history":{"seenCount":12,"readCount":6,"isCorrespondent":false}}
{"id":"syn-018","source":"synthetic","category":"receipt","label":"archive","input":{"kind":"message","from":{"address":"noreply@bookstore.example.net","name":"Chapter One Books"},"subject":"Order confirmation: The Long Walk Home","snippet":"Thanks for your order. We will email you again when your book ships.","ageDays":48,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@bookstore.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=bookstore.example.net; dkim=pass header.d=bookstore.example.net; dmarc=pass header.from=bookstore.example.net"}},"history":{"seenCount":6,"readCount":4,"isCorrespondent":false}}
{"id":"syn-019","source":"synthetic","category":"otp","label":"delete","input":{"kind":"message","from":{"address":"codes@login.example.com","name":"Example Login"},"subject":"Your verification code is 482913","snippet":"Use 482913 to sign in. This code expires in 10 minutes. If you did not request it, ignore this email.","ageDays":12,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@login.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=login.example.com; dkim=pass header.d=login.example.com; dmarc=pass header.from=login.example.com"}},"history":{"seenCount":22,"readCount":22,"isCorrespondent":false}}
{"id":"syn-020","source":"synthetic","category":"otp","label":"delete","input":{"kind":"message","from":{"address":"security@bank.example.net","name":"Harbor Bank"},"subject":"Your one-time passcode","snippet":"Your one-time passcode is 735102. It is valid for 5 minutes. Never share this code.","ageDays":40,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@bank.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=bank.example.net; dkim=pass header.d=bank.example.net; dmarc=pass header.from=bank.example.net"}},"history":{"seenCount":15,"readCount":15,"isCorrespondent":false}}
{"id":"syn-021","source":"synthetic","category":"otp","label":"delete","input":{"kind":"message","from":{"address":"no-reply@shop.example.org","name":"Corner Shop"},"subject":"Confirm your email address","snippet":"Enter 5521 to confirm your email address and finish creating your account.","ageDays":90,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@shop.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=shop.example.org; dkim=pass header.d=shop.example.org; dmarc=pass header.from=shop.example.org"}},"history":{"seenCount":1,"readCount":1,"isCorrespondent":false}}
{"id":"syn-022","source":"synthetic","category":"otp","label":"delete","input":{"kind":"message","from":{"address":"verify@games.example.com","name":"Arcade Hub"},"subject":"Arcade Hub login code: 660417","snippet":"Here is your login code. It expires in 15 minutes.","ageDays":7,"isRead":false,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@games.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=games.example.com; dkim=pass header.d=games.example.com; dmarc=pass header.from=games.example.com"}},"history":{"seenCount":8,"readCount":6,"isCorrespondent":false}}
{"id":"syn-023","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"alex@team.example.org","name":"Alex Rivera"},"subject":"Re: draft budget for Q4","snippet":"Thanks, I left two comments on the travel line. Can we meet Thursday to finalize?","ageDays":6,"isRead":true,"threadDepth":4,"ownerReplied":true,"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=team.example.org; dkim=pass header.d=team.example.org; dmarc=pass header.from=team.example.org","returnPath":"<mailer@team.example.org>"}},"history":{"seenCount":80,"readCount":78,"isCorrespondent":true}}
{"id":"syn-024","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"grandma@family.example.net","name":"Rosa"},"subject":"Photos from Sunday","snippet":"Here are the photos from lunch. The one with the dog is my favorite!","ageDays":8,"isRead":true,"hasAttachments":true,"starred":true,"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=family.example.net; dkim=pass header.d=family.example.net; dmarc=pass header.from=family.example.net","returnPath":"<mailer@family.example.net>"}},"history":{"seenCount":40,"readCount":40,"isCorrespondent":true}}
{"id":"syn-025","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"sam@friends.example.com","name":"Sam Lee"},"subject":"Dinner next week?","snippet":"Are you free Wednesday or Thursday? I found a new ramen place near the station.","ageDays":4,"isRead":false,"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=friends.example.com; dkim=pass header.d=friends.example.com; dmarc=pass header.from=friends.example.com","returnPath":"<mailer@friends.example.com>"}},"history":{"seenCount":25,"readCount":24,"isCorrespondent":true}}
{"id":"syn-026","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"landlord@homes.example.org","name":"J. Patel"},"subject":"Heating maintenance visit on Monday","snippet":"A technician will check the boiler on Monday between 9 and 11. Please make sure someone is home.","ageDays":3,"isRead":false,"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=homes.example.org; dkim=pass header.d=homes.example.org; dmarc=pass header.from=homes.example.org","returnPath":"<mailer@homes.example.org>"}},"history":{"seenCount":5,"readCount":5,"isCorrespondent":true}}
{"id":"syn-027","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"jordan@client.example.net","name":"Jordan Kim"},"subject":"Contract question","snippet":"Before I sign, could you confirm whether the support hours include weekends?","ageDays":5,"isRead":false,"cc":["partner@client.example.net"],"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=client.example.net; dkim=pass header.d=client.example.net; dmarc=pass header.from=client.example.net","returnPath":"<mailer@client.example.net>"}},"history":{"seenCount":3,"readCount":3,"isCorrespondent":false}}
{"id":"syn-028","source":"synthetic","category":"human","label":"keep","input":{"kind":"message","from":{"address":"coach@club.example.com","name":"Coach Mia"},"subject":"Saturday practice moved to 10am","snippet":"Field 2 is booked earlier, so we start at 10. Bring water and shin guards.","ageDays":3,"isRead":true,"to":["parents@club.example.com"],"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=club.example.com; dkim=pass header.d=club.example.com; dmarc=pass header.from=club.example.com","returnPath":"<mailer@club.example.com>"}},"history":{"seenCount":12,"readCount":12,"isCorrespondent":true}}
{"id":"syn-029","source":"synthetic","category":"github","label":"delete","input":{"kind":"message","from":{"address":"notifications@github.example","name":"CI Bot"},"subject":"[acme/widgets] Run failed: CI - main (4f2a9c1)","snippet":"Run failed for main. Test job failed after 3m 12s. View the workflow run for details.","ageDays":30,"isRead":false,"category":"updates","headers":{"listId":"<widgets.acme.github.example>","listUnsubscribe":"<https://github.example/notifications/unsubscribe/abc123>","returnPath":"<noreply@github.example>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=github.example; dkim=pass header.d=github.example; dmarc=pass header.from=github.example"}},"history":{"seenCount":300,"readCount":20,"isCorrespondent":false}}
{"id":"syn-030","source":"synthetic","category":"github","label":"delete","input":{"kind":"message","from":{"address":"notifications@github.example","name":"Riley Chen"},"subject":"Re: [acme/widgets] Fix flaky upload test (PR #482)","snippet":"Merged #482 into main.","ageDays":25,"isRead":true,"category":"updates","headers":{"listId":"<widgets.acme.github.example>","listUnsubscribe":"<https://github.example/notifications/unsubscribe/abc123>","returnPath":"<noreply@github.example>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=github.example; dkim=pass header.d=github.example; dmarc=pass header.from=github.example"}},"history":{"seenCount":300,"readCount":20,"isCorrespondent":false}}
{"id":"syn-031","source":"synthetic","category":"github","label":"delete","input":{"kind":"message","from":{"address":"notifications@github.example","name":"Dependency Bot"},"subject":"[acme/widgets] Bump parser from 2.1.0 to 2.1.1 (PR #490)","snippet":"Bumps parser from 2.1.0 to 2.1.1. Release notes and commits are included below.","ageDays":14,"isRead":false,"category":"updates","headers":{"listId":"<widgets.acme.github.example>","listUnsubscribe":"<https://github.example/notifications/unsubscribe/abc123>","returnPath":"<noreply@github.example>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=github.example; dkim=pass header.d=github.example; dmarc=pass header.from=github.example"}},"history":{"seenCount":300,"readCount":20,"isCorrespondent":false}}
{"id":"syn-032","source":"synthetic","category":"github","label":"archive","input":{"kind":"message","from":{"address":"notifications@github.example","name":"acme/widgets"},"subject":"[acme/widgets] Release v3.0.0","snippet":"Widgets 3.0.0 is out. Breaking: the legacy upload API was removed. See the migration guide.","ageDays":10,"isRead":true,"category":"updates","headers":{"listId":"<widgets.acme.github.example>","listUnsubscribe":"<https://github.example/notifications/unsubscribe/abc123>","returnPath":"<noreply@github.example>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=github.example; dkim=pass header.d=github.example; dmarc=pass header.from=github.example"}},"history":{"seenCount":300,"readCount":20,"isCorrespondent":false}}
{"id":"syn-033","source":"synthetic","category":"github","label":"keep","input":{"kind":"message","from":{"address":"notifications@github.example","name":"Riley Chen"},"subject":"[acme/widgets] Review requested: Add retry to sync (PR #501)","snippet":"@owner requested your review on this pull request. 4 files changed.","ageDays":3,"isRead":false,"category":"updates","headers":{"listId":"<widgets.acme.github.example>","listUnsubscribe":"<https://github.example/notifications/unsubscribe/abc123>","returnPath":"<noreply@github.example>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=github.example; dkim=pass header.d=github.example; dmarc=pass header.from=github.example"}},"history":{"seenCount":300,"readCount":20,"isCorrespondent":false}}
{"id":"syn-034","source":"synthetic","category":"security_alert","label":"keep","input":{"kind":"message","from":{"address":"no-reply@accounts.example.com","name":"Example Accounts"},"subject":"Security alert: new sign-in on Linux","snippet":"We noticed a new sign-in to your account from a Linux device. If this was you, no action is needed.","ageDays":3,"isRead":false,"category":"updates","providerImportant":true,"headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@accounts.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=accounts.example.com; dkim=pass header.d=accounts.example.com; dmarc=pass header.from=accounts.example.com"}},"history":{"seenCount":10,"readCount":9,"isCorrespondent":false}}
{"id":"syn-035","source":"synthetic","category":"security_alert","label":"keep","input":{"kind":"message","from":{"address":"security@bank.example.net","name":"Harbor Bank"},"subject":"Your password was changed","snippet":"The password for your online banking was changed today. If you did not do this, call us immediately.","ageDays":4,"isRead":false,"category":"updates","providerImportant":true,"headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@bank.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=bank.example.net; dkim=pass header.d=bank.example.net; dmarc=pass header.from=bank.example.net"}},"history":{"seenCount":15,"readCount":15,"isCorrespondent":false}}
{"id":"syn-036","source":"synthetic","category":"security_alert","label":"archive","input":{"kind":"message","from":{"address":"no-reply@accounts.example.com","name":"Example Accounts"},"subject":"Security alert: new sign-in on Windows","snippet":"We noticed a new sign-in to your account from a Windows device. If this was you, no action is needed.","ageDays":95,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@accounts.example.com>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=accounts.example.com; dkim=pass header.d=accounts.example.com; dmarc=pass header.from=accounts.example.com"}},"history":{"seenCount":10,"readCount":9,"isCorrespondent":false}}
{"id":"syn-037","source":"synthetic","category":"security_alert","label":"archive","input":{"kind":"message","from":{"address":"alerts@cloudhost.example.org","name":"CloudHost Security"},"subject":"Two-factor authentication enabled","snippet":"Two-factor authentication is now on for your account. Keep your recovery codes in a safe place.","ageDays":60,"isRead":true,"category":"updates","headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@cloudhost.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=cloudhost.example.org; dkim=pass header.d=cloudhost.example.org; dmarc=pass header.from=cloudhost.example.org"}},"history":{"seenCount":10,"readCount":4,"isCorrespondent":false}}
{"id":"syn-038","source":"synthetic","category":"calendar","label":"keep","input":{"kind":"message","from":{"address":"alex@team.example.org","name":"Alex Rivera"},"subject":"Invitation: Design review @ Thu Oct 22, 2026 10:00 (owner@example.test)","snippet":"You have been invited to Design review. Join with the meeting link in the event.","ageDays":3,"isRead":false,"hasAttachments":true,"headers":{"authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=team.example.org; dkim=pass header.d=team.example.org; dmarc=pass header.from=team.example.org","returnPath":"<mailer@team.example.org>"}},"history":{"seenCount":80,"readCount":78,"isCorrespondent":true}}
{"id":"syn-039","source":"synthetic","category":"calendar","label":"delete","input":{"kind":"message","from":{"address":"events@webinar.example.net","name":"Webinar Series"},"subject":"Reminder: Cloud costs webinar starts in 1 hour","snippet":"Join us live at 3pm. Can't make it? A recording will be shared after the session.","ageDays":45,"isRead":false,"category":"promotions","headers":{"listUnsubscribe":"<https://webinar.example.net/unsubscribe/u-7f3a>, <mailto:unsubscribe@webinar.example.net>","listId":"<news.webinar.example.net>","precedence":"bulk","returnPath":"<bounces@webinar.example.net>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=webinar.example.net; dkim=pass header.d=webinar.example.net; dmarc=pass header.from=webinar.example.net","listUnsubscribePost":"List-Unsubscribe=One-Click"}},"history":{"seenCount":11,"readCount":1,"isCorrespondent":false}}
{"id":"syn-040","source":"synthetic","category":"calendar","label":"archive","input":{"kind":"message","from":{"address":"calendar@team.example.org","name":"Team Calendar"},"subject":"Accepted: Quarterly planning @ Mon Aug 3, 2026","snippet":"Jordan Kim has accepted this invitation.","ageDays":73,"isRead":true,"headers":{"autoSubmitted":"auto-generated","returnPath":"<no-reply@team.example.org>","authenticationResults":"mx.google.com; spf=pass smtp.mailfrom=team.example.org; dkim=pass header.d=team.example.org; dmarc=pass header.from=team.example.org"}},"history":{"seenCount":30,"readCount":25,"isCorrespondent":false}}
```

- [ ] **Step 3: Write the failing test**

Create `eval/test/fixtures.test.ts` with exactly this content:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  FIXTURE_CATEGORIES,
  OWNER_ADDRESS,
  domainsIn,
  isReservedDomain,
  loadFixtures,
  parseFixtures,
  toMailMessage,
} from "../src/fixtures.ts";

const COMMITTED = fileURLToPath(new URL("../fixtures/emails.jsonl", import.meta.url));

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "syn-900",
    source: "synthetic",
    category: "promotion",
    label: "delete",
    input: {
      kind: "message",
      from: { address: "deals@shop.example.com", name: "Shop" },
      subject: "Sale",
      snippet: "Sale ends tonight",
      ageDays: 10,
      isRead: false,
    },
    ...over,
  });

describe("committed fixtures", () => {
  const fixtures = loadFixtures(COMMITTED);

  it("has 40 synthetic fixtures with unique ids", () => {
    expect(fixtures).toHaveLength(40);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(40);
    expect(fixtures.every((f) => f.source === "synthetic")).toBe(true);
  });

  it("covers every category except other, and all three labels", () => {
    const categories = new Set(fixtures.map((f) => f.category));
    for (const c of FIXTURE_CATEGORIES.filter((c) => c !== "other")) expect(categories.has(c)).toBe(true);
    expect(new Set(fixtures.map((f) => f.label))).toEqual(new Set(["delete", "archive", "keep"]));
  });

  it("uses reserved domains only", () => {
    for (const f of fixtures) {
      if (f.input.kind !== "message") throw new Error("synthetic fixtures are messages");
      for (const d of domainsIn(f.input)) expect(isReservedDomain(d), `${f.id}: ${d}`).toBe(true);
    }
  });
});

describe("parseFixtures", () => {
  it("applies defaults", () => {
    const [f] = parseFixtures(line(), "t");
    expect(f?.history).toEqual({ seenCount: 0, readCount: 0, isCorrespondent: false });
    if (f?.input.kind !== "message") throw new Error("expected message");
    expect(f.input.to).toEqual([OWNER_ADDRESS]);
    expect(f.input.headers).toEqual({});
  });

  it("rejects non-reserved domains in synthetic fixtures", () => {
    const bad = line({
      input: {
        kind: "message",
        from: { address: "a@gmail.com", name: null },
        subject: "",
        snippet: "",
        ageDays: 1,
        isRead: true,
      },
    });
    expect(() => parseFixtures(bad, "t")).toThrow(/non-reserved domain\(s\).*gmail\.com/);
  });

  it("rejects duplicate ids, bad JSON and unknown fields", () => {
    expect(() => parseFixtures(`${line()}\n${line()}`, "t")).toThrow(/duplicate id/);
    expect(() => parseFixtures("{", "t")).toThrow(/t:1: invalid JSON/);
    expect(() => parseFixtures(line({ extra: 1 }), "t")).toThrow(/t:1/);
  });
});

describe("isReservedDomain", () => {
  it("accepts RFC 2606 names and rejects real domains", () => {
    for (const d of [
      "example.com",
      "shop.example.com",
      "example.net",
      "x.example.org",
      "a.test",
      "github.example",
    ]) {
      expect(isReservedDomain(d)).toBe(true);
    }
    for (const d of ["gmail.com", "example.co", "notexample.com", "test.com"])
      expect(isReservedDomain(d)).toBe(false);
  });
});

describe("toMailMessage", () => {
  it("builds a normalized message with null header defaults", () => {
    const [f] = parseFixtures(line(), "t");
    if (f === undefined) throw new Error("missing fixture");
    const now = 1_800_000_000_000;
    const msg = toMailMessage(f, now);
    expect(msg.receivedAt).toBe(now - 10 * DAY_MS);
    expect(msg.providerMessageId).toBe("syn-900");
    expect(msg.threadId).toBe("thread-syn-900");
    expect(msg.headers.listUnsubscribe).toBeNull();
    expect(msg.headers.returnPath).toBeNull();
    expect(msg.to).toEqual([OWNER_ADDRESS]);
    expect(msg.deliveredTo).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/eval exec vitest run test/fixtures.test.ts`
Expected: FAIL, `Failed to load url ../src/fixtures.ts` (or "Cannot find module").

- [ ] **Step 5: Implement**

Create `eval/src/fixtures.ts` with exactly this content:

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MailHeaders, MailMessage, Signals } from "@clearbox/core";

export const OWNER_ADDRESS = "owner@example.test";
export const DAY_MS = 86_400_000;

export const FIXTURE_CATEGORIES = [
  "promotion",
  "newsletter",
  "receipt",
  "otp",
  "human",
  "github",
  "security_alert",
  "calendar",
  "other",
] as const;
export type FixtureCategory = (typeof FIXTURE_CATEGORIES)[number];

const MailCategorySchema = z.enum([
  "primary",
  "promotions",
  "social",
  "updates",
  "forums",
  "focused",
  "other",
]);
const AuthVerdictSchema = z.enum(["pass", "fail", "none"]);
const nullableText = z.string().nullable().optional();

const HeadersSchema = z
  .object({
    listUnsubscribe: nullableText,
    listUnsubscribePost: nullableText,
    listId: nullableText,
    precedence: nullableText,
    autoSubmitted: nullableText,
    authenticationResults: nullableText,
    returnPath: nullableText,
    contentType: nullableText,
    references: nullableText,
    inReplyTo: nullableText,
  })
  .strict();

const MessageInputSchema = z
  .object({
    kind: z.literal("message"),
    from: z.object({ address: z.string().nullable(), name: z.string().nullable() }).strict(),
    to: z.array(z.string()).default([OWNER_ADDRESS]),
    cc: z.array(z.string()).default([]),
    subject: z.string(),
    snippet: z.string().max(255),
    ageDays: z.int().min(0).max(3650),
    isRead: z.boolean(),
    starred: z.boolean().default(false),
    providerImportant: z.boolean().default(false),
    category: MailCategorySchema.nullable().default(null),
    hasAttachments: z.boolean().default(false),
    threadDepth: z.int().min(1).nullable().default(1),
    ownerReplied: z.boolean().default(false),
    headers: HeadersSchema.default({}),
  })
  .strict();

/** Mirrors `Signals` (contracts 4.5); used for exported owner labels. */
export const SignalsSchema = z
  .object({
    senderAddress: z.string(),
    senderDomain: z.string(),
    senderName: z.string().nullable(),
    senderKnown: z.boolean(),
    ownerReplied: z.boolean(),
    isCorrespondent: z.boolean(),
    senderSeenCount: z.number(),
    senderOpenRate: z.number().nullable(),
    ownerDeleteRate: z.number().nullable(),
    ownerDecisions: z.number(),
    hasListUnsubscribe: z.boolean(),
    oneClickUnsubscribe: z.boolean(),
    hasListId: z.boolean(),
    precedenceBulk: z.boolean(),
    autoSubmitted: z.boolean(),
    espDomain: z.string().nullable(),
    auth: z.object({ spf: AuthVerdictSchema, dkim: AuthVerdictSchema, dmarc: AuthVerdictSchema }),
    category: MailCategorySchema.nullable(),
    starred: z.boolean(),
    providerImportant: z.boolean(),
    ageDays: z.number().min(0),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
    attachmentsApprox: z.boolean(),
    threadDepth: z.number().nullable(),
    ownerPosition: z.enum(["to", "cc", "bcc_or_list"]),
  })
  .loose();

const SignalsInputSchema = z
  .object({
    kind: z.literal("signals"),
    subject: z.string(),
    snippet: z.string(),
    signals: SignalsSchema,
  })
  .strict();

const HistorySchema = z
  .object({
    seenCount: z.int().min(0),
    readCount: z.int().min(0),
    isCorrespondent: z.boolean(),
  })
  .strict();

export const EvalFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,64}$/),
    source: z.enum(["synthetic", "owner"]),
    category: z.enum(FIXTURE_CATEGORIES),
    label: z.enum(["delete", "archive", "keep"]),
    input: z.discriminatedUnion("kind", [MessageInputSchema, SignalsInputSchema]),
    history: HistorySchema.default({ seenCount: 0, readCount: 0, isCorrespondent: false }),
  })
  .strict();

export type EvalFixture = z.infer<typeof EvalFixtureSchema>;
export type MessageInput = z.infer<typeof MessageInputSchema>;

const RESERVED_BASES = ["example.com", "example.net", "example.org"];

/** RFC 2606 / 6761 reserved names only: example.com|net|org (and subdomains), *.test, *.example. */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.endsWith(".test") || d.endsWith(".example")) return true;
  return RESERVED_BASES.some((base) => d === base || d.endsWith(`.${base}`));
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).replace(/>$/, "") : null;
}

/** Every domain mentioned in addresses, Return-Path and List-Unsubscribe URIs of a message input. */
export function domainsIn(input: MessageInput): string[] {
  const out: string[] = [];
  const addresses = [input.from.address, ...input.to, ...input.cc, input.headers.returnPath ?? null];
  for (const a of addresses) {
    const d = a === null ? null : domainOf(a);
    if (d !== null) out.push(d);
  }
  for (const uri of (input.headers.listUnsubscribe ?? "").matchAll(/<([^>]+)>/g)) {
    const value = uri[1] ?? "";
    const d = value.startsWith("mailto:")
      ? domainOf(value)
      : URL.canParse(value)
        ? new URL(value).hostname
        : null;
    if (d !== null) out.push(d);
  }
  return out;
}

/** Parses JSONL. Synthetic fixtures must only use reserved domains; ids must be unique. */
export function parseFixtures(text: string, origin: string): EvalFixture[] {
  const fixtures: EvalFixture[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `${origin}:${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${where}: invalid JSON`);
    }
    const parsed = EvalFixtureSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${where}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid fixture"}`);
    }
    const fixture = parsed.data;
    if (seen.has(fixture.id)) throw new Error(`${where}: duplicate id ${fixture.id}`);
    seen.add(fixture.id);
    if (fixture.source === "synthetic") {
      if (fixture.input.kind !== "message")
        throw new Error(`${where}: synthetic fixtures use kind "message"`);
      const bad = domainsIn(fixture.input).filter((d) => !isReservedDomain(d));
      if (bad.length > 0)
        throw new Error(`${where}: non-reserved domain(s) in a synthetic fixture: ${bad.join(", ")}`);
    }
    fixtures.push(fixture);
  });
  return fixtures;
}

export function loadFixtures(path: string): EvalFixture[] {
  return parseFixtures(readFileSync(path, "utf8"), path);
}

const EMPTY_HEADERS: MailHeaders = {
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
};

export function threadIdFor(fixture: EvalFixture): string {
  return `thread-${fixture.id}`;
}

/** Builds the normalized message the provider layer would produce. */
export function toMailMessage(fixture: EvalFixture, now: number): MailMessage {
  const base = {
    providerMessageId: fixture.id,
    threadId: threadIdFor(fixture),
    internetMessageId: `<${fixture.id}@fixtures.example>`,
    deliveredTo: [],
    webLink: null,
    labels: [],
  };
  const input = fixture.input;
  if (input.kind === "message") {
    const headers: MailHeaders = { ...EMPTY_HEADERS };
    for (const key of Object.keys(EMPTY_HEADERS) as (keyof MailHeaders)[]) {
      headers[key] = input.headers[key] ?? null;
    }
    return {
      ...base,
      receivedAt: now - input.ageDays * DAY_MS,
      from: { address: input.from.address?.toLowerCase() ?? null, name: input.from.name },
      to: input.to.map((a) => a.toLowerCase()),
      cc: input.cc.map((a) => a.toLowerCase()),
      subject: input.subject,
      snippet: input.snippet,
      isRead: input.isRead,
      starred: input.starred,
      providerImportant: input.providerImportant,
      category: input.category,
      hasAttachments: input.hasAttachments,
      attachmentsApprox: false,
      threadDepth: input.threadDepth,
      headers,
    };
  }
  const s: Signals = input.signals;
  return {
    ...base,
    receivedAt: now - s.ageDays * DAY_MS,
    from: { address: s.senderAddress === "" ? null : s.senderAddress, name: s.senderName },
    to: [OWNER_ADDRESS],
    cc: [],
    subject: input.subject,
    snippet: input.snippet,
    isRead: s.isRead,
    starred: s.starred,
    providerImportant: s.providerImportant,
    category: s.category,
    hasAttachments: s.hasAttachments,
    attachmentsApprox: s.attachmentsApprox,
    threadDepth: s.threadDepth,
    headers: { ...EMPTY_HEADERS },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/eval exec vitest run test/fixtures.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 7: Format, lint, commit**

Run: `pnpm exec prettier --write eval && pnpm lint`
Expected: clean.

```bash
git add .gitignore eval/package.json eval/tsconfig.json eval/vitest.config.ts eval/src/fixtures.ts eval/fixtures/emails.jsonl eval/test/fixtures.test.ts pnpm-lock.yaml
git commit -m "feat(eval): add eval package and 40 synthetic fixtures"
```

### Task 6: Eval metrics

**Files:**

- Create: `eval/src/metrics.ts`
- Test: `eval/test/metrics.test.ts`

**Interfaces:**

- Consumes: types `ActionKind`, `SuggestedAction` from `@clearbox/core`.
- Produces: `LabeledPrediction { predicted; label }`, `PrecisionRecall { truePositives; falsePositives; falseNegatives; precision; recall; precisionLower95 }`, `wilsonLowerBound(successes, n, z?)`, `deletePrecisionRecall(rows)`, `PREDICTED_ORDER`, `LABEL_ORDER`, `ConfusionMatrix`, `confusionMatrix(rows)`, `ProbabilityPoint { p; positive }`, `ReliabilityBin`, `ReliabilityTable { bins; ece; brier }`, `reliabilityTable(points, binCount = 10)`, `ThresholdSample { pDelete; margin; label }`, `ThresholdPoint { tau; support; precision; recall }`, `thresholdSweep(samples, taus, deleteMargin)`, `ShufflePair`, `ShuffleRobustness { pairs; flips; flipRate; meanAbsDeltaDelete; maxAbsDeltaDelete }`, `shuffleRobustness(pairs)`, `percentile(values, p)` (nearest rank), `argmaxAction(dist)` (ties: keep, archive, unsure, delete).

- [ ] **Step 1: Write the failing test**

Create `eval/test/metrics.test.ts` with exactly this content:

```ts
import { describe, expect, it } from "vitest";
import {
  argmaxAction,
  confusionMatrix,
  deletePrecisionRecall,
  percentile,
  reliabilityTable,
  shuffleRobustness,
  thresholdSweep,
  wilsonLowerBound,
} from "../src/metrics.ts";

describe("deletePrecisionRecall", () => {
  it("counts delete as the positive class", () => {
    const r = deletePrecisionRecall([
      { predicted: "delete", label: "delete" },
      { predicted: "delete", label: "delete" },
      { predicted: "delete", label: "keep" },
      { predicted: "unsure", label: "delete" },
      { predicted: "keep", label: "keep" },
    ]);
    expect(r.truePositives).toBe(2);
    expect(r.falsePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.precision).toBeCloseTo(2 / 3, 9);
    expect(r.recall).toBeCloseTo(2 / 3, 9);
    expect(r.precisionLower95).toBeLessThan(2 / 3);
  });

  it("returns null precision when nothing is predicted delete", () => {
    const r = deletePrecisionRecall([{ predicted: "keep", label: "keep" }]);
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
    expect(r.precisionLower95).toBeNull();
  });
});

describe("wilsonLowerBound", () => {
  it("is below the point estimate and null for n = 0", () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(50, 50)).toBeCloseTo(0.9287, 3);
    expect(wilsonLowerBound(10, 20)).toBeCloseTo(0.2993, 3);
  });
});

describe("confusionMatrix", () => {
  it("counts suggestion by label", () => {
    const m = confusionMatrix([
      { predicted: "unsure", label: "keep" },
      { predicted: "archive", label: "archive" },
      { predicted: "unsure", label: "keep" },
    ]);
    expect(m.unsure.keep).toBe(2);
    expect(m.archive.archive).toBe(1);
    expect(m.delete.delete).toBe(0);
  });
});

describe("reliabilityTable", () => {
  it("bins probabilities and computes ECE and Brier", () => {
    const t = reliabilityTable([
      { p: 0.95, positive: true },
      { p: 1, positive: true },
      { p: 0.05, positive: false },
      { p: 0.15, positive: true },
    ]);
    expect(t.bins).toHaveLength(10);
    expect(t.bins[9]?.count).toBe(2);
    expect(t.bins[9]?.meanPredicted).toBeCloseTo(0.975, 9);
    expect(t.bins[9]?.observedRate).toBe(1);
    expect(t.bins[0]?.count).toBe(1);
    expect(t.bins[1]?.observedRate).toBe(1);
    expect(t.bins[5]?.meanPredicted).toBeNull();
    // ECE = 2/4*0.025 + 1/4*0.05 + 1/4*0.85
    expect(t.ece).toBeCloseTo(0.2375, 9);
    // Brier = (0.0025 + 0 + 0.0025 + 0.7225) / 4
    expect(t.brier).toBeCloseTo(0.181875, 9);
  });

  it("handles no points", () => {
    const t = reliabilityTable([]);
    expect(t.ece).toBeNull();
    expect(t.brier).toBeNull();
  });
});

describe("thresholdSweep", () => {
  it("applies tau and the delete margin like calibration", () => {
    const samples = [
      { pDelete: 0.95, margin: 0.9, label: "delete" as const },
      { pDelete: 0.85, margin: 0.75, label: "keep" as const },
      { pDelete: 0.9, margin: 0.1, label: "delete" as const },
      { pDelete: null, margin: null, label: "delete" as const },
    ];
    const [at80, at90] = thresholdSweep(samples, [0.8, 0.9], 0.2);
    expect(at80).toEqual({ tau: 0.8, support: 2, precision: 0.5, recall: 1 / 3 });
    expect(at90).toEqual({ tau: 0.9, support: 1, precision: 1, recall: 1 / 3 });
  });
});

describe("shuffleRobustness", () => {
  it("measures flips and probability drift", () => {
    const r = shuffleRobustness([
      { baseline: "delete", shuffled: "delete", baselineDelete: 0.9, shuffledDelete: 0.88 },
      { baseline: "archive", shuffled: "unsure", baselineDelete: 0.3, shuffledDelete: 0.4 },
    ]);
    expect(r.flips).toBe(1);
    expect(r.flipRate).toBe(0.5);
    expect(r.meanAbsDeltaDelete).toBeCloseTo(0.06, 9);
    expect(r.maxAbsDeltaDelete).toBeCloseTo(0.1, 9);
    expect(shuffleRobustness([]).flipRate).toBeNull();
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("argmaxAction", () => {
  it("prefers the safe order on ties", () => {
    expect(argmaxAction({ delete: 0.7, archive: 0.1, keep: 0.1, unsure: 0.1 })).toBe("delete");
    expect(argmaxAction({ delete: 0.4, archive: 0.4, keep: 0.1, unsure: 0.1 })).toBe("archive");
    expect(argmaxAction({ delete: 0.25, archive: 0.25, keep: 0.25, unsure: 0.25 })).toBe("keep");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/eval exec vitest run test/metrics.test.ts`
Expected: FAIL, cannot load `../src/metrics.ts`.

- [ ] **Step 3: Implement**

Create `eval/src/metrics.ts` with exactly this content:

```ts
import type { ActionKind, SuggestedAction } from "@clearbox/core";

export interface LabeledPrediction {
  predicted: SuggestedAction;
  label: ActionKind;
}

export interface PrecisionRecall {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when nothing was predicted as delete. */
  precision: number | null;
  /** null when nothing is labeled delete. */
  recall: number | null;
  /** Wilson 95% lower bound of precision; null when precision is null. */
  precisionLower95: number | null;
}

export function wilsonLowerBound(successes: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / (1 + z2 / n));
}

export function deletePrecisionRecall(rows: readonly LabeledPrediction[]): PrecisionRecall {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    const predictedDelete = r.predicted === "delete";
    const labeledDelete = r.label === "delete";
    if (predictedDelete && labeledDelete) tp++;
    else if (predictedDelete) fp++;
    else if (labeledDelete) fn++;
  }
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    precisionLower95: wilsonLowerBound(tp, tp + fp),
  };
}

export const PREDICTED_ORDER = ["delete", "archive", "keep", "unsure"] as const;
export const LABEL_ORDER = ["delete", "archive", "keep"] as const;
export type ConfusionMatrix = Record<SuggestedAction, Record<ActionKind, number>>;

export function confusionMatrix(rows: readonly LabeledPrediction[]): ConfusionMatrix {
  const empty = (): Record<ActionKind, number> => ({ delete: 0, archive: 0, keep: 0 });
  const m: ConfusionMatrix = { delete: empty(), archive: empty(), keep: empty(), unsure: empty() };
  for (const r of rows) m[r.predicted][r.label]++;
  return m;
}

export interface ProbabilityPoint {
  /** Predicted probability that the owner deletes, in [0, 1]. */
  p: number;
  positive: boolean;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface ReliabilityTable {
  bins: ReliabilityBin[];
  /** Expected calibration error: sum over bins of count/N * |meanPredicted - observedRate|. */
  ece: number | null;
  /** Mean squared error of p against the 0/1 outcome. */
  brier: number | null;
}

/** Equal-width bins on [0, 1]; p = 1 falls in the last bin. */
export function reliabilityTable(points: readonly ProbabilityPoint[], binCount = 10): ReliabilityTable {
  const sums = Array.from({ length: binCount }, () => ({ count: 0, p: 0, positives: 0 }));
  let brier = 0;
  for (const pt of points) {
    const p = Math.min(1, Math.max(0, pt.p));
    const index = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = sums[index];
    if (bin === undefined) continue;
    bin.count++;
    bin.p += p;
    if (pt.positive) bin.positives++;
    brier += (p - (pt.positive ? 1 : 0)) ** 2;
  }
  const n = points.length;
  let ece = 0;
  const bins = sums.map((s, i) => {
    const meanPredicted = s.count === 0 ? null : s.p / s.count;
    const observedRate = s.count === 0 ? null : s.positives / s.count;
    if (meanPredicted !== null && observedRate !== null)
      ece += (s.count / n) * Math.abs(meanPredicted - observedRate);
    return { lower: i / binCount, upper: (i + 1) / binCount, count: s.count, meanPredicted, observedRate };
  });
  return { bins, ece: n === 0 ? null : ece, brier: n === 0 ? null : brier / n };
}

export interface ThresholdPoint {
  tau: number;
  support: number;
  precision: number | null;
  recall: number | null;
}

export interface ThresholdSample {
  pDelete: number | null;
  margin: number | null;
  label: ActionKind;
}

/** Same rule as calibration (contracts 5.3): delete when pDelete >= tau and margin >= deleteMargin. */
export function thresholdSweep(
  samples: readonly ThresholdSample[],
  taus: readonly number[],
  deleteMargin: number,
): ThresholdPoint[] {
  const positives = samples.filter((s) => s.label === "delete").length;
  return taus.map((tau) => {
    const selected = samples.filter(
      (s) => s.pDelete !== null && s.margin !== null && s.pDelete >= tau && s.margin >= deleteMargin,
    );
    const hits = selected.filter((s) => s.label === "delete").length;
    return {
      tau,
      support: selected.length,
      precision: selected.length === 0 ? null : hits / selected.length,
      recall: positives === 0 ? null : hits / positives,
    };
  });
}

export interface ShufflePair {
  baseline: SuggestedAction;
  shuffled: SuggestedAction;
  baselineDelete: number;
  shuffledDelete: number;
}

export interface ShuffleRobustness {
  pairs: number;
  flips: number;
  flipRate: number | null;
  meanAbsDeltaDelete: number | null;
  maxAbsDeltaDelete: number | null;
}

export function shuffleRobustness(pairs: readonly ShufflePair[]): ShuffleRobustness {
  if (pairs.length === 0) {
    return { pairs: 0, flips: 0, flipRate: null, meanAbsDeltaDelete: null, maxAbsDeltaDelete: null };
  }
  let flips = 0;
  let sum = 0;
  let max = 0;
  for (const pair of pairs) {
    if (pair.baseline !== pair.shuffled) flips++;
    const delta = Math.abs(pair.baselineDelete - pair.shuffledDelete);
    sum += delta;
    max = Math.max(max, delta);
  }
  return {
    pairs: pairs.length,
    flips,
    flipRate: flips / pairs.length,
    meanAbsDeltaDelete: sum / pairs.length,
    maxAbsDeltaDelete: max,
  };
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? null;
}

/** Highest-probability action; ties resolve in the safe order keep, archive, unsure, delete. */
export function argmaxAction(dist: Readonly<Record<SuggestedAction, number>>): SuggestedAction {
  const order: SuggestedAction[] = ["keep", "archive", "unsure", "delete"];
  let best: SuggestedAction = "keep";
  for (const action of order) if (dist[action] > dist[best]) best = action;
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/eval exec vitest run test/metrics.test.ts`
Expected: PASS, `Tests  10 passed (10)`.

- [ ] **Step 5: Format, lint, commit**

Run: `pnpm exec prettier --write eval && pnpm lint`

```bash
git add eval/src/metrics.ts eval/test/metrics.test.ts
git commit -m "feat(eval): add precision, calibration and robustness metrics"
```

### Task 7: Eval pipeline over the real core

**Files:**

- Create: `eval/src/pipeline.ts`
- Test: `eval/test/pipeline.test.ts`

**Interfaces:**

- Consumes: from `@clearbox/core`: `DEFAULT_POLICY`, `DELETE_MARGIN`, `MIN_CONFIDENCE`, `DecisionError`, `FakeEngine`, `buildDecisionQuestions`, `buildDecisionState`, `decisionSeed`, `evaluateGuardrails`, `extractSignals`, `fnv1a32`, `fuse`, `mapWithConcurrency`, `selectPrior` and the types listed in "Interfaces consumed"; Task 5 `toMailMessage`, `threadIdFor`, `OWNER_ADDRESS`; Task 6 `argmaxAction`.
- Produces: `EVAL_ACCOUNT_ID = "acc_00000000000000e1"`, `MAX_ATTEMPTS = 3`, `Clock { now(): number; sleep(ms): Promise<void> }`, `class EvalAbortError`, `PreparedFixture`, `optionOrder(seed): string`, `alternateSeed(id, baseSeed): number`, `prepareFixture(fixture, now): PreparedFixture`, `createPacer(rpm, clock): () => Promise<void>`, `decideWithRetry(engine, input, pace, clock): Promise<DecisionResult>`, `EvalRow` (fields below), `EvalDeps { engine; clock; now; tauDelete; concurrency; rpm; shuffle; onProgress? }`, `evaluateFixture(prepared, deps, pace): Promise<EvalRow>`, `runEval(fixtures, deps): Promise<EvalRow[]>`.
- `EvalRow { id; source; category; label; ceiling; error: string | null; modelAction; modelDelete; suggestion; confidence; fusedDelete; margin; shuffledModelAction; shuffledModelDelete; shuffledSuggestion; latencyMs: number[]; inputTokens: number[]; responseModel }`.

Behavior: each fixture runs extractSignals (or uses stored signals), `evaluateGuardrails` with `DEFAULT_POLICY`, no prior, `buildDecisionState` with no past decisions, `decisionSeed(EVAL_ACCOUNT_ID, id)`, the engine, and `fuse`. The shuffle check repeats the call with the first derived seed whose option order differs (key `<id>#shuffle`). A `DecisionError` with `scope: "config"` aborts the run; retryable errors are retried up to 3 attempts (`retryAfterMs`, else 2 s times attempt), then recorded as a failed row with the production fallback suggestion `unsure`. Calls are paced to at most `rpm` starts per minute.

- [ ] **Step 1: Write the failing test**

Create `eval/test/pipeline.test.ts` with exactly this content:

```ts
import { fileURLToPath } from "node:url";
import { DecisionError, FakeEngine } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import { loadFixtures, type EvalFixture } from "../src/fixtures.ts";
import {
  EvalAbortError,
  createPacer,
  optionOrder,
  prepareFixture,
  runEval,
  type Clock,
  type EvalDeps,
} from "../src/pipeline.ts";

const NOW = 1_800_000_000_000;
const FIXTURES = loadFixtures(fileURLToPath(new URL("../fixtures/emails.jsonl", import.meta.url)));

function fixture(id: string): EvalFixture {
  const f = FIXTURES.find((x) => x.id === id);
  if (f === undefined) throw new Error(`missing ${id}`);
  return f;
}

function fakeClock(): Clock & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

function deps(over: Partial<EvalDeps> = {}): EvalDeps {
  return {
    engine: new FakeEngine(),
    clock: fakeClock(),
    now: NOW,
    tauDelete: 0.8,
    concurrency: 2,
    rpm: 1000,
    shuffle: true,
    ...over,
  };
}

describe("prepareFixture", () => {
  it("keeps every state within the 1,750 character budget", () => {
    for (const f of FIXTURES)
      expect(JSON.stringify(prepareFixture(f, NOW).state).length).toBeLessThanOrEqual(1750);
  });

  it("applies the production guardrails", () => {
    expect(prepareFixture(fixture("syn-023"), NOW).guard.ceiling).toBe("keep"); // owner replied
    expect(prepareFixture(fixture("syn-016"), NOW).guard.ceiling).toBe("archive"); // invoice with attachment
    expect(prepareFixture(fixture("syn-001"), NOW).guard.ceiling).toBe("delete"); // old promotion
  });

  it("uses a different option order for the shuffle check", () => {
    for (const f of FIXTURES) {
      const p = prepareFixture(f, NOW);
      expect(optionOrder(p.shuffleSeed)).not.toBe(optionOrder(p.seed));
    }
  });
});

describe("runEval with FakeEngine", () => {
  it("evaluates every fixture twice (baseline and shuffled) without errors", async () => {
    const engine = new FakeEngine();
    const rows = await runEval(FIXTURES, deps({ engine }));
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => r.error === null)).toBe(true);
    expect(engine.calls).toHaveLength(80);
    expect(engine.calls.filter((c) => c.key.endsWith("#shuffle"))).toHaveLength(40);
    expect(rows.map((r) => r.id)).toEqual(FIXTURES.map((f) => f.id));
  });

  it("is deterministic and never suggests deleting human mail", async () => {
    const a = await runEval(FIXTURES, deps());
    const b = await runEval(FIXTURES, deps());
    expect(a.map((r) => r.suggestion)).toEqual(b.map((r) => r.suggestion));
    expect(a.filter((r) => r.category === "human").every((r) => r.suggestion !== "delete")).toBe(true);
    // FakeEngine ignores option order, so the shuffle check finds no flips.
    expect(a.every((r) => r.shuffledModelAction === r.modelAction)).toBe(true);
  });

  it("aborts the run on a configuration error", async () => {
    const engine = new FakeEngine({
      overrides: new Map([
        [
          "syn-001",
          new DecisionError({
            kind: "auth",
            status: 401,
            retryable: false,
            scope: "config",
            retryAfterMs: null,
            requestId: null,
          }),
        ],
      ]),
    });
    await expect(runEval([fixture("syn-001")], deps({ engine }))).rejects.toBeInstanceOf(EvalAbortError);
  });

  it("retries transient errors, then records the failure as unsure", async () => {
    const clock = fakeClock();
    const engine = new FakeEngine({
      overrides: new Map([
        [
          "syn-001",
          new DecisionError({
            kind: "rate_limited",
            status: 429,
            retryable: true,
            scope: "item",
            retryAfterMs: 1500,
            requestId: null,
          }),
        ],
      ]),
    });
    const [r] = await runEval([fixture("syn-001")], deps({ engine, clock, shuffle: false, concurrency: 1 }));
    expect(r?.error).toBe("rate_limited");
    expect(r?.suggestion).toBe("unsure");
    expect(clock.sleeps).toEqual([1500, 1500]);
  });
});

describe("createPacer", () => {
  it("spaces concurrent call starts by 60000 / rpm", async () => {
    const sleeps: number[] = [];
    const frozen: Clock = {
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    const pace = createPacer(60, frozen);
    await Promise.all([pace(), pace(), pace()]);
    expect(sleeps).toEqual([1000, 2000]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/eval exec vitest run test/pipeline.test.ts`
Expected: FAIL, cannot load `../src/pipeline.ts`.

- [ ] **Step 3: Implement**

Create `eval/src/pipeline.ts` with exactly this content:

```ts
import {
  DEFAULT_POLICY,
  DELETE_MARGIN,
  DecisionError,
  MIN_CONFIDENCE,
  buildDecisionQuestions,
  buildDecisionState,
  decisionSeed,
  evaluateGuardrails,
  extractSignals,
  fnv1a32,
  fuse,
  mapWithConcurrency,
  selectPrior,
  type ActionKind,
  type Ceiling,
  type DecisionEngine,
  type DecisionInput,
  type DecisionResult,
  type DecisionState,
  type GuardrailResult,
  type Prior,
  type Signals,
  type SuggestedAction,
  type Thresholds,
} from "@clearbox/core";
import {
  OWNER_ADDRESS,
  threadIdFor,
  toMailMessage,
  type EvalFixture,
  type FixtureCategory,
} from "./fixtures.ts";
import { argmaxAction } from "./metrics.ts";

/** Synthetic account id used only to derive option-order seeds. */
export const EVAL_ACCOUNT_ID = "acc_00000000000000e1";
export const MAX_ATTEMPTS = 3;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class EvalAbortError extends Error {
  override name = "EvalAbortError";
}

export interface PreparedFixture {
  fixture: EvalFixture;
  signals: Signals;
  guard: GuardrailResult;
  prior: Prior;
  state: DecisionState;
  seed: number;
  shuffleSeed: number;
}

export function optionOrder(seed: number): string {
  return Object.keys(buildDecisionQuestions(seed).action.criteria).join(",");
}

/** First seed derived from the id whose action option order differs from the baseline order. */
export function alternateSeed(id: string, baseSeed: number): number {
  const baseline = optionOrder(baseSeed);
  const first = fnv1a32(`${id}:shuffle:1`);
  for (let k = 1; k <= 32; k++) {
    const candidate = fnv1a32(`${id}:shuffle:${k}`);
    if (optionOrder(candidate) !== baseline) return candidate;
  }
  return first;
}

/** Runs the same deterministic steps as a tick, without priors or past decisions. */
export function prepareFixture(fixture: EvalFixture, now: number): PreparedFixture {
  const msg = toMailMessage(fixture, now);
  const input = fixture.input;
  const signals =
    input.kind === "signals"
      ? input.signals
      : extractSignals(
          msg,
          { ...fixture.history, senderPrior: null, domainPrior: null },
          {
            now,
            ownerAddresses: [OWNER_ADDRESS],
            repliedThreadIds: new Set(input.ownerReplied ? [threadIdFor(fixture)] : []),
          },
        );
  const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, DEFAULT_POLICY);
  const prior = selectPrior(null, null, signals.senderAddress, signals.senderDomain);
  const state = buildDecisionState({ msg, signals, pastDecisions: [] });
  const seed = decisionSeed(EVAL_ACCOUNT_ID, fixture.id);
  return { fixture, signals, guard, prior, state, seed, shuffleSeed: alternateSeed(fixture.id, seed) };
}

/** Spaces call starts at least 60000 / rpm ms apart, across concurrent workers. */
export function createPacer(rpm: number, clock: Clock): () => Promise<void> {
  const interval = 60_000 / rpm;
  let next = 0;
  return async () => {
    const now = clock.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    if (slot > now) await clock.sleep(slot - now);
  };
}

/** Eval-only retries for transient errors; configuration errors abort the whole run. */
export async function decideWithRetry(
  engine: DecisionEngine,
  input: DecisionInput,
  pace: () => Promise<void>,
  clock: Clock,
): Promise<DecisionResult> {
  for (let attempt = 1; ; attempt++) {
    await pace();
    try {
      return await engine.decide(input);
    } catch (error) {
      if (error instanceof DecisionError && error.scope === "config") {
        throw new EvalAbortError(
          `Decision-1 configuration error (${error.kind}, HTTP ${error.status ?? "n/a"}). Check the AZURE_DECISION_* variables.`,
        );
      }
      if (!(error instanceof DecisionError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      await clock.sleep(error.retryAfterMs ?? 2_000 * attempt);
    }
  }
}

export interface EvalRow {
  id: string;
  source: EvalFixture["source"];
  category: FixtureCategory;
  label: ActionKind;
  ceiling: Ceiling;
  /** DecisionError kind, "unknown", or null on success. */
  error: string | null;
  modelAction: SuggestedAction | null;
  modelDelete: number | null;
  /** Fused suggestion; "unsure" when the model failed, as in production. */
  suggestion: SuggestedAction;
  confidence: number;
  fusedDelete: number | null;
  margin: number | null;
  shuffledModelAction: SuggestedAction | null;
  shuffledModelDelete: number | null;
  shuffledSuggestion: SuggestedAction | null;
  latencyMs: number[];
  inputTokens: number[];
  responseModel: string | null;
}

export interface EvalDeps {
  engine: DecisionEngine;
  clock: Clock;
  /** Wall-clock epoch ms used to compute message ages. */
  now: number;
  tauDelete: number;
  concurrency: number;
  rpm: number;
  shuffle: boolean;
  onProgress?: (done: number, total: number) => void;
}

function errorKind(error: unknown): string {
  if (error instanceof EvalAbortError) throw error;
  return error instanceof DecisionError ? error.kind : "unknown";
}

export async function evaluateFixture(
  prepared: PreparedFixture,
  deps: EvalDeps,
  pace: () => Promise<void>,
): Promise<EvalRow> {
  const { fixture, signals, guard, prior, state } = prepared;
  const thresholds: Thresholds = {
    tauDelete: deps.tauDelete,
    deleteMargin: DELETE_MARGIN,
    minConfidence: MIN_CONFIDENCE,
  };
  const latencyMs: number[] = [];
  const inputTokens: number[] = [];
  const record = (r: DecisionResult): void => {
    latencyMs.push(r.latencyMs);
    inputTokens.push(r.inputTokens);
  };

  let model: DecisionResult | null = null;
  let error: string | null = null;
  try {
    model = await decideWithRetry(
      deps.engine,
      { key: fixture.id, state, seed: prepared.seed },
      pace,
      deps.clock,
    );
    record(model);
  } catch (e) {
    error = errorKind(e);
  }
  const suggestion = fuse({ model, prior, guard, signals, thresholds });

  let shuffled: DecisionResult | null = null;
  if (deps.shuffle && model !== null) {
    try {
      shuffled = await decideWithRetry(
        deps.engine,
        { key: `${fixture.id}#shuffle`, state, seed: prepared.shuffleSeed },
        pace,
        deps.clock,
      );
      record(shuffled);
    } catch (e) {
      errorKind(e);
    }
  }

  return {
    id: fixture.id,
    source: fixture.source,
    category: fixture.category,
    label: fixture.label,
    ceiling: guard.ceiling,
    error,
    modelAction: model === null ? null : argmaxAction(model.action),
    modelDelete: model?.action.delete ?? null,
    suggestion: suggestion.action,
    confidence: suggestion.confidence,
    fusedDelete: suggestion.distribution?.delete ?? null,
    margin: suggestion.margin,
    shuffledModelAction: shuffled === null ? null : argmaxAction(shuffled.action),
    shuffledModelDelete: shuffled?.action.delete ?? null,
    shuffledSuggestion:
      shuffled === null ? null : fuse({ model: shuffled, prior, guard, signals, thresholds }).action,
    latencyMs,
    inputTokens,
    responseModel: model?.responseModel ?? null,
  };
}

export async function runEval(fixtures: readonly EvalFixture[], deps: EvalDeps): Promise<EvalRow[]> {
  const prepared = fixtures.map((f) => prepareFixture(f, deps.now));
  const pace = createPacer(deps.rpm, deps.clock);
  let done = 0;
  return mapWithConcurrency(prepared, deps.concurrency, async (p) => {
    const row = await evaluateFixture(p, deps, pace);
    done++;
    deps.onProgress?.(done, prepared.length);
    return row;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/eval exec vitest run test/pipeline.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Typecheck, format, lint, commit**

Run: `pnpm --filter @clearbox/eval typecheck && pnpm exec prettier --write eval && pnpm lint`
Expected: no errors.

```bash
git add eval/src/pipeline.ts eval/test/pipeline.test.ts
git commit -m "feat(eval): run the core pipeline with pacing, retries and shuffle check"
```

### Task 8: Eval report and the pnpm eval CLI

**Files:**

- Create: `eval/src/report.ts`, `eval/src/io.ts`, `eval/src/run.ts`
- Test: `eval/test/report.test.ts`, `eval/test/run.test.ts`

**Interfaces:**

- Consumes: Task 6 metrics, Task 7 `EvalRow`, `runEval`, `EvalAbortError`; Task 5 `FIXTURE_CATEGORIES`, `loadFixtures`; from `@clearbox/core`: `MaiDecisionEngine`, `TAU_DELETE_DEFAULT`, `DELETE_MARGIN`.
- Produces: `TARGET_DELETE_PRECISION = 0.98`, `INPUT_PRICE_PER_MILLION_USD = 0.042`, `SWEEP_TAUS`, `CategoryStats`, `EvalSummary`, `summarize(rows): EvalSummary`, `ReportMeta`, `renderReport(summary, meta): string`; `REPO_ROOT`, `EVAL_ROOT`, `PRIVATE_DIR`, `DEFAULT_FIXTURES`, `LOCAL_D1_ID`, `isMain`, `assertGitIgnored(path)`, `readD1Id(env?)`; `DecisionEnv`, `readDecisionEnv(env)`, `RunOptions`, `parseRunArgs(argv, stamp)`.
- CLI: `pnpm eval [--fixtures <path>] [--out <path>] [--tau 0.8] [--concurrency 2] [--rpm 240] [--no-shuffle] [--limit N]`. Paths are relative to `eval/` (pnpm runs the script there). Exit code 0, 2 when any harmful delete (suggested delete, labeled keep) occurred, 3 on a configuration abort, 1 on other errors. The report contains ids, categories and numbers only.

- [ ] **Step 1: Write the failing tests**

Create `eval/test/report.test.ts` with exactly this content:

```ts
import { describe, expect, it } from "vitest";
import type { EvalRow } from "../src/pipeline.ts";
import { INPUT_PRICE_PER_MILLION_USD, renderReport, summarize } from "../src/report.ts";

function row(over: Partial<EvalRow>): EvalRow {
  return {
    id: "syn-001",
    source: "synthetic",
    category: "promotion",
    label: "delete",
    ceiling: "delete",
    error: null,
    modelAction: "delete",
    modelDelete: 0.95,
    suggestion: "delete",
    confidence: 0.95,
    fusedDelete: 0.95,
    margin: 0.9,
    shuffledModelAction: "delete",
    shuffledModelDelete: 0.94,
    shuffledSuggestion: "delete",
    latencyMs: [300, 320],
    inputTokens: [600, 600],
    responseModel: "microsoft-decision-1",
    ...over,
  };
}

const ROWS: EvalRow[] = [
  row({ id: "syn-001" }),
  row({ id: "syn-002", label: "keep", category: "human", suggestion: "delete" }),
  row({
    id: "syn-003",
    label: "archive",
    category: "receipt",
    suggestion: "archive",
    modelAction: "archive",
    fusedDelete: 0.05,
    modelDelete: 0.05,
    margin: -0.8,
    ceiling: "archive",
    shuffledModelAction: "archive",
    shuffledModelDelete: 0.06,
    shuffledSuggestion: "archive",
  }),
  row({
    id: "syn-004",
    label: "keep",
    category: "human",
    error: "rate_limited",
    modelAction: null,
    modelDelete: null,
    suggestion: "unsure",
    confidence: 0,
    fusedDelete: null,
    margin: null,
    shuffledModelAction: null,
    shuffledModelDelete: null,
    shuffledSuggestion: null,
    latencyMs: [],
    inputTokens: [],
    responseModel: null,
  }),
];

describe("summarize", () => {
  const s = summarize(ROWS);

  it("computes headline metrics", () => {
    expect(s.total).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.errors).toEqual({ rate_limited: 1 });
    expect(s.labels).toEqual({ delete: 1, archive: 1, keep: 2 });
    expect(s.fused.precision).toBe(0.5);
    expect(s.fused.recall).toBe(1);
    expect(s.harmfulDeletes).toEqual([{ id: "syn-002", category: "human" }]);
    expect(s.unsureRate).toBe(0.25);
    expect(s.ceilingCapped).toBe(1);
  });

  it("aggregates latency, tokens and cost", () => {
    expect(s.calls).toBe(6);
    expect(s.latencyP50Ms).toBe(300);
    expect(s.latencyP95Ms).toBe(320);
    expect(s.tokensTotal).toBe(3600);
    expect(s.estimatedCostUsd).toBeCloseTo((3600 / 1_000_000) * INPUT_PRICE_PER_MILLION_USD, 12);
    expect(s.responseModels).toEqual(["microsoft-decision-1"]);
  });

  it("reports shuffle robustness over successful rows only", () => {
    expect(s.shuffleModel.pairs).toBe(3);
    expect(s.shuffleModel.flips).toBe(0);
  });

  it("builds per-category stats", () => {
    const human = s.perCategory.find((c) => c.category === "human");
    expect(human).toEqual({ category: "human", n: 2, accuracy: 0, deleteSuggested: 1, deletePrecision: 0 });
  });
});

describe("renderReport", () => {
  const text = renderReport(summarize(ROWS), {
    generatedAt: "2026-10-15T00:00:00.000Z",
    deployment: "decision-1",
    fixtures: "emails.jsonl",
    tauDelete: 0.8,
    shuffle: true,
    concurrency: 2,
    rpm: 240,
  });

  it("contains every section", () => {
    for (const heading of [
      "# Clearbox eval report",
      "## Headline",
      "## Confusion matrix",
      "## Per category",
      "## Reliability (calibration)",
      "## Threshold sweep",
      "## Option-order shuffle robustness",
      "## Latency and tokens",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("BELOW TARGET");
    expect(text).toContain("syn-002 (human)");
  });

  it("never contains an em dash", () => {
    expect(text.includes("\u2014")).toBe(false);
  });
});
```

Create `eval/test/run.test.ts` with exactly this content:

```ts
import { describe, expect, it } from "vitest";
import { parseRunArgs, readDecisionEnv } from "../src/run.ts";

describe("readDecisionEnv", () => {
  const good = {
    AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com/",
    AZURE_DECISION_KEY: "k".repeat(32),
    AZURE_DECISION_DEPLOYMENT: "decision-1",
  };

  it("reads and normalizes the three variables", () => {
    expect(readDecisionEnv(good)).toEqual({
      endpoint: "https://acct.services.ai.azure.com",
      apiKey: "k".repeat(32),
      deployment: "decision-1",
    });
  });

  it("names missing variables without echoing values", () => {
    expect(() => readDecisionEnv({ AZURE_DECISION_KEY: "secret-value" })).toThrow(
      "Missing environment variables: AZURE_DECISION_ENDPOINT, AZURE_DECISION_DEPLOYMENT",
    );
  });

  it("rejects project URLs and the reserved model name", () => {
    expect(() =>
      readDecisionEnv({
        ...good,
        AZURE_DECISION_ENDPOINT: "https://acct.services.ai.azure.com/api/projects/p",
      }),
    ).toThrow();
    expect(() => readDecisionEnv({ ...good, AZURE_DECISION_DEPLOYMENT: "Microsoft-Decision-1" })).toThrow(
      /deployment name/,
    );
  });
});

describe("parseRunArgs", () => {
  it("defaults to the committed fixtures and a git-ignored report path", () => {
    const o = parseRunArgs([], "stamp");
    expect(o.fixtures).toMatch(/eval[\\/]fixtures[\\/]emails\.jsonl$/);
    expect(o.out).toMatch(/eval[\\/]private[\\/]reports[\\/]eval-stamp\.md$/);
    expect(o).toMatchObject({ tauDelete: 0.8, concurrency: 2, rpm: 240, shuffle: true, limit: null });
  });

  it("parses overrides and validates ranges", () => {
    expect(parseRunArgs(["--tau", "0.9", "--no-shuffle", "--limit", "5"], "s")).toMatchObject({
      tauDelete: 0.9,
      shuffle: false,
      limit: 5,
    });
    expect(() => parseRunArgs(["--concurrency", "50"], "s")).toThrow(/--concurrency/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @clearbox/eval exec vitest run test/report.test.ts test/run.test.ts`
Expected: FAIL, cannot load `../src/report.ts` and `../src/run.ts`.

- [ ] **Step 3: Implement the report**

Create `eval/src/report.ts` with exactly this content:

```ts
import { DELETE_MARGIN, type ActionKind } from "@clearbox/core";
import { FIXTURE_CATEGORIES, type FixtureCategory } from "./fixtures.ts";
import {
  LABEL_ORDER,
  PREDICTED_ORDER,
  confusionMatrix,
  deletePrecisionRecall,
  percentile,
  reliabilityTable,
  shuffleRobustness,
  thresholdSweep,
  type ConfusionMatrix,
  type PrecisionRecall,
  type ReliabilityTable,
  type ShufflePair,
  type ShuffleRobustness,
  type ThresholdPoint,
} from "./metrics.ts";
import type { EvalRow } from "./pipeline.ts";

/** Product target (PRODUCT.md): delete precision at or above 98%. */
export const TARGET_DELETE_PRECISION = 0.98;
/** USD per 1M input tokens (output is free). */
export const INPUT_PRICE_PER_MILLION_USD = 0.042;
export const SWEEP_TAUS = [0.8, 0.85, 0.9, 0.95, 0.99] as const;

export interface CategoryStats {
  category: FixtureCategory;
  n: number;
  accuracy: number | null;
  deleteSuggested: number;
  deletePrecision: number | null;
}

export interface EvalSummary {
  total: number;
  failed: number;
  errors: Record<string, number>;
  labels: Record<ActionKind, number>;
  fused: PrecisionRecall;
  model: PrecisionRecall;
  confusion: ConfusionMatrix;
  harmfulDeletes: { id: string; category: FixtureCategory }[];
  unsureRate: number | null;
  ceilingCapped: number;
  reliabilityFused: ReliabilityTable;
  reliabilityModel: ReliabilityTable;
  sweep: ThresholdPoint[];
  shuffleModel: ShuffleRobustness;
  shuffleFused: ShuffleRobustness;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  calls: number;
  tokensTotal: number;
  tokensMean: number | null;
  tokensMax: number | null;
  estimatedCostUsd: number;
  perCategory: CategoryStats[];
  responseModels: string[];
}

export function summarize(rows: readonly EvalRow[]): EvalSummary {
  const ok = rows.filter((r) => r.error === null);
  const errors: Record<string, number> = {};
  for (const r of rows) if (r.error !== null) errors[r.error] = (errors[r.error] ?? 0) + 1;
  const labels: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
  for (const r of rows) labels[r.label]++;

  const shufflePairs = (pick: "model" | "fused"): ShufflePair[] =>
    ok.flatMap((r) => {
      const baseline = pick === "model" ? r.modelAction : r.suggestion;
      const shuffled = pick === "model" ? r.shuffledModelAction : r.shuffledSuggestion;
      if (baseline === null || shuffled === null || r.modelDelete === null || r.shuffledModelDelete === null)
        return [];
      return [{ baseline, shuffled, baselineDelete: r.modelDelete, shuffledDelete: r.shuffledModelDelete }];
    });

  const latencies = rows.flatMap((r) => r.latencyMs);
  const tokens = rows.flatMap((r) => r.inputTokens);
  const tokensTotal = tokens.reduce((s, t) => s + t, 0);

  const perCategory = FIXTURE_CATEGORIES.flatMap((category): CategoryStats[] => {
    const inCat = rows.filter((r) => r.category === category);
    if (inCat.length === 0) return [];
    const suggestedDelete = inCat.filter((r) => r.suggestion === "delete");
    return [
      {
        category,
        n: inCat.length,
        accuracy: inCat.filter((r) => r.suggestion === r.label).length / inCat.length,
        deleteSuggested: suggestedDelete.length,
        deletePrecision:
          suggestedDelete.length === 0
            ? null
            : suggestedDelete.filter((r) => r.label === "delete").length / suggestedDelete.length,
      },
    ];
  });

  return {
    total: rows.length,
    failed: rows.length - ok.length,
    errors,
    labels,
    fused: deletePrecisionRecall(rows.map((r) => ({ predicted: r.suggestion, label: r.label }))),
    model: deletePrecisionRecall(
      ok.flatMap((r) => (r.modelAction === null ? [] : [{ predicted: r.modelAction, label: r.label }])),
    ),
    confusion: confusionMatrix(rows.map((r) => ({ predicted: r.suggestion, label: r.label }))),
    harmfulDeletes: rows
      .filter((r) => r.suggestion === "delete" && r.label === "keep")
      .map((r) => ({ id: r.id, category: r.category })),
    unsureRate: rows.length === 0 ? null : rows.filter((r) => r.suggestion === "unsure").length / rows.length,
    ceilingCapped: rows.filter((r) => r.ceiling !== "delete").length,
    reliabilityFused: reliabilityTable(
      ok.flatMap((r) =>
        r.fusedDelete === null ? [] : [{ p: r.fusedDelete, positive: r.label === "delete" }],
      ),
    ),
    reliabilityModel: reliabilityTable(
      ok.flatMap((r) =>
        r.modelDelete === null ? [] : [{ p: r.modelDelete, positive: r.label === "delete" }],
      ),
    ),
    sweep: thresholdSweep(
      rows.map((r) => ({ pDelete: r.fusedDelete, margin: r.margin, label: r.label })),
      SWEEP_TAUS,
      DELETE_MARGIN,
    ),
    shuffleModel: shuffleRobustness(shufflePairs("model")),
    shuffleFused: shuffleRobustness(shufflePairs("fused")),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    calls: latencies.length,
    tokensTotal,
    tokensMean: tokens.length === 0 ? null : tokensTotal / tokens.length,
    tokensMax: tokens.length === 0 ? null : Math.max(...tokens),
    estimatedCostUsd: (tokensTotal / 1_000_000) * INPUT_PRICE_PER_MILLION_USD,
    perCategory,
    responseModels: [...new Set(ok.flatMap((r) => (r.responseModel === null ? [] : [r.responseModel])))],
  };
}

export interface ReportMeta {
  generatedAt: string;
  deployment: string;
  fixtures: string;
  tauDelete: number;
  shuffle: boolean;
  concurrency: number;
  rpm: number;
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, digits = 3): string => (v === null ? "n/a" : v.toFixed(digits));
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;

function reliabilitySection(title: string, table: ReliabilityTable): string[] {
  return [
    `### ${title}`,
    "",
    row(["P(delete) bucket", "Count", "Mean predicted", "Observed delete rate"]),
    row(["---", "---:", "---:", "---:"]),
    ...table.bins.map((b) =>
      row([
        `${b.lower.toFixed(1)} to ${b.upper.toFixed(1)}`,
        b.count,
        num(b.meanPredicted),
        num(b.observedRate),
      ]),
    ),
    "",
    `ECE ${num(table.ece)}, Brier ${num(table.brier)}.`,
    "",
  ];
}

/** Markdown report. Contains ids, categories and numbers only: never subjects, snippets or addresses. */
export function renderReport(summary: EvalSummary, meta: ReportMeta): string {
  const s = summary;
  const verdict =
    s.fused.precision === null
      ? "no delete suggestions"
      : s.fused.precision >= TARGET_DELETE_PRECISION
        ? "meets target"
        : "BELOW TARGET";
  const lines: string[] = [
    "# Clearbox eval report",
    "",
    `- Generated: ${meta.generatedAt}`,
    `- Fixtures: ${meta.fixtures} (${s.total}; delete ${s.labels.delete}, archive ${s.labels.archive}, keep ${s.labels.keep})`,
    `- Deployment: ${meta.deployment}; response model: ${s.responseModels.join(", ") || "n/a"}`,
    `- tau_delete ${meta.tauDelete}, delete margin ${DELETE_MARGIN}, no priors, no past decisions`,
    `- Concurrency ${meta.concurrency}, pacing ${meta.rpm} requests per minute, shuffle check ${meta.shuffle ? "on" : "off"}`,
    `- Model failures: ${s.failed}${
      Object.keys(s.errors).length > 0
        ? ` (${Object.entries(s.errors)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})`
        : ""
    }`,
    "",
    "## Headline",
    "",
    row(["Metric", "Fused suggestion", "Model argmax only"]),
    row(["---", "---:", "---:"]),
    row(["Delete precision", pct(s.fused.precision), pct(s.model.precision)]),
    row(["Delete precision, 95% lower bound", pct(s.fused.precisionLower95), pct(s.model.precisionLower95)]),
    row(["Delete recall", pct(s.fused.recall), pct(s.model.recall)]),
    row([
      "Delete suggestions (TP + FP)",
      s.fused.truePositives + s.fused.falsePositives,
      s.model.truePositives + s.model.falsePositives,
    ]),
    "",
    `Target delete precision ${pct(TARGET_DELETE_PRECISION)}: **${verdict}**. Unsure rate ${pct(s.unsureRate)}. Guardrail ceiling below delete on ${s.ceilingCapped} of ${s.total}.`,
    "",
    `Harmful deletes (suggested delete, labeled keep): ${s.harmfulDeletes.length === 0 ? "none" : s.harmfulDeletes.map((h) => `${h.id} (${h.category})`).join(", ")}`,
    "",
    "## Confusion matrix (rows: suggestion, columns: label)",
    "",
    row(["", ...LABEL_ORDER]),
    row(["---", ...LABEL_ORDER.map(() => "---:")]),
    ...PREDICTED_ORDER.map((p) => row([p, ...LABEL_ORDER.map((l) => s.confusion[p][l])])),
    "",
    "## Per category",
    "",
    row(["Category", "N", "Accuracy", "Delete suggested", "Delete precision"]),
    row(["---", "---:", "---:", "---:", "---:"]),
    ...s.perCategory.map((c) =>
      row([c.category, c.n, pct(c.accuracy), c.deleteSuggested, pct(c.deletePrecision)]),
    ),
    "",
    "## Reliability (calibration)",
    "",
    ...reliabilitySection("Fused P(delete), after prior, flags and ceiling", s.reliabilityFused),
    ...reliabilitySection("Raw model P(delete)", s.reliabilityModel),
    "## Threshold sweep (fused P(delete) >= tau and margin >= delete margin)",
    "",
    row(["tau", "Support", "Precision", "Recall"]),
    row(["---:", "---:", "---:", "---:"]),
    ...s.sweep.map((p) => row([p.tau.toFixed(2), p.support, pct(p.precision), pct(p.recall)])),
    "",
    "## Option-order shuffle robustness",
    "",
    row(["Level", "Pairs", "Flips", "Flip rate", "Mean abs delta P(delete)", "Max abs delta P(delete)"]),
    row(["---", "---:", "---:", "---:", "---:", "---:"]),
    ...(
      [
        ["Model argmax", s.shuffleModel],
        ["Fused suggestion", s.shuffleFused],
      ] as const
    ).map(([name, r]) =>
      row([name, r.pairs, r.flips, pct(r.flipRate), num(r.meanAbsDeltaDelete), num(r.maxAbsDeltaDelete)]),
    ),
    "",
    "## Latency and tokens",
    "",
    `- Calls: ${s.calls}; latency p50 ${num(s.latencyP50Ms, 0)} ms, p95 ${num(s.latencyP95Ms, 0)} ms`,
    `- Input tokens: total ${s.tokensTotal}, mean ${num(s.tokensMean, 1)}, max ${s.tokensMax ?? "n/a"}`,
    `- Estimated cost: $${s.estimatedCostUsd.toFixed(6)} at $${INPUT_PRICE_PER_MILLION_USD} per 1M input tokens`,
    "",
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: Implement the IO helpers and the CLI**

Create `eval/src/io.ts` with exactly this content:

```ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root (eval/src/io.ts -> ../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EVAL_ROOT = join(REPO_ROOT, "eval");
/** Git-ignored directory for owner data and reports. */
export const PRIVATE_DIR = join(EVAL_ROOT, "private");
export const DEFAULT_FIXTURES = join(EVAL_ROOT, "fixtures", "emails.jsonl");
export const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";

export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/** Throws unless git reports `path` as ignored. Fails closed when git is unavailable. */
export function assertGitIgnored(path: string): void {
  const rel = relative(REPO_ROOT, resolve(path));
  const result = spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO_ROOT });
  if (result.status !== 0) {
    throw new Error(`${rel} is not git-ignored. Owner data may only be written under eval/private/.`);
  }
}

/** Remote D1 id: CLEARBOX_D1_ID, else app/clearbox.local.json (written by pnpm setup:cf). */
export function readD1Id(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLEARBOX_D1_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const file = join(REPO_ROOT, "app", "clearbox.local.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { d1DatabaseId?: unknown };
    if (typeof parsed.d1DatabaseId === "string") return parsed.d1DatabaseId;
  }
  throw new Error("No D1 database id. Run pnpm setup:cf or set CLEARBOX_D1_ID.");
}
```

Create `eval/src/run.ts` with exactly this content:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MaiDecisionEngine, TAU_DELETE_DEFAULT } from "@clearbox/core";
import { loadFixtures } from "./fixtures.ts";
import { DEFAULT_FIXTURES, PRIVATE_DIR, assertGitIgnored, isMain } from "./io.ts";
import { EvalAbortError, runEval } from "./pipeline.ts";
import { renderReport, summarize } from "./report.ts";

export interface DecisionEnv {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

/** Reads AZURE_DECISION_* from the process environment only (never from files in the repo). */
export function readDecisionEnv(env: NodeJS.ProcessEnv): DecisionEnv {
  const endpoint = (env.AZURE_DECISION_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.AZURE_DECISION_KEY ?? "").trim();
  const deployment = (env.AZURE_DECISION_DEPLOYMENT ?? "").trim();
  const missing = [
    endpoint === "" ? "AZURE_DECISION_ENDPOINT" : null,
    apiKey === "" ? "AZURE_DECISION_KEY" : null,
    deployment === "" ? "AZURE_DECISION_DEPLOYMENT" : null,
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (!/^https:\/\/[a-z0-9-]+\.services\.ai\.azure\.com$/i.test(endpoint)) {
    throw new Error("AZURE_DECISION_ENDPOINT must be https://<foundry-account>.services.ai.azure.com");
  }
  if (deployment.toLowerCase() === "microsoft-decision-1") {
    throw new Error(
      "AZURE_DECISION_DEPLOYMENT is the deployment name (for example decision-1), not the model name.",
    );
  }
  return { endpoint, apiKey, deployment };
}

export interface RunOptions {
  fixtures: string;
  out: string;
  tauDelete: number;
  concurrency: number;
  rpm: number;
  shuffle: boolean;
  limit: number | null;
}

export function parseRunArgs(argv: readonly string[], stamp: string): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      fixtures: { type: "string", default: DEFAULT_FIXTURES },
      out: { type: "string", default: join(PRIVATE_DIR, "reports", `eval-${stamp}.md`) },
      tau: { type: "string", default: String(TAU_DELETE_DEFAULT) },
      concurrency: { type: "string", default: "2" },
      rpm: { type: "string", default: "240" },
      "no-shuffle": { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const number = (name: string, raw: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max)
      throw new Error(`--${name} must be between ${min} and ${max}`);
    return n;
  };
  return {
    fixtures: resolve(values.fixtures),
    out: resolve(values.out),
    tauDelete: number("tau", values.tau, 0.5, 0.99),
    concurrency: Math.floor(number("concurrency", values.concurrency, 1, 8)),
    rpm: number("rpm", values.rpm, 1, 1000),
    shuffle: !values["no-shuffle"],
    limit: values.limit === undefined ? null : Math.floor(number("limit", values.limit, 1, 100_000)),
  };
}

async function main(): Promise<number> {
  const generatedAt = new Date().toISOString();
  const options = parseRunArgs(process.argv.slice(2), generatedAt.replace(/[:.]/g, "-"));
  const decision = readDecisionEnv(process.env);
  const all = loadFixtures(options.fixtures);
  const fixtures = options.limit === null ? all : all.slice(0, options.limit);
  if (fixtures.some((f) => f.source === "owner")) assertGitIgnored(options.out);

  const engine = new MaiDecisionEngine({
    endpoint: decision.endpoint,
    deployment: decision.deployment,
    apiKey: decision.apiKey,
    fetch: (input, init) => fetch(input, init),
    now: () => performance.now(),
  });
  console.log(`Evaluating ${fixtures.length} fixtures against deployment ${decision.deployment}...`);
  const rows = await runEval(fixtures, {
    engine,
    clock: { now: () => performance.now(), sleep: (ms) => sleep(ms) },
    now: Date.now(),
    tauDelete: options.tauDelete,
    concurrency: options.concurrency,
    rpm: options.rpm,
    shuffle: options.shuffle,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });
  const summary = summarize(rows);
  const report = renderReport(summary, {
    generatedAt,
    deployment: decision.deployment,
    fixtures: basename(options.fixtures),
    tauDelete: options.tauDelete,
    shuffle: options.shuffle,
    concurrency: options.concurrency,
    rpm: options.rpm,
  });
  mkdirSync(resolve(options.out, ".."), { recursive: true });
  writeFileSync(options.out, report);
  console.log("");
  console.log(
    `Delete precision ${summary.fused.precision === null ? "n/a" : (summary.fused.precision * 100).toFixed(1) + "%"}, ` +
      `recall ${summary.fused.recall === null ? "n/a" : (summary.fused.recall * 100).toFixed(1) + "%"}, ` +
      `harmful deletes ${summary.harmfulDeletes.length}, model failures ${summary.failed}, ` +
      `shuffle flip rate ${summary.shuffleModel.flipRate === null ? "n/a" : (summary.shuffleModel.flipRate * 100).toFixed(1) + "%"}.`,
  );
  console.log(`Report: ${options.out}`);
  return summary.harmfulDeletes.length > 0 ? 2 : 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`eval: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof EvalAbortError ? 3 : 1;
  }
}
```

- [ ] **Step 5: Run the eval tests to verify they pass**

Run: `pnpm --filter @clearbox/eval exec vitest run test/report.test.ts test/run.test.ts`
Expected: PASS, `Tests  11 passed (11)` (6 report, 5 run).

- [ ] **Step 6: Typecheck and check the missing-environment path**

Run: `pnpm --filter @clearbox/eval typecheck && env -u AZURE_DECISION_KEY -u AZURE_DECISION_ENDPOINT -u AZURE_DECISION_DEPLOYMENT pnpm eval; echo "exit $?"`
Expected: no tsc output; `eval: Missing environment variables: AZURE_DECISION_ENDPOINT, AZURE_DECISION_KEY, AZURE_DECISION_DEPLOYMENT` and a non-zero exit.

- [ ] **Step 7: Format, lint, commit**

Run: `pnpm exec prettier --write eval && pnpm lint`

```bash
git add eval/src/report.ts eval/src/io.ts eval/src/run.ts eval/test/report.test.ts eval/test/run.test.ts
git commit -m "feat(eval): add markdown report and pnpm eval CLI"
```

### Task 9: Owner-label export from D1

**Files:**

- Create: `eval/src/export-labels.ts`
- Test: `eval/test/export-labels.test.ts`

**Interfaces:**

- Consumes: Task 5 `EvalFixtureSchema`, `SignalsSchema`; Task 8 `io.ts`; plan 03/04 tables `labels` (`id`, `owner_action`, `subject_trunc`, `message_id`, `account_id`) and `messages` (`subject`, `snippet`, `signals_json`).
- Produces: `DEFAULT_LIMIT = 500`, `MAX_LIMIT = 5000`, `exportSql(limit)`, `parseD1Rows(json)` (accepts `cf d1 query` objects and `cf d1 raw` columns/rows), `inferCategory(subject, signals)`, `ConvertResult`, `rowsToFixtures(rows)`. CLI: `pnpm --filter @clearbox/eval export-labels [--out <path>] [--limit 500] [--local]`, default output `eval/private/owner-labels.jsonl` (mode 600). Refuses any output path that git does not ignore. Prints counts only.

- [ ] **Step 1: Write the failing test**

Create `eval/test/export-labels.test.ts` with exactly this content:

```ts
import { describe, expect, it } from "vitest";
import { exportSql, inferCategory, parseD1Rows, rowsToFixtures } from "../src/export-labels.ts";

const SIGNALS = {
  senderAddress: "deals@shop.example.com",
  senderDomain: "example.com",
  senderName: "Shop",
  senderKnown: true,
  ownerReplied: false,
  isCorrespondent: false,
  senderSeenCount: 12,
  senderOpenRate: 0,
  ownerDeleteRate: 1,
  ownerDecisions: 4,
  hasListUnsubscribe: true,
  oneClickUnsubscribe: true,
  hasListId: true,
  precedenceBulk: true,
  autoSubmitted: false,
  espDomain: "example.com",
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  category: "promotions",
  starred: false,
  providerImportant: false,
  ageDays: 20,
  isRead: false,
  hasAttachments: false,
  attachmentsApprox: true,
  threadDepth: 1,
  ownerPosition: "to",
};

describe("exportSql", () => {
  it("joins labels to unpurged messages and bounds the limit", () => {
    expect(exportSql(10)).toContain("JOIN messages m ON m.id = l.message_id AND m.account_id = l.account_id");
    expect(exportSql(10)).toMatch(/LIMIT 10$/);
    expect(() => exportSql(0)).toThrow();
    expect(() => exportSql(5001)).toThrow();
    expect(() => exportSql(1.5)).toThrow();
  });
});

describe("parseD1Rows", () => {
  it("reads cf d1 query output (objects)", () => {
    expect(parseD1Rows([{ success: true, results: [{ a: 1 }, { a: 2 }], meta: {} }])).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    expect(parseD1Rows({ result: [{ results: [{ a: 1 }] }] })).toEqual([{ a: 1 }]);
  });

  it("reads cf d1 raw output (columns and rows)", () => {
    expect(parseD1Rows([{ results: { columns: ["a", "b"], rows: [[1, "x"]] } }])).toEqual([{ a: 1, b: "x" }]);
  });
});

describe("rowsToFixtures", () => {
  it("converts rows into owner fixtures and skips invalid ones", () => {
    const { fixtures, skipped } = rowsToFixtures([
      {
        label_id: 7,
        owner_action: "delete",
        subject: "Flash sale",
        snippet: null,
        subject_trunc: "Flash",
        signals_json: JSON.stringify(SIGNALS),
      },
      { label_id: 8, owner_action: "delete", subject: "x", snippet: "", signals_json: "{not json" },
      {
        label_id: 9,
        owner_action: "maybe",
        subject: "x",
        snippet: "",
        signals_json: JSON.stringify(SIGNALS),
      },
    ]);
    expect(skipped).toBe(2);
    expect(fixtures).toHaveLength(1);
    const f = fixtures[0];
    expect(f?.id).toBe("owner-7");
    expect(f?.source).toBe("owner");
    expect(f?.category).toBe("promotion");
    expect(f?.input).toMatchObject({ kind: "signals", subject: "Flash sale", snippet: "" });
  });
});

describe("inferCategory", () => {
  const base = { category: null, hasListUnsubscribe: false, hasListId: false, isCorrespondent: false };
  it("maps subjects and signals to coarse categories", () => {
    expect(inferCategory("Your verification code", base)).toBe("otp");
    expect(inferCategory("Invoice for May", base)).toBe("receipt");
    expect(inferCategory("New sign-in detected", base)).toBe("security_alert");
    expect(inferCategory("Invitation: sync", base)).toBe("calendar");
    expect(inferCategory("Lunch?", { ...base, isCorrespondent: true })).toBe("human");
    expect(inferCategory("Weekly digest", { ...base, hasListId: true })).toBe("newsletter");
    expect(inferCategory("Hello", base)).toBe("other");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/eval exec vitest run test/export-labels.test.ts`
Expected: FAIL, cannot load `../src/export-labels.ts`.

- [ ] **Step 3: Implement**

Create `eval/src/export-labels.ts` with exactly this content:

```ts
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { EvalFixtureSchema, SignalsSchema, type EvalFixture, type FixtureCategory } from "./fixtures.ts";
import { LOCAL_D1_ID, PRIVATE_DIR, REPO_ROOT, assertGitIgnored, isMain, readD1Id } from "./io.ts";

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

/** Labels joined to messages that are not purged yet (messages live 30 days after a decision). */
export function exportSql(limit: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(`limit must be 1-${MAX_LIMIT}`);
  return [
    "SELECT l.id AS label_id, l.owner_action, l.subject_trunc, m.subject, m.snippet, m.signals_json",
    "FROM labels l JOIN messages m ON m.id = l.message_id AND m.account_id = l.account_id",
    `ORDER BY l.id DESC LIMIT ${limit}`,
  ].join(" ");
}

/** Rows from `cf d1 query` (results as objects) or `cf d1 raw` (columns + rows). */
export function parseD1Rows(json: unknown): Record<string, unknown>[] {
  const root =
    json !== null && typeof json === "object" && !Array.isArray(json) && "result" in json
      ? (json as { result: unknown }).result
      : json;
  const statements = Array.isArray(root) ? root : [root];
  const rows: Record<string, unknown>[] = [];
  for (const statement of statements) {
    if (statement === null || typeof statement !== "object") continue;
    const results = (statement as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const r of results)
        if (r !== null && typeof r === "object") rows.push(r as Record<string, unknown>);
    } else if (results !== null && typeof results === "object") {
      const { columns, rows: raw } = results as { columns?: unknown; rows?: unknown };
      if (!Array.isArray(columns) || !Array.isArray(raw)) continue;
      for (const values of raw) {
        if (!Array.isArray(values)) continue;
        const record: Record<string, unknown> = {};
        columns.forEach((c, i) => {
          record[String(c)] = values[i];
        });
        rows.push(record);
      }
    }
  }
  return rows;
}

export function inferCategory(
  subject: string,
  signals: {
    category: string | null;
    hasListUnsubscribe: boolean;
    hasListId: boolean;
    isCorrespondent: boolean;
  },
): FixtureCategory {
  if (/\b(code|verification|one-time|otp|passcode)\b/i.test(subject)) return "otp";
  if (/\b(receipt|invoice|order|payment)\b/i.test(subject)) return "receipt";
  if (/\b(sign-in|sign in|security|password)\b/i.test(subject)) return "security_alert";
  if (/\b(invitation|invite|calendar|event)\b/i.test(subject)) return "calendar";
  if (signals.isCorrespondent) return "human";
  if (signals.category === "promotions") return "promotion";
  if (signals.hasListUnsubscribe || signals.hasListId) return "newsletter";
  return "other";
}

export interface ConvertResult {
  fixtures: EvalFixture[];
  skipped: number;
}

export function rowsToFixtures(rows: readonly Record<string, unknown>[]): ConvertResult {
  const fixtures: EvalFixture[] = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      const signals = SignalsSchema.parse(JSON.parse(String(r.signals_json)));
      const subject =
        typeof r.subject === "string"
          ? r.subject
          : typeof r.subject_trunc === "string"
            ? r.subject_trunc
            : "";
      const snippet = typeof r.snippet === "string" ? r.snippet : "";
      fixtures.push(
        EvalFixtureSchema.parse({
          id: `owner-${String(r.label_id)}`,
          source: "owner",
          category: inferCategory(subject, signals),
          label: r.owner_action,
          input: { kind: "signals", subject, snippet, signals },
        }),
      );
    } catch {
      skipped++;
    }
  }
  return { fixtures, skipped };
}

function main(): number {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(PRIVATE_DIR, "owner-labels.jsonl") },
      limit: { type: "string", default: String(DEFAULT_LIMIT) },
      local: { type: "boolean", default: false },
    },
  });
  const out = resolve(values.out);
  assertGitIgnored(out);
  const sql = exportSql(Number(values.limit));
  const d1Id = values.local ? LOCAL_D1_ID : readD1Id();
  const cf = join(REPO_ROOT, "app", "node_modules", ".bin", "cf");
  const args = values.local
    ? [
        "d1",
        "raw",
        LOCAL_D1_ID,
        "--sql",
        sql,
        "--local",
        "--persist-to",
        join(REPO_ROOT, "app", ".cloudflare", "state"),
      ]
    : ["d1", "query", d1Id, "--sql", sql];
  const result = spawnSync(cf, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CLEARBOX_D1_ID: d1Id },
  });
  if (result.status !== 0) {
    console.error(`cf d1 ${values.local ? "raw" : "query"} failed (exit ${result.status ?? "signal"}).`);
    console.error(result.stderr.split("\n").slice(0, 5).join("\n"));
    return 1;
  }
  const { fixtures, skipped } = rowsToFixtures(parseD1Rows(JSON.parse(result.stdout)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, fixtures.map((f) => JSON.stringify(f)).join("\n") + "\n", { mode: 0o600 });
  chmodSync(out, 0o600);
  const counts = { delete: 0, archive: 0, keep: 0 };
  for (const f of fixtures) counts[f.label]++;
  console.log(
    `Exported ${fixtures.length} labels (delete ${counts.delete}, archive ${counts.archive}, keep ${counts.keep}); skipped ${skipped}.`,
  );
  console.log(`Wrote ${out} (git-ignored). Run: pnpm eval --fixtures ${out}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/eval exec vitest run test/export-labels.test.ts`
Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 5: Check the git-ignore guard**

Run: `pnpm --filter @clearbox/eval export-labels --out fixtures/leak.jsonl; echo "exit $?"; ls fixtures/leak.jsonl 2>&1`
Expected: `eval/fixtures/leak.jsonl is not git-ignored. Owner data may only be written under eval/private/.`, a non-zero exit, and `No such file or directory`.

- [ ] **Step 6: Optional local round trip (needs plan 03 and a local dev database with labels)**

Run: `pnpm --filter @clearbox/eval export-labels --local && pnpm eval --fixtures private/owner-labels.jsonl --limit 5`
Expected: `Exported <n> labels (...)`; with Azure variables set, a report path under `eval/private/reports/`.

- [ ] **Step 7: Format, lint, run all eval tests, commit**

Run: `pnpm exec prettier --write eval && pnpm lint && pnpm --filter @clearbox/eval test`
Expected: `Tests  42 passed (42)` across 6 files.

```bash
git add eval/src/export-labels.ts eval/test/export-labels.test.ts
git commit -m "feat(eval): export owner labels from D1 to a git-ignored path"
```

### Task 10: CI, CodeQL and Dependabot

**Files:**

- Create: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`

**Interfaces:**

- Consumes: root scripts `lint`, `format:check`, `typecheck`, `test`, `build` (plan 01); `scripts/tsconfig.json` and script tests (Tasks 1 to 3); `infra/azure/*` (Task 4).
- Produces: required status checks `Lint, typecheck, test, build`, `Azure IaC`, `Analyze (javascript-typescript)`, `Analyze (actions)`.

All actions are pinned to full commit SHAs (verified 2026-10-15 with `gh api repos/<action>/commits/<tag>`): `actions/checkout` v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`, `pnpm/action-setup` v6.1.0 `ea17c68df8912ef543352723c149a84f56e3d413` (reads `packageManager`, supports pnpm 12), `actions/setup-node` v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`, `github/codeql-action` v4.38.3 `24c54180a607b1449ed407dd24f251e4e9147c8d`. Dependabot keeps them current.

- [ ] **Step 1: CI workflow**

Create `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  CF_SEND_TELEMETRY: "false"
  DO_NOT_TRACK: "1"
  # Placeholder so app/cloudflare.config.ts resolves in production mode for typecheck and build.
  # CI never deploys and never talks to Cloudflare.
  CLEARBOX_D1_ID: 00000000-0000-4000-8000-000000000000

jobs:
  check:
    name: Lint, typecheck, test, build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Lint (ESLint, em dashes, secret patterns)
        run: pnpm lint
      - name: Format
        run: pnpm format:check
      - name: Typecheck packages
        run: pnpm typecheck
      - name: Typecheck scripts
        run: pnpm exec tsc -p scripts/tsconfig.json
      - name: Script tests
        run: node --test "scripts/test/*.test.ts"
      - name: Unit, worker, SPA and eval tests
        run: pnpm test
      - name: Build
        run: pnpm build

  infra:
    name: Azure IaC
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: ShellCheck
        run: shellcheck infra/azure/deploy-decision.sh
      - name: Script dry run
        run: infra/azure/deploy-decision.sh --resource-group rg-ci --account ci-account --dry-run --smoke-test
      - name: Bicep build
        run: |
          az bicep install
          az bicep build --file infra/azure/decision.bicep --stdout > /dev/null
          az bicep build --file infra/azure/decision-existing.bicep --stdout > /dev/null
```

- [ ] **Step 2: CodeQL workflow**

Create `.github/workflows/codeql.yml` with exactly this content:

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 3 * * 1"

permissions:
  contents: read

jobs:
  analyze:
    name: Analyze (${{ matrix.language }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      actions: read
      contents: read
      security-events: write
    strategy:
      fail-fast: false
      matrix:
        language: [javascript-typescript, actions]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: github/codeql-action/init@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          languages: ${{ matrix.language }}
          build-mode: none
          queries: security-extended
      - uses: github/codeql-action/analyze@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          category: /language:${{ matrix.language }}
```

- [ ] **Step 3: Dependabot**

Create `.github/dependabot.yml` with exactly this content:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    cooldown:
      default-days: 7
    ignore:
      # typescript-eslint 8.71.2 peers typescript < 6.1.0 (contracts section 2).
      - dependency-name: typescript
        versions: [">=6.1.0"]
    groups:
      cloudflare:
        patterns: ["cf", "@cloudflare/*", "@msw/cloudflare"]
      react:
        patterns:
          [
            "react",
            "react-dom",
            "@types/react",
            "@types/react-dom",
            "react-router",
            "@tanstack/*",
            "@vitejs/*",
          ]
      build:
        patterns: ["vite", "tailwindcss", "@tailwindcss/*"]
      runtime:
        patterns: ["hono", "zod", "jose"]
      test:
        patterns: ["vitest", "msw", "happy-dom", "jsdom", "@testing-library/*", "axe-core"]
      lint-and-types:
        patterns:
          [
            "eslint",
            "@eslint/*",
            "typescript-eslint",
            "eslint-plugin-*",
            "globals",
            "prettier",
            "typescript",
            "@types/node",
          ]

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    cooldown:
      default-days: 7
    groups:
      actions:
        patterns: ["*"]
```

- [ ] **Step 4: Validate locally**

Run: `pnpm exec prettier --check .github && node -e "for (const f of ['ci','codeql']) console.log(f, require('node:fs').readFileSync('.github/workflows/'+f+'.yml','utf8').includes('persist-credentials: false'))"`
Expected: `All matched files use Prettier code style!`, `ci true`, `codeql true`. If `actionlint` is installed, `actionlint` prints nothing.

- [ ] **Step 5: Reproduce the CI job locally**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 sh -c 'pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm typecheck && pnpm exec tsc -p scripts/tsconfig.json && node --test "scripts/test/*.test.ts" && pnpm test && pnpm build'`
Expected: every step succeeds (this needs plans 01 to 05 merged; if run earlier, only the steps for existing packages are meaningful).

- [ ] **Step 6: Commit and check on GitHub**

```bash
git add .github/workflows/ci.yml .github/workflows/codeql.yml .github/dependabot.yml
git commit -m "ci: add CI, CodeQL and Dependabot"
```

After pushing: `gh run list --limit 3` shows `CI` and `CodeQL` runs; `gh run watch` ends in success. Enable secret scanning, push protection, Dependabot alerts and private vulnerability reporting with the commands in `SECURITY.md` (Task 12).

### Task 11: Setup guides

**Files:**

- Create: `docs/setup-cloudflare.md`, `docs/setup-azure.md`, `docs/setup-google.md`, `docs/setup-microsoft.md`

**Interfaces:**

- Consumes: `pnpm setup:cf` behavior (Task 3), `deploy-decision.sh` flags (Task 4), `pnpm eval` (Task 8), contracts 3.1, 3.7, 7.12, 7.13, research `cloudflare.md` sections 1 and 6, `decision-1.md` sections 5, 6, 9 and 10, `mail-providers.md` section 1.
- Produces: the documentation links used by `README.md` and `docs/runbook.md`.

- [ ] **Step 1: Cloudflare guide**

Create `docs/setup-cloudflare.md` with exactly this content:

````markdown
# Set up Cloudflare

Clearbox runs as one Cloudflare Worker named `clearbox` (API, cron jobs and the SPA) with one D1 database named `clearbox` in the **EU jurisdiction**, protected by a Cloudflare Access application. Everything fits the Workers Free plan.

Do [setup-azure.md](setup-azure.md) first so you have the Decision-1 endpoint, key and deployment name. Google and Microsoft OAuth clients ([setup-google.md](setup-google.md), [setup-microsoft.md](setup-microsoft.md)) can be added now or later by re-running the setup.

## 1. Prerequisites

| Requirement                         | Check                                                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare account (Free is enough) | You can sign in to the dashboard                                                                                                                                                                      |
| Zero Trust organization             | Dashboard > Zero Trust. The first visit asks for a team name and a plan; the Free plan still asks for payment details but does not charge. Your team domain is `https://<team>.cloudflareaccess.com`. |
| Node.js 24.13 or newer              | `node --version`                                                                                                                                                                                      |
| pnpm 12 (through Corepack)          | `corepack enable && pnpm --version`                                                                                                                                                                   |
| Dependencies installed              | `pnpm install` at the repository root                                                                                                                                                                 |
| Free Cron Trigger slots             | Clearbox needs 2 of the 5 Cron Triggers per account on Workers Free. Check the triggers of your other Workers in the dashboard.                                                                       |

Sign in the `cf` CLI that the project pins (run from the repository root):

```sh
./app/node_modules/.bin/cf auth login
./app/node_modules/.bin/cf auth whoami
```

For automation you can instead export `CLOUDFLARE_API_TOKEN` (permissions: Account D1 Edit, Workers Scripts Edit, Access Apps and Policies Edit) and `CLOUDFLARE_ACCOUNT_ID`. Never put these, or any Worker secret, in a project `.env` file.

## 2. Run the setup script

```sh
pnpm setup:cf
```

The script is interactive and safe to re-run. It:

1. Checks Node.js, pnpm, the `cf` install and the `cf` login.
2. Finds or creates the D1 database: it uses the id in `app/clearbox.local.json` (git-ignored) when present, otherwise looks for a database named `clearbox`, otherwise runs `cf d1 create --name clearbox --jurisdiction eu`. It refuses a database whose jurisdiction is not `eu`, and writes the id to `app/clearbox.local.json`.
3. Applies the migrations in `app/migrations` to the remote database (`cf d1 migrations apply <id>`). `cf` may ask you to confirm.
4. Asks for every secret that is not set yet (table below). `TOKEN_ENC_KEY` and `STATE_SIGNING_KEY` are generated (32 random bytes each) and never shown. Credentials are read with hidden input. For secrets that already exist it asks whether to replace them (default: no).
5. Writes the new values to the git-ignored temporary file `app/deploy.secrets.json` (mode 600), runs `pnpm run deploy:cf --secrets-file app/deploy.secrets.json` (which runs `cf deploy --no-provision`) and deletes the file, even on failure.
6. Asks for the Worker URL printed by the deploy (`https://clearbox.<subdomain>.workers.dev`) and stores it in `app/clearbox.local.json`.
7. Prints the Access instructions (section 3) and asks for the AUD tag, then deploys once more with `ACCESS_AUD`.
8. Prints the exact OAuth redirect URIs to register with Google and Microsoft.

`--no-provision` matters: without it `cf deploy` creates missing resources itself, and an auto-created D1 database would not be in the EU jurisdiction. `app/cloudflare.config.ts` also refuses to build for production without a database id.

| Secret                                     | Value                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `AZURE_DECISION_ENDPOINT`                  | `https://<foundry-account>.services.ai.azure.com` (account root, no path) |
| `AZURE_DECISION_KEY`                       | Foundry key1 (hidden input)                                               |
| `AZURE_DECISION_DEPLOYMENT`                | `decision-1` (the deployment name, never `Microsoft-Decision-1`)          |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google web client; empty id disables Gmail                                |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`         | Entra app id and secret value; empty id disables Outlook                  |
| `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`       | generated                                                                 |
| `OWNER_EMAIL`                              | the one email allowed in, stored lowercase                                |
| `ACCESS_TEAM_DOMAIN`                       | `https://<team>.cloudflareaccess.com` (you can type just `<team>`)        |
| `ACCESS_AUD`                               | AUD tag of the Access application (section 3)                             |

Until `ACCESS_AUD` and the other Access values are set, every `/api/*` and `/oauth/*` request answers `500 access_misconfigured`. That is intentional: the Worker fails closed.

## 3. Protect the Worker with Cloudflare Access

Access must protect **all traffic** of the Worker, including the `workers.dev` URL. The Worker also verifies the Access JWT itself on every request.

Dashboard:

1. Workers & Pages > `clearbox` > Settings > Access (or the Access tab) > **Protect this Worker behind Access**.
2. Choose **All traffic**, pick any policy, then **Apply Access**.
3. Zero Trust > Access controls > Applications > the new application > Policies: make the only Allow rule **Include: Emails = `<you@example.com>`** (the same value as `OWNER_EMAIL`). Remove broader rules such as "Cloudflare account" or "Email domain".
4. Same application > Configure > Additional settings: copy the **Application Audience (AUD) tag** and paste it when `pnpm setup:cf` asks for `ACCESS_AUD`.

CLI alternative (from the repository root; the response contains `aud`):

```sh
./app/node_modules/.bin/cf workers get clearbox   # note the "id" field
./app/node_modules/.bin/cf zero-trust access applications create --body '{
  "type": "self_hosted",
  "name": "Clearbox",
  "destinations": [{ "type": "worker", "worker_id": "<worker-id>" }],
  "policies": [{ "decision": "allow", "include": [{ "email": { "email": "<you@example.com>" } }] }]
}'
```

Check it:

```sh
curl -sI https://clearbox.<subdomain>.workers.dev/api/me | head -n 3
```

Expected: a `302` redirect to `https://<team>.cloudflareaccess.com/...` (Access answers before the Worker runs; you never get a Clearbox JSON response without signing in). In a private browser window, the URL shows the Access login page; after signing in with `OWNER_EMAIL` (one-time PIN works) you see the Clearbox dashboard.

## 4. Re-running and changing secrets

- `pnpm setup:cf` again: reuses the database, keeps existing keys, asks per secret whether to replace it, deploys the current code.
- Rotate the OAuth state key: `pnpm setup:cf --rotate-state-key` (only in-flight connect flows are affected).
- Rotate the token key: `pnpm setup:cf --rotate-token-key`. Read [runbook.md](runbook.md) first: every account must Reconnect.
- Single secret without the script: `npx wrangler secret put <NAME> --name clearbox` (`cf` cannot set a single secret yet).
- Deploy code only: `pnpm deploy:cf` (needs `app/clearbox.local.json` or `CLEARBOX_D1_ID`).

## 5. Local development

```sh
cp app/.dev.vars.example app/.dev.vars   # fill in values; the file is git-ignored
pnpm db:migrate:local                    # local D1 in app/.cloudflare/state
pnpm dev                                 # http://localhost:5173
```

- Local mode skips Access only on `localhost` / `127.0.0.1` in development mode. Production builds always verify the JWT.
- Trigger the cron jobs: `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=*+*+*+*+*"` (tick) and `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=0+2+*+*+*"` (nightly).
- OAuth locally needs `http://localhost:5173/oauth/google/callback` and `http://localhost:5173/oauth/microsoft/callback` registered as extra redirect URIs.

## 6. Troubleshooting

| Symptom                                                      | Fix                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No D1 database id. Run pnpm setup:cf or set CLEARBOX_D1_ID` | Run `pnpm setup:cf`, or export `CLEARBOX_D1_ID=<d1-id>`                                                                                                                                                                                                                                                                  |
| `cf is not logged in`                                        | `./app/node_modules/.bin/cf auth login`                                                                                                                                                                                                                                                                                  |
| `jurisdiction "us"` (or other)                               | The existing database is not EU. Create a new one (delete or rename the old one, delete `app/clearbox.local.json`, re-run). The jurisdiction cannot be changed after creation.                                                                                                                                           |
| `500 access_misconfigured`                                   | A required secret is missing or malformed (`OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TOKEN_ENC_KEY`, `STATE_SIGNING_KEY`). Re-run `pnpm setup:cf`.                                                                                                                                                             |
| `403 forbidden` after Access login                           | `OWNER_EMAIL` differs from the Access login email, or `ACCESS_AUD` belongs to another application.                                                                                                                                                                                                                       |
| First deploy rejected because `ACCESS_AUD` is missing        | The Access application needs the deployed Worker first. Re-run `pnpm setup:cf` and enter a placeholder such as `pending-access-application-setup-0000` for `ACCESS_AUD` (the Worker still rejects every request, because no Access JWT carries that audience), then create the Access application and replace the value. |
| Cron jobs never run                                          | Account already uses 5 Cron Triggers; remove one from another Worker.                                                                                                                                                                                                                                                    |

## 7. Workers Paid

On Workers Paid you can lift the Free limits: set `FREE_TIER: bindings.text("false")` in `app/cloudflare.config.ts` (page size 100, no D1 write budget gate) and deploy with `pnpm deploy:cf`. Nothing else changes.
````

- [ ] **Step 2: Azure guide**

Create `docs/setup-azure.md` with exactly this content:

````markdown
# Set up Azure (Microsoft-Decision-1)

Clearbox scores each email with **Microsoft-Decision-1** on Microsoft Foundry, in **Sweden Central** with the **DataZoneStandard** SKU (EU data zone). You need:

- an AIServices (Foundry) account in `swedencentral` with a custom subdomain and key auth enabled;
- a deployment named `decision-1` of model `Microsoft-Decision-1` (format `Microsoft`, version `1`), capacity **300** (for this model one capacity unit is one request per minute), version upgrades off (`NoAutoUpgrade`).

Cost: $0.042 per 1M input tokens, output is free. Clearbox sends about 450 to 800 input tokens per email, about $0.25 to $0.34 per 10,000 emails. Version 1 retires on **2027-02-04** (see [runbook.md](runbook.md)).

## 1. Prerequisites

```sh
az login
az account set --subscription "<subscription>"
az bicep install            # or: az bicep upgrade
```

You need Contributor (or Cognitive Services Contributor) on the resource group. Check the regional quota (expect `limit` 500 or more and room for 300):

```sh
az cognitiveservices usage list --location swedencentral \
  --query "[?name.value=='AIServices.DataZoneStandard.Microsoft-Decision-1']" --output table
```

## 2. Deploy with the script

The script previews the change with `az deployment group what-if`, asks before applying, verifies the deployment and never prints the key. Add `--dry-run` to only print the commands.

New account (the name must be globally unique; it becomes `https://<foundry-account>.services.ai.azure.com`):

```sh
infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --create-group --smoke-test
```

Existing AIServices account (only adds the deployment; checks region, kind, subdomain and key auth first):

```sh
infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --existing --smoke-test
```

Options: `--deployment <name>` (default `decision-1`), `--capacity <rpm>` (default 300), `--subscription <id>`, `--yes` (no confirmation).

The script ends with the values for the Worker secrets:

| Secret                      | Value                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `AZURE_DECISION_ENDPOINT`   | `https://<foundry-account>.services.ai.azure.com`                                          |
| `AZURE_DECISION_DEPLOYMENT` | `decision-1`                                                                               |
| `AZURE_DECISION_KEY`        | not printed; copy it to the clipboard and paste it at the hidden prompt of `pnpm setup:cf` |

```sh
az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key1 --output tsv | pbcopy
```

(Linux: pipe to `xclip -selection clipboard` instead of `pbcopy`.)

## 3. Bicep directly

```sh
az deployment group what-if --resource-group <resource-group> --name clearbox-decision \
  --template-file infra/azure/decision.bicep --parameters accountName=<foundry-account>
az deployment group create --resource-group <resource-group> --name clearbox-decision \
  --template-file infra/azure/decision.bicep --parameters accountName=<foundry-account>
```

Use `infra/azure/decision-existing.bicep` for an existing account. Parameters: `accountName` (required), `deploymentName` (default `decision-1`), `capacityRpm` (default 300). `decision.bicep` only allows `swedencentral`.

Do not point `decision.bicep` at an account you created by other means: it would reset that account's network and auth settings. Use the existing-account template.

## 4. Plain az commands (no Bicep)

```sh
az cognitiveservices account create --name <foundry-account> --resource-group <resource-group> \
  --location swedencentral --kind AIServices --sku S0 --custom-domain <foundry-account> --assign-identity --yes

az cognitiveservices account deployment create --name <foundry-account> --resource-group <resource-group> \
  --deployment-name decision-1 --model-name Microsoft-Decision-1 --model-format Microsoft --model-version 1 \
  --sku-name DataZoneStandard --sku-capacity 300

az resource update --set properties.versionUpgradeOption=NoAutoUpgrade --ids "$(az cognitiveservices account deployment show \
  --resource-group <resource-group> --name <foundry-account> --deployment-name decision-1 --query id --output tsv)"
```

`--sku-capacity 1` (as in some examples) would mean one request per minute: unusable.

## 5. Run the model evaluation

The eval harness calls the real deployment with synthetic emails (see the README). The key goes into the environment of your shell only:

```sh
export AZURE_DECISION_ENDPOINT="https://<foundry-account>.services.ai.azure.com"
export AZURE_DECISION_DEPLOYMENT="decision-1"
export AZURE_DECISION_KEY="$(az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key1 --output tsv)"
pnpm eval
unset AZURE_DECISION_KEY
```

## 6. Troubleshooting

| Error                                 | Meaning and fix                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ContainsReservedWord` at deploy time | The deployment cannot be named `Microsoft-Decision-1`. Use `decision-1`.                                                       |
| `InsufficientQuota`                   | Lower `--capacity` or request quota for `AIServices.DataZoneStandard.Microsoft-Decision-1` in swedencentral.                   |
| 401 from the API                      | Wrong or rotated key. Update `AZURE_DECISION_KEY`.                                                                             |
| 404 `DeploymentNotFound`              | `AZURE_DECISION_DEPLOYMENT` must be the deployment name, and the endpoint must be the account root.                            |
| 400 `unrecognized_request_argument`   | A request carried an extra top-level field. Clearbox sends only `model`, `state` and `questions`; check for a modified client. |
| 429                                   | More than the deployment capacity per minute. Clearbox retries on later ticks; raise `--capacity` if it persists.              |
````

- [ ] **Step 3: Google guide (Testing-mode 7-day gotcha, "In production (unverified)")**

Create `docs/setup-google.md` with exactly this content:

```markdown
# Set up Google (Gmail)

Each Clearbox deployment uses its own Google OAuth client. Clearbox requests one scope, `https://www.googleapis.com/auth/gmail.modify`, which can read, label, archive and trash mail but **cannot permanently delete** it.

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
5. Run `pnpm setup:cf`, answer "yes" to replace `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, paste the values.
6. In Clearbox: open **Accounts** (sidebar) and click **Connect Gmail**. On the consent screen keep the Gmail permission ticked; if you untick it, Clearbox refuses the connection (`scope_missing`).

## 4. When Gmail asks you to reconnect

Google invalidates the refresh token when:

- you change your Google password (tokens with Gmail scopes are revoked);
- it has not been used for 6 months;
- the app is still in Testing (7 days);
- more than 100 refresh tokens exist for the same account and client (the oldest is dropped);
- you remove Clearbox at https://myaccount.google.com/permissions;
- a Workspace admin restricts the scope (`admin_policy_enforced`). The admin must allow the app in the Admin console (Security > Access and data control > API controls).

The account shows "Reconnect". Click it; Clearbox keeps your history and suggestions.

## 5. Configuration errors

| Message or state                                               | Cause                                                                                                                                                            | Fix                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| App banner "Google sign-in is misconfigured.", accounts in `config_error` | Wrong client id or secret, or the client was deleted (`invalid_client`, `deleted_client`; Google deletes clients unused for a long time, restorable for 30 days) | Fix or recreate the client, update the secrets with `pnpm setup:cf`, then Reconnect |
| `redirect_uri_mismatch` on the Google page                     | Redirect URI not registered exactly                                                                                                                              | Copy the URI printed by `pnpm setup:cf` into the client                             |
| `provider_not_configured`                                      | `GOOGLE_CLIENT_ID` is empty                                                                                                                                      | Set it with `pnpm setup:cf`                                                         |
| `no_refresh_token`                                             | Google returned no refresh token                                                                                                                                 | Remove Clearbox at https://myaccount.google.com/permissions and connect again       |

## 6. Disconnect

Disconnect in Clearbox revokes the token at Google (`oauth2.googleapis.com/revoke`), wipes it locally and purges that account's data in the nightly job. You can also remove access at https://myaccount.google.com/permissions.
```

- [ ] **Step 4: Microsoft guide (admin consent, no revoke endpoint)**

Create `docs/setup-microsoft.md` with exactly this content:

```markdown
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
3. Put a reminder in your calendar a few weeks before expiry ([runbook.md](runbook.md), "Rotate the Entra client secret").

## 4. API permissions

API permissions > Add a permission > Microsoft Graph > **Delegated permissions**: `offline_access`, `User.Read`, `Mail.ReadWrite`. Do not add application permissions. Personal accounts consent themselves on first sign-in.

## 5. Store the values and connect

1. Run `pnpm setup:cf`, replace `MS_CLIENT_ID` (the Application ID) and `MS_CLIENT_SECRET` (the secret value).
2. In Clearbox: open **Accounts** (sidebar) and click **Connect Outlook**, pick your account and accept the permissions.

## 6. Work or school accounts: admin consent

Many organizations block users from consenting to `Mail.ReadWrite` for unknown apps, or block them with Conditional Access. Symptoms: Microsoft shows "Need admin approval", or Clearbox reports `admin_consent_required` (AADSTS90094, AADSTS65001) or a Conditional Access block (AADSTS53003).

An administrator of that tenant can grant consent once:

- Entra admin center > Enterprise applications > Clearbox > Permissions > **Grant admin consent for <organization>**, or
- open `https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<app-id>` while signed in as an admin.

If the organization does not allow third-party mail apps at all, Clearbox cannot be used with that mailbox.

## 7. No revoke endpoint

Microsoft has no OAuth token revocation endpoint for these permissions. Disconnect in Clearbox wipes the tokens locally and purges the account's data, and the UI links to the consent pages so you can remove the grant yourself:

- personal accounts: https://account.live.com/consent/Manage
- work or school accounts: https://myapps.microsoft.com (grants given by an admin can only be removed by an admin).

## 8. Errors

| Error                      | Meaning                                                                         | Fix                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AADSTS7000215              | Invalid client secret                                                           | Paste the secret Value (not the ID) with `pnpm setup:cf`                                 |
| AADSTS7000222              | Client secret expired                                                           | Create a new secret, update `MS_CLIENT_SECRET`, Reconnect accounts in `config_error`     |
| AADSTS50011                | Redirect URI mismatch                                                           | Register the exact URI printed by `pnpm setup:cf` under the Web platform                 |
| AADSTS50194                | App is single-tenant                                                            | Change Supported account types (Authentication > Supported accounts) or recreate the app |
| AADSTS700016               | App not found in the directory                                                  | Wrong `MS_CLIENT_ID`                                                                     |
| AADSTS70008, 700082, 50173 | Refresh token expired or revoked (inactivity, password reset, revoked sessions) | Reconnect                                                                                |

Microsoft refresh tokens rotate on every use; Clearbox stores the new one after each refresh. An account that is checked at least every 90 days does not expire for inactivity.
```

- [ ] **Step 5: Format and scan**

Run: `pnpm exec prettier --write docs/setup-*.md && node scripts/check-text.ts && git grep -nE "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -- docs/setup-*.md`
Expected: `check-text: <n> files clean`; the grep prints only the all-zero UUIDs (`00000000-0000-...`), no real ids.

- [ ] **Step 6: Commit**

```bash
git add docs/setup-cloudflare.md docs/setup-azure.md docs/setup-google.md docs/setup-microsoft.md
git commit -m "docs: add Cloudflare, Azure, Google and Microsoft setup guides"
```

### Task 12: README, security policy, runbook and review checklist

**Files:**

- Create: `README.md`, `SECURITY.md`, `LICENSE`, `docs/security-review-checklist.md` (no earlier plan creates them)
- Replace: `docs/runbook.md` (plan 04 Task 12 created it with only the "Checking tick CPU time after deploy" section; the full runbook below keeps that section verbatim as section 15)

**Interfaces:**

- Consumes: everything above; design spec sections 7, 12 and 13; PRODUCT.md vocabulary (suggestion, sender group, confidence, reasons, guardrail, Clean up); contracts 6.5 (retention), 8 (budget gates), 9 (log events), 12 (amendments).
- Produces: the security gate that must pass before the first deploy (Task 13).

- [ ] **Step 1: README**

Create `README.md` with exactly this content:

````markdown
# Clearbox

Clearbox pre-sorts your Gmail and Outlook inboxes into **delete**, **archive**, **keep** or **unsure**, explains each suggestion, and executes only what you approve. A weekly 5 to 10 minute "Clean up" session replaces reading email by email.

- Suggestions are grouped by sender, with a calibrated confidence and up to three concrete reasons.
- Nothing is deleted without your approval, and "delete" means a recoverable move to Trash. Every batch can be undone for 24 hours.
- Guardrails (starred, replied threads, people you write to, receipts, attachments) cap what can be suggested.
- Every approval or override teaches the system: per-sender priors and a nightly calibration tune the delete threshold toward the 98% delete-precision target.

Self-hosted and single-owner: you deploy your own copy on Cloudflare Workers Free, with your own OAuth clients and your own Microsoft Foundry deployment. This repository contains no shared service and no shared credentials.

Screenshot placeholder: the design mockup lives at [`docs/design/clearbox-ui-v4.html`](docs/design/clearbox-ui-v4.html) (open it in a browser). Screenshots of the running app will replace it.

## How it works

```mermaid
flowchart LR
  owner[Owner browser] -->|Cloudflare Access login| access[Cloudflare Access]
  access -->|Cf-Access-Jwt-Assertion| worker
  subgraph cf[Cloudflare Workers Free]
    worker[Worker clearbox: Hono API, React SPA assets]
    cron[Cron: every minute tick, nightly 02:00 UTC] --> worker
    worker --> d1[(D1 clearbox, EU jurisdiction)]
  end
  worker -->|OAuth, gmail.modify| gmail[Gmail API]
  worker -->|OAuth, Mail.ReadWrite| graph[Microsoft Graph]
  worker -->|api-key| foundry[Microsoft-Decision-1, Foundry Sweden Central, DataZoneStandard]
```

Every minute a tick leases one mailbox, reads one page of up to 25 messages (metadata and the provider snippet only), and runs a pipeline:

1. **Signals** from headers and history (unsubscribe headers, bulk mail, authentication results, open rate, whether you wrote to the sender or replied in the thread).
2. **Guardrails** compute the highest allowed action (starred or replied: keep; receipts and attachments: archive at most).
3. **Microsoft-Decision-1** returns probabilities for delete, archive, keep and unsure plus importance and record, expired and human flags. It returns no text, so a hostile email cannot make it say or do anything.
4. **Fusion** blends the model with your past decisions for that sender, applies the flags and the guardrail ceiling, and suggests delete only above a calibrated threshold (`tau_delete`, at least 0.80) with a clear margin.

You review sender groups in the dashboard, approve or override in bulk, and Clearbox moves the mail through the provider API. The nightly job recalibrates `tau_delete` from your decisions and purges old data.

## Quick start

You need a Cloudflare account, an Azure subscription with access to Microsoft Foundry, Node.js 24.13+, and pnpm 12 (`corepack enable`).

```sh
git clone https://github.com/<owner>/clearbox.git && cd clearbox
pnpm install

# 1. Decision-1 in Sweden Central (prints the endpoint and deployment name)
az login
infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --create-group --smoke-test

# 2. OAuth clients (optional now, can be added later)
#    docs/setup-google.md and docs/setup-microsoft.md

# 3. Cloudflare: EU D1, migrations, secrets, deploy, Access instructions
./app/node_modules/.bin/cf auth login
pnpm setup:cf
```

Then open `https://clearbox.<subdomain>.workers.dev`, sign in through Access, and connect a mailbox on the **Accounts** page (or follow the first-run setup screen).

Guides: [Cloudflare](docs/setup-cloudflare.md), [Azure](docs/setup-azure.md), [Google](docs/setup-google.md), [Microsoft](docs/setup-microsoft.md), [runbook](docs/runbook.md), [security review checklist](docs/security-review-checklist.md).

## Cost

| Item                                                            | Cost                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers, D1, Cron Triggers, Workers Logs (Free plan) | $0                                                                                                                                  |
| Cloudflare Access (Zero Trust Free, up to 50 users)             | $0                                                                                                                                  |
| Microsoft-Decision-1, DataZoneStandard                          | $0.042 per 1M input tokens, output free. About 450 to 800 tokens per email: **$0.25 to $0.34 per 10,000 emails**. Billed per token. |
| Gmail API, Microsoft Graph                                      | $0                                                                                                                                  |

A 50,000-email inbox costs roughly $1.30 to $1.70 to sort once. Throughput on the Free plan is limited by the D1 daily write budget: about 13,000 emails per day during the first backfill and about 6,800 per day sustained. Workers Paid lifts that limit without code changes.

## Security model

- **One owner per deployment.** A Worker-level Cloudflare Access application protects every hostname, and the Worker verifies the Access JWT itself (signature, issuer, audience, expiry, owner email). Missing configuration fails closed.
- **Least-privilege OAuth.** Gmail `gmail.modify` cannot permanently delete; Graph uses delegated `Mail.ReadWrite`. Authorization code with PKCE and a signed state cookie.
- **Encrypted tokens.** Refresh and access tokens are encrypted with AES-256-GCM (per-value IV, AAD bound to account, token kind and key version) using a key held only in Worker secrets.
- **Approval required.** No code path trashes or archives a message without a pending suggestion you approved in that request; requests are capped at 100 items, idempotent, and undoable for 24 hours.
- **Data minimization and residency.** Metadata and the provider snippet only, never full bodies; message rows are purged 30 days after a decision. D1 is in the EU jurisdiction and Decision-1 runs in the EU data zone. Logs contain opaque ids and counts only.
- **Hostile content.** Email text is rendered as plain text, the SPA ships a strict CSP, and the model only returns bounded probabilities.

Details: [SECURITY.md](SECURITY.md) and the design spec in [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Limitations

- Gmail and Outlook (Microsoft Graph) only; no IMAP.
- Single owner; not a multi-tenant service.
- No permanent deletion and no unsubscribe automation by design.
- The first backfill of a large inbox takes days on the Free plan (D1 write budget).
- Microsoft-Decision-1 is a Preview model; version 1 retires on 2027-02-04 ([runbook](docs/runbook.md)).
- A personal Google OAuth app shows the "unverified app" warning (you approve your own app once).
- Work or school Microsoft accounts may need admin consent.
- Suggestions use the snippet (up to 255 characters), not the full body.
- The `cf` CLI and the Cloudflare Vite plugin 2.0 are in beta; versions are pinned.
- Clearbox uses 2 of the 5 Cron Triggers available per Cloudflare account on Free.

## Development

```sh
pnpm dev               # Worker + SPA on http://localhost:5173 (local D1, dev auth bypass on localhost only)
pnpm db:migrate:local  # apply migrations to the local D1
pnpm lint              # ESLint + em dash and secret pattern scan
pnpm typecheck
pnpm test              # core, worker, SPA and eval unit tests
node --test "scripts/test/*.test.ts"
pnpm build
```

### Model evaluation

`pnpm eval` runs the real pipeline (signals, guardrails, Microsoft-Decision-1, fusion) on 40 synthetic labeled emails in `eval/fixtures/emails.jsonl` and writes a report to `eval/private/reports/` (git-ignored): delete precision and recall, a reliability (calibration) table, an option-order shuffle check, latency p50/p95 and token usage. It needs `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_KEY` and `AZURE_DECISION_DEPLOYMENT` in the environment ([setup-azure.md](docs/setup-azure.md), section 5).

To evaluate on your own decisions, export them from D1 into the git-ignored `eval/private/` folder and point the eval at them:

```sh
pnpm --filter @clearbox/eval export-labels
pnpm eval --fixtures private/owner-labels.jsonl
```

Never commit exported labels: they contain your real senders and subjects. Committed fixtures use reserved domains (`example.com`, `.test`, `.example`) only.

## License

MIT, see [LICENSE](LICENSE).
````

- [ ] **Step 2: SECURITY.md**

Create `SECURITY.md` with exactly this content:

````markdown
# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security > Report a vulnerability** on this repository. Do not open a public issue, and do not include real email content, tokens or keys in the report.

Include the affected version or commit, the steps to reproduce, and the impact you expect. This is a single-maintainer project: expect an acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues. Coordinated disclosure is appreciated; you will be credited unless you prefer otherwise.

In scope: the code in this repository (Worker, SPA, core library, scripts, infrastructure templates). Out of scope: vulnerabilities in Cloudflare, Microsoft, Google or other third-party services (report those to the vendor), and deployments whose owner changed the code or configuration.

## Supported versions

Only the latest commit on `main` receives fixes. Self-hosters should redeploy (`pnpm setup:cf` or `pnpm deploy:cf`) after pulling a security fix.

## Threat model summary

The most valuable asset is a mailbox refresh token; others are email metadata, the Azure API key and the decision history.

| Adversary                                     | Main controls                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated internet user                 | Worker-level Cloudflare Access ("All traffic", owner email only) plus JWT verification in the Worker (RS256 against the team JWKS, `iss`, `aud`, `exp`, owner email); fail closed when configuration is missing; dev bypass only in development mode on localhost |
| Cross-site attacker                           | `X-Clearbox-CSRF: 1` required on mutating API calls, no CORS, `SameSite=Lax` `__Host-` OAuth state cookie with HMAC, PKCE S256                                                                                                                                    |
| Hostile email content (XSS, prompt injection) | Plain-text rendering only, strict CSP, the model returns only bounded probabilities, guardrails based on headers and history, mandatory human approval, trash-only actions                                                                                        |
| Leaked logs                                   | Logs carry opaque ids and counts only; query strings redacted (`redactQueryString`)                                                                                                                                                                               |
| Database exposure                             | Tokens encrypted with AES-256-GCM (AAD binds account, token kind and key version); the key lives only in Worker secrets                                                                                                                                           |
| Supply chain                                  | Exact dependency versions, committed lockfile, Dependabot, CodeQL, actions pinned by commit SHA                                                                                                                                                                   |
| Public repository leak                        | No environment values in tracked files, `scripts/check-text.ts` secret patterns in `pnpm lint`, GitHub secret scanning with push protection, synthetic fixtures only                                                                                              |

The full model and the control list are in the design spec, section 7 (`docs/superpowers/specs/2026-10-15-clearbox-design.md`). Before a first deploy, work through [docs/security-review-checklist.md](docs/security-review-checklist.md).

## Repository settings (maintainers and forks)

Enable these on the GitHub repository (Settings > Code security, or with the GitHub CLI):

```sh
gh api -X PATCH repos/<owner>/<repo> --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts
gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting
```

- Secret scanning with **push protection** blocks pushes that contain known credential formats. If it blocks a push, remove the secret from the commit and rotate it; do not bypass the block for real secrets.
- Dependabot alerts and the weekly version updates in `.github/dependabot.yml`.
- CodeQL runs from `.github/workflows/codeql.yml`; protect `main` with required CI and CodeQL checks.

## If a secret leaks

Rotate it immediately using [docs/runbook.md](docs/runbook.md) (sections 2 to 5), then remove it from git history if it was committed. Rotation, not history rewriting, is what makes a leaked secret harmless.
````

- [ ] **Step 3: Runbook (key rotation with key_version, re-auth, purge, restore, budget, Decision-1 outage, rollback, tick CPU)**

Replace the whole of `docs/runbook.md` (plan 04's one-section file) with exactly this content:

````markdown
# Clearbox runbook

Operational procedures for a running deployment. Commands run from the repository root. `CF` below means `./app/node_modules/.bin/cf`, and `<d1-id>` is the `d1DatabaseId` in `app/clearbox.local.json`.

Queries you run against D1 count toward the daily rows read and written, like the app's own.

## 1. Where to look

| Source                                                       | What it tells you                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clearbox banners and the Accounts page                        | App issues (`decision_not_configured`, `decision_auth_failed`, `decision_deployment_not_found`, `google_client_invalid`, `microsoft_client_invalid`, `storage_near_limit`, `budget_exhausted_today`) and per-account status (`active`, `needs_reauth`, `config_error`) |
| Insights page                                                | Today's D1 budget, database size, `tau_delete`, calibration, sync status                                                                                                                                                                                               |
| Workers Logs (dashboard > Workers & Pages > clearbox > Logs) | JSON events: `tick.done`, `tick.failed`, `decision.error`, `provider.error`, `access.denied`, `config.invalid`, `budget.gate`, `nightly.done`, `issue.raised`                                                                                                          |
| Live tail                                                    | `npx wrangler tail clearbox`                                                                                                                                                                                                                                           |
| Budget history                                               | `$CF d1 query <d1-id> --sql "SELECT date, rows_written, ticks, messages_ingested, decision_failures FROM budget ORDER BY date DESC LIMIT 7"`                                                                                                                           |

Logs never contain addresses, subjects, tokens or URLs, only ids and counts.

## 2. Rotate TOKEN_ENC_KEY

`TOKEN_ENC_KEY` encrypts every stored OAuth token (AES-256-GCM, AAD `clearbox|<accountId>|<kind>|v<keyVersion>`). Clearbox v1 holds one key at a time, so rotation means re-encrypting through Reconnect. `accounts.key_version` stays `1`; it is reserved for a future dual-key rotation.

When: the key may have leaked, or as yearly hygiene.

1. In Clearbox, on the **Accounts** page: **Pause** every account (no ticks will try to decrypt with the new key).
2. `pnpm setup:cf --rotate-token-key`, type `rotate`, keep every other secret. The script generates the new key, deploys it and never shows it.
3. For each account click **Reconnect** and complete the provider sign-in. Reconnect writes fresh tokens encrypted with the new key and keeps cursors, suggestions, labels and priors.
4. **Resume** each account and click **Scan now** once to confirm (`tick.done` in the logs).
5. If the old key leaked: also revoke the old grants (Google: https://myaccount.google.com/permissions then reconnect; Microsoft: reconnect issues new tokens, and an admin can revoke sessions for work accounts).

An account you forget to reconnect fails its ticks safely (no actions, backoff) until you reconnect it.

## 3. Rotate STATE_SIGNING_KEY

`pnpm setup:cf --rotate-state-key`. Only connect flows started in the last 10 minutes fail (`state_invalid`); start them again.

## 4. Rotate the Azure key

1. Switch Clearbox to key2: `az cognitiveservices account keys list --resource-group <resource-group> --name <foundry-account> --query key2 --output tsv | pbcopy`, then `pnpm setup:cf` and replace `AZURE_DECISION_KEY`.
2. Regenerate key1: `az cognitiveservices account keys regenerate --resource-group <resource-group> --name <foundry-account> --key-name key1 --output none`.
3. Next time, rotate the other way round.

## 5. Rotate the Google or Entra client secret

- Entra secrets expire (AADSTS7000222). Before expiry: Certificates & secrets > New client secret, `pnpm setup:cf` to replace `MS_CLIENT_SECRET`, then delete the old secret. Existing tokens keep working.
- Google: Clients > Clearbox > Add secret, replace `GOOGLE_CLIENT_SECRET`, then disable and delete the old secret.
- After an expiry already happened: accounts show `config_error`; replace the secret, then Reconnect each affected account.

## 6. Re-authentication (`needs_reauth`)

Causes: revoked consent, password change (Gmail), 6 months unused (Gmail), Testing-mode app (Gmail, 7 days), Conditional Access or MFA requirement (Microsoft), refresh token expiry (Microsoft, 90 days unused). Fix: **Reconnect** on the account card (Accounts page) or in the Review banner. Repeated weekly Gmail re-auth means the consent screen is still in Testing ([setup-google.md](setup-google.md)).

## 7. Configuration errors (`config_error`)

Owner-side credential problems (`invalid_client`, `unauthorized_client`, `deleted_client`, AADSTS7000215, AADSTS7000222, AADSTS50011, AADSTS50194, AADSTS700016). The app banner names the provider. Fix the client in Google or Entra, update the secrets with `pnpm setup:cf`, then Reconnect the affected accounts.

## 8. Purge and data removal

- Automatic: the nightly job (02:00 UTC) deletes suggestions and messages 30 days after a decision (90 days if never reviewed) and action batches after 7 days, in bounded chunks.
- One account: **Accounts** page, **Disconnect** on its card. Tokens are wiped at once (Google token revoked); messages, suggestions, labels, priors and sender data are purged by the following nightly runs; the audit log keeps counts only.
- Everything: disconnect all accounts and wait for the purge, or delete the resources:

  ```sh
  $CF workers delete clearbox
  $CF d1 delete <d1-id>
  rm app/clearbox.local.json
  ```

  Then delete the Access application (Zero Trust > Access controls > Applications) and, if wanted, the Azure deployment and the OAuth clients.

- Undo a bad database change (for example a wrong manual query): D1 Time Travel restores to any point in the last 7 days (Free):

  ```sh
  $CF d1 time-travel restore <d1-id> --timestamp 2026-10-15T08:00:00Z
  ```

## 9. Restore mail

- Within 24 hours: Clearbox > Activity > Undo on the batch. Trashed mail returns to the inbox, archived mail returns to the inbox.
- After 24 hours: Clearbox never deletes permanently. Gmail: open Trash (kept about 30 days) and choose "Move to inbox"; archived mail is under All Mail. Outlook: Deleted Items (retention depends on the mailbox policy, often 30 days) and the Archive folder.
- Then override the sender in Clearbox ("Always keep sender") so it is not suggested again.

## 10. D1 budget exhaustion

Free D1 allows 100,000 rows written per day (reset 00:00 UTC). Clearbox stops claiming ticks at 65,000, stops the nightly purge at 80,000 and refuses owner actions with `budget_exhausted` at 90,000 (`budget.gate` events).

- Usually expected during the first backfill: scanning resumes after 00:00 UTC.
- If owner actions are refused, wait for the UTC reset.
- To go faster permanently: Workers Paid and `FREE_TIER` `"false"` ([setup-cloudflare.md](setup-cloudflare.md), section 7).

Storage: backfill pauses at 450 MB of the 500 MB per-database limit (`storage_near_limit`). Review and decide pending suggestions so the purge can remove decided rows, or disconnect accounts you no longer need.

## 11. Decision-1 outage or errors

| Signal                                                               | Meaning                            | Action                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue `decision_not_configured`                                      | `AZURE_DECISION_*` secrets missing | `pnpm setup:cf`                                                                                                                                             |
| Issue `decision_auth_failed`, `decision.error` kind `auth` (401/403) | Key wrong or rotated               | Replace `AZURE_DECISION_KEY` (section 4)                                                                                                                    |
| Issue `decision_deployment_not_found` (404)                          | Deployment deleted or renamed      | `infra/azure/deploy-decision.sh ... --existing`, check `AZURE_DECISION_DEPLOYMENT`                                                                          |
| Many `rate_limited` (429)                                            | Capacity too low                   | Re-run the deploy script with a higher `--capacity`                                                                                                         |
| `server`, `timeout`, `network`                                       | Azure incident                     | Nothing to do: suggestions wait as `awaiting_model`, retry after 5 and 30 minutes, then fall back to `unsure` with "Model unavailable". Check Azure status. |
| Many `invalid_response`                                              | API shape changed (Preview model)  | Check the release notes; update the schema in `packages/core/src/decision/response.ts`; run `pnpm eval`                                                     |

Nothing is ever executed without your approval, so an outage only delays suggestions.

### Version retirement (2027-02-04)

Microsoft-Decision-1 version 1 stops serving on 2027-02-04. Weeks before:

1. Deploy the new version under a new name (for example `decision-2`) with `infra/azure/deploy-decision.sh --existing --deployment decision-2` after updating the model version in the Bicep files.
2. Run `pnpm eval` against both deployments, on the synthetic fixtures and on exported labels (`pnpm --filter @clearbox/eval export-labels`). Compare delete precision, calibration and flip rate.
3. Switch `AZURE_DECISION_DEPLOYMENT` with `pnpm setup:cf`. New suggestions carry the new `model_version`; the nightly calibration re-tunes `tau_delete` from new labels.
4. Delete the old deployment after the switch.

## 12. Roll back a deploy

Worker code is versioned; D1 is not rolled back with it.

```sh
$CF workers versions list --worker-id clearbox
$CF workers deployments create --worker clearbox --strategy percentage \
  --versions '[{"version_id":"<previous-version-id>","percentage":100}]'
```

If Cloudflare blocks the rollback because secrets changed since that version, add `--bypass-deployment-checks` only after checking that the old code works with the current secrets. Migrations are forward-only: never roll code back past a migration it does not understand. Fix forward with a new migration instead.

## 13. Schema changes

Add `app/migrations/000N_<name>.sql` (never edit an applied file), test it locally with `pnpm db:migrate:local`, then `pnpm setup:cf` (it applies pending migrations before deploying) or `$CF d1 migrations apply <d1-id> --dir app/migrations` followed by `pnpm deploy:cf`.

## 14. Locked out

- Access login works but Clearbox answers 403: `OWNER_EMAIL` differs from your Access identity, or `ACCESS_AUD` belongs to another application. Replace them with `pnpm setup:cf`.
- 500 `access_misconfigured` everywhere: a required secret is missing or malformed (`config.invalid` event lists names only).
- Cron jobs stopped: another Worker took the last Cron Trigger slot (5 per account on Free).

## 15. Checking tick CPU time after deploy

Workers Free allows 10 ms of CPU per cron invocation. Locally, `pnpm --filter @clearbox/app exec vitest run -c vitest.worker.config.ts test/worker/tick/tick-cpu.test.ts` guards the compute of one 25-message tick (pure stages under 8 ms). After a deploy, check the real numbers:

1. Cloudflare dashboard, Workers & Pages, `clearbox`, Observability, Query builder (Workers Logs must be enabled; `cloudflare.config.ts` enables invocation logs).
2. Filter invocation logs to the tick cron: `$metadata.message` equals `* * * * *` (cron invocations use the cron schedule as their message).
3. Visualize `$workers.cpuTimeMs` with P50, P99 and Max over the last 24 hours. P99 should stay well below 10; anything above 8 needs attention.
4. Find the slow ticks: filter `$workers.cpuTimeMs` greater than `8` and match them by time to the `tick.done` events (`evt = "tick.done"`), which carry `kind`, `fetched`, `decided` and `durationMs`.
5. Signs of CPU kills: `tick.claimed` without a matching `tick.done` or `tick.failed`, and accounts whose `page_size` dropped below 25 (each killed tick halves it on the next claim, minimum 5; successful ticks grow it back by 5).

If ticks are being killed, the adaptive page size recovers on its own. If it stays low for days, lower the work per page (see the benchmark notes in `docs/superpowers/plans/2026-10-15-clearbox-04-scan-pipeline.md`, Task 12) or move to Workers Paid and set `FREE_TIER=false`.
````

- [ ] **Step 4: Security review checklist (pre-deploy gate from design spec section 7)**

Create `docs/security-review-checklist.md` with exactly this content:

```markdown
# Security review checklist (pre-deploy gate)

Complete this list before the first production deploy and again after any change to authentication, OAuth, token crypto, action endpoints or infrastructure. It mirrors the controls in the design spec, section 7. Every item names its evidence: a test, a command, or a setting.

Record the result at the end and keep it outside the repository if it contains environment details.

## Automated gates

- [ ] CI green on the commit: lint (ESLint plus `scripts/check-text.ts`), format, typecheck, script tests, `pnpm test`, build.
- [ ] CodeQL (`javascript-typescript` and `actions`) shows no open alerts.
- [ ] Dependabot shows no open security alerts; `pnpm-lock.yaml` is committed and every version in `package.json` files is exact.
- [ ] A `security-review` agent pass over token handling, OAuth, Access verification and the action endpoints is done and every finding is fixed or accepted in writing.

## App access

- [ ] Access application covers **All traffic** of the Worker (including `workers.dev`); its only Allow rule is the owner's email. Evidence: Zero Trust > Applications.
- [ ] `curl -sI https://clearbox.<subdomain>.workers.dev/api/me` returns a redirect to Access, never Clearbox JSON.
- [ ] Worker JWT verification tests pass: missing token, bad signature, wrong `aud`, wrong `iss`, expired, wrong email, service token without email (`app/test/worker/access/`).
- [ ] Fail-closed tests pass: missing `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TOKEN_ENC_KEY` or `STATE_SIGNING_KEY` gives `500 access_misconfigured`.
- [ ] Dev bypass tests pass: honored only in development mode on `localhost` / `127.0.0.1`; `DEV_AUTH_BYPASS=true` elsewhere fails closed. `app/cloudflare.config.ts` derives it from the build mode.

## OAuth

- [ ] Scopes are exactly `gmail.modify` (Google) and `offline_access User.Read Mail.ReadWrite` (Microsoft). `git grep -n '"https://mail.google.com/"' -- packages app/src` (the full-access scope) returns nothing.
- [ ] Granted scopes are checked on connect (`scope_missing` test).
- [ ] PKCE S256 and the HMAC-signed `__Host-clearbox_oauth` cookie: tampered, expired, provider-mismatch and state-mismatch tests pass; the cookie is cleared on every callback.
- [ ] Redirect URIs in Google and Entra are exactly `https://clearbox.<subdomain>.workers.dev/oauth/<provider>/callback` (plus optional localhost); Microsoft uses the Web platform, not SPA.
- [ ] Google consent screen is **In production**; Entra app is multitenant plus personal accounts.

## Tokens and secrets

- [ ] AES-256-GCM round trip and AAD mismatch tests pass (`app/test/worker/crypto/`).
- [ ] Microsoft refresh-token rotation is persisted, including on the failure path (tick tests).
- [ ] `./app/node_modules/.bin/cf workers secrets list --worker clearbox` lists all 12 secrets from contracts 3.7.
- [ ] `TOKEN_ENC_KEY` and `STATE_SIGNING_KEY` were generated by `pnpm setup:cf` or `pnpm gen-key`, not copied from tests or docs.
- [ ] No secret in the repository: `pnpm lint` passes and `git ls-files | grep -E '(^|/)\.dev\.vars$|clearbox\.local\.json|\.secrets\.json$|^eval/private/'` prints nothing.

## Web surface

- [ ] Asset responses carry the strict CSP from `app/public/_headers`: `curl -sI` on `/` after Access login (or in the browser network panel) shows `Content-Security-Policy: default-src 'self'; script-src 'self'; ...` and `X-Frame-Options: DENY`.
- [ ] `/api/*` responses carry `Cache-Control: no-store` and `default-src 'none'` (route tests).
- [ ] CSRF tests pass: mutating `/api/*` without `X-Clearbox-CSRF: 1` gives `403 csrf_required`; no CORS headers anywhere.
- [ ] Email content is plain text only: `git grep -n "dangerouslySetInnerHTML\|innerHTML" -- app/src` returns nothing.

## Destructive actions

- [ ] Approval invariant tests pass: no provider call without a `pending` suggestion id in the request, cap 100 ids, idempotent repeats, `unsure` not approvable.
- [ ] No hard-delete code path: `git grep -n "batchDelete\|messages/.*/delete\|permanentDelete" -- packages app/src` returns nothing.
- [ ] Undo works within 24 hours on a real test mailbox (trash and archive).

## Data minimization, residency and logs

- [ ] D1 is in the EU jurisdiction: `./app/node_modules/.bin/cf d1 get <d1-id>` shows `"jurisdiction": "eu"` (or the dashboard shows the EU location).
- [ ] Decision-1 deployment uses `DataZoneStandard` in `swedencentral`: `az cognitiveservices account deployment show ... --query sku.name`.
- [ ] `observability.redactQueryString` is `true` in `app/cloudflare.config.ts`.
- [ ] Only `app/src/worker/log.ts` calls `console`: `git grep -n "console\." -- app/src/worker ':!app/src/worker/log.ts'` returns nothing.
- [ ] A tail of real traffic (`npx wrangler tail clearbox`) shows no addresses, subjects, snippets, provider ids, tokens or URLs.
- [ ] DB isolation scan test passes (`app/test/worker/db-isolation.test.ts`).

## Repository settings

- [ ] Secret scanning and push protection enabled (see SECURITY.md for the `gh api` commands).
- [ ] Dependabot alerts and private vulnerability reporting enabled.
- [ ] Branch protection on `main` requires the CI and CodeQL checks.

## Sign-off

| Field          | Value |
| -------------- | ----- |
| Commit         |       |
| Date           |       |
| Reviewer       |       |
| Accepted risks |       |
```

- [ ] **Step 5: License**

Create `LICENSE` with exactly this content (MIT, as contracts 1.1 requires):

```text
MIT License

Copyright (c) 2026 Clearbox contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: Format, scan, check links**

Run: `pnpm exec prettier --write README.md SECURITY.md docs/runbook.md docs/security-review-checklist.md && node scripts/check-text.ts && for f in docs/setup-cloudflare.md docs/setup-azure.md docs/setup-google.md docs/setup-microsoft.md docs/runbook.md docs/security-review-checklist.md docs/design/clearbox-ui-v4.html LICENSE SECURITY.md; do test -e "$f" || echo "missing $f"; done`
Expected: `check-text: <n> files clean` and no `missing` lines.

- [ ] **Step 7: Commit**

```bash
git add README.md SECURITY.md LICENSE docs/runbook.md docs/security-review-checklist.md
git commit -m "docs: add README, security policy, runbook and review checklist"
```

### Task 13: End-to-end verification and first deploy

**Files:**

- No new files. Fix forward in the files of Tasks 1 to 12 if a step fails.

**Interfaces:**

- Consumes: plans 01 to 05 merged on the branch.
- Produces: a deployed, Access-protected Clearbox and a first eval report (both outside the repository).

- [ ] **Step 1: Full local gate**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm exec tsc -p scripts/tsconfig.json && node --test "scripts/test/*.test.ts" && pnpm test && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm build`
Expected: every command succeeds; script tests `ℹ tests 43`, eval `Tests  42 passed (42)`.

- [ ] **Step 2: Azure**

Run: `infra/azure/deploy-decision.sh --resource-group <resource-group> --account <foundry-account> --existing --smoke-test` (or without `--existing` plus `--create-group` for a new account)
Expected: what-if preview, confirmation prompt, a table with `state Succeeded`, `model Microsoft-Decision-1`, `version 1`, `sku DataZoneStandard`, `rpm 300`, `upgrade NoAutoUpgrade`, then `HTTP 200` and `"model":"microsoft-decision-1"`.

- [ ] **Step 3: Live eval on synthetic fixtures**

Run (key only in the shell environment, see `docs/setup-azure.md` section 5): `pnpm eval`
Expected: `Evaluating 40 fixtures against deployment decision-1...`, progress lines, a summary line, and `Report: .../eval/private/reports/eval-<timestamp>.md`. Read the report; record delete precision, harmful deletes (should be none), flip rate, p50/p95 latency and mean input tokens (expect about 450 to 800). Exit code 2 (a harmful delete) blocks the deploy until investigated.

- [ ] **Step 4: Cloudflare**

Run: `./app/node_modules/.bin/cf auth login && pnpm setup:cf`
Expected: the flow of Task 3; after the second deploy, `curl -sI https://clearbox.<subdomain>.workers.dev/api/me | head -n 1` shows a redirect to Access. Verify the open behaviors noted in "Contract issues" C9 and C11 (secrets kept across deploys, first deploy without `ACCESS_AUD`) and record the result in the plan index.

- [ ] **Step 5: Security gate**

Work through `docs/security-review-checklist.md` item by item and run the `security-review` agent over the auth, OAuth, crypto and action code. Do not connect a real mailbox before every item is checked.

- [ ] **Step 6: Repository settings**

Run the `gh api` commands in `SECURITY.md` for this repository, then `gh api repos/<owner>/<repo> --jq .security_and_analysis`
Expected: `secret_scanning` and `secret_scanning_push_protection` both `"enabled"`.

---

## Self-review

**Spec and brief coverage**

| Requirement                                                                                                                                                                                                                                                                                                       | Task                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `setup:cf`: prerequisites (cf login, Node, pnpm), EU D1 if absent, id into config, remote migrations, generated keys, every 3.7 secret through `cf`, `--no-provision` deploy, Access and redirect URI instructions, tests with injectable runner                                                                  | 2, 3                                                                           |
| `gen-key`, `check-text` (em dash and secret patterns)                                                                                                                                                                                                                                                             | 1                                                                              |
| `deploy:cf`                                                                                                                                                                                                                                                                                                       | consumed (plan 03 script), invoked by Task 3 and documented in Tasks 11 and 12 |
| Bicep: AIServices in swedencentral with `customSubDomainName`, `decision-1` deployment, format Microsoft, version 1, DataZoneStandard, 300 RPM; existing-account mode; what-if first; endpoint output; keys never printed                                                                                         | 4                                                                              |
| README (what, screenshot placeholder, mermaid, quick start, free-tier cost, security model, limitations), SECURITY.md, setup guides, runbook (key rotation with key_version, re-auth, purge, restore, budget, Decision-1 outage, rollback via versions), security review checklist (design spec 7)                | 11, 12                                                                         |
| CI (pnpm cache, lint, typecheck, unit and worker tests, build), CodeQL, Dependabot weekly grouped (npm and actions), push protection instructions, em dash and secret check                                                                                                                                       | 1, 10, 12                                                                      |
| Eval: ~40 synthetic fixtures across promotions, newsletters, receipts, OTP, human, GitHub, security alerts, calendar; real `MaiDecisionEngine` plus core pipeline; precision and recall, reliability table, shuffle flip rate, latency p50/p95, tokens; markdown report; owner-label export to a git-ignored path | 5 to 9                                                                         |
| Amendments rev 2.1 (12.4 dev deps)                                                                                                                                                                                                                                                                                | 10 (Dependabot `test` group)                                                   |

**Placeholder scan:** every code and doc step contains the full file. Angle-bracket values such as `<resource-group>` and `<foundry-account>` are intentional public-repo placeholders required by contracts section 11, not plan gaps.

**Type consistency:** `SetupDeps`, `SetupFs`, `CommandRunner`, `Prompter` are defined in Tasks 2 and 3 and used with the same names in tests. `EvalFixture`, `EvalRow`, `EvalSummary`, `Clock`, `EvalDeps` keep one definition each (Tasks 5, 7, 8). Test counts: scripts 5 + 11 + 20 + 7 = 43; eval 8 + 10 + 8 + 6 + 5 + 5 = 42.

**Verified while writing this plan (2026-10-15):** script modules ran under Node 24 type stripping with `node:test` (43 passing); eval modules typechecked against the contracts 4.x signatures and the metrics, fixtures, report, run and export tests passed under Vitest 5.0.4 (the pipeline tests need the real `@clearbox/core`); both Bicep files built with Bicep 0.47; `deploy-decision.sh` passed ShellCheck and the dry run; all files passed Prettier 3.9.10 and the ESLint strict and stylistic configs, and `check-text`.

**Open items**

1. First real deploy must confirm C9 (secrets not in `--secrets-file` are kept) and C11 (a version can be deployed while `ACCESS_AUD` is missing). Fallbacks are documented.
2. Confirm that `cf d1 get` reports `jurisdiction`; the script only warns when it is absent.
3. The Access dashboard path ("Settings > Access" vs an "Access" tab) may differ slightly; the CLI alternative is exact.
4. UI labels quoted in docs (Accounts page, Connect Gmail, Connect Outlook, Pause, Resume, Reconnect, Disconnect, Scan now, Activity > Undo, Insights, banner titles) were checked against plan 05 and the UI spec by the integration pass.
5. Resolved by the integration pass (C12): plan 03's token source turns an AES-GCM decrypt failure into `ProviderAuthError("token_decrypt_failed")`, which plan 04's tick records as a safe `needs_reauth` failure; plan 03's OAuth callback reconnects any non-disconnected account, paused or not.
6. `LICENSE` (MIT) is created by Task 12 Step 5 (no earlier plan creates it).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-clearbox-06-ops-ci-eval.md`. Two execution options:

1. **Subagent-Driven (recommended):** a fresh subagent per task with review between tasks (REQUIRED SUB-SKILL: superpowers:subagent-driven-development).
2. **Inline Execution:** execute tasks in one session with checkpoints (REQUIRED SUB-SKILL: superpowers:executing-plans).

## Execution notes

Executed on branch `feat/clearbox-06-ops-ci-eval` (stacked on `feat/clearbox-05-web-ui`) with superpowers:subagent-driven-development: one implementer per task, a spec and quality review after each task (fix rounds on Tasks 3, 4, 6, 7 and X1), a final whole-branch review and one fix wave. Task 12's README step was replaced by the owner's README brief (style of the ShinyQ-HQ README). Three lead tasks were added: X1 docs reconciliation (contracts rev 2.3), X2 route-level code splitting, X3 hide Undo for keep-only batches. No dependency was added beyond the eval package's pinned `zod` and `vitest` (C4).

### Gate 06 result (local commands)

`pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm exec tsc -p scripts/tsconfig.json && node --test "scripts/test/*.test.ts" && pnpm test && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm build` passes: `check-text: 495 files clean`; Prettier clean; script tests `ℹ tests 49`; core `Test Files  40 passed (40)`, `Tests  635 passed (635)`; eval `Test Files  6 passed (6)`, `Tests  55 passed (55)`; app worker `Test Files  49 passed (49)`, `Tests  387 passed (387)`; app web `Test Files  42 passed (42)`, `Tests  433 passed (433)`; build clean (no chunk size warning after X2). Gallery not shipped; built `index.html` inline style/script count `0`; `committed`.

Counts differ from the plan (scripts 43, eval 42) because of regression tests added by review fixes: scripts +6 (setup-cf secrets-list and secrets-file hardening), eval +13 (percentile rank, retry clamp, shared pacer back-off, shuffle errors, pacer guard, report shuffle-error count). Web grew from 422 to 433 (X3). Task 13 Steps 2 to 6 (live) run with the owner after the PR opens; outcomes are recorded below when done.

### Lead notes from earlier layers

| # | Handling |
|---|---|
| 1 | `"no-console": "error"` kept; `scripts/**` and `eval/**` already exempt. |
| 2 | CI runs `pnpm install --frozen-lockfile`, the worker tests (workerd) and the build (esbuild) on ubuntu; the first PR CI run confirms `allowBuilds` false still yields working binaries (see "Live verification"). |
| 3 | Docs and README use the real `db:migrate:local` (`--mode development`), `fsModuleCache: false` is untouched, build output `app/.cloudflare/output/v0/`. |
| 4 | No `cf d1 execute` anywhere. `export-labels` uses `cf d1 raw <id> [--local --persist-to .cloudflare/state --mode development] --sql=<sql>` for both modes, run from `app/` (the config resolves the D1 id from `CLEARBOX_D1_ID` or `app/clearbox.local.json`); runbook and checklist use `cf d1 raw ... --sql=`. Every documented `cf` command was checked against `cf` 1.0.0-beta.17 `--help`. |
| 5, 6 | Guides, runbook, README use the exact routes and labels. |
| 7 | Docs reconciliation in one commit (174f53b) plus a follow-up (ddf9d5b): contracts rev 2.3 (section 12.6), 1.1 lists the layer 4, 5 and 6 files, 1.3 `db:migrate:local`, 9 `request.error` on 200 for invalid stored reasons, C27 `{reason}` audit shape, incremental retention skip (8.2, 8.3, 6.5, `skippedOld`), Undo not applying to keeps (7.8, UI spec 5.2.4, 5.2.6, 5.4, 6.8), UI spec copy additions, account card status rule; design spec revision history; index points to rev 2.3. |
| 8 | Done (X2, 5bb47c2): Setup, Activity, Insights, Rules and Accounts are React Router `lazy` routes; main chunk 625 kB to 324 kB plus a 250 kB shared chunk and 6 to 11 kB page chunks. |

### Deviations (fix forward)

| # | Task | Change | Why |
|---|---|---|---|
| 1 | 3, final | `setup:cf` treats a failed `cf workers secrets list` as "no secrets" only when `cf workers get clearbox` also reports not found; any other failure aborts before key generation. SIGINT/SIGTERM during the write-to-deploy window deletes `app/deploy.secrets.json`; the write happens inside `try` (owner approved) | A transient list failure silently rotated `TOKEN_ENC_KEY` and made every stored token unreadable; Ctrl+C left secrets on disk |
| 2 | 4, final | `deploy-decision.sh`: `--existing` accepts account names with uppercase and underscores (new accounts stay lowercase); dry run prints the resource-group commands; clear errors for a bad subscription, a failed group check and a failed smoke-test curl (key unset); account preflight and quota parsing are null-safe (joined single-row queries) | Real existing accounts; silent exits; tsv null fields shifted |
| 3 | 6 | `percentile` computes the rank as `ceil(p * n / 100)` | `p / 100` float error picked the next rank (p=28, n=25) |
| 4 | 7 | Retry sleeps clamp to `MAX_RETRY_SLEEP_MS = 60_000`; a rate-limit retry pushes the shared pacer forward (`Pacer.delayUntil`); shuffle-call failures are recorded (`EvalRow.shuffleError`, report count); `createPacer` rejects non-positive rpm | A large `Retry-After` stalled the run; other workers kept hitting a throttled endpoint; silent shuffle failures |
| 5 | final | `pnpm eval` gives `MaiDecisionEngine` `Date.now` (pacer keeps `performance.now`) | HTTP-date `Retry-After` was computed against a monotonic clock |
| 6 | 11, 12a | Guides and runbook follow the real scripts; TOKEN_ENC_KEY rotation re-links each paused account with Connect Gmail / Connect Outlook on the same mailbox (Reconnect only shows for `needs_reauth` and `config_error`; `completeConnect` reconnects the existing row in place) | C12 assumed a Reconnect button on paused accounts |
| 7 | 12b | README written from the owner's brief: centered header, badges, screens table and hero captured from the local app with the synthetic dev seed (headless Chrome over DevTools, `docs/readme/*.png`), mermaid architecture, Quick start with a working local `.dev.vars` snippet (the example's placeholders fail config validation) | Owner request |
| 8 | X3 | The SPA hides Undo for keep-only batches (toasts, undo stack, Activity rows) and keeps it for mixed batches (`lib/keep-only.ts`); keep-only Activity rows show an empty cell (owner approved) | Lead decision: Undo does not apply to keeps |
| 9 | final | Cost figures corrected to about $0.19 to $0.34 per 10,000 emails (450 to 800 tokens at $0.042 per million) in README, setup-azure, design spec and research | Arithmetic |

### Live verification

Recorded after Phase B (owner present). Items: Linux CI with `allowBuilds` (index note), Decision-1 what-if and deployment, smoke test, live eval numbers and 429 headers (index item 5), `cf deploy --secrets-file` semantics (C9, index item 6), first deploy without `ACCESS_AUD` (C11, index item 7), production D1 `CLAIM_SQL` (index item 8), D1 `batch()` counting, `cf d1 get` jurisdiction, real `cf` not-found stderr for the setup heuristic, Access application body.

### Deferred minor findings (triaged by the final review as safe to defer)

check-text robustness (bare catch, silent skip over 2 MB, overlapping key rules, `<` prefix exemption, no `main()` coverage); Access Option B command embeds the owner email unescaped; `parseJsonOutput` banner fallback; duplicate UUID regexes; raw-mode prompt chunk handling; `onNodeInterrupt` untested; non-TTY prompter stack trace; `STATE_SIGNING_KEY` rotation unconfirmed; no secrets re-list after the `ACCESS_AUD` deploy; existing-mode account regex rejects `.`; fixture domain guard skips some fields; metrics argument validation; unexpected engine errors scored as `unknown`; no `assertGitIgnored` test; `export-labels` raw parse errors may echo cf output to the local terminal; CI concurrency cancels in-flight `main` runs; Dependabot group split of vite and `@vitejs/*`; AADSTS wording in the Microsoft guide; export window wording; no failed-chunk test and no `HydrateFallback` for lazy routes; small X3 test fixture and import-order nits.
