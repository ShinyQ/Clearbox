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
