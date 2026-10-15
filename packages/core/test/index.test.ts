import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";
import * as testing from "./testing.ts";

const RUNTIME_EXPORTS = [
  "ACTION_KINDS",
  "ACTION_RANK",
  "SUGGESTED_ACTIONS",
  "isAllowedByCeiling",
  "minCeiling",
  "REASON_CODES",
  "REASON_TEMPLATES",
  "renderReason",
  "ClearboxError",
  "ProviderAuthError",
  "ProviderConfigError",
  "ProviderRateLimitError",
  "ProviderUnavailableError",
  "CursorExpiredError",
  "ProviderResponseError",
  "SubrequestBudgetError",
  "ScopeMissingError",
  "DecisionError",
  "DECISION_ERROR_RULES",
  "PRIOR_MIN_N",
  "TAU_DELETE_DEFAULT",
  "DECISION_CONCURRENCY",
  "DECISION_RETRY_DELAYS_MS",
  "TICK_SUBREQUEST_LIMIT",
  "MESSAGE_SUBJECT_MAX_CHARS",
  "createSubrequestCounter",
  "countingFetch",
  "parseRetryAfter",
  "backoffMs",
  "fnv1a32",
  "mulberry32",
  "seededShuffle",
  "mapWithConcurrency",
  "decodeEncodedWords",
  "unfoldHeader",
  "parseAddress",
  "parseAddressList",
  "registrableDomain",
  "headerValue",
  "parseAuthResults",
  "parseListUnsubscribe",
  "isBulkPrecedence",
  "isAutoSubmitted",
  "truncateChars",
  "collapseWhitespace",
  "decodeHtmlEntities",
  "GOOGLE_SCOPES",
  "MICROSOFT_SCOPES",
  "MICROSOFT_CONSENT_URLS",
  "extractSignals",
  "SenderEntrySchema",
  "PolicySchema",
  "DEFAULT_POLICY",
  "parsePolicy",
  "matchesSenderList",
  "matchRecordPattern",
  "evaluateGuardrails",
  "priorKeyForSender",
  "priorKeyForDomain",
  "selectPrior",
  "priorDelta",
  "applyOwnerAction",
  "buildDecisionState",
  "DECISION_QUESTIONS",
  "IMPORTANCE_LEVELS",
  "buildDecisionQuestions",
  "buildDecisionRequest",
  "decisionSeed",
  "ChoiceAnswerSchema",
  "ScoreAnswerSchema",
  "NoulAnswerSchema",
  "DecisionResponseSchema",
  "normalizeDecisionResponse",
  "MaiDecisionEngine",
  "DECISION_PATH",
  "decisionErrorKindForStatus",
  "FakeEngine",
  "decideAll",
  "fuse",
  "selectReasons",
  "calibrateTauDelete",
] as const;

describe("@clearbox/core barrel", () => {
  it.each(RUNTIME_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
    expect((core as Record<string, unknown>)[name]).toBeDefined();
  });
});

describe("@clearbox/core/testing", () => {
  it("exports builders and the Decision-1 mock", () => {
    for (const name of [
      "makeMailMessage",
      "makeSignals",
      "makeSenderHistory",
      "makeDecisionResult",
      "makePolicy",
      "decisionHandlers",
      "DecisionMockState",
    ]) {
      expect(testing).toHaveProperty(name);
    }
  });
});
