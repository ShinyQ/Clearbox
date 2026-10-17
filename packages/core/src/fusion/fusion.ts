import type { DecisionFlags, DecisionResult } from "../decision/engine.ts";
import { IMPORTANCE_LEVELS } from "../decision/questions.ts";
import type { GuardrailResult } from "../guardrails/guardrails.ts";
import {
  ACTION_RANK,
  isAllowedByCeiling,
  type ActionDistribution,
  type Ceiling,
  type SuggestedAction,
} from "../model/actions.ts";
import {
  EXPIRED_HUMAN_MAX,
  EXPIRED_SHIFT,
  FLAG_THRESHOLD,
  HUMAN_SHIFT,
  MAX_REASONS,
  PRIOR_LAMBDA_K,
  PRIOR_MIN_N,
  RECORD_SHIFT,
} from "../model/constants.ts";
import type { Reason } from "../model/reasons.ts";
import type { Prior } from "../priors/priors.ts";
import type { Signals } from "../signals/signals.ts";
import { decisionSegment, segmentTau, type DecisionSegment, type SegmentTaus } from "./segments.ts";

export interface Thresholds {
  /** From settings, [TAU_DELETE_MIN, TAU_DELETE_MAX], default TAU_DELETE_DEFAULT. */
  tauDelete: number;
  /** DELETE_MARGIN. */
  deleteMargin: number;
  /** MIN_CONFIDENCE. */
  minConfidence: number;
  /**
   * contracts 12.10: calibrated trash threshold per segment (null = paused). A missing segment uses tauDelete.
   * Omitted entirely before the first segment calibration.
   */
  segmentTaus?: SegmentTaus;
}

export interface FusionInput {
  /** null when the model failed permanently for this message. */
  model: DecisionResult | null;
  prior: Prior;
  guard: GuardrailResult;
  signals: Signals;
  thresholds: Thresholds;
}

export interface Suggestion {
  action: SuggestedAction;
  /** distribution[action] after all steps; for model failure: 0. */
  confidence: number;
  /** Final distribution after prior, flags and ceiling folding; null when model is null. */
  distribution: ActionDistribution | null;
  /** Raw model P(delete); null when model is null. */
  modelDelete: number | null;
  /** distribution.delete minus the largest other entry; null when model is null. */
  margin: number | null;
  ceiling: Ceiling;
  ceilingApplied: boolean;
  importance: number | null;
  flags: DecisionFlags | null;
  /** 0..3 entries, selection in contracts 5.2. */
  reasons: Reason[];
  /** contracts 12.10: the evidence segment that picked the trash threshold. */
  segment: DecisionSegment;
  /** The trash threshold this suggestion passed when action is "delete" (0 for rule), else null. */
  deleteTau: number | null;
}

export interface ReasonContext {
  model: DecisionResult | null;
  prior: Prior;
  guard: GuardrailResult;
  signals: Signals;
  /** The suggested action after thresholds. */
  action: SuggestedAction;
  ceilingApplied: boolean;
  /** True when the threshold step fell back to "unsure" for lack of confidence. */
  lowConfidence: boolean;
}

const ORDER_NON_DELETE = ["keep", "archive", "unsure"] as const;
const SIGNAL_CATEGORIES: ReadonlySet<string> = new Set(["promotions", "social", "updates", "forums"]);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function deleteSideReasons(ctx: ReasonContext): Reason[] {
  const { model, signals: s } = ctx;
  const out: Reason[] = [];
  if (model !== null && model.flags.isExpired >= FLAG_THRESHOLD)
    out.push({ code: "flag_expired", params: {} });
  if (s.senderSeenCount >= 5 && s.senderOpenRate !== null && s.senderOpenRate <= 0.1) {
    out.push({
      code: "low_open_rate",
      params: { openPct: Math.round(s.senderOpenRate * 100), seen: s.senderSeenCount },
    });
  }
  if (s.hasListUnsubscribe) out.push({ code: "list_unsubscribe", params: {} });
  if (s.precedenceBulk) out.push({ code: "bulk_mail", params: {} });
  if (s.autoSubmitted) out.push({ code: "auto_sent", params: {} });
  if (s.category !== null && SIGNAL_CATEGORIES.has(s.category)) {
    out.push({ code: "category", params: { category: capitalize(s.category) } });
  }
  if (!s.isRead && s.ageDays >= 30) out.push({ code: "old_unread", params: { ageDays: s.ageDays } });
  const failed =
    s.auth.dmarc === "fail"
      ? "DMARC"
      : s.auth.spf === "fail"
        ? "SPF"
        : s.auth.dkim === "fail"
          ? "DKIM"
          : null;
  if (failed !== null) out.push({ code: "auth_failed", params: { method: failed } });
  return out;
}

function signalReasons(ctx: ReasonContext): Reason[] {
  const { model, action } = ctx;
  if (action === "delete" || action === "unsure") return deleteSideReasons(ctx);
  if (action === "archive") {
    const out: Reason[] = [];
    if (model !== null && model.flags.isRecord >= FLAG_THRESHOLD)
      out.push({ code: "flag_record", params: {} });
    return [...out, ...deleteSideReasons(ctx)];
  }
  const out: Reason[] = [];
  if (model !== null && model.flags.isFromHuman >= FLAG_THRESHOLD)
    out.push({ code: "flag_human", params: {} });
  if (model !== null && model.importance >= 3) {
    const index = Math.min(IMPORTANCE_LEVELS.length - 1, Math.round(model.importance));
    out.push({
      code: "model_important",
      params: { level: (IMPORTANCE_LEVELS[index] ?? "High").toLowerCase() },
    });
  }
  return out;
}

function priorReason(ctx: ReasonContext): Reason | null {
  const { prior, action, signals } = ctx;
  if (prior.source === "none" || prior.n < PRIOR_MIN_N) return null;
  const domain = signals.senderDomain;
  if (action === "delete" || prior.pDelete >= 0.5) {
    const code = prior.source === "sender" ? "prior_sender_deleted" : "prior_domain_deleted";
    return { code, params: { deletes: prior.alpha - 1, total: prior.n, domain } };
  }
  const code = prior.source === "sender" ? "prior_sender_kept" : "prior_domain_kept";
  return { code, params: { keeps: prior.beta - 1, total: prior.n, domain } };
}

/** Up to MAX_REASONS reasons in the priority order of contracts 5.2, without duplicate codes. */
export function selectReasons(ctx: ReasonContext): Reason[] {
  const candidates: Reason[] = [];
  if (ctx.model === null) candidates.push({ code: "model_unavailable", params: {} });
  const holdsBack = (ctx.action === "keep" || ctx.action === "archive") && ctx.guard.ceiling !== "delete";
  if (ctx.ceilingApplied || holdsBack) candidates.push(...ctx.guard.reasons);
  if (ctx.guard.denylisted && ctx.action === "delete") candidates.push({ code: "deny_listed", params: {} });
  if (ctx.lowConfidence) candidates.push({ code: "low_confidence", params: {} });
  const prior = priorReason(ctx);
  if (prior !== null) candidates.push(prior);
  candidates.push(...signalReasons(ctx));

  const seen = new Set<string>();
  const out: Reason[] = [];
  for (const reason of candidates) {
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    out.push(reason);
    if (out.length === MAX_REASONS) break;
  }
  return out;
}

interface Choice {
  action: SuggestedAction;
  confidence: number;
  lowConfidence: boolean;
}

/**
 * tau null: the segment is paused, so never delete. skipCheck: an "Always OK to trash" rule, so delete whenever
 * the ceiling allows it (contracts 12.10).
 */
function choose(dist: ActionDistribution, th: Thresholds, tau: number | null, skipCheck: boolean): Choice {
  const nextBest = Math.max(dist.archive, dist.keep, dist.unsure);
  if (skipCheck && dist.delete > 0)
    return { action: "delete", confidence: dist.delete, lowConfidence: false };
  if (tau !== null && dist.delete >= tau && dist.delete - nextBest >= th.deleteMargin) {
    return { action: "delete", confidence: dist.delete, lowConfidence: false };
  }
  let best: (typeof ORDER_NON_DELETE)[number] = ORDER_NON_DELETE[0];
  for (const candidate of ORDER_NON_DELETE) {
    if (dist[candidate] > dist[best]) best = candidate;
  }
  if (dist[best] < th.minConfidence) {
    return { action: "unsure", confidence: dist.unsure, lowConfidence: true };
  }
  return { action: best, confidence: dist[best], lowConfidence: false };
}

function move(v: ActionDistribution, from: SuggestedAction, to: SuggestedAction, amount: number): void {
  v[from] -= amount;
  v[to] += amount;
}

function clampAndRenormalize(v: ActionDistribution): ActionDistribution {
  const c = {
    delete: Math.min(1, Math.max(0, v.delete)),
    archive: Math.min(1, Math.max(0, v.archive)),
    keep: Math.min(1, Math.max(0, v.keep)),
    unsure: Math.min(1, Math.max(0, v.unsure)),
  };
  const sum = c.delete + c.archive + c.keep + c.unsure;
  if (sum === 0) return { delete: 0, archive: 0, keep: 0, unsure: 1 };
  return { delete: c.delete / sum, archive: c.archive / sum, keep: c.keep / sum, unsure: c.unsure / sum };
}

/** Deterministic fusion of model, prior, flags and guardrail ceiling (contracts 5.1). */
export function fuse(input: FusionInput): Suggestion {
  const { model, prior, guard, signals, thresholds } = input;
  const segment = decisionSegment(prior, signals, guard);
  const tau = segmentTau(segment, thresholds.tauDelete, thresholds.segmentTaus);
  const skipCheck = segment === "rule";
  if (model === null) {
    return {
      action: "unsure",
      confidence: 0,
      distribution: null,
      modelDelete: null,
      margin: null,
      ceiling: guard.ceiling,
      ceilingApplied: false,
      importance: null,
      flags: null,
      reasons: selectReasons({
        model: null,
        prior,
        guard,
        signals,
        action: "unsure",
        ceilingApplied: false,
        lowConfidence: false,
      }),
      segment,
      deleteTau: null,
    };
  }

  const m = model.action;
  const lambda = prior.n / (prior.n + PRIOR_LAMBDA_K);
  const d = (1 - lambda) * m.delete + lambda * prior.pDelete;

  let v: ActionDistribution;
  if (m.delete < 1) {
    const scale = (1 - d) / (1 - m.delete);
    v = { delete: d, archive: m.archive * scale, keep: m.keep * scale, unsure: m.unsure * scale };
  } else {
    v = { delete: d, archive: 0, keep: 0, unsure: 1 - d };
  }

  const f = model.flags;
  if (f.isRecord >= FLAG_THRESHOLD) move(v, "delete", "archive", RECORD_SHIFT * v.delete);
  if (f.isFromHuman >= FLAG_THRESHOLD) move(v, "delete", "keep", HUMAN_SHIFT * v.delete);
  if (f.isExpired >= FLAG_THRESHOLD && f.isFromHuman < EXPIRED_HUMAN_MAX) {
    move(v, "archive", "delete", EXPIRED_SHIFT * v.archive);
  }
  v = clampAndRenormalize(v);

  const unbounded = choose(v, thresholds, tau, skipCheck);
  const w: ActionDistribution = { ...v };
  for (const x of ["delete", "archive"] as const) {
    if (ACTION_RANK[x] > ACTION_RANK[guard.ceiling]) {
      w[guard.ceiling] += w[x];
      w[x] = 0;
    }
  }

  const chosen = choose(w, thresholds, tau, skipCheck);
  const ceilingApplied = !isAllowedByCeiling(unbounded.action, guard.ceiling);

  return {
    action: chosen.action,
    confidence: chosen.confidence,
    distribution: w,
    modelDelete: m.delete,
    margin: w.delete - Math.max(w.archive, w.keep, w.unsure),
    ceiling: guard.ceiling,
    ceilingApplied,
    importance: model.importance,
    flags: f,
    reasons: selectReasons({
      model,
      prior,
      guard,
      signals,
      action: chosen.action,
      ceilingApplied,
      lowConfidence: chosen.lowConfidence,
    }),
    segment,
    deleteTau: chosen.action === "delete" ? tau : null,
  };
}
