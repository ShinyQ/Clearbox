import { FakeEngine } from "@clearbox/core";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { runTickInternal } from "../../../src/worker/scan/tick.ts";
import type { TickTimings } from "../../../src/worker/scan/tick.ts";
import { ProviderMock, expectNoUnhandled, mail, useNetwork } from "../helpers/provider-mock.ts";
import { MINUTE, NOW, resetDb, seedTickAccount } from "../helpers/tick-db.ts";
import { network } from "../setup/network.ts";

const RUNS = 21; // first run is warm-up
const PURE_BUDGET_MS = 8;
const PROXY_BUDGET_MS = 10;

afterEach(expectNoUnhandled);

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("tick CPU (25-message page, FakeEngine, MSW Graph provider)", () => {
  it("runs where timers advance during synchronous work (local workerd)", () => {
    const start = performance.now();
    let spins = 0;
    for (let i = 0; i < 5_000_000 && performance.now() - start < 2; i++) spins += 1;
    expect(spins).toBeGreaterThan(0);
    expect(
      performance.now() - start,
      "timers are frozen in this runtime; run the benchmark under local workerd",
    ).toBeGreaterThan(0);
  });

  it("keeps pure compute under 8 ms and wall minus I/O under 10 ms per tick", async () => {
    const pure: number[] = [];
    const proxy: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      network.resetHandlers();
      await resetDb();
      await seedTickAccount({ phase: "inbox_backfill", lastIncrementalAt: NOW - MINUTE });
      const mock = new ProviderMock();
      mock.inbox = Array.from({ length: 25 }, (_, i) =>
        mail(i, { listUnsubscribe: i % 2 === 0, isRead: i % 3 === 0 }),
      );
      useNetwork(mock.handlers());
      const timings: TickTimings = { wallMs: 0, ioMs: 0, pureMs: 0 };
      const report = await runTickInternal(
        env,
        { trigger: "cron", now: NOW, engine: new FakeEngine() },
        { timings },
      );
      expect(report).toMatchObject({ outcome: "processed", fetched: 25, decided: 25, errorCode: null });
      if (run === 0) continue;
      pure.push(timings.pureMs);
      proxy.push(timings.wallMs - timings.ioMs);
    }
    expect(pure).toHaveLength(RUNS - 1);
    // eslint-disable-next-line no-console
    console.info(
      `tick CPU: pure median ${median(pure).toFixed(2)} ms, wall minus I/O median ${median(proxy).toFixed(2)} ms, samples ${pure.length}`,
    );
    expect(median(pure)).toBeLessThan(PURE_BUDGET_MS);
    expect(median(proxy)).toBeLessThan(PROXY_BUDGET_MS);
  });
});
