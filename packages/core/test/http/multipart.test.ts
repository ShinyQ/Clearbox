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
