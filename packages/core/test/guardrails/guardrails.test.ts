import { describe, expect, it } from "vitest";
import { evaluateGuardrails, type GuardrailInput } from "../../src/guardrails/guardrails.ts";
import type { Ceiling } from "../../src/model/actions.ts";
import type { ReasonCode } from "../../src/model/reasons.ts";
import type { Signals } from "../../src/signals/signals.ts";
import { makePolicy, makeSignals } from "../fixtures/builders.ts";

function input(signals: Partial<Signals> = {}, subject = "Weekly picks", snippet = ""): GuardrailInput {
  return { signals: makeSignals(signals), subject, snippet };
}

const SENDER = { senderAddress: "news@shop.example.com", senderDomain: "example.com" };
const ALLOW = makePolicy({ allowlist: ["news@shop.example.com"] });
const DENY = makePolicy({ denylist: ["@example.com"] });

describe("evaluateGuardrails", () => {
  it("allows delete when nothing matches", () => {
    expect(evaluateGuardrails(input(), makePolicy())).toEqual({
      ceiling: "delete",
      reasons: [],
      allowlisted: false,
      denylisted: false,
      liftedByDenylist: false,
    });
  });

  // Ceiling matrix: every rule alone, with and without the denylist.
  const matrix: {
    name: string;
    signals: Partial<Signals>;
    subject?: string;
    policy: "plain" | "allow";
    ceiling: Ceiling;
    code: ReasonCode;
    deniedCeiling: Ceiling;
  }[] = [
    {
      name: "starred",
      signals: { starred: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_starred",
      deniedCeiling: "keep",
    },
    {
      name: "owner replied",
      signals: { ownerReplied: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_replied",
      deniedCeiling: "keep",
    },
    {
      name: "too recent",
      signals: { ageDays: 2 },
      policy: "plain",
      ceiling: "keep",
      code: "guard_too_recent",
      deniedCeiling: "keep",
    },
    {
      name: "correspondent",
      signals: { isCorrespondent: true },
      policy: "plain",
      ceiling: "keep",
      code: "guard_correspondent",
      deniedCeiling: "delete",
    },
    {
      name: "attachment",
      signals: { hasAttachments: true },
      policy: "plain",
      ceiling: "archive",
      code: "guard_attachment",
      deniedCeiling: "delete",
    },
    {
      name: "record pattern",
      signals: {},
      subject: "Your invoice #42",
      policy: "plain",
      ceiling: "archive",
      code: "guard_record_pattern",
      deniedCeiling: "delete",
    },
  ];

  it.each(matrix)("$name caps at $ceiling ($code), denylisted -> $deniedCeiling", (row) => {
    const plain = evaluateGuardrails(input({ ...SENDER, ...row.signals }, row.subject), makePolicy());
    expect(plain.ceiling).toBe(row.ceiling);
    expect(plain.reasons.map((r) => r.code)).toEqual([row.code]);

    const denied = evaluateGuardrails(input({ ...SENDER, ...row.signals }, row.subject), DENY);
    expect(denied.denylisted).toBe(true);
    expect(denied.ceiling).toBe(row.deniedCeiling);
    // A cap the denylist skipped keeps the normal confidence check (contracts 12.10).
    expect(denied.liftedByDenylist).toBe(row.deniedCeiling === "delete");
  });

  it("allowlist caps at keep and beats the denylist", () => {
    const result = evaluateGuardrails(
      input(SENDER),
      makePolicy({ allowlist: ALLOW.allowlist, denylist: DENY.denylist }),
    );
    expect(result).toMatchObject({ ceiling: "keep", allowlisted: true, denylisted: false });
    expect(result.reasons.map((r) => r.code)).toEqual(["guard_allowlist"]);
  });

  it("denylist alone does not cap and adds no cap reason", () => {
    const result = evaluateGuardrails(input(SENDER), DENY);
    expect(result).toEqual({
      ceiling: "delete",
      reasons: [],
      allowlisted: false,
      denylisted: true,
      liftedByDenylist: false,
    });
  });

  it("reports every cap in rule order with params", () => {
    const result = evaluateGuardrails(
      input(
        { starred: true, ownerReplied: true, ageDays: 0, isCorrespondent: true, hasAttachments: true },
        "Tax statement",
      ),
      makePolicy({ minAgeDays: 3 }),
    );
    expect(result.ceiling).toBe("keep");
    expect(result.reasons).toEqual([
      { code: "guard_starred", params: {} },
      { code: "guard_replied", params: {} },
      { code: "guard_too_recent", params: { minAgeDays: 3 } },
      { code: "guard_correspondent", params: {} },
      { code: "guard_attachment", params: {} },
      { code: "guard_record_pattern", params: { pattern: "tax" } },
    ]);
  });

  it("minAgeDays 0 never triggers too recent", () => {
    expect(evaluateGuardrails(input({ ageDays: 0 }), makePolicy({ minAgeDays: 0 })).ceiling).toBe("delete");
  });

  it("matches record patterns in the snippet", () => {
    expect(evaluateGuardrails(input({}, "Hello", "your medical results"), makePolicy()).ceiling).toBe(
      "archive",
    );
  });

  it("ignores providerImportant", () => {
    expect(evaluateGuardrails(input({ providerImportant: true }), makePolicy()).ceiling).toBe("delete");
  });
});
