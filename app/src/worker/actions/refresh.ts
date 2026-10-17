import { DELETE_MARGIN, MIN_CONFIDENCE, refreshSuggestion, registrableDomain } from "@clearbox/core";
import type {
  ActionDistribution,
  DecisionFlags,
  Policy,
  PriorCounts,
  SegmentTaus,
  Signals,
  Thresholds,
} from "@clearbox/core";
import { listAccounts } from "../db/accounts.ts";
import { budgetDeltaStmt } from "../db/budget.ts";
import { refreshPriorsQuery, refreshRowsQuery, refreshUpdateQuery } from "../db/refresh.ts";
import type { RefreshFilter, RefreshRow, RefreshUpdate } from "../db/refresh.ts";
import { bindQuery, MAX_BOUND_PARAMS, sumRowsRead, sumRowsWritten, utcDate } from "../db/sql.ts";

/** Rows re-fused per call by an owner action or a rule change; the nightly job pages through the rest. */
export const REFRESH_LIMIT = 200;
/** Senders plus domains per refresh query (the statement also binds the account, keyset and limit). */
const SCOPE_MAX = MAX_BOUND_PARAMS - 4;
/** Scoped queries per account and request; more is left to the nightly refresh. */
export const REFRESH_MAX_CHUNKS = 2;
const EPS = 1e-9;

export interface RefreshSettings {
  policy: Policy;
  tauDelete: number;
  segmentTaus: SegmentTaus | null;
}

export interface RefreshScope {
  accountId: string;
  /** Empty senders and domains: every pending suggestion of the account. */
  senders?: readonly string[];
  domains?: readonly string[];
  afterId?: number;
  limit?: number;
}

export interface RefreshOutcome {
  scanned: number;
  updated: number;
  rowsRead: number;
  rowsWritten: number;
  d1Calls: number;
  /** Highest message_id scanned (keyset for the next page); null when nothing was scanned. */
  lastId: number | null;
}

export function thresholdsOf(s: RefreshSettings): Thresholds {
  return {
    tauDelete: s.tauDelete,
    deleteMargin: DELETE_MARGIN,
    minConfidence: MIN_CONFIDENCE,
    ...(s.segmentTaus === null ? {} : { segmentTaus: s.segmentTaus }),
  };
}

function differs(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > EPS;
}

/** Pure: the update for one stored row, or null when nothing visible changes. Exported for tests. */
export function refreshRow(
  row: RefreshRow,
  priors: ReadonlyMap<string, PriorCounts>,
  s: RefreshSettings,
  now: number,
): RefreshUpdate | null {
  let action: ActionDistribution;
  let signals: Signals;
  let flags: DecisionFlags;
  try {
    action = JSON.parse(row.model_action_json) as ActionDistribution;
    signals = JSON.parse(row.signals_json) as Signals;
    flags = JSON.parse(row.flags_json ?? "null") as DecisionFlags;
  } catch {
    return null;
  }
  if (flags === null || typeof action?.delete !== "number") return null;
  const { suggestion } = refreshSuggestion({
    model: { action, flags, importance: row.importance ?? 0, modelVersion: row.model_version ?? "" },
    signals,
    receivedAt: row.received_at,
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    storedCeiling: row.ceiling,
    policy: s.policy,
    senderPrior: row.sender === "" ? null : (priors.get(row.sender) ?? null),
    domainPrior: row.sender_domain === "" ? null : (priors.get(`@${row.sender_domain}`) ?? null),
    thresholds: thresholdsOf(s),
    now,
  });
  const d = suggestion.distribution;
  const reasonsJson = JSON.stringify(suggestion.reasons);
  const same =
    suggestion.action === row.action &&
    suggestion.ceiling === row.ceiling &&
    suggestion.segment === row.segment &&
    !differs(suggestion.deleteTau, row.delete_tau) &&
    !differs(suggestion.confidence, row.confidence) &&
    !differs(d?.delete ?? null, row.p_delete) &&
    reasonsJson === row.reasons_json;
  if (same) return null;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return {
    messageId: row.message_id,
    action: suggestion.action,
    confidence: clamp(suggestion.confidence),
    pDelete: d === null ? null : clamp(d.delete),
    pArchive: d === null ? null : clamp(d.archive),
    pKeep: d === null ? null : clamp(d.keep),
    pUnsure: d === null ? null : clamp(d.unsure),
    margin: suggestion.margin,
    ceiling: suggestion.ceiling,
    ceilingApplied: suggestion.ceilingApplied,
    reasonsJson,
    segment: suggestion.segment,
    deleteTau: suggestion.deleteTau,
  };
}

/**
 * contracts 12.10: re-fuse pending suggestions with the current priors, rules and thresholds (no model call), so
 * owner decisions, new rules and a new calibration reach what is already in Review. Two D1 calls: one read batch,
 * one write batch with only the rows that changed.
 */
export async function refreshPending(
  db: D1Database,
  scope: RefreshScope,
  settings: RefreshSettings,
  now: number,
): Promise<RefreshOutcome> {
  const senders = [...new Set(scope.senders ?? [])].filter((x) => x !== "");
  const domains = [...new Set(scope.domains ?? [])].filter((x) => x !== "");
  if (senders.length + domains.length > SCOPE_MAX)
    throw new RangeError("refresh scope too wide; use refreshScoped");
  const filter: RefreshFilter = {
    senders,
    domains,
    afterId: scope.afterId ?? 0,
    limit: scope.limit ?? REFRESH_LIMIT,
  };
  const reads = await db.batch([
    bindQuery(db, refreshRowsQuery(scope.accountId, filter)),
    bindQuery(db, refreshPriorsQuery(scope.accountId, filter)),
  ]);
  const rows = (reads[0]?.results ?? []) as RefreshRow[];
  const priors = new Map<string, PriorCounts>();
  for (const p of (reads[1]?.results ?? []) as { key: string; deletes: number; keeps: number }[]) {
    priors.set(p.key, { deletes: p.deletes, keeps: p.keeps });
  }
  const updates = rows.flatMap((r) => {
    const u = refreshRow(r, priors, settings, now);
    return u === null ? [] : [u];
  });
  const writes =
    updates.length === 0
      ? []
      : await db.batch(updates.map((u) => bindQuery(db, refreshUpdateQuery(scope.accountId, u, now))));
  return {
    scanned: rows.length,
    updated: writes.reduce((n, r) => n + (r.meta.changes ?? 0), 0),
    rowsRead: sumRowsRead(reads) + sumRowsRead(writes),
    rowsWritten: sumRowsWritten(writes),
    d1Calls: 1 + (writes.length > 0 ? 1 : 0),
    lastId: rows.length === 0 ? null : (rows[rows.length - 1]?.message_id ?? null),
  };
}

function addOutcome(a: RefreshOutcome, b: RefreshOutcome): RefreshOutcome {
  return {
    scanned: a.scanned + b.scanned,
    updated: a.updated + b.updated,
    rowsRead: a.rowsRead + b.rowsRead,
    rowsWritten: a.rowsWritten + b.rowsWritten,
    d1Calls: a.d1Calls + b.d1Calls,
    lastId: b.lastId ?? a.lastId,
  };
}

const EMPTY: RefreshOutcome = {
  scanned: 0,
  updated: 0,
  rowsRead: 0,
  rowsWritten: 0,
  d1Calls: 0,
  lastId: null,
};

/**
 * contracts 12.10: re-fuse the pending suggestions of these domains and senders in one account. A domain covers
 * every sender in it, so senders only matter when their domain is unknown or not listed. Chunked to the parameter
 * limit, at most REFRESH_MAX_CHUNKS queries; the nightly refresh covers anything beyond.
 */
export async function refreshScoped(
  db: D1Database,
  accountId: string,
  scope: { senders: readonly string[]; domains: readonly string[] },
  settings: RefreshSettings,
  now: number,
): Promise<RefreshOutcome> {
  const domains = [...new Set(scope.domains.filter((d) => d !== ""))];
  const covered = new Set(domains);
  const senders = [...new Set(scope.senders.filter((x) => x !== ""))].filter(
    (x) => !covered.has(x.slice(x.lastIndexOf("@") + 1)) && !covered.has(registrableOf(x)),
  );
  const keys: { kind: "domain" | "sender"; value: string }[] = [
    ...domains.map((value) => ({ kind: "domain" as const, value })),
    ...senders.map((value) => ({ kind: "sender" as const, value })),
  ];
  let out = EMPTY;
  for (let i = 0, chunks = 0; i < keys.length && chunks < REFRESH_MAX_CHUNKS; i += SCOPE_MAX, chunks++) {
    const part = keys.slice(i, i + SCOPE_MAX);
    const res = await refreshPending(
      db,
      {
        accountId,
        domains: part.filter((k) => k.kind === "domain").map((k) => k.value),
        senders: part.filter((k) => k.kind === "sender").map((k) => k.value),
      },
      settings,
      now,
    );
    out = addOutcome(out, res);
  }
  return out;
}

function registrableOf(address: string): string {
  const host = address.slice(address.lastIndexOf("@") + 1);
  return host === "" ? "" : registrableDomain(host);
}

/**
 * contracts 12.10: after "Always keep" / "Always OK to trash" changes, re-fuse the pending suggestions they cover in
 * every connected account (one scoped refresh per account) and count the rows in today's budget once. "@domain"
 * entries cover the registrable domain (a superset of a subdomain entry; the guardrails decide per row).
 */
export async function refreshForEntries(
  db: D1Database,
  entries: readonly string[],
  settings: RefreshSettings,
  now: number,
): Promise<void> {
  if (entries.length === 0) return;
  const scope = {
    senders: entries.filter((e) => !e.startsWith("@")),
    domains: entries.filter((e) => e.startsWith("@")).map((e) => registrableDomain(e.slice(1))),
  };
  const accounts = await listAccounts(db, { includeDisconnected: false });
  let total = EMPTY;
  for (const a of accounts) total = addOutcome(total, await refreshScoped(db, a.id, scope, settings, now));
  if (total.rowsRead + total.rowsWritten > 0) {
    await budgetDeltaStmt(
      db,
      utcDate(now),
      { rowsWritten: total.rowsWritten + 1, rowsRead: total.rowsRead },
      now,
    ).run();
  }
}
