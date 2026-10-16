# Clearbox Web UI (plan 05 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Clearbox single-page app (Review with the one-click Clean up flow, Insights, Activity, Accounts, Rules, first-run Setup, error and offline states) in `app/src/web/`, served as Workers Static Assets from the same Vite project as the Worker, replacing plan 03's placeholder SPA entry.

**Architecture:** A client-rendered React 19 app on the React Router 8 data router. All server state goes through TanStack Query hooks over one typed fetch client (`api/client.ts`) that validates every response with zod, adds the CSRF header to every mutation and publishes session errors (401, 403, `access_misconfigured`) to a store the root layout reads. Cross-page behavior lives in small providers mounted once in the root layout (live announcer, toasts, undo stack, the Clean up state machine, hotkeys), so a Clean up run survives navigation. Every visual value comes from the Tailwind v4 `@theme` block in `styles.css`; dynamic geometry uses `--cb-*` custom properties set through `cssVars()` so the production CSP (`style-src 'self'`) holds.

**Tech Stack:** React 19.3.1, React Router 8.4.0, TanStack Query 5.104.3, Tailwind CSS 4.3.3 (`@tailwindcss/vite`), Vite 8.3.4, zod 4.6.7, TypeScript 6.0.3 strict; tests: Vitest 5.0.4 (happy-dom 21.0.1), Testing Library React 16.3.3, `@testing-library/user-event` 14.6.8, MSW 3.0.3 (`msw/node`), axe-core 4.14.0.

## Global Constraints

- Sources of truth: `docs/superpowers/specs/2026-10-15-clearbox-ui-design.md` (visuals, copy, behavior; "UI spec") and `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` (API shapes, layout, versions, conventions; "contracts"), including contracts section 12 (rev 2.1, A1 to A6 accepted). UI spec wins for visuals and copy, contracts win for API shapes. Every conflict is listed in "Contract issues and decisions".
- Exact versions, no ranges: react and react-dom 19.3.1, react-router 8.4.0, @tanstack/react-query 5.104.3, tailwindcss and @tailwindcss/vite 4.3.3, vite 8.3.4, zod 4.6.7, typescript 6.0.3, vitest 5.0.4, happy-dom 21.0.1, @testing-library/react 16.3.3, @testing-library/dom 10.4.2, msw 3.0.3, plus the two test dependencies this plan adds (contracts 12.4, verified with `npm view` on 2026-10-15): `axe-core` 4.14.0 and `@testing-library/user-event` 14.6.8. No other dependency (no UI kit, icon library, date library, CSS-in-JS, jest-dom).
- No em dashes (U+2014) anywhere: code, comments, test names, UI copy, commit messages. En dashes only in numeric ranges ("91–99%").
- No colored left or top edge stripes on any surface. Selection is `bg-surface-selected`; keyboard focus is a 2px `focus` outline.
- Email content (sender names, subjects, snippets, reasons) renders as React text nodes only. `dangerouslySetInnerHTML`, `innerHTML` and `insertAdjacentHTML` are banned.
- The Clean up threshold tau is always read from the API (`CleanupPreview.threshold`, then `QueueSummary.tauDelete`, then `MeResponse.tauDelete`). Never a constant in `src/web`. Tests read it from the fixture state.
- Confidence is always a floored percentage plus a band word (`toPercent`, `bandFor`); verdicts always an icon plus a word; account status always a dot plus text.
- CSP: no inline `<script>` or `<style>`, no `style=""` in `index.html`; every React `style` prop is a direct `cssVars({...})` call with `--cb-*` names only (ESLint-enforced, test-enforced). SVG uses presentation attributes only.
- ESM only, relative imports with explicit `.ts`/`.tsx` extensions, `import type` for type-only imports, named exports only (no default exports in `src/web`), strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), no `any`, no `enum`, no non-null assertions outside tests.
- Files: React components `PascalCase.tsx`, other modules kebab-case; each file under 300 lines.
- `src/web/**` must not import `src/worker/**`, `hono` or `cloudflare:*`; it imports runtime values only from `src/shared/api.ts` (`CSRF_HEADER`, `CSRF_VALUE`, `PutPolicyBodySchema`, `PatchSenderBodySchema`) and types only from `@clearbox/core`.
- Tests: `app/test/web/**/*.test.{ts,tsx}`, Vitest in happy-dom, synthetic data only (`example.com`, `example.net`, `*.example`, `*.test` domains; owner `owner@example.test`), time injected or faked, every screen gets an axe pass (WCAG 2.0/2.1/2.2 A and AA tags; `color-contrast` and `target-size` disabled because happy-dom has no layout, covered by the token test and manual QA).
- Run all commands from the repository root unless a step says otherwise. Do not edit contracts, the UI spec, the design spec or `PRODUCT.md`. Report contract issues to the lead instead.
- `cf workers types` and `cf build` (inside `typecheck`, `build`, `deploy:cf`) evaluate `app/cloudflare.config.ts` in production mode, which throws without a D1 id (contracts 3.2). Local typecheck and build commands therefore run with `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000` (the public local id; plan 06 CI does the same). Never write that id into `app/clearbox.local.json`.

---

## Contract issues and decisions

| # | Issue | Decision in this plan |
|---|---|---|
| W1 | Contracts 7 defines response shapes only as TypeScript interfaces, but this plan must validate responses with zod. | `src/web/api/schemas.ts` declares one zod schema per response, each written as `z.object(...) satisfies z.ZodType<ContractType>` so a contract change breaks `tsc`. Fields the UI never reads (`ItemSignals`, `Distribution`) are validated as plain objects. Unknown extra fields are stripped, missing fields fail with `ApiError(status, "invalid_response")`. |
| W2 | UI spec 8.3 gives `apiGet<T>(path, params)` and `ApiError.code: ApiErrorCode \| "network"`. | `apiGet(path, schema, params?)` and `apiSend(method, path, schema, body?)` take the zod schema; `ApiError.code` adds `"invalid_response"` (shown as the generic error toast and reported with `reportBug`). |
| W3 | UI spec 8.2 names `state/useSelection.ts` and `state/useNow.ts`; contracts 11 says non-component modules are kebab-case. | Contracts 11 wins: `state/use-selection.ts`, `state/use-now.ts`, and every other hook module is kebab-case. Provider components stay PascalCase (`CleanupProvider.tsx`). |
| W4 | UI spec 8.2 lists `lib/`, `state/` and component subfolders that contracts 1.1 does not list (contracts 1.1 lets the UI plan own `pages/` and `components/`). | Created as specified, plus `pages/review/` (Review hooks), `pages/gallery/`, `api/schemas.ts`, `api/endpoints.ts`, `api/query-client.ts`, `api/group-actions.ts`, `lib/copy-actions.ts`, `lib/banners.ts`, `lib/activity.ts`, `lib/rules-draft.ts`, `lib/oauth-errors.ts`, `lib/links.ts`, `lib/report.ts`. Lead: add `src/web/lib/`, `src/web/state/` and these files to contracts 1.1. |
| W5 | Contracts 3.8 sets `no-console: error` (plan 01 config), but UI spec 5.2.2 and 8.4 require `console.error` for unexpected errors and CSP violations. | `lib/report.ts` owns the only `console.error` call (`reportBug`, with one `eslint-disable-next-line no-console` comment); the CSP listener calls `reportBug`. |
| W6 | UI spec 8.4 and 8.5 require ESLint rules (`style` only via `cssVars`, ban on `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`) in `eslint.config.js`, a plan 01 file. | Task 7 Step 6 appends one config block for `app/src/web/**` to `eslint.config.js` (exact code given). Flagged in that task's Interfaces. |
| W7 | Contracts 12.4 asks for `axe-core` and `@testing-library/user-event` as app dev dependencies. | Plan 03 Task 1 already declares both in `app/package.json` (`axe-core` 4.14.0, `@testing-library/user-event` 14.6.8, verified with `npm view` on 2026-10-15), together with `happy-dom` 21.0.1, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2 and `msw` 3.0.3. This plan does not edit the manifest; Task 1 Step 1 only verifies it. Contracts 2 lists them (rev 2.2). |
| W8 | `app/index.html`, `src/web/main.tsx`, `src/web/styles.css`, `test/web/setup.ts` and `test/web/placeholder.test.tsx` are plan 03 placeholders. | Task 1 replaces `test/web/setup.ts`; Task 2 replaces `index.html` (adds `lang="en"`, favicon link, `color-scheme` meta; still no inline script or style) and `styles.css`; Task 25 replaces `main.tsx` and deletes `placeholder.test.tsx`. Plan 03's `public/favicon.svg` is kept. |
| W9 | `app/test/web/setup.ts` is named by `vitest.web.config.ts` (plan 03) but its content is not specified. | Task 1 owns it (create, or replace if plan 03 created a stub). `vitest.web.config.ts` is not changed. |
| W10 | UI spec 3.5 mounts `ToastProvider`, `UndoStackProvider`, `CleanupProvider`, `HotkeysProvider` inside AppShell, but `/setup` has no AppShell and still needs toasts, session errors and the G sequences. | They mount once in `pages/RootLayout.tsx` (a pathless root route), above both AppShell and Setup. AppShell keeps everything visual (sidebar, main, banners). Same behavior, one instance. |
| W11 | UI spec 4.18 `ToastInput` has no field for the "action running" state ("Undoing…" with a spinner). | `ToastInput.busy?: boolean`; `busy` hides the action and close buttons and shows the spinner. |
| W12 | UI spec 4.16 ConfirmBar props have no slot for the "Reconnect" button of the `account_inactive` partial outcome. | `ConfirmBarProps.extraAction?: { label: string; onClick: () => void }`, rendered before "Try again". |
| W13 | `SenderEntrySchema` and `PolicySchema` live in `@clearbox/core`; the SPA must not import core runtime code (UI spec 8.3). | The SPA reads them through the shared request schemas: `PatchSenderBodySchema.shape.entry` (sender entries) and `PutPolicyBodySchema.shape.policy` (policy responses). Record words use a local `z.string().trim().toLowerCase().min(2).max(40)` that mirrors contracts 4.6. |
| W14 | UI spec setup-error banners link to "the repository's `docs/setup-*.md`", but no repository URL exists in contracts. | `lib/links.ts` exports `DOCS_BASE_URL = "https://github.com/ShinyQ/Clearbox/blob/main/docs/"`. Confirmed by the lead: the repository is ShinyQ/Clearbox. |
| W15 | UI spec 6.6 says a group row is "removed" optimistically and 4.8 says it "exits" (fade, then collapse) after success. | The row enters the exiting state immediately (fade 200 ms, then collapse 200 ms via `max-height`) while the request runs; it leaves the cache after 400 ms (0 ms with reduced motion). Errors restore the snapshot. `rowExitDelayMs()` returns 0 under `prefers-reduced-motion: reduce` (UI spec 7.6 test). |
| W16 | UI spec copy has no singular for some strings ("All 248 are in Clean up."). | Singular forms use natural English: "The 1 email is in Clean up.", "1 email is left for you to check.", "Clean up 1 email in 1 sender group?". All other copy is verbatim. |
| W17 | UI spec 4.8 row accessible name gives only the in-Clean-up example. | Non-members say "left for you" (Trash and Archive below tau, Check) or "not in Clean up" (Keep). |
| W18 | Seeded data for manual QA needs a way to load rows into local D1; contracts only shows `cf d1 migrations apply`. | Task 26 provides `app/test/web/fixtures/dev-seed.sql` (synthetic) and applies it with `cf d1 execute ... --local --persist-to .cloudflare/state --file`, falling back to `sqlite3` on the persisted file if that subcommand is missing. The Clean up run cannot reach a real mailbox with seeded tokens, so its visual states are checked in `/dev/components`. |
| W19 | Formatting examples in UI spec 4.0 ("12 Oct", "Sun 12 Oct, 18:40", "07:00") match the `en-GB` locale although the spec says "examples use en-US". | Formatters use the browser locale and time zone in production; tests call `configureFormat({ locale: "en-GB", timeZone: "UTC" })` so expected strings match the spec text. Current ICU writes September as "Sept" in en-GB, so tests that need a month use October dates or compute labels with `formatDayMonth`. |
| W20 | A4 `inboxEstimate` gives a total, but the catch-up percentage formula is not specified. | `catchUp = min(0.99, messagesIngested / inboxEstimate)` while `backfillDone` is false; remaining `= max(0, inboxEstimate - messagesIngested)`. Null estimate shows "Sorting". |
| W21 | The task brief says a 401 from Access should trigger a full reload; UI spec 5.9 shows a "Your session expired" page whose button reloads. Behind Access an expired session can also surface as a redirect to the Access login, which `fetch` cannot follow cross-origin. | UI spec wins: any 401, and any opaque redirect (the client fetches with `redirect: "manual"`), publishes `unauthenticated`; the root layout shows the session-expired page and "Sign in again" runs `window.location.reload()` (full reload, Access re-authenticates). No automatic reload, so a misconfigured Access app cannot cause a reload loop. |
| W22 | UI spec 5.2.2 lists `undoing` and `undone` as Clean up machine states, but 5.2.2 also returns the machine to `idle` 0 ms after the done toast, and 6.8 routes every Undo (toast button and `mod+Z`) through the undo stack. | Undo of a Clean up run is handled by the undo stack only (same API calls newest batch first, same "Undoing…" and "Restored …" copy); the machine has no `undoing`/`undone` states. A partial run stays in `partial` while its Undo runs from the toast. |
| W23 | UI spec 4.7 says the list shows "EmptyState variant `panel`" in the list column; 4.20 defines the `inline` variant for exactly that place. | `inline` (no second border inside the work area). |
| W24 | UI spec 4.31 makes the chart `role="img"` and also makes every bar focusable; focusable children inside `role="img"` are presentational (axe `nested-interactive`). | The chart is `role="group"` with the same `aria-label`; bars stay focusable with their own labels; the visually hidden table follows. |
| W25 | UI spec 4.16 names the confirm button only for Clean up ("Clean up"). | Confirm all keeps uses "Confirm" on the white button. |

## Upstream surfaces (reconciled against plans 01, 03 and 04)

| From | Surface | Verified shape | Used by |
|---|---|---|---|
| plan 03 | `app/src/shared/api.ts` | Exports every type and schema of contracts 7 by its contract name, including A1 `QueueSummary.groupsByAction`, A2 `CleanupPreview.groupsLeft`, A3 `Insights.weekly`, A4 `AccountSync.inboxEstimate`, A6 `SenderGroup.latestSubject`. | everything under `src/web/api` |
| plan 03 | every REST route in contracts 7.3 except scan | Behaves per contracts 7, error envelope per 7.2, CSRF per 7.1. | `api/endpoints.ts` |
| plan 04 | `POST /api/accounts/:id/scan` | Returns `TickReport`; errors 404, 409 `account_busy` (with `retryAt`), 409 `account_inactive`, 429 `budget_exhausted`. | `pages/review/use-scan-now.ts`, Accounts |
| plan 03 Task 1 | `app/vite.config.ts`, `app/vitest.web.config.ts` (`include: ["test/web/**/*.test.{ts,tsx}"]`, `environment: "happy-dom"`, `setupFiles: ["test/web/setup.ts"]`), `app/tsconfig.web.json` (includes `src/web`, `src/shared`, `test/web`; DOM libs; `jsx: "react-jsx"`; `types: ["vite/client"]`), `app/package.json` scripts `dev`, `build`, `test:web`, `typecheck` and every SPA dependency | Exactly contracts 3.3, 3.5, 3.6, 1.3. happy-dom's default URL is `http://localhost:3000`. `cf build` writes to `app/.cloudflare/output/v0/`. | all tasks |
| plan 03 Task 1 | placeholders `app/index.html`, `src/web/main.tsx`, `src/web/styles.css`, `test/web/setup.ts`, `test/web/placeholder.test.tsx`, `public/favicon.svg` | Replaced or deleted by Tasks 1, 2 and 25 (W8); favicon kept. | Tasks 1, 2, 25 |
| plan 03 Task 9 | OAuth callbacks | `302 /settings/accounts?connected=<accountId>` or `?error=<code>&provider=<kind>`; codes in `OAUTH_CALLBACK_ERRORS`. The SPA route `/settings/accounts` (`OAuthReturn`) forwards to `/accounts` or `/setup` (UI spec 3.5). | Tasks 16, 21, 25 |
| plan 01 Task 1 | `eslint.config.js` | `defineConfig(...)` flat config, last block `["**/test/**", "**/*.config.ts", "**/*.config.js"]`; `"no-console": "error"` (contracts 3.8 rev 2.2). | Task 7 |
| plan 01 | `@clearbox/core` types | `ActionKind`, `SuggestedAction`, `ProviderKind`, `ReasonCode`, `Policy`, `MailCategory` exported as types. | `lib/view-types.ts`, `api/schemas.ts` |

## File Structure

All paths are under `app/` unless marked "repo root". "Create" unless marked.

| Path | Responsibility | Task |
|---|---|---|
| `package.json` (verify only, plan 03 declares the test dependencies) | `axe-core`, `@testing-library/user-event`, `happy-dom`, Testing Library, `msw` | 1 |
| `test/web/setup.ts` (replace), `test/web/msw/*`, `test/web/helpers/axe.ts`, `helpers/viewport.ts` | harness, synthetic fake API, axe and viewport helpers | 1 |
| `index.html` (replace) | SPA entry document, no inline script or style | 2 |
| `src/web/styles.css` | tokens (`@theme`), base, `cb-*` geometry helpers, reduced motion, forced colors (keyframes appended in 8, 9, 14) | 2 |
| `src/web/styles.dark.css` | v1.1 dark token set, NOT imported | 2 |
| `src/web/lib/view-types.ts` | UI unions (`Verdict`, `Band`, `TabKey`, ...) and label maps | 3 |
| `src/web/lib/confidence.ts` | `bandFor`, `toPercent`, `inCleanup`, scale ranges, membership line, band classes | 3 |
| `src/web/lib/format.ts` | Intl formatters (`formatCount`, `relativeAgo`, `activityWhen`, ...) and `configureFormat` | 3 |
| `src/web/lib/avatar.ts` | `fnv1a32`, `avatarColorIndex`, `monogram`, `AVATAR_BG` | 3 |
| `src/web/lib/account-status.ts` | `deriveAccountUiStatus`, catch-up math, provider labels | 3 |
| `src/web/lib/platform.ts` | mac or other, key labels, `aria-keyshortcuts` values | 3 |
| `src/web/lib/report.ts` | `reportBug`, CSP violation listener (the only `console.error`) | 4 |
| `src/web/api/client.ts` | `apiGet`, `apiSend`, `ApiError`, session error and network-failure stores | 4 |
| `src/web/api/schemas.ts` | zod response schemas tied to contract types | 4 |
| `src/web/api/endpoints.ts` | one typed function per REST route | 4 |
| `src/web/api/keys.ts` | query key factory `qk` (UI spec 8.3) | 4 |
| `src/web/api/query-client.ts`, `test/web/helpers/query.tsx` | `createQueryClient` with global defaults (UI spec 6.7), query test wrapper | 5 |
| `src/web/api/queries.ts` | query hooks and polling cadence | 5 |
| `src/web/api/mutations.ts` | mutation hooks with invalidations and optimistic pause | 5 |
| `src/web/api/cleanup.ts` | pure Clean up loop (UI spec 5.2.3) | 6 |
| `src/web/api/group-actions.ts` | pure group approve/override loop (UI spec 6.4) | 6 |
| `src/web/components/ui/*` | primitives: `css-vars.ts`, `icons.tsx`, `Spark`, `VisuallyHidden`, `Kbd`, `Spinner`, `Button`, `Checkbox`, `Toggle`, `TextInput`, `Select` | 7 |
| `eslint.config.js` (modify, repo root) | append the web CSP and text-safety block (W6) | 7 |
| `src/web/components/ui/*`, `src/web/state/use-media-query.ts` | `Banner`, `EmptyState`, `Skeleton`, `ProgressBar`, `Table`, `Tabs`, `Menu`, `Dialog`, `Chip`, `ChipInput`; layout media queries | 8 |
| `src/web/state/LiveAnnouncer.tsx` | app-wide polite live region | 9 |
| `src/web/state/toast-queue.ts`, `state/ToastProvider.tsx`, `components/ui/Toast.tsx` | toast queue rules, timers, region | 9 |
| `src/web/state/UndoStackProvider.tsx` | undo entries, `mod+Z`, undo toasts | 9 |
| `src/web/state/use-now.ts`, `state/use-platform.ts`, `test/web/helpers/core.tsx` | shared 30 s clock, platform hook, core-provider test wrapper | 9 |
| `src/web/state/hotkeys-core.ts`, `state/HotkeysProvider.tsx` | key matching, scopes, priorities, G sequences, single-key toggle | 10 |
| `src/web/components/shell/GSequenceHint.tsx`, `ShortcutHelpDialog.tsx` | hint chip and help dialog | 10 |
| `src/web/components/review/SenderAvatar.tsx`, `VerdictTag.tsx`, `ConfidenceMeter.tsx`, `ConfidenceLabel.tsx`, `ReasonLine.tsx`, `SplitBar.tsx` | verdict and confidence display | 11 |
| `src/web/components/review/SummaryCard.tsx`, `ActionTabs.tsx` | summary hero and tabs | 12 |
| `src/web/state/use-selection.ts`, `components/review/SenderGroupRow.tsx`, `SelectionToolbar.tsx`, `SenderGroupList.tsx` | list, grid semantics, selection | 13 |
| `src/web/state/use-focus-trap.ts`, `components/review/EmailPreviewList.tsx`, `DetailActions.tsx`, `DetailPanel.tsx` | detail panel and sheet focus trap | 14 |
| `src/web/lib/copy.ts`, `state/cleanup-machine.ts`, `state/CleanupProvider.tsx`, `components/review/ConfirmBar.tsx`, `CleanupBar.tsx` | Clean up state machine and bar | 15 |
| `src/web/lib/links.ts`, `lib/oauth-return.ts`, `lib/banners.ts` | docs and sign-out links, OAuth start, app banner matrix | 16 |
| `src/web/state/offline.ts`, `state/use-document-title.ts`, `state/use-route-focus.ts` | offline store, titles, route focus | 16 |
| `src/web/components/shell/*` | `StatusDot`, `AccountStatusItem`, `PageHeader`, `SidebarNav`, `TopBar`, `AppBanners`, `OfflineWatcher`, `AppShell` | 16 |
| `src/web/pages/RootLayout.tsx`, `pages/FullPageError.tsx`, `test/web/helpers/render.tsx` | providers, session gate, error boundary page, app render helper | 16 |
| `src/web/lib/copy-actions.ts`, `src/web/pages/review/use-review-params.ts`, `group-cache.ts`, `use-group-actions.ts`, `use-item-actions.ts`, `use-new-suggestions.ts`, `use-review-hotkeys.ts`, `use-scan-now.ts` | action toast copy and Review interaction hooks | 17 |
| `src/web/pages/review/review-state.ts`, `use-review-controller.ts`, `ReviewWorkArea.tsx`, `pages/ReviewPage.tsx` | Review page | 18 |
| `src/web/components/ui/Panel.tsx`, `components/insights/*`, `pages/InsightsPage.tsx` | Insights | 19 |
| `src/web/lib/activity.ts`, `pages/ActivityPage.tsx` | Activity | 20 |
| `src/web/lib/oauth-errors.ts`, `components/accounts/*`, `pages/AccountsPage.tsx` | Accounts | 21 |
| `src/web/lib/rules-draft.ts`, `components/rules/*`, `pages/RulesPage.tsx` | Rules | 22 |
| `src/web/pages/SetupPage.tsx` | first-run setup | 23 |
| `src/web/pages/ComponentGallery.tsx`, `pages/gallery/*` | dev-only gallery and CSP style audit | 24 |
| `src/web/routes.tsx`, `src/web/main.tsx` (replace), `pages/RootRedirect.tsx`, `pages/OAuthReturn.tsx`, `pages/NotFoundPage.tsx` | router and entry | 25 |
| `test/web/fixtures/dev-seed.sql` | synthetic local D1 seed for manual QA | 26 |

Test files mirror sources under `app/test/web/` (for example `src/web/lib/confidence.ts` is tested in `test/web/lib/confidence.test.ts`).

---

### Task 1: Test dependencies, harness and the synthetic fake API

**Files:**
- Verify (no edit): `app/package.json` (plan 03 Task 1 declares every SPA test dependency)
- Replace (plan 03's temporary stub): `app/test/web/setup.ts`
- Create: `app/test/web/msw/server.ts`, `app/test/web/msw/fixtures.ts`, `app/test/web/msw/fake-api.ts`, `app/test/web/msw/handlers.ts`, `app/test/web/helpers/axe.ts`, `app/test/web/helpers/viewport.ts`
- Test: `app/test/web/harness.test.ts`

**Interfaces:**
- Consumes: plan 03 `app/src/shared/api.ts` types (contracts 7 + A1 to A6); plan 03 `vitest.web.config.ts` (`setupFiles: ["test/web/setup.ts"]`, happy-dom) and `app/package.json` dev dependencies (`axe-core`, `@testing-library/user-event`, `@testing-library/react`, `happy-dom`, `msw`; W7).
- Produces (test-only, used by every later task):
  - `server` (`msw/node` `SetupServer`) from `test/web/msw/server.ts`.
  - `installFakeApi(mutate?: (s: FakeApiState) => void): FakeApiState` and `fakeApiHandlers(state)` from `test/web/msw/handlers.ts`.
  - `createFakeApiState(): FakeApiState`, `deriveGroups(state, accountId?)`, `summaryOf(state, accountId?)`, `previewOf(state, q)`, `encodeGroupKey(accountId, sender, action)`, `FakeItem`, `RouteName`, `Failure` from `test/web/msw/fake-api.ts`.
  - Fixture constants and builders from `test/web/msw/fixtures.ts`: `OWNER`, `T0`, `ACC_GMAIL`, `ACC_OUTLOOK`, `iso(ms)`, `makeSync`, `makeAccount`, `makeMe`, `makeGroupItems`, `defaultItems`, `makeInsights`, `makePolicyResponse`, `defaultActivity`, `defaultBatches`.
  - `expectNoA11yViolations(root?: Element): Promise<void>` from `test/web/helpers/axe.ts`.
  - `installMatchMedia()`, `setViewport(width: number)`, `setReducedMotion(on: boolean)`, `resetViewport()` from `test/web/helpers/viewport.ts`.
- Default dataset facts later tests rely on (tau 0.86): 7 pending sender groups, 27 pending emails; Clean up preview (`delete,archive`) count 14 (11 Trash, 3 Archive) in 4 groups, `groupsLeft` 4; `groupsByAction` delete 3, archive 2, keep 1, unsure 1; default sort order Northwind Deals (97%), Contoso Orders (92%), Daily Digest (90%), Mom (90%), Tailspin Travel (85%), Fabrikam Updates (79%), Build Bot (50%).

- [ ] **Step 1: Verify the test dependencies (plan 03 declared them)**

Run: `grep -E '"(axe-core|@testing-library/user-event|@testing-library/react|happy-dom|msw)"' app/package.json`
Expected: five lines with the exact versions `"axe-core": "4.14.0"`, `"@testing-library/user-event": "14.6.8"`, `"@testing-library/react": "16.3.3"`, `"happy-dom": "21.0.1"`, `"msw": "3.0.3"` (no caret). Do not edit `app/package.json`; if a line is missing, stop and report it (plan 03 Task 1 owns the manifest).

- [ ] **Step 2: Write the failing harness test**

`app/test/web/harness.test.ts`:

```ts
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "./helpers/axe.ts";
import { setReducedMotion, setViewport } from "./helpers/viewport.ts";
import { createFakeApiState, deriveGroups, previewOf, summaryOf } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

describe("fake API", () => {
  it("answers same-origin fetches and reports tau from state", async () => {
    const state = installFakeApi();
    const res = await fetch(new URL("/api/me", window.location.origin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; tauDelete: number };
    expect(body.email).toBe("owner@example.test");
    expect(body.tauDelete).toBe(state.tau);
  });

  it("rejects a mutation without the CSRF header", async () => {
    installFakeApi();
    const res = await fetch(new URL("/api/override", window.location.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [1], action: "keep" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_required");
  });

  it("derives groups, summary and preview from the default dataset", () => {
    const s = createFakeApiState();
    expect(deriveGroups(s)).toHaveLength(7);
    const summary = summaryOf(s);
    expect(summary.pending.total).toBe(27);
    expect(summary.groupsByAction).toEqual({ delete: 3, archive: 2, keep: 1, unsure: 1 });
    const preview = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
    expect(preview.count).toBe(14);
    expect(preview.byAction).toEqual({ delete: 11, archive: 3, keep: 0 });
    expect(preview.groups).toBe(4);
    expect(preview.groupsLeft).toBe(4);
  });
});

describe("axe helper", () => {
  it("fails on an image without alt text", async () => {
    const img = document.createElement("img");
    img.src = "/x.png";
    document.body.append(img);
    await expect(expectNoA11yViolations()).rejects.toThrow();
    img.remove();
  });

  it("passes on a labelled button", async () => {
    const button = document.createElement("button");
    button.textContent = "Save changes";
    document.body.append(button);
    await expectNoA11yViolations();
    button.remove();
  });
});

describe("viewport helper", () => {
  it("drives matchMedia for width and reduced motion", () => {
    expect(window.matchMedia("(min-width: 80rem)").matches).toBe(true);
    act(() => setViewport(1100));
    expect(window.matchMedia("(min-width: 80rem)").matches).toBe(false);
    expect(window.matchMedia("(min-width: 64rem)").matches).toBe(true);
    act(() => setReducedMotion(true));
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/harness.test.ts`
Expected: FAIL with `Failed to load url ./helpers/axe.ts` (or `Cannot find module`).

- [ ] **Step 4: Create the MSW server, viewport and axe helpers**

`app/test/web/msw/server.ts`:

```ts
import { setupServer } from "msw/node";

export const server = setupServer();
```

`app/test/web/helpers/viewport.ts`:

```ts
const DEFAULT_WIDTH = 1440;
let width = DEFAULT_WIDTH;
let reducedMotion = false;
const listeners = new Set<() => void>();

function toPx(value: string, unit: string): number {
  return unit === "rem" ? Number(value) * 16 : Number(value);
}

function evaluate(query: string): boolean {
  if (query.includes("prefers-reduced-motion")) return reducedMotion && query.includes("reduce");
  const min = /min-width:\s*([\d.]+)(px|rem)/.exec(query);
  if (min?.[1] && min[2]) return width >= toPx(min[1], min[2]);
  const max = /max-width:\s*([\d.]+)(px|rem)/.exec(query);
  if (max?.[1] && max[2]) return width <= toPx(max[1], max[2]);
  return false;
}

export function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => {
    const mql = {
      media: query,
      get matches() {
        return evaluate(query);
      },
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
      addListener: (cb: () => void) => listeners.add(cb),
      removeListener: (cb: () => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    };
    return mql as unknown as MediaQueryList;
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setViewport(next: number): void {
  width = next;
  notify();
}

export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  notify();
}

export function resetViewport(): void {
  width = DEFAULT_WIDTH;
  reducedMotion = false;
}
```

`app/test/web/helpers/axe.ts`:

```ts
import axe from "axe-core";
import { expect } from "vitest";

/** WCAG 2.0, 2.1 and 2.2 A and AA. Contrast and target size need layout, which happy-dom lacks. */
export async function expectNoA11yViolations(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
    resultTypes: ["violations"],
  });
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
  expect(summary).toEqual([]);
}
```

- [ ] **Step 5: Create the synthetic fixtures**

`app/test/web/msw/fixtures.ts`:

```ts
import type { SuggestedAction } from "@clearbox/core";
import type {
  AccountSync,
  AccountView,
  ActionBatchView,
  ActivityEntry,
  ApiReason,
  Insights,
  MeResponse,
  PolicyResponse,
} from "../../../src/shared/api.ts";
import type { FakeItem } from "./fake-api.ts";

export const OWNER = "owner@example.test";
export const T0 = Date.parse("2026-10-15T10:00:00.000Z");
export const ACC_GMAIL = "acc_0000000000000001";
export const ACC_OUTLOOK = "acc_0000000000000002";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function makeSync(overrides: Partial<AccountSync> = {}): AccountSync {
  return {
    phase: "incremental",
    backfillDone: true,
    messagesIngested: 32_118,
    pendingCount: 0,
    awaitingModelCount: 0,
    lastTickAt: iso(T0 - 4 * MIN),
    nextTickAt: iso(T0 + 26 * MIN),
    backoffUntil: null,
    lastErrorCode: null,
    pageSize: 25,
    inboxEstimate: null,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: ACC_GMAIL,
    provider: "gmail",
    email: "you@example.com",
    status: "active",
    statusReason: null,
    paused: false,
    archiveSupported: true,
    sync: makeSync(),
    createdAt: iso(T0 - 30 * DAY),
    ...overrides,
  };
}

export function defaultAccounts(): AccountView[] {
  return [
    makeAccount({ sync: makeSync({ pendingCount: 20 }) }),
    makeAccount({
      id: ACC_OUTLOOK,
      provider: "outlook",
      email: "you@example.net",
      sync: makeSync({
        phase: "inbox_backfill",
        backfillDone: false,
        messagesIngested: 8_200,
        pendingCount: 7,
        lastTickAt: iso(T0 - 1 * MIN),
        inboxEstimate: 20_000,
      }),
    }),
  ];
}

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    email: OWNER,
    environment: "production",
    freeTier: true,
    providers: { gmail: true, outlook: true },
    issues: [],
    tauDelete: 0.86,
    serverTime: iso(T0),
    ...overrides,
  };
}

export interface GroupSpec {
  accountId: string;
  sender: string;
  name: string | null;
  action: SuggestedAction;
  confidences: number[];
  subjects: string[];
  reasons: ApiReason[];
  ceilingApplied?: boolean;
  snippet?: string | null;
}

export function makeGroupItems(spec: GroupSpec, startId: number): FakeItem[] {
  const domain = spec.sender.includes("@") ? (spec.sender.split("@")[1] ?? "") : "";
  const gmail = spec.accountId === ACC_GMAIL;
  return spec.confidences.map((confidence, i) => {
    const id = startId + i;
    return {
      id,
      accountId: spec.accountId,
      sender: spec.sender,
      senderName: spec.name,
      domain,
      action: spec.action,
      confidence,
      subject: spec.subjects[i % spec.subjects.length] ?? null,
      snippet: spec.snippet === undefined ? `Synthetic preview text for message ${id}.` : spec.snippet,
      receivedAt: iso(T0 - (i + 1) * 3 * HOUR),
      isRead: i % 2 === 0,
      reasons: spec.reasons,
      ceilingApplied: spec.ceilingApplied ?? false,
      deepLink: gmail
        ? `https://mail.google.com/mail/u/?authuser=you%40example.com#all/m${id}`
        : `https://outlook.office.com/mail/id/m${id}`,
      status: "pending",
      finalAction: null,
    };
  });
}

const r = (code: ApiReason["code"], text: string): ApiReason => ({ code, text });

export const DEFAULT_GROUPS: GroupSpec[] = [
  {
    accountId: ACC_GMAIL,
    sender: "promo@northwind.example",
    name: "Northwind Deals",
    action: "delete",
    confidences: [0.99, 0.98, 0.97, 0.97, 0.96, 0.96],
    subjects: ["Flash sale ends tonight", "Your weekly picks", "Last chance: 70% off"],
    reasons: [
      r("prior_sender_deleted", "You trashed 41 of 44 from this sender"),
      r("low_open_rate", "Opened 2% of 52 emails from this sender"),
      r("list_unsubscribe", "Has an unsubscribe link"),
    ],
  },
  {
    accountId: ACC_GMAIL,
    sender: "digest@news.example",
    name: "Daily Digest",
    action: "delete",
    confidences: [0.93, 0.91, 0.9, 0.88],
    subjects: ["Your morning digest"],
    reasons: [r("bulk_mail", "Sent as bulk mail"), r("old_unread", "Unread for 9 days")],
  },
  {
    accountId: ACC_OUTLOOK,
    sender: "orders@contoso.example",
    name: "Contoso Orders",
    action: "archive",
    confidences: [0.95, 0.92, 0.9],
    subjects: ["Your order has shipped", "Receipt for order 4471"],
    reasons: [r("guard_record_pattern", "Looks like a record (receipt)")],
    ceilingApplied: true,
  },
  {
    accountId: ACC_GMAIL,
    sender: "updates@fabrikam.example",
    name: "Fabrikam Updates",
    action: "archive",
    confidences: [0.84, 0.8, 0.78, 0.74],
    subjects: ["Release notes"],
    reasons: [r("category", "Filed under updates")],
  },
  {
    accountId: ACC_GMAIL,
    sender: "deals@tailspin.example",
    name: "Tailspin Travel",
    action: "delete",
    confidences: [0.9, 0.85, 0.8],
    subjects: ["Fares to the coast"],
    reasons: [r("list_unsubscribe", "Has an unsubscribe link")],
  },
  {
    accountId: ACC_OUTLOOK,
    sender: "mom@family.example",
    name: "Mom",
    action: "keep",
    confidences: [0.92, 0.88],
    subjects: ["Sunday lunch?"],
    reasons: [r("guard_correspondent", "You have written to this sender")],
  },
  {
    accountId: ACC_GMAIL,
    sender: "builds@ci.example",
    name: "Build Bot",
    action: "unsure",
    confidences: [0.55, 0.52, 0.5, 0.48, 0.45],
    subjects: ["Build 1042 finished"],
    reasons: [r("low_confidence", "Not confident enough to suggest an action")],
  },
];

export function defaultItems(): FakeItem[] {
  let next = 1000;
  return DEFAULT_GROUPS.flatMap((spec) => {
    const items = makeGroupItems(spec, next);
    next += 100;
    return items;
  });
}

export function makeInsights(accounts: AccountView[]): Insights {
  const weekStarts = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
  const cleaned = [420, 730, 512, 640, 980, 1284];
  const undone = [3, 5, 0, 2, 9, 18];
  return {
    precision: { deletePrecision: 0.986, deleteSuggestionsDecided: 412, window: 500 },
    labels: { total: 1912, last7Days: 312 },
    calibration: {
      tauDelete: 0.86,
      outcome: "calibrated",
      ranAt: iso(T0 - 9 * HOUR),
      points: [
        { tau: 0.8, support: 120, precision: 0.979 },
        { tau: 0.86, support: 96, precision: 0.986 },
        { tau: 0.9, support: 60, precision: 0.99 },
      ],
    },
    budget: {
      date: "2026-10-15",
      rowsWritten: 21_080,
      rowsCap: 90_000,
      ingestStopRows: 65_000,
      d1DailyWriteLimit: 100_000,
      ticks: 900,
      messagesIngested: 3_120,
      decisionCalls: 3_412,
      decisionFailures: 2,
      decisionInputTokens: 1_400_000,
      estimatedDecisionCostUsd: 0.0588,
      dbSizeBytes: 182_000_000,
      dbSizeLimitBytes: 500_000_000,
    },
    history: Array.from({ length: 14 }, (_, i) => ({
      date: iso(T0 - (13 - i) * DAY).slice(0, 10),
      rowsWritten: 20_000,
      messagesIngested: 6_000,
      decisionCalls: 3_000,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      status: a.status,
      paused: a.paused,
      sync: a.sync,
    })),
    weekly: weekStarts.map((weekStart, i) => ({ weekStart, cleaned: cleaned[i] ?? 0, undone: undone[i] ?? 0 })),
  };
}

export function makePolicyResponse(): PolicyResponse {
  const defaults = {
    allowlist: [],
    denylist: [],
    minAgeDays: 3,
    storeSnippets: true,
    labelSubjects: true,
    recordPatterns: ["receipt", "invoice", "tax", "statement", "contract", "medical", "legal"],
  };
  return {
    policy: { ...defaults, allowlist: ["mom@family.example", "@bank.example"], denylist: ["promo@northwind.example"] },
    version: 4,
    defaults,
  };
}

export function defaultBatches(): (ActionBatchView & { itemIds: number[] })[] {
  const byAction = (d: number, a: number) => ({ delete: d, archive: a, keep: 0 });
  return [
    {
      id: 3, kind: "cleanup", createdAt: iso(T0 - 1 * HOUR), requestedCount: 1284, executedCount: 1280,
      failedCount: 0, byAction: byAction(1102, 178), undoable: true, undoExpiresAt: iso(T0 + 23 * HOUR),
      undoneAt: null, itemIds: [],
    },
    {
      id: 2, kind: "approve", createdAt: iso(T0 - 3 * HOUR), requestedCount: 248, executedCount: 248,
      failedCount: 0, byAction: byAction(248, 0), undoable: false, undoExpiresAt: iso(T0 + 21 * HOUR),
      undoneAt: iso(T0 - 2 * HOUR), itemIds: [],
    },
    {
      id: 1, kind: "override", createdAt: iso(T0 - 2 * DAY), requestedCount: 12, executedCount: 12,
      failedCount: 0, byAction: byAction(12, 0), undoable: false, undoExpiresAt: iso(T0 - 1 * DAY),
      undoneAt: null, itemIds: [],
    },
  ];
}

export function defaultActivity(): ActivityEntry[] {
  const counts = { executed: 0, failed: 0, skipped: 0, retryLater: 0, delete: 0, archive: 0, keep: 0, groups: 0 };
  return [
    { id: 9, ts: iso(T0 - 1 * HOUR), kind: "cleanup", accountId: null, batchId: 3, count: 1284,
      result: { ...counts, executed: 1280, skipped: 4, delete: 1102, archive: 178, groups: 371 } },
    { id: 8, ts: iso(T0 - 2 * HOUR), kind: "undo", accountId: ACC_GMAIL, batchId: 2, count: 248, result: { restored: 248, failed: 0 } },
    { id: 7, ts: iso(T0 - 3 * HOUR), kind: "approve", accountId: ACC_GMAIL, batchId: 2, count: 248,
      result: { ...counts, executed: 248, delete: 248 } },
    { id: 6, ts: iso(T0 - 2 * DAY), kind: "override", accountId: ACC_GMAIL, batchId: 1, count: 12,
      result: { ...counts, executed: 12, delete: 12 } },
    { id: 5, ts: iso(T0 - 2 * DAY - HOUR), kind: "policy_updated", accountId: null, batchId: null, count: 0, result: { allow: 3, deny: 1 } },
    { id: 4, ts: iso(T0 - 3 * DAY), kind: "calibration", accountId: null, batchId: null, count: 312, result: { tauDelete: 0.86 } },
    { id: 3, ts: iso(T0 - 3 * DAY - HOUR), kind: "purge", accountId: null, batchId: null, count: 4210, result: {} },
    { id: 2, ts: iso(T0 - 4 * DAY), kind: "reauth_required", accountId: ACC_OUTLOOK, batchId: null, count: 0, result: { reason: "invalid_grant" } },
    { id: 1, ts: iso(T0 - 30 * DAY), kind: "account_connected", accountId: ACC_GMAIL, batchId: null, count: 0, result: {} },
  ];
}
```

- [ ] **Step 6: Create the fake API state model**

`app/test/web/msw/fake-api.ts`:

```ts
import type { ActionKind, SuggestedAction } from "@clearbox/core";
import type {
  AccountView,
  ActionBatchView,
  ActionResponse,
  ActivityEntry,
  ApiErrorCode,
  ApiReason,
  CleanupPreview,
  Insights,
  ItemErrorCode,
  ItemResult,
  MeResponse,
  PolicyResponse,
  QueueSummary,
  SenderGroup,
  SuggestionItem,
} from "../../../src/shared/api.ts";
import {
  T0,
  defaultAccounts,
  defaultActivity,
  defaultBatches,
  defaultItems,
  iso,
  makeInsights,
  makeMe,
  makePolicyResponse,
} from "./fixtures.ts";

export interface FakeItem {
  id: number;
  accountId: string;
  sender: string;
  senderName: string | null;
  domain: string;
  action: SuggestedAction;
  confidence: number;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
  reasons: ApiReason[];
  ceilingApplied: boolean;
  deepLink: string | null;
  status: "pending" | "executed" | "failed" | "undone";
  finalAction: ActionKind | null;
}

export type RouteName =
  | "me" | "accounts" | "patchAccount" | "deleteAccount" | "scan" | "summary" | "groups" | "group"
  | "approve" | "override" | "preview" | "cleanup" | "batches" | "undo" | "activity" | "insights"
  | "policy" | "putPolicy" | "patchSender";

export interface Failure {
  status: number;
  code: ApiErrorCode | "network";
  times: number;
  retryAt?: string;
  details?: unknown;
}

export interface RecordedRequest {
  route: RouteName;
  method: string;
  url: URL;
  body: unknown;
  csrf: string | null;
}

export type FakeBatch = ActionBatchView & { itemIds: number[] };

export interface FakeApiState {
  now: number;
  tau: number;
  me: MeResponse;
  accounts: AccountView[];
  items: FakeItem[];
  awaitingModel: number;
  batches: FakeBatch[];
  activity: ActivityEntry[];
  insights: Insights;
  policy: PolicyResponse;
  scanDecided: number;
  failures: Partial<Record<RouteName, Failure>>;
  retryLaterIds: Set<number>;
  retryLaterCode: ItemErrorCode;
  failIds: Set<number>;
  requests: RecordedRequest[];
  nextBatchId: number;
}

export function createFakeApiState(): FakeApiState {
  const accounts = defaultAccounts();
  return {
    now: T0,
    tau: 0.86,
    me: makeMe(),
    accounts,
    items: defaultItems(),
    awaitingModel: 0,
    batches: defaultBatches(),
    activity: defaultActivity(),
    insights: makeInsights(accounts),
    policy: makePolicyResponse(),
    scanDecided: 0,
    failures: {},
    retryLaterIds: new Set(),
    retryLaterCode: "unavailable",
    failIds: new Set(),
    requests: [],
    nextBatchId: 10,
  };
}

export function encodeGroupKey(accountId: string, sender: string, action: SuggestedAction): string {
  const bytes = new TextEncoder().encode(JSON.stringify([accountId, sender, action]));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const keyOf = (i: FakeItem): string => encodeGroupKey(i.accountId, i.sender, i.action);

export function pendingItems(s: FakeApiState, accountId?: string | null): FakeItem[] {
  return s.items.filter((i) => i.status === "pending" && (!accountId || i.accountId === accountId));
}

function toGroup(s: FakeApiState, key: string, list: FakeItem[]): SenderGroup {
  const byNewest = [...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const newest = byNewest[0]!;
  const oldest = byNewest[byNewest.length - 1]!;
  const confs = list.map((i) => i.confidence);
  return {
    key,
    accountId: newest.accountId,
    provider: s.accounts.find((a) => a.id === newest.accountId)?.provider ?? "gmail",
    sender: newest.sender,
    senderName: newest.senderName,
    domain: newest.domain,
    action: newest.action,
    count: list.length,
    confidence: {
      min: Math.min(...confs),
      avg: confs.reduce((sum, c) => sum + c, 0) / confs.length,
      max: Math.max(...confs),
    },
    topReasons: newest.reasons.slice(0, 3),
    ceilingApplied: list.some((i) => i.ceilingApplied),
    newestReceivedAt: newest.receivedAt,
    oldestReceivedAt: oldest.receivedAt,
    latestSubject: newest.subject,
  };
}

export function deriveGroups(s: FakeApiState, accountId?: string | null): SenderGroup[] {
  const map = new Map<string, FakeItem[]>();
  for (const item of pendingItems(s, accountId)) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map].map(([key, list]) => toGroup(s, key, list));
}

export function sortGroups(groups: SenderGroup[], sort: string): SenderGroup[] {
  const copy = [...groups];
  if (sort === "count_desc") return copy.sort((a, b) => b.count - a.count);
  if (sort === "newest") return copy.sort((a, b) => b.newestReceivedAt.localeCompare(a.newestReceivedAt));
  return copy.sort((a, b) => b.confidence.avg - a.confidence.avg);
}

export function toSuggestionItem(s: FakeApiState, i: FakeItem): SuggestionItem {
  return {
    id: i.id,
    accountId: i.accountId,
    provider: s.accounts.find((a) => a.id === i.accountId)?.provider ?? "gmail",
    status: "pending",
    action: i.action,
    confidence: i.confidence,
    distribution: null,
    importance: null,
    ceiling: "delete",
    ceilingApplied: i.ceilingApplied,
    reasons: i.reasons,
    from: { address: i.sender, name: i.senderName },
    subject: i.subject,
    snippet: i.snippet,
    receivedAt: i.receivedAt,
    isRead: i.isRead,
    signals: {
      hasListUnsubscribe: true, precedenceBulk: false, autoSubmitted: false, category: null,
      hasAttachments: false, starred: false, ownerReplied: false, isCorrespondent: false, ageDays: 5,
      ownerPosition: "to", auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    },
    deepLink: i.deepLink,
    modelVersion: "decision-1",
    policyVersion: 1,
  };
}

const count = (list: FakeItem[], a: SuggestedAction): number => list.filter((i) => i.action === a).length;

export function summaryOf(s: FakeApiState, accountId?: string | null): QueueSummary {
  const pend = pendingItems(s, accountId);
  const groups = deriveGroups(s, accountId);
  const g = (a: SuggestedAction) => groups.filter((x) => x.action === a).length;
  const atTau = pend.filter((i) => i.action !== "unsure" && i.confidence >= s.tau);
  return {
    asOf: iso(s.now),
    pending: { delete: count(pend, "delete"), archive: count(pend, "archive"), keep: count(pend, "keep"),
      unsure: count(pend, "unsure"), total: pend.length },
    awaitingModel: s.awaitingModel,
    groups: groups.length,
    tauDelete: s.tau,
    cleanup: { threshold: s.tau, count: atTau.length,
      byAction: { delete: count(atTau, "delete"), archive: count(atTau, "archive"), keep: count(atTau, "keep") } },
    groupsByAction: { delete: g("delete"), archive: g("archive"), keep: g("keep"), unsure: g("unsure") },
  };
}

export interface ScopeQuery {
  actions: ActionKind[];
  threshold: number;
  accountId?: string | null;
}

export function inScope(s: FakeApiState, q: ScopeQuery): FakeItem[] {
  return pendingItems(s, q.accountId)
    .filter((i) => q.actions.includes(i.action as ActionKind) && i.confidence >= q.threshold)
    .sort((a, b) => b.confidence - a.confidence);
}

export function previewOf(s: FakeApiState, q: ScopeQuery): CleanupPreview {
  const scoped = inScope(s, q);
  const ids = new Set(scoped.map((i) => i.id));
  const left = pendingItems(s, q.accountId).filter((i) => !ids.has(i.id));
  return {
    asOf: iso(s.now),
    threshold: q.threshold,
    defaultThreshold: s.tau,
    count: scoped.length,
    byAction: { delete: count(scoped, "delete"), archive: count(scoped, "archive"), keep: count(scoped, "keep") },
    groups: new Set(scoped.map(keyOf)).size,
    groupsLeft: new Set(left.map(keyOf)).size,
  };
}

export function execute(
  s: FakeApiState,
  targets: { item: FakeItem; action: ActionKind }[],
  kind: ActionBatchView["kind"],
): Omit<ActionResponse, "remaining"> {
  const results: ItemResult[] = [];
  const executedIds: number[] = [];
  const byAction = { delete: 0, archive: 0, keep: 0 };
  let failed = 0;
  let retryLater = 0;
  for (const { item, action } of targets) {
    if (s.retryLaterIds.has(item.id)) {
      retryLater += 1;
      results.push({ id: item.id, outcome: "retry_later", action, error: s.retryLaterCode });
    } else if (s.failIds.has(item.id)) {
      failed += 1;
      item.status = "failed";
      results.push({ id: item.id, outcome: "failed", action, error: "not_found" });
    } else {
      item.status = "executed";
      item.finalAction = action;
      byAction[action] += 1;
      executedIds.push(item.id);
      results.push({ id: item.id, outcome: "executed", action, error: null });
    }
  }
  let batchId: number | null = null;
  if (executedIds.length > 0) {
    batchId = s.nextBatchId++;
    s.batches.unshift({
      id: batchId, kind, createdAt: iso(s.now), requestedCount: targets.length,
      executedCount: executedIds.length, failedCount: failed, byAction, undoable: true,
      undoExpiresAt: iso(s.now + 24 * 3_600_000), undoneAt: null, itemIds: executedIds,
    });
  }
  return { batchId, results, executed: executedIds.length, failed, skipped: 0, retryLater };
}
```

- [ ] **Step 7: Create the MSW handlers**

`app/test/web/msw/handlers.ts`:

```ts
import type { ActionKind } from "@clearbox/core";
import { http, HttpResponse } from "msw";
import type { ApiErrorCode } from "../../../src/shared/api.ts";
import {
  createFakeApiState,
  deriveGroups,
  execute,
  inScope,
  keyOf,
  pendingItems,
  previewOf,
  sortGroups,
  summaryOf,
  toSuggestionItem,
  type FakeApiState,
  type RouteName,
} from "./fake-api.ts";
import { iso } from "./fixtures.ts";
import { server } from "./server.ts";

type Method = "get" | "post" | "put" | "patch" | "delete";
interface Ctx { url: URL; body: unknown; params: Record<string, string> }

export function errorResponse(status: number, code: ApiErrorCode, retryAt?: string, details?: unknown): Response {
  return HttpResponse.json(
    { error: { code, message: "Synthetic error", ...(retryAt ? { retryAt } : {}), ...(details ? { details } : {}) } },
    { status },
  );
}

function paginate<T>(list: T[], url: URL): { items: T[]; nextCursor: string | null } {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const start = Number(url.searchParams.get("cursor") ?? "0");
  return { items: list.slice(start, start + limit), nextCursor: start + limit < list.length ? String(start + limit) : null };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function fakeApiHandlers(s: FakeApiState) {
  const route = (name: RouteName, method: Method, path: string, resolve: (c: Ctx) => Response) =>
    http[method](`*${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const body = method === "get" ? undefined : await readJson(request);
      const csrf = request.headers.get("X-Clearbox-CSRF");
      s.requests.push({ route: name, method: method.toUpperCase(), url, body, csrf });
      const fail = s.failures[name];
      if (fail && fail.times > 0) {
        fail.times -= 1;
        if (fail.code === "network") return HttpResponse.error();
        return errorResponse(fail.status, fail.code, fail.retryAt, fail.details);
      }
      if (method !== "get" && csrf !== "1") return errorResponse(403, "csrf_required");
      return resolve({ url, body, params: params as Record<string, string> });
    });

  return [
    route("me", "get", "/api/me", () => HttpResponse.json({ ...s.me, tauDelete: s.tau })),
    route("accounts", "get", "/api/accounts", () => HttpResponse.json({ accounts: s.accounts })),
    route("scan", "post", "/api/accounts/:id/scan", ({ params }) => {
      if (!s.accounts.some((a) => a.id === params.id)) return errorResponse(404, "not_found");
      return HttpResponse.json({
        outcome: "processed", accountId: params.id ?? null, kind: "incremental", phase: "incremental",
        fetched: s.scanDecided, skippedKnown: 0, decided: s.scanDecided, deferred: 0, unsure: 0, removed: 0,
        subrequests: 5, rowsWritten: 10, nextTickAt: null, errorCode: null,
      });
    }),
    route("patchAccount", "patch", "/api/accounts/:id", ({ params, body }) => {
      const account = s.accounts.find((a) => a.id === params.id);
      if (!account) return errorResponse(404, "not_found");
      account.paused = (body as { paused: boolean }).paused;
      return HttpResponse.json(account);
    }),
    route("deleteAccount", "delete", "/api/accounts/:id", ({ params }) => {
      const account = s.accounts.find((a) => a.id === params.id);
      if (!account) return errorResponse(404, "not_found");
      s.accounts = s.accounts.filter((a) => a.id !== account.id);
      const outlook = account.provider === "outlook";
      return HttpResponse.json({
        accountId: account.id,
        revocation: outlook ? "not_supported" : "revoked",
        consentUrls: outlook
          ? { personal: "https://account.live.com/consent/Manage", work: "https://myapps.microsoft.com" }
          : null,
      });
    }),
    route("summary", "get", "/api/queue/summary", ({ url }) =>
      HttpResponse.json(summaryOf(s, url.searchParams.get("accountId")))),
    route("groups", "get", "/api/groups", ({ url }) => {
      const action = url.searchParams.get("action");
      const groups = deriveGroups(s, url.searchParams.get("accountId")).filter((g) => !action || g.action === action);
      return HttpResponse.json(paginate(sortGroups(groups, url.searchParams.get("sort") ?? "confidence_desc"), url));
    }),
    route("group", "get", "/api/groups/:key", ({ params, url }) => {
      const group = deriveGroups(s).find((g) => g.key === params.key);
      if (!group) return errorResponse(404, "not_found");
      const items = pendingItems(s)
        .filter((i) => keyOf(i) === group.key)
        .sort((a, b) => b.confidence - a.confidence || b.receivedAt.localeCompare(a.receivedAt))
        .map((i) => toSuggestionItem(s, i));
      return HttpResponse.json({ asOf: iso(s.now), group, items: paginate(items, url) });
    }),
    route("approve", "post", "/api/approve", ({ body }) => {
      const b = body as { ids?: number[]; groupKey?: string };
      if (b.groupKey) {
        const list = pendingItems(s).filter((i) => keyOf(i) === b.groupKey).sort((x, y) => y.confidence - x.confidence);
        if (list[0]?.action === "unsure") return errorResponse(400, "validation_failed");
        const res = execute(s, list.slice(0, 100).map((item) => ({ item, action: item.action as ActionKind })), "approve");
        const remaining = pendingItems(s).filter((i) => keyOf(i) === b.groupKey && !s.retryLaterIds.has(i.id)).length;
        return HttpResponse.json({ ...res, remaining });
      }
      const targets = pendingItems(s).filter((i) => b.ids?.includes(i.id) && i.action !== "unsure");
      const res = execute(s, targets.map((item) => ({ item, action: item.action as ActionKind })), "approve");
      const skipped = (b.ids?.length ?? 0) - targets.length;
      return HttpResponse.json({ ...res, skipped, remaining: 0 });
    }),
    route("override", "post", "/api/override", ({ body }) => {
      const b = body as { ids: number[]; action: ActionKind };
      const targets = pendingItems(s).filter((i) => b.ids.includes(i.id));
      const res = execute(s, targets.map((item) => ({ item, action: b.action })), "override");
      return HttpResponse.json({ ...res, skipped: b.ids.length - targets.length, remaining: 0 });
    }),
    route("preview", "get", "/api/cleanup/preview", ({ url }) => {
      const actions = (url.searchParams.get("actions") ?? "delete,archive,keep").split(",") as ActionKind[];
      const threshold = Number(url.searchParams.get("threshold") ?? s.tau);
      return HttpResponse.json(previewOf(s, { actions, threshold, accountId: url.searchParams.get("accountId") }));
    }),
    route("cleanup", "post", "/api/cleanup", ({ body }) => {
      const b = body as { threshold?: number; actions?: ActionKind[]; accountId?: string };
      const q = { actions: b.actions ?? ["delete", "archive", "keep"], threshold: b.threshold ?? s.tau, accountId: b.accountId ?? null };
      const batch = inScope(s, q).filter((i) => !s.retryLaterIds.has(i.id)).slice(0, 100);
      const retry = inScope(s, q).filter((i) => s.retryLaterIds.has(i.id)).slice(0, 100 - batch.length);
      const res = execute(s, [...batch, ...retry].map((item) => ({ item, action: item.action as ActionKind })), "cleanup");
      return HttpResponse.json({ ...res, remaining: inScope(s, q).length });
    }),
    route("batches", "get", "/api/batches", ({ url }) =>
      HttpResponse.json(paginate(s.batches.map(({ itemIds, ...b }) => (void itemIds, b)), url))),
    route("undo", "post", "/api/batches/:id/undo", ({ params }) => {
      const batch = s.batches.find((b) => String(b.id) === params.id);
      if (!batch) return errorResponse(404, "not_found");
      if (!batch.undoable) return errorResponse(410, "undo_expired");
      const items = s.items.filter((i) => batch.itemIds.includes(i.id));
      for (const item of items) item.status = "undone";
      batch.undoable = false;
      batch.undoneAt = iso(s.now);
      const restored = Math.max(items.length, batch.executedCount);
      return HttpResponse.json({
        batchId: batch.id,
        results: items.map((i) => ({ id: i.id, outcome: "restored", error: null })),
        restored, failed: 0, skipped: 0,
      });
    }),
    route("activity", "get", "/api/activity", ({ url }) => {
      const accountId = url.searchParams.get("accountId");
      return HttpResponse.json(paginate(s.activity.filter((e) => !accountId || e.accountId === accountId), url));
    }),
    route("insights", "get", "/api/insights", () => HttpResponse.json(s.insights)),
    route("policy", "get", "/api/policy", () => HttpResponse.json(s.policy)),
    route("putPolicy", "put", "/api/policy", ({ body }) => {
      const b = body as { policy: FakeApiState["policy"]["policy"]; expectedVersion: number };
      if (b.expectedVersion !== s.policy.version) return errorResponse(409, "conflict");
      s.policy = { ...s.policy, policy: b.policy, version: s.policy.version + 1 };
      return HttpResponse.json(s.policy);
    }),
    route("patchSender", "patch", "/api/policy/senders", ({ body }) => {
      const b = body as { entry: string; list: "allow" | "deny" | "none" };
      const p = s.policy.policy;
      const allowlist = p.allowlist.filter((e) => e !== b.entry);
      const denylist = p.denylist.filter((e) => e !== b.entry);
      if (b.list === "allow") allowlist.push(b.entry);
      if (b.list === "deny") denylist.push(b.entry);
      s.policy = { ...s.policy, policy: { ...p, allowlist, denylist }, version: s.policy.version + 1 };
      return HttpResponse.json(s.policy);
    }),
  ];
}

/** Installs the fake API for one test. `mutate` adjusts the default dataset before handlers run. */
export function installFakeApi(mutate?: (s: FakeApiState) => void): FakeApiState {
  const state = createFakeApiState();
  mutate?.(state);
  server.use(...fakeApiHandlers(state));
  return state;
}
```

- [ ] **Step 8: Create the setup file**

`app/test/web/setup.ts` (create, or replace the whole file if plan 03 created a stub):

```ts
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { installMatchMedia, resetViewport } from "./helpers/viewport.ts";
import { server } from "./msw/server.ts";

installMatchMedia();
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetViewport();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
```

- [ ] **Step 9: Run the harness test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/harness.test.ts`
Expected: PASS, 6 tests. If the first test fails with a URL parse or stream error, happy-dom's `fetch` is not being intercepted: confirm `server.listen` runs in `beforeAll` and that the request URL is absolute (`new URL(path, window.location.origin)`), which is the same form `api/client.ts` uses in Task 4.

- [ ] **Step 10: Commit**

```bash
git add app/test/web
git commit -m "test(web): add SPA test harness, synthetic fake API and axe helper"
```

---

### Task 2: Design tokens, base styles, entry document and text guards

**Files:**
- Replace: `app/src/web/styles.css` (plan 03 placeholder, W8)
- Create: `app/src/web/styles.dark.css`
- Replace: `app/index.html` (plan 03 file, W8)
- Test: `app/test/web/tokens.contrast.test.ts`, `app/test/web/no-em-dash.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: Tailwind utilities for every token in UI spec 2 (`bg-surface`, `text-ink-3`, `text-body`, `font-emphasis`, `rounded-xl`, `shadow-card`, `z-(--z-toast)`, `duration-(--duration-base)`, `animate-shimmer`, ...); geometry helper classes `cb-fill`, `cb-tick`, `cb-grow`, `cb-bar-height` reading `--cb-value`, `--cb-tau`, `--cb-grow`; forced-colors marker classes `cb-tag`, `cb-chip`, `cb-meter`, `cb-toast`, `cb-bar`, `cb-row`; CSS variables `--layout-sidebar` (208px), `--layout-detail` (300px), `--layout-slideover` (340px).

- [ ] **Step 1: Write the failing token contrast test**

`app/test/web/tokens.contrast.test.ts`:

```ts
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest replaces CSS imports (including ?raw) with an empty string by default.
// The web suite always runs from app/ (pnpm --filter @clearbox/app exec vitest ...).
const css = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");

function readTokens(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of css.matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    if (m[1] && m[2]) map.set(m[1], m[2]);
  }
  return map;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const AVATARS = Array.from({ length: 12 }, (_, i) => ["white", `avatar-${i}`] as const);

// UI spec 7.2, text pairs (4.5:1).
const TEXT_PAIRS: (readonly [string, string])[] = [
  ["ink", "surface"], ["ink", "canvas"], ["ink", "surface-sunk"], ["ink", "surface-selected"],
  ["ink-2", "surface"], ["ink-2", "surface-sunk"], ["ink-2", "surface-selected"],
  ["ink-3", "surface"], ["ink-3", "canvas"], ["ink-3", "surface-raised"], ["ink-3", "surface-hover"],
  ["ink-3", "surface-sunk"], ["ink-3", "surface-selected"],
  ["on-inverse", "inverse"], ["on-inverse-2", "inverse"], ["on-inverse-3", "inverse"],
  ["white", "trash"], ["white", "trash-hover"],
  ["trash-ink", "trash-soft"], ["archive-ink", "archive-soft"], ["keep-ink", "keep-soft"], ["check-ink", "check-soft"],
  ["check-ink-strong", "check-soft"], ["trash-ink", "surface"],
  ["band-very-sure-ink", "surface"], ["band-very-sure-ink", "surface-selected"],
  ["band-sure-ink", "surface"], ["band-sure-ink", "surface-selected"],
  ["band-likely-ink", "surface"], ["band-likely-ink", "surface-selected"],
  ["band-unsure-ink", "surface"], ["band-unsure-ink", "surface-selected"], ["band-unsure-ink", "surface-sunk"],
  ["accent", "surface"], ["accent", "accent-soft"], ["accent-hover", "surface"],
  ["ink", "neutral-fill"], ["white", "provider-gmail"], ["white", "provider-outlook"], ["white", "provider-off"],
  ...AVATARS,
];

// UI spec 7.2, UI component and graphic pairs (3:1). Exempt pairs are excluded on purpose.
const UI_PAIRS: (readonly [string, string])[] = [
  ["focus", "surface"], ["focus", "surface-selected"], ["focus", "surface-sunk"], ["white", "inverse"],
  ["line-control", "surface"], ["line-control", "surface-selected"], ["line-control", "surface-sunk"],
  ["white", "line-control"], ["tick", "track"], ["tick", "surface-selected"],
  ["status-ok", "surface-sunk"], ["status-sync", "surface-sunk"], ["status-warn", "surface-sunk"],
  ["status-error", "surface-sunk"], ["status-off", "surface-sunk"],
  ["accent-bar", "surface"], ["accent", "surface"], ["trash", "surface"], ["archive", "surface"],
  ["band-very-sure", "track"],
];

describe("design tokens", () => {
  const tokens = readTokens();
  const hex = (name: string): string => {
    const value = tokens.get(name);
    if (!value) throw new Error(`missing token --color-${name}`);
    return value;
  };

  it.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)("graphic %s on %s is at least 3:1", (fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the owner-binding band fills exactly", () => {
    expect([hex("band-very-sure"), hex("band-sure"), hex("band-likely"), hex("band-unsure")]).toEqual([
      "#1F9D55", "#6CC08B", "#E0A030", "#E5762E",
    ]);
  });

  it("clears the default Tailwind palette and does not import dark mode", () => {
    expect(css).toContain("--color-*: initial;");
    expect(css).not.toContain("styles.dark.css");
  });
});
```

- [ ] **Step 2: Write the failing em dash guard**

`app/test/web/no-em-dash.test.ts`:

```ts
/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EM_DASH = String.fromCharCode(0x2014);
// The web suite always runs from app/ (pnpm --filter @clearbox/app exec vitest ...).
const roots = [resolve(process.cwd(), "src/web") + "/", resolve(process.cwd(), "test/web") + "/"];
const sources: Record<string, string> = Object.fromEntries(
  roots.flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx|css|sql)$/.test(f))
      .map((f) => [`${dir}${f}`, readFileSync(`${dir}${f}`, "utf8")] as const),
  ),
);

describe("text guard", () => {
  it("finds source files to scan", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
  });

  it("contains no em dash in SPA sources or tests", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes(EM_DASH))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run both tests to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/tokens.contrast.test.ts test/web/no-em-dash.test.ts`
Expected: FAIL: `tokens.contrast.test.ts` finds none of the `--color-*` tokens in plan 03's placeholder `src/web/styles.css`, so its contrast assertions fail. `no-em-dash.test.ts` already passes over plan 03's placeholder files (it is a guard, not a feature).

- [ ] **Step 4: Replace `styles.css` (UI spec 2.9 verbatim)**

`app/src/web/styles.css` (replace plan 03's placeholder with exactly this content):

```css
@import "tailwindcss";

/* Clearbox design tokens v1 (light). Source: docs/superpowers/specs/2026-10-15-clearbox-ui-design.md section 2. */
@theme static {
  --color-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --text-*: initial;
  --font-weight-*: initial;
  --breakpoint-*: initial;

  /* Surfaces and lines */
  --color-canvas: #FBFBFC;
  --color-surface: #FFFFFF;
  --color-surface-raised: #FCFCFD;
  --color-surface-sunk: #F4F5F7;
  --color-surface-hover: #F8F8FA;
  --color-surface-selected: #F3F4FF;
  --color-track: #F4F5F7;
  --color-skeleton-highlight: #ECEDF1;
  --color-line: #E8E9ED;
  --color-line-subtle: #F0F1F4;
  --color-line-control: #868A95;
  --color-tick: #7C808C;
  --color-neutral-fill: #D9DBE3;

  /* Ink */
  --color-ink: #16171B;
  --color-ink-2: #4A4D57;
  --color-ink-3: #686C77;
  --color-primary: #16171B;
  --color-primary-hover: #2A2C33;
  --color-on-primary: #FFFFFF;
  --color-inverse: #16171B;
  --color-on-inverse: #FFFFFF;
  --color-on-inverse-2: #C9CAD1;
  --color-on-inverse-3: #A9ABB5;
  --color-inverse-track: #33353D;
  --color-inverse-line: #4A4C55;
  --color-white: #FFFFFF;
  --color-transparent: transparent;

  /* Accent */
  --color-accent: #4F46E5;
  --color-accent-hover: #4338CA;
  --color-accent-soft: #EEF0FF;
  --color-accent-bar: #7F86EB;
  --color-focus: #4F46E5;
  --color-spark-from: #8B85FF;
  --color-spark-to: #4F46E5;

  /* Verdicts */
  --color-trash: #D93636;
  --color-trash-hover: #C42B2B;
  --color-trash-soft: #FDEEEE;
  --color-trash-ink: #B42323;
  --color-trash-line: #F5C9C9;
  --color-archive: #2F6FDB;
  --color-archive-soft: #ECF2FD;
  --color-archive-ink: #1F58B8;
  --color-archive-line: #C9DAF7;
  --color-keep: #1F9D55;
  --color-keep-soft: #EAF7EF;
  --color-keep-ink: #167A41;
  --color-keep-line: #C3E8D1;
  --color-check: #B76E00;
  --color-check-soft: #FFF5E0;
  --color-check-ink: #8F5600;
  --color-check-line: #F4DDB0;
  --color-check-ink-strong: #6E4300;

  /* Confidence bands (fills are owner-binding; -ink variants are for text) */
  --color-band-very-sure: #1F9D55;
  --color-band-very-sure-ink: #167A41;
  --color-band-sure: #6CC08B;
  --color-band-sure-ink: #2F7A4D;
  --color-band-likely: #E0A030;
  --color-band-likely-ink: #8F5600;
  --color-band-unsure: #E5762E;
  --color-band-unsure-ink: #B4501A;

  /* Account status */
  --color-status-ok: #1F9D55;
  --color-status-sync: #2F6FDB;
  --color-status-warn: #B76E00;
  --color-status-error: #D93636;
  --color-status-off: #868A95;

  /* Provider tiles */
  --color-provider-gmail: #D93025;
  --color-provider-outlook: #0F6CBD;
  --color-provider-off: #6B6F7A;

  /* Sender monogram palette (index = fnv1a32(domain) % 12) */
  --color-avatar-0: #B42323;
  --color-avatar-1: #B4501A;
  --color-avatar-2: #8F5600;
  --color-avatar-3: #167A41;
  --color-avatar-4: #0F766E;
  --color-avatar-5: #0E7490;
  --color-avatar-6: #1F58B8;
  --color-avatar-7: #4F46E5;
  --color-avatar-8: #7C3AED;
  --color-avatar-9: #A21CAF;
  --color-avatar-10: #BE185D;
  --color-avatar-11: #475569;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  --text-micro: 0.65625rem;
  --text-micro--line-height: 1rem;
  --text-caption: 0.6875rem;
  --text-caption--line-height: 0.875rem;
  --text-meta: 0.71875rem;
  --text-meta--line-height: 1rem;
  --text-small: 0.75rem;
  --text-small--line-height: 1.0625rem;
  --text-body: 0.78125rem;
  --text-body--line-height: 1.125rem;
  --text-base: 0.8125rem;
  --text-base--line-height: 1.45;
  --text-title-sm: 0.875rem;
  --text-title-sm--line-height: 1.25rem;
  --text-title-sm--letter-spacing: -0.01em;
  --text-title: 0.9375rem;
  --text-title--line-height: 1.3125rem;
  --text-title--letter-spacing: -0.01em;
  --text-title-lg: 0.96875rem;
  --text-title-lg--line-height: 1.375rem;
  --text-title-lg--letter-spacing: -0.01em;
  --text-h1: 1.0625rem;
  --text-h1--line-height: 1.5rem;
  --text-h1--letter-spacing: -0.015em;
  --text-stat: 1.25rem;
  --text-stat--line-height: 1.625rem;
  --text-stat--letter-spacing: -0.02em;

  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-emphasis: 560;
  --font-weight-semibold: 620;
  --font-weight-heading: 650;
  --font-weight-heavy: 700;

  /* Radii */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-card: 0 1px 2px rgba(16, 17, 22, 0.04), 0 4px 14px rgba(16, 17, 22, 0.06);
  --shadow-nav: 0 1px 2px rgba(16, 17, 22, 0.06);
  --shadow-button-primary: 0 1px 2px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --shadow-bar: 0 12px 30px -10px rgba(16, 17, 22, 0.45);
  --shadow-toast: 0 10px 28px -8px rgba(16, 17, 22, 0.4);
  --shadow-overlay: 0 2px 6px rgba(16, 17, 22, 0.05), 0 24px 60px -24px rgba(16, 17, 22, 0.25);

  /* Breakpoints (desktop-first design, min-width variants) */
  --breakpoint-sm: 40rem;   /* 640px */
  --breakpoint-lg: 64rem;   /* 1024px */
  --breakpoint-xl: 80rem;   /* 1280px */

  /* Motion */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --animate-shimmer: shimmer 1.4s linear infinite;
  --animate-spin: spin 0.8s linear infinite;

  @keyframes shimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
}

:root {
  color-scheme: light;
  --duration-fast: 150ms;
  --duration-base: 200ms;
  --duration-slow: 250ms;
  --z-base: 0;
  --z-sticky: 10;
  --z-confirm: 20;
  --z-slideover: 30;
  --z-drawer: 40;
  --z-popover: 50;
  --z-dialog: 60;
  --z-toast: 70;
  --z-skiplink: 80;
  --layout-sidebar: 208px;
  --layout-detail: 300px;
  --layout-slideover: 340px;
  --layout-row-height: 56px;
}

@layer base {
  html { background: var(--color-canvas); }
  body {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
    color: var(--color-ink);
    background: var(--color-canvas);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  :focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  [data-inverse] :focus-visible { outline-color: var(--color-on-inverse); }
  ::selection { background: var(--color-accent-soft); }
}

/* Meter, progress, split bar and chart geometry come from CSS custom properties set through
   React's style prop (CSSOM, allowed by CSP style-src 'self'; see section 8.4). */
@layer components {
  .cb-fill { width: calc(var(--cb-value, 0) * 100%); }
  .cb-tick { left: calc(var(--cb-tau, 0) * 100%); }
  .cb-grow { flex-grow: var(--cb-grow, 0); }
  .cb-bar-height { height: calc(var(--cb-value, 0) * 100%); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .cb-fade { transition: opacity 150ms linear !important; }
}

@media (forced-colors: active) {
  .cb-tag, .cb-chip, .cb-meter, .cb-toast, .cb-bar { border: 1px solid CanvasText; }
  .cb-row[aria-selected="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
}
```

- [ ] **Step 5: Create `styles.dark.css` (UI spec 2.10 verbatim, not imported in v1)**

`app/src/web/styles.dark.css`:

```css
/* v1.1 OPTIONAL. Import from styles.css only when dark mode is approved. */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-canvas: #0F1013;
    --color-surface: #16171B;
    --color-surface-raised: #131418;
    --color-surface-sunk: #1D1F24;
    --color-surface-hover: #1B1D22;
    --color-surface-selected: #23254A;
    --color-track: #26282E;
    --color-skeleton-highlight: #24262C;
    --color-line: #2A2C33;
    --color-line-subtle: #222429;
    --color-line-control: #777B86;
    --color-tick: #8E929C;
    --color-neutral-fill: #3A3D45;

    --color-ink: #ECEDF0;
    --color-ink-2: #B4B7C0;
    --color-ink-3: #9599A3;
    --color-primary: #ECEDF0;
    --color-primary-hover: #FFFFFF;
    --color-on-primary: #16171B;
    --color-inverse: #26282E;
    --color-on-inverse: #ECEDF0;
    --color-on-inverse-2: #C9CAD1;
    --color-on-inverse-3: #A9ABB5;
    --color-inverse-track: #3A3D45;
    --color-inverse-line: #4A4C55;

    --color-accent: #8B85FF;
    --color-accent-hover: #A5A0FF;
    --color-accent-soft: #24224A;
    --color-accent-bar: #5A5FB8;
    --color-focus: #8B85FF;

    --color-trash-soft: #3A1C1E;
    --color-trash-ink: #FF9A9A;
    --color-trash-line: #5A2A2D;
    --color-archive-soft: #172540;
    --color-archive-ink: #9DBEF7;
    --color-archive-line: #26406B;
    --color-keep-soft: #13301F;
    --color-keep-ink: #7BD9A3;
    --color-keep-line: #1F4D33;
    --color-check-soft: #33260F;
    --color-check-ink: #F2C46D;
    --color-check-line: #5A4317;
    --color-check-ink-strong: #F2C46D;

    --color-band-very-sure-ink: #4CC883;
    --color-band-sure-ink: #8FD3A8;
    --color-band-likely-ink: #E9B455;
    --color-band-unsure-ink: #F0915A;

    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 14px rgba(0, 0, 0, 0.35);
    --shadow-overlay: 0 2px 6px rgba(0, 0, 0, 0.4), 0 24px 60px -24px rgba(0, 0, 0, 0.7);
  }
}
```

- [ ] **Step 6: Replace `index.html`**

`app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>Clearbox</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/tokens.contrast.test.ts test/web/no-em-dash.test.ts`
Expected: PASS (74 token checks plus 2 guard tests). The token test reproduces every non-exempt pair of UI spec 7.2.

- [ ] **Step 8: Commit**

```bash
git add app/src/web/styles.css app/src/web/styles.dark.css app/index.html app/test/web/tokens.contrast.test.ts app/test/web/no-em-dash.test.ts
git commit -m "feat(web): add Clearbox design tokens, base styles and entry document"
```

---

### Task 3: Pure view helpers (types, confidence bands, formatting, avatars, account status, platform)

**Files:**
- Create: `app/src/web/lib/view-types.ts`, `app/src/web/lib/confidence.ts`, `app/src/web/lib/format.ts`, `app/src/web/lib/avatar.ts`, `app/src/web/lib/account-status.ts`, `app/src/web/lib/platform.ts`
- Modify: `app/test/web/setup.ts` (pin locale and time zone)
- Test: `app/test/web/lib/confidence.test.ts`, `app/test/web/lib/format.test.ts`, `app/test/web/lib/avatar.test.ts`, `app/test/web/lib/account-status.test.ts`

**Interfaces:**
- Consumes: `AccountView`, `ApiReason`, `Insights` types from `src/shared/api.ts`; `ActionKind`, `SuggestedAction`, `ProviderKind`, `ReasonCode` types from `@clearbox/core`.
- Produces:
  - `view-types.ts`: types `Verdict`, `TagKind`, `Band`, `TabKey`, `GroupSort`, `Platform`, `AccountUiStatus`, re-exported `ActionKind`, `SuggestedAction`, `ProviderKind`, `ReasonCode`; constants `VERDICT_LABEL`, `BAND_LABEL`, `TAB_ACTION`, `TAB_KEYS`, `TAB_LABEL`, `SORT_OPTIONS`; guards `isTabKey(v)`, `isGroupSort(v)`.
  - `confidence.ts`: `VERY_SURE_MIN`, `LIKELY_MIN`, `bandFor(confidence, tau, verdict): Band`, `toPercent(c): number`, `inCleanup(verdict, band): boolean`, `BAND_FILL`, `BAND_INK`, `scaleBands(tau): ScaleBand[]`, `membershipLine(verdict, conf, tau, count): string`, `membershipPhrase(verdict, band): string`, `isModelUnavailable(g): boolean`.
  - `format.ts`: `configureFormat({ locale?, timeZone? })`, `formatCount`, `plural`, `formatPercent`, `relativeAgo(iso, now)`, `shortAge(iso, now)`, `activityWhen(iso, now)`, `formatWeekdayDateTime(iso)`, `localResetTime(now)`, `formatDayMonth(iso, utc?)`, `formatUsd(v)`, `formatMb(bytes)`, `truncateName(name, max?)`, `calendarDaysBetween(a, b)`.
  - `avatar.ts`: `fnv1a32`, `avatarColorIndex`, `monogram`, `AVATAR_BG`.
  - `account-status.ts`: `deriveAccountUiStatus(account, now)`, `catchUpFraction(account)`, `backlogRemaining(account)`, `dailyRateFrom(history)`, `etaText(remaining, dailyRate)`, `providerName(provider)`, `minutesUntil(iso, now)`, `newestTickAt(accounts)`.
  - `platform.ts`: `detectPlatform(nav?)`, `modKey(p)`, `enterKey(p)`, `shiftKey(p)`, `ariaMod(p)`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/lib/confidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bandFor, inCleanup, membershipLine, scaleBands, toPercent } from "../../../src/web/lib/confidence.ts";

describe("bandFor", () => {
  it.each([0.8, 0.86, 0.95, 0.99])("uses the API tau %s for the Sure and Likely boundary", (tau) => {
    expect(bandFor(tau, tau, "delete")).toBe(tau >= 0.95 ? "very_sure" : "sure");
    expect(bandFor(tau - 0.0001, tau, "delete")).toBe("likely");
    expect(bandFor(0.7, tau, "archive")).toBe("likely");
    expect(bandFor(0.6999, tau, "archive")).toBe("unsure");
    expect(bandFor(0.95, tau, "keep")).toBe(tau > 0.95 ? "likely" : "very_sure");
  });

  it("always calls Check verdicts unsure", () => {
    expect(bandFor(0.99, 0.86, "unsure")).toBe("unsure");
  });
});

describe("toPercent", () => {
  it.each([
    [0.29, 29],
    [0.949, 94],
    [0.86, 86],
    [0.85, 85],
    [1, 100],
  ])("floors %s to %s", (value, expected) => {
    expect(toPercent(value)).toBe(expected);
  });
});

describe("inCleanup", () => {
  it("includes only Trash and Archive at Sure or Very sure", () => {
    expect(inCleanup("delete", "sure")).toBe(true);
    expect(inCleanup("archive", "very_sure")).toBe(true);
    expect(inCleanup("delete", "likely")).toBe(false);
    expect(inCleanup("keep", "very_sure")).toBe(false);
    expect(inCleanup("unsure", "unsure")).toBe(false);
  });
});

describe("scaleBands", () => {
  it("computes ranges from tau", () => {
    expect(scaleBands(0.86).map((b) => `${b.label}|${b.range}|${b.membership}`)).toEqual([
      "Very sure|95 to 100%|In Clean up",
      "Sure|86 to 94%|In Clean up",
      "Likely|70 to 85%|Left for you",
      "Unsure|Below 70%|Left for you",
    ]);
  });

  it("explains an empty Sure band above 95%", () => {
    const sure = scaleBands(0.96)[1];
    expect([sure?.range, sure?.membership]).toEqual(["None right now", "Threshold is above 95%"]);
  });
});

describe("membershipLine", () => {
  it("describes each case with the API tau", () => {
    expect(membershipLine("delete", { min: 0.91, max: 0.99 }, 0.86, 248)).toBe("All 248 are in Clean up.");
    expect(membershipLine("delete", { min: 0.91, max: 0.99 }, 0.86, 1)).toBe("The 1 email is in Clean up.");
    expect(membershipLine("delete", { min: 0.8, max: 0.9 }, 0.86, 3)).toBe(
      "Emails below 86% stay here for you after Clean up.",
    );
    expect(membershipLine("archive", { min: 0.74, max: 0.84 }, 0.86, 4)).toBe(
      "Below 86%, so Clean up leaves this group for you.",
    );
    expect(membershipLine("keep", { min: 0.9, max: 0.9 }, 0.86, 2)).toBe("Keep suggestions are not part of Clean up.");
    expect(membershipLine("unsure", { min: 0.4, max: 0.5 }, 0.86, 5)).toBe("Clearbox needs your call on this group.");
  });
});
```

`app/test/web/lib/format.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  activityWhen,
  configureFormat,
  formatCount,
  formatDayMonth,
  formatPercent,
  formatUsd,
  localResetTime,
  plural,
  relativeAgo,
  shortAge,
  truncateName,
} from "../../../src/web/lib/format.ts";

const NOW = Date.parse("2026-10-15T16:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => configureFormat({ locale: "en-GB", timeZone: "UTC" }));

describe("format", () => {
  it("formats counts and plurals", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(plural(1, "email", "emails")).toBe("1 email");
    expect(plural(1284, "email", "emails")).toBe("1,284 emails");
    expect(formatPercent(0.986, 1)).toBe("98.6%");
  });

  it("formats relative times", () => {
    expect(relativeAgo(ago(20_000), NOW)).toBe("just now");
    expect(relativeAgo(ago(4 * MIN), NOW)).toBe("4 min ago");
    expect(relativeAgo(ago(2 * HOUR), NOW)).toBe("2 h ago");
    expect(relativeAgo(ago(DAY + HOUR), NOW)).toBe("yesterday");
    expect(relativeAgo(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeAgo("2026-10-03T09:00:00.000Z", NOW)).toBe("3 Oct");
  });

  it("formats short ages for the email list", () => {
    expect(shortAge(ago(10_000), NOW)).toBe("now");
    expect(shortAge(ago(45 * MIN), NOW)).toBe("45m");
    expect(shortAge(ago(3 * HOUR), NOW)).toBe("3h");
    expect(shortAge(ago(2 * DAY), NOW)).toBe("2d");
    expect(shortAge(ago(35 * DAY), NOW)).toBe("5w");
    expect(shortAge("2024-03-10T00:00:00.000Z", NOW)).toBe("Mar 2024");
  });

  it("formats activity times", () => {
    expect(activityWhen("2026-10-15T16:21:00.000Z", NOW)).toBe("Today 16:21");
    expect(activityWhen("2026-10-14T09:02:00.000Z", NOW)).toBe("Yesterday 09:02");
    expect(activityWhen("2026-10-11T18:40:00.000Z", NOW)).toBe("Sun 11 Oct, 18:40");
  });

  it("renders the next UTC midnight in local time", () => {
    configureFormat({ locale: "en-GB", timeZone: "Asia/Jakarta" });
    expect(localResetTime(NOW)).toBe("07:00");
  });

  it("formats dates, money and names", () => {
    expect(formatDayMonth("2026-10-12", true)).toBe("12 Oct");
    expect(formatUsd(0.0588)).toBe("about $0.06");
    expect(formatUsd(0.004)).toBe("less than $0.01");
    expect(truncateName("Tokopedia Orders and Receipts Team")).toBe("Tokopedia Orders and Rec…");
    expect(truncateName("Mom")).toBe("Mom");
  });
});
```

`app/test/web/lib/avatar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AVATAR_BG, avatarColorIndex, fnv1a32, monogram } from "../../../src/web/lib/avatar.ts";

describe("avatar", () => {
  it("hashes deterministically with FNV-1a 32", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  it("maps a domain to a stable palette index, case and space insensitive", () => {
    const i = avatarColorIndex("northwind.example");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(12);
    expect(avatarColorIndex(" Northwind.Example ")).toBe(i);
    expect(AVATAR_BG[i]).toBe(`bg-avatar-${i}`);
  });

  it("builds monograms from names, addresses and Unicode", () => {
    expect(monogram("Northwind Deals", "promo@northwind.example", "northwind.example")).toBe("N");
    expect(monogram(null, "digest@news.example", "news.example")).toBe("D");
    expect(monogram("  ", "", "contoso.example")).toBe("C");
    expect(monogram("Élodie", "e@x.example", "x.example")).toBe("É");
    expect(monogram("***", "", "")).toBe("?");
  });
});
```

`app/test/web/lib/account-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  backlogRemaining,
  catchUpFraction,
  dailyRateFrom,
  deriveAccountUiStatus,
  etaText,
} from "../../../src/web/lib/account-status.ts";
import { T0, iso, makeAccount, makeSync } from "../msw/fixtures.ts";

describe("deriveAccountUiStatus", () => {
  it("applies the first matching rule", () => {
    expect(deriveAccountUiStatus(makeAccount({ status: "config_error", paused: true }), T0)).toBe("config_error");
    expect(deriveAccountUiStatus(makeAccount({ status: "needs_reauth", paused: true }), T0)).toBe("needs_reauth");
    expect(deriveAccountUiStatus(makeAccount({ paused: true }), T0)).toBe("paused");
    expect(
      deriveAccountUiStatus(makeAccount({ sync: makeSync({ backoffUntil: iso(T0 + 180_000), backfillDone: false }) }), T0),
    ).toBe("waiting");
    expect(deriveAccountUiStatus(makeAccount({ sync: makeSync({ backfillDone: false }) }), T0)).toBe("catching_up");
    expect(deriveAccountUiStatus(makeAccount({ sync: makeSync({ phase: "inbox_backfill" }) }), T0)).toBe("catching_up");
    expect(deriveAccountUiStatus(makeAccount(), T0)).toBe("up_to_date");
  });
});

describe("catch-up math (A4)", () => {
  it("uses inboxEstimate when known", () => {
    const a = makeAccount({ sync: makeSync({ backfillDone: false, messagesIngested: 8_200, inboxEstimate: 20_000 }) });
    expect(catchUpFraction(a)).toBeCloseTo(0.41, 9);
    expect(backlogRemaining(a)).toBe(11_800);
    expect(catchUpFraction(makeAccount({ sync: makeSync({ backfillDone: false }) }))).toBeNull();
  });

  it("estimates days from the last three complete days", () => {
    const history = [5_000, 6_000, 7_000, 8_000, 999].map((m, i) => ({
      date: `2026-10-${10 + i}`, rowsWritten: 0, messagesIngested: m, decisionCalls: 0,
    }));
    expect(dailyRateFrom(history)).toBe(7_000);
    expect(dailyRateFrom([])).toBe(6_800);
    expect(etaText(18_400, 6_800)).toBe("about 3 days");
    expect(etaText(8_000, 6_800)).toBe("about 1 day");
    expect(etaText(2_000, 6_800)).toBe("less than a day");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib`
Expected: FAIL with `Failed to load url ../../../src/web/lib/confidence.ts` (and the other three modules).

- [ ] **Step 3: Implement `view-types.ts` and `platform.ts`**

`app/src/web/lib/view-types.ts`:

```ts
import type { ActionKind, ProviderKind, ReasonCode, SuggestedAction } from "@clearbox/core";

export type { ActionKind, ProviderKind, ReasonCode, SuggestedAction };

export type Verdict = SuggestedAction;
export type TagKind = Verdict | "protected";
export type Band = "very_sure" | "sure" | "likely" | "unsure";
export type TabKey = "all" | "trash" | "archive" | "check" | "keep";
export type GroupSort = "confidence_desc" | "count_desc" | "newest";
export type Platform = "mac" | "other";
export type AccountUiStatus = "up_to_date" | "catching_up" | "paused" | "needs_reauth" | "config_error" | "waiting";

export const VERDICT_LABEL: Record<Verdict, string> = { delete: "Trash", archive: "Archive", keep: "Keep", unsure: "Check" };
export const BAND_LABEL: Record<Band, string> = { very_sure: "Very sure", sure: "Sure", likely: "Likely", unsure: "Unsure" };
export const TAB_ACTION: Record<TabKey, Verdict | undefined> = {
  all: undefined,
  trash: "delete",
  archive: "archive",
  check: "unsure",
  keep: "keep",
};
export const TAB_KEYS: readonly TabKey[] = ["all", "trash", "archive", "check", "keep"];
export const TAB_LABEL: Record<TabKey, string> = { all: "All", trash: "Trash", archive: "Archive", check: "Check", keep: "Keep" };
export const SORT_OPTIONS: readonly { value: GroupSort; label: string }[] = [
  { value: "confidence_desc", label: "Sort: Confidence" },
  { value: "count_desc", label: "Sort: Most emails" },
  { value: "newest", label: "Sort: Newest" },
];

export function isTabKey(v: string | null): v is TabKey {
  return v !== null && (TAB_KEYS as readonly string[]).includes(v);
}

export function isGroupSort(v: string | null): v is GroupSort {
  return v === "confidence_desc" || v === "count_desc" || v === "newest";
}
```

`app/src/web/lib/platform.ts`:

```ts
import type { Platform } from "./view-types.ts";

export function detectPlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): Platform {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent) ? "mac" : "other";
}

export const modKey = (p: Platform): string => (p === "mac" ? "⌘" : "Ctrl");
export const enterKey = (p: Platform): string => (p === "mac" ? "↵" : "Enter");
export const shiftKey = (p: Platform): string => (p === "mac" ? "⇧" : "Shift");
/** Value prefix for aria-keyshortcuts ("Meta+Enter" on mac, "Control+Enter" elsewhere). */
export const ariaMod = (p: Platform): "Meta" | "Control" => (p === "mac" ? "Meta" : "Control");
```

- [ ] **Step 4: Implement `format.ts`**

`app/src/web/lib/format.ts`:

```ts
interface FormatConfig {
  locale: string | undefined;
  timeZone: string | undefined;
}

const config: FormatConfig = { locale: undefined, timeZone: undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Browser locale and zone by default; tests pin en-GB and UTC so strings match the UI spec text. */
export function configureFormat(next: Partial<FormatConfig>): void {
  Object.assign(config, next);
}

const zone = (): { timeZone?: string } => (config.timeZone ? { timeZone: config.timeZone } : {});
const dtf = (opts: Intl.DateTimeFormatOptions, utc = false) =>
  new Intl.DateTimeFormat(config.locale, { ...opts, ...(utc ? { timeZone: "UTC" } : zone()) });

export function formatCount(n: number): string {
  return new Intl.NumberFormat(config.locale).format(n);
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function formatPercent(value: number, digits = 1): string {
  return new Intl.NumberFormat(config.locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function dayKey(ms: number): number {
  const key = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone() }).format(ms);
  return Date.parse(`${key}T00:00:00Z`);
}

/** Calendar days from a to b in the configured zone (b later gives a positive number). */
export function calendarDaysBetween(a: number, b: number): number {
  return Math.round((dayKey(b) - dayKey(a)) / DAY);
}

const time = (ms: number) => dtf({ hour: "2-digit", minute: "2-digit" }).format(ms);

export function formatDayMonth(isoOrDate: string, utc = false): string {
  return dtf({ day: "numeric", month: "short" }, utc).format(Date.parse(isoOrDate));
}

export function relativeAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  const d = Math.max(0, now - t);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = calendarDaysBetween(t, now);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDayMonth(iso);
}

export function shortAge(iso: string, now: number): string {
  const d = Math.max(0, now - Date.parse(iso));
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  if (d < 365 * DAY) return `${Math.floor(d / (7 * DAY))}w`;
  return dtf({ month: "short", year: "numeric" }).format(Date.parse(iso));
}

/** "Mon 13 Oct, 08:12" (detail panel meta line, older activity rows). */
export function formatWeekdayDateTime(iso: string): string {
  const t = Date.parse(iso);
  return `${dtf({ weekday: "short", day: "numeric", month: "short" }).format(t)}, ${time(t)}`;
}

export function activityWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  const days = calendarDaysBetween(t, now);
  if (days === 0) return `Today ${time(t)}`;
  if (days === 1) return `Yesterday ${time(t)}`;
  return formatWeekdayDateTime(iso);
}

/** The next 00:00 UTC (when the daily free-tier budget resets), in local time. */
export function localResetTime(now: number): string {
  return time((Math.floor(now / DAY) + 1) * DAY);
}

export function formatUsd(value: number): string {
  return value < 0.005 ? "less than $0.01" : `about $${value.toFixed(2)}`;
}

export function formatMb(bytes: number): string {
  return `${formatCount(Math.round(bytes / 1_000_000))} MB`;
}

export function truncateName(name: string, max = 24): string {
  const chars = Array.from(name);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : name;
}
```

- [ ] **Step 5: Implement `confidence.ts`, `avatar.ts` and `account-status.ts`**

`app/src/web/lib/confidence.ts`:

```ts
import type { ApiReason } from "../../shared/api.ts";
import { formatCount } from "./format.ts";
import type { Band, Verdict } from "./view-types.ts";

export const VERY_SURE_MIN = 0.95;
export const LIKELY_MIN = 0.7;

/** Band for a confidence value. tau always comes from the API. Check (unsure) verdicts are always "unsure". */
export function bandFor(confidence: number, tau: number, verdict: Verdict): Band {
  if (verdict === "unsure") return "unsure";
  if (confidence < LIKELY_MIN) return "unsure";
  if (confidence < tau) return "likely";
  if (confidence < VERY_SURE_MIN) return "sure";
  return "very_sure";
}

/** Floor, never round, so 0.949 shows "94%" and stays consistent with the band. Epsilon guards float drift. */
export function toPercent(confidence: number): number {
  return Math.floor(confidence * 100 + 1e-9);
}

/** True when this verdict and band are executed by Clean up. Keep is never in Clean up. */
export function inCleanup(verdict: Verdict, band: Band): boolean {
  return (verdict === "delete" || verdict === "archive") && (band === "sure" || band === "very_sure");
}

export const BAND_FILL: Record<Band, string> = {
  very_sure: "bg-band-very-sure",
  sure: "bg-band-sure",
  likely: "bg-band-likely",
  unsure: "bg-band-unsure",
};

export const BAND_INK: Record<Band, string> = {
  very_sure: "text-band-very-sure-ink",
  sure: "text-band-sure-ink",
  likely: "text-band-likely-ink",
  unsure: "text-band-unsure-ink",
};

export interface ScaleBand {
  band: Band;
  label: string;
  range: string;
  membership: string;
}

export function scaleBands(tau: number): ScaleBand[] {
  const t = toPercent(tau);
  const sure: ScaleBand =
    tau >= VERY_SURE_MIN
      ? { band: "sure", label: "Sure", range: "None right now", membership: "Threshold is above 95%" }
      : { band: "sure", label: "Sure", range: `${t} to 94%`, membership: "In Clean up" };
  return [
    { band: "very_sure", label: "Very sure", range: "95 to 100%", membership: "In Clean up" },
    sure,
    { band: "likely", label: "Likely", range: `70 to ${Math.min(t, 95) - 1}%`, membership: "Left for you" },
    { band: "unsure", label: "Unsure", range: "Below 70%", membership: "Left for you" },
  ];
}

/** Detail panel membership line (UI spec 4.14). */
export function membershipLine(verdict: Verdict, conf: { min: number; max: number }, tau: number, count: number): string {
  if (verdict === "keep") return "Keep suggestions are not part of Clean up.";
  if (verdict === "unsure") return "Clearbox needs your call on this group.";
  const p = toPercent(tau);
  if (conf.min >= tau) return count === 1 ? "The 1 email is in Clean up." : `All ${formatCount(count)} are in Clean up.`;
  if (conf.max >= tau) return `Emails below ${p}% stay here for you after Clean up.`;
  return `Below ${p}%, so Clean up leaves this group for you.`;
}

/** Short phrase for row accessible names (decision W17). */
export function membershipPhrase(verdict: Verdict, band: Band): string {
  if (inCleanup(verdict, band)) return "in Clean up";
  return verdict === "keep" ? "not in Clean up" : "left for you";
}

export function isModelUnavailable(group: { action: Verdict; topReasons: readonly ApiReason[] }): boolean {
  return group.action === "unsure" && group.topReasons[0]?.code === "model_unavailable";
}
```

`app/src/web/lib/avatar.ts`:

```ts
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function avatarColorIndex(domain: string): number {
  return fnv1a32(domain.trim().toLowerCase()) % 12;
}

export function monogram(name: string | null, address: string, domain: string): string {
  const source = (name ?? "").trim() || address.split("@")[0] || domain;
  const m = source.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toLocaleUpperCase() : "?";
}

/** Static list so Tailwind sees every class name. */
export const AVATAR_BG: readonly string[] = [
  "bg-avatar-0", "bg-avatar-1", "bg-avatar-2", "bg-avatar-3", "bg-avatar-4", "bg-avatar-5",
  "bg-avatar-6", "bg-avatar-7", "bg-avatar-8", "bg-avatar-9", "bg-avatar-10", "bg-avatar-11",
];
```

`app/src/web/lib/account-status.ts`:

```ts
import type { AccountView, Insights } from "../../shared/api.ts";
import type { AccountUiStatus, ProviderKind } from "./view-types.ts";

export function deriveAccountUiStatus(account: AccountView, now: number): AccountUiStatus {
  if (account.status === "config_error") return "config_error";
  if (account.status === "needs_reauth") return "needs_reauth";
  if (account.paused) return "paused";
  if (account.sync.backoffUntil && Date.parse(account.sync.backoffUntil) > now) return "waiting";
  if (account.sync.phase !== "incremental" || !account.sync.backfillDone) return "catching_up";
  return "up_to_date";
}

/** Share of the inbox sorted so far (A4, decision W20). Null when unknown or finished. */
export function catchUpFraction(account: Pick<AccountView, "sync">): number | null {
  const { inboxEstimate, messagesIngested, backfillDone } = account.sync;
  if (backfillDone || !inboxEstimate || inboxEstimate <= 0) return null;
  return Math.min(0.99, messagesIngested / inboxEstimate);
}

export function backlogRemaining(account: Pick<AccountView, "sync">): number | null {
  const { inboxEstimate, messagesIngested, backfillDone } = account.sync;
  if (backfillDone) return 0;
  if (!inboxEstimate) return null;
  return Math.max(0, inboxEstimate - messagesIngested);
}

/** Mean messagesIngested of the last 3 complete days (the last history entry is today). */
export function dailyRateFrom(history: Insights["history"]): number {
  const complete = history.slice(0, -1).slice(-3);
  if (complete.length === 0) return 6_800;
  const mean = complete.reduce((sum, d) => sum + d.messagesIngested, 0) / complete.length;
  return mean > 0 ? mean : 6_800;
}

export function etaText(remaining: number, dailyRate: number): string {
  const days = remaining / dailyRate;
  if (days < 0.5) return "less than a day";
  if (days < 1.5) return "about 1 day";
  return `about ${Math.ceil(days)} days`;
}

export const providerName = (p: ProviderKind): "Gmail" | "Outlook" => (p === "gmail" ? "Gmail" : "Outlook");

export function minutesUntil(iso: string, now: number): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** Newest lastTickAt among active accounts, for "Sorted 4 min ago". */
export function newestTickAt(accounts: readonly AccountView[]): string | null {
  const ticks = accounts
    .filter((a) => a.status === "active" && a.sync.lastTickAt)
    .map((a) => a.sync.lastTickAt as string)
    .sort();
  return ticks[ticks.length - 1] ?? null;
}
```

- [ ] **Step 6: Pin the test locale and zone**

Replace `app/test/web/setup.ts` with:

```ts
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { configureFormat } from "../../src/web/lib/format.ts";
import { installMatchMedia, resetViewport } from "./helpers/viewport.ts";
import { server } from "./msw/server.ts";

installMatchMedia();
configureFormat({ locale: "en-GB", timeZone: "UTC" });
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetViewport();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib`
Expected: PASS (4 files). If `fnv1a32("a")` differs, the implementation is not FNV-1a 32 (offset basis `0x811c9dc5`, prime `0x01000193`); fix the code, not the test.

- [ ] **Step 8: Commit**

```bash
git add app/src/web/lib app/test/web/lib app/test/web/setup.ts
git commit -m "feat(web): add confidence bands, formatters, avatars and account status helpers"
```

---

### Task 4: Typed API client, response schemas, endpoints and query keys

**Files:**
- Create: `app/src/web/lib/report.ts`, `app/src/web/api/client.ts`, `app/src/web/api/schemas.ts`, `app/src/web/api/endpoints.ts`, `app/src/web/api/keys.ts`
- Test: `app/test/web/api/client.test.ts`

**Interfaces:**
- Consumes: from `src/shared/api.ts` the runtime values `CSRF_HEADER`, `CSRF_VALUE`, `PutPolicyBodySchema` and the contract types; `Verdict`, `GroupSort` from Task 3.
- Produces:
  - `report.ts`: `reportBug(message: string, detail?: unknown): void`, `installCspListener(target?: Document): () => void`.
  - `client.ts`: `class ApiError extends Error { status: number; code: ApiErrorKind; retryAt: string | undefined; details: unknown }`, `type ApiErrorKind = ApiErrorCode | "network" | "invalid_response"`, `type SessionError = "unauthenticated" | "forbidden" | "access_misconfigured"`, `interface Store<T> { get(): T; set(v: T): void; subscribe(cb: () => void): () => void }`, `sessionErrorStore: Store<SessionError | null>`, `networkFailureStore: Store<number>`, `apiGet(path, schema, params?)`, `apiSend(method, path, schema, body?)`, `isApiError(e): e is ApiError`.
  - `schemas.ts`: `MeResponseSchema`, `AccountViewSchema`, `AccountsResponseSchema`, `DisconnectResponseSchema`, `TickReportSchema`, `QueueSummarySchema`, `SenderGroupSchema`, `SenderGroupPageSchema`, `SuggestionItemSchema`, `GroupDetailSchema`, `CleanupPreviewSchema`, `ActionResponseSchema`, `ActionBatchPageSchema`, `UndoResponseSchema`, `ActivityPageSchema`, `InsightsSchema`, `PolicyResponseSchema`.
  - `endpoints.ts`: `api` object with `me()`, `accounts()`, `patchAccount(id, body)`, `disconnectAccount(id)`, `scanAccount(id)`, `summary(accountId?)`, `groups(q)`, `groupDetail(key, q?)`, `approve(body)`, `override(body)`, `cleanupPreview(q)`, `cleanup(body)`, `batches(q?)`, `undoBatch(id)`, `activity(q)`, `insights()`, `policy()`, `putPolicy(body)`, `patchSender(body)`; types `GroupsQuery`, `PreviewQuery`, `PageParams`, `PutPolicyBody`, `PatchSenderBody`.
  - `keys.ts`: `qk` exactly as UI spec 8.3.

- [ ] **Step 1: Write the failing client test**

`app/test/web/api/client.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, networkFailureStore, sessionErrorStore } from "../../../src/web/api/client.ts";
import { api } from "../../../src/web/api/endpoints.ts";
import { qk } from "../../../src/web/api/keys.ts";
import { ACC_GMAIL, iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

afterEach(() => {
  sessionErrorStore.set(null);
  networkFailureStore.set(0);
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("sends X-Clearbox-CSRF: 1 on every mutation and never on GETs", async () => {
    const state = installFakeApi();
    await api.me();
    await api.summary(ACC_GMAIL);
    await api.override({ ids: [1000], action: "keep" });
    await api.patchAccount(ACC_GMAIL, { paused: true });
    await api.putPolicy({ policy: state.policy.policy, expectedVersion: state.policy.version });
    await api.patchSender({ entry: "@bank.example", list: "none" });
    await api.disconnectAccount(ACC_GMAIL);
    const gets = state.requests.filter((r) => r.method === "GET");
    const mutations = state.requests.filter((r) => r.method !== "GET");
    expect(gets.map((r) => r.csrf)).toEqual([null, null]);
    expect(mutations.map((r) => `${r.method} ${r.csrf}`)).toEqual(["POST 1", "PATCH 1", "PUT 1", "PATCH 1", "DELETE 1"]);
  });

  it("drops empty query parameters", async () => {
    const state = installFakeApi();
    await api.groups({ sort: "confidence_desc", limit: 50 });
    expect(state.requests[0]?.url.search).toBe("?sort=confidence_desc&limit=50");
  });

  it("maps the error envelope to ApiError", async () => {
    installFakeApi((s) => {
      s.failures.summary = { status: 429, code: "budget_exhausted", times: 1, retryAt: iso(T0 + 60_000) };
    });
    const error = await api.summary().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "budget_exhausted", retryAt: iso(T0 + 60_000) });
  });

  it("maps fetch rejection to a network error and counts consecutive failures", async () => {
    installFakeApi((s) => {
      s.failures.me = { status: 0, code: "network", times: 2 };
    });
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: "network" });
    await expect(api.me()).rejects.toMatchObject({ code: "network" });
    expect(networkFailureStore.get()).toBe(2);
    await api.me();
    expect(networkFailureStore.get()).toBe(0);
  });

  it.each([
    [401, "unauthenticated", "unauthenticated"],
    [403, "forbidden", "forbidden"],
    [500, "access_misconfigured", "access_misconfigured"],
  ] as const)("publishes %s %s as a session error", async (status, code, expected) => {
    installFakeApi((s) => {
      s.failures.accounts = { status, code, times: 1 };
    });
    await expect(api.accounts()).rejects.toBeInstanceOf(ApiError);
    expect(sessionErrorStore.get()).toBe(expected);
  });

  it("does not treat csrf_required as a session error", async () => {
    installFakeApi((s) => {
      s.failures.override = { status: 403, code: "csrf_required", times: 1 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(api.override({ ids: [1000], action: "keep" })).rejects.toMatchObject({ code: "csrf_required" });
    expect(sessionErrorStore.get()).toBeNull();
  });

  it("rejects a response that does not match the contract", async () => {
    server.use(http.get("*/api/me", () => HttpResponse.json({ email: 5 })));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(api.me()).rejects.toMatchObject({ code: "invalid_response" });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("query keys", () => {
  it("matches UI spec 8.3", () => {
    expect(qk.summary()).toEqual(["queue", "summary", { accountId: null }]);
    expect(qk.preview("acc_1")).toEqual(["cleanup", "preview", { accountId: "acc_1", actions: "delete,archive" }]);
    expect(qk.groups({ sort: "confidence_desc" })).toEqual([
      "groups", { accountId: null, action: null, sort: "confidence_desc" },
    ]);
    expect(qk.group("k1")).toEqual(["group", "k1"]);
    expect(qk.activity()).toEqual(["activity", { accountId: null }]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/client.test.ts`
Expected: FAIL with `Failed to load url ../../../src/web/api/client.ts`.

- [ ] **Step 3: Implement `report.ts` and `client.ts`**

`app/src/web/lib/report.ts`:

```ts
/** The single console sink of the SPA (contracts 3.8 bans console elsewhere; decision W5). */
export function reportBug(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[clearbox] ${message}`, detail);
}

/** Makes CSP violations obvious in every build (UI spec 8.4 item 7). */
export function installCspListener(target: Document = document): () => void {
  const onViolation = (e: SecurityPolicyViolationEvent) =>
    reportBug(`CSP blocked ${e.effectiveDirective || e.violatedDirective}`, e.blockedURI);
  target.addEventListener("securitypolicyviolation", onViolation);
  return () => target.removeEventListener("securitypolicyviolation", onViolation);
}
```

`app/src/web/api/client.ts`:

```ts
import type { z } from "zod";
import { CSRF_HEADER, CSRF_VALUE, type ApiErrorBody, type ApiErrorCode } from "../../shared/api.ts";
import { reportBug } from "../lib/report.ts";

export type ApiErrorKind = ApiErrorCode | "network" | "invalid_response";
export type SessionError = "unauthenticated" | "forbidden" | "access_misconfigured";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorKind;
  readonly retryAt: string | undefined;
  readonly details: unknown;
  constructor(status: number, code: ApiErrorKind, message: string, retryAt?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
    this.details = details;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(cb: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const cb of [...subs]) cb();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Read by the root layout (UI spec 5.9). */
export const sessionErrorStore = createStore<SessionError | null>(null);
/** Consecutive network failures; two or more means offline (UI spec 5.9). */
export const networkFailureStore = createStore<number>(0);

type Params = Record<string, string | number | null | undefined>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function buildUrl(path: string, params?: Params): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function publishSessionError(status: number, code: ApiErrorKind): void {
  if (status === 401) sessionErrorStore.set("unauthenticated");
  else if (status === 403 && code === "forbidden") sessionErrorStore.set("forbidden");
  else if (code === "access_misconfigured") sessionErrorStore.set("access_misconfigured");
}

async function toApiError(res: Response, label: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  const e = body?.error;
  const code: ApiErrorKind = e?.code ?? (res.status >= 500 ? "internal" : "invalid_response");
  publishSessionError(res.status, code);
  if (code === "csrf_required") reportBug(`CSRF header rejected on ${label}`);
  return new ApiError(res.status, code, e?.message ?? `HTTP ${res.status}`, e?.retryAt, e?.details);
}

async function request<S extends z.ZodType>(method: Method, url: string, label: string, schema: S, init: RequestInit): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, method, credentials: "same-origin", redirect: "manual" });
  } catch {
    networkFailureStore.set(networkFailureStore.get() + 1);
    throw new ApiError(0, "network", "Network error");
  }
  networkFailureStore.set(0);
  if (res.type === "opaqueredirect") {
    // Cloudflare Access redirects expired sessions to its login page (decision W21).
    publishSessionError(401, "unauthenticated");
    throw new ApiError(401, "unauthenticated", "Session expired");
  }
  if (!res.ok) throw await toApiError(res, label);
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    reportBug(`Unexpected response from ${label}`, parsed.error.issues);
    throw new ApiError(res.status, "invalid_response", "Unexpected response");
  }
  return parsed.data;
}

export function apiGet<S extends z.ZodType>(path: string, schema: S, params?: Params): Promise<z.output<S>> {
  return request("GET", buildUrl(path, params), `GET ${path}`, schema, { headers: { Accept: "application/json" } });
}

export function apiSend<S extends z.ZodType>(
  method: Exclude<Method, "GET">,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const headers: Record<string, string> = { Accept: "application/json", [CSRF_HEADER]: CSRF_VALUE };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return request(method, buildUrl(path), `${method} ${path}`, schema, {
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
```

- [ ] **Step 4: Implement `schemas.ts`**

`app/src/web/api/schemas.ts`:

```ts
import type { ReasonCode } from "@clearbox/core";
import { z } from "zod";
import {
  PutPolicyBodySchema,
  type AccountsResponse,
  type AccountSync,
  type AccountView,
  type ActionBatchView,
  type ActionResponse,
  type ActivityEntry,
  type ActivityKind,
  type ApiReason,
  type AppIssueCode,
  type CleanupPreview,
  type DisconnectResponse,
  type GroupDetail,
  type Insights,
  type ItemErrorCode,
  type ItemSignals,
  type MeResponse,
  type Page,
  type PolicyResponse,
  type QueueSummary,
  type SenderGroup,
  type SuggestionItem,
  type TickReport,
  type UndoResponse,
} from "../../shared/api.ts";

// Every schema is checked against its contract type with `satisfies` (decision W1).
const str = z.string();
const num = z.number();
const bool = z.boolean();
const nstr = z.string().nullable();
const actionKind = z.enum(["delete", "archive", "keep"]);
const suggested = z.enum(["delete", "archive", "keep", "unsure"]);
const provider = z.enum(["gmail", "outlook"]);
const byActionKind = z.object({ delete: num, archive: num, keep: num });
const bySuggested = z.object({ delete: num, archive: num, keep: num, unsure: num });
const anyString = <T extends string>() => z.custom<T>((v) => typeof v === "string");

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: nstr });
}

export const ApiReasonSchema = z.object({ code: anyString<ReasonCode>(), text: str }) satisfies z.ZodType<ApiReason>;

export const MeResponseSchema = z.object({
  email: str,
  environment: z.enum(["development", "test", "production"]),
  freeTier: bool,
  providers: z.object({ gmail: bool, outlook: bool }),
  issues: z.array(z.object({ code: anyString<AppIssueCode>(), since: str, accountId: nstr })),
  tauDelete: num,
  serverTime: str,
}) satisfies z.ZodType<MeResponse>;

export const AccountSyncSchema = z.object({
  phase: z.enum(["sent_backfill", "inbox_backfill", "incremental"]),
  backfillDone: bool,
  messagesIngested: num,
  pendingCount: num,
  awaitingModelCount: num,
  lastTickAt: nstr,
  nextTickAt: nstr,
  backoffUntil: nstr,
  lastErrorCode: nstr,
  pageSize: num,
  inboxEstimate: num.nullable(),
}) satisfies z.ZodType<AccountSync>;

const accountStatus = z.enum(["active", "needs_reauth", "config_error"]);

export const AccountViewSchema = z.object({
  id: str,
  provider,
  email: str,
  status: accountStatus,
  statusReason: nstr,
  paused: bool,
  archiveSupported: bool,
  sync: AccountSyncSchema,
  createdAt: str,
}) satisfies z.ZodType<AccountView>;

export const AccountsResponseSchema = z.object({ accounts: z.array(AccountViewSchema) }) satisfies z.ZodType<AccountsResponse>;

export const DisconnectResponseSchema = z.object({
  accountId: str,
  revocation: z.enum(["revoked", "failed", "not_supported"]),
  consentUrls: z.object({ personal: str, work: str }).nullable(),
}) satisfies z.ZodType<DisconnectResponse>;

export const TickReportSchema = z.object({
  outcome: z.enum(["processed", "idle", "error"]),
  accountId: nstr,
  kind: z.enum(["sent_backfill", "inbox_backfill", "incremental", "redecide"]).nullable(),
  phase: z.enum(["sent_backfill", "inbox_backfill", "incremental"]).nullable(),
  fetched: num,
  skippedKnown: num,
  decided: num,
  deferred: num,
  unsure: num,
  removed: num,
  subrequests: num,
  rowsWritten: num,
  nextTickAt: nstr,
  errorCode: nstr,
}) satisfies z.ZodType<TickReport>;

export const QueueSummarySchema = z.object({
  asOf: str,
  pending: bySuggested.extend({ total: num }),
  awaitingModel: num,
  groups: num,
  tauDelete: num,
  cleanup: z.object({ threshold: num, count: num, byAction: byActionKind }),
  groupsByAction: bySuggested,
}) satisfies z.ZodType<QueueSummary>;

export const SenderGroupSchema = z.object({
  key: str,
  accountId: str,
  provider,
  sender: str,
  senderName: nstr,
  domain: str,
  action: suggested,
  count: num,
  confidence: z.object({ min: num, avg: num, max: num }),
  topReasons: z.array(ApiReasonSchema),
  ceilingApplied: bool,
  newestReceivedAt: str,
  oldestReceivedAt: str,
  latestSubject: nstr,
}) satisfies z.ZodType<SenderGroup>;

export const SenderGroupPageSchema = pageSchema(SenderGroupSchema) satisfies z.ZodType<Page<SenderGroup>>;

export const SuggestionItemSchema = z.object({
  id: num,
  accountId: str,
  provider,
  status: z.enum(["awaiting_model", "pending", "approved", "executed", "failed", "dismissed", "undone"]),
  action: suggested,
  confidence: num,
  distribution: bySuggested.nullable(),
  importance: num.nullable(),
  ceiling: actionKind,
  ceilingApplied: bool,
  reasons: z.array(ApiReasonSchema),
  from: z.object({ address: str, name: nstr }),
  subject: nstr,
  snippet: nstr,
  receivedAt: str,
  isRead: bool,
  signals: z.custom<ItemSignals>((v) => typeof v === "object" && v !== null),
  deepLink: nstr,
  modelVersion: nstr,
  policyVersion: num,
}) satisfies z.ZodType<SuggestionItem>;

export const GroupDetailSchema = z.object({
  asOf: str,
  group: SenderGroupSchema,
  items: pageSchema(SuggestionItemSchema),
}) satisfies z.ZodType<GroupDetail>;

export const CleanupPreviewSchema = z.object({
  asOf: str,
  threshold: num,
  defaultThreshold: num,
  count: num,
  byAction: byActionKind,
  groups: num,
  groupsLeft: num,
}) satisfies z.ZodType<CleanupPreview>;

export const ActionResponseSchema = z.object({
  batchId: num.nullable(),
  results: z.array(
    z.object({
      id: num,
      outcome: z.enum(["executed", "failed", "skipped", "retry_later"]),
      action: actionKind.nullable(),
      error: anyString<ItemErrorCode>().nullable(),
    }),
  ),
  executed: num,
  failed: num,
  skipped: num,
  retryLater: num,
  remaining: num,
}) satisfies z.ZodType<ActionResponse>;

export const ActionBatchViewSchema = z.object({
  id: num,
  kind: z.enum(["approve", "override", "cleanup"]),
  createdAt: str,
  requestedCount: num,
  executedCount: num,
  failedCount: num,
  byAction: byActionKind,
  undoable: bool,
  undoExpiresAt: str,
  undoneAt: nstr,
}) satisfies z.ZodType<ActionBatchView>;

export const ActionBatchPageSchema = pageSchema(ActionBatchViewSchema) satisfies z.ZodType<Page<ActionBatchView>>;

export const UndoResponseSchema = z.object({
  batchId: num,
  results: z.array(
    z.object({ id: num, outcome: z.enum(["restored", "failed", "skipped"]), error: anyString<ItemErrorCode>().nullable() }),
  ),
  restored: num,
  failed: num,
  skipped: num,
}) satisfies z.ZodType<UndoResponse>;

export const ActivityEntrySchema = z.object({
  id: num,
  ts: str,
  kind: anyString<ActivityKind>(),
  accountId: nstr,
  batchId: num.nullable(),
  count: num,
  result: z.record(z.string(), z.union([num, str])),
}) satisfies z.ZodType<ActivityEntry>;

export const ActivityPageSchema = pageSchema(ActivityEntrySchema) satisfies z.ZodType<Page<ActivityEntry>>;

export const InsightsSchema = z.object({
  precision: z.object({ deletePrecision: num.nullable(), deleteSuggestionsDecided: num, window: num }),
  labels: z.object({ total: num, last7Days: num }),
  calibration: z.object({
    tauDelete: num,
    outcome: z.enum(["insufficient_data", "calibrated", "no_tau_meets_target"]).nullable(),
    ranAt: nstr,
    points: z.array(z.object({ tau: num, support: num, precision: num.nullable() })),
  }),
  budget: z.object({
    date: str,
    rowsWritten: num,
    rowsCap: num,
    ingestStopRows: num,
    d1DailyWriteLimit: num,
    ticks: num,
    messagesIngested: num,
    decisionCalls: num,
    decisionFailures: num,
    decisionInputTokens: num,
    estimatedDecisionCostUsd: num,
    dbSizeBytes: num,
    dbSizeLimitBytes: num,
  }),
  history: z.array(z.object({ date: str, rowsWritten: num, messagesIngested: num, decisionCalls: num })),
  accounts: z.array(
    z.object({ id: str, provider, email: str, status: accountStatus, paused: bool, sync: AccountSyncSchema }),
  ),
  weekly: z.array(z.object({ weekStart: str, cleaned: num, undone: num })),
}) satisfies z.ZodType<Insights>;

const policy = PutPolicyBodySchema.shape.policy;

export const PolicyResponseSchema = z.object({ policy, version: num, defaults: policy }) satisfies z.ZodType<PolicyResponse>;
```

- [ ] **Step 5: Implement `endpoints.ts` and `keys.ts`**

`app/src/web/api/endpoints.ts`:

```ts
import type { z } from "zod";
import type {
  ApproveBody,
  CleanupBody,
  OverrideBody,
  PatchAccountBody,
  PatchSenderBodySchema,
  PutPolicyBodySchema,
} from "../../shared/api.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";
import { apiGet, apiSend } from "./client.ts";
import {
  AccountsResponseSchema,
  AccountViewSchema,
  ActionBatchPageSchema,
  ActionResponseSchema,
  ActivityPageSchema,
  CleanupPreviewSchema,
  DisconnectResponseSchema,
  GroupDetailSchema,
  InsightsSchema,
  MeResponseSchema,
  PolicyResponseSchema,
  QueueSummarySchema,
  SenderGroupPageSchema,
  TickReportSchema,
  UndoResponseSchema,
} from "./schemas.ts";

export type PutPolicyBody = z.input<typeof PutPolicyBodySchema>;
export type PatchSenderBody = z.input<typeof PatchSenderBodySchema>;

export interface PageParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}
export interface GroupsQuery extends PageParams {
  accountId?: string | undefined;
  action?: Verdict | undefined;
  sort: GroupSort;
}
export interface PreviewQuery {
  actions: string;
  accountId?: string | undefined;
  threshold?: number | undefined;
}

const seg = encodeURIComponent;

export const api = {
  me: () => apiGet("/api/me", MeResponseSchema),
  accounts: () => apiGet("/api/accounts", AccountsResponseSchema),
  patchAccount: (id: string, body: PatchAccountBody) => apiSend("PATCH", `/api/accounts/${seg(id)}`, AccountViewSchema, body),
  disconnectAccount: (id: string) => apiSend("DELETE", `/api/accounts/${seg(id)}`, DisconnectResponseSchema),
  scanAccount: (id: string) => apiSend("POST", `/api/accounts/${seg(id)}/scan`, TickReportSchema),
  summary: (accountId?: string) => apiGet("/api/queue/summary", QueueSummarySchema, { accountId }),
  groups: (q: GroupsQuery) =>
    apiGet("/api/groups", SenderGroupPageSchema, {
      accountId: q.accountId, action: q.action, sort: q.sort, limit: q.limit, cursor: q.cursor,
    }),
  groupDetail: (key: string, q: PageParams = {}) =>
    apiGet(`/api/groups/${seg(key)}`, GroupDetailSchema, { limit: q.limit, cursor: q.cursor }),
  approve: (body: ApproveBody) => apiSend("POST", "/api/approve", ActionResponseSchema, body),
  override: (body: OverrideBody) => apiSend("POST", "/api/override", ActionResponseSchema, body),
  cleanupPreview: (q: PreviewQuery) =>
    apiGet("/api/cleanup/preview", CleanupPreviewSchema, { actions: q.actions, accountId: q.accountId, threshold: q.threshold }),
  cleanup: (body: CleanupBody) => apiSend("POST", "/api/cleanup", ActionResponseSchema, body),
  batches: (q: PageParams = {}) => apiGet("/api/batches", ActionBatchPageSchema, { limit: q.limit, cursor: q.cursor }),
  undoBatch: (id: number) => apiSend("POST", `/api/batches/${id}/undo`, UndoResponseSchema),
  activity: (q: PageParams & { accountId?: string | undefined }) =>
    apiGet("/api/activity", ActivityPageSchema, { accountId: q.accountId, limit: q.limit, cursor: q.cursor }),
  insights: () => apiGet("/api/insights", InsightsSchema),
  policy: () => apiGet("/api/policy", PolicyResponseSchema),
  putPolicy: (body: PutPolicyBody) => apiSend("PUT", "/api/policy", PolicyResponseSchema, body),
  patchSender: (body: PatchSenderBody) => apiSend("PATCH", "/api/policy/senders", PolicyResponseSchema, body),
};
```

`app/src/web/api/keys.ts`:

```ts
import type { GroupKey } from "../../shared/api.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";

export const qk = {
  me: ["me"] as const,
  accounts: ["accounts"] as const,
  summary: (accountId?: string) => ["queue", "summary", { accountId: accountId ?? null }] as const,
  preview: (accountId?: string, actions = "delete,archive") =>
    ["cleanup", "preview", { accountId: accountId ?? null, actions }] as const,
  groups: (f: { accountId?: string | undefined; action?: Verdict | undefined; sort: GroupSort }) =>
    ["groups", { accountId: f.accountId ?? null, action: f.action ?? null, sort: f.sort }] as const,
  group: (key: GroupKey) => ["group", key] as const,
  batches: ["batches"] as const,
  activity: (accountId?: string) => ["activity", { accountId: accountId ?? null }] as const,
  insights: ["insights"] as const,
  policy: ["policy"] as const,
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/client.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Typecheck the schemas against the contract types**

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exit 0. A `satisfies` error names the contract type whose shape changed; fix the schema to match `src/shared/api.ts`, never the other way round.

- [ ] **Step 8: Commit**

```bash
git add app/src/web/lib/report.ts app/src/web/api app/test/web/api/client.test.ts
git commit -m "feat(web): add zod-validated API client, endpoints and query keys"
```

---

### Task 5: Query client, query hooks, polling cadence and simple mutations

**Files:**
- Create: `app/src/web/api/query-client.ts`, `app/src/web/api/queries.ts`, `app/src/web/api/mutations.ts`, `app/test/web/helpers/query.tsx`
- Test: `app/test/web/api/queries.test.tsx`

**Interfaces:**
- Consumes: `api`, `qk`, `isApiError` (Task 4); `deriveAccountUiStatus` (Task 3).
- Produces:
  - `createQueryClient(opts?: { retryDelayMs?: number }): QueryClient` (UI spec 6.7 global defaults).
  - Hooks: `useMe()`, `useAccounts(opts?: { fast?: boolean })`, `useQueueSummary(accountId?)`, `useCleanupPreview(accountId: string | undefined, polling: boolean)`, `useGroups(f: { accountId?; action?; sort })` (infinite, page size 50), `useGroupDetail(key: string | null)` (infinite, page size 20), `useBatches(active: boolean)`, `useActivity(accountId?)` (infinite), `useInsights()`, `usePolicy()`.
  - Helpers: `accountsInterval(accounts, fast, now): number`, `groupDetailOptions(key)`, `prefetchGroupDetail(qc, key)`, `flattenGroups(data)`.
  - Mutations: `usePatchAccount()` (optimistic pause with rollback), `useDisconnectAccount()`, `usePatchSender()`, `usePutPolicy()`, `invalidateAfterActions(qc)`, `ACTION_CACHE_PREFIXES`.
  - Test helpers: `createTestQueryClient()`, `QueryWrapper` from `test/web/helpers/query.tsx`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/helpers/query.tsx`:

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createQueryClient } from "../../../src/web/api/query-client.ts";

export function createTestQueryClient(): QueryClient {
  return createQueryClient({ retryDelayMs: 0 });
}

export function queryWrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
```

`app/test/web/api/queries.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http } from "msw";
import { describe, expect, it } from "vitest";
import { qk } from "../../../src/web/api/keys.ts";
import { usePatchAccount } from "../../../src/web/api/mutations.ts";
import { accountsInterval, flattenGroups, useAccounts, useGroups } from "../../../src/web/api/queries.ts";
import type { AccountsResponse } from "../../../src/shared/api.ts";
import { createTestQueryClient, queryWrapper } from "../helpers/query.tsx";
import { ACC_GMAIL, T0, makeAccount, makeGroupItems, makeSync } from "../msw/fixtures.ts";
import { errorResponse, installFakeApi } from "../msw/handlers.ts";
import { server } from "../msw/server.ts";

describe("accountsInterval (UI spec 6.7)", () => {
  it("polls every 15 s while any account is busy, else every 60 s", () => {
    expect(accountsInterval([makeAccount()], false, T0)).toBe(60_000);
    expect(accountsInterval([makeAccount({ sync: makeSync({ backfillDone: false }) })], false, T0)).toBe(15_000);
    expect(accountsInterval([makeAccount({ sync: makeSync({ awaitingModelCount: 3 }) })], false, T0)).toBe(15_000);
    expect(accountsInterval([makeAccount()], true, T0)).toBe(15_000);
  });
});

describe("useGroups", () => {
  it("pages with limit 50 and the server cursor", async () => {
    const state = installFakeApi((s) => {
      s.items = Array.from({ length: 60 }, (_, i) =>
        makeGroupItems(
          { accountId: ACC_GMAIL, sender: `s${i}@bulk.example`, name: null, action: "delete",
            confidences: [0.9], subjects: ["Hi"], reasons: [] },
          5000 + i,
        ),
      ).flat();
    });
    const client = createTestQueryClient();
    const { result } = renderHook(() => useGroups({ sort: "confidence_desc" }), { wrapper: queryWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(flattenGroups(result.current.data)).toHaveLength(50);
    expect(result.current.hasNextPage).toBe(true);
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(flattenGroups(result.current.data)).toHaveLength(60));
    expect(state.requests.filter((r) => r.route === "groups").map((r) => r.url.searchParams.get("cursor"))).toEqual([null, "50"]);
  });
});

describe("usePatchAccount", () => {
  it("flips paused optimistically and rolls back on error", async () => {
    installFakeApi();
    server.use(
      http.patch("*/api/accounts/:id", async () => {
        await delay(150);
        return errorResponse(500, "internal");
      }),
    );
    const client = createTestQueryClient();
    const wrapper = queryWrapper(client);
    const accounts = renderHook(() => useAccounts(), { wrapper });
    await waitFor(() => expect(accounts.result.current.isSuccess).toBe(true));
    const mutation = renderHook(() => usePatchAccount(), { wrapper });
    act(() => mutation.result.current.mutate({ id: ACC_GMAIL, paused: true }));
    await waitFor(() =>
      expect(client.getQueryData<AccountsResponse>(qk.accounts)?.accounts[0]?.paused).toBe(true),
    );
    await waitFor(() => expect(mutation.result.current.isError).toBe(true));
    expect(client.getQueryData<AccountsResponse>(qk.accounts)?.accounts[0]?.paused).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/queries.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/api/query-client.ts`.

- [ ] **Step 3: Implement `query-client.ts`**

`app/src/web/api/query-client.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./client.ts";

/** UI spec 6.7: one retry for queries (never for 4xx), none for mutations. */
export function createQueryClient(opts: { retryDelayMs?: number } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          failureCount < 1 && !(isApiError(error) && error.status >= 400 && error.status < 500),
        ...(opts.retryDelayMs !== undefined ? { retryDelay: opts.retryDelayMs } : {}),
        refetchOnReconnect: true,
        refetchIntervalInBackground: false,
        networkMode: "online",
      },
      mutations: { retry: 0, networkMode: "online" },
    },
  });
}
```

- [ ] **Step 4: Implement `queries.ts`**

`app/src/web/api/queries.ts`:

```ts
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { AccountView, ActionBatchView, Page, SenderGroup } from "../../shared/api.ts";
import { deriveAccountUiStatus } from "../lib/account-status.ts";
import type { GroupSort, Verdict } from "../lib/view-types.ts";
import { api } from "./endpoints.ts";
import { qk } from "./keys.ts";

const MIN = 60_000;

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 5 * MIN, refetchOnWindowFocus: true });
}

export function accountsInterval(accounts: readonly AccountView[] | undefined, fast: boolean, now: number): number {
  if (fast) return 15_000;
  const busy = (accounts ?? []).some((a) => {
    const status = deriveAccountUiStatus(a, now);
    return status === "catching_up" || status === "waiting" || a.sync.awaitingModelCount > 0;
  });
  return busy ? 15_000 : 60_000;
}

/** `fast` is set while a scan runs or the Setup page is open. */
export function useAccounts(opts: { fast?: boolean } = {}) {
  const fast = opts.fast ?? false;
  return useQuery({
    queryKey: qk.accounts,
    queryFn: api.accounts,
    staleTime: 10_000,
    refetchInterval: (q) => accountsInterval(q.state.data?.accounts, fast, Date.now()),
    refetchOnWindowFocus: true,
  });
}

export function useQueueSummary(accountId?: string) {
  return useQuery({
    queryKey: qk.summary(accountId),
    queryFn: () => api.summary(accountId),
    staleTime: 0,
    refetchInterval: MIN,
    refetchOnWindowFocus: true,
  });
}

/** Polls only while the Clean up machine is idle; Clean up always fetches a fresh preview itself. */
export function useCleanupPreview(accountId: string | undefined, polling: boolean) {
  return useQuery({
    queryKey: qk.preview(accountId),
    queryFn: () => api.cleanupPreview({ actions: "delete,archive", accountId }),
    staleTime: 0,
    refetchInterval: polling ? MIN : false,
    refetchOnWindowFocus: polling,
  });
}

export interface GroupFilter {
  accountId?: string | undefined;
  action?: Verdict | undefined;
  sort: GroupSort;
}

export function groupsOptions(f: GroupFilter) {
  return infiniteQueryOptions({
    queryKey: qk.groups(f),
    queryFn: ({ pageParam }) => api.groups({ ...f, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p: Page<SenderGroup>) => p.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGroups(f: GroupFilter) {
  return useInfiniteQuery(groupsOptions(f));
}

export function flattenGroups(data: InfiniteData<Page<SenderGroup>> | undefined): SenderGroup[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

export function groupDetailOptions(key: string) {
  return infiniteQueryOptions({
    queryKey: qk.group(key),
    queryFn: ({ pageParam }) => api.groupDetail(key, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (d) => d.items.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGroupDetail(key: string | null) {
  return useInfiniteQuery({ ...groupDetailOptions(key ?? ""), enabled: key !== null });
}

export function prefetchGroupDetail(qc: QueryClient, key: string): Promise<void> {
  return qc.prefetchInfiniteQuery(groupDetailOptions(key));
}

/** Batches are kept 7 days; all pages are loaded (at most 10) so Activity can join them. */
export function useBatches(active: boolean) {
  return useQuery({
    queryKey: qk.batches,
    queryFn: async () => {
      const all: ActionBatchView[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await api.batches({ limit: 100, cursor });
        all.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return all;
    },
    staleTime: 30_000,
    refetchInterval: active ? MIN : false,
    refetchOnWindowFocus: true,
  });
}

export function useActivity(accountId?: string) {
  return useInfiniteQuery({
    queryKey: qk.activity(accountId),
    queryFn: ({ pageParam }) => api.activity({ accountId, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useInsights() {
  return useQuery({
    queryKey: qk.insights,
    queryFn: api.insights,
    staleTime: MIN,
    refetchInterval: 5 * MIN,
    refetchOnWindowFocus: true,
  });
}

export function usePolicy() {
  return useQuery({ queryKey: qk.policy, queryFn: api.policy, staleTime: Infinity, refetchOnWindowFocus: false });
}
```

- [ ] **Step 5: Implement `mutations.ts`**

`app/src/web/api/mutations.ts`:

```ts
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AccountsResponse, PolicyResponse } from "../../shared/api.ts";
import { api, type PatchSenderBody, type PutPolicyBody } from "./endpoints.ts";
import { qk } from "./keys.ts";

/** Caches touched by any mailbox action, Clean up or undo (UI spec 5.2.2). */
export const ACTION_CACHE_PREFIXES = ["queue", "cleanup", "groups", "group", "accounts", "batches", "activity"] as const;

export async function invalidateAfterActions(qc: QueryClient): Promise<void> {
  await Promise.all(ACTION_CACHE_PREFIXES.map((p) => qc.invalidateQueries({ queryKey: [p] })));
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; paused: boolean }) => api.patchAccount(v.id, { paused: v.paused }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.accounts });
      const prev = qc.getQueryData<AccountsResponse>(qk.accounts);
      if (prev) {
        qc.setQueryData<AccountsResponse>(qk.accounts, {
          accounts: prev.accounts.map((a) => (a.id === v.id ? { ...a, paused: v.paused } : a)),
        });
      }
      return { prev };
    },
    onError: (_error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.accounts, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.accounts }),
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnectAccount(id),
    onSuccess: () => invalidateAfterActions(qc),
  });
}

export function usePatchSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchSenderBody) => api.patchSender(body),
    onSuccess: (res: PolicyResponse) => qc.setQueryData(qk.policy, res),
  });
}

export function usePutPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutPolicyBody) => api.putPolicy(body),
    onSuccess: (res: PolicyResponse) => qc.setQueryData(qk.policy, res),
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/queries.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/api/query-client.ts app/src/web/api/queries.ts app/src/web/api/mutations.ts app/test/web/helpers/query.tsx app/test/web/api/queries.test.tsx
git commit -m "feat(web): add TanStack Query hooks with the polling cadence and account mutations"
```

---

### Task 6: Clean up loop and group action loops (pure)

**Files:**
- Create: `app/src/web/api/cleanup.ts`, `app/src/web/api/group-actions.ts`
- Test: `app/test/web/api/cleanup.test.ts`, `app/test/web/api/group-actions.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `isApiError` (Task 4); contract types `ActionResponse`, `CleanupBody`, `CleanupPreview`, `ItemErrorCode`, `SenderGroup`, `GroupDetail`, `ApproveBody`, `OverrideBody`; `ActionKind` (Task 3).
- Produces:
  - `cleanup.ts`: `interface RunTotals { calls; executed; failed; skipped; lastRemaining; lastRetryLater; failedCodes; lastRetryCodes; batchIds: number[]; total }`, `type PartialReason = "stopped" | "budget" | "rate_limited" | "account_inactive" | "no_progress" | "network" | "item_failures" | "unexpected"`, `type RunOutcome = { phase: "done"; run } | { phase: "partial"; reason; run }`, `emptyTotals(count)`, `processedOf(run)`, `accumulate(run, res)`, `dominantReason(run)`, `mapError(e)`, `interface CleanupDeps { post; sleep; signal: { stop: boolean }; onProgress? }`, `runCleanup(preview, scope: { actions: ActionKind[]; accountId?: string }, deps): Promise<RunOutcome>`, `RETRY_DELAY_MS = 2000`.
  - `group-actions.ts`: `interface GroupActionResult { executed; failed; skipped; retryLater; batchIds: number[]; codes: Partial<Record<ItemErrorCode, number>>; error: ApiError | null }`, `interface GroupActionDeps { approve; override; groupDetail }`, `actOnGroup(group, target, asOf, deps): Promise<GroupActionResult>`, `emptyGroupResult()`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/api/cleanup.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, CleanupBody, CleanupPreview } from "../../../src/shared/api.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { runCleanup, type CleanupDeps } from "../../../src/web/api/cleanup.ts";

const preview = (count: number): CleanupPreview => ({
  asOf: "2026-10-15T10:00:00.000Z", threshold: 0.87, defaultThreshold: 0.87, count,
  byAction: { delete: count, archive: 0, keep: 0 }, groups: 3, groupsLeft: 1,
});

const res = (o: Partial<ActionResponse>): ActionResponse => ({
  batchId: null, results: [], executed: 0, failed: 0, skipped: 0, retryLater: 0, remaining: 0, ...o,
});

function deps(responses: (ActionResponse | Error)[], overrides: Partial<CleanupDeps> = {}) {
  const bodies: CleanupBody[] = [];
  const queue = [...responses];
  const d: CleanupDeps = {
    post: vi.fn(async (body: CleanupBody) => {
      bodies.push(body);
      const next = queue.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async () => undefined),
    signal: { stop: false },
    ...overrides,
  };
  return { d, bodies };
}

describe("runCleanup", () => {
  it("loops until remaining is 0 and sends the confirmed threshold and asOf unchanged", async () => {
    const { d, bodies } = deps([
      res({ batchId: 1, executed: 100, remaining: 150 }),
      res({ batchId: 2, executed: 100, remaining: 50 }),
      res({ batchId: 3, executed: 48, skipped: 2, remaining: 0 }),
    ]);
    const out = await runCleanup(preview(250), { actions: ["delete", "archive"] }, d);
    expect(out.phase).toBe("done");
    expect(out.run).toMatchObject({ calls: 3, executed: 248, skipped: 2, batchIds: [1, 2, 3], total: 250 });
    expect(bodies).toEqual(
      Array(3).fill({ threshold: 0.87, actions: ["delete", "archive"], asOf: "2026-10-15T10:00:00.000Z" }),
    );
  });

  it("adds accountId when the run is scoped", async () => {
    const { d, bodies } = deps([res({ batchId: 1, executed: 5 })]);
    await runCleanup(preview(5), { actions: ["keep"], accountId: "acc_1" }, d);
    expect(bodies[0]).toEqual({ threshold: 0.87, actions: ["keep"], asOf: "2026-10-15T10:00:00.000Z", accountId: "acc_1" });
  });

  it("stops with no_progress when a call makes no progress", async () => {
    const { d } = deps([res({ batchId: 1, executed: 100, remaining: 5 }), res({ retryLater: 5, remaining: 5 })]);
    const out = await runCleanup(preview(105), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "no_progress" });
    expect(out.run.executed).toBe(100);
  });

  it("names account_inactive when it dominates the retry_later items", async () => {
    const retry = Array.from({ length: 4 }, (_, i) => ({
      id: i, outcome: "retry_later" as const, action: "delete" as const, error: "account_inactive" as const,
    }));
    const { d } = deps([res({ batchId: 1, executed: 10, remaining: 4 }), res({ results: retry, retryLater: 4, remaining: 4 })]);
    expect(await runCleanup(preview(14), { actions: ["delete"] }, d)).toMatchObject({ reason: "account_inactive" });
  });

  it("returns partial budget on 429 budget_exhausted without retrying", async () => {
    const { d } = deps([res({ batchId: 1, executed: 100, remaining: 20 }), new ApiError(429, "budget_exhausted", "x")]);
    const out = await runCleanup(preview(120), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "budget" });
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("returns partial rate_limited on 429 rate_limited", async () => {
    const { d } = deps([new ApiError(429, "rate_limited", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({ reason: "rate_limited" });
  });

  it("retries a 5xx or network failure once after 2 s", async () => {
    const { d } = deps([new ApiError(503, "internal", "x"), res({ batchId: 1, executed: 10, remaining: 0 })]);
    const out = await runCleanup(preview(10), { actions: ["delete"] }, d);
    expect(out.phase).toBe("done");
    expect(d.sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up with network after the second failure", async () => {
    const { d } = deps([new ApiError(0, "network", "x"), new ApiError(0, "network", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({ reason: "network" });
  });

  it("maps a 400 to unexpected", async () => {
    const { d } = deps([new ApiError(400, "validation_failed", "x")]);
    expect(await runCleanup(preview(10), { actions: ["delete"] }, d)).toMatchObject({ reason: "unexpected" });
  });

  it("stops after maxCalls = ceil(count / 100) + 5", async () => {
    const { d } = deps(Array.from({ length: 20 }, (_, i) => res({ batchId: i + 1, executed: 1, remaining: 50 })));
    const out = await runCleanup(preview(100), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "no_progress" });
    expect(out.run.calls).toBe(6);
  });

  it("honors Stop after the in-flight call completes", async () => {
    const signal = { stop: false };
    const { d } = deps([res({ batchId: 1, executed: 100, remaining: 100 })], { signal });
    (d.post as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      signal.stop = true;
      return res({ batchId: 1, executed: 100, remaining: 100 });
    });
    const out = await runCleanup(preview(200), { actions: ["delete"] }, d);
    expect(out).toMatchObject({ phase: "partial", reason: "stopped" });
    expect(out.run).toMatchObject({ executed: 100, batchIds: [1] });
  });

  it("reports item failures when the queue empties with failed items", async () => {
    const { d } = deps([res({ batchId: 1, executed: 96, failed: 4, remaining: 0 })]);
    expect(await runCleanup(preview(100), { actions: ["delete"] }, d)).toMatchObject({ phase: "partial", reason: "item_failures" });
  });

  it("reports progress after every call", async () => {
    const onProgress = vi.fn();
    const { d } = deps([res({ batchId: 1, executed: 100, remaining: 50 }), res({ batchId: 2, executed: 50 })], { onProgress });
    await runCleanup(preview(150), { actions: ["delete"] }, d);
    expect(onProgress.mock.calls.map(([r]) => (r as { executed: number }).executed)).toEqual([100, 150]);
  });
});
```

`app/test/web/api/group-actions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ActionResponse, GroupDetail, SenderGroup, SuggestionItem } from "../../../src/shared/api.ts";
import { ApiError } from "../../../src/web/api/client.ts";
import { actOnGroup, type GroupActionDeps } from "../../../src/web/api/group-actions.ts";

const group = (o: Partial<SenderGroup> = {}): SenderGroup => ({
  key: "g1", accountId: "acc_1", provider: "gmail", sender: "promo@northwind.example", senderName: "Northwind Deals",
  domain: "northwind.example", action: "delete", count: 150, confidence: { min: 0.9, avg: 0.95, max: 0.99 },
  topReasons: [], ceilingApplied: false, newestReceivedAt: "2026-10-15T09:00:00.000Z",
  oldestReceivedAt: "2026-10-01T09:00:00.000Z", latestSubject: null, ...o,
});
const res = (o: Partial<ActionResponse>): ActionResponse => ({
  batchId: null, results: [], executed: 0, failed: 0, skipped: 0, retryLater: 0, remaining: 0, ...o,
});
const detail = (ids: number[]): GroupDetail => ({
  asOf: "2026-10-15T10:00:00.000Z",
  group: group(),
  items: { items: ids.map((id) => ({ id }) as SuggestionItem), nextCursor: null },
});

function fakeDeps(o: Partial<GroupActionDeps>): GroupActionDeps {
  return {
    approve: vi.fn(async () => res({})),
    override: vi.fn(async () => res({})),
    groupDetail: vi.fn(async () => detail([])),
    ...o,
  };
}

describe("actOnGroup", () => {
  it("approves the whole group by groupKey, 100 per call, until remaining is 0", async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce(res({ batchId: 7, executed: 100, remaining: 50 }))
      .mockResolvedValueOnce(res({ batchId: 8, executed: 50, remaining: 0 }));
    const d = fakeDeps({ approve });
    const out = await actOnGroup(group(), "delete", "2026-10-15T10:00:00.000Z", d);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledWith({ groupKey: "g1", asOf: "2026-10-15T10:00:00.000Z" });
    expect(out).toEqual({ executed: 150, failed: 0, skipped: 0, retryLater: 0, batchIds: [7, 8], codes: {}, error: null });
  });

  it("overrides by paging the pending items with limit 100", async () => {
    const groupDetail = vi.fn().mockResolvedValueOnce(detail([1, 2, 3])).mockResolvedValueOnce(detail([]));
    const override = vi.fn().mockResolvedValueOnce(res({ batchId: 9, executed: 3 }));
    const d = fakeDeps({ groupDetail, override });
    const out = await actOnGroup(group({ count: 3 }), "archive", "x", d);
    expect(groupDetail).toHaveBeenCalledWith("g1", { limit: 100 });
    expect(override).toHaveBeenCalledWith({ ids: [1, 2, 3], action: "archive" });
    expect(out.executed).toBe(3);
    expect(out.batchIds).toEqual([9]);
  });

  it("never approves a Check group", async () => {
    const d = fakeDeps({ groupDetail: vi.fn().mockResolvedValueOnce(detail([4])).mockResolvedValueOnce(detail([])) });
    await actOnGroup(group({ action: "unsure", count: 1 }), "keep", "x", d);
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.override).toHaveBeenCalledWith({ ids: [4], action: "keep" });
  });

  it("stops when an override call only returns retry_later", async () => {
    const groupDetail = vi.fn().mockResolvedValue(detail([1]));
    const override = vi.fn().mockResolvedValue(res({ retryLater: 1 }));
    const out = await actOnGroup(group({ count: 1 }), "keep", "x", fakeDeps({ groupDetail, override }));
    expect(override).toHaveBeenCalledTimes(1);
    expect(out.retryLater).toBe(1);
  });

  it("treats a group that vanished (404) as finished", async () => {
    const groupDetail = vi.fn().mockResolvedValueOnce(detail([1, 2])).mockRejectedValueOnce(new ApiError(404, "not_found", "x"));
    const override = vi.fn().mockResolvedValueOnce(res({ batchId: 4, executed: 2 }));
    const out = await actOnGroup(group({ count: 2 }), "keep", "x", fakeDeps({ groupDetail, override }));
    expect(out).toMatchObject({ executed: 2, error: null });
  });

  it("returns the error with partial totals", async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce(res({ batchId: 1, executed: 100, remaining: 50 }))
      .mockRejectedValueOnce(new ApiError(429, "budget_exhausted", "x"));
    const out = await actOnGroup(group(), "delete", "x", fakeDeps({ approve }));
    expect(out.executed).toBe(100);
    expect(out.error?.code).toBe("budget_exhausted");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/cleanup.test.ts test/web/api/group-actions.test.ts`
Expected: FAIL with `Failed to load url ../../../src/web/api/cleanup.ts` and `.../group-actions.ts`.

- [ ] **Step 3: Implement `cleanup.ts`**

`app/src/web/api/cleanup.ts`:

```ts
import type { ActionResponse, CleanupBody, CleanupPreview, ItemErrorCode } from "../../shared/api.ts";
import type { ActionKind } from "../lib/view-types.ts";
import { isApiError } from "./client.ts";

export const RETRY_DELAY_MS = 2000;

type CodeCounts = Partial<Record<ItemErrorCode, number>>;

export interface RunTotals {
  calls: number;
  executed: number;
  failed: number;
  skipped: number;
  lastRemaining: number;
  lastRetryLater: number;
  failedCodes: CodeCounts;
  lastRetryCodes: CodeCounts;
  batchIds: number[];
  total: number;
}

export type PartialReason =
  | "stopped" | "budget" | "rate_limited" | "account_inactive" | "no_progress" | "network" | "item_failures" | "unexpected";

export type RunOutcome = { phase: "done"; run: RunTotals } | { phase: "partial"; reason: PartialReason; run: RunTotals };

export interface CleanupDeps {
  post: (body: CleanupBody) => Promise<ActionResponse>;
  sleep: (ms: number) => Promise<void>;
  signal: { stop: boolean };
  onProgress?: (run: RunTotals) => void;
}

export function emptyTotals(previewCount: number): RunTotals {
  return {
    calls: 0, executed: 0, failed: 0, skipped: 0, lastRemaining: previewCount, lastRetryLater: 0,
    failedCodes: {}, lastRetryCodes: {}, batchIds: [], total: previewCount,
  };
}

export const processedOf = (r: Pick<RunTotals, "executed" | "failed" | "skipped">): number => r.executed + r.failed + r.skipped;

function countCodes(into: CodeCounts, res: ActionResponse, outcome: "failed" | "retry_later"): CodeCounts {
  const next = { ...into };
  for (const r of res.results) {
    if (r.outcome === outcome && r.error) next[r.error] = (next[r.error] ?? 0) + 1;
  }
  return next;
}

export function accumulate(run: RunTotals, res: ActionResponse): RunTotals {
  const executed = run.executed + res.executed;
  const failed = run.failed + res.failed;
  const skipped = run.skipped + res.skipped;
  return {
    calls: run.calls + 1,
    executed,
    failed,
    skipped,
    lastRemaining: res.remaining,
    lastRetryLater: res.retryLater,
    failedCodes: countCodes(run.failedCodes, res, "failed"),
    lastRetryCodes: countCodes({}, res, "retry_later"),
    batchIds: res.batchId === null ? run.batchIds : [...run.batchIds, res.batchId],
    total: Math.max(run.total, executed + failed + skipped + res.remaining),
  };
}

export function dominantReason(run: RunTotals): PartialReason {
  const merged: CodeCounts = { ...run.failedCodes };
  for (const [code, n] of Object.entries(run.lastRetryCodes) as [ItemErrorCode, number][]) {
    merged[code] = (merged[code] ?? 0) + n;
  }
  const entries = Object.entries(merged) as [ItemErrorCode, number][];
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const top = entries.sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] * 2 > total && (top[0] === "account_inactive" || top[0] === "rate_limited")) return top[0];
  return "no_progress";
}

export function mapError(e: unknown): PartialReason {
  if (!isApiError(e)) return "unexpected";
  if (e.code === "budget_exhausted") return "budget";
  if (e.code === "rate_limited") return "rate_limited";
  if (e.code === "network" || e.status >= 500) return "network";
  return "unexpected";
}

const retryable = (e: unknown): boolean => isApiError(e) && (e.code === "network" || e.status >= 500);

async function postWithOneRetry(deps: CleanupDeps, body: CleanupBody): Promise<ActionResponse> {
  try {
    return await deps.post(body);
  } catch (e) {
    if (!retryable(e)) throw e;
    await deps.sleep(RETRY_DELAY_MS);
    return deps.post(body);
  }
}

/** UI spec 5.2.3: the server caps each call at 100 items and returns `remaining`. */
export async function runCleanup(
  preview: CleanupPreview,
  scope: { actions: ActionKind[]; accountId?: string | undefined },
  deps: CleanupDeps,
): Promise<RunOutcome> {
  const body: CleanupBody = {
    threshold: preview.threshold,
    actions: scope.actions,
    asOf: preview.asOf,
    ...(scope.accountId ? { accountId: scope.accountId } : {}),
  };
  let run = emptyTotals(preview.count);
  const maxCalls = Math.ceil(preview.count / 100) + 5;
  for (;;) {
    if (deps.signal.stop) return { phase: "partial", reason: "stopped", run };
    let res: ActionResponse;
    try {
      res = await postWithOneRetry(deps, body);
    } catch (e) {
      return { phase: "partial", reason: mapError(e), run };
    }
    run = accumulate(run, res);
    deps.onProgress?.(run);
    if (res.remaining === 0) {
      return run.failed > 0 ? { phase: "partial", reason: "item_failures", run } : { phase: "done", run };
    }
    if (processedOf(res) === 0 || run.calls >= maxCalls) return { phase: "partial", reason: dominantReason(run), run };
  }
}
```

- [ ] **Step 4: Implement `group-actions.ts`**

`app/src/web/api/group-actions.ts`:

```ts
import type { ActionResponse, ApproveBody, GroupDetail, ItemErrorCode, OverrideBody, SenderGroup } from "../../shared/api.ts";
import type { ActionKind } from "../lib/view-types.ts";
import { ApiError } from "./client.ts";

export interface GroupActionResult {
  executed: number;
  failed: number;
  skipped: number;
  retryLater: number;
  batchIds: number[];
  /** Error codes of failed and retry_later items (account_inactive, rate_limited, ...). */
  codes: Partial<Record<ItemErrorCode, number>>;
  error: ApiError | null;
}

export interface GroupActionDeps {
  approve: (body: ApproveBody) => Promise<ActionResponse>;
  override: (body: OverrideBody) => Promise<ActionResponse>;
  groupDetail: (key: string, q: { limit: number }) => Promise<GroupDetail>;
}

export function emptyGroupResult(): GroupActionResult {
  return { executed: 0, failed: 0, skipped: 0, retryLater: 0, batchIds: [], codes: {}, error: null };
}

/** UI spec 6.4. Approve when the target equals the suggestion; otherwise override page by page. */
export async function actOnGroup(
  group: SenderGroup,
  target: ActionKind,
  asOf: string,
  deps: GroupActionDeps,
): Promise<GroupActionResult> {
  const out = emptyGroupResult();
  const collect = (r: ActionResponse) => {
    out.executed += r.executed;
    out.failed += r.failed;
    out.skipped += r.skipped;
    out.retryLater += r.retryLater;
    if (r.batchId !== null) out.batchIds.push(r.batchId);
    for (const item of r.results) {
      if (item.error && item.outcome !== "executed") out.codes[item.error] = (out.codes[item.error] ?? 0) + 1;
    }
  };
  const maxCalls = Math.ceil(group.count / 100) + 3;
  try {
    if (group.action === target) {
      for (let i = 0; i < maxCalls; i++) {
        const r = await deps.approve({ groupKey: group.key, asOf });
        collect(r);
        if (r.remaining === 0 || r.executed + r.failed + r.skipped === 0) break;
      }
    } else {
      for (let i = 0; i < maxCalls; i++) {
        let page: GroupDetail;
        try {
          page = await deps.groupDetail(group.key, { limit: 100 });
        } catch (e) {
          // The group disappears (404) once it has no pending items left.
          if (e instanceof ApiError && e.status === 404) break;
          throw e;
        }
        const ids = page.items.items.map((it) => it.id);
        if (ids.length === 0) break;
        const r = await deps.override({ ids, action: target });
        collect(r);
        if (r.executed + r.failed + r.skipped === 0) break;
      }
    }
  } catch (e) {
    out.error = e instanceof ApiError ? e : new ApiError(0, "invalid_response", "Unexpected error");
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/api/cleanup.test.ts test/web/api/group-actions.test.ts`
Expected: PASS (13 + 6 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/web/api/cleanup.ts app/src/web/api/group-actions.ts app/test/web/api/cleanup.test.ts app/test/web/api/group-actions.test.ts
git commit -m "feat(web): add the server-capped Clean up loop and group action loops"
```

---

### Task 7: UI primitives I (CSP-safe styles, icons, buttons, form controls) and the ESLint guard

**Files:**
- Create: `app/src/web/components/ui/css-vars.ts`, `icons.tsx`, `Spark.tsx`, `VisuallyHidden.tsx`, `Kbd.tsx`, `Spinner.tsx`, `Button.tsx`, `Checkbox.tsx`, `Toggle.tsx`, `TextInput.tsx`, `Select.tsx` (all under `app/src/web/components/ui/`)
- Modify: `eslint.config.js` (plan 01 file, decision W6): append one config block
- Test: `app/test/web/components/ui/primitives.test.tsx`

**Interfaces:**
- Consumes: tokens (Task 2), `Platform` (Task 3).
- Produces:
  - `cssVars(vars: CbVars): React.CSSProperties`, `type CbVarName = \`--cb-${string}\``, `type CbVars = Record<CbVarName, number | string>`.
  - `Icon({ name, size?, strokeWidth?, className?, label? })`, `type IconName` (UI spec 4.33 names plus `check`, `minus`).
  - `Spark({ size?: 14 | 22 })`, `VisuallyHidden({ children })`, `Kbd({ keys, tone?, ariaHidden? })`, `type KbdTone`, `Spinner({ tone? })`.
  - `Button(props: ButtonProps)`, `LinkButton(props: LinkButtonProps)`, `buttonClass(variant, size, extra?)`, `type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "on-inverse" | "on-inverse-ghost" | "link"`, `type ButtonSize = "sm" | "md" | "lg"`. `ButtonProps` adds `icon?`, `kbd?`, `loading?`, `loadingLabel?` (default "Working…"), `softDisabled?` (renders `aria-disabled="true"` and ignores clicks, UI spec 4.22), `ref?`.
  - `Checkbox({ checked: boolean | "mixed", onChange(next, e), label, tabIndex?, disabled? })`, `Toggle({ checked, onChange, label, labelledBy?, describedBy?, locked?, disabled? })`, `TextInput(props: TextInputProps)`, `Select<V>({ label, showLabel?, value, options, onChange, variant?, disabled?, className? })`.
  - ESLint: `style` props in `app/src/web/**` must be a direct `cssVars(...)` call; `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment and `insertAdjacentHTML` are errors.

- [ ] **Step 1: Write the failing primitives test**

`app/test/web/components/ui/primitives.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../../../src/web/components/ui/Button.tsx";
import { Checkbox } from "../../../../src/web/components/ui/Checkbox.tsx";
import { cssVars } from "../../../../src/web/components/ui/css-vars.ts";
import { Icon } from "../../../../src/web/components/ui/icons.tsx";
import { Kbd } from "../../../../src/web/components/ui/Kbd.tsx";
import { Select } from "../../../../src/web/components/ui/Select.tsx";
import { TextInput } from "../../../../src/web/components/ui/TextInput.tsx";
import { Toggle } from "../../../../src/web/components/ui/Toggle.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";

describe("cssVars", () => {
  it("passes --cb-* properties through", () => {
    expect(cssVars({ "--cb-value": 0.97, "--cb-tau": 0.86 })).toEqual({ "--cb-value": 0.97, "--cb-tau": 0.86 });
  });

  it("throws on any other property in development", () => {
    expect(() => cssVars({ color: "red" } as never)).toThrow("cssVars only accepts --cb-* properties");
  });
});

describe("Button", () => {
  it("shows the loading label, sets aria-busy and ignores clicks", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Clean up 14</Button>);
    const button = screen.getByRole("button", { name: "Working…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("soft-disables with aria-disabled so it stays focusable", async () => {
    const onClick = vi.fn();
    render(<Button softDisabled onClick={onClick}>Clean up</Button>);
    const button = screen.getByRole("button", { name: "Clean up" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders shortcut keys hidden from assistive tech", () => {
    render(<Button variant="primary" kbd={["Ctrl", "Enter"]} aria-keyshortcuts="Control+Enter">Clean up</Button>);
    const button = screen.getByRole("button", { name: "Clean up" });
    expect([...button.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "Enter"]);
  });
});

describe("form controls", () => {
  it("Checkbox supports mixed and reports the next value", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked="mixed" onChange={onChange} label="Select all groups in Trash" />);
    const box = screen.getByRole("checkbox", { name: "Select all groups in Trash" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    rerender(<Checkbox checked onChange={onChange} label="Select all groups in Trash" />);
    expect(box.indeterminate).toBe(false);
  });

  it("Toggle is a switch; locked toggles stay on", async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return (
        <>
          <Toggle checked={on} onChange={setOn} label="Store email previews" />
          <Toggle checked={false} onChange={() => undefined} label="Protect starred threads" locked />
        </>
      );
    }
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Store email previews" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const locked = screen.getByRole("switch", { name: "Protect starred threads" });
    expect(locked.getAttribute("aria-checked")).toBe("true");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
  });

  it("TextInput links helper and error text", () => {
    render(<TextInput label="Record word" helper="2 to 40 characters." error="Use 2 to 40 characters." />);
    const input = screen.getByRole("textbox", { name: "Record word" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["2 to 40 characters.", "Use 2 to 40 characters."]);
  });

  it("Select reports the typed value", async () => {
    const onChange = vi.fn();
    render(
      <Select label="Account" value="all" onChange={onChange}
        options={[{ value: "all", label: "All accounts" }, { value: "acc_1", label: "you@example.com" }]} />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Account" }), "acc_1");
    expect(onChange).toHaveBeenCalledWith("acc_1");
  });

  it("renders Kbd keys and hidden icons accessibly", async () => {
    render(
      <div>
        <Kbd keys={["G", "R"]} />
        <Icon name="trash" />
        <Button icon="trash" variant="danger">Trash 6</Button>
        <Checkbox checked={false} onChange={() => undefined} label="Select Northwind Deals" />
      </div>,
    );
    expect(document.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    await expectNoA11yViolations();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/ui/primitives.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/components/ui/Button.tsx`.

- [ ] **Step 3: Implement `css-vars.ts`, `icons.tsx`, `Spark.tsx`, `VisuallyHidden.tsx`**

`app/src/web/components/ui/css-vars.ts`:

```ts
import type { CSSProperties } from "react";

export type CbVarName = `--cb-${string}`;
export type CbVars = Record<CbVarName, number | string>;

/**
 * The only allowed value of a React `style` prop (UI spec 8.4). React applies it through the CSSOM,
 * which CSP `style-src 'self'` does not block; only `--cb-*` custom properties are accepted.
 */
export function cssVars(vars: CbVars): CSSProperties {
  if (import.meta.env.DEV) {
    for (const key of Object.keys(vars)) {
      if (!key.startsWith("--cb-")) throw new Error(`cssVars only accepts --cb-* properties, got ${key}`);
    }
  }
  return vars as CSSProperties;
}
```

`app/src/web/components/ui/icons.tsx`:

```tsx
import type { ReactNode } from "react";

export type IconName =
  | "review" | "activity" | "insights" | "rules" | "plus" | "trash" | "archive" | "keep" | "check-question"
  | "shield" | "spark" | "spark-off" | "close" | "chevron-down" | "external" | "refresh" | "pause" | "play"
  | "more" | "menu" | "arrow-left" | "info" | "warning" | "error" | "success" | "history" | "eye-off"
  | "megaphone" | "star" | "person" | "list" | "clock" | "paperclip" | "receipt" | "alert" | "flag"
  | "question" | "lock" | "copy" | "check" | "minus";

const CIRCLE = <circle cx="8" cy="8" r="5.75" />;
const TICK = <path d="m5.5 8 1.8 1.8 3.2-3.6" />;
const QMARK = <path d="M6.5 6.5a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.4M8 11h.01" />;
const STAR4 = <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z" />;
const TRIANGLE = (
  <>
    <path d="M8 2.5 14 13H2z" />
    <path d="M8 6.5v3M8 11.2h.01" />
  </>
);

const PATHS: Record<IconName, ReactNode> = {
  review: (
    <>
      <path d="M2.5 9.5h3l1 2h3l1-2h3" />
      <path d="M3.5 3.5h9l1.5 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3z" />
    </>
  ),
  activity: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  insights: <path d="M3 13V8M8 13V3M13 13V6" />,
  rules: (
    <>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.5" />
      <circle cx="10" cy="11.5" r="1.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />,
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" />
    </>
  ),
  keep: (
    <>
      {CIRCLE}
      {TICK}
    </>
  ),
  "check-question": (
    <>
      {CIRCLE}
      {QMARK}
    </>
  ),
  shield: <path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z" />,
  spark: STAR4,
  "spark-off": (
    <>
      {STAR4}
      <path d="m2.5 2.5 11 11" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  play: <path d="m5 3.5 7.5 4.5L5 12.5z" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  "arrow-left": <path d="M13 8H3M7 4 3 8l4 4" />,
  info: (
    <>
      {CIRCLE}
      <path d="M8 7.5V11M8 5h.01" />
    </>
  ),
  warning: TRIANGLE,
  error: (
    <>
      <path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z" />
      <path d="M8 5v3.5M8 10.8h.01" />
    </>
  ),
  success: (
    <>
      {CIRCLE}
      {TICK}
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <circle cx="8" cy="8" r="1.8" />
      <path d="m2.5 2.5 11 11" />
    </>
  ),
  megaphone: <path d="M2.5 6.5v3h2l5 3v-9l-5 3zM12 6a2.5 2.5 0 0 1 0 4M4.5 9.5l.8 3.5" />,
  star: <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />,
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </>
  ),
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  clock: (
    <>
      {CIRCLE}
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  paperclip: <path d="m13 7.5-5.2 5.2a3 3 0 0 1-4.3-4.3l5.6-5.6a2 2 0 0 1 2.9 2.9l-5.5 5.5a1 1 0 0 1-1.4-1.4L10 4.9" />,
  receipt: (
    <>
      <path d="M3.5 2h9v12l-1.8-1.2L9 14l-1.5-1.2L6 14l-1.7-1.2L3.5 14z" />
      <path d="M6 5.5h4M6 8h4" />
    </>
  ),
  alert: TRIANGLE,
  flag: <path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8" />,
  question: (
    <>
      {CIRCLE}
      {QMARK}
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  check: <path d="m3.5 8.2 3 3 6-6.7" />,
  minus: <path d="M4 8h8" />,
};

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string | undefined;
  /** When set, the icon is announced (role img); otherwise it is aria-hidden. */
  label?: string | undefined;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {PATHS[name]}
    </svg>
  );
}
```

`app/src/web/components/ui/Spark.tsx`:

```tsx
import { useId } from "react";

/** The Clearbox AI spark: four-point star with the spark gradient (SVG, not CSS). */
export function Spark({ size = 14 }: { size?: 14 | 22 }) {
  const id = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="shrink-0">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="[stop-color:var(--color-spark-from)]" />
          <stop offset="1" className="[stop-color:var(--color-spark-to)]" />
        </linearGradient>
      </defs>
      <path d="M8 .5 9.8 6.2 15.5 8 9.8 9.8 8 15.5 6.2 9.8.5 8 6.2 6.2z" fill={`url(#${id})`} />
    </svg>
  );
}
```

`app/src/web/components/ui/VisuallyHidden.tsx`:

```tsx
import type { ReactNode } from "react";

export function VisuallyHidden({ children, id }: { children: ReactNode; id?: string | undefined }) {
  return (
    <span className="sr-only" id={id}>
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Implement `Kbd.tsx`, `Spinner.tsx`, `Button.tsx`**

`app/src/web/components/ui/Kbd.tsx`:

```tsx
export type KbdTone = "default" | "on-primary" | "on-inverse";

const TONE: Record<KbdTone, string> = {
  default: "bg-surface border-line text-ink-3",
  "on-primary": "bg-[rgba(255,255,255,.12)] border-[rgba(255,255,255,.18)] text-[#D6D7DD]",
  "on-inverse": "bg-transparent border-inverse-line text-on-inverse-3",
};

/** Hidden below 640px (no physical keyboard expected there). */
export function Kbd({ keys, tone = "default", ariaHidden = false }: { keys: string[]; tone?: KbdTone; ariaHidden?: boolean }) {
  return (
    <span className="hidden items-center gap-[3px] sm:inline-flex" aria-hidden={ariaHidden || undefined}>
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className={`rounded-xs border border-b-2 px-[5px] font-mono text-micro ${TONE[tone]}`}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
```

`app/src/web/components/ui/Spinner.tsx`:

```tsx
export type SpinnerTone = "default" | "on-dark";

/** 12px spinner; with reduced motion a static three-dot glyph replaces it (UI spec 2.7). */
export function Spinner({ tone = "default" }: { tone?: SpinnerTone }) {
  const ring = tone === "on-dark" ? "border-[rgba(255,255,255,.3)] border-t-white" : "border-line-control border-t-ink";
  const dot = tone === "on-dark" ? "bg-white" : "bg-ink-3";
  return (
    <span aria-hidden="true" className="inline-flex size-3 shrink-0 items-center justify-center">
      <span className={`size-3 rounded-full border-2 motion-safe:animate-spin motion-reduce:hidden ${ring}`} />
      <span className="hidden gap-[2px] motion-reduce:inline-flex">
        <i className={`size-[3px] rounded-full ${dot}`} />
        <i className={`size-[3px] rounded-full ${dot}`} />
        <i className={`size-[3px] rounded-full ${dot}`} />
      </span>
    </span>
  );
}
```

`app/src/web/components/ui/Button.tsx`:

```tsx
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "./icons.tsx";
import { Kbd, type KbdTone } from "./Kbd.tsx";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "on-inverse" | "on-inverse-ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary border-primary shadow-button-primary hover:bg-primary-hover hover:border-primary-hover motion-safe:active:translate-y-px",
  secondary: "bg-surface text-ink border-line hover:bg-surface-hover hover:border-neutral-fill active:bg-surface-sunk",
  danger: "bg-trash text-white border-trash hover:bg-trash-hover hover:border-trash-hover motion-safe:active:translate-y-px",
  ghost:
    "bg-transparent text-ink-2 border-transparent hover:bg-[rgba(22,23,27,.05)] hover:text-ink active:bg-[rgba(22,23,27,.08)]",
  "on-inverse": "bg-white text-ink border-white hover:bg-surface-sunk",
  "on-inverse-ghost":
    "bg-transparent text-on-inverse-2 border-transparent hover:text-on-inverse hover:bg-[rgba(255,255,255,.08)]",
  link: "bg-transparent border-transparent text-accent underline-offset-2 hover:text-accent-hover hover:underline",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 py-[5px] text-small rounded-md",
  md: "h-8 px-3 py-[7px] text-body rounded-md",
  lg: "h-9 px-[15px] py-[9px] text-base rounded-lg",
};
const LINK_SIZE: Record<ButtonSize, string> = { sm: "text-small", md: "text-body", lg: "text-base" };
const ICON_SIZE: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 16 };

export function buttonClass(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  const sizing = variant === "link" ? `p-0 rounded-xs ${LINK_SIZE[size]}` : SIZE[size];
  return [
    "inline-flex items-center justify-center gap-[7px] whitespace-nowrap border font-emphasis",
    "transition-colors duration-(--duration-fast)",
    "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
    VARIANT[variant],
    sizing,
    extra ?? "",
  ].join(" ");
}

const isDark = (v: ButtonVariant) => v === "primary" || v === "danger";
const kbdTone = (v: ButtonVariant): KbdTone =>
  isDark(v) ? "on-primary" : v === "on-inverse" || v === "on-inverse-ghost" ? "on-inverse" : "default";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | undefined;
  kbd?: string[] | undefined;
  loading?: boolean | undefined;
  loadingLabel?: string | undefined;
  softDisabled?: boolean | undefined;
  type?: "button" | "submit";
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  kbd,
  loading = false,
  loadingLabel = "Working…",
  softDisabled = false,
  type = "button",
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const inactive = loading || softDisabled;
  const handle = (e: MouseEvent<HTMLButtonElement>) => {
    if (inactive) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      aria-busy={loading || undefined}
      aria-disabled={softDisabled || rest["aria-disabled"] || undefined}
      onClick={handle}
    >
      {loading ? (
        <Spinner tone={isDark(variant) ? "on-dark" : "default"} />
      ) : icon ? (
        <Icon name={icon} size={ICON_SIZE[size]} />
      ) : null}
      {loading ? <span>{loadingLabel}</span> : children !== undefined ? <span>{children}</span> : null}
      {kbd && !loading ? <Kbd keys={kbd} tone={kbdTone(variant)} ariaHidden /> : null}
    </button>
  );
}

export interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to?: string | undefined;
  href?: string | undefined;
  external?: boolean | undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | undefined;
  children: ReactNode;
}

/** Same visuals as Button; renders a router Link (internal) or an anchor (external, new tab). */
export function LinkButton({ to, href, external = false, variant = "secondary", size = "md", icon, children, className, ...rest }: LinkButtonProps) {
  const cls = buttonClass(variant, size, className);
  const inner = (
    <>
      {icon ? <Icon name={icon} size={ICON_SIZE[size]} /> : null}
      <span>{children}</span>
      {external ? <Icon name="external" size={12} /> : null}
    </>
  );
  if (to !== undefined) {
    return (
      <Link {...rest} to={to} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <a {...rest} href={href} className={cls} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {inner}
    </a>
  );
}
```

- [ ] **Step 5: Implement `Checkbox.tsx`, `Toggle.tsx`, `TextInput.tsx`, `Select.tsx`**

`app/src/web/components/ui/Checkbox.tsx`:

```tsx
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "./icons.tsx";

export interface CheckboxProps {
  checked: boolean | "mixed";
  onChange: (next: boolean, e: MouseEvent | KeyboardEvent) => void;
  label: string;
  tabIndex?: 0 | -1;
  disabled?: boolean;
}

/** Native checkbox styled directly (appearance: none); mixed uses the indeterminate property. */
export function Checkbox({ checked, onChange, label, tabIndex = 0, disabled = false }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "mixed";
  }, [checked]);
  const on = checked !== false;
  return (
    <span className="relative inline-grid size-[15px] shrink-0 place-items-center">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked === true}
        disabled={disabled}
        tabIndex={tabIndex}
        onChange={() => undefined}
        onClick={(e) => {
          e.stopPropagation();
          onChange(checked !== true, e);
        }}
        className={`size-[15px] cursor-pointer appearance-none rounded-xs border-[1.5px] transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-45 ${
          on ? "border-ink bg-ink" : "border-line-control bg-surface hover:border-ink-3"
        }`}
      />
      {checked === true ? (
        <Icon name="check" size={11} strokeWidth={2} className="pointer-events-none absolute text-white" />
      ) : null}
      {checked === "mixed" ? (
        <span aria-hidden="true" className="pointer-events-none absolute h-[2px] w-2 rounded-full bg-white" />
      ) : null}
    </span>
  );
}
```

`app/src/web/components/ui/Toggle.tsx`:

```tsx
import { Icon } from "./icons.tsx";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  locked?: boolean;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, labelledBy, describedBy, locked = false, disabled = false }: ToggleProps) {
  const on = locked || checked;
  const inert = locked || disabled;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {locked ? <Icon name="lock" size={12} className="text-ink-3" /> : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-disabled={inert || undefined}
        onClick={() => {
          if (!inert) onChange(!checked);
        }}
        className={`relative h-[18px] w-[30px] rounded-full transition-colors duration-(--duration-fast) ${
          on ? "bg-ink" : "bg-line-control"
        } ${inert ? "cursor-not-allowed opacity-45" : "hover:opacity-90"}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 size-3.5 rounded-full bg-white motion-safe:transition-[left] motion-safe:duration-(--duration-fast) motion-safe:ease-out ${
            on ? "left-[14px]" : "left-0.5"
          }`}
        />
      </button>
    </span>
  );
}
```

`app/src/web/components/ui/TextInput.tsx`:

```tsx
import { useId, type InputHTMLAttributes, type Ref } from "react";
import { Icon } from "./icons.tsx";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  hideLabel?: boolean;
  helper?: string | undefined;
  error?: string | null | undefined;
  size?: "sm" | "md";
  ref?: Ref<HTMLInputElement> | undefined;
}

export function TextInput({ label, hideLabel = false, helper, error, size = "md", id, className, ref, ...rest }: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const helpId = `${inputId}-help`;
  const errId = `${inputId}-err`;
  const describedBy = [helper ? helpId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined;
  const sizing = size === "sm" ? "h-[26px] px-2.5 py-[3px]" : "h-8 px-2.5 py-[7px]";
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-meta font-emphasis text-ink-3"}>
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`rounded-md border bg-surface text-body text-ink placeholder:text-ink-3 focus-visible:border-focus disabled:bg-surface-sunk disabled:text-ink/45 ${sizing} ${
          error ? "border-trash-ink" : "border-line-control hover:border-ink-3"
        }`}
      />
      {helper ? (
        <p id={helpId} className="text-small text-ink-3">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="flex items-center gap-1 text-small text-trash-ink">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

`app/src/web/components/ui/Select.tsx`:

```tsx
import { useId } from "react";
import { Icon } from "./icons.tsx";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string> {
  label: string;
  showLabel?: boolean;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  variant?: "default" | "ghost";
  disabled?: boolean;
  className?: string | undefined;
}

/** Styled native select (UI spec 4.24); the chevron is an SVG sibling, not a CSS background. */
export function Select<V extends string>({
  label, showLabel = false, value, options, onChange, variant = "default", disabled = false, className,
}: SelectProps<V>) {
  const id = useId();
  const box =
    variant === "ghost"
      ? "bg-transparent pl-1.5 pr-6 text-small text-ink-3 hover:text-ink-2"
      : "rounded-md border border-line bg-surface pl-2.5 pr-7 py-[5px] text-body text-ink-2 hover:border-neutral-fill";
  return (
    <span className={`relative inline-flex items-center ${className ?? ""}`}>
      <label htmlFor={id} className={showLabel ? "mr-2 text-meta text-ink-3" : "sr-only"}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) onChange(next.value);
        }}
        className={`h-[30px] max-w-full cursor-pointer appearance-none truncate disabled:cursor-not-allowed disabled:opacity-45 ${box}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={12} className="pointer-events-none absolute right-2 text-ink-3" />
    </span>
  );
}
```

- [ ] **Step 6: Add the ESLint CSP and text-safety rules**

In `eslint.config.js`, add this object as the last argument of `defineConfig(...)`, directly before the final `);` (after the `["**/test/**", "**/*.config.ts", "**/*.config.js"]` block):

```js
  {
    files: ["app/src/web/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'JSXAttribute[name.name="style"] > JSXExpressionContainer > :not(CallExpression[callee.name="cssVars"])',
          message: "Use style={cssVars({...})} with --cb-* properties only (CSP, see UI spec 8.4)",
        },
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: "Email content is rendered as plain text only (UI spec 8.5).",
        },
        {
          selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
          message: "No HTML injection in the SPA (UI spec 8.5).",
        },
        {
          selector: 'CallExpression[callee.property.name="insertAdjacentHTML"]',
          message: "No HTML injection in the SPA (UI spec 8.5).",
        },
      ],
    },
  },
```

- [ ] **Step 7: Run the tests and verify the lint rule fires**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/ui/primitives.test.tsx`
Expected: PASS (10 tests).

Run: `printf 'export const X = () => <div style={{ color: "red" }} />;\n' | pnpm exec eslint --stdin --stdin-filename app/src/web/lint-probe.tsx`
Expected: exit 1 with `Use style={cssVars({...})} with --cb-* properties only (CSP, see UI spec 8.4)`.

Run: `pnpm exec eslint app/src/web`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add app/src/web/components/ui eslint.config.js app/test/web/components/ui/primitives.test.tsx
git commit -m "feat(web): add CSP-safe UI primitives, inline SVG icons and lint guards"
```

---

### Task 8: UI primitives II (banners, empty states, skeletons, progress, table, tabs, menu, dialog, chips)

**Files:**
- Create: `app/src/web/state/use-media-query.ts`; under `app/src/web/components/ui/`: `Banner.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `ProgressBar.tsx`, `Table.tsx`, `Tabs.tsx`, `Menu.tsx`, `Dialog.tsx`, `Chip.tsx`, `ChipInput.tsx`
- Modify: `app/src/web/styles.css` (append two keyframes)
- Test: `app/test/web/components/ui/composites.test.tsx`

**Interfaces:**
- Consumes: Task 7 primitives (`Button`, `LinkButton`, `Icon`, `cssVars`); `formatCount`, `plural` (Task 3).
- Produces:
  - `useMediaQuery(query): boolean`, `usePrefersReducedMotion()`, `prefersReducedMotion()`, `BP = { sm, lg, xl }` media strings.
  - `Banner({ tone, title, body?, actions?, dismissible?, onDismiss?, announce? })`, `type BannerTone`, `interface BannerAction { label; onClick?; href?; external?; loading? }`.
  - `EmptyState({ variant: "panel" | "page" | "inline", title, body, action?, secondaryAction?, icon?, headingLevel?: 1 | 2 | 3, actionRef?, children? })`.
  - `SkeletonLine({ width, height? })`, `SkeletonRows({ count })`, `SHIMMER` class string.
  - `ProgressBar({ value: number | null, tone, height?, label, valueText?, width? })`.
  - `Table<Row>({ caption, columns, rows, rowKey, state, emptyText, onRetry?, footer?, rowHover? })`, `interface Column<Row> { key; header; align?; className?; srOnlyHeader?; render }`.
  - `Tabs<K>({ label, value, items: TabItem<K>[], onChange, controls, idPrefix })`, `interface TabItem<K> { key; label; count?; ariaLabel? }`.
  - `Menu({ label, items: MenuItem[], align?, placement?, renderTrigger })` where `renderTrigger(props: MenuTriggerProps): ReactNode` (render prop instead of UI spec's cloned `trigger` element, so trigger props stay typed), `interface MenuItem { id; label; icon?; destructive?; disabled?; onSelect }`.
  - `Dialog({ open, onClose, title, children, className? })` (native `<dialog>` with `showModal()`).
  - `Chip({ label, onRemove?, removeLabel, note? })`, `ChipInput({ labelledBy, listName, values, placeholder, validate, onAdd, onRemove, max, notes?, serverError?, describedBy?, disabled? })`, `type ChipValidation`.
  - CSS keyframes `cb-indeterminate`, `cb-fade-in`.

- [ ] **Step 1: Write the failing test**

`app/test/web/components/ui/composites.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "../../../../src/web/components/ui/Banner.tsx";
import { Button } from "../../../../src/web/components/ui/Button.tsx";
import { ChipInput } from "../../../../src/web/components/ui/ChipInput.tsx";
import { Dialog } from "../../../../src/web/components/ui/Dialog.tsx";
import { EmptyState } from "../../../../src/web/components/ui/EmptyState.tsx";
import { Menu } from "../../../../src/web/components/ui/Menu.tsx";
import { ProgressBar } from "../../../../src/web/components/ui/ProgressBar.tsx";
import { Table } from "../../../../src/web/components/ui/Table.tsx";
import { Tabs } from "../../../../src/web/components/ui/Tabs.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";

describe("Banner and EmptyState", () => {
  it("announces late error banners and runs actions", async () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Banner tone="error" title="Clearbox can't use the AI model." body="New emails are marked Check until this is fixed."
        actions={[{ label: "Open setup guide", onClick }]} dismissible onDismiss={onDismiss} announce />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Clearbox can't use the AI model. New emails are marked Check");
    await userEvent.click(screen.getByRole("button", { name: "Open setup guide" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss: Clearbox can't use the AI model." }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders an empty state heading with its action", async () => {
    const onClick = vi.fn();
    render(<EmptyState variant="panel" title="Nothing to review" body="New mail gets sorted every 30 minutes." action={{ label: "Scan now", onClick }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Nothing to review" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Scan now" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("ProgressBar", () => {
  it("exposes determinate values and sets geometry only through --cb-value", () => {
    render(<ProgressBar value={0.63} tone="accent" label="Daily writes used" valueText="21,080 of 90,000 (23%)" />);
    const bar = screen.getByRole("progressbar", { name: "Daily writes used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(bar.getAttribute("aria-valuetext")).toBe("21,080 of 90,000 (23%)");
    expect((bar.querySelector(".cb-fill") as HTMLElement).style.getPropertyValue("--cb-value")).toBe("0.63");
  });

  it("omits aria-valuenow when indeterminate", () => {
    render(<ProgressBar value={null} tone="archive" label="Sorting progress" />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });
});

describe("Table", () => {
  const columns = [{ key: "a", header: "Account", render: (r: { a: string }) => r.a }];

  it("renders rows, empty and error states", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<Table caption="Accounts" columns={columns} rows={[{ a: "you@example.com" }]} rowKey={(r) => r.a} state="ready" emptyText="No accounts connected." />);
    expect(screen.getByRole("table", { name: "Accounts" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "you@example.com" })).toBeTruthy();
    rerender(<Table caption="Accounts" columns={columns} rows={[]} rowKey={(r) => r.a} state="empty" emptyText="No accounts connected." />);
    expect(screen.getByText("No accounts connected.")).toBeTruthy();
    rerender(<Table caption="Accounts" columns={columns} rows={[]} rowKey={(r) => r.a} state="error" emptyText="" onRetry={onRetry} />);
    expect(screen.getByText("Couldn't load this table.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("Tabs", () => {
  it("implements roving focus with automatic activation", async () => {
    function Harness() {
      const [tab, setTab] = useState<"all" | "trash" | "keep">("all");
      return (
        <Tabs label="Filter by suggestion" value={tab} onChange={setTab} controls="group-list" idPrefix="tab"
          items={[{ key: "all", label: "All", count: 7 }, { key: "trash", label: "Trash", count: 3, ariaLabel: "Trash, 3 groups" }, { key: "keep", label: "Keep", count: 0 }]} />
      );
    }
    render(<Harness />);
    const all = screen.getByRole("tab", { name: /^All/ });
    expect(all.getAttribute("aria-selected")).toBe("true");
    all.focus();
    await userEvent.keyboard("{ArrowRight}");
    const trash = screen.getByRole("tab", { name: "Trash, 3 groups" });
    expect(trash.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(trash);
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /^Keep/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Home}");
    expect(all.getAttribute("tabindex")).toBe("0");
  });
});

describe("Menu and Dialog", () => {
  it("opens, moves with arrows, selects and returns focus", async () => {
    const onCopy = vi.fn();
    render(
      <Menu label="More actions" align="end" items={[
        { id: "deny", label: "Always OK to trash Northwind Deals", onSelect: () => undefined },
        { id: "copy", label: "Copy sender address", icon: "copy", onSelect: onCopy },
      ]} renderTrigger={(p) => <Button {...p} variant="ghost" icon="more" aria-label="More actions" />} />,
    );
    const trigger = screen.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Always OK to trash Northwind Deals");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders a modal dialog with a close button", async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Keyboard shortcuts"><p>Shortcuts are off while you type in a field.</p></Dialog>);
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ChipInput", () => {
  function Harness() {
    const [values, setValues] = useState(["@bank.example"]);
    return (
      <>
        <h3 id="allow-title">Always keep these senders</h3>
        <ChipInput labelledBy="allow-title" listName="Always keep" values={values} placeholder="Add sender or @domain" max={1000}
          validate={(raw) => (/^(@|[^@\s]+@)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw.trim().toLowerCase())
            ? { ok: true, value: raw.trim().toLowerCase() } : { ok: false, error: "Use name@domain.com or @domain.com." })}
          onAdd={(v) => setValues((xs) => [...xs, v])} onRemove={(v) => setValues((xs) => xs.filter((x) => x !== v))} />
      </>
    );
  }

  it("adds on Enter and comma, validates, rejects duplicates and removes", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Always keep these senders" });
    await userEvent.type(input, "Mom@Family.example{Enter}");
    await userEvent.type(input, "nope,");
    expect(screen.getByText("Use name@domain.com or @domain.com.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await userEvent.clear(input);
    await userEvent.type(input, "@bank.example{Enter}");
    expect(screen.getByText("This entry is already in the list.")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Always keep" });
    expect(within(list).getAllByRole("listitem").map((li) => li.firstChild?.textContent)).toEqual(["@bank.example", "mom@family.example"]);
    await userEvent.clear(input);
    await userEvent.keyboard("{Backspace}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove mom@family.example from Always keep" }));
    await userEvent.keyboard("{Enter}");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await expectNoA11yViolations();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/ui/composites.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/components/ui/Banner.tsx`.

- [ ] **Step 3: Append the keyframes to `styles.css`**

Append to the end of `app/src/web/styles.css`:

```css
/* Plan 05 additions: indeterminate progress (UI spec 4.17) and chip fade-in (UI spec 4.27). */
@keyframes cb-indeterminate {
  from { transform: translateX(-100%); }
  to { transform: translateX(340%); }
}
@keyframes cb-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

- [ ] **Step 4: Implement `use-media-query.ts`, `Banner.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `ProgressBar.tsx`**

`app/src/web/state/use-media-query.ts`:

```ts
import { useSyncExternalStore } from "react";

export const BP = { sm: "(min-width: 40rem)", lg: "(min-width: 64rem)", xl: "(min-width: 80rem)" } as const;
const REDUCED = "(prefers-reduced-motion: reduce)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const usePrefersReducedMotion = (): boolean => useMediaQuery(REDUCED);
export const prefersReducedMotion = (): boolean => window.matchMedia(REDUCED).matches;
```

`app/src/web/components/ui/Banner.tsx`:

```tsx
import { Button, LinkButton } from "./Button.tsx";
import { Icon, type IconName } from "./icons.tsx";

export type BannerTone = "warning" | "error" | "info" | "success";

export interface BannerAction {
  label: string;
  onClick?: (() => void) | undefined;
  href?: string | undefined;
  external?: boolean | undefined;
  loading?: boolean | undefined;
}

export interface BannerProps {
  tone: BannerTone;
  title: string;
  body?: string | undefined;
  actions?: BannerAction[] | undefined;
  dismissible?: boolean | undefined;
  onDismiss?: (() => void) | undefined;
  /** True for banners that appear after the page loaded (UI spec 4.19). */
  announce?: boolean | undefined;
}

const TONE: Record<BannerTone, string> = {
  warning: "bg-check-soft border-check-line text-check-ink-strong",
  error: "bg-trash-soft border-trash-line text-trash-ink",
  info: "bg-archive-soft border-archive-line text-archive-ink",
  success: "bg-keep-soft border-keep-line text-keep-ink",
};
const ICON: Record<BannerTone, IconName> = { warning: "warning", error: "error", info: "info", success: "success" };

export function Banner({ tone, title, body, actions = [], dismissible = false, onDismiss, announce = false }: BannerProps) {
  const role = announce ? (tone === "error" ? "alert" : "status") : undefined;
  return (
    <div role={role} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-body ${TONE[tone]}`}>
      <Icon name={ICON[tone]} size={16} />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{title}</span>
        {body ? ` ${body}` : null}
      </p>
      {actions.map((a) =>
        a.href ? (
          <LinkButton key={a.label} href={a.href} external={a.external} size="sm" variant="secondary">
            {a.label}
          </LinkButton>
        ) : (
          <Button key={a.label} size="sm" variant="secondary" loading={a.loading} onClick={a.onClick}>
            {a.label}
          </Button>
        ),
      )}
      {dismissible ? (
        <Button variant="ghost" size="sm" icon="close" aria-label={`Dismiss: ${title}`} onClick={onDismiss} />
      ) : null}
    </div>
  );
}
```

`app/src/web/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode, Ref } from "react";
import { Button } from "./Button.tsx";
import { Icon, type IconName } from "./icons.tsx";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: "secondary" | "primary";
}

export interface EmptyStateProps {
  variant: "panel" | "page" | "inline";
  title: string;
  body: string;
  action?: EmptyStateAction | undefined;
  secondaryAction?: EmptyStateAction | undefined;
  icon?: IconName | undefined;
  headingLevel?: 1 | 2 | 3;
  actionRef?: Ref<HTMLButtonElement> | undefined;
  children?: ReactNode;
}

const FRAME = {
  panel: "rounded-xl border border-line bg-surface p-[26px] text-center",
  page: "mx-auto max-w-[480px] pt-8 text-center",
  inline: "px-4 py-10 text-center",
};

export function EmptyState({ variant, title, body, action, secondaryAction, icon, headingLevel = 2, actionRef, children }: EmptyStateProps) {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={FRAME[variant]}>
      {icon && variant === "page" ? <Icon name={icon} size={32} className="mx-auto mb-3 text-ink-3" /> : null}
      <Heading className="text-title font-semibold text-ink">{title}</Heading>
      <p className="mx-auto mt-1 mb-3 max-w-[420px] text-ink-3">{body}</p>
      {children}
      {action || secondaryAction ? (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {action ? (
            <Button ref={actionRef} variant={action.variant ?? "secondary"} onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant={secondaryAction.variant ?? "secondary"} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

`app/src/web/components/ui/Skeleton.tsx`:

```tsx
import { cssVars } from "./css-vars.ts";

export const SHIMMER =
  "bg-[linear-gradient(90deg,var(--color-surface-sunk),var(--color-skeleton-highlight),var(--color-surface-sunk))] bg-[length:200%_100%] motion-safe:animate-shimmer motion-reduce:bg-none motion-reduce:bg-surface-sunk";

const HEIGHT = { 6: "h-1.5", 10: "h-2.5", 14: "h-3.5" } as const;

export function SkeletonLine({ width, height = 10 }: { width: number | `${number}%`; height?: 6 | 10 | 14 }) {
  const w = typeof width === "number" ? `${width}px` : width;
  return <span aria-hidden="true" className={`block max-w-full w-(--cb-w) rounded-xs ${HEIGHT[height]} ${SHIMMER}`} style={cssVars({ "--cb-w": w })} />;
}

/** Same grid and padding as SenderGroupRow so nothing shifts when data arrives. */
export function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid min-h-14 grid-cols-[22px_minmax(0,1fr)_92px_108px_44px] items-center gap-2.5 border-b border-line-subtle px-3.5 py-2.5">
          <span className={`size-[15px] rounded-xs ${SHIMMER}`} />
          <span className="flex items-center gap-[9px]">
            <span className={`size-[22px] shrink-0 rounded-sm ${SHIMMER}`} />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <SkeletonLine width={140} />
              <SkeletonLine width={220} height={6} />
            </span>
          </span>
          <span className={`h-[18px] w-16 rounded-sm ${SHIMMER}`} />
          <span className="flex flex-col gap-1.5">
            <SkeletonLine width={80} />
            <span className={`h-1 w-full rounded-xs ${SHIMMER}`} />
          </span>
          <span className="ml-auto">
            <SkeletonLine width={24} />
          </span>
        </div>
      ))}
    </div>
  );
}
```

`app/src/web/components/ui/ProgressBar.tsx`:

```tsx
import { cssVars } from "./css-vars.ts";

export interface ProgressBarProps {
  value: number | null;
  tone: "on-inverse" | "accent" | "archive" | "ink";
  height?: 4 | 6;
  label: string;
  valueText?: string | undefined;
  width?: "full" | 240;
}

const FILL = { "on-inverse": "bg-on-inverse", accent: "bg-accent", archive: "bg-archive", ink: "bg-ink" } as const;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function ProgressBar({ value, tone, height = 4, label, valueText, width = "full" }: ProgressBarProps) {
  const track = tone === "on-inverse" ? "bg-inverse-track" : "bg-track";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(clamp(value) * 100)}
      aria-valuetext={valueText}
      className={`cb-meter relative overflow-hidden rounded-xs ${track} ${height === 6 ? "h-1.5" : "h-1"} ${
        width === 240 ? "w-[240px] max-w-full" : "w-full"
      }`}
    >
      {value === null ? (
        <i className={`absolute inset-y-0 left-0 w-[30%] rounded-xs ${FILL[tone]} motion-safe:animate-[cb-indeterminate_1.2s_var(--ease-standard)_infinite]`} />
      ) : (
        <i
          className={`cb-fill block h-full rounded-xs ${FILL[tone]} motion-safe:transition-[width] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-standard)`}
          style={cssVars({ "--cb-value": clamp(value) })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `Table.tsx` and `Tabs.tsx`**

`app/src/web/components/ui/Table.tsx`:

```tsx
import type { ReactNode } from "react";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { Button } from "./Button.tsx";
import { SkeletonLine } from "./Skeleton.tsx";

export interface Column<Row> {
  key: string;
  header: string;
  align?: "left" | "right";
  className?: string;
  srOnlyHeader?: boolean;
  render: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  caption: string;
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string | number;
  state: "loading" | "ready" | "empty" | "error";
  emptyText: string;
  onRetry?: (() => void) | undefined;
  footer?: ReactNode;
  rowHover?: (row: Row) => boolean;
}

const TD = "border-b border-line-subtle px-4 py-2.5 text-ink-2";

export function Table<Row>({ caption, columns, rows, rowKey, state, emptyText, onRetry, footer, rowHover }: TableProps<Row>) {
  const narrow = !useMediaQuery(BP.sm);
  const span = columns.length;
  const table = (
    <table className="w-full border-collapse text-body">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={`border-b border-line bg-surface px-4 py-2 text-meta font-medium text-ink-3 ${c.align === "right" ? "text-right" : "text-left"} ${c.className ?? ""}`}>
              {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody aria-busy={state === "loading" || undefined}>
        {state === "loading"
          ? Array.from({ length: 5 }, (_, i) => (
              <tr key={i} aria-hidden="true">
                {columns.map((c) => (
                  <td key={c.key} className={TD}>
                    <SkeletonLine width="60%" />
                  </td>
                ))}
              </tr>
            ))
          : null}
        {state === "empty" ? (
          <tr>
            <td colSpan={span} className="px-4 py-6 text-center text-ink-3">{emptyText}</td>
          </tr>
        ) : null}
        {state === "error" ? (
          <tr>
            <td colSpan={span} className="px-4 py-6 text-center text-ink-3">
              Couldn't load this table.{" "}
              {onRetry ? <Button variant="link" onClick={onRetry}>Try again</Button> : null}
            </td>
          </tr>
        ) : null}
        {state === "ready"
          ? rows.map((row) => (
              <tr key={rowKey(row)} className={`[&:last-child>td]:border-b-0 ${rowHover?.(row) ? "hover:bg-surface-hover" : ""}`}>
                {columns.map((c) => (
                  <td key={c.key} className={`${TD} ${c.align === "right" ? "text-right" : ""}`}>{c.render(row)}</td>
                ))}
              </tr>
            ))
          : null}
      </tbody>
    </table>
  );
  return (
    <>
      {narrow ? (
        <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto">{table}</div>
      ) : (
        table
      )}
      {footer}
    </>
  );
}
```

`app/src/web/components/ui/Tabs.tsx`:

```tsx
import { useRef, type KeyboardEvent } from "react";
import { formatCount } from "../../lib/format.ts";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number | null | undefined;
  ariaLabel?: string | undefined;
}

export interface TabsProps<K extends string> {
  label: string;
  value: K;
  items: readonly TabItem<K>[];
  onChange: (key: K) => void;
  controls: string;
  idPrefix: string;
}

/** WAI-ARIA tabs with roving tabindex and automatic activation (UI spec 4.6, 4.26). */
export function Tabs<K extends string>({ label, value, items, onChange, controls, idPrefix }: TabsProps<K>) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const go = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.key);
    refs.current.get(item.key)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    go(next);
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-0.5">
      {items.map((item, i) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) refs.current.set(item.key, el);
              else refs.current.delete(item.key);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.key}`}
            aria-selected={selected}
            aria-controls={controls}
            aria-label={item.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`relative px-2.5 py-2 text-body outline-offset-[-2px] transition-colors duration-(--duration-fast) ${
              selected
                ? "font-emphasis text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-xs after:bg-ink"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {item.label}
            {item.count !== null && item.count !== undefined ? (
              <b className={`ml-1 font-emphasis ${item.count === 0 ? "text-ink-3" : "text-ink-2"}`}>{formatCount(item.count)}</b>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Implement `Menu.tsx` and `Dialog.tsx`**

`app/src/web/components/ui/Menu.tsx`:

```tsx
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "./icons.tsx";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName | undefined;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface MenuProps {
  label: string;
  items: readonly MenuItem[];
  align?: "start" | "end";
  placement?: "below" | "above";
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
}

/** WAI-ARIA menu button (UI spec 4.25). Keys are handled here and never reach the global hotkeys. */
export function Menu({ label, items, align = "start", placement = "below", renderTrigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!listRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const step = (dir: 1 | -1) => {
    const pos = enabled.indexOf(active);
    const next = enabled[(pos + dir + enabled.length) % enabled.length];
    if (next !== undefined) setActive(next);
  };

  const onListKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") setActive(enabled[0] ?? 0);
    else if (e.key === "End") setActive(enabled[enabled.length - 1] ?? 0);
    else if (e.key === "Escape" || e.key === "Tab") close(e.key === "Escape");
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const match = enabled.find((i) => i > active && items[i]?.label.toLowerCase().startsWith(e.key.toLowerCase()))
        ?? enabled.find((i) => items[i]?.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (match !== undefined) setActive(match);
    } else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <div className="relative inline-flex">
      {renderTrigger({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        onClick: () => (open ? close(false) : openAt(enabled[0] ?? 0)),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            openAt(e.key === "ArrowDown" ? (enabled[0] ?? 0) : (enabled[enabled.length - 1] ?? 0));
          }
        },
      })}
      {open ? (
        <div
          id={menuId}
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          className={`absolute z-(--z-popover) min-w-[200px] rounded-lg border border-line bg-surface p-1 shadow-overlay motion-safe:animate-[cb-fade-in_200ms_var(--ease-out)] ${
            align === "end" ? "right-0" : "left-0"
          } ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-index={i}
              tabIndex={i === active ? 0 : -1}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={`flex h-[30px] w-full items-center gap-2 rounded-sm px-2 text-left text-body outline-offset-[-2px] hover:bg-surface-hover focus-visible:bg-surface-hover disabled:opacity-45 ${
                item.destructive ? "text-trash-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

`app/src/web/components/ui/Dialog.tsx`:

```tsx
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string | undefined;
}

/** Native modal dialog (UI spec 4.33); focus goes to the title and returns to the opener. */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      dialog.querySelector<HTMLElement>("h2")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnTo.current?.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={`z-(--z-dialog) m-auto w-[520px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-5 text-ink shadow-overlay backdrop:bg-[rgba(16,17,22,.32)] ${className ?? ""}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <h2 id={titleId} tabIndex={-1} className="text-title font-semibold outline-none">
          {title}
        </h2>
        <Button variant="ghost" size="sm" icon="close" aria-label="Close" className="ml-auto" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
```

- [ ] **Step 7: Implement `Chip.tsx` and `ChipInput.tsx`**

`app/src/web/components/ui/Chip.tsx`:

```tsx
import { Icon } from "./icons.tsx";

export interface ChipProps {
  label: string;
  onRemove?: (() => void) | undefined;
  removeLabel: string;
  note?: string | undefined;
}

export function Chip({ label, onRemove, removeLabel, note }: ChipProps) {
  return (
    <li className="cb-chip inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-[3px] pr-1.5 pl-2.5 text-small text-ink-2 motion-safe:animate-[cb-fade-in_200ms_var(--ease-out)]">
      <span>{label}</span>
      {note ? <span className="text-ink-3">{note}</span> : null}
      {onRemove ? (
        <button type="button" aria-label={removeLabel} onClick={onRemove} className="group -my-1 grid size-6 place-items-center rounded-full">
          <span className="grid size-4 place-items-center rounded-full bg-surface-sunk text-ink-3 group-hover:bg-line group-hover:text-ink">
            <Icon name="close" size={10} strokeWidth={2} />
          </span>
        </button>
      ) : null}
    </li>
  );
}
```

`app/src/web/components/ui/ChipInput.tsx`:

```tsx
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { formatCount } from "../../lib/format.ts";
import { Chip } from "./Chip.tsx";
import { Icon } from "./icons.tsx";

export type ChipValidation = { ok: true; value: string } | { ok: false; error: string };

export interface ChipInputProps {
  /** id of the visible field title (UI spec 4.27: the group label). */
  labelledBy: string;
  /** List name used in the list label and remove labels ("Always keep"). */
  listName: string;
  values: readonly string[];
  placeholder: string;
  validate: (raw: string) => ChipValidation;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  max: number;
  notes?: Readonly<Record<string, string>> | undefined;
  serverError?: string | null | undefined;
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
}

export function ChipInput({
  labelledBy, listName, values, placeholder, validate, onAdd, onRemove, max, notes, serverError, describedBy, disabled = false,
}: ChipInputProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const errorId = useId();
  const shown = error ?? serverError ?? null;

  const commit = () => {
    const raw = draft.trim();
    if (!raw) return;
    if (values.length >= max) return setError(`Lists hold up to ${formatCount(max)} entries.`);
    const result = validate(raw);
    if (!result.ok) return setError(result.error);
    if (values.includes(result.value)) return setError("This entry is already in the list.");
    onAdd(result.value);
    setDraft("");
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "") {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
      buttons?.[buttons.length - 1]?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <ul ref={listRef} aria-label={listName} className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <Chip key={v} label={v} note={notes?.[v]} removeLabel={`Remove ${v} from ${listName}`} onRemove={disabled ? undefined : () => onRemove(v)} />
          ))}
        </ul>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-labelledby={labelledBy}
          aria-invalid={shown ? true : undefined}
          aria-describedby={[describedBy ?? "", shown ? errorId : ""].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          className={`h-[26px] w-[200px] rounded-full border bg-surface px-2.5 py-[3px] text-body text-ink placeholder:text-ink-3 focus-visible:border-focus disabled:opacity-45 ${
            shown ? "border-trash-ink" : "border-line-control hover:border-ink-3"
          }`}
        />
      </div>
      {shown ? (
        <p id={errorId} className="flex items-center gap-1 text-small text-trash-ink">
          <Icon name="alert" size={12} />
          {shown}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/ui/composites.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 9: Commit**

```bash
git add app/src/web/state/use-media-query.ts app/src/web/components/ui app/src/web/styles.css app/test/web/components/ui/composites.test.tsx
git commit -m "feat(web): add banners, empty states, skeletons, progress, table, tabs, menu, dialog and chips"
```

---

### Task 9: Live announcer, toast queue and the undo stack

**Files:**
- Create: `app/src/web/state/LiveAnnouncer.tsx`, `app/src/web/state/toast-queue.ts`, `app/src/web/state/ToastProvider.tsx`, `app/src/web/components/ui/Toast.tsx`, `app/src/web/state/UndoStackProvider.tsx`, `app/src/web/state/use-now.ts`, `app/src/web/state/use-platform.ts`, `app/test/web/helpers/core.tsx`
- Modify: `app/src/web/styles.css` (append `cb-toast-in` keyframes)
- Test: `app/test/web/state/toasts.test.tsx`, `app/test/web/state/undo-stack.test.tsx`

**Interfaces:**
- Consumes: `api.undoBatch` (Task 4), `invalidateAfterActions` (Task 5), `ApiError` (Task 4), `Button`, `Icon`, `Kbd`, `Spinner` (Task 7), `prefersReducedMotion` (Task 8), `detectPlatform`, `modKey`, `ariaMod` (Task 3), `formatCount` (Task 3).
- Produces:
  - `LiveAnnouncerProvider`, `useAnnounce(): (text: string) => void` (region carries `data-live-announcer`).
  - `toast-queue.ts`: `type ToastKind`, `interface ToastAction { label: "Undo" | "Try again" | "Reconnect" | "View"; onAction(); shortcut? }`, `interface ToastInput { kind; message; action?; durationMs?; dedupeKey?; busy? }`, `interface ToastItem extends ToastInput { id; createdAt; leaving? }`, `MAX_TOASTS = 3`, `defaultDuration(t)`, `addToast(list, item)`.
  - `ToastProvider`, `useToast(): ToastApi { show(t): string; update(id, patch): void; dismiss(id): void }`, `useToastList(): ToastItem[]`.
  - `ToastRegion({ raised: boolean })`, `ToastView`.
  - `UndoStackProvider`, `useUndoStack(): { notifyWithUndo(n: UndoNotice): void; undo(entryId, toastId?): Promise<void>; undoLatest(): Promise<void>; size: number }`, `interface UndoNotice { kind: "cleanup" | "action"; message: string; batchIds: number[]; dedupeKey?; expiresAt? }`, `undoResultMessage(kind, restored, failed)`.
  - `useNow(): number` (shared 30 s clock), `usePlatform(): Platform`.
  - Test helper `renderWithCore(ui, opts?)` from `test/web/helpers/core.tsx` (QueryClient + memory router + announcer + toasts + undo stack + toast region).

- [ ] **Step 1: Write the failing tests**

`app/test/web/helpers/core.tsx`:

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ToastRegion } from "../../../src/web/components/ui/Toast.tsx";
import { LiveAnnouncerProvider } from "../../../src/web/state/LiveAnnouncer.tsx";
import { ToastProvider } from "../../../src/web/state/ToastProvider.tsx";
import { UndoStackProvider } from "../../../src/web/state/UndoStackProvider.tsx";
import { createTestQueryClient } from "./query.tsx";

export function CoreProviders({ children }: { children: ReactNode }) {
  return (
    <LiveAnnouncerProvider>
      <ToastProvider>
        <UndoStackProvider>
          {children}
          <ToastRegion raised={false} />
        </UndoStackProvider>
      </ToastProvider>
    </LiveAnnouncerProvider>
  );
}

/** Renders `ui` inside the cross-page providers, a memory router and a fresh QueryClient. */
export function renderWithCore(ui: ReactNode, opts: { client?: QueryClient; path?: string } = {}) {
  const client = opts.client ?? createTestQueryClient();
  const router = createMemoryRouter(
    [
      { path: "*", element: <CoreProviders>{ui}</CoreProviders> },
    ],
    { initialEntries: [opts.path ?? "/review"] },
  );
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, client, router, user: userEvent.setup() };
}

export function announcements(): string {
  return document.querySelector("[data-live-announcer]")?.textContent ?? "";
}
```

`app/test/web/state/toasts.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnnounce } from "../../../src/web/state/LiveAnnouncer.tsx";
import { addToast, defaultDuration, type ToastItem } from "../../../src/web/state/toast-queue.ts";
import { useToast, type ToastApi } from "../../../src/web/state/ToastProvider.tsx";
import { announcements, renderWithCore } from "../helpers/core.tsx";

const item = (id: string, kind: ToastItem["kind"], dedupeKey?: string): ToastItem => ({
  id, kind, message: id, createdAt: 0, ...(dedupeKey ? { dedupeKey } : {}),
});

describe("toast queue rules (UI spec 6.8)", () => {
  it("keeps at most 3 and drops the oldest non-error first", () => {
    const list = [item("e1", "error"), item("s1", "success"), item("i1", "info")];
    expect(addToast(list, item("s2", "success")).map((t) => t.id)).toEqual(["e1", "i1", "s2"]);
  });

  it("drops the oldest error when all 3 are errors", () => {
    const list = [item("e1", "error"), item("e2", "error"), item("e3", "error")];
    expect(addToast(list, item("s1", "success")).map((t) => t.id)).toEqual(["e2", "e3", "s1"]);
  });

  it("replaces a toast with the same dedupe key in place", () => {
    const list = [item("a", "info", "online"), item("b", "success")];
    expect(addToast(list, { ...item("a", "info", "online"), message: "Back online." }).map((t) => t.message)).toEqual(["Back online.", "b"]);
  });

  it("uses 8 s for success, 5 s for info and keeps errors", () => {
    expect([defaultDuration(item("a", "success")), defaultDuration(item("b", "info")), defaultDuration(item("c", "error"))]).toEqual([8000, 5000, null]);
  });
});

describe("ToastProvider and region", () => {
  afterEach(() => vi.useRealTimers());

  function Grab({ onReady }: { onReady: (api: ToastApi, announce: (t: string) => void) => void }) {
    onReady(useToast(), useAnnounce());
    return null;
  }

  it("renders polite toasts with the undo hint and errors as alerts, then expires success after 8 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api: ToastApi | null = null;
    renderWithCore(<Grab onReady={(a) => (api = a)} />);
    act(() => {
      api?.show({ kind: "success", message: "Moved 6 emails from Northwind Deals to Trash.",
        action: { label: "Undo", shortcut: "mod+z", onAction: () => undefined } });
      api?.show({ kind: "error", message: "Something went wrong. Nothing was changed." });
    });
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.querySelector("[aria-live='polite']")?.textContent).toContain("Press Control Z to undo");
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong. Nothing was changed.");
    act(() => vi.advanceTimersByTime(8_000 + 250));
    expect(screen.queryByText("Moved 6 emails from Northwind Deals to Trash.")).toBeNull();
    expect(screen.getByText("Something went wrong. Nothing was changed.")).toBeTruthy();
  });

  it("announces through the live announcer and clears after 1 s", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let announce: (t: string) => void = () => undefined;
    renderWithCore(<Grab onReady={(_a, an) => (announce = an)} />);
    act(() => announce("Clean up started, 14 emails"));
    expect(announcements()).toBe("Clean up started, 14 emails");
    act(() => vi.advanceTimersByTime(1_000));
    expect(announcements()).toBe("");
  });
});
```

`app/test/web/state/undo-stack.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUndoStack } from "../../../src/web/state/UndoStackProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

type Stack = ReturnType<typeof useUndoStack>;

function Grab({ onReady }: { onReady: (s: Stack) => void }) {
  onReady(useUndoStack());
  return null;
}

describe("UndoStackProvider", () => {
  it("shows Undo, undoes every batch newest first and reports the total", async () => {
    const state = installFakeApi((s) => {
      s.batches.unshift({ id: 11, kind: "approve", createdAt: iso(T0), requestedCount: 5, executedCount: 5, failedCount: 0,
        byAction: { delete: 5, archive: 0, keep: 0 }, undoable: true, undoExpiresAt: iso(T0 + 86_400_000), undoneAt: null, itemIds: [] });
    });
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() => stack?.notifyWithUndo({ kind: "action", message: "Moved 1,285 emails from 2 sender groups to Trash.", batchIds: [3, 11] }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Restored 1,285 emails to your inbox.");
    expect(state.requests.filter((r) => r.route === "undo").map((r) => r.url.pathname)).toEqual([
      "/api/batches/11/undo",
      "/api/batches/3/undo",
    ]);
  });

  it("reports an expired undo", async () => {
    installFakeApi();
    let stack: Stack | null = null;
    const { user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    act(() => stack?.notifyWithUndo({ kind: "cleanup", message: "14 emails cleaned up from 4 sender groups", batchIds: [1] }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undo is no longer available for this Clean up (24 hours passed).");
  });

  it("explains an empty stack and links to Activity", async () => {
    installFakeApi();
    let stack: Stack | null = null;
    const { router, user } = renderWithCore(<Grab onReady={(s) => (stack = s)} />);
    await act(() => stack?.undoLatest() ?? Promise.resolve());
    expect(screen.getByText("Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/toasts.test.tsx test/web/state/undo-stack.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/components/ui/Toast.tsx`.

- [ ] **Step 3: Append the toast keyframes and implement the small hooks**

Append to `app/src/web/styles.css`:

```css
@keyframes cb-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
```

`app/src/web/state/use-now.ts`:

```ts
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void): () => void {
  if (listeners.size === 0) now = Date.now();
  listeners.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of [...listeners]) l();
  }, 30_000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Shared clock for relative times; ticks every 30 s (UI spec 6.7). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
```

`app/src/web/state/use-platform.ts`:

```ts
import { useMemo } from "react";
import { detectPlatform } from "../lib/platform.ts";
import type { Platform } from "../lib/view-types.ts";

export function usePlatform(): Platform {
  return useMemo(() => detectPlatform(), []);
}
```

`app/src/web/state/LiveAnnouncer.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(text: string) => void>(() => undefined);

/** One polite live region for the whole app (UI spec 4.33); clears after 1 s so repeats are re-read. */
export function LiveAnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(""), 1_000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div data-live-announcer aria-live="polite" aria-atomic="true" className="sr-only">
        {text}
      </div>
    </AnnounceContext.Provider>
  );
}

export const useAnnounce = (): ((text: string) => void) => useContext(AnnounceContext);
```

- [ ] **Step 4: Implement the toast queue and provider**

`app/src/web/state/toast-queue.ts`:

```ts
export type ToastKind = "success" | "info" | "error";

export interface ToastAction {
  label: "Undo" | "Try again" | "Reconnect" | "View";
  onAction: () => void;
  shortcut?: "mod+z" | undefined;
}

export interface ToastInput {
  kind: ToastKind;
  message: string;
  action?: ToastAction | undefined;
  durationMs?: number | undefined;
  dedupeKey?: string | undefined;
  /** "Undoing…" state: spinner, no buttons (decision W11). */
  busy?: boolean | undefined;
}

export interface ToastItem extends ToastInput {
  id: string;
  createdAt: number;
  leaving?: boolean | undefined;
}

export const MAX_TOASTS = 3;

export function defaultDuration(t: ToastInput): number | null {
  if (t.durationMs !== undefined) return t.durationMs;
  if (t.kind === "error") return null;
  return t.kind === "success" ? 8_000 : 5_000;
}

/** UI spec 6.8: dedupe in place; a 4th toast drops the oldest non-error, else the oldest error. */
export function addToast(list: readonly ToastItem[], item: ToastItem): ToastItem[] {
  if (item.dedupeKey) {
    const i = list.findIndex((t) => t.dedupeKey === item.dedupeKey);
    if (i >= 0) return list.map((t, j) => (j === i ? item : t));
  }
  const next = [...list, item];
  while (next.filter((t) => !t.leaving).length > MAX_TOASTS) {
    const older = next.slice(0, -1);
    const victim = older.findIndex((t) => !t.leaving && t.kind !== "error");
    next.splice(victim >= 0 ? victim : older.findIndex((t) => !t.leaving), 1);
  }
  return next;
}
```

`app/src/web/state/ToastProvider.tsx`:

```tsx
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./use-media-query.ts";
import { addToast, type ToastInput, type ToastItem } from "./toast-queue.ts";

export interface ToastApi {
  show(t: ToastInput): string;
  update(id: string, patch: Partial<ToastInput>): void;
  dismiss(id: string): void;
}

const ApiContext = createContext<ToastApi | null>(null);
const ListContext = createContext<ToastItem[]>([]);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const api = useMemo<ToastApi>(
    () => ({
      show(input) {
        const id = input.dedupeKey ? `d:${input.dedupeKey}` : `t${++counter.current}`;
        setToasts((list) => addToast(list, { ...input, id, createdAt: Date.now() }));
        return id;
      },
      update(id, patch) {
        setToasts((list) => list.map((t) => (t.id === id ? { ...t, ...patch, createdAt: Date.now() } : t)));
      },
      dismiss(id) {
        setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id || !t.leaving)), prefersReducedMotion() ? 0 : 200);
      },
    }),
    [],
  );
  return (
    <ApiContext.Provider value={api}>
      <ListContext.Provider value={toasts}>{children}</ListContext.Provider>
    </ApiContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useToast needs ToastProvider");
  return api;
}

export const useToastList = (): ToastItem[] => useContext(ListContext);
```

- [ ] **Step 5: Implement the toast view and region**

`app/src/web/components/ui/Toast.tsx`:

```tsx
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ariaMod, modKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { defaultDuration, type ToastItem } from "../../state/toast-queue.ts";
import { useToast, useToastList } from "../../state/ToastProvider.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./icons.tsx";
import { Kbd } from "./Kbd.tsx";
import { Spinner } from "./Spinner.tsx";

function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    () => document.hidden,
    () => false,
  );
}

/** Pausable countdown; restarts when `resetKey` changes (dedupe or update). */
function useToastTimer(duration: number | null, paused: boolean, onExpire: () => void, resetKey: number) {
  const remaining = useRef(duration);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  useEffect(() => {
    remaining.current = duration;
  }, [duration, resetKey]);
  useEffect(() => {
    if (duration === null || paused) return;
    const started = Date.now();
    const t = setTimeout(() => expire.current(), remaining.current ?? duration);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(0, (remaining.current ?? duration) - (Date.now() - started));
    };
  }, [duration, paused, resetKey]);
}

const ICON = { success: "success", info: "info", error: "alert" } as const;

export function ToastView({ toast, platform, onDismiss }: { toast: ToastItem; platform: Platform; onDismiss: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const hidden = useDocumentHidden();
  useToastTimer(toast.busy ? null : defaultDuration(toast), hover || focusWithin || hidden, () => onDismiss(toast.id), toast.createdAt);
  const undo = toast.action?.shortcut === "mod+z";
  return (
    <div
      data-inverse
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      className={`cb-toast pointer-events-auto inline-flex max-w-[560px] items-center gap-3 rounded-lg bg-inverse py-[9px] pr-2.5 pl-3.5 text-body text-on-inverse shadow-toast motion-safe:animate-[cb-toast-in_250ms_var(--ease-out)] ${
        toast.leaving ? "translate-y-1 opacity-0 motion-safe:transition-[opacity,transform] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-in)" : ""
      }`}
    >
      {toast.busy ? <Spinner tone="on-dark" /> : <Icon name={ICON[toast.kind]} size={14} />}
      <span>{toast.message}</span>
      {toast.action && !toast.busy ? (
        <button
          type="button"
          onClick={toast.action.onAction}
          aria-keyshortcuts={undo ? `${ariaMod(platform)}+Z` : undefined}
          className="font-semibold underline underline-offset-2"
        >
          {toast.action.label}
        </button>
      ) : null}
      {undo && !toast.busy ? <Kbd keys={[modKey(platform), "Z"]} tone="on-inverse" ariaHidden /> : null}
      {undo && !toast.busy ? <span className="sr-only">{`Press ${platform === "mac" ? "Command" : "Control"} Z to undo`}</span> : null}
      {!toast.busy && (toast.kind === "error" || hover || focusWithin) ? (
        <Button variant="on-inverse-ghost" size="sm" icon="close" aria-label="Dismiss notification" className="size-5 p-0" onClick={() => onDismiss(toast.id)} />
      ) : null}
    </div>
  );
}

/** Fixed region above everything (UI spec 4.18); raised above the ConfirmBar while it shows. */
export function ToastRegion({ raised }: { raised: boolean }) {
  const toasts = useToastList();
  const { dismiss } = useToast();
  const platform = usePlatform();
  const polite = toasts.filter((t) => t.kind !== "error");
  const errors = toasts.filter((t) => t.kind === "error");
  return (
    <div
      role="region"
      aria-label="Notifications"
      className={`pointer-events-none fixed inset-x-4 z-(--z-toast) flex flex-col items-stretch gap-2 sm:inset-x-0 sm:items-center lg:left-(--layout-sidebar) ${raised ? "bottom-24" : "bottom-6"}`}
    >
      <div aria-live="polite" className="flex flex-col items-stretch gap-2 sm:items-center">
        {polite.map((t) => (
          <ToastView key={t.id} toast={t} platform={platform} onDismiss={dismiss} />
        ))}
      </div>
      {errors.map((t) => (
        <div key={t.id} role="alert" className="flex justify-center">
          <ToastView toast={t} platform={platform} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Implement the undo stack**

`app/src/web/state/UndoStackProvider.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { formatCount, plural } from "../lib/format.ts";
import { useToast } from "./ToastProvider.tsx";

export type UndoKind = "cleanup" | "action";

interface UndoEntry {
  id: string;
  kind: UndoKind;
  batchIds: number[];
  expiresAt: number;
}

export interface UndoNotice {
  kind: UndoKind;
  message: string;
  batchIds: number[];
  dedupeKey?: string | undefined;
  expiresAt?: number | undefined;
}

export interface UndoStackApi {
  notifyWithUndo(n: UndoNotice): void;
  undo(entryId: string, toastId?: string): Promise<void>;
  undoLatest(): Promise<void>;
  size: number;
}

const MAX_ENTRIES = 20;
const DAY = 86_400_000;
const Ctx = createContext<UndoStackApi | null>(null);

export function undoResultMessage(kind: UndoKind, restored: number, failed: number): string {
  if (failed === 0) return `Restored ${plural(restored, "email", "emails")} to your inbox.`;
  const rest = kind === "cleanup" ? " and are still in Trash or Archive." : ".";
  return `Restored ${plural(restored, "email", "emails")}. ${formatCount(failed)} could not be restored${rest}`;
}

const expiredMessage = (kind: UndoKind) =>
  `Undo is no longer available for this ${kind === "cleanup" ? "Clean up" : "action"} (24 hours passed).`;

export function UndoStackProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const entries = useRef<UndoEntry[]>([]);
  const counter = useRef(0);
  const [size, setSize] = useState(0);

  const undo = useCallback(
    async (entryId: string, toastId?: string) => {
      const entry = entries.current.find((e) => e.id === entryId);
      if (!entry) return;
      entries.current = entries.current.filter((e) => e.id !== entryId);
      setSize(entries.current.length);
      const busy = { kind: "info" as const, message: "Undoing…", busy: true, action: undefined };
      const id = toastId ?? toast.show(busy);
      if (toastId) toast.update(toastId, busy);
      let restored = 0;
      let failed = 0;
      try {
        for (const batchId of [...entry.batchIds].reverse()) {
          const res = await api.undoBatch(batchId);
          restored += res.restored;
          failed += res.failed;
        }
        toast.update(id, { kind: "success", busy: false, message: undoResultMessage(entry.kind, restored, failed) });
      } catch (e) {
        const message = isApiError(e) && e.code === "undo_expired" ? expiredMessage(entry.kind) : "Something went wrong. Nothing was changed.";
        toast.update(id, { kind: "error", busy: false, message });
      }
      await invalidateAfterActions(qc);
    },
    [qc, toast],
  );

  const notifyWithUndo = useCallback(
    (n: UndoNotice) => {
      if (n.batchIds.length === 0) {
        toast.show({ kind: "success", message: n.message, dedupeKey: n.dedupeKey });
        return;
      }
      const entry: UndoEntry = { id: `u${++counter.current}`, kind: n.kind, batchIds: n.batchIds, expiresAt: n.expiresAt ?? Date.now() + DAY };
      entries.current = [...entries.current, entry].slice(-MAX_ENTRIES);
      setSize(entries.current.length);
      let toastId = "";
      toastId = toast.show({
        kind: "success",
        message: n.message,
        dedupeKey: n.dedupeKey,
        action: { label: "Undo", shortcut: "mod+z", onAction: () => void undo(entry.id, toastId) },
      });
    },
    [toast, undo],
  );

  const undoLatest = useCallback(async () => {
    const now = Date.now();
    const latest = [...entries.current].reverse().find((e) => e.expiresAt > now);
    if (!latest) {
      toast.show({
        kind: "info",
        message: "Nothing to undo here. Actions from earlier sessions can be undone in Activity for 24 hours.",
        action: { label: "View", onAction: () => void navigate("/activity") },
      });
      return;
    }
    await undo(latest.id);
  }, [navigate, toast, undo]);

  const value = useMemo(() => ({ notifyWithUndo, undo, undoLatest, size }), [notifyWithUndo, undo, undoLatest, size]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUndoStack(): UndoStackApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUndoStack needs UndoStackProvider");
  return v;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/toasts.test.tsx test/web/state/undo-stack.test.tsx`
Expected: PASS (6 + 3 tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/web/state app/src/web/components/ui/Toast.tsx app/src/web/styles.css app/test/web/helpers/core.tsx app/test/web/state
git commit -m "feat(web): add live announcer, toast queue and the undo stack"
```

---

### Task 10: Hotkeys (scopes, priorities, G sequences, single-key toggle) and the help dialog

**Files:**
- Create: `app/src/web/state/hotkeys-core.ts`, `app/src/web/state/HotkeysProvider.tsx`, `app/src/web/components/shell/GSequenceHint.tsx`, `app/src/web/components/shell/ShortcutHelpDialog.tsx`
- Test: `app/test/web/state/hotkeys.test.tsx`

**Interfaces:**
- Consumes: `usePlatform` (Task 9), `useUndoStack` (Task 9), `Dialog`, `Toggle`, `Kbd` (Tasks 7, 8), `modKey`, `enterKey`, `shiftKey` (Task 3).
- Produces:
  - `hotkeys-core.ts`: `type HotkeyScope = "dialog" | "menu" | "confirm" | "slideover" | "review" | "rules" | "global"`, `SCOPE_PRIORITY`, `interface Binding { combo: string; handler(e: KeyboardEvent): void; allowInInputs?: boolean }`, `parseCombo`, `normalizeKey`, `matchesCombo(e, combo, platform)`, `isTypingTarget(target)`, `isSingleKey(combo)`, `G_ROUTES: Record<string, string>` (`r` /review, `a` /activity, `i` /insights, `u` /rules, `c` /accounts), `G_WINDOW_MS = 1000`, `G_HINT_MS = 400`, `SINGLE_KEYS_STORAGE = "clearbox.singleKeys"`.
  - `HotkeysProvider`, `useHotkeys(scope, bindings, enabled?)`, `useHotkeysControl(): { helpOpen; setHelpOpen; singleKeys; setSingleKeys; gHint }`. The provider itself binds `?` (help) and `mod+z` (undo latest) in scope `global`.
  - `GSequenceHint()`, `ShortcutHelpDialog()`.
  - Combo syntax: lowercase `mod+enter`, `mod+z`, `mod+s`, `mod+a`, `shift+x`, `x`, `j`, `arrowdown`, `pagedown`, `home`, `end`, `enter`, `escape`, `?`, `1`.

- [ ] **Step 1: Write the failing test**

`app/test/web/state/hotkeys.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSequenceHint } from "../../../src/web/components/shell/GSequenceHint.tsx";
import { ShortcutHelpDialog } from "../../../src/web/components/shell/ShortcutHelpDialog.tsx";
import { isTypingTarget, matchesCombo } from "../../../src/web/state/hotkeys-core.ts";
import { HotkeysProvider, useHotkeys } from "../../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { installFakeApi } from "../msw/handlers.ts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("hotkeys core", () => {
  it("matches combos per platform and rejects extra modifiers", () => {
    expect(matchesCombo(key({ key: "Enter", ctrlKey: true }), "mod+enter", "other")).toBe(true);
    expect(matchesCombo(key({ key: "Enter", metaKey: true }), "mod+enter", "mac")).toBe(true);
    expect(matchesCombo(key({ key: "Enter", metaKey: true }), "mod+enter", "other")).toBe(false);
    expect(matchesCombo(key({ key: "T" }), "t", "other")).toBe(true);
    expect(matchesCombo(key({ key: "t", altKey: true }), "t", "other")).toBe(false);
    expect(matchesCombo(key({ key: "X", shiftKey: true }), "shift+x", "other")).toBe(true);
    expect(matchesCombo(key({ key: "X", shiftKey: true }), "x", "other")).toBe(false);
    expect(matchesCombo(key({ key: "?", shiftKey: true }), "?", "other")).toBe(true);
  });

  it("treats text fields, not checkboxes, as typing targets", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    expect([isTypingTarget(text), isTypingTarget(box), isTypingTarget(document.createElement("textarea"))]).toEqual([true, false, true]);
  });
});

function Bindings({ review, confirm }: { review: Record<string, () => void>; confirm?: Record<string, () => void> }) {
  useHotkeys("review", [
    { combo: "t", handler: () => review.t?.() },
    { combo: "a", handler: () => review.a?.() },
    { combo: "escape", handler: () => review.escape?.() },
    { combo: "mod+enter", handler: () => review.cleanup?.(), allowInInputs: true },
  ]);
  useHotkeys("confirm", [{ combo: "escape", handler: () => confirm?.escape?.() }], confirm !== undefined);
  return <input aria-label="Search" />;
}

function setup(review: Record<string, () => void>, confirm?: Record<string, () => void>) {
  installFakeApi();
  return renderWithCore(
    <HotkeysProvider>
      <Bindings review={review} {...(confirm ? { confirm } : {})} />
      <GSequenceHint />
      <ShortcutHelpDialog />
    </HotkeysProvider>,
  );
}

describe("HotkeysProvider", () => {
  afterEach(() => vi.useRealTimers());

  it("fires single-key shortcuts outside fields and mod+Enter everywhere", async () => {
    const review = { t: vi.fn(), cleanup: vi.fn() };
    const { user } = setup(review);
    await user.keyboard("t");
    expect(review.t).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("textbox", { name: "Search" }));
    await user.keyboard("t");
    expect(review.t).toHaveBeenCalledOnce();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(review.cleanup).toHaveBeenCalledOnce();
  });

  it("gives Esc to the highest-priority scope", async () => {
    const review = { escape: vi.fn() };
    const confirm = { escape: vi.fn() };
    const { user } = setup(review, confirm);
    await user.keyboard("{Escape}");
    expect(confirm.escape).toHaveBeenCalledOnce();
    expect(review.escape).not.toHaveBeenCalled();
  });

  it("runs G sequences, where A means Activity and not Archive, and shows the hint after 400 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const review = { a: vi.fn() };
    const { router, user } = setup(review);
    await user.keyboard("g");
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("status").textContent).toBe("Go to: R Review · A Activity · I Insights · U Rules · C Accounts");
    await user.keyboard("a");
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));
    expect(review.a).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the help dialog with ? and turns single-key shortcuts off", async () => {
    const review = { t: vi.fn(), escape: vi.fn() };
    const { user } = setup(review);
    await user.keyboard("?");
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByText("Shortcuts are off while you type in a field.")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Use single-key shortcuts" }));
    expect(window.localStorage.getItem("clearbox.singleKeys")).toBe("off");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("t");
    expect(review.t).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(review.escape).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/hotkeys.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/state/hotkeys-core.ts`.

- [ ] **Step 3: Implement `hotkeys-core.ts`**

`app/src/web/state/hotkeys-core.ts`:

```ts
import type { Platform } from "../lib/view-types.ts";

export type HotkeyScope = "dialog" | "menu" | "confirm" | "slideover" | "review" | "rules" | "global";
export const SCOPE_PRIORITY: readonly HotkeyScope[] = ["dialog", "menu", "confirm", "slideover", "review", "rules", "global"];

export interface Binding {
  combo: string;
  handler: (e: KeyboardEvent) => void;
  allowInInputs?: boolean;
}

export const G_ROUTES: Readonly<Record<string, string>> = {
  r: "/review",
  a: "/activity",
  i: "/insights",
  u: "/rules",
  c: "/accounts",
};
export const G_WINDOW_MS = 1_000;
export const G_HINT_MS = 400;
export const SINGLE_KEYS_STORAGE = "clearbox.singleKeys";

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  return { key: parts[parts.length - 1] ?? "", mod: parts.includes("mod"), shift: parts.includes("shift") };
}

export function normalizeKey(e: Pick<KeyboardEvent, "key">): string {
  const k = e.key.toLowerCase();
  return k === "esc" ? "escape" : k;
}

/** UI spec 6.2: case-insensitive letters, Alt never, no modifier beyond the listed one. */
export function matchesCombo(e: KeyboardEvent, combo: string, platform: Platform): boolean {
  if (e.altKey) return false;
  const c = parseCombo(combo);
  const mod = platform === "mac" ? e.metaKey : e.ctrlKey;
  const otherMod = platform === "mac" ? e.ctrlKey : e.metaKey;
  if (otherMod || c.mod !== mod) return false;
  const key = normalizeKey(e);
  if (c.key === "?") return key === "?";
  if (c.shift !== e.shiftKey) return false;
  return key === c.key;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Character-key shortcuts that the WCAG 2.1.4 toggle turns off (letters, digits, not "?"). */
export function isSingleKey(combo: string): boolean {
  const c = parseCombo(combo);
  return !c.mod && c.key.length === 1 && c.key !== "?";
}
```

- [ ] **Step 4: Implement `HotkeysProvider.tsx`**

`app/src/web/state/HotkeysProvider.tsx`:

```tsx
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import { useNavigate } from "react-router";
import {
  G_HINT_MS, G_ROUTES, G_WINDOW_MS, isSingleKey, isTypingTarget, matchesCombo, normalizeKey, SCOPE_PRIORITY,
  SINGLE_KEYS_STORAGE, type Binding, type HotkeyScope,
} from "./hotkeys-core.ts";
import { useUndoStack } from "./UndoStackProvider.tsx";
import { usePlatform } from "./use-platform.ts";

interface Registration {
  scope: HotkeyScope;
  bindings: RefObject<Binding[]>;
}

interface Registry {
  register(scope: HotkeyScope, bindings: RefObject<Binding[]>): () => void;
}

export interface HotkeysControl {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
  gHint: boolean;
}

const RegistryContext = createContext<Registry | null>(null);
const ControlContext = createContext<HotkeysControl | null>(null);

/** Dialogs, menus, the mobile drawer and the detail sheet block single-key shortcuts (UI spec 6.2). */
const overlayOpen = () => document.querySelector("dialog[open], [role='menu'], [aria-modal='true']") !== null;

export function HotkeysProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const navigate = useNavigate();
  const { undoLatest } = useUndoStack();
  const regs = useRef(new Map<number, Registration>());
  const nextId = useRef(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [singleKeys, setSingleKeysState] = useState(() => window.localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off");
  const [gHint, setGHint] = useState(false);
  const gPending = useRef(false);
  const gTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const singleRef = useRef(singleKeys);
  useEffect(() => {
    singleRef.current = singleKeys;
  }, [singleKeys]);

  const setSingleKeys = useCallback((on: boolean) => {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE, on ? "on" : "off");
    setSingleKeysState(on);
  }, []);

  const cancelG = useCallback(() => {
    gPending.current = false;
    for (const t of gTimers.current) clearTimeout(t);
    gTimers.current = [];
    setGHint(false);
  }, []);

  const registry = useMemo<Registry>(
    () => ({
      register(scope, bindings) {
        const id = nextId.current++;
        regs.current.set(id, { scope, bindings });
        return () => regs.current.delete(id);
      },
    }),
    [],
  );

  const globalBindings = useRef<Binding[]>([]);
  useLayoutEffect(() => {
    globalBindings.current = [
      { combo: "?", handler: () => setHelpOpen(true) },
      { combo: "mod+z", handler: () => void undoLatest() },
    ];
  });
  useEffect(() => registry.register("global", globalBindings), [registry]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const typing = isTypingTarget(e.target);
      const key = normalizeKey(e);
      if (gPending.current) {
        cancelG();
        const route = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? G_ROUTES[key] : undefined;
        if (route) {
          e.preventDefault();
          void navigate(route);
        }
        return;
      }
      if (typing && key === "escape" && e.target instanceof HTMLElement) e.target.blur();
      const blocked = overlayOpen();
      for (const scope of SCOPE_PRIORITY) {
        for (const reg of regs.current.values()) {
          if (reg.scope !== scope) continue;
          for (const b of reg.bindings.current) {
            if (!matchesCombo(e, b.combo, platform)) continue;
            if (isSingleKey(b.combo) && (!singleRef.current || blocked)) continue;
            if (typing && !b.allowInInputs && key !== "escape") continue;
            e.preventDefault();
            b.handler(e);
            return;
          }
        }
      }
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (key === "g" && plain && !typing && !blocked && singleRef.current) {
        e.preventDefault();
        gPending.current = true;
        gTimers.current = [setTimeout(() => setGHint(true), G_HINT_MS), setTimeout(cancelG, G_WINDOW_MS)];
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancelG, navigate, platform]);

  const control = useMemo(
    () => ({ helpOpen, setHelpOpen, singleKeys, setSingleKeys, gHint }),
    [helpOpen, singleKeys, setSingleKeys, gHint],
  );
  return (
    <RegistryContext.Provider value={registry}>
      <ControlContext.Provider value={control}>{children}</ControlContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Registers bindings for a scope while mounted and `enabled`. The latest handlers are always used. */
export function useHotkeys(scope: HotkeyScope, bindings: Binding[], enabled = true): void {
  const registry = useContext(RegistryContext);
  const ref = useRef(bindings);
  useLayoutEffect(() => {
    ref.current = bindings;
  });
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register(scope, ref);
  }, [registry, scope, enabled]);
}

export function useHotkeysControl(): HotkeysControl {
  const v = useContext(ControlContext);
  if (!v) throw new Error("useHotkeysControl needs HotkeysProvider");
  return v;
}
```

- [ ] **Step 5: Implement the hint chip and the help dialog**

`app/src/web/components/shell/GSequenceHint.tsx`:

```tsx
import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";

export function GSequenceHint() {
  const { gHint } = useHotkeysControl();
  if (!gHint) return null;
  return (
    <div
      role="status"
      className="fixed bottom-6 left-4 z-(--z-toast) rounded-md bg-inverse px-2 py-1 text-meta text-on-inverse lg:left-[calc(var(--layout-sidebar)+22px)]"
    >
      Go to: R Review · A Activity · I Insights · U Rules · C Accounts
    </div>
  );
}
```

`app/src/web/components/shell/ShortcutHelpDialog.tsx`:

```tsx
import { useId } from "react";
import { enterKey, modKey, shiftKey } from "../../lib/platform.ts";
import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Toggle } from "../ui/Toggle.tsx";

type Row = [string[], string];

function Column({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <h3 className="mb-2 text-meta font-emphasis text-ink-3">{title}</h3>
      <dl className="flex flex-col gap-1.5 text-body text-ink-2">
        {rows.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="order-2">
              <Kbd keys={keys} />
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutHelpDialog() {
  const { helpOpen, setHelpOpen, singleKeys, setSingleKeys } = useHotkeysControl();
  const p = usePlatform();
  const toggleLabel = useId();
  const mod = modKey(p);
  return (
    <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts" className="w-[640px]">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Column title="Review" rows={[
          [["J", "K"], "move"], [["X"], "select"], [[shiftKey(p), "X"], "select range"], [["T"], "trash"],
          [["A"], "archive"], [["E"], "keep"], [[enterKey(p)], "open"], [["1", "5"], "tabs"],
        ]} />
        <Column title="Clean up" rows={[
          [[mod, enterKey(p)], "clean up"], [[enterKey(p)], "confirm"], [["Esc"], "cancel"], [[mod, "Z"], "undo"],
        ]} />
        <Column title="Go to" rows={[
          [["G", "R"], "Review"], [["G", "A"], "Activity"], [["G", "I"], "Insights"], [["G", "U"], "Rules"],
          [["G", "C"], "Accounts"], [["?"], "this help"],
        ]} />
      </div>
      <p className="mt-4 text-small text-ink-3">Shortcuts are off while you type in a field.</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span id={toggleLabel} className="text-body text-ink">Use single-key shortcuts</span>
        <Toggle checked={singleKeys} onChange={setSingleKeys} label="Use single-key shortcuts" labelledBy={toggleLabel} />
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/hotkeys.test.tsx test/web/state/undo-stack.test.tsx`
Expected: PASS (6 + 3 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/state app/src/web/components/shell app/test/web/state/hotkeys.test.tsx
git commit -m "feat(web): add scoped hotkeys, G sequences, single-key toggle and shortcut help"
```

---

### Task 11: Verdict and confidence display (avatar, tag, meter, label, reasons, split bar)

**Files:**
- Create: under `app/src/web/components/review/`: `SenderAvatar.tsx`, `VerdictTag.tsx`, `ConfidenceMeter.tsx`, `ConfidenceLabel.tsx`, `ReasonLine.tsx`, `SplitBar.tsx`
- Test: `app/test/web/components/review/display.test.tsx`

**Interfaces:**
- Consumes: `bandFor`, `toPercent`, `BAND_FILL`, `BAND_INK`, `scaleBands` (Task 3), `AVATAR_BG`, `avatarColorIndex`, `monogram` (Task 3), `Icon`, `cssVars`, `VisuallyHidden` (Task 7).
- Produces:
  - `SenderAvatar({ name, address, domain, size: 22 | 30 })`.
  - `VerdictTag({ kind: TagKind, label?, size?: "sm" | "md" })`, `VERDICT_ICON: Record<TagKind, IconName>`.
  - `ConfidenceMeter({ value, band, tau: number | null, height?, tone?, empty? })` (aria-hidden; sets `--cb-value` and `--cb-tau`).
  - `ConfidenceLabel({ value, verdict, tau, variant: "cell" | "inline" | "scale", modelUnavailable? })`, `ConfidenceScale({ tau })`.
  - `ReasonLine({ reason })`, `ReasonList({ reasons, label? })`, `reasonIcon(code): IconName`.
  - `SplitBar({ segments: SplitSegment[] })`, `interface SplitSegment { key; className; value; legend }`.

- [ ] **Step 1: Write the failing test**

`app/test/web/components/review/display.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceLabel } from "../../../../src/web/components/review/ConfidenceLabel.tsx";
import { ReasonList } from "../../../../src/web/components/review/ReasonLine.tsx";
import { SenderAvatar } from "../../../../src/web/components/review/SenderAvatar.tsx";
import { SplitBar } from "../../../../src/web/components/review/SplitBar.tsx";
import { VerdictTag } from "../../../../src/web/components/review/VerdictTag.tsx";
import { avatarColorIndex } from "../../../../src/web/lib/avatar.ts";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState } from "../../msw/fake-api.ts";

const meterVars = (root: HTMLElement) => {
  const meter = root.querySelector<HTMLElement>(".cb-meter");
  return [meter?.style.getPropertyValue("--cb-value"), meter?.style.getPropertyValue("--cb-tau")];
};

describe("SenderAvatar and VerdictTag", () => {
  it("renders a deterministic monogram and a ? for unknown senders", () => {
    const { container } = render(
      <>
        <SenderAvatar name="Northwind Deals" address="promo@northwind.example" domain="northwind.example" size={22} />
        <SenderAvatar name={null} address="" domain="" size={30} />
      </>,
    );
    const [known, unknown] = [...container.querySelectorAll("span[aria-hidden='true']")];
    expect(known?.textContent).toBe("N");
    expect(known?.className).toContain(`bg-avatar-${avatarColorIndex("northwind.example")}`);
    expect(unknown?.textContent).toBe("?");
    expect(unknown?.className).toContain("bg-neutral-fill");
  });

  it("always shows an icon plus a word", () => {
    render(
      <>
        <VerdictTag kind="delete" />
        <VerdictTag kind="unsure" />
        <VerdictTag kind="protected" size="sm" />
        <VerdictTag kind="delete" label="Move 6 to Trash" />
      </>,
    );
    expect(screen.getByText("Trash").closest(".cb-tag")?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(screen.getByText("Check")).toBeTruthy();
    expect(screen.getByText("Protected")).toBeTruthy();
    expect(screen.getByText("Move 6 to Trash")).toBeTruthy();
  });
});

describe("ConfidenceLabel", () => {
  const tau = createFakeApiState().tau;

  it("bands the cell with tau from the API and sets meter geometry through --cb-* only", () => {
    const { container } = render(<ConfidenceLabel value={0.85} verdict="delete" tau={tau} variant="cell" />);
    expect(container.textContent).toContain("85%");
    expect(container.textContent).toContain("Likely");
    expect(screen.getByText("85 percent, Likely")).toBeTruthy();
    expect(meterVars(container)).toEqual(["0.85", String(tau)]);
  });

  it("moves the boundary when tau moves", () => {
    const { container, rerender } = render(<ConfidenceLabel value={0.85} verdict="delete" tau={0.8} variant="cell" />);
    expect(container.textContent).toContain("Sure");
    rerender(<ConfidenceLabel value={0.97} verdict="archive" tau={0.8} variant="cell" />);
    expect(container.textContent).toContain("Very sure");
  });

  it("adds the left-for-you hint and the model-unavailable state inline", () => {
    const { container, rerender } = render(<ConfidenceLabel value={0.78} verdict="archive" tau={tau} variant="inline" />);
    expect(container.textContent).toBe("78%Likely· left for you");
    rerender(<ConfidenceLabel value={0.5} verdict="unsure" tau={tau} variant="inline" modelUnavailable />);
    expect(container.textContent).toBe("n/aUnsure· model unavailable");
  });

  it("computes the scale cards from tau", () => {
    render(<ConfidenceLabel value={0} verdict="delete" tau={0.88} variant="scale" />);
    expect(screen.getByText("88 to 94%")).toBeTruthy();
    expect(screen.getByText("70 to 87%")).toBeTruthy();
  });
});

describe("ReasonList and SplitBar", () => {
  it("renders reason text verbatim with icons hidden", () => {
    render(<ReasonList reasons={[{ code: "list_unsubscribe", text: "Has an unsubscribe link" }, { code: "guard_starred", text: "You starred or flagged this email" }]} />);
    const list = screen.getByRole("list", { name: "Reasons" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Has an unsubscribe link",
      "You starred or flagged this email",
    ]);
  });

  it("omits zero segments and grows segments through --cb-grow", async () => {
    const { container } = render(
      <SplitBar segments={[
        { key: "trash", className: "bg-trash", value: 11, legend: "11 to trash" },
        { key: "archive", className: "bg-archive", value: 0, legend: "0 to archive" },
        { key: "left", className: "bg-neutral-fill", value: 13, legend: "13 to check or keep" },
      ]} />,
    );
    expect([...container.querySelectorAll(".cb-grow")].map((el) => (el as HTMLElement).style.getPropertyValue("--cb-grow"))).toEqual(["11", "13"]);
    expect(screen.queryByText("0 to archive")).toBeNull();
    await expectNoA11yViolations(container);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/display.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/components/review/ConfidenceLabel.tsx`.

- [ ] **Step 3: Implement `SenderAvatar.tsx` and `VerdictTag.tsx`**

`app/src/web/components/review/SenderAvatar.tsx`:

```tsx
import { AVATAR_BG, avatarColorIndex, monogram } from "../../lib/avatar.ts";

export interface SenderAvatarProps {
  name: string | null;
  address: string;
  domain: string;
  size: 22 | 30;
}

/** Private monogram; never a remote logo (UI spec 4.9). */
export function SenderAvatar({ name, address, domain, size }: SenderAvatarProps) {
  const unknown = !address && !domain;
  const tone = unknown ? "bg-neutral-fill text-ink" : `${AVATAR_BG[avatarColorIndex(domain || address)] ?? "bg-avatar-0"} text-white`;
  const dims = size === 22 ? "size-[22px] rounded-sm text-micro" : "size-[30px] rounded-md text-base";
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center font-heavy ${dims} ${tone}`}>
      {unknown ? "?" : monogram(name, address, domain)}
    </span>
  );
}
```

`app/src/web/components/review/VerdictTag.tsx`:

```tsx
import { VERDICT_LABEL, type TagKind } from "../../lib/view-types.ts";
import { Icon, type IconName } from "../ui/icons.tsx";

export const VERDICT_ICON: Record<TagKind, IconName> = {
  delete: "trash",
  archive: "archive",
  keep: "keep",
  unsure: "check-question",
  protected: "shield",
};

const TONE: Record<TagKind, string> = {
  delete: "bg-trash-soft text-trash-ink",
  archive: "bg-archive-soft text-archive-ink",
  keep: "bg-keep-soft text-keep-ink",
  unsure: "bg-check-soft text-check-ink",
  protected: "bg-surface-sunk text-ink-2",
};

export function VerdictTag({ kind, label, size = "md" }: { kind: TagKind; label?: string | undefined; size?: "sm" | "md" }) {
  const word = kind === "protected" ? "Protected" : VERDICT_LABEL[kind];
  return (
    <span
      className={`cb-tag inline-flex items-center gap-[5px] rounded-sm text-meta font-emphasis whitespace-nowrap ${
        size === "sm" ? "py-px pr-1.5 pl-1" : "py-0.5 pr-2 pl-1.5"
      } ${TONE[kind]}`}
    >
      <Icon name={VERDICT_ICON[kind]} size={size === "sm" ? 10 : 12} strokeWidth={1.6} />
      {label ?? word}
    </span>
  );
}
```

- [ ] **Step 4: Implement `ConfidenceMeter.tsx` and `ConfidenceLabel.tsx`**

`app/src/web/components/review/ConfidenceMeter.tsx`:

```tsx
import { BAND_FILL } from "../../lib/confidence.ts";
import type { Band } from "../../lib/view-types.ts";
import { cssVars } from "../ui/css-vars.ts";

export interface ConfidenceMeterProps {
  value: number;
  band: Band;
  tau: number | null;
  height?: 4 | 6;
  tone?: "band" | "accent" | "archive";
  empty?: boolean;
}

/** Supplementary graphic; the adjacent label carries the information (UI spec 4.11). */
export function ConfidenceMeter({ value, band, tau, height = 4, tone = "band", empty = false }: ConfidenceMeterProps) {
  const fill = tone === "band" ? BAND_FILL[band] : tone === "accent" ? "bg-accent" : "bg-archive";
  return (
    <span
      aria-hidden="true"
      className={`cb-meter relative block rounded-xs bg-track ${height === 6 ? "h-1.5" : "h-1"}`}
      style={cssVars({ "--cb-value": empty ? 0 : value, "--cb-tau": tau ?? 0 })}
    >
      <i className={`cb-fill block h-full rounded-xs ${fill} motion-safe:transition-[width] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-standard)`} />
      {tau !== null ? <i className="cb-tick absolute -top-[3px] -bottom-[3px] w-[1.5px] -translate-x-1/2 rounded-[1px] bg-tick" /> : null}
    </span>
  );
}
```

`app/src/web/components/review/ConfidenceLabel.tsx`:

```tsx
import { BAND_FILL, BAND_INK, bandFor, scaleBands, toPercent } from "../../lib/confidence.ts";
import { BAND_LABEL, type Verdict } from "../../lib/view-types.ts";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { ConfidenceMeter } from "./ConfidenceMeter.tsx";

export interface ConfidenceLabelProps {
  value: number;
  verdict: Verdict;
  tau: number;
  variant: "cell" | "inline" | "scale";
  modelUnavailable?: boolean | undefined;
}

export function ConfidenceScale({ tau }: { tau: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {scaleBands(tau).map((b) => (
        <div key={b.band} className="rounded-lg border border-line px-2.5 py-[9px] text-small">
          <div className="flex items-center gap-1.5">
            <i aria-hidden="true" className={`size-[9px] rounded-[3px] ${BAND_FILL[b.band]}`} />
            <span className="font-semibold text-ink">{b.label}</span>
          </div>
          <div className="text-ink-2">{b.range}</div>
          <div className="text-ink-3">{b.membership}</div>
        </div>
      ))}
    </div>
  );
}

export function ConfidenceLabel({ value, verdict, tau, variant, modelUnavailable = false }: ConfidenceLabelProps) {
  if (variant === "scale") return <ConfidenceScale tau={tau} />;
  const band = modelUnavailable ? "unsure" : bandFor(value, tau, verdict);
  const pct = modelUnavailable ? "n/a" : `${toPercent(value)}%`;
  const word = BAND_LABEL[band];
  if (variant === "cell") {
    return (
      <span className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5">
        <span aria-hidden="true" className="text-small font-emphasis text-ink">{pct}</span>
        <span aria-hidden="true" className={`text-caption font-emphasis ${BAND_INK[band]}`}>{word}</span>
        <VisuallyHidden>{modelUnavailable ? "Confidence not available, Unsure" : `${toPercent(value)} percent, ${word}`}</VisuallyHidden>
        <span className="col-span-2">
          <ConfidenceMeter value={value} band={band} tau={tau} empty={modelUnavailable} />
        </span>
      </span>
    );
  }
  const hint = modelUnavailable ? "· model unavailable" : band === "likely" || band === "unsure" ? "· left for you" : null;
  return (
    <span className="inline-flex items-baseline gap-1.5 text-small">
      <span className="font-semibold text-ink">{pct}</span>
      <span className={`font-emphasis ${BAND_INK[band]}`}>{word}</span>
      {hint ? <span className="text-ink-3">{hint}</span> : null}
    </span>
  );
}
```

- [ ] **Step 5: Implement `ReasonLine.tsx` and `SplitBar.tsx`**

`app/src/web/components/review/ReasonLine.tsx`:

```tsx
import type { ApiReason } from "../../../shared/api.ts";
import type { ReasonCode } from "../../lib/view-types.ts";
import { Icon, type IconName } from "../ui/icons.tsx";

const REASON_ICON: Partial<Record<ReasonCode, IconName>> = {
  prior_sender_deleted: "history", prior_sender_kept: "history", prior_domain_deleted: "history", prior_domain_kept: "history",
  low_open_rate: "eye-off", old_unread: "eye-off",
  list_unsubscribe: "megaphone", bulk_mail: "megaphone", auto_sent: "megaphone", category: "megaphone",
  guard_starred: "star",
  guard_replied: "person", guard_correspondent: "person", flag_human: "person",
  guard_allowlist: "list", deny_listed: "list",
  guard_too_recent: "clock", flag_expired: "clock",
  guard_attachment: "paperclip",
  guard_record_pattern: "receipt", flag_record: "receipt",
  auth_failed: "alert",
  model_important: "flag",
  model_unavailable: "spark-off",
  low_confidence: "question",
};

export const reasonIcon = (code: ReasonCode): IconName => REASON_ICON[code] ?? "info";

export function ReasonLine({ reason }: { reason: ApiReason }) {
  return (
    <li className="flex items-start gap-[9px] text-body text-ink-2">
      <span aria-hidden="true" className="grid size-[18px] shrink-0 place-items-center rounded-sm bg-surface-sunk text-ink-2">
        <Icon name={reasonIcon(reason.code)} size={12} />
      </span>
      <span>{reason.text}</span>
    </li>
  );
}

export function ReasonList({ reasons, label = "Reasons" }: { reasons: readonly ApiReason[]; label?: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-[7px]">
      {reasons.map((r) => (
        <ReasonLine key={`${r.code}:${r.text}`} reason={r} />
      ))}
    </ul>
  );
}
```

`app/src/web/components/review/SplitBar.tsx`:

```tsx
import { cssVars } from "../ui/css-vars.ts";

export interface SplitSegment {
  key: string;
  className: string;
  value: number;
  legend: string;
}

/** The bar is decorative; the legend states every number (UI spec 4.5, 7.2 exemption). */
export function SplitBar({ segments }: { segments: readonly SplitSegment[] }) {
  const shown = segments.filter((s) => s.value > 0);
  return (
    <>
      <div aria-hidden="true" className="mt-2.5 flex h-1.5 w-[340px] max-w-full gap-0.5 overflow-hidden rounded-xs">
        {shown.map((s) => (
          <i key={s.key} className={`cb-grow block h-full ${s.className}`} style={cssVars({ "--cb-grow": s.value })} />
        ))}
      </div>
      <ul aria-label="Clean up split" className="mt-[7px] flex flex-wrap gap-3.5 text-meta text-ink-2">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-[5px]">
            <i aria-hidden="true" className={`size-[7px] rounded-[2px] ${s.className}`} />
            {s.legend}
          </li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/display.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/components/review app/test/web/components/review/display.test.tsx
git commit -m "feat(web): add verdict tags, confidence meter and label, reasons and split bar"
```

---

### Task 12: Summary card and action tabs

**Files:**
- Create: `app/src/web/components/review/SummaryCard.tsx`, `app/src/web/components/review/ActionTabs.tsx`
- Test: `app/test/web/components/review/summary-tabs.test.tsx`

**Interfaces:**
- Consumes: `SplitBar` (Task 11), `Button`, `Spark`, `SkeletonLine`, `Kbd` (Tasks 7, 8), `Tabs`, `Select` (Tasks 7, 8), `formatCount`, `plural`, `toPercent`, `modKey`, `enterKey`, `ariaMod`, `TAB_KEYS`, `TAB_LABEL`, `SORT_OPTIONS` (Task 3).
- Produces:
  - `SummaryCard(props: SummaryCardProps)` where `SummaryCardProps` is UI spec 4.5 with one change: `cleanupPhase: "idle" | "preparing" | "busy"` replaces `cleanupBusy: boolean` (so "Preparing…" and "Cleaning up…" differ), plus `buttonRef?: Ref<HTMLButtonElement>` (focus target after Cancel, UI spec 6.5).
  - Pure copy: `summaryHeadline(count)`, `summarySubline(o)`, `nothingSureSubline(o)`, `leftForYouSentence(groupsLeft, emailsLeft)`.
  - `ActionTabs(props: ActionTabsProps)`: UI spec 4.6 props plus `confirmKeeps?: { onClick(): void; busy: boolean } | null` (shown only on the Keep tab, UI spec 5.2.6).

- [ ] **Step 1: Write the failing test**

`app/test/web/components/review/summary-tabs.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionTabs } from "../../../../src/web/components/review/ActionTabs.tsx";
import { SummaryCard, type SummaryCardProps } from "../../../../src/web/components/review/SummaryCard.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState, previewOf, summaryOf } from "../../msw/fake-api.ts";

function props(over: Partial<SummaryCardProps> = {}): SummaryCardProps {
  const s = createFakeApiState();
  const preview = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
  const summary = summaryOf(s);
  return {
    state: "ready", preview, pendingTotal: summary.pending.total, awaitingModel: 0, groupsLeft: preview.groupsLeft,
    tau: preview.threshold, catchingUp: false, cleanupPhase: "idle", offline: false, platform: "other",
    onCleanUp: vi.fn(), onRetry: vi.fn(), ...over,
  };
}

describe("SummaryCard", () => {
  it("states exactly what Clean up will do", async () => {
    const p = props();
    const { container } = render(<SummaryCard {...p} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("14 emails are ready to clean up");
    expect(screen.getByText("Clearbox is confident about 4 sender groups. 4 groups are left for you to check.")).toBeTruthy();
    const legend = screen.getByRole("list", { name: "Clean up split" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["11 to trash", "3 to archive", "13 to check or keep"]);
    const button = screen.getByRole("button", { name: "Clean up 14" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    await userEvent.click(button);
    expect(p.onCleanUp).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("appends catching up and awaiting model, and falls back to email counts without A2", () => {
    render(<SummaryCard {...props({ catchingUp: true, awaitingModel: 25, groupsLeft: null })} />);
    expect(screen.getByText(
      "Clearbox is confident about 4 sender groups. 13 emails are left for you to check. Still sorting older mail. 25 emails are waiting for the AI model.",
    )).toBeTruthy();
  });

  it("says nothing else needs you when no group is left", () => {
    render(<SummaryCard {...props({ groupsLeft: 0 })} />);
    expect(screen.getByText("Clearbox is confident about 4 sender groups. Nothing else needs you.")).toBeTruthy();
  });

  it("explains the nothing-sure state with tau from the preview", () => {
    const p = props({ state: "nothing_sure", tau: 0.88 });
    render(<SummaryCard {...p} preview={p.preview ? { ...p.preview, count: 0, byAction: { delete: 0, archive: 0, keep: 0 }, threshold: 0.88 } : null} />);
    expect(screen.getByRole("heading").textContent).toBe("Nothing is sure enough to clean up yet");
    expect(screen.getByText("4 groups are left for you to check. Suggestions at 88% or higher go into Clean up.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows preparing, running and offline button states", () => {
    const { rerender } = render(<SummaryCard {...props({ cleanupPhase: "preparing" })} />);
    expect(screen.getByRole("button", { name: "Preparing…" }).getAttribute("aria-busy")).toBe("true");
    rerender(<SummaryCard {...props({ cleanupPhase: "busy" })} />);
    expect(screen.getByRole("button", { name: "Cleaning up…" }).getAttribute("aria-disabled")).toBe("true");
    rerender(<SummaryCard {...props({ offline: true })} />);
    expect(screen.getByRole("button", { name: "Clean up 14" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("You're offline.")).toBeTruthy();
  });

  it("renders loading and error states", async () => {
    const p = props({ state: "error" });
    const { rerender, container } = render(<SummaryCard {...p} />);
    expect(screen.getByRole("heading").textContent).toBe("Couldn't load the Clean up summary");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<SummaryCard {...props({ state: "loading", preview: null })} />);
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ActionTabs", () => {
  it("names tabs with counts, offers Confirm all keeps on Keep, the pill and sort", async () => {
    const onChange = vi.fn();
    const onSortChange = vi.fn();
    const onRefresh = vi.fn();
    const confirm = vi.fn();
    render(
      <ActionTabs value="keep" counts={{ all: 7, trash: 3, archive: 2, check: 1, keep: 1 }} onChange={onChange}
        sort="confidence_desc" onSortChange={onSortChange} newSuggestions onRefresh={onRefresh}
        confirmKeeps={{ onClick: confirm, busy: false }} />,
    );
    expect(screen.getByRole("tab", { name: "Trash, 3 groups" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Keep, 1 group" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Confirm all keeps" }));
    await userEvent.click(screen.getByRole("button", { name: "New suggestions · Refresh" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort groups" }), "count_desc");
    expect([confirm.mock.calls.length, onRefresh.mock.calls.length]).toEqual([1, 1]);
    expect(onSortChange).toHaveBeenCalledWith("count_desc");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/summary-tabs.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/components/review/ActionTabs.tsx`.

- [ ] **Step 3: Implement `SummaryCard.tsx`**

`app/src/web/components/review/SummaryCard.tsx`:

```tsx
import { useId, type Ref } from "react";
import type { CleanupPreview } from "../../../shared/api.ts";
import { toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { ariaMod, enterKey, modKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { SkeletonLine, SHIMMER } from "../ui/Skeleton.tsx";
import { Spark } from "../ui/Spark.tsx";
import { SplitBar } from "./SplitBar.tsx";

export interface SummaryCardProps {
  state: "loading" | "ready" | "nothing_sure" | "error";
  preview: CleanupPreview | null;
  pendingTotal: number;
  awaitingModel: number;
  groupsLeft: number | null;
  tau: number;
  catchingUp: boolean;
  cleanupPhase: "idle" | "preparing" | "busy";
  offline: boolean;
  platform: Platform;
  onCleanUp: () => void;
  onRetry: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

export const summaryHeadline = (count: number): string =>
  count === 1 ? "1 email is ready to clean up" : `${formatCount(count)} emails are ready to clean up`;

export function leftForYouSentence(groupsLeft: number | null, emailsLeft: number): string {
  if (groupsLeft === null) {
    return emailsLeft === 1 ? "1 email is left for you to check." : `${formatCount(emailsLeft)} emails are left for you to check.`;
  }
  return groupsLeft === 1 ? "1 group is left for you to check." : `${formatCount(groupsLeft)} groups are left for you to check.`;
}

export function summarySubline(o: { groups: number; groupsLeft: number | null; emailsLeft: number; catchingUp: boolean; awaitingModel: number }): string {
  const parts = [`Clearbox is confident about ${plural(o.groups, "sender group", "sender groups")}.`];
  parts.push(o.groupsLeft === 0 ? "Nothing else needs you." : leftForYouSentence(o.groupsLeft, o.emailsLeft));
  if (o.catchingUp) parts.push("Still sorting older mail.");
  if (o.awaitingModel > 0) {
    parts.push(o.awaitingModel === 1 ? "1 email is waiting for the AI model." : `${formatCount(o.awaitingModel)} emails are waiting for the AI model.`);
  }
  return parts.join(" ");
}

export const nothingSureSubline = (groupsLeft: number | null, emailsLeft: number, tau: number): string =>
  `${leftForYouSentence(groupsLeft, emailsLeft)} Suggestions at ${toPercent(tau)}% or higher go into Clean up.`;

export function SummaryCard({ buttonRef, ...p }: SummaryCardProps) {
  const headingId = useId();
  const count = p.preview?.count ?? 0;
  const emailsLeft = Math.max(0, p.pendingTotal - count);
  const loading = p.state === "loading";
  const segments = [
    { key: "trash", className: "bg-trash", value: p.preview?.byAction.delete ?? 0, legend: `${formatCount(p.preview?.byAction.delete ?? 0)} to trash` },
    { key: "archive", className: "bg-archive", value: p.preview?.byAction.archive ?? 0, legend: `${formatCount(p.preview?.byAction.archive ?? 0)} to archive` },
    { key: "left", className: "bg-neutral-fill", value: emailsLeft, legend: `${formatCount(emailsLeft)} to check or keep` },
  ];
  const headline =
    p.state === "error" ? "Couldn't load the Clean up summary"
      : p.state === "nothing_sure" ? "Nothing is sure enough to clean up yet"
        : summaryHeadline(count);
  const sub =
    p.state === "error" ? "Your sender groups below still work."
      : p.state === "nothing_sure" ? nothingSureSubline(p.groupsLeft, emailsLeft, p.tau)
        : summarySubline({ groups: p.preview?.groups ?? 0, groupsLeft: p.groupsLeft, emailsLeft, catchingUp: p.catchingUp, awaitingModel: p.awaitingModel });

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading || undefined}
      className="mb-4 flex items-center gap-4 rounded-xl border border-line bg-surface px-[18px] py-4 shadow-card"
    >
      <Spark size={22} />
      <div className="min-w-0 flex-1">
        {loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <span id={headingId} className="sr-only">Loading the Clean up summary</span>
            <SkeletonLine width={260} height={14} />
            <SkeletonLine width={360} />
            <span className={`mt-1 block h-1.5 w-[340px] max-w-full rounded-xs ${SHIMMER}`} />
          </div>
        ) : (
          <>
            <h2 id={headingId} className="mb-[3px] text-title-lg font-heading text-ink">{headline}</h2>
            <p className="text-body text-ink-2">{sub}</p>
            {p.state === "ready" ? <SplitBar segments={segments} /> : null}
            {p.state === "nothing_sure" ? <SplitBar segments={segments.slice(2)} /> : null}
            {p.offline && p.state === "ready" ? <p className="mt-1.5 text-small text-ink-3">You're offline.</p> : null}
          </>
        )}
      </div>
      {loading ? <span aria-hidden="true" className={`h-9 w-[120px] rounded-lg ${SHIMMER}`} /> : null}
      {p.state === "error" ? <Button onClick={p.onRetry}>Try again</Button> : null}
      {p.state === "ready" ? (
        <Button
          ref={buttonRef}
          variant="primary"
          size="lg"
          kbd={[modKey(p.platform), enterKey(p.platform)]}
          aria-keyshortcuts={`${ariaMod(p.platform)}+Enter`}
          loading={p.cleanupPhase === "preparing"}
          loadingLabel="Preparing…"
          softDisabled={p.cleanupPhase === "busy" || p.offline}
          onClick={p.onCleanUp}
        >
          {p.cleanupPhase === "busy" ? "Cleaning up…" : `Clean up ${formatCount(count)}`}
        </Button>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Implement `ActionTabs.tsx`**

`app/src/web/components/review/ActionTabs.tsx`:

```tsx
import { plural } from "../../lib/format.ts";
import { SORT_OPTIONS, TAB_KEYS, TAB_LABEL, type GroupSort, type TabKey } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Tabs } from "../ui/Tabs.tsx";

export interface ActionTabsProps {
  value: TabKey;
  counts: Record<TabKey, number | null>;
  onChange: (tab: TabKey) => void;
  sort: GroupSort;
  onSortChange: (sort: GroupSort) => void;
  newSuggestions: boolean;
  onRefresh: () => void;
  confirmKeeps?: { onClick: () => void; busy: boolean } | null | undefined;
}

export function ActionTabs(p: ActionTabsProps) {
  const items = TAB_KEYS.map((key) => {
    const count = p.counts[key];
    return {
      key,
      label: TAB_LABEL[key],
      count,
      ariaLabel: count === null ? undefined : `${TAB_LABEL[key]}, ${plural(count, "group", "groups")}`,
    };
  });
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line">
      <Tabs label="Filter by suggestion" value={p.value} items={items} onChange={p.onChange} controls="group-list" idPrefix="tab" />
      <div className="ml-auto flex items-center gap-2 pb-1">
        {p.newSuggestions ? (
          <button
            type="button"
            onClick={p.onRefresh}
            className="rounded-full bg-accent-soft px-2.5 py-0.5 text-meta font-emphasis text-accent hover:text-accent-hover"
          >
            New suggestions · Refresh
          </button>
        ) : null}
        {p.value === "keep" && p.confirmKeeps ? (
          <Button size="sm" loading={p.confirmKeeps.busy} loadingLabel="Preparing…" onClick={p.confirmKeeps.onClick}>
            Confirm all keeps
          </Button>
        ) : null}
        <Select label="Sort groups" variant="ghost" value={p.sort} options={SORT_OPTIONS} onChange={p.onSortChange} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/summary-tabs.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/web/components/review/SummaryCard.tsx app/src/web/components/review/ActionTabs.tsx app/test/web/components/review/summary-tabs.test.tsx
git commit -m "feat(web): add the Clean up summary card and the action tabs"
```

---

### Task 13: Sender group list, rows, selection model and selection toolbar

**Files:**
- Create: `app/src/web/state/use-selection.ts`, `app/src/web/components/review/SenderGroupRow.tsx`, `app/src/web/components/review/SelectionToolbar.tsx`, `app/src/web/components/review/SenderGroupList.tsx`
- Test: `app/test/web/state/use-selection.test.ts`, `app/test/web/components/review/group-list.test.tsx`

**Interfaces:**
- Consumes: Task 11 display components, `Checkbox`, `Button`, `Spinner`, `EmptyState`, `SkeletonRows`, `VisuallyHidden` (Tasks 7, 8), `bandFor`, `toPercent`, `membershipPhrase`, `isModelUnavailable`, `plural`, `formatCount`, `VERDICT_LABEL`, `BAND_LABEL`, `TAB_LABEL` (Task 3).
- Produces:
  - `use-selection.ts`: `interface SelectionState { selected: ReadonlySet<string>; anchor: string | null }`, `EMPTY_SELECTION`, pure `toggleKey(s, key)`, `selectRange(s, key, order)`, `selectAll(keys)`, `removeKeys(s, keys)`, and hook `useSelection(): { selected; anchor; toggle(key); range(key, order); selectAll(keys); clear(); remove(keys); setAnchor(key) }`.
  - `SenderGroupRow(props)`, `rowId(key): string` (`group-row-<key>`), `displayName(g): { text; unknown }`, `rowAriaLabel(g, tau): string`.
  - `SelectionToolbar(props)`.
  - `SenderGroupList(props: SenderGroupListProps)`: UI spec 4.7 props plus `exitingKeys: ReadonlySet<string>`, `bulkProgress: { done: number; total: number } | null`, `platform`, and `onMove(to: RowMove)` with `type RowMove = "next" | "prev" | "first" | "last" | "pagedown" | "pageup"` (row-focused navigation keys are handled by the grid itself; J and K are global review hotkeys, Task 17). `EMPTY_COPY: Record<TabKey, [title, body]>`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/state/use-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, removeKeys, selectAll, selectRange, toggleKey } from "../../../src/web/state/use-selection.ts";

const order = ["a", "b", "c", "d", "e"];

describe("selection model (UI spec 6.3)", () => {
  it("toggles and sets the anchor", () => {
    const s = toggleKey(EMPTY_SELECTION, "b");
    expect([...s.selected]).toEqual(["b"]);
    expect(s.anchor).toBe("b");
    expect([...toggleKey(s, "b").selected]).toEqual([]);
  });

  it("adds the inclusive range from the anchor in either direction", () => {
    const s = selectRange(toggleKey(EMPTY_SELECTION, "d"), "b", order);
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
    expect([...selectRange({ selected: new Set(), anchor: null }, "c", order).selected]).toEqual(["c"]);
  });

  it("selects all and removes executed keys", () => {
    const all = selectAll(order);
    expect(all.selected.size).toBe(5);
    expect([...removeKeys(all, ["a", "e"]).selected]).toEqual(["b", "c", "d"]);
  });
});
```

`app/test/web/components/review/group-list.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SenderGroupList, type SenderGroupListProps } from "../../../../src/web/components/review/SenderGroupList.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { createFakeApiState, deriveGroups, sortGroups } from "../../msw/fake-api.ts";

function props(over: Partial<SenderGroupListProps> = {}): SenderGroupListProps {
  const s = createFakeApiState();
  const groups = sortGroups(deriveGroups(s), "confidence_desc");
  return {
    state: "ready", tab: "all", groups, tau: s.tau,
    accountsById: Object.fromEntries(s.accounts.map((a) => [a.id, a])), showAccount: false,
    activeKey: groups[0]?.key ?? null, selected: new Set(), busyKeys: new Set(), exitingKeys: new Set(),
    totalInTab: groups.length, hasNextPage: false, isFetchingNextPage: false, bulkProgress: null, platform: "other",
    onActivate: vi.fn(), onToggleSelect: vi.fn(), onSelectAllLoaded: vi.fn(), onSelectAllInTab: vi.fn(),
    onClearSelection: vi.fn(), onBulkAction: vi.fn(), onLoadMore: vi.fn(), onRetry: vi.fn(), onMove: vi.fn(),
    ...over,
  };
}

const rows = () => screen.getAllByRole("row").slice(1);

describe("SenderGroupList", () => {
  it("renders an accessible grid with descriptive row names", async () => {
    const { container } = render(<SenderGroupList {...props()} />);
    const grid = screen.getByRole("grid", { name: "Sender groups, All tab" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Northwind Deals, Trash, 97% Very sure, in Clean up, 6 emails",
      "Contoso Orders, Archive, 92% Sure, in Clean up, 3 emails, protected by a guardrail",
      "Daily Digest, Trash, 90% Sure, in Clean up, 4 emails",
      "Mom, Keep, 90% Sure, not in Clean up, 2 emails",
      "Tailspin Travel, Trash, 85% Likely, left for you, 3 emails",
      "Fabrikam Updates, Archive, 79% Likely, left for you, 4 emails",
      "Build Bot, Check, 50% Unsure, left for you, 5 emails",
    ]);
    expect(rows()[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows()[1]?.getAttribute("tabindex")).toBe("-1");
    expect(within(rows()[1] as HTMLElement).getByText("Protected")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("renders email text as text, never as HTML", () => {
    const p = props();
    const evil = { ...p.groups[0]!, senderName: "<img src=x onerror=alert(1)>", latestSubject: "<b>bold</b>" };
    render(<SenderGroupList {...p} groups={[evil]} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("activates on click, toggles with mod and checkbox, ranges with shift", async () => {
    const p = props();
    render(<SenderGroupList {...p} />);
    const user = userEvent.setup();
    await user.click(within(rows()[2] as HTMLElement).getByText("Daily Digest"));
    expect(p.onActivate).toHaveBeenCalledWith(p.groups[2]?.key, { openDetail: true });
    await user.keyboard("{Control>}");
    await user.click(within(rows()[3] as HTMLElement).getByText("Mom"));
    await user.keyboard("{/Control}");
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[3]?.key, { range: false });
    await user.click(screen.getByRole("checkbox", { name: "Select Build Bot" }));
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[6]?.key, { range: false });
    await user.keyboard("{Shift>}");
    await user.click(within(rows()[4] as HTMLElement).getByText("Tailspin Travel"));
    await user.keyboard("{/Shift}");
    expect(p.onToggleSelect).toHaveBeenLastCalledWith(p.groups[4]?.key, { range: true });
  });

  it("moves with row-focused keys and opens detail with Enter", async () => {
    const p = props();
    render(<SenderGroupList {...p} />);
    (rows()[0] as HTMLElement).focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}{End}{PageUp}{Enter}");
    expect((p.onMove as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m)).toEqual(["next", "last", "pageup"]);
    expect(p.onActivate).toHaveBeenLastCalledWith(p.groups[0]?.key, { openDetail: true, keyboard: true });
  });

  it("replaces the header with the selection toolbar and blocks Approve for Check groups", async () => {
    const p = props();
    const keys = [p.groups[0]!.key, p.groups[6]!.key];
    render(<SenderGroupList {...p} selected={new Set(keys)} />);
    const toolbar = screen.getByRole("toolbar", { name: "Selected groups" });
    expect(within(toolbar).getByText("2 groups selected · 11 emails")).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "Approve suggestions" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Check groups need your choice. Use Trash, Archive or Keep.")).toBeTruthy();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Trash" }));
    expect(p.onBulkAction).toHaveBeenCalledWith("delete");
  });

  it("offers selecting the whole tab when every loaded row is selected", async () => {
    const p = props({ tab: "trash", hasNextPage: true, totalInTab: 318 });
    render(<SenderGroupList {...p} selected={new Set(p.groups.map((g) => g.key))} />);
    expect(screen.getByText("All 7 loaded groups are selected.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Select all 318 in Trash" }));
    expect(p.onSelectAllInTab).toHaveBeenCalledOnce();
  });

  it("shows the bulk progress line", () => {
    const p = props();
    render(<SenderGroupList {...p} selected={new Set([p.groups[0]!.key])} bulkProgress={{ done: 2, total: 3 }} />);
    expect(screen.getByText("Working on 2 of 3 groups…")).toBeTruthy();
  });

  it.each([
    ["all", "Nothing to review", "New mail gets sorted every 30 minutes."],
    ["trash", "No trash suggestions", "Nothing here looks safe to trash right now."],
    ["keep", "No keep suggestions", "Emails Clearbox thinks you should keep will show up here."],
  ] as const)("shows the %s empty state", (tab, title, body) => {
    render(<SenderGroupList {...props({ state: "empty", tab, groups: [] })} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
  });

  it("shows loading and error states", async () => {
    const p = props({ state: "error", groups: [] });
    const { rerender } = render(<SenderGroupList {...p} />);
    expect(screen.getByRole("heading", { name: "Couldn't load sender groups" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<SenderGroupList {...props({ state: "loading", groups: [] })} />);
    expect(screen.getByRole("grid").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading sender groups")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/use-selection.test.ts test/web/components/review/group-list.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/state/use-selection.ts`.

- [ ] **Step 3: Implement `use-selection.ts`**

`app/src/web/state/use-selection.ts`:

```ts
import { useCallback, useMemo, useState } from "react";

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export function toggleKey(s: SelectionState, key: string): SelectionState {
  const next = new Set(s.selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { selected: next, anchor: key };
}

export function selectRange(s: SelectionState, key: string, order: readonly string[]): SelectionState {
  const to = order.indexOf(key);
  if (to < 0) return s;
  const from = s.anchor === null ? -1 : order.indexOf(s.anchor);
  const [start, end] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  const next = new Set(s.selected);
  for (const k of order.slice(start, end + 1)) next.add(k);
  return { selected: next, anchor: key };
}

export function selectAll(keys: readonly string[]): SelectionState {
  return { selected: new Set(keys), anchor: keys[keys.length - 1] ?? null };
}

export function removeKeys(s: SelectionState, keys: readonly string[]): SelectionState {
  const next = new Set(s.selected);
  for (const k of keys) next.delete(k);
  return { selected: next, anchor: s.anchor !== null && keys.includes(s.anchor) ? null : s.anchor };
}

export function useSelection() {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);
  const toggle = useCallback((key: string) => setState((s) => toggleKey(s, key)), []);
  const range = useCallback((key: string, order: readonly string[]) => setState((s) => selectRange(s, key, order)), []);
  const all = useCallback((keys: readonly string[]) => setState(selectAll(keys)), []);
  const clear = useCallback(() => setState(EMPTY_SELECTION), []);
  const remove = useCallback((keys: readonly string[]) => setState((s) => removeKeys(s, keys)), []);
  const setAnchor = useCallback((key: string | null) => setState((s) => ({ ...s, anchor: key })), []);
  return useMemo(
    () => ({ selected: state.selected, anchor: state.anchor, toggle, range, selectAll: all, clear, remove, setAnchor }),
    [state, toggle, range, all, clear, remove, setAnchor],
  );
}
```

- [ ] **Step 4: Implement `SenderGroupRow.tsx`**

`app/src/web/components/review/SenderGroupRow.tsx`:

```tsx
import type { KeyboardEvent, MouseEvent } from "react";
import type { SenderGroup } from "../../../shared/api.ts";
import { bandFor, isModelUnavailable, membershipPhrase, toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { BAND_LABEL, VERDICT_LABEL } from "../../lib/view-types.ts";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { ConfidenceLabel } from "./ConfidenceLabel.tsx";
import { SenderAvatar } from "./SenderAvatar.tsx";
import { VerdictTag } from "./VerdictTag.tsx";

export const rowId = (key: string): string => `group-row-${key}`;

export function displayName(g: Pick<SenderGroup, "sender" | "senderName">): { text: string; unknown: boolean } {
  if (!g.sender) return { text: "Unknown sender", unknown: true };
  const name = g.senderName?.trim();
  return { text: name && name !== g.sender ? name : g.sender, unknown: false };
}

export function rowAriaLabel(g: SenderGroup, tau: number): string {
  const unavailable = isModelUnavailable(g);
  const band = unavailable ? "unsure" : bandFor(g.confidence.avg, tau, g.action);
  const confidence = unavailable ? "confidence not available" : `${toPercent(g.confidence.avg)}% ${BAND_LABEL[band]}`;
  const parts = [displayName(g).text, VERDICT_LABEL[g.action], confidence, membershipPhrase(g.action, band), plural(g.count, "email", "emails")];
  if (g.ceilingApplied) parts.push("protected by a guardrail");
  return parts.join(", ");
}

export interface SenderGroupRowProps {
  group: SenderGroup;
  tau: number;
  rowIndex: number;
  active: boolean;
  selected: boolean;
  busy: boolean;
  exiting: boolean;
  focusable: boolean;
  accountEmail: string | null;
  onClick: (e: MouseEvent) => void;
  onCheckboxChange: (next: boolean, e: MouseEvent | KeyboardEvent) => void;
}

const GRID = "grid-cols-[22px_minmax(0,1fr)_auto] sm:grid-cols-[22px_minmax(0,1fr)_92px_108px_44px]";
const EXIT =
  "max-h-0 min-h-0 overflow-hidden border-b-0 py-0 opacity-0 motion-safe:transition-[opacity,max-height,padding] motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-in) motion-safe:[transition-delay:0ms,200ms,200ms]";

export function SenderGroupRow(p: SenderGroupRowProps) {
  const { group: g } = p;
  const name = displayName(g);
  const unavailable = isModelUnavailable(g);
  const second = g.latestSubject ?? g.topReasons[0]?.text ?? "";
  const tint = p.active || p.selected ? "bg-surface-selected" : "bg-surface hover:bg-surface-hover";
  return (
    <div
      role="row"
      id={rowId(g.key)}
      data-group-key={g.key}
      aria-rowindex={p.rowIndex + 2}
      aria-selected={p.selected}
      aria-current={p.active ? "true" : undefined}
      aria-busy={p.busy || undefined}
      aria-label={rowAriaLabel(g, p.tau)}
      tabIndex={p.focusable ? 0 : -1}
      onClick={p.onClick}
      className={`cb-row grid min-h-14 max-h-40 cursor-pointer items-center gap-x-2.5 gap-y-1 border-b border-line-subtle px-3.5 py-2.5 outline-offset-[-2px] transition-colors duration-(--duration-fast) ${GRID} ${tint} ${
        p.busy ? "[&>*]:opacity-60" : ""
      } ${p.exiting ? EXIT : ""}`}
    >
      <div role="gridcell" className="row-span-2 grid place-items-center sm:row-span-1">
        <Checkbox checked={p.selected} tabIndex={-1} label={`Select ${name.text}`} onChange={p.onCheckboxChange} />
      </div>
      <div role="gridcell" className="flex min-w-0 items-center">
        <SenderAvatar name={g.senderName} address={g.sender} domain={g.domain} size={22} />
        <span className="ml-[9px] min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-emphasis ${name.unknown ? "text-ink-3" : "text-ink"}`}>{name.text}</span>
            {g.ceilingApplied ? <VerdictTag kind="protected" size="sm" /> : null}
          </span>
          <span className="block truncate text-small text-ink-3">
            {p.accountEmail ? `${p.accountEmail} · ` : ""}
            {second}
          </span>
        </span>
      </div>
      <div role="gridcell" className="col-start-2 row-start-2 justify-self-start sm:col-auto sm:row-auto">
        <VerdictTag kind={g.action} />
      </div>
      <div role="gridcell" className="col-start-3 row-start-2 w-[108px] sm:col-auto sm:row-auto">
        <ConfidenceLabel value={g.confidence.avg} verdict={g.action} tau={p.tau} variant="cell" modelUnavailable={unavailable} />
      </div>
      <div role="gridcell" className="col-start-3 row-start-1 flex justify-end font-emphasis text-ink-2 sm:col-auto sm:row-auto">
        {p.busy ? <Spinner /> : formatCount(g.count)}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `SelectionToolbar.tsx`**

`app/src/web/components/review/SelectionToolbar.tsx`:

```tsx
import { plural } from "../../lib/format.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";

export type BulkAction = "approve" | "delete" | "archive" | "keep";

export interface SelectionToolbarProps {
  selectedCount: number;
  emailCount: number;
  allChecked: boolean;
  tabLabel: string;
  approveBlocked: boolean;
  approveHintId: string;
  bulkProgress: { done: number; total: number } | null;
  onToggleAll: (next: boolean) => void;
  onBulkAction: (action: BulkAction) => void;
  onClear: () => void;
}

export function SelectionToolbar(p: SelectionToolbarProps) {
  const working = p.bulkProgress !== null;
  return (
    <div role="toolbar" aria-label="Selected groups" className="flex min-h-[18px] flex-wrap items-center gap-1.5">
      <Checkbox checked={p.allChecked ? true : "mixed"} label={`Select all groups in ${p.tabLabel}`} onChange={(next) => p.onToggleAll(next)} />
      <span className="mr-1 ml-2 text-body font-emphasis text-ink">
        {working
          ? `Working on ${p.bulkProgress?.done ?? 0} of ${p.bulkProgress?.total ?? 0} groups…`
          : `${plural(p.selectedCount, "group", "groups")} selected · ${plural(p.emailCount, "email", "emails")}`}
      </span>
      <Button size="sm" softDisabled={p.approveBlocked || working} aria-describedby={p.approveBlocked ? p.approveHintId : undefined} onClick={() => p.onBulkAction("approve")}>
        Approve suggestions
      </Button>
      <Button size="sm" kbd={["T"]} aria-keyshortcuts="T" softDisabled={working} onClick={() => p.onBulkAction("delete")}>Trash</Button>
      <Button size="sm" kbd={["A"]} aria-keyshortcuts="A" softDisabled={working} onClick={() => p.onBulkAction("archive")}>Archive</Button>
      <Button size="sm" kbd={["E"]} aria-keyshortcuts="E" softDisabled={working} onClick={() => p.onBulkAction("keep")}>Keep</Button>
      <Button size="sm" variant="ghost" kbd={["Esc"]} aria-keyshortcuts="Escape" className="ml-auto" softDisabled={working} onClick={p.onClear}>
        Clear
      </Button>
    </div>
  );
}
```

- [ ] **Step 6: Implement `SenderGroupList.tsx`**

`app/src/web/components/review/SenderGroupList.tsx`:

```tsx
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { AccountView, SenderGroup } from "../../../shared/api.ts";
import { formatCount } from "../../lib/format.ts";
import { TAB_LABEL, type Platform, type TabKey } from "../../lib/view-types.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { SkeletonRows } from "../ui/Skeleton.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { SelectionToolbar, type BulkAction } from "./SelectionToolbar.tsx";
import { SenderGroupRow } from "./SenderGroupRow.tsx";

export type RowMove = "next" | "prev" | "first" | "last" | "pagedown" | "pageup";

export const EMPTY_COPY: Record<TabKey, [string, string]> = {
  all: ["Nothing to review", "New mail gets sorted every 30 minutes."],
  trash: ["No trash suggestions", "Nothing here looks safe to trash right now."],
  archive: ["No archive suggestions", "Receipts and finished threads will show up here."],
  check: ["No groups to check", "Clearbox is confident about everything left."],
  keep: ["No keep suggestions", "Emails Clearbox thinks you should keep will show up here."],
};

export interface SenderGroupListProps {
  state: "loading" | "ready" | "empty" | "error";
  tab: TabKey;
  groups: readonly SenderGroup[];
  tau: number;
  accountsById: Readonly<Record<string, AccountView>>;
  showAccount: boolean;
  activeKey: string | null;
  selected: ReadonlySet<string>;
  busyKeys: ReadonlySet<string>;
  exitingKeys: ReadonlySet<string>;
  totalInTab: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  bulkProgress: { done: number; total: number } | null;
  platform: Platform;
  onActivate: (key: string, opts: { openDetail: boolean; keyboard?: boolean }) => void;
  onToggleSelect: (key: string, opts: { range: boolean }) => void;
  onSelectAllLoaded: () => void;
  onSelectAllInTab: () => void;
  onClearSelection: () => void;
  onBulkAction: (action: BulkAction) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onMove: (to: RowMove) => void;
}

const HEADER = "grid grid-cols-[22px_minmax(0,1fr)_auto] gap-2.5 sm:grid-cols-[22px_minmax(0,1fr)_92px_108px_44px]";
const MOVE_KEYS: Record<string, RowMove> = { ArrowDown: "next", ArrowUp: "prev", Home: "first", End: "last", PageDown: "pagedown", PageUp: "pageup" };

export function SenderGroupList(p: SenderGroupListProps) {
  const hintId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(p.onLoadMore);
  useEffect(() => {
    loadMore.current = p.onLoadMore;
  });

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !p.hasNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore.current();
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [p.hasNextPage, p.groups.length]);

  if (p.state === "empty" || p.state === "error") {
    const [title, body] = p.state === "error" ? ["Couldn't load sender groups", "Check your connection, then try again."] : EMPTY_COPY[p.tab];
    return (
      <div id="group-list">
        <EmptyState variant="inline" title={title} body={body} action={p.state === "error" ? { label: "Try again", onClick: p.onRetry } : undefined} />
      </div>
    );
  }

  const loaded = p.groups.map((g) => g.key);
  const selectedGroups = p.groups.filter((g) => p.selected.has(g.key));
  const allSelected = loaded.length > 0 && selectedGroups.length === loaded.length;
  const someSelected = selectedGroups.length > 0;
  const approveBlocked = selectedGroups.some((g) => g.action === "unsure");
  const label = TAB_LABEL[p.tab];
  const total = p.totalInTab ?? loaded.length;
  const capped = total > 1000;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[role='row'][data-group-key]");
    if (!row || e.altKey) return;
    const mod = p.platform === "mac" ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      p.onSelectAllLoaded();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const move = MOVE_KEYS[e.key];
    if (move) {
      e.preventDefault();
      p.onMove(move);
    } else if (e.key === "Enter" && row.dataset.groupKey) {
      e.preventDefault();
      p.onActivate(row.dataset.groupKey, { openDetail: true, keyboard: true });
    }
  };

  return (
    <div
      role="grid"
      id="group-list"
      aria-label={`Sender groups, ${label} tab`}
      aria-multiselectable="true"
      aria-rowcount={p.totalInTab ?? -1}
      aria-busy={p.state === "loading" || p.isFetchingNextPage || undefined}
      onKeyDown={onKeyDown}
      className="[scroll-padding-top:44px] [scroll-padding-bottom:96px]"
    >
      <div role="row" aria-rowindex={1} className="sticky top-0 z-(--z-sticky) border-b border-line bg-surface-raised px-3.5 py-2 text-meta text-ink-3">
        {someSelected ? (
          <div role="gridcell" aria-colspan={5}>
            <SelectionToolbar
              selectedCount={selectedGroups.length}
              emailCount={selectedGroups.reduce((sum, g) => sum + g.count, 0)}
              allChecked={allSelected}
              tabLabel={label}
              approveBlocked={approveBlocked}
              approveHintId={hintId}
              bulkProgress={p.bulkProgress}
              onToggleAll={(next) => (next ? p.onSelectAllLoaded() : p.onClearSelection())}
              onBulkAction={p.onBulkAction}
              onClear={p.onClearSelection}
            />
            {approveBlocked ? (
              <p id={hintId} className="mt-1 text-small text-ink-3">Check groups need your choice. Use Trash, Archive or Keep.</p>
            ) : null}
            {allSelected && p.hasNextPage ? (
              <p className="mt-1 text-small text-ink-2">
                {`All ${formatCount(loaded.length)} loaded groups are selected.`}{" "}
                <Button variant="link" size="sm" onClick={p.onSelectAllInTab}>
                  {capped ? "Select first 1,000" : `Select all ${formatCount(total)} in ${label}`}
                </Button>
              </p>
            ) : null}
          </div>
        ) : (
          <div className={HEADER}>
            <span role="columnheader" className="grid place-items-center">
              <Checkbox checked={false} disabled={p.state === "loading"} label={`Select all groups in ${label}`} onChange={() => p.onSelectAllLoaded()} />
            </span>
            <span role="columnheader">Sender</span>
            <span role="columnheader" className="max-sm:hidden">Verdict</span>
            <span role="columnheader" className="max-sm:hidden">Confidence</span>
            <span role="columnheader" className="text-right">Emails</span>
          </div>
        )}
      </div>
      {p.state === "loading" ? (
        <>
          <VisuallyHidden>Loading sender groups</VisuallyHidden>
          <SkeletonRows count={8} />
        </>
      ) : (
        p.groups.map((g, i) => (
          <SenderGroupRow
            key={g.key}
            group={g}
            tau={p.tau}
            rowIndex={i}
            active={g.key === p.activeKey}
            selected={p.selected.has(g.key)}
            busy={p.busyKeys.has(g.key)}
            exiting={p.exitingKeys.has(g.key)}
            focusable={g.key === p.activeKey || (p.activeKey === null && i === 0)}
            accountEmail={p.showAccount ? (p.accountsById[g.accountId]?.email ?? null) : null}
            onClick={(e) => {
              const mod = p.platform === "mac" ? e.metaKey : e.ctrlKey;
              if (e.shiftKey) p.onToggleSelect(g.key, { range: true });
              else if (mod) p.onToggleSelect(g.key, { range: false });
              else p.onActivate(g.key, { openDetail: true });
            }}
            onCheckboxChange={(_next, e) => p.onToggleSelect(g.key, { range: e.shiftKey })}
          />
        ))
      )}
      {p.isFetchingNextPage ? <SkeletonRows count={3} /> : null}
      <div ref={sentinel} aria-hidden="true" />
    </div>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/use-selection.test.ts test/web/components/review/group-list.test.tsx`
Expected: PASS (3 + 11 tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/web/state/use-selection.ts app/src/web/components/review app/test/web/state/use-selection.test.ts app/test/web/components/review/group-list.test.tsx
git commit -m "feat(web): add the sender group grid, rows, selection model and toolbar"
```

---

### Task 14: Detail panel (verdict card, latest emails, actions)

**Files:**
- Create: `app/src/web/state/use-focus-trap.ts`, `app/src/web/components/review/EmailPreviewList.tsx`, `app/src/web/components/review/DetailActions.tsx`, `app/src/web/components/review/DetailPanel.tsx`
- Modify: `app/src/web/styles.css` (append `cb-slide-in` keyframes)
- Test: `app/test/web/components/review/detail.test.tsx`

**Interfaces:**
- Consumes: Task 11 components, `displayName` (Task 13), `useHotkeys` (Task 10), `Menu`, `Button`, `LinkButton`, `Kbd`, `SkeletonLine` (Tasks 7, 8), `membershipLine`, `bandFor`, `toPercent`, `truncateName`, `shortAge`, `formatWeekdayDateTime`, `plural`, `formatCount`, `providerName` (Task 3).
- Produces:
  - `useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean)`.
  - `safeDeepLink(link: string | null): string | null` (UI spec 8.5 allow-list).
  - `EmailPreviewList(props)`: UI spec 4.15 props plus `senderLabel`, `now`, `busyIds: ReadonlySet<number>`.
  - `DetailActions({ group, name, busyAction, disabled, onAction, onAlwaysKeep, onAlwaysTrash, onCopyAddress })`.
  - `DetailPanel(props: DetailPanelProps)`: UI spec 4.14 props with these concrete types: `items: SuggestionItem[]` and `hasMoreItems`, `loadingMoreItems` instead of the raw `GroupDetail`; `busyAction: ActionKind | null` instead of `busy`; `busyItemIds`; `now`; `platform`; `headingRef?`; `onCopyAddress()`; `onReconnect(account)`. Esc closes the slide-over and sheet through hotkey scope `slideover`.
  - CSS keyframes `cb-slide-in`.

- [ ] **Step 1: Write the failing test**

`app/test/web/components/review/detail.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SenderGroup, SuggestionItem } from "../../../../src/shared/api.ts";
import { DetailPanel, type DetailPanelProps } from "../../../../src/web/components/review/DetailPanel.tsx";
import { safeDeepLink } from "../../../../src/web/components/review/EmailPreviewList.tsx";
import { HotkeysProvider } from "../../../../src/web/state/HotkeysProvider.tsx";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { renderWithCore } from "../../helpers/core.tsx";
import { createFakeApiState, deriveGroups, keyOf, pendingItems, toSuggestionItem } from "../../msw/fake-api.ts";
import { T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

const s = createFakeApiState();
const byName = (name: string): SenderGroup => deriveGroups(s).find((g) => g.senderName === name)!;
const itemsOf = (g: SenderGroup): SuggestionItem[] =>
  pendingItems(s).filter((i) => keyOf(i) === g.key).sort((a, b) => b.confidence - a.confidence).map((i) => toSuggestionItem(s, i));

function props(group: SenderGroup, over: Partial<DetailPanelProps> = {}): DetailPanelProps {
  return {
    mode: "inline", open: true, group, items: itemsOf(group), detailState: "ready", hasMoreItems: false, loadingMoreItems: false,
    tau: s.tau, account: s.accounts.find((a) => a.id === group.accountId) ?? null, busyAction: null, busyItemIds: new Set(),
    now: T0, platform: "other",
    onAction: vi.fn(), onAlwaysKeep: vi.fn(), onAlwaysTrash: vi.fn(), onCopyAddress: vi.fn(), onItemAction: vi.fn(),
    onLoadMoreItems: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(), onReconnect: vi.fn(),
    ...over,
  };
}

describe("DetailPanel", () => {
  it("shows verdict, confidence, membership, reasons and Trash actions", async () => {
    const p = props(byName("Northwind Deals"));
    const { container } = render(<DetailPanel {...p} />);
    const aside = screen.getByRole("complementary", { name: "Northwind Deals" });
    expect(within(aside).getByText("promo@northwind.example · you@example.com")).toBeTruthy();
    expect(within(aside).getByText("Move 6 to Trash")).toBeTruthy();
    expect(within(aside).getByText("All 6 are in Clean up.")).toBeTruthy();
    expect(within(aside).queryByText(/^Range/)).toBeNull();
    expect(within(screen.getByRole("list", { name: "Reasons" })).getAllByRole("listitem")).toHaveLength(3);
    const trash = within(aside).getByRole("button", { name: "Trash 6" });
    expect(trash.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(within(aside).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "Always keep Northwind Deals" })).toBeTruthy();
    await userEvent.click(trash);
    expect(p.onAction).toHaveBeenCalledWith("delete");
    await expectNoA11yViolations(container);
  });

  it("shows the confidence range when it spans at least 5 points", () => {
    render(<DetailPanel {...props(byName("Daily Digest"))} />);
    expect(screen.getByText("Range 88–93% across 4 emails")).toBeTruthy();
  });

  it("uses the Keep and Check variants", () => {
    const { rerender } = render(<DetailPanel {...props(byName("Mom"))} />);
    expect(screen.getByRole("button", { name: "Keep 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Always keep/ })).toBeNull();
    expect(screen.getByText("Keep suggestions are not part of Clean up.")).toBeTruthy();
    rerender(<DetailPanel {...props(byName("Build Bot"))} />);
    expect(screen.getByText("Check 5 yourself")).toBeTruthy();
    expect(screen.getByText("Clearbox needs your call on this group.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trash" })).toBeTruthy();
  });

  it("disables actions while the account needs to reconnect", async () => {
    const g = byName("Northwind Deals");
    const account = { ...s.accounts[0]!, status: "needs_reauth" as const };
    const p = props(g, { account });
    render(<DetailPanel {...p} />);
    expect(screen.getByText("Reconnect you@example.com to act on these emails.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trash 6" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(p.onReconnect).toHaveBeenCalledWith(account);
  });

  it("expands an email as plain text with safe deep links and per-email actions", async () => {
    const g = byName("Northwind Deals");
    const items = itemsOf(g);
    const evil = { ...items[0]!, subject: "<img src=x onerror=alert(1)>" };
    const nosnippet = { ...items[1]!, snippet: null, subject: null };
    const p = props(g, { items: [evil, nosnippet], hasMoreItems: true });
    render(<DetailPanel {...p} />);
    const list = screen.getByRole("list", { name: "Latest emails from Northwind Deals" });
    expect(within(list).getByText("(no subject)")).toBeTruthy();
    await userEvent.click(within(list).getByRole("button", { name: /<img src=x onerror=alert\(1\)>/ }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(`Synthetic preview text for message ${evil.id}.`)).toBeTruthy();
    expect(screen.getByText("Received Thu 15 Oct, 07:00 · 99% Very sure")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open this email in Gmail (new tab)" });
    expect([open.getAttribute("target"), open.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    await userEvent.click(screen.getByRole("button", { name: "Archive this email" }));
    expect(p.onItemAction).toHaveBeenCalledWith(evil.id, "archive");
    expect(screen.getByText("+ 4 more")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(p.onLoadMoreItems).toHaveBeenCalledOnce();
    await userEvent.click(within(list).getByRole("button", { name: /^\(no subject\)/ }));
    expect(screen.getByText("Preview not stored (turned off in Rules).")).toBeTruthy();
  });

  it("allows only Gmail and Outlook https deep links", () => {
    expect(safeDeepLink("https://mail.google.com/mail/u/?authuser=a#all/1")).toBe("https://mail.google.com/mail/u/?authuser=a#all/1");
    expect(safeDeepLink("https://outlook.office.com/mail/id/1")).toBe("https://outlook.office.com/mail/id/1");
    expect(safeDeepLink("javascript:alert(1)")).toBeNull();
    expect(safeDeepLink("https://evil.example/mail.google.com/")).toBeNull();
    expect(safeDeepLink(null)).toBeNull();
  });

  it("renders a non-modal slide-over that Esc closes", async () => {
    installFakeApi();
    const p = props(byName("Contoso Orders"), { mode: "slideover" });
    const { user } = renderWithCore(<HotkeysProvider><DetailPanel {...p} /></HotkeysProvider>);
    const dialog = screen.getByRole("dialog", { name: "Contoso Orders" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    await user.keyboard("{Escape}");
    expect(p.onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/detail.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/components/review/DetailPanel.tsx`.

- [ ] **Step 3: Append keyframes and implement `use-focus-trap.ts`**

Append to `app/src/web/styles.css`:

```css
@keyframes cb-slide-in {
  from { transform: translateX(100%); }
  to { transform: none; }
}
```

`app/src/web/state/use-focus-trap.ts`:

```ts
import { useEffect, type RefObject } from "react";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Keeps Tab inside `ref` while active (modal sheet and drawer). */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [ref, active]);
}
```

- [ ] **Step 4: Implement `EmailPreviewList.tsx`**

`app/src/web/components/review/EmailPreviewList.tsx`:

```tsx
import type { KeyboardEvent } from "react";
import type { SuggestionItem } from "../../../shared/api.ts";
import { bandFor, toPercent } from "../../lib/confidence.ts";
import { formatCount, formatWeekdayDateTime, shortAge } from "../../lib/format.ts";
import { providerName } from "../../lib/account-status.ts";
import { BAND_LABEL, type ActionKind, type ProviderKind } from "../../lib/view-types.ts";
import { Button, LinkButton } from "../ui/Button.tsx";

const OUTLOOK_HOST = /^outlook\.(live|office|office365)\.com$/;

/** UI spec 8.5: only Gmail and Outlook web links, https only. */
export function safeDeepLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "mail.google.com" || OUTLOOK_HOST.test(url.hostname)) return link;
  } catch {
    return null;
  }
  return null;
}

export interface EmailPreviewListProps {
  items: readonly SuggestionItem[];
  total: number;
  provider: ProviderKind;
  senderLabel: string;
  expandedId: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  tau: number;
  now: number;
  busyIds: ReadonlySet<number>;
  onToggleExpand: (id: number) => void;
  onItemAction: (id: number, action: ActionKind) => void;
  onLoadMore: () => void;
}

const ACTIONS: [ActionKind, string][] = [["delete", "Trash"], ["archive", "Archive"], ["keep", "Keep"]];

export function EmailPreviewList(p: EmailPreviewListProps) {
  const provider = providerName(p.provider);
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, item: SuggestionItem) => {
    if (e.key.toLowerCase() !== "o" || p.expandedId !== item.id || e.metaKey || e.ctrlKey || e.altKey) return;
    const link = safeDeepLink(item.deepLink);
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.open(link, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <ul aria-label={`Latest emails from ${p.senderLabel}`}>
        {p.items.map((item) => {
          const expanded = p.expandedId === item.id;
          const regionId = `email-${item.id}`;
          const link = safeDeepLink(item.deepLink);
          const band = bandFor(item.confidence, p.tau, item.action);
          return (
            <li
              key={item.id}
              onKeyDown={(e) => onKeyDown(e, item)}
              className={`border-b border-line-subtle last:border-b-0 ${expanded ? "bg-surface-hover" : ""} ${p.busyIds.has(item.id) ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={regionId}
                onClick={() => p.onToggleExpand(item.id)}
                className="flex w-full items-center justify-between gap-2.5 px-2.5 py-[7px] text-left text-small outline-offset-[-2px] hover:bg-surface-hover"
              >
                <span className={`truncate ${item.subject ? (item.isRead ? "text-ink-2" : "font-emphasis text-ink") : "text-ink-3"}`}>
                  {item.subject || "(no subject)"}
                </span>
                <span className="shrink-0 text-ink-3">{shortAge(item.receivedAt, p.now)}</span>
              </button>
              {expanded ? (
                <div id={regionId} className="flex flex-col gap-1.5 px-2.5 pb-2.5">
                  <p className="line-clamp-3 text-small whitespace-pre-line text-ink-3">
                    {item.snippet ?? "Preview not stored (turned off in Rules)."}
                  </p>
                  <p className="text-meta text-ink-3">
                    {`Received ${formatWeekdayDateTime(item.receivedAt)} · ${toPercent(item.confidence)}% ${BAND_LABEL[band]}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ACTIONS.map(([action, label]) => (
                      <Button key={action} size="sm" aria-label={`${label} this email`} softDisabled={p.busyIds.has(item.id)} onClick={() => p.onItemAction(item.id, action)}>
                        {label}
                      </Button>
                    ))}
                    {link ? (
                      <LinkButton href={link} external variant="ghost" size="sm" aria-label={`Open this email in ${provider} (new tab)`}>
                        {`Open in ${provider}`}
                      </LinkButton>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {p.hasMore ? (
        <div className="flex items-center justify-between border-t border-line-subtle px-2.5 py-[7px] text-small">
          <span className="text-ink-3">{`+ ${formatCount(Math.max(0, p.total - p.items.length))} more`}</span>
          <Button variant="link" size="sm" loading={p.loadingMore} loadingLabel="Loading…" onClick={p.onLoadMore}>
            Show 20 more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Implement `DetailActions.tsx`**

`app/src/web/components/review/DetailActions.tsx`:

```tsx
import type { SenderGroup } from "../../../shared/api.ts";
import { formatCount, truncateName } from "../../lib/format.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { Button, type ButtonVariant } from "../ui/Button.tsx";
import type { IconName } from "../ui/icons.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";

export interface DetailActionsProps {
  group: SenderGroup;
  name: string;
  busyAction: ActionKind | null;
  disabled: boolean;
  onAction: (action: ActionKind) => void;
  onAlwaysKeep: (entry: string) => void;
  onAlwaysTrash: (entry: string) => void;
  onCopyAddress: () => void;
}

interface Spec {
  action: ActionKind;
  label: string;
  variant: ButtonVariant;
  icon?: IconName;
}

const KEY: Record<ActionKind, string> = { delete: "T", archive: "A", keep: "E" };

function specs(g: SenderGroup): Spec[] {
  const n = formatCount(g.count);
  switch (g.action) {
    case "delete":
      return [
        { action: "delete", label: `Trash ${n}`, variant: "danger", icon: "trash" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
    case "archive":
      return [
        { action: "archive", label: `Archive ${n}`, variant: "primary", icon: "archive" },
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
    case "keep":
      return [
        { action: "keep", label: `Keep ${n}`, variant: "primary", icon: "keep" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
      ];
    default:
      return [
        { action: "delete", label: "Trash", variant: "secondary", icon: "trash" },
        { action: "archive", label: "Archive", variant: "secondary" },
        { action: "keep", label: "Keep", variant: "secondary" },
      ];
  }
}

export function DetailActions(p: DetailActionsProps) {
  const known = p.group.sender !== "";
  const short = truncateName(p.name);
  const items: MenuItem[] = [
    ...(known
      ? [
          { id: "deny", label: `Always OK to trash ${short}`, icon: "trash" as const, onSelect: () => p.onAlwaysTrash(p.group.sender) },
          { id: "allow-domain", label: `Always keep everything from @${p.group.domain}`, icon: "shield" as const, onSelect: () => p.onAlwaysKeep(`@${p.group.domain}`) },
        ]
      : []),
    { id: "copy", label: "Copy sender address", icon: "copy" as const, disabled: !known, onSelect: p.onCopyAddress },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {specs(p.group).map((s) => (
        <Button
          key={s.action}
          variant={s.variant}
          icon={s.icon}
          aria-keyshortcuts={KEY[s.action]}
          loading={p.busyAction === s.action}
          softDisabled={p.disabled || (p.busyAction !== null && p.busyAction !== s.action)}
          onClick={() => p.onAction(s.action)}
        >
          {s.label}
        </Button>
      ))}
      {known && p.group.action !== "keep" ? (
        <Button variant="ghost" softDisabled={p.disabled || p.busyAction !== null} onClick={() => p.onAlwaysKeep(p.group.sender)}>
          {`Always keep ${short}`}
        </Button>
      ) : null}
      <Menu
        label="More actions"
        align="end"
        items={items}
        renderTrigger={(t) => <Button {...t} variant="ghost" icon="more" aria-label="More actions" />}
      />
    </div>
  );
}
```

- [ ] **Step 6: Implement `DetailPanel.tsx`**

`app/src/web/components/review/DetailPanel.tsx`:

```tsx
import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import type { AccountView, SenderGroup, SuggestionItem } from "../../../shared/api.ts";
import { isModelUnavailable, membershipLine, toPercent } from "../../lib/confidence.ts";
import { formatCount, plural } from "../../lib/format.ts";
import type { ActionKind, Platform } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { useFocusTrap } from "../../state/use-focus-trap.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { SkeletonLine } from "../ui/Skeleton.tsx";
import { ConfidenceLabel } from "./ConfidenceLabel.tsx";
import { DetailActions } from "./DetailActions.tsx";
import { EmailPreviewList } from "./EmailPreviewList.tsx";
import { ReasonList } from "./ReasonLine.tsx";
import { SenderAvatar } from "./SenderAvatar.tsx";
import { displayName } from "./SenderGroupRow.tsx";
import { VerdictTag } from "./VerdictTag.tsx";

export interface DetailPanelProps {
  mode: "inline" | "slideover" | "sheet";
  open: boolean;
  group: SenderGroup | null;
  items: SuggestionItem[];
  detailState: "loading" | "ready" | "error";
  hasMoreItems: boolean;
  loadingMoreItems: boolean;
  tau: number;
  account: AccountView | null;
  busyAction: ActionKind | null;
  busyItemIds: ReadonlySet<number>;
  now: number;
  platform: Platform;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  onAction: (action: ActionKind) => void;
  onAlwaysKeep: (entry: string) => void;
  onAlwaysTrash: (entry: string) => void;
  onCopyAddress: () => void;
  onItemAction: (itemId: number, action: ActionKind) => void;
  onLoadMoreItems: () => void;
  onClose: () => void;
  onRetry: () => void;
  onReconnect: (account: AccountView) => void;
}

function tagLabel(g: SenderGroup): string {
  const n = formatCount(g.count);
  return { delete: `Move ${n} to Trash`, archive: `Archive ${n}`, keep: `Keep ${n} in inbox`, unsure: `Check ${n} yourself` }[g.action];
}

const HINTS: [string[], string][] = [[["J", "K"], "move"], [["X"], "select"], [["T"], "trash"], [["A"], "archive"], [["E"], "keep"]];

export function DetailPanel({ headingRef, ...p }: DetailPanelProps) {
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const floating = p.mode !== "inline";
  useHotkeys("slideover", [{ combo: "escape", handler: () => p.onClose() }], floating && p.open);
  useFocusTrap(rootRef, p.mode === "sheet" && p.open);
  if (!p.group || !p.open) return null;
  const g = p.group;
  const name = displayName(g);
  const needsReconnect = p.account?.status === "needs_reauth";
  const range = g.confidence.max - g.confidence.min >= 0.05;

  const body: ReactNode = (
    <>
      <div className="flex items-center gap-2.5">
        {p.mode === "sheet" ? <Button variant="ghost" size="sm" icon="arrow-left" onClick={p.onClose}>Back</Button> : null}
        <SenderAvatar name={g.senderName} address={g.sender} domain={g.domain} size={30} />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="truncate text-title-sm font-semibold text-ink outline-none">
            {name.text}
          </h2>
          <p className="truncate text-small text-ink-3">{`${g.sender || "Unknown sender"} · ${p.account?.email ?? ""}`}</p>
        </div>
        {p.mode === "slideover" ? <Button variant="ghost" size="sm" icon="close" aria-label="Close" onClick={p.onClose} /> : null}
      </div>
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <VerdictTag kind={g.action} label={tagLabel(g)} />
          <ConfidenceLabel value={g.confidence.avg} verdict={g.action} tau={p.tau} variant="inline" modelUnavailable={isModelUnavailable(g)} />
        </div>
        {range ? (
          <p className="text-small text-ink-3">{`Range ${toPercent(g.confidence.min)}–${toPercent(g.confidence.max)}% across ${plural(g.count, "email", "emails")}`}</p>
        ) : null}
        <p className="mb-2 text-small text-ink-3">{membershipLine(g.action, g.confidence, p.tau, g.count)}</p>
        <ReasonList reasons={g.topReasons} />
      </div>
      <p className="text-meta font-emphasis text-ink-3">Latest emails</p>
      {p.detailState === "loading" ? (
        <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
          <SkeletonLine width="90%" />
          <SkeletonLine width="75%" />
          <SkeletonLine width="80%" />
        </div>
      ) : p.detailState === "error" ? (
        <p className="text-small text-ink-3">
          Couldn't load these emails.{" "}
          <Button variant="link" size="sm" onClick={p.onRetry}>Try again</Button>
        </p>
      ) : (
        <EmailPreviewList
          items={p.items} total={g.count} provider={g.provider} senderLabel={name.text} expandedId={expandedId}
          hasMore={p.hasMoreItems} loadingMore={p.loadingMoreItems} tau={p.tau} now={p.now} busyIds={p.busyItemIds}
          onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
          onItemAction={p.onItemAction} onLoadMore={p.onLoadMoreItems}
        />
      )}
      {needsReconnect && p.account ? (
        <p className="flex flex-wrap items-center gap-1.5 text-small text-check-ink-strong">
          <Icon name="warning" size={12} />
          {`Reconnect ${p.account.email} to act on these emails.`}
          <Button variant="link" size="sm" onClick={() => p.account && p.onReconnect(p.account)}>Reconnect</Button>
        </p>
      ) : null}
      <DetailActions
        group={g} name={name.text} busyAction={p.busyAction} disabled={needsReconnect}
        onAction={p.onAction} onAlwaysKeep={p.onAlwaysKeep} onAlwaysTrash={p.onAlwaysTrash} onCopyAddress={p.onCopyAddress}
      />
      <div className="hidden flex-wrap gap-2.5 text-meta text-ink-3 lg:flex">
        {HINTS.map(([keys, label]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <Kbd keys={keys} />
            {label}
          </span>
        ))}
      </div>
    </>
  );

  const inner = "flex flex-col gap-3 bg-surface-raised p-4";
  if (p.mode === "inline") {
    return (
      <aside aria-labelledby={headingId} className={`${inner} xl:sticky xl:top-0 xl:max-h-dvh xl:overflow-y-auto`}>
        {body}
      </aside>
    );
  }
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal={p.mode === "sheet"}
      aria-labelledby={headingId}
      className={`${inner} fixed z-(--z-slideover) overflow-y-auto shadow-overlay ${
        p.mode === "slideover"
          ? "inset-y-0 right-0 w-(--layout-slideover) motion-safe:animate-[cb-slide-in_250ms_var(--ease-out)]"
          : "inset-0"
      }`}
    >
      {body}
    </div>
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/components/review/detail.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/web/state/use-focus-trap.ts app/src/web/components/review app/src/web/styles.css app/test/web/components/review/detail.test.tsx
git commit -m "feat(web): add the detail panel with plain-text email previews and actions"
```

---

### Task 15: Clean up state machine, provider, copy and the confirm bar

**Files:**
- Create: `app/src/web/lib/copy.ts`, `app/src/web/state/cleanup-machine.ts`, `app/src/web/state/CleanupProvider.tsx`, `app/src/web/components/review/ConfirmBar.tsx`, `app/src/web/components/review/CleanupBar.tsx`
- Test: `app/test/web/state/cleanup-machine.test.ts`, `app/test/web/lib/copy.test.ts`, `app/test/web/state/cleanup-provider.test.tsx`

**Interfaces:**
- Consumes: `runCleanup`, `processedOf`, `RunTotals`, `RunOutcome`, `PartialReason`, `emptyTotals` (Task 6), `api` (Task 4), `invalidateAfterActions` (Task 5), `useToast`, `useAnnounce`, `useUndoStack` (Task 9), `useHotkeys` (Task 10), `ProgressBar`, `Button`, `Kbd`, `Spark` (Tasks 7, 8), `reportBug` (Task 4), `plural`, `formatCount`, `toPercent`, `localResetTime` (Task 3).
- Produces:
  - `copy.ts`: `type CleanupMode = "cleanup" | "confirm_keeps"`, `interface CopyContext { pendingTotal: number; accountEmail: string | null; inactiveEmail: string | null; providerLabel: string; resetTime: string }`, `confirmTitle(mode, preview, ctx)`, `confirmDetail(mode, preview, ctx)`, `runningTitle(mode, processed, total)`, `STOPPING_TITLE`, `doneToast(mode, run, preview)`, `partialToast(mode, run)`, `partialCopy(reason, run, ctx): { title; detail }`.
  - `cleanup-machine.ts`: `type CleanupPhase`, `interface CleanupState { mode; accountId: string | null; machine: CleanupPhase }`, `type CleanupEvent`, `INITIAL_CLEANUP`, `cleanupReducer(state, event)`, `barVisible(state)`.
  - `CleanupProvider({ children, sleep? })`, `useCleanup(): CleanupApi { state; start(mode, accountId?); confirm(); cancel(); stop(); retry(); dismiss(); barVisible: boolean; progressLabel: string | null; busyPhase: "idle" | "preparing" | "busy" }`.
  - `ConfirmBar(props: ConfirmBarProps)` (UI spec 4.16 plus `stopping?`, `extraAction?` (W12), `confirmRef?`).
  - `CleanupBar({ context, platform, onReconnect? })`: reads `useCleanup()` and renders the right ConfirmBar; announces partial titles.

- [ ] **Step 1: Write the failing tests**

`app/test/web/state/cleanup-machine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CleanupPreview } from "../../../src/shared/api.ts";
import { emptyTotals } from "../../../src/web/api/cleanup.ts";
import { cleanupReducer, INITIAL_CLEANUP, type CleanupEvent, type CleanupState } from "../../../src/web/state/cleanup-machine.ts";

const preview = (count: number): CleanupPreview => ({
  asOf: "2026-10-15T10:00:00.000Z", threshold: 0.86, defaultThreshold: 0.86, count,
  byAction: { delete: count, archive: 0, keep: 0 }, groups: 2, groupsLeft: 1,
});
const run = (events: CleanupEvent[], from: CleanupState = INITIAL_CLEANUP) => events.reduce(cleanupReducer, from);

describe("cleanupReducer (UI spec 5.2.2)", () => {
  it("goes idle, preparing, confirming, running, done, idle", () => {
    let s = run([{ type: "START", mode: "cleanup", accountId: null }]);
    expect(s.machine.phase).toBe("preparing");
    s = run([{ type: "PREVIEW_OK", preview: preview(14) }], s);
    expect(s.machine.phase).toBe("confirming");
    s = run([{ type: "CONFIRM" }], s);
    expect(s.machine).toMatchObject({ phase: "running", stopRequested: false, run: { total: 14 } });
    s = run([{ type: "PROGRESS", run: { ...emptyTotals(14), executed: 10 } }], s);
    expect(s.machine).toMatchObject({ phase: "running", run: { executed: 10 } });
    s = run([{ type: "FINISH", outcome: { phase: "done", run: { ...emptyTotals(14), executed: 14 } } }], s);
    expect(s.machine.phase).toBe("done");
    expect(run([{ type: "SETTLE" }], s).machine.phase).toBe("idle");
  });

  it("returns to idle when the fresh preview is empty, and to error when it fails", () => {
    const preparing = run([{ type: "START", mode: "cleanup", accountId: "acc_1" }]);
    expect(preparing.accountId).toBe("acc_1");
    expect(run([{ type: "PREVIEW_OK", preview: preview(0) }], preparing).machine.phase).toBe("idle");
    const error = run([{ type: "PREVIEW_FAIL", code: "network" }], preparing);
    expect(error.machine).toEqual({ phase: "error", code: "network" });
    expect(run([{ type: "SETTLE" }], error).machine.phase).toBe("idle");
  });

  it("cancels from confirming and records Stop while running", () => {
    const confirming = run([{ type: "START", mode: "confirm_keeps", accountId: null }, { type: "PREVIEW_OK", preview: preview(3) }]);
    expect(confirming.mode).toBe("confirm_keeps");
    expect(run([{ type: "CANCEL" }], confirming).machine.phase).toBe("idle");
    const stopping = run([{ type: "CONFIRM" }, { type: "STOP" }], confirming);
    expect(stopping.machine).toMatchObject({ phase: "running", stopRequested: true });
  });

  it("handles partial: Try again re-prepares, Dismiss returns to idle", () => {
    const partial = run([
      { type: "START", mode: "cleanup", accountId: null }, { type: "PREVIEW_OK", preview: preview(200) }, { type: "CONFIRM" },
      { type: "FINISH", outcome: { phase: "partial", reason: "budget", run: { ...emptyTotals(200), executed: 100 } } },
    ]);
    expect(partial.machine).toMatchObject({ phase: "partial", reason: "budget" });
    expect(run([{ type: "RETRY" }], partial).machine.phase).toBe("preparing");
    expect(run([{ type: "DISMISS" }], partial).machine.phase).toBe("idle");
  });

  it("ignores events that do not apply to the current phase", () => {
    expect(run([{ type: "CONFIRM" }, { type: "STOP" }, { type: "DISMISS" }])).toEqual(INITIAL_CLEANUP);
    const preparing = run([{ type: "START", mode: "cleanup", accountId: null }]);
    expect(run([{ type: "START", mode: "confirm_keeps", accountId: null }], preparing)).toEqual(preparing);
  });
});
```

`app/test/web/lib/copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CleanupPreview } from "../../../src/shared/api.ts";
import { emptyTotals } from "../../../src/web/api/cleanup.ts";
import { confirmDetail, confirmTitle, doneToast, partialCopy, type CopyContext } from "../../../src/web/lib/copy.ts";
import { createFakeApiState, previewOf } from "../msw/fake-api.ts";

const s = createFakeApiState();
const base = previewOf(s, { actions: ["delete", "archive"], threshold: s.tau });
const ctx: CopyContext = { pendingTotal: 27, accountEmail: null, inactiveEmail: null, providerLabel: "Gmail", resetTime: "07:00" };
const withActions = (d: number, a: number, groups: number): CleanupPreview => ({ ...base, count: d + a, byAction: { delete: d, archive: a, keep: 0 }, groups });

describe("confirm copy (UI spec 5.2.4)", () => {
  it("uses exact preview counts and tau from the preview", () => {
    expect(confirmTitle("cleanup", base, ctx)).toBe("Clean up 14 emails in 4 sender groups?");
    expect(confirmDetail("cleanup", base, ctx)).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you.",
    );
  });

  it("covers trash only, archive only, account filter, nothing left, missing A2 and inactive accounts", () => {
    expect(confirmDetail("cleanup", withActions(11, 0, 3), ctx)).toBe("All 11 go to Trash. Nothing is permanently deleted. 4 groups below 86% stay here for you.");
    expect(confirmDetail("cleanup", withActions(0, 3, 1), ctx)).toBe("All 3 go to Archive. 4 groups below 86% stay here for you.");
    expect(confirmTitle("cleanup", base, { ...ctx, accountEmail: "you@example.com" })).toBe("Clean up 14 emails from you@example.com?");
    expect(confirmDetail("cleanup", { ...base, groupsLeft: 0 }, ctx)).toBe("11 go to Trash and 3 to Archive. Nothing is permanently deleted.");
    expect(confirmDetail("cleanup", { ...base, groupsLeft: undefined as unknown as number }, ctx)).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 13 emails below 86% or waiting for your choice stay here.",
    );
    expect(confirmDetail("cleanup", base, { ...ctx, inactiveEmail: "you@example.net" })).toBe(
      "11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you. Emails from you@example.net are skipped until you reconnect it.",
    );
  });

  it("words Confirm all keeps", () => {
    const keeps = { ...base, count: 47, byAction: { delete: 0, archive: 0, keep: 47 }, groups: 12 };
    expect(confirmTitle("confirm_keeps", keeps, ctx)).toBe("Mark 47 emails in 12 sender groups as Keep?");
    expect(confirmDetail("confirm_keeps", keeps, ctx)).toBe("They stay in your inbox, leave Review, and Clearbox learns from your choice.");
  });
});

describe("outcome copy", () => {
  const run = { ...emptyTotals(1284), executed: 1180, total: 1284 };

  it("words the done toast with already-handled items", () => {
    expect(doneToast("cleanup", { ...run, executed: 1280, skipped: 4 }, { ...base, groups: 371 })).toBe(
      "1,280 emails cleaned up from 371 sender groups (4 were already handled)",
    );
    expect(doneToast("confirm_keeps", { ...run, executed: 47 }, { ...base, groups: 12 })).toBe(
      "Kept 47 emails from 12 sender groups. Clearbox will remember.",
    );
  });

  it.each([
    ["budget", "Clean up paused at today's free-tier limit. 1,180 emails were cleaned up.", "The other 104 stay in Review. Actions work again after 07:00."],
    ["rate_limited", "Gmail asked Clearbox to slow down. 1,180 emails were cleaned up.", "The other 104 stay in Review. Try again in a minute."],
    ["account_inactive", "1,180 emails were cleaned up. 104 were skipped.", "you@example.net needs to reconnect before its emails can be moved."],
    ["no_progress", "1,180 emails were cleaned up. 104 are still waiting.", "The mailbox did not accept more changes right now. Try again in a few minutes."],
    ["stopped", "Clean up stopped. 1,180 emails were cleaned up.", "The rest stay in Review."],
    ["network", "Connection lost during Clean up. 1,180 emails were cleaned up.", "The rest stay in Review. Try again when you're back online."],
    ["unexpected", "Clean up stopped because of an unexpected error. 1,180 emails were cleaned up.", "The rest stay in Review. Try again; if it keeps happening, check the Worker logs."],
  ] as const)("words partial %s", (reason, title, detail) => {
    expect(partialCopy(reason, run, { ...ctx, inactiveEmail: "you@example.net" })).toEqual({ title, detail });
  });

  it("words item failures", () => {
    expect(partialCopy("item_failures", { ...run, executed: 1280, failed: 4 }, ctx)).toEqual({
      title: "1,280 emails were cleaned up. 4 could not be moved.",
      detail: "They were moved or deleted outside Clearbox, or the mailbox refused the change. They are marked as failed.",
    });
  });
});
```

`app/test/web/state/cleanup-provider.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CleanupBar } from "../../../src/web/components/review/CleanupBar.tsx";
import { CleanupProvider, useCleanup } from "../../../src/web/state/CleanupProvider.tsx";
import { HotkeysProvider } from "../../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "../helpers/core.tsx";
import { ACC_GMAIL, makeGroupItems } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";
import type { FakeApiState } from "../msw/fake-api.ts";

const ctx = { pendingTotal: 250, accountEmail: null, inactiveEmail: null, providerLabel: "Gmail", resetTime: "07:00" };

function bigGroup(s: FakeApiState) {
  s.items = makeGroupItems({ accountId: ACC_GMAIL, sender: "promo@northwind.example", name: "Northwind Deals",
    action: "delete", confidences: Array(250).fill(0.97), subjects: ["Sale"], reasons: [] }, 2000);
}

let api: ReturnType<typeof useCleanup> | null = null;
function Grab() {
  api = useCleanup();
  return <span data-testid="phase">{api.state.machine.phase}</span>;
}

function setup(mutate: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  const utils = renderWithCore(
    <CleanupProvider sleep={async () => undefined}>
      <HotkeysProvider>
        <Grab />
        <CleanupBar context={ctx} platform="other" />
      </HotkeysProvider>
    </CleanupProvider>,
  );
  return { state, ...utils };
}

const phase = () => screen.getByTestId("phase").textContent;

describe("CleanupProvider", () => {
  it("prepares a fresh preview, confirms with Enter, loops until remaining is 0 and offers Undo", async () => {
    const { state, user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    const confirm = await screen.findByRole("button", { name: "Clean up" });
    expect(screen.getByText("Clean up 250 emails in 1 sender group?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await user.keyboard("{Enter}");
    await screen.findByText("250 emails cleaned up from 1 sender group");
    const bodies = state.requests.filter((r) => r.route === "cleanup").map((r) => r.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ threshold: state.tau, actions: ["delete", "archive"] });
    expect(phase()).toBe("idle");
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("cancels with Esc", async () => {
    const { user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    await user.keyboard("{Escape}");
    expect(phase()).toBe("idle");
    expect(screen.queryByRole("region", { name: "Clean up" })).toBeNull();
  });

  it("stops after the in-flight call and keeps Undo for what ran", async () => {
    const { user } = setup(bigGroup);
    act(() => api?.start("cleanup"));
    await screen.findByRole("button", { name: "Clean up" });
    act(() => {
      api?.confirm();
      api?.stop();
    });
    await screen.findAllByText("Clean up stopped. 100 emails were cleaned up.");
    expect(screen.getByText("100 emails cleaned up")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(phase()).toBe("idle");
  });

  it("pauses at the budget limit", async () => {
    const { user } = setup((s) => {
      bigGroup(s);
      s.failures.cleanup = { status: 429, code: "budget_exhausted", times: 1 };
    });
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText("Clean up paused at today's free-tier limit. 0 emails were cleaned up.");
    expect(screen.getByText("The other 250 stay in Review. Actions work again after 07:00.")).toBeTruthy();
    expect(phase()).toBe("partial");
  });

  it("reports item failures and no progress", async () => {
    const { user } = setup((s) => {
      bigGroup(s);
      s.failIds = new Set([2000, 2001]);
      s.retryLaterIds = new Set([2002]);
    });
    act(() => api?.start("cleanup"));
    await user.click(await screen.findByRole("button", { name: "Clean up" }));
    await screen.findAllByText("247 emails were cleaned up. 1 is still waiting.");
  });

  it("tells the owner when nothing is left after a fresh preview", async () => {
    setup((s) => {
      s.items = [];
    });
    act(() => api?.start("cleanup"));
    await screen.findByText("Nothing left to clean up. New suggestions appear after the next sort.");
    expect(phase()).toBe("idle");
  });

  it("confirms all keeps with the keep preview", async () => {
    const { state, user } = setup(() => undefined);
    act(() => api?.start("confirm_keeps"));
    await screen.findByText("Mark 2 emails in 1 sender group as Keep?");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Kept 2 emails from 1 sender group. Clearbox will remember.");
    expect(state.requests.find((r) => r.route === "preview")?.url.search).toContain("actions=keep");
    expect(state.requests.find((r) => r.route === "preview")?.url.search).toContain("threshold=0.5");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/cleanup-machine.test.ts test/web/lib/copy.test.ts test/web/state/cleanup-provider.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/state/cleanup-machine.ts` (and `copy.ts`, `CleanupBar.tsx`).

- [ ] **Step 3: Implement `copy.ts`**

`app/src/web/lib/copy.ts`:

```ts
import type { CleanupPreview } from "../../shared/api.ts";
import { processedOf, type PartialReason, type RunTotals } from "../api/cleanup.ts";
import { toPercent } from "./confidence.ts";
import { formatCount, plural } from "./format.ts";

export type CleanupMode = "cleanup" | "confirm_keeps";

export interface CopyContext {
  pendingTotal: number;
  accountEmail: string | null;
  inactiveEmail: string | null;
  providerLabel: string;
  resetTime: string;
}

const groupsOf = (n: number) => plural(n, "sender group", "sender groups");

export function confirmTitle(mode: CleanupMode, p: CleanupPreview, ctx: CopyContext): string {
  if (mode === "confirm_keeps") return `Mark ${plural(p.count, "email", "emails")} in ${groupsOf(p.groups)} as Keep?`;
  if (ctx.accountEmail) return `Clean up ${plural(p.count, "email", "emails")} from ${ctx.accountEmail}?`;
  return `Clean up ${plural(p.count, "email", "emails")} in ${groupsOf(p.groups)}?`;
}

export function confirmDetail(mode: CleanupMode, p: CleanupPreview, ctx: CopyContext): string {
  if (mode === "confirm_keeps") return "They stay in your inbox, leave Review, and Clearbox learns from your choice.";
  const d = p.byAction.delete;
  const a = p.byAction.archive;
  const pct = toPercent(p.threshold);
  const parts: string[] = [];
  if (d > 0 && a > 0) parts.push(`${formatCount(d)} go to Trash and ${formatCount(a)} to Archive. Nothing is permanently deleted.`);
  else if (d > 0) parts.push(`${d === 1 ? "It goes" : `All ${formatCount(d)} go`} to Trash. Nothing is permanently deleted.`);
  else parts.push(`${a === 1 ? "It goes" : `All ${formatCount(a)} go`} to Archive.`);
  const left = typeof p.groupsLeft === "number" ? p.groupsLeft : null;
  if (left === null) {
    parts.push(`${plural(Math.max(0, ctx.pendingTotal - p.count), "email", "emails")} below ${pct}% or waiting for your choice stay here.`);
  } else if (left > 0) {
    parts.push(left === 1 ? `1 group below ${pct}% stays here for you.` : `${formatCount(left)} groups below ${pct}% stay here for you.`);
  }
  if (ctx.inactiveEmail) parts.push(`Emails from ${ctx.inactiveEmail} are skipped until you reconnect it.`);
  return parts.join(" ");
}

export const runningTitle = (mode: CleanupMode, processed: number, total: number): string =>
  `${mode === "confirm_keeps" ? "Confirming…" : "Cleaning up…"} ${formatCount(processed)} of ${formatCount(total)}`;

export const STOPPING_TITLE = "Stopping after this step…";

export function doneToast(mode: CleanupMode, run: RunTotals, p: CleanupPreview): string {
  if (mode === "confirm_keeps") return `Kept ${plural(run.executed, "email", "emails")} from ${groupsOf(p.groups)}. Clearbox will remember.`;
  const skipped = run.skipped > 0 ? ` (${formatCount(run.skipped)} were already handled)` : "";
  return `${plural(run.executed, "email", "emails")} cleaned up from ${groupsOf(p.groups)}${skipped}`;
}

/** Partial runs report only the executed count; the group count is not exact (UI spec 5.2.4). */
export function partialToast(mode: CleanupMode, run: RunTotals): string {
  return mode === "confirm_keeps"
    ? `Kept ${plural(run.executed, "email", "emails")}. Clearbox will remember.`
    : `${plural(run.executed, "email", "emails")} cleaned up`;
}

export function partialCopy(reason: PartialReason, run: RunTotals, ctx: CopyContext): { title: string; detail: string } {
  const done = `${plural(run.executed, "email was", "emails were")} cleaned up.`;
  const restN = Math.max(0, run.total - processedOf(run));
  const rest = formatCount(restN);
  const one = restN === 1;
  switch (reason) {
    case "stopped":
      return { title: `Clean up stopped. ${done}`, detail: "The rest stay in Review." };
    case "budget":
      return { title: `Clean up paused at today's free-tier limit. ${done}`, detail: `The other ${rest} ${one ? "stays" : "stay"} in Review. Actions work again after ${ctx.resetTime}.` };
    case "rate_limited":
      return { title: `${ctx.providerLabel} asked Clearbox to slow down. ${done}`, detail: `The other ${rest} ${one ? "stays" : "stay"} in Review. Try again in a minute.` };
    case "account_inactive":
      return { title: `${done} ${rest} ${one ? "was" : "were"} skipped.`, detail: `${ctx.inactiveEmail ?? "An account"} needs to reconnect before its emails can be moved.` };
    case "item_failures":
      return {
        title: `${done} ${formatCount(run.failed)} could not be moved.`,
        detail: "They were moved or deleted outside Clearbox, or the mailbox refused the change. They are marked as failed.",
      };
    case "no_progress":
      return { title: `${done} ${rest} ${one ? "is" : "are"} still waiting.`, detail: "The mailbox did not accept more changes right now. Try again in a few minutes." };
    case "network":
      return { title: `Connection lost during Clean up. ${done}`, detail: "The rest stay in Review. Try again when you're back online." };
    default:
      return {
        title: `Clean up stopped because of an unexpected error. ${done}`,
        detail: "The rest stay in Review. Try again; if it keeps happening, check the Worker logs.",
      };
  }
}
```

- [ ] **Step 4: Implement `cleanup-machine.ts`**

`app/src/web/state/cleanup-machine.ts`:

```ts
import type { CleanupPreview } from "../../shared/api.ts";
import { emptyTotals, type PartialReason, type RunOutcome, type RunTotals } from "../api/cleanup.ts";
import type { CleanupMode } from "../lib/copy.ts";

/** UI spec 5.2.2 without undoing/undone (decision W22). */
export type CleanupPhase =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "confirming"; preview: CleanupPreview }
  | { phase: "running"; preview: CleanupPreview; run: RunTotals; stopRequested: boolean }
  | { phase: "done"; preview: CleanupPreview; run: RunTotals }
  | { phase: "partial"; preview: CleanupPreview; run: RunTotals; reason: PartialReason }
  | { phase: "error"; code: string };

export interface CleanupState {
  mode: CleanupMode;
  accountId: string | null;
  machine: CleanupPhase;
}

export type CleanupEvent =
  | { type: "START"; mode: CleanupMode; accountId: string | null }
  | { type: "PREVIEW_OK"; preview: CleanupPreview }
  | { type: "PREVIEW_FAIL"; code: string }
  | { type: "CANCEL" }
  | { type: "CONFIRM" }
  | { type: "PROGRESS"; run: RunTotals }
  | { type: "STOP" }
  | { type: "FINISH"; outcome: RunOutcome }
  | { type: "RETRY" }
  | { type: "DISMISS" }
  | { type: "SETTLE" };

export const INITIAL_CLEANUP: CleanupState = { mode: "cleanup", accountId: null, machine: { phase: "idle" } };

export function cleanupReducer(state: CleanupState, event: CleanupEvent): CleanupState {
  const m = state.machine;
  const to = (machine: CleanupPhase): CleanupState => ({ ...state, machine });
  switch (event.type) {
    case "START":
      return m.phase === "idle" ? { mode: event.mode, accountId: event.accountId, machine: { phase: "preparing" } } : state;
    case "PREVIEW_OK":
      if (m.phase !== "preparing") return state;
      return to(event.preview.count > 0 ? { phase: "confirming", preview: event.preview } : { phase: "idle" });
    case "PREVIEW_FAIL":
      return m.phase === "preparing" ? to({ phase: "error", code: event.code }) : state;
    case "CANCEL":
      return m.phase === "confirming" ? to({ phase: "idle" }) : state;
    case "CONFIRM":
      return m.phase === "confirming"
        ? to({ phase: "running", preview: m.preview, run: emptyTotals(m.preview.count), stopRequested: false })
        : state;
    case "PROGRESS":
      return m.phase === "running" ? to({ ...m, run: event.run }) : state;
    case "STOP":
      return m.phase === "running" ? to({ ...m, stopRequested: true }) : state;
    case "FINISH":
      if (m.phase !== "running") return state;
      return to(
        event.outcome.phase === "done"
          ? { phase: "done", preview: m.preview, run: event.outcome.run }
          : { phase: "partial", preview: m.preview, run: event.outcome.run, reason: event.outcome.reason },
      );
    case "RETRY":
      return m.phase === "partial" ? to({ phase: "preparing" }) : state;
    case "DISMISS":
      return m.phase === "partial" ? to({ phase: "idle" }) : state;
    case "SETTLE":
      return m.phase === "done" || m.phase === "error" ? to({ phase: "idle" }) : state;
  }
}

export const barVisible = (s: CleanupState): boolean =>
  s.machine.phase === "confirming" || s.machine.phase === "running" || s.machine.phase === "partial";
```

- [ ] **Step 5: Implement `CleanupProvider.tsx`**

`app/src/web/state/CleanupProvider.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { emptyTotals, processedOf, runCleanup } from "../api/cleanup.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { doneToast, partialToast, type CleanupMode } from "../lib/copy.ts";
import { plural } from "../lib/format.ts";
import { reportBug } from "../lib/report.ts";
import { barVisible, cleanupReducer, INITIAL_CLEANUP, type CleanupState } from "./cleanup-machine.ts";
import { useAnnounce } from "./LiveAnnouncer.tsx";
import { useToast } from "./ToastProvider.tsx";
import { useUndoStack } from "./UndoStackProvider.tsx";

export interface CleanupApi {
  state: CleanupState;
  start(mode: CleanupMode, accountId?: string): void;
  confirm(): void;
  cancel(): void;
  stop(): void;
  retry(): void;
  dismiss(): void;
  barVisible: boolean;
  progressLabel: string | null;
  busyPhase: "idle" | "preparing" | "busy";
}

const Ctx = createContext<CleanupApi | null>(null);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function CleanupProvider({ children, sleep = defaultSleep }: { children: ReactNode; sleep?: (ms: number) => Promise<void> }) {
  const [state, dispatch] = useReducer(cleanupReducer, INITIAL_CLEANUP);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const qc = useQueryClient();
  const toast = useToast();
  const announce = useAnnounce();
  const undoStack = useUndoStack();
  const signal = useRef({ stop: false });
  const announced = useRef(0);
  // Lets fetchPreview's "Try again" toast call the latest start() without a declaration cycle.
  const startRef = useRef<(mode: CleanupMode, accountId?: string) => void>(() => undefined);

  const fetchPreview = useCallback(
    async (mode: CleanupMode, accountId: string | null) => {
      const scope = accountId ?? undefined;
      try {
        const preview = await api.cleanupPreview(
          mode === "confirm_keeps" ? { actions: "keep", threshold: 0.5, accountId: scope } : { actions: "delete,archive", accountId: scope },
        );
        dispatch({ type: "PREVIEW_OK", preview });
        if (preview.count === 0) {
          toast.show({ kind: "info", message: "Nothing left to clean up. New suggestions appear after the next sort." });
          void qc.invalidateQueries({ queryKey: ["queue"] });
          void qc.invalidateQueries({ queryKey: ["groups"] });
        }
      } catch {
        dispatch({ type: "PREVIEW_FAIL", code: "network" });
        toast.show({
          kind: "error",
          message: "Couldn't prepare Clean up. Nothing was changed.",
          action: { label: "Try again", onAction: () => startRef.current(mode, scope) },
        });
        dispatch({ type: "SETTLE" });
      }
    },
    [qc, toast],
  );

  const start = useCallback(
    (mode: CleanupMode, accountId?: string) => {
      if (stateRef.current.machine.phase !== "idle") return;
      dispatch({ type: "START", mode, accountId: accountId ?? null });
      stateRef.current = { mode, accountId: accountId ?? null, machine: { phase: "preparing" } };
      void fetchPreview(mode, accountId ?? null);
    },
    [fetchPreview],
  );
  useEffect(() => {
    startRef.current = start;
  });

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (s.machine.phase !== "confirming") return;
    const { preview } = s.machine;
    const mode = s.mode;
    dispatch({ type: "CONFIRM" });
    // Guard against a second confirm (Enter plus click) before the next render.
    stateRef.current = { ...s, machine: { phase: "running", preview, run: emptyTotals(preview.count), stopRequested: false } };
    signal.current = { stop: false };
    announced.current = 0;
    announce(`${mode === "confirm_keeps" ? "Confirming keeps" : "Clean up started"}, ${plural(preview.count, "email", "emails")}`);
    void runCleanup(
      preview,
      { actions: mode === "confirm_keeps" ? ["keep"] : ["delete", "archive"], accountId: s.accountId ?? undefined },
      {
        post: api.cleanup,
        sleep,
        signal: signal.current,
        onProgress: (run) => {
          dispatch({ type: "PROGRESS", run });
          const pct = Math.floor((processedOf(run) / Math.max(1, run.total)) * 100);
          const step = [75, 50, 25].find((t) => pct >= t && announced.current < t);
          if (step && pct < 100) {
            announced.current = step;
            announce(`Cleaning up, ${step} percent done`);
          }
        },
      },
    ).then((outcome) => {
      dispatch({ type: "FINISH", outcome });
      const kind = mode === "confirm_keeps" ? "action" : "cleanup";
      if (outcome.phase === "done") {
        undoStack.notifyWithUndo({ kind, message: doneToast(mode, outcome.run, preview), batchIds: outcome.run.batchIds });
        dispatch({ type: "SETTLE" });
        void invalidateAfterActions(qc);
        return;
      }
      if (outcome.reason === "unexpected") reportBug("Clean up stopped on an unexpected error");
      if (outcome.run.executed > 0) {
        undoStack.notifyWithUndo({ kind, message: partialToast(mode, outcome.run), batchIds: outcome.run.batchIds });
      }
    });
  }, [announce, qc, sleep, undoStack]);

  const cancel = useCallback(() => dispatch({ type: "CANCEL" }), []);
  const stop = useCallback(() => {
    signal.current.stop = true;
    dispatch({ type: "STOP" });
  }, []);
  const dismiss = useCallback(() => {
    dispatch({ type: "DISMISS" });
    void invalidateAfterActions(qc);
  }, [qc]);
  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.machine.phase !== "partial") return;
    dispatch({ type: "RETRY" });
    void fetchPreview(s.mode, s.accountId);
  }, [fetchPreview]);

  const value = useMemo<CleanupApi>(() => {
    const m = state.machine;
    const progressLabel = m.phase === "running" ? `${Math.floor((processedOf(m.run) / Math.max(1, m.run.total)) * 100)}%` : null;
    const busyPhase = m.phase === "preparing" ? "preparing" : m.phase === "running" || m.phase === "confirming" ? "busy" : "idle";
    return { state, start, confirm, cancel, stop, retry, dismiss, barVisible: barVisible(state), progressLabel, busyPhase };
  }, [state, start, confirm, cancel, stop, retry, dismiss]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCleanup(): CleanupApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCleanup needs CleanupProvider");
  return v;
}
```

- [ ] **Step 6: Implement `ConfirmBar.tsx` and `CleanupBar.tsx`**

`app/src/web/components/review/ConfirmBar.tsx`:

```tsx
import { useEffect, useId, useRef } from "react";
import { enterKey } from "../../lib/platform.ts";
import type { Platform } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { Button } from "../ui/Button.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { Spark } from "../ui/Spark.tsx";

export type ConfirmBarMode = "cleanup" | "confirm_keeps";

export interface ConfirmBarProps {
  mode: ConfirmBarMode;
  phase: "confirming" | "running" | "partial";
  title: string;
  detail: string;
  processed?: number | undefined;
  total?: number | undefined;
  stopping?: boolean | undefined;
  platform: Platform;
  extraAction?: { label: string; onClick: () => void } | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  onStop: () => void;
  onRetry: () => void;
}

/** Inline, non-modal confirmation and progress for Clean up (UI spec 4.16). */
export function ConfirmBar(p: ConfirmBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  const confirming = p.phase === "confirming";
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useHotkeys(
    "confirm",
    [
      {
        combo: "enter",
        handler: () => {
          const active = document.activeElement;
          if (active === document.body || (active && rootRef.current?.contains(active))) p.onConfirm();
        },
      },
      { combo: "escape", handler: () => p.onCancel() },
    ],
    confirming,
  );
  const value = p.total ? (p.processed ?? 0) / p.total : 0;
  return (
    <div
      ref={rootRef}
      data-inverse
      role="region"
      aria-label="Clean up"
      className="cb-bar sticky bottom-4 z-(--z-confirm) mt-3.5 flex items-center gap-3.5 rounded-xl bg-inverse py-3 pr-3.5 pl-[18px] text-on-inverse shadow-bar motion-safe:animate-[cb-toast-in_250ms_var(--ease-out)]"
    >
      <Spark size={14} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{p.title}</p>
        {p.phase === "running" ? (
          <div className="mt-2">
            <ProgressBar value={value} tone="on-inverse" label={p.mode === "confirm_keeps" ? "Confirm keeps progress" : "Clean up progress"} valueText={p.title} />
          </div>
        ) : (
          <p id={detailId} className="text-small text-on-inverse-3">{p.detail}</p>
        )}
      </div>
      {confirming ? (
        <>
          <Button variant="on-inverse-ghost" kbd={["Esc"]} aria-keyshortcuts="Escape" onClick={p.onCancel}>Cancel</Button>
          <Button ref={confirmRef} variant="on-inverse" kbd={[enterKey(p.platform)]} aria-keyshortcuts="Enter" aria-describedby={detailId} onClick={p.onConfirm}>
            {p.mode === "confirm_keeps" ? "Confirm" : "Clean up"}
          </Button>
        </>
      ) : null}
      {p.phase === "running" ? (
        <>
          <span className="hidden text-small text-on-inverse-3 sm:inline">You can keep reviewing</span>
          <Button variant="on-inverse-ghost" loading={p.stopping} loadingLabel="Stopping…" onClick={p.onStop}>Stop</Button>
        </>
      ) : null}
      {p.phase === "partial" ? (
        <>
          {p.extraAction ? <Button variant="on-inverse" onClick={p.extraAction.onClick}>{p.extraAction.label}</Button> : null}
          <Button variant="on-inverse" onClick={p.onRetry}>Try again</Button>
          <Button variant="on-inverse-ghost" onClick={p.onCancel}>Dismiss</Button>
        </>
      ) : null}
    </div>
  );
}
```

`app/src/web/components/review/CleanupBar.tsx`:

```tsx
import { useEffect } from "react";
import { processedOf } from "../../api/cleanup.ts";
import { confirmDetail, confirmTitle, partialCopy, runningTitle, STOPPING_TITLE, type CopyContext } from "../../lib/copy.ts";
import type { Platform } from "../../lib/view-types.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { ConfirmBar } from "./ConfirmBar.tsx";

export interface CleanupBarProps {
  context: CopyContext;
  platform: Platform;
  onReconnect?: (() => void) | undefined;
}

export function CleanupBar({ context, platform, onReconnect }: CleanupBarProps) {
  const c = useCleanup();
  const announce = useAnnounce();
  const m = c.state.machine;
  const mode = c.state.mode;
  const partialTitle = m.phase === "partial" ? partialCopy(m.reason, m.run, context).title : null;
  useEffect(() => {
    if (partialTitle) announce(partialTitle);
  }, [partialTitle, announce]);

  const common = { mode, platform, onConfirm: c.confirm, onStop: c.stop, onRetry: c.retry };
  if (m.phase === "confirming") {
    return (
      <ConfirmBar {...common} phase="confirming" title={confirmTitle(mode, m.preview, context)}
        detail={confirmDetail(mode, m.preview, context)} onCancel={c.cancel} />
    );
  }
  if (m.phase === "running") {
    const processed = processedOf(m.run);
    return (
      <ConfirmBar {...common} phase="running" processed={processed} total={m.run.total} stopping={m.stopRequested}
        title={m.stopRequested ? STOPPING_TITLE : runningTitle(mode, processed, m.run.total)} detail="" onCancel={c.cancel} />
    );
  }
  if (m.phase === "partial") {
    const copy = partialCopy(m.reason, m.run, context);
    return (
      <ConfirmBar {...common} phase="partial" title={copy.title} detail={copy.detail} onCancel={c.dismiss}
        extraAction={m.reason === "account_inactive" && onReconnect ? { label: "Reconnect", onClick: onReconnect } : undefined} />
    );
  }
  return null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/state/cleanup-machine.test.ts test/web/lib/copy.test.ts test/web/state/cleanup-provider.test.tsx`
Expected: PASS (5 + 14 + 7 tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/web/lib/copy.ts app/src/web/state app/src/web/components/review/ConfirmBar.tsx app/src/web/components/review/CleanupBar.tsx app/test/web/state app/test/web/lib/copy.test.ts
git commit -m "feat(web): add the Clean up state machine, server-capped run loop and confirm bar"
```

---

### Task 16: App shell, sidebar, app banners, offline and full-page errors

**Files:**
- Create: `app/src/web/lib/links.ts`, `app/src/web/lib/oauth-return.ts`, `app/src/web/lib/banners.ts`, `app/src/web/state/offline.ts`, `app/src/web/state/use-document-title.ts`, `app/src/web/state/use-route-focus.ts`
- Create: under `app/src/web/components/shell/`: `StatusDot.tsx`, `AccountStatusItem.tsx`, `PageHeader.tsx`, `SidebarNav.tsx`, `TopBar.tsx`, `AppBanners.tsx`, `OfflineWatcher.tsx`, `AppShell.tsx`
- Create: `app/src/web/pages/FullPageError.tsx`, `app/src/web/pages/RootLayout.tsx`, `app/test/web/helpers/render.tsx`
- Test: `app/test/web/lib/banners.test.ts`, `app/test/web/components/shell/shell.test.tsx`

**Interfaces:**
- Consumes: Tasks 3 to 15 (queries, stores, providers, primitives, `useCleanup().progressLabel`, `useHotkeysControl().setHelpOpen`, `deriveAccountUiStatus`, `catchUpFraction`, `minutesUntil`, `providerName`, `localResetTime`).
- Produces:
  - `links.ts`: `DOCS_BASE_URL`, `docsUrl(file)`, `SIGN_OUT_URL = "/cdn-cgi/access/logout"`, `browser = { assign(url), reload(), open(url) }` (spy target in tests).
  - `oauth-return.ts`: `OAUTH_RETURN_KEY = "clearbox.oauthReturn"`, `startOAuth(provider, opts: { returnTo: "/setup" | "/accounts"; loginHint?: string })`, `consumeOAuthReturn(): "/setup" | "/accounts"`.
  - `banners.ts`: `type BannerPage`, `interface AppBannerSpec`, `type BannerActionSpec`, `interface BannerInput`, `buildAppBanners(input): AppBannerSpec[]`, `collapseBanners(list): AppBannerSpec[]`, `bannerDismissKey(id)`, `setupErrorBanner(provider)`, `MODEL_BODY`.
  - `offline.ts`: `useStoreValue(store)`, `useOffline(): boolean`, `useSessionError(): SessionError | null`, `navigatorOfflineStore`, `isOfflineNow()`.
  - `useDocumentTitle(title)`, `useRouteFocus(ref, enabled?)`.
  - Shell: `StatusDot({ status })`, `AccountStatusItem({ account, status, catchUpPercent, variant, now, onReconnect })`, `PageHeader({ title, meta?, actions?, titleRef? })`, `SidebarNav({ items, accounts, ownerEmail, variant, loading?, now, onNavigate? })`, `type NavItem`, `TopBar({ items, accounts, ownerEmail, reviewCount, now })`, `AppBanners({ page, extra?, awaitingModel?, modelUnavailableShare? })`, `OfflineWatcher()`, `AppShell({ children })`.
  - Pages: `FullPageError({ kind: SessionError | "boundary" })`, `RouteErrorPage()`, `RootLayout()` (providers, session gate, offline watcher, toast region, help dialog, G hint).
  - Test helper `renderPage(element, { path, route?, shell?, client? })` from `test/web/helpers/render.tsx`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/lib/banners.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAppBanners, collapseBanners, type BannerInput } from "../../../src/web/lib/banners.ts";
import { makeAccount, makeMe, iso, T0 } from "../msw/fixtures.ts";

const input = (over: Partial<BannerInput>): BannerInput => ({
  page: "review", me: makeMe(), accounts: [makeAccount()], offline: false, awaitingModel: 0, modelUnavailableShare: 0,
  resetTime: "07:00", dismissed: new Set(), ...over,
});
const titles = (i: BannerInput) => buildAppBanners(i).map((b) => `${b.tone}: ${b.title}`);

describe("buildAppBanners (UI spec 5.1, 5.9 matrix)", () => {
  it("shows reconnect banners on Review and Accounts only", () => {
    const accounts = [makeAccount({ status: "needs_reauth", email: "you@example.com" })];
    expect(buildAppBanners(input({ accounts }))[0]).toMatchObject({
      tone: "warning", title: "you@example.com needs to reconnect.",
      body: "Google ended the session (password change or 6 months unused). Sorting is paused for this account.",
    });
    expect(titles(input({ accounts, page: "insights" }))).toEqual([]);
  });

  it("orders error, warning, info", () => {
    const me = makeMe({ issues: [
      { code: "budget_exhausted_today", since: iso(T0), accountId: null },
      { code: "microsoft_client_invalid", since: iso(T0), accountId: null },
    ] });
    const list = buildAppBanners(input({ me, awaitingModel: 25 }));
    expect(list.map((b) => b.title)).toEqual([
      "Microsoft sign-in is misconfigured.",
      "Today's free-tier limit is reached.",
      "The AI model is not responding right now.",
    ]);
    expect(list[1]?.body).toBe("New mail is sorted again after 07:00. Clean up and other actions keep working until the action limit is reached.");
    expect(list[2]?.body).toBe(
      '25 emails are waiting and Clearbox retries automatically. Emails it could not score are marked Check with the reason "Model unavailable".',
    );
  });

  it("words model configuration issues per code and drops the not-responding banner then", () => {
    const me = makeMe({ issues: [{ code: "decision_auth_failed", since: iso(T0), accountId: null }] });
    const list = buildAppBanners(input({ me, awaitingModel: 25 }));
    expect(list.map((b) => b.tone)).toEqual(["error"]);
    expect(list[0]?.body).toBe("Azure rejected the API key. Update AZURE_DECISION_KEY and redeploy. New emails are marked Check until this is fixed.");
  });

  it("shows setup errors on Setup and offline everywhere, and hides dismissed banners", () => {
    const me = makeMe({ issues: [{ code: "google_client_invalid", since: iso(T0), accountId: null }, { code: "storage_near_limit", since: iso(T0), accountId: null }] });
    expect(titles(input({ me, page: "setup", offline: true }))).toEqual([
      "error: Google sign-in is misconfigured.",
      "warning: You're offline.",
    ]);
    expect(titles(input({ me, dismissed: new Set(["storage"]) }))).toEqual(["error: Google sign-in is misconfigured."]);
  });

  it("collapses more than 3 banners into a final info line", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, tone: "warning" as const, title: `T${i}.` }));
    expect(collapseBanners(many).map((b) => b.title)).toEqual(["T0.", "T1.", "3 more issues. See Accounts."]);
  });
});
```

`app/test/web/components/shell/shell.test.tsx`:

```tsx
import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkFailureStore, sessionErrorStore } from "../../../../src/web/api/client.ts";
import { browser } from "../../../../src/web/lib/links.ts";
import { expectNoA11yViolations } from "../../helpers/axe.ts";
import { renderPage } from "../../helpers/render.tsx";
import { setViewport } from "../../helpers/viewport.ts";
import { T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

afterEach(() => {
  sessionErrorStore.set(null);
  networkFailureStore.set(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const Page = () => <h1>Test page</h1>;

describe("AppShell", () => {
  it("renders the sidebar with counts, account health, add account and the user menu", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    installFakeApi();
    const { container, user } = renderPage(<Page />, { path: "/review" });
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(await within(primary).findByRole("link", { name: "Review, 7 groups to review" })).toBeTruthy();
    expect(within(primary).getByRole("link", { name: "Add account" }).getAttribute("href")).toBe("/accounts?add=1");
    const accounts = screen.getByRole("navigation", { name: "Accounts" });
    expect(within(accounts).getByRole("link", { name: "you@example.com, up to date" })).toBeTruthy();
    expect(within(accounts).getByRole("link", { name: "you@example.net, catching up, 41% sorted" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    await user.click(screen.getByRole("button", { name: "Account menu for owner@example.test" }));
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await expectNoA11yViolations(container);
  });

  it("offers Reconnect for an account that needs it and remembers where to return", async () => {
    installFakeApi((s) => {
      s.accounts[1] = { ...s.accounts[1]!, status: "needs_reauth" };
    });
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { user } = renderPage(<Page />, { path: "/review" });
    const accounts = await screen.findByRole("navigation", { name: "Accounts" });
    await user.click(await within(accounts).findByRole("button", { name: "Reconnect you@example.net" }));
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/accounts");
    expect(assign).toHaveBeenCalledWith("/oauth/microsoft/start?loginHint=you%40example.net");
  });

  it("replaces the page with the session-expired state on 401", async () => {
    installFakeApi((s) => {
      s.failures.me = { status: 401, code: "unauthenticated", times: 5 };
    });
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => undefined);
    const { user } = renderPage(<Page />, { path: "/review" });
    expect(await screen.findByRole("heading", { name: "Your session expired" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the forbidden and misconfigured pages", async () => {
    installFakeApi();
    renderPage(<Page />, { path: "/review" });
    act(() => sessionErrorStore.set("access_misconfigured"));
    expect(await screen.findByRole("heading", { name: "Sign-in protection is not configured" })).toBeTruthy();
    act(() => sessionErrorStore.set("forbidden"));
    expect(screen.getByRole("heading", { name: "This Clearbox belongs to someone else" })).toBeTruthy();
  });

  it("collapses to a top bar with a modal drawer below 1024px", async () => {
    installFakeApi();
    setViewport(900);
    const { user } = renderPage(<Page />, { path: "/review" });
    const open = await screen.findByRole("button", { name: "Open navigation" });
    await user.click(open);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("toasts when the connection comes back", async () => {
    installFakeApi();
    renderPage(<Page />, { path: "/review" });
    act(() => networkFailureStore.set(2));
    act(() => networkFailureStore.set(0));
    expect(await screen.findByText("Back online.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/banners.test.ts test/web/components/shell/shell.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/lib/banners.ts` and `../../helpers/render.tsx`.

- [ ] **Step 3: Implement `links.ts`, `oauth-return.ts`, `offline.ts`, `use-document-title.ts`, `use-route-focus.ts`**

`app/src/web/lib/links.ts`:

```ts
/** Open item O1: the lead confirms the public repository URL (decision W14). */
export const DOCS_BASE_URL = "https://github.com/ShinyQ/Clearbox/blob/main/docs/";
export const docsUrl = (file: string): string => `${DOCS_BASE_URL}${file}`;
export const SIGN_OUT_URL = "/cdn-cgi/access/logout";

/** Full navigations go through this object so tests can replace them. */
export const browser = {
  assign: (url: string): void => window.location.assign(url),
  reload: (): void => window.location.reload(),
  open: (url: string): void => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
```

`app/src/web/lib/oauth-return.ts`:

```ts
import { browser } from "./links.ts";
import type { ProviderKind } from "./view-types.ts";

export const OAUTH_RETURN_KEY = "clearbox.oauthReturn";
type ReturnPath = "/setup" | "/accounts";

/** UI spec 4.3 and 5.5: remember the page, then leave the SPA for the provider's sign-in. */
export function startOAuth(provider: ProviderKind, opts: { returnTo: ReturnPath; loginHint?: string | undefined }): void {
  window.sessionStorage.setItem(OAUTH_RETURN_KEY, opts.returnTo);
  const base = provider === "gmail" ? "/oauth/google/start" : "/oauth/microsoft/start";
  browser.assign(opts.loginHint ? `${base}?loginHint=${encodeURIComponent(opts.loginHint)}` : base);
}

export function consumeOAuthReturn(): ReturnPath {
  const value = window.sessionStorage.getItem(OAUTH_RETURN_KEY);
  window.sessionStorage.removeItem(OAUTH_RETURN_KEY);
  return value === "/setup" ? "/setup" : "/accounts";
}
```

`app/src/web/state/offline.ts`:

```ts
import { useSyncExternalStore } from "react";
import { createStore, networkFailureStore, sessionErrorStore, type SessionError, type Store } from "../api/client.ts";

export const navigatorOfflineStore = createStore<boolean>(typeof navigator === "undefined" ? false : !navigator.onLine);

export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** UI spec 5.9: navigator offline, or two consecutive network failures. */
export function useOffline(): boolean {
  const nav = useStoreValue(navigatorOfflineStore);
  const failures = useStoreValue(networkFailureStore);
  return nav || failures >= 2;
}

export const isOfflineNow = (): boolean => navigatorOfflineStore.get() || networkFailureStore.get() >= 2;

export const useSessionError = (): SessionError | null => useStoreValue(sessionErrorStore);
```

`app/src/web/state/use-document-title.ts`:

```ts
import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
```

`app/src/web/state/use-route-focus.ts`:

```ts
import { useEffect, useRef, type RefObject } from "react";
import { useLocation } from "react-router";

/** UI spec 6.5: after a route change (not the first load), focus moves to the page h1. */
export function useRouteFocus(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const { key } = useLocation();
  const initial = useRef(key === "default");
  useEffect(() => {
    if (!enabled || initial.current) return;
    ref.current?.focus({ preventScroll: true });
  }, [ref, enabled]);
}
```

- [ ] **Step 4: Implement `banners.ts`**

`app/src/web/lib/banners.ts`:

```ts
import type { AccountView, AppIssueCode, MeResponse } from "../../shared/api.ts";
import type { BannerTone } from "../components/ui/Banner.tsx";
import { docsUrl } from "./links.ts";
import { formatCount } from "./format.ts";

export type BannerPage = "review" | "activity" | "insights" | "rules" | "accounts" | "setup";

export type BannerActionSpec =
  | { label: string; kind: "reconnect"; account: AccountView }
  | { label: string; kind: "link"; href: string }
  | { label: string; kind: "route"; to: string }
  | { label: string; kind: "callback"; onClick: () => void; loading?: boolean };

export interface AppBannerSpec {
  id: string;
  tone: BannerTone;
  title: string;
  body?: string | undefined;
  actions?: BannerActionSpec[] | undefined;
  dismissible?: boolean | undefined;
}

export interface BannerInput {
  page: BannerPage;
  me: MeResponse | undefined;
  accounts: readonly AccountView[];
  offline: boolean;
  awaitingModel: number;
  modelUnavailableShare: number;
  resetTime: string;
  dismissed: ReadonlySet<string>;
}

export const bannerDismissKey = (id: string): string => `clearbox.banner.${id}`;

export const MODEL_BODY: Partial<Record<AppIssueCode, string>> = {
  decision_not_configured: "AZURE_DECISION_ENDPOINT, AZURE_DECISION_KEY or AZURE_DECISION_DEPLOYMENT is missing.",
  decision_auth_failed: "Azure rejected the API key. Update AZURE_DECISION_KEY and redeploy.",
  decision_deployment_not_found: "The deployment name was not found. Check AZURE_DECISION_DEPLOYMENT.",
};

const SETUP_ERROR = {
  gmail: {
    title: "Google sign-in is misconfigured.",
    body: "Google rejected the client ID or secret. Update GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, redeploy, then reconnect.",
    doc: "setup-google.md",
  },
  outlook: {
    title: "Microsoft sign-in is misconfigured.",
    body: "Microsoft rejected the client secret (it may have expired). Create a new secret, update MS_CLIENT_SECRET, redeploy, then reconnect.",
    doc: "setup-microsoft.md",
  },
} as const;

export const setupErrorBanner = (provider: "gmail" | "outlook"): AppBannerSpec => ({
  id: `setup-${provider}`,
  tone: "error",
  title: SETUP_ERROR[provider].title,
  body: SETUP_ERROR[provider].body,
  actions: [{ label: "Open setup guide", kind: "link", href: docsUrl(SETUP_ERROR[provider].doc) }],
});

const ON: Record<string, readonly BannerPage[]> = {
  reconnect: ["review", "accounts"],
  setup: ["review", "accounts", "setup"],
  model: ["review", "insights"],
  modelDown: ["review", "insights"],
  budget: ["review", "insights"],
  storage: ["review", "insights"],
};
const TONE_ORDER: Record<BannerTone, number> = { error: 0, warning: 1, info: 2, success: 3 };

export function buildAppBanners(i: BannerInput): AppBannerSpec[] {
  const out: AppBannerSpec[] = [];
  const issues = new Set((i.me?.issues ?? []).map((x) => x.code));
  const on = (k: string) => ON[k]?.includes(i.page) ?? false;
  if (i.offline) {
    out.push({ id: "offline", tone: "warning", title: "You're offline.", body: "Clearbox will refresh when you're back online. Actions are paused." });
  }
  if (on("reconnect")) {
    for (const a of i.accounts.filter((x) => x.status === "needs_reauth")) {
      out.push({
        id: `reauth-${a.id}`,
        tone: "warning",
        title: `${a.email} needs to reconnect.`,
        body: a.provider === "gmail"
          ? "Google ended the session (password change or 6 months unused). Sorting is paused for this account."
          : "Microsoft ended the session. Sorting is paused for this account.",
        actions: [{ label: "Reconnect", kind: "reconnect", account: a }],
      });
    }
  }
  if (on("setup")) {
    const gmail = issues.has("google_client_invalid") || i.accounts.some((a) => a.status === "config_error" && a.provider === "gmail");
    const outlook = issues.has("microsoft_client_invalid") || i.accounts.some((a) => a.status === "config_error" && a.provider === "outlook");
    if (gmail) out.push(setupErrorBanner("gmail"));
    if (outlook) out.push(setupErrorBanner("outlook"));
  }
  const modelCode = (["decision_not_configured", "decision_auth_failed", "decision_deployment_not_found"] as const).find((c) => issues.has(c));
  if (on("model") && modelCode) {
    out.push({
      id: "model",
      tone: "error",
      title: "Clearbox can't use the AI model.",
      body: `${MODEL_BODY[modelCode] ?? ""} New emails are marked Check until this is fixed.`,
      actions: [{ label: "Open setup guide", kind: "link", href: docsUrl("setup-azure.md") }],
    });
  }
  if (on("modelDown") && !modelCode && (i.awaitingModel > 0 || i.modelUnavailableShare > 0.5)) {
    const waiting = i.awaitingModel > 0
      ? `${formatCount(i.awaitingModel)} ${i.awaitingModel === 1 ? "email is" : "emails are"} waiting and Clearbox retries automatically.`
      : "Clearbox retries automatically.";
    out.push({
      id: "model-down",
      tone: "info",
      title: "The AI model is not responding right now.",
      body: `${waiting} Emails it could not score are marked Check with the reason "Model unavailable".`,
    });
  }
  if (on("budget") && issues.has("budget_exhausted_today")) {
    out.push({
      id: "budget", tone: "warning", dismissible: true, title: "Today's free-tier limit is reached.",
      body: `New mail is sorted again after ${i.resetTime}. Clean up and other actions keep working until the action limit is reached.`,
    });
  }
  if (on("storage") && issues.has("storage_near_limit")) {
    out.push({
      id: "storage", tone: "warning", dismissible: true, title: "Storage is almost full.",
      body: "Clearbox paused reading older mail at 450 MB of 500 MB. Old data is removed nightly, then sorting resumes.",
    });
  }
  return out.filter((b) => !i.dismissed.has(b.id)).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

/** UI spec 3.4: at most 3 banners; extras collapse into a final info line. */
export function collapseBanners(list: readonly AppBannerSpec[]): AppBannerSpec[] {
  if (list.length <= 3) return [...list];
  const extra = list.length - 2;
  return [
    ...list.slice(0, 2),
    { id: "more", tone: "info", title: `${formatCount(extra)} more issues. See Accounts.`, actions: [{ label: "Open Accounts", kind: "route", to: "/accounts" }] },
  ];
}
```

- [ ] **Step 5: Implement `StatusDot.tsx`, `AccountStatusItem.tsx`, `PageHeader.tsx`**

`app/src/web/components/shell/StatusDot.tsx`:

```tsx
import type { AccountUiStatus } from "../../lib/view-types.ts";

const COLOR: Record<AccountUiStatus, string> = {
  up_to_date: "bg-status-ok",
  catching_up: "bg-status-sync",
  waiting: "bg-status-sync",
  paused: "bg-status-off",
  needs_reauth: "bg-status-warn",
  config_error: "bg-status-error",
};

export function StatusDot({ status }: { status: AccountUiStatus }) {
  return <span aria-hidden="true" className={`inline-block size-[7px] shrink-0 rounded-full ${COLOR[status]}`} />;
}
```

`app/src/web/components/shell/AccountStatusItem.tsx`:

```tsx
import { Link } from "react-router";
import type { AccountView } from "../../../shared/api.ts";
import { minutesUntil, providerName } from "../../lib/account-status.ts";
import type { AccountUiStatus } from "../../lib/view-types.ts";
import { StatusDot } from "./StatusDot.tsx";

export interface AccountStatusItemProps {
  account: AccountView;
  status: AccountUiStatus;
  catchUpPercent: number | null;
  variant: "sidebar" | "inline";
  now: number;
  onReconnect: (account: AccountView) => void;
}

export const INLINE_TEXT = (status: AccountUiStatus, account: AccountView): string =>
  ({
    up_to_date: "Up to date",
    catching_up: "Catching up",
    waiting: `Waiting for ${providerName(account.provider)}`,
    paused: "Paused",
    needs_reauth: "Needs reconnect",
    config_error: "Setup error",
  })[status];

export function accountAccessibleName(p: Pick<AccountStatusItemProps, "account" | "status" | "catchUpPercent" | "now">): string {
  const { email, sync } = p.account;
  switch (p.status) {
    case "up_to_date":
      return `${email}, up to date`;
    case "catching_up":
      return p.catchUpPercent === null ? `${email}, catching up` : `${email}, catching up, ${p.catchUpPercent}% sorted`;
    case "waiting":
      return `${email}, waiting for the provider, retrying in ${sync.backoffUntil ? minutesUntil(sync.backoffUntil, p.now) : 1} min`;
    case "paused":
      return `${email}, paused`;
    case "needs_reauth":
      return `${email}, needs reconnect`;
    case "config_error":
      return `${email}, setup error`;
  }
}

export function AccountStatusItem(p: AccountStatusItemProps) {
  if (p.variant === "inline") {
    return (
      <span className="inline-flex items-center gap-2">
        <StatusDot status={p.status} />
        {INLINE_TEXT(p.status, p.account)}
      </span>
    );
  }
  const hash = `/accounts#acc_${p.account.id}`;
  const trailing =
    p.status === "catching_up" ? (p.catchUpPercent === null ? "Sorting" : `${p.catchUpPercent}%`)
      : p.status === "waiting" ? "Waiting"
        : p.status === "paused" ? "Paused"
          : null;
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-[5px] text-body text-ink-2 hover:bg-[rgba(22,23,27,.04)]">
      <Link to={hash} aria-label={accountAccessibleName(p)} className="flex min-w-0 flex-1 items-center gap-2 outline-offset-[-2px]">
        <StatusDot status={p.status} />
        <span className="truncate" title={p.account.email}>{p.account.email}</span>
      </Link>
      {trailing ? <span aria-hidden="true" className="text-small text-ink-3">{trailing}</span> : null}
      {p.status === "needs_reauth" ? (
        <button type="button" aria-label={`Reconnect ${p.account.email}`} onClick={() => p.onReconnect(p.account)} className="text-small text-ink-2 hover:underline">
          Reconnect
        </button>
      ) : null}
      {p.status === "config_error" ? (
        <Link to={hash} className="text-small text-ink-2 hover:underline">Fix setup</Link>
      ) : null}
    </li>
  );
}
```

`app/src/web/components/shell/PageHeader.tsx`:

```tsx
import type { ReactNode, Ref } from "react";

export interface PageHeaderProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}

export function PageHeader({ title, meta, actions, titleRef }: PageHeaderProps) {
  return (
    <div className="mb-3.5 flex min-h-8 flex-wrap items-center gap-2.5">
      <h1 ref={titleRef} tabIndex={-1} className="text-h1 font-heading text-ink focus:outline-none">
        {title}
      </h1>
      {meta ? <span className="text-small text-ink-3">{meta}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
```

- [ ] **Step 6: Implement `SidebarNav.tsx` and `TopBar.tsx`**

`app/src/web/components/shell/SidebarNav.tsx`:

```tsx
import { Link, NavLink } from "react-router";
import type { AccountView } from "../../../shared/api.ts";
import { catchUpFraction, deriveAccountUiStatus } from "../../lib/account-status.ts";
import { formatCount, plural } from "../../lib/format.ts";
import { browser, SIGN_OUT_URL } from "../../lib/links.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import { useHotkeysControl } from "../../state/HotkeysProvider.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { Menu } from "../ui/Menu.tsx";
import { SHIMMER } from "../ui/Skeleton.tsx";
import { AccountStatusItem } from "./AccountStatusItem.tsx";

export interface NavItem {
  to: "/review" | "/activity" | "/insights" | "/rules";
  label: "Review" | "Activity" | "Insights" | "Rules";
  icon: IconName;
  count?: number | null;
  progressLabel?: string | null;
  shortcut: string;
}

export interface SidebarNavProps {
  items: readonly NavItem[];
  accounts: readonly AccountView[];
  ownerEmail: string;
  variant: "rail" | "drawer";
  loading?: boolean;
  now: number;
  onNavigate?: (() => void) | undefined;
}

const ITEM = "flex h-[30px] items-center gap-[9px] rounded-md px-2 py-1.5 text-body outline-offset-[-2px]";

function navLabel(item: NavItem): string | undefined {
  if (item.progressLabel) return `${item.label}, Clean up ${item.progressLabel} done`;
  if (item.count) return `${item.label}, ${plural(item.count, "group", "groups")} to review`;
  return undefined;
}

export function Brand() {
  return (
    <Link to="/review" className="flex items-center gap-[9px] px-2 pt-1 pb-3.5 text-title-sm font-heading text-ink">
      <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-ink text-white">
        <Icon name="review" size={14} strokeWidth={2} />
      </span>
      Clearbox
    </Link>
  );
}

export function SidebarNav({ items, accounts, ownerEmail, loading = false, now, onNavigate }: SidebarNavProps) {
  const { setHelpOpen } = useHotkeysControl();
  const shown = accounts.slice(0, 6);
  return (
    <div className="flex h-full flex-col gap-0.5">
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        <Brand />
        {loading
          ? Array.from({ length: 4 }, (_, i) => <span key={i} aria-hidden="true" className={`mx-2 my-[9px] h-3 rounded-xs ${SHIMMER}`} />)
          : items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.shortcut}
                aria-label={navLabel(item)}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `${ITEM} ${isActive ? "bg-surface font-emphasis text-ink shadow-nav [&_svg]:opacity-100" : "text-ink-2 hover:bg-[rgba(22,23,27,.04)] active:bg-[rgba(22,23,27,.06)] [&_svg]:opacity-70"}`
                }
              >
                <Icon name={item.icon} size={15} />
                {item.label}
                {item.progressLabel || item.count ? (
                  <span className="ml-auto text-meta text-ink-3">{item.progressLabel ?? formatCount(item.count ?? 0)}</span>
                ) : null}
              </NavLink>
            ))}
        <Link to="/accounts?add=1" onClick={onNavigate} className={`${ITEM} mt-1 text-ink-2 hover:bg-[rgba(22,23,27,.04)]`}>
          <Icon name="plus" size={15} className="opacity-70" />
          Add account
        </Link>
      </nav>
      <nav aria-label="Accounts">
        <Link to="/accounts" onClick={onNavigate} className="block px-2 pt-4 pb-1.5 text-meta text-ink-3 hover:text-ink-2 hover:underline">
          Accounts
        </Link>
        <ul className="flex flex-col">
          {shown.map((a) => {
            const fraction = catchUpFraction(a);
            return (
              <AccountStatusItem
                key={a.id}
                account={a}
                status={deriveAccountUiStatus(a, now)}
                catchUpPercent={fraction === null ? null : Math.floor(fraction * 100)}
                variant="sidebar"
                now={now}
                onReconnect={(acc) => startOAuth(acc.provider, { returnTo: "/accounts", loginHint: acc.email })}
              />
            );
          })}
        </ul>
        {accounts.length > 6 ? (
          <Link to="/accounts" className="block px-2 py-1 text-small text-ink-3 hover:underline">{`${accounts.length - 6} more`}</Link>
        ) : null}
      </nav>
      <div className="mt-auto">
        <Menu
          label="Account menu"
          placement="above"
          items={[
            { id: "keys", label: "Keyboard shortcuts", icon: "question", onSelect: () => setHelpOpen(true) },
            { id: "signout", label: "Sign out", icon: "arrow-left", onSelect: () => browser.assign(SIGN_OUT_URL) },
          ]}
          renderTrigger={(t) => (
            <button {...t} type="button" aria-label={`Account menu for ${ownerEmail}`} className="flex w-full items-center gap-2 rounded-md p-2 text-left text-small text-ink-2 hover:bg-[rgba(22,23,27,.04)]">
              <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-full bg-neutral-fill text-micro font-heavy text-ink">
                {(ownerEmail[0] ?? "?").toUpperCase()}
              </span>
              <span className="truncate" title={ownerEmail}>{ownerEmail}</span>
            </button>
          )}
        />
      </div>
    </div>
  );
}
```

`app/src/web/components/shell/TopBar.tsx`:

```tsx
import { useRef, useState } from "react";
import type { AccountView } from "../../../shared/api.ts";
import { formatCount } from "../../lib/format.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";
import { useFocusTrap } from "../../state/use-focus-trap.ts";
import { Button } from "../ui/Button.tsx";
import { Brand, SidebarNav, type NavItem } from "./SidebarNav.tsx";

export interface TopBarProps {
  items: readonly NavItem[];
  accounts: readonly AccountView[];
  ownerEmail: string;
  reviewCount: number | null;
  now: number;
}

/** Below 1024px the sidebar becomes a 48px top bar plus a modal drawer (UI spec 2.8). */
export function TopBar({ items, accounts, ownerEmail, reviewCount, now }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    menuRef.current?.focus();
  };
  useHotkeys("dialog", [{ combo: "escape", handler: close }], open);
  useFocusTrap(drawerRef, open);
  return (
    <>
      <header className="sticky top-0 z-(--z-sticky) flex h-12 items-center gap-2 border-b border-line bg-surface-sunk px-2.5">
        <Button ref={menuRef} variant="ghost" size="sm" icon="menu" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)} />
        <Brand />
        {reviewCount ? <span className="ml-auto text-meta text-ink-3">{`${formatCount(reviewCount)} to review`}</span> : null}
      </header>
      {open ? (
        <div className="fixed inset-0 z-(--z-drawer)">
          <div aria-hidden="true" className="absolute inset-0 bg-[rgba(16,17,22,.32)]" onClick={close} />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 w-(--layout-sidebar) overflow-y-auto bg-surface-sunk px-2.5 pt-3.5 pb-2.5 shadow-overlay motion-safe:animate-[cb-fade-in_250ms_var(--ease-out)]"
          >
            <Button variant="ghost" size="sm" icon="close" aria-label="Close navigation" className="mb-1" onClick={close} />
            <SidebarNav items={items} accounts={accounts} ownerEmail={ownerEmail} variant="drawer" now={now} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 7: Implement `AppBanners.tsx`, `OfflineWatcher.tsx`, `AppShell.tsx`**

`app/src/web/components/shell/AppBanners.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAccounts, useMe } from "../../api/queries.ts";
import { bannerDismissKey, buildAppBanners, collapseBanners, type AppBannerSpec, type BannerPage } from "../../lib/banners.ts";
import { localResetTime } from "../../lib/format.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import { useNow } from "../../state/use-now.ts";
import { useOffline } from "../../state/offline.ts";
import { Banner, type BannerAction } from "../ui/Banner.tsx";

export interface AppBannersProps {
  page: BannerPage;
  extra?: readonly AppBannerSpec[] | undefined;
  awaitingModel?: number | undefined;
  modelUnavailableShare?: number | undefined;
}

function readDismissed(): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith("clearbox.banner.")) out.add(key.slice("clearbox.banner.".length));
  }
  return out;
}

export function AppBanners({ page, extra = [], awaitingModel = 0, modelUnavailableShare = 0 }: AppBannersProps) {
  const me = useMe();
  const accounts = useAccounts();
  const offline = useOffline();
  const now = useNow();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(null);
  const ready = me.isSuccess && accounts.isSuccess;
  const list = collapseBanners([
    ...extra,
    ...buildAppBanners({
      page, me: me.data, accounts: accounts.data?.accounts ?? [], offline, awaitingModel, modelUnavailableShare,
      resetTime: localResetTime(now), dismissed,
    }),
  ]);
  // Banners present when data first arrives are plain regions; later ones are announced (UI spec 4.19).
  if (ready && initialIds === null) setInitialIds(new Set(list.map((b) => b.id)));
  if (list.length === 0) return null;

  const toAction = (a: NonNullable<AppBannerSpec["actions"]>[number]): BannerAction => {
    switch (a.kind) {
      case "reconnect":
        return { label: a.label, onClick: () => startOAuth(a.account.provider, { returnTo: "/accounts", loginHint: a.account.email }) };
      case "link":
        return { label: a.label, href: a.href, external: true };
      case "route":
        return { label: a.label, onClick: () => void navigate(a.to) };
      case "callback":
        return { label: a.label, onClick: a.onClick, loading: a.loading };
    }
  };
  const dismiss = (id: string) => {
    window.sessionStorage.setItem(bannerDismissKey(id), "1");
    setDismissed((d) => new Set([...d, id]));
  };
  return (
    <div className="mb-3.5 flex flex-col gap-2">
      {list.map((b) => (
        <Banner
          key={b.id}
          tone={b.tone}
          title={b.title}
          body={b.body}
          actions={b.actions?.map(toAction)}
          dismissible={b.dismissible}
          onDismiss={() => dismiss(b.id)}
          announce={initialIds !== null && !initialIds.has(b.id)}
        />
      ))}
    </div>
  );
}
```

`app/src/web/components/shell/OfflineWatcher.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { navigatorOfflineStore, useOffline } from "../../state/offline.ts";
import { useToast } from "../../state/ToastProvider.tsx";

/** Tracks navigator online state and announces recovery (UI spec 5.9). */
export function OfflineWatcher() {
  const offline = useOffline();
  const was = useRef(offline);
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    const on = () => navigatorOfflineStore.set(false);
    const off = () => navigatorOfflineStore.set(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (was.current && !offline) {
      toast.show({ kind: "info", message: "Back online.", dedupeKey: "online" });
      void qc.invalidateQueries();
    }
    was.current = offline;
  }, [offline, qc, toast]);
  return null;
}
```

`app/src/web/components/shell/AppShell.tsx`:

```tsx
import type { ReactNode } from "react";
import { useAccounts, useMe, useQueueSummary } from "../../api/queries.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { useNow } from "../../state/use-now.ts";
import { buttonClass } from "../ui/Button.tsx";
import { SidebarNav, type NavItem } from "./SidebarNav.tsx";
import { TopBar } from "./TopBar.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const accounts = useAccounts();
  const summary = useQueueSummary();
  const cleanup = useCleanup();
  const wide = useMediaQuery(BP.lg);
  const now = useNow();
  const count = summary.data?.groups ?? null;
  const items: NavItem[] = [
    { to: "/review", label: "Review", icon: "review", count, progressLabel: cleanup.progressLabel, shortcut: "G R" },
    { to: "/activity", label: "Activity", icon: "activity", shortcut: "G A" },
    { to: "/insights", label: "Insights", icon: "insights", shortcut: "G I" },
    { to: "/rules", label: "Rules", icon: "rules", shortcut: "G U" },
  ];
  const list = accounts.data?.accounts ?? [];
  const owner = me.data?.email ?? "";
  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[208px_minmax(0,1fr)]">
      <a href="#main" className={`sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-(--z-skiplink) ${buttonClass("secondary", "md")}`}>
        Skip to content
      </a>
      {wide ? (
        <aside className="sticky top-0 h-dvh overflow-y-auto border-r border-line bg-surface-sunk px-2.5 pt-3.5 pb-2.5">
          <SidebarNav items={items} accounts={list} ownerEmail={owner} variant="rail" loading={me.isPending || accounts.isPending} now={now} />
        </aside>
      ) : (
        <TopBar items={items} accounts={list} ownerEmail={owner} reviewCount={count} now={now} />
      )}
      <main id="main" tabIndex={-1} className="min-w-0 px-[22px] pt-[18px] pb-[22px] focus:outline-none">
        {children}
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Implement `FullPageError.tsx`, `RootLayout.tsx` and the page render helper**

`app/src/web/pages/FullPageError.tsx`:

```tsx
import { useEffect } from "react";
import { useRouteError } from "react-router";
import type { SessionError } from "../api/client.ts";
import { Brand } from "../components/shell/SidebarNav.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { Icon } from "../components/ui/icons.tsx";
import { browser, SIGN_OUT_URL } from "../lib/links.ts";
import { reportBug } from "../lib/report.ts";

export type FullPageErrorKind = SessionError | "boundary";

const COPY: Record<FullPageErrorKind, { title: string; body: string; action?: { label: string; primary: boolean; run: () => void } }> = {
  unauthenticated: { title: "Your session expired", body: "Sign in again to keep using Clearbox.", action: { label: "Sign in again", primary: true, run: () => browser.reload() } },
  forbidden: { title: "This Clearbox belongs to someone else", body: "Sign in with the owner's email address.", action: { label: "Sign out", primary: false, run: () => browser.assign(SIGN_OUT_URL) } },
  access_misconfigured: {
    title: "Sign-in protection is not configured",
    body: "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and OWNER_EMAIL as Worker secrets, then redeploy. See docs/setup-cloudflare.md.",
  },
  boundary: {
    title: "Something went wrong on this page",
    body: "Reload to try again. Your data is safe: Clearbox only acts when you confirm.",
    action: { label: "Reload", primary: true, run: () => browser.reload() },
  },
};

/** Rendered without providers so it also works as the router error element (no Link or query hooks below the brand). */
export function FullPageError({ kind, withBrandLink = false }: { kind: FullPageErrorKind; withBrandLink?: boolean }) {
  const c = COPY[kind];
  return (
    <main id="main" className="mx-auto max-w-[560px] px-4 pt-12">
      {withBrandLink ? (
        <Brand />
      ) : (
        <p className="flex items-center gap-[9px] px-2 pb-3.5 text-title-sm font-heading text-ink">
          <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-ink text-white">
            <Icon name="review" size={14} strokeWidth={2} />
          </span>
          Clearbox
        </p>
      )}
      <EmptyState
        variant="page"
        title={c.title}
        body={c.body}
        action={c.action ? { label: c.action.label, onClick: c.action.run, variant: c.action.primary ? "primary" : "secondary" } : undefined}
      />
    </main>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  useEffect(() => reportBug("Uncaught render error", error), [error]);
  return <FullPageError kind="boundary" />;
}
```

`app/src/web/pages/RootLayout.tsx`:

```tsx
import { Outlet } from "react-router";
import { GSequenceHint } from "../components/shell/GSequenceHint.tsx";
import { OfflineWatcher } from "../components/shell/OfflineWatcher.tsx";
import { ShortcutHelpDialog } from "../components/shell/ShortcutHelpDialog.tsx";
import { ToastRegion } from "../components/ui/Toast.tsx";
import { CleanupProvider, useCleanup } from "../state/CleanupProvider.tsx";
import { HotkeysProvider } from "../state/HotkeysProvider.tsx";
import { LiveAnnouncerProvider } from "../state/LiveAnnouncer.tsx";
import { useSessionError } from "../state/offline.ts";
import { ToastProvider } from "../state/ToastProvider.tsx";
import { UndoStackProvider } from "../state/UndoStackProvider.tsx";
import { FullPageError } from "./FullPageError.tsx";

function SessionGate() {
  const error = useSessionError();
  return error ? <FullPageError kind={error} /> : <Outlet />;
}

function RaisedToasts() {
  return <ToastRegion raised={useCleanup().barVisible} />;
}

/** Cross-page providers mounted once (decision W10), so a Clean up run survives navigation. */
export function RootLayout() {
  return (
    <LiveAnnouncerProvider>
      <ToastProvider>
        <UndoStackProvider>
          <CleanupProvider>
            <HotkeysProvider>
              <SessionGate />
              <OfflineWatcher />
              <RaisedToasts />
              <ShortcutHelpDialog />
              <GSequenceHint />
            </HotkeysProvider>
          </CleanupProvider>
        </UndoStackProvider>
      </ToastProvider>
    </LiveAnnouncerProvider>
  );
}
```

`app/test/web/helpers/render.tsx`:

```tsx
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { AppShell } from "../../../src/web/components/shell/AppShell.tsx";
import { RootLayout } from "../../../src/web/pages/RootLayout.tsx";
import { createTestQueryClient } from "./query.tsx";

export interface RenderPageOptions {
  path: string;
  route?: string;
  shell?: boolean;
  client?: QueryClient;
}

/** Renders one page inside RootLayout (and AppShell unless shell is false) on a memory router. */
export function renderPage(element: ReactNode, opts: RenderPageOptions) {
  const client = opts.client ?? createTestQueryClient();
  const route = opts.route ?? opts.path.split(/[?#]/)[0] ?? "/";
  const pageRoutes = [
    { path: route, element },
    { path: "*", element: <h1>Elsewhere</h1> },
  ];
  const router = createMemoryRouter(
    [
      {
        element: <RootLayout />,
        children: opts.shell === false ? pageRoutes : [{ element: <AppShell><Outlet /></AppShell>, children: pageRoutes }],
      },
    ],
    { initialEntries: [opts.path] },
  );
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, client, user: userEvent.setup() };
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/banners.test.ts test/web/components/shell/shell.test.tsx`
Expected: PASS (5 + 6 tests).

- [ ] **Step 10: Commit**

```bash
git add app/src/web/lib app/src/web/state app/src/web/components/shell app/src/web/pages app/test/web/helpers/render.tsx app/test/web/lib/banners.test.ts app/test/web/components/shell
git commit -m "feat(web): add the app shell, sidebar, app banners, offline handling and full-page errors"
```

---

### Task 17: Review interaction hooks (params, optimistic group actions, item actions, new-suggestions pill, hotkeys, Scan now)

**Files:**
- Create: `app/src/web/lib/copy-actions.ts`, under `app/src/web/pages/review/`: `use-review-params.ts`, `group-cache.ts`, `use-group-actions.ts`, `use-item-actions.ts`, `use-new-suggestions.ts`, `use-review-hotkeys.ts`, `use-scan-now.ts`
- Test: `app/test/web/pages/review/review-actions.test.tsx`, `app/test/web/pages/review/review-hooks.test.tsx`

**Interfaces:**
- Consumes: `actOnGroup`, `GroupActionResult` (Task 6), `api`, `qk`, `isApiError` (Task 4), `usePatchSender` (Task 5), `useToast`, `useUndoStack` (Task 9), `useHotkeys` (Task 10), `displayName` (Task 13), `BulkAction` (Task 13), `RowMove` (Task 13), `startOAuth` (Task 16), `prefersReducedMotion` (Task 8), `plural`, `formatCount`, `minutesUntil`, `localResetTime` (Task 3).
- Produces:
  - `copy-actions.ts`: `interface ActionErrorContext { providerLabel; resetTime }`, `groupActionToast(target, name, n)`, `bulkActionToast(target, n, groups)`, `approveSummaryToast(byAction)`, `partialGroupToast(target, executed, count)`, `perEmailToast(target)`, `actionErrorMessage(code: string | null | undefined, ctx)`, `GENERIC_ERROR`, `NETWORK_ERROR`.
  - `useReviewParams(): { accountId; tab; sort; groupKey; update(patch, replace?) }` (search params `account`, `tab`, `sort`, `group`; defaults omitted from the URL).
  - `group-cache.ts`: `rowExitDelayMs()`, `takeSnapshot(qc, extraKeys?)`, `restoreSnapshot(qc, snap)`, `removeGroupFromCache(qc, key)`, `patchGroupCount(qc, key, count)`, `adjustSummary(qc, accountId, action, dEmails, dGroups)`, `removeItemFromDetail(qc, key, id)`, `groupsInCache(qc)`.
  - `useGroupActions(cb: GroupActionCallbacks): GroupActionsApi` with `act(group, target, asOf, message?)`, `bulk(groups, action, asOf)`, `busyKeys`, `exitingKeys`, `busyAction`, `bulkProgress`; `interface GroupActionCallbacks { onRemoved(keys); onRestored(key); onDelta(dEmails, dGroups); errorContext(accountId); accountFor(accountId) }`.
  - `useItemActions(groupActions, cb)`: `{ itemAction(group, item, action); alwaysKeep(group, entry, asOf); alwaysTrash(group); copyAddress(group); busyItemIds }`.
  - `useNewSuggestions(summary, groupsUpdatedAt): { show: boolean; applyDelta(dEmails, dGroups) }`.
  - `useReviewHotkeys(handlers: ReviewHotkeyHandlers, enabled)`.
  - `useScanNow(accounts, accountId): { scanning: boolean; run(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/pages/review/review-actions.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueSummary, SenderGroup } from "../../../../src/shared/api.ts";
import { qk } from "../../../../src/web/api/keys.ts";
import { groupsInCache } from "../../../../src/web/pages/review/group-cache.ts";
import { useGroupActions, type GroupActionsApi } from "../../../../src/web/pages/review/use-group-actions.ts";
import { useItemActions } from "../../../../src/web/pages/review/use-item-actions.ts";
import { renderWithCore } from "../../helpers/core.tsx";
import { createTestQueryClient } from "../../helpers/query.tsx";
import { setReducedMotion } from "../../helpers/viewport.ts";
import { deriveGroups, keyOf, pendingItems, sortGroups, summaryOf, toSuggestionItem, type FakeApiState } from "../../msw/fake-api.ts";
import { iso, T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

let actions: GroupActionsApi | null = null;
let items: ReturnType<typeof useItemActions> | null = null;
const calls = { removed: [] as string[][], restored: [] as string[] };

function Harness() {
  const cb = {
    onRemoved: (k: string[]) => calls.removed.push(k),
    onRestored: (k: string) => calls.restored.push(k),
    onDelta: () => undefined,
    errorContext: () => ({ providerLabel: "Gmail", resetTime: "07:00" }),
    accountFor: () => undefined,
  };
  actions = useGroupActions(cb);
  items = useItemActions(actions, cb);
  return null;
}

function setup(mutate?: (s: FakeApiState) => void) {
  setReducedMotion(true);
  const state = installFakeApi(mutate);
  const client = createTestQueryClient();
  const groups = sortGroups(deriveGroups(state), "confidence_desc");
  client.setQueryData(qk.groups({ sort: "confidence_desc" }), { pages: [{ items: groups, nextCursor: null }], pageParams: [undefined] });
  client.setQueryData(qk.summary(), summaryOf(state));
  renderWithCore(<Harness />, { client });
  const byName = (n: string): SenderGroup => groups.find((g) => g.senderName === n)!;
  return { state, client, groups, byName };
}

const asOf = iso(T0);
afterEach(() => {
  calls.removed = [];
  calls.restored = [];
});

describe("useGroupActions", () => {
  it("approves a Trash group by key, removes the row, updates counts and offers Undo", async () => {
    const { state, client, byName } = setup();
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(state.requests.find((r) => r.route === "approve")?.body).toEqual({ groupKey: north.key, asOf });
    await waitFor(() => expect(groupsInCache(client).map((g) => g.key)).not.toContain(north.key));
    expect(client.getQueryData<QueueSummary>(qk.summary())?.pending.total).toBe(21);
    expect(screen.getByText("Moved 6 emails from Northwind Deals to Trash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(calls.removed).toContainEqual([north.key]);
  });

  it("rolls back the row and counts on error", async () => {
    const { client, byName } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(groupsInCache(client).map((g) => g.key)).toContain(north.key);
    expect(client.getQueryData<QueueSummary>(qk.summary())?.pending.total).toBe(27);
    expect(screen.getByText("Something went wrong. Nothing was changed.")).toBeTruthy();
    expect(calls.restored).toEqual([north.key]);
  });

  it("re-inserts a partially executed group with the remaining count", async () => {
    const { client, byName } = setup((s) => {
      s.retryLaterIds = new Set([1004, 1005]);
    });
    const north = byName("Northwind Deals");
    await act(async () => {
      await actions?.act(north, "delete", asOf);
    });
    expect(screen.getByText("Moved 4 of 6 emails to Trash. 2 could not be moved and stay in Review.")).toBeTruthy();
    expect(groupsInCache(client).find((g) => g.key === north.key)?.count).toBe(2);
  });

  it("overrides a Check group page by page", async () => {
    const { state, byName } = setup();
    const bot = byName("Build Bot");
    const ids = pendingItems(state).filter((i) => keyOf(i) === bot.key).sort((a, b) => b.confidence - a.confidence).map((i) => i.id);
    await act(async () => {
      await actions?.act(bot, "delete", asOf);
    });
    expect(state.requests.filter((r) => r.route === "group")[0]?.url.searchParams.get("limit")).toBe("100");
    expect(state.requests.find((r) => r.route === "override")?.body).toEqual({ ids, action: "delete" });
    expect(screen.getByText("Moved 5 emails from Build Bot to Trash.")).toBeTruthy();
  });

  it("approves a selection and reports one summary toast", async () => {
    const { byName } = setup();
    await act(async () => {
      await actions?.bulk([byName("Northwind Deals"), byName("Contoso Orders")], "approve", asOf);
    });
    expect(screen.getByText("Done: 6 to Trash, 3 archived.")).toBeTruthy();
  });

  it("stops a bulk action at the budget limit and keeps the rest", async () => {
    const { state, client, byName } = setup((s) => {
      s.failures.approve = { status: 429, code: "budget_exhausted", times: 1 };
    });
    let done: string[] = [];
    await act(async () => {
      done = (await actions?.bulk([byName("Build Bot"), byName("Northwind Deals"), byName("Daily Digest")], "delete", asOf)) ?? [];
    });
    expect(done).toEqual([byName("Build Bot").key]);
    expect(state.requests.filter((r) => r.route === "approve")).toHaveLength(1);
    expect(screen.getByText("Moved 5 emails from 1 sender group to Trash.")).toBeTruthy();
    expect(screen.getByText("Today's free-tier limit for changes is reached. Try again after 07:00.")).toBeTruthy();
    expect(groupsInCache(client).map((g) => g.senderName)).toContain("Daily Digest");
  });
});

describe("useItemActions", () => {
  it("adds the sender to Always keep, then keeps the group", async () => {
    const { state, byName } = setup();
    const north = byName("Northwind Deals");
    await act(async () => {
      await items?.alwaysKeep(north, north.sender, asOf);
    });
    expect(state.requests.find((r) => r.route === "patchSender")?.body).toEqual({ entry: "promo@northwind.example", list: "allow" });
    expect(screen.getByText("Northwind Deals is on your Always keep list. 6 emails kept.")).toBeTruthy();
  });

  it("adds the sender to Always OK to trash without Undo", async () => {
    const { byName } = setup();
    await act(async () => {
      await items?.alwaysTrash(byName("Daily Digest"));
    });
    expect(screen.getByText("Daily Digest is on your Always OK to trash list. Future emails from it skip the confidence check.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("approves one email when the choice matches its suggestion", async () => {
    const { state, client, byName } = setup();
    const north = byName("Northwind Deals");
    const item = toSuggestionItem(state, pendingItems(state).find((i) => i.id === 1000)!);
    await act(async () => {
      await items?.itemAction(north, item, "delete");
    });
    expect(state.requests.find((r) => r.route === "approve")?.body).toEqual({ ids: [1000] });
    expect(screen.getByText("Moved 1 email to Trash.")).toBeTruthy();
    expect(groupsInCache(client).find((g) => g.key === north.key)?.count).toBe(5);
  });
});
```

`app/test/web/pages/review/review-hooks.test.tsx`:

```tsx
import { act, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNewSuggestions } from "../../../../src/web/pages/review/use-new-suggestions.ts";
import { useReviewHotkeys, type ReviewHotkeyHandlers } from "../../../../src/web/pages/review/use-review-hotkeys.ts";
import { useReviewParams } from "../../../../src/web/pages/review/use-review-params.ts";
import { useScanNow } from "../../../../src/web/pages/review/use-scan-now.ts";
import { HotkeysProvider } from "../../../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "../../helpers/core.tsx";
import { createFakeApiState, summaryOf } from "../../msw/fake-api.ts";
import { ACC_GMAIL, iso, T0 } from "../../msw/fixtures.ts";
import { installFakeApi } from "../../msw/handlers.ts";

afterEach(() => vi.useRealTimers());

describe("useNewSuggestions (UI spec 6.6)", () => {
  it("shows the pill only when a later summary differs from the snapshot", () => {
    const base = summaryOf(createFakeApiState());
    const { result, rerender } = renderHook(({ s, at }) => useNewSuggestions(s, at), { initialProps: { s: base, at: 1 } });
    expect(result.current.show).toBe(false);
    const fewer = { ...base, pending: { ...base.pending, total: base.pending.total - 6 }, groups: base.groups - 1 };
    act(() => result.current.applyDelta(-6, -1));
    rerender({ s: fewer, at: 1 });
    expect(result.current.show).toBe(false);
    rerender({ s: { ...fewer, pending: { ...fewer.pending, total: fewer.pending.total + 25 } }, at: 1 });
    expect(result.current.show).toBe(true);
    rerender({ s: { ...fewer, pending: { ...fewer.pending, total: fewer.pending.total + 25 } }, at: 2 });
    expect(result.current.show).toBe(false);
  });
});

describe("useReviewParams", () => {
  it("reads defaults and writes only non-default values", async () => {
    installFakeApi();
    let params: ReturnType<typeof useReviewParams> | null = null;
    function Grab() {
      params = useReviewParams();
      return null;
    }
    const { router } = renderWithCore(<Grab />, { path: "/review?tab=trash&sort=count_desc&account=acc_1" });
    expect(params).toMatchObject({ tab: "trash", sort: "count_desc", accountId: "acc_1", groupKey: null });
    act(() => params?.update({ tab: "all", sort: "confidence_desc", group: "k1" }));
    expect(router.state.location.search).toBe("?account=acc_1&group=k1");
  });
});

describe("useReviewHotkeys", () => {
  it("maps the Review keys to handlers", async () => {
    installFakeApi();
    const h: ReviewHotkeyHandlers = {
      move: vi.fn(), toggleActive: vi.fn(), rangeToActive: vi.fn(), act: vi.fn(), cleanUp: vi.fn(), tab: vi.fn(), escape: vi.fn(),
    };
    function Grab() {
      useReviewHotkeys(h, true);
      return <input aria-label="Filter" />;
    }
    const { user } = renderWithCore(<HotkeysProvider><Grab /></HotkeysProvider>);
    await user.keyboard("jk{ArrowDown}x{Shift>}X{/Shift}tae3{Escape}");
    expect((h.move as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m)).toEqual(["next", "prev", "next"]);
    expect([h.toggleActive, h.rangeToActive, h.escape].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1]);
    expect((h.act as ReturnType<typeof vi.fn>).mock.calls.map(([a]) => a)).toEqual(["delete", "archive", "keep"]);
    expect(h.tab).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("textbox", { name: "Filter" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(h.cleanUp).toHaveBeenCalledOnce();
  });
});

describe("useScanNow", () => {
  function setup(accountId?: string) {
    let scan: ReturnType<typeof useScanNow> | null = null;
    const state = installFakeApi((s) => {
      s.scanDecided = 25;
    });
    function Grab() {
      scan = useScanNow(state.accounts, accountId);
      return null;
    }
    renderWithCore(<Grab />);
    return { state, run: () => scan?.run() ?? Promise.resolve() };
  }

  it("scans each active account and sums new emails", async () => {
    const { state, run } = setup();
    await act(run);
    expect(state.requests.filter((r) => r.route === "scan")).toHaveLength(2);
    expect(screen.getByText("Scan finished. 50 new emails sorted.")).toBeTruthy();
  });

  it("explains a busy account", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const { state, run } = setup(ACC_GMAIL);
    state.failures.scan = { status: 409, code: "account_busy", times: 1, retryAt: iso(T0 + 2 * 60_000) };
    await act(run);
    expect(screen.getByText("A scan is already running for you@example.com. Try again in 2 min.")).toBeTruthy();
  });

  it("stops at the free-tier limit", async () => {
    const { state, run } = setup();
    state.failures.scan = { status: 429, code: "budget_exhausted", times: 1 };
    await act(run);
    expect(state.requests.filter((r) => r.route === "scan")).toHaveLength(1);
    expect(screen.getByText(/^Today's free-tier limit is reached\. Scanning resumes after \d\d:\d\d\.$/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/review`
Expected: FAIL with `Failed to load url ../../../../src/web/pages/review/group-cache.ts` (and the other hooks).

- [ ] **Step 3: Implement `copy-actions.ts`**

`app/src/web/lib/copy-actions.ts`:

```ts
import { formatCount, plural } from "./format.ts";
import type { ActionKind } from "./view-types.ts";

export interface ActionErrorContext {
  providerLabel: string;
  resetTime: string;
}

export const GENERIC_ERROR = "Something went wrong. Nothing was changed.";
export const NETWORK_ERROR = "Couldn't reach Clearbox. Check your connection and try again.";
const emails = (n: number) => plural(n, "email", "emails");
const groups = (n: number) => plural(n, "sender group", "sender groups");

export function groupActionToast(target: ActionKind, name: string, n: number): string {
  if (target === "delete") return `Moved ${emails(n)} from ${name} to Trash.`;
  if (target === "archive") return `Archived ${emails(n)} from ${name}.`;
  return `Kept ${emails(n)} from ${name}. Clearbox will remember.`;
}

export function bulkActionToast(target: ActionKind, n: number, groupCount: number): string {
  if (target === "delete") return `Moved ${emails(n)} from ${groups(groupCount)} to Trash.`;
  if (target === "archive") return `Archived ${emails(n)} from ${groups(groupCount)}.`;
  return `Kept ${emails(n)} from ${groups(groupCount)}.`;
}

export function approveSummaryToast(by: Record<ActionKind, number>): string {
  const parts = [
    by.delete > 0 ? `${formatCount(by.delete)} to Trash` : "",
    by.archive > 0 ? `${formatCount(by.archive)} archived` : "",
    by.keep > 0 ? `${formatCount(by.keep)} kept` : "",
  ].filter(Boolean);
  return `Done: ${parts.join(", ")}.`;
}

export function partialGroupToast(target: ActionKind, executed: number, count: number): string {
  const left = formatCount(count - executed);
  if (target === "delete") return `Moved ${formatCount(executed)} of ${emails(count)} to Trash. ${left} could not be moved and stay in Review.`;
  if (target === "archive") return `Archived ${formatCount(executed)} of ${emails(count)}. ${left} could not be archived and stay in Review.`;
  return `Kept ${formatCount(executed)} of ${emails(count)}. ${left} could not be kept and stay in Review.`;
}

export function perEmailToast(target: ActionKind): string {
  return { delete: "Moved 1 email to Trash.", archive: "Archived 1 email.", keep: "Kept 1 email." }[target];
}

/** Error toasts for owner actions (UI spec 5.1 table, 4.18 generic copy). */
export function actionErrorMessage(code: string | null | undefined, ctx: ActionErrorContext): string {
  if (code === "budget_exhausted") return `Today's free-tier limit for changes is reached. Try again after ${ctx.resetTime}.`;
  if (code === "rate_limited") return `${ctx.providerLabel} asked Clearbox to slow down. Nothing else was changed. Try again in a minute.`;
  if (code === "network") return NETWORK_ERROR;
  return GENERIC_ERROR;
}
```

- [ ] **Step 4: Implement `use-review-params.ts` and `group-cache.ts`**

`app/src/web/pages/review/use-review-params.ts`:

```ts
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { isGroupSort, isTabKey, type GroupSort, type TabKey } from "../../lib/view-types.ts";

type ParamName = "account" | "tab" | "sort" | "group";
const DEFAULTS: Partial<Record<ParamName, string>> = { tab: "all", sort: "confidence_desc" };

export function useReviewParams() {
  const [params, setParams] = useSearchParams();
  const update = useCallback(
    (patch: Partial<Record<ParamName, string | null>>, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch) as [ParamName, string | null][]) {
            if (v === null || v === "" || DEFAULTS[k] === v) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      ),
    [setParams],
  );
  return useMemo(() => {
    const tab = params.get("tab");
    const sort = params.get("sort");
    return {
      accountId: params.get("account") ?? undefined,
      tab: (isTabKey(tab) ? tab : "all") as TabKey,
      sort: (isGroupSort(sort) ? sort : "confidence_desc") as GroupSort,
      groupKey: params.get("group"),
      update,
    };
  }, [params, update]);
}
```

`app/src/web/pages/review/group-cache.ts`:

```ts
import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { GroupDetail, Page, QueueSummary, SenderGroup } from "../../../shared/api.ts";
import type { SuggestedAction } from "../../lib/view-types.ts";
import { prefersReducedMotion } from "../../state/use-media-query.ts";

type GroupPages = InfiniteData<Page<SenderGroup>>;
type DetailPages = InfiniteData<GroupDetail>;
export type Snapshot = [QueryKey, unknown][];

/** Fade 200 ms then collapse 200 ms; instant with reduced motion (UI spec 4.8, 7.6, decision W15). */
export const rowExitDelayMs = (): number => (prefersReducedMotion() ? 0 : 400);

export function takeSnapshot(qc: QueryClient, extra: QueryKey[] = []): Snapshot {
  return [
    ...qc.getQueriesData({ queryKey: ["groups"] }),
    ...qc.getQueriesData({ queryKey: ["queue", "summary"] }),
    ...extra.flatMap((key) => qc.getQueriesData({ queryKey: key })),
  ];
}

export function restoreSnapshot(qc: QueryClient, snap: Snapshot): void {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

const mapGroups = (qc: QueryClient, fn: (items: SenderGroup[]) => SenderGroup[]) =>
  qc.setQueriesData<GroupPages>({ queryKey: ["groups"] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
  );

export function removeGroupFromCache(qc: QueryClient, key: string): void {
  mapGroups(qc, (items) => items.filter((g) => g.key !== key));
}

export function patchGroupCount(qc: QueryClient, key: string, count: number): void {
  mapGroups(qc, (items) => items.map((g) => (g.key === key ? { ...g, count } : g)));
}

export function groupsInCache(qc: QueryClient): SenderGroup[] {
  return qc.getQueriesData<GroupPages>({ queryKey: ["groups"] }).flatMap(([, d]) => d?.pages.flatMap((p) => p.items) ?? []);
}

/** Optimistic summary counts for every summary cache that includes this account. */
export function adjustSummary(qc: QueryClient, accountId: string, action: SuggestedAction, dEmails: number, dGroups: number): void {
  qc.setQueriesData<QueueSummary>(
    {
      queryKey: ["queue", "summary"],
      predicate: (q) => {
        const scope = q.queryKey[2] as { accountId: string | null } | undefined;
        return !scope || scope.accountId === null || scope.accountId === accountId;
      },
    },
    (old) =>
      old && {
        ...old,
        pending: {
          ...old.pending,
          [action]: Math.max(0, old.pending[action] + dEmails),
          total: Math.max(0, old.pending.total + dEmails),
        },
        groups: Math.max(0, old.groups + dGroups),
        groupsByAction: { ...old.groupsByAction, [action]: Math.max(0, old.groupsByAction[action] + dGroups) },
      },
  );
}

export function removeItemFromDetail(qc: QueryClient, key: string, id: number): void {
  qc.setQueriesData<DetailPages>({ queryKey: ["group", key] }, (old) =>
    old
      ? { ...old, pages: old.pages.map((p) => ({ ...p, items: { ...p.items, items: p.items.items.filter((i) => i.id !== id) } })) }
      : old,
  );
}
```

- [ ] **Step 5: Implement `use-group-actions.ts`**

`app/src/web/pages/review/use-group-actions.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AccountView, SenderGroup } from "../../../shared/api.ts";
import { api } from "../../api/endpoints.ts";
import { actOnGroup, type GroupActionResult } from "../../api/group-actions.ts";
import { qk } from "../../api/keys.ts";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import type { BulkAction } from "../../components/review/SelectionToolbar.tsx";
import {
  actionErrorMessage, approveSummaryToast, bulkActionToast, groupActionToast, partialGroupToast, type ActionErrorContext,
} from "../../lib/copy-actions.ts";
import { startOAuth } from "../../lib/oauth-return.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { useUndoStack } from "../../state/UndoStackProvider.tsx";
import { adjustSummary, patchGroupCount, removeGroupFromCache, restoreSnapshot, rowExitDelayMs, takeSnapshot } from "./group-cache.ts";

const DEPS = { approve: api.approve, override: api.override, groupDetail: api.groupDetail };

export interface GroupActionCallbacks {
  onRemoved: (keys: string[]) => void;
  onRestored: (key: string) => void;
  onDelta: (dEmails: number, dGroups: number) => void;
  errorContext: (accountId: string) => ActionErrorContext;
  accountFor: (accountId: string) => AccountView | undefined;
}

export interface GroupActionsApi {
  busyKeys: ReadonlySet<string>;
  exitingKeys: ReadonlySet<string>;
  busyAction: { key: string; action: ActionKind } | null;
  bulkProgress: { done: number; total: number } | null;
  act: (group: SenderGroup, target: ActionKind, asOf: string, message?: (executed: number) => string) => Promise<boolean>;
  bulk: (groups: readonly SenderGroup[], action: BulkAction, asOf: string) => Promise<string[]>;
  showError: (group: SenderGroup, result: Pick<GroupActionResult, "codes" | "error" | "executed">) => void;
}

function toggle(set: Dispatch<SetStateAction<ReadonlySet<string>>>, key: string, on: boolean) {
  set((prev) => {
    const next = new Set(prev);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });
}

export function useGroupActions(cb: GroupActionCallbacks): GroupActionsApi {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndoStack();
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [exitingKeys, setExitingKeys] = useState<ReadonlySet<string>>(new Set());
  const [busyAction, setBusyAction] = useState<{ key: string; action: ActionKind } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Set<string>());

  const exit = useCallback(
    (key: string) => {
      toggle(setExitingKeys, key, true);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          cbRef.current.onRemoved([key]);
          removeGroupFromCache(qc, key);
          toggle(setExitingKeys, key, false);
        }, rowExitDelayMs()),
      );
    },
    [qc],
  );

  const cancelExit = useCallback((key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    toggle(setExitingKeys, key, false);
  }, []);

  const showError = useCallback<GroupActionsApi["showError"]>(
    (group, result) => {
      const account = cbRef.current.accountFor(group.accountId);
      if (result.executed === 0 && (result.codes.account_inactive ?? 0) > 0) {
        toast.show({
          kind: "error",
          message: `Reconnect ${account?.email ?? "this account"} to act on its emails.`,
          action: account
            ? { label: "Reconnect", onAction: () => startOAuth(account.provider, { returnTo: "/accounts", loginHint: account.email }) }
            : undefined,
        });
        return;
      }
      const code = result.error?.code ?? ((result.codes.rate_limited ?? 0) > 0 ? "rate_limited" : null);
      toast.show({ kind: "error", message: actionErrorMessage(code, cbRef.current.errorContext(group.accountId)) });
    },
    [toast],
  );

  const act = useCallback<GroupActionsApi["act"]>(
    async (group, target, asOf, message) => {
      if (inflight.current.has(group.key)) return false;
      inflight.current.add(group.key);
      const snap = takeSnapshot(qc);
      setBusyAction({ key: group.key, action: target });
      adjustSummary(qc, group.accountId, group.action, -group.count, -1);
      cbRef.current.onDelta(-group.count, -1);
      exit(group.key);
      const result = await actOnGroup(group, target, asOf, DEPS);
      inflight.current.delete(group.key);
      setBusyAction(null);
      const done = result.executed + result.skipped;
      if (done === 0) {
        cancelExit(group.key);
        restoreSnapshot(qc, snap);
        cbRef.current.onDelta(group.count, 1);
        cbRef.current.onRestored(group.key);
        showError(group, result);
        return false;
      }
      if (done < group.count) {
        cancelExit(group.key);
        restoreSnapshot(qc, snap);
        patchGroupCount(qc, group.key, group.count - done);
        adjustSummary(qc, group.accountId, group.action, -done, 0);
        cbRef.current.onDelta(group.count - done, 1);
        cbRef.current.onRestored(group.key);
        undo.notifyWithUndo({ kind: "action", message: partialGroupToast(target, result.executed, group.count), batchIds: result.batchIds });
        void qc.invalidateQueries({ queryKey: qk.group(group.key) });
        return false;
      }
      const name = displayName(group).text;
      undo.notifyWithUndo({ kind: "action", message: message ? message(result.executed) : groupActionToast(target, name, result.executed), batchIds: result.batchIds });
      qc.removeQueries({ queryKey: qk.group(group.key) });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["cleanup"] });
      return true;
    },
    [cancelExit, exit, qc, showError, undo],
  );

  const bulk = useCallback<GroupActionsApi["bulk"]>(
    async (groups, action, asOf) => {
      setBusyKeys(new Set(groups.map((g) => g.key)));
      const doneKeys: string[] = [];
      const batchIds: number[] = [];
      const by: Record<ActionKind, number> = { delete: 0, archive: 0, keep: 0 };
      let executed = 0;
      let touched = 0;
      let firstError: { group: SenderGroup; result: GroupActionResult } | null = null;
      for (const [i, g] of groups.entries()) {
        setBulkProgress({ done: i + 1, total: groups.length });
        const target: ActionKind = action === "approve" ? (g.action === "unsure" ? "keep" : g.action) : action;
        const r = await actOnGroup(g, target, asOf, DEPS);
        toggle(setBusyKeys, g.key, false);
        executed += r.executed;
        by[target] += r.executed;
        batchIds.push(...r.batchIds);
        const done = r.executed + r.skipped;
        if (done >= g.count) {
          touched += 1;
          doneKeys.push(g.key);
          adjustSummary(qc, g.accountId, g.action, -g.count, -1);
          cbRef.current.onDelta(-g.count, -1);
          exit(g.key);
        } else if (done > 0) {
          touched += 1;
          patchGroupCount(qc, g.key, g.count - done);
          adjustSummary(qc, g.accountId, g.action, -done, 0);
          cbRef.current.onDelta(-done, 0);
        }
        if (done === 0 || r.error) {
          firstError ??= { group: g, result: r };
          if (r.error?.code === "budget_exhausted" || r.error?.code === "network") break;
        }
      }
      setBusyKeys(new Set());
      setBulkProgress(null);
      if (executed > 0) {
        const target: ActionKind = action === "approve" ? "delete" : action;
        undo.notifyWithUndo({
          kind: "action",
          message: action === "approve" ? approveSummaryToast(by) : bulkActionToast(target, executed, touched),
          batchIds,
        });
      }
      if (firstError) showError(firstError.group, firstError.result);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["cleanup"] });
      return doneKeys;
    },
    [exit, qc, showError, undo],
  );

  return useMemo(
    () => ({ busyKeys, exitingKeys, busyAction, bulkProgress, act, bulk, showError }),
    [busyKeys, exitingKeys, busyAction, bulkProgress, act, bulk, showError],
  );
}
```

- [ ] **Step 6: Implement `use-item-actions.ts`**

`app/src/web/pages/review/use-item-actions.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SenderGroup, SuggestionItem } from "../../../shared/api.ts";
import { isApiError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { qk } from "../../api/keys.ts";
import { usePatchSender } from "../../api/mutations.ts";
import { displayName } from "../../components/review/SenderGroupRow.tsx";
import { actionErrorMessage, GENERIC_ERROR, perEmailToast } from "../../lib/copy-actions.ts";
import { plural } from "../../lib/format.ts";
import type { ActionKind } from "../../lib/view-types.ts";
import { useToast } from "../../state/ToastProvider.tsx";
import { useUndoStack } from "../../state/UndoStackProvider.tsx";
import { adjustSummary, patchGroupCount, removeGroupFromCache, removeItemFromDetail, restoreSnapshot, takeSnapshot } from "./group-cache.ts";
import type { GroupActionCallbacks, GroupActionsApi } from "./use-group-actions.ts";

export function useItemActions(groupActions: GroupActionsApi, cb: GroupActionCallbacks) {
  const qc = useQueryClient();
  const toast = useToast();
  const undo = useUndoStack();
  const patchSender = usePatchSender();
  const [busyItemIds, setBusyItemIds] = useState<ReadonlySet<number>>(new Set());
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  const setBusy = (id: number, on: boolean) =>
    setBusyItemIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const itemAction = useCallback(
    async (group: SenderGroup, item: SuggestionItem, action: ActionKind) => {
      setBusy(item.id, true);
      const last = group.count === 1;
      const snap = takeSnapshot(qc, [qk.group(group.key)]);
      removeItemFromDetail(qc, group.key, item.id);
      patchGroupCount(qc, group.key, group.count - 1);
      adjustSummary(qc, group.accountId, group.action, -1, last ? -1 : 0);
      cbRef.current.onDelta(-1, last ? -1 : 0);
      try {
        const res = item.action !== "unsure" && item.action === action
          ? await api.approve({ ids: [item.id] })
          : await api.override({ ids: [item.id], action });
        if (res.executed + res.skipped === 0) {
          const codes = Object.fromEntries(res.results.filter((r) => r.error).map((r) => [r.error, 1]));
          throw Object.assign(new Error("no progress"), { codes });
        }
        undo.notifyWithUndo({ kind: "action", message: perEmailToast(action), batchIds: res.batchId === null ? [] : [res.batchId] });
        if (last) {
          cbRef.current.onRemoved([group.key]);
          removeGroupFromCache(qc, group.key);
        }
        void qc.invalidateQueries({ queryKey: qk.group(group.key) });
        void qc.invalidateQueries({ queryKey: ["queue"] });
      } catch (e) {
        restoreSnapshot(qc, snap);
        cbRef.current.onDelta(1, last ? 1 : 0);
        const codes = (e as { codes?: Record<string, number> }).codes ?? {};
        groupActions.showError(group, { executed: 0, codes, error: isApiError(e) ? e : null });
      } finally {
        setBusy(item.id, false);
      }
    },
    [groupActions, qc, undo],
  );

  const alwaysKeep = useCallback(
    async (group: SenderGroup, entry: string, asOf: string) => {
      try {
        await patchSender.mutateAsync({ entry, list: "allow" });
      } catch {
        toast.show({ kind: "error", message: GENERIC_ERROR });
        return;
      }
      const label = entry.startsWith("@") ? entry : displayName(group).text;
      await groupActions.act(group, "keep", asOf, (n) => `${label} is on your Always keep list. ${plural(n, "email", "emails")} kept.`);
    },
    [groupActions, patchSender, toast],
  );

  const alwaysTrash = useCallback(
    async (group: SenderGroup) => {
      try {
        await patchSender.mutateAsync({ entry: group.sender, list: "deny" });
        toast.show({
          kind: "info",
          message: `${displayName(group).text} is on your Always OK to trash list. Future emails from it skip the confidence check.`,
        });
      } catch (e) {
        toast.show({ kind: "error", message: actionErrorMessage(isApiError(e) ? e.code : null, cbRef.current.errorContext(group.accountId)) });
      }
    },
    [patchSender, toast],
  );

  const copyAddress = useCallback(
    async (group: SenderGroup) => {
      try {
        await navigator.clipboard.writeText(group.sender);
        toast.show({ kind: "info", message: `Copied ${group.sender}.` });
      } catch {
        toast.show({ kind: "error", message: GENERIC_ERROR });
      }
    },
    [toast],
  );

  return useMemo(() => ({ itemAction, alwaysKeep, alwaysTrash, copyAddress, busyItemIds }), [itemAction, alwaysKeep, alwaysTrash, copyAddress, busyItemIds]);
}
```

- [ ] **Step 7: Implement `use-new-suggestions.ts`, `use-review-hotkeys.ts`, `use-scan-now.ts`**

`app/src/web/pages/review/use-new-suggestions.ts`:

```ts
import { useCallback, useState } from "react";
import type { QueueSummary } from "../../../shared/api.ts";

interface Snap {
  total: number;
  groups: number;
  at: number;
}

/** UI spec 6.6: snapshot the summary when the list loads; own changes move the snapshot by the same deltas. */
export function useNewSuggestions(summary: QueueSummary | undefined, groupsUpdatedAt: number) {
  const [snap, setSnap] = useState<Snap | null>(null);
  if (summary && groupsUpdatedAt > 0 && (snap === null || snap.at !== groupsUpdatedAt)) {
    setSnap({ total: summary.pending.total, groups: summary.groups, at: groupsUpdatedAt });
  }
  const applyDelta = useCallback((dEmails: number, dGroups: number) => {
    setSnap((s) => (s ? { ...s, total: s.total + dEmails, groups: s.groups + dGroups } : s));
  }, []);
  const show = !!summary && !!snap && snap.at === groupsUpdatedAt && (summary.pending.total !== snap.total || summary.groups !== snap.groups);
  return { show, applyDelta };
}
```

`app/src/web/pages/review/use-review-hotkeys.ts`:

```ts
import type { RowMove } from "../../components/review/SenderGroupList.tsx";
import type { ActionKind } from "../../lib/view-types.ts";
import { useHotkeys } from "../../state/HotkeysProvider.tsx";

export interface ReviewHotkeyHandlers {
  move: (to: RowMove) => void;
  toggleActive: () => void;
  rangeToActive: () => void;
  act: (action: ActionKind) => void;
  cleanUp: () => void;
  tab: (index: number) => void;
  escape: () => void;
}

/** UI spec 6.1 Review scope. Row-focused keys (Home, End, Page keys, Enter) live in the grid itself. */
export function useReviewHotkeys(h: ReviewHotkeyHandlers, enabled: boolean): void {
  useHotkeys(
    "review",
    [
      { combo: "j", handler: () => h.move("next") },
      { combo: "arrowdown", handler: () => h.move("next") },
      { combo: "k", handler: () => h.move("prev") },
      { combo: "arrowup", handler: () => h.move("prev") },
      { combo: "x", handler: () => h.toggleActive() },
      { combo: "shift+x", handler: () => h.rangeToActive() },
      { combo: "t", handler: () => h.act("delete") },
      { combo: "a", handler: () => h.act("archive") },
      { combo: "e", handler: () => h.act("keep") },
      { combo: "mod+enter", handler: () => h.cleanUp(), allowInInputs: true },
      ...[1, 2, 3, 4, 5].map((n) => ({ combo: String(n), handler: () => h.tab(n - 1) })),
      { combo: "escape", handler: () => h.escape() },
    ],
    enabled,
  );
}
```

`app/src/web/pages/review/use-scan-now.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { AccountView } from "../../../shared/api.ts";
import { isApiError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { minutesUntil } from "../../lib/account-status.ts";
import { GENERIC_ERROR } from "../../lib/copy-actions.ts";
import { localResetTime, plural } from "../../lib/format.ts";
import { useToast } from "../../state/ToastProvider.tsx";

/** UI spec 5.1 Scan now: the selected account, or every active unpaused account in sequence. */
export function useScanNow(accounts: readonly AccountView[], accountId: string | undefined) {
  const [scanning, setScanning] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const run = useCallback(async () => {
    const single = accountId !== undefined;
    const targets = single ? accounts.filter((a) => a.id === accountId) : accounts.filter((a) => a.status === "active" && !a.paused);
    setScanning(true);
    let sorted = 0;
    let finished = false;
    for (const a of targets) {
      try {
        const r = await api.scanAccount(a.id);
        sorted += r.decided + r.unsure;
        finished = true;
      } catch (e) {
        const code = isApiError(e) ? e.code : null;
        if (code === "account_busy") {
          const mins = minutesUntil(isApiError(e) && e.retryAt ? e.retryAt : new Date().toISOString(), Date.now());
          toast.show({ kind: "info", message: `A scan is already running for ${a.email}. Try again in ${mins} min.` });
        } else if (code === "account_inactive") {
          if (single) toast.show({ kind: "info", message: `${a.email} is paused.` });
        } else if (code === "budget_exhausted") {
          toast.show({ kind: "info", message: `Today's free-tier limit is reached. Scanning resumes after ${localResetTime(Date.now())}.` });
          break;
        } else {
          toast.show({ kind: "error", message: GENERIC_ERROR });
        }
      }
    }
    if (finished) {
      toast.show({
        kind: "info",
        message: sorted === 0 ? "Scan finished. No new emails." : `Scan finished. ${plural(sorted, "new email", "new emails")} sorted.`,
      });
    }
    setScanning(false);
    await Promise.all(["accounts", "queue", "cleanup"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  }, [accountId, accounts, qc, toast]);
  return { scanning, run };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/review`
Expected: PASS (9 + 6 tests).

- [ ] **Step 9: Commit**

```bash
git add app/src/web/lib/copy-actions.ts app/src/web/pages/review app/test/web/pages/review
git commit -m "feat(web): add optimistic group and email actions, the new-suggestions pill, review hotkeys and Scan now"
```

---

### Task 18: Review page (states, work area, keyboard flow, Clean up integration)

**Files:**
- Create: `app/src/web/pages/review/review-state.ts`, `app/src/web/pages/review/use-review-controller.ts`, `app/src/web/pages/review/ReviewWorkArea.tsx`, `app/src/web/pages/ReviewPage.tsx`
- Test: `app/test/web/pages/review/review-state.test.ts`, `app/test/web/pages/review-page.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3 to 17; notably `useReviewParams`, `useGroupActions`, `useItemActions`, `useNewSuggestions`, `useReviewHotkeys`, `useScanNow`, `useCleanup`, `CleanupBar`, `SummaryCard`, `ActionTabs`, `SenderGroupList`, `DetailPanel`, `AppBanners`, `PageHeader`.
- Produces:
  - `review-state.ts`: `type ReviewPageState`, `reviewPageState(i)`, `summaryCardState(preview, summary, previewCount)`, `resolveTau(preview?, summary?, me?)`, `isBackfilling(accounts)`, `isCatchingUp(accounts)`, `sortedMeta(accounts, now)`, `tabCounts(summary?)`, `modelUnavailableShare(groups)`, `moveTarget(keys, active, to)`, `nextAfterRemoval(keys, removed)`, `firstSortProgress(accounts)`.
  - `useReviewController()` (all Review state and handlers), `ReviewWorkArea({ list, detail })`, `ReviewPage()` (route `/review`).

- [ ] **Step 1: Write the failing tests**

`app/test/web/pages/review/review-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  firstSortProgress, moveTarget, nextAfterRemoval, reviewPageState, sortedMeta, summaryCardState, tabCounts,
} from "../../../../src/web/pages/review/review-state.ts";
import { createFakeApiState, summaryOf } from "../../msw/fake-api.ts";
import { makeAccount, makeSync, T0 } from "../../msw/fixtures.ts";

const ok = "success" as const;

describe("review-state", () => {
  it("derives the page state", () => {
    const base = { accounts: ok, accountCount: 2, summary: ok, preview: ok, groups: ok, pendingTotal: 27, backfilling: false };
    expect(reviewPageState({ ...base, accounts: "pending" })).toBe("loading");
    expect(reviewPageState({ ...base, accountCount: 0 })).toBe("no_accounts");
    expect(reviewPageState({ ...base, summary: "error", preview: "error", groups: "error" })).toBe("error");
    expect(reviewPageState({ ...base, pendingTotal: 0, backfilling: true })).toBe("first_sort");
    expect(reviewPageState({ ...base, pendingTotal: 0 })).toBe("all_caught_up");
    expect(reviewPageState(base)).toBe("ready");
  });

  it("derives the summary card state", () => {
    expect(summaryCardState("pending", ok, 0)).toBe("loading");
    expect(summaryCardState("error", ok, 0)).toBe("error");
    expect(summaryCardState(ok, ok, 0)).toBe("nothing_sure");
    expect(summaryCardState(ok, ok, 14)).toBe("ready");
  });

  it("formats the header meta and tab counts", () => {
    const s = createFakeApiState();
    expect(sortedMeta(s.accounts, T0)).toBe("Sorted 1 min ago · catching up");
    expect(sortedMeta([makeAccount({ sync: makeSync({ lastTickAt: null }) })], T0)).toBe("Not sorted yet");
    expect(tabCounts(summaryOf(s))).toEqual({ all: 7, trash: 3, archive: 2, check: 1, keep: 1 });
    expect(tabCounts(undefined).all).toBeNull();
  });

  it("moves and picks the next row after removal", () => {
    const keys = ["a", "b", "c", "d"];
    expect([moveTarget(keys, "b", "next"), moveTarget(keys, "a", "prev"), moveTarget(keys, "b", "last"), moveTarget(keys, "c", "pageup")]).toEqual(["c", "a", "d", "a"]);
    expect(nextAfterRemoval(keys, ["b"])).toBe("c");
    expect(nextAfterRemoval(keys, ["d"])).toBe("c");
    expect(nextAfterRemoval(["a"], ["a"])).toBeNull();
  });

  it("averages first-sort progress when every estimate is known", () => {
    const accounts = createFakeApiState().accounts;
    expect(firstSortProgress(accounts)).toEqual({ value: 0.41, sorted: 40_318 });
    expect(firstSortProgress([makeAccount({ sync: makeSync({ backfillDone: false, inboxEstimate: null, messagesIngested: 10 }) })]).value).toBeNull();
  });
});
```

`app/test/web/pages/review-page.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPage } from "../../../src/web/pages/ReviewPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { setViewport } from "../helpers/viewport.ts";
import { deriveGroups, type FakeApiState } from "../msw/fake-api.ts";
import { makeSync, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void, path = "/review") {
  const state = installFakeApi(mutate);
  const utils = renderPage(<ReviewPage />, { path, route: "/review" });
  return { state, ...utils };
}
const keyOfName = (s: FakeApiState, name: string) => deriveGroups(s).find((g) => g.senderName === name)?.key;

describe("Review page", () => {
  it("renders the ready state with summary, tabs, rows and the inline detail", async () => {
    const { container } = setup();
    expect(await screen.findByRole("heading", { level: 2, name: "14 emails are ready to clean up" })).toBeTruthy();
    expect(screen.getByText("Sorted 1 min ago · catching up")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trash, 3 groups" })).toBeTruthy();
    expect(await screen.findByRole("complementary", { name: "Northwind Deals" })).toBeTruthy();
    const first = screen.getAllByRole("row")[1];
    expect(first?.getAttribute("aria-current")).toBe("true");
    expect(document.title).toBe("(7) Review · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("supports the keyboard triage flow with Undo", async () => {
    const { state, user } = setup();
    const northKey = keyOfName(state, "Northwind Deals");
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("j");
    expect(await screen.findByRole("complementary", { name: "Contoso Orders" })).toBeTruthy();
    await user.keyboard("x");
    expect(screen.getByText("1 group selected · 3 emails")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar", { name: "Selected groups" })).toBeNull();
    await user.keyboard("k");
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("t");
    await screen.findByText("Moved 6 emails from Northwind Deals to Trash.");
    expect(state.requests.find((r) => r.route === "approve")?.body).toMatchObject({ groupKey: northKey });
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Contoso Orders/));
    await user.keyboard("{Control>}z{/Control}");
    await screen.findByText("Restored 6 emails to your inbox.");
  });

  it("switches tabs with number keys and overrides a Check group with T", async () => {
    const { state, user } = setup();
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("4");
    expect(await screen.findByRole("grid", { name: "Sender groups, Check tab" })).toBeTruthy();
    await screen.findByRole("complementary", { name: "Build Bot" });
    await user.keyboard("t");
    await screen.findByText("Moved 5 emails from Build Bot to Trash.");
    expect(state.requests.some((r) => r.route === "override")).toBe(true);
  });

  it("runs Clean up from mod+Enter, then shows Inbox cleared", async () => {
    const { state, user } = setup();
    await screen.findByRole("button", { name: "Clean up 14" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Clean up 14 emails in 4 sender groups?")).toBeTruthy();
    expect(screen.getByText("11 go to Trash and 3 to Archive. Nothing is permanently deleted. 4 groups below 86% stay here for you.")).toBeTruthy();
    await user.keyboard("{Enter}");
    await screen.findByText("14 emails cleaned up from 4 sender groups");
    expect(state.requests.filter((r) => r.route === "cleanup")[0]?.body).toMatchObject({ threshold: 0.86, actions: ["delete", "archive"] });
    expect(await screen.findByRole("heading", { name: "Inbox cleared" })).toBeTruthy();
    expect(screen.getByText("4 groups are waiting for your call. New mail gets sorted every 30 minutes.")).toBeTruthy();
  });

  it("rolls back a failed action and keeps focus on the row", async () => {
    const { user } = setup((s) => {
      s.failures.approve = { status: 500, code: "internal", times: 1 };
    });
    await screen.findByRole("complementary", { name: "Northwind Deals" });
    await user.keyboard("t");
    await screen.findByText("Something went wrong. Nothing was changed.");
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Northwind Deals/));
    expect(screen.getAllByRole("row")).toHaveLength(8);
  });

  it.each([
    ["nothing sure", (s: FakeApiState) => void (s.tau = 0.995), "Nothing is sure enough to clean up yet"],
    ["all caught up", (s: FakeApiState) => {
      s.items = [];
      s.accounts = s.accounts.map((a) => ({ ...a, sync: makeSync() }));
    }, "All caught up"],
    ["first sort", (s: FakeApiState) => void (s.items = []), "Sorting your mailbox"],
    ["no accounts", (s: FakeApiState) => void (s.accounts = []), "Connect a mailbox to start"],
  ])("shows the %s state", async (_name, mutate, heading) => {
    const { container } = setup(mutate);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("shows first-sort progress from inboxEstimate", async () => {
    setup((s) => void (s.items = []));
    await screen.findByRole("heading", { name: "Sorting your mailbox" });
    expect(screen.getByRole("progressbar", { name: "Sorting progress" }).getAttribute("aria-valuenow")).toBe("41");
  });

  it("shows the error state when everything fails", async () => {
    setup((s) => {
      for (const r of ["summary", "preview", "groups"] as const) s.failures[r] = { status: 500, code: "internal", times: 9 };
    });
    expect(await screen.findByRole("heading", { name: "Couldn't load Review" })).toBeTruthy();
  });

  it("shows the reconnect banner for an account that needs it", async () => {
    setup((s) => {
      s.accounts[0] = { ...s.accounts[0]!, status: "needs_reauth" };
    });
    expect(await screen.findByText("you@example.com needs to reconnect.")).toBeTruthy();
  });

  it("opens the slide-over at 1100px and returns focus to the row on Esc", async () => {
    setViewport(1100);
    const { user } = setup();
    const row = await screen.findByRole("row", { name: /^Contoso Orders/ });
    await user.click(within(row).getByText("Contoso Orders"));
    const dialog = await screen.findByRole("dialog", { name: "Contoso Orders" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Contoso Orders" })));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Contoso Orders" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("row", { name: /^Contoso Orders/ })));
  });

  it("offers Confirm all keeps on the Keep tab", async () => {
    const { user } = setup(undefined, "/review?tab=keep");
    await user.click(await screen.findByRole("button", { name: "Confirm all keeps" }));
    expect(await screen.findByText("Mark 2 emails in 1 sender group as Keep?")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/review/review-state.test.ts test/web/pages/review-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../../src/web/pages/review/review-state.ts` and `../../../src/web/pages/ReviewPage.tsx`.

- [ ] **Step 3: Implement `review-state.ts`**

`app/src/web/pages/review/review-state.ts`:

```ts
import type { AccountView, CleanupPreview, MeResponse, QueueSummary, SenderGroup } from "../../../shared/api.ts";
import type { RowMove } from "../../components/review/SenderGroupList.tsx";
import { catchUpFraction, newestTickAt } from "../../lib/account-status.ts";
import { isModelUnavailable } from "../../lib/confidence.ts";
import { relativeAgo } from "../../lib/format.ts";
import type { TabKey } from "../../lib/view-types.ts";

export type ReviewPageState = "loading" | "no_accounts" | "error" | "first_sort" | "all_caught_up" | "ready";
export type LoadStatus = "pending" | "error" | "success";

export function reviewPageState(i: {
  accounts: LoadStatus; accountCount: number; summary: LoadStatus; preview: LoadStatus; groups: LoadStatus;
  pendingTotal: number | null; backfilling: boolean;
}): ReviewPageState {
  if (i.accounts === "pending") return "loading";
  if (i.accounts === "success" && i.accountCount === 0) return "no_accounts";
  if (i.summary === "error" && i.preview === "error" && i.groups === "error") return "error";
  if (i.pendingTotal === 0) return i.backfilling ? "first_sort" : "all_caught_up";
  return "ready";
}

export function summaryCardState(preview: LoadStatus, summary: LoadStatus, previewCount: number): "loading" | "ready" | "nothing_sure" | "error" {
  if (preview === "error") return "error";
  if (preview === "pending" || summary === "pending") return "loading";
  return previewCount === 0 ? "nothing_sure" : "ready";
}

/** UI spec 5.1: preview.threshold, then summary.tauDelete, then me.tauDelete. Never a constant. */
export const resolveTau = (p?: CleanupPreview, s?: QueueSummary, m?: MeResponse): number | null =>
  p?.threshold ?? s?.tauDelete ?? m?.tauDelete ?? null;

const active = (accounts: readonly AccountView[]) => accounts.filter((a) => a.status === "active");
export const isBackfilling = (accounts: readonly AccountView[]): boolean => active(accounts).some((a) => !a.sync.backfillDone);
export const isCatchingUp = (accounts: readonly AccountView[]): boolean =>
  active(accounts).some((a) => !a.sync.backfillDone || a.sync.phase !== "incremental");

export function sortedMeta(accounts: readonly AccountView[], now: number): string {
  const tick = newestTickAt(accounts);
  const base = tick ? `Sorted ${relativeAgo(tick, now)}` : "Not sorted yet";
  return isCatchingUp(accounts) ? `${base} · catching up` : base;
}

export function tabCounts(s: QueueSummary | undefined): Record<TabKey, number | null> {
  if (!s) return { all: null, trash: null, archive: null, check: null, keep: null };
  return { all: s.groups, trash: s.groupsByAction.delete, archive: s.groupsByAction.archive, check: s.groupsByAction.unsure, keep: s.groupsByAction.keep };
}

export const modelUnavailableShare = (groups: readonly SenderGroup[]): number =>
  groups.length === 0 ? 0 : groups.filter(isModelUnavailable).length / groups.length;

export function moveTarget(keys: readonly string[], activeKey: string | null, to: RowMove): string | null {
  if (keys.length === 0) return null;
  const i = activeKey ? keys.indexOf(activeKey) : -1;
  const idx = { next: i + 1, prev: i - 1, first: 0, last: keys.length - 1, pagedown: i + 10, pageup: i - 10 }[to];
  return keys[Math.min(keys.length - 1, Math.max(0, idx))] ?? null;
}

/** UI spec 6.5: the next row at the same index, else the previous row. */
export function nextAfterRemoval(keys: readonly string[], removed: readonly string[]): string | null {
  const first = keys.findIndex((k) => removed.includes(k));
  const remaining = keys.filter((k) => !removed.includes(k));
  if (remaining.length === 0) return null;
  return remaining[Math.min(Math.max(first, 0), remaining.length - 1)] ?? null;
}

export function firstSortProgress(accounts: readonly AccountView[]): { value: number | null; sorted: number } {
  const sorted = accounts.reduce((sum, a) => sum + a.sync.messagesIngested, 0);
  const backfilling = active(accounts).filter((a) => !a.sync.backfillDone);
  const fractions = backfilling.map(catchUpFraction);
  if (fractions.length === 0 || fractions.some((f) => f === null)) return { value: null, sorted };
  const known = fractions as number[];
  return { value: known.reduce((s, f) => s + f, 0) / known.length, sorted };
}
```

- [ ] **Step 4: Implement `use-review-controller.ts`**

`app/src/web/pages/review/use-review-controller.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { flattenGroups, prefetchGroupDetail, useAccounts, useCleanupPreview, useGroupDetail, useGroups, useMe, useQueueSummary } from "../../api/queries.ts";
import type { BulkAction } from "../../components/review/SelectionToolbar.tsx";
import { displayName, rowId } from "../../components/review/SenderGroupRow.tsx";
import { providerName } from "../../lib/account-status.ts";
import type { CopyContext } from "../../lib/copy.ts";
import { formatCount, localResetTime, plural } from "../../lib/format.ts";
import { TAB_ACTION, TAB_KEYS, type ActionKind, type GroupSort, type TabKey } from "../../lib/view-types.ts";
import { useCleanup } from "../../state/CleanupProvider.tsx";
import { useAnnounce } from "../../state/LiveAnnouncer.tsx";
import { useOffline } from "../../state/offline.ts";
import { useDocumentTitle } from "../../state/use-document-title.ts";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { useNow } from "../../state/use-now.ts";
import { usePlatform } from "../../state/use-platform.ts";
import { useRouteFocus } from "../../state/use-route-focus.ts";
import { useSelection } from "../../state/use-selection.ts";
import {
  isBackfilling, modelUnavailableShare, moveTarget, nextAfterRemoval, resolveTau, reviewPageState, sortedMeta, summaryCardState, tabCounts,
  type LoadStatus,
} from "./review-state.ts";
import { useGroupActions, type GroupActionCallbacks } from "./use-group-actions.ts";
import { useItemActions } from "./use-item-actions.ts";
import { useNewSuggestions } from "./use-new-suggestions.ts";
import { useReviewHotkeys } from "./use-review-hotkeys.ts";
import { useReviewParams } from "./use-review-params.ts";
import { useScanNow } from "./use-scan-now.ts";

const EMPTY = "__empty__";
const HEADING = "__heading__";
const VERB: Record<ActionKind, string> = { delete: "moved to Trash", archive: "archived", keep: "kept" };
const status = (q: { isPending: boolean; isError: boolean }): LoadStatus => (q.isError ? "error" : q.isPending ? "pending" : "success");

export function useReviewController() {
  const params = useReviewParams();
  const { accountId, tab, sort } = params;
  const qc = useQueryClient();
  const now = useNow();
  const platform = usePlatform();
  const offline = useOffline();
  const announce = useAnnounce();
  const cleanup = useCleanup();
  const phase = cleanup.state.machine.phase;
  const me = useMe();
  const accountsQ = useAccounts();
  const summaryQ = useQueueSummary(accountId);
  const previewQ = useCleanupPreview(accountId, phase === "idle");
  const groupsQ = useGroups({ accountId, action: TAB_ACTION[tab], sort });
  const accounts = useMemo(() => accountsQ.data?.accounts ?? [], [accountsQ.data]);
  const accountsById = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);
  const scope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  const groups = useMemo(() => flattenGroups(groupsQ.data), [groupsQ.data]);
  const keys = useMemo(() => groups.map((g) => g.key), [groups]);
  const tau = resolveTau(previewQ.data, summaryQ.data, me.data);
  const activeKey = params.groupKey && keys.includes(params.groupKey) ? params.groupKey : (keys[0] ?? null);
  const activeGroup = groups.find((g) => g.key === activeKey) ?? null;
  const detailQ = useGroupDetail(activeKey);
  const selection = useSelection();
  const wide = useMediaQuery(BP.xl);
  const medium = useMediaQuery(BP.lg);
  const detailMode: "inline" | "slideover" | "sheet" = wide ? "inline" : medium ? "slideover" : "sheet";
  const [detailOpen, setDetailOpen] = useState(false);
  const pill = useNewSuggestions(summaryQ.data, groupsQ.dataUpdatedAt);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const emptyActionRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const asOf = detailQ.data?.pages[0]?.asOf ?? summaryQ.data?.asOf ?? new Date(now).toISOString();

  const callbacks: GroupActionCallbacks = {
    onRemoved: (removed) => {
      selection.remove(removed);
      if (activeKey && removed.includes(activeKey)) {
        const next = nextAfterRemoval(keys, removed);
        params.update({ group: next }, true);
        pendingFocus.current = next ?? EMPTY;
      }
    },
    onRestored: (key) => {
      params.update({ group: key }, true);
      pendingFocus.current = key;
    },
    onDelta: pill.applyDelta,
    errorContext: (id) => ({ providerLabel: providerName(accountsById[id]?.provider ?? "gmail"), resetTime: localResetTime(Date.now()) }),
    accountFor: (id) => accountsById[id],
  };
  const groupActions = useGroupActions(callbacks);
  const itemActions = useItemActions(groupActions, callbacks);
  const scan = useScanNow(accounts, accountId);

  const [prevPhase, setPrevPhase] = useState(phase);
  const [justCleaned, setJustCleaned] = useState(false);
  if (prevPhase !== phase) {
    setPrevPhase(phase);
    if ((prevPhase === "running" || prevPhase === "partial" || prevPhase === "done") && phase === "idle") setJustCleaned(true);
  }
  if (justCleaned && (previewQ.data?.count ?? 0) > 0) setJustCleaned(false);

  const focusRow = (key: string) => {
    const el = document.getElementById(rowId(key));
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === EMPTY) emptyActionRef.current?.focus();
    else if (target === HEADING) headingRef.current?.focus();
    else focusRow(target);
  });

  const phaseRef = useRef(phase);
  useEffect(() => {
    const was = phaseRef.current;
    phaseRef.current = phase;
    if (was === "confirming" && phase === "idle") summaryButtonRef.current?.focus();
    else if ((was === "running" || was === "partial") && phase === "idle" && document.activeElement === document.body) {
      if (emptyActionRef.current) emptyActionRef.current.focus();
      else if (activeKey) focusRow(activeKey);
    }
  }, [phase, activeKey]);

  const { key: locationKey } = useLocation();
  const rowFocused = useRef(locationKey === "default");
  useRouteFocus(titleRef, groups.length === 0);
  useEffect(() => {
    if (rowFocused.current || !activeKey) return;
    rowFocused.current = true;
    focusRow(activeKey);
  }, [activeKey]);

  useEffect(() => {
    const i = activeKey ? keys.indexOf(activeKey) : -1;
    const next = keys[i + 1];
    if (next) void prefetchGroupDetail(qc, next);
  }, [activeKey, keys, qc]);

  useEffect(() => {
    const n = selection.selected.size;
    if (n === 0) return;
    const t = setTimeout(() => announce(`${plural(n, "group", "groups")} selected`), 300);
    return () => clearTimeout(t);
  }, [selection.selected.size, announce]);

  useEffect(() => {
    if (pill.show) announce("New suggestions are ready. Refresh to see them.");
  }, [pill.show, announce]);

  const activate = useCallback(
    (key: string, opts: { openDetail: boolean; keyboard?: boolean }) => {
      params.update({ group: key }, true);
      selection.setAnchor(key);
      if (!opts.openDetail) return;
      if (detailMode !== "inline") {
        setDetailOpen(true);
        pendingFocus.current = HEADING;
      } else if (opts.keyboard) pendingFocus.current = HEADING;
    },
    [detailMode, params, selection],
  );

  const move = (to: Parameters<typeof moveTarget>[2]) => {
    const target = moveTarget(keys, activeKey, to);
    if (!target) return;
    params.update({ group: target }, true);
    selection.setAnchor(target);
    pendingFocus.current = target;
  };

  const closeDetail = () => {
    setDetailOpen(false);
    if (activeKey) pendingFocus.current = activeKey;
  };

  const performAction = async (target: ActionKind) => {
    if (offline || cleanup.busyPhase === "preparing") return;
    if (selection.selected.size > 0) {
      await groupActions.bulk(groups.filter((g) => selection.selected.has(g.key) && !groupActions.busyKeys.has(g.key)), target, asOf);
      return;
    }
    if (!activeGroup || groupActions.busyKeys.has(activeGroup.key) || groupActions.exitingKeys.has(activeGroup.key)) return;
    const i = keys.indexOf(activeGroup.key);
    const next = groups[i + 1] ?? groups[i - 1];
    if (await groupActions.act(activeGroup, target, asOf)) {
      announce(`${displayName(activeGroup).text} ${VERB[target]}.${next ? ` Next: ${displayName(next).text}.` : ""}`);
    }
  };

  const bulkAction = (action: BulkAction) => {
    if (action === "approve") {
      void groupActions.bulk(groups.filter((g) => selection.selected.has(g.key)), "approve", asOf);
    } else void performAction(action);
  };

  const selectAllInTab = async () => {
    let data = groupsQ.data;
    let more = groupsQ.hasNextPage;
    while (more && flattenGroups(data).length < 1000) {
      const r = await groupsQ.fetchNextPage();
      data = r.data;
      more = r.hasNextPage;
    }
    selection.selectAll(flattenGroups(data).slice(0, 1000).map((g) => g.key));
  };

  const changeTab = (t: TabKey) => {
    params.update({ tab: t, group: null });
    selection.clear();
  };
  const changeSort = (s: GroupSort) => {
    params.update({ sort: s, group: null });
    selection.clear();
  };
  const changeAccount = (v: string) => {
    params.update({ account: v === "all" ? null : v, group: null });
    selection.clear();
  };

  const summaryState = summaryCardState(status(previewQ), status(summaryQ), previewQ.data?.count ?? 0);
  const startCleanup = () => {
    if (offline || summaryState !== "ready" || phase !== "idle") return;
    cleanup.start("cleanup", accountId);
  };

  const pageState = reviewPageState({
    accounts: status(accountsQ), accountCount: accounts.length, summary: status(summaryQ), preview: status(previewQ),
    groups: status(groupsQ), pendingTotal: summaryQ.data?.pending.total ?? null, backfilling: isBackfilling(scope),
  });

  useReviewHotkeys(
    {
      move,
      toggleActive: () => activeKey && selection.toggle(activeKey),
      rangeToActive: () => activeKey && selection.range(activeKey, keys),
      act: (a) => void performAction(a),
      cleanUp: startCleanup,
      tab: (i) => {
        const t = TAB_KEYS[i];
        if (t) changeTab(t);
      },
      escape: () => selection.selected.size > 0 && selection.clear(),
    },
    pageState === "ready",
  );

  const groupCount = summaryQ.data?.groups ?? 0;
  useDocumentTitle(groupCount > 0 ? `(${formatCount(groupCount)}) Review · Clearbox` : "Review · Clearbox");

  const inactive = scope.find((a) => a.status === "needs_reauth") ?? null;
  const providers = [...new Set(scope.map((a) => a.provider))];
  const copyContext: CopyContext = {
    pendingTotal: summaryQ.data?.pending.total ?? 0,
    accountEmail: accountId ? (accountsById[accountId]?.email ?? null) : null,
    inactiveEmail: inactive?.email ?? null,
    providerLabel: providers.length === 1 && providers[0] ? providerName(providers[0]) : "Your mail provider",
    resetTime: localResetTime(now),
  };

  return {
    params, tab, sort, accountId, now, platform, offline, cleanup, me, accounts, accountsById, scope, groups, keys, tau,
    activeKey, activeGroup, detailQ, selection, detailMode, detailOpen, pill, titleRef, headingRef, summaryButtonRef, emptyActionRef,
    groupActions, itemActions, scan, justCleaned, summaryQ, previewQ, groupsQ, summaryState, pageState, copyContext,
    meta: sortedMeta(scope, now), counts: tabCounts(summaryQ.data), modelShare: modelUnavailableShare(groups), asOf,
    activate, move, closeDetail, performAction, bulkAction, selectAllInTab, changeTab, changeSort, changeAccount, startCleanup,
  };
}

export type ReviewController = ReturnType<typeof useReviewController>;
```

- [ ] **Step 5: Implement `ReviewWorkArea.tsx`**

`app/src/web/pages/review/ReviewWorkArea.tsx`:

```tsx
import { DetailPanel } from "../../components/review/DetailPanel.tsx";
import { SenderGroupList } from "../../components/review/SenderGroupList.tsx";
import { startOAuth } from "../../lib/oauth-return.ts";
import type { ReviewController } from "./use-review-controller.ts";

/** List plus detail (UI spec 4.7, 4.14). Uses overflow-clip so the sticky header still sticks to the page. */
export function ReviewWorkArea({ c }: { c: ReviewController }) {
  const g = c.activeGroup;
  const detailPages = c.detailQ.data?.pages ?? [];
  const inline = c.detailMode === "inline" && g !== null;
  const tau = c.tau ?? 0;
  return (
    <div className={`overflow-clip rounded-b-xl border border-t-0 border-line bg-surface ${inline ? "xl:grid xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}>
      <div className={`min-w-0 ${inline ? "xl:border-r xl:border-line" : ""}`}>
        <SenderGroupList
          state={c.groupsQ.isPending ? "loading" : c.groupsQ.isError ? "error" : c.groups.length === 0 ? "empty" : "ready"}
          tab={c.tab}
          groups={c.groups}
          tau={tau}
          accountsById={c.accountsById}
          showAccount={c.accounts.length > 1 && !c.accountId}
          activeKey={c.activeKey}
          selected={c.selection.selected}
          busyKeys={c.groupActions.busyKeys}
          exitingKeys={c.groupActions.exitingKeys}
          totalInTab={c.counts[c.tab]}
          hasNextPage={c.groupsQ.hasNextPage}
          isFetchingNextPage={c.groupsQ.isFetchingNextPage}
          bulkProgress={c.groupActions.bulkProgress}
          platform={c.platform}
          onActivate={c.activate}
          onToggleSelect={(key, o) => (o.range ? c.selection.range(key, c.keys) : c.selection.toggle(key))}
          onSelectAllLoaded={() => c.selection.selectAll(c.keys)}
          onSelectAllInTab={() => void c.selectAllInTab()}
          onClearSelection={c.selection.clear}
          onBulkAction={c.bulkAction}
          onLoadMore={() => void c.groupsQ.fetchNextPage()}
          onRetry={() => void c.groupsQ.refetch()}
          onMove={c.move}
        />
      </div>
      <DetailPanel
        mode={c.detailMode}
        open={c.detailMode === "inline" ? g !== null : c.detailOpen}
        group={g}
        items={detailPages.flatMap((p) => p.items.items)}
        detailState={c.detailQ.isPending ? "loading" : c.detailQ.isError ? "error" : "ready"}
        hasMoreItems={c.detailQ.hasNextPage}
        loadingMoreItems={c.detailQ.isFetchingNextPage}
        tau={tau}
        account={g ? (c.accountsById[g.accountId] ?? null) : null}
        busyAction={c.groupActions.busyAction && g && c.groupActions.busyAction.key === g.key ? c.groupActions.busyAction.action : null}
        busyItemIds={c.itemActions.busyItemIds}
        now={c.now}
        platform={c.platform}
        headingRef={c.headingRef}
        onAction={(a) => void c.performAction(a)}
        onAlwaysKeep={(entry) => g && void c.itemActions.alwaysKeep(g, entry, c.asOf)}
        onAlwaysTrash={() => g && void c.itemActions.alwaysTrash(g)}
        onCopyAddress={() => g && void c.itemActions.copyAddress(g)}
        onItemAction={(id, a) => {
          const item = detailPages.flatMap((p) => p.items.items).find((i) => i.id === id);
          if (g && item) void c.itemActions.itemAction(g, item, a);
        }}
        onLoadMoreItems={() => void c.detailQ.fetchNextPage()}
        onClose={c.closeDetail}
        onRetry={() => void c.detailQ.refetch()}
        onReconnect={(a) => startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email })}
      />
    </div>
  );
}
```

- [ ] **Step 6: Implement `ReviewPage.tsx`**

`app/src/web/pages/ReviewPage.tsx`:

```tsx
import { useNavigate } from "react-router";
import { ActionTabs } from "../components/review/ActionTabs.tsx";
import { CleanupBar } from "../components/review/CleanupBar.tsx";
import { SummaryCard } from "../components/review/SummaryCard.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { ProgressBar } from "../components/ui/ProgressBar.tsx";
import { Select } from "../components/ui/Select.tsx";
import { formatCount } from "../lib/format.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import { firstSortProgress, isCatchingUp } from "./review/review-state.ts";
import { ReviewWorkArea } from "./review/ReviewWorkArea.tsx";
import { useReviewController, type ReviewController } from "./review/use-review-controller.ts";

function Header({ c }: { c: ReviewController }) {
  const options = [{ value: "all", label: "All accounts" }, ...c.accounts.map((a) => ({ value: a.id, label: a.email }))];
  return (
    <PageHeader
      title="Review"
      titleRef={c.titleRef}
      meta={c.accounts.length > 0 ? c.meta : undefined}
      actions={
        <>
          <Select label="Account" value={c.accountId ?? "all"} options={options} onChange={c.changeAccount} className="w-[160px]" />
          <Button variant="ghost" icon="refresh" loading={c.scan.scanning} loadingLabel="Scanning…" softDisabled={c.offline} onClick={() => void c.scan.run()}>
            Scan now
          </Button>
        </>
      }
    />
  );
}

function PageStates({ c }: { c: ReviewController }) {
  const navigate = useNavigate();
  if (c.pageState === "no_accounts") {
    return (
      <EmptyState variant="page" title="Connect a mailbox to start" body="Clearbox sorts Gmail and Outlook. Setup takes about a minute."
        action={{ label: "Set up Clearbox", variant: "primary", onClick: () => void navigate("/setup") }} />
    );
  }
  if (c.pageState === "error") {
    return (
      <EmptyState variant="page" title="Couldn't load Review" body="Check your connection, then try again."
        action={{ label: "Try again", onClick: () => void Promise.all([c.summaryQ.refetch(), c.previewQ.refetch(), c.groupsQ.refetch()]) }} />
    );
  }
  if (c.pageState === "all_caught_up") {
    return (
      <EmptyState variant="page" title="All caught up" body="Nothing needs your attention. New mail gets sorted every 30 minutes."
        action={{ label: "Scan now", onClick: () => void c.scan.run() }} actionRef={c.emptyActionRef} />
    );
  }
  const progress = firstSortProgress(c.scope);
  return (
    <EmptyState variant="page" title="Sorting your mailbox" body="Clearbox reads your newest emails first. Your first suggestions appear within a few minutes.">
      <div className="mx-auto mb-2 max-w-[340px]">
        <ProgressBar value={progress.value} tone="archive" height={6} label="Sorting progress" />
      </div>
      <p className="text-small text-ink-3">{`${formatCount(progress.sorted)} emails sorted so far`}</p>
    </EmptyState>
  );
}

export function ReviewPage() {
  const c = useReviewController();
  const preview = c.previewQ.data ?? null;
  const summary = c.summaryQ.data;
  const ready = c.pageState === "ready" || c.pageState === "loading";
  const confirmKeeps = c.tab === "keep" && c.groups.length > 0
    ? { onClick: () => c.cleanup.start("confirm_keeps", c.accountId), busy: c.cleanup.busyPhase === "preparing" && c.cleanup.state.mode === "confirm_keeps" }
    : null;
  return (
    <>
      <Header c={c} />
      <AppBanners page="review" awaitingModel={summary?.awaitingModel ?? 0} modelUnavailableShare={c.modelShare} />
      {!ready ? (
        <PageStates c={c} />
      ) : (
        <>
          {c.justCleaned && preview?.count === 0 && (summary?.groups ?? 0) > 0 ? (
            <div className="mb-4">
              <EmptyState variant="panel" title="Inbox cleared"
                body={`${formatCount(summary?.groups ?? 0)} ${summary?.groups === 1 ? "group is" : "groups are"} waiting for your call. New mail gets sorted every 30 minutes.`}
                action={{ label: `Review the ${formatCount(summary?.groups ?? 0)} groups`, onClick: () => c.changeTab("all") }}
                actionRef={c.emptyActionRef} />
            </div>
          ) : (
            <SummaryCard
              state={c.summaryState}
              preview={preview}
              pendingTotal={summary?.pending.total ?? 0}
              awaitingModel={summary?.awaitingModel ?? 0}
              groupsLeft={preview && typeof preview.groupsLeft === "number" ? preview.groupsLeft : null}
              tau={c.tau ?? 0}
              catchingUp={isCatchingUp(c.scope)}
              cleanupPhase={c.cleanup.busyPhase}
              offline={c.offline}
              platform={c.platform}
              onCleanUp={c.startCleanup}
              onRetry={() => void c.previewQ.refetch()}
              buttonRef={c.summaryButtonRef}
            />
          )}
          <ActionTabs
            value={c.tab}
            counts={c.counts}
            onChange={c.changeTab}
            sort={c.sort}
            onSortChange={c.changeSort}
            newSuggestions={c.pill.show}
            onRefresh={() => void c.groupsQ.refetch()}
            confirmKeeps={confirmKeeps}
          />
          <ReviewWorkArea c={c} />
          <CleanupBar
            context={c.copyContext}
            platform={c.platform}
            onReconnect={() => {
              const a = c.scope.find((x) => x.status === "needs_reauth");
              if (a) startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email });
            }}
          />
        </>
      )}
    </>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/review/review-state.test.ts test/web/pages/review-page.test.tsx`
Expected: PASS (5 + 14 tests). If the keyboard test times out waiting for focus, confirm the row exit delay is 400 ms (`rowExitDelayMs`) and that `waitFor` uses its default 1,000 ms timeout.

- [ ] **Step 8: Commit**

```bash
git add app/src/web/pages/review app/src/web/pages/ReviewPage.tsx app/test/web/pages
git commit -m "feat(web): add the Review page with keyboard triage, optimistic actions and Clean up"
```

---

### Task 19: Insights page

**Files:**
- Create: `app/src/web/components/ui/Panel.tsx`, under `app/src/web/components/insights/`: `StatLine.tsx`, `WeeklyChart.tsx`, `BudgetPanel.tsx`, `ThresholdTable.tsx`; `app/src/web/pages/InsightsPage.tsx`
- Test: `app/test/web/pages/insights-page.test.tsx`

**Interfaces:**
- Consumes: `useInsights`, `useMe`, `useAccounts` (Task 5), `Table`, `ProgressBar`, `EmptyState`, `SkeletonLine`, `Icon`, `cssVars` (Tasks 7, 8), `AccountStatusItem` (Task 16), `AppBanners`, `PageHeader`, `useDocumentTitle`, `useRouteFocus` (Task 16), `deriveAccountUiStatus`, `backlogRemaining`, `dailyRateFrom`, `etaText`, `minutesUntil`, `formatPercent`, `formatCount`, `toPercent`, `relativeAgo`, `localResetTime`, `formatDayMonth`, `formatUsd`, `formatMb` (Task 3).
- Produces: `Panel({ title, meta?, children, className? })`, `StatLine({ value, text, sub? })`, `WeeklyChart({ weeks, state })`, `BudgetPanel({ insights, freeTier, now, budgetExhausted })`, `backlogText(account, rate, now)`, `ThresholdTable({ calibration })`, `InsightsPage()` (route `/insights`).

- [ ] **Step 1: Write the failing test**

`app/test/web/pages/insights-page.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsPage } from "../../../src/web/pages/InsightsPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import { type FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<InsightsPage />, { path: "/insights" }) };
}

describe("Insights page", () => {
  it("states agreement, threshold, decisions, weekly chart, budget and calibration", async () => {
    const { container } = setup();
    const match = await screen.findByRole("region", { name: "How well Clearbox matches you" });
    expect(await within(match).findByText("98.6%")).toBeTruthy();
    expect(within(match).getByText("of trash suggestions you agreed with (target 98%)")).toBeTruthy();
    expect(within(match).getByText("86%")).toBeTruthy();
    expect(screen.getByText("current Clean up threshold, tuned nightly from your choices")).toBeTruthy();
    expect(screen.getByText("Last tuned 9 h ago")).toBeTruthy();
    expect(screen.getByText("decisions learned from you (312 this week)")).toBeTruthy();
    const chart = screen.getByRole("group", { name: /^Emails cleaned per week: .*this week 1,284$/ });
    expect(within(chart).getAllByRole("button")).toHaveLength(6);
    expect(screen.getByText("This week: 1,284 cleaned, 18 undone")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Accounts and daily budget" });
    expect(within(table).getByRole("cell", { name: "11,800 emails · about 2 days" })).toBeTruthy();
    expect(within(table).getByText("Catching up")).toBeTruthy();
    expect(screen.getByText("Cloudflare free tier · resets 00:00")).toBeTruthy();
    expect(screen.getByText("21,080 of 90,000 daily writes used (23%)")).toBeTruthy();
    expect(screen.getByText("AI model today: 3,412 calls, 2 failed, about $0.06")).toBeTruthy();
    expect(screen.getByText("Storage: 182 MB of 500 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Daily writes used" }).getAttribute("aria-valuenow")).toBe("23");
    expect(screen.getByText("How the threshold was chosen")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(document.title).toBe("Insights · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("explains insufficient data", async () => {
    setup((s) => {
      s.insights = {
        ...s.insights,
        precision: { ...s.insights.precision, deletePrecision: null },
        calibration: { ...s.insights.calibration, outcome: "insufficient_data", ranAt: null, points: [] },
        labels: { total: 0, last7Days: 0 },
      };
    });
    expect(await screen.findByText("Not enough trash decisions yet. Clearbox measures this after 50.")).toBeTruthy();
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(screen.getByText("starting Clean up threshold. Clearbox tunes it after 50 trash decisions.")).toBeTruthy();
    expect(screen.getByText("No decisions yet. Every Clean up and choice teaches Clearbox.")).toBeTruthy();
    expect(screen.getByText("Not enough decisions yet.")).toBeTruthy();
  });

  it("shows the budget at 100% and the paid tier", async () => {
    const { state } = setup((s) => {
      s.insights = { ...s.insights, budget: { ...s.insights.budget, rowsWritten: 90_000 } };
      s.me = { ...s.me, issues: [{ code: "budget_exhausted_today", since: iso(T0), accountId: null }] };
    });
    expect(await screen.findByText("90,000 of 90,000 daily writes used (100%). Sorting resumes after 00:00.")).toBeTruthy();
    expect(screen.getByText("Today's free-tier limit is reached.")).toBeTruthy();
    expect(state.requests.some((r) => r.route === "insights")).toBe(true);
  });

  it("hides the write meter on Workers Paid", async () => {
    setup((s) => {
      s.me = { ...s.me, freeTier: false };
    });
    expect(await screen.findByText("Workers Paid · no daily write cap")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: "Daily writes used" })).toBeNull();
  });

  it("shows a panel error with Try again", async () => {
    setup((s) => {
      s.failures.insights = { status: 500, code: "internal", times: 9 };
    });
    expect(await screen.findByRole("heading", { name: "Couldn't load insights." })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/insights-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/pages/InsightsPage.tsx`.

- [ ] **Step 3: Implement `Panel.tsx`, `StatLine.tsx`, `ThresholdTable.tsx`**

`app/src/web/components/ui/Panel.tsx`:

```tsx
import { useId, type ReactNode } from "react";

export function Panel({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string | undefined }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`rounded-xl border border-line bg-surface ${className ?? ""}`}>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <h2 id={id} className="font-semibold text-ink">{title}</h2>
        {meta ? <span className="ml-auto text-small text-ink-3">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
```

`app/src/web/components/insights/StatLine.tsx`:

```tsx
export function StatLine({ value, text, sub }: { value: string; text: string; sub?: string | undefined }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
      <span className="min-w-[90px] text-stat font-heading text-ink">{value}</span>
      <span className="text-ink-3">
        {text}
        {sub ? <span className="block text-small">{sub}</span> : null}
      </span>
    </div>
  );
}
```

`app/src/web/components/insights/ThresholdTable.tsx`:

```tsx
import type { Insights } from "../../../shared/api.ts";
import { toPercent } from "../../lib/confidence.ts";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { Icon } from "../ui/icons.tsx";
import { Table } from "../ui/Table.tsx";

type Point = Insights["calibration"]["points"][number];

export function ThresholdTable({ calibration }: { calibration: Insights["calibration"] }) {
  const current = toPercent(calibration.tauDelete);
  return (
    <details className="group mt-3.5 rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-semibold text-ink">
        How the threshold was chosen
        <Icon name="chevron-down" size={14} className="text-ink-3 motion-safe:transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line">
        <p className="px-4 py-3 text-small text-ink-3">
          Each row shows how often you agreed with trash suggestions at that threshold. Clearbox picks the lowest threshold with at least 20 decisions and 98% agreement.
        </p>
        <Table<Point>
          caption="Threshold calibration"
          state={calibration.points.length === 0 ? "empty" : "ready"}
          emptyText="Not enough decisions yet."
          rows={calibration.points}
          rowKey={(p) => p.tau}
          columns={[
            {
              key: "tau", header: "Threshold",
              render: (p) => (
                <span className="inline-flex items-center gap-2">
                  {`${toPercent(p.tau)}%`}
                  {toPercent(p.tau) === current ? <span className="rounded-sm bg-surface-sunk px-1.5 text-meta font-emphasis text-ink-2">Current</span> : null}
                </span>
              ),
            },
            { key: "support", header: "Decisions", align: "right", render: (p) => formatCount(p.support) },
            { key: "precision", header: "Agreement", render: (p) => (p.precision === null ? "n/a" : formatPercent(p.precision, 1)) },
          ]}
        />
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Implement `WeeklyChart.tsx`**

`app/src/web/components/insights/WeeklyChart.tsx`:

```tsx
import type { Insights } from "../../../shared/api.ts";
import { formatCount, formatDayMonth } from "../../lib/format.ts";
import { cssVars } from "../ui/css-vars.ts";
import { SHIMMER } from "../ui/Skeleton.tsx";

export interface WeeklyChartProps {
  weeks: Insights["weekly"];
  state: "loading" | "ready" | "empty";
}

const SKELETON_HEIGHTS = ["h-[30%]", "h-[60%]", "h-[45%]", "h-[75%]", "h-[55%]", "h-[90%]"];

export function WeeklyChart({ weeks, state }: WeeklyChartProps) {
  if (state === "loading") {
    return (
      <div aria-hidden="true" className="flex h-[120px] items-end gap-1.5 px-4 pt-3.5 pb-1.5">
        {SKELETON_HEIGHTS.map((h) => <span key={h} className={`flex-1 rounded-t-[4px] rounded-b-[2px] ${h} ${SHIMMER}`} />)}
      </div>
    );
  }
  const max = Math.max(1, ...weeks.map((w) => w.cleaned));
  const label = (i: number, w: (typeof weeks)[number]) => (i === weeks.length - 1 ? "This week" : formatDayMonth(w.weekStart, true));
  const summary = weeks.map((w, i) => `${i === weeks.length - 1 ? "this week" : formatDayMonth(w.weekStart, true)} ${formatCount(w.cleaned)}`).join(", ");
  const last = weeks[weeks.length - 1];
  return (
    <>
      <div role="group" aria-label={`Emails cleaned per week: ${summary}`} className="flex h-[120px] items-end gap-1.5 px-4 pt-3.5 pb-1.5">
        {weeks.map((w, i) => (
          <div key={w.weekStart} className="group relative flex h-full flex-1 items-end">
            <span
              role="button"
              tabIndex={0}
              aria-label={`${label(i, w)}: ${formatCount(w.cleaned)} cleaned, ${formatCount(w.undone)} undone`}
              className={`cb-bar-height block min-h-[2px] w-full rounded-t-[4px] rounded-b-[2px] outline-offset-2 ${i === weeks.length - 1 ? "bg-accent" : "bg-accent-bar"}`}
              style={cssVars({ "--cb-value": w.cleaned / max })}
            />
            <span aria-hidden="true" className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 rounded-sm bg-inverse px-1.5 py-0.5 text-meta whitespace-nowrap text-on-inverse group-focus-within:block group-hover:block">
              {`${formatCount(w.cleaned)} cleaned · ${formatCount(w.undone)} undone`}
            </span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-1.5 px-4 text-meta text-ink-3">
        {weeks.map((w, i) => <span key={w.weekStart} className="flex-1 text-center">{label(i, w)}</span>)}
      </div>
      <p className="px-4 pt-1 pb-3 text-small text-ink-3">
        {state === "empty" || !last ? "No Clean ups yet. Your first one will show up here." : `This week: ${formatCount(last.cleaned)} cleaned, ${formatCount(last.undone)} undone`}
      </p>
      <table className="sr-only">
        <caption>Emails cleaned per week</caption>
        <thead><tr><th scope="col">Week</th><th scope="col">Cleaned</th><th scope="col">Undone</th></tr></thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.weekStart}><td>{label(i, w)}</td><td>{formatCount(w.cleaned)}</td><td>{formatCount(w.undone)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 5: Implement `BudgetPanel.tsx`**

`app/src/web/components/insights/BudgetPanel.tsx`:

```tsx
import type { Insights } from "../../../shared/api.ts";
import { backlogRemaining, dailyRateFrom, deriveAccountUiStatus, etaText, minutesUntil } from "../../lib/account-status.ts";
import { formatCount, formatMb, formatUsd, localResetTime, relativeAgo } from "../../lib/format.ts";
import { AccountStatusItem } from "../shell/AccountStatusItem.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { Table } from "../ui/Table.tsx";

type Row = Insights["accounts"][number];

export function backlogText(a: Row, rate: number, now: number): string {
  const status = deriveAccountUiStatus({ ...a, statusReason: null, archiveSupported: true, createdAt: "" }, now);
  if (status === "up_to_date") return "0";
  if (status === "waiting") return `Retrying in ${a.sync.backoffUntil ? minutesUntil(a.sync.backoffUntil, now) : 1} min`;
  if (status !== "catching_up") return "Paused";
  const remaining = backlogRemaining(a);
  return remaining === null
    ? `Sorting, ${formatCount(a.sync.messagesIngested)} so far`
    : `${formatCount(remaining)} emails · ${etaText(remaining, rate)}`;
}

export interface BudgetPanelProps {
  insights: Insights;
  freeTier: boolean;
  now: number;
  budgetExhausted: boolean;
}

export function BudgetPanel({ insights, freeTier, now, budgetExhausted }: BudgetPanelProps) {
  const b = insights.budget;
  const rate = dailyRateFrom(insights.history);
  const pct = Math.min(100, Math.round((b.rowsWritten / b.rowsCap) * 100));
  const reset = localResetTime(now);
  const full = budgetExhausted || b.rowsWritten >= b.rowsCap;
  const writes = `${formatCount(b.rowsWritten)} of ${formatCount(b.rowsCap)} daily writes used (${pct}%)`;
  return (
    <>
      <Table<Row>
        caption="Accounts and daily budget"
        state={insights.accounts.length === 0 ? "empty" : "ready"}
        emptyText="No accounts connected. Connect one in Accounts."
        rows={insights.accounts}
        rowKey={(a) => a.id}
        columns={[
          { key: "account", header: "Account", render: (a) => <b className="font-emphasis text-ink">{a.email}</b> },
          {
            key: "status", header: "Status",
            render: (a) => {
              const view = { ...a, statusReason: null, archiveSupported: true, createdAt: "" };
              return <AccountStatusItem account={view} status={deriveAccountUiStatus(view, now)} catchUpPercent={null} variant="inline" now={now} onReconnect={() => undefined} />;
            },
          },
          { key: "backlog", header: "Backlog", render: (a) => backlogText(a, rate, now) },
          { key: "last", header: "Last sorted", render: (a) => (a.sync.lastTickAt ? relativeAgo(a.sync.lastTickAt, now) : "Not yet") },
          { key: "pending", header: "Pending", align: "right", render: (a) => formatCount(a.sync.pendingCount) },
        ]}
      />
      <div className="flex flex-col gap-1.5 border-t border-line-subtle px-4 py-3">
        {freeTier ? (
          <>
            <ProgressBar value={b.rowsWritten / b.rowsCap} tone="accent" height={6} label="Daily writes used" valueText={writes} />
            <p className="text-small text-ink-3">{full ? `${writes}. Sorting resumes after ${reset}.` : writes}</p>
          </>
        ) : null}
        <p className="text-small text-ink-3">
          {`AI model today: ${formatCount(b.decisionCalls)} calls, ${formatCount(b.decisionFailures)} failed, ${formatUsd(b.estimatedDecisionCostUsd)}`}
        </p>
        <p className="text-small text-ink-3">{`Storage: ${formatMb(b.dbSizeBytes)} of ${formatMb(b.dbSizeLimitBytes)}`}</p>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Implement `InsightsPage.tsx`**

`app/src/web/pages/InsightsPage.tsx`:

```tsx
import { useRef } from "react";
import { useAccounts, useInsights, useMe } from "../api/queries.ts";
import { BudgetPanel } from "../components/insights/BudgetPanel.tsx";
import { StatLine } from "../components/insights/StatLine.tsx";
import { ThresholdTable } from "../components/insights/ThresholdTable.tsx";
import { WeeklyChart } from "../components/insights/WeeklyChart.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { Panel } from "../components/ui/Panel.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { toPercent } from "../lib/confidence.ts";
import { formatCount, formatPercent, localResetTime, relativeAgo } from "../lib/format.ts";
import type { Insights } from "../../shared/api.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";

function thresholdText(outcome: Insights["calibration"]["outcome"]): string {
  if (outcome === "calibrated") return "current Clean up threshold, tuned nightly from your choices";
  if (outcome === "no_tau_meets_target") {
    return "highest Clean up threshold. Your recent choices often disagreed with trash suggestions, so Clearbox is being extra careful.";
  }
  return "starting Clean up threshold. Clearbox tunes it after 50 trash decisions.";
}

function MatchPanel({ data, now }: { data: Insights; now: number }) {
  const p = data.precision.deletePrecision;
  return (
    <Panel title="How well Clearbox matches you">
      <StatLine
        value={p === null ? "n/a" : formatPercent(p, 1)}
        text={p === null ? "Not enough trash decisions yet. Clearbox measures this after 50." : "of trash suggestions you agreed with (target 98%)"}
      />
      <StatLine
        value={`${toPercent(data.calibration.tauDelete)}%`}
        text={thresholdText(data.calibration.outcome)}
        sub={data.calibration.ranAt ? `Last tuned ${relativeAgo(data.calibration.ranAt, now)}` : undefined}
      />
      <StatLine
        value={formatCount(data.labels.total)}
        text={data.labels.total === 0 ? "No decisions yet. Every Clean up and choice teaches Clearbox." : `decisions learned from you (${formatCount(data.labels.last7Days)} this week)`}
      />
    </Panel>
  );
}

export function InsightsPage() {
  useDocumentTitle("Insights · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const insights = useInsights();
  const me = useMe();
  const accounts = useAccounts();
  const now = useNow();
  const awaiting = (accounts.data?.accounts ?? []).reduce((sum, a) => sum + a.sync.awaitingModelCount, 0);
  const data = insights.data;
  const freeTier = me.data?.freeTier ?? true;
  return (
    <div className="max-w-[1040px]">
      <PageHeader title="Insights" titleRef={titleRef} />
      <AppBanners page="insights" awaitingModel={awaiting} />
      {insights.isError ? (
        <EmptyState variant="panel" title="Couldn't load insights." body="Check your connection, then try again." action={{ label: "Try again", onClick: () => void insights.refetch() }} />
      ) : !data ? (
        <div aria-busy="true" className="flex flex-col gap-3.5">
          <span className="sr-only">Loading insights</span>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
              <SkeletonLine width={200} height={14} />
              <SkeletonLine width="80%" />
              <SkeletonLine width="60%" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.4fr_1fr]">
            <MatchPanel data={data} now={now} />
            <Panel title="Emails cleaned per week">
              <WeeklyChart weeks={data.weekly} state={data.weekly.every((w) => w.cleaned === 0) ? "empty" : "ready"} />
            </Panel>
          </div>
          <Panel
            className="mt-3.5"
            title="Accounts and daily budget"
            meta={freeTier ? `Cloudflare free tier · resets ${localResetTime(now)}` : "Workers Paid · no daily write cap"}
          >
            <BudgetPanel
              insights={data}
              freeTier={freeTier}
              now={now}
              budgetExhausted={(me.data?.issues ?? []).some((i) => i.code === "budget_exhausted_today")}
            />
          </Panel>
          <ThresholdTable calibration={data.calibration} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/insights-page.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add app/src/web/components/ui/Panel.tsx app/src/web/components/insights app/src/web/pages/InsightsPage.tsx app/test/web/pages/insights-page.test.tsx
git commit -m "feat(web): add the Insights page with agreement, weekly chart, budget and calibration"
```

---

### Task 20: Activity page

**Files:**
- Create: `app/src/web/lib/activity.ts`, `app/src/web/pages/ActivityPage.tsx`
- Test: `app/test/web/lib/activity.test.ts`, `app/test/web/pages/activity-page.test.tsx`

**Interfaces:**
- Consumes: `useActivity`, `useBatches`, `useAccounts` (Task 5), `api.undoBatch` (Task 4), `invalidateAfterActions` (Task 5), `undoResultMessage` (Task 9), `Table`, `Button`, `LinkButton`, `Select`, `Panel` (Tasks 7, 8, 19), `PageHeader`, `AppBanners` (Task 16), `startOAuth` (Task 16), `activityWhen`, `plural`, `formatCount`, `toPercent` (Task 3).
- Produces:
  - `activity.ts`: `type ActivityLast = { kind: "undo"; batchId: number } | { kind: "undone" } | { kind: "expired" } | { kind: "reconnect"; account: AccountView } | { kind: "route"; label: string; to: string } | null`, `interface ActivityRow { verb; detail; result; account; last }`, `describeActivity(entry, ctx: { accountsById; batchesById })`.
  - `ActivityPage()` (route `/activity`, search param `account`).

- [ ] **Step 1: Write the failing tests**

`app/test/web/lib/activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeActivity } from "../../../src/web/lib/activity.ts";
import { createFakeApiState } from "../msw/fake-api.ts";

const s = createFakeApiState();
const ctx = {
  accountsById: Object.fromEntries(s.accounts.map((a) => [a.id, a])),
  batchesById: Object.fromEntries(s.batches.map((b) => [b.id, b])),
};
const row = (id: number) => describeActivity(s.activity.find((e) => e.id === id)!, ctx);

describe("describeActivity (UI spec 5.4)", () => {
  it("describes batch kinds with results and undo state", () => {
    expect(row(9)).toMatchObject({ verb: "Clean up", detail: "1,284 emails, 371 sender groups", result: "1,280 done · 4 already moved", account: "All accounts", last: { kind: "undo", batchId: 3 } });
    expect(row(7)).toMatchObject({ verb: "Trash", detail: "248 emails", result: "Done", account: "you@example.com", last: { kind: "undone" } });
    expect(row(6)).toMatchObject({ verb: "Changed", detail: "12 emails to Trash", last: { kind: "expired" } });
    expect(row(8)).toMatchObject({ verb: "Undo", detail: "248 emails restored", result: "Done", last: null });
  });

  it("describes maintenance, rules and account events", () => {
    expect(row(5)).toMatchObject({ verb: "Rules updated", detail: "", result: "Always keep 3 · Always OK to trash 1", last: { kind: "route", label: "Open Rules", to: "/rules" } });
    expect(row(4)).toMatchObject({ verb: "Threshold tuned", detail: "checked 312 trash decisions", result: "Now 86%" });
    expect(row(3)).toMatchObject({ verb: "Nightly cleanup", detail: "4,210 old records removed", result: "Done" });
    expect(row(2)).toMatchObject({ verb: "Needs reconnect", detail: "you@example.net", result: "Sorting paused", last: null });
    expect(row(1)).toMatchObject({ verb: "Connected", detail: "you@example.com", result: "Sorting started" });
  });

  it("names unknown accounts and offers Reconnect only while needed", () => {
    const entry = { id: 50, ts: s.activity[0]!.ts, kind: "reauth_required" as const, accountId: "acc_ffffffffffffffff", batchId: null, count: 0, result: {} };
    expect(describeActivity(entry, ctx)).toMatchObject({ account: "A removed account", detail: "a removed account" });
    const needs = { ...s.accounts[1]!, status: "needs_reauth" as const };
    const withNeeds = { ...ctx, accountsById: { ...ctx.accountsById, [needs.id]: needs } };
    expect(describeActivity(s.activity.find((e) => e.id === 2)!, withNeeds).last).toMatchObject({ kind: "reconnect" });
  });
});
```

`app/test/web/pages/activity-page.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPage } from "../../../src/web/pages/ActivityPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<ActivityPage />, { path: "/activity" }) };
}

describe("Activity page", () => {
  it("lists activity newest first with undo states", async () => {
    const { container } = setup();
    const table = await screen.findByRole("table", { name: "Activity" });
    expect(await within(table).findByRole("cell", { name: "Clean up · 1,284 emails, 371 sender groups" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "Today 09:00" })).toBeTruthy();
    expect(within(table).getByText("Undone")).toBeTruthy();
    expect(within(table).getByText("Undo expired")).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Open Rules" }).getAttribute("href")).toBe("/rules");
    expect(screen.getByText("Undo is available for 24 hours")).toBeTruthy();
    expect(document.title).toBe("Activity · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("undoes a batch and shows the result", async () => {
    const { state, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1,280 emails to your inbox.")).toBeTruthy();
    expect(state.requests.some((r) => r.url.pathname === "/api/batches/3/undo")).toBe(true);
    expect(await screen.findAllByText("Undone")).toHaveLength(2);
  });

  it("marks an expired undo", async () => {
    const { user } = setup((s) => {
      s.failures.undo = { status: 410, code: "undo_expired", times: 1 };
    });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undo is no longer available for this action (24 hours passed).")).toBeTruthy();
    expect(screen.getAllByText("Undo expired")).toHaveLength(2);
  });

  it("shows the empty state and loads more pages", async () => {
    setup((s) => void (s.activity = []));
    expect(await screen.findByText("Nothing yet. Actions you take and nightly maintenance appear here.")).toBeTruthy();
  });

  it("pages with Load more", async () => {
    const { user } = setup((s) => {
      s.activity = Array.from({ length: 60 }, (_, i) => ({
        id: 100 - i, ts: iso(T0 - i * 60_000), kind: "purge" as const, accountId: null, batchId: null, count: i + 1, result: {},
      }));
    });
    await screen.findByRole("cell", { name: "Nightly cleanup · 1 old records removed" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("cell", { name: "Nightly cleanup · 60 old records removed" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/activity.test.ts test/web/pages/activity-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/lib/activity.ts`.

- [ ] **Step 3: Implement `activity.ts`**

`app/src/web/lib/activity.ts`:

```ts
import type { AccountView, ActionBatchView, ActivityEntry } from "../../shared/api.ts";
import { toPercent } from "./confidence.ts";
import { formatCount, plural } from "./format.ts";

export type ActivityLast =
  | { kind: "undo"; batchId: number }
  | { kind: "undone" }
  | { kind: "expired" }
  | { kind: "reconnect"; account: AccountView }
  | { kind: "route"; label: string; to: string }
  | null;

export interface ActivityRow {
  verb: string;
  detail: string;
  result: string;
  account: string;
  last: ActivityLast;
}

export interface ActivityContext {
  accountsById: Readonly<Record<string, AccountView>>;
  batchesById: Readonly<Record<number, ActionBatchView>>;
}

const num = (r: ActivityEntry["result"], key: string): number => (typeof r[key] === "number" ? (r[key] as number) : 0);
const has = (r: ActivityEntry["result"], key: string): boolean => typeof r[key] === "number";
const ACTION_WORD = { delete: "Trash", archive: "Archive", keep: "Keep" } as const;

function onlyAction(r: ActivityEntry["result"]): keyof typeof ACTION_WORD | null {
  const nonZero = (["delete", "archive", "keep"] as const).filter((k) => num(r, k) > 0);
  return nonZero.length === 1 ? (nonZero[0] ?? null) : null;
}

function batchResult(e: ActivityEntry): string {
  const r = e.result;
  if (!has(r, "executed")) return "Done";
  const executed = num(r, "executed");
  const skipped = num(r, "skipped");
  const failed = num(r, "failed");
  if (skipped === 0 && failed === 0) return "Done";
  return [`${formatCount(executed)} done`, skipped > 0 ? `${formatCount(skipped)} already moved` : "", failed > 0 ? `${formatCount(failed)} failed` : ""]
    .filter(Boolean)
    .join(" · ");
}

function batchLast(e: ActivityEntry, ctx: ActivityContext): ActivityLast {
  const batch = e.batchId === null ? undefined : ctx.batchesById[e.batchId];
  if (!batch) return { kind: "expired" };
  if (batch.undoneAt) return { kind: "undone" };
  return batch.undoable ? { kind: "undo", batchId: batch.id } : { kind: "expired" };
}

/** UI spec 5.4 table. The audit log stores counts and codes only, never addresses or names. */
export function describeActivity(e: ActivityEntry, ctx: ActivityContext): ActivityRow {
  const account = e.accountId === null ? "All accounts" : (ctx.accountsById[e.accountId]?.email ?? "A removed account");
  const email = e.accountId === null ? "" : (ctx.accountsById[e.accountId]?.email ?? "a removed account");
  const emails = plural(e.count, "email", "emails");
  const r = e.result;
  const base = { account, last: null as ActivityLast };
  switch (e.kind) {
    case "cleanup":
      return { ...base, verb: "Clean up", detail: has(r, "groups") && num(r, "groups") > 0 ? `${emails}, ${plural(num(r, "groups"), "sender group", "sender groups")}` : emails, result: batchResult(e), last: batchLast(e, ctx) };
    case "approve": {
      const only = onlyAction(r);
      return { ...base, verb: only ? ACTION_WORD[only] : "Approved", detail: emails, result: batchResult(e), last: batchLast(e, ctx) };
    }
    case "override": {
      const only = onlyAction(r);
      return { ...base, verb: "Changed", detail: only ? `${emails} to ${ACTION_WORD[only]}` : emails, result: batchResult(e), last: batchLast(e, ctx) };
    }
    case "undo": {
      const failed = num(r, "failed");
      return { ...base, verb: "Undo", detail: `${emails} restored`, result: failed > 0 ? `${formatCount(num(r, "restored"))} restored · ${formatCount(failed)} failed` : "Done" };
    }
    case "account_connected":
      return { ...base, verb: "Connected", detail: email, result: "Sorting started" };
    case "account_reconnected":
      return { ...base, verb: "Reconnected", detail: email, result: "Sorting resumed" };
    case "account_disconnected":
      return { ...base, verb: "Disconnected", detail: "a mailbox", result: "Data removed tonight" };
    case "account_purged":
      return { ...base, verb: "Removed data", detail: "disconnected mailbox", result: "Done" };
    case "account_paused":
      return { ...base, verb: "Paused", detail: email, result: "Done" };
    case "account_resumed":
      return { ...base, verb: "Resumed", detail: email, result: "Done" };
    case "reauth_required": {
      const acc = e.accountId === null ? undefined : ctx.accountsById[e.accountId];
      return { ...base, verb: "Needs reconnect", detail: email, result: "Sorting paused", last: acc && acc.status === "needs_reauth" ? { kind: "reconnect", account: acc } : null };
    }
    case "config_error":
      return { ...base, verb: "Setup error", detail: email, result: "Sorting paused", last: { kind: "route", label: "Open Accounts", to: "/accounts" } };
    case "policy_updated":
      return {
        ...base, verb: "Rules updated", detail: "",
        result: has(r, "allow") || has(r, "deny") ? `Always keep ${formatCount(num(r, "allow"))} · Always OK to trash ${formatCount(num(r, "deny"))}` : "Saved",
        last: { kind: "route", label: "Open Rules", to: "/rules" },
      };
    case "calibration":
      return { ...base, verb: "Threshold tuned", detail: `checked ${plural(e.count, "trash decision", "trash decisions")}`, result: has(r, "tauDelete") ? `Now ${toPercent(num(r, "tauDelete"))}%` : "Unchanged" };
    case "purge":
      return { ...base, verb: "Nightly cleanup", detail: `${formatCount(e.count)} old records removed`, result: "Done" };
    default:
      return { ...base, verb: "Activity", detail: emails, result: "Done" };
  }
}
```

- [ ] **Step 4: Implement `ActivityPage.tsx`**

`app/src/web/pages/ActivityPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { ActivityEntry } from "../../shared/api.ts";
import { isApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { invalidateAfterActions } from "../api/mutations.ts";
import { useAccounts, useActivity, useBatches } from "../api/queries.ts";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button, LinkButton } from "../components/ui/Button.tsx";
import { Select } from "../components/ui/Select.tsx";
import { Table } from "../components/ui/Table.tsx";
import { describeActivity, type ActivityRow } from "../lib/activity.ts";
import { GENERIC_ERROR } from "../lib/copy-actions.ts";
import { activityWhen } from "../lib/format.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { useToast } from "../state/ToastProvider.tsx";
import { undoResultMessage } from "../state/UndoStackProvider.tsx";

type Row = ActivityEntry & { view: ActivityRow };

export function ActivityPage() {
  useDocumentTitle("Activity · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const [params, setParams] = useSearchParams();
  const accountId = params.get("account") ?? undefined;
  const activity = useActivity(accountId);
  const batches = useBatches(true);
  const accounts = useAccounts();
  const now = useNow();
  const toast = useToast();
  const qc = useQueryClient();
  const [undoing, setUndoing] = useState<number | null>(null);
  const [expired, setExpired] = useState<ReadonlySet<number>>(new Set());

  const list = accounts.data?.accounts ?? [];
  const rows: Row[] = useMemo(() => {
    const ctx = {
      accountsById: Object.fromEntries((accounts.data?.accounts ?? []).map((a) => [a.id, a])),
      batchesById: Object.fromEntries((batches.data ?? []).map((b) => [b.id, b])),
    };
    return (activity.data?.pages.flatMap((p) => p.items) ?? []).map((e) => ({ ...e, view: describeActivity(e, ctx) }));
  }, [activity.data, batches.data, accounts.data]);

  const undo = async (batchId: number) => {
    setUndoing(batchId);
    try {
      const res = await api.undoBatch(batchId);
      toast.show({ kind: "success", message: undoResultMessage("action", res.restored, res.failed) });
    } catch (e) {
      if (isApiError(e) && e.code === "undo_expired") {
        setExpired((s) => new Set([...s, batchId]));
        toast.show({ kind: "error", message: "Undo is no longer available for this action (24 hours passed)." });
      } else toast.show({ kind: "error", message: GENERIC_ERROR });
    } finally {
      setUndoing(null);
      await invalidateAfterActions(qc);
    }
  };

  const lastCell = (row: Row) => {
    const last = row.view.last;
    if (!last) return null;
    if (last.kind === "undo") {
      if (expired.has(last.batchId)) return <span className="text-small text-ink-3">Undo expired</span>;
      return <Button size="sm" loading={undoing === last.batchId} loadingLabel="Undoing…" onClick={() => void undo(last.batchId)}>Undo</Button>;
    }
    if (last.kind === "undone") return <span className="text-ink-3">Undone</span>;
    if (last.kind === "expired") return <span className="text-small text-ink-3">Undo expired</span>;
    if (last.kind === "reconnect") {
      return <Button size="sm" variant="ghost" onClick={() => startOAuth(last.account.provider, { returnTo: "/accounts", loginHint: last.account.email })}>Reconnect</Button>;
    }
    return <LinkButton size="sm" variant="ghost" to={last.to}>{last.label}</LinkButton>;
  };

  const options = [{ value: "all", label: "All accounts" }, ...list.map((a) => ({ value: a.id, label: a.email }))];
  return (
    <div className="max-w-[1040px]">
      <PageHeader
        title="Activity"
        titleRef={titleRef}
        meta="Undo is available for 24 hours"
        actions={
          <Select label="Account" value={accountId ?? "all"} options={options} className="w-[160px]"
            onChange={(v) => setParams(v === "all" ? {} : { account: v })} />
        }
      />
      <AppBanners page="activity" />
      <div className="rounded-xl border border-line bg-surface">
        <Table<Row>
          caption="Activity"
          state={activity.isPending ? "loading" : activity.isError ? "error" : rows.length === 0 ? "empty" : "ready"}
          emptyText="Nothing yet. Actions you take and nightly maintenance appear here."
          onRetry={() => void activity.refetch()}
          rows={rows}
          rowKey={(r) => r.id}
          rowHover={(r) => r.view.last !== null && r.view.last.kind !== "undone" && r.view.last.kind !== "expired"}
          columns={[
            { key: "when", header: "When", className: "w-[170px]", render: (r) => activityWhen(r.ts, now) },
            {
              key: "what", header: "What",
              render: (r) => (
                <span>
                  <b className="font-emphasis text-ink">{r.view.verb}</b>
                  {r.view.detail ? ` · ${r.view.detail}` : ""}
                </span>
              ),
            },
            { key: "accounts", header: "Accounts", render: (r) => r.view.account },
            { key: "result", header: "Result", render: (r) => r.view.result },
            { key: "action", header: "Actions", srOnlyHeader: true, align: "right", render: lastCell },
          ]}
        />
      </div>
      {activity.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" loading={activity.isFetchingNextPage} loadingLabel="Loading…" onClick={() => void activity.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/activity.test.ts test/web/pages/activity-page.test.tsx`
Expected: PASS (3 + 5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/web/lib/activity.ts app/src/web/pages/ActivityPage.tsx app/test/web/lib/activity.test.ts app/test/web/pages/activity-page.test.tsx
git commit -m "feat(web): add the Activity page with undo"
```

---

### Task 21: Accounts page (cards, pause, disconnect, connect, OAuth return)

**Files:**
- Create: `app/src/web/lib/oauth-errors.ts`, under `app/src/web/components/accounts/`: `ProviderTile.tsx`, `DisconnectConfirm.tsx`, `AccountCard.tsx`; `app/src/web/pages/AccountsPage.tsx`
- Test: `app/test/web/pages/accounts-page.test.tsx`

**Interfaces:**
- Consumes: `useAccounts`, `useMe`, `usePatchAccount`, `useDisconnectAccount` (Task 5), `qk` (Task 4), `useScanNow` (Task 17), `startOAuth`, `browser`, `docsUrl` (Task 16), `setupErrorBanner`, `AppBannerSpec` (Task 16), `AppBanners`, `PageHeader` (Task 16), `Menu`, `Button`, `ProgressBar`, `EmptyState`, `SkeletonLine`, `Panel` (Tasks 7, 8, 19), `deriveAccountUiStatus`, `catchUpFraction`, `backlogRemaining`, `dailyRateFrom`, `etaText`, `minutesUntil`, `providerName`, `formatCount`, `formatDayMonth` (Task 3).
- Produces:
  - `oauth-errors.ts`: `oauthErrorBanner(code, provider, retry): AppBannerSpec | null` (UI spec 5.5 table; `retry` starts the provider sign-in again), `NOT_CONFIGURED: Record<ProviderKind, string>`.
  - `ProviderTile({ provider, active, size? })`, `DisconnectConfirm({ email, busy, onCancel, onConfirm })`, `AccountCard(props)`, `accountStatusLine(account, now, dailyRate)`.
  - `AccountsPage()` (route `/accounts`; consumes `connected`, `error`, `provider`, `add=1` and `#acc_<id>`).

- [ ] **Step 1: Write the failing test**

`app/test/web/pages/accounts-page.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "../../../src/web/lib/links.ts";
import { AccountsPage } from "../../../src/web/pages/AccountsPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { ACC_GMAIL, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

beforeEach(() => vi.useFakeTimers({ now: T0, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(mutate?: (s: FakeApiState) => void, path = "/accounts") {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<AccountsPage />, { path, route: "/accounts" }) };
}

describe("Accounts page", () => {
  it("shows a card per account with status lines, actions and the footer note", async () => {
    const { container } = setup();
    const gmail = await screen.findByRole("group", { name: "you@example.com" });
    expect(within(gmail).getByText(/^Gmail · up to date · 32,118 emails sorted · connected /)).toBeTruthy();
    const outlook = screen.getByRole("group", { name: "you@example.net" });
    expect(within(outlook).getByText(/^Outlook · catching up, 11,800 left \(about 2 days\) · connected /)).toBeTruthy();
    expect(within(outlook).getByRole("progressbar", { name: "Sorting progress for you@example.net" }).getAttribute("aria-valuenow")).toBe("41");
    expect(within(gmail).getByRole("button", { name: "Pause you@example.com" })).toBeTruthy();
    expect(screen.getByText("Clearbox can only move mail to Trash or Archive. It can never permanently delete or send email.")).toBeTruthy();
    expect(document.title).toBe("Accounts · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("pauses optimistically and rolls back on error", async () => {
    const { user } = setup((s) => {
      s.failures.patchAccount = { status: 500, code: "internal", times: 1 };
    });
    await user.click(await screen.findByRole("button", { name: "Pause you@example.com" }));
    expect(await screen.findByText("Couldn't pause you@example.com. Try again.")).toBeTruthy();
    expect(screen.getByText(/^Gmail · up to date/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause you@example.com" }));
    expect(await screen.findByText("Paused sorting for you@example.com.")).toBeTruthy();
    expect(await screen.findByText("Gmail · paused by you · 32,118 emails sorted")).toBeTruthy();
  });

  it("disconnects after an inline confirm", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.com" }));
    expect(screen.getByText("Disconnect you@example.com? Clearbox stops sorting it and deletes its stored data tonight. Your mailbox is not changed.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected you@example.com. Google access was revoked.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("group", { name: "you@example.com" })).toBeNull());
  });

  it("explains how to remove Outlook consent after disconnecting", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect you@example.net" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected you@example.net.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Personal account" }).getAttribute("href")).toBe("https://account.live.com/consent/Manage");
    expect(screen.getByRole("link", { name: "Work or school account" })).toBeTruthy();
  });

  it("consumes an OAuth error and removes the query", async () => {
    const { router } = setup(undefined, "/accounts?error=access_denied&provider=gmail");
    expect(await screen.findByText("Access was not granted.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("toasts a fresh connection", async () => {
    setup(undefined, `/accounts?connected=${ACC_GMAIL}`);
    expect(await screen.findByText("Connected you@example.com. Sorting starts within a minute.")).toBeTruthy();
  });

  it("starts Connect and Reconnect through the provider sign-in", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { user } = setup((s) => {
      s.accounts[1] = { ...s.accounts[1]!, status: "needs_reauth" };
    });
    expect(await screen.findByText("Outlook · paused, needs reconnect")).toBeTruthy();
    const card = screen.getByRole("group", { name: "you@example.net" });
    await user.click(within(card).getByRole("button", { name: "Reconnect you@example.net" }));
    expect(assign).toHaveBeenLastCalledWith("/oauth/microsoft/start?loginHint=you%40example.net");
    await user.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect(assign).toHaveBeenLastCalledWith("/oauth/google/start");
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/accounts");
  });

  it("explains a provider that is not configured", async () => {
    setup((s) => {
      s.me = { ...s.me, providers: { gmail: false, outlook: true } };
    });
    expect(await screen.findByText("Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/setup-google.md).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Gmail" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the empty state", async () => {
    setup((s) => void (s.accounts = []));
    expect(await screen.findByRole("heading", { name: "No accounts yet" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/accounts-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/pages/AccountsPage.tsx`.

- [ ] **Step 3: Implement `oauth-errors.ts`, `ProviderTile.tsx`, `DisconnectConfirm.tsx`**

`app/src/web/lib/oauth-errors.ts`:

```ts
import { setupErrorBanner, type AppBannerSpec } from "./banners.ts";
import { docsUrl } from "./links.ts";
import type { ProviderKind } from "./view-types.ts";

const RETRY = (label: string, onClick: () => void) => [{ label, kind: "callback" as const, onClick }];

/** Helper lines under the Connect buttons when a provider has no client credentials (UI spec 5.5). */
export const NOT_CONFIGURED: Record<ProviderKind, string> = {
  gmail: "Gmail is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/setup-google.md).",
  outlook: "Outlook is not set up yet. Add MS_CLIENT_ID and MS_CLIENT_SECRET as Worker secrets (see docs/setup-microsoft.md).",
};

/** UI spec 5.5 OAuth return table. */
export function oauthErrorBanner(code: string, provider: ProviderKind | null, retry: () => void): AppBannerSpec | null {
  const p = provider ?? "gmail";
  const warn = (title: string, body: string): AppBannerSpec => ({ id: `oauth-${code}`, tone: "warning", title, body, actions: RETRY("Try again", retry) });
  const err = (title: string, body: string): AppBannerSpec => ({ id: `oauth-${code}`, tone: "error", title, body, actions: RETRY("Try again", retry) });
  switch (code) {
    case "access_denied":
      return warn("Access was not granted.", "You cancelled the sign-in or declined the permissions. Clearbox needs them to sort your mail.");
    case "admin_consent_required":
      return warn("Your organization must approve Clearbox first.", "Ask your Microsoft 365 admin to grant consent for this app, then try again.");
    case "state_invalid":
      return warn("The sign-in took too long or was opened in another tab.", "Start again from this page.");
    case "token_exchange_failed":
      return err("The provider did not complete the sign-in.", "Wait a moment and try again.");
    case "provider_config_error":
      return { ...setupErrorBanner(p), id: `oauth-${code}` };
    case "scope_missing":
      return warn("Some permissions were not granted.", "Clearbox needs permission to read and organize mail. Try again and keep every box checked.");
    case "no_refresh_token":
      return warn("Google did not grant offline access.", "Remove Clearbox at myaccount.google.com/permissions, then connect again.");
    case "profile_failed":
      return err(
        "Connected, but Clearbox could not read the mailbox profile.",
        "Try again. If it keeps failing, check that the Gmail API (or Microsoft Graph) is enabled.",
      );
    case "provider_not_configured":
      return {
        id: `oauth-${code}`,
        tone: "warning",
        title: p === "gmail" ? "Gmail is not set up yet." : "Outlook is not set up yet.",
        body: p === "gmail"
          ? "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets, then redeploy."
          : "Add MS_CLIENT_ID and MS_CLIENT_SECRET as Worker secrets, then redeploy.",
        actions: [{ label: "Open setup guide", kind: "link", href: docsUrl(p === "gmail" ? "setup-google.md" : "setup-microsoft.md") }],
      };
    default:
      return null;
  }
}
```

`app/src/web/components/accounts/ProviderTile.tsx`:

```tsx
import type { ProviderKind } from "../../lib/view-types.ts";

export function ProviderTile({ provider, active, size = 34 }: { provider: ProviderKind; active: boolean; size?: 34 | 14 }) {
  const tone = !active ? "bg-provider-off" : provider === "gmail" ? "bg-provider-gmail" : "bg-provider-outlook";
  const dims = size === 34 ? "size-[34px] rounded-lg text-title-sm" : "size-3.5 rounded-xs text-[9px] leading-none";
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center font-heavy text-white ${dims} ${tone}`}>
      {provider === "gmail" ? "G" : "O"}
    </span>
  );
}
```

`app/src/web/components/accounts/DisconnectConfirm.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Button } from "../ui/Button.tsx";

export interface DisconnectConfirmProps {
  email: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Inline confirm, no modal (UI spec 5.5); focus starts on Cancel. */
export function DisconnectConfirm({ email, busy, onCancel, onConfirm }: DisconnectConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="col-span-full mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-trash-line bg-trash-soft px-3 py-2.5 text-body text-trash-ink">
      <p className="min-w-0 flex-1">
        {`Disconnect ${email}? Clearbox stops sorting it and deletes its stored data tonight. Your mailbox is not changed.`}
      </p>
      <Button ref={cancelRef} variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button variant="danger" loading={busy} onClick={onConfirm}>Disconnect</Button>
    </div>
  );
}
```

- [ ] **Step 4: Implement `AccountCard.tsx`**

`app/src/web/components/accounts/AccountCard.tsx`:

```tsx
import { useRef, useState } from "react";
import type { AccountView } from "../../../shared/api.ts";
import { backlogRemaining, catchUpFraction, deriveAccountUiStatus, etaText, minutesUntil, providerName } from "../../lib/account-status.ts";
import { formatCount, formatDayMonth } from "../../lib/format.ts";
import { useScanNow } from "../../pages/review/use-scan-now.ts";
import { BP, useMediaQuery } from "../../state/use-media-query.ts";
import { Button } from "../ui/Button.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { DisconnectConfirm } from "./DisconnectConfirm.tsx";
import { ProviderTile } from "./ProviderTile.tsx";

export function accountStatusLine(a: AccountView, now: number, dailyRate: number): string {
  const p = providerName(a.provider);
  const connected = `connected ${formatDayMonth(a.createdAt)}`;
  const sorted = formatCount(a.sync.messagesIngested);
  const status = deriveAccountUiStatus(a, now);
  let line: string;
  if (status === "up_to_date") line = `${p} · up to date · ${sorted} emails sorted · ${connected}`;
  else if (status === "catching_up") {
    const left = backlogRemaining(a);
    line = left === null
      ? `${p} · catching up, ${sorted} sorted so far · ${connected}`
      : `${p} · catching up, ${formatCount(left)} left (${etaText(left, dailyRate)}) · ${connected}`;
  } else if (status === "waiting") {
    line = `${p} · waiting, ${p} asked Clearbox to slow down · retrying in ${a.sync.backoffUntil ? minutesUntil(a.sync.backoffUntil, now) : 1} min`;
  } else if (status === "paused") line = `${p} · paused by you · ${sorted} emails sorted`;
  else if (status === "needs_reauth") line = `${p} · paused, needs reconnect`;
  else line = `${p} · paused, sign-in setup error (${a.statusReason ?? "unknown"})`;
  return a.archiveSupported ? line : `${line} · Archive unavailable, archive suggestions are kept in Review`;
}

export interface AccountCardProps {
  account: AccountView;
  now: number;
  dailyRate: number;
  disconnecting: boolean;
  onPause: (paused: boolean) => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

interface CardAction {
  id: string;
  label: string;
  primary: boolean;
  run: () => void;
}

export function AccountCard({ account: a, now, dailyRate, disconnecting, onPause, onDisconnect, onReconnect }: AccountCardProps) {
  const status = deriveAccountUiStatus(a, now);
  const [confirming, setConfirming] = useState(false);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const wide = useMediaQuery(BP.lg);
  const scan = useScanNow([a], a.id);
  const fraction = catchUpFraction(a);
  const actions: CardAction[] = [];
  if (status === "up_to_date" || status === "catching_up") actions.push({ id: "scan", label: "Scan now", primary: false, run: () => void scan.run() });
  if (status === "up_to_date" || status === "catching_up" || status === "waiting") actions.push({ id: "pause", label: "Pause", primary: false, run: () => onPause(true) });
  if (status === "paused") actions.push({ id: "resume", label: "Resume", primary: true, run: () => onPause(false) });
  if (status === "needs_reauth" || status === "config_error") actions.push({ id: "reconnect", label: "Reconnect", primary: true, run: onReconnect });
  actions.push({ id: "disconnect", label: "Disconnect", primary: false, run: () => setConfirming(true) });

  const items: MenuItem[] = actions.map((x) => ({ id: x.id, label: x.label, destructive: x.id === "disconnect", onSelect: x.run }));
  return (
    <div
      id={`acc_${a.id}`}
      tabIndex={-1}
      role="group"
      aria-label={a.email}
      className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-subtle px-4 py-3.5 outline-offset-[-2px] last:border-b-0"
    >
      <ProviderTile provider={a.provider} active={status === "up_to_date" || status === "catching_up"} />
      <div className="min-w-0">
        <p className="truncate font-emphasis text-ink">{a.email}</p>
        <p className="text-small text-ink-3">{accountStatusLine(a, now, dailyRate)}</p>
        {status === "catching_up" ? (
          <div className="mt-1.5">
            <ProgressBar value={fraction} tone="archive" width={240} label={`Sorting progress for ${a.email}`} />
          </div>
        ) : null}
      </div>
      {wide ? (
        <div className="flex items-center gap-1.5">
          {actions.map((x) => (
            <Button
              key={x.id}
              ref={x.id === "disconnect" ? disconnectRef : undefined}
              variant={x.primary ? "secondary" : "ghost"}
              size="sm"
              aria-label={`${x.label} ${a.email}`}
              loading={x.id === "scan" ? scan.scanning : undefined}
              loadingLabel="Scanning…"
              onClick={x.run}
            >
              {x.label}
            </Button>
          ))}
        </div>
      ) : (
        <Menu
          label={`Account actions for ${a.email}`}
          align="end"
          items={items}
          renderTrigger={(t) => <Button {...t} variant="ghost" size="sm" icon="more" aria-label={`Account actions for ${a.email}`} />}
        />
      )}
      {confirming ? (
        <DisconnectConfirm
          email={a.email}
          busy={disconnecting}
          onCancel={() => {
            setConfirming(false);
            requestAnimationFrame(() => disconnectRef.current?.focus());
          }}
          onConfirm={onDisconnect}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Implement `AccountsPage.tsx`**

`app/src/web/pages/AccountsPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { Insights } from "../../shared/api.ts";
import { qk } from "../api/keys.ts";
import { useDisconnectAccount, usePatchAccount } from "../api/mutations.ts";
import { useAccounts, useMe } from "../api/queries.ts";
import { AccountCard } from "../components/accounts/AccountCard.tsx";
import { ProviderTile } from "../components/accounts/ProviderTile.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { dailyRateFrom } from "../lib/account-status.ts";
import type { AppBannerSpec } from "../lib/banners.ts";
import { GENERIC_ERROR } from "../lib/copy-actions.ts";
import { NOT_CONFIGURED, oauthErrorBanner } from "../lib/oauth-errors.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import type { ProviderKind } from "../lib/view-types.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useNow } from "../state/use-now.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { useToast } from "../state/ToastProvider.tsx";

export function AccountsPage() {
  useDocumentTitle("Accounts · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const [oauth] = useState(() => ({ connected: params.get("connected"), error: params.get("error"), provider: params.get("provider"), add: params.get("add") === "1" }));
  const me = useMe();
  const accounts = useAccounts();
  const patch = usePatchAccount();
  const disconnect = useDisconnectAccount();
  const toast = useToast();
  const qc = useQueryClient();
  const now = useNow();
  const [opening, setOpening] = useState<ProviderKind | null>(null);
  const [consentBanner, setConsentBanner] = useState<AppBannerSpec | null>(null);
  const gmailRef = useRef<HTMLButtonElement>(null);
  const toasted = useRef(false);
  const list = accounts.data?.accounts ?? [];
  const insights = qc.getQueryData<Insights>(qk.insights);
  const dailyRate = insights ? dailyRateFrom(insights.history) : 6_800;

  useEffect(() => {
    if (oauth.connected || oauth.error || oauth.provider || oauth.add) setParams({}, { replace: true });
  }, [oauth, setParams]);
  useEffect(() => {
    if (oauth.add) gmailRef.current?.focus();
  }, [oauth.add]);
  useEffect(() => {
    if (!accounts.data || toasted.current) return;
    const focusId = oauth.connected ? `acc_${oauth.connected}` : hash.startsWith("#acc_") ? hash.slice(1) : null;
    if (oauth.connected) {
      const a = accounts.data.accounts.find((x) => x.id === oauth.connected);
      if (a) toast.show({ kind: "success", message: `Connected ${a.email}. Sorting starts within a minute.` });
    }
    toasted.current = true;
    const el = focusId ? document.getElementById(focusId) : null;
    el?.scrollIntoView({ block: "nearest" });
    el?.focus();
  }, [accounts.data, hash, oauth.connected, toast]);

  const connect = (provider: ProviderKind) => {
    setOpening(provider);
    startOAuth(provider, { returnTo: "/accounts" });
  };
  const provider: ProviderKind | null = oauth.provider === "outlook" ? "outlook" : oauth.provider === "gmail" ? "gmail" : null;
  const oauthBanner = oauth.error ? oauthErrorBanner(oauth.error, provider, () => connect(provider ?? "gmail")) : null;
  const extra = [oauthBanner, consentBanner].filter((b): b is AppBannerSpec => b !== null);
  const providers = me.data?.providers;

  const onPause = (id: string, email: string, paused: boolean) =>
    patch.mutate(
      { id, paused },
      {
        onSuccess: () => toast.show({ kind: "info", message: paused ? `Paused sorting for ${email}.` : `Resumed sorting for ${email}.` }),
        onError: () => toast.show({ kind: "error", message: `Couldn't ${paused ? "pause" : "resume"} ${email}. Try again.` }),
      },
    );

  const onDisconnect = (id: string, email: string) =>
    disconnect.mutate(id, {
      onSuccess: (res) => {
        if (res.revocation === "revoked") toast.show({ kind: "success", message: `Disconnected ${email}. Google access was revoked.` });
        else if (res.revocation === "failed") {
          toast.show({ kind: "success", message: `Disconnected ${email}. Google did not confirm the revoke; you can remove access at myaccount.google.com/permissions.` });
        } else {
          setConsentBanner({
            id: "consent", tone: "info", title: `Disconnected ${email}.`,
            body: "Microsoft has no revoke button for apps, so remove Clearbox's access yourself.",
            actions: res.consentUrls
              ? [{ label: "Personal account", kind: "link", href: res.consentUrls.personal }, { label: "Work or school account", kind: "link", href: res.consentUrls.work }]
              : [],
          });
        }
      },
      onError: () => toast.show({ kind: "error", message: GENERIC_ERROR }),
    });

  const connectButtons = (
    <>
      <Button ref={gmailRef} softDisabled={providers?.gmail === false} loading={opening === "gmail"} loadingLabel="Opening Google…" onClick={() => connect("gmail")}>
        <span className="inline-flex items-center gap-[7px]"><ProviderTile provider="gmail" active size={14} />Connect Gmail</span>
      </Button>
      <Button softDisabled={providers?.outlook === false} loading={opening === "outlook"} loadingLabel="Opening Microsoft…" onClick={() => connect("outlook")}>
        <span className="inline-flex items-center gap-[7px]"><ProviderTile provider="outlook" active size={14} />Connect Outlook</span>
      </Button>
    </>
  );

  return (
    <div className="max-w-[1040px]">
      <PageHeader title="Accounts" titleRef={titleRef} actions={connectButtons} />
      {providers && (!providers.gmail || !providers.outlook) ? (
        <div className="-mt-2 mb-3.5 flex flex-col gap-1 text-small text-ink-3">
          {!providers.gmail ? <p>{NOT_CONFIGURED.gmail}</p> : null}
          {!providers.outlook ? <p>{NOT_CONFIGURED.outlook}</p> : null}
        </div>
      ) : null}
      <AppBanners page="accounts" extra={extra} />
      {accounts.isError ? (
        <EmptyState variant="panel" title="Couldn't load accounts." body="Check your connection, then try again." action={{ label: "Try again", onClick: () => void accounts.refetch() }} />
      ) : accounts.isPending ? (
        <div aria-busy="true" className="rounded-xl border border-line bg-surface">
          <span className="sr-only">Loading accounts</span>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="flex flex-col gap-2 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
              <SkeletonLine width={180} />
              <SkeletonLine width={320} height={6} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState variant="panel" title="No accounts yet" body="Connect Gmail or Outlook to start sorting."
          action={{ label: "Connect Gmail", onClick: () => connect("gmail") }} secondaryAction={{ label: "Connect Outlook", onClick: () => connect("outlook") }} />
      ) : (
        <div className="rounded-xl border border-line bg-surface">
          {list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              now={now}
              dailyRate={dailyRate}
              disconnecting={disconnect.isPending && disconnect.variables === a.id}
              onPause={(paused) => onPause(a.id, a.email, paused)}
              onDisconnect={() => onDisconnect(a.id, a.email)}
              onReconnect={() => startOAuth(a.provider, { returnTo: "/accounts", loginHint: a.email })}
            />
          ))}
        </div>
      )}
      <p className="mt-2.5 text-small text-ink-3">Clearbox can only move mail to Trash or Archive. It can never permanently delete or send email.</p>
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/accounts-page.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/lib/oauth-errors.ts app/src/web/components/accounts app/src/web/pages/AccountsPage.tsx app/test/web/pages/accounts-page.test.tsx
git commit -m "feat(web): add the Accounts page with pause, disconnect, connect and OAuth results"
```

---

### Task 22: Rules page (draft, chips, save, validation, conflict, unsaved guard)

**Files:**
- Create: `app/src/web/lib/rules-draft.ts`, `app/src/web/components/rules/RuleField.tsx`, `app/src/web/components/rules/RulesForm.tsx`, `app/src/web/pages/RulesPage.tsx`
- Test: `app/test/web/lib/rules-draft.test.ts`, `app/test/web/pages/rules-page.test.tsx`

**Interfaces:**
- Consumes: `PatchSenderBodySchema` (shared, W13), `usePolicy`, `usePutPolicy` (Task 5), `isApiError` (Task 4), `ChipInput`, `ChipValidation`, `Toggle`, `Select`, `Button`, `EmptyState`, `SkeletonLine` (Tasks 7, 8), `useHotkeys` (Task 10), `useToast` (Task 9), `PageHeader`, `AppBanners`, `useDocumentTitle`, `useRouteFocus` (Task 16), `formatCount` (Task 3); type `Policy` from `@clearbox/core`.
- Produces:
  - `rules-draft.ts`: `type ListKey = "allowlist" | "denylist"`, `addEntry(policy, list, value): { policy; movedFrom: ListKey | null }`, `removeEntry(policy, list, value)`, `policiesEqual(a, b)`, `validateSenderEntry(raw): ChipValidation`, `validateRecordWord(raw): ChipValidation`, `fieldErrors(details): Partial<Record<keyof Policy, string>>`, `MIN_AGE_OPTIONS`, `MOVED_NOTE`.
  - `RuleField({ id, title, description, row?, children })`, `RulesForm(props)`, `RulesPage()` (route `/rules`).

- [ ] **Step 1: Write the failing tests**

`app/test/web/lib/rules-draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addEntry, fieldErrors, policiesEqual, removeEntry, validateRecordWord, validateSenderEntry } from "../../../src/web/lib/rules-draft.ts";
import { makePolicyResponse } from "../msw/fixtures.ts";

const { policy } = makePolicyResponse();

describe("rules draft", () => {
  it("moves an entry between lists", () => {
    const out = addEntry(policy, "allowlist", "promo@northwind.example");
    expect(out.movedFrom).toBe("denylist");
    expect(out.policy.allowlist).toContain("promo@northwind.example");
    expect(out.policy.denylist).not.toContain("promo@northwind.example");
    expect(removeEntry(out.policy, "allowlist", "promo@northwind.example").allowlist).toEqual(policy.allowlist);
    expect(policiesEqual(policy, { ...policy })).toBe(true);
    expect(policiesEqual(policy, out.policy)).toBe(false);
  });

  it("validates entries with the shared schema and record words locally", () => {
    expect(validateSenderEntry("  Mom@Family.Example ")).toEqual({ ok: true, value: "mom@family.example" });
    expect(validateSenderEntry("@bank.example")).toEqual({ ok: true, value: "@bank.example" });
    expect(validateSenderEntry("nope")).toEqual({ ok: false, error: "Use name@domain.com or @domain.com." });
    expect(validateRecordWord(" Invoice ")).toEqual({ ok: true, value: "invoice" });
    expect(validateRecordWord("a")).toEqual({ ok: false, error: "Use 2 to 40 characters." });
  });

  it("maps server validation paths to fields", () => {
    expect(fieldErrors([{ path: "allowlist.3", message: "x" }, { path: "recordPatterns.0", message: "y" }, { path: "minAgeDays", message: "Too big" }])).toEqual({
      allowlist: "Use name@domain.com or @domain.com.",
      recordPatterns: "Use 2 to 40 characters.",
      minAgeDays: "Too big",
    });
    expect(fieldErrors("nonsense")).toEqual({});
  });
});
```

`app/test/web/pages/rules-page.test.tsx`:

```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RulesPage } from "../../../src/web/pages/RulesPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { installFakeApi } from "../msw/handlers.ts";

function setup(mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<RulesPage />, { path: "/rules" }) };
}
const chips = (name: string) => within(screen.getByRole("list", { name })).getAllByRole("listitem").map((li) => li.firstChild?.textContent);

describe("Rules page", () => {
  it("renders every rule with the current policy", async () => {
    const { container } = setup();
    expect(await screen.findByRole("textbox", { name: "Always keep these senders" })).toBeTruthy();
    expect(chips("Always keep")).toEqual(["mom@family.example", "@bank.example"]);
    expect(chips("Always OK to trash")).toEqual(["promo@northwind.example"]);
    expect((screen.getByRole("combobox", { name: "Leave recent emails alone" }) as HTMLSelectElement).value).toBe("3");
    const locked = screen.getByRole("switch", { name: "Protect starred, flagged and replied threads" });
    expect([locked.getAttribute("aria-checked"), locked.getAttribute("aria-disabled")]).toEqual(["true", "true"]);
    expect(screen.getByRole("switch", { name: "Store email previews" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Save changes" }).getAttribute("aria-disabled")).toBe("true");
    expect(document.title).toBe("Rules · Clearbox");
    await expectNoA11yViolations(container);
  });

  it("moves an entry between lists, marks the draft dirty and saves", async () => {
    const { state, user } = setup();
    const input = await screen.findByRole("textbox", { name: "Always keep these senders" });
    await user.type(input, "promo@northwind.example{Enter}");
    expect(screen.getByText("Moved from Always OK to trash")).toBeTruthy();
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    expect(document.title).toBe("Rules (unsaved) · Clearbox");
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByText("Rules saved. They apply to new emails from now on.")).toBeTruthy();
    const body = state.requests.find((r) => r.route === "putPolicy")?.body as { policy: { allowlist: string[]; denylist: string[] }; expectedVersion: number };
    expect(body.expectedVersion).toBe(4);
    expect(body.policy.allowlist).toContain("promo@northwind.example");
    expect(body.policy.denylist).toEqual([]);
    await waitFor(() => expect(screen.queryByText("You have unsaved changes.")).toBeNull());
  });

  it("validates record words on the client", async () => {
    const { user } = setup();
    await user.type(await screen.findByRole("textbox", { name: "Record words" }), "a{Enter}");
    expect(screen.getByText("Use 2 to 40 characters.")).toBeTruthy();
  });

  it("shows server validation errors under the field", async () => {
    const { user } = setup((s) => {
      s.failures.putPolicy = { status: 400, code: "validation_failed", times: 1, details: [{ path: "allowlist.2", message: "bad" }] };
    });
    await user.type(await screen.findByRole("textbox", { name: "Always keep these senders" }), "@new.example{Enter}");
    await user.keyboard("{Control>}s{/Control}");
    expect(await screen.findByText("Some entries are not valid. Fix the highlighted fields.")).toBeTruthy();
    expect(screen.getByText("Use name@domain.com or @domain.com.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Always keep these senders" })));
  });

  it("handles a conflict by reloading the rules", async () => {
    const { user } = setup((s) => {
      s.failures.putPolicy = { status: 409, code: "conflict", times: 1 };
    });
    await user.click(await screen.findByRole("switch", { name: "Store email previews" }));
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByText("Rules changed in another tab.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reload rules" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Store email previews" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("resets to defaults and discards", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    expect(screen.queryByRole("list", { name: "Always keep" })?.querySelectorAll("li").length ?? 0).toBe(0);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(chips("Always keep")).toEqual(["mom@family.example", "@bank.example"]);
  });

  it("guards navigation while there are unsaved changes", async () => {
    const { router, user } = setup();
    await user.click(await screen.findByRole("switch", { name: "Remember subjects of emails you decide" }));
    await act(() => router.navigate("/review"));
    expect(screen.getByRole("button", { name: "Stay" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/rules");
    await act(() => router.navigate("/review"));
    await user.click(screen.getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/rules-draft.test.ts test/web/pages/rules-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/lib/rules-draft.ts`.

- [ ] **Step 3: Implement `rules-draft.ts`**

`app/src/web/lib/rules-draft.ts`:

```ts
import type { Policy } from "@clearbox/core";
import { z } from "zod";
import { PatchSenderBodySchema } from "../../shared/api.ts";
import type { ChipValidation } from "../components/ui/ChipInput.tsx";

export type ListKey = "allowlist" | "denylist";

const SENDER_ERROR = "Use name@domain.com or @domain.com.";
const WORD_ERROR = "Use 2 to 40 characters.";
const RecordWordSchema = z.string().trim().toLowerCase().min(2).max(40);

export const MOVED_NOTE: Record<ListKey, string> = {
  allowlist: "Moved from Always OK to trash",
  denylist: "Moved from Always keep",
};

export const MIN_AGE_OPTIONS = [
  { value: "0", label: "Off" },
  ...[1, 2, 3, 5, 7, 14, 30].map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` })),
] as const satisfies readonly { value: string; label: string }[];

const other = (list: ListKey): ListKey => (list === "allowlist" ? "denylist" : "allowlist");

/** Adding to one list removes the entry from the other (UI spec 5.6, contracts 7.11). */
export function addEntry(policy: Policy, list: ListKey, value: string): { policy: Policy; movedFrom: ListKey | null } {
  const o = other(list);
  const moved = policy[o].includes(value);
  return {
    policy: { ...policy, [list]: [...policy[list], value], [o]: policy[o].filter((v) => v !== value) },
    movedFrom: moved ? o : null,
  };
}

export function removeEntry(policy: Policy, list: ListKey, value: string): Policy {
  return { ...policy, [list]: policy[list].filter((v) => v !== value) };
}

export const policiesEqual = (a: Policy, b: Policy): boolean => JSON.stringify(a) === JSON.stringify(b);

export function validateSenderEntry(raw: string): ChipValidation {
  const r = PatchSenderBodySchema.shape.entry.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: SENDER_ERROR };
}

export function validateRecordWord(raw: string): ChipValidation {
  const r = RecordWordSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: WORD_ERROR };
}

const POLICY_KEYS = ["allowlist", "denylist", "minAgeDays", "storeSnippets", "labelSubjects", "recordPatterns"] as const;

/** Maps validation_failed details ({ path, message }[]) to one message per field. */
export function fieldErrors(details: unknown): Partial<Record<keyof Policy, string>> {
  if (!Array.isArray(details)) return {};
  const out: Partial<Record<keyof Policy, string>> = {};
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    const head = typeof d.path === "string" ? d.path.split(".")[0] : undefined;
    const key = POLICY_KEYS.find((k) => k === head);
    if (!key || out[key]) continue;
    out[key] = key === "allowlist" || key === "denylist" ? SENDER_ERROR : key === "recordPatterns" ? WORD_ERROR : String(d.message ?? "");
  }
  return out;
}
```

- [ ] **Step 4: Implement `RuleField.tsx` and `RulesForm.tsx`**

`app/src/web/components/rules/RuleField.tsx`:

```tsx
import type { ReactNode } from "react";

export interface RuleFieldProps {
  id: string;
  title: string;
  description: string;
  row?: boolean;
  children: ReactNode;
}

export function RuleField({ id, title, description, row = false, children }: RuleFieldProps) {
  return (
    <div className={`flex flex-col gap-1.5 border-b border-line-subtle px-4 py-3.5 last:border-b-0 ${row ? "sm:flex-row sm:items-center sm:gap-4" : ""}`}>
      <div className="min-w-0 flex-1">
        <p id={`${id}-title`} className="font-emphasis text-ink">{title}</p>
        <p id={`${id}-desc`} className="text-small text-ink-3">{description}</p>
      </div>
      {children}
    </div>
  );
}
```

`app/src/web/components/rules/RulesForm.tsx`:

```tsx
import type { Policy } from "@clearbox/core";
import { addEntry, MIN_AGE_OPTIONS, MOVED_NOTE, removeEntry, validateRecordWord, validateSenderEntry, type ListKey } from "../../lib/rules-draft.ts";
import { ChipInput } from "../ui/ChipInput.tsx";
import { Select } from "../ui/Select.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { RuleField } from "./RuleField.tsx";

export interface RulesFormProps {
  draft: Policy;
  disabled: boolean;
  errors: Partial<Record<keyof Policy, string>>;
  notes: Readonly<Record<string, string>>;
  onChange: (next: Policy) => void;
  onMoved: (value: string, note: string) => void;
}

export function RulesForm({ draft, disabled, errors, notes, onChange, onMoved }: RulesFormProps) {
  const add = (list: ListKey) => (value: string) => {
    const out = addEntry(draft, list, value);
    onChange(out.policy);
    if (out.movedFrom) onMoved(value, MOVED_NOTE[list]);
  };
  const lists: { key: ListKey; id: string; title: string; description: string; name: string }[] = [
    { key: "allowlist", id: "rule-allow", title: "Always keep these senders", description: "Never suggested for trash or archive.", name: "Always keep" },
    { key: "denylist", id: "rule-deny", title: "Always OK to trash", description: "Skip the confidence check for these.", name: "Always OK to trash" },
  ];
  return (
    <div className="rounded-xl border border-line bg-surface">
      {lists.map((l) => (
        <RuleField key={l.key} id={l.id} title={l.title} description={l.description}>
          <ChipInput
            labelledBy={`${l.id}-title`}
            describedBy={`${l.id}-desc`}
            listName={l.name}
            values={draft[l.key]}
            placeholder="Add sender or @domain"
            validate={validateSenderEntry}
            onAdd={add(l.key)}
            onRemove={(v) => onChange(removeEntry(draft, l.key, v))}
            max={1000}
            notes={notes}
            serverError={errors[l.key]}
            disabled={disabled}
          />
        </RuleField>
      ))}
      <RuleField id="rule-age" title="Leave recent emails alone" description="Don't suggest anything for emails newer than this." row>
        <Select label="Leave recent emails alone" value={String(draft.minAgeDays)} options={MIN_AGE_OPTIONS} disabled={disabled}
          onChange={(v) => onChange({ ...draft, minAgeDays: Number(v) })} />
      </RuleField>
      <RuleField id="rule-starred" title="Protect starred, flagged and replied threads" description="Always on. These are never trashed." row>
        <Toggle checked locked onChange={() => undefined} label="Protect starred, flagged and replied threads" labelledBy="rule-starred-title" describedBy="rule-starred-desc" />
      </RuleField>
      <RuleField
        id="rule-records"
        title="Receipts and attachments go to Archive, not Trash"
        description="Always on. Emails with files, and emails whose subject or preview contains one of the words below."
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <span id="rule-words-title" className="text-meta font-emphasis text-ink-3">Record words</span>
            <ChipInput
              labelledBy="rule-words-title"
              listName="Record words"
              values={draft.recordPatterns}
              placeholder="Add a word"
              validate={validateRecordWord}
              onAdd={(v) => onChange({ ...draft, recordPatterns: [...draft.recordPatterns, v] })}
              onRemove={(v) => onChange({ ...draft, recordPatterns: draft.recordPatterns.filter((x) => x !== v) })}
              max={100}
              serverError={errors.recordPatterns}
              disabled={disabled}
            />
          </div>
          <Toggle checked locked onChange={() => undefined} label="Receipts and attachments go to Archive, not Trash" labelledBy="rule-records-title" describedBy="rule-records-desc" />
        </div>
      </RuleField>
      <RuleField id="rule-snippets" title="Store email previews" description="Keeps a short snippet for 30 days to show in Review. Turn off to store subjects only." row>
        <Toggle checked={draft.storeSnippets} disabled={disabled} onChange={(v) => onChange({ ...draft, storeSnippets: v })}
          label="Store email previews" labelledBy="rule-snippets-title" describedBy="rule-snippets-desc" />
      </RuleField>
      <RuleField
        id="rule-subjects"
        title="Remember subjects of emails you decide"
        description="Keeps the first 60 characters of the subject with each decision to improve suggestions. Turn off to keep only the sender."
        row
      >
        <Toggle checked={draft.labelSubjects} disabled={disabled} onChange={(v) => onChange({ ...draft, labelSubjects: v })}
          label="Remember subjects of emails you decide" labelledBy="rule-subjects-title" describedBy="rule-subjects-desc" />
      </RuleField>
    </div>
  );
}
```

- [ ] **Step 5: Implement `RulesPage.tsx`**

`app/src/web/pages/RulesPage.tsx`:

```tsx
import type { Policy } from "@clearbox/core";
import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { isApiError } from "../api/client.ts";
import { usePutPolicy } from "../api/mutations.ts";
import { usePolicy } from "../api/queries.ts";
import { RulesForm } from "../components/rules/RulesForm.tsx";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { Button } from "../components/ui/Button.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import type { AppBannerSpec } from "../lib/banners.ts";
import { GENERIC_ERROR } from "../lib/copy-actions.ts";
import { fieldErrors, policiesEqual } from "../lib/rules-draft.ts";
import { useHotkeys } from "../state/HotkeysProvider.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { useToast } from "../state/ToastProvider.tsx";

const FIELD_INPUT: Partial<Record<keyof Policy, string>> = {
  allowlist: "rule-allow-title",
  denylist: "rule-deny-title",
  recordPatterns: "rule-words-title",
};

export function RulesPage() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const policy = usePolicy();
  const put = usePutPolicy();
  const toast = useToast();
  const [draft, setDraft] = useState<Policy | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Policy, string>>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [focusField, setFocusField] = useState<string | null>(null);
  const data = policy.data;
  if (data && draft === null) setDraft(data.policy);
  const dirty = !!data && !!draft && !policiesEqual(draft, data.policy);
  const saving = put.isPending;
  useDocumentTitle(dirty ? "Rules (unsaved) · Clearbox" : "Rules · Clearbox");
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  useEffect(() => {
    if (!focusField) return;
    document.querySelector<HTMLInputElement>(`input[aria-labelledby="${focusField}"]`)?.focus();
  }, [focusField]);

  const save = async (): Promise<boolean> => {
    if (!data || !draft || !dirty || saving) return false;
    try {
      const res = await put.mutateAsync({ policy: draft, expectedVersion: data.version });
      setDraft(res.policy);
      setErrors({});
      setFocusField(null);
      toast.show({ kind: "success", message: "Rules saved. They apply to new emails from now on." });
      return true;
    } catch (e) {
      if (isApiError(e) && e.code === "conflict") setConflict(true);
      else if (isApiError(e) && e.code === "validation_failed") {
        const next = fieldErrors(e.details);
        setErrors(next);
        const first = (Object.keys(FIELD_INPUT) as (keyof Policy)[]).find((k) => next[k]);
        setFocusField(first ? (FIELD_INPUT[first] ?? null) : null);
        toast.show({ kind: "error", message: "Some entries are not valid. Fix the highlighted fields." });
      } else toast.show({ kind: "error", message: GENERIC_ERROR });
      return false;
    }
  };

  useHotkeys("rules", [{ combo: "mod+s", handler: () => void save(), allowInInputs: true }]);

  const onMoved = (value: string, note: string) => {
    setNotes((n) => ({ ...n, [value]: note }));
    setTimeout(() => setNotes((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== value))), 4_000);
  };
  const discard = () => {
    if (data) setDraft(data.policy);
    setErrors({});
  };

  const extra: AppBannerSpec[] = [];
  if (conflict) {
    extra.push({
      id: "rules-conflict", tone: "warning", title: "Rules changed in another tab.",
      body: "Reload to see the latest rules. Your unsaved changes will be lost.",
      actions: [{
        label: "Reload rules", kind: "callback",
        onClick: () => void policy.refetch().then((r) => {
          if (r.data) setDraft(r.data.policy);
          setConflict(false);
        }),
      }],
    });
  } else if (blocker.state === "blocked") {
    extra.push({
      id: "rules-leave", tone: "warning", title: "You have unsaved changes.",
      actions: [
        { label: "Save and leave", kind: "callback", onClick: () => void save().then((ok) => (ok ? blocker.proceed?.() : blocker.reset?.())) },
        { label: "Leave without saving", kind: "callback", onClick: () => blocker.proceed?.() },
        { label: "Stay", kind: "callback", onClick: () => blocker.reset?.() },
      ],
    });
  } else if (dirty) {
    extra.push({
      id: "rules-dirty", tone: "info", title: "You have unsaved changes.",
      actions: [
        { label: "Save changes", kind: "callback", onClick: () => void save(), loading: saving },
        { label: "Discard", kind: "callback", onClick: discard },
      ],
    });
  }

  return (
    <div className="max-w-[880px]">
      <PageHeader
        title="Rules"
        titleRef={titleRef}
        meta="These always override the AI"
        actions={
          <Button variant="primary" softDisabled={!dirty} loading={saving} loadingLabel="Saving…" aria-keyshortcuts="Control+S Meta+S" onClick={() => void save()}>
            Save changes
          </Button>
        }
      />
      <AppBanners page="rules" extra={extra} />
      {policy.isError ? (
        <EmptyState variant="panel" title="Couldn't load your rules." body="Check your connection, then try again." action={{ label: "Try again", onClick: () => void policy.refetch() }} />
      ) : !draft ? (
        <div aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <span className="sr-only">Loading rules</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} aria-hidden="true" className="flex flex-col gap-2">
              <SkeletonLine width={220} />
              <SkeletonLine width={320} height={6} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <RulesForm draft={draft} disabled={saving} errors={errors} notes={notes} onChange={setDraft} onMoved={onMoved} />
          <p className="mt-2.5 text-small text-ink-3">
            Rule changes apply to emails sorted from now on. Suggestions already in Review keep their current verdict.{" "}
            <Button variant="link" size="sm" onClick={() => data && setDraft(data.defaults)}>Reset to defaults</Button>
          </p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/lib/rules-draft.test.ts test/web/pages/rules-page.test.tsx`
Expected: PASS (3 + 7 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/lib/rules-draft.ts app/src/web/components/rules app/src/web/pages/RulesPage.tsx app/test/web/lib/rules-draft.test.ts app/test/web/pages/rules-page.test.tsx
git commit -m "feat(web): add the Rules page with chip lists, save, validation, conflict and unsaved guard"
```

---

### Task 23: First-run Setup page

**Files:**
- Create: `app/src/web/pages/SetupPage.tsx`
- Test: `app/test/web/pages/setup-page.test.tsx`

**Interfaces:**
- Consumes: `useMe`, `useAccounts({ fast: true })`, `useQueueSummary` (Task 5), `Brand` (Task 16), `AppBanners`, `MODEL_BODY`, `docsUrl`, `startOAuth` (Task 16), `NOT_CONFIGURED`, `oauthErrorBanner` (Task 21), `firstSortProgress` (Task 18), `Button`, `LinkButton`, `Icon`, `ProgressBar`, `SkeletonLine`, `VisuallyHidden` (Tasks 7, 8), `useDocumentTitle`, `useRouteFocus` (Task 16), `formatCount`, `plural` (Task 3).
- Produces: `SetupPage()` (route `/setup`, rendered without AppShell), `SetupStep({ status, title, children, action? })`, `type StepStatus = "done" | "warning" | "error" | "pending"`.

- [ ] **Step 1: Write the failing test**

`app/test/web/pages/setup-page.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupPage } from "../../../src/web/pages/SetupPage.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderPage } from "../helpers/render.tsx";
import type { FakeApiState } from "../msw/fake-api.ts";
import { iso, T0 } from "../msw/fixtures.ts";
import { installFakeApi } from "../msw/handlers.ts";

function setup(mutate?: (s: FakeApiState) => void, path = "/setup") {
  const state = installFakeApi(mutate);
  return { state, ...renderPage(<SetupPage />, { path, route: "/setup", shell: false }) };
}

describe("Setup page", () => {
  it("walks through the three checks before any account exists", async () => {
    const { container, user } = setup((s) => void (s.accounts = []));
    expect(await screen.findByRole("heading", { level: 1, name: "Set up Clearbox" })).toBeTruthy();
    expect(await screen.findByText("Protected by Cloudflare Access. Signed in as owner@example.test.")).toBeTruthy();
    expect(screen.getByText("Connected to your Decision-1 deployment.")).toBeTruthy();
    expect(screen.getByText("Connect Gmail or Outlook. You'll sign in on their page.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sorting your first emails" })).toBeNull();
    expect(screen.getByText(/^Clearbox can only move mail to Trash or Archive\. It never permanently deletes or sends email\./)).toBeTruthy();
    expect(document.title).toBe("Set up Clearbox");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBe("/setup");
  });

  it("shows model problems and local development mode in the steps", async () => {
    setup((s) => {
      s.accounts = [];
      s.me = { ...s.me, environment: "development", issues: [{ code: "decision_not_configured", since: iso(T0), accountId: null }] };
    });
    expect(await screen.findByText("Local development mode. Sign-in is bypassed on localhost only.")).toBeTruthy();
    expect(screen.getByText("AZURE_DECISION_ENDPOINT, AZURE_DECISION_KEY or AZURE_DECISION_DEPLOYMENT is missing. New emails will be marked Check until this is fixed.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open setup guide" })).toBeTruthy();
  });

  it("shows sorting progress and enables Go to Review once groups exist", async () => {
    const { router, user } = setup();
    expect(await screen.findByText("you@example.com connected.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sorting your first emails" })).toBeTruthy();
    expect(screen.getByText("Sorting your inbox, newest first (step 2 of 3). 8,200 emails sorted.")).toBeTruthy();
    expect(screen.getByText("Caught up (step 3 of 3).")).toBeTruthy();
    expect(await screen.findByText("7 sender groups are ready.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Go to Review" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });

  it("keeps Go to Review disabled until the first suggestions exist", async () => {
    setup((s) => void (s.items = []));
    expect(await screen.findByText("Your first suggestions appear within a few minutes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to Review" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the OAuth result above the panel", async () => {
    setup((s) => void (s.accounts = []), "/setup?error=scope_missing&provider=gmail");
    expect(await screen.findByText("Some permissions were not granted.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/setup-page.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/pages/SetupPage.tsx`.

- [ ] **Step 3: Implement `SetupPage.tsx`**

`app/src/web/pages/SetupPage.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { AccountView } from "../../shared/api.ts";
import { useAccounts, useMe, useQueueSummary } from "../api/queries.ts";
import { AppBanners } from "../components/shell/AppBanners.tsx";
import { Brand } from "../components/shell/SidebarNav.tsx";
import { Button, LinkButton } from "../components/ui/Button.tsx";
import { Icon } from "../components/ui/icons.tsx";
import { ProgressBar } from "../components/ui/ProgressBar.tsx";
import { SkeletonLine } from "../components/ui/Skeleton.tsx";
import { VisuallyHidden } from "../components/ui/VisuallyHidden.tsx";
import { MODEL_BODY, type AppBannerSpec } from "../lib/banners.ts";
import { formatCount, plural } from "../lib/format.ts";
import { docsUrl } from "../lib/links.ts";
import { NOT_CONFIGURED, oauthErrorBanner } from "../lib/oauth-errors.ts";
import { startOAuth } from "../lib/oauth-return.ts";
import type { ProviderKind } from "../lib/view-types.ts";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { useRouteFocus } from "../state/use-route-focus.ts";
import { firstSortProgress } from "./review/review-state.ts";

export type StepStatus = "done" | "warning" | "error" | "pending";

const STATUS: Record<StepStatus, { icon: "success" | "warning" | "error" | null; className: string; label: string }> = {
  done: { icon: "success", className: "text-keep-ink", label: "Done" },
  warning: { icon: "warning", className: "text-check-ink", label: "Needs attention" },
  error: { icon: "error", className: "text-trash-ink", label: "Problem" },
  pending: { icon: null, className: "", label: "Not done yet" },
};

export function SetupStep({ status, title, children, action }: { status: StepStatus; title: string; children: ReactNode; action?: ReactNode }) {
  const s = STATUS[status];
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 border-b border-line-subtle px-4 py-3.5 last:border-b-0">
      <span className="pt-0.5">
        {s.icon ? <Icon name={s.icon} size={16} className={s.className} /> : <span aria-hidden="true" className="block size-4 rounded-full border-[1.5px] border-line-control" />}
        <VisuallyHidden>{s.label}</VisuallyHidden>
      </span>
      <div className="min-w-0">
        <h2 className="font-emphasis text-ink">{title}</h2>
        <div className="text-small text-ink-3">{children}</div>
      </div>
      {action ? <div className="flex flex-col items-end gap-1.5">{action}</div> : null}
    </li>
  );
}

function phaseText(a: AccountView): string {
  if (a.sync.phase === "sent_backfill") return "Learning who you write to (step 1 of 3)";
  if (a.sync.phase === "inbox_backfill") return `Sorting your inbox, newest first (step 2 of 3). ${formatCount(a.sync.messagesIngested)} emails sorted.`;
  return "Caught up (step 3 of 3).";
}

export function SetupPage() {
  useDocumentTitle("Set up Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useRouteFocus(titleRef);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [oauth] = useState(() => ({ error: params.get("error"), provider: params.get("provider"), connected: params.get("connected") }));
  useEffect(() => {
    if (oauth.error || oauth.provider || oauth.connected) setParams({}, { replace: true });
  }, [oauth, setParams]);
  const me = useMe();
  const accounts = useAccounts({ fast: true });
  const summary = useQueueSummary();
  const list = accounts.data?.accounts ?? [];
  const issues = new Set((me.data?.issues ?? []).map((i) => i.code));
  const modelCode = (["decision_not_configured", "decision_auth_failed", "decision_deployment_not_found"] as const).find((c) => issues.has(c));
  const connect = (p: ProviderKind) => startOAuth(p, { returnTo: "/setup" });
  const provider: ProviderKind | null = oauth.provider === "outlook" ? "outlook" : oauth.provider === "gmail" ? "gmail" : null;
  const banner = oauth.error ? oauthErrorBanner(oauth.error, provider, () => connect(provider ?? "gmail")) : null;
  const extra: AppBannerSpec[] = banner ? [banner] : [];
  const groups = summary.data?.groups ?? 0;
  const ready = (summary.data?.pending.total ?? 0) > 0;
  const progress = firstSortProgress(list);
  const loading = me.isPending || accounts.isPending;

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-[560px] px-4 pt-12 pb-8 focus:outline-none">
      <Brand />
      <h1 ref={titleRef} tabIndex={-1} className="text-h1 font-heading text-ink focus:outline-none">Set up Clearbox</h1>
      <p className="mt-1 mb-4 text-ink-2">Three checks, then Clearbox sorts your mailbox in the background.</p>
      <AppBanners page="setup" extra={extra} />
      {loading ? (
        <div aria-busy="true" className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <span className="sr-only">Loading setup checks</span>
          {[0, 1, 2].map((i) => <SkeletonLine key={i} width="70%" />)}
        </div>
      ) : (
        <ol className="rounded-xl border border-line bg-surface">
          <SetupStep status={me.data?.environment === "development" ? "warning" : "done"} title="Sign-in protection">
            {me.data?.environment === "development"
              ? "Local development mode. Sign-in is bypassed on localhost only."
              : `Protected by Cloudflare Access. Signed in as ${me.data?.email ?? ""}.`}
          </SetupStep>
          <SetupStep
            status={modelCode ? "error" : "done"}
            title="AI model"
            action={modelCode ? <LinkButton href={docsUrl("setup-azure.md")} external variant="ghost" size="sm">Open setup guide</LinkButton> : undefined}
          >
            {modelCode ? `${MODEL_BODY[modelCode] ?? ""} New emails will be marked Check until this is fixed.` : "Connected to your Decision-1 deployment."}
          </SetupStep>
          <SetupStep
            status={list.length > 0 ? "done" : "pending"}
            title="Connect a mailbox"
            action={
              <>
                {(["gmail", "outlook"] as const).map((p) => (
                  <Button key={p} size="sm" softDisabled={me.data?.providers[p] === false} onClick={() => connect(p)}>
                    {p === "gmail" ? "Connect Gmail" : "Connect Outlook"}
                  </Button>
                ))}
              </>
            }
          >
            {list.length > 0
              ? list.map((a) => <span key={a.id} className="block">{`${a.email} connected.`}</span>)
              : "Connect Gmail or Outlook. You'll sign in on their page."}
            {me.data && !me.data.providers.gmail ? <span className="block">{NOT_CONFIGURED.gmail}</span> : null}
            {me.data && !me.data.providers.outlook ? <span className="block">{NOT_CONFIGURED.outlook}</span> : null}
          </SetupStep>
        </ol>
      )}
      <p className="mt-2.5 text-small text-ink-3">
        Clearbox can only move mail to Trash or Archive. It never permanently deletes or sends email. It stores sender, subject, date and a short preview, never full email bodies.
      </p>
      {list.length > 0 ? (
        <section aria-labelledby="first-sort" className="mt-6 flex flex-col gap-2">
          <h2 id="first-sort" className="text-title font-semibold text-ink">Sorting your first emails</h2>
          {list.map((a) => <p key={a.id} className="text-small text-ink-2">{phaseText(a)}</p>)}
          <ProgressBar value={progress.value} tone="archive" height={6} label="Sorting progress" />
          <div className="mt-2 flex flex-col items-start gap-1">
            <Button variant="primary" softDisabled={!ready} onClick={() => void navigate("/review")}>Go to Review</Button>
            <p className="text-small text-ink-3">
              {ready ? `${plural(groups, "sender group", "sender groups")} ${groups === 1 ? "is" : "are"} ready.` : "Your first suggestions appear within a few minutes."}
            </p>
          </div>
        </section>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/setup-page.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/web/pages/SetupPage.tsx app/test/web/pages/setup-page.test.tsx
git commit -m "feat(web): add the first-run Setup page"
```

---

### Task 24: Component gallery (development only) and the CSP style audit

**Files:**
- Create: `app/src/web/pages/gallery/sample-data.ts`, `app/src/web/pages/gallery/GalleryControls.tsx`, `app/src/web/pages/gallery/GalleryReview.tsx`, `app/src/web/pages/ComponentGallery.tsx`
- Test: `app/test/web/pages/gallery.test.tsx`, `app/test/web/csp.test.tsx`

**Interfaces:**
- Consumes: every component from Tasks 7 to 15 and 19.
- Produces: `ComponentGallery()` (route `/dev/components`, registered only when `import.meta.env.DEV`, Task 25), `GALLERY_GROUPS`, `galleryGroup(overrides)` synthetic data (reserved `.example` domains only), `GalleryCard({ title, children })`.

- [ ] **Step 1: Write the failing tests**

`app/test/web/pages/gallery.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComponentGallery } from "../../../src/web/pages/ComponentGallery.tsx";
import { HotkeysProvider } from "../../../src/web/state/HotkeysProvider.tsx";
import { expectNoA11yViolations } from "../helpers/axe.ts";
import { renderWithCore } from "../helpers/core.tsx";
import { installFakeApi } from "../msw/handlers.ts";

describe("Component gallery", () => {
  it("renders every card of UI spec 5.7 without accessibility violations", async () => {
    installFakeApi();
    const { container } = renderWithCore(<HotkeysProvider><ComponentGallery /></HotkeysProvider>, { path: "/dev/components" });
    for (const title of ["Buttons", "Verdict tags (icon + word, never color alone)", "Confidence scale (tick = Clean up threshold, tuned nightly)", "Rows", "Banners and toasts", "Inputs", "Empty states and skeletons", "Confirm bar"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("Clean up 1,284")).toBeTruthy();
    expect(screen.getByText("Cleaning up… 812 of 1,284")).toBeTruthy();
    expect(document.title).toBe("Components · Clearbox");
    await expectNoA11yViolations(container);
  });
});
```

`app/test/web/csp.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeeklyChart } from "../../src/web/components/insights/WeeklyChart.tsx";
import { SplitBar } from "../../src/web/components/review/SplitBar.tsx";
import { SkeletonLine } from "../../src/web/components/ui/Skeleton.tsx";
import { ComponentGallery } from "../../src/web/pages/ComponentGallery.tsx";
import { HotkeysProvider } from "../../src/web/state/HotkeysProvider.tsx";
import { renderWithCore } from "./helpers/core.tsx";
import { createFakeApiState } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

function styledProperties(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>("[style]")].flatMap((el) => Array.from({ length: el.style.length }, (_, i) => el.style[i] ?? ""));
}

describe("CSP-safe geometry (UI spec 8.4)", () => {
  it("sets only --cb-* custom properties through style props across the gallery", () => {
    installFakeApi();
    const { container } = renderWithCore(<HotkeysProvider><ComponentGallery /></HotkeysProvider>);
    const props = styledProperties(container);
    expect(props.length).toBeGreaterThan(5);
    expect(props.filter((p) => !p.startsWith("--cb-"))).toEqual([]);
  });

  it("covers the chart, split bar and skeleton geometry too", () => {
    const { container } = render(
      <>
        <WeeklyChart weeks={createFakeApiState().insights.weekly} state="ready" />
        <SplitBar segments={[{ key: "t", className: "bg-trash", value: 3, legend: "3 to trash" }]} />
        <SkeletonLine width={120} />
      </>,
    );
    expect(styledProperties(container).filter((p) => !p.startsWith("--cb-"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/gallery.test.tsx test/web/csp.test.tsx`
Expected: FAIL with `Failed to load url ../../../src/web/pages/ComponentGallery.tsx`.

- [ ] **Step 3: Implement the synthetic sample data**

`app/src/web/pages/gallery/sample-data.ts`:

```ts
import type { SenderGroup } from "../../../shared/api.ts";

/** Synthetic data for the dev gallery only (reserved .example domains). */
export function galleryGroup(overrides: Partial<SenderGroup>): SenderGroup {
  return {
    key: "gallery-1", accountId: "acc_0000000000000001", provider: "gmail", sender: "promo@northwind.example",
    senderName: "Northwind Deals", domain: "northwind.example", action: "delete", count: 248,
    confidence: { min: 0.91, avg: 0.97, max: 0.99 },
    topReasons: [{ code: "prior_sender_deleted", text: "You trashed 41 of 44 from this sender" }],
    ceilingApplied: false, newestReceivedAt: "2026-10-15T09:00:00.000Z", oldestReceivedAt: "2026-10-01T09:00:00.000Z",
    latestSubject: "Flash sale ends tonight", ...overrides,
  };
}

export const GALLERY_GROUPS: { label: string; group: SenderGroup; active?: boolean; selected?: boolean; busy?: boolean }[] = [
  { label: "default", group: galleryGroup({ key: "g-default" }) },
  { label: "active", group: galleryGroup({ key: "g-active", senderName: "Daily Digest", sender: "digest@news.example", domain: "news.example", confidence: { min: 0.88, avg: 0.9, max: 0.93 } }), active: true },
  { label: "selected", group: galleryGroup({ key: "g-selected", senderName: "Fabrikam Updates", sender: "updates@fabrikam.example", domain: "fabrikam.example", action: "archive", confidence: { min: 0.74, avg: 0.79, max: 0.84 } }), selected: true },
  { label: "busy", group: galleryGroup({ key: "g-busy", senderName: "Tailspin Travel", sender: "deals@tailspin.example", domain: "tailspin.example" }), busy: true },
  { label: "protected", group: galleryGroup({ key: "g-protected", senderName: "Contoso Orders", sender: "orders@contoso.example", domain: "contoso.example", action: "archive", ceilingApplied: true }) },
  {
    label: "model unavailable",
    group: galleryGroup({
      key: "g-model", senderName: "Build Bot", sender: "builds@ci.example", domain: "ci.example", action: "unsure",
      confidence: { min: 0.4, avg: 0.5, max: 0.55 }, topReasons: [{ code: "model_unavailable", text: "Model unavailable, needs your review" }],
    }),
  },
];
```

- [ ] **Step 4: Implement the gallery sections**

`app/src/web/pages/gallery/GalleryControls.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { Banner } from "../../components/ui/Banner.tsx";
import { Button } from "../../components/ui/Button.tsx";
import { Checkbox } from "../../components/ui/Checkbox.tsx";
import { ChipInput } from "../../components/ui/ChipInput.tsx";
import { EmptyState } from "../../components/ui/EmptyState.tsx";
import { Select } from "../../components/ui/Select.tsx";
import { SkeletonRows } from "../../components/ui/Skeleton.tsx";
import { TextInput } from "../../components/ui/TextInput.tsx";
import { ToastView } from "../../components/ui/Toast.tsx";
import { Toggle } from "../../components/ui/Toggle.tsx";
import { validateSenderEntry } from "../../lib/rules-draft.ts";
import { usePlatform } from "../../state/use-platform.ts";

export function GalleryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5">
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

const noop = () => undefined;

export function ButtonsCard() {
  return (
    <GalleryCard title="Buttons">
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" kbd={["Ctrl", "Enter"]}>Clean up 1,284</Button>
        <Button>Archive</Button>
        <Button variant="danger" icon="trash">Trash 248</Button>
        <Button variant="ghost">Cancel</Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button className="outline-2 outline-offset-2 outline-focus outline-solid">Focused</Button>
        <Button softDisabled>Disabled</Button>
        <Button loading>Save</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </div>
    </GalleryCard>
  );
}

export function FeedbackCard() {
  const platform = usePlatform();
  const toast = (id: string, kind: "success" | "info" | "error", message: string, undo = false) => (
    <ToastView
      platform={platform}
      onDismiss={noop}
      toast={{ id, kind, message, createdAt: 0, durationMs: 3_600_000, ...(undo ? { action: { label: "Undo" as const, shortcut: "mod+z" as const, onAction: noop } } : {}) }}
    />
  );
  return (
    <GalleryCard title="Banners and toasts">
      <Banner tone="warning" title="you@example.com needs to reconnect." body="Google ended the session (password change or 6 months unused). Sorting is paused for this account." actions={[{ label: "Reconnect", onClick: noop }]} />
      <Banner tone="error" title="Clearbox can't use the AI model." body="New emails are marked Check until this is fixed." />
      <Banner tone="info" title="The AI model is not responding right now." body="Clearbox retries automatically." />
      <Banner tone="success" title="Rules saved." />
      <div className="flex flex-col items-start gap-2">
        {toast("g1", "success", "Moved 248 emails from Northwind Deals to Trash.", true)}
        {toast("g2", "info", "Scan finished. 25 new emails sorted.")}
        {toast("g3", "error", "Something went wrong. Nothing was changed.")}
      </div>
    </GalleryCard>
  );
}

export function InputsCard() {
  const [chips, setChips] = useState(["mom@family.example", "@bank.example"]);
  const [on, setOn] = useState(true);
  const [age, setAge] = useState("3");
  return (
    <GalleryCard title="Inputs">
      <TextInput label="Default input" placeholder="Add a word" />
      <TextInput label="Input with error" defaultValue="nope" error="Use name@domain.com or @domain.com." />
      <TextInput label="Disabled input" disabled defaultValue="read only" />
      <span id="gallery-chips" className="text-meta font-emphasis text-ink-3">Always keep these senders</span>
      <ChipInput labelledBy="gallery-chips" listName="Always keep" values={chips} placeholder="Add sender or @domain" max={1000}
        validate={validateSenderEntry} onAdd={(v) => setChips((c) => [...c, v])} onRemove={(v) => setChips((c) => c.filter((x) => x !== v))} />
      <Select label="Leave recent emails alone" showLabel value={age} onChange={setAge}
        options={[{ value: "0", label: "Off" }, { value: "3", label: "3 days" }, { value: "7", label: "7 days" }]} />
      <div className="flex flex-wrap items-center gap-3">
        <Toggle checked={on} onChange={setOn} label="Toggle on" />
        <Toggle checked={false} onChange={noop} label="Toggle off" />
        <Toggle checked locked onChange={noop} label="Toggle locked" />
        <Checkbox checked={false} onChange={noop} label="Checkbox off" />
        <Checkbox checked onChange={noop} label="Checkbox on" />
        <Checkbox checked="mixed" onChange={noop} label="Checkbox mixed" />
        <Checkbox checked={false} disabled onChange={noop} label="Checkbox disabled" />
      </div>
    </GalleryCard>
  );
}

export function EmptyCard() {
  return (
    <GalleryCard title="Empty states and skeletons">
      <EmptyState variant="panel" headingLevel={3} title="Inbox cleared" body="41 groups are waiting for your call. New mail gets sorted every 30 minutes." action={{ label: "Review the 41 groups", onClick: noop }} />
      <EmptyState variant="inline" headingLevel={3} title="No trash suggestions" body="Nothing here looks safe to trash right now." />
      <SkeletonRows count={2} />
    </GalleryCard>
  );
}
```

`app/src/web/pages/gallery/GalleryReview.tsx`:

```tsx
import { useState } from "react";
import { ConfidenceLabel, ConfidenceScale } from "../../components/review/ConfidenceLabel.tsx";
import { ConfirmBar } from "../../components/review/ConfirmBar.tsx";
import { SenderGroupRow } from "../../components/review/SenderGroupRow.tsx";
import { VerdictTag } from "../../components/review/VerdictTag.tsx";
import { usePlatform } from "../../state/use-platform.ts";
import { GalleryCard } from "./GalleryControls.tsx";
import { GALLERY_GROUPS } from "./sample-data.ts";

const noop = () => undefined;

export function TagsCard() {
  return (
    <GalleryCard title="Verdict tags (icon + word, never color alone)">
      {(["md", "sm"] as const).map((size) => (
        <div key={size} className="flex flex-wrap gap-1.5">
          {(["delete", "archive", "keep", "unsure", "protected"] as const).map((k) => <VerdictTag key={k} kind={k} size={size} />)}
        </div>
      ))}
    </GalleryCard>
  );
}

export function ScaleCard() {
  const [tau, setTau] = useState(0.86);
  return (
    <GalleryCard title="Confidence scale (tick = Clean up threshold, tuned nightly)">
      <label className="flex items-center gap-2 text-small text-ink-2">
        Threshold
        <input type="range" min={0.8} max={0.99} step={0.01} value={tau} onChange={(e) => setTau(Number(e.target.value))} />
        {`${Math.round(tau * 100)}%`}
      </label>
      <ConfidenceScale tau={tau} />
      <div className="flex flex-col gap-1.5">
        {[0.97, 0.89, 0.78, 0.54].map((v) => (
          <ConfidenceLabel key={v} value={v} verdict="delete" tau={tau} variant="inline" />
        ))}
      </div>
    </GalleryCard>
  );
}

export function RowsCard() {
  return (
    <GalleryCard title="Rows">
      <div role="grid" aria-label="Row states" className="overflow-clip rounded-lg border border-line">
        {GALLERY_GROUPS.map((r, i) => (
          <SenderGroupRow key={r.group.key} group={r.group} tau={0.86} rowIndex={i} active={r.active ?? false} selected={r.selected ?? false}
            busy={r.busy ?? false} exiting={false} focusable={i === 0} accountEmail={null} onClick={noop} onCheckboxChange={noop} />
        ))}
      </div>
    </GalleryCard>
  );
}

export function BarsCard() {
  const platform = usePlatform();
  const common = { mode: "cleanup" as const, platform, onConfirm: noop, onCancel: noop, onStop: noop, onRetry: noop };
  return (
    <GalleryCard title="Confirm bar">
      <ConfirmBar {...common} phase="confirming" title="Clean up 1,284 emails in 371 sender groups?"
        detail="1,102 go to Trash and 182 to Archive. Nothing is permanently deleted. 41 groups below 86% stay here for you." />
      <ConfirmBar {...common} phase="running" title="Cleaning up… 812 of 1,284" detail="" processed={812} total={1284} />
      <ConfirmBar {...common} phase="partial" title="Clean up paused at today's free-tier limit. 1,180 emails were cleaned up."
        detail="The other 104 stay in Review. Actions work again after 07:00." />
    </GalleryCard>
  );
}
```

`app/src/web/pages/ComponentGallery.tsx`:

```tsx
import { useRef } from "react";
import { PageHeader } from "../components/shell/PageHeader.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";
import { ButtonsCard, EmptyCard, FeedbackCard, InputsCard } from "./gallery/GalleryControls.tsx";
import { BarsCard, RowsCard, ScaleCard, TagsCard } from "./gallery/GalleryReview.tsx";

/** UI spec 5.7: mockup section 7 as live components for visual QA. Registered only in development. */
export function ComponentGallery() {
  useDocumentTitle("Components · Clearbox");
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <div>
      <PageHeader title="Components" titleRef={titleRef} />
      <div className="grid grid-cols-1 gap-3.5 p-4 xl:grid-cols-2">
        <ButtonsCard />
        <TagsCard />
        <ScaleCard />
        <RowsCard />
        <FeedbackCard />
        <InputsCard />
        <EmptyCard />
        <BarsCard />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/pages/gallery.test.tsx test/web/csp.test.tsx`
Expected: PASS (1 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/web/pages/gallery app/src/web/pages/ComponentGallery.tsx app/test/web/pages/gallery.test.tsx app/test/web/csp.test.tsx
git commit -m "feat(web): add the dev component gallery and the CSP style audit"
```

---

### Task 25: Router, entry point, redirects, OAuth return, 404 and full verification

**Files:**
- Create: `app/src/web/routes.tsx`, `app/src/web/pages/RootRedirect.tsx`, `app/src/web/pages/OAuthReturn.tsx`, `app/src/web/pages/NotFoundPage.tsx`
- Replace: `app/src/web/main.tsx` (plan 03 placeholder, W8)
- Delete: `app/test/web/placeholder.test.tsx` (plan 03's temporary test of the placeholder entry; it asserts the placeholder heading)
- Test: `app/test/web/routes.test.tsx`

**Interfaces:**
- Consumes: every page (Tasks 16 to 24), `RootLayout`, `RouteErrorPage` (Task 16), `AppShell` (Task 16), `createQueryClient` (Task 5), `installCspListener` (Task 4), `consumeOAuthReturn` (Task 16).
- Produces: `appRoutes(): RouteObject[]` (UI spec 3.5 table; `/dev/components` only when `import.meta.env.DEV`, so production builds drop the gallery chunk), `createAppRouter()`, `RootRedirect()`, `OAuthReturn()`, `NotFoundPage()`, and the browser entry `main.tsx`.

- [ ] **Step 1: Write the failing test**

`app/test/web/routes.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteErrorPage } from "../../src/web/pages/FullPageError.tsx";
import { appRoutes } from "../../src/web/routes.tsx";
import { createTestQueryClient } from "./helpers/query.tsx";
import type { FakeApiState } from "./msw/fake-api.ts";
import { installFakeApi } from "./msw/handlers.ts";

afterEach(() => vi.restoreAllMocks());

function renderApp(path: string, mutate?: (s: FakeApiState) => void) {
  const state = installFakeApi(mutate);
  const router = createMemoryRouter(appRoutes(), { initialEntries: [path] });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { state, router, user: userEvent.setup() };
}

describe("routes (UI spec 3.5)", () => {
  it("redirects / to Review when accounts exist and to Setup when none do", async () => {
    const a = renderApp("/");
    await waitFor(() => expect(a.router.state.location.pathname).toBe("/review"));
    cleanup();
    const b = renderApp("/", (s) => void (s.accounts = []));
    await waitFor(() => expect(b.router.state.location.pathname).toBe("/setup"));
  });

  it("returns from OAuth to the remembered page with the same query", async () => {
    window.sessionStorage.setItem("clearbox.oauthReturn", "/setup");
    const { router } = renderApp("/settings/accounts?error=scope_missing&provider=gmail");
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(await screen.findByText("Some permissions were not granted.")).toBeTruthy();
    expect(window.sessionStorage.getItem("clearbox.oauthReturn")).toBeNull();
  });

  it("defaults the OAuth return to Accounts", async () => {
    const { router } = renderApp("/settings/accounts?error=access_denied&provider=gmail");
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
  });

  it("shows the 404 page with a way back", async () => {
    const { router, user } = renderApp("/nope");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByText("This page does not exist in Clearbox.")).toBeTruthy();
    expect(document.title).toBe("Page not found · Clearbox");
    await user.click(screen.getByRole("button", { name: "Go to Review" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/review"));
  });

  it("navigates with G sequences and focuses the new page title", async () => {
    const { router, user } = renderApp("/review");
    await screen.findByRole("heading", { level: 1, name: "Review" });
    await user.keyboard("gi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/insights"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Insights" })));
    await user.keyboard("gc");
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
  });

  it("registers the dev gallery in development", async () => {
    renderApp("/dev/components");
    expect(await screen.findByRole("heading", { level: 1, name: "Components" })).toBeTruthy();
  });

  it("renders the error boundary page for render errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("boom");
    }
    const router = createMemoryRouter([{ path: "/", element: <Boom />, errorElement: <RouteErrorPage /> }]);
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Something went wrong on this page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/routes.test.tsx`
Expected: FAIL with `Failed to load url ../../src/web/routes.tsx`.

- [ ] **Step 3: Implement the redirect, OAuth return and 404 pages**

`app/src/web/pages/RootRedirect.tsx`:

```tsx
import { Navigate } from "react-router";
import { useAccounts } from "../api/queries.ts";

/** "/" goes to Setup when no account exists, otherwise to Review (UI spec 3.5). */
export function RootRedirect() {
  const accounts = useAccounts();
  if (accounts.isPending) return null;
  return <Navigate to={accounts.data && accounts.data.accounts.length === 0 ? "/setup" : "/review"} replace />;
}
```

`app/src/web/pages/OAuthReturn.tsx`:

```tsx
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { consumeOAuthReturn } from "../lib/oauth-return.ts";

/** The server redirects OAuth callbacks to /settings/accounts (contracts 7.14); forward with the same query. */
export function OAuthReturn() {
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => {
    void navigate(`${consumeOAuthReturn()}${search}`, { replace: true });
  }, [navigate, search]);
  return null;
}
```

`app/src/web/pages/NotFoundPage.tsx`:

```tsx
import { useNavigate } from "react-router";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { useDocumentTitle } from "../state/use-document-title.ts";

export function NotFoundPage() {
  useDocumentTitle("Page not found · Clearbox");
  const navigate = useNavigate();
  return (
    <EmptyState variant="page" headingLevel={1} title="Page not found" body="This page does not exist in Clearbox."
      action={{ label: "Go to Review", onClick: () => void navigate("/review") }} />
  );
}
```

- [ ] **Step 4: Implement `routes.tsx` and replace `main.tsx`**

`app/src/web/routes.tsx`:

```tsx
import { createBrowserRouter, Outlet, type RouteObject } from "react-router";
import { AppShell } from "./components/shell/AppShell.tsx";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { RouteErrorPage } from "./pages/FullPageError.tsx";
import { InsightsPage } from "./pages/InsightsPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OAuthReturn } from "./pages/OAuthReturn.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { RootLayout } from "./pages/RootLayout.tsx";
import { RootRedirect } from "./pages/RootRedirect.tsx";
import { RulesPage } from "./pages/RulesPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";

/** UI spec 3.5. `import.meta.env.DEV` is replaced at build time, so production drops the gallery chunk. */
export function appRoutes(): RouteObject[] {
  const dev: RouteObject[] = import.meta.env.DEV
    ? [{ path: "/dev/components", lazy: async () => ({ Component: (await import("./pages/ComponentGallery.tsx")).ComponentGallery }) }]
    : [];
  return [
    {
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        { path: "/", element: <RootRedirect /> },
        { path: "/setup", element: <SetupPage /> },
        { path: "/settings/accounts", element: <OAuthReturn /> },
        {
          element: (
            <AppShell>
              <Outlet />
            </AppShell>
          ),
          children: [
            { path: "/review", element: <ReviewPage /> },
            { path: "/activity", element: <ActivityPage /> },
            { path: "/insights", element: <InsightsPage /> },
            { path: "/rules", element: <RulesPage /> },
            { path: "/accounts", element: <AccountsPage /> },
            ...dev,
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter() {
  return createBrowserRouter(appRoutes());
}
```

`app/src/web/main.tsx` (replace the whole file):

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { createQueryClient } from "./api/query-client.ts";
import { installCspListener } from "./lib/report.ts";
import { createAppRouter } from "./routes.tsx";
import "./styles.css";

installCspListener();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const queryClient = createQueryClient();
const router = createAppRouter();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

Delete plan 03's placeholder test, which imports the old entry and expects its placeholder heading:

Run: `git rm app/test/web/placeholder.test.tsx`
Expected: `rm 'app/test/web/placeholder.test.tsx'`.

- [ ] **Step 5: Run the routes test to verify it passes**

Run: `pnpm --filter @clearbox/app exec vitest run -c vitest.web.config.ts test/web/routes.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the whole SPA suite, typecheck, lint and the production build**

Run: `pnpm --filter @clearbox/app test:web`
Expected: every file under `app/test/web` passes; 0 failed.

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app typecheck`
Expected: exit 0 (no `satisfies` mismatch in `api/schemas.ts`, no implicit any).

Run: `pnpm lint`
Expected: exit 0. ESLint reports no `react-hooks/*` errors and the U+2014 scan in `scripts/check-text.ts` passes. If a `react-hooks/refs`, `set-state-in-effect` or `purity` error appears, move the flagged read or write into an effect or event handler; do not disable the rule.

Run: `CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm --filter @clearbox/app build`
Expected: exit 0; `cf build` writes the Worker bundle and the client assets to `app/.cloudflare/output/v0/` (research cloudflare.md section 1; plan 03 Task 1 Step 15). Then verify the shipped assets:

Run: `grep -rl "Components · Clearbox" app/.cloudflare/output/v0 || echo "gallery not shipped"`
Expected: `gallery not shipped`.

Run: `find app/.cloudflare/output/v0 -name index.html -exec grep -cE "<style|style=|<script>" {} \;`
Expected: `0` (the entry document has no inline style or inline script; the module script tag has a `src`).

- [ ] **Step 7: Commit**

```bash
git add app/src/web/routes.tsx app/src/web/main.tsx app/src/web/pages/RootRedirect.tsx app/src/web/pages/OAuthReturn.tsx app/src/web/pages/NotFoundPage.tsx app/test/web/routes.test.tsx app/test/web/placeholder.test.tsx
git commit -m "feat(web): wire the router, entry point, redirects, OAuth return and 404"
```

---

### Task 26: Synthetic dev seed and manual visual QA against the approved mockup

**Files:**
- Create: `app/test/web/fixtures/dev-seed.sql`
- No source changes. Fix any defect found in QA in the owning file with a test first (the task that created the file shows its test).

**Interfaces:**
- Consumes: plan 03's local dev setup (`pnpm dev` = `cf dev` on `http://localhost:5173`, `DEV_AUTH_BYPASS` on localhost, `app/.dev.vars`), plan 03's migration `0001_init.sql` (contracts 6.1 plus A4 `accounts.inbox_estimate`), plan 03 `pnpm db:migrate:local`.
- Produces: a reproducible synthetic local dataset (3 accounts, 10 sender groups, 228 pending suggestions, labels, batches, audit rows, budget, calibration) and a signed-off QA checklist.

- [ ] **Step 1: Write the seed (synthetic, reserved domains only)**

`app/test/web/fixtures/dev-seed.sql`:

```sql
-- Synthetic local data for visual QA (plan 05 Task 26). Never apply to a remote database.
-- Apply to a freshly migrated local D1. Accounts carry dummy token bytes and a far-future next_tick_at,
-- so ticks never claim them; actions that reach a mailbox (Clean up, Undo, Scan now) fail by design.

UPDATE settings SET value = '0.86', updated_at = unixepoch() * 1000 WHERE key = 'tau_delete';
INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('issues', '[]', unixepoch() * 1000),
  ('calibration',
   '{"tauDelete":0.86,"changed":true,"outcome":"calibrated","deleteSuggestions":412,"precisionAtTau":0.986,'
   || '"points":[{"tau":0.8,"support":120,"precision":0.979},{"tau":0.86,"support":96,"precision":0.986},{"tau":0.9,"support":60,"precision":0.99}],'
   || '"ranAt":' || (unixepoch() * 1000 - 9 * 3600000) || '}',
   unixepoch() * 1000);

INSERT INTO accounts (id, provider, email, provider_user_id, status, status_reason, paused, key_version,
  enc_refresh_token, refresh_iv, granted_scopes, owner_aliases_json, archive_folder_id, phase, sent_scanned,
  backfill_done, incremental_cursor, page_size, next_tick_at, last_tick_at, messages_ingested, inbox_estimate,
  created_at, updated_at)
VALUES
  ('acc_00000000000000a1', 'gmail', 'you@example.com', 'seed-user-1', 'active', NULL, 0, 1, X'00', X'00',
   'https://www.googleapis.com/auth/gmail.modify', '[]', NULL, 'incremental', 1000, 1, 'seed-cursor-1', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 4 * 60000, 32118, NULL,
   unixepoch() * 1000 - 30 * 86400000, unixepoch() * 1000),
  ('acc_00000000000000a2', 'outlook', 'you@example.net', 'seed-user-2', 'active', NULL, 0, 1, X'00', X'00',
   'Mail.ReadWrite offline_access', '[]', 'seed-archive', 'inbox_backfill', 1000, 0, 'seed-cursor-2', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 60000, 8200, 20000,
   unixepoch() * 1000 - 2 * 86400000, unixepoch() * 1000),
  ('acc_00000000000000a3', 'gmail', 'work@example.org', 'seed-user-3', 'needs_reauth', 'invalid_grant', 0, 1, X'00', X'00',
   'https://www.googleapis.com/auth/gmail.modify', '[]', NULL, 'incremental', 1000, 1, 'seed-cursor-3', 25,
   unixepoch() * 1000 + 30 * 86400000, unixepoch() * 1000 - 3 * 86400000, 5120, NULL,
   unixepoch() * 1000 - 60 * 86400000, unixepoch() * 1000);

WITH RECURSIVE
  g(gid, acc, sender, name, domain, action, base, n, subject, reasons, ceiling, applied) AS (VALUES
    (1, 'acc_00000000000000a1', 'promo@northwind.example', 'Northwind Deals', 'northwind.example', 'delete', 0.97, 48, 'Flash sale ends tonight',
     '[{"code":"prior_sender_deleted","params":{"deletes":41,"total":44}},{"code":"low_open_rate","params":{"openPct":2,"seen":52}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (2, 'acc_00000000000000a1', 'digest@news.example', 'Daily Digest', 'news.example', 'delete', 0.91, 36, 'Your morning digest',
     '[{"code":"bulk_mail","params":{}},{"code":"old_unread","params":{"ageDays":9}}]', 'delete', 0),
    (3, 'acc_00000000000000a2', 'orders@contoso.example', 'Contoso Orders', 'contoso.example', 'archive', 0.93, 22, 'Receipt for your order',
     '[{"code":"guard_record_pattern","params":{"pattern":"receipt"}}]', 'archive', 1),
    (4, 'acc_00000000000000a1', 'updates@fabrikam.example', 'Fabrikam Updates', 'fabrikam.example', 'archive', 0.79, 14, 'Release notes',
     '[{"code":"category","params":{"category":"updates"}}]', 'delete', 0),
    (5, 'acc_00000000000000a1', 'deals@tailspin.example', 'Tailspin Travel', 'tailspin.example', 'delete', 0.85, 19, 'Fares to the coast',
     '[{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (6, 'acc_00000000000000a2', 'mom@family.example', 'Mom', 'family.example', 'keep', 0.9, 3, 'Sunday lunch?',
     '[{"code":"guard_correspondent","params":{}}]', 'keep', 1),
    (7, 'acc_00000000000000a1', 'builds@ci.example', 'Build Bot', 'ci.example', 'unsure', 0.5, 9, 'Build finished',
     '[{"code":"low_confidence","params":{}}]', 'delete', 0),
    (8, 'acc_00000000000000a2', 'news@adventure-works.example', 'Adventure Works Weekly', 'adventure-works.example', 'delete', 0.96, 60, 'This week at Adventure Works',
     '[{"code":"prior_domain_deleted","params":{"deletes":30,"total":31,"domain":"adventure-works.example"}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (9, 'acc_00000000000000a1', 'alerts@litware.example', 'Litware Alerts', 'litware.example', 'archive', 0.88, 12, 'Your weekly alert summary',
     '[{"code":"auto_sent","params":{}}]', 'delete', 0),
    (10, 'acc_00000000000000a1', 'hello@proseware.example', 'Proseware', 'proseware.example', 'unsure', 0.4, 5, 'A note from Proseware',
     '[{"code":"model_unavailable","params":{}}]', 'delete', 0)),
  seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO messages (id, account_id, provider_msg_id, thread_id, internet_message_id, sender, sender_name, sender_domain,
  subject, snippet, received_at, is_read, signals_json, web_link, created_at)
SELECT gid * 1000 + i, acc, 'seed-' || gid || '-' || i, NULL, NULL, sender, name, domain,
  subject || ' (' || (i + 1) || ')', 'Synthetic preview text for message ' || (i + 1) || ' from ' || name || '.',
  unixepoch() * 1000 - (i + 1) * 3 * 3600000, i % 2,
  json_object('senderAddress', sender, 'senderDomain', domain, 'senderName', name, 'senderKnown', json('true'),
    'ownerReplied', json('false'), 'isCorrespondent', json(CASE WHEN gid = 6 THEN 'true' ELSE 'false' END),
    'senderSeenCount', n, 'senderOpenRate', 0.1, 'ownerDeleteRate', NULL, 'ownerDecisions', 0,
    'hasListUnsubscribe', json('true'), 'oneClickUnsubscribe', json('true'), 'hasListId', json('true'),
    'precedenceBulk', json('false'), 'autoSubmitted', json('false'), 'espDomain', NULL,
    'auth', json_object('spf', 'pass', 'dkim', 'pass', 'dmarc', 'pass'), 'category', NULL, 'starred', json('false'),
    'providerImportant', json('false'), 'ageDays', (i + 1) / 8, 'isRead', json(CASE WHEN i % 2 = 1 THEN 'true' ELSE 'false' END),
    'hasAttachments', json('false'), 'attachmentsApprox', json('false'), 'threadDepth', 1, 'ownerPosition', 'to'),
  CASE WHEN acc = 'acc_00000000000000a2' THEN 'https://outlook.office.com/mail/id/seed-' || gid || '-' || i ELSE NULL END,
  unixepoch() * 1000
FROM g JOIN seq ON seq.i < g.n;

WITH RECURSIVE
  g(gid, action, base, n, reasons, ceiling, applied) AS (VALUES
    (1, 'delete', 0.97, 48, '[{"code":"prior_sender_deleted","params":{"deletes":41,"total":44}},{"code":"low_open_rate","params":{"openPct":2,"seen":52}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (2, 'delete', 0.91, 36, '[{"code":"bulk_mail","params":{}},{"code":"old_unread","params":{"ageDays":9}}]', 'delete', 0),
    (3, 'archive', 0.93, 22, '[{"code":"guard_record_pattern","params":{"pattern":"receipt"}}]', 'archive', 1),
    (4, 'archive', 0.79, 14, '[{"code":"category","params":{"category":"updates"}}]', 'delete', 0),
    (5, 'delete', 0.85, 19, '[{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (6, 'keep', 0.9, 3, '[{"code":"guard_correspondent","params":{}}]', 'keep', 1),
    (7, 'unsure', 0.5, 9, '[{"code":"low_confidence","params":{}}]', 'delete', 0),
    (8, 'delete', 0.96, 60, '[{"code":"prior_domain_deleted","params":{"deletes":30,"total":31,"domain":"adventure-works.example"}},{"code":"list_unsubscribe","params":{}}]', 'delete', 0),
    (9, 'archive', 0.88, 12, '[{"code":"auto_sent","params":{}}]', 'delete', 0),
    (10, 'unsure', 0.4, 5, '[{"code":"model_unavailable","params":{}}]', 'delete', 0)),
  seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO suggestions (message_id, account_id, sender, sender_domain, status, action, confidence, p_delete,
  ceiling, ceiling_applied, reasons_json, model_version, policy_version, decision_attempts, created_at, updated_at, expires_at)
SELECT m.id, m.account_id, m.sender, m.sender_domain, 'pending', g.action,
  MIN(1.0, g.base + 0.02 - (seq.i % 5) * 0.01),
  CASE WHEN g.action = 'delete' THEN MIN(1.0, g.base + 0.02 - (seq.i % 5) * 0.01) ELSE 0.05 END,
  g.ceiling, g.applied, g.reasons, 'decision-1', 1, 1, unixepoch() * 1000, unixepoch() * 1000, unixepoch() * 1000 + 90 * 86400000
FROM g JOIN seq ON seq.i < g.n JOIN messages m ON m.id = g.gid * 1000 + seq.i;

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < 59)
INSERT INTO labels (account_id, message_id, sender, sender_domain, subject_trunc, suggested_action, owner_action, source,
  p_delete, margin, ceiling, model_version, policy_version, created_at, updated_at)
SELECT 'acc_00000000000000a1', NULL, 'old' || i || '@archive.example', 'archive.example', NULL, 'delete',
  CASE WHEN i = 7 THEN 'keep' ELSE 'delete' END, 'cleanup', 0.95, 0.4, 'delete', 'decision-1', 1,
  unixepoch() * 1000 - i * 3600000, unixepoch() * 1000 - i * 3600000
FROM seq;

INSERT INTO action_batches (id, created_at, kind, suggestion_ids_json, requested_count, executed_count, failed_count, undo_expires_at, undone_at) VALUES
  (1, unixepoch() * 1000 - 3600000, 'cleanup', '[]', 1284, 1280, 0, unixepoch() * 1000 + 23 * 3600000, NULL),
  (2, unixepoch() * 1000 - 3 * 3600000, 'approve', '[]', 248, 248, 0, unixepoch() * 1000 + 21 * 3600000, unixepoch() * 1000 - 2 * 3600000),
  (3, unixepoch() * 1000 - 2 * 86400000, 'override', '[]', 12, 12, 0, unixepoch() * 1000 - 86400000, NULL);

INSERT INTO audit_log (ts, account_id, kind, batch_id, count, result_json) VALUES
  (unixepoch() * 1000 - 30 * 86400000, 'acc_00000000000000a1', 'account_connected', NULL, 0, '{}'),
  (unixepoch() * 1000 - 4 * 86400000, 'acc_00000000000000a3', 'reauth_required', NULL, 0, '{"reason":"invalid_grant"}'),
  (unixepoch() * 1000 - 3 * 86400000, NULL, 'purge', NULL, 4210, '{}'),
  (unixepoch() * 1000 - 3 * 86400000 + 60000, NULL, 'calibration', NULL, 312, '{"tauDelete":0.86}'),
  (unixepoch() * 1000 - 2 * 86400000 - 3600000, NULL, 'policy_updated', NULL, 0, '{"allow":3,"deny":1}'),
  (unixepoch() * 1000 - 2 * 86400000, 'acc_00000000000000a1', 'override', 3, 12,
   '{"executed":12,"failed":0,"skipped":0,"retryLater":0,"delete":12,"archive":0,"keep":0,"groups":1}'),
  (unixepoch() * 1000 - 3 * 3600000, 'acc_00000000000000a1', 'approve', 2, 248,
   '{"executed":248,"failed":0,"skipped":0,"retryLater":0,"delete":248,"archive":0,"keep":0,"groups":1}'),
  (unixepoch() * 1000 - 2 * 3600000, 'acc_00000000000000a1', 'undo', 2, 248, '{"restored":248,"failed":0}'),
  (unixepoch() * 1000 - 3600000, NULL, 'cleanup', 1, 1284,
   '{"executed":1280,"failed":0,"skipped":4,"retryLater":0,"delete":1102,"archive":178,"keep":0,"groups":371}');

INSERT OR REPLACE INTO budget (date, rows_written, rows_read, ticks, messages_ingested, decision_calls, decision_failures,
  decision_input_tokens, provider_calls, db_size_bytes, updated_at)
VALUES (strftime('%Y-%m-%d', 'now'), 21080, 120000, 900, 3120, 3412, 2, 1400000, 2000, 182000000, unixepoch() * 1000);
```

- [ ] **Step 2: Reset, migrate and seed the local database**

Run: `rm -rf app/.cloudflare/state && pnpm db:migrate:local`
Expected: the migration `0001_init.sql` is applied to the local database (output lists `0001_init.sql` as applied).

Run: `pnpm --filter @clearbox/app exec cf d1 execute 00000000-0000-4000-8000-000000000000 --local --persist-to .cloudflare/state --file test/web/fixtures/dev-seed.sql`
Expected: success with no SQL error. If `cf d1 execute` does not exist in `cf` 1.0.0-beta.17, apply the same file with SQLite directly (decision W18):

Run: `sqlite3 "$(find app/.cloudflare/state -path '*d1*' -name '*.sqlite' | head -n 1)" < app/test/web/fixtures/dev-seed.sql`
Expected: no output (success).

Run: `sqlite3 "$(find app/.cloudflare/state -path '*d1*' -name '*.sqlite' | head -n 1)" "SELECT COUNT(*) FROM suggestions WHERE status = 'pending';"`
Expected: `228`.

- [ ] **Step 3: Start the app locally**

Run (async, keep it running during QA): `pnpm dev`
Expected: Vite and the Worker serve `http://localhost:5173`; `curl -s http://localhost:5173/api/me` returns JSON with `"email"` set to your `OWNER_EMAIL` from `app/.dev.vars` and `"tauDelete":0.86`.

- [ ] **Step 4: Visual QA at 1440, 1280 and 1024 pixels wide**

Open `docs/design/clearbox-ui-v4.html` in one browser window and `http://localhost:5173` in another. Use the browser's responsive mode at 1440 x 900, 1280 x 800 and 1024 x 800 (plus 1100, 900 and 390 for rows 20 and the layout checks). Repeat rows 1, 9 and 20 with `prefers-reduced-motion: reduce` emulated. Compare against the mockup section named in brackets; the deliberate differences in UI spec 9.2 are expected, not defects. Tick each row only when it matches the UI spec at all three primary widths.

- [ ] 1. Review ready, first row active, inline detail panel at 1280 and 1440, slide-over at 1024 (mockup section 1). Header meta "Sorted N min ago · catching up"; split bar and legend; confidence ticks sit at 86% on every meter.
- [ ] 2. Three rows selected: the selection toolbar replaces the header row with "3 groups selected · N emails".
- [ ] 3. Row hover tint, a 2px indigo focus ring inside the row (J, K), and a busy row (DevTools "Slow 3G", select two rows, press T: rows show the busy state; the seeded mailbox refuses the change, so they are restored with an error toast).
- [ ] 4. Loading skeletons (DevTools network throttling "Slow 3G", reload): skeleton geometry matches rows, no layout shift.
- [ ] 5. Nothing sure (temporarily `UPDATE settings SET value = '0.995' WHERE key = 'tau_delete'` with `sqlite3`, reload, then restore `0.86`); Review with no accounts (reset and migrate without seeding); all caught up and first sort are covered by the Review page tests and need only a visual glance on a reset database.
- [ ] 6. Each tab, including an empty tab, shows its count and copy.
- [ ] 7. Detail panel for Trash, Archive, Keep, Check, Protected (Contoso Orders), model unavailable (Proseware) and needs reconnect (switch the account filter to work@example.org).
- [ ] 8. Email row expanded: snippet, "Received … · 97% Very sure", per-email actions, "Open in Outlook" for you@example.net groups.
- [ ] 9. Clean up flow (mockup section 2): confirming bar copy "Clean up N emails in M sender groups?"; running, done and partial states in `/dev/components` (real runs cannot reach a mailbox with seeded tokens).
- [ ] 10. Keep tab: "Confirm all keeps" in the tab bar.
- [ ] 11. Banners: needs reconnect (work@example.org), setup error and model banners (temporarily set `issues` to `[{"code":"decision_auth_failed","since":"2026-10-15T00:00:00.000Z","accountId":null}]`), offline (DevTools offline).
- [ ] 12. Insights (mockup section 3): 98.3% agreement, 86% threshold, weekly chart, budget table with "Catching up" and "Needs reconnect", threshold table expanded.
- [ ] 13. Activity (mockup section 4): undoable, undone and expired rows (do not click Undo: the seeded batch has no restorable mail and shows an error toast); empty state on a fresh reset.
- [ ] 14. Accounts (mockup section 5): up to date, catching up with the 240px bar, needs reconnect; Disconnect inline confirm (Cancel, do not confirm); OAuth banners via `/accounts?error=access_denied&provider=gmail` and every other code in UI spec 5.5.
- [ ] 15. Rules (mockup section 6): clean, dirty with the unsaved banner, validation error ("nope"), conflict (edit in two tabs and save both).
- [ ] 16. `/dev/components` (mockup section 7): every card.
- [ ] 17. Setup: `/setup` before accounts (fresh reset), after seeding (sorting progress, Go to Review enabled).
- [ ] 18. Full-page errors: 404 (`/nope`), error boundary (temporarily throw in a page component), session expired and forbidden (block `/api/me` with a 401 response override in DevTools).
- [ ] 19. Shortcut help dialog (`?`), G sequence hint (press G and wait), user menu, detail More menu.
- [ ] 20. 1100px slide-over open; 900px drawer open and detail sheet; 390px Review is usable (two-line rows, tables scroll).

Also confirm on every page: no colored edge stripes, no em dashes in visible copy, Kbd hints hidden below 640px, every confidence shows a percentage and a band word, every verdict shows an icon and a word.

- [ ] **Step 5: Stop the dev server and record the result**

Stop the `pnpm dev` process. Expected: all 20 rows ticked. Any defect becomes a failing test plus fix in the owning task's file, then rerun `pnpm --filter @clearbox/app test:web`.

- [ ] **Step 6: Commit**

```bash
git add app/test/web/fixtures/dev-seed.sql
git commit -m "test(web): add synthetic local seed for visual QA"
```


## Execution notes

Executed on branch `feat/clearbox-05-web-ui` (stacked on `feat/clearbox-04-scan-pipeline`) with superpowers:subagent-driven-development: one implementer per task, a spec and quality review after each task (fix rounds on Tasks 1, 3, 5, 6, 9, 14 to 21, 23, 25 and the Task 26 QA wave), a final whole-branch review and one fix wave. No dependency was added; `packages/core`, contracts, the UI spec, the design spec and `PRODUCT.md` were not edited. No Produces name or label that plan 06 quotes changed.

### Gate 05 result

`pnpm test && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm typecheck && pnpm lint && pnpm format:check && CLEARBOX_D1_ID=00000000-0000-4000-8000-000000000000 pnpm build` passes: core `Test Files  40 passed (40)`, `Tests  635 passed (635)`; app worker `Test Files  49 passed (49)`, `Tests  387 passed (387)`; app web `Test Files  42 passed (42)`, `Tests  422 passed (422)`; `placeholder.test.tsx` is deleted; ESLint clean; `check-text: 452 tracked files clean`; Prettier clean; the build writes `app/.cloudflare/output/v0/` (one 621 kB JS chunk, Vite size warning only). `grep -rl "Components · Clearbox" app/.cloudflare/output/v0 || echo "gallery not shipped"` prints `gallery not shipped`; the `index.html` inline style or script count is `0`; `committed`.

Counts: core and worker are unchanged from Gate 04 (plan 05 touches neither). The web run grew from plan 03's 1 placeholder test to 42 files and 422 tests: the planned files plus regression tests for the fix rounds (for example undo partial results, focus traps, StrictMode OAuth return, key repeat, Clean up gating, per-target restore).

### Manual visual QA (Task 26 Step 4)

Run against `pnpm dev` with `test/web/fixtures/dev-seed.sql` at 1440, 1280 and 1024 wide (plus 1100, 900, 390; reduced motion for rows 1, 9, 20), driving headless Chrome over the DevTools Protocol from a throwaway Node script (no repository dependency). Screenshots and the full findings live under the git-ignored `.superpowers/qa-05/` (not committed).

- First pass: 13 rows PASS, 7 GAP (rows 2, 4, 7, 9, 11, 19, 20). Global checks clean on every page: no em dashes, no colored edge stripes (selection is a soft tint), every confidence shows a percentage and a band word, every verdict an icon and a word, ticks at 86% on every meter (99.5% with tau 0.995), band fills and inks match the owner hexes.
- Material gaps fixed (tests where testable, re-captured): selection toolbar taller than the header row and wrapping at 1280 (G1); summary and detail skeletons causing layout shift (G2); confidence label overflowing the 300px verdict card (G3); summary button reading "Cleaning up…" while only confirming (G4); detail More menu clipped by the panel and items overlapping (G6, Menu now `position: fixed` through `--cb-menu-x/y`, flips and clamps); summary card not stacking below 1024 (G7). Also fixed: Select chevron detached (C7), help dialog "1 to 5" (C9), no meters below 1024 (C10), keeps confirm bar label (C11), detail actions in two deliberate rows (C12).
- G5 is intended: the model banner adds "This clears after the next successful sort." for `decision_auth_failed` and `decision_deployment_not_found` (layer note 6). Lead: update UI spec 5.1.
- Deferred cosmetic: 12h clock zero padding in en-US (C1), threshold table column alignment (C2), Activity "When" wrapping (C3), empty ChipInput indent (C4), gallery Kbd label and confidence scale card (C5, C6), Setup sorting lines not naming the account (C8).
- Not checked on screen (covered by tests): live busy rows via T, reset-database states (no accounts, first sort, empty Activity, Setup before accounts), the needs-reconnect detail panel (the seed has no pending groups for that account), the error boundary, and real Clean up runs and Undo (seeded tokens cannot reach a mailbox; states checked in `/dev/components`).

All 20 rows are ticked after the fix wave, with the not-on-screen items above covered by the test suite.

### Lead notes from earlier layers

| # | Handling |
|---|---|
| 1 | Clean up counts and execution come from the server preview (active accounts only); the confirm copy adds "Emails from <email> are skipped until you reconnect it." for every non-active account (`needs_reauth` and `config_error`); done and partial toasts report only executed items; "left for you" uses `QueueSummary.pending.total`, consistent with `CleanupPreview.groupsLeft`, which already counts inactive accounts' groups as left. "Confirm all keeps" uses keeps wording and covers every visible account. |
| 2 | The undo stack consumes an entry before calling the server and never offers a retry; partial results report "Restored N emails. Some could not be restored."; an undo that restored nothing and failed nothing (keep batches) shows an info toast; Activity offers Undo again only when nothing was restored and something failed (the server keeps that batch undoable). The fake API undo now skips keep items like the server. |
| 3 | `decision_not_configured` copy explains that the endpoint must be https and the deployment cannot be named `Microsoft-Decision-1`; Setup step 2 reuses the same copy. |
| 4 | `ReasonList` renders 0 to 3 reasons and nothing for an empty list. |
| 5 | Scan now: `account_inactive` with `retryAt` reads "<email> is retrying after a problem. Next try at HH:MM."; without it "<email> is paused."; `account_busy` and `budget_exhausted` use `retryAt`; a 200 `TickReport` with `outcome: "error"` reads "Scan hit a problem. Clearbox will retry automatically."; `idle` reads "No new emails.". Accounts cards reuse the same hook. |
| 6 | See G5 above; `decision_not_configured` does not promise anything about clearing. |
| 7 | Gate 05 reads `app/.cloudflare/output/v0/`; the seed is applied after `pnpm db:migrate:local`. |
| 8 | See "Counts" above. |

### Deviations (fix forward)

| # | Task | Change | Why |
|---|---|---|---|
| 1 | 1 | `test/web/msw/fixtures.ts` and `fake-api.ts` are barrels over `fixtures-*.ts` and `fake-api-state.ts`; `setup.ts` drops happy-dom's non-2xx fetch log and lone offline `TypeError` (`test/web/node-console.d.ts`) | 300-line rule; pristine test output |
| 2 | 2 | `readTokens()` uppercases hex | Prettier lowercases CSS hex |
| 3 | 3 | `scaleBands`: Likely is `70 to toPercent(tau) - 1` (no cap at 94); Very sure starts at `max(95, toPercent(tau))` | UI spec 4.12 wins over the plan code; tau is always a whole percent (core `round2` on `TAU_STEP`) |
| 4 | 4, 6 | `ApiError.retryAt`; `runCleanup` reports unexpected errors with `reportBug`; `actOnGroup` counts only failed and retry-later codes and keeps non-API errors as `details` | Scan-now cases; UI spec 5.2.2; Reconnect hint accuracy |
| 5 | 9 | Undo settles every batch and reports partial results; the originating toast is reused (`UndoEntry.toastId`); `toast.update` re-shows a missing toast; focus-within resets when the toast turns busy | UI spec 5.2.2; stale Undo after mod+Z; stuck timer |
| 6 | 10, final | `useHotkeys` bindings ignore key auto-repeat unless `repeat: true` (J, K, arrows) | Holding T trashed group after group; holding mod+Z walked the undo stack |
| 7 | 14 | `use-focus-trap` listens on `document` and reads the root lazily; the sheet activates it only when mounted | Trap never installed on late mount |
| 8 | 15 | Enter in the confirm bar confirms only from the body, the bar or the confirm button (other focused bar buttons run their own action); queues refresh after partial runs; run rejections end in an `unexpected` partial; keeps wording ("Nothing left to confirm…", "Couldn't prepare Confirm all keeps. Nothing was changed.", "N could not be confirmed."); zero-executed done toast "Nothing needed cleaning up (N were already handled)." | Enter on Cancel ran a destructive Clean up; stale lists; stuck machine; accurate copy |
| 9 | 16 | Drawer closes on any location change; `visibleBanners()` filters and orders `extra` banners | UI spec 4.2, 3.4 |
| 10 | 17 | Failed group or item actions restore only their own target (`captureGroupPositions`, `restoreGroup`, `captureItemPositions`, `restoreItem`); `formatClock` in `lib/format.ts` | The plan's whole-cache snapshot resurrected concurrent successful actions |
| 11 | 18 | Controller split into `use-review-focus.ts`, `use-review-effects.ts`, `select-all.ts` (bounded at 20 page fetches, stops on error); T/A/E/X and bulk approve gated while Clean up prepares, confirms or runs; detail actions soft-disabled meanwhile (`actionsDisabled`); `tau: number \| null` shows loading instead of `tau ?? 0`; `ReviewWorkArea` takes `{ c }` | 300-line rule; infinite paging loop; brief gated preparing only; no constant tau |
| 12 | 19 | Insights keeps loaded data on a failed background refetch; chart bars are focusable `role="img"` | Transient errors blanked the page; bars had no action |
| 13 | 20 | "1 old record removed" (W16); focus moves to the "Undone" text after Undo; table waits for activity, accounts and batches | Natural singular; focus loss; flashes of "Undo expired" |
| 14 | 21, 23, final | Accounts focus returns to the menu trigger in the narrow layout and to the h1 after disconnect; consent banners per account and dismissible; Connect buttons show "Opening Google…" / "Opening Microsoft…" and reset on a back-forward cache restore (`use-pageshow-reset.ts`); Setup never shows success rows without data | Accessibility; stuck buttons |
| 15 | 25 | `OAuthReturn` reads the remembered target once (`useState` initializer); `RootRedirect` shows a loading status | StrictMode double effects in development sent first-run OAuth returns to `/accounts` |
| 16 | 26 | Seed applied with `cf d1 raw <id> --local --persist-to .cloudflare/state --sql="$(cat test/web/fixtures/dev-seed.sql)"` (needs `CLEARBOX_D1_ID`; `--sql=` with an equals sign because the file starts with `--`) | `cf d1 execute` does not exist in `cf` 1.0.0-beta.17 (index item 12) |
| 17 | final | `styles.css` split into `styles.css` (tokens, base) and `styles-layers.css`; an `errorElement` on the AppShell route keeps root providers mounted on a page error; `insights` joins `ACTION_CACHE_PREFIXES`; config errors count as skipped accounts in Clean up copy | 300-line rule; a page error mid Clean up unmounted the run; stale Insights |

### Routes and labels for plan 06 docs

Routes: `/` (redirects to `/setup` without accounts, else `/review`), `/setup`, `/review`, `/activity`, `/insights`, `/rules`, `/accounts`, OAuth landing `/settings/accounts?connected=<id>` or `?error=<code>&provider=<kind>` (forwards to the remembered page or `/accounts`), `/dev/components` (development only). Sidebar: Review, Activity, Insights, Rules, the Accounts list with "Add account". Labels verbatim: "Connect Gmail", "Connect Outlook", "Scan now", "Pause", "Resume", "Disconnect", "Reconnect", "Undo", "Clean up", "Confirm all keeps", banners "Google sign-in is misconfigured." and "Microsoft sign-in is misconfigured.".

### Notes for later plans

- Plan 06 / lead:
  - Contract conflict: UI spec 5.2.6 promises Undo for keep decisions, but contracts 7.8 and the server skip keep items on undo. The UI shows an info toast ("Nothing needed restoring…") instead of a false success; decide whether the server should reset keeps to pending or the UI should drop Undo on keep toasts.
  - Add to the UI spec: the G5 banner sentence, the Scan now retrying and failed-tick toasts, the zero-executed Clean up toast, the keeps partial wording, "1 old record removed".
  - Contracts 1.1: add `src/web/lib/`, `src/web/state/` and the extra modules (W4 plus `pages/review/select-all.ts`, `use-review-focus.ts`, `use-review-effects.ts`, `state/use-pageshow-reset.ts`, `styles-layers.css`).
  - The production bundle is one 621 kB chunk (191 kB gzip); consider route-level splitting.
  - Spec 5.5 account cards show status as text without a dot while the global rule says "dot plus text"; reconcile.

### Deferred minor findings (triaged by the final review as safe to defer)

Test depth (opaque-redirect branch, runtime parsing for some endpoints, Dialog Escape and focus return, Menu typeahead, W16 singular copy in SummaryCard, item-action failure restore, cancel after retry); envelope-less 403 not mapped to `forbidden`; Enter bindings still call `preventDefault` on focused links and buttons outside the confirm bar while it is open; ConfidenceLabel says "left for you" for a Keep verdict in the Likely band (spec 4.12 literal, W17 covers row names); Menu, Tabs and Dialog polish (modifier chords, chip removal focus, Dialog children mounted while closed); `use-media-query` resubscribes per render; Table remounts across 40rem; skeleton and SR loading text gaps; consent dismissal persists per session; Gmail revoke-failed toast has no link; override loop resends permanently failed ids; Scan now in all-accounts mode is silent when every account is paused; cosmetic QA items C1 to C6 and C8.
