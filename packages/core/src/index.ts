export type {
  AccountId,
  AccountRef,
  AuthVerdict,
  MailAddress,
  MailCategory,
  MailHeaders,
  MailMessage,
  OwnerPosition,
  ProviderKind,
} from "./model/mail.ts";
export {
  ACTION_KINDS,
  ACTION_RANK,
  SUGGESTED_ACTIONS,
  isAllowedByCeiling,
  minCeiling,
} from "./model/actions.ts";
export type { ActionDistribution, ActionKind, Ceiling, SuggestedAction } from "./model/actions.ts";
export { REASON_CODES, REASON_TEMPLATES, renderReason } from "./model/reasons.ts";
export type { Reason, ReasonCode, ReasonParams } from "./model/reasons.ts";
export {
  ClearboxError,
  CursorExpiredError,
  DECISION_ERROR_RULES,
  DecisionError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ScopeMissingError,
  SubrequestBudgetError,
} from "./model/errors.ts";
export type { DecisionErrorKind, DecisionErrorOptions } from "./model/errors.ts";
export * from "./model/constants.ts";

export { backoffMs, countingFetch, createSubrequestCounter, parseRetryAfter } from "./http/fetch.ts";
export type { FetchLike, SubrequestCounter } from "./http/fetch.ts";
export { fnv1a32, mulberry32, seededShuffle } from "./util/rng.ts";
export { mapWithConcurrency } from "./util/concurrency.ts";

export { decodeEncodedWords, unfoldHeader } from "./text/rfc2047.ts";
export { parseAddress, parseAddressList, registrableDomain } from "./text/address.ts";
export {
  headerValue,
  isAutoSubmitted,
  isBulkPrecedence,
  parseAuthResults,
  parseListUnsubscribe,
} from "./text/headers.ts";
export type { ListUnsubscribe, ParsedAuthResults, RawHeader } from "./text/headers.ts";
export {
  UNSUBSCRIBE_URL_MAX_CHARS,
  checkUnsubscribeUrl,
  isOneClickPost,
  oneClickTarget,
} from "./text/unsubscribe.ts";
export type { CheckedUrl, UnsafeUrlReason } from "./text/unsubscribe.ts";
export { collapseWhitespace, decodeHtmlEntities, truncateChars } from "./text/truncate.ts";

export type {
  ActionErrorCode,
  ActionResult,
  BackfillCursor,
  BootstrapResult,
  ChangesPage,
  GraphProviderDeps,
  IncrementalCursor,
  InboxNote,
  InboxPage,
  MailProvider,
  ProviderDeps,
  RestoreFrom,
  RestoreItem,
  SentCursor,
  SentItem,
  SentPage,
  UnsubscribeHeaders,
} from "./providers/provider.ts";
export type { OAuthTokens, TokenSource, TokenUpdate } from "./providers/token.ts";
export {
  GOOGLE_SCOPES,
  MICROSOFT_CONSENT_URLS,
  MICROSOFT_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  parseTokenResponse,
  refreshAccessToken,
} from "./providers/oauth.ts";
export type { AuthorizeParams, OAuthClientConfig, TokenEndpoint } from "./providers/oauth.ts";
export { boundaryFromContentType, buildBatchBody, parseBatchResponse } from "./http/multipart.ts";
export type { BatchRequestPart, BatchResponsePart } from "./http/multipart.ts";
export {
  GMAIL_MODIFY_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  buildGoogleAuthorizeUrl,
  classifyGmailApiError,
  classifyGoogleOAuthError,
  exchangeGoogleCode,
  hasGmailScope,
  refreshGoogleToken,
  revokeGoogleToken,
} from "./providers/google/oauth.ts";
export { buildGmailDeepLink, mapGmailMessage } from "./providers/google/map.ts";
export { createGmailProvider } from "./providers/google/gmail.ts";
export {
  MICROSOFT_TOKEN_ENDPOINT,
  buildMicrosoftAuthorizeUrl,
  classifyGraphApiError,
  classifyMicrosoftOAuthError,
  exchangeMicrosoftCode,
  hasGraphScopes,
  refreshMicrosoftToken,
} from "./providers/microsoft/oauth.ts";
export { mapGraphMessage } from "./providers/microsoft/map.ts";
export { createGraphProvider } from "./providers/microsoft/graph.ts";

export { extractSignals } from "./signals/signals.ts";
export type { SenderHistory, SignalContext, Signals } from "./signals/signals.ts";
export {
  DEFAULT_POLICY,
  DEFAULT_SCAN_HISTORY_DAYS,
  DEFAULT_WEEKLY_REMINDER,
  PolicySchema,
  SCAN_HISTORY_DAYS_OPTIONS,
  ScanHistoryDaysSchema,
  SenderEntrySchema,
  WeeklyReminderSchema,
  matchRecordPattern,
  matchesSenderList,
  parsePolicy,
  scanHistoryCutoff,
  scanHistoryWidened,
} from "./policy/policy.ts";
export type { Policy, ScanHistoryDays, WeeklyReminder } from "./policy/policy.ts";
export {
  CLEARBOX_NOTE_HEADER,
  CLEARBOX_NOTE_NAME,
  CLEARBOX_NOTE_SENDER,
  REMINDER_MIN_GAP_DAYS,
  buildReminderNote,
  dropClearboxNotes,
  isClearboxNote,
  pendingTotal,
  reminderDue,
} from "./reminder/reminder.ts";
export type { ReminderCounts, ReminderInput } from "./reminder/reminder.ts";
export { AUTO_TRASH_DAILY_CAP, autoTrashBlock } from "./autotrash/autotrash.ts";
export type { AutoTrashBlock, AutoTrashCandidate } from "./autotrash/autotrash.ts";
export { evaluateGuardrails } from "./guardrails/guardrails.ts";
export type { GuardrailInput, GuardrailResult } from "./guardrails/guardrails.ts";
export {
  applyOwnerAction,
  priorDelta,
  priorKeyForDomain,
  priorKeyForSender,
  selectPrior,
} from "./priors/priors.ts";
export type { Prior, PriorCounts } from "./priors/priors.ts";

export type { DecisionEngine, DecisionFlags, DecisionInput, DecisionResult } from "./decision/engine.ts";
export { buildDecisionState } from "./decision/state.ts";
export type { BuildStateInput, DecisionState, PastDecision } from "./decision/state.ts";
export {
  DECISION_QUESTIONS,
  IMPORTANCE_LEVELS,
  buildDecisionQuestions,
  buildDecisionRequest,
  decisionSeed,
} from "./decision/questions.ts";
export type {
  ChoiceQuestion,
  DecisionQuestions,
  DecisionRequestBody,
  NoulQuestion,
  ScoreQuestion,
} from "./decision/questions.ts";
export {
  ChoiceAnswerSchema,
  DecisionResponseSchema,
  NoulAnswerSchema,
  ScoreAnswerSchema,
  normalizeDecisionResponse,
} from "./decision/response.ts";
export type { DecisionResponse, NormalizeMeta } from "./decision/response.ts";
export { DECISION_PATH, MaiDecisionEngine, decisionErrorKindForStatus } from "./decision/mai-engine.ts";
export type { MaiEngineConfig } from "./decision/mai-engine.ts";
export { FakeEngine } from "./decision/fake-engine.ts";
export type { FakeEngineOptions } from "./decision/fake-engine.ts";
export { decideAll } from "./decision/run.ts";
export type { DecisionOutcome } from "./decision/run.ts";

export { fuse, selectReasons } from "./fusion/fusion.ts";
export type { FusionInput, ReasonContext, Suggestion, Thresholds } from "./fusion/fusion.ts";
export { calibrateSegments, calibrateTauDelete } from "./calibration/calibration.ts";
export type {
  CalibrationPoint,
  CalibrationResult,
  CalibrationSample,
  SegmentCalibration,
  SegmentCalibrationResult,
  SegmentCalibrationSample,
} from "./calibration/calibration.ts";
export {
  CALIBRATED_SEGMENTS,
  DECISION_SEGMENTS,
  decisionSegment,
  isBulkMail,
  segmentTau,
} from "./fusion/segments.ts";
export type { CalibratedSegment, DecisionSegment, SegmentTaus } from "./fusion/segments.ts";
export { refreshSuggestion, holdUntil } from "./fusion/refresh.ts";
export type { RefreshInput, RefreshResult, StoredModel } from "./fusion/refresh.ts";
