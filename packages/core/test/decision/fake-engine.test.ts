import { describe, expect, it } from "vitest";
import type { DecisionInput } from "../../src/decision/engine.ts";
import { FakeEngine } from "../../src/decision/fake-engine.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { DecisionError } from "../../src/model/errors.ts";
import type { MailMessageOverrides } from "../fixtures/builders.ts";
import { makeDecisionResult, makeMailMessage, makeSignals } from "../fixtures/builders.ts";
import type { Signals } from "../../src/signals/signals.ts";

function input(msg: MailMessageOverrides = {}, signals: Partial<Signals> = {}, key = "msg-1"): DecisionInput {
  return {
    key,
    seed: 1,
    state: buildDecisionState({
      msg: makeMailMessage(msg),
      signals: makeSignals(signals),
      pastDecisions: [],
    }),
  };
}

describe("FakeEngine", () => {
  it("is named fake and records calls", async () => {
    const engine = new FakeEngine();
    const i = input();
    await engine.decide(i);
    expect(engine.name).toBe("fake");
    expect(engine.calls).toEqual([i]);
  });

  it.each([
    ["correspondent", {}, { isCorrespondent: true }, [0.02, 0.08, 0.85, 0.05]],
    ["record subject", { subject: "Your order receipt" }, {}, [0.05, 0.8, 0.1, 0.05]],
    ["unread list mail", {}, { hasListUnsubscribe: true, isRead: false }, [0.9, 0.04, 0.03, 0.03]],
    ["read list mail", {}, { hasListUnsubscribe: true, isRead: true }, [0.6, 0.2, 0.1, 0.1]],
    ["otherwise", {}, {}, [0.15, 0.2, 0.3, 0.35]],
  ] as const)("rule: %s", async (_name, msg, signals, expected) => {
    const result = await new FakeEngine().decide(input(msg, signals));
    expect([result.action.delete, result.action.archive, result.action.keep, result.action.unsure]).toEqual(
      expected,
    );
  });

  it("first matching rule wins (correspondent before record subject)", async () => {
    const result = await new FakeEngine().decide(input({ subject: "Invoice" }, { isCorrespondent: true }));
    expect(result.action.keep).toBe(0.85);
  });

  it("computes flags and importance independently", async () => {
    const r1 = await new FakeEngine().decide(input({ subject: "Statement ready, last chance" }));
    expect(r1.flags).toEqual({ isRecord: 0.9, isExpired: 0.9, isFromHuman: 0.05 });
    expect(r1.importance).toBe(1);

    const r2 = await new FakeEngine().decide(input({ subject: "Lunch?" }, { isCorrespondent: true }));
    expect(r2.flags).toEqual({ isRecord: 0.05, isExpired: 0.1, isFromHuman: 0.9 });
    expect(r2.importance).toBe(3);

    const r3 = await new FakeEngine().decide(input({ subject: "Hello" }));
    expect(r3.importance).toBe(0.5);
  });

  it("fills metadata deterministically", async () => {
    const i = input();
    const result = await new FakeEngine().decide(i);
    expect(result.responseModel).toBe("fake-1");
    expect(result.modelVersion).toBe("fake/fake-1");
    expect(result.inputTokens).toBe(Math.ceil(JSON.stringify(i.state).length / 3.5) + 250);
    expect([result.latencyMs, result.requestId]).toEqual([0, null]);
  });

  it("returns overrides and throws override errors per key", async () => {
    const canned = makeDecisionResult({ importance: 4 });
    const failure = new DecisionError({ kind: "rate_limited", status: 429 });
    const engine = new FakeEngine({
      overrides: new Map<string, typeof canned | DecisionError>([
        ["ok-key", canned],
        ["bad-key", failure],
      ]),
    });
    expect(await engine.decide(input({}, {}, "ok-key"))).toBe(canned);
    await expect(engine.decide(input({}, {}, "bad-key"))).rejects.toBe(failure);
    expect(engine.calls.map((c) => c.key)).toEqual(["ok-key", "bad-key"]);
  });
});
