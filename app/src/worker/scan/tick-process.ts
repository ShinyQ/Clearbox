import { DELETE_MARGIN, MIN_CONFIDENCE, scanHistoryCutoff } from "@clearbox/core";
import type { DecisionEngine, FetchLike, MailMessage, SentItem, SubrequestCounter } from "@clearbox/core";
import type { AppIssueCode, TickKind } from "../../shared/api.ts";
import type { TickAccountRow, TickSettings } from "./claim.ts";
import { freshContextStatements, parseContext, redecideContextStatements } from "./context.ts";
import { makeDecisionEngine } from "./engine.ts";
import { DecisionNotConfiguredError, DecisionOutageError } from "./failure.ts";
import { fetchInboxEstimate, fetchPage, shouldRefreshEstimate } from "./fetch.ts";
import {
  applyScanWindow,
  decideStage,
  dropBeyondRetention,
  emptyStage,
  finalize,
  freshKeys,
  identify,
  prepareFresh,
  prepareRedecide,
} from "./ingest.ts";
import type { IngestSettings, PreparedItem } from "./ingest.ts";
import { makeProvider } from "./providers.ts";
import { encryptTokenUpdate, providerTargetOf } from "./tick-tokens.ts";
import { decisionStats, logDecisionErrors } from "./tick-stats.ts";
import type { DecisionStats, Stopwatch } from "./tick-stats.ts";
import type { D1TokenSource } from "./token-source.ts";
import { applyIssues, buildSuccessWrite, computeAdvance, sumMeta } from "./write-plan.ts";
import type {
  AccountAdvance,
  BatchRunner,
  IssueChange,
  IssueRaise,
  PageOutcome,
  SuccessWrite,
} from "./write-plan.ts";

const DECISION_ISSUES: readonly AppIssueCode[] = [
  "decision_not_configured",
  "decision_auth_failed",
  "decision_deployment_not_found",
];

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

export interface ProcessParams {
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
  /** An inbox_backfill tick switched to incremental by the storage gate. */
  storageGated: boolean;
}

export interface Processed {
  write: SuccessWrite;
  advance: AccountAdvance;
  issues: IssueChange;
  stats: DecisionStats;
  fetched: number;
  skippedKnown: number;
  /**
   * Inbox items dropped before any read or decision: incremental items older than the retention window, and
   * (rev 2.4) backfill items older than the scan history window.
   */
  skippedOld: number;
  freshCount: number;
  rowsRead: number;
}

/** Fetch, context, decide, fuse and build the write batch. Throws on any tick-level failure. */
export async function processAccount(p: ProcessParams): Promise<Processed> {
  const { account, kind, now, watch } = p;
  const needsEngine = kind !== "sent_backfill";
  const engine = needsEngine ? (p.engine ?? makeDecisionEngine(p.env, p.decisionFetch)) : null;
  if (needsEngine && engine === null) throw new DecisionNotConfiguredError();
  if (needsEngine) p.clear.push("decision_not_configured");
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
  let skippedOld = 0;
  let rowsRead = 0;
  let windowEdge = false;
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
    let messages: readonly MailMessage[];
    if (fetched.kind === "inbox_backfill") {
      fetchedCount = fetched.page.messages.length;
      const cutoff = scanHistoryCutoff(p.settings.policy.scanHistoryDays, now);
      ({
        kept: messages,
        skippedOld,
        edgeReached: windowEdge,
      } = applyScanWindow(fetched.page.messages, cutoff));
    } else {
      sent = fetched.page.sent;
      removedIds = fetched.page.removedIds;
      fetchedCount = fetched.page.added.length;
      ({ kept: messages, skippedOld } = dropBeyondRetention(fetched.page.added, now));
    }
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
        ? {
            kind: "inbox_backfill",
            nextCursor: fetched.page.nextCursor,
            partial: stage.partial,
            windowEdge,
          }
        : fetched.kind === "incremental"
          ? {
              kind: "incremental",
              startCursor: fetched.startCursor,
              nextCursor: fetched.page.nextCursor,
              caughtUp: fetched.page.caughtUp,
              partial: stage.partial,
              storageGated: p.storageGated,
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
    skippedOld,
    freshCount: fresh.length,
    rowsRead,
  };
}
