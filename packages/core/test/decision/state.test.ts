import { describe, expect, it } from "vitest";
import { buildDecisionState, type PastDecision } from "../../src/decision/state.ts";
import { DECISION_STATE_MAX_CHARS } from "../../src/model/constants.ts";
import { makeMailMessage, makeSignals } from "../fixtures/builders.ts";

function past(n: number, subject = "Flash sale: boots 30% off"): PastDecision[] {
  return Array.from({ length: n }, () => ({
    domain: "shop.example.com",
    subject,
    owner_action: "delete" as const,
  }));
}

describe("buildDecisionState", () => {
  it("maps message and signals to the snake_case state", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Last chance", snippet: "Ends tonight" }),
      signals: makeSignals({
        hasListUnsubscribe: true,
        precedenceBulk: true,
        category: "promotions",
        isRead: false,
        ageDays: 41,
        senderSeenCount: 37,
        senderOpenRate: 1 / 3,
        ownerDeleteRate: 0.666666,
        ownerDecisions: 14,
        auth: { spf: "pass", dkim: "pass", dmarc: "fail" },
      }),
      pastDecisions: past(1),
    });
    expect(state).toEqual({
      email: {
        from: "news@shop.example.com",
        domain: "example.com",
        subject: "Last chance",
        snippet: "Ends tonight",
        age_days: 41,
        signals: {
          has_list_unsubscribe: true,
          precedence_bulk: true,
          auto_submitted: false,
          category: "promotions",
          is_read: false,
          has_attachments: false,
          owner_position: "to",
          thread_depth: 1,
          provider_important: false,
          auth: { spf: "pass", dkim: "pass", dmarc: "fail" },
        },
      },
      sender_history: {
        messages_seen: 37,
        open_rate: 0.33,
        owner_delete_rate: 0.67,
        owner_decisions: 14,
        is_correspondent: false,
      },
      similar_past_decisions: past(1),
    });
  });

  it("uses 'unknown' for an unparseable sender", () => {
    const state = buildDecisionState({
      msg: makeMailMessage(),
      signals: makeSignals({ senderAddress: "", senderDomain: "" }),
      pastDecisions: [],
    });
    expect(state.email.from).toBe("unknown");
    expect(state.email.domain).toBe("");
  });

  it("caps subject, snippet, past decision count and past subjects", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "s".repeat(500), snippet: "n".repeat(500) }),
      signals: makeSignals(),
      pastDecisions: past(9, "p".repeat(100)),
    });
    expect(state.email.subject).toHaveLength(120);
    expect(state.similar_past_decisions.length).toBeLessThanOrEqual(5);
    for (const d of state.similar_past_decisions) expect(d.subject).toHaveLength(60);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("keeps everything when the state already fits", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: "n".repeat(300) }),
      signals: makeSignals(),
      pastDecisions: past(5, "short"),
    });
    expect(state.similar_past_decisions).toHaveLength(5);
    expect(state.email.snippet).toHaveLength(300);
  });

  it("drops past decisions from the end first", () => {
    const decisions = Array.from({ length: 5 }, (_, i) => ({
      domain: `d${String(i)}.example.com`,
      subject: "\u0001".repeat(60),
      owner_action: "keep" as const,
    }));
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: "n".repeat(300) }),
      signals: makeSignals(),
      pastDecisions: decisions,
    });
    expect(state.similar_past_decisions.length).toBeLessThan(5);
    expect(state.similar_past_decisions.map((d) => d.domain)).toEqual(
      decisions.slice(0, state.similar_past_decisions.length).map((d) => d.domain),
    );
    expect(state.email.snippet).toHaveLength(300);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  // JSON escapes each U+0001 as 6 chars, so these fields are expensive. The base state is about 520 chars.
  const heavy = (n: number): string => "\u0001".repeat(n);

  it("then shrinks the snippet to 150 chars", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: "Hi", snippet: heavy(250) }),
      signals: makeSignals(),
      pastDecisions: past(5),
    });
    expect(state.similar_past_decisions).toEqual([]);
    expect(state.email.snippet).toHaveLength(150);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("then empties the snippet", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals(),
      pastDecisions: [],
    });
    expect(state.email.snippet).toBe("");
    expect(state.email.subject).toHaveLength(120);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("then shrinks the subject to 60 chars", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals({ senderDomain: heavy(100) }),
      pastDecisions: [],
    });
    expect(state.email.snippet).toBe("");
    expect(state.email.subject).toHaveLength(60);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });

  it("finally empties the subject", () => {
    const state = buildDecisionState({
      msg: makeMailMessage({ subject: heavy(120), snippet: heavy(300) }),
      signals: makeSignals({ senderDomain: heavy(200) }),
      pastDecisions: [],
    });
    expect(state.email.subject).toBe("");
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(DECISION_STATE_MAX_CHARS);
  });
});
