import {
  DECISION_CONCURRENCY,
  DECISION_FAILURE_ABORT_RATIO,
  DECISION_MAX_ATTEMPTS,
  DECISION_RETRY_DELAYS_MS,
  PAST_DECISIONS_MAX,
  PAST_DECISION_SUBJECT_MAX_CHARS,
  buildDecisionState,
  decideAll,
  decisionSeed,
  evaluateGuardrails,
  extractSignals,
  fuse,
  priorKeyForDomain,
  priorKeyForSender,
  selectPrior,
} from "@clearbox/core";
import type {
  ActionKind,
  DecisionEngine,
  DecisionError,
  DecisionInput,
  DecisionOutcome,
  DecisionResult,
  GuardrailResult,
  MailMessage,
  PastDecision,
  Policy,
  Prior,
  PriorCounts,
  SenderHistory,
  SentItem,
  SignalContext,
  Signals,
  SubrequestCounter,
  Suggestion,
  Thresholds,
} from "@clearbox/core";

export interface LabelRow {
  id: number;
  sender: string;
  sender_domain: string;
  subject_trunc: string | null;
  owner_action: ActionKind;
}

export interface PageContext {
  known: ReadonlySet<string>;
  priors: ReadonlyMap<string, PriorCounts>;
  senders: ReadonlyMap<string, { seen: number; read: number }>;
  correspondents: ReadonlySet<string>;
  repliedThreads: ReadonlySet<string>;
  /** Newest first. */
  labelsBySender: ReadonlyMap<string, LabelRow[]>;
  /** Newest first. */
  labelsByDomain: ReadonlyMap<string, LabelRow[]>;
}

export function emptyContext(): PageContext {
  return {
    known: new Set(),
    priors: new Map(),
    senders: new Map(),
    correspondents: new Set(),
    repliedThreads: new Set(),
    labelsBySender: new Map(),
    labelsByDomain: new Map(),
  };
}

export interface IngestSettings {
  policy: Policy;
  thresholds: Thresholds;
  ownerAddresses: readonly string[];
  now: number;
  accountId: string;
}

export interface Identity {
  address: string;
  domain: string;
}

const EMPTY_HISTORY: SenderHistory = {
  seenCount: 0,
  readCount: 0,
  isCorrespondent: false,
  senderPrior: null,
  domainPrior: null,
};

/** Providers already lowercase addresses; this keeps context keys and stored senders consistent regardless. */
function withLowerSender(m: MailMessage): MailMessage {
  const address = m.from.address;
  return address === null || address === address.toLowerCase()
    ? m
    : { ...m, from: { ...m.from, address: address.toLowerCase() } };
}

/** Sender address and registrable domain, needed for the context query before real signals exist. */
export function identify(messages: readonly MailMessage[], s: IngestSettings): Identity[] {
  const ctx: SignalContext = {
    now: s.now,
    ownerAddresses: s.ownerAddresses,
    repliedThreadIds: new Set<string>(),
  };
  return messages.map((raw) => {
    const sig = extractSignals(withLowerSender(raw), EMPTY_HISTORY, ctx);
    return { address: sig.senderAddress, domain: sig.senderDomain };
  });
}

export interface FreshKeys {
  providerIds: string[];
  senders: string[];
  domains: string[];
  threadIds: string[];
}

export function freshKeys(messages: readonly MailMessage[], ids: readonly Identity[]): FreshKeys {
  const providerIds = new Set<string>();
  const senders = new Set<string>();
  const domains = new Set<string>();
  const threadIds = new Set<string>();
  messages.forEach((m, i) => {
    providerIds.add(m.providerMessageId);
    const id = ids[i];
    if (id !== undefined && id.address !== "") senders.add(id.address);
    if (id !== undefined && id.domain !== "") domains.add(id.domain);
    if (m.threadId !== null) threadIds.add(m.threadId);
  });
  return {
    providerIds: [...providerIds],
    senders: [...senders],
    domains: [...domains],
    threadIds: [...threadIds],
  };
}

export interface PreparedItem {
  msg: MailMessage;
  signals: Signals;
  guard: GuardrailResult;
  prior: Prior;
  input: DecisionInput;
  /** messages.id for a re-decided suggestion; null for a fresh message. */
  existingMessageId: number | null;
  previousAttempts: number;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

function pastDecisions(address: string, domain: string, ctx: PageContext): PastDecision[] {
  const out: PastDecision[] = [];
  const used = new Set<number>();
  const add = (rows: readonly LabelRow[] | undefined): void => {
    for (const l of rows ?? []) {
      if (out.length >= PAST_DECISIONS_MAX) return;
      if (used.has(l.id)) continue;
      used.add(l.id);
      out.push({
        domain: l.sender_domain,
        subject: truncateText(l.subject_trunc ?? "", PAST_DECISION_SUBJECT_MAX_CHARS),
        owner_action: l.owner_action,
      });
    }
  };
  if (address !== "") add(ctx.labelsBySender.get(address));
  if (domain !== "") add(ctx.labelsByDomain.get(domain));
  return out;
}

function prepareOne(
  msg: MailMessage,
  rawSignals: Signals,
  history: SenderHistory,
  ctx: PageContext,
  s: IngestSettings,
  existingMessageId: number | null,
  previousAttempts: number,
): PreparedItem {
  // Provider mappers use receivedAt = 0 when no date exists; fail closed so guard_too_recent applies.
  const signals: Signals = msg.receivedAt <= 0 ? { ...rawSignals, ageDays: 0 } : rawSignals;
  const guard = evaluateGuardrails({ signals, subject: msg.subject, snippet: msg.snippet }, s.policy);
  const prior = selectPrior(
    history.senderPrior,
    history.domainPrior,
    signals.senderAddress,
    signals.senderDomain,
  );
  const state = buildDecisionState({
    msg,
    signals,
    pastDecisions: pastDecisions(signals.senderAddress, signals.senderDomain, ctx),
  });
  const input: DecisionInput = {
    key: msg.providerMessageId,
    state,
    seed: decisionSeed(s.accountId, msg.providerMessageId),
  };
  return { msg, signals, guard, prior, input, existingMessageId, previousAttempts };
}

export function prepareFresh(
  messages: readonly MailMessage[],
  ids: readonly Identity[],
  ctx: PageContext,
  extraSent: readonly SentItem[],
  s: IngestSettings,
): { items: PreparedItem[]; skippedKnown: number } {
  const owners = new Set(s.ownerAddresses);
  const correspondents = new Set(ctx.correspondents);
  const replied = new Set(ctx.repliedThreads);
  for (const item of extraSent) {
    if (item.threadId !== null) replied.add(item.threadId);
    for (const r of item.recipients) if (!owners.has(r)) correspondents.add(r);
  }
  const sctx: SignalContext = { now: s.now, ownerAddresses: s.ownerAddresses, repliedThreadIds: replied };
  const pageCounts = new Map<string, { seen: number; read: number }>();
  const seen = new Set<string>();
  const items: PreparedItem[] = [];
  let skippedKnown = 0;
  messages.forEach((raw, i) => {
    const msg = withLowerSender(raw);
    if (ctx.known.has(msg.providerMessageId) || seen.has(msg.providerMessageId)) {
      skippedKnown += 1;
      return;
    }
    seen.add(msg.providerMessageId);
    const id = ids[i] ?? { address: "", domain: "" };
    const stored = ctx.senders.get(id.address) ?? { seen: 0, read: 0 };
    const page = pageCounts.get(id.address) ?? { seen: 0, read: 0 };
    const history: SenderHistory = {
      seenCount: stored.seen + page.seen,
      readCount: stored.read + page.read,
      isCorrespondent: id.address !== "" && correspondents.has(id.address),
      senderPrior: id.address === "" ? null : (ctx.priors.get(priorKeyForSender(id.address)) ?? null),
      domainPrior: id.domain === "" ? null : (ctx.priors.get(priorKeyForDomain(id.domain)) ?? null),
    };
    if (id.address !== "")
      pageCounts.set(id.address, { seen: page.seen + 1, read: page.read + (msg.isRead ? 1 : 0) });
    items.push(prepareOne(msg, extractSignals(msg, history, sctx), history, ctx, s, null, 0));
  });
  return { items, skippedKnown };
}

export interface RedecideRow {
  message_id: number;
  sender: string;
  sender_domain: string;
  decision_attempts: number;
  provider_msg_id: string;
  thread_id: string | null;
  internet_message_id: string | null;
  sender_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  is_read: number;
  signals_json: string;
  web_link: string | null;
}

function messageFromRow(row: RedecideRow, signals: Signals): MailMessage {
  return {
    providerMessageId: row.provider_msg_id,
    threadId: row.thread_id,
    internetMessageId: row.internet_message_id,
    receivedAt: row.received_at,
    from: { address: row.sender === "" ? null : row.sender, name: row.sender_name },
    to: [],
    cc: [],
    deliveredTo: [],
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    isRead: row.is_read === 1,
    starred: signals.starred,
    providerImportant: signals.providerImportant,
    category: signals.category,
    hasAttachments: signals.hasAttachments,
    attachmentsApprox: signals.attachmentsApprox,
    threadDepth: signals.threadDepth,
    headers: {
      listUnsubscribe: null,
      listUnsubscribePost: null,
      listId: null,
      precedence: null,
      autoSubmitted: null,
      authenticationResults: null,
      returnPath: null,
      contentType: null,
      references: null,
      inReplyTo: null,
    },
    webLink: row.web_link,
    labels: [],
  };
}

/** Rebuilds inputs from stored rows; guardrails are recomputed with the current policy. */
export function prepareRedecide(
  rows: readonly RedecideRow[],
  ctx: PageContext,
  s: IngestSettings,
): PreparedItem[] {
  return rows.map((row) => {
    const signals = JSON.parse(row.signals_json) as Signals;
    const history: SenderHistory = {
      seenCount: signals.senderSeenCount,
      readCount: 0,
      isCorrespondent: signals.isCorrespondent,
      senderPrior: row.sender === "" ? null : (ctx.priors.get(priorKeyForSender(row.sender)) ?? null),
      domainPrior:
        row.sender_domain === "" ? null : (ctx.priors.get(priorKeyForDomain(row.sender_domain)) ?? null),
    };
    return prepareOne(
      messageFromRow(row, signals),
      signals,
      history,
      ctx,
      s,
      row.message_id,
      row.decision_attempts,
    );
  });
}

export interface DecideStage {
  processed: PreparedItem[];
  outcomes: DecisionOutcome[];
  /** True when not every item fitted in the remaining subrequests. */
  partial: boolean;
  configError: DecisionError | null;
  outage: boolean;
  retryableFailures: number;
}

export function emptyStage(): DecideStage {
  return {
    processed: [],
    outcomes: [],
    partial: false,
    configError: null,
    outage: false,
    retryableFailures: 0,
  };
}

export async function decideStage(
  engine: DecisionEngine,
  items: readonly PreparedItem[],
  counter: SubrequestCounter,
): Promise<DecideStage> {
  if (items.length === 0) return emptyStage();
  const room = counter.limit - counter.used;
  if (room <= 0) counter.reserve(1); // throws SubrequestBudgetError
  const processed = items.slice(0, Math.max(room, 0));
  const outcomes = await decideAll(
    engine,
    processed.map((p) => p.input),
    DECISION_CONCURRENCY,
  );
  let retryable = 0;
  let configError: DecisionError | null = null;
  for (const o of outcomes) {
    if (o.ok) continue;
    if (o.error.scope === "config") configError ??= o.error;
    else if (o.error.retryable) retryable += 1;
  }
  return {
    processed,
    outcomes,
    partial: processed.length < items.length,
    configError,
    outage: processed.length >= 4 && retryable / processed.length > DECISION_FAILURE_ABORT_RATIO,
    retryableFailures: retryable,
  };
}

export interface FinalItem {
  msg: MailMessage;
  signals: Signals;
  guard: GuardrailResult;
  existingMessageId: number | null;
  /** decision_attempts after this tick. */
  attempts: number;
  status: "pending" | "awaiting_model";
  /** null while awaiting_model. */
  suggestion: Suggestion | null;
  retryAfter: number | null;
  modelVersion: string | null;
  result: DecisionResult | null;
  error: DecisionError | null;
}

export function finalize(stage: DecideStage, thresholds: Thresholds, now: number): FinalItem[] {
  return stage.processed.map((item, i): FinalItem => {
    const outcome = stage.outcomes[i];
    const attempts = item.previousAttempts + 1;
    const base = {
      msg: item.msg,
      signals: item.signals,
      guard: item.guard,
      existingMessageId: item.existingMessageId,
      attempts,
    };
    const fuseWith = (model: DecisionResult | null): Suggestion =>
      fuse({ model, prior: item.prior, guard: item.guard, signals: item.signals, thresholds });
    if (outcome?.ok === true) {
      return {
        ...base,
        status: "pending",
        suggestion: fuseWith(outcome.result),
        retryAfter: null,
        modelVersion: outcome.result.modelVersion,
        result: outcome.result,
        error: null,
      };
    }
    const error = outcome !== undefined && !outcome.ok ? outcome.error : null;
    const fresh = item.existingMessageId === null;
    if (error !== null && error.retryable && (fresh || attempts < DECISION_MAX_ATTEMPTS)) {
      const delay =
        DECISION_RETRY_DELAYS_MS[Math.min(attempts - 1, DECISION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      return {
        ...base,
        status: "awaiting_model",
        suggestion: null,
        retryAfter: now + delay,
        modelVersion: null,
        result: null,
        error,
      };
    }
    return {
      ...base,
      status: "pending",
      suggestion: fuseWith(null),
      retryAfter: null,
      modelVersion: null,
      result: null,
      error,
    };
  });
}
