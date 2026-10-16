import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/util/concurrency.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("keeps input order in the results", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${String(i)}:${String(ms)}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than limit calls at once", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, () => deferred());
    const run = mapWithConcurrency(gates, 4, async (gate) => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return true;
    });
    for (const gate of gates) {
      await Promise.resolve();
      gate.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await run;
    expect(peak).toBe(4);
  });

  it("returns [] for no items", async () => {
    expect(await mapWithConcurrency([], 3, () => Promise.resolve(1))).toEqual([]);
  });

  it("rejects with the first error", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) =>
        n === 2 ? Promise.reject(new Error("boom")) : Promise.resolve(n),
      ),
    ).rejects.toThrow("boom");
  });

  it("rejects a non-positive limit", async () => {
    await expect(mapWithConcurrency([1], 0, (n) => Promise.resolve(n))).rejects.toThrow(RangeError);
  });
});
