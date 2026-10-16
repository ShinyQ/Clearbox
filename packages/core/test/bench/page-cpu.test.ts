import { describe, expect, it } from "vitest";
import { buildDecisionRequest, decisionSeed } from "../../src/decision/questions.ts";
import { buildDecisionState } from "../../src/decision/state.ts";
import { fuse } from "../../src/fusion/fusion.ts";
import { evaluateGuardrails } from "../../src/guardrails/guardrails.ts";
import { DELETE_MARGIN, MIN_CONFIDENCE, TAU_DELETE_DEFAULT } from "../../src/model/constants.ts";
import { DEFAULT_POLICY } from "../../src/policy/policy.ts";
import { selectPrior } from "../../src/priors/priors.ts";
import { extractSignals } from "../../src/signals/signals.ts";
import {
  DAY_MS,
  TEST_NOW,
  makeDecisionResult,
  makeMailMessage,
  makeSenderHistory,
} from "../fixtures/builders.ts";

const PAGE = Array.from({ length: 25 }, (_, i) =>
  makeMailMessage({
    providerMessageId: `msg-${String(i)}`,
    threadId: `thr-${String(i)}`,
    receivedAt: TEST_NOW - (i + 1) * DAY_MS,
    from: {
      address: `sender${String(i % 7)}@news${String(i % 3)}.example.com`,
      name: "=?UTF-8?B?Q2Fmw6k=?=",
    },
    subject: i % 4 === 0 ? "Your receipt for order 1234" : `Weekly deals number ${String(i)} ends tonight`,
    snippet: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4),
    category: i % 2 === 0 ? "promotions" : "updates",
    isRead: i % 3 === 0,
    headers: {
      listUnsubscribe: "<https://news.example.com/u/1>, <mailto:u@news.example.com>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      precedence: "bulk",
      returnPath: "<bounce@mailer.esp.example.net>",
      authenticationResults:
        "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=x; dmarc=pass",
    },
  }),
);
const PAST = Array.from({ length: 5 }, () => ({
  domain: "example.com",
  subject: "Flash sale: boots 30% off",
  owner_action: "delete" as const,
}));
const RESULT = makeDecisionResult({ action: { delete: 0.9, archive: 0.04, keep: 0.03, unsure: 0.03 } });
const TH = { tauDelete: TAU_DELETE_DEFAULT, deleteMargin: DELETE_MARGIN, minConfidence: MIN_CONFIDENCE };
const ctx = { now: TEST_NOW, ownerAddresses: ["owner@example.test"], repliedThreadIds: new Set(["thr-3"]) };

function processPage(): number {
  let checksum = 0;
  for (const msg of PAGE) {
    const history = makeSenderHistory({ seenCount: 12, readCount: 1, senderPrior: { deletes: 4, keeps: 1 } });
    const signals = extractSignals(msg, history, ctx);
    const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, DEFAULT_POLICY);
    const prior = selectPrior(
      history.senderPrior,
      history.domainPrior,
      signals.senderAddress,
      signals.senderDomain,
    );
    const state = buildDecisionState({ msg, signals, pastDecisions: PAST });
    const body = JSON.stringify(
      buildDecisionRequest(state, "decision-1", decisionSeed("acc_0123456789abcdef", msg.providerMessageId)),
    );
    const suggestion = fuse({ model: RESULT, prior, guard, signals, thresholds: TH });
    checksum += body.length + suggestion.confidence;
  }
  return checksum;
}

describe("page CPU budget", () => {
  it("processes a 25-message page in <= 6 ms median over 50 runs", () => {
    for (let i = 0; i < 5; i++) processPage();
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      processPage();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[25] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThanOrEqual(6);
  });
});
