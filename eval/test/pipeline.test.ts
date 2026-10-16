import { fileURLToPath } from "node:url";
import { DecisionError, FakeEngine } from "@clearbox/core";
import { describe, expect, it } from "vitest";
import { loadFixtures, type EvalFixture } from "../src/fixtures.ts";
import {
  EvalAbortError,
  createPacer,
  optionOrder,
  prepareFixture,
  runEval,
  type Clock,
  type EvalDeps,
} from "../src/pipeline.ts";

const NOW = 1_800_000_000_000;
const FIXTURES = loadFixtures(fileURLToPath(new URL("../fixtures/emails.jsonl", import.meta.url)));

function fixture(id: string): EvalFixture {
  const f = FIXTURES.find((x) => x.id === id);
  if (f === undefined) throw new Error(`missing ${id}`);
  return f;
}

function fakeClock(): Clock & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

function deps(over: Partial<EvalDeps> = {}): EvalDeps {
  return {
    engine: new FakeEngine(),
    clock: fakeClock(),
    now: NOW,
    tauDelete: 0.8,
    concurrency: 2,
    rpm: 1000,
    shuffle: true,
    ...over,
  };
}

describe("prepareFixture", () => {
  it("keeps every state within the 1,750 character budget", () => {
    for (const f of FIXTURES)
      expect(JSON.stringify(prepareFixture(f, NOW).state).length).toBeLessThanOrEqual(1750);
  });

  it("applies the production guardrails", () => {
    expect(prepareFixture(fixture("syn-023"), NOW).guard.ceiling).toBe("keep"); // owner replied
    expect(prepareFixture(fixture("syn-016"), NOW).guard.ceiling).toBe("archive"); // invoice with attachment
    expect(prepareFixture(fixture("syn-001"), NOW).guard.ceiling).toBe("delete"); // old promotion
  });

  it("uses a different option order for the shuffle check", () => {
    for (const f of FIXTURES) {
      const p = prepareFixture(f, NOW);
      expect(optionOrder(p.shuffleSeed)).not.toBe(optionOrder(p.seed));
    }
  });
});

describe("runEval with FakeEngine", () => {
  it("evaluates every fixture twice (baseline and shuffled) without errors", async () => {
    const engine = new FakeEngine();
    const rows = await runEval(FIXTURES, deps({ engine }));
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => r.error === null)).toBe(true);
    expect(engine.calls).toHaveLength(80);
    expect(engine.calls.filter((c) => c.key.endsWith("#shuffle"))).toHaveLength(40);
    expect(rows.map((r) => r.id)).toEqual(FIXTURES.map((f) => f.id));
  });

  it("is deterministic and never suggests deleting human mail", async () => {
    const a = await runEval(FIXTURES, deps());
    const b = await runEval(FIXTURES, deps());
    expect(a.map((r) => r.suggestion)).toEqual(b.map((r) => r.suggestion));
    expect(a.filter((r) => r.category === "human").every((r) => r.suggestion !== "delete")).toBe(true);
    // FakeEngine ignores option order, so the shuffle check finds no flips.
    expect(a.every((r) => r.shuffledModelAction === r.modelAction)).toBe(true);
  });

  it("aborts the run on a configuration error", async () => {
    const engine = new FakeEngine({
      overrides: new Map([
        [
          "syn-001",
          new DecisionError({
            kind: "auth",
            status: 401,
            retryable: false,
            scope: "config",
            retryAfterMs: null,
            requestId: null,
          }),
        ],
      ]),
    });
    await expect(runEval([fixture("syn-001")], deps({ engine }))).rejects.toBeInstanceOf(EvalAbortError);
  });

  it("retries transient errors, then records the failure as unsure", async () => {
    const clock = fakeClock();
    const engine = new FakeEngine({
      overrides: new Map([
        [
          "syn-001",
          new DecisionError({
            kind: "rate_limited",
            status: 429,
            retryable: true,
            scope: "item",
            retryAfterMs: 1500,
            requestId: null,
          }),
        ],
      ]),
    });
    const [r] = await runEval([fixture("syn-001")], deps({ engine, clock, shuffle: false, concurrency: 1 }));
    expect(r?.error).toBe("rate_limited");
    expect(r?.suggestion).toBe("unsure");
    expect(clock.sleeps).toEqual([1500, 1500]);
  });
});

describe("createPacer", () => {
  it("spaces concurrent call starts by 60000 / rpm", async () => {
    const sleeps: number[] = [];
    const frozen: Clock = {
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    const pace = createPacer(60, frozen);
    await Promise.all([pace(), pace(), pace()]);
    expect(sleeps).toEqual([1000, 2000]);
  });
});
