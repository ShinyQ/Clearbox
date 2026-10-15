// Public test helpers, exported as "@clearbox/core/testing" for worker and web tests.
export {
  DAY_MS,
  TEST_NOW,
  makeDecisionResult,
  makeMailHeaders,
  makeMailMessage,
  makePolicy,
  makeSenderHistory,
  makeSignals,
} from "./fixtures/builders.ts";
export type { MailMessageOverrides } from "./fixtures/builders.ts";
export { DecisionMockState, decisionHandlers, makeDecisionResponseBody } from "./msw/decision.ts";
export type { DecisionFailSpec, DecisionMockOptions } from "./msw/decision.ts";
