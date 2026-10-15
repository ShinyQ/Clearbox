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
export { makeGmailMetadata, makeGraphMessage } from "./fixtures/builders.ts";
export type { GmailMetadataOverrides } from "./fixtures/builders.ts";
export { FAKE_OWNER, FakeMailbox, FakeTokenSource } from "./msw/fake-mailbox.ts";
export type { FailRule, FakeChange, FakeFolder, FakeHeader, FakeMessage } from "./msw/fake-mailbox.ts";
export { gmailHandlers } from "./msw/gmail.ts";
export { graphHandlers } from "./msw/graph.ts";
export {
  FakeOAuthState,
  GOOGLE_TEST_CLIENT,
  createGoogleOAuthState,
  googleOAuthHandlers,
} from "./msw/google-oauth.ts";
export {
  MICROSOFT_TEST_CLIENT,
  createMicrosoftOAuthState,
  microsoftOAuthHandlers,
} from "./msw/microsoft-oauth.ts";
export { DecisionMockState, decisionHandlers, makeDecisionResponseBody } from "./msw/decision.ts";
export type { DecisionFailSpec, DecisionMockOptions } from "./msw/decision.ts";
