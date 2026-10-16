import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { backoffMs, countingFetch, createSubrequestCounter, parseRetryAfter } from "../../src/http/fetch.ts";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../../src/model/constants.ts";
import { SubrequestBudgetError } from "../../src/model/errors.ts";
import { server } from "../setup/msw.ts";

describe("createSubrequestCounter", () => {
  it("counts reservations up to the limit", () => {
    const counter = createSubrequestCounter(3, 1);
    counter.reserve();
    counter.reserve(1);
    expect(counter.used).toBe(3);
    expect(counter.limit).toBe(3);
  });

  it("throws SubrequestBudgetError when used + n > limit and does not count it", () => {
    const counter = createSubrequestCounter(2);
    counter.reserve(2);
    try {
      counter.reserve();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SubrequestBudgetError);
      expect((error as SubrequestBudgetError).code).toBe("subrequest_budget");
      expect((error as SubrequestBudgetError).used).toBe(2);
      expect((error as SubrequestBudgetError).limit).toBe(2);
    }
    expect(counter.used).toBe(2);
  });
});

describe("countingFetch", () => {
  it("reserves one subrequest per call before fetching", async () => {
    server.use(http.get("https://api.example.test/ping", () => HttpResponse.json({ ok: true })));
    const counter = createSubrequestCounter(1);
    const f = countingFetch(fetch, counter);
    const res = await f("https://api.example.test/ping");
    expect(await res.json()).toEqual({ ok: true });
    expect(counter.used).toBe(1);
    await expect(f("https://api.example.test/ping")).rejects.toBeInstanceOf(SubrequestBudgetError);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);

  it("prefers retry-after-ms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "1500", "retry-after": "9" }), now)).toBe(1500);
  });

  it("reads delta-seconds", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
  });

  it("reads an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 15 Oct 2026 12:01:00 GMT" }), now)).toBe(
      60_000,
    );
    expect(parseRetryAfter(new Headers({ "retry-after": "Thu, 15 Oct 2026 11:00:00 GMT" }), now)).toBe(0);
  });

  it("returns null when absent or malformed", () => {
    expect(parseRetryAfter(new Headers(), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "abc" }), now)).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from the base and caps at the max, plus jitter", () => {
    const zero = () => 0;
    expect(backoffMs(1, zero)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, zero)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3, zero)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(20, zero)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(1, () => 0.999)).toBe(BACKOFF_BASE_MS + 999);
  });

  it("treats attempt < 1 as 1", () => {
    expect(backoffMs(0, () => 0)).toBe(BACKOFF_BASE_MS);
  });
});
