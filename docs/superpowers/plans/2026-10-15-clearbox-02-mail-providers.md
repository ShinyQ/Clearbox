# Clearbox Mail Providers Implementation Plan (plan 02 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Gmail and Microsoft Graph mail providers inside `@clearbox/core`: OAuth helpers, the `MailProvider` implementations (`createGmailProvider`, `createGraphProvider`), the Gmail multipart batch codec, provider error classification, normalization to `MailMessage`, plus the MSW fakes that later plans use to test ticks and actions.

**Architecture:** Hand-written `fetch` clients only (no SDKs). Every provider receives `fetch`, a `TokenSource` and `now` through `ProviderDeps`, issues requests strictly one at a time, refreshes the access token once on a 401, and maps every failure to the contracts error classes (section 4.12). Pure mapping and cursor code lives in `providers/*/map.ts`, error classification in `providers/*/oauth.ts`, and the request flow in `gmail.ts` / `graph.ts`. Tests run in Node with Vitest and MSW over an in-memory `FakeMailbox` that renders the same synthetic messages in Gmail and Graph wire shapes.

**Tech Stack:** TypeScript 6.0.3 (strict, erasable syntax only), Node 24.13.1, pnpm 12.11.2, Vitest 5.0.4, MSW 3.0.3 (`msw`, `msw/node`). Gmail API v1, Microsoft Graph v1.0, Google and Entra OAuth 2.0 with PKCE S256.

## Global Constraints

- Contracts doc `docs/superpowers/specs/2026-10-15-clearbox-contracts.md` is the source of truth; section 12 (rev 2.1 amendments) overrides earlier sections. Research facts come from `docs/superpowers/research/mail-providers.md`.
- Runtime and tools: Node.js 24.13.1 (`engines` `>=24.13.0`), pnpm 12.11.2, TypeScript 6.0.3, Vitest 5.0.4, MSW 3.0.3. This plan adds **no** dependency.
- ESM only; relative imports use explicit `.ts` extensions; `import type` for type-only imports (`verbatimModuleSyntax`); erasable syntax only (no `enum`, no `namespace`, no parameter properties); no `any`; no non-null assertions outside tests; named exports only.
- `packages/core/src` must not import `node:*`, `cloudflare:*`, `hono`, `@cloudflare/*`, `react`. Only Web globals: `fetch`, `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextDecoder`, `atob`.
- Pure core: `fetch`, `now` and token sources are parameters; core never reads `Date.now()` or environment variables.
- Files: kebab-case, one responsibility, aim under 300 lines, **anything over 500 lines must be split**. Tests mirror `src/` paths under `packages/core/test/`.
- **No em dashes (U+2014)** anywhere: code, comments, docs, test names, commit messages. En dashes in numeric ranges are allowed.
- Fixtures are synthetic only: `example.com`, `example.net`, `example.org`, `*.test`, `*.example`; the owner is `owner@example.test`. No real message content, ids, names, tokens or keys.
- Error messages never contain email content, tokens or response bodies. Core never logs.
- `MailProvider` has no hard-delete method; Gmail uses only `gmail.modify` (cannot hard-delete).
- Graph: **every request and every `$batch` sub-request** carries `Prefer: IdType="ImmutableId"`; delta requests add `Prefer: odata.maxpagesize=<n>` on the same `Headers`.
- Never two concurrent requests to one mailbox. Gmail batch at most 50 parts; Graph `$batch` at most 20 sub-requests; at most 100 ids per action call.
- Prettier: `printWidth` 110, double quotes, trailing commas `all`, semicolons. ESLint: `@typescript-eslint/consistent-type-imports`, `no-explicit-any`, strict and stylistic presets.
- Time in tests is always injected (`now`); compare floats with `toBeCloseTo(x, 9)`; one `describe` per exported function.

---

## Contract issues and decisions

The contracts doc is not edited by this plan. Each item records a gap or contradiction found in plan 02's scope and the decision this plan implements. The lead should fold them into the contracts doc (plan 00 cross-plan review).

1. **A4 inbox estimate (contracts 12.1) needs a provider surface.** Decision: add `inboxEstimate(): Promise<number | null>` to `MailProvider` (Task 3, edits plan 01's `providers/provider.ts`). The name matches plan 04's assumption (its issue C26, `fetchInboxEstimate` in `scan/tick.ts`). Gmail: `GET /gmail/v1/users/me/labels/INBOX` `messagesTotal` (1 quota unit, allowed with `gmail.modify`). Graph: `GET /me/mailFolders/inbox?$select=totalItemCount`. One request, best effort: rate limit, 5xx, network and shape problems return `null`; `ProviderAuthError`, `ProviderConfigError` and `SubrequestBudgetError` still throw. `BootstrapResult` is **not** extended, so `bootstrap()` keeps its contract request list: plan 03's `completeConnect` calls `inboxEstimate()` once after `bootstrap()` (best effort, its decision 27) and plan 04 refreshes the column at most daily during backfill. Plan 03's test `FakeProvider` (`app/test/worker/helpers/fake-provider.ts`) implements `inboxEstimate` (configurable value, recorded call), so it satisfies `MailProvider`. Plan 01's `test/providers/types.test.ts` stub is updated by Task 3.
2. **Ownership of `text/*.ts`.** Plan 01 implements `text/rfc2047.ts`, `text/address.ts`, `text/headers.ts`, `text/truncate.ts` (observed in plan 01's drafts). Plan 02 consumes them with these exact signatures: `unfoldHeader(value: string): string`, `decodeEncodedWords(input: string): string`, `parseAddress(raw: string | null): MailAddress`, `parseAddressList(raw: string | null): MailAddress[]`, `headerValue(headers: readonly RawHeader[], name: string): string | null`, `parseAuthResults(value: string | null): ParsedAuthResults` (with `authservId: string \| null`), `truncateChars(text, max)`, `collapseWhitespace(text)`, `decodeHtmlEntities(text)`, `interface RawHeader { name: string; value: string }`. Provider-level header normalization (A-R selection, `MailHeaders`, multi-value headers) is implemented here, and decoding edge cases are covered by the mapping tests in Tasks 6 and 7.
3. **`http/multipart.ts` signatures were unspecified.** Decision: `buildBatchBody(parts, boundary): string`, `boundaryFromContentType(contentType): string | null`, `parseBatchResponse(body, contentType): BatchResponsePart[] | null` with `BatchRequestPart { contentId; method: "GET" | "POST"; path; body? }` and `BatchResponsePart { contentId; status; headers (lowercased names); bodyText }`.
4. **`providers/oauth.ts` "provider-agnostic shell" signatures were unspecified, and 1.1 lists no shared provider helper file.** Decision: plan 01 owns the types and constants at the top of `providers/oauth.ts`; plan 02 appends `TokenEndpoint`, `buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `parseTokenResponse`, plus shared helpers used by both providers (`isJsonObject`, `readJsonBody`, `sendGuarded`, `parseCursorJson`, `stringField`, `bestEffortCount`, `chunkIds`, `headerValues`, `selectAuthenticationResults`, `buildMailHeaders`, `uniqueAddresses`). Suggested contracts follow-up: move the helpers to a listed `providers/shared.ts`.
5. **File-size rule vs the fixed file list.** `gmail.ts` and `graph.ts` would exceed 500 lines. Decision, using only listed files: cursor codecs and the pure history scan live in `google/map.ts`; Gmail batch-part classification (`classifyPart`, `toActionOutcome`) lives in `google/oauth.ts`; Graph `$batch` sub-response classification (`graphMoveResult`, `subRetryAfter`, `isDeltaExpired`) lives in `microsoft/oauth.ts`; the Graph incremental cursor codec lives in `microsoft/map.ts`.
6. **Gmail batch partial failures (contracts 4.3.2 says "retried once ... then dropped").** Dropping is unsafe for page-token backfill (a dropped message is never listed again). Decision: retry failed parts once in the same call (429, 403 rate reasons, 5xx, missing part; 401 parts after one `forceRefresh`). Afterwards: still rate limited: throw `ProviderRateLimitError` (the page is retried by a later tick, nothing lost); every part of a chunk failed: throw `ProviderUnavailableError`; otherwise 404 parts and persistently 5xx parts are dropped (matches the contract for the rare broken message).
7. **Gmail batch auth failures are per part.** The research probe shows an expired token yields outer `200` with every part `401`. Decision: a 401 part triggers one `forceRefresh` and a retry of those parts; a second 401 throws `ProviderAuthError("unauthorized")`.
8. **Gmail sent metadata headers were unspecified.** Decision: sent parts request `metadataHeaders` `To`, `Cc`, `Bcc` with `fields=id,threadId,internalDate,payload(headers)`.
9. **Gmail incremental call shape.** Decision: one `syncChanges` call does either one catch-up `messages.list` page (after `resyncCursor`) or one `history.list` page, never both, and fetches inbox and sent metadata in one combined batch (25 + 25 parts on Free). This keeps the incremental Gmail column of contracts 8.4 at 1 list + 1 metadata batch. `labelsAdded` `INBOX` counts as an inbox add (restored outside Clearbox; the caller deduplicates known ids); `labelsAdded` `TRASH`, `labelsRemoved` `INBOX` and `messagesDeleted` count as removals. A single history record above `maxMessages` (not observed in practice) keeps only the first `maxMessages` ids. `resyncCursor(watermark)` sets `catchupAfter = floor(watermark / 1000) - 1` (one second of overlap; duplicates are deduplicated by the caller).
10. **Gmail archive with a vanished id.** `batchModify` rejects the whole call (400 or 404). Decision: fall back to per-message `POST .../modify` through the batch endpoint to return per-item results.
11. **Graph `resyncCursor`.** Following a watermark-filtered delta round to its `deltaLink` (as bootstrap does) would skip mail received between the watermark and now. Decision: `resyncCursor` makes **no request** and returns the unfollowed initial filtered delta URLs; `syncChanges` pages through them and ingests everything since the watermark. Bootstrap still follows its `ge <now>` round to the `deltaLink`.
12. **Graph delta expiry codes.** Decision: `410` or any 4xx whose `error.code` is `syncStateNotFound`, `syncStateInvalid` or `resyncRequired` (case-insensitive) throws `CursorExpiredError("incremental")`.
13. **Graph header fallback sub-request failures were unspecified.** Decision: 404 drops the message; 429 throws `ProviderRateLimitError` (sub-request `Retry-After`, else `backoffMs(1)`); 5xx or a missing sub-response throws `ProviderUnavailableError`; any other status keeps the message with empty headers.
14. **Graph archive folder resolution failures.** Contracts say "on failure `archiveFolderId = null`". Decision: 404 then `POST /me/mailFolders {"displayName":"Archive"}`; a non-transient failure (403 and similar) gives `null`; 401 (after refresh), 429 and 5xx propagate so a transient error fails the connect (`profile_failed`) instead of disabling archive permanently.
15. **Cursor errors.** A corrupt or unknown-version cursor throws `CursorExpiredError` of its kind. A rejected Gmail page token (400) throws `CursorExpiredError("backfill" | "sent" | "incremental")`; a rejected Graph sent `nextLink` (400) throws `CursorExpiredError("sent")`. Contracts 8.2 does not say how the tick handles `CursorExpiredError("sent")`: recommended for plan 04, restart the sent scan with cursor `null`.
16. **Token safety for stored links.** Graph `nextLink` / `deltaLink` values come from D1. Decision: the Graph client refuses any URL not starting with `https://graph.microsoft.com/` (`ProviderResponseError` with `status: 0`) so a tampered cursor cannot leak the bearer token.
17. **API error reasons.** Contracts list example reasons only. Decision: Gmail 401 `unauthorized`, 403 `domainPolicy` `domain_policy`, 403 `insufficientPermissions` `insufficient_scope`; Graph 401 `unauthorized`, 403 the Graph `error.code` (else `forbidden`). Any other unexpected status is `ProviderResponseError`.
18. **`hasGraphScopes`** checks `Mail.ReadWrite` only (contracts doc comment); a missing `User.Read` surfaces as `profile_failed` at connect.
19. **`MICROSOFT_CONSENT_URLS`** is defined by plan 01 in `providers/oauth.ts` (contracts 4.4 places it with the Microsoft functions); plan 02 does not redefine it.
20. **Microsoft refresh-token rotation.** `refreshMicrosoftToken` returns the new token in `OAuthTokens.refreshToken`; persisting it (also when the tick later fails) is the worker `TokenSource` (contracts 7.15, plans 03 and 04). `null` means Entra omitted it and the stored token stays valid.
21. **Gmail deep link** has a format (contracts 7.6 `deepLink` comment) but no function. Decision: `buildGmailDeepLink(email, providerMessageId)` in `google/map.ts`.
22. **Snippets.** Gmail snippets are HTML-entity decoded; Graph `bodyPreview` is already plain text and is only whitespace-collapsed (decoding entities there would corrupt literal `&amp;` text). Both are truncated to 255 code points.
23. **Thread depth.** Gmail: References count + 1; with `In-Reply-To` but no `References`: 2. Graph: `(bytes - 22) / 5 + 1` from `conversationIndex`, null when shorter than 22 bytes or malformed.
24. **Graph wire types** add `conversationIndex` and `sentDateTime` (both selected by contracts 4.3.2) to the research section 8 shapes; `GraphBatchSubResponse.headers` is normalized to `Record<string, string>`.
25. **Ids per call above 100** throw `ClearboxError("too_many_ids")` (a programming error, never user data).
26. **MSW catch-alls (contracts 10.3).** A global `http.all("*")` at the end of every handler set would shadow later sets when they are combined. Decision: each factory ends with an origin-scoped catch-all (for example `https://gmail.googleapis.com/*`) that throws `Unhandled request <METHOD> <origin><pathname>`; plan 01's `test/setup/msw.ts` already fails any other unhandled request.
27. **MSW 3 API.** Handlers use `http` and `HttpResponse` from `msw` and `server.use` from plan 01's `test/setup/msw.ts` (which uses MSW 3's `onUnhandledFrame`). Verified with msw 3.0.3.
28. **Test helper files.** Contracts 10.3 names the handler files; this plan also adds `test/msw/failures.ts` (`FailRule`, `FailureQueue`, shared by mailbox and OAuth fakes) and `test/providers/error-table.ts` (table-driven classification helper). Provider tests are split per task: `gmail.test.ts`, `gmail-sync.test.ts`, `gmail-actions.test.ts`, `graph.test.ts`, `graph-sync.test.ts`, `graph-actions.test.ts` (contracts 10.1 names only the first two; the split keeps each file under 300 lines).
29. **Contracts 3.8 ESLint rule** `no-console: ["error", { allow: [] }]` is rejected by ESLint 10.12.0 ("Value [] should NOT have fewer than 1 items"); plan 01 or 06 should use `"no-console": "error"`. Not in plan 02's files; recorded for the lead.

---

## File Structure

All paths are inside `packages/core/`. "Plan 01" files exist before this plan starts.

| Path | Status | Responsibility |
|---|---|---|
| `src/http/multipart.ts` | Create | Gmail batch request body builder and robust `multipart/mixed` response parser |
| `src/providers/oauth.ts` | Modify (append; plan 01 owns the top) | Token endpoint shell (`exchangeCode`, `refreshAccessToken`) and helpers shared by both providers |
| `src/providers/provider.ts` | Modify (plan 01 file) | A4: `MailProvider.inboxEstimate()` |
| `src/providers/google/types.ts` | Create | Google OAuth and Gmail wire types |
| `src/providers/google/oauth.ts` | Create | Google authorize URL, exchange, refresh, revoke, scope check; Gmail API and batch-part error classification |
| `src/providers/google/map.ts` | Create | Metadata paths, `GmailMessageMetadata -> MailMessage`, sent items, cursors, history scan, deep link |
| `src/providers/google/gmail.ts` | Create | `createGmailProvider` |
| `src/providers/microsoft/types.ts` | Create | Entra and Graph wire types |
| `src/providers/microsoft/oauth.ts` | Create | Entra authorize URL, exchange, rotating refresh, scope check; Graph error, delta-expiry and `$batch` classification |
| `src/providers/microsoft/map.ts` | Create | `$select` constants, `graphUrl`, `GraphMessage -> MailMessage`, sent items, incremental cursor |
| `src/providers/microsoft/graph.ts` | Create | `createGraphProvider` |
| `src/index.ts` | Modify (plan 01 file) | Public exports for everything above |
| `test/testing.ts` | Modify (plan 01 file) | Re-export builders, fakes and handler factories as `@clearbox/core/testing` |
| `test/fixtures/builders.ts` | Modify (plan 01 file) | `makeGmailMetadata`, `makeGraphMessage` |
| `test/fixtures/gmail/*.json`, `test/fixtures/graph/*.json`, `test/fixtures/oauth/*.json` | Create | Synthetic fixtures and error tables |
| `test/msw/failures.ts` | Create | `FailRule`, `FailureQueue` |
| `test/msw/fake-mailbox.ts` | Create | `FakeMailbox`, `FakeTokenSource` |
| `test/msw/gmail.ts`, `test/msw/graph.ts` | Create | Gmail REST + batch and Graph REST + delta + `$batch` fakes |
| `test/msw/google-oauth.ts`, `test/msw/microsoft-oauth.ts` | Create | Token endpoint fakes (`FakeOAuthState`) |
| `test/http/multipart.test.ts`, `test/providers/**/*.test.ts`, `test/providers/error-table.ts` | Create | Tests |
| `test/providers/types.test.ts` | Modify (plan 01 file) | Keep plan 01's stub provider compiling after A4 |

Task order and dependencies: 1 (multipart) and 2 (shell) and 3 (A4 interface) first; 4 and 5 (OAuth and classification) need 1 and 2; 6 and 7 (mapping) need 2, 4, 5; 8 to 10 (Gmail provider) need 1 to 6; 11 to 13 (Graph provider) need 2, 3, 5, 7 and the `FakeMailbox` from Task 8; 14 (exports) needs all; 15 is manual and optional.

---

### Task 1: Gmail batch multipart codec

**Files:**
- Create: `packages/core/src/http/multipart.ts`
- Test: `packages/core/test/http/multipart.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`src/http/multipart.ts`):
  - `interface BatchRequestPart { contentId: string; method: "GET" | "POST"; path: string; body?: unknown }`
  - `interface BatchResponsePart { contentId: string; status: number; headers: Record<string, string>; bodyText: string }` (header names lowercased, `contentId` without `<response-` and `>`)
  - `buildBatchBody(parts: readonly BatchRequestPart[], boundary: string): string`
  - `boundaryFromContentType(contentType: string | null): string | null`
  - `parseBatchResponse(body: string, contentType: string | null): BatchResponsePart[] | null` (null when the boundary is missing or absent from the body; malformed parts are skipped)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/http/multipart.test.ts` (the inline multipart response is a synthetic copy of the observed Gmail batch shape, research section 2.4):

```ts
import { describe, expect, it } from "vitest";
import { boundaryFromContentType, buildBatchBody, parseBatchResponse } from "../../src/http/multipart.ts";

const CRLF_RESPONSE = [
  "This preamble must be ignored.",
  "--batch_resp_01",
  "Content-Type: application/http",
  "Content-ID: <response-m2>",
  "",
  "HTTP/1.1 429 Too Many Requests",
  "Content-Type: application/json; charset=UTF-8",
  "Retry-After: 30",
  "",
  '{ "error": { "code": 429, "message": "Too many concurrent requests for user", "errors": [ { "reason": "rateLimitExceeded" } ] } }',
  "--batch_resp_01",
  "Content-Type: application/http",
  "Content-ID: <response-m0>",
  "",
  "HTTP/1.1 200 OK",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{ "id": "18f0000000000001", "threadId": "18f0000000000001", "labelIds": ["INBOX"] }',
  "--batch_resp_01",
  "Content-Type: application/http",
  "Content-ID: <response-m1>",
  "",
  "HTTP/1.1 404 Not Found",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{ "error": { "code": 404, "message": "Requested entity was not found.", "errors": [ { "reason": "notFound" } ] } }',
  "--batch_resp_01",
  "Content-Type: application/http",
  "Content-ID: <response-m3>",
  "",
  "HTTP/1.1 204 No Content",
  "",
  "--batch_resp_01--",
  "",
].join("\r\n");

describe("buildBatchBody", () => {
  it("renders one application/http part per request with CRLF and a closing delimiter", () => {
    const body = buildBatchBody(
      [
        { contentId: "m0", method: "GET", path: "/gmail/v1/users/me/messages/a1?format=metadata" },
        {
          contentId: "m1",
          method: "POST",
          path: "/gmail/v1/users/me/messages/a2/modify",
          body: { addLabelIds: ["INBOX"] },
        },
      ],
      "b_test",
    );
    expect(body).toBe(
      "--b_test\r\nContent-Type: application/http\r\nContent-ID: <m0>\r\n\r\n" +
        "GET /gmail/v1/users/me/messages/a1?format=metadata\r\n\r\n" +
        "--b_test\r\nContent-Type: application/http\r\nContent-ID: <m1>\r\n\r\n" +
        "POST /gmail/v1/users/me/messages/a2/modify\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
        '{"addLabelIds":["INBOX"]}\r\n' +
        "--b_test--\r\n",
    );
  });
});

describe("boundaryFromContentType", () => {
  it("reads bare and quoted boundaries", () => {
    expect(boundaryFromContentType("multipart/mixed; boundary=batch_abc")).toBe("batch_abc");
    expect(boundaryFromContentType('multipart/mixed; boundary="batch abc"; charset=UTF-8')).toBe("batch abc");
  });
  it("returns null when absent", () => {
    expect(boundaryFromContentType("application/json")).toBeNull();
    expect(boundaryFromContentType(null)).toBeNull();
  });
});

describe("parseBatchResponse", () => {
  it("maps parts by Content-ID regardless of order and keeps status, headers and body", () => {
    const parts = parseBatchResponse(CRLF_RESPONSE, "multipart/mixed; boundary=batch_resp_01");
    expect(parts?.map((p) => [p.contentId, p.status])).toEqual([
      ["m2", 429],
      ["m0", 200],
      ["m1", 404],
      ["m3", 204],
    ]);
    const ok = parts?.find((p) => p.contentId === "m0");
    expect(JSON.parse(ok?.bodyText ?? "null")).toEqual({
      id: "18f0000000000001",
      threadId: "18f0000000000001",
      labelIds: ["INBOX"],
    });
    expect(parts?.find((p) => p.contentId === "m2")?.headers["retry-after"]).toBe("30");
    expect(parts?.find((p) => p.contentId === "m3")?.bodyText).toBe("");
  });

  it("accepts LF line endings and a quoted boundary", () => {
    const lf = CRLF_RESPONSE.replace(/\r\n/g, "\n");
    const parts = parseBatchResponse(lf, 'multipart/mixed; boundary="batch_resp_01"');
    expect(parts).toHaveLength(4);
  });

  it("keeps complete parts when the closing delimiter is missing", () => {
    const truncated = CRLF_RESPONSE.slice(
      0,
      CRLF_RESPONSE.indexOf("--batch_resp_01\r\nContent-Type: application/http\r\nContent-ID: <response-m3>"),
    );
    const parts = parseBatchResponse(truncated, "multipart/mixed; boundary=batch_resp_01");
    expect(parts?.map((p) => p.contentId)).toEqual(["m2", "m0", "m1"]);
  });

  it("skips parts without a Content-ID or status line", () => {
    const body = [
      "--b",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "",
      "{}",
      "--b",
      "Content-Type: application/http",
      "Content-ID: <response-x>",
      "",
      "garbage",
      "--b--",
    ].join("\r\n");
    expect(parseBatchResponse(body, "multipart/mixed; boundary=b")).toEqual([]);
  });

  it("returns null without a boundary or when the boundary never appears", () => {
    expect(parseBatchResponse(CRLF_RESPONSE, "application/json")).toBeNull();
    expect(parseBatchResponse("{}", "multipart/mixed; boundary=other")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/http/multipart.test.ts`
Expected: FAIL, the import of `../../src/http/multipart.ts` not found (`Error: Cannot find module ...`).

- [ ] **Step 3: Implement the codec**

Create `packages/core/src/http/multipart.ts`:

```ts
/** One sub-request of a Gmail batch (`POST /batch/gmail/v1`). `path` is path + query, no host. */
export interface BatchRequestPart {
  contentId: string;
  method: "GET" | "POST";
  path: string;
  /** JSON body; omitted for bodiless requests. */
  body?: unknown;
}

/** One parsed part of a multipart/mixed batch response. */
export interface BatchResponsePart {
  /** Content-ID without angle brackets and without the "response-" prefix. */
  contentId: string;
  status: number;
  /** Inner HTTP response headers, names lowercased. */
  headers: Record<string, string>;
  /** Inner HTTP response body, trimmed ("" when empty). */
  bodyText: string;
}

/** Builds a multipart/mixed batch request body with CRLF line endings. */
export function buildBatchBody(parts: readonly BatchRequestPart[], boundary: string): string {
  let out = "";
  for (const part of parts) {
    out += `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${part.contentId}>\r\n\r\n`;
    out += `${part.method} ${part.path}\r\n`;
    out +=
      part.body === undefined
        ? "\r\n"
        : `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(part.body)}\r\n`;
  }
  return `${out}--${boundary}--\r\n`;
}

/** Reads the boundary parameter (quoted or bare) from a Content-Type value. */
export function boundaryFromContentType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2] ?? null;
  return boundary === null || boundary === "" ? null : boundary;
}

function splitHead(text: string): [string, string | null] {
  const index = text.indexOf("\n\n");
  return index < 0 ? [text, null] : [text.slice(0, index), text.slice(index + 2)];
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let last: string | null = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && last !== null) {
      headers[last] = `${headers[last] ?? ""} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parsePart(segment: string): BatchResponsePart | null {
  const lineEnd = segment.indexOf("\n");
  if (lineEnd < 0) return null;
  const [outerHead, rest] = splitHead(segment.slice(lineEnd + 1));
  if (rest === null) return null;
  const contentId = (parseHeaderBlock(outerHead)["content-id"] ?? "")
    .replace(/^<|>$/g, "")
    .replace(/^response-/, "");
  const http = rest.replace(/^\n+/, "");
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(http);
  if (status === null || contentId === "") return null;
  const statusEnd = http.indexOf("\n");
  const [innerHead, innerBody] = splitHead(statusEnd < 0 ? "" : http.slice(statusEnd + 1));
  return {
    contentId,
    status: Number(status[1]),
    headers: parseHeaderBlock(innerHead),
    bodyText: (innerBody ?? "").trim(),
  };
}

/**
 * Parses a multipart/mixed batch response. Accepts CRLF or LF, a quoted boundary, a preamble and a missing
 * closing delimiter. Malformed parts are skipped (callers treat a missing Content-ID as a failed part).
 * Returns null when the boundary is missing or never appears in the body.
 */
export function parseBatchResponse(body: string, contentType: string | null): BatchResponsePart[] | null {
  const boundary = boundaryFromContentType(contentType);
  if (boundary === null) return null;
  const segments = `\n${body.replace(/\r\n/g, "\n")}`.split(`\n--${boundary}`);
  if (segments.length < 2) return null;
  const parts: BatchResponsePart[] = [];
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) break;
    const part = parsePart(segment);
    if (part !== null) parts.push(part);
  }
  return parts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/http/multipart.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/http/multipart.ts packages/core/test/http/multipart.test.ts`
Expected: no output after `tsc -p tsconfig.json`, exit code 0.

```bash
git add packages/core/src/http/multipart.ts packages/core/test/http/multipart.test.ts
git commit -m "feat(core): add Gmail batch multipart builder and parser"
```

---

### Task 2: Provider-agnostic OAuth shell and shared provider helpers

**Files:**
- Modify: `packages/core/src/providers/oauth.ts` (replace the import block, append a section; plan 01's types and constants stay unchanged)
- Test: `packages/core/test/providers/oauth.test.ts`

**Interfaces:**
- Consumes (plan 01): `FetchLike` (`http/fetch.ts`); `MailHeaders`, `ProviderKind` (`model/mail.ts`); `ClearboxError`, `CursorExpiredError`, `ProviderAuthError`, `ProviderConfigError`, `ProviderResponseError`, `ProviderUnavailableError`, `SubrequestBudgetError` (`model/errors.ts`, options-object constructors); `parseAddressList`; `headerValue`, `parseAuthResults`, `RawHeader`; `unfoldHeader`; `OAuthTokens` (`providers/token.ts`); `OAuthClientConfig`, `AuthorizeParams`, `GOOGLE_SCOPES`, `MICROSOFT_SCOPES`, `MICROSOFT_CONSENT_URLS` (already in `providers/oauth.ts`).
- Produces (`src/providers/oauth.ts`):
  - `isJsonObject(value: unknown): value is Record<string, unknown>`
  - `readJsonBody(res: Response): Promise<unknown>` (null for empty or invalid JSON)
  - `sendGuarded(f: FetchLike, provider: ProviderKind, url: string, init: RequestInit): Promise<Response>` (network failure: `ProviderUnavailableError`; `ClearboxError` passes through)
  - `parseCursorJson(raw: string, provider: ProviderKind, cursorKind: "backfill" | "sent" | "incremental"): Record<string, unknown>`
  - `stringField(body: Record<string, unknown>, key: string): string | null`
  - `bestEffortCount(read: () => Promise<Record<string, unknown>>, field: string): Promise<number | null>`
  - `chunkIds<T>(items: readonly T[], size: number): T[][]`
  - `headerValues(headers: readonly RawHeader[], name: string): string[]`
  - `selectAuthenticationResults(values: readonly string[], provider: ProviderKind): string | null`
  - `buildMailHeaders(headers: readonly RawHeader[], provider: ProviderKind): MailHeaders`
  - `uniqueAddresses(values: readonly string[]): string[]`
  - `buildAuthorizeUrl(base: string, params: Readonly<Record<string, string | undefined>>): string`
  - `interface TokenEndpoint { provider: ProviderKind; url: string; classify: (status: number, body: unknown, headers: Headers, now: number) => ClearboxError }`
  - `parseTokenResponse(provider: ProviderKind, status: number, body: unknown, now: number): OAuthTokens`
  - `exchangeCode(f, endpoint: TokenEndpoint, form: Readonly<Record<string, string>>, now: number): Promise<OAuthTokens>`
  - `refreshAccessToken(f, endpoint: TokenEndpoint, form: Readonly<Record<string, string>>, now: number): Promise<OAuthTokens>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/providers/oauth.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
} from "../../src/model/errors.ts";
import {
  buildAuthorizeUrl,
  buildMailHeaders,
  chunkIds,
  exchangeCode,
  headerValues,
  parseCursorJson,
  parseTokenResponse,
  readJsonBody,
  refreshAccessToken,
  selectAuthenticationResults,
  sendGuarded,
  uniqueAddresses,
  type TokenEndpoint,
} from "../../src/providers/oauth.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const TOKEN_URL = "https://token.example.test/token";
const endpoint: TokenEndpoint = {
  provider: "gmail",
  url: TOKEN_URL,
  classify: (status, body) =>
    new ProviderAuthError({
      provider: "gmail",
      reason:
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : `http_${String(status)}`,
    }),
};

describe("buildAuthorizeUrl", () => {
  it("sets every defined parameter and omits undefined ones", () => {
    const url = new URL(
      buildAuthorizeUrl("https://auth.example.test/authorize", { a: "1", b: undefined, c: "x y" }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.test/authorize");
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("b")).toBe(false);
    expect(url.searchParams.get("c")).toBe("x y");
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("posts a form and maps the token response", async () => {
    const forms: URLSearchParams[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        forms.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "at-1",
          expires_in: 3599,
          token_type: "Bearer",
          scope: "scope-a  scope-b",
          refresh_token: "rt-1",
          refresh_token_expires_in: 604800,
        });
      }),
    );
    const tokens = await exchangeCode(
      fetch,
      endpoint,
      { grant_type: "authorization_code", code: "c-1" },
      NOW,
    );
    expect(forms[0]?.get("code")).toBe("c-1");
    expect(tokens).toEqual({
      accessToken: "at-1",
      expiresAt: NOW + 3_599_000,
      refreshToken: "rt-1",
      grantedScopes: ["scope-a", "scope-b"],
      refreshTokenExpiresAt: NOW + 604_800_000,
    });
  });

  it("returns refreshToken null when the response has none", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ access_token: "at-2", expires_in: 60 })));
    const tokens = await refreshAccessToken(fetch, endpoint, { grant_type: "refresh_token" }, NOW);
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.grantedScopes).toEqual([]);
  });

  it("delegates non-2xx responses to the endpoint classifier", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "invalid_grant",
    });
  });

  it("maps a network failure to ProviderUnavailableError", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("rejects a 200 without access_token as ProviderResponseError", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({ expires_in: 60 })));
    await expect(refreshAccessToken(fetch, endpoint, {}, NOW)).rejects.toBeInstanceOf(ProviderResponseError);
  });
});

describe("parseTokenResponse", () => {
  it("rejects non-object bodies", () => {
    expect(() => parseTokenResponse("outlook", 200, null, NOW)).toThrow(ProviderResponseError);
  });
});

describe("sendGuarded", () => {
  it("passes ClearboxErrors through unchanged", async () => {
    const budget = new SubrequestBudgetError({ used: 45, limit: 45 });
    await expect(
      sendGuarded(() => Promise.reject(budget), "gmail", "https://x.example.test", {}),
    ).rejects.toBe(budget);
  });
  it("wraps other failures", async () => {
    await expect(
      sendGuarded(
        () => Promise.reject(new TypeError("fetch failed")),
        "outlook",
        "https://x.example.test",
        {},
      ),
    ).rejects.toMatchObject({ name: "ProviderUnavailableError", provider: "outlook" });
  });
});

describe("readJsonBody", () => {
  it("returns null for empty or invalid JSON", async () => {
    expect(await readJsonBody(new Response(""))).toBeNull();
    expect(await readJsonBody(new Response("<html>"))).toBeNull();
    expect(await readJsonBody(new Response('{"a":1}'))).toEqual({ a: 1 });
  });
});

describe("parseCursorJson", () => {
  it("returns the object for version 1", () => {
    expect(parseCursorJson('{"v":1,"pageToken":"p"}', "gmail", "backfill")).toEqual({ v: 1, pageToken: "p" });
  });
  it("throws CursorExpiredError for corrupt or unknown versions", () => {
    expect(() => parseCursorJson("not json", "gmail", "backfill")).toThrow(CursorExpiredError);
    expect(() => parseCursorJson('{"v":2}', "outlook", "incremental")).toThrow(CursorExpiredError);
  });
});

describe("chunkIds", () => {
  it("splits into chunks of the given size", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 20)).toEqual([]);
  });
});

describe("headerValues", () => {
  it("returns every value, case-insensitive, unfolded", () => {
    const headers = [
      { name: "Delivered-To", value: "a@example.test" },
      { name: "delivered-to", value: "b@example.test" },
      { name: "Subject", value: "Hello\r\n world" },
    ];
    expect(headerValues(headers, "DELIVERED-TO")).toEqual(["a@example.test", "b@example.test"]);
    expect(headerValues(headers, "subject")).toEqual(["Hello world"]);
  });
});

describe("selectAuthenticationResults", () => {
  const upstream = "relay.example.net; dkim=pass header.d=shop.example.com";
  const google = "mx.google.com; spf=pass smtp.mailfrom=esp.example.net";
  it("Gmail trusts only the mx.google.com authserv-id", () => {
    expect(selectAuthenticationResults([upstream, google], "gmail")).toBe(google);
    expect(selectAuthenticationResults([upstream], "gmail")).toBeNull();
  });
  it("Microsoft uses the first value", () => {
    expect(selectAuthenticationResults(["spf=pass smtp.mailfrom=a.example", "spf=fail"], "outlook")).toBe(
      "spf=pass smtp.mailfrom=a.example",
    );
    expect(selectAuthenticationResults([], "outlook")).toBeNull();
  });
});

describe("buildMailHeaders", () => {
  it("normalizes every MailHeaders field and nulls missing ones", () => {
    const headers = buildMailHeaders(
      [
        { name: "list-unsubscribe", value: "<https://shop.example.com/u/1>" },
        { name: "Precedence", value: "bulk" },
        { name: "Return-Path", value: "<bounce@esp.example.net>" },
      ],
      "gmail",
    );
    expect(headers).toEqual({
      listUnsubscribe: "<https://shop.example.com/u/1>",
      listUnsubscribePost: null,
      listId: null,
      precedence: "bulk",
      autoSubmitted: null,
      authenticationResults: null,
      returnPath: "<bounce@esp.example.net>",
      contentType: null,
      references: null,
      inReplyTo: null,
    });
  });
});

describe("uniqueAddresses", () => {
  it("lowercases and de-duplicates across header values", () => {
    expect(
      uniqueAddresses(["A <A@Example.com>, b@example.org", "a@example.com; undisclosed-recipients:;"]),
    ).toEqual(["a@example.com", "b@example.org"]);
  });
});

describe("ClearboxError hierarchy", () => {
  it("provider errors are ClearboxErrors", () => {
    expect(new ProviderAuthError({ provider: "gmail", reason: "x" })).toBeInstanceOf(ClearboxError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/oauth.test.ts`
Expected: FAIL, `Failed Tests 18` with `TypeError: buildAuthorizeUrl is not a function` (and the same for the other new helpers).

- [ ] **Step 3: Replace the import block of `providers/oauth.ts`**

Replace every `import` line at the top of `packages/core/src/providers/oauth.ts` (plan 01's file has none or only type imports) with:

```ts
import type { FetchLike } from "../http/fetch.ts";
import type { MailHeaders, ProviderKind } from "../model/mail.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderResponseError,
  ProviderUnavailableError,
  SubrequestBudgetError,
} from "../model/errors.ts";
import { parseAddressList } from "../text/address.ts";
import { headerValue, parseAuthResults, type RawHeader } from "../text/headers.ts";
import { unfoldHeader } from "../text/rfc2047.ts";
import type { OAuthTokens } from "./token.ts";
```

- [ ] **Step 4: Append the shell and helpers**

Append to the end of `packages/core/src/providers/oauth.ts` (after `MICROSOFT_CONSENT_URLS`):

```ts
// ---------------------------------------------------------------------------------------------
// Provider-agnostic shell (plan 02): token endpoint calls plus HTTP, cursor and header helpers
// shared by providers/google/* and providers/microsoft/*.
// ---------------------------------------------------------------------------------------------

/** True for plain JSON objects (not arrays, not null). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a response body as JSON; null for an empty or non-JSON body. Never throws on bad JSON. */
export async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Calls fetch; a network failure becomes ProviderUnavailableError. ClearboxErrors (budget) pass through. */
export async function sendGuarded(
  f: FetchLike,
  provider: ProviderKind,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await f(url, init);
  } catch (cause) {
    if (cause instanceof ClearboxError) throw cause;
    throw new ProviderUnavailableError({ provider, retryAfterMs: null, cause });
  }
}

/** Parses a provider cursor (JSON with "v": 1). Anything else throws CursorExpiredError so the caller restarts. */
export function parseCursorJson(
  raw: string,
  provider: ProviderKind,
  cursorKind: "backfill" | "sent" | "incremental",
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CursorExpiredError({ provider, cursorKind });
  }
  if (!isJsonObject(parsed) || parsed.v !== 1) throw new CursorExpiredError({ provider, cursorKind });
  return parsed;
}

/**
 * Best-effort count for display (inbox estimate): returns body[field] when it is a non-negative number, else null.
 * Auth, config and subrequest budget errors propagate; any other failure yields null.
 */
export async function bestEffortCount(
  read: () => Promise<Record<string, unknown>>,
  field: string,
): Promise<number | null> {
  try {
    const value = (await read())[field];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  } catch (error) {
    if (
      error instanceof ProviderAuthError ||
      error instanceof ProviderConfigError ||
      error instanceof SubrequestBudgetError
    ) {
      throw error;
    }
    return null;
  }
}

/** body[key] when it is a non-empty string, else null. */
export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Splits items into consecutive chunks of at most size items. */
export function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every value of a header (case-insensitive name), unfolded, in order. */
export function headerValues(headers: readonly RawHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === wanted).map((h) => unfoldHeader(h.value));
}

/**
 * Only the receiving provider's Authentication-Results is trusted:
 * Gmail = the first value whose authserv-id is "mx.google.com"; Microsoft = the first value.
 */
export function selectAuthenticationResults(
  values: readonly string[],
  provider: ProviderKind,
): string | null {
  if (provider === "outlook") return values[0] ?? null;
  return values.find((v) => parseAuthResults(v).authservId === "mx.google.com") ?? null;
}

/** Normalized MailHeaders from raw provider headers. */
export function buildMailHeaders(headers: readonly RawHeader[], provider: ProviderKind): MailHeaders {
  return {
    listUnsubscribe: headerValue(headers, "List-Unsubscribe"),
    listUnsubscribePost: headerValue(headers, "List-Unsubscribe-Post"),
    listId: headerValue(headers, "List-Id"),
    precedence: headerValue(headers, "Precedence"),
    autoSubmitted: headerValue(headers, "Auto-Submitted"),
    authenticationResults: selectAuthenticationResults(
      headerValues(headers, "Authentication-Results"),
      provider,
    ),
    returnPath: headerValue(headers, "Return-Path"),
    contentType: headerValue(headers, "Content-Type"),
    references: headerValue(headers, "References"),
    inReplyTo: headerValue(headers, "In-Reply-To"),
  };
}

/** Lowercased, de-duplicated addresses from address-list header values, in first-seen order. */
export function uniqueAddresses(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    for (const entry of parseAddressList(value)) if (entry.address !== null) out.add(entry.address);
  }
  return [...out];
}

/** Builds an authorize URL; undefined parameters are omitted. */
export function buildAuthorizeUrl(
  base: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A token endpoint plus the provider's error classification (google/oauth.ts, microsoft/oauth.ts). */
export interface TokenEndpoint {
  provider: ProviderKind;
  url: string;
  classify: (status: number, body: unknown, headers: Headers, now: number) => ClearboxError;
}

/** Validates a token endpoint success body. A missing access_token or expires_in is ProviderResponseError. */
export function parseTokenResponse(
  provider: ProviderKind,
  status: number,
  body: unknown,
  now: number,
): OAuthTokens {
  if (
    !isJsonObject(body) ||
    typeof body.access_token !== "string" ||
    body.access_token === "" ||
    typeof body.expires_in !== "number"
  ) {
    throw new ProviderResponseError({ provider, status });
  }
  const refresh = body.refresh_token;
  const refreshExpiresIn = body.refresh_token_expires_in;
  return {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
    refreshToken: typeof refresh === "string" && refresh !== "" ? refresh : null,
    grantedScopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter((s) => s !== "") : [],
    refreshTokenExpiresAt: typeof refreshExpiresIn === "number" ? now + refreshExpiresIn * 1000 : null,
  };
}

async function postTokenForm(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  const res = await sendGuarded(f, endpoint.provider, endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJsonBody(res);
  if (!res.ok) throw endpoint.classify(res.status, body, res.headers, now);
  return parseTokenResponse(endpoint.provider, res.status, body, now);
}

/** authorization_code grant. The caller supplies every form field (provider files build them). */
export function exchangeCode(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  return postTokenForm(f, endpoint, form, now);
}

/** refresh_token grant. A non-null result.refreshToken is a rotated token the caller must persist. */
export function refreshAccessToken(
  f: FetchLike,
  endpoint: TokenEndpoint,
  form: Readonly<Record<string, string>>,
  now: number,
): Promise<OAuthTokens> {
  return postTokenForm(f, endpoint, form, now);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/oauth.test.ts`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/oauth.ts packages/core/test/providers/oauth.test.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/oauth.ts packages/core/test/providers/oauth.test.ts
git commit -m "feat(core): add OAuth token shell and shared provider helpers"
```

---

### Task 3: Inbox estimate on the provider interface (contracts 12.1 A4)

**Files:**
- Modify: `packages/core/src/providers/provider.ts` (plan 01 file)
- Modify: `packages/core/test/providers/types.test.ts` (plan 01 file; its stub provider must implement the new member)

**Interfaces:**
- Consumes: plan 01's `MailProvider`.
- Produces: `MailProvider.inboxEstimate(): Promise<number | null>` (one request; best effort as documented below). Plan 04 calls it at most once per day during backfill and writes `accounts.inbox_estimate`; plan 03 stores NULL at connect.

- [ ] **Step 1: Make plan 01's stub provider use the new member (failing typecheck)**

In `packages/core/test/providers/types.test.ts`, inside `stubProvider()`, add this member after `resyncCursor: () => Promise.resolve("{}"),`:

```ts
    inboxEstimate: () => Promise.resolve(null),
```

(If plan 01's file has no stub provider, skip Steps 1 and 2: Tasks 8 and 11 exercise the member.)

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `pnpm --filter @clearbox/core typecheck`
Expected: FAIL with `error TS2353: Object literal may only specify known properties, and 'inboxEstimate' does not exist in type 'MailProvider'.`

- [ ] **Step 3: Add the member to the interface**

In `packages/core/src/providers/provider.ts`, inside `interface MailProvider`, add after the `resyncCursor(...)` member:

```ts
  /**
   * Inbox message count (Gmail labels/INBOX messagesTotal, Graph mailFolders/inbox totalItemCount), one request.
   * Best effort: null on rate limit, 5xx, network or shape errors; auth, config and budget errors still throw.
   */
  inboxEstimate(): Promise<number | null>;
```

- [ ] **Step 4: Verify typecheck and plan 01's provider test pass**

Run: `pnpm --filter @clearbox/core typecheck && pnpm --filter @clearbox/core exec vitest run test/providers/types.test.ts`
Expected: PASS, `Tests  3 passed (3)` (plan 01's count).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/provider.ts packages/core/test/providers/types.test.ts
git commit -m "feat(core): add inbox estimate to the mail provider interface"
```

---

### Task 4: Google OAuth and Gmail error classification

**Files:**
- Create: `packages/core/src/providers/google/types.ts`
- Create: `packages/core/src/providers/google/oauth.ts`
- Create: `packages/core/test/msw/failures.ts`
- Create: `packages/core/test/msw/google-oauth.ts`
- Create: `packages/core/test/providers/error-table.ts`
- Create: `packages/core/test/fixtures/oauth/google-errors.json`
- Create: `packages/core/test/fixtures/gmail/api-errors.json`
- Test: `packages/core/test/providers/google/oauth.test.ts`

**Interfaces:**
- Consumes: Task 1 `BatchResponsePart`; Task 2 `buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `isJsonObject`, `sendGuarded`, `TokenEndpoint`; plan 01 `parseRetryAfter(headers, now): number | null`, `backoffMs(attempt): number`, error classes, `GOOGLE_SCOPES`, `OAuthClientConfig`, `AuthorizeParams`, `OAuthTokens`, `ActionErrorCode`, `ActionResult`.
- Produces (`src/providers/google/oauth.ts`):
  - `GOOGLE_AUTHORIZE_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_REVOKE_URL`, `GMAIL_MODIFY_SCOPE`, `GOOGLE_TOKEN_ENDPOINT: TokenEndpoint`
  - `buildGoogleAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string`
  - `exchangeGoogleCode(f: FetchLike, cfg: OAuthClientConfig, code: string, codeVerifier: string, now: number): Promise<OAuthTokens>`
  - `refreshGoogleToken(f: FetchLike, cfg: OAuthClientConfig, refreshToken: string, now: number): Promise<OAuthTokens>` (`refreshToken` in the result is null: Google does not rotate)
  - `revokeGoogleToken(f: FetchLike, token: string): Promise<boolean>` (never throws)
  - `hasGmailScope(granted: readonly string[]): boolean`
  - `classifyGoogleOAuthError(status, body, headers, now): ClearboxError`, `classifyGmailApiError(status, body, headers, now): ClearboxError`
  - `gmailErrorReason(body: unknown): string | null`, `isGmailRateLimit(status: number, reason: string | null): boolean`, `msUntilNextUtcMidnight(now: number): number`
  - `type PartOutcome`, `classifyPart(part: BatchResponsePart | undefined, now: number): PartOutcome`, `interface ActionOutcome { result: ActionResult; labelIds: string[] | null }`, `toActionOutcome(id, outcome): ActionOutcome`
- Produces (tests): `FailRule`, `FailureQueue` (`test/msw/failures.ts`); `FakeOAuthState`, `GOOGLE_TEST_CLIENT`, `createGoogleOAuthState()`, `googleOAuthHandlers(state)` (`test/msw/google-oauth.ts`); `ErrorRow`, `ERROR_CLASSES`, `expectClassified(row, err)` (`test/providers/error-table.ts`).

- [ ] **Step 1: Add the wire types**

Create `packages/core/src/providers/google/types.ts`:

```ts
// Google OAuth and Gmail wire types (research mail-providers.md section 8).

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface GoogleOAuthError {
  error: string;
  error_description?: string;
  error_subtype?: string;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch ms as a string. */
  internalDate?: string;
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
  ids: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GoogleApiError {
  error: {
    code: number;
    message: string;
    status?: string;
    errors?: {
      domain?: string;
      reason?: string;
      message?: string;
      location?: string;
      locationType?: string;
    }[];
  };
}
```

- [ ] **Step 2: Add the test helpers, fake token endpoint and error tables**

Create `packages/core/test/msw/failures.ts`:

```ts
/** One injected failure: the next `times` requests (default 1) matching method and path get this response. */
export interface FailRule {
  method: string;
  /** Exact path or a RegExp. Gmail: URL pathname ("/gmail/v1/users/me/history"); Graph: path after "/v1.0"; OAuth: "/token". */
  path: string | RegExp;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times?: number;
}

export class FailureQueue {
  private readonly rules: { rule: FailRule; left: number }[] = [];

  add(rule: FailRule): void {
    this.rules.push({ rule, left: rule.times ?? 1 });
  }

  take(method: string, path: string): FailRule | null {
    for (const entry of this.rules) {
      const { rule } = entry;
      const pathMatches = typeof rule.path === "string" ? rule.path === path : rule.path.test(path);
      if (entry.left > 0 && rule.method.toUpperCase() === method.toUpperCase() && pathMatches) {
        entry.left--;
        return rule;
      }
    }
    return null;
  }
}
```

Create `packages/core/test/msw/google-oauth.ts`:

```ts
import { http, HttpResponse } from "msw";
import { FailureQueue, type FailRule } from "./failures.ts";

/** In-memory OAuth server state shared by the Google and Microsoft token endpoint fakes. */
export class FakeOAuthState {
  readonly failures = new FailureQueue();
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revoked: string[] = [];
  readonly refreshTokens = new Set<string>();
  validCode = "code-valid";
  grantedScope: string;
  /** Microsoft rotates refresh tokens; Google does not. */
  rotateRefreshTokens: boolean;
  /** When set, the code exchange also returns refresh_token_expires_in (Google time-based access). */
  refreshTokenExpiresIn: number | null = null;
  private issued = 0;
  private readonly prefix: string;

  constructor(options: { prefix: string; grantedScope: string; rotateRefreshTokens: boolean }) {
    this.prefix = options.prefix;
    this.grantedScope = options.grantedScope;
    this.rotateRefreshTokens = options.rotateRefreshTokens;
  }

  failNext(rule: FailRule): void {
    this.failures.add(rule);
  }

  /** Issues an access token and, when withRefresh, a new refresh token that the fake will accept. */
  issue(withRefresh: boolean): Record<string, unknown> {
    this.issued++;
    const body: Record<string, unknown> = {
      access_token: `${this.prefix}-at-${String(this.issued)}`,
      expires_in: 3599,
      token_type: "Bearer",
      scope: this.grantedScope,
    };
    if (withRefresh) {
      const refresh = `${this.prefix}-rt-${String(this.issued)}`;
      this.refreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return body;
  }
}

export const GOOGLE_TEST_CLIENT = {
  clientId: "test-google-client",
  clientSecret: "test-google-secret",
  redirectUri: "http://localhost:5173/oauth/google/callback",
} as const;

export function createGoogleOAuthState(): FakeOAuthState {
  return new FakeOAuthState({
    prefix: "g",
    grantedScope: "https://www.googleapis.com/auth/gmail.modify",
    rotateRefreshTokens: false,
  });
}

function unhandled(request: Request): never {
  const url = new URL(request.url);
  throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
}

export function googleOAuthHandlers(state: FakeOAuthState) {
  return [
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      state.tokenRequests.push(form);
      const fail = state.failures.take("POST", "/token");
      if (fail)
        return HttpResponse.json(fail.body ?? null, { status: fail.status, headers: fail.headers ?? {} });
      if (
        form.get("client_id") !== GOOGLE_TEST_CLIENT.clientId ||
        form.get("client_secret") !== GOOGLE_TEST_CLIENT.clientSecret
      ) {
        return HttpResponse.json(
          { error: "invalid_client", error_description: "The OAuth client was not found." },
          { status: 401 },
        );
      }
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== state.validCode || !form.get("code_verifier") || !form.get("redirect_uri")) {
          return HttpResponse.json(
            { error: "invalid_grant", error_description: "Bad Request" },
            { status: 400 },
          );
        }
        const body = state.issue(true);
        if (state.refreshTokenExpiresIn !== null) body.refresh_token_expires_in = state.refreshTokenExpiresIn;
        return HttpResponse.json(body);
      }
      if (grant === "refresh_token") {
        if (!state.refreshTokens.has(form.get("refresh_token") ?? "")) {
          return HttpResponse.json(
            { error: "invalid_grant", error_description: "Token has been expired or revoked." },
            { status: 400 },
          );
        }
        return HttpResponse.json(state.issue(state.rotateRefreshTokens));
      }
      return HttpResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
    }),
    http.post("https://oauth2.googleapis.com/revoke", async ({ request }) => {
      const token = new URLSearchParams(await request.text()).get("token") ?? "";
      if (!state.refreshTokens.delete(token))
        return HttpResponse.json({ error: "invalid_token" }, { status: 400 });
      state.revoked.push(token);
      return HttpResponse.json({});
    }),
    http.all("https://oauth2.googleapis.com/*", ({ request }) => unhandled(request)),
  ];
}
```

Create `packages/core/test/providers/error-table.ts`:

```ts
import { expect } from "vitest";
import {
  CursorExpiredError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  type ClearboxError,
} from "../../src/model/errors.ts";

/** One row of a JSON error classification table (test/fixtures/{oauth,gmail,graph}/*errors.json). */
export interface ErrorRow {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  expected: keyof typeof ERROR_CLASSES;
  reason?: string;
  retryAfterMs?: number | null;
  retryAfterRange?: [number, number];
  httpStatus?: number;
}

export const ERROR_CLASSES = {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderResponseError,
  CursorExpiredError,
} as const;

export function expectClassified(row: ErrorRow, err: ClearboxError): void {
  expect(err).toBeInstanceOf(ERROR_CLASSES[row.expected]);
  if (row.reason !== undefined) expect(err).toMatchObject({ reason: row.reason });
  if (row.retryAfterMs !== undefined) expect(err).toMatchObject({ retryAfterMs: row.retryAfterMs });
  if (row.retryAfterRange !== undefined) {
    const value = (err as ProviderRateLimitError).retryAfterMs;
    expect(value).toBeGreaterThanOrEqual(row.retryAfterRange[0]);
    expect(value).toBeLessThanOrEqual(row.retryAfterRange[1]);
  }
  if (row.httpStatus !== undefined) expect(err).toMatchObject({ status: row.httpStatus });
}
```

Create `packages/core/test/fixtures/oauth/google-errors.json`:

```json
[
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_description": "Token has been expired or revoked." },
    "expected": "ProviderAuthError",
    "reason": "invalid_grant"
  },
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_subtype": "invalid_rapt" },
    "expected": "ProviderAuthError",
    "reason": "invalid_grant"
  },
  {
    "status": 400,
    "body": { "error": "interaction_required" },
    "expected": "ProviderAuthError",
    "reason": "interaction_required"
  },
  {
    "status": 400,
    "body": { "error": "consent_required" },
    "expected": "ProviderAuthError",
    "reason": "consent_required"
  },
  {
    "status": 401,
    "body": { "error": "invalid_client", "error_description": "The OAuth client was not found." },
    "expected": "ProviderConfigError",
    "reason": "invalid_client"
  },
  {
    "status": 401,
    "body": { "error": "unauthorized_client" },
    "expected": "ProviderConfigError",
    "reason": "unauthorized_client"
  },
  {
    "status": 401,
    "body": { "error": "deleted_client" },
    "expected": "ProviderConfigError",
    "reason": "deleted_client"
  },
  { "status": 503, "body": { "error": "temporarily_unavailable" }, "expected": "ProviderUnavailableError" },
  { "status": 500, "body": null, "expected": "ProviderUnavailableError" },
  {
    "status": 429,
    "body": {},
    "headers": { "Retry-After": "20" },
    "expected": "ProviderRateLimitError",
    "retryAfterMs": 20000
  },
  { "status": 400, "body": { "error": "invalid_request" }, "expected": "ProviderResponseError" }
]
```

Create `packages/core/test/fixtures/gmail/api-errors.json` (`retryAfterMs` 43200000 is 12 hours: the test clock is 12:00 UTC):

```json
[
  {
    "status": 401,
    "body": {
      "error": {
        "code": 401,
        "message": "Invalid Credentials",
        "errors": [{ "reason": "authError" }],
        "status": "UNAUTHENTICATED"
      }
    },
    "expected": "ProviderAuthError",
    "reason": "unauthorized"
  },
  {
    "status": 403,
    "body": {
      "error": {
        "code": 403,
        "message": "Rate Limit Exceeded",
        "errors": [{ "domain": "usageLimits", "reason": "rateLimitExceeded" }]
      }
    },
    "expected": "ProviderRateLimitError",
    "retryAfterRange": [60000, 61000]
  },
  {
    "status": 403,
    "body": {
      "error": {
        "code": 403,
        "message": "User Rate Limit Exceeded",
        "errors": [{ "domain": "usageLimits", "reason": "userRateLimitExceeded" }]
      }
    },
    "headers": { "Retry-After": "30" },
    "expected": "ProviderRateLimitError",
    "retryAfterMs": 30000
  },
  {
    "status": 403,
    "body": {
      "error": {
        "code": 403,
        "message": "Daily Limit Exceeded",
        "errors": [{ "domain": "usageLimits", "reason": "dailyLimitExceeded" }]
      }
    },
    "expected": "ProviderRateLimitError",
    "retryAfterMs": 43200000
  },
  {
    "status": 403,
    "body": {
      "error": { "code": 403, "message": "Domain policy", "errors": [{ "reason": "domainPolicy" }] }
    },
    "expected": "ProviderAuthError",
    "reason": "domain_policy"
  },
  {
    "status": 403,
    "body": {
      "error": {
        "code": 403,
        "message": "Insufficient Permission",
        "errors": [{ "reason": "insufficientPermissions" }]
      }
    },
    "expected": "ProviderAuthError",
    "reason": "insufficient_scope"
  },
  {
    "status": 429,
    "body": {
      "error": {
        "code": 429,
        "message": "Too many concurrent requests for user",
        "status": "RESOURCE_EXHAUSTED"
      }
    },
    "expected": "ProviderRateLimitError",
    "retryAfterRange": [60000, 61000]
  },
  {
    "status": 500,
    "body": {
      "error": { "code": 500, "message": "Backend Error", "errors": [{ "reason": "backendError" }] }
    },
    "expected": "ProviderUnavailableError",
    "retryAfterMs": null
  },
  {
    "status": 503,
    "body": null,
    "headers": { "Retry-After": "120" },
    "expected": "ProviderUnavailableError",
    "retryAfterMs": 120000
  },
  {
    "status": 400,
    "body": { "error": { "code": 400, "message": "Bad Request", "errors": [{ "reason": "badRequest" }] } },
    "expected": "ProviderResponseError",
    "httpStatus": 400
  },
  {
    "status": 404,
    "body": { "error": { "code": 404, "message": "Not Found", "errors": [{ "reason": "notFound" }] } },
    "expected": "ProviderResponseError",
    "httpStatus": 404
  }
]
```

- [ ] **Step 3: Write the failing test**

Create `packages/core/test/providers/google/oauth.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "../../../src/model/errors.ts";
import {
  buildGoogleAuthorizeUrl,
  classifyGmailApiError,
  classifyGoogleOAuthError,
  classifyPart,
  exchangeGoogleCode,
  hasGmailScope,
  msUntilNextUtcMidnight,
  refreshGoogleToken,
  revokeGoogleToken,
  toActionOutcome,
} from "../../../src/providers/google/oauth.ts";
import gmailApiErrors from "../../fixtures/gmail/api-errors.json" with { type: "json" };
import googleErrors from "../../fixtures/oauth/google-errors.json" with { type: "json" };
import {
  GOOGLE_TEST_CLIENT,
  createGoogleOAuthState,
  googleOAuthHandlers,
  type FakeOAuthState,
} from "../../msw/google-oauth.ts";
import { server } from "../../setup/msw.ts";
import { expectClassified, type ErrorRow } from "../error-table.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let state: FakeOAuthState;

beforeEach(() => {
  state = createGoogleOAuthState();
  server.use(...googleOAuthHandlers(state));
});

describe("buildGoogleAuthorizeUrl", () => {
  it("requests gmail.modify offline with consent and PKCE S256", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(GOOGLE_TEST_CLIENT, { state: "nonce-1", codeChallenge: "challenge-1" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-google-client",
      redirect_uri: "http://localhost:5173/oauth/google/callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      access_type: "offline",
      prompt: "consent",
      state: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });
  it("adds login_hint only when given", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(GOOGLE_TEST_CLIENT, {
        state: "s",
        codeChallenge: "c",
        loginHint: "owner@example.test",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("owner@example.test");
  });
});

describe("exchangeGoogleCode", () => {
  it("exchanges the code with secret, redirect URI and verifier", async () => {
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "verifier-1", NOW);
    expect(tokens).toEqual({
      accessToken: "g-at-1",
      expiresAt: NOW + 3_599_000,
      refreshToken: "g-rt-1",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      refreshTokenExpiresAt: null,
    });
    const form = state.tokenRequests[0];
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code_verifier")).toBe("verifier-1");
    expect(form?.get("client_secret")).toBe("test-google-secret");
    expect(form?.get("redirect_uri")).toBe("http://localhost:5173/oauth/google/callback");
  });

  it("keeps refresh_token_expires_in for time-based access", async () => {
    state.refreshTokenExpiresIn = 86_400;
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(tokens.refreshTokenExpiresAt).toBe(NOW + 86_400_000);
  });

  it("reports granted scopes so the caller can detect unticked gmail.modify", async () => {
    state.grantedScope = "openid";
    const tokens = await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(hasGmailScope(tokens.grantedScopes)).toBe(false);
  });

  it("maps a bad code to ProviderAuthError and a bad secret to ProviderConfigError", async () => {
    await expect(
      exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-wrong", "v", NOW),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(
      exchangeGoogleCode(fetch, { ...GOOGLE_TEST_CLIENT, clientSecret: "wrong" }, "code-valid", "v", NOW),
    ).rejects.toMatchObject({ name: "ProviderConfigError", reason: "invalid_client" });
  });
});

describe("refreshGoogleToken", () => {
  it("returns a new access token and no refresh token (no rotation)", async () => {
    await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    const tokens = await refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW + 1000);
    expect(tokens.accessToken).toBe("g-at-2");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresAt).toBe(NOW + 1000 + 3_599_000);
  });

  it("maps a revoked refresh token to ProviderAuthError invalid_grant", async () => {
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-unknown", NOW)).rejects.toMatchObject({
      name: "ProviderAuthError",
      provider: "gmail",
      reason: "invalid_grant",
    });
  });

  it("maps network failures to ProviderUnavailableError", async () => {
    server.use(http.post("https://oauth2.googleapis.com/token", () => HttpResponse.error()));
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("maps an injected invalid_client to ProviderConfigError", async () => {
    state.failNext({ method: "POST", path: "/token", status: 401, body: { error: "invalid_client" } });
    await expect(refreshGoogleToken(fetch, GOOGLE_TEST_CLIENT, "g-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
  });
});

describe("revokeGoogleToken", () => {
  it("returns true for a live token and false otherwise", async () => {
    await exchangeGoogleCode(fetch, GOOGLE_TEST_CLIENT, "code-valid", "v", NOW);
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(true);
    expect(state.revoked).toEqual(["g-rt-1"]);
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(false);
  });
  it("never throws on network failure", async () => {
    server.use(http.post("https://oauth2.googleapis.com/revoke", () => HttpResponse.error()));
    expect(await revokeGoogleToken(fetch, "g-rt-1")).toBe(false);
  });
});

describe("hasGmailScope", () => {
  it("requires the exact gmail.modify scope", () => {
    expect(hasGmailScope(["openid", "https://www.googleapis.com/auth/gmail.modify"])).toBe(true);
    expect(hasGmailScope(["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
    expect(hasGmailScope([])).toBe(false);
  });
});

describe("classifyGoogleOAuthError", () => {
  it.each(googleErrors as ErrorRow[])("HTTP $status $body.error -> $expected", (row) => {
    expectClassified(
      row,
      classifyGoogleOAuthError(row.status, row.body, new Headers(row.headers ?? {}), NOW),
    );
  });
});

describe("classifyGmailApiError", () => {
  it.each(gmailApiErrors as ErrorRow[])("HTTP $status -> $expected", (row) => {
    expectClassified(row, classifyGmailApiError(row.status, row.body, new Headers(row.headers ?? {}), NOW));
  });
});

describe("msUntilNextUtcMidnight", () => {
  it("counts to the next UTC midnight", () => {
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 9, 15, 23, 59))).toBe(60_000);
    expect(msUntilNextUtcMidnight(Date.UTC(2026, 11, 31, 12))).toBe(12 * 3_600_000);
  });
});

describe("classifyPart", () => {
  const part = (status: number, bodyText = "", headers: Record<string, string> = {}) => ({
    contentId: "m0",
    status,
    headers,
    bodyText,
  });

  it("classifies batch parts", () => {
    expect(classifyPart(part(200, '{"id":"a"}'), NOW)).toEqual({ kind: "ok", body: { id: "a" } });
    expect(classifyPart(part(204), NOW)).toEqual({ kind: "ok", body: {} });
    expect(classifyPart(part(401), NOW)).toEqual({ kind: "auth" });
    expect(classifyPart(part(429, "", { "retry-after": "4" }), NOW)).toEqual({
      kind: "rate",
      retryAfterMs: 4000,
    });
    expect(
      classifyPart(
        part(403, '{"error":{"code":403,"message":"x","errors":[{"reason":"rateLimitExceeded"}]}}'),
        NOW,
      ),
    ).toEqual({ kind: "rate", retryAfterMs: null });
    expect(classifyPart(part(503), NOW)).toEqual({ kind: "server", retryAfterMs: null });
    expect(classifyPart(part(404), NOW)).toEqual({ kind: "fail", error: "not_found" });
    expect(classifyPart(part(400), NOW)).toEqual({ kind: "fail", error: "bad_request" });
    expect(classifyPart(part(403, "not json"), NOW)).toEqual({ kind: "fail", error: "unknown" });
    expect(classifyPart(undefined, NOW)).toEqual({ kind: "server", retryAfterMs: null });
  });
});

describe("toActionOutcome", () => {
  it("keeps label ids on success and maps failures to ActionResult codes", () => {
    expect(toActionOutcome("a", { kind: "ok", body: { labelIds: ["INBOX", 3] } })).toEqual({
      result: { id: "a", ok: true, newId: "a" },
      labelIds: ["INBOX"],
    });
    expect(toActionOutcome("a", { kind: "ok", body: {} }).labelIds).toBeNull();
    expect(toActionOutcome("a", { kind: "rate", retryAfterMs: 5 }).result).toEqual({
      id: "a",
      ok: false,
      error: "rate_limited",
      retryAfterMs: 5,
    });
    expect(toActionOutcome("a", { kind: "server", retryAfterMs: null }).result).toMatchObject({
      error: "unavailable",
    });
    expect(toActionOutcome("a", { kind: "fail", error: "not_found" }).result).toMatchObject({
      error: "not_found",
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/google/oauth.test.ts`
Expected: FAIL, `../../../src/providers/google/oauth.ts` not found (`Error: Cannot find module ...`).

- [ ] **Step 5: Implement Google OAuth and classification**

Create `packages/core/src/providers/google/oauth.ts`:

```ts
import { backoffMs, parseRetryAfter } from "../../http/fetch.ts";
import type { FetchLike } from "../../http/fetch.ts";
import type { BatchResponsePart } from "../../http/multipart.ts";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { ClearboxError } from "../../model/errors.ts";
import {
  GOOGLE_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  isJsonObject,
  refreshAccessToken,
  sendGuarded,
} from "../oauth.ts";
import type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "../oauth.ts";
import type { ActionErrorCode, ActionResult } from "../provider.ts";
import type { OAuthTokens } from "../token.ts";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const REAUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
]);
const CONFIG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
]);
const RATE_REASONS: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** Classifies a non-2xx Google token endpoint response (contracts 4.4 table). */
export function classifyGoogleOAuthError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const error = isJsonObject(body) && typeof body.error === "string" ? body.error : null;
  if (error !== null && REAUTH_ERRORS.has(error))
    return new ProviderAuthError({ provider: "gmail", reason: error });
  if (error !== null && CONFIG_ERRORS.has(error))
    return new ProviderConfigError({ provider: "gmail", reason: error });
  if (status === 429) {
    return new ProviderRateLimitError({
      provider: "gmail",
      retryAfterMs: parseRetryAfter(headers, now) ?? backoffMs(1),
    });
  }
  if (error === "temporarily_unavailable" || status >= 500) {
    return new ProviderUnavailableError({ provider: "gmail", retryAfterMs: parseRetryAfter(headers, now) });
  }
  return new ProviderResponseError({ provider: "gmail", status });
}

export const GOOGLE_TOKEN_ENDPOINT: TokenEndpoint = {
  provider: "gmail",
  url: GOOGLE_TOKEN_URL,
  classify: classifyGoogleOAuthError,
};

/** access_type=offline, prompt=consent (a refresh token on every connect), PKCE S256. */
export function buildGoogleAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string {
  return buildAuthorizeUrl(GOOGLE_AUTHORIZE_URL, {
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    login_hint: p.loginHint,
  });
}

export function exchangeGoogleCode(
  f: FetchLike,
  cfg: OAuthClientConfig,
  code: string,
  codeVerifier: string,
  now: number,
): Promise<OAuthTokens> {
  return exchangeCode(
    f,
    GOOGLE_TOKEN_ENDPOINT,
    {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    },
    now,
  );
}

/** Google does not rotate refresh tokens: the result's refreshToken is null and the stored one stays valid. */
export function refreshGoogleToken(
  f: FetchLike,
  cfg: OAuthClientConfig,
  refreshToken: string,
  now: number,
): Promise<OAuthTokens> {
  return refreshAccessToken(
    f,
    GOOGLE_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    now,
  );
}

/** Best effort: true on 200, false on any error (never throws). Revoking either token revokes the grant. */
export async function revokeGoogleToken(f: FetchLike, token: string): Promise<boolean> {
  try {
    const res = await sendGuarded(f, "gmail", GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function hasGmailScope(granted: readonly string[]): boolean {
  return granted.includes(GMAIL_MODIFY_SCOPE);
}

/** error.errors[0].reason, else error.status, else null. */
export function gmailErrorReason(body: unknown): string | null {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return null;
  const errors = body.error.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  if (isJsonObject(first) && typeof first.reason === "string") return first.reason;
  return typeof body.error.status === "string" ? body.error.status : null;
}

export function isGmailRateLimit(status: number, reason: string | null): boolean {
  return status === 429 || (status === 403 && reason !== null && RATE_REASONS.has(reason));
}

export function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/**
 * Classifies a whole-call Gmail API error (after the one 401 refresh retry). 404 on history and 400 on a
 * page token are handled by the callers (CursorExpiredError) before this is called.
 */
export function classifyGmailApiError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const reason = gmailErrorReason(body);
  const retryAfter = parseRetryAfter(headers, now);
  if (status === 401) return new ProviderAuthError({ provider: "gmail", reason: "unauthorized" });
  if (isGmailRateLimit(status, reason)) {
    return new ProviderRateLimitError({ provider: "gmail", retryAfterMs: retryAfter ?? backoffMs(1) });
  }
  if (status === 403 && reason === "dailyLimitExceeded") {
    return new ProviderRateLimitError({ provider: "gmail", retryAfterMs: msUntilNextUtcMidnight(now) });
  }
  if (status === 403 && reason === "domainPolicy")
    return new ProviderAuthError({ provider: "gmail", reason: "domain_policy" });
  if (status === 403 && reason === "insufficientPermissions") {
    return new ProviderAuthError({ provider: "gmail", reason: "insufficient_scope" });
  }
  if (status >= 500) return new ProviderUnavailableError({ provider: "gmail", retryAfterMs: retryAfter });
  return new ProviderResponseError({ provider: "gmail", status });
}

// ---- Batch part classification (Gmail multipart batch) ----

export type PartOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "auth" }
  | { kind: "rate"; retryAfterMs: number | null }
  | { kind: "server"; retryAfterMs: number | null }
  | { kind: "fail"; error: ActionErrorCode };

function parsePartBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function classifyPart(part: BatchResponsePart | undefined, now: number): PartOutcome {
  if (part === undefined) return { kind: "server", retryAfterMs: null };
  const body = parsePartBody(part.bodyText);
  const retryAfterMs = parseRetryAfter(new Headers(part.headers), now);
  if (part.status >= 200 && part.status < 300) return { kind: "ok", body: isJsonObject(body) ? body : {} };
  if (part.status === 401) return { kind: "auth" };
  if (isGmailRateLimit(part.status, gmailErrorReason(body))) return { kind: "rate", retryAfterMs };
  if (part.status >= 500) return { kind: "server", retryAfterMs };
  if (part.status === 404) return { kind: "fail", error: "not_found" };
  if (part.status === 400) return { kind: "fail", error: "bad_request" };
  return { kind: "fail", error: "unknown" };
}

export interface ActionOutcome {
  result: ActionResult;
  labelIds: string[] | null;
}

export function toActionOutcome(id: string, outcome: Exclude<PartOutcome, { kind: "auth" }>): ActionOutcome {
  switch (outcome.kind) {
    case "ok": {
      const labels = outcome.body.labelIds;
      const labelIds = Array.isArray(labels)
        ? labels.filter((l): l is string => typeof l === "string")
        : null;
      return { result: { id, ok: true, newId: id }, labelIds };
    }
    case "rate":
      return {
        result: { id, ok: false, error: "rate_limited", retryAfterMs: outcome.retryAfterMs },
        labelIds: null,
      };
    case "server":
      return {
        result: { id, ok: false, error: "unavailable", retryAfterMs: outcome.retryAfterMs },
        labelIds: null,
      };
    case "fail":
      return { result: { id, ok: false, error: outcome.error, retryAfterMs: null }, labelIds: null };
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/google/oauth.test.ts`
Expected: PASS, `Tests  38 passed (38)`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/google packages/core/test/msw packages/core/test/providers`
Expected: exit code 0.

```bash
git add packages/core/src/providers/google/types.ts packages/core/src/providers/google/oauth.ts \
  packages/core/test/msw/failures.ts packages/core/test/msw/google-oauth.ts \
  packages/core/test/providers/error-table.ts packages/core/test/providers/google/oauth.test.ts \
  packages/core/test/fixtures/oauth/google-errors.json packages/core/test/fixtures/gmail/api-errors.json
git commit -m "feat(core): add Google OAuth helpers and Gmail error classification"
```

---

### Task 5: Microsoft OAuth with refresh-token rotation and Graph error classification

**Files:**
- Create: `packages/core/src/providers/microsoft/types.ts`
- Create: `packages/core/src/providers/microsoft/oauth.ts`
- Create: `packages/core/test/msw/microsoft-oauth.ts`
- Create: `packages/core/test/fixtures/oauth/microsoft-errors.json`
- Create: `packages/core/test/fixtures/graph/api-errors.json`
- Test: `packages/core/test/providers/microsoft/oauth.test.ts`

**Interfaces:**
- Consumes: Task 2 shell and helpers; Task 4 `FakeOAuthState` and `expectClassified`; plan 01 `MICROSOFT_SCOPES`, `parseRetryAfter`, `backoffMs`, error classes, `ActionResult`.
- Produces (`src/providers/microsoft/oauth.ts`):
  - `MICROSOFT_AUTHORIZE_URL`, `MICROSOFT_TOKEN_URL`, `MICROSOFT_TOKEN_ENDPOINT: TokenEndpoint`
  - `buildMicrosoftAuthorizeUrl(cfg, p): string` (tenant `common`, `response_mode=query`, `prompt=select_account`, S256)
  - `exchangeMicrosoftCode(f, cfg, code, codeVerifier, now): Promise<OAuthTokens>`
  - `refreshMicrosoftToken(f, cfg, refreshToken, now): Promise<OAuthTokens>`: **`result.refreshToken` is the rotated token; callers must re-encrypt and persist it** (plans 03/04 `TokenUpdate`)
  - `hasGraphScopes(granted: readonly string[]): boolean`
  - `aadstsCode(body: unknown): number | null`, `classifyMicrosoftOAuthError(status, body, headers, now): ClearboxError`
  - `graphErrorCode(body: unknown): string | null`, `classifyGraphApiError(status, body, headers, now): ClearboxError`
  - `isDeltaExpired(status: number, body: unknown): boolean`, `subRetryAfter(sub: GraphBatchSubResponse, now: number): number | null`, `graphMoveResult(id: string, sub: GraphBatchSubResponse | undefined, now: number): ActionResult`
  - No revoke function: Entra has no revoke endpoint for these scopes; Disconnect deletes tokens locally and shows `MICROSOFT_CONSENT_URLS` (plan 01).
- Produces (types): `GraphMe`, `GraphRecipient`, `GraphHeader`, `GraphMessage`, `GraphCollection<T>`, `GraphBatchSubRequest`, `GraphBatchSubResponse`, `GraphError`, `MsTokenResponse`, `MsOAuthError`.
- Produces (tests): `MICROSOFT_TEST_CLIENT`, `createMicrosoftOAuthState()`, `microsoftOAuthHandlers(state)`.

- [ ] **Step 1: Add the wire types**

Create `packages/core/src/providers/microsoft/types.ts`:

```ts
// Microsoft identity platform and Graph wire types (research mail-providers.md section 8, plus
// conversationIndex and sentDateTime, which Clearbox selects).

export interface MsTokenResponse {
  token_type: "Bearer";
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  /** Returned on every refresh: persist it (rotation). */
  refresh_token?: string;
}

export interface MsOAuthError {
  error: string;
  error_description: string;
  error_codes?: number[];
  timestamp?: string;
  trace_id?: string;
  correlation_id?: string;
  suberror?: string;
}

export interface GraphMe {
  id: string;
  mail: string | null;
  userPrincipalName: string;
  displayName?: string | null;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress: GraphEmailAddress;
}

export interface GraphHeader {
  name: string;
  value: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  /** Base64 PidTagConversationIndex: 22-byte header + 5 bytes per reply level. */
  conversationIndex?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
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
  internetMessageHeaders?: GraphHeader[];
  "@removed"?: { reason: string };
}

export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphMailFolder {
  id: string;
  displayName: string;
}

export interface GraphBatchSubRequest {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  dependsOn?: string[];
}

export interface GraphBatchRequest {
  requests: GraphBatchSubRequest[];
}

export interface GraphBatchSubResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GraphBatchResponse {
  responses: GraphBatchSubResponse[];
}

export interface GraphError {
  error: {
    code: string;
    message: string;
    innerError?: { date?: string; "request-id"?: string; "client-request-id"?: string };
  };
}
```

- [ ] **Step 2: Add the fake token endpoint and error tables**

Create `packages/core/test/msw/microsoft-oauth.ts` (refresh rotates the refresh token; old tokens stay valid, as Entra documents):

```ts
import { http, HttpResponse } from "msw";
import { FakeOAuthState } from "./google-oauth.ts";

export const MICROSOFT_TEST_CLIENT = {
  clientId: "test-ms-client",
  clientSecret: "test-ms-secret",
  redirectUri: "http://localhost:5173/oauth/microsoft/callback",
} as const;

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export function createMicrosoftOAuthState(): FakeOAuthState {
  return new FakeOAuthState({
    prefix: "m",
    grantedScope: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read",
    rotateRefreshTokens: true,
  });
}

function aadError(error: string, code: number, status: number) {
  return HttpResponse.json(
    {
      error,
      error_description: `AADSTS${String(code)}: synthetic description.\r\nTrace ID: 00000000-0000-0000-0000-000000000000`,
      error_codes: [code],
    },
    { status },
  );
}

export function microsoftOAuthHandlers(state: FakeOAuthState) {
  return [
    http.post(TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      state.tokenRequests.push(form);
      const fail = state.failures.take("POST", "/token");
      if (fail)
        return HttpResponse.json(fail.body ?? null, { status: fail.status, headers: fail.headers ?? {} });
      if (form.get("client_id") !== MICROSOFT_TEST_CLIENT.clientId)
        return aadError("unauthorized_client", 700016, 400);
      if (form.get("client_secret") !== MICROSOFT_TEST_CLIENT.clientSecret)
        return aadError("invalid_client", 7000215, 401);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        if (form.get("code") !== state.validCode || !form.get("code_verifier"))
          return aadError("invalid_grant", 54005, 400);
        return HttpResponse.json(state.issue(true));
      }
      if (grant === "refresh_token") {
        // Old refresh tokens are not revoked on use (Microsoft docs); the fake keeps them valid too.
        if (!state.refreshTokens.has(form.get("refresh_token") ?? ""))
          return aadError("invalid_grant", 70000, 400);
        return HttpResponse.json(state.issue(state.rotateRefreshTokens));
      }
      return aadError("unsupported_grant_type", 70003, 400);
    }),
    http.all("https://login.microsoftonline.com/*", ({ request }) => {
      const url = new URL(request.url);
      throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
    }),
  ];
}
```

Create `packages/core/test/fixtures/oauth/microsoft-errors.json`:

```json
[
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_description": "AADSTS70008: expired", "error_codes": [70008] },
    "expected": "ProviderAuthError",
    "reason": "AADSTS70008"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_grant",
      "error_description": "AADSTS700082: inactive",
      "error_codes": [700082]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS700082"
  },
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_description": "AADSTS50173: revoked", "error_codes": [50173] },
    "expected": "ProviderAuthError",
    "reason": "AADSTS50173"
  },
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_description": "AADSTS70000: invalid", "error_codes": [70000] },
    "expected": "ProviderAuthError",
    "reason": "AADSTS70000"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_grant",
      "error_description": "AADSTS70043: sign-in frequency",
      "error_codes": [70043]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS70043"
  },
  {
    "status": 400,
    "body": {
      "error": "interaction_required",
      "error_description": "AADSTS50076: mfa",
      "error_codes": [50076]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS50076"
  },
  {
    "status": 400,
    "body": {
      "error": "interaction_required",
      "error_description": "AADSTS50079: enrollment",
      "error_codes": [50079]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS50079"
  },
  {
    "status": 400,
    "body": {
      "error": "interaction_required",
      "error_description": "AADSTS50078: mfa expired",
      "error_codes": [50078]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS50078"
  },
  {
    "status": 400,
    "body": {
      "error": "interaction_required",
      "error_description": "AADSTS53003: conditional access",
      "error_codes": [53003]
    },
    "expected": "ProviderAuthError",
    "reason": "AADSTS53003"
  },
  {
    "status": 400,
    "body": { "error": "invalid_grant", "error_description": "AADSTS65001: consent", "error_codes": [65001] },
    "expected": "ProviderAuthError",
    "reason": "AADSTS65001"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_grant",
      "error_description": "AADSTS90094: admin consent",
      "error_codes": [90094]
    },
    "expected": "ProviderAuthError",
    "reason": "admin_consent_required"
  },
  {
    "status": 401,
    "body": {
      "error": "invalid_client",
      "error_description": "AADSTS7000215: bad secret",
      "error_codes": [7000215]
    },
    "expected": "ProviderConfigError",
    "reason": "AADSTS7000215"
  },
  {
    "status": 401,
    "body": { "error": "invalid_client", "error_description": "AADSTS7000222: secret expired" },
    "expected": "ProviderConfigError",
    "reason": "AADSTS7000222"
  },
  {
    "status": 400,
    "body": {
      "error": "unauthorized_client",
      "error_description": "AADSTS700016: app not found",
      "error_codes": [700016]
    },
    "expected": "ProviderConfigError",
    "reason": "AADSTS700016"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_request",
      "error_description": "AADSTS50194: not multitenant",
      "error_codes": [50194]
    },
    "expected": "ProviderConfigError",
    "reason": "AADSTS50194"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_request",
      "error_description": "AADSTS50011: redirect mismatch",
      "error_codes": [50011]
    },
    "expected": "ProviderConfigError",
    "reason": "AADSTS50011"
  },
  {
    "status": 400,
    "body": {
      "error": "invalid_grant",
      "error_description": "AADSTS54005: code already redeemed",
      "error_codes": [54005]
    },
    "expected": "ProviderAuthError",
    "reason": "invalid_grant"
  },
  {
    "status": 400,
    "body": { "error": "consent_required", "error_description": "consent" },
    "expected": "ProviderAuthError",
    "reason": "consent_required"
  },
  {
    "status": 401,
    "body": { "error": "invalid_client", "error_description": "no code" },
    "expected": "ProviderConfigError",
    "reason": "invalid_client"
  },
  {
    "status": 503,
    "body": { "error": "temporarily_unavailable", "error_description": "AADSTS90033: busy" },
    "headers": { "Retry-After": "5" },
    "expected": "ProviderUnavailableError",
    "retryAfterMs": 5000
  },
  { "status": 500, "body": null, "expected": "ProviderUnavailableError", "retryAfterMs": null },
  {
    "status": 429,
    "body": { "error": "too_many_requests" },
    "headers": { "Retry-After": "7" },
    "expected": "ProviderRateLimitError",
    "retryAfterMs": 7000
  },
  {
    "status": 400,
    "body": { "error": "invalid_scope", "error_description": "AADSTS70011: scope" },
    "expected": "ProviderResponseError"
  }
]
```

Create `packages/core/test/fixtures/graph/api-errors.json`:

```json
[
  {
    "status": 401,
    "body": { "error": { "code": "InvalidAuthenticationToken", "message": "Access token has expired." } },
    "expected": "ProviderAuthError",
    "reason": "unauthorized"
  },
  {
    "status": 403,
    "body": { "error": { "code": "ErrorAccessDenied", "message": "Access is denied." } },
    "expected": "ProviderAuthError",
    "reason": "ErrorAccessDenied"
  },
  { "status": 403, "body": null, "expected": "ProviderAuthError", "reason": "forbidden" },
  {
    "status": 429,
    "body": { "error": { "code": "TooManyRequests", "message": "Please retry again later." } },
    "headers": { "Retry-After": "10" },
    "expected": "ProviderRateLimitError",
    "retryAfterMs": 10000
  },
  {
    "status": 429,
    "body": { "error": { "code": "TooManyRequests", "message": "Please retry again later." } },
    "expected": "ProviderRateLimitError",
    "retryAfterRange": [60000, 61000]
  },
  {
    "status": 503,
    "body": { "error": { "code": "ServiceUnavailable", "message": "Unavailable" } },
    "headers": { "Retry-After": "5" },
    "expected": "ProviderUnavailableError",
    "retryAfterMs": 5000
  },
  { "status": 504, "body": null, "expected": "ProviderUnavailableError", "retryAfterMs": null },
  {
    "status": 400,
    "body": { "error": { "code": "ErrorInvalidRequest", "message": "Bad request" } },
    "expected": "ProviderResponseError",
    "httpStatus": 400
  },
  {
    "status": 404,
    "body": { "error": { "code": "ErrorItemNotFound", "message": "Not found" } },
    "expected": "ProviderResponseError",
    "httpStatus": 404
  }
]
```

- [ ] **Step 3: Write the failing test**

Create `packages/core/test/providers/microsoft/oauth.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "../../../src/model/errors.ts";
import {
  aadstsCode,
  buildMicrosoftAuthorizeUrl,
  classifyGraphApiError,
  classifyMicrosoftOAuthError,
  exchangeMicrosoftCode,
  graphErrorCode,
  graphMoveResult,
  hasGraphScopes,
  isDeltaExpired,
  refreshMicrosoftToken,
} from "../../../src/providers/microsoft/oauth.ts";
import graphApiErrors from "../../fixtures/graph/api-errors.json" with { type: "json" };
import microsoftErrors from "../../fixtures/oauth/microsoft-errors.json" with { type: "json" };
import type { FakeOAuthState } from "../../msw/google-oauth.ts";
import {
  MICROSOFT_TEST_CLIENT,
  createMicrosoftOAuthState,
  microsoftOAuthHandlers,
} from "../../msw/microsoft-oauth.ts";
import { server } from "../../setup/msw.ts";
import { expectClassified, type ErrorRow } from "../error-table.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let state: FakeOAuthState;

beforeEach(() => {
  state = createMicrosoftOAuthState();
  server.use(...microsoftOAuthHandlers(state));
});

describe("buildMicrosoftAuthorizeUrl", () => {
  it("uses tenant common, response_mode=query, select_account and PKCE S256", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl(MICROSOFT_TEST_CLIENT, { state: "nonce-1", codeChallenge: "challenge-1" }),
    );
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-ms-client",
      response_type: "code",
      redirect_uri: "http://localhost:5173/oauth/microsoft/callback",
      response_mode: "query",
      scope: "offline_access User.Read Mail.ReadWrite",
      state: "nonce-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });
});

describe("exchangeMicrosoftCode", () => {
  it("returns tokens including the first refresh token", async () => {
    const tokens = await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "verifier-1", NOW);
    expect(tokens.accessToken).toBe("m-at-1");
    expect(tokens.refreshToken).toBe("m-rt-1");
    expect(hasGraphScopes(tokens.grantedScopes)).toBe(true);
    const form = state.tokenRequests[0];
    expect(form?.get("scope")).toBe("offline_access User.Read Mail.ReadWrite");
    expect(form?.get("code_verifier")).toBe("verifier-1");
  });

  it("maps a wrong secret to ProviderConfigError AADSTS7000215", async () => {
    await expect(
      exchangeMicrosoftCode(
        fetch,
        { ...MICROSOFT_TEST_CLIENT, clientSecret: "wrong" },
        "code-valid",
        "v",
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ProviderConfigError", reason: "AADSTS7000215" });
  });
});

describe("refreshMicrosoftToken", () => {
  it("returns a rotated refresh token on every refresh", async () => {
    const first = await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "v", NOW);
    const second = await refreshMicrosoftToken(
      fetch,
      MICROSOFT_TEST_CLIENT,
      first.refreshToken ?? "",
      NOW + 1,
    );
    const third = await refreshMicrosoftToken(
      fetch,
      MICROSOFT_TEST_CLIENT,
      second.refreshToken ?? "",
      NOW + 2,
    );
    expect([first.refreshToken, second.refreshToken, third.refreshToken]).toEqual([
      "m-rt-1",
      "m-rt-2",
      "m-rt-3",
    ]);
    const form = state.tokenRequests[2];
    expect(form?.get("refresh_token")).toBe("m-rt-2");
    expect(form?.get("client_secret")).toBe("test-ms-secret");
    expect(form?.get("scope")).toBe("offline_access User.Read Mail.ReadWrite");
  });

  it("returns refreshToken null when Entra omits it (caller keeps the stored token)", async () => {
    await exchangeMicrosoftCode(fetch, MICROSOFT_TEST_CLIENT, "code-valid", "v", NOW);
    state.rotateRefreshTokens = false;
    const tokens = await refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-1", NOW);
    expect(tokens.refreshToken).toBeNull();
  });

  it("maps an invalid refresh token to ProviderAuthError AADSTS70000", async () => {
    await expect(
      refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-unknown", NOW),
    ).rejects.toMatchObject({
      name: "ProviderAuthError",
      provider: "outlook",
      reason: "AADSTS70000",
    });
  });

  it("maps network failure to ProviderUnavailableError", async () => {
    server.use(
      http.post("https://login.microsoftonline.com/common/oauth2/v2.0/token", () => HttpResponse.error()),
    );
    await expect(refreshMicrosoftToken(fetch, MICROSOFT_TEST_CLIENT, "m-rt-1", NOW)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("hasGraphScopes", () => {
  it("accepts Mail.ReadWrite case-insensitively with or without the Graph prefix", () => {
    expect(hasGraphScopes(["https://graph.microsoft.com/Mail.ReadWrite"])).toBe(true);
    expect(hasGraphScopes(["mail.readwrite"])).toBe(true);
    expect(hasGraphScopes(["Mail.Read", "User.Read"])).toBe(false);
    expect(hasGraphScopes(["https://graph.microsoft.com/Mail.ReadWrite.Shared"])).toBe(false);
  });
});

describe("aadstsCode", () => {
  it("prefers error_codes and falls back to the description", () => {
    expect(aadstsCode({ error_codes: [70008], error_description: "AADSTS1: x" })).toBe(70008);
    expect(aadstsCode({ error_description: "AADSTS7000222: expired" })).toBe(7000222);
    expect(aadstsCode({ error: "x" })).toBeNull();
    expect(aadstsCode(null)).toBeNull();
  });
});

describe("classifyMicrosoftOAuthError", () => {
  it.each(microsoftErrors as ErrorRow[])("HTTP $status $body.error -> $expected", (row) => {
    expectClassified(
      row,
      classifyMicrosoftOAuthError(row.status, row.body, new Headers(row.headers ?? {}), NOW),
    );
  });
});

describe("classifyGraphApiError", () => {
  it.each(graphApiErrors as ErrorRow[])("HTTP $status -> $expected", (row) => {
    expectClassified(row, classifyGraphApiError(row.status, row.body, new Headers(row.headers ?? {}), NOW));
  });
  it("reads error.code", () => {
    expect(graphErrorCode({ error: { code: "syncStateNotFound", message: "x" } })).toBe("syncStateNotFound");
    expect(graphErrorCode({})).toBeNull();
  });
});

describe("isDeltaExpired", () => {
  it("detects 410 and 4xx sync state codes, case-insensitive", () => {
    expect(isDeltaExpired(410, null)).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "syncStateNotFound", message: "x" } })).toBe(true);
    expect(isDeltaExpired(404, { error: { code: "SyncStateInvalid", message: "x" } })).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "resyncRequired", message: "x" } })).toBe(true);
    expect(isDeltaExpired(400, { error: { code: "ErrorInvalidRequest", message: "x" } })).toBe(false);
    expect(isDeltaExpired(503, { error: { code: "syncStateNotFound", message: "x" } })).toBe(false);
  });
});

describe("graphMoveResult", () => {
  const sub = (status: number, body: unknown = null, headers: Record<string, string> = {}) => ({
    id: "0",
    status,
    headers,
    body,
  });

  it("maps move sub-responses to ActionResult", () => {
    expect(graphMoveResult("a", sub(201, { id: "a-new" }), NOW)).toEqual({
      id: "a",
      ok: true,
      newId: "a-new",
    });
    expect(graphMoveResult("a", sub(200, {}), NOW)).toEqual({ id: "a", ok: true, newId: "a" });
    expect(graphMoveResult("a", sub(404), NOW)).toMatchObject({ error: "not_found" });
    expect(graphMoveResult("a", sub(429, null, { "Retry-After": "10" }), NOW)).toEqual({
      id: "a",
      ok: false,
      error: "rate_limited",
      retryAfterMs: 10_000,
    });
    expect(graphMoveResult("a", sub(504), NOW)).toMatchObject({ error: "unavailable" });
    expect(graphMoveResult("a", sub(400), NOW)).toMatchObject({ error: "bad_request" });
    expect(graphMoveResult("a", sub(403), NOW)).toMatchObject({ error: "unknown" });
    expect(graphMoveResult("a", undefined, NOW)).toMatchObject({ error: "unknown" });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/microsoft/oauth.test.ts`
Expected: FAIL, `../../../src/providers/microsoft/oauth.ts` not found (`Error: Cannot find module ...`).

- [ ] **Step 5: Implement Microsoft OAuth and Graph classification**

Create `packages/core/src/providers/microsoft/oauth.ts`:

```ts
import { backoffMs, parseRetryAfter } from "../../http/fetch.ts";
import type { FetchLike } from "../../http/fetch.ts";
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { ClearboxError } from "../../model/errors.ts";
import {
  MICROSOFT_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  isJsonObject,
  refreshAccessToken,
} from "../oauth.ts";
import type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "../oauth.ts";
import type { ActionResult } from "../provider.ts";
import type { OAuthTokens } from "../token.ts";
import type { GraphBatchSubResponse } from "./types.ts";

// Microsoft has no OAuth revoke endpoint for these scopes (POST /me/revokeSignInSessions needs
// User.RevokeSessions.All and is not supported for personal accounts). Disconnect deletes the tokens
// locally and shows MICROSOFT_CONSENT_URLS (defined in providers/oauth.ts).

export const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const AUTH_CODES: ReadonlySet<number> = new Set([
  70008, 700082, 50173, 70000, 70043, 50076, 50079, 50078, 53003, 65001,
]);
const CONFIG_CODES: ReadonlySet<number> = new Set([7000215, 7000222, 700016, 50194, 50011]);
const REAUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
]);
const CONFIG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
]);

/** First AADSTS code: error_codes[0], else the number in "AADSTSnnnn" of error_description. */
export function aadstsCode(body: unknown): number | null {
  if (!isJsonObject(body)) return null;
  const codes = body.error_codes;
  const first: unknown = Array.isArray(codes) ? codes[0] : undefined;
  if (typeof first === "number") return first;
  const match =
    typeof body.error_description === "string" ? /AADSTS(\d+)/.exec(body.error_description) : null;
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Classifies a non-2xx Microsoft token endpoint response (contracts 4.4 table). AADSTS codes win over `error`. */
export function classifyMicrosoftOAuthError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const code = aadstsCode(body);
  const error = isJsonObject(body) && typeof body.error === "string" ? body.error : null;
  if (code === 90094) return new ProviderAuthError({ provider: "outlook", reason: "admin_consent_required" });
  if (code !== null && CONFIG_CODES.has(code))
    return new ProviderConfigError({ provider: "outlook", reason: `AADSTS${String(code)}` });
  if (code !== null && AUTH_CODES.has(code))
    return new ProviderAuthError({ provider: "outlook", reason: `AADSTS${String(code)}` });
  if (error !== null && REAUTH_ERRORS.has(error))
    return new ProviderAuthError({ provider: "outlook", reason: error });
  if (error !== null && CONFIG_ERRORS.has(error))
    return new ProviderConfigError({ provider: "outlook", reason: error });
  if (status === 429) {
    return new ProviderRateLimitError({
      provider: "outlook",
      retryAfterMs: parseRetryAfter(headers, now) ?? backoffMs(1),
    });
  }
  if (error === "temporarily_unavailable" || status >= 500) {
    return new ProviderUnavailableError({ provider: "outlook", retryAfterMs: parseRetryAfter(headers, now) });
  }
  return new ProviderResponseError({ provider: "outlook", status });
}

export const MICROSOFT_TOKEN_ENDPOINT: TokenEndpoint = {
  provider: "outlook",
  url: MICROSOFT_TOKEN_URL,
  classify: classifyMicrosoftOAuthError,
};

/** Tenant "common", response_mode=query (keeps the SameSite=Lax state cookie), prompt=select_account, PKCE S256. */
export function buildMicrosoftAuthorizeUrl(cfg: OAuthClientConfig, p: AuthorizeParams): string {
  return buildAuthorizeUrl(MICROSOFT_AUTHORIZE_URL, {
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    login_hint: p.loginHint,
  });
}

export function exchangeMicrosoftCode(
  f: FetchLike,
  cfg: OAuthClientConfig,
  code: string,
  codeVerifier: string,
  now: number,
): Promise<OAuthTokens> {
  return exchangeCode(
    f,
    MICROSOFT_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      scope: MICROSOFT_SCOPES.join(" "),
      code,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
      client_secret: cfg.clientSecret,
    },
    now,
  );
}

/**
 * Microsoft rotates refresh tokens: result.refreshToken is the NEW token and the caller must re-encrypt and
 * persist it (contracts 7.15 TokenUpdate), also when the rest of the tick fails. null only if Entra omitted it.
 */
export function refreshMicrosoftToken(
  f: FetchLike,
  cfg: OAuthClientConfig,
  refreshToken: string,
  now: number,
): Promise<OAuthTokens> {
  return refreshAccessToken(
    f,
    MICROSOFT_TOKEN_ENDPOINT,
    {
      client_id: cfg.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_secret: cfg.clientSecret,
      scope: MICROSOFT_SCOPES.join(" "),
    },
    now,
  );
}

function normalizeScope(scope: string): string {
  return scope
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/graph\.microsoft\.com\//, "");
}

/** Case-insensitive; accepts "Mail.ReadWrite" with or without the https://graph.microsoft.com/ prefix. */
export function hasGraphScopes(granted: readonly string[]): boolean {
  return granted.some((scope) => normalizeScope(scope) === "mail.readwrite");
}

/** error.code of a Graph error body, else null. */
export function graphErrorCode(body: unknown): string | null {
  if (!isJsonObject(body) || !isJsonObject(body.error)) return null;
  return typeof body.error.code === "string" ? body.error.code : null;
}

/** Classifies a whole-call Graph error (after the one 401 refresh retry). Delta expiry is handled by the caller. */
export function classifyGraphApiError(
  status: number,
  body: unknown,
  headers: Headers,
  now: number,
): ClearboxError {
  const retryAfter = parseRetryAfter(headers, now);
  if (status === 401) return new ProviderAuthError({ provider: "outlook", reason: "unauthorized" });
  if (status === 403)
    return new ProviderAuthError({ provider: "outlook", reason: graphErrorCode(body) ?? "forbidden" });
  if (status === 429)
    return new ProviderRateLimitError({ provider: "outlook", retryAfterMs: retryAfter ?? backoffMs(1) });
  if (status >= 500) return new ProviderUnavailableError({ provider: "outlook", retryAfterMs: retryAfter });
  return new ProviderResponseError({ provider: "outlook", status });
}

// ---- $batch sub-responses and delta expiry ----

const DELTA_EXPIRED_CODES: ReadonlySet<string> = new Set([
  "syncstatenotfound",
  "syncstateinvalid",
  "resyncrequired",
]);

/** Delta token expiry: 410 Gone (handled by the caller) or any 4xx with syncStateNotFound / syncStateInvalid / resyncRequired. */
export function isDeltaExpired(status: number, body: unknown): boolean {
  const code = graphErrorCode(body)?.toLowerCase() ?? null;
  return status === 410 || (status >= 400 && status < 500 && code !== null && DELTA_EXPIRED_CODES.has(code));
}

/** Retry-After of one $batch sub-response, in ms. */
export function subRetryAfter(sub: GraphBatchSubResponse, now: number): number | null {
  return parseRetryAfter(new Headers(sub.headers), now);
}

/** One move sub-response -> ActionResult; newId is the moved message id from the response body. */
export function graphMoveResult(
  id: string,
  sub: GraphBatchSubResponse | undefined,
  now: number,
): ActionResult {
  if (sub === undefined) return { id, ok: false, error: "unknown", retryAfterMs: null };
  if (sub.status === 200 || sub.status === 201) {
    const newId = isJsonObject(sub.body) && typeof sub.body.id === "string" ? sub.body.id : id;
    return { id, ok: true, newId };
  }
  if (sub.status === 404) return { id, ok: false, error: "not_found", retryAfterMs: null };
  if (sub.status === 429)
    return { id, ok: false, error: "rate_limited", retryAfterMs: subRetryAfter(sub, now) };
  if (sub.status >= 500)
    return { id, ok: false, error: "unavailable", retryAfterMs: subRetryAfter(sub, now) };
  if (sub.status === 400) return { id, ok: false, error: "bad_request", retryAfterMs: null };
  return { id, ok: false, error: "unknown", retryAfterMs: null };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/microsoft/oauth.test.ts`
Expected: PASS, `Tests  44 passed (44)`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/microsoft packages/core/test/msw packages/core/test/providers`
Expected: exit code 0.

```bash
git add packages/core/src/providers/microsoft/types.ts packages/core/src/providers/microsoft/oauth.ts \
  packages/core/test/msw/microsoft-oauth.ts packages/core/test/providers/microsoft/oauth.test.ts \
  packages/core/test/fixtures/oauth/microsoft-errors.json packages/core/test/fixtures/graph/api-errors.json
git commit -m "feat(core): add Microsoft OAuth with token rotation and Graph error classification"
```

---

### Task 6: Gmail metadata mapping, cursors, history scan and deep link

**Files:**
- Create: `packages/core/src/providers/google/map.ts`
- Create: `packages/core/test/fixtures/gmail/metadata-newsletter.json`
- Create: `packages/core/test/fixtures/gmail/history-page.json`
- Modify: `packages/core/test/fixtures/builders.ts` (plan 01 file: one import, one appended section)
- Test: `packages/core/test/providers/google/map.test.ts`

**Interfaces:**
- Consumes: Task 2 `buildMailHeaders`, `headerValues`, `parseCursorJson`, `uniqueAddresses`; Task 4 types; plan 01 `parseAddress`, `headerValue`, `decodeEncodedWords`, `collapseWhitespace`, `decodeHtmlEntities`, `truncateChars`, `CursorExpiredError`, `MailMessage`, `MailCategory`, `SentItem`, `IncrementalCursor`.
- Produces (`src/providers/google/map.ts`):
  - `GMAIL_API = "https://gmail.googleapis.com"`, `GMAIL_METADATA_HEADERS`, `GMAIL_METADATA_FIELDS`, `GMAIL_SENT_HEADERS`, `GMAIL_SENT_FIELDS`
  - `gmailMetadataPath(id: string): string`, `gmailSentMetadataPath(id: string): string` (batch part paths)
  - `gmailCategory(labels: readonly string[]): MailCategory | null`
  - `mapGmailMessage(meta: GmailMessageMetadata): MailMessage`, `mapGmailSentItem(meta: GmailMessageMetadata): SentItem`
  - `buildGmailDeepLink(email: string, providerMessageId: string): string` (`https://mail.google.com/mail/u/?authuser=<email>#all/<id>`)
  - `interface IncrementalState { v: 1; historyId: string; catchupAfter: number | null; catchupPageToken: string | null }`, `pageTokenOf(cursor, kind: "backfill" | "sent"): string`, `pageCursor(pageToken: string | null): string | null`, `decodeIncremental(cursor: string): IncrementalState`, `encodeIncremental(state): IncrementalCursor`
  - `interface HistoryScan { inbox: string[]; sent: string[]; removed: string[]; processed: number; lastId: string | null }`, `scanHistory(records: readonly GmailHistoryRecord[], max: number): HistoryScan`
- Produces (tests): `makeGmailMetadata(overrides?: GmailMetadataOverrides): GmailMessageMetadata`, `type GmailMetadataOverrides`.

- [ ] **Step 1: Add fixtures and the builder**

Create `packages/core/test/fixtures/gmail/metadata-newsletter.json` (exercises RFC 2047 B and Q, UTF-8 and ISO-8859-1, folded `To`, an untrusted upstream `Authentication-Results`, `Message-Id` spelled differently, entities in the snippet):

```json
{
  "id": "19a0c0ffee000001",
  "threadId": "19a0c0ffee000000",
  "labelIds": ["UNREAD", "CATEGORY_PROMOTIONS", "INBOX", "IMPORTANT"],
  "snippet": "Our autumn sale starts now &amp; ends Sunday.   Don&#39;t miss it",
  "historyId": "4421337",
  "internalDate": "1760500000000",
  "payload": {
    "mimeType": "multipart/mixed",
    "headers": [
      { "name": "From", "value": "=?UTF-8?B?Q2Fmw6kgU2hvcA==?= <News@Shop.Example.com>" },
      { "name": "To", "value": "Owner <owner@example.test>,\r\n team@example.org" },
      { "name": "Cc", "value": "\"Doe, Jane\" <jane@example.net>" },
      { "name": "Delivered-To", "value": "owner@example.test" },
      { "name": "Subject", "value": "=?UTF-8?Q?Caf=C3=A9_autumn_sale?= =?ISO-8859-1?Q?_=FCber_30=25_off?=" },
      { "name": "Date", "value": "Wed, 15 Oct 2025 03:46:40 +0000" },
      { "name": "Message-Id", "value": "<abc123@mail.shop.example.com>" },
      { "name": "References", "value": "<r1@example.com> <r2@example.com>" },
      { "name": "In-Reply-To", "value": "<r2@example.com>" },
      {
        "name": "List-Unsubscribe",
        "value": "<mailto:unsub@shop.example.com?subject=unsub>, <https://shop.example.com/u/abc>"
      },
      { "name": "List-Unsubscribe-Post", "value": "List-Unsubscribe=One-Click" },
      { "name": "List-Id", "value": "Shop News <news.shop.example.com>" },
      { "name": "Precedence", "value": "bulk" },
      { "name": "Authentication-Results", "value": "relay.example.net; dkim=fail header.d=shop.example.com" },
      {
        "name": "Authentication-Results",
        "value": "mx.google.com; dkim=pass header.i=@shop.example.com header.s=s1 header.b=Ab12; spf=pass (google.com: domain of bounce@esp.example.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@esp.example.net; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example.com"
      },
      { "name": "Return-Path", "value": "<bounce-123@esp.example.net>" },
      { "name": "Content-Type", "value": "multipart/mixed; boundary=\"b1\"" }
    ]
  }
}
```

Create `packages/core/test/fixtures/gmail/history-page.json`:

```json
{
  "history": [
    {
      "id": "2001",
      "messagesAdded": [
        { "message": { "id": "msg0001", "threadId": "thr0001", "labelIds": ["INBOX", "UNREAD"] } }
      ]
    },
    {
      "id": "2002",
      "messagesAdded": [{ "message": { "id": "draft01", "threadId": "draft01", "labelIds": ["DRAFT"] } }]
    },
    {
      "id": "2003",
      "messagesAdded": [{ "message": { "id": "sent01", "threadId": "thr0001", "labelIds": ["SENT"] } }]
    },
    {
      "id": "2004",
      "labelsAdded": [{ "message": { "id": "msg0002", "threadId": "thr0002" }, "labelIds": ["TRASH"] }]
    },
    {
      "id": "2005",
      "labelsRemoved": [{ "message": { "id": "msg0003", "threadId": "thr0003" }, "labelIds": ["INBOX"] }]
    },
    { "id": "2006", "messagesDeleted": [{ "message": { "id": "msg0004", "threadId": "thr0004" } }] },
    {
      "id": "2007",
      "labelsAdded": [{ "message": { "id": "msg0005", "threadId": "thr0005" }, "labelIds": ["INBOX"] }]
    },
    {
      "id": "2008",
      "messagesAdded": [{ "message": { "id": "msg0006", "threadId": "thr0006", "labelIds": ["INBOX"] } }]
    }
  ],
  "nextPageToken": "h2008",
  "historyId": "2100"
}
```

In `packages/core/test/fixtures/builders.ts`, add this import next to the other type imports:

```ts
import type { GmailHeader, GmailMessageMetadata } from "../../src/providers/google/types.ts";
```

and append to the end of the file:

```ts
// ---- Provider wire builders (plan 02) ----

export type GmailMetadataOverrides = Partial<Omit<GmailMessageMetadata, "payload">> & {
  mimeType?: string;
  headers?: GmailHeader[];
};

/** Minimal Gmail inbox metadata from a synthetic sender; override headers to test parsing. */
export function makeGmailMetadata(overrides: GmailMetadataOverrides = {}): GmailMessageMetadata {
  const { mimeType, headers, ...rest } = overrides;
  return {
    id: "18f0000000000001",
    threadId: "18f0000000000001",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    snippet: "Synthetic snippet",
    historyId: "1001",
    internalDate: "1760000000000",
    payload: {
      mimeType: mimeType ?? "multipart/alternative",
      headers: headers ?? [
        { name: "From", value: "Example Sender <sender@example.com>" },
        { name: "To", value: "owner@example.test" },
        { name: "Subject", value: "Synthetic subject" },
      ],
    },
    ...rest,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/providers/google/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CursorExpiredError } from "../../../src/model/errors.ts";
import {
  GMAIL_METADATA_HEADERS,
  buildGmailDeepLink,
  decodeIncremental,
  encodeIncremental,
  gmailCategory,
  gmailMetadataPath,
  gmailSentMetadataPath,
  mapGmailMessage,
  mapGmailSentItem,
  pageCursor,
  pageTokenOf,
  scanHistory,
} from "../../../src/providers/google/map.ts";
import type { GmailHistoryResponse, GmailMessageMetadata } from "../../../src/providers/google/types.ts";
import { makeGmailMetadata } from "../../fixtures/builders.ts";
import historyPage from "../../fixtures/gmail/history-page.json" with { type: "json" };
import newsletter from "../../fixtures/gmail/metadata-newsletter.json" with { type: "json" };

describe("mapGmailMessage", () => {
  it("normalizes the newsletter fixture", () => {
    const msg = mapGmailMessage(newsletter as GmailMessageMetadata);
    expect(msg).toMatchObject({
      providerMessageId: "19a0c0ffee000001",
      threadId: "19a0c0ffee000000",
      internetMessageId: "<abc123@mail.shop.example.com>",
      receivedAt: 1_760_500_000_000,
      from: { address: "news@shop.example.com", name: "Café Shop" },
      to: ["owner@example.test", "team@example.org"],
      cc: ["jane@example.net"],
      deliveredTo: ["owner@example.test"],
      subject: "Café autumn sale über 30% off",
      snippet: "Our autumn sale starts now & ends Sunday. Don't miss it",
      isRead: false,
      starred: false,
      providerImportant: true,
      category: "promotions",
      hasAttachments: true,
      attachmentsApprox: true,
      threadDepth: 3,
      webLink: null,
      labels: ["UNREAD", "CATEGORY_PROMOTIONS", "INBOX", "IMPORTANT"],
    });
    expect(msg.headers).toEqual({
      listUnsubscribe: "<mailto:unsub@shop.example.com?subject=unsub>, <https://shop.example.com/u/abc>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      listId: "Shop News <news.shop.example.com>",
      precedence: "bulk",
      autoSubmitted: null,
      authenticationResults:
        "mx.google.com; dkim=pass header.i=@shop.example.com header.s=s1 header.b=Ab12; spf=pass (google.com: domain of bounce@esp.example.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@esp.example.net; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example.com",
      returnPath: "<bounce-123@esp.example.net>",
      contentType: 'multipart/mixed; boundary="b1"',
      references: "<r1@example.com> <r2@example.com>",
      inReplyTo: "<r2@example.com>",
    });
  });

  it("drops an upstream Authentication-Results that is not from mx.google.com", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({
        headers: [{ name: "Authentication-Results", value: "evil.example.net; spf=pass" }],
      }),
    );
    expect(msg.headers.authenticationResults).toBeNull();
  });

  it("falls back to the Content-Type header when payload.mimeType is missing", () => {
    const meta = makeGmailMetadata({
      headers: [{ name: "Content-Type", value: "multipart/mixed; boundary=x" }],
    });
    delete meta.payload?.mimeType;
    expect(mapGmailMessage(meta).hasAttachments).toBe(true);
    expect(mapGmailMessage(makeGmailMetadata({ mimeType: "multipart/related" })).hasAttachments).toBe(false);
    expect(mapGmailMessage(makeGmailMetadata({ mimeType: "multipart/alternative" })).hasAttachments).toBe(
      false,
    );
  });

  it("uses the Date header when internalDate is missing, else 0", () => {
    const meta = makeGmailMetadata({ headers: [{ name: "Date", value: "Wed, 15 Oct 2025 03:46:40 +0000" }] });
    delete meta.internalDate;
    expect(mapGmailMessage(meta).receivedAt).toBe(1_760_500_000_000);
    const none = makeGmailMetadata({ headers: [] });
    delete none.internalDate;
    expect(mapGmailMessage(none).receivedAt).toBe(0);
  });

  it("handles a missing From, Subject and payload", () => {
    const msg = mapGmailMessage({ id: "18f0000000000009", threadId: "18f0000000000009" });
    expect(msg.from).toEqual({ address: null, name: null });
    expect(msg.subject).toBe("");
    expect(msg.snippet).toBe("");
    expect(msg.isRead).toBe(true);
    expect(msg.category).toBeNull();
    expect(msg.threadDepth).toBe(1);
  });

  it("maps STARRED, CATEGORY_PERSONAL and read state", () => {
    const msg = mapGmailMessage(makeGmailMetadata({ labelIds: ["INBOX", "STARRED", "CATEGORY_PERSONAL"] }));
    expect(msg).toMatchObject({ starred: true, isRead: true, category: "primary", providerImportant: false });
  });

  it("counts In-Reply-To without References as depth 2", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({ headers: [{ name: "In-Reply-To", value: "<a@example.com>" }] }),
    );
    expect(msg.threadDepth).toBe(2);
  });

  it("decodes RFC 2047 edge cases in subject and display name", () => {
    const msg = mapGmailMessage(
      makeGmailMetadata({
        headers: [
          { name: "From", value: '"=?ISO-8859-1?Q?Gr=FC=DFe?=" <greet@example.org>' },
          { name: "Subject", value: "=?utf-8?b?Q2Fmw6kgbmV3cw==?= and =?x-unknown?Q?raw?=" },
        ],
      }),
    );
    expect(msg.from).toEqual({ address: "greet@example.org", name: "Grüße" });
    expect(msg.subject).toBe("Café news and =?x-unknown?Q?raw?=");
  });

  it("truncates the snippet to 255 code points", () => {
    const msg = mapGmailMessage(makeGmailMetadata({ snippet: "é".repeat(300) }));
    expect([...msg.snippet]).toHaveLength(255);
  });
});

describe("mapGmailSentItem", () => {
  it("collects lowercased To, Cc and Bcc recipients", () => {
    const item = mapGmailSentItem(
      makeGmailMetadata({
        threadId: "18f00000000000aa",
        internalDate: "1760000000000",
        headers: [
          { name: "To", value: "Friend <Friend@Example.com>" },
          { name: "Cc", value: "friend@example.com, other@example.org" },
          { name: "Bcc", value: "hidden@example.net" },
        ],
      }),
    );
    expect(item).toEqual({
      threadId: "18f00000000000aa",
      recipients: ["friend@example.com", "other@example.org", "hidden@example.net"],
      sentAt: 1_760_000_000_000,
    });
  });
});

describe("gmailMetadataPath", () => {
  it("repeats metadataHeaders and sets fields", () => {
    const url = new URL(gmailMetadataPath("18f0000000000001"), "https://gmail.googleapis.com");
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/18f0000000000001");
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual([...GMAIL_METADATA_HEADERS]);
    expect(url.searchParams.get("fields")).toBe(
      "id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,headers)",
    );
  });
  it("sent path asks for To, Cc and Bcc only", () => {
    const url = new URL(gmailSentMetadataPath("x1"), "https://gmail.googleapis.com");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual(["To", "Cc", "Bcc"]);
  });
});

describe("gmailCategory", () => {
  it("maps CATEGORY_* labels", () => {
    expect(gmailCategory(["CATEGORY_SOCIAL"])).toBe("social");
    expect(gmailCategory(["CATEGORY_FORUMS"])).toBe("forums");
    expect(gmailCategory(["INBOX"])).toBeNull();
  });
});

describe("buildGmailDeepLink", () => {
  it("opens the message for the right account", () => {
    expect(buildGmailDeepLink("owner@example.test", "19a0c0ffee000001")).toBe(
      "https://mail.google.com/mail/u/?authuser=owner%40example.test#all/19a0c0ffee000001",
    );
  });
});

describe("scanHistory", () => {
  const records = (historyPage as GmailHistoryResponse).history ?? [];

  it("classifies adds, sent adds and removals in record order", () => {
    expect(scanHistory(records, 25)).toEqual({
      inbox: ["msg0001", "msg0005", "msg0006"],
      sent: ["sent01"],
      removed: ["msg0002", "msg0003", "msg0004"],
      processed: 8,
      lastId: "2008",
    });
  });

  it("stops before the record that would exceed maxMessages", () => {
    expect(scanHistory(records, 2)).toMatchObject({
      inbox: ["msg0001", "msg0005"],
      processed: 7,
      lastId: "2007",
    });
  });

  it("always processes the first record", () => {
    const big = [
      {
        id: "3001",
        messagesAdded: ["a", "b", "c"].map((id) => ({ message: { id, threadId: id, labelIds: ["INBOX"] } })),
      },
    ];
    expect(scanHistory(big, 2)).toMatchObject({ inbox: ["a", "b"], processed: 1, lastId: "3001" });
  });
});

describe("Gmail cursors", () => {
  it("round-trips page and incremental cursors", () => {
    expect(pageTokenOf(pageCursor("p25") ?? "", "backfill")).toBe("p25");
    expect(pageCursor(null)).toBeNull();
    const state = { v: 1 as const, historyId: "42", catchupAfter: 1_760_000_000, catchupPageToken: null };
    expect(decodeIncremental(encodeIncremental(state))).toEqual(state);
  });

  it("rejects malformed cursors with CursorExpiredError", () => {
    expect(() => pageTokenOf('{"v":1}', "sent")).toThrow(CursorExpiredError);
    expect(() => decodeIncremental('{"v":1,"historyId":""}')).toThrow(CursorExpiredError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/google/map.test.ts`
Expected: FAIL, `../../../src/providers/google/map.ts` not found (`Error: Cannot find module ...`).

- [ ] **Step 4: Implement the mapping**

Create `packages/core/src/providers/google/map.ts`:

```ts
import { CursorExpiredError } from "../../model/errors.ts";
import type { MailCategory, MailMessage } from "../../model/mail.ts";
import { parseAddress } from "../../text/address.ts";
import { headerValue } from "../../text/headers.ts";
import { decodeEncodedWords } from "../../text/rfc2047.ts";
import { collapseWhitespace, decodeHtmlEntities, truncateChars } from "../../text/truncate.ts";
import { buildMailHeaders, headerValues, parseCursorJson, uniqueAddresses } from "../oauth.ts";
import type { IncrementalCursor, SentItem } from "../provider.ts";
import type { GmailHistoryRecord, GmailMessageMetadata } from "./types.ts";

export const GMAIL_API = "https://gmail.googleapis.com";

/** Exact metadataHeaders list (contracts 4.3.2), sent as repeated query parameters. */
export const GMAIL_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Delivered-To",
  "Subject",
  "Date",
  "Message-ID",
  "References",
  "In-Reply-To",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "Authentication-Results",
  "Return-Path",
  "Content-Type",
] as const;
export const GMAIL_METADATA_FIELDS =
  "id,threadId,labelIds,snippet,historyId,internalDate,payload(mimeType,headers)";
export const GMAIL_SENT_HEADERS = ["To", "Cc", "Bcc"] as const;
export const GMAIL_SENT_FIELDS = "id,threadId,internalDate,payload(headers)";

const SNIPPET_MAX_CHARS = 255;

function metadataPath(id: string, headers: readonly string[], fields: string): string {
  const query = new URLSearchParams({ format: "metadata" });
  for (const header of headers) query.append("metadataHeaders", header);
  query.set("fields", fields);
  return `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query.toString()}`;
}

/** Batch part path for inbox metadata. */
export function gmailMetadataPath(id: string): string {
  return metadataPath(id, GMAIL_METADATA_HEADERS, GMAIL_METADATA_FIELDS);
}

/** Batch part path for sent-message recipients. */
export function gmailSentMetadataPath(id: string): string {
  return metadataPath(id, GMAIL_SENT_HEADERS, GMAIL_SENT_FIELDS);
}

const CATEGORY_BY_LABEL: Readonly<Record<string, MailCategory>> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

export function gmailCategory(labels: readonly string[]): MailCategory | null {
  for (const label of labels) {
    const category = CATEGORY_BY_LABEL[label];
    if (category !== undefined) return category;
  }
  return null;
}

function receivedAtOf(meta: GmailMessageMetadata, date: string | null): number {
  const internal = Number(meta.internalDate);
  if (meta.internalDate !== undefined && Number.isFinite(internal)) return internal;
  const parsed = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function threadDepthOf(references: string | null, inReplyTo: string | null): number {
  const count = references === null ? 0 : (references.match(/<[^<>\s]+>/g) ?? []).length;
  if (count > 0) return count + 1;
  return inReplyTo === null ? 1 : 2;
}

/** GmailMessageMetadata (format=metadata) -> MailMessage (contracts 4.1). */
export function mapGmailMessage(meta: GmailMessageMetadata): MailMessage {
  const headers = meta.payload?.headers ?? [];
  const labels = meta.labelIds ?? [];
  const mimeType = (meta.payload?.mimeType ?? "").trim() || (headerValue(headers, "Content-Type") ?? "");
  return {
    providerMessageId: meta.id,
    threadId: meta.threadId === "" ? null : meta.threadId,
    internetMessageId: headerValue(headers, "Message-ID"),
    receivedAt: receivedAtOf(meta, headerValue(headers, "Date")),
    from: parseAddress(headerValue(headers, "From")),
    to: uniqueAddresses(headerValues(headers, "To")),
    cc: uniqueAddresses(headerValues(headers, "Cc")),
    deliveredTo: uniqueAddresses(headerValues(headers, "Delivered-To")),
    subject: decodeEncodedWords(headerValue(headers, "Subject") ?? "").trim(),
    snippet: truncateChars(collapseWhitespace(decodeHtmlEntities(meta.snippet ?? "")), SNIPPET_MAX_CHARS),
    isRead: !labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    providerImportant: labels.includes("IMPORTANT"),
    category: gmailCategory(labels),
    hasAttachments: mimeType.toLowerCase().startsWith("multipart/mixed"),
    attachmentsApprox: true,
    threadDepth: threadDepthOf(headerValue(headers, "References"), headerValue(headers, "In-Reply-To")),
    headers: buildMailHeaders(headers, "gmail"),
    webLink: null,
    labels: [...labels],
  };
}

/** Sent message metadata (To/Cc/Bcc) -> SentItem. */
export function mapGmailSentItem(meta: GmailMessageMetadata): SentItem {
  const headers = meta.payload?.headers ?? [];
  const sentAt = Number(meta.internalDate);
  return {
    threadId: meta.threadId === "" ? null : meta.threadId,
    recipients: uniqueAddresses([
      ...headerValues(headers, "To"),
      ...headerValues(headers, "Cc"),
      ...headerValues(headers, "Bcc"),
    ]),
    sentAt: Number.isFinite(sentAt) ? sentAt : 0,
  };
}

/** Gmail has no official deep link (research section 7); this opens the message in the right account. */
export function buildGmailDeepLink(email: string, providerMessageId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(providerMessageId)}`;
}

// ---- Cursors (contracts 4.3.1) ----

export interface IncrementalState {
  v: 1;
  historyId: string;
  catchupAfter: number | null;
  catchupPageToken: string | null;
}

export function pageTokenOf(cursor: string, kind: "backfill" | "sent"): string {
  const parsed = parseCursorJson(cursor, "gmail", kind);
  if (typeof parsed.pageToken !== "string" || parsed.pageToken === "") {
    throw new CursorExpiredError({ provider: "gmail", cursorKind: kind });
  }
  return parsed.pageToken;
}

export function pageCursor(pageToken: string | null): string | null {
  return pageToken === null ? null : JSON.stringify({ v: 1, pageToken });
}

export function decodeIncremental(cursor: string): IncrementalState {
  const parsed = parseCursorJson(cursor, "gmail", "incremental");
  if (typeof parsed.historyId !== "string" || parsed.historyId === "") {
    throw new CursorExpiredError({ provider: "gmail", cursorKind: "incremental" });
  }
  return {
    v: 1,
    historyId: parsed.historyId,
    catchupAfter: typeof parsed.catchupAfter === "number" ? parsed.catchupAfter : null,
    catchupPageToken: typeof parsed.catchupPageToken === "string" ? parsed.catchupPageToken : null,
  };
}

export function encodeIncremental(state: IncrementalState): IncrementalCursor {
  return JSON.stringify(state);
}

// ---- History (contracts 4.3.2 incremental rules) ----

export interface HistoryScan {
  inbox: string[];
  sent: string[];
  removed: string[];
  processed: number;
  lastId: string | null;
}

function countNew(seen: ReadonlySet<string>, ids: readonly string[]): number {
  return seen.size + ids.filter((id) => !seen.has(id)).length;
}

/** Walks records in order and stops before a record that would push inbox or sent adds past max. */
export function scanHistory(records: readonly GmailHistoryRecord[], max: number): HistoryScan {
  const inbox = new Set<string>();
  const sent = new Set<string>();
  const removed = new Set<string>();
  let processed = 0;
  let lastId: string | null = null;
  for (const record of records) {
    const addInbox: string[] = [];
    const addSent: string[] = [];
    const remove: string[] = [];
    for (const added of record.messagesAdded ?? []) {
      const labels = added.message.labelIds ?? [];
      if (labels.includes("INBOX")) addInbox.push(added.message.id);
      if (labels.includes("SENT")) addSent.push(added.message.id);
    }
    for (const change of record.labelsAdded ?? []) {
      if (change.labelIds.includes("INBOX")) addInbox.push(change.message.id);
      if (change.labelIds.includes("TRASH")) remove.push(change.message.id);
    }
    for (const change of record.labelsRemoved ?? []) {
      if (change.labelIds.includes("INBOX")) remove.push(change.message.id);
    }
    for (const deleted of record.messagesDeleted ?? []) remove.push(deleted.message.id);
    if (processed > 0 && (countNew(inbox, addInbox) > max || countNew(sent, addSent) > max)) break;
    // A single record above max (not seen in practice) keeps only the first max ids.
    for (const id of addInbox) if (inbox.size < max) inbox.add(id);
    for (const id of addSent) if (sent.size < max) sent.add(id);
    for (const id of remove) removed.add(id);
    processed++;
    lastId = record.id;
  }
  return { inbox: [...inbox], sent: [...sent], removed: [...removed], processed, lastId };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/google/map.test.ts`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/google packages/core/test/providers/google packages/core/test/fixtures/builders.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/google/map.ts packages/core/test/providers/google/map.test.ts \
  packages/core/test/fixtures/gmail/metadata-newsletter.json packages/core/test/fixtures/gmail/history-page.json \
  packages/core/test/fixtures/builders.ts
git commit -m "feat(core): map Gmail metadata to MailMessage with cursors and history scan"
```

---

### Task 7: Graph message mapping and incremental cursor

**Files:**
- Create: `packages/core/src/providers/microsoft/map.ts`
- Create: `packages/core/test/fixtures/graph/message-newsletter.json`
- Modify: `packages/core/test/fixtures/builders.ts` (one import, one appended function)
- Test: `packages/core/test/providers/microsoft/map.test.ts`

**Interfaces:**
- Consumes: Task 2 `buildMailHeaders`, `parseCursorJson`, `stringField`; Task 5 types; plan 01 `parseAddress`, `decodeEncodedWords`, `collapseWhitespace`, `truncateChars`, `CursorExpiredError`.
- Produces (`src/providers/microsoft/map.ts`):
  - `GRAPH_BASE = "https://graph.microsoft.com/v1.0"`, `IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"'`, `GRAPH_INBOX_SELECT`, `GRAPH_DELTA_INBOX_SELECT`, `GRAPH_SENT_DELTA_SELECT`, `GRAPH_SENT_LIST_SELECT`
  - `graphUrl(path: string, params?: Readonly<Record<string, string>>): string` (values percent-encoded with `%20`, never `+`)
  - `graphRecipients(...lists: (GraphRecipient[] | undefined)[]): string[]`, `conversationDepth(conversationIndex: string | undefined): number | null`
  - `mapGraphMessage(msg: GraphMessage): MailMessage`, `mapGraphSentItem(msg: GraphMessage): SentItem`
  - `interface IncrementalState { v: 1; inboxDeltaLink: string; sentDeltaLink: string; watermark: string }`, `decodeIncremental(cursor: string): IncrementalState`
- Produces (tests): `makeGraphMessage(overrides?: Partial<GraphMessage>): GraphMessage`.

- [ ] **Step 1: Add the fixture and builder**

Create `packages/core/test/fixtures/graph/message-newsletter.json` (includes an X.500 recipient that must be dropped and two `Authentication-Results`, of which Microsoft's first one is trusted):

```json
{
  "@odata.etag": "W/\"CQAAABYAAAFake\"",
  "id": "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AFake-Newsletter-01",
  "conversationId": "AAQkAGI2Fake-Conv-01",
  "conversationIndex": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  "internetMessageId": "<abc123@mail.shop.example.com>",
  "receivedDateTime": "2026-10-14T21:03:11Z",
  "subject": "Big sale",
  "bodyPreview": "Our biggest sale\r\n\r\nof the year starts now",
  "isRead": false,
  "importance": "high",
  "hasAttachments": true,
  "inferenceClassification": "focused",
  "webLink": "https://outlook.office365.com/owa/?ItemID=AAkALgFake&exvsurl=1&viewmodel=ReadMessageItem",
  "flag": { "flagStatus": "flagged" },
  "from": { "emailAddress": { "name": "Shop", "address": "News@Shop.Example.com" } },
  "toRecipients": [
    { "emailAddress": { "name": "Owner", "address": "owner@example.test" } },
    {
      "emailAddress": {
        "name": "Exchange user",
        "address": "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=FAKE"
      }
    }
  ],
  "ccRecipients": [{ "emailAddress": { "name": "Team", "address": "team@example.org" } }],
  "internetMessageHeaders": [
    { "name": "List-Unsubscribe", "value": "<https://shop.example.com/u/abc>" },
    {
      "name": "Authentication-Results",
      "value": "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=esp.example.net; dkim=pass (signature was verified) header.d=shop.example.com;dmarc=pass action=none header.from=shop.example.com;compauth=pass reason=100"
    },
    { "name": "Authentication-Results", "value": "spf=fail smtp.mailfrom=other.example.net" },
    { "name": "Return-Path", "value": "bounce@esp.example.net" }
  ]
}
```

In `packages/core/test/fixtures/builders.ts`, add next to the other type imports:

```ts
import type { GraphMessage } from "../../src/providers/microsoft/types.ts";
```

and append to the end of the file:

```ts
/** Minimal Graph inbox message from a synthetic sender. */
export function makeGraphMessage(overrides: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0Fake0001",
    conversationId: "AAQkAGI2Fake0001",
    conversationIndex: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
    internetMessageId: "<0001@mail.example.com>",
    receivedDateTime: "2026-10-05T08:00:00Z",
    subject: "Synthetic subject",
    bodyPreview: "Synthetic preview",
    isRead: false,
    importance: "normal",
    hasAttachments: false,
    inferenceClassification: "other",
    flag: { flagStatus: "notFlagged" },
    from: { emailAddress: { name: "Example Sender", address: "sender@example.com" } },
    toRecipients: [{ emailAddress: { name: "Owner", address: "owner@example.test" } }],
    ccRecipients: [],
    webLink: "https://outlook.office365.com/owa/?ItemID=Fake0001&exvsurl=1&viewmodel=ReadMessageItem",
    internetMessageHeaders: [],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/providers/microsoft/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CursorExpiredError } from "../../../src/model/errors.ts";
import {
  GRAPH_DELTA_INBOX_SELECT,
  GRAPH_INBOX_SELECT,
  conversationDepth,
  decodeIncremental,
  graphRecipients,
  graphUrl,
  mapGraphMessage,
  mapGraphSentItem,
} from "../../../src/providers/microsoft/map.ts";
import type { GraphMessage } from "../../../src/providers/microsoft/types.ts";
import { makeGraphMessage } from "../../fixtures/builders.ts";
import newsletter from "../../fixtures/graph/message-newsletter.json" with { type: "json" };

describe("mapGraphMessage", () => {
  it("normalizes the newsletter fixture", () => {
    const msg = mapGraphMessage(newsletter as GraphMessage);
    expect(msg).toMatchObject({
      providerMessageId: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AFake-Newsletter-01",
      threadId: "AAQkAGI2Fake-Conv-01",
      internetMessageId: "<abc123@mail.shop.example.com>",
      receivedAt: Date.UTC(2026, 9, 14, 21, 3, 11),
      from: { address: "news@shop.example.com", name: "Shop" },
      to: ["owner@example.test"],
      cc: ["team@example.org"],
      deliveredTo: [],
      subject: "Big sale",
      snippet: "Our biggest sale of the year starts now",
      isRead: false,
      starred: true,
      providerImportant: true,
      category: "focused",
      hasAttachments: true,
      attachmentsApprox: false,
      threadDepth: 3,
      webLink: "https://outlook.office365.com/owa/?ItemID=AAkALgFake&exvsurl=1&viewmodel=ReadMessageItem",
      labels: [],
    });
    expect(msg.headers.listUnsubscribe).toBe("<https://shop.example.com/u/abc>");
    expect(msg.headers.authenticationResults).toContain("compauth=pass");
    expect(msg.headers.returnPath).toBe("bounce@esp.example.net");
  });

  it("keeps the case-sensitive immutable id verbatim", () => {
    expect(mapGraphMessage(makeGraphMessage({ id: "AAkALg-Mixed-CASE-id" })).providerMessageId).toBe(
      "AAkALg-Mixed-CASE-id",
    );
  });

  it("handles missing optional fields", () => {
    const msg = mapGraphMessage({ id: "AAkALg-min" });
    expect(msg).toMatchObject({
      threadId: null,
      receivedAt: 0,
      from: { address: null, name: null },
      subject: "",
      snippet: "",
      isRead: false,
      starred: false,
      category: null,
      threadDepth: null,
      webLink: null,
    });
    expect(msg.headers.authenticationResults).toBeNull();
  });

  it("decodes an encoded display name and subject defensively", () => {
    const msg = mapGraphMessage(
      makeGraphMessage({
        subject: "=?UTF-8?B?Q2Fmw6kgbmV3cw==?=",
        from: { emailAddress: { name: "=?ISO-8859-1?Q?Gr=FC=DFe?=", address: "greet@example.org" } },
      }),
    );
    expect(msg.subject).toBe("Café news");
    expect(msg.from.name).toBe("Grüße");
  });
});

describe("mapGraphSentItem", () => {
  it("uses To + Cc + Bcc and sentDateTime", () => {
    const item = mapGraphSentItem(
      makeGraphMessage({
        conversationId: "conv-1",
        sentDateTime: "2026-10-01T10:00:00Z",
        toRecipients: [{ emailAddress: { address: "A@Example.com" } }],
        ccRecipients: [{ emailAddress: { address: "a@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "b@example.org" } }],
      }),
    );
    expect(item).toEqual({
      threadId: "conv-1",
      recipients: ["a@example.com", "b@example.org"],
      sentAt: Date.UTC(2026, 9, 1, 10),
    });
  });
});

describe("conversationDepth", () => {
  it("computes (bytes - 22) / 5 + 1", () => {
    expect(conversationDepth("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==")).toBe(1);
    expect(conversationDepth("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")).toBe(3);
  });
  it("returns null for missing, short or malformed values", () => {
    expect(conversationDepth(undefined)).toBeNull();
    expect(conversationDepth("AQEBAQEBAQEBAQ==")).toBeNull();
    expect(conversationDepth("***")).toBeNull();
  });
});

describe("graphRecipients", () => {
  it("drops non-SMTP addresses", () => {
    expect(
      graphRecipients([{ emailAddress: { address: "/O=EXCHANGELABS/CN=X" } }, { emailAddress: {} }]),
    ).toEqual([]);
  });
});

describe("graphUrl and selects", () => {
  it("encodes values with %20 and keeps $ keys", () => {
    expect(
      graphUrl("/me/mailFolders/inbox/messages", { $filter: "receivedDateTime le 2026-10-01T00:00:00Z" }),
    ).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime%20le%202026-10-01T00%3A00%3A00Z",
    );
  });
  it("delta select is the inbox select without internetMessageHeaders", () => {
    expect(GRAPH_INBOX_SELECT.endsWith(",webLink,internetMessageHeaders")).toBe(true);
    expect(GRAPH_DELTA_INBOX_SELECT.includes("internetMessageHeaders")).toBe(false);
    expect(GRAPH_DELTA_INBOX_SELECT.includes("conversationIndex")).toBe(true);
  });
});

describe("decodeIncremental", () => {
  it("reads the Graph incremental cursor and rejects incomplete ones", () => {
    const state = {
      v: 1,
      inboxDeltaLink: "https://graph.microsoft.com/a",
      sentDeltaLink: "https://graph.microsoft.com/b",
      watermark: "2026-10-15T12:00:00.000Z",
    };
    expect(decodeIncremental(JSON.stringify(state))).toEqual(state);
    expect(() => decodeIncremental(JSON.stringify({ ...state, sentDeltaLink: "" }))).toThrow(
      CursorExpiredError,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/microsoft/map.test.ts`
Expected: FAIL, `../../../src/providers/microsoft/map.ts` not found (`Error: Cannot find module ...`).

- [ ] **Step 4: Implement the mapping**

Create `packages/core/src/providers/microsoft/map.ts`:

```ts
import type { MailAddress, MailCategory, MailMessage } from "../../model/mail.ts";
import { parseAddress } from "../../text/address.ts";
import { decodeEncodedWords } from "../../text/rfc2047.ts";
import { collapseWhitespace, truncateChars } from "../../text/truncate.ts";
import { CursorExpiredError } from "../../model/errors.ts";
import { buildMailHeaders, parseCursorJson, stringField } from "../oauth.ts";
import type { SentItem } from "../provider.ts";
import type { GraphMessage, GraphRecipient } from "./types.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Every Graph request and $batch sub-request carries this Prefer value (ids survive moves). */
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Inbox $select (contracts 4.3.2). */
export const GRAPH_INBOX_SELECT =
  "id,conversationId,conversationIndex,internetMessageId,from,toRecipients,ccRecipients,subject,bodyPreview," +
  "receivedDateTime,isRead,flag,importance,hasAttachments,inferenceClassification,webLink,internetMessageHeaders";
/** Delta $select: the inbox select without internetMessageHeaders. */
export const GRAPH_DELTA_INBOX_SELECT = GRAPH_INBOX_SELECT.replace(",internetMessageHeaders", "");
export const GRAPH_SENT_DELTA_SELECT =
  "id,conversationId,toRecipients,ccRecipients,bccRecipients,receivedDateTime";
export const GRAPH_SENT_LIST_SELECT = "conversationId,toRecipients,ccRecipients,bccRecipients,sentDateTime";

const SNIPPET_MAX_CHARS = 255;

/** Builds a Graph URL; values are percent-encoded (spaces as %20, never "+"), keys like $select stay literal. */
export function graphUrl(path: string, params: Readonly<Record<string, string>> = {}): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return query === "" ? `${GRAPH_BASE}${path}` : `${GRAPH_BASE}${path}?${query}`;
}

function toAddress(recipient: GraphRecipient | undefined): MailAddress {
  const raw = recipient?.emailAddress.address ?? null;
  const name = recipient?.emailAddress.name ?? null;
  const decoded = name === null ? "" : collapseWhitespace(decodeEncodedWords(name));
  return { address: raw === null ? null : parseAddress(raw).address, name: decoded === "" ? null : decoded };
}

/** Lowercased, de-duplicated addresses; unparseable (for example X.500) entries are dropped. */
export function graphRecipients(...lists: (GraphRecipient[] | undefined)[]): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    for (const recipient of list ?? []) {
      const { address } = toAddress(recipient);
      if (address !== null) out.add(address);
    }
  }
  return [...out];
}

/** (bytes - 22) / 5 + 1 from the base64 conversationIndex; null when missing or malformed. */
export function conversationDepth(conversationIndex: string | undefined): number | null {
  if (conversationIndex === undefined || conversationIndex === "") return null;
  let length: number;
  try {
    length = atob(conversationIndex).length;
  } catch {
    return null;
  }
  return length < 22 ? null : Math.floor((length - 22) / 5) + 1;
}

function graphCategory(value: GraphMessage["inferenceClassification"]): MailCategory | null {
  return value === "focused" || value === "other" ? value : null;
}

function epochOf(iso: string | undefined): number {
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** GraphMessage -> MailMessage. Headers come from internetMessageHeaders ([] when absent). */
export function mapGraphMessage(msg: GraphMessage): MailMessage {
  return {
    providerMessageId: msg.id,
    threadId: msg.conversationId ?? null,
    internetMessageId: msg.internetMessageId ?? null,
    receivedAt: epochOf(msg.receivedDateTime),
    from: toAddress(msg.from),
    to: graphRecipients(msg.toRecipients),
    cc: graphRecipients(msg.ccRecipients),
    deliveredTo: [],
    subject: decodeEncodedWords(msg.subject ?? "").trim(),
    snippet: truncateChars(collapseWhitespace(msg.bodyPreview ?? ""), SNIPPET_MAX_CHARS),
    isRead: msg.isRead ?? false,
    starred: msg.flag?.flagStatus === "flagged",
    providerImportant: msg.importance === "high",
    category: graphCategory(msg.inferenceClassification),
    hasAttachments: msg.hasAttachments ?? false,
    attachmentsApprox: false,
    threadDepth: conversationDepth(msg.conversationIndex),
    headers: buildMailHeaders(msg.internetMessageHeaders ?? [], "outlook"),
    webLink: msg.webLink ?? null,
    labels: [],
  };
}

/** Sent Items message -> SentItem (sentDateTime for lists, receivedDateTime for delta). */
export function mapGraphSentItem(msg: GraphMessage): SentItem {
  return {
    threadId: msg.conversationId ?? null,
    recipients: graphRecipients(msg.toRecipients, msg.ccRecipients, msg.bccRecipients),
    sentAt: epochOf(msg.sentDateTime ?? msg.receivedDateTime),
  };
}

// ---- Incremental cursor (contracts 4.3.1) ----

export interface IncrementalState {
  v: 1;
  inboxDeltaLink: string;
  sentDeltaLink: string;
  watermark: string;
}

export function decodeIncremental(cursor: string): IncrementalState {
  const parsed = parseCursorJson(cursor, "outlook", "incremental");
  const inbox = stringField(parsed, "inboxDeltaLink");
  const sent = stringField(parsed, "sentDeltaLink");
  const watermark = stringField(parsed, "watermark");
  if (inbox === null || sent === null || watermark === null) {
    throw new CursorExpiredError({ provider: "outlook", cursorKind: "incremental" });
  }
  return { v: 1, inboxDeltaLink: inbox, sentDeltaLink: sent, watermark };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/microsoft/map.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/microsoft packages/core/test/providers/microsoft packages/core/test/fixtures/builders.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/microsoft/map.ts packages/core/test/providers/microsoft/map.test.ts \
  packages/core/test/fixtures/graph/message-newsletter.json packages/core/test/fixtures/builders.ts
git commit -m "feat(core): map Graph messages to MailMessage and decode the delta cursor"
```

---

### Task 8: FakeMailbox, Gmail fake and the Gmail provider read path

**Files:**
- Create: `packages/core/test/msw/fake-mailbox.ts`
- Create: `packages/core/test/msw/gmail.ts`
- Create: `packages/core/src/providers/google/gmail.ts` (read path; sync and actions are stubs replaced in Tasks 9 and 10)
- Test: `packages/core/test/providers/gmail.test.ts`

**Interfaces:**
- Consumes: Task 1 `buildBatchBody`, `parseBatchResponse`; Task 2 `bestEffortCount`, `chunkIds`, `isJsonObject`, `readJsonBody`, `sendGuarded`; Task 3 `inboxEstimate` member; Task 4 `classifyGmailApiError`, `classifyPart`; Task 6 map functions and cursor codecs; plan 01 `ProviderDeps`, `MailProvider`, `TokenSource`, `backoffMs`, error classes.
- Produces:
  - `createGmailProvider(deps: ProviderDeps): MailProvider` (contracts 4.3). After this task `bootstrap`, `inboxEstimate`, `listInboxPage`, `listSentPage` work; the other members reject with `ClearboxError("not_implemented")` until Tasks 9 and 10.
  - Bootstrap request order: `GET /profile` (historyId taken before any backfill), then `GET /settings/sendAs`. `inboxEstimate()` is `GET /labels/INBOX` (`messagesTotal`).
  - Test fakes (`test/msw/fake-mailbox.ts`): `FAKE_OWNER`, `type FakeFolder = "inbox" | "archive" | "trash" | "sent"`, `interface FakeMessage`, `interface FakeChange`, `class FakeMailbox` (`addMessage(overrides?)`, `move(id, to | null)`, `expireCursors()`, `inFolder(folder)`, `failNext(rule)`, `track(label, run)`, fields `requests`, `preferHeaders`, `messages`, `changes`, `seq`, `minValidSeq`, `validAccessToken`, `aliases`, `graphMail`, `graphUserId`, `archiveFolderId`, `archiveFolder`, `untrashRestoresInbox`, `deltaExpiredStatus`, `inFlight`, `maxInFlight`), `class FakeTokenSource implements TokenSource` (`current`, `refreshes`, `refreshError`), `defaultErrorBody(status)`.
  - `gmailHandlers(box: FakeMailbox)` (`test/msw/gmail.ts`), `gmailDispatch(box, method, url, body)`, `gmailLabels(message, folder?)`. Batch requests log `POST /batch/gmail/v1` plus one `part:<METHOD> <path>` entry per part; an invalid token makes every part `401` with an outer `200` (observed Gmail behavior).

- [ ] **Step 1: Add the in-memory mailbox**

Create `packages/core/test/msw/fake-mailbox.ts`:

```ts
import type { TokenSource } from "../../src/providers/token.ts";
import { FailureQueue, type FailRule } from "./failures.ts";

export type { FailRule } from "./failures.ts";

export type FakeFolder = "inbox" | "archive" | "trash" | "sent";
export type GmailCategoryLabel =
  "CATEGORY_PERSONAL" | "CATEGORY_PROMOTIONS" | "CATEGORY_SOCIAL" | "CATEGORY_UPDATES" | "CATEGORY_FORUMS";

export interface FakeHeader {
  name: string;
  value: string;
}

/** Provider-neutral synthetic message; gmail.ts and graph.ts render it in each provider's wire shape. */
export interface FakeMessage {
  /** Gmail message id or Graph immutable id (case-sensitive, unchanged by moves). */
  id: string;
  threadId: string;
  folder: FakeFolder;
  receivedAt: number;
  fromName: string | null;
  fromAddress: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  snippet: string;
  isRead: boolean;
  starred: boolean;
  important: boolean;
  category: GmailCategoryLabel | null;
  inference: "focused" | "other";
  mimeType: string;
  hasAttachments: boolean;
  /** Extra raw headers (List-Unsubscribe, Authentication-Results, ...). */
  headers: FakeHeader[];
  /** Graph: when false, list responses omit internetMessageHeaders, forcing the $batch fallback. */
  headersOnList: boolean;
}

/** One change-log entry; drives Gmail history records and Graph delta rounds. */
export interface FakeChange {
  seq: number;
  id: string;
  from: FakeFolder | null;
  to: FakeFolder | null;
}

export const FAKE_OWNER = "owner@example.test";
const BASE_TIME = Date.UTC(2026, 9, 1);

/** In-memory mailbox shared by the Gmail and Graph MSW handlers (contracts 10.3). */
export class FakeMailbox {
  readonly owner = FAKE_OWNER;
  readonly failures = new FailureQueue();
  /** Every top-level request ("GET /gmail/v1/...") and batch part ("part:GET /gmail/v1/...") in order. */
  readonly requests: string[] = [];
  /** Prefer header of every Graph request and sub-request. */
  readonly preferHeaders: string[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly changes: FakeChange[] = [];
  aliases: string[] = ["Alias@Example.test"];
  validAccessToken = "at-valid";
  /** Graph /me mail; null exercises the userPrincipalName fallback. */
  graphMail: string | null = "Owner@Example.test";
  graphUserId = "graph-user-0001";
  archiveFolderId = "folder-archive-0001";
  /** "missing": GET archive 404 then POST creates it; "uncreatable": GET 404 and POST 403. */
  archiveFolder: "present" | "missing" | "uncreatable" = "present";
  /** Gmail untrash: false (default) leaves the message without INBOX, exercising the INBOX re-add. */
  untrashRestoresInbox = false;
  /** Status for an expired Graph delta token: 400 syncStateNotFound or 410 Gone. */
  deltaExpiredStatus: 400 | 410 = 400;
  seq = 0;
  /** Cursors (history ids, delta tokens) older than this sequence number are rejected. */
  minValidSeq = 0;
  inFlight = 0;
  maxInFlight = 0;
  private nextNumber = 1;

  failNext(rule: FailRule): void {
    this.failures.add(rule);
  }

  addMessage(overrides: Partial<FakeMessage> = {}): FakeMessage {
    const n = this.nextNumber++;
    const tag = String(n).padStart(4, "0");
    const message: FakeMessage = {
      id: `msg${tag}`,
      threadId: `thr${tag}`,
      folder: "inbox",
      receivedAt: BASE_TIME + n * 60_000,
      fromName: `Sender ${tag}`,
      fromAddress: `sender${tag}@shop.example.com`,
      to: [FAKE_OWNER],
      cc: [],
      bcc: [],
      subject: `Synthetic subject ${tag}`,
      snippet: `Synthetic snippet ${tag}`,
      isRead: false,
      starred: false,
      important: false,
      category: "CATEGORY_PROMOTIONS",
      inference: "other",
      mimeType: "multipart/alternative",
      hasAttachments: false,
      headers: [{ name: "List-Unsubscribe", value: `<https://shop.example.com/u/${tag}>` }],
      headersOnList: true,
      ...overrides,
    };
    this.messages.set(message.id, message);
    this.record(message.id, null, message.folder);
    return message;
  }

  /** Moves a message (to = null deletes it permanently) and records the change. */
  move(id: string, to: FakeFolder | null): void {
    const message = this.messages.get(id);
    if (message === undefined || message.folder === to) return;
    const from = message.folder;
    if (to === null) this.messages.delete(id);
    else message.folder = to;
    this.record(id, from, to);
  }

  /** Invalidates every cursor taken before the current position (history 404, delta syncStateNotFound / 410). */
  expireCursors(): void {
    this.minValidSeq = this.seq;
  }

  inFolder(folder: FakeFolder): FakeMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.folder === folder)
      .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? -1 : 1));
  }

  /** Wraps a handler: logs the request and tracks concurrency (the providers must never overlap requests). */
  async track<T>(label: string, run: () => Promise<T>): Promise<T> {
    this.requests.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await run();
    } finally {
      this.inFlight--;
    }
  }

  private record(id: string, from: FakeFolder | null, to: FakeFolder | null): void {
    this.seq++;
    this.changes.push({ seq: this.seq, id, from, to });
  }
}

/** TokenSource for provider tests: forceRefresh() switches to the mailbox's valid token. */
export class FakeTokenSource implements TokenSource {
  current: string;
  refreshes = 0;
  refreshError: Error | null = null;
  private readonly mailbox: { validAccessToken: string };

  constructor(mailbox: { validAccessToken: string }, current?: string) {
    this.mailbox = mailbox;
    this.current = current ?? mailbox.validAccessToken;
  }

  async getAccessToken(): Promise<string> {
    return this.current;
  }

  async forceRefresh(): Promise<string> {
    this.refreshes++;
    if (this.refreshError !== null) throw this.refreshError;
    this.current = this.mailbox.validAccessToken;
    return this.current;
  }
}

/** JSON body used for injected failures without an explicit body. */
export function defaultErrorBody(status: number): unknown {
  return { error: { code: status, message: "Injected failure", errors: [{ reason: "injected" }] } };
}
```

- [ ] **Step 2: Add the Gmail fake (REST and multipart batch)**

Create `packages/core/test/msw/gmail.ts`:

```ts
import { http, HttpResponse } from "msw";
import {
  defaultErrorBody,
  type FakeChange,
  type FakeFolder,
  type FakeMailbox,
  type FakeMessage,
} from "./fake-mailbox.ts";

const API = "https://gmail.googleapis.com";
const RESPONSE_BOUNDARY = "batch_fake_response_7f3a";
const HISTORY_BASE = 1000;

interface FakeResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

function folderLabel(folder: FakeFolder | null): string | null {
  if (folder === "inbox") return "INBOX";
  if (folder === "trash") return "TRASH";
  if (folder === "sent") return "SENT";
  return null;
}

export function gmailLabels(message: FakeMessage, folder: FakeFolder = message.folder): string[] {
  const labels: string[] = [];
  const label = folderLabel(folder);
  if (label !== null) labels.push(label);
  if (!message.isRead) labels.push("UNREAD");
  if (message.starred) labels.push("STARRED");
  if (message.important) labels.push("IMPORTANT");
  if (message.category !== null && folder !== "sent") labels.push(message.category);
  return labels;
}

function rawHeaders(message: FakeMessage): { name: string; value: string }[] {
  const headers = [
    {
      name: "From",
      value:
        message.fromName === null ? message.fromAddress : `"${message.fromName}" <${message.fromAddress}>`,
    },
    { name: "To", value: message.to.join(", ") },
    { name: "Subject", value: message.subject },
    { name: "Date", value: new Date(message.receivedAt).toUTCString() },
    { name: "Message-ID", value: `<${message.id}@mail.example.com>` },
    { name: "Content-Type", value: `${message.mimeType}; boundary="fake"` },
  ];
  if (message.cc.length > 0) headers.push({ name: "Cc", value: message.cc.join(", ") });
  if (message.bcc.length > 0) headers.push({ name: "Bcc", value: message.bcc.join(", ") });
  return [...headers, ...message.headers];
}

function metadata(box: FakeMailbox, message: FakeMessage, url: URL): Record<string, unknown> {
  const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
  const headers = rawHeaders(message).filter(
    (h) => wanted.length === 0 || wanted.includes(h.name.toLowerCase()),
  );
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: gmailLabels(message),
    snippet: message.snippet,
    historyId: String(HISTORY_BASE + box.seq),
    internalDate: String(message.receivedAt),
    payload: { mimeType: message.mimeType, headers },
  };
}

function apiError(status: number, reason: string, message: string): FakeResult {
  return { status, body: { error: { code: status, message, errors: [{ reason, message }] } } };
}

function historyRecord(box: FakeMailbox, change: FakeChange): Record<string, unknown> {
  const message = box.messages.get(change.id);
  const ref = { id: change.id, threadId: message?.threadId ?? change.id };
  const record: Record<string, unknown> = { id: String(HISTORY_BASE + change.seq) };
  if (change.from === null) {
    const labels =
      message === undefined
        ? [folderLabel(change.to)].filter((l) => l !== null)
        : gmailLabels(message, change.to ?? "archive");
    record.messagesAdded = [{ message: { ...ref, labelIds: labels } }];
    return record;
  }
  if (change.to === null) {
    record.messagesDeleted = [{ message: ref }];
    return record;
  }
  const before = folderLabel(change.from);
  const after = folderLabel(change.to);
  if (after !== null) record.labelsAdded = [{ message: ref, labelIds: [after] }];
  if (before !== null) record.labelsRemoved = [{ message: ref, labelIds: [before] }];
  return record;
}

function list(box: FakeMailbox, url: URL): FakeResult {
  const label = url.searchParams.get("labelIds");
  const folder: FakeFolder | null = label === "INBOX" ? "inbox" : label === "SENT" ? "sent" : null;
  if (folder === null) return apiError(400, "badRequest", "Unsupported labelIds in fake");
  const after = /^after:(\d+)$/.exec(url.searchParams.get("q") ?? "");
  const pageToken = url.searchParams.get("pageToken");
  if (pageToken !== null && !/^p\d+$/.test(pageToken))
    return apiError(400, "invalidArgument", "Invalid pageToken");
  const offset = pageToken === null ? 0 : Number(pageToken.slice(1));
  const max = Number(url.searchParams.get("maxResults") ?? "100");
  const all = box.inFolder(folder).filter((m) => after === null || m.receivedAt > Number(after[1]) * 1000);
  const page = all.slice(offset, offset + max);
  const body: Record<string, unknown> = { resultSizeEstimate: all.length };
  if (page.length > 0) body.messages = page.map((m) => ({ id: m.id, threadId: m.threadId }));
  if (offset + max < all.length) body.nextPageToken = `p${String(offset + max)}`;
  return { status: 200, body };
}

function history(box: FakeMailbox, url: URL): FakeResult {
  const start = Number(url.searchParams.get("startHistoryId")) - HISTORY_BASE;
  if (!Number.isFinite(start) || start < box.minValidSeq)
    return apiError(404, "notFound", "Requested entity was not found.");
  const pageToken = url.searchParams.get("pageToken");
  const from = pageToken === null ? start : Number(pageToken.slice(1));
  const max = Number(url.searchParams.get("maxResults") ?? "100");
  const pending = box.changes.filter((c) => c.seq > from);
  const page = pending.slice(0, max);
  const body: Record<string, unknown> = { historyId: String(HISTORY_BASE + box.seq) };
  if (page.length > 0) body.history = page.map((c) => historyRecord(box, c));
  const last = page[page.length - 1];
  if (pending.length > max && last !== undefined) body.nextPageToken = `h${String(last.seq)}`;
  return { status: 200, body };
}

function applyLabels(box: FakeMailbox, message: FakeMessage, add: string[], remove: string[]): void {
  if (add.includes("INBOX")) box.move(message.id, "inbox");
  else if (remove.includes("INBOX") && message.folder === "inbox") box.move(message.id, "archive");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Routes one Gmail REST call (top-level or batch part) against the fake mailbox. */
export function gmailDispatch(box: FakeMailbox, method: string, url: URL, body: unknown): FakeResult {
  const fail = box.failures.take(method, url.pathname);
  if (fail)
    return {
      status: fail.status,
      body: fail.body ?? defaultErrorBody(fail.status),
      headers: fail.headers ?? {},
    };
  const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (method === "GET" && path === "/profile") {
    return {
      status: 200,
      body: {
        emailAddress: "Owner@Example.test",
        messagesTotal: box.messages.size,
        threadsTotal: box.messages.size,
        historyId: String(HISTORY_BASE + box.seq),
      },
    };
  }
  if (method === "GET" && path === "/settings/sendAs") {
    return {
      status: 200,
      body: {
        sendAs: [
          { sendAsEmail: "Owner@Example.test", isPrimary: true },
          ...box.aliases.map((a) => ({ sendAsEmail: a })),
        ],
      },
    };
  }
  if (method === "GET" && path === "/labels/INBOX") {
    const inbox = box.inFolder("inbox");
    return {
      status: 200,
      body: {
        id: "INBOX",
        name: "INBOX",
        type: "system",
        messagesTotal: inbox.length,
        messagesUnread: inbox.filter((m) => !m.isRead).length,
      },
    };
  }
  if (method === "GET" && path === "/messages") return list(box, url);
  if (method === "GET" && path === "/history") return history(box, url);
  if (method === "POST" && path === "/messages/batchModify") {
    const ids = stringArray(record.ids);
    if (ids.some((id) => !box.messages.has(id))) return apiError(400, "invalidArgument", "Invalid id value");
    for (const id of ids) {
      const message = box.messages.get(id);
      if (message !== undefined)
        applyLabels(box, message, stringArray(record.addLabelIds), stringArray(record.removeLabelIds));
    }
    return { status: 204, body: null };
  }
  const single = /^\/messages\/([^/]+)(?:\/(trash|untrash|modify))?$/.exec(path);
  if (single !== null) {
    const message = box.messages.get(decodeURIComponent(single[1] ?? ""));
    if (message === undefined) return apiError(404, "notFound", "Requested entity was not found.");
    const verb = single[2];
    if (method === "GET" && verb === undefined) return { status: 200, body: metadata(box, message, url) };
    if (method === "POST" && verb === "trash") box.move(message.id, "trash");
    else if (method === "POST" && verb === "untrash")
      box.move(message.id, box.untrashRestoresInbox ? "inbox" : "archive");
    else if (method === "POST" && verb === "modify")
      applyLabels(box, message, stringArray(record.addLabelIds), stringArray(record.removeLabelIds));
    else return apiError(400, "badRequest", "Unsupported method in fake");
    return {
      status: 200,
      body: { id: message.id, threadId: message.threadId, labelIds: gmailLabels(message) },
    };
  }
  return apiError(400, "badRequest", `Unsupported path in fake: ${path}`);
}

interface BatchRequestPart {
  contentId: string;
  method: string;
  path: string;
  body: unknown;
}

function parseBatchRequest(text: string, boundary: string): BatchRequestPart[] {
  const parts: BatchRequestPart[] = [];
  for (const segment of text.replace(/\r\n/g, "\n").split(`--${boundary}`).slice(1)) {
    if (segment.startsWith("--")) break;
    const [outer = "", ...rest] = segment.replace(/^\n/, "").split("\n\n");
    const contentId = /content-id:\s*<([^>]+)>/i.exec(outer)?.[1] ?? "";
    const request = rest.join("\n\n");
    const [head = "", ...bodyParts] = request.split("\n\n");
    const line = /^(GET|POST)\s+(\S+)/.exec(head.trim());
    if (line === null) continue;
    const bodyText = bodyParts.join("\n\n").trim();
    parts.push({
      contentId,
      method: line[1] ?? "GET",
      path: line[2] ?? "/",
      body: bodyText === "" ? null : (JSON.parse(bodyText) as unknown),
    });
  }
  return parts;
}

function renderBatch(results: { contentId: string; result: FakeResult }[]): string {
  let out = "";
  for (const { contentId, result } of results) {
    out += `--${RESPONSE_BOUNDARY}\r\nContent-Type: application/http\r\nContent-ID: <response-${contentId}>\r\n\r\n`;
    out += `HTTP/1.1 ${String(result.status)} ${STATUS_TEXT[result.status] ?? "Status"}\r\n`;
    out += "Content-Type: application/json; charset=UTF-8\r\n";
    for (const [name, value] of Object.entries(result.headers ?? {})) out += `${name}: ${value}\r\n`;
    out += `\r\n${result.body === null ? "" : JSON.stringify(result.body)}\r\n`;
  }
  return `${out}--${RESPONSE_BOUNDARY}--\r\n`;
}

function isAuthorized(request: Request, box: FakeMailbox): boolean {
  return request.headers.get("authorization") === `Bearer ${box.validAccessToken}`;
}

function toResponse(result: FakeResult): Response {
  if (result.body === null)
    return new HttpResponse(null, { status: result.status, headers: result.headers ?? {} });
  return HttpResponse.json(result.body, { status: result.status, headers: result.headers ?? {} });
}

/** MSW handlers for gmail.googleapis.com over a FakeMailbox (REST + multipart batch). */
export function gmailHandlers(box: FakeMailbox) {
  return [
    http.post(`${API}/batch/gmail/v1`, ({ request }) =>
      box.track("POST /batch/gmail/v1", async () => {
        const outer = box.failures.take("POST", "/batch/gmail/v1");
        if (outer)
          return toResponse({
            status: outer.status,
            body: outer.body ?? defaultErrorBody(outer.status),
            headers: outer.headers ?? {},
          });
        if (request.headers.get("authorization") === null)
          return toResponse(apiError(401, "required", "Login Required."));
        const boundary = /boundary=([^;\s]+)/.exec(request.headers.get("content-type") ?? "")?.[1];
        if (boundary === undefined) return toResponse(apiError(400, "badRequest", "Missing boundary"));
        const authorized = isAuthorized(request, box);
        const results = parseBatchRequest(await request.text(), boundary).map((part) => {
          const url = new URL(part.path, API);
          box.requests.push(`part:${part.method} ${url.pathname}`);
          // Observed behavior: an expired token yields outer 200 with every part 401.
          const result = authorized
            ? gmailDispatch(box, part.method, url, part.body)
            : apiError(401, "authError", "Invalid Credentials");
          return { contentId: part.contentId, result };
        });
        return new HttpResponse(renderBatch(results), {
          status: 200,
          headers: { "content-type": `multipart/mixed; boundary=${RESPONSE_BOUNDARY}` },
        });
      }),
    ),
    http.all(`${API}/gmail/v1/*`, ({ request }) =>
      box.track(`${request.method} ${new URL(request.url).pathname}`, async () => {
        if (!isAuthorized(request, box)) return toResponse(apiError(401, "authError", "Invalid Credentials"));
        const text = await request.text();
        return toResponse(
          gmailDispatch(
            box,
            request.method,
            new URL(request.url),
            text === "" ? null : (JSON.parse(text) as unknown),
          ),
        );
      }),
    ),
    http.all(`${API}/*`, ({ request }) => {
      const url = new URL(request.url);
      throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
    }),
  ];
}
```

- [ ] **Step 3: Write the failing test**

Create `packages/core/test/providers/gmail.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError, ProviderAuthError, ProviderUnavailableError } from "../../src/model/errors.ts";
import { createGmailProvider } from "../../src/providers/google/gmail.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { gmailHandlers } from "../msw/gmail.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;
let provider: MailProvider;

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...gmailHandlers(box));
  provider = createGmailProvider({ fetch: (input, init) => fetch(input, init), tokens, now: () => NOW });
});

function inboxIdsNewestFirst(): string[] {
  return box.inFolder("inbox").map((m) => m.id);
}

describe("GmailProvider.bootstrap", () => {
  it("reads the profile first, then sendAs aliases, and starts the history cursor", async () => {
    box.addMessage();
    const result = await provider.bootstrap();
    expect(result).toEqual({
      email: "owner@example.test",
      providerUserId: "owner@example.test",
      aliases: ["alias@example.test"],
      archiveFolderId: null,
      incrementalCursor: JSON.stringify({
        v: 1,
        historyId: "1001",
        catchupAfter: null,
        catchupPageToken: null,
      }),
    });
    expect(box.requests).toEqual([
      "GET /gmail/v1/users/me/profile",
      "GET /gmail/v1/users/me/settings/sendAs",
    ]);
  });
});

describe("GmailProvider.inboxEstimate", () => {
  it("returns INBOX messagesTotal with one request", async () => {
    box.addMessage();
    box.addMessage();
    box.addMessage({ folder: "archive" });
    expect(await provider.inboxEstimate()).toBe(2);
    expect(box.requests).toEqual(["GET /gmail/v1/users/me/labels/INBOX"]);
  });

  it("returns null on rate limit but throws on auth failure", async () => {
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/labels/INBOX", status: 429 });
    expect(await provider.inboxEstimate()).toBeNull();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/labels/INBOX", status: 401, times: 2 });
    await expect(provider.inboxEstimate()).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe("GmailProvider.listInboxPage", () => {
  it("pages the inbox newest first with labelIds=INBOX and one metadata batch per page", async () => {
    for (let i = 0; i < 5; i++) box.addMessage();
    box.addMessage({ folder: "archive" });
    box.addMessage({ folder: "sent" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await provider.listInboxPage(cursor, 2);
      seen.push(...page.messages.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(inboxIdsNewestFirst());
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(3);
    expect(box.maxInFlight).toBe(1);
  });

  it("encodes the backfill cursor as {v:1,pageToken}", async () => {
    for (let i = 0; i < 3; i++) box.addMessage();
    const page = await provider.listInboxPage(null, 2);
    expect(page.nextCursor).toBe(JSON.stringify({ v: 1, pageToken: "p2" }));
  });

  it("maps metadata into MailMessage", async () => {
    box.addMessage({
      subject: "=?UTF-8?B?Q2Fmw6kgbmV3cw==?=",
      mimeType: "multipart/mixed",
      starred: true,
      headers: [
        { name: "Authentication-Results", value: "mx.google.com; spf=pass smtp.mailfrom=esp.example.net" },
      ],
    });
    const [msg] = (await provider.listInboxPage(null, 25)).messages;
    expect(msg).toMatchObject({
      providerMessageId: "msg0001",
      subject: "Café news",
      from: { address: "sender0001@shop.example.com", name: "Sender 0001" },
      hasAttachments: true,
      starred: true,
      category: "promotions",
      headers: { authenticationResults: "mx.google.com; spf=pass smtp.mailfrom=esp.example.net" },
    });
  });

  it("refreshes once on a 401 and retries", async () => {
    box.addMessage();
    tokens.current = "at-stale";
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages).toHaveLength(1);
    expect(tokens.refreshes).toBe(1);
  });

  it("throws ProviderAuthError after a second 401", async () => {
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages", status: 401, times: 2 });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderAuthError",
      reason: "unauthorized",
    });
    expect(tokens.refreshes).toBe(1);
  });

  it("propagates a refresh failure unchanged", async () => {
    tokens.current = "at-stale";
    tokens.refreshError = new ProviderAuthError({ provider: "gmail", reason: "invalid_grant" });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({ reason: "invalid_grant" });
  });

  it("refreshes once when every batch part is 401 (outer 200)", async () => {
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: /^\/gmail\/v1\/users\/me\/messages\/msg/, status: 401, times: 2 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages).toHaveLength(2);
    expect(tokens.refreshes).toBe(1);
  });

  it("retries a rate-limited part once inside the same call", async () => {
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 429 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002", "msg0001"]);
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:")).slice(2)).toEqual([
      "part:GET /gmail/v1/users/me/messages/msg0001",
    ]);
  });

  it("throws ProviderRateLimitError when a part stays rate limited", async () => {
    box.addMessage();
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg0001",
      status: 403,
      headers: { "Retry-After": "7" },
      body: {
        error: {
          code: 403,
          message: "User Rate Limit Exceeded",
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      },
      times: 2,
    });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 7000,
    });
  });

  it("drops a part that stays 5xx while others succeed, and drops 404 parts without retry", async () => {
    box.addMessage();
    box.addMessage();
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 500, times: 2 });
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0002", status: 404 });
    const page = await provider.listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0003"]);
    expect(box.requests.filter((r) => r.startsWith("part:"))).toHaveLength(4);
  });

  it("throws ProviderUnavailableError when every part of a chunk fails", async () => {
    box.addMessage();
    box.failNext({ method: "GET", path: "/gmail/v1/users/me/messages/msg0001", status: 503, times: 2 });
    await expect(provider.listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("drops messages that left INBOX between list and metadata", async () => {
    box.addMessage();
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages/msg0001",
      status: 200,
      body: { id: "msg0001", threadId: "thr0001", labelIds: ["TRASH"] },
    });
    expect((await provider.listInboxPage(null, 25)).messages).toEqual([]);
  });

  it("maps a rejected page token to CursorExpiredError(backfill)", async () => {
    await expect(
      provider.listInboxPage(JSON.stringify({ v: 1, pageToken: "garbage" }), 25),
    ).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "backfill",
    });
    await expect(provider.listInboxPage("not json", 25)).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("maps a whole-call 429 with Retry-After", async () => {
    box.failNext({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      status: 429,
      headers: { "Retry-After": "12" },
    });
    await expect(provider.listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 12_000,
    });
  });

  it("maps a network failure to ProviderUnavailableError", async () => {
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", () => HttpResponse.error()),
    );
    await expect(provider.listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("GmailProvider.listSentPage", () => {
  it("returns thread ids and lowercased To + Cc + Bcc recipients, paged", async () => {
    box.addMessage({
      folder: "sent",
      fromAddress: "owner@example.test",
      to: ["Friend@Example.com"],
      cc: ["team@example.org"],
      bcc: ["hidden@example.net"],
    });
    box.addMessage({ folder: "sent", fromAddress: "owner@example.test", to: ["friend@example.com"] });
    box.addMessage({ folder: "sent", fromAddress: "owner@example.test", to: ["third@example.com"] });
    const first = await provider.listSentPage(null, 2);
    expect(first.items).toEqual([
      {
        threadId: "thr0003",
        recipients: ["third@example.com"],
        sentAt: box.messages.get("msg0003")?.receivedAt,
      },
      {
        threadId: "thr0002",
        recipients: ["friend@example.com"],
        sentAt: box.messages.get("msg0002")?.receivedAt,
      },
    ]);
    const second = await provider.listSentPage(first.nextCursor, 2);
    expect(second.items[0]?.recipients).toEqual([
      "friend@example.com",
      "team@example.org",
      "hidden@example.net",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("maps a rejected sent page token to CursorExpiredError(sent)", async () => {
    await expect(
      provider.listSentPage(JSON.stringify({ v: 1, pageToken: "bad" }), 100),
    ).rejects.toMatchObject({
      cursorKind: "sent",
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail.test.ts`
Expected: FAIL, `Error: Cannot find module '../../src/providers/google/gmail.ts'`.

- [ ] **Step 5: Implement the provider read path**

Create `packages/core/src/providers/google/gmail.ts`:

```ts
import { backoffMs } from "../../http/fetch.ts";
import { buildBatchBody, parseBatchResponse } from "../../http/multipart.ts";
import type { BatchRequestPart, BatchResponsePart } from "../../http/multipart.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import { bestEffortCount, chunkIds, isJsonObject, readJsonBody, sendGuarded } from "../oauth.ts";
import type {
  BackfillCursor,
  BootstrapResult,
  InboxPage,
  MailProvider,
  ProviderDeps,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GMAIL_API,
  encodeIncremental,
  gmailMetadataPath,
  gmailSentMetadataPath,
  mapGmailMessage,
  mapGmailSentItem,
  pageCursor,
  pageTokenOf,
} from "./map.ts";
import { classifyGmailApiError, classifyPart } from "./oauth.ts";
import type { GmailMessageMetadata } from "./types.ts";

const PROVIDER = "gmail";
const USER_URL = `${GMAIL_API}/gmail/v1/users/me`;
const BATCH_URL = `${GMAIL_API}/batch/gmail/v1`;
const BATCH_BOUNDARY = "clearbox_batch_7d1f0c";
const BATCH_MAX_PARTS = 50;

type CursorKind = "backfill" | "sent" | "incremental";

interface GmailClient {
  readonly deps: ProviderDeps;
  /** Authorized request; one forceRefresh + retry on 401, then ProviderAuthError. */
  request(url: string, init?: RequestInit): Promise<Response>;
  /** request + non-2xx classification + JSON object check. */
  json(url: string): Promise<Record<string, unknown>>;
  error(res: Response): Promise<ClearboxError>;
  /** One multipart batch call; parts keyed by Content-ID. */
  batch(parts: readonly BatchRequestPart[]): Promise<Map<string, BatchResponsePart>>;
}

function makeClient(deps: ProviderDeps): GmailClient {
  const once = (url: string, init: RequestInit, token: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return sendGuarded(deps.fetch, PROVIDER, url, { ...init, headers });
  };
  const client: GmailClient = {
    deps,
    async request(url, init = {}) {
      const res = await once(url, init, await deps.tokens.getAccessToken());
      if (res.status !== 401) return res;
      const retry = await once(url, init, await deps.tokens.forceRefresh());
      if (retry.status === 401) throw new ProviderAuthError({ provider: PROVIDER, reason: "unauthorized" });
      return retry;
    },
    async error(res) {
      return classifyGmailApiError(res.status, await readJsonBody(res), res.headers, deps.now());
    },
    async json(url) {
      const res = await client.request(url);
      if (!res.ok) throw await client.error(res);
      const body = await readJsonBody(res);
      if (!isJsonObject(body)) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
      return body;
    },
    async batch(parts) {
      const res = await client.request(BATCH_URL, {
        method: "POST",
        headers: { "content-type": `multipart/mixed; boundary=${BATCH_BOUNDARY}` },
        body: buildBatchBody(parts, BATCH_BOUNDARY),
      });
      if (!res.ok) throw await client.error(res);
      const parsed = parseBatchResponse(await res.text(), res.headers.get("content-type"));
      if (parsed === null) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
      return new Map(parsed.map((part) => [part.contentId, part]));
    },
  };
  return client;
}

interface MetadataRequest {
  key: string;
  path: string;
}

/**
 * Fetches metadata with batches of at most 50 parts. Failed parts are retried once in the same call
 * (429/403-rate, 5xx, missing part; 401 parts after one forceRefresh). Afterwards: still rate limited ->
 * ProviderRateLimitError; every part of a chunk failed -> ProviderUnavailableError; otherwise 404 and
 * persistent 5xx parts are dropped.
 */
async function fetchMetadata(
  client: GmailClient,
  requests: readonly MetadataRequest[],
): Promise<Map<string, GmailMessageMetadata>> {
  const found = new Map<string, GmailMessageMetadata>();
  let refreshed = false;
  for (const group of chunkIds(requests, BATCH_MAX_PARTS)) {
    let pending = group;
    let succeeded = 0;
    let rateRetryAfter: number | null | undefined;
    let serverRetryAfter: number | null = null;
    for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
      const parts = await client.batch(
        pending.map((r, i) => ({ contentId: `m${String(i)}`, method: "GET", path: r.path })),
      );
      const retry: MetadataRequest[] = [];
      let unauthorized = false;
      rateRetryAfter = undefined;
      for (const [i, request] of pending.entries()) {
        const outcome = classifyPart(parts.get(`m${String(i)}`), client.deps.now());
        if (outcome.kind === "ok") {
          found.set(request.key, outcome.body as unknown as GmailMessageMetadata);
          succeeded++;
        } else if (outcome.kind === "auth") {
          unauthorized = true;
          retry.push(request);
        } else if (outcome.kind === "rate") {
          rateRetryAfter = outcome.retryAfterMs;
          retry.push(request);
        } else if (outcome.kind === "server") {
          serverRetryAfter = outcome.retryAfterMs;
          retry.push(request);
        }
      }
      if (unauthorized) {
        if (refreshed || attempt === 2)
          throw new ProviderAuthError({ provider: PROVIDER, reason: "unauthorized" });
        await client.deps.tokens.forceRefresh();
        refreshed = true;
      }
      pending = retry;
    }
    if (pending.length > 0 && rateRetryAfter !== undefined) {
      throw new ProviderRateLimitError({ provider: PROVIDER, retryAfterMs: rateRetryAfter ?? backoffMs(1) });
    }
    if (pending.length > 0 && succeeded === 0) {
      throw new ProviderUnavailableError({ provider: PROVIDER, retryAfterMs: serverRetryAfter });
    }
  }
  return found;
}

// ---- Listing ----

interface ListQuery {
  label: "INBOX" | "SENT";
  maxResults: number;
  pageToken: string | null;
  query: string | null;
}

async function listIds(
  client: GmailClient,
  q: ListQuery,
  kind: CursorKind,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const url = new URL(`${USER_URL}/messages`);
  url.searchParams.set("labelIds", q.label);
  url.searchParams.set("maxResults", String(q.maxResults));
  if (q.query !== null) url.searchParams.set("q", q.query);
  if (q.pageToken !== null) url.searchParams.set("pageToken", q.pageToken);
  const res = await client.request(url.toString());
  if (res.status === 400 && q.pageToken !== null)
    throw new CursorExpiredError({ provider: PROVIDER, cursorKind: kind });
  if (!res.ok) throw await client.error(res);
  const body = await readJsonBody(res);
  if (!isJsonObject(body)) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  const refs: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const ids = refs.flatMap((ref) => (isJsonObject(ref) && typeof ref.id === "string" ? [ref.id] : []));
  return { ids, nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null };
}

/** Maps metadata in the given id order, dropping ids whose metadata is missing or no longer in INBOX. */
function inboxMessages(
  ids: readonly string[],
  metas: Map<string, GmailMessageMetadata>,
  prefix = "",
): MailMessage[] {
  return ids.flatMap((id) => {
    const meta = metas.get(`${prefix}${id}`);
    return meta !== undefined && (meta.labelIds ?? []).includes("INBOX") ? [mapGmailMessage(meta)] : [];
  });
}

async function bootstrap(client: GmailClient): Promise<BootstrapResult> {
  const profile = await client.json(`${USER_URL}/profile`);
  if (typeof profile.emailAddress !== "string" || typeof profile.historyId !== "string") {
    throw new ProviderResponseError({ provider: PROVIDER, status: 200 });
  }
  const email = profile.emailAddress.toLowerCase();
  const sendAs = await client.json(`${USER_URL}/settings/sendAs`);
  const entries: unknown[] = Array.isArray(sendAs.sendAs) ? sendAs.sendAs : [];
  const aliases = new Set<string>();
  for (const entry of entries) {
    if (isJsonObject(entry) && typeof entry.sendAsEmail === "string")
      aliases.add(entry.sendAsEmail.toLowerCase());
  }
  aliases.delete(email);
  return {
    email,
    providerUserId: email,
    aliases: [...aliases],
    archiveFolderId: null,
    incrementalCursor: encodeIncremental({
      v: 1,
      historyId: profile.historyId,
      catchupAfter: null,
      catchupPageToken: null,
    }),
  };
}

/** GET /users/me/labels/INBOX (1 quota unit, allowed with gmail.modify): messagesTotal. */
function getInboxEstimate(client: GmailClient): Promise<number | null> {
  return bestEffortCount(() => client.json(`${USER_URL}/labels/INBOX`), "messagesTotal");
}

async function listInboxPage(
  client: GmailClient,
  cursor: BackfillCursor | null,
  pageSize: number,
): Promise<InboxPage> {
  const pageToken = cursor === null ? null : pageTokenOf(cursor, "backfill");
  const list = await listIds(
    client,
    { label: "INBOX", maxResults: pageSize, pageToken, query: null },
    "backfill",
  );
  const metas = await fetchMetadata(
    client,
    list.ids.map((id) => ({ key: id, path: gmailMetadataPath(id) })),
  );
  return { messages: inboxMessages(list.ids, metas), nextCursor: pageCursor(list.nextPageToken) };
}

async function listSentPage(
  client: GmailClient,
  cursor: SentCursor | null,
  pageSize: number,
): Promise<SentPage> {
  const pageToken = cursor === null ? null : pageTokenOf(cursor, "sent");
  const list = await listIds(client, { label: "SENT", maxResults: pageSize, pageToken, query: null }, "sent");
  const metas = await fetchMetadata(
    client,
    list.ids.map((id) => ({ key: id, path: gmailSentMetadataPath(id) })),
  );
  const items = list.ids.flatMap((id) => {
    const meta = metas.get(id);
    return meta === undefined ? [] : [mapGmailSentItem(meta)];
  });
  return { items, nextCursor: pageCursor(list.nextPageToken) };
}

// ---- Incremental sync ----
// (added in Task 9)

// ---- Actions ----
// (added in Task 10)

function notImplemented(): Promise<never> {
  return Promise.reject(new ClearboxError("not_implemented", "Added by a later plan 02 task"));
}

/** Gmail provider (contracts 4.3, 4.3.2). Requests are strictly sequential; no hard delete exists. */
export function createGmailProvider(deps: ProviderDeps): MailProvider {
  const client = makeClient(deps);
  return {
    kind: "gmail",
    bootstrap: () => bootstrap(client),
    listInboxPage: (cursor, pageSize) => listInboxPage(client, cursor, pageSize),
    listSentPage: (cursor, pageSize) => listSentPage(client, cursor, pageSize),
    syncChanges: () => notImplemented(),
    resyncCursor: () => notImplemented(),
    inboxEstimate: () => getInboxEstimate(client),
    trash: () => notImplemented(),
    archive: () => notImplemented(),
    restore: () => notImplemented(),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail.test.ts`
Expected: PASS, `Tests  20 passed (20)`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/google packages/core/test/msw packages/core/test/providers/gmail.test.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/google/gmail.ts packages/core/test/msw/fake-mailbox.ts \
  packages/core/test/msw/gmail.ts packages/core/test/providers/gmail.test.ts
git commit -m "feat(core): add Gmail provider bootstrap, inbox backfill and sent scan"
```

---

### Task 9: Gmail incremental sync and resync

**Files:**
- Modify: `packages/core/src/providers/google/gmail.ts`
- Test: `packages/core/test/providers/gmail-sync.test.ts`

**Interfaces:**
- Consumes: Task 6 `scanHistory`, `decodeIncremental`, `encodeIncremental`, `IncrementalState`; Task 8 client and `fetchMetadata`.
- Produces: `MailProvider.syncChanges(cursor, maxMessages)` and `resyncCursor(watermark)` for Gmail, following contracts 4.3.1 and decision 9: history `404` throws `CursorExpiredError("incremental")`; `nextCursor.historyId` is the last fully processed record id, or the response `historyId` when caught up; `resyncCursor` takes a fresh `getProfile` historyId and sets `catchupAfter`; the next `syncChanges` drains `messages.list?labelIds=INBOX&q=after:<s>` pages first.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/providers/gmail-sync.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { createGmailProvider } from "../../src/providers/google/gmail.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { gmailHandlers } from "../msw/gmail.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;
let provider: MailProvider;

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...gmailHandlers(box));
  provider = createGmailProvider({ fetch: (input, init) => fetch(input, init), tokens, now: () => NOW });
});

describe("GmailProvider.syncChanges", () => {
  it("reports caughtUp with no changes", async () => {
    box.addMessage();
    const { incrementalCursor } = await provider.bootstrap();
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page).toEqual({
      added: [],
      removedIds: [],
      sent: [],
      nextCursor: incrementalCursor,
      caughtUp: true,
    });
  });

  it("collects new inbox mail, sent mail and removals (archive, trash, delete)", async () => {
    const kept = box.addMessage();
    const archived = box.addMessage();
    const trashed = box.addMessage();
    const deleted = box.addMessage();
    const { incrementalCursor } = await provider.bootstrap();
    const fresh = box.addMessage();
    box.addMessage({ folder: "sent", to: ["friend@example.com"] });
    box.move(archived.id, "archive");
    box.move(trashed.id, "trash");
    box.move(deleted.id, null);
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(page.sent).toEqual([
      {
        threadId: "thr0006",
        recipients: ["friend@example.com"],
        sentAt: box.messages.get("msg0006")?.receivedAt,
      },
    ]);
    expect(page.removedIds.sort()).toEqual([archived.id, deleted.id, trashed.id].sort());
    expect(page.caughtUp).toBe(true);
    expect(JSON.parse(page.nextCursor)).toEqual({
      v: 1,
      historyId: String(1000 + box.seq),
      catchupAfter: null,
      catchupPageToken: null,
    });
    expect(kept.folder).toBe("inbox");
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(1);
  });

  it("stops at maxMessages and resumes from the last processed record", async () => {
    const { incrementalCursor } = await provider.bootstrap();
    for (let i = 0; i < 5; i++) box.addMessage();
    const added: string[] = [];
    let cursor = incrementalCursor;
    let calls = 0;
    for (;;) {
      const page = await provider.syncChanges(cursor, 2);
      expect(page.added.length).toBeLessThanOrEqual(2);
      added.push(...page.added.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      calls++;
      if (page.caughtUp) break;
    }
    expect(added).toEqual(["msg0001", "msg0002", "msg0003", "msg0004", "msg0005"]);
    expect(calls).toBe(3);
  });

  it("throws CursorExpiredError when history returns 404", async () => {
    const { incrementalCursor } = await provider.bootstrap();
    box.addMessage();
    box.expireCursors();
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toMatchObject({
      name: "CursorExpiredError",
      provider: "gmail",
      cursorKind: "incremental",
    });
  });

  it("follows a history page that has a nextPageToken without claiming caughtUp", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () =>
        HttpResponse.json({
          history: [
            {
              id: "2001",
              messagesAdded: [{ message: { id: a.id, threadId: a.threadId, labelIds: ["INBOX", "UNREAD"] } }],
            },
            {
              id: "2002",
              messagesAdded: [{ message: { id: "draft01", threadId: "draft01", labelIds: ["DRAFT"] } }],
            },
            {
              id: "2003",
              labelsAdded: [{ message: { id: b.id, threadId: b.threadId }, labelIds: ["TRASH"] }],
            },
          ],
          nextPageToken: "h2003",
          historyId: "2100",
        }),
      ),
    );
    const page = await provider.syncChanges(
      JSON.stringify({ v: 1, historyId: "2000", catchupAfter: null, catchupPageToken: null }),
      25,
    );
    expect(page.added.map((m) => m.providerMessageId)).toEqual([a.id]);
    expect(page.removedIds).toEqual([b.id]);
    expect(page.caughtUp).toBe(false);
    expect(JSON.parse(page.nextCursor)).toMatchObject({ historyId: "2003" });
  });
});

describe("GmailProvider.resyncCursor", () => {
  it("takes a fresh historyId and drains a catch-up list after the watermark first", async () => {
    const old = box.addMessage();
    const newer1 = box.addMessage();
    const newer2 = box.addMessage();
    const cursor = await provider.resyncCursor(old.receivedAt);
    expect(JSON.parse(cursor)).toEqual({
      v: 1,
      historyId: String(1000 + box.seq),
      catchupAfter: Math.floor(old.receivedAt / 1000) - 1,
      catchupPageToken: null,
    });
    const first = await provider.syncChanges(cursor, 25);
    expect(first.added.map((m) => m.providerMessageId)).toEqual([newer2.id, newer1.id, old.id]);
    expect(first.caughtUp).toBe(false);
    expect(box.requests.some((r) => r === "GET /gmail/v1/users/me/messages")).toBe(true);
    const fresh = box.addMessage();
    const second = await provider.syncChanges(first.nextCursor, 25);
    expect(second.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(second.caughtUp).toBe(true);
  });

  it("pages the catch-up list", async () => {
    const watermark = box.addMessage().receivedAt;
    for (let i = 0; i < 3; i++) box.addMessage();
    const cursor = await provider.resyncCursor(watermark);
    const first = await provider.syncChanges(cursor, 2);
    expect(JSON.parse(first.nextCursor)).toMatchObject({ catchupPageToken: "p2" });
    const second = await provider.syncChanges(first.nextCursor, 2);
    expect(JSON.parse(second.nextCursor)).toMatchObject({ catchupAfter: null, catchupPageToken: null });
    expect([...first.added, ...second.added]).toHaveLength(4);
  });

  it("skips catch-up without a watermark", async () => {
    expect(JSON.parse(await provider.resyncCursor(null))).toMatchObject({ catchupAfter: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail-sync.test.ts`
Expected: FAIL, `Tests  8 failed (8)` with `ClearboxError: Added by a later plan 02 task`.

- [ ] **Step 3: Replace the import block of `gmail.ts`**

Replace every line above `const PROVIDER = "gmail";` in `packages/core/src/providers/google/gmail.ts` with:

```ts
import { backoffMs } from "../../http/fetch.ts";
import { buildBatchBody, parseBatchResponse } from "../../http/multipart.ts";
import type { BatchRequestPart, BatchResponsePart } from "../../http/multipart.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import { bestEffortCount, chunkIds, isJsonObject, readJsonBody, sendGuarded } from "../oauth.ts";
import type {
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  IncrementalCursor,
  InboxPage,
  MailProvider,
  ProviderDeps,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GMAIL_API,
  decodeIncremental,
  encodeIncremental,
  gmailMetadataPath,
  gmailSentMetadataPath,
  mapGmailMessage,
  mapGmailSentItem,
  pageCursor,
  pageTokenOf,
  scanHistory,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGmailApiError, classifyPart } from "./oauth.ts";
import type { GmailHistoryRecord, GmailMessageMetadata } from "./types.ts";
```

- [ ] **Step 4: Add the incremental sync section**

Replace these two lines:

```ts
// ---- Incremental sync ----
// (added in Task 9)
```

with:

```ts
// ---- Incremental sync ----

const HISTORY_PAGE_SIZE = 100;
const HISTORY_TYPES = ["messageAdded", "labelAdded", "labelRemoved", "messageDeleted"] as const;

async function catchUp(
  client: GmailClient,
  state: IncrementalState,
  after: number,
  max: number,
): Promise<ChangesPage> {
  const list = await listIds(
    client,
    { label: "INBOX", maxResults: max, pageToken: state.catchupPageToken, query: `after:${String(after)}` },
    "incremental",
  );
  const metas = await fetchMetadata(
    client,
    list.ids.map((id) => ({ key: id, path: gmailMetadataPath(id) })),
  );
  const next: IncrementalState =
    list.nextPageToken === null
      ? { ...state, catchupAfter: null, catchupPageToken: null }
      : { ...state, catchupPageToken: list.nextPageToken };
  return {
    added: inboxMessages(list.ids, metas),
    removedIds: [],
    sent: [],
    nextCursor: encodeIncremental(next),
    caughtUp: false,
  };
}

async function syncChanges(
  client: GmailClient,
  cursor: IncrementalCursor,
  maxMessages: number,
): Promise<ChangesPage> {
  const state = decodeIncremental(cursor);
  if (state.catchupAfter !== null) return catchUp(client, state, state.catchupAfter, maxMessages);
  const url = new URL(`${USER_URL}/history`);
  url.searchParams.set("startHistoryId", state.historyId);
  for (const type of HISTORY_TYPES) url.searchParams.append("historyTypes", type);
  url.searchParams.set("maxResults", String(HISTORY_PAGE_SIZE));
  const res = await client.request(url.toString());
  if (res.status === 404) throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "incremental" });
  if (!res.ok) throw await client.error(res);
  const body = await readJsonBody(res);
  if (!isJsonObject(body) || typeof body.historyId !== "string") {
    throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  }
  const records = (Array.isArray(body.history) ? body.history : []) as GmailHistoryRecord[];
  const scan = scanHistory(records, maxMessages);
  const caughtUp = scan.processed === records.length && typeof body.nextPageToken !== "string";
  const historyId = caughtUp ? body.historyId : (scan.lastId ?? state.historyId);
  const metas = await fetchMetadata(client, [
    ...scan.inbox.map((id) => ({ key: `i:${id}`, path: gmailMetadataPath(id) })),
    ...scan.sent.map((id) => ({ key: `s:${id}`, path: gmailSentMetadataPath(id) })),
  ]);
  const sent = scan.sent.flatMap((id) => {
    const meta = metas.get(`s:${id}`);
    return meta === undefined ? [] : [mapGmailSentItem(meta)];
  });
  return {
    added: inboxMessages(scan.inbox, metas, "i:"),
    removedIds: scan.removed,
    sent,
    nextCursor: encodeIncremental({ ...state, historyId }),
    caughtUp,
  };
}

async function resyncCursor(client: GmailClient, watermark: number | null): Promise<IncrementalCursor> {
  const profile = await client.json(`${USER_URL}/profile`);
  if (typeof profile.historyId !== "string")
    throw new ProviderResponseError({ provider: PROVIDER, status: 200 });
  const catchupAfter = watermark === null ? null : Math.max(0, Math.floor(watermark / 1000) - 1);
  return encodeIncremental({ v: 1, historyId: profile.historyId, catchupAfter, catchupPageToken: null });
}
```

- [ ] **Step 5: Wire the methods**

In `createGmailProvider`, replace:

```ts
    syncChanges: () => notImplemented(),
    resyncCursor: () => notImplemented(),
```

with:

```ts
    syncChanges: (cursor, maxMessages) => syncChanges(client, cursor, maxMessages),
    resyncCursor: (watermark) => resyncCursor(client, watermark),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail.test.ts test/providers/gmail-sync.test.ts`
Expected: PASS, `Tests  28 passed (28)`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/google packages/core/test/providers/gmail-sync.test.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/google/gmail.ts packages/core/test/providers/gmail-sync.test.ts
git commit -m "feat(core): add Gmail history sync with resync catch-up"
```

---

### Task 10: Gmail trash, archive and restore

**Files:**
- Modify: `packages/core/src/providers/google/gmail.ts`
- Test: `packages/core/test/providers/gmail-actions.test.ts`

**Interfaces:**
- Consumes: Task 4 `classifyPart`, `toActionOutcome`, `ActionOutcome`; Task 8 client.
- Produces: Gmail `trash(ids)` (batch of `POST .../messages/{id}/trash`, 50 per request), `archive(ids)` (`batchModify` remove `INBOX`; per-message `modify` fallback on 400/404), `restore(items)` (`untrash`, then `batchModify` add `INBOX` for every restored message lacking it; archive restores use `batchModify` add `INBOX`). Results are in input order; `newId` equals the id; more than 100 ids throws `ClearboxError("too_many_ids")`. Whole-call 429/5xx throw; per-part failures become `ActionResult` errors (`not_found`, `rate_limited` with `retryAfterMs`, `unavailable`, `bad_request`, `unknown`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/providers/gmail-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { ClearboxError, ProviderRateLimitError } from "../../src/model/errors.ts";
import { createGmailProvider } from "../../src/providers/google/gmail.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { gmailHandlers } from "../msw/gmail.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;
let provider: MailProvider;

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...gmailHandlers(box));
  provider = createGmailProvider({ fetch: (input, init) => fetch(input, init), tokens, now: () => NOW });
});

describe("GmailProvider.trash", () => {
  it("trashes through the batch endpoint and reports per-item results in input order", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    const results = await provider.trash([a.id, "missing01", b.id]);
    expect(results).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect(a.folder).toBe("trash");
    expect(box.requests).toEqual([
      "POST /batch/gmail/v1",
      "part:POST /gmail/v1/users/me/messages/msg0001/trash",
      "part:POST /gmail/v1/users/me/messages/missing01/trash",
      "part:POST /gmail/v1/users/me/messages/msg0002/trash",
    ]);
  });

  it("returns rate_limited with Retry-After for a throttled part", async () => {
    const a = box.addMessage();
    box.failNext({
      method: "POST",
      path: `/gmail/v1/users/me/messages/${a.id}/trash`,
      status: 429,
      headers: { "Retry-After": "5" },
    });
    expect(await provider.trash([a.id])).toEqual([
      { id: a.id, ok: false, error: "rate_limited", retryAfterMs: 5000 },
    ]);
  });

  it("splits more than 50 ids into several batch requests", async () => {
    const ids = Array.from({ length: 60 }, () => box.addMessage().id);
    const results = await provider.trash(ids);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /batch/gmail/v1")).toHaveLength(2);
  });

  it("refuses more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id${String(i)}`);
    await expect(provider.trash(ids)).rejects.toMatchObject({ code: "too_many_ids" });
    await expect(provider.trash(ids)).rejects.toBeInstanceOf(ClearboxError);
  });

  it("refreshes once when the batch parts come back 401", async () => {
    const a = box.addMessage();
    tokens.current = "at-stale";
    expect(await provider.trash([a.id])).toEqual([{ id: a.id, ok: true, newId: a.id }]);
    expect(tokens.refreshes).toBe(1);
  });
});

describe("GmailProvider.archive", () => {
  it("removes INBOX with one batchModify", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    expect(await provider.archive([a.id, b.id])).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["archive", "archive"]);
    expect(box.requests).toEqual(["POST /gmail/v1/users/me/messages/batchModify"]);
  });

  it("falls back to per-message modify when batchModify rejects an id", async () => {
    const a = box.addMessage();
    expect(await provider.archive([a.id, "missing01"])).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
    ]);
    expect(a.folder).toBe("archive");
  });

  it("throws on a whole-call rate limit", async () => {
    const a = box.addMessage();
    box.failNext({ method: "POST", path: "/gmail/v1/users/me/messages/batchModify", status: 429 });
    await expect(provider.archive([a.id])).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe("GmailProvider.restore", () => {
  it("untrashes and re-adds INBOX when untrash does not restore it", async () => {
    const a = box.addMessage();
    box.move(a.id, "trash");
    expect(await provider.restore([{ id: a.id, from: "trash" }])).toEqual([
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect(a.folder).toBe("inbox");
    expect(box.requests).toContain("POST /gmail/v1/users/me/messages/batchModify");
  });

  it("skips batchModify when untrash already restored INBOX", async () => {
    box.untrashRestoresInbox = true;
    const a = box.addMessage();
    box.move(a.id, "trash");
    expect(await provider.restore([{ id: a.id, from: "trash" }])).toEqual([
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect(box.requests).not.toContain("POST /gmail/v1/users/me/messages/batchModify");
  });

  it("restores archived mail with batchModify and keeps input order", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    box.move(a.id, "archive");
    box.move(b.id, "trash");
    const results = await provider.restore([
      { id: b.id, from: "trash" },
      { id: "missing01", from: "trash" },
      { id: a.id, from: "archive" },
    ]);
    expect(results).toEqual([
      { id: b.id, ok: true, newId: b.id },
      { id: "missing01", ok: false, error: "not_found", retryAfterMs: null },
      { id: a.id, ok: true, newId: a.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["inbox", "inbox"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail-actions.test.ts`
Expected: FAIL, `Tests  11 failed (11)` (`ClearboxError: Added by a later plan 02 task`).

- [ ] **Step 3: Replace the import block of `gmail.ts`**

Replace every line above `const PROVIDER = "gmail";` with:

```ts
import { backoffMs } from "../../http/fetch.ts";
import { buildBatchBody, parseBatchResponse } from "../../http/multipart.ts";
import type { BatchRequestPart, BatchResponsePart } from "../../http/multipart.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import { bestEffortCount, chunkIds, isJsonObject, readJsonBody, sendGuarded } from "../oauth.ts";
import type {
  ActionResult,
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  IncrementalCursor,
  InboxPage,
  MailProvider,
  ProviderDeps,
  RestoreItem,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GMAIL_API,
  decodeIncremental,
  encodeIncremental,
  gmailMetadataPath,
  gmailSentMetadataPath,
  mapGmailMessage,
  mapGmailSentItem,
  pageCursor,
  pageTokenOf,
  scanHistory,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGmailApiError, classifyPart, toActionOutcome } from "./oauth.ts";
import type { ActionOutcome } from "./oauth.ts";
import type { GmailHistoryRecord, GmailMessageMetadata } from "./types.ts";
```

- [ ] **Step 4: Add the actions section and remove the stub**

Replace everything from the line `// ---- Actions ----` through the closing `}` of `function notImplemented()` (the lines `// ---- Actions ----`, `// (added in Task 10)`, a blank line and the three-line `notImplemented` function) with:

```ts
// ---- Actions ----

const MAX_IDS_PER_CALL = 100;

function assertMaxIds(count: number): void {
  if (count > MAX_IDS_PER_CALL)
    throw new ClearboxError("too_many_ids", "At most 100 ids per provider action call");
}

function unknownResult(id: string): ActionResult {
  return { id, ok: false, error: "unknown", retryAfterMs: null };
}

/** POST /messages/{id}/{verb} for every id through the batch endpoint (50 per request). */
async function postEach(
  client: GmailClient,
  ids: readonly string[],
  verb: "trash" | "untrash" | "modify",
  body?: Record<string, unknown>,
): Promise<Map<string, ActionOutcome>> {
  const out = new Map<string, ActionOutcome>();
  let refreshed = false;
  for (const group of chunkIds(ids, BATCH_MAX_PARTS)) {
    let pending = group;
    while (pending.length > 0) {
      const parts = await client.batch(
        pending.map((id, i) => ({
          contentId: `a${String(i)}`,
          method: "POST" as const,
          path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}/${verb}`,
          ...(body === undefined ? {} : { body }),
        })),
      );
      const unauthorized: string[] = [];
      for (const [i, id] of pending.entries()) {
        const outcome = classifyPart(parts.get(`a${String(i)}`), client.deps.now());
        if (outcome.kind === "auth") unauthorized.push(id);
        else out.set(id, toActionOutcome(id, outcome));
      }
      if (unauthorized.length > 0) {
        if (refreshed) throw new ProviderAuthError({ provider: PROVIDER, reason: "unauthorized" });
        await client.deps.tokens.forceRefresh();
        refreshed = true;
      }
      pending = unauthorized;
    }
  }
  return out;
}

/** batchModify for all ids; a 400/404 (an id no longer exists) falls back to per-message modify for per-item results. */
async function modifyLabels(
  client: GmailClient,
  ids: readonly string[],
  change: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<Map<string, ActionResult>> {
  if (ids.length === 0) return new Map();
  const res = await client.request(`${USER_URL}/messages/batchModify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, ...change }),
  });
  if (res.ok) return new Map(ids.map((id) => [id, { id, ok: true, newId: id }]));
  if (res.status !== 400 && res.status !== 404) throw await client.error(res);
  const each = await postEach(client, ids, "modify", change);
  return new Map(ids.map((id) => [id, each.get(id)?.result ?? unknownResult(id)]));
}

async function trash(client: GmailClient, ids: readonly string[]): Promise<ActionResult[]> {
  assertMaxIds(ids.length);
  const outcomes = await postEach(client, ids, "trash");
  return ids.map((id) => outcomes.get(id)?.result ?? unknownResult(id));
}

async function archive(client: GmailClient, ids: readonly string[]): Promise<ActionResult[]> {
  assertMaxIds(ids.length);
  const results = await modifyLabels(client, ids, { removeLabelIds: ["INBOX"] });
  return ids.map((id) => results.get(id) ?? unknownResult(id));
}

async function restore(client: GmailClient, items: readonly RestoreItem[]): Promise<ActionResult[]> {
  assertMaxIds(items.length);
  const fromTrash = items.filter((item) => item.from === "trash").map((item) => item.id);
  const untrashed = await postEach(client, fromTrash, "untrash");
  const needInbox = items.filter((item) => item.from === "archive").map((item) => item.id);
  for (const id of fromTrash) {
    const outcome = untrashed.get(id);
    if (outcome?.result.ok === true && !(outcome.labelIds ?? []).includes("INBOX")) needInbox.push(id);
  }
  const modified = await modifyLabels(client, needInbox, { addLabelIds: ["INBOX"] });
  return items.map(({ id, from }) => {
    if (from === "archive") return modified.get(id) ?? unknownResult(id);
    const outcome = untrashed.get(id);
    if (outcome === undefined) return unknownResult(id);
    if (!outcome.result.ok) return outcome.result;
    return modified.get(id) ?? outcome.result;
  });
}
```

- [ ] **Step 5: Wire the methods**

In `createGmailProvider`, replace:

```ts
    trash: () => notImplemented(),
    archive: () => notImplemented(),
    restore: () => notImplemented(),
```

with:

```ts
    trash: (ids) => trash(client, ids),
    archive: (ids) => archive(client, ids),
    restore: (items) => restore(client, items),
```

- [ ] **Step 6: Run the Gmail tests to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/gmail.test.ts test/providers/gmail-sync.test.ts test/providers/gmail-actions.test.ts`
Expected: PASS, `Tests  39 passed (39)`.

- [ ] **Step 7: Format, typecheck, lint, commit**

Run: `pnpm exec prettier --write packages/core/src/providers/google/gmail.ts && pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/google packages/core/test/providers`
Expected: exit code 0; `wc -l packages/core/src/providers/google/gmail.ts` prints about 470 (under 500).

```bash
git add packages/core/src/providers/google/gmail.ts packages/core/test/providers/gmail-actions.test.ts
git commit -m "feat(core): add Gmail trash, archive and restore with INBOX re-add"
```

---

### Task 11: Graph fake and the Graph provider read path

**Files:**
- Create: `packages/core/test/msw/graph.ts`
- Create: `packages/core/src/providers/microsoft/graph.ts` (read path; sync and actions are stubs replaced in Tasks 12 and 13)
- Test: `packages/core/test/providers/graph.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers; Task 3 `inboxEstimate`; Task 5 `classifyGraphApiError`, `isDeltaExpired`, `subRetryAfter`; Task 7 constants, `graphUrl`, `mapGraphMessage`, `mapGraphSentItem`, `IncrementalState`; Task 8 `FakeMailbox`, `FakeTokenSource`; plan 01 `GraphProviderDeps`, `MailProvider`, `backoffMs`.
- Produces:
  - `createGraphProvider(deps: GraphProviderDeps): MailProvider`. After this task `bootstrap` (`/me`, archive folder resolution, inbox and sent delta links followed to `deltaLink` from `receivedDateTime ge <now>`), `inboxEstimate` (`GET /me/mailFolders/inbox?$select=totalItemCount`), `listInboxPage` (keyset cursor, header `$batch` fallback) and `listSentPage` (`nextLink` cursor) work.
  - `graphHandlers(box: FakeMailbox)` (`test/msw/graph.ts`), `graphDispatch(box, method, url, headers, body)`, `graphMessage(message, select, onList)`. The fake rejects any request or sub-request without `Prefer: IdType="ImmutableId"` (`400 TestMissingImmutableIdPrefer`), records every Prefer value in `box.preferHeaders`, returns `$batch` responses in reverse order, supports filtered and token delta rounds with `odata.maxpagesize`, expiry (`box.expireCursors()`, `box.deltaExpiredStatus`), archive folder states and moves.

- [ ] **Step 1: Add the Graph fake (REST, delta and JSON `$batch`)**

Create `packages/core/test/msw/graph.ts`:

```ts
import { http, HttpResponse } from "msw";
import type { FakeFolder, FakeMailbox, FakeMessage } from "./fake-mailbox.ts";

const ORIGIN = "https://graph.microsoft.com";
const BASE = `${ORIGIN}/v1.0`;
const IMMUTABLE = 'IdType="ImmutableId"';
const ARCHIVE_NAME = "Archive";
/** 22-byte conversation index header: thread depth 1. */
const CONVERSATION_INDEX = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==";

interface FakeResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface HeaderReader {
  get(name: string): string | null;
}

const FOLDER_BY_SEGMENT: Readonly<Record<string, FakeFolder>> = { inbox: "inbox", sentitems: "sent" };

function iso(epoch: number): string {
  return new Date(epoch).toISOString().replace(".000Z", "Z");
}

function graphError(status: number, code: string, message = "Synthetic error"): FakeResult {
  return { status, body: { error: { code, message } } };
}

function recipient(address: string) {
  return { emailAddress: { name: address.split("@")[0] ?? address, address } };
}

/** Renders a FakeMessage as a Graph message; select = null renders every property. */
export function graphMessage(
  message: FakeMessage,
  select: ReadonlySet<string> | null,
  onList: boolean,
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    id: message.id,
    conversationId: message.threadId,
    conversationIndex: CONVERSATION_INDEX,
    internetMessageId: `<${message.id}@mail.example.com>`,
    receivedDateTime: iso(message.receivedAt),
    sentDateTime: iso(message.receivedAt),
    subject: message.subject,
    bodyPreview: message.snippet,
    isRead: message.isRead,
    importance: message.important ? "high" : "normal",
    hasAttachments: message.hasAttachments,
    inferenceClassification: message.inference,
    flag: { flagStatus: message.starred ? "flagged" : "notFlagged" },
    from: { emailAddress: { name: message.fromName ?? undefined, address: message.fromAddress } },
    toRecipients: message.to.map(recipient),
    ccRecipients: message.cc.map(recipient),
    bccRecipients: message.bcc.map(recipient),
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(message.id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    internetMessageHeaders: message.headers,
  };
  const out: Record<string, unknown> = { id: message.id };
  for (const [key, value] of Object.entries(full)) {
    if (select !== null && !select.has(key)) continue;
    if (key === "internetMessageHeaders" && onList && !message.headersOnList) continue;
    out[key] = value;
  }
  return out;
}

function selectOf(url: URL): Set<string> | null {
  const raw = url.searchParams.get("$select");
  return raw === null ? null : new Set(raw.split(","));
}

function maxPageSize(headers: HeaderReader): number {
  const match = /odata\.maxpagesize=(\d+)/.exec(headers.get("prefer") ?? "");
  return match === null ? 10 : Number(match[1]);
}

function folderIdFor(box: FakeMailbox, destinationId: string): FakeFolder | null {
  if (destinationId === "deleteditems") return "trash";
  if (destinationId === "inbox") return "inbox";
  if (destinationId === box.archiveFolderId && box.archiveFolder === "present") return "archive";
  return null;
}

/** Server-side delta state: pending page items keyed by skip token. */
const deltaPages = new WeakMap<
  FakeMailbox,
  Map<string, { items: Record<string, unknown>[]; seq: number; folder: string }>
>();

function deltaResponse(
  box: FakeMailbox,
  folder: string,
  items: Record<string, unknown>[],
  seq: number,
  pageSize: number,
): FakeResult {
  const pages =
    deltaPages.get(box) ??
    new Map<string, { items: Record<string, unknown>[]; seq: number; folder: string }>();
  deltaPages.set(box, pages);
  const page = items.slice(0, pageSize);
  const rest = items.slice(pageSize);
  const body: Record<string, unknown> = { value: page };
  if (rest.length > 0) {
    const token = `skip-${String(pages.size + 1)}`;
    pages.set(token, { items: rest, seq, folder });
    body["@odata.nextLink"] = `${BASE}/me/mailFolders/${folder}/messages/delta?$skiptoken=${token}`;
  } else {
    body["@odata.deltaLink"] =
      `${BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=${folder}.${String(seq)}`;
  }
  return { status: 200, body };
}

function delta(box: FakeMailbox, segment: string, url: URL, headers: HeaderReader): FakeResult {
  const folder = FOLDER_BY_SEGMENT[segment];
  if (folder === undefined) return graphError(400, "ErrorInvalidRequest");
  const size = maxPageSize(headers);
  const skip = url.searchParams.get("$skiptoken");
  if (skip !== null) {
    const pending = deltaPages.get(box)?.get(skip);
    if (pending === undefined) return graphError(400, "syncStateNotFound");
    return deltaResponse(box, segment, pending.items, pending.seq, size);
  }
  const token = url.searchParams.get("$deltatoken");
  const select = selectOf(url);
  if (token === null) {
    const filter = /^receivedDateTime ge (.+)$/.exec(url.searchParams.get("$filter") ?? "");
    const since = filter === null ? Number.NEGATIVE_INFINITY : Date.parse(filter[1] ?? "");
    const items = box
      .inFolder(folder)
      .filter((m) => m.receivedAt >= since)
      .map((m) => graphMessage(m, select, true));
    return deltaResponse(box, segment, items, box.seq, size);
  }
  const seq = Number(token.split(".")[1]);
  if (!Number.isFinite(seq) || seq < box.minValidSeq) {
    return box.deltaExpiredStatus === 410
      ? graphError(410, "resyncRequired")
      : graphError(400, "syncStateNotFound");
  }
  const touched = [
    ...new Set(
      box.changes.filter((c) => c.seq > seq && (c.from === folder || c.to === folder)).map((c) => c.id),
    ),
  ];
  const items = touched.map((id) => {
    const message = box.messages.get(id);
    if (message !== undefined && message.folder === folder) return graphMessage(message, select, true);
    return { id, "@removed": { reason: "deleted" } };
  });
  return deltaResponse(box, segment, items, box.seq, size);
}

function listMessages(box: FakeMailbox, folder: FakeFolder, url: URL): FakeResult {
  const top = Number(url.searchParams.get("$top") ?? "10");
  const skip = Number(url.searchParams.get("$skip") ?? "0");
  if (!Number.isFinite(skip) || skip < 0) return graphError(400, "ErrorInvalidRequest");
  const filter = /^receivedDateTime le (.+)$/.exec(url.searchParams.get("$filter") ?? "");
  const before = filter === null ? Number.POSITIVE_INFINITY : Date.parse(filter[1] ?? "");
  const all = box.inFolder(folder).filter((m) => m.receivedAt <= before);
  const page = all.slice(skip, skip + top);
  const body: Record<string, unknown> = { value: page.map((m) => graphMessage(m, selectOf(url), true)) };
  if (skip + top < all.length) {
    const next = new URL(url);
    next.searchParams.set("$skip", String(skip + top));
    body["@odata.nextLink"] = next.toString();
  }
  return { status: 200, body };
}

/** Routes one Graph call (top-level or $batch sub-request). path is relative to /v1.0. */
export function graphDispatch(
  box: FakeMailbox,
  method: string,
  url: URL,
  headers: HeaderReader,
  body: unknown,
): FakeResult {
  const prefer = headers.get("prefer") ?? "";
  box.preferHeaders.push(prefer);
  if (!prefer.includes(IMMUTABLE))
    return graphError(400, "TestMissingImmutableIdPrefer", "Every request must prefer immutable ids");
  const path = url.pathname.replace(/^\/v1\.0/, "");
  const fail = box.failures.take(method, path);
  if (fail)
    return {
      status: fail.status,
      body: fail.body ?? { error: { code: "Injected", message: "Injected failure" } },
      headers: fail.headers ?? {},
    };
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (method === "GET" && path === "/me") {
    return { status: 200, body: { id: box.graphUserId, mail: box.graphMail, userPrincipalName: box.owner } };
  }
  if (method === "GET" && path === "/me/mailFolders/archive") {
    return box.archiveFolder === "present"
      ? { status: 200, body: { id: box.archiveFolderId, displayName: ARCHIVE_NAME } }
      : graphError(404, "ErrorItemNotFound");
  }
  if (method === "GET" && path === "/me/mailFolders/inbox") {
    return { status: 200, body: { id: "folder-inbox-0001", totalItemCount: box.inFolder("inbox").length } };
  }
  if (method === "POST" && path === "/me/mailFolders") {
    if (box.archiveFolder === "uncreatable") return graphError(403, "ErrorAccessDenied");
    box.archiveFolder = "present";
    return { status: 201, body: { id: box.archiveFolderId, displayName: record.displayName } };
  }
  const deltaMatch = /^\/me\/mailFolders\/(inbox|sentitems)\/messages\/delta$/.exec(path);
  if (method === "GET" && deltaMatch !== null) return delta(box, deltaMatch[1] ?? "", url, headers);
  if (method === "GET" && path === "/me/mailFolders/inbox/messages") return listMessages(box, "inbox", url);
  if (method === "GET" && path === "/me/mailFolders/sentitems/messages")
    return listMessages(box, "sent", url);
  const single = /^\/me\/messages\/([^/]+)(\/move)?$/.exec(path);
  if (single !== null) {
    const message = box.messages.get(decodeURIComponent(single[1] ?? ""));
    if (message === undefined)
      return graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
    if (method === "GET" && single[2] === undefined)
      return { status: 200, body: graphMessage(message, selectOf(url), false) };
    if (method === "POST" && single[2] === "/move") {
      const target = folderIdFor(box, typeof record.destinationId === "string" ? record.destinationId : "");
      if (target === null) return graphError(400, "ErrorInvalidIdMalformed");
      box.move(message.id, target);
      return { status: 201, body: { id: message.id, parentFolderId: `folder-${target}` } };
    }
  }
  return graphError(400, "ErrorInvalidRequest", `Unsupported path in fake: ${path}`);
}

function toResponse(result: FakeResult): Response {
  return new HttpResponse(JSON.stringify(result.body), {
    status: result.status,
    headers: { "content-type": "application/json", ...result.headers },
  });
}

/** MSW handlers for graph.microsoft.com over a FakeMailbox (REST, delta and JSON $batch). */
export function graphHandlers(box: FakeMailbox) {
  return [
    http.all(`${BASE}/*`, ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/v1\.0/, "");
      return box.track(`${request.method} ${path}`, async () => {
        if (request.headers.get("authorization") !== `Bearer ${box.validAccessToken}`) {
          return toResponse(graphError(401, "InvalidAuthenticationToken", "Access token has expired."));
        }
        const text = await request.text();
        const body: unknown = text === "" ? null : JSON.parse(text);
        if (request.method !== "POST" || path !== "/$batch")
          return toResponse(graphDispatch(box, request.method, url, request.headers, body));
        box.preferHeaders.push(request.headers.get("prefer") ?? "");
        const outer = box.failures.take("POST", "/$batch");
        if (outer)
          return toResponse({ status: outer.status, body: outer.body ?? null, headers: outer.headers ?? {} });
        const requests = (
          body as {
            requests: {
              id: string;
              method: string;
              url: string;
              headers?: Record<string, string>;
              body?: unknown;
            }[];
          }
        ).requests;
        if (requests.length > 20)
          return toResponse(graphError(400, "BadRequest", "Too many requests in batch"));
        const responses = requests.map((sub) => {
          const subUrl = new URL(`${BASE}${sub.url}`);
          box.requests.push(`part:${sub.method} ${subUrl.pathname.replace(/^\/v1\.0/, "")}`);
          const subHeaders = new Headers(sub.headers ?? {});
          const result = graphDispatch(box, sub.method, subUrl, subHeaders, sub.body ?? null);
          return {
            id: sub.id,
            status: result.status,
            headers: { "Content-Type": "application/json", ...result.headers },
            body: result.body,
          };
        });
        // Responses come back in any order: reverse them so callers must correlate by id.
        return HttpResponse.json({ responses: responses.reverse() });
      });
    }),
    http.all(`${ORIGIN}/*`, ({ request }) => {
      const url = new URL(request.url);
      throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
    }),
  ];
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/providers/graph.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  ProviderAuthError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../src/model/errors.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { graphHandlers } from "../msw/graph.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;

function makeProvider(archiveFolderId: string | null = "folder-archive-0001"): MailProvider {
  return createGraphProvider({
    fetch: (input, init) => fetch(input, init),
    tokens,
    now: () => NOW,
    archiveFolderId,
  });
}

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...graphHandlers(box));
});

describe("GraphProvider.bootstrap", () => {
  it("reads /me, resolves the archive folder and starts both delta links", async () => {
    box.addMessage();
    const result = await makeProvider().bootstrap();
    expect(result).toMatchObject({
      email: "owner@example.test",
      providerUserId: "graph-user-0001",
      aliases: [],
      archiveFolderId: "folder-archive-0001",
    });
    const cursor = JSON.parse(result.incrementalCursor) as Record<string, string>;
    expect(cursor.v).toBe(1);
    expect(cursor.watermark).toBe("2026-10-15T12:00:00.000Z");
    expect(cursor.inboxDeltaLink).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta\?\$deltatoken=/,
    );
    expect(cursor.sentDeltaLink).toMatch(/sentitems\/messages\/delta\?\$deltatoken=/);
    expect(box.requests).toEqual([
      "GET /me",
      "GET /me/mailFolders/archive",
      "GET /me/mailFolders/inbox/messages/delta",
      "GET /me/mailFolders/sentitems/messages/delta",
    ]);
    expect(box.preferHeaders.every((p) => p.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("falls back to userPrincipalName when mail is null", async () => {
    box.graphMail = null;
    expect((await makeProvider().bootstrap()).email).toBe("owner@example.test");
  });

  it("creates an Archive folder when the well-known folder is missing", async () => {
    box.archiveFolder = "missing";
    expect((await makeProvider().bootstrap()).archiveFolderId).toBe("folder-archive-0001");
    expect(box.requests).toContain("POST /me/mailFolders");
  });

  it("returns archiveFolderId null when the folder cannot be created", async () => {
    box.archiveFolder = "uncreatable";
    expect((await makeProvider().bootstrap()).archiveFolderId).toBeNull();
  });

  it("fails the connect on a transient archive lookup error instead of disabling archive", async () => {
    box.failNext({ method: "GET", path: "/me/mailFolders/archive", status: 503 });
    await expect(makeProvider().bootstrap()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("GraphProvider.inboxEstimate", () => {
  it("returns totalItemCount and null on throttling", async () => {
    box.addMessage();
    box.addMessage({ folder: "archive" });
    const provider = makeProvider();
    expect(await provider.inboxEstimate()).toBe(1);
    box.failNext({ method: "GET", path: "/me/mailFolders/inbox", status: 429 });
    expect(await provider.inboxEstimate()).toBeNull();
  });
});

describe("GraphProvider.listInboxPage", () => {
  it("pages by receivedDateTime keyset without gaps or duplicates when times tie at the boundary", async () => {
    const t = Date.UTC(2026, 9, 10, 8);
    box.addMessage({ receivedAt: t + 3000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 1000 });
    const provider = makeProvider();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await provider.listInboxPage(cursor, 2);
      seen.push(...page.messages.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(box.inFolder("inbox").map((m) => m.id));
    expect(new Set(seen).size).toBe(5);
  });

  it("encodes the backfill cursor as {v:1,before,seenAtBefore}", async () => {
    const t = Date.UTC(2026, 9, 10, 8);
    box.addMessage({ receivedAt: t + 2000 });
    box.addMessage({ receivedAt: t + 1000 });
    box.addMessage({ receivedAt: t });
    const page = await makeProvider().listInboxPage(null, 2);
    expect(JSON.parse(page.nextCursor ?? "null")).toEqual({
      v: 1,
      before: "2026-10-10T08:00:01Z",
      seenAtBefore: ["msg0002"],
    });
  });

  it("maps list messages including internetMessageHeaders", async () => {
    box.addMessage({ id: "AAkALg-Mixed-CASE-01", starred: true, important: true, hasAttachments: true });
    const [msg] = (await makeProvider().listInboxPage(null, 25)).messages;
    expect(msg).toMatchObject({
      providerMessageId: "AAkALg-Mixed-CASE-01",
      starred: true,
      providerImportant: true,
      hasAttachments: true,
      attachmentsApprox: false,
      headers: { listUnsubscribe: "<https://shop.example.com/u/0001>" },
    });
    expect(msg?.webLink).toContain("AAkALg-Mixed-CASE-01");
  });

  it("fetches missing headers with $batch, 20 per request", async () => {
    for (let i = 0; i < 25; i++) box.addMessage({ headersOnList: false });
    const page = await makeProvider().listInboxPage(null, 25);
    expect(page.messages).toHaveLength(25);
    expect(page.messages.every((m) => m.headers.listUnsubscribe !== null)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /$batch")).toHaveLength(2);
    expect(box.requests.filter((r) => r.startsWith("part:GET /me/messages/"))).toHaveLength(25);
  });

  it("drops a message whose header fetch returns 404 and throws on a throttled sub-request", async () => {
    box.addMessage({ headersOnList: false });
    box.addMessage({ headersOnList: false });
    box.failNext({
      method: "GET",
      path: "/me/messages/msg0001",
      status: 404,
      body: { error: { code: "ErrorItemNotFound", message: "x" } },
    });
    const page = await makeProvider().listInboxPage(null, 25);
    expect(page.messages.map((m) => m.providerMessageId)).toEqual(["msg0002"]);
    box.failNext({
      method: "GET",
      path: "/me/messages/msg0002",
      status: 429,
      headers: { "Retry-After": "9" },
    });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 9000,
    });
  });

  it("refreshes once on 401", async () => {
    box.addMessage();
    tokens.current = "at-stale";
    expect((await makeProvider().listInboxPage(null, 25)).messages).toHaveLength(1);
    expect(tokens.refreshes).toBe(1);
  });

  it("throws ProviderAuthError after a second 401", async () => {
    box.failNext({ method: "GET", path: "/me/mailFolders/inbox/messages", status: 401, times: 2 });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("honors Retry-After on 429", async () => {
    box.failNext({
      method: "GET",
      path: "/me/mailFolders/inbox/messages",
      status: 429,
      headers: { "Retry-After": "10" },
    });
    await expect(makeProvider().listInboxPage(null, 25)).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 10_000,
    });
  });

  it("never runs two requests at once", async () => {
    for (let i = 0; i < 5; i++) box.addMessage({ headersOnList: false });
    await makeProvider().listInboxPage(null, 25);
    expect(box.maxInFlight).toBe(1);
  });
});

describe("GraphProvider.listSentPage", () => {
  it("follows nextLink and maps recipients", async () => {
    box.addMessage({
      folder: "sent",
      to: ["Friend@Example.com"],
      cc: ["team@example.org"],
      bcc: ["hidden@example.net"],
    });
    box.addMessage({ folder: "sent", to: ["second@example.com"] });
    const provider = makeProvider();
    const first = await provider.listSentPage(null, 1);
    expect(first.items).toEqual([
      {
        threadId: "thr0002",
        recipients: ["second@example.com"],
        sentAt: box.messages.get("msg0002")?.receivedAt,
      },
    ]);
    expect(JSON.parse(first.nextCursor ?? "null")).toMatchObject({ v: 1 });
    const second = await provider.listSentPage(first.nextCursor, 1);
    expect(second.items[0]?.recipients).toEqual([
      "friend@example.com",
      "team@example.org",
      "hidden@example.net",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("maps a rejected nextLink to CursorExpiredError(sent)", async () => {
    const cursor = JSON.stringify({
      v: 1,
      nextLink: "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$skip=-1",
    });
    await expect(makeProvider().listSentPage(cursor, 100)).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "sent",
    });
  });

  it("never sends the token to a foreign host from a cursor", async () => {
    const cursor = JSON.stringify({ v: 1, nextLink: "https://evil.example.net/steal" });
    await expect(makeProvider().listSentPage(cursor, 100)).rejects.toBeInstanceOf(ProviderResponseError);
    expect(box.requests).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph.test.ts`
Expected: FAIL, `Error: Cannot find module '../../src/providers/microsoft/graph.ts'`.

- [ ] **Step 4: Implement the provider read path**

Create `packages/core/src/providers/microsoft/graph.ts`:

```ts
import { backoffMs } from "../../http/fetch.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import {
  bestEffortCount,
  chunkIds,
  isJsonObject,
  parseCursorJson,
  readJsonBody,
  sendGuarded,
  stringField,
} from "../oauth.ts";
import type {
  BackfillCursor,
  BootstrapResult,
  GraphProviderDeps,
  InboxPage,
  MailProvider,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GRAPH_DELTA_INBOX_SELECT,
  GRAPH_INBOX_SELECT,
  GRAPH_SENT_DELTA_SELECT,
  GRAPH_SENT_LIST_SELECT,
  IMMUTABLE_ID_PREFER,
  graphUrl,
  mapGraphMessage,
  mapGraphSentItem,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGraphApiError, isDeltaExpired, subRetryAfter } from "./oauth.ts";
import type { GraphBatchSubRequest, GraphBatchSubResponse, GraphMessage } from "./types.ts";

const PROVIDER = "outlook";
const GRAPH_ORIGIN = "https://graph.microsoft.com/";
const BATCH_MAX = 20;
const SENT_BACKFILL_TOP = 100;
const MAX_BOOTSTRAP_PAGES = 10;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Adds Prefer: odata.maxpagesize=<n> next to the immutable id preference (delta requests). */
  maxPageSize?: number;
}

interface GraphClient {
  readonly deps: GraphProviderDeps;
  request(url: string, options?: RequestOptions): Promise<Response>;
  json(url: string, options?: RequestOptions): Promise<Record<string, unknown>>;
  error(res: Response): Promise<ClearboxError>;
  batch(requests: readonly GraphBatchSubRequest[]): Promise<Map<string, GraphBatchSubResponse>>;
}

function makeClient(deps: GraphProviderDeps): GraphClient {
  const once = (url: string, options: RequestOptions, token: string): Promise<Response> => {
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: "application/json" });
    headers.append("prefer", IMMUTABLE_ID_PREFER);
    if (options.maxPageSize !== undefined)
      headers.append("prefer", `odata.maxpagesize=${String(options.maxPageSize)}`);
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    return sendGuarded(deps.fetch, PROVIDER, url, init);
  };
  const client: GraphClient = {
    deps,
    async request(url, options = {}) {
      // nextLink / deltaLink come from stored cursors: never send the bearer token anywhere else.
      if (!url.startsWith(GRAPH_ORIGIN)) throw new ProviderResponseError({ provider: PROVIDER, status: 0 });
      const res = await once(url, options, await deps.tokens.getAccessToken());
      if (res.status !== 401) return res;
      const retry = await once(url, options, await deps.tokens.forceRefresh());
      if (retry.status === 401) throw new ProviderAuthError({ provider: PROVIDER, reason: "unauthorized" });
      return retry;
    },
    async error(res) {
      return classifyGraphApiError(res.status, await readJsonBody(res), res.headers, deps.now());
    },
    async json(url, options) {
      const res = await client.request(url, options);
      if (!res.ok) throw await client.error(res);
      const body = await readJsonBody(res);
      if (!isJsonObject(body)) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
      return body;
    },
    async batch(requests) {
      const body = await client.json(graphUrl("/$batch"), { method: "POST", body: { requests } });
      const responses: unknown[] = Array.isArray(body.responses) ? body.responses : [];
      const map = new Map<string, GraphBatchSubResponse>();
      for (const r of responses) {
        if (!isJsonObject(r) || typeof r.id !== "string" || typeof r.status !== "number") continue;
        const headers: Record<string, string> = {};
        if (isJsonObject(r.headers)) {
          for (const [k, v] of Object.entries(r.headers)) if (typeof v === "string") headers[k] = v;
        }
        map.set(r.id, { id: r.id, status: r.status, headers, body: r.body });
      }
      return map;
    },
  };
  return client;
}

/** One $batch sub-request; every sub-request carries the immutable id preference. */
function subRequest(id: string, method: "GET" | "POST", url: string, body?: unknown): GraphBatchSubRequest {
  if (body === undefined) return { id, method, url, headers: { Prefer: IMMUTABLE_ID_PREFER } };
  return {
    id,
    method,
    url,
    headers: { "Content-Type": "application/json", Prefer: IMMUTABLE_ID_PREFER },
    body,
  };
}

function messagesOf(body: Record<string, unknown>): GraphMessage[] {
  const value: unknown[] = Array.isArray(body.value) ? body.value : [];
  return value.filter((v): v is GraphMessage => isJsonObject(v) && typeof v.id === "string");
}

/**
 * Maps messages, fetching internetMessageHeaders with $batch (20 per request) for messages that lack the
 * property. Sub-request 404 drops the message; 429 / 5xx / missing throw so the page is retried later;
 * other failures keep the message with no headers.
 */
async function withHeaders(client: GraphClient, messages: readonly GraphMessage[]): Promise<MailMessage[]> {
  const missing = messages.filter((m) => m.internetMessageHeaders === undefined);
  const fetched = new Map<string, GraphMessage["internetMessageHeaders"] | null>();
  for (const group of chunkIds(missing, BATCH_MAX)) {
    const responses = await client.batch(
      group.map((m, i) =>
        subRequest(
          String(i),
          "GET",
          `/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders`,
        ),
      ),
    );
    for (const [i, message] of group.entries()) {
      const sub = responses.get(String(i));
      const now = client.deps.now();
      if (sub === undefined) throw new ProviderUnavailableError({ provider: PROVIDER, retryAfterMs: null });
      if (sub.status === 429) {
        throw new ProviderRateLimitError({
          provider: PROVIDER,
          retryAfterMs: subRetryAfter(sub, now) ?? backoffMs(1),
        });
      }
      if (sub.status >= 500)
        throw new ProviderUnavailableError({ provider: PROVIDER, retryAfterMs: subRetryAfter(sub, now) });
      if (sub.status === 404) {
        fetched.set(message.id, null);
        continue;
      }
      const headers =
        sub.status === 200 && isJsonObject(sub.body) ? sub.body.internetMessageHeaders : undefined;
      fetched.set(
        message.id,
        Array.isArray(headers) ? (headers as GraphMessage["internetMessageHeaders"]) : [],
      );
    }
  }
  return messages.flatMap((m) => {
    if (m.internetMessageHeaders !== undefined) return [mapGraphMessage(m)];
    const headers = fetched.get(m.id);
    return headers === null ? [] : [mapGraphMessage({ ...m, internetMessageHeaders: headers ?? [] })];
  });
}

// ---- Bootstrap ----

async function resolveArchiveFolder(client: GraphClient): Promise<string | null> {
  const res = await client.request(graphUrl("/me/mailFolders/archive", { $select: "id" }));
  if (res.ok) {
    const body = await readJsonBody(res);
    return isJsonObject(body) ? stringField(body, "id") : null;
  }
  if (res.status === 429 || res.status >= 500) throw await client.error(res);
  if (res.status !== 404) return null;
  const created = await client.request(graphUrl("/me/mailFolders"), {
    method: "POST",
    body: { displayName: "Archive" },
  });
  if (created.ok) {
    const body = await readJsonBody(created);
    return isJsonObject(body) ? stringField(body, "id") : null;
  }
  if (created.status === 429 || created.status >= 500) throw await client.error(created);
  return null;
}

function initialInboxDelta(sinceIso: string): string {
  return graphUrl("/me/mailFolders/inbox/messages/delta", {
    $select: GRAPH_DELTA_INBOX_SELECT,
    $filter: `receivedDateTime ge ${sinceIso}`,
  });
}

function initialSentDelta(sinceIso: string): string {
  return graphUrl("/me/mailFolders/sentitems/messages/delta", {
    $select: GRAPH_SENT_DELTA_SELECT,
    $filter: `receivedDateTime ge ${sinceIso}`,
  });
}

interface DeltaPage {
  value: GraphMessage[];
  nextLink: string | null;
  deltaLink: string | null;
}

async function getDeltaPage(client: GraphClient, url: string, maxPageSize?: number): Promise<DeltaPage> {
  const res = await client.request(url, maxPageSize === undefined ? {} : { maxPageSize });
  if (res.status === 410) throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "incremental" });
  const body = await readJsonBody(res);
  if (!res.ok) {
    if (isDeltaExpired(res.status, body))
      throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "incremental" });
    throw classifyGraphApiError(res.status, body, res.headers, client.deps.now());
  }
  if (!isJsonObject(body)) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  const page = {
    value: messagesOf(body),
    nextLink: stringField(body, "@odata.nextLink"),
    deltaLink: stringField(body, "@odata.deltaLink"),
  };
  if (page.nextLink === null && page.deltaLink === null)
    throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  return page;
}

/** Follows a fresh delta round to its deltaLink, discarding items (connect-time "start from now"). */
async function followToDeltaLink(client: GraphClient, url: string): Promise<string> {
  let next = url;
  for (let i = 0; i < MAX_BOOTSTRAP_PAGES; i++) {
    const page = await getDeltaPage(client, next);
    if (page.deltaLink !== null) return page.deltaLink;
    next = page.nextLink ?? "";
  }
  throw new ProviderResponseError({ provider: PROVIDER, status: 200 });
}

function getInboxEstimate(client: GraphClient): Promise<number | null> {
  return bestEffortCount(
    () => client.json(graphUrl("/me/mailFolders/inbox", { $select: "totalItemCount" })),
    "totalItemCount",
  );
}

async function bootstrap(client: GraphClient): Promise<BootstrapResult> {
  const me = await client.json(graphUrl("/me", { $select: "id,mail,userPrincipalName" }));
  const email = stringField(me, "mail") ?? stringField(me, "userPrincipalName");
  const id = stringField(me, "id");
  if (email === null || id === null) throw new ProviderResponseError({ provider: PROVIDER, status: 200 });
  const archiveFolderId = await resolveArchiveFolder(client);
  const since = new Date(client.deps.now()).toISOString();
  const state: IncrementalState = {
    v: 1,
    inboxDeltaLink: await followToDeltaLink(client, initialInboxDelta(since)),
    sentDeltaLink: await followToDeltaLink(client, initialSentDelta(since)),
    watermark: since,
  };
  return {
    email: email.toLowerCase(),
    providerUserId: id,
    aliases: [],
    archiveFolderId,
    incrementalCursor: JSON.stringify(state),
  };
}

// ---- Backfill ----

async function listInboxPage(
  client: GraphClient,
  cursor: BackfillCursor | null,
  pageSize: number,
): Promise<InboxPage> {
  let before: string | null = null;
  let seen: string[] = [];
  if (cursor !== null) {
    const parsed = parseCursorJson(cursor, PROVIDER, "backfill");
    before = stringField(parsed, "before");
    const seenRaw: unknown[] = Array.isArray(parsed.seenAtBefore) ? parsed.seenAtBefore : [];
    seen = seenRaw.filter((v): v is string => typeof v === "string");
    if (before === null) throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "backfill" });
  }
  const top = pageSize + seen.length;
  const params: Record<string, string> = {
    $select: GRAPH_INBOX_SELECT,
    $top: String(top),
    $orderby: "receivedDateTime desc",
  };
  if (before !== null) params.$filter = `receivedDateTime le ${before}`;
  const values = messagesOf(await client.json(graphUrl("/me/mailFolders/inbox/messages", params)));
  const seenSet = new Set(seen);
  const remaining = values.filter((m) => !seenSet.has(m.id));
  const page = remaining.slice(0, pageSize);
  const exhausted = values.length < top && remaining.length <= pageSize;
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (!exhausted && last?.receivedDateTime !== undefined) {
    const nextBefore = last.receivedDateTime;
    const atBefore = page.filter((m) => m.receivedDateTime === nextBefore).map((m) => m.id);
    const carried = nextBefore === before ? seen : [];
    nextCursor = JSON.stringify({ v: 1, before: nextBefore, seenAtBefore: [...carried, ...atBefore] });
  }
  return { messages: await withHeaders(client, page), nextCursor };
}

async function listSentPage(
  client: GraphClient,
  cursor: SentCursor | null,
  pageSize: number,
): Promise<SentPage> {
  let url = graphUrl("/me/mailFolders/sentitems/messages", {
    $select: GRAPH_SENT_LIST_SELECT,
    $top: String(Math.min(pageSize, SENT_BACKFILL_TOP)),
    $orderby: "sentDateTime desc",
  });
  if (cursor !== null) {
    const nextLink = stringField(parseCursorJson(cursor, PROVIDER, "sent"), "nextLink");
    if (nextLink === null) throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "sent" });
    url = nextLink;
  }
  const res = await client.request(url);
  if (res.status === 400 && cursor !== null)
    throw new CursorExpiredError({ provider: PROVIDER, cursorKind: "sent" });
  if (!res.ok) throw await client.error(res);
  const body = await readJsonBody(res);
  if (!isJsonObject(body)) throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  const nextLink = stringField(body, "@odata.nextLink");
  return {
    items: messagesOf(body).map(mapGraphSentItem),
    nextCursor: nextLink === null ? null : JSON.stringify({ v: 1, nextLink }),
  };
}

// ---- Incremental ----
// (added in Task 12)

// ---- Actions ----
// (added in Task 13)

function notImplemented(): Promise<never> {
  return Promise.reject(new ClearboxError("not_implemented", "Added by a later plan 02 task"));
}

/** Graph provider (contracts 4.3, 4.3.2). Every request carries Prefer: IdType="ImmutableId"; requests are sequential. */
export function createGraphProvider(deps: GraphProviderDeps): MailProvider {
  const client = makeClient(deps);
  return {
    kind: "outlook",
    bootstrap: () => bootstrap(client),
    listInboxPage: (cursor, pageSize) => listInboxPage(client, cursor, pageSize),
    listSentPage: (cursor, pageSize) => listSentPage(client, cursor, pageSize),
    syncChanges: () => notImplemented(),
    resyncCursor: () => notImplemented(),
    inboxEstimate: () => getInboxEstimate(client),
    trash: () => notImplemented(),
    archive: () => notImplemented(),
    restore: () => notImplemented(),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph.test.ts`
Expected: PASS, `Tests  18 passed (18)`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/microsoft packages/core/test/msw/graph.ts packages/core/test/providers/graph.test.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/microsoft/graph.ts packages/core/test/msw/graph.ts packages/core/test/providers/graph.test.ts
git commit -m "feat(core): add Graph provider bootstrap, keyset backfill and sent scan"
```

---

### Task 12: Graph delta sync and resync

**Files:**
- Modify: `packages/core/src/providers/microsoft/graph.ts`
- Test: `packages/core/test/providers/graph-sync.test.ts`

**Interfaces:**
- Consumes: Task 7 `decodeIncremental`; Task 11 client, `getDeltaPage`, `withHeaders`, `initialInboxDelta`, `initialSentDelta`.
- Produces: Graph `syncChanges(cursor, maxMessages)`: one inbox delta page and one sent delta page per call (`Prefer: odata.maxpagesize=<maxMessages>`), `@removed` items become `removedIds`, added items get headers through the `$batch` fallback, `caughtUp` when neither round has a `nextLink`, `watermark` advances to the newest added `receivedAt`; `410` and `syncStateNotFound`-style 4xx throw `CursorExpiredError("incremental")`. `resyncCursor(watermark)` makes no request and returns the initial filtered delta URLs from `watermark` (or `now`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/providers/graph-sync.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError } from "../../src/model/errors.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { graphHandlers } from "../msw/graph.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;

function makeProvider(archiveFolderId: string | null = "folder-archive-0001"): MailProvider {
  return createGraphProvider({
    fetch: (input, init) => fetch(input, init),
    tokens,
    now: () => NOW,
    archiveFolderId,
  });
}

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...graphHandlers(box));
});

describe("GraphProvider.syncChanges", () => {
  it("returns new inbox mail with headers, removals and sent items, then catches up", async () => {
    const leaving = box.addMessage();
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    box.requests.length = 0;
    const fresh = box.addMessage({ receivedAt: NOW + 60_000 });
    box.addMessage({ folder: "sent", to: ["friend@example.com"], receivedAt: NOW + 120_000 });
    box.move(leaving.id, "trash");
    const page = await provider.syncChanges(incrementalCursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([fresh.id]);
    expect(page.added[0]?.headers.listUnsubscribe).toBe("<https://shop.example.com/u/0002>");
    expect(page.removedIds).toEqual([leaving.id]);
    expect(page.sent).toEqual([
      { threadId: "thr0003", recipients: ["friend@example.com"], sentAt: NOW + 120_000 },
    ]);
    expect(page.caughtUp).toBe(true);
    expect(JSON.parse(page.nextCursor)).toMatchObject({ watermark: new Date(NOW + 60_000).toISOString() });
    expect(box.requests.slice(0, 2)).toEqual([
      "GET /me/mailFolders/inbox/messages/delta",
      "GET /me/mailFolders/sentitems/messages/delta",
    ]);
    expect(box.preferHeaders.some((p) => p.includes("odata.maxpagesize=25"))).toBe(true);
  });

  it("pages with maxMessages until caught up", async () => {
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    for (let i = 0; i < 5; i++) box.addMessage({ receivedAt: NOW + i });
    const ids: string[] = [];
    let cursor = incrementalCursor;
    let calls = 0;
    for (;;) {
      const page = await provider.syncChanges(cursor, 2);
      expect(page.added.length).toBeLessThanOrEqual(2);
      ids.push(...page.added.map((m) => m.providerMessageId));
      cursor = page.nextCursor;
      calls++;
      if (page.caughtUp) break;
    }
    expect(new Set(ids).size).toBe(5);
    expect(calls).toBe(3);
  });

  it("throws CursorExpiredError on syncStateNotFound and on 410 Gone", async () => {
    const provider = makeProvider();
    const { incrementalCursor } = await provider.bootstrap();
    box.addMessage();
    box.expireCursors();
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toMatchObject({
      name: "CursorExpiredError",
      cursorKind: "incremental",
    });
    box.deltaExpiredStatus = 410;
    await expect(provider.syncChanges(incrementalCursor, 25)).rejects.toBeInstanceOf(CursorExpiredError);
  });
});

describe("GraphProvider.resyncCursor", () => {
  it("makes no request and re-reads everything received since the watermark", async () => {
    const t = Date.UTC(2026, 9, 12);
    box.addMessage({ receivedAt: t - 60_000 });
    const after1 = box.addMessage({ receivedAt: t });
    const after2 = box.addMessage({ receivedAt: t + 60_000 });
    const provider = makeProvider();
    const cursor = await provider.resyncCursor(t);
    expect(box.requests).toEqual([]);
    expect(JSON.parse(cursor)).toMatchObject({ v: 1, watermark: new Date(t).toISOString() });
    const page = await provider.syncChanges(cursor, 25);
    expect(page.added.map((m) => m.providerMessageId)).toEqual([after2.id, after1.id]);
    expect(page.caughtUp).toBe(true);
    box.addMessage({ receivedAt: t + 120_000 });
    const next = await provider.syncChanges(page.nextCursor, 25);
    expect(next.added).toHaveLength(1);
  });

  it("uses now when the watermark is null", async () => {
    expect(JSON.parse(await makeProvider().resyncCursor(null))).toMatchObject({
      watermark: new Date(NOW).toISOString(),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph-sync.test.ts`
Expected: FAIL, `Tests  5 failed (5)` with `ClearboxError: Added by a later plan 02 task`.

- [ ] **Step 3: Replace the import block of `graph.ts`**

Replace every line above `const PROVIDER = "outlook";` in `packages/core/src/providers/microsoft/graph.ts` with:

```ts
import { backoffMs } from "../../http/fetch.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import {
  bestEffortCount,
  chunkIds,
  isJsonObject,
  parseCursorJson,
  readJsonBody,
  sendGuarded,
  stringField,
} from "../oauth.ts";
import type {
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  GraphProviderDeps,
  IncrementalCursor,
  InboxPage,
  MailProvider,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GRAPH_DELTA_INBOX_SELECT,
  GRAPH_INBOX_SELECT,
  GRAPH_SENT_DELTA_SELECT,
  GRAPH_SENT_LIST_SELECT,
  IMMUTABLE_ID_PREFER,
  decodeIncremental,
  graphUrl,
  mapGraphMessage,
  mapGraphSentItem,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGraphApiError, isDeltaExpired, subRetryAfter } from "./oauth.ts";
import type { GraphBatchSubRequest, GraphBatchSubResponse, GraphMessage } from "./types.ts";
```

- [ ] **Step 4: Add the incremental section**

Replace these two lines:

```ts
// ---- Incremental ----
// (added in Task 12)
```

with:

```ts
// ---- Incremental ----

async function syncChanges(
  client: GraphClient,
  cursor: IncrementalCursor,
  maxMessages: number,
): Promise<ChangesPage> {
  const state = decodeIncremental(cursor);
  const inbox = await getDeltaPage(client, state.inboxDeltaLink, maxMessages);
  const sentPage = await getDeltaPage(client, state.sentDeltaLink, maxMessages);
  const removedIds = inbox.value.filter((m) => m["@removed"] !== undefined).map((m) => m.id);
  const added = await withHeaders(
    client,
    inbox.value.filter((m) => m["@removed"] === undefined),
  );
  const sent = sentPage.value.filter((m) => m["@removed"] === undefined).map(mapGraphSentItem);
  const newest = added.reduce((max, m) => Math.max(max, m.receivedAt), Date.parse(state.watermark));
  const next: IncrementalState = {
    v: 1,
    inboxDeltaLink: inbox.nextLink ?? inbox.deltaLink ?? state.inboxDeltaLink,
    sentDeltaLink: sentPage.nextLink ?? sentPage.deltaLink ?? state.sentDeltaLink,
    watermark: Number.isFinite(newest) ? new Date(newest).toISOString() : state.watermark,
  };
  return {
    added,
    removedIds,
    sent,
    nextCursor: JSON.stringify(next),
    caughtUp: inbox.nextLink === null && sentPage.nextLink === null,
  };
}

/** No request: returns fresh filtered delta URLs from the watermark; syncChanges pages them (items since watermark are ingested). */
async function resyncCursor(client: GraphClient, watermark: number | null): Promise<IncrementalCursor> {
  const since = new Date(watermark ?? client.deps.now()).toISOString();
  const state: IncrementalState = {
    v: 1,
    inboxDeltaLink: initialInboxDelta(since),
    sentDeltaLink: initialSentDelta(since),
    watermark: since,
  };
  return JSON.stringify(state);
}
```

- [ ] **Step 5: Wire the methods**

In `createGraphProvider`, replace:

```ts
    syncChanges: () => notImplemented(),
    resyncCursor: () => notImplemented(),
```

with:

```ts
    syncChanges: (cursor, maxMessages) => syncChanges(client, cursor, maxMessages),
    resyncCursor: (watermark) => resyncCursor(client, watermark),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph.test.ts test/providers/graph-sync.test.ts`
Expected: PASS, `Tests  23 passed (23)`.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/microsoft packages/core/test/providers/graph-sync.test.ts`
Expected: exit code 0.

```bash
git add packages/core/src/providers/microsoft/graph.ts packages/core/test/providers/graph-sync.test.ts
git commit -m "feat(core): add Graph delta sync with watermark resync"
```

---

### Task 13: Graph trash, archive and restore

**Files:**
- Modify: `packages/core/src/providers/microsoft/graph.ts`
- Create: `packages/core/test/fixtures/graph/batch-move-mixed.json`
- Test: `packages/core/test/providers/graph-actions.test.ts`

**Interfaces:**
- Consumes: Task 5 `graphMoveResult`; Task 11 client and `subRequest`.
- Produces: Graph `trash(ids)` (move to `deleteditems`), `archive(ids)` (move to `deps.archiveFolderId`; every id `archive_unavailable` with no request when it is null), `restore(items)` (move to `inbox` for both origins). `$batch` of at most 20 `POST /me/messages/{id}/move` sub-requests, each with `Prefer: IdType="ImmutableId"`, correlated by sub-request id; `newId` = response body `id`. Results in input order; more than 100 ids throws `ClearboxError("too_many_ids")`; a whole-batch 429/5xx throws.

- [ ] **Step 1: Add the out-of-order `$batch` fixture**

Create `packages/core/test/fixtures/graph/batch-move-mixed.json`:

```json
{
  "responses": [
    {
      "id": "2",
      "status": 404,
      "headers": { "Content-Type": "application/json" },
      "body": {
        "error": {
          "code": "ErrorItemNotFound",
          "message": "The specified object was not found in the store."
        }
      }
    },
    {
      "id": "0",
      "status": 201,
      "headers": { "Content-Type": "application/json" },
      "body": { "id": "AAkALg-Fake-New-0", "parentFolderId": "AQMkADFake-deleteditems" }
    },
    {
      "id": "1",
      "status": 429,
      "headers": { "Retry-After": "10" },
      "body": { "error": { "code": "TooManyRequests", "message": "Please retry again later." } }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/providers/graph-actions.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ClearboxError, ProviderRateLimitError } from "../../src/model/errors.ts";
import { createGraphProvider } from "../../src/providers/microsoft/graph.ts";
import type { MailProvider } from "../../src/providers/provider.ts";
import batchMoveMixed from "../fixtures/graph/batch-move-mixed.json" with { type: "json" };
import { FakeMailbox, FakeTokenSource } from "../msw/fake-mailbox.ts";
import { graphHandlers } from "../msw/graph.ts";
import { server } from "../setup/msw.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
let box: FakeMailbox;
let tokens: FakeTokenSource;

function makeProvider(archiveFolderId: string | null = "folder-archive-0001"): MailProvider {
  return createGraphProvider({
    fetch: (input, init) => fetch(input, init),
    tokens,
    now: () => NOW,
    archiveFolderId,
  });
}

beforeEach(() => {
  box = new FakeMailbox();
  tokens = new FakeTokenSource(box);
  server.use(...graphHandlers(box));
});

describe("GraphProvider.trash / archive / restore", () => {
  it("moves to deleteditems, the archive folder and inbox, keeping immutable ids", async () => {
    const a = box.addMessage();
    const b = box.addMessage();
    const provider = makeProvider();
    expect(await provider.trash([a.id])).toEqual([{ id: a.id, ok: true, newId: a.id }]);
    expect(await provider.archive([b.id])).toEqual([{ id: b.id, ok: true, newId: b.id }]);
    expect([a.folder, b.folder]).toEqual(["trash", "archive"]);
    expect(
      await provider.restore([
        { id: a.id, from: "trash" },
        { id: b.id, from: "archive" },
      ]),
    ).toEqual([
      { id: a.id, ok: true, newId: a.id },
      { id: b.id, ok: true, newId: b.id },
    ]);
    expect([a.folder, b.folder]).toEqual(["inbox", "inbox"]);
  });

  it("returns archive_unavailable without any request when no archive folder was resolved", async () => {
    const a = box.addMessage();
    expect(await makeProvider(null).archive([a.id])).toEqual([
      { id: a.id, ok: false, error: "archive_unavailable", retryAfterMs: null },
    ]);
    expect(box.requests).toEqual([]);
  });

  it("splits 25 moves into two $batch requests", async () => {
    const ids = Array.from({ length: 25 }, () => box.addMessage().id);
    const results = await makeProvider().trash(ids);
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(box.requests.filter((r) => r === "POST /$batch")).toHaveLength(2);
  });

  it("correlates out-of-order sub-responses by id: new id, throttled and missing", async () => {
    server.use(http.post("https://graph.microsoft.com/v1.0/$batch", () => HttpResponse.json(batchMoveMixed)));
    const results = await makeProvider().trash(["AAkALg-A", "AAkALg-B", "AAkALg-C"]);
    expect(results).toEqual([
      { id: "AAkALg-A", ok: true, newId: "AAkALg-Fake-New-0" },
      { id: "AAkALg-B", ok: false, error: "rate_limited", retryAfterMs: 10_000 },
      { id: "AAkALg-C", ok: false, error: "not_found", retryAfterMs: null },
    ]);
  });

  it("reports unknown for a sub-response that is missing", async () => {
    server.use(
      http.post("https://graph.microsoft.com/v1.0/$batch", () => HttpResponse.json({ responses: [] })),
    );
    expect(await makeProvider().trash(["AAkALg-A"])).toEqual([
      { id: "AAkALg-A", ok: false, error: "unknown", retryAfterMs: null },
    ]);
  });

  it("throws on a whole-batch 429 and refuses more than 100 ids", async () => {
    box.failNext({ method: "POST", path: "/$batch", status: 429, headers: { "Retry-After": "3" } });
    await expect(makeProvider().trash(["AAkALg-A"])).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      retryAfterMs: 3000,
    });
    await expect(
      makeProvider().trash(Array.from({ length: 101 }, (_, i) => `id${String(i)}`)),
    ).rejects.toBeInstanceOf(ClearboxError);
  });

  it("sends the immutable id preference on every sub-request", async () => {
    const a = box.addMessage();
    await makeProvider().trash([a.id]);
    expect(box.preferHeaders).toHaveLength(2);
    expect(box.preferHeaders.every((p) => p.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("ProviderRateLimitError is exported for callers", () => {
    expect(new ProviderRateLimitError({ provider: "outlook", retryAfterMs: 1 })).toBeInstanceOf(
      ClearboxError,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph-actions.test.ts`
Expected: FAIL, `Tests  7 failed | 1 passed (8)` (`ClearboxError: Added by a later plan 02 task`).

- [ ] **Step 4: Replace the import block of `graph.ts`**

Replace every line above `const PROVIDER = "outlook";` with:

```ts
import { backoffMs } from "../../http/fetch.ts";
import {
  ClearboxError,
  CursorExpiredError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from "../../model/errors.ts";
import type { MailMessage } from "../../model/mail.ts";
import {
  bestEffortCount,
  chunkIds,
  isJsonObject,
  parseCursorJson,
  readJsonBody,
  sendGuarded,
  stringField,
} from "../oauth.ts";
import type {
  ActionResult,
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  GraphProviderDeps,
  IncrementalCursor,
  InboxPage,
  MailProvider,
  RestoreItem,
  SentCursor,
  SentPage,
} from "../provider.ts";
import {
  GRAPH_DELTA_INBOX_SELECT,
  GRAPH_INBOX_SELECT,
  GRAPH_SENT_DELTA_SELECT,
  GRAPH_SENT_LIST_SELECT,
  IMMUTABLE_ID_PREFER,
  decodeIncremental,
  graphUrl,
  mapGraphMessage,
  mapGraphSentItem,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGraphApiError, graphMoveResult, isDeltaExpired, subRetryAfter } from "./oauth.ts";
import type { GraphBatchSubRequest, GraphBatchSubResponse, GraphMessage } from "./types.ts";
```

- [ ] **Step 5: Add the actions section and remove the stub**

Replace everything from the line `// ---- Actions ----` through the closing `}` of `function notImplemented()` with:

```ts
// ---- Actions ----

const MAX_IDS_PER_CALL = 100;

function assertMaxIds(count: number): void {
  if (count > MAX_IDS_PER_CALL)
    throw new ClearboxError("too_many_ids", "At most 100 ids per provider action call");
}

/** $batch of POST /me/messages/{id}/move, 20 per request; newId = response body id. */
async function move(
  client: GraphClient,
  ids: readonly string[],
  destinationId: string,
): Promise<ActionResult[]> {
  assertMaxIds(ids.length);
  const results: ActionResult[] = [];
  for (const group of chunkIds(ids, BATCH_MAX)) {
    const responses = await client.batch(
      group.map((id, i) =>
        subRequest(String(i), "POST", `/me/messages/${encodeURIComponent(id)}/move`, { destinationId }),
      ),
    );
    for (const [i, id] of group.entries())
      results.push(graphMoveResult(id, responses.get(String(i)), client.deps.now()));
  }
  return results;
}

function trash(client: GraphClient, ids: readonly string[]): Promise<ActionResult[]> {
  return move(client, ids, "deleteditems");
}

/** Moves to the folder resolved at connect; archive_unavailable for every id (no request) when there is none. */
async function archive(
  client: GraphClient,
  ids: readonly string[],
  archiveFolderId: string | null,
): Promise<ActionResult[]> {
  assertMaxIds(ids.length);
  if (archiveFolderId === null) {
    return ids.map((id) => ({ id, ok: false, error: "archive_unavailable", retryAfterMs: null }));
  }
  return move(client, ids, archiveFolderId);
}

/** Trash and archive both restore by moving back to the well-known inbox folder. */
function restore(client: GraphClient, items: readonly RestoreItem[]): Promise<ActionResult[]> {
  return move(
    client,
    items.map((item) => item.id),
    "inbox",
  );
}
```

- [ ] **Step 6: Wire the methods**

In `createGraphProvider`, replace:

```ts
    trash: () => notImplemented(),
    archive: () => notImplemented(),
    restore: () => notImplemented(),
```

with:

```ts
    trash: (ids) => trash(client, ids),
    archive: (ids) => archive(client, ids, deps.archiveFolderId),
    restore: (items) => restore(client, items),
```

- [ ] **Step 7: Run the Graph tests to verify they pass**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/graph.test.ts test/providers/graph-sync.test.ts test/providers/graph-actions.test.ts`
Expected: PASS, `Tests  31 passed (31)`.

- [ ] **Step 8: Format, typecheck, lint, commit**

Run: `pnpm exec prettier --write packages/core/src/providers/microsoft/graph.ts && pnpm --filter @clearbox/core typecheck && pnpm exec eslint packages/core/src/providers/microsoft packages/core/test/providers`
Expected: exit code 0; `wc -l packages/core/src/providers/microsoft/graph.ts` prints about 455 (under 500).

```bash
git add packages/core/src/providers/microsoft/graph.ts packages/core/test/providers/graph-actions.test.ts \
  packages/core/test/fixtures/graph/batch-move-mixed.json
git commit -m "feat(core): add Graph trash, archive and restore through JSON batch moves"
```

---

### Task 14: Public exports and full verification

**Files:**
- Modify: `packages/core/src/index.ts` (plan 01 file)
- Modify: `packages/core/test/testing.ts` (plan 01 file)
- Test: `packages/core/test/providers/exports.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (`@clearbox/core`): see the final "Produces summary" below. Produces (`@clearbox/core/testing`): `makeGmailMetadata`, `makeGraphMessage`, `GmailMetadataOverrides`, `FAKE_OWNER`, `FakeMailbox`, `FakeTokenSource`, `FailRule`, `FakeChange`, `FakeFolder`, `FakeHeader`, `FakeMessage`, `gmailHandlers`, `graphHandlers`, `FakeOAuthState`, `GOOGLE_TEST_CLIENT`, `createGoogleOAuthState`, `googleOAuthHandlers`, `MICROSOFT_TEST_CLIENT`, `createMicrosoftOAuthState`, `microsoftOAuthHandlers`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/providers/exports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as core from "../../src/index.ts";
import * as testing from "../testing.ts";

const PROVIDER_EXPORTS = [
  "buildAuthorizeUrl",
  "exchangeCode",
  "refreshAccessToken",
  "parseTokenResponse",
  "buildBatchBody",
  "parseBatchResponse",
  "boundaryFromContentType",
  "GMAIL_MODIFY_SCOPE",
  "GOOGLE_TOKEN_ENDPOINT",
  "buildGoogleAuthorizeUrl",
  "exchangeGoogleCode",
  "refreshGoogleToken",
  "revokeGoogleToken",
  "hasGmailScope",
  "classifyGoogleOAuthError",
  "classifyGmailApiError",
  "mapGmailMessage",
  "buildGmailDeepLink",
  "createGmailProvider",
  "MICROSOFT_TOKEN_ENDPOINT",
  "buildMicrosoftAuthorizeUrl",
  "exchangeMicrosoftCode",
  "refreshMicrosoftToken",
  "hasGraphScopes",
  "classifyMicrosoftOAuthError",
  "classifyGraphApiError",
  "mapGraphMessage",
  "createGraphProvider",
] as const;

const TESTING_EXPORTS = [
  "makeGmailMetadata",
  "makeGraphMessage",
  "FAKE_OWNER",
  "FakeMailbox",
  "FakeTokenSource",
  "gmailHandlers",
  "graphHandlers",
  "FakeOAuthState",
  "GOOGLE_TEST_CLIENT",
  "createGoogleOAuthState",
  "googleOAuthHandlers",
  "MICROSOFT_TEST_CLIENT",
  "createMicrosoftOAuthState",
  "microsoftOAuthHandlers",
] as const;

describe("@clearbox/core provider exports", () => {
  it.each(PROVIDER_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
  });

  it("providers expose the MailProvider surface and no hard delete", () => {
    const deps = {
      fetch: () => Promise.reject(new Error("unused")),
      tokens: { getAccessToken: () => Promise.resolve("t"), forceRefresh: () => Promise.resolve("t") },
      now: () => 0,
    };
    for (const provider of [
      core.createGmailProvider(deps),
      core.createGraphProvider({ ...deps, archiveFolderId: null }),
    ]) {
      expect(Object.keys(provider).sort()).toEqual(
        [
          "archive",
          "bootstrap",
          "inboxEstimate",
          "kind",
          "listInboxPage",
          "listSentPage",
          "restore",
          "resyncCursor",
          "syncChanges",
          "trash",
        ].sort(),
      );
    }
  });
});

describe("@clearbox/core/testing provider helpers", () => {
  it.each(TESTING_EXPORTS)("exports %s", (name) => {
    expect(testing).toHaveProperty(name);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/exports.test.ts`
Expected: FAIL, the provider names are missing from `core` and `testing` (`expected { ... } to have property "buildAuthorizeUrl"`).

- [ ] **Step 3: Export from the barrel**

In `packages/core/src/index.ts`, replace plan 01's two lines

```ts
export { GOOGLE_SCOPES, MICROSOFT_CONSENT_URLS, MICROSOFT_SCOPES } from "./providers/oauth.ts";
export type { AuthorizeParams, OAuthClientConfig } from "./providers/oauth.ts";
```

with:

```ts
export {
  GOOGLE_SCOPES,
  MICROSOFT_CONSENT_URLS,
  MICROSOFT_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  parseTokenResponse,
  refreshAccessToken,
} from "./providers/oauth.ts";
export type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "./providers/oauth.ts";
export { boundaryFromContentType, buildBatchBody, parseBatchResponse } from "./http/multipart.ts";
export type { BatchRequestPart, BatchResponsePart } from "./http/multipart.ts";
export {
  GMAIL_MODIFY_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  buildGoogleAuthorizeUrl,
  classifyGmailApiError,
  classifyGoogleOAuthError,
  exchangeGoogleCode,
  hasGmailScope,
  refreshGoogleToken,
  revokeGoogleToken,
} from "./providers/google/oauth.ts";
export { buildGmailDeepLink, mapGmailMessage } from "./providers/google/map.ts";
export { createGmailProvider } from "./providers/google/gmail.ts";
export {
  MICROSOFT_TOKEN_ENDPOINT,
  buildMicrosoftAuthorizeUrl,
  classifyGraphApiError,
  classifyMicrosoftOAuthError,
  exchangeMicrosoftCode,
  hasGraphScopes,
  refreshMicrosoftToken,
} from "./providers/microsoft/oauth.ts";
export { mapGraphMessage } from "./providers/microsoft/map.ts";
export { createGraphProvider } from "./providers/microsoft/graph.ts";
```

If plan 01's `providers/provider.ts` still contains `export declare function createGmailProvider` or `createGraphProvider` (contracts 4.3 shows them as declarations), delete those two lines: the implementations now live in `google/gmail.ts` and `microsoft/graph.ts`.

- [ ] **Step 4: Export the test helpers**

In `packages/core/test/testing.ts`, insert after the line `export type { MailMessageOverrides } from "./fixtures/builders.ts";`:

```ts
export { makeGmailMetadata, makeGraphMessage } from "./fixtures/builders.ts";
export type { GmailMetadataOverrides } from "./fixtures/builders.ts";
export { FAKE_OWNER, FakeMailbox, FakeTokenSource } from "./msw/fake-mailbox.ts";
export type { FailRule, FakeChange, FakeFolder, FakeHeader, FakeMessage } from "./msw/fake-mailbox.ts";
export { gmailHandlers } from "./msw/gmail.ts";
export { graphHandlers } from "./msw/graph.ts";
export {
  FakeOAuthState,
  GOOGLE_TEST_CLIENT,
  createGoogleOAuthState,
  googleOAuthHandlers,
} from "./msw/google-oauth.ts";
export {
  MICROSOFT_TEST_CLIENT,
  createMicrosoftOAuthState,
  microsoftOAuthHandlers,
} from "./msw/microsoft-oauth.ts";
```

- [ ] **Step 5: Run the whole core suite**

Run: `pnpm --filter @clearbox/core exec vitest run test/providers/exports.test.ts && pnpm --filter @clearbox/core test`
Expected: PASS, `Tests  43 passed (43)` for the exports file, then every core test file passes (plan 02 alone adds 252 tests in 13 files).

- [ ] **Step 6: Typecheck, lint, text check**

Run: `pnpm --filter @clearbox/core typecheck && pnpm lint && pnpm format:check`
Expected: exit code 0 (no ESLint problems, no em dash or secret findings from `scripts/check-text.ts`, Prettier clean).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/testing.ts packages/core/test/providers/exports.test.ts
git commit -m "feat(core): export mail providers, OAuth helpers and provider test fakes"
```

---

### Task 15: Record real fixtures (optional, owner-run, manual)

Resolves the **[Unverified]** items in `docs/superpowers/research/mail-providers.md` ("Unresolved" list) against the owner's own mailboxes. Nothing in this task runs in CI and no raw recording is ever committed. Skip it entirely if no real mailbox is available; the code already has fallbacks for every item.

**Files:**
- Create (gitignored, never committed): `.superpowers/recordings/` (covered by `.gitignore` entry `.superpowers/`)
- Create (gitignored): `.superpowers/recordings/sanitize.mjs`
- Modify (only after sanitizing): `docs/superpowers/research/mail-providers.md` (findings), optionally `packages/core/test/fixtures/{gmail,graph}/recorded-*.json`

**Interfaces:**
- Consumes: nothing from the code. Produces: answers recorded in the research doc; optional sanitized fixtures.

- [ ] **Step 1: Prepare a private scratch folder and short-lived tokens**

```bash
mkdir -p .superpowers/recordings && cd .superpowers/recordings
git check-ignore -q . && echo "ignored: OK"
```

Expected: `ignored: OK`. Get short-lived access tokens without touching Clearbox's stored tokens:

- Gmail: Google OAuth 2.0 Playground (`https://developers.google.com/oauthplayground`), scope `https://www.googleapis.com/auth/gmail.modify`, "Exchange authorization code for tokens", copy the access token (valid about 1 hour).
- Graph: Graph Explorer (`https://developer.microsoft.com/graph/graph-explorer`), sign in with the personal account first, then the work account, consent to `Mail.ReadWrite`, copy the access token from the "Access token" tab.

Load them into the shell without echo or history:

```bash
read -rs GMAIL_TOKEN; export GMAIL_TOKEN
read -rs GRAPH_TOKEN; export GRAPH_TOKEN
```

- [ ] **Step 2: Graph, `internetMessageHeaders` on list and on delta (personal, then work)**

```bash
curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" -H 'Prefer: IdType="ImmutableId"' \
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=id,conversationIndex,webLink,internetMessageHeaders&$top=3' \
  > graph-list.json
jq '[.value[] | has("internetMessageHeaders")]' graph-list.json
curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" -H 'Prefer: IdType="ImmutableId"' -H 'Prefer: odata.maxpagesize=3' \
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?\$select=id,internetMessageHeaders&\$filter=receivedDateTime%20ge%20$(date -u -v-2d +%Y-%m-%dT%H:%M:%SZ)" \
  > graph-delta.json
jq '{headers: [.value[] | has("internetMessageHeaders")], next: has("@odata.nextLink"), delta: has("@odata.deltaLink")}' graph-delta.json
```

Expected: arrays of `true` or `false`. `true` on list means the `$batch` header fallback is rarely used; the delta answer tells whether delta could skip it too (the code requests headers by fallback for delta either way). The second request also answers "two `Prefer` headers accepted" (a 400 would say no). On Linux use `date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ`.

- [ ] **Step 3: Graph, archive folder, `/me` and `webLink` host**

```bash
curl -sS -o graph-archive.json -w '%{http_code}\n' -H "Authorization: Bearer $GRAPH_TOKEN" \
  'https://graph.microsoft.com/v1.0/me/mailFolders/archive?$select=id,displayName'
jq '{code: .error.code, hasId: has("id")}' graph-archive.json
curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName' \
  | jq '{mailIsNull: (.mail == null), upnHasAt: (.userPrincipalName | contains("@"))}'
jq -r '.value[0].webLink' graph-list.json | sed -E 's#^(https://[^/]+)/.*#\1#'
```

Expected: `200` with `hasId: true`, or `404` with the exact `error.code` (record it; the code treats any 404 as "create the folder"). Record whether `mail` is null for the personal account and the `webLink` origin (for example `https://outlook.live.com`).

- [ ] **Step 4: Graph, filtered delta continuity**

```bash
DELTA=$(jq -r '."@odata.deltaLink" // empty' graph-delta.json)
echo "Send yourself a test email now, wait one minute, then press enter"; read -r
curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" -H 'Prefer: IdType="ImmutableId"' "$DELTA" \
  | jq '{newItems: [.value[] | select(has("@removed") | not)] | length}'
```

Expected: `newItems` at least 1, which confirms a `receivedDateTime ge` filtered delta keeps reporting new mail (decision 11 and bootstrap rely on it). If `DELTA` is empty, page `graph-delta.json`'s `@odata.nextLink` first.

- [ ] **Step 5: Gmail, `payload.mimeType`, header decoding and header name case**

```bash
ID=$(curl -sS -H "Authorization: Bearer $GMAIL_TOKEN" \
  'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=1' | jq -r '.messages[0].id')
curl -sS -H "Authorization: Bearer $GMAIL_TOKEN" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/$ID?format=metadata&metadataHeaders=subject&metadataHeaders=Message-ID&metadataHeaders=Content-Type&fields=id,payload(mimeType,headers)" \
  > gmail-meta.json
jq '{mimeType: .payload.mimeType, names: [.payload.headers[].name], encodedWords: ([.payload.headers[].value | test("=\\?[^?]+\\?[BbQq]\\?")] | any)}' gmail-meta.json
```

Expected: `mimeType` present (else the `Content-Type` fallback is used), `names` shows whether lowercase `subject` matched (case-insensitive `metadataHeaders`), `encodedWords` false means Gmail decodes RFC 2047 itself (decoding stays defensive either way). Repeat with a message whose subject has non-ASCII characters.

- [ ] **Step 6: Gmail, does `untrash` restore `INBOX`**

Use a test email you sent to yourself (it lands in the inbox).

```bash
TID=$(curl -sS -H "Authorization: Bearer $GMAIL_TOKEN" \
  'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=1&q=subject:clearbox-untrash-probe' | jq -r '.messages[0].id')
curl -sS -X POST -H "Authorization: Bearer $GMAIL_TOKEN" -H 'Content-Length: 0' \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/$TID/trash" | jq '.labelIds'
curl -sS -X POST -H "Authorization: Bearer $GMAIL_TOKEN" -H 'Content-Length: 0' \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/$TID/untrash" | jq '{inboxBack: (.labelIds | index("INBOX") != null)}'
```

Expected: `inboxBack` true or false. Either way the code is correct (it re-adds `INBOX` when missing); `true` means the follow-up `batchModify` is skipped in practice. Subject the probe email `clearbox-untrash-probe`.

- [ ] **Step 7: Gmail, `Retry-After` on 429 (optional, read-only burst)**

```bash
seq 1 400 | xargs -P 40 -I{} curl -sS -o /dev/null -D - -H "Authorization: Bearer $GMAIL_TOKEN" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/$ID?format=metadata" \
  | grep -iE '^(HTTP/|retry-after)' | sort | uniq -c
```

Expected: mostly `HTTP/2 200`; any `HTTP/2 429` lines show whether a `retry-after` header accompanies them. Stop after one run (this spends about 8,000 quota units of the 6,000 per minute allowance, which is the point; it only reads).

- [ ] **Step 8: Sanitize before anything leaves the folder**

Create `.superpowers/recordings/sanitize.mjs`:

```js
// Re-synthesizes a recorded provider JSON response so it can be committed as a fixture.
// Usage: node sanitize.mjs <in.json> <out.json>
// Keeps structure, keys, numbers, booleans, dates and known enum values. Replaces every id, address,
// subject, snippet, header value and URL query with synthetic values. Fails if anything address-like survives.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node sanitize.mjs <in.json> <out.json>");
  process.exit(2);
}

const KEEP_KEYS = new Set([
  "flagStatus", "importance", "inferenceClassification", "@odata.type", "reason", "code", "status",
  "mimeType", "type", "token_type", "displayName", "wellKnownName",
]);
const DATE_KEYS = /DateTime$|^internalDate$|^date$|^timestamp$/;
const ID_KEYS = /(^id$|Id$|^threadId$|^historyId$|ChangeKey$|^@odata\.etag$)/;
const URL_KEYS = /(Link$|^webLink$|^@odata\.context$)/;
const SYSTEM_LABELS = /^(INBOX|SENT|TRASH|SPAM|DRAFT|UNREAD|STARRED|IMPORTANT|CHAT|CATEGORY_[A-Z]+)$/;

const ids = new Map();
const addresses = new Map();
const pseudoId = (value) => {
  if (!ids.has(value)) ids.set(value, `id-${String(ids.size + 1).padStart(4, "0")}`);
  return ids.get(value);
};
const pseudoAddress = (value) => {
  const key = value.toLowerCase();
  if (!addresses.has(key)) addresses.set(key, `user${String(addresses.size + 1)}@example.com`);
  return addresses.get(key);
};

function sanitizeHeader(header) {
  const name = String(header.name);
  if (/^content-type$/i.test(name)) return { name, value: String(header.value).split(";")[0] };
  if (/^authentication-results$/i.test(name)) {
    const methods = [...String(header.value).matchAll(/\b(spf|dkim|dmarc|compauth)=([a-z]+)/gi)].map((m) => `${m[1]}=${m[2]}`);
    const authserv = /^\s*mx\.google\.com\s*;/i.test(String(header.value)) ? "mx.google.com; " : "";
    return { name, value: `${authserv}${methods.join("; ")}` };
  }
  if (/^list-unsubscribe-post$/i.test(name)) return { name, value: String(header.value) };
  return { name, value: "redacted" };
}

function walk(value, key) {
  if (Array.isArray(value)) {
    if (key === "headers" || key === "internetMessageHeaders") return value.map(sanitizeHeader);
    return value.map((item) => walk(item, key));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    return out;
  }
  if (typeof value !== "string") return value;
  if (key === "labelIds") return SYSTEM_LABELS.test(value) ? value : pseudoId(value);
  if (KEEP_KEYS.has(key)) return value;
  if (DATE_KEYS.test(key)) return value;
  if (key === "address" || key === "emailAddress" || key === "mail" || key === "userPrincipalName" || key === "sendAsEmail") {
    return pseudoAddress(value);
  }
  if (URL_KEYS.test(key)) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? "?redacted" : ""}`;
    } catch {
      return "redacted";
    }
  }
  if (key === "conversationIndex") return Buffer.alloc(Buffer.from(value, "base64").length, 1).toString("base64");
  if (ID_KEYS.test(key)) return pseudoId(value);
  if (key === "name") return "Redacted Name";
  return value === "" ? value : "redacted";
}

const sanitized = walk(JSON.parse(readFileSync(input, "utf8")), "");
const text = `${JSON.stringify(sanitized, null, 2)}\n`;
const leaked = text.match(/[A-Za-z0-9._%+-]+@(?![a-z0-9-]*\.?example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
if (leaked) {
  console.error(`refusing to write: ${leaked.length} address-like strings survived`);
  process.exit(1);
}
writeFileSync(output, text);
console.log(`wrote ${output}: ${ids.size} ids and ${addresses.size} addresses re-synthesized`);
```

```bash
node sanitize.mjs graph-list.json recorded-graph-list.json
node sanitize.mjs gmail-meta.json recorded-gmail-metadata.json
grep -nE '@' recorded-*.json | grep -v 'example\.com' || echo "no foreign addresses"
```

Expected: `wrote recorded-...: N ids and M addresses re-synthesized` and `no foreign addresses`. Then read every recorded file by eye: no names, subjects, snippets, ids or URL queries may remain. Only copy a sanitized file into `packages/core/test/fixtures/{gmail,graph}/` if a test will use it, and rename its synthetic addresses to `owner@example.test` style where meaningful.

- [ ] **Step 9: Record the findings and clean up**

Update the "Unresolved" list in `docs/superpowers/research/mail-providers.md`: replace each answered item with `[Verified by owner fixture YYYY-MM-DD]` plus the observed answer (booleans, status codes and error codes only, no mailbox data). If an answer contradicts a decision in this plan (for example filtered delta does not continue), open an issue and adjust the provider in a follow-up task.

```bash
cd ../.. && rm -rf .superpowers/recordings && unset GMAIL_TOKEN GRAPH_TOKEN
pnpm lint
git add docs/superpowers/research/mail-providers.md
git commit -m "docs: record verified mail provider behaviors from owner fixtures"
```

Expected: `pnpm lint` passes (no em dash, no secrets). Revoke the playground grant at `https://myaccount.google.com/permissions` and sign out of Graph Explorer.

---

## Produces summary (for plans 03 and 04)

Exports of `@clearbox/core` added or extended by this plan:

| Export | Signature | Used by |
|---|---|---|
| `createGmailProvider` | `(deps: ProviderDeps) => MailProvider` | 03 `scan/providers.ts`, `oauth/connect.ts`; 04 tick |
| `createGraphProvider` | `(deps: GraphProviderDeps) => MailProvider` (`archiveFolderId` from `accounts.archive_folder_id`) | 03, 04 |
| `MailProvider.inboxEstimate` | `() => Promise<number \| null>` (one request, best effort; A4) | 03 `completeConnect` (once at connect); 04 `fetchInboxEstimate` (at most daily during backfill); both write `accounts.inbox_estimate`; 03 `FakeProvider` implements it |
| `buildGoogleAuthorizeUrl`, `buildMicrosoftAuthorizeUrl` | `(cfg: OAuthClientConfig, p: AuthorizeParams) => string` | 03 `/oauth/*/start` |
| `exchangeGoogleCode`, `exchangeMicrosoftCode` | `(f, cfg, code, codeVerifier, now) => Promise<OAuthTokens>` | 03 callback |
| `refreshGoogleToken`, `refreshMicrosoftToken` | `(f, cfg, refreshToken, now) => Promise<OAuthTokens>`; Microsoft `refreshToken` is rotated and must be persisted | 03/04 `D1TokenSource` |
| `revokeGoogleToken` | `(f, token) => Promise<boolean>` | 03 disconnect, scope-missing |
| `hasGmailScope`, `hasGraphScopes` | `(granted: readonly string[]) => boolean` | 03 callback |
| `classifyGoogleOAuthError`, `classifyMicrosoftOAuthError` | `(status, body, headers, now) => ClearboxError` | internal; exported for worker tests |
| `classifyGmailApiError`, `classifyGraphApiError` | same | internal; exported for worker tests |
| `GOOGLE_TOKEN_ENDPOINT`, `MICROSOFT_TOKEN_ENDPOINT`, `GMAIL_MODIFY_SCOPE` | constants | 03 |
| `buildGmailDeepLink` | `(email: string, providerMessageId: string) => string` | 03 queue group detail `deepLink` |
| `mapGmailMessage`, `mapGraphMessage` | wire message to `MailMessage` | eval and tests |
| `buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`, `parseTokenResponse`, `TokenEndpoint` | shell | internal |
| `buildBatchBody`, `parseBatchResponse`, `boundaryFromContentType`, `BatchRequestPart`, `BatchResponsePart` | multipart codec | internal |

Behavior later plans rely on: requests are sequential; whole-call failures throw contracts 4.12 errors (`ProviderRateLimitError.retryAfterMs` always set); per-item action failures are `ActionResult` values; `CursorExpiredError.cursorKind` tells the tick which cursor to reset; `newId` from Graph moves must be stored for undo; Gmail ids never change.

---

## Self-review

1. **Spec coverage.** Gmail OAuth (PKCE S256, offline, consent, exchange, refresh, scope check, revoke): Task 4. Gmail profile and aliases: Task 8. Inbox list with `labelIds=INBOX`, metadata batch with the exact header list and `fields`, robust multipart parser: Tasks 1, 6, 8. History sync with 404 resync and catch-up: Tasks 6, 9. Sent recipients and thread ids: Tasks 6, 8. Trash, archive, restore with untrash plus INBOX re-add: Task 10. Deep link: Task 6. Gmail error mapping (rate limit with Retry-After, daily limit until UTC midnight, domain policy, invalid_grant, config errors): Task 4. Graph OAuth (common tenant, `response_mode=query`, PKCE, rotated refresh token, no revoke): Task 5. `$select`, immutable id and `maxpagesize` Prefer headers: Tasks 7, 11, 12. Delta with 410 and `syncStateNotFound`: Tasks 5, 12. JSON `$batch` (20) with per-response status and out-of-order correlation: Tasks 5, 11, 13. Archive folder resolution and fallback: Tasks 11, 13. Moves returning new ids: Task 13. Sent items recipients and conversation ids: Tasks 7, 11, 12. `webLink`: Task 7. Throttling (429 Retry-After, sequential requests, `maxInFlight === 1`): Tasks 8, 11. Header parsing and RFC 2047 (B, Q, UTF-8, ISO-8859-1, split adjacent words, unknown charset), List-Unsubscribe(-Post), Precedence, Auto-Submitted, Authentication-Results selection, Return-Path: Tasks 2, 6, 7 on top of plan 01's `text/*`. A4 inbox estimate: Tasks 3, 8, 11. Error classification tables, token rotation, scope checks, paging, partial batch failures, resync paths: Tasks 4 to 13. Record real fixtures: Task 15.
2. **Placeholder scan.** No "TBD" or "implement later". The `notImplemented()` stubs in Tasks 8 and 11 are deliberate red states that Tasks 9, 10, 12 and 13 replace with the exact code shown.
3. **Type consistency.** `classifyPart`, `toActionOutcome`, `ActionOutcome`, `PartOutcome` (Task 4) are the names imported in Tasks 8 and 10; `graphMoveResult`, `subRetryAfter`, `isDeltaExpired` (Task 5) are the names imported in Tasks 11 to 13; Gmail `IncrementalState`, `decodeIncremental`, `encodeIncremental`, `pageTokenOf`, `pageCursor`, `scanHistory` (Task 6) match Tasks 8 and 9; Graph `IncrementalState`, `decodeIncremental` (Task 7) match Tasks 11 and 12; `bestEffortCount`, `stringField`, `chunkIds` (Task 2) match Tasks 8 and 11. Every code block in this plan was compiled with TypeScript 6.0.3, linted with ESLint 10.12.0 and typescript-eslint 8.71.2, formatted with Prettier 3.9.10 and run with Vitest 5.0.4 and MSW 3.0.3 against a snapshot of plan 01's core (606 tests passing, of which 252 are plan 02's), including each intermediate stage of `gmail.ts` and `graph.ts`.
