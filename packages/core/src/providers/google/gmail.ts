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
  isHistoryRecord,
  scanHistory,
} from "./map.ts";
import type { IncrementalState } from "./map.ts";
import { classifyGmailApiError, classifyPart, parsePartBody, toActionOutcome } from "./oauth.ts";
import type { ActionOutcome } from "./oauth.ts";
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
 * (429/403-rate, 5xx, missing part; 401 parts after one forceRefresh). Any other non-404 part failure
 * (403 dailyLimitExceeded / domainPolicy / insufficientPermissions, 400, ...) throws at once via
 * classifyGmailApiError. Afterwards: still rate limited -> ProviderRateLimitError; every part of a chunk
 * failed -> ProviderUnavailableError; otherwise 404 and persistent 5xx parts are dropped.
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
    let attempts = 2;
    for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt++) {
      const parts = await client.batch(
        pending.map((r, i) => ({ contentId: `m${String(i)}`, method: "GET", path: r.path })),
      );
      const retry: MetadataRequest[] = [];
      let unauthorized = false;
      rateRetryAfter = undefined;
      for (const [i, request] of pending.entries()) {
        const part = parts.get(`m${String(i)}`);
        const outcome = classifyPart(part, client.deps.now());
        if (outcome.kind === "fail" && part !== undefined && part.status !== 404) {
          // Dropping would lose the message for good (the page token still advances); fail the page instead.
          throw classifyGmailApiError(
            part.status,
            parsePartBody(part.bodyText),
            new Headers(part.headers),
            client.deps.now(),
          );
        }
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
        if (refreshed) throw new ProviderAuthError({ provider: PROVIDER, reason: "unauthorized" });
        await client.deps.tokens.forceRefresh();
        refreshed = true;
        // A part that first turns 401 on its retry still gets one attempt with the refreshed token.
        if (attempt === attempts) attempts++;
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

/**
 * One history.list page (decision 9). The next startHistoryId is the last fully processed record, or the
 * response historyId when every record was processed and there is no nextPageToken. An id that is both
 * added and removed within the page is resolved by its fresh metadata: still in INBOX means added only.
 */
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
  if (!isJsonObject(body) || typeof body.historyId !== "string" || body.historyId === "") {
    throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
  }
  const records: unknown[] = Array.isArray(body.history) ? body.history : [];
  if (!records.every(isHistoryRecord))
    throw new ProviderResponseError({ provider: PROVIDER, status: res.status });
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
  const added = inboxMessages(scan.inbox, metas, "i:");
  const addedIds = new Set(added.map((m) => m.providerMessageId));
  return {
    added,
    removedIds: scan.removed.filter((id) => !addedIds.has(id)),
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

/** Gmail provider (contracts 4.3, 4.3.2). Requests are strictly sequential; no hard delete exists. */
export function createGmailProvider(deps: ProviderDeps): MailProvider {
  const client = makeClient(deps);
  return {
    kind: "gmail",
    bootstrap: () => bootstrap(client),
    listInboxPage: (cursor, pageSize) => listInboxPage(client, cursor, pageSize),
    listSentPage: (cursor, pageSize) => listSentPage(client, cursor, pageSize),
    syncChanges: (cursor, maxMessages) => syncChanges(client, cursor, maxMessages),
    resyncCursor: (watermark) => resyncCursor(client, watermark),
    inboxEstimate: () => getInboxEstimate(client),
    trash: (ids) => trash(client, ids),
    archive: (ids) => archive(client, ids),
    restore: (items) => restore(client, items),
  };
}
