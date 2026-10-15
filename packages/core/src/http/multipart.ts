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
