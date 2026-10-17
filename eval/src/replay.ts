import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  DEFAULT_POLICY,
  DELETE_MARGIN,
  MIN_CONFIDENCE,
  TAU_DELETE_DEFAULT,
  calibrateSegments,
  calibrateTauDelete,
  evaluateGuardrails,
  fuse,
  minCeiling,
  selectPrior,
} from "@clearbox/core";
import type {
  ActionDistribution,
  ActionKind,
  Ceiling,
  DecisionFlags,
  DecisionResult,
  DecisionSegment,
  Policy,
  PriorCounts,
  SegmentCalibrationSample,
  SegmentTaus,
  Signals,
  SuggestedAction,
} from "@clearbox/core";
import { parseD1Rows } from "./export-labels.ts";
import { LOCAL_D1_ID, PRIVATE_DIR, REPO_ROOT, assertGitIgnored, isMain, readD1Id } from "./io.ts";
import { deletePrecisionRecall, type PrecisionRecall } from "./metrics.ts";

/**
 * Offline replay of the contracts 12.10 pipeline on exported owner labels, without calling the model: each label's
 * stored model output is re-fused with the owner decisions made before it, recent mail is decided once it is old
 * enough (no "too recent" cap), and trash thresholds are calibrated per segment on the earlier part of the
 * timeline and measured on the later part. No subjects or snippets are exported.
 */

const COMMON = `s.model_p_delete, s.p_archive, s.p_keep, s.p_unsure, s.ceiling AS s_ceiling, s.flags_json, s.importance,
  s.reasons_json, s.model_action_json, m.received_at, m.signals_json`;
/** For a database that predates migration 0003. */
export const withoutModelColumn = (sql: string): string =>
  sql.replace("s.model_action_json", "NULL AS model_action_json");

export const REPLAY_LABELS_SQL = `SELECT l.id, l.created_at, l.sender, l.sender_domain, l.owner_action, l.suggested_action,
  l.p_delete, l.margin, s.created_at AS s_created, ${COMMON}
  FROM labels l LEFT JOIN suggestions s ON s.message_id = l.message_id AND s.account_id = l.account_id
  LEFT JOIN messages m ON m.id = l.message_id AND m.account_id = l.account_id ORDER BY l.id`;

export const REPLAY_PENDING_SQL = `SELECT s.message_id AS id, s.sender, s.sender_domain, s.status, s.action, ${COMMON}
  FROM suggestions s JOIN messages m ON m.id = s.message_id AND m.account_id = s.account_id
  WHERE s.status IN ('pending', 'awaiting_model')`;

export interface StoredDecision {
  action: ActionDistribution;
  flags: DecisionFlags;
  importance: number;
}

export interface ReplayRow {
  id: number;
  sender: string;
  senderDomain: string;
  receivedAt: number;
  signals: Signals | null;
  /** Caps that need the subject or snippet (record patterns), from the stored reasons. */
  recordPattern: boolean;
  storedCeiling: Ceiling;
  model: StoredDecision | null;
}

export interface ReplayLabel extends ReplayRow {
  createdAt: number;
  decidedAt: number;
  ownerAction: ActionKind;
  suggestedAction: SuggestedAction;
  storedPDelete: number | null;
  storedMargin: number | null;
}

export interface ReplayPending extends ReplayRow {
  status: string;
  action: SuggestedAction | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseJson<T>(v: unknown): T | null {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/**
 * The raw model distribution: model_action_json when stored, else rebuilt from model_p_delete and the stored
 * distribution (non-delete shares kept, mass folded by the ceiling removed). Approximate for capped rows only.
 */
export function reconstructModel(r: Record<string, unknown>): StoredDecision | null {
  const flags = parseJson<DecisionFlags>(r.flags_json);
  const stored = parseJson<ActionDistribution>(r.model_action_json);
  if (flags === null) return null;
  const importance = num(r.importance) ?? 0;
  if (stored !== null && typeof stored.delete === "number") return { action: stored, flags, importance };
  const md = num(r.model_p_delete);
  if (md === null) return null;
  let pa = num(r.p_archive) ?? 0;
  let pk = num(r.p_keep) ?? 0;
  const pu = num(r.p_unsure) ?? 0;
  const ceiling = str(r.s_ceiling);
  if (ceiling === "keep") pk = Math.max(0, pk - md - pa);
  if (ceiling === "archive") pa = Math.max(0, pa - md);
  const sum = pa + pk + pu;
  const rest = 1 - md;
  const action =
    sum <= 0
      ? { delete: md, archive: 0, keep: 0, unsure: rest }
      : { delete: md, archive: (pa / sum) * rest, keep: (pk / sum) * rest, unsure: (pu / sum) * rest };
  return { action, flags, importance };
}

function baseRow(r: Record<string, unknown>): ReplayRow {
  const reasons = parseJson<{ code: string }[]>(r.reasons_json) ?? [];
  const ceiling = str(r.s_ceiling);
  return {
    id: num(r.id) ?? 0,
    sender: str(r.sender),
    senderDomain: str(r.sender_domain),
    receivedAt: num(r.received_at) ?? 0,
    signals: parseJson<Signals>(r.signals_json),
    recordPattern: reasons.some((x) => x.code === "guard_record_pattern"),
    storedCeiling: ceiling === "keep" || ceiling === "archive" ? ceiling : "delete",
    model: reconstructModel(r),
  };
}

export function toReplayLabel(r: Record<string, unknown>): ReplayLabel {
  const createdAt = num(r.created_at) ?? 0;
  return {
    ...baseRow(r),
    createdAt,
    decidedAt: num(r.s_created) ?? createdAt,
    ownerAction: str(r.owner_action) as ActionKind,
    suggestedAction: str(r.suggested_action) as SuggestedAction,
    storedPDelete: num(r.p_delete),
    storedMargin: num(r.margin),
  };
}

export function toReplayPending(r: Record<string, unknown>): ReplayPending {
  const action = str(r.action);
  return { ...baseRow(r), status: str(r.status), action: action === "" ? null : (action as SuggestedAction) };
}

export interface PriorBook {
  counts: Map<string, PriorCounts>;
}

function bump(book: PriorBook, key: string, ownerAction: ActionKind): void {
  if (key === "" || key === "@") return;
  const c = book.counts.get(key) ?? { deletes: 0, keeps: 0 };
  if (ownerAction === "delete") c.deletes += 1;
  else c.keeps += 1;
  book.counts.set(key, c);
}

export interface Scored {
  p: number;
  margin: number;
  segment: DecisionSegment;
  ownerAction: ActionKind;
  createdAt: number;
}

/** Re-fuses one stored row with the given priors (recent mail is decided once old enough: no recency cap). */
export function scoreRow(
  row: ReplayRow,
  book: PriorBook,
  policy: Policy,
  segmentTaus?: SegmentTaus,
): (Omit<Scored, "ownerAction" | "createdAt"> & { action: SuggestedAction }) | null {
  if (row.model === null || row.signals === null) return null;
  const signals: Signals = {
    ...row.signals,
    ageDays: row.receivedAt > 0 ? Math.max(row.signals.ageDays, policy.minAgeDays) : 0,
  };
  const computed = evaluateGuardrails({ signals, subject: "", snippet: "" }, policy);
  const ceiling = row.recordPattern ? minCeiling(computed.ceiling, "archive") : computed.ceiling;
  const guard = ceiling === computed.ceiling ? computed : { ...computed, ceiling };
  const prior = selectPrior(
    book.counts.get(row.sender) ?? null,
    book.counts.get(`@${row.senderDomain}`) ?? null,
    row.sender,
    row.senderDomain,
  );
  const model: DecisionResult = {
    action: row.model.action,
    importance: row.model.importance,
    flags: row.model.flags,
    responseModel: "",
    modelVersion: "replay",
    inputTokens: 0,
    requestId: null,
    latencyMs: 0,
  };
  const s = fuse({
    model,
    prior,
    guard,
    signals,
    thresholds: {
      tauDelete: TAU_DELETE_DEFAULT,
      deleteMargin: DELETE_MARGIN,
      minConfidence: MIN_CONFIDENCE,
      ...(segmentTaus === undefined ? {} : { segmentTaus }),
    },
  });
  return { p: s.distribution?.delete ?? 0, margin: s.margin ?? -1, segment: s.segment, action: s.action };
}

/** Chronological replay: each label is scored with only the owner decisions made strictly before it. */
export function replayLabels(labels: readonly ReplayLabel[], policy: Policy): Scored[] {
  const ordered = [...labels].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const book: PriorBook = { counts: new Map() };
  const out: Scored[] = [];
  let i = 0;
  while (i < ordered.length) {
    // Labels of one owner action share created_at; they see only decisions made before that action.
    let j = i;
    while (j < ordered.length && ordered[j]?.createdAt === ordered[i]?.createdAt) j++;
    const batch = ordered.slice(i, j);
    for (const l of batch) {
      const s = scoreRow(l, book, policy);
      if (s !== null) {
        out.push({
          p: s.p,
          margin: s.margin,
          segment: s.segment,
          ownerAction: l.ownerAction,
          createdAt: l.createdAt,
        });
      }
    }
    for (const l of batch) {
      bump(book, l.sender, l.ownerAction);
      bump(book, `@${l.senderDomain}`, l.ownerAction);
    }
    i = j;
  }
  return out;
}

function predicts(s: { p: number; margin: number }, tau: number | null): boolean {
  return tau !== null && s.p >= tau && s.margin >= DELETE_MARGIN;
}

function precisionRecall(
  rows: readonly { p: number; margin: number; segment?: DecisionSegment; ownerAction: ActionKind }[],
  tauOf: (segment: DecisionSegment | undefined) => number | null,
): PrecisionRecall {
  return deletePrecisionRecall(
    rows.map((r) => ({
      predicted: predicts(r, tauOf(r.segment)) ? "delete" : "unsure",
      label: r.ownerAction,
    })),
  );
}

/** Like replayLabels, but returns the suggested action under the given segment thresholds. */
export function replayActions(
  labels: readonly ReplayLabel[],
  policy: Policy,
  taus: SegmentTaus,
): { action: SuggestedAction; ownerAction: ActionKind }[] {
  const book: PriorBook = { counts: new Map() };
  const out: { action: SuggestedAction; ownerAction: ActionKind }[] = [];
  let i = 0;
  while (i < labels.length) {
    let j = i;
    while (j < labels.length && labels[j]?.createdAt === labels[i]?.createdAt) j++;
    const batch = labels.slice(i, j);
    for (const l of batch) {
      const s = scoreRow(l, book, policy, taus);
      if (s !== null) out.push({ action: s.action, ownerAction: l.ownerAction });
    }
    for (const l of batch) {
      bump(book, l.sender, l.ownerAction);
      bump(book, `@${l.senderDomain}`, l.ownerAction);
    }
    i = j;
  }
  return out;
}

const newestFirst = <T>(rows: readonly T[]): T[] => [...rows].reverse();

export interface ReplayReport {
  labels: number;
  scored: number;
  trainShare: number;
  before: {
    production: PrecisionRecall;
    tauTrain: number;
    test: PrecisionRecall;
    tauAll: number;
    pendingDeletes: number;
    keepToTrash: number;
  };
  after: {
    tausTrain: Record<string, number | null>;
    test: PrecisionRecall;
    tausAll: Record<string, number | null>;
    all: PrecisionRecall;
    segments: {
      segment: string;
      outcome: string;
      deleteSuggestions: number;
      precisionAtTau: number | null;
    }[];
    pendingDeletes: number;
    pendingScored: number;
    /** Owner-trashed emails the replayed pipeline would still suggest as Keep (before: as suggested). */
    keepToTrash: number;
    /** Senders offered "Always OK to trash" (10+ decisions, 95%+ trash, nothing contrary in 30 days). */
    ruleOffers: number;
    /** Pending trash suggestions if the owner accepted every offered rule. */
    pendingDeletesWithRules: number;
  };
}

const RULE_MIN = 10;
const RULE_AGREEMENT = 0.95;
const RULE_QUIET_MS = 30 * 86_400_000;

/** Mirrors app/src/worker/routes/rules.ts pickRuleSuggestions for "Always OK to trash". */
export function ruleOffers(labels: readonly ReplayLabel[], now: number): string[] {
  const by = new Map<string, { d: number; n: number; lastContrary: number }>();
  for (const l of labels) {
    if (l.sender === "") continue;
    const c = by.get(l.sender) ?? { d: 0, n: 0, lastContrary: 0 };
    c.n += 1;
    if (l.ownerAction === "delete") c.d += 1;
    else c.lastContrary = Math.max(c.lastContrary, l.createdAt);
    by.set(l.sender, c);
  }
  return [...by.entries()]
    .filter(
      ([, c]) =>
        c.d >= RULE_MIN &&
        c.d / c.n >= RULE_AGREEMENT &&
        (c.lastContrary === 0 || c.lastContrary < now - RULE_QUIET_MS),
    )
    .map(([sender]) => sender)
    .sort();
}

/**
 * before: production as it ran (stored suggestions; one global threshold calibrated on stored p_delete).
 * after: replayed pipeline with per-segment thresholds. Both measured on the same later share of the timeline.
 */
export function runReplay(
  labels: readonly ReplayLabel[],
  pending: readonly ReplayPending[],
  opts: { trainShare?: number; policy?: Policy } = {},
): ReplayReport {
  const trainShare = opts.trainShare ?? 0.6;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const ordered = [...labels].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const cut = Math.floor(ordered.length * trainShare);
  const cutAt = ordered[cut]?.createdAt ?? Number.POSITIVE_INFINITY;

  // Before.
  const stored = ordered.map((l) => ({
    pDelete: l.storedPDelete,
    margin: l.storedMargin,
    ceiling: "delete" as const,
    ownerAction: l.ownerAction,
    createdAt: l.createdAt,
  }));
  const storedTrain = stored.filter((s) => s.createdAt < cutAt);
  const storedTest = stored.filter((s) => s.createdAt >= cutAt);
  const tauTrain = calibrateTauDelete(newestFirst(storedTrain), TAU_DELETE_DEFAULT).tauDelete;
  const tauAll = calibrateTauDelete(newestFirst(stored), TAU_DELETE_DEFAULT).tauDelete;
  const asScored = (rows: typeof stored) =>
    rows
      .filter((s) => s.pDelete !== null && s.margin !== null)
      .map((s) => ({ p: s.pDelete ?? 0, margin: s.margin ?? 0, ownerAction: s.ownerAction }));
  const production = deletePrecisionRecall(
    ordered.map((l) => ({ predicted: l.suggestedAction, label: l.ownerAction })),
  );

  // After.
  const scored = replayLabels(ordered, policy);
  const train = scored.filter((s) => s.createdAt < cutAt);
  const test = scored.filter((s) => s.createdAt >= cutAt);
  const samples = (rows: readonly Scored[]): SegmentCalibrationSample[] =>
    newestFirst(rows).map((s) => ({
      pDelete: s.p,
      margin: s.margin,
      ceiling: "delete",
      ownerAction: s.ownerAction,
      segment: s.segment,
    }));
  const trainCal = calibrateSegments(samples(train), TAU_DELETE_DEFAULT, {});
  const allCal = calibrateSegments(samples(scored), TAU_DELETE_DEFAULT, {});
  const tauIn =
    (taus: SegmentTaus) =>
    (segment: DecisionSegment | undefined): number | null =>
      segment === "rule" ? 0 : segment === undefined ? null : (taus[segment] ?? null);

  const book: PriorBook = { counts: new Map() };
  for (const l of ordered) {
    bump(book, l.sender, l.ownerAction);
    bump(book, `@${l.senderDomain}`, l.ownerAction);
  }
  const now = ordered[ordered.length - 1]?.createdAt ?? 0;
  const keepToTrash = replayActions(ordered, policy, allCal.taus).filter(
    (x) => x.action === "keep" && x.ownerAction === "delete",
  ).length;
  const offers = ruleOffers(ordered, now);
  const withRules: Policy = { ...policy, denylist: [...policy.denylist, ...offers] };
  let pendingDeletes = 0;
  let pendingScored = 0;
  let pendingDeletesWithRules = 0;
  for (const row of pending) {
    const s = scoreRow(row, book, policy);
    if (s === null) continue;
    pendingScored += 1;
    if (predicts(s, tauIn(allCal.taus)(s.segment))) pendingDeletes += 1;
    const r = scoreRow(row, book, withRules);
    if (r !== null && (r.segment === "rule" || predicts(r, tauIn(allCal.taus)(r.segment)))) {
      pendingDeletesWithRules += 1;
    }
  }

  return {
    labels: labels.length,
    scored: scored.length,
    trainShare,
    before: {
      production,
      tauTrain,
      test: precisionRecall(asScored(storedTest), () => tauTrain),
      tauAll,
      pendingDeletes: pending.filter((p) => p.status === "pending" && p.action === "delete").length,
      keepToTrash: ordered.filter((l) => l.suggestedAction === "keep" && l.ownerAction === "delete").length,
    },
    after: {
      tausTrain: trainCal.taus,
      test: precisionRecall(test, tauIn(trainCal.taus)),
      tausAll: allCal.taus,
      all: precisionRecall(scored, tauIn(allCal.taus)),
      segments: allCal.segments.map((g) => ({
        segment: g.segment,
        outcome: g.outcome,
        deleteSuggestions: g.deleteSuggestions,
        precisionAtTau: g.precisionAtTau,
      })),
      pendingDeletes,
      pendingScored,
      keepToTrash,
      ruleOffers: offers.length,
      pendingDeletesWithRules,
    },
  };
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const pr = (m: PrecisionRecall): string =>
  `${pct(m.precision)} (${m.truePositives}/${m.truePositives + m.falsePositives}) | ${pct(m.recall)}`;

export function renderReplay(r: ReplayReport): string {
  const taus = (t: Record<string, number | null>) =>
    Object.entries(t)
      .map(([k, v]) => `${k} ${v === null ? "paused" : v.toFixed(2)}`)
      .join(", ");
  return [
    "# Clearbox replay (contracts 12.10)",
    "",
    `Labels: ${r.labels}, replayable: ${r.scored}. Thresholds fitted on the first ${Math.round(r.trainShare * 100)}% of the timeline, measured on the rest.`,
    "",
    "| Pipeline | Trash precision (hits/suggested) | Trash recall |",
    "|---|---|---|",
    `| Before, as suggested in production (all labels) | ${pr(r.before.production)} |`,
    `| Before, global threshold ${r.before.tauTrain.toFixed(2)} (held-out) | ${pr(r.before.test)} |`,
    `| After, per segment (held-out) | ${pr(r.after.test)} |`,
    `| After, per segment (all labels, in-sample) | ${pr(r.after.all)} |`,
    "",
    `Thresholds before: global ${r.before.tauAll.toFixed(2)}. After (all labels): ${taus(r.after.tausAll)}.`,
    "",
    "| Segment | Outcome | Trash suggestions at 0.80 | Precision at threshold |",
    "|---|---|---|---|",
    ...r.after.segments.map(
      (g) => `| ${g.segment} | ${g.outcome} | ${g.deleteSuggestions} | ${pct(g.precisionAtTau)} |`,
    ),
    "",
    `Pending trash suggestions: before ${r.before.pendingDeletes}, after ${r.after.pendingDeletes} (of ${r.after.pendingScored} open emails re-fused).`,
    `Owner-trashed emails suggested as Keep: before ${r.before.keepToTrash}, after ${r.after.keepToTrash}.`,
    `Always OK to trash offers: ${r.after.ruleOffers} senders; pending trash suggestions if all are accepted: ${r.after.pendingDeletesWithRules}.`,
    "",
  ].join("\n");
}

function query(sql: string, local: boolean): Record<string, unknown>[] {
  const appDir = join(REPO_ROOT, "app");
  const cf = join(appDir, "node_modules", ".bin", "cf");
  const d1Id = local ? LOCAL_D1_ID : readD1Id();
  const flat = sql.replace(/\s+/g, " ");
  const args = local
    ? [
        "d1",
        "raw",
        d1Id,
        "--local",
        "--persist-to",
        join(appDir, ".cloudflare", "state"),
        "--mode",
        "development",
        `--sql=${flat}`,
      ]
    : ["d1", "raw", d1Id, `--sql=${flat}`];
  const result = spawnSync(cf, args, { cwd: appDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = result.stderr.split("\n").slice(0, 5).join(" ");
    throw new Error(`cf d1 raw failed (exit ${result.status ?? "signal"}): ${detail}`);
  }
  return parseD1Rows(JSON.parse(result.stdout));
}

function writePrivate(path: string, text: string): void {
  assertGitIgnored(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function main(): number {
  const { values } = parseArgs({
    options: {
      export: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      data: { type: "string", default: join(PRIVATE_DIR, "replay.json") },
      out: { type: "string", default: join(PRIVATE_DIR, "reports", "replay.md") },
      train: { type: "string", default: "0.6" },
    },
  });
  const data = resolve(values.data);
  if (values.export) {
    const run = (sql: string): Record<string, unknown>[] => {
      try {
        return query(sql, values.local);
      } catch (error) {
        if (!String(error).includes("no such column")) throw error;
        return query(withoutModelColumn(sql), values.local);
      }
    };
    const payload = { labels: run(REPLAY_LABELS_SQL), pending: run(REPLAY_PENDING_SQL) };
    writePrivate(data, JSON.stringify(payload));
    console.log(
      `Exported ${payload.labels.length} labels and ${payload.pending.length} open suggestions to ${data}.`,
    );
  }
  const raw = JSON.parse(readFileSync(data, "utf8")) as {
    labels: Record<string, unknown>[];
    pending: Record<string, unknown>[];
  };
  const report = runReplay(raw.labels.map(toReplayLabel), raw.pending.map(toReplayPending), {
    trainShare: Number(values.train),
  });
  const text = renderReplay(report);
  writePrivate(resolve(values.out), text);
  console.log(text);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`replay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
