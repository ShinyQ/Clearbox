# Cloudflare platform research for Clearbox

- **Date verified:** 2026-10-15
- **Method:** current official docs (`developers.cloudflare.com/.../index.md`), local `cf --help` / `cf cli search` / `cf schema` / `--dry-run`, read-only account queries with the owner's authenticated `cf`, and inspection of the published npm packages (`cf@1.0.0-beta.17`, `@cloudflare/config@0.26.0`, `@cloudflare/vite-plugin@2.0.0-beta`, `@cloudflare/vitest-plugin@1.4.2`).
- **Nothing was created, deployed, or modified** in the Cloudflare account. The only local writes were throwaway scratch files (deleted).
- Spec under review: `docs/superpowers/specs/2026-10-15-clearbox-design.md`.

> Note: this file sits in a public repo. Environment-specific values found during research (account ID and name, `workers.dev` subdomain, Zero Trust team domain, existing Workers) are kept outside the repo; placeholders such as `<your-account-id>` and `<team>.cloudflareaccess.com` are used below.

## Summary of spec corrections (details in each section)

| # | Spec statement | Correction | Severity |
|---|---|---|---|
| C1 | "Each step uses at most 30 subrequests", one instance runs up to 900 steps | Docs state the Free subrequest limit for Workflows is **per Workflow instance** (50 external), not per step. A 900-step instance with 30 fetches per step is not safe on Free. Redesign: one page per instance, chained successor instances, or verify empirically before relying on per-step resets. | **High** |
| C2 | Workflows Free limits: 1,024 steps, 100 concurrent | Also: **3,000 steps per day included on Free** (step billing since 2026-08-10; sleeps count as steps for billing), 1 GB-month storage, 3-day retention, 100k executions/day shared with Worker requests. | **High** |
| C3 | D1: "5 GB storage" | 5 GB is per account. **Max 500 MB per database on Free**, 10 databases per account. | Medium |
| C4 | "about 5 D1 rows written per email" | Every index on a written column adds one written row; `DELETE` purges also count (plus index rows). With the planned indexes, an email costs about 6-7 rows on insert and about 4 more on purge. Re-derive the budget. | Medium |
| C5 | Workers Free "50 subrequests" | 50 **external** subrequests plus **1,000 to Cloudflare services** per invocation (Workers limits page). The D1 limits page still says "50 queries per invocation" on Free. Docs conflict; plan for 50 D1 calls per invocation and use `batch()`. | Medium |
| C6 | Smart Placement for the app | Smart Placement only affects the `fetch` handler. It does nothing for Workflows steps or Cron Triggers, which do the Foundry calls. Low value; keep it optional. | Low |
| C7 | `cf` secrets command | `cf` docs say single-secret put is not supported yet; recommended paths are `cf deploy --secrets-file <file>` or `npx wrangler secret put ... --name <worker>`. `cf workers secrets update` / `bulk` (raw API commands) do exist. | Low |
| C8 | `apps/worker` and `apps/web` as separate apps | `cloudflare.config.ts` has no `assets.directory`. With `cf`, assets are the **Vite client build of the same Vite project** that builds the Worker. Make one Vite project contain both the SPA and the Worker entry. | Medium |
| C9 | Testing with `@cloudflare/vitest-pool-workers` | Renamed: **`@cloudflare/vitest-plugin`** (1.4.2). Supports `cloudflare.config.ts` via `experimental.newConfig`. `fetchMock` is gone: use `msw@^3` + `@msw/cloudflare`. `SELF` is replaced by `exports` from `cloudflare:workers`. | Medium |
| C10 | (implicit) `nodejs_compat` flag | Not needed: compatibility dates **2026-08-04 or later enable Node.js compat by default**. | Low |
| C11 | Access verification in Worker | Correct as written. Note `ctx.access` (new built-in identity) is **not available to Workers with Static Assets**, so manual JWT verification is required, as the spec says. | Info |
| C12 | "CPU limit (error 1102) on a step: halve page size and retry" | Inside a Workflow, a CPU overrun surfaces as a failed step attempt (`Error: Worker exceeded CPU time limit.`). Implement the adaptive page size inside the step using `ctx.attempt` from `WorkflowStepContext`. | Low |
| C13 | Local dev with `cf dev` and local D1 | `cf d1 migrations apply --local` writes to a **global** state dir by default, not the dev server's `.cloudflare/state`. Pass `--persist-to .cloudflare/state`. | Low |
| C14 | `pnpm setup` creates D1 with `cf` and deploys | `cf deploy` **auto-provisions** missing resources by default (`--provision` defaults to true), which would not set the EU jurisdiction. Always set the D1 `id` in config and deploy with `--no-provision`. | Medium |

---

## 0. Account state (read-only checks, 2026-10-15)

### Verified facts

| Item | Value | How verified |
|---|---|---|
| `cf` installed | `1.0.0-beta.16` (global install; the bin runs on Node via `#!/usr/bin/env node`). Latest on npm: `1.0.0-beta.17`. | `cf --version`, `npm view cf version` |
| Node.js | v24.13.1 (meets the `cf` minimum of 22.18) | `node --version` |
| Wrangler | Not installed globally (`which wrangler` empty). npm latest `4.151.0`. | `which`, `npm view` |
| Authenticated | Yes (OAuth profile). Scopes include `d1:write`, `workers:write`, `access:write`, `teams:write`. | `cf auth whoami` |
| Account ID | `<your-account-id>` | `cf auth whoami` |
| Account name | `<your-account-name>` (type `standard`) | `cf auth whoami` |
| workers.dev subdomain | `<subdomain>.workers.dev` (so Clearbox would be `https://clearbox.<subdomain>.workers.dev`) | `cf workers get <id>` on the existing Worker |
| Existing Workers | 1 unrelated Worker, `workers.dev` disabled | `cf workers list` |
| Existing D1 databases | none | `cf d1 list` |
| Existing Workflows | none | `cf workflows list` |
| Zero Trust organization | **Exists**, auth domain `<team>.cloudflareaccess.com` | `cf zero-trust organization get` |
| Access apps | 1 unrelated self-hosted app (Pages) | `cf zero-trust access applications list` |
| Identity providers | 1: One-time PIN (`onetimepin`) | `cf zero-trust identity-providers list` |

### Implications for Clearbox

- `ACCESS_TEAM_DOMAIN` for this owner is `https://<team>.cloudflareaccess.com` (JWT `iss` value). `ACCESS_AUD` will come from the new Access application created for the Clearbox Worker.
- One-time PIN is already configured, so owner-email login works without a third-party IdP.
- Cron Triggers are limited to **5 per account** on Free. The existing unrelated Worker may already use some; check its triggers in the dashboard (no read-only `cf` command for a script's schedules was found via `cf cli search`).

### Source

- https://developers.cloudflare.com/cf/get-started/index.md
- Local command output (above).

---

## 1. `cf` CLI: project config and commands

### Verified facts

- Config file: **`cloudflare.config.ts`** at the project root, default export via `defineConfig()` imported from **`cf/config`**. Open beta; format can change. Needs `"type": "module"` in `package.json` and Node 22.18+. Bun cannot load it. Add `cf` as a dev dependency (`pnpm add -D cf`).
- `cf` never bundles itself. `cf dev` / `cf build` / `cf deploy` delegate to the **Cloudflare Vite plugin 2.0 beta** (`@cloudflare/vite-plugin@beta`, which does not depend on Wrangler) or to Wrangler 4.136+ if declared without the Vite plugin. `cf` does **not** run `package.json` scripts; chain extra steps yourself (`"build": "tsc -b && cf build"`). Build output goes to `.cloudflare/output/v0/`.
- Worker fields (camelCase): `name`, `compatibilityDate` (required), `entrypoint`, `compatibilityFlags`, `assets` (`htmlHandling`, `notFoundHandling`, `basePath`, `runWorkerFirst`), `env` (bindings), `exports` (Workflows / DOs / entrypoints), `triggers`, `placement`, `observability`, `limits` (Paid only), `workersDev`, `previewUrls`, `access.dev`, `domains`, `cache`, `logpush`, `tailConsumers`.
- **No `assets.directory`**: in a Vite project the assets are Vite's client build output (including `publicDir`, default `public/`).
- Bindings builders (`bindings.*`): `text`, `json`, `secret`, `d1({ id?, name?, dev? })`, `workflow({ name, worker, exportName })`, `assets()`, and more. Exports builder: `exports.workflow({ name, limits?: { steps }, concurrency?: { limit }, schedules?, defaultRetention?: { successRetention, errorRetention } })`.
- Triggers: `triggers.scheduled({ schedule: "<cron>" })` (one entry per cron).
- Placement type: `{ mode: "off" | "smart", hint? } | { region } | { host } | { hostname }`.
- Observability type: `{ enabled?, headSamplingRate?, redactQueryString?, logs?: { enabled?, headSamplingRate?, invocationLogs?, persist?, destinations? }, traces?: {...} }`.
- `bindings.secret()` declares a secret for types and local validation (warns if missing in `.dev.vars`).
- Node.js compat: **on by default for compatibility dates >= 2026-08-04**; omit `nodejs_compat` (source: Node.js compat page).
- D1 binding `id` is optional in the type. If omitted, **`cf deploy` provisions missing resources by default** (`--provision`, default `true`); it does not write IDs back. Auto-provisioning cannot set a jurisdiction, so always pass the EU database ID.
- Local secrets: the Vite plugin reads, in order, `.dev.vars.<mode>`, `.dev.vars`, `.env.<mode>.local`, `.env.<mode>`, `.env.local`, `.env` (from the plugin's missing-secret error text). `cf` itself also reads `CLOUDFLARE_API_TOKEN`/account vars from a project `.env`, so keep Worker secrets in **`.dev.vars`** and never put them in `.env`.
- Local dev data: Vite plugin persists to **`.cloudflare/state/v3`** in the project. `--local` API commands default to a global dir (`~/Library/Preferences/cloudflare/state/v3` on macOS) unless `--persist-to <dir>` is passed (the command appends `/v3`). Verified: `cf d1 migrations apply <UUID> --local --persist-to .cloudflare/state` created `.cloudflare/state/v3/...` and applied a migration; `cf d1 raw <UUID> --sql ... --local --persist-to .cloudflare/state` read it back. The database argument **must be a UUID** (names rejected).
- `cf dev` uses Vite's port (default `http://localhost:5173`); `cf dev --port` is rejected in Vite projects (set `server.port` in `vite.config.ts`).
- Modes: `cf dev` = `development`, `cf build`/`cf deploy` = `production` (Vite). `--prebuilt` deploy must pass the recorded mode (`cf deploy --prebuilt --mode production`).
- `cf init` writes `.gitignore` entries for `.wrangler`, `.dev.vars*`, `.env*` but **not** `.cloudflare/`; add it.

### Exact snippets

`cloudflare.config.ts` (Clearbox, Free plan):

```ts
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

const WORKER_NAME = "clearbox";

export default defineConfig({
  worker: {
    name: WORKER_NAME,
    entrypoint,
    // Must not exceed the local workerd date shipped with the Vite plugin (miniflare 5.20261012).
    compatibilityDate: "2026-10-12",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/oauth/*"],
    },
    env: {
      DB: bindings.d1({ id: process.env.CLEARBOX_D1_ID, name: "clearbox" }),
      SCAN_WORKFLOW: bindings.workflow({
        name: "clearbox-scan",
        worker: WORKER_NAME,
        exportName: "ScanWorkflow",
      }),
      ASSETS: bindings.assets(),
      ENVIRONMENT: bindings.text("production"),
      FREE_TIER: bindings.text("true"),
      STORE_SNIPPETS: bindings.text("true"),
      LABEL_SUBJECTS: bindings.text("true"),
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
    exports: {
      ScanWorkflow: exports.workflow({
        name: "clearbox-scan",
        limits: { steps: 1000 },
        defaultRetention: { successRetention: "1 day", errorRetention: "3 days" },
      }),
    },
    triggers: [
      triggers.scheduled({ schedule: "*/30 * * * *" }),
      triggers.scheduled({ schedule: "0 2 * * *" }),
    ],
    placement: { mode: "smart" },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
    workersDev: true,
    previewUrls: false,
  },
});
```

Notes on the snippet:
- `bindings.workflow` requires `worker`; for a self-binding pass the Worker's own name (the vitest plugin source confirms "self-referential ... Workflow bindings are written against this name"). Declaring both the `env` binding and the `exports` entry is allowed (docs: "You can declare the same Workflow as both a binding and an export"); the `env` binding is required for test introspection.
- With a string `worker`, the generated type is plain `Workflow`; narrow it in code: `env.SCAN_WORKFLOW as Workflow<ScanParams>`.
- `process.env.CLEARBOX_D1_ID` keeps the database UUID out of the public repo; `pnpm setup` writes it to a gitignored file or exports it. If it is undefined, deploy with `--no-provision` so nothing is auto-created.
- `limits.steps` above 1,024 is rejected/ignored on Free (cap 1,024).

`vite.config.ts` (single Vite project for SPA + Worker; shape as generated by `cf init`):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare({ experimental: { headersAndRedirectsDevModeSupport: true } })],
});
```

`tsconfig.json` additions (from the cf config docs):

```json
{
  "compilerOptions": { "allowImportingTsExtensions": true, "noEmit": true },
  "include": ["src", "cloudflare.config.ts", ".cloudflare/types"]
}
```

`.gitignore` additions: `.cloudflare/`, `.dev.vars*`, `.env*`, `.wrangler/`.

### Exact commands (`cf`, verified with `--help` / `--dry-run` / local runs)

| Task | Command |
|---|---|
| Install | `npm install --global cf` (global) or `pnpm add -D cf` (project, required for `cf/config` import) |
| Local dev | `cf dev` (Vite, `http://localhost:5173`) |
| Build only | `cf build` |
| Validate without credentials | `cf deploy --dry-run` |
| Deploy | `cf deploy --no-provision` (optionally `--message "..." --tag vX`) |
| Deploy with secrets in one version | `cf deploy --no-provision --secrets-file .secrets.json` (JSON or `.env` format) |
| Create D1 (EU) | `cf d1 create --name clearbox --jurisdiction eu` (dry-run body verified: `{"jurisdiction":"eu","name":"clearbox"}`; choices `eu`, `fedramp`, `us`) |
| List D1 | `cf d1 list` (works with `--local` too) |
| New migration | `cf d1 migrations create "init schema"` (local only; verified output `migrations/0001_init_schema.sql`, header `-- Migration number: 0001 \t <ISO date>`) |
| Apply migrations, local | `cf d1 migrations apply <DATABASE_UUID> --local --persist-to .cloudflare/state` |
| Apply migrations, remote | `cf d1 migrations apply <DATABASE_UUID>` (options: `--dir` default `./migrations`, `--pattern`, `--table` default `d1_migrations`) |
| List unapplied | `cf d1 migrations list <DATABASE_UUID> [--local --persist-to .cloudflare/state]` |
| Ad hoc SQL | remote: `cf d1 query <UUID> --sql "..."`; local: `cf d1 raw <UUID> --sql "..." --local --persist-to .cloudflare/state` (`d1 query` has no local mode) |
| One secret (API command) | `cf workers secrets update <SECRET_NAME> --worker clearbox --type secret_text --text <VALUE>` (dry-run verified; value lands in shell history, prefer the next two) |
| Many secrets (API command) | `cf workers secrets bulk --worker clearbox --file secrets-patch.json` (JSON Merge Patch; set a key to `null` to delete). Body object shape per secret not shown by `cf schema`; verify with `--dry-run` before use. |
| One secret (docs-recommended fallback) | `npx wrangler secret put <SECRET_NAME> --name clearbox` |
| Types | `cf workers types` (writes `.cloudflare/types/index.d.ts`; the Vite plugin also regenerates it on `cf dev`/`cf build`). Typecheck script: `cf workers types && tsc` |
| Trigger cron locally | `curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=*/30+*+*+*+*"` (endpoint documented; `?format=json` for structured result) |
| Live logs | not in `cf` yet: `npx wrangler tail clearbox` |
| Workflow instances | `cf workflows instances list ...`, `cf workflows instances get <instance-id> ...` (exist per `cf workflows instances --help`) |
| Protect Worker with Access | `cf zero-trust access applications create --body '<json>'` (see section 6) |

### Wrangler fallback (`wrangler.jsonc`)

Only if `cf` proves unworkable. Do not keep both files: `cf dev/build/deploy` must not run in a project with a Wrangler config and no `cloudflare.config.ts`.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "clearbox",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-10-12",
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/oauth/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "clearbox", "database_id": "<UUID>", "migrations_dir": "migrations" }
  ],
  "workflows": [
    {
      "name": "clearbox-scan",
      "binding": "SCAN_WORKFLOW",
      "class_name": "ScanWorkflow",
      "limits": { "steps": 1000 },
      "default_retention": { "success_retention": "1 day", "error_retention": "3 days" }
    }
  ],
  "triggers": { "crons": ["*/30 * * * *", "0 2 * * *"] },
  "vars": { "ENVIRONMENT": "production", "FREE_TIER": "true" },
  "secrets": { "required": ["TOKEN_ENC_KEY", "OWNER_EMAIL", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"] },
  "placement": { "mode": "smart" },
  "observability": { "enabled": true, "logs": { "enabled": true, "invocation_logs": true } }
}
```

Wrangler commands: `wrangler dev`, `wrangler deploy`, `wrangler d1 create clearbox --jurisdiction=eu`, `wrangler d1 migrations create clearbox <msg>`, `wrangler d1 migrations apply clearbox --local|--remote`, `wrangler secret put NAME`, `wrangler secret bulk secrets.json`, `wrangler types`.

### Source

- https://developers.cloudflare.com/cf/projects/cloudflare-config/index.md
- https://developers.cloudflare.com/cf/projects/index.md
- https://developers.cloudflare.com/cf/wrangler/reference/index.md
- https://developers.cloudflare.com/cf/get-started/first-worker/index.md
- https://developers.cloudflare.com/cf/environment-variables/index.md
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/index.md
- Typings: `@cloudflare/config@0.26.0` (`WorkerConfig`, `D1BindingOptions`, `WorkflowExportOptions`, `WorkflowBindingOptions`)

### Implications for Clearbox / spec corrections

- C8: restructure `apps/worker` + `apps/web` into **one Vite project** (for example `apps/app/` with `index.html`, `src/client/`, `src/worker/`, `cloudflare.config.ts`, `vite.config.ts`). `packages/core` stays separate.
- C14: `pnpm setup` must create the EU D1 first, capture its UUID, then deploy with `--no-provision`.
- C13: the setup/dev scripts must pass `--persist-to .cloudflare/state` for local migrations so `cf dev` sees them. Verify once at scaffolding that `cf dev` keys the local DB by the same UUID (expected, since the plugin passes `database_id` to Miniflare).
- C7: prefer `cf deploy --secrets-file` (gitignored temp file, deleted after) in `pnpm setup`.
- `cf` is beta (`1.0.0-beta.17`); pin the version in `package.json`.

---

## 2. Workflows TypeScript API

### Verified facts

- Imports: `import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";` and `import { NonRetryableError } from "cloudflare:workflows";`.
- Class: `export class ScanWorkflow extends WorkflowEntrypoint<Env, Params> { async run(event: WorkflowEvent<Params>, step: WorkflowStep) { ... } }`. The entrypoint module must export the class.
- `WorkflowEvent<T> = { payload: Readonly<T>; timestamp: Date; instanceId: string; workflowName: string; schedule?: { cron: string; scheduledTime: number } }`.
- `step.do` overloads:
  - `step.do(name, callback)`
  - `step.do(name, config, callback)`
  - `step.do(name, callback, rollbackOptions)` / `step.do(name, config, callback, rollbackOptions)`
  - `name` up to 256 chars; callback receives `WorkflowStepContext = { step: { name, count }, attempt, config }` (`attempt` is 1-based).
- `WorkflowStepConfig = { retries?: { limit: number; delay: string | number | (({ ctx, error }) => string | number | Promise<...>); backoff?: "constant" | "linear" | "exponential" }; timeout?: string | number }`.
- Defaults when no config: `{ retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes" }`. `limit` counts retries (limit 10 = 11 attempts). Max 10,000 retries per step. Timeout is per attempt; keep it at 30 minutes or less.
- `step.sleep(name, duration: number | "N second|minute|hour|day|week|month|year")`, `step.sleepUntil(name, Date | epochMs)`. Max sleep 365 days. Sleeps do **not** count toward the per-instance step limit (but do count as steps for billing, per the 2026-07-07 changelog).
- `NonRetryableError(message, name?)`: stops retries and fails the instance (rollback handlers still run).
- Creating instances: `env.SCAN_WORKFLOW.create({ id?, params?, retention? }) => Promise<WorkflowInstance>`; `createBatch({ instances: [...] })` (1-100) returns `{ created, errors }` and reports duplicate IDs as error code `10405` (no throw); `get(id)`, `deleteBatch(ids)`. Instance methods: `status()`, `pause()`, `resume()`, `restart()`, `terminate()`, `sendEvent()`.
- Instance ID rules: max 100 chars, pattern `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, unique per Workflow; `create()` **throws** if the ID exists and has not passed its retention period (3 days on Free). Use that for idempotency, or `createBatch` and inspect `errors`.
- Determinism / replay: step names are the cache key; name steps deterministically. Code outside `step.do` may run more than once (engine restarts / hibernation lose in-memory state). Conditions outside steps must depend only on `event.payload` or prior step results. Completed steps are not re-executed: their persisted result is returned.
- Step result size: **1 MiB** max for non-stream return values (structured-cloneable only). Event payload max 1 MiB. Per-instance persisted state max 100 MB on Free.
- Successor instances: allowed. Docs example creates a child from inside `step.do` (`this.env.CHILD_WORKFLOW.create({ id: \`child-${event.instanceId}\`, params })`); parent does not wait.
- Free plan limits (Workflows limits + pricing pages):
  - Compute (CPU) per step: **10 ms**; wall time per step unlimited. I/O wait does not count toward CPU.
  - Max steps per instance: **1,024** (sleeps excluded).
  - Steps included: **3,000 per day** on Free (step billing since 2026-08-10). Free accounts "will not be charged" beyond; docs do not state whether excess steps are throttled or fail.
  - Executions: 100,000 per day, **shared with the Workers daily request limit**.
  - Concurrent running instances: 100 (waiting/sleeping instances excluded). Creation rate 100/s.
  - Retention of finished instances: 3 days. Storage: 1 GB-month.
  - **Subrequests: "Maximum number of subrequests per Workflow instance: 50/request" on Free**, and "Workers on the free plan remain limited to 50 external subrequests and 1,000 subrequests to Cloudflare services per invocation." The table scopes it per instance; a Cloudflare skills issue (cloudflare/skills#22, closed) also reads it as per instance, not per step. Whether a wake-up after sleep/retry counts as a new "invocation" with a fresh budget is **not documented**.
- CPU measurement: active CPU only, per step (Free 10 ms). Paid default 30 s per invocation, configurable to 5 min via `limits.cpuMs`.
- Workflow-native cron: `exports.workflow({ schedules: ["0 * * * *"] })` starts instances on a schedule (100 schedules per account; separate from the 5 Worker Cron Triggers). `event.schedule` carries `cron` and `scheduledTime`. Free-plan availability of `schedules` is not stated explicitly.
- Calling a Workflow declared only in `exports`: `ctx.exports.ScanWorkflow.create(...)` (same API as a binding).

### Exact snippet

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type ScanParams = { accountId: string; cursor: string | null; pageSize: number; generation: number };

export class ScanWorkflow extends WorkflowEntrypoint<Env, ScanParams> {
  async run(event: WorkflowEvent<ScanParams>, step: WorkflowStep) {
    const { accountId, cursor, pageSize, generation } = event.payload;

    const page = await step.do(
      "scan-page",
      {
        retries: {
          limit: 3,
          delay: ({ ctx, error }) => (error.message.startsWith("429:") ? `${30 * ctx.attempt} seconds` : "10 seconds"),
          backoff: "exponential",
        },
        timeout: "5 minutes",
      },
      async (ctx) => {
        const size = Math.max(5, Math.floor(pageSize / 2 ** (ctx.attempt - 1)));
        // fetch page, decide, write with one db.batch(); throw NonRetryableError on invalid_grant
        return { nextCursor: "...", processed: size, done: false };
      },
    );

    if (!page.done) {
      await step.do("spawn-successor", async () => {
        const next = await (this.env.SCAN_WORKFLOW as Workflow<ScanParams>).create({
          id: `scan-${accountId}-${generation + 1}`,
          params: { accountId, cursor: page.nextCursor, pageSize, generation: generation + 1 },
        });
        return { id: next.id };
      });
    }
  }
}
```

Return only small, serializable values from steps (IDs, cursors, counts), not `WorkflowInstance` objects.

### Source

- https://developers.cloudflare.com/workflows/build/workers-api/index.md
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/index.md
- https://developers.cloudflare.com/workflows/build/rules-of-workflows/index.md
- https://developers.cloudflare.com/workflows/build/trigger-workflows/index.md
- https://developers.cloudflare.com/workflows/reference/limits/index.md
- https://developers.cloudflare.com/workflows/reference/pricing/index.md
- https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/index.md
- https://github.com/cloudflare/skills/issues/22

### Implications for Clearbox / spec corrections

- **C1 (high):** the spec's ScanWorkflow (one instance, loop up to 900 steps, about 30 subrequests per step) assumes a per-step budget. Safe Free design: **one page per instance** (token refresh 1 + list/metadata 1-2 + 25 Decision calls = about 28 external subrequests; D1 via batch), then a `spawn-successor` step. Keep each instance at 2-3 steps. Alternatively, run a spike test on Free before committing to multi-page instances. Store the provider access token (encrypted, short TTL) in D1 to skip the refresh subrequest in successor instances.
- **C2 (high):** 3,000 steps/day caps throughput. At 2 steps per 25-email page, that is at most 1,500 pages, about 37k emails/day from the step budget alone, before the D1 write budget (the tighter limit). Count `step.sleep` as a step in the daily budget. Add `steps` to the `budget` table.
- Successor IDs: derive deterministically (`scan-<accountId>-<generation>`) so retries of `spawn-successor` cannot fork two chains (the second `create` throws on duplicate ID; catch and treat as success). For cron-started scans use `scan-<accountId>-<floor(scheduledTime/30min)>` with `createBatch` and ignore `10405`.
- Instance ID uniqueness is only enforced within retention (3 days on Free); the generation counter in D1 must keep increasing.
- C12: implement adaptive page size with `ctx.attempt` as in the snippet.
- "`step.sleep` until 00:05 UTC" when the D1 budget is hit still works (`step.sleepUntil`), and a sleeping instance does not use a concurrency slot.

---

## 3. Cron Triggers

### Verified facts

- Handler: `async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext)`. Properties: `controller.cron` (the matching cron string), `controller.scheduledTime` (ms epoch), `controller.type === "scheduled"`.
- Multiple crons on one Worker all call the same `scheduled()`; switch on `controller.cron`.
- Cron Triggers run in UTC. Changes take up to 15 minutes to propagate.
- Free plan: **5 Cron Triggers per account** (not per Worker); **10 ms CPU** per Cron invocation; wall time 15 minutes.
- Local test: `/cdn-cgi/local/scheduled` on the Vite dev port (`?cron=...` to pick the expression, `?format=json` for structured output).
- Config in `cf`: `triggers: [triggers.scheduled({ schedule: "*/30 * * * *" }), triggers.scheduled({ schedule: "0 2 * * *" })]`. Wrangler: `"triggers": { "crons": [...] }`.

### Exact snippet

```ts
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case "*/30 * * * *":
        ctx.waitUntil(startScans(env, controller.scheduledTime));
        break;
      case "0 2 * * *":
        ctx.waitUntil(runNightly(env, controller.scheduledTime));
        break;
    }
  },
} satisfies ExportedHandler<Env>;
```

### Source

- https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/index.md
- https://developers.cloudflare.com/workers/configuration/cron-triggers/index.md
- https://developers.cloudflare.com/workers/platform/limits/index.md

### Implications for Clearbox / spec corrections

- Two crons fit the Free limit only if the account has at most 3 others (check the existing Workers).
- The nightly job (calibration over 500 labels plus TTL purge) must fit **10 ms CPU** and 50 external / 1,000 internal subrequests in one invocation; push heavy work into a Workflow instance started from the cron, and purge in bounded batches (`DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT 1000)`).
- Option: Workflow `schedules` could replace Worker crons without consuming the 5-per-account Worker cron quota; Free availability unverified.

---

## 4. D1

### Verified facts

- Worker API: `env.DB.prepare(sql).bind(...values)`; statement methods `run()` (returns `D1Result` with `results`, `success`, `meta`), `first(column?)` (row or `null`), `raw({ columnNames? })` (arrays). The current prepared-statement page documents `bind`, `run`, `raw`, `first` (no `all()` section; use `run()`). `env.DB.batch(stmts)` returns `D1Result[]` in order. `env.DB.exec(sql)` runs unprepared SQL. `withSession()` for read replication.
- `meta` fields: `duration`, `changes`, `last_row_id`, `changed_db`, `size_after`, **`rows_read`**, **`rows_written`**, `served_by_region`, `served_by_primary`, `timings.sql_duration_ms`, `total_attempts`.
- **Batch semantics:** "Batched statements are SQL transactions. If a statement in the sequence fails, ... it aborts or rolls back the entire sequence." Statements run sequentially. Per-statement limits apply inside a batch; the whole batch must finish within 30 s.
- Limits: **100 bound parameters per query**, **100 KB per SQL statement**, 2 MB max row/string/BLOB, 100 columns per table, 32 args per SQL function, 50-byte `LIKE`/`GLOB` patterns, 30 s query duration.
- Free: **10 databases per account**, **500 MB per database**, 5 GB per account, Time Travel 7 days, 5M rows read and 100k rows written per day (reset 00:00 UTC; queries error once exceeded). D1 limits page: "Queries per Worker invocation: 50 (Free)"; Workers limits page: 1,000 subrequests to Cloudflare services on Free (conflict, see C5). Max 6 simultaneous connections.
- Row counting: rows read = rows scanned; rows written = rows inserted/updated/deleted; **each index on a written column adds at least one written row**; DDL counts too; dashboard/CLI queries count.
- Jurisdiction: set only at creation, immutable. `eu`, `us`, `fedramp`. Overrides location hint. Workers anywhere can still access it.
- Migrations: `.sql` files in `migrations/`, named `NNNN_<message>.sql` (verified locally), applied in numeric order, tracked in table `d1_migrations`. `cf d1 migrations apply` is "wire-compatible with `wrangler d1 migrations apply`: same table shape, same --dir-relative recorded names, same ordering".

### Exact snippets

```ts
const res = await env.DB.batch([
  env.DB.prepare("INSERT INTO messages (id, account_id, provider_msg_id, sender, sender_domain, subject, snippet, signals_json, received_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(account_id, provider_msg_id) DO NOTHING").bind(/* 10 values */),
  env.DB.prepare("UPDATE budget SET rows_written = rows_written + ?1 WHERE date = ?2").bind(n, today),
]);
const written = res.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0);
```

Multi-row `INSERT ... VALUES (...), (...)` must keep total placeholders at 100 or fewer (10 columns means at most 10 rows per statement). Prefer one prepared statement per row inside a single `batch()`.

```sh
cf d1 create --name clearbox --jurisdiction eu
```

### Source

- https://developers.cloudflare.com/d1/worker-api/d1-database/index.md
- https://developers.cloudflare.com/d1/worker-api/prepared-statements/index.md
- https://developers.cloudflare.com/d1/worker-api/return-object/index.md
- https://developers.cloudflare.com/d1/platform/limits/index.md
- https://developers.cloudflare.com/d1/platform/pricing/index.md
- https://developers.cloudflare.com/d1/reference/migrations/index.md
- https://developers.cloudflare.com/d1/configuration/data-location/index.md

### Implications for Clearbox / spec corrections

- C3: add a storage guard: track `meta.size_after` and stop backfill near 450 MB.
- C4: with indexes `(account_id, provider_msg_id)` unique, `(account_id, sender_domain)`, `expires_at` on messages and `(account_id, status)` on suggestions, one email costs roughly 4 (message) + 2 (suggestion) + amortized budget/prior updates, about 6-7 rows written, plus about 4 when purged. Use `meta.rows_written` for the budget instead of estimates. Revised backfill capacity: about 9-12k emails/day under a 90k write budget once purges start.
- Batch atomicity is guaranteed, so "write messages and suggestions, update the budget (1 db.batch)" is transactional as the spec assumes.
- C5: assume at most 50 D1 calls per invocation on Free and batch aggressively (a batch is one call).

---

## 5. Workers Static Assets

### Verified facts

- SPA: `not_found_handling: "single-page-application"` (cf: `notFoundHandling`) serves `/index.html` with 200 for unmatched paths.
- Compatibility date >= 2025-04-01: navigation requests (`Sec-Fetch-Mode: navigate`) do not invoke the Worker. Using `run_worker_first` as an **array** switches to explicit routing and disables the navigate heuristic, so `/oauth/*` navigations reach the Worker.
- `run_worker_first`: `true`, `false`, or up to 100 glob patterns; `*` deep match; `!` negative patterns take precedence; order irrelevant.
- Worker can serve assets via the binding: `env.ASSETS.fetch(request)` (cf: `ASSETS: bindings.assets()`).
- `_headers` file (in Vite `public/`, copied to the build) sets headers on **asset** responses, including the SPA `index.html` fallback. It is **not** applied to responses generated by Worker code. Limits: 100 rules, 2,000 chars per line. Vite plugin can apply `_headers` in dev with `experimental.headersAndRedirectsDevModeSupport`.
- Default asset headers: `Cache-Control: public, max-age=0, must-revalidate`, `ETag`, `Content-Type`.
- Billing: asset requests are free and unlimited; requests matching `run_worker_first` always invoke the Worker and count toward the 100k/day Free limit (over the limit they get **429**).
- Free: 20,000 files per version, 25 MiB per file.

### Exact snippets

`public/_headers`:

```txt
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: interest-cohort=()
```

Worker responses (`/api/*`, `/oauth/*`): set headers in Hono, for example `app.use("*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }))` from `hono/secure-headers`.

### Source

- https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/index.md
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/index.md
- https://developers.cloudflare.com/workers/static-assets/binding/index.md
- https://developers.cloudflare.com/workers/static-assets/headers/index.md
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/index.md
- https://developers.cloudflare.com/workers/platform/limits/index.md

### Implications for Clearbox / spec corrections

- Strict CSP is achievable for the built SPA via `_headers`. Vite dev injects inline scripts (React refresh), so do not enable the strict CSP in dev, or allow it only in production builds. Tailwind (build-time CSS) needs no `'unsafe-inline'`.
- Access still gates asset requests (the Access check happens before the Worker and assets), so the SPA shell is never served to unauthenticated users once the Worker-level Access app exists.

---

## 6. Cloudflare Access

### Verified facts

- Prerequisite: Zero Trust enabled. Onboarding requires choosing a team name and "selecting a subscription plan and entering your payment details. If you chose the Zero Trust Free plan, this step is still needed but you will not be charged." The owner's account already has a Zero Trust org (`<team>.cloudflareaccess.com`).
- **Protect one Worker** (dashboard): Workers & Pages > select Worker > **Access** tab > **Protect this Worker behind Access** > choose **Previews only** or **All traffic** > choose an authentication policy > **Apply Access**. This protects all of the Worker's hostnames: routes, Custom Domains, **`workers.dev`**, and previews. Dashboard policy options are "Cloudflare account" or "Email domain"; a single-email policy needs editing in Zero Trust or the API.
- API equivalent: self-hosted app with destination `{ "type": "worker", "worker_id": "<id>" }` (`preview_worker` for previews only). Verified request shape with `cf zero-trust access applications create --dry-run --body ...`.
- Hierarchy: hostname/path apps > Worker-level > account-level "Protect all Workers".
- Worker-level Access does not support WebSockets (not needed).
- `ctx.access.getIdentity()` exists but **is not passed to Workers that have Static Assets** (internal router). Clearbox must validate the JWT itself.
- JWT: header **`Cf-Access-Jwt-Assertion`** (preferred); browsers also get cookie **`CF_Authorization`** (not guaranteed to be forwarded; do not rely on it). Keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (`keys` JWKS, `public_cert`, `public_certs`). Alg **RS256**, match `kid`. Keys rotate every 6 weeks; previous key valid 7 more days; do not hard-code keys.
- Claims (identity login): `aud` (**array** of AUD tags), `email`, `exp`, `iat`, `nbf`, `iss` (`https://<team>.cloudflareaccess.com`), `type` (`app`), `identity_nonce`, `sub`, `country`. Service-token JWTs carry no `email` (use `common_name`).
- AUD tag: Zero Trust > Access controls > Applications > Configure > Additional settings. Stable unless the app is recreated.
- Library: official Workers example uses **`jose`** (`createRemoteJWKSet` + `jwtVerify`). Current `jose` is 6.2.12.
- Local dev simulation of `ctx.access` exists (`access.dev` in config), but is irrelevant because Clearbox cannot use `ctx.access`.

### Exact snippets

Access app for the Clearbox Worker (single owner email), via `cf`:

```sh
cf zero-trust access applications create --body '{
  "type": "self_hosted",
  "name": "Clearbox",
  "destinations": [{ "type": "worker", "worker_id": "<CLEARBOX_WORKER_ID>" }],
  "policies": [{ "decision": "allow", "include": [{ "email": { "email": "<OWNER_EMAIL>" } }] }]
}'
```

(`<CLEARBOX_WORKER_ID>` from `cf workers list`. The response contains `aud`, which becomes the `ACCESS_AUD` secret.)

Verification in the Worker:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksFor: string | undefined;

export async function verifyAccess(req: Request, env: Env): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) throw new Error("access-misconfigured");
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("missing-jwt");
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  if (!jwks || jwksFor !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksFor = issuer;
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"] });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (email !== env.OWNER_EMAIL.toLowerCase()) throw new Error("wrong-email");
  return email;
}
```

`jwtVerify` checks `exp`/`nbf` and accepts an `aud` array containing `ACCESS_AUD`.

### Source

- https://developers.cloudflare.com/workers/configuration/cloudflare-access/index.md
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/index.md
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/index.md
- https://developers.cloudflare.com/cloudflare-one/setup/index.md

### Implications for Clearbox / spec corrections

- C11: the spec's design is correct; add "`ctx.access` cannot be used because of Static Assets" to the rationale.
- Set `ACCESS_TEAM_DOMAIN` as a full origin (`https://<team>.cloudflareaccess.com`) because it is also the `iss` value.
- JWKS fetch is one external subrequest per isolate cold start; cache the `createRemoteJWKSet` instance in module scope as above.
- Choose "All traffic" (not "Previews only") so `workers.dev` is protected; keep `previewUrls: false` anyway.
- OAuth callbacks from Google/Microsoft land on the protected hostname in the same browser session, so the `CF_Authorization` cookie lets them through; no Access bypass for `/oauth/*` is needed.

---

## 7. Testing (Workers Vitest integration)

### Verified facts

- Package renamed: **`@cloudflare/vitest-plugin`** replaces `@cloudflare/vitest-pool-workers` ("The package API and Vitest configuration are unchanged"; codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`). Latest **1.4.2** (2026-10-14). Peer: **`vitest ^4.1.0 || ^5.0.0`** (Vitest latest 5.0.4). The old `@cloudflare/vitest-pool-workers@0.23.0` only supports Vitest ^4.1.
- Config: `plugins: [cloudflareTest(options)]` in `vitest.config.ts` (Vite plugin, not a `pool` string). Options: `main`, `miniflare` (bindings, d1Databases, workflows, ...), `wrangler: { configPath, environment }`, and **`experimental: { newConfig: true | { configPath } }`** which loads **`cloudflare.config.ts`** instead of a Wrangler file ("Cannot be combined with `wrangler`"; config functions get `ctx.mode = "test"`). Verified in the 1.4.2 source (`src/pool/new-config.ts`). Not yet in the public docs.
- No Wrangler config file is required. The package depends on `wrangler@4.151.0` internally (installed transitively); nothing to configure.
- The runner forces Node.js compat in tests regardless of flags.
- Exports from `@cloudflare/vitest-plugin` (1.4.2): `cloudflareTest`, `readD1Migrations`, `buildPagesASSETSBinding`, `D1Migration` type. (Docs mention `@cloudflare/vitest-plugin/config`, but the 1.4.2 `package.json` exports only `.` and `./types`; import from the root.)
- Test-side modules: `import { env, exports } from "cloudflare:workers"` (`exports.default.fetch(...)` replaces `SELF`; it does not serve assets) and `cloudflare:test` (`createExecutionContext`, `waitOnExecutionContext`, `createScheduledController`, `applyD1Migrations(db, migrations, table?)`, `introspectWorkflowInstance`, `introspectWorkflow`). Types: `"types": ["@cloudflare/vitest-plugin/types"]` and `declare module "cloudflare:workers" { interface ProvidedEnv extends Env {} }`.
- Workflows testing: `introspectWorkflowInstance(env.WF, id)` / `introspectWorkflow(env.WF)` with modifiers `disableSleeps`, `disableRetryDelays`, `mockStepResult`, `mockStepError(step, err, times?)`, `forceStepTimeout`, `mockEvent`, `forceEventTimeout`; introspectors expose `waitForStepResult`, `waitForStatus`, `getOutput`, `getError`, `dispose` (use `await using`). Requires an **`env` binding** (throws for `ctx.exports` Workflows; add a `miniflare.workflows` test binding if only exported).
- Outbound mocking: `fetchMock` is gone. Use **`msw@^3` (3.0.3) + `@msw/cloudflare` (0.2.0)**: `setupNetwork()`, `network.enable()/resetHandlers()/disable()`, `network.use(http.get(...))`.

### Exact snippets

`vitest.config.ts`:

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
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
          ENVIRONMENT: "test",
          OWNER_EMAIL: "owner@example.test",
          ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
          ACCESS_AUD: "test-aud",
          TOKEN_ENC_KEY: "<base64 test key>",
          STATE_SIGNING_KEY: "<base64 test key>",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts", "./test/network-setup.ts"] },
});
```

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/network-setup.ts`:

```ts
import { setupNetwork } from "@msw/cloudflare";
import { afterAll, afterEach, beforeAll } from "vitest";

export const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
```

Dev dependencies: `pnpm add -D vitest@^5 @cloudflare/vitest-plugin msw@^3 @msw/cloudflare`.

### Source

- https://developers.cloudflare.com/workers/testing/vitest-integration/index.md
- https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/index.md
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/index.md
- https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/index.md
- https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/index.md
- npm: `@cloudflare/vitest-plugin@1.4.2` (`package.json`, `dist/pool/index.d.mts`, source map `src/pool/new-config.ts`)

### Implications for Clearbox / spec corrections

- C9: update the spec's testing table: `@cloudflare/vitest-plugin` + `experimental.newConfig`, MSW 3 via `@msw/cloudflare` (the spec already plans MSW for providers; reuse it in the Worker tests).
- `experimental.newConfig` is experimental; if it breaks, the documented fallback is passing everything through `miniflare` options (`d1Databases`, `workflows`, `bindings`) with `main: "./src/worker/index.ts"`, still without a Wrangler file.
- Whether MSW intercepts `fetch` inside Workflow steps (same isolate as the main Worker in tests) is not documented; for Workflow tests prefer `mockStepResult` / `mockStepError` plus `FakeEngine`.
- Free-tier CPU benchmark: Miniflare does not enforce the 10 ms limit; measure with `performance.now()` around pure code in Node, and use `cf workers check` for startup cost.

---

## 8. Smart Placement

### Verified facts

- Config: cf `placement: { mode: "smart" }`; Wrangler `"placement": { "mode": "smart" }`. Also Placement Hints: `{ region: "azure:<region>" | "aws:..." | "gcp:..." }`, `{ host }` (experimental), `{ hostname }`.
- "Smart Placement is available on all Workers plans." Analysis takes up to 15 minutes and needs consistent traffic from multiple locations.
- Only affects the **`fetch` handler**; not RPC, not named entrypoints. Static assets are always served nearest the user. With `run_worker_first`, the whole Worker is placed as one unit (docs caution).
- `cf-placement` response header shows `remote-XXX` / `local-XXX`.

### Source

- https://developers.cloudflare.com/workers/configuration/placement/index.md
- https://developers.cloudflare.com/workers/static-assets/binding/index.md

### Implications for Clearbox / spec corrections

- C6: free, harmless, but low value: the heavy traffic (Graph/Gmail/Foundry) runs in Workflow steps and cron, which placement does not affect. A single-owner app may never generate enough traffic for analysis. Keep `mode: "smart"` or drop it; an explicit `region: "azure:swedencentral"` hint is an alternative for the API path (D1 EU and Foundry Sweden Central are both in Europe).

---

## 9. Workers Free limits (re-verified)

### Verified facts (Workers limits page, updated 2026-10-12)

| Limit | Free |
|---|---|
| Requests | 100,000/day (reset 00:00 UTC; Error 1027 after). Workflow executions share this. |
| CPU per HTTP request | 10 ms |
| CPU per Cron Trigger | 10 ms |
| CPU per Workflow step | 10 ms |
| Memory | 128 MB per isolate |
| Subrequests (external `fetch`) | **50 per invocation** |
| Subrequests to Cloudflare services (D1, KV, R2, ...) | **1,000 per invocation** (D1 limits page still says 50 D1 queries per invocation on Free) |
| Simultaneous connections waiting for headers | 6 (D1: "up to six connections simultaneously") |
| Cron Triggers | **5 per account** |
| Env vars + secrets | 64 per Worker, 5 KB each |
| Worker size | 64 MiB uncompressed; startup 1 s |
| `waitUntil` after response | up to 30 s |
| Workers Logs | 200,000 events/day, 3-day retention |

Subrequest definition: "any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1." Redirect hops count separately. Binding calls (D1) count, against the internal-services bucket.

### Source

- https://developers.cloudflare.com/workers/platform/limits/index.md
- https://developers.cloudflare.com/d1/platform/limits/index.md
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/index.md

### Implications for Clearbox / spec corrections

- The spec's numbers (10 ms, 50 subrequests, 100k/day, 5 crons) are right; add the external vs internal split (C5), the Workflows-per-instance subrequest scope (C1), and the 64 vars limit (Clearbox uses about 17).
- "At most 6 concurrent Decision calls" matches the 6-connection limit (excess connections queue rather than fail).

---

## 10. Hono on Workers

### Verified facts

- Current version: **`hono@4.13.13`** (npm latest).
- Typing: `const app = new Hono<{ Bindings: Env }>()`; bindings via `c.env`.
- Combine with other handlers: `export default { fetch: app.fetch, scheduled: ... }`.
- Assets: use Workers Static Assets (Hono docs) and `run_worker_first` patterns so only `/api/*` and `/oauth/*` reach Hono; everything else is served from assets with SPA fallback. Cloudflare's official full-stack template is Hono + React + Vite (`cloudflare/templates/vite-react-template`).

### Exact snippet

```ts
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
export { ScanWorkflow } from "./workflows/scan.ts";

const app = new Hono<{ Bindings: Env }>();
app.use("*", secureHeaders());
app.use("/api/*", accessGuard);
app.get("/api/health", (c) => c.json({ ok: true }));
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
```

### Source

- https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/index.md
- https://github.com/honojs/website/blob/main/docs/getting-started/cloudflare-workers.md
- `npm view hono version`

### Implications for Clearbox / spec corrections

- No changes. `Env` comes from `.cloudflare/types/index.d.ts` generated by `cf workers types` / the Vite plugin.

---

## 11. WebCrypto in Workers

### Verified facts

- Global `crypto.subtle`, `crypto.randomUUID()` (v4), `crypto.getRandomValues()`, plus non-standard `crypto.subtle.timingSafeEqual(a, b)` and `crypto.DigestStream`.
- Supported: **AES-GCM** encrypt/decrypt/generate/import/export/wrap; **HMAC** sign/verify; **RSASSA-PKCS1-v1_5** sign/verify (RS256), RSA-PSS, ECDSA, Ed25519; **SHA-256** digest; HKDF, PBKDF2.
- No compatibility flag needed for WebCrypto. Node's `node:crypto` is also available (Node compat is on by default for compat dates >= 2026-08-04).
- Worker secrets can also be uploaded as `secret_key` (a WebCrypto `CryptoKey` binding with `--format raw|pkcs8|spki|jwk`, `--key-base64`, `--usages`) per `cf workers secrets update --help`.

### Exact snippet

```ts
const key = await crypto.subtle.importKey("raw", base64ToBytes(env.TOKEN_ENC_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(accountId) }, key, plaintext);

const mac = await crypto.subtle.importKey("raw", base64ToBytes(env.STATE_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const ok = await crypto.subtle.verify("HMAC", mac, signature, data);
```

### Source

- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/index.md
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/index.md
- `cf workers secrets update --help`

### Implications for Clearbox / spec corrections

- Spec controls (AES-256-GCM with 96-bit IV and AAD, HMAC state, PKCE S256 via SHA-256) are all supported natively. Use `crypto.subtle.verify` for HMAC checks (constant-time) or `timingSafeEqual`.
- Optional hardening: store `TOKEN_ENC_KEY` as a `secret_key` binding (non-extractable `CryptoKey`). Local dev and test parity for `secret_key` is unverified, so keep `secret_text` for v1.

---

## Unresolved questions (need a spike or owner input)

1. **Workflows Free subrequest scope:** per instance (docs table) vs per invocation/wake-up. Decide by spike: one Free instance with 3 steps of 30 external fetches each. Until then, design for per instance (C1).
2. **3,000 steps/day on Free:** behavior when exceeded (throttle, queue, or error) is undocumented.
3. **D1 queries per invocation on Free:** 50 (D1 page) vs 1,000 internal subrequests (Workers page).
4. Whether Workflow `schedules` work on Workers Free and whether they share the 5-cron account limit.
5. `cf workers secrets bulk` request body shape per secret (the API schema in `cf schema` lists no fields); `cf deploy --secrets-file` is the documented path. Also confirm whether `--secrets-file` keeps secrets not listed in the file.
6. Confirm at scaffolding that `cf dev` (Vite plugin 2.0 beta) keys the local D1 by the configured `id`, so `cf d1 migrations apply <id> --local --persist-to .cloudflare/state` targets the same file.
7. Cron Triggers already used by other Workers on the account (5 per account on Free).
