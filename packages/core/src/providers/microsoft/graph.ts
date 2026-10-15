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
import type { GraphBatchSubRequest, GraphBatchSubResponse, GraphHeader, GraphMessage } from "./types.ts";

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

function isGraphHeader(value: unknown): value is GraphHeader {
  return isJsonObject(value) && typeof value.name === "string" && typeof value.value === "string";
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
      const headers: unknown =
        sub.status === 200 && isJsonObject(sub.body) ? sub.body.internetMessageHeaders : undefined;
      fetched.set(message.id, Array.isArray(headers) ? headers.filter(isGraphHeader) : []);
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
    syncChanges: (cursor, maxMessages) => syncChanges(client, cursor, maxMessages),
    resyncCursor: (watermark) => resyncCursor(client, watermark),
    inboxEstimate: () => getInboxEstimate(client),
    trash: () => notImplemented(),
    archive: () => notImplemented(),
    restore: () => notImplemented(),
  };
}
