import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, newAccountId, newRequestId } from "../../../src/worker/log.ts";

afterEach(() => vi.restoreAllMocks());

describe("logEvent", () => {
  it("writes one JSON line with app, ts and evt", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("tick.idle", { tickId: "t-1", trigger: "cron" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ app: "clearbox", evt: "tick.idle", tickId: "t-1", trigger: "cron" });
    expect(typeof line["ts"]).toBe("string");
  });

  it("does not let fields override the base keys", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("issue.raised", { evt: "spoofed", app: "other", code: "storage_near_limit", accountId: null });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line["evt"]).toBe("issue.raised");
    expect(line["app"]).toBe("clearbox");
  });
});

describe("id helpers", () => {
  it("creates account ids that satisfy the accounts CHECK", () => {
    const id = newAccountId();
    expect(id).toMatch(/^acc_[0-9a-f]{16}$/);
    expect(newAccountId()).not.toBe(id);
  });
  it("creates uuid request ids", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
