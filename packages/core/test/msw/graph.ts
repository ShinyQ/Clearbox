import { http, HttpResponse } from "msw";
import type { FakeFolder, FakeMailbox, FakeMessage } from "./fake-mailbox.ts";
import { CLOSE_CONNECTION } from "./failures.ts";

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

/** Graph returns date-times truncated to the second while Exchange keeps sub-second precision. */
function iso(epoch: number): string {
  return new Date(Math.floor(epoch / 1000) * 1000).toISOString().replace(".000Z", "Z");
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
  // Compares the full-precision receivedAt like Exchange does, not the truncated rendering.
  const filter = /^receivedDateTime (le|lt) (.+)$/.exec(url.searchParams.get("$filter") ?? "");
  const bound = filter === null ? Number.POSITIVE_INFINITY : Date.parse(filter[2] ?? "");
  const all = box
    .inFolder(folder)
    .filter((m) => (filter?.[1] === "lt" ? m.receivedAt < bound : m.receivedAt <= bound));
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
    headers: { "content-type": "application/json", ...result.headers, ...CLOSE_CONNECTION },
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
        return HttpResponse.json({ responses: responses.reverse() }, { headers: CLOSE_CONNECTION });
      });
    }),
    http.all(`${ORIGIN}/*`, ({ request }) => {
      const url = new URL(request.url);
      throw new Error(`Unhandled request ${request.method} ${url.origin}${url.pathname}`);
    }),
  ];
}
