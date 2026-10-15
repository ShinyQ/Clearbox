import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../../src/worker/index.ts";
import { CRON_NIGHTLY, CRON_TICK } from "../../../src/worker/env.ts";
import { apiFetch } from "../helpers/request.ts";

describe("worker entry", () => {
  it("serves the Hono app through exports.default.fetch", async () => {
    const res = await apiFetch("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-Id")).not.toBeNull();
  });

  it.each([CRON_TICK, CRON_NIGHTLY, "*/5 * * * *"])(
    "handles scheduled cron %s without throwing",
    async (cron) => {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ cron, scheduledTime: Date.UTC(2026, 9, 15, 2) }),
        env,
        ctx,
      );
      await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
    },
  );
});
