import {
  CursorExpiredError,
  DELETE_MARGIN,
  INGEST_STOP_ROWS,
  MIN_CONFIDENCE,
  PAGE_SIZE_FREE,
  PAGE_SIZE_PAID,
  POLL_INTERVAL_MS,
  ProviderResponseError,
  SENT_PAGE_SIZE,
  STORAGE_SOFT_LIMIT_BYTES,
  TICK_SUBREQUEST_LIMIT,
  countingFetch,
  createSubrequestCounter,
} from "@clearbox/core";
import type {
  ChangesPage,
  DecisionEngine,
  FetchLike,
  InboxPage,
  MailMessage,
  MailProvider,
  SentItem,
  SentPage,
  SubrequestCounter,
} from "@clearbox/core";
import type { AccountPhase, AppIssueCode, TickKind, TickReport } from "../../shared/api.ts";
import { importEncKey } from "../crypto/aead.ts";
import { readConfig } from "../env.ts";
import { logEvent } from "../log.ts";
import { claimStatements, parseClaim, parseTickSettings, scanNowError } from "./claim.ts";
import type { TickAccountRow, TickSettings } from "./claim.ts";
import { freshContextStatements, parseContext, redecideContextStatements } from "./context.ts";
import { makeDecisionEngine } from "./engine.ts";
import { DecisionNotConfiguredError, DecisionOutageError } from "./failure.ts";
import {
  decideStage,
  emptyStage,
  finalize,
  freshKeys,
  identify,
  prepareFresh,
  prepareRedecide,
} from "./ingest.ts";
import type { DecideStage, FinalItem, IngestSettings, PreparedItem } from "./ingest.ts";
import { makeProvider } from "./providers.ts";
import { encryptTokenUpdate, openTickTokens, providerTargetOf } from "./tick-tokens.ts";
import type { D1TokenSource } from "./token-source.ts";
import {
  applyIssues,
  batchRunner,
  budgetUpsertStmt,
  buildSuccessWrite,
  computeAdvance,
  isoOf,
  lastSizeAfter,
  nextUtcMidnight,
  rowsOf,
  sumMeta,
  utcDate,
} from "./write-plan.ts";
import type {
  AccountAdvance,
  BatchResult,
  BatchRunner,
  IssueChange,
  IssueRaise,
  PageOutcome,
  SuccessWrite,
} from "./write-plan.ts";

/** Contracts 8.1. */
export interface TickOptions {
  trigger: "cron" | "scan_now";
  /** Required for scan_now. */
  accountId?: string;
  now: number;
  /** Tests inject FakeEngine; default makeDecisionEngine(env, countingFetch). */
  engine?: DecisionEngine;
  /** Tests may inject; default globalThis.fetch. */
  fetch?: FetchLike;
}

/** Filled by runTickInternal: pure compute, awaited I/O, and total wall time, in ms. */
export interface TickTimings {
  wallMs: number;
  ioMs: number;
  pureMs: number;
}

export interface TickInternals {
  subrequestLimit?: number;
  timings?: TickTimings;
}

/**
 * The final write and the budget upsert always fit (contracts C9 decision). Everything else draws from the
 * work counter, and Decision-1 gets only the room left after the provider fetch has actually run: the fetch
 * cost varies. Worst case per Gmail metadata chunk (50 ids): 3 batch POSTs (a 5xx/429/missing-part retry plus
 * one extra attempt after a 401 part) and 1 token refresh, on top of the list or history call.
 */
const FINAL_D1_CALLS = 2;
const PAID_TICK_SUBREQUEST_LIMIT = 500;
const DECISION_ISSUES: readonly AppIssueCode[] = [
  "decision_not_configured",
  "decision_auth_failed",
  "decision_deployment_not_found",
];

class Stopwatch {
  readonly t: TickTimings;

  constructor(t?: TickTimings) {
    this.t = t ?? { wallMs: 0, ioMs: 0, pureMs: 0 };
  }

  pure<T>(fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.t.pureMs += performance.now() - start;
    }
  }

  async io<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.t.ioMs += performance.now() - start;
    }
  }
}

function tally(f: FetchLike): { fetch: FetchLike; count: () => number } {
  let n = 0;
  return {
    fetch: (input, init) => {
      n += 1;
      return f(input, init);
    },
    count: () => n,
  };
}

export function selectKind(
  a: Pick<TickAccountRow, "phase" | "last_incremental_at">,
  awaitingDue: number,
  now: number,
): TickKind {
  if (awaitingDue > 0) return "redecide";
  if (a.phase === "sent_backfill") return "sent_backfill";
  if (
    a.phase === "incremental" ||
    a.last_incremental_at === null ||
    now - a.last_incremental_at >= POLL_INTERVAL_MS
  ) {
    return "incremental";
  }
  return "inbox_backfill";
}

function ownerAddresses(a: TickAccountRow): string[] {
  let aliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(a.owner_aliases_json);
    if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    aliases = [];
  }
  return [a.email, ...aliases].map((x) => x.toLowerCase());
}

/** Amendment A4: during backfill, refresh when unknown or on the first tick of a UTC day. */
function shouldRefreshEstimate(a: TickAccountRow, kind: TickKind, now: number): boolean {
  if (kind !== "sent_backfill" && kind !== "inbox_backfill") return false;
  return a.inbox_estimate === null || a.last_tick_at === null || utcDate(a.last_tick_at) !== utcDate(now);
}

/** Best effort: any failure keeps the stored estimate. */
async function fetchInboxEstimate(provider: MailProvider): Promise<number | null> {
  try {
    return await provider.inboxEstimate();
  } catch {
    return null;
  }
}

/**
 * An expired cursor, or a stored provider URL (Graph nextLink / deltaLink) that the provider refused to call
 * because it is not on the provider's origin (ProviderResponseError status 0, no request was sent).
 */
function isStaleCursor(err: unknown): boolean {
  return err instanceof CursorExpiredError || (err instanceof ProviderResponseError && err.status === 0);
}

export type Fetched =
  | { kind: "sent_backfill"; page: SentPage }
  | { kind: "inbox_backfill"; page: InboxPage }
  | { kind: "incremental"; page: ChangesPage; startCursor: string }
  | { kind: "redecide" };

/**
 * One provider page; sequential requests only (never Promise.all over provider calls: the token source has no
 * single-flight refresh). A stale cursor restarts the backfill or sent scan from the newest mail, or resyncs
 * the incremental cursor from the watermark; a second failure is rethrown, so it never loops.
 */
export async function fetchPage(
  kind: TickKind,
  provider: MailProvider,
  a: Pick<
    TickAccountRow,
    "sent_cursor" | "backfill_cursor" | "incremental_cursor" | "watermark_received_at" | "page_size"
  >,
): Promise<Fetched> {
  switch (kind) {
    case "sent_backfill":
      try {
        return { kind, page: await provider.listSentPage(a.sent_cursor, SENT_PAGE_SIZE) };
      } catch (err) {
        if (!isStaleCursor(err) || a.sent_cursor === null) throw err;
        return { kind, page: await provider.listSentPage(null, SENT_PAGE_SIZE) };
      }
    case "inbox_backfill":
      try {
        return { kind, page: await provider.listInboxPage(a.backfill_cursor, a.page_size) };
      } catch (err) {
        if (!isStaleCursor(err) || a.backfill_cursor === null) throw err;
        return { kind, page: await provider.listInboxPage(null, a.page_size) };
      }
    case "incremental":
      try {
        return {
          kind,
          page: await provider.syncChanges(a.incremental_cursor, a.page_size),
          startCursor: a.incremental_cursor,
        };
      } catch (err) {
        if (!isStaleCursor(err)) throw err;
        const cursor = await provider.resyncCursor(a.watermark_received_at);
        return { kind, page: await provider.syncChanges(cursor, a.page_size), startCursor: cursor };
      }
    case "redecide":
      return { kind };
  }
}

interface DecisionStats {
  decided: number;
  deferred: number;
  unsure: number;
  calls: number;
  failures: number;
  inputTokens: number;
  latencies: number[];
}

function emptyStats(): DecisionStats {
  return { decided: 0, deferred: 0, unsure: 0, calls: 0, failures: 0, inputTokens: 0, latencies: [] };
}

function decisionStats(stage: DecideStage, finals: readonly FinalItem[]): DecisionStats {
  const stats = emptyStats();
  stats.calls = stage.outcomes.length;
  for (const o of stage.outcomes) {
    if (o.ok) {
      stats.decided += 1;
      stats.inputTokens += o.result.inputTokens;
      stats.latencies.push(o.result.latencyMs);
    } else {
      stats.failures += 1;
    }
  }
  stats.deferred = finals.filter((f) => f.status === "awaiting_model").length;
  stats.unsure = finals.filter((f) => f.status === "pending" && f.suggestion?.action === "unsure").length;
  return stats;
}

function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function logDecisionErrors(stage: DecideStage, tickId: string, accountId: string): void {
  for (const o of stage.outcomes) {
    if (o.ok) continue;
    logEvent("decision.error", {
      tickId,
      accountId,
      messageId: null,
      kind: o.error.kind,
      status: o.error.status,
      requestId: o.error.requestId,
    });
  }
}

interface ProcessParams {
  env: Env;
  account: TickAccountRow;
  kind: TickKind;
  now: number;
  tickId: string;
  settings: TickSettings;
  engine: DecisionEngine | undefined;
  providerFetch: FetchLike;
  decisionFetch: FetchLike;
  tokens: D1TokenSource;
  encKey: CryptoKey;
  work: SubrequestCounter;
  run: BatchRunner;
  watch: Stopwatch;
  raise: IssueRaise[];
  clear: AppIssueCode[];
  maxPageSize: number;
}

interface Processed {
  write: SuccessWrite;
  advance: AccountAdvance;
  issues: IssueChange;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  freshCount: number;
  rowsRead: number;
}

/** Fetch, context, decide, fuse and build the write batch. Throws on any tick-level failure. */
async function processAccount(p: ProcessParams): Promise<Processed> {
  const { account, kind, now, watch } = p;
  const needsEngine = kind !== "sent_backfill";
  const engine = needsEngine ? (p.engine ?? makeDecisionEngine(p.env, p.decisionFetch)) : null;
  if (needsEngine && engine === null) throw new DecisionNotConfiguredError();
  const provider = makeProvider(providerTargetOf(account), {
    fetch: p.providerFetch,
    tokens: p.tokens,
    now: () => now,
  });
  const inboxEstimate = shouldRefreshEstimate(account, kind, now) ? await fetchInboxEstimate(provider) : null;
  const fetched = await fetchPage(kind, provider, account);
  const s: IngestSettings = {
    policy: p.settings.policy,
    thresholds: {
      tauDelete: p.settings.tauDelete,
      deleteMargin: DELETE_MARGIN,
      minConfidence: MIN_CONFIDENCE,
    },
    ownerAddresses: ownerAddresses(account),
    now,
    accountId: account.id,
  };

  let items: PreparedItem[] = [];
  let sent: readonly SentItem[] = [];
  let removedIds: readonly string[] = [];
  let fetchedCount = 0;
  let skippedKnown = 0;
  let rowsRead = 0;
  if (fetched.kind === "sent_backfill") {
    sent = fetched.page.items;
    fetchedCount = sent.length;
  } else if (fetched.kind === "redecide") {
    const tagged = redecideContextStatements(account.id, now, account.page_size);
    const res = await p.run(
      p.work,
      tagged.map((t) => t.stmt),
    );
    rowsRead += sumMeta(res, "rows_read");
    items = watch.pure(() => {
      const parsed = parseContext(tagged, res);
      return prepareRedecide(parsed.redecideRows, parsed.ctx, s);
    });
  } else {
    const messages: readonly MailMessage[] =
      fetched.kind === "inbox_backfill" ? fetched.page.messages : fetched.page.added;
    if (fetched.kind === "incremental") {
      sent = fetched.page.sent;
      removedIds = fetched.page.removedIds;
    }
    fetchedCount = messages.length;
    if (messages.length > 0) {
      // Graph delta also reports updates of stored messages in `added`: the "known" read and prepareFresh
      // drop every provider id already in D1 (and repeats within the page) before Decision-1 and the write.
      const ids = watch.pure(() => identify(messages, s));
      const tagged = freshContextStatements(
        account.id,
        watch.pure(() => freshKeys(messages, ids)),
      );
      const res = await p.run(
        p.work,
        tagged.map((t) => t.stmt),
      );
      rowsRead += sumMeta(res, "rows_read");
      const prepared = watch.pure(() => prepareFresh(messages, ids, parseContext(tagged, res).ctx, sent, s));
      items = prepared.items;
      skippedKnown = prepared.skippedKnown;
    }
  }

  // decideStage sizes Decision-1 from the counter as it stands now, after the fetch's real cost.
  const stage =
    engine === null || items.length === 0 ? emptyStage() : await decideStage(engine, items, p.work);
  logDecisionErrors(stage, p.tickId, account.id);
  if (stage.configError !== null) throw stage.configError;
  if (stage.outage) throw new DecisionOutageError(stage.retryableFailures, stage.processed.length);
  const finals = watch.pure(() => finalize(stage, s.thresholds, now));
  const fresh = finals.filter((f) => f.existingMessageId === null);
  const maxReceived = fresh.reduce<number | null>(
    (m, f) => (m === null || f.msg.receivedAt > m ? f.msg.receivedAt : m),
    null,
  );
  const outcome: PageOutcome =
    fetched.kind === "sent_backfill"
      ? { kind: "sent_backfill", itemCount: fetched.page.items.length, nextCursor: fetched.page.nextCursor }
      : fetched.kind === "inbox_backfill"
        ? { kind: "inbox_backfill", nextCursor: fetched.page.nextCursor, partial: stage.partial }
        : fetched.kind === "incremental"
          ? {
              kind: "incremental",
              startCursor: fetched.startCursor,
              nextCursor: fetched.page.nextCursor,
              caughtUp: fetched.page.caughtUp,
              partial: stage.partial,
            }
          : { kind: "redecide" };
  const advance = computeAdvance(account, outcome, maxReceived, now);
  const stats = decisionStats(stage, finals);

  const clear = [...p.clear];
  if (stats.decided > 0) clear.push(...DECISION_ISSUES);
  const update = p.tokens.update;
  if (update !== null)
    clear.push(account.provider === "gmail" ? "google_client_invalid" : "microsoft_client_invalid");
  const issues = applyIssues(p.settings.issues, p.raise, clear, now);
  const tokens = update === null ? null : await encryptTokenUpdate(p.encKey, account, update);
  const write = watch.pure(() =>
    buildSuccessWrite({
      accountId: account.id,
      tickId: p.tickId,
      now,
      policyVersion: p.settings.policyVersion,
      storeSnippets: p.settings.policy.storeSnippets,
      items: finals,
      sent,
      ownerAddresses: s.ownerAddresses,
      removedIds,
      issues: issues.changed ? issues.issues : null,
      advance,
      tokens,
      maxPageSize: p.maxPageSize,
      inboxEstimate,
    }),
  );
  return {
    write,
    advance,
    issues,
    stats,
    fetched: fetchedCount,
    skippedKnown,
    freshCount: fresh.length,
    rowsRead,
  };
}

interface TickResult {
  outcome: "processed" | "error";
  phase: AccountPhase;
  nextTickAt: number | null;
  errorCode: string | null;
  freshCount: number;
  rowsWritten: number;
  rowsRead: number;
  dbSize: number;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  removed: number;
  issues: IssueChange | null;
}

function successResult(p: Processed, res: readonly BatchResult[]): TickResult {
  return {
    outcome: "processed",
    phase: p.advance.phase,
    nextTickAt:
      rowsOf<{ next_tick_at: number }>(res[p.write.nextTickIndex])[0]?.next_tick_at ?? p.advance.nextTickAt,
    errorCode: null,
    freshCount: p.freshCount,
    rowsWritten: sumMeta(res, "rows_written"),
    rowsRead: p.rowsRead + sumMeta(res, "rows_read"),
    dbSize: lastSizeAfter(res),
    stats: p.stats,
    fetched: p.fetched,
    skippedKnown: p.skippedKnown,
    removed: p.write.dismissals.reduce((n, i) => n + (res[i]?.meta?.changes ?? 0), 0),
    issues: p.issues,
  };
}

function idleReport(subrequests: number, nextTickAt: number | null): TickReport {
  return {
    outcome: "idle",
    accountId: null,
    kind: null,
    phase: null,
    fetched: 0,
    skippedKnown: 0,
    decided: 0,
    deferred: 0,
    unsure: 0,
    removed: 0,
    subrequests,
    rowsWritten: 0,
    nextTickAt: nextTickAt === null ? null : isoOf(nextTickAt),
    errorCode: null,
  };
}

interface FinishParams {
  run: BatchRunner;
  final: SubrequestCounter;
  claimRowsWritten: number;
  claimRowsRead: number;
  result: TickResult;
  account: TickAccountRow;
  kind: TickKind;
  tickId: string;
  today: string;
  now: number;
  providerCalls: number;
  startedAt: number;
}

/** D1 call 4 (budget), logs and the report. */
async function finishTick(f: FinishParams): Promise<TickReport> {
  const r = f.result;
  const rowsWritten = f.claimRowsWritten + r.rowsWritten + 1;
  try {
    await f.run(f.final, [
      budgetUpsertStmt({
        date: f.today,
        rowsWritten,
        rowsRead: f.claimRowsRead + r.rowsRead,
        ticks: 1,
        messagesIngested: r.freshCount,
        decisionCalls: r.stats.calls,
        decisionFailures: r.stats.failures,
        decisionInputTokens: r.stats.inputTokens,
        providerCalls: f.providerCalls,
        dbSizeBytes: r.dbSize,
        now: f.now,
      }),
    ]);
  } catch {
    logEvent("tick.failed", {
      tickId: f.tickId,
      accountId: f.account.id,
      kind: f.kind,
      errorCode: "budget_write_failed",
      attempts: f.account.attempts,
      retryAfterMs: null,
    });
  }
  for (const code of r.issues?.raised ?? []) logEvent("issue.raised", { code, accountId: null });
  for (const code of r.issues?.cleared ?? []) logEvent("issue.cleared", { code, accountId: null });
  if (r.outcome === "processed") {
    logEvent("tick.done", {
      tickId: f.tickId,
      accountId: f.account.id,
      kind: f.kind,
      fetched: r.fetched,
      skippedKnown: r.skippedKnown,
      decided: r.stats.decided,
      deferred: r.stats.deferred,
      unsure: r.stats.unsure,
      removed: r.removed,
      subrequests: f.final.used,
      rowsWritten,
      rowsRead: f.claimRowsRead + r.rowsRead,
      inputTokens: r.stats.inputTokens,
      decisionP50Ms: percentile(r.stats.latencies, 0.5),
      decisionP95Ms: percentile(r.stats.latencies, 0.95),
      durationMs: Math.round(performance.now() - f.startedAt),
    });
  }
  return {
    outcome: r.outcome,
    accountId: f.account.id,
    kind: f.kind,
    phase: r.phase,
    fetched: r.fetched,
    skippedKnown: r.skippedKnown,
    decided: r.stats.decided,
    deferred: r.stats.deferred,
    unsure: r.stats.unsure,
    removed: r.removed,
    subrequests: f.final.used,
    rowsWritten,
    nextTickAt: r.nextTickAt === null ? null : isoOf(r.nextTickAt),
    errorCode: r.errorCode,
  };
}

async function tick(
  env: Env,
  opts: TickOptions,
  internals: TickInternals,
  watch: Stopwatch,
): Promise<TickReport> {
  const startedAt = performance.now();
  const config = readConfig(env);
  if (!config.ok) {
    logEvent("config.invalid", { missing: config.invalid.join(",") });
    return idleReport(0, null);
  }
  const now = opts.now;
  const tickId = crypto.randomUUID();
  const freeTier = config.config.freeTier;
  const limit = internals.subrequestLimit ?? (freeTier ? TICK_SUBREQUEST_LIMIT : PAID_TICK_SUBREQUEST_LIMIT);
  const stopRows = freeTier ? INGEST_STOP_ROWS : Number.MAX_SAFE_INTEGER;
  const work = createSubrequestCounter(Math.max(1, limit - FINAL_D1_CALLS));
  const base: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const counted = countingFetch((input, init) => watch.io(() => base(input, init)), work);
  const providerFetch = tally(counted);
  const decisionFetch = tally(counted);
  const run = batchRunner(env.DB, (fn) => watch.io(fn));
  const today = utcDate(now);

  // D1 call 1: claim.
  const claimResults = await run(
    work,
    claimStatements({
      tickId,
      now,
      accountId: opts.accountId ?? null,
      force: opts.trigger === "scan_now",
      today,
      stopRows,
    }),
  );
  const claim = parseClaim(claimResults);
  const account = claim.account;
  if (claim.claimedAccountId === null || account === null) {
    if (opts.trigger === "scan_now") throw scanNowError(claim, now, stopRows);
    const rowsWritten = claim.budget?.rows_written ?? 0;
    const gated = rowsWritten >= stopRows;
    if (gated) logEvent("budget.gate", { date: today, rowsWritten, gate: "ingest" });
    logEvent("tick.idle", { tickId, trigger: opts.trigger });
    return idleReport(work.used, gated ? nextUtcMidnight(now) : null);
  }

  const settings = parseTickSettings(claim.settings);
  let kind = selectKind(account, claim.awaitingDue, now);
  const raise: IssueRaise[] = [];
  const clear: AppIssueCode[] = [];
  if ((claim.budget?.db_size_bytes ?? 0) >= STORAGE_SOFT_LIMIT_BYTES) {
    if (kind === "inbox_backfill") {
      raise.push({ code: "storage_near_limit", accountId: null });
      kind = "incremental";
    }
  } else {
    clear.push("storage_near_limit");
  }
  logEvent("tick.claimed", {
    tickId,
    trigger: opts.trigger,
    accountId: account.id,
    kind,
    phase: account.phase,
    pageSize: account.page_size,
  });
  const encKey = await importEncKey(config.config.tokenEncKey);
  const tokens = openTickTokens({
    row: account,
    config: config.config,
    encKey,
    fetch: providerFetch.fetch,
    now,
  });
  const params: ProcessParams = {
    env,
    account,
    kind,
    now,
    tickId,
    settings,
    engine: opts.engine,
    providerFetch: providerFetch.fetch,
    decisionFetch: decisionFetch.fetch,
    tokens,
    encKey,
    work,
    run,
    watch,
    raise,
    clear,
    maxPageSize: freeTier ? PAGE_SIZE_FREE : PAGE_SIZE_PAID,
  };

  // Success path. Task 8 wraps these four statements in the failure handler.
  const processed = await processAccount(params);
  const final = createSubrequestCounter(limit, work.used);
  const finalResults = await run(final, processed.write.stmts);
  const result = successResult(processed, finalResults);

  return finishTick({
    run,
    final,
    claimRowsWritten: claim.rowsWritten,
    claimRowsRead: claim.rowsRead,
    result,
    account,
    kind,
    tickId,
    today,
    now,
    providerCalls: providerFetch.count(),
    startedAt,
  });
}

export async function runTickInternal(
  env: Env,
  opts: TickOptions,
  internals: TickInternals,
): Promise<TickReport> {
  const watch = new Stopwatch(internals.timings);
  const start = performance.now();
  try {
    return await tick(env, opts, internals, watch);
  } finally {
    watch.t.wallMs += performance.now() - start;
  }
}

/** The single tick code path for the cron and POST /api/accounts/:id/scan (contracts 8.1). */
export function runTick(env: Env, opts: TickOptions): Promise<TickReport> {
  return runTickInternal(env, opts, {});
}
