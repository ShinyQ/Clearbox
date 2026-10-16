import { describe, expect, it } from "vitest";
import type { DecisionEngine, DecisionInput, DecisionResult } from "../../src/decision/engine.ts";
import { FakeEngine } from "../../src/decision/fake-engine.ts";
import { decideAll } from "../../src/decision/run.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError } from "../../src/model/errors.ts";
import { makeDecisionResult, makeMailMessage, makeSignals } from "../fixtures/builders.ts";

function inputs(n: number): DecisionInput[] {
  const state = buildDecisionState({ msg: makeMailMessage(), signals: makeSignals(), pastDecisions: [] });
  return Array.from({ length: n }, (_, i) => ({ key: `msg-${String(i)}`, seed: i, state }));
}

describe("decideAll", () => {
  it("returns one settled outcome per input, in input order", async () => {
    const failure = new DecisionError({ kind: "server", status: 503 });
    const engine = new FakeEngine({ overrides: new Map([["msg-1", failure]]) });
    const outcomes = await decideAll(engine, inputs(3), 4);
    expect(outcomes.map((o) => [o.key, o.ok])).toEqual([
      ["msg-0", true],
      ["msg-1", false],
      ["msg-2", true],
    ]);
    const second = outcomes[1];
    expect(second?.ok === false ? second.error : null).toBe(failure);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const engine: DecisionEngine = {
      name: "fake",
      async decide(): Promise<DecisionResult> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return makeDecisionResult();
      },
    };
    await decideAll(engine, inputs(10), 4);
    expect(peak).toBe(4);
  });

  it("wraps unexpected errors as retryable network DecisionErrors and never rejects", async () => {
    const engine: DecisionEngine = { name: "fake", decide: () => Promise.reject(new TypeError("boom")) };
    const [outcome] = await decideAll(engine, inputs(1), 4);
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) {
      expect(outcome.error.kind).toBe("network");
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it("handles an empty input list", async () => {
    expect(await decideAll(new FakeEngine(), [], 4)).toEqual([]);
  });
});
