import type { ActionKind, Ceiling } from "../model/actions.ts";
import {
  CALIBRATED_SEGMENTS,
  type CalibratedSegment,
  type DecisionSegment,
  type SegmentTaus,
} from "../fusion/segments.ts";
import {
  CALIBRATION_MIN_DELETE_SUGGESTIONS,
  CALIBRATION_WINDOW,
  CALIBRATION_MIN_SUPPORT,
  CALIBRATION_TARGET_PRECISION,
  DELETE_MARGIN,
  TAU_DELETE_MAX,
  TAU_DELETE_MIN,
  TAU_STEP,
} from "../model/constants.ts";

export interface CalibrationSample {
  /** labels.p_delete (fused, after ceiling). */
  pDelete: number | null;
  /** labels.margin. */
  margin: number | null;
  ceiling: Ceiling;
  ownerAction: ActionKind;
}

export interface CalibrationPoint {
  tau: number;
  support: number;
  precision: number | null;
}

export interface CalibrationResult {
  tauDelete: number;
  changed: boolean;
  outcome: "insufficient_data" | "calibrated" | "no_tau_meets_target";
  /** Support at TAU_DELETE_MIN. */
  deleteSuggestions: number;
  precisionAtTau: number | null;
  /** Every tau evaluated, ascending. */
  points: CalibrationPoint[];
}

interface ScoredSample {
  pDelete: number;
  margin: number;
  ownerAction: ActionKind;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function wouldDelete(s: ScoredSample, tau: number): boolean {
  return s.pDelete >= tau && s.margin >= DELETE_MARGIN;
}

/** Grid search for the smallest tau with enough support and precision >= target (contracts 5.3). */
export function calibrateTauDelete(
  samples: readonly CalibrationSample[],
  currentTau: number,
): CalibrationResult {
  const base: ScoredSample[] = [];
  for (const s of samples) {
    if (s.pDelete !== null && s.margin !== null) {
      base.push({ pDelete: s.pDelete, margin: s.margin, ownerAction: s.ownerAction });
    }
  }
  const deleteSuggestions = base.filter((s) => wouldDelete(s, TAU_DELETE_MIN)).length;

  if (deleteSuggestions < CALIBRATION_MIN_DELETE_SUGGESTIONS) {
    return {
      tauDelete: currentTau,
      changed: false,
      outcome: "insufficient_data",
      deleteSuggestions,
      precisionAtTau: null,
      points: [],
    };
  }

  const steps = Math.round((TAU_DELETE_MAX - TAU_DELETE_MIN) / TAU_STEP);
  const points: CalibrationPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const tau = round2(TAU_DELETE_MIN + i * TAU_STEP);
    const selected = base.filter((s) => wouldDelete(s, tau));
    const support = selected.length;
    const correct = selected.filter((s) => s.ownerAction === "delete").length;
    points.push({ tau, support, precision: support > 0 ? correct / support : null });
  }

  const chosen = points.find(
    (p) =>
      p.support >= CALIBRATION_MIN_SUPPORT &&
      p.precision !== null &&
      p.precision >= CALIBRATION_TARGET_PRECISION,
  );
  const last = points[points.length - 1];
  const tauDelete = chosen ? chosen.tau : TAU_DELETE_MAX;
  return {
    tauDelete,
    changed: tauDelete !== currentTau,
    outcome: chosen ? "calibrated" : "no_tau_meets_target",
    deleteSuggestions,
    precisionAtTau: chosen ? chosen.precision : (last?.precision ?? null),
    points,
  };
}

export interface SegmentCalibrationSample extends CalibrationSample {
  /** labels.segment; null for labels written before contracts 12.10 that could not be classified. */
  segment: DecisionSegment | null;
}

export interface SegmentCalibration {
  segment: CalibratedSegment;
  /** null: no threshold reaches the target, so the segment is paused (no trash suggestions). */
  tauDelete: number | null;
  outcome: CalibrationResult["outcome"];
  deleteSuggestions: number;
  precisionAtTau: number | null;
  points: CalibrationPoint[];
}

export interface SegmentCalibrationResult {
  /** The single global threshold of contracts 5.3 (fallback and the archive and keep Clean up threshold). */
  global: CalibrationResult;
  segments: SegmentCalibration[];
  /** Explicit value for every calibrated segment, ready for Thresholds.segmentTaus. */
  taus: Record<CalibratedSegment, number | null>;
  changed: boolean;
}

/**
 * contracts 12.10: the 5.3 grid search per segment. calibrated -> that tau; no_tau_meets_target -> null (paused,
 * never saturate at TAU_DELETE_MAX); insufficient_data -> the segment's current value, else the global result.
 * The global result uses the newest CALIBRATION_WINDOW samples; rule samples never count (they skip the check).
 */
export function calibrateSegments(
  samples: readonly SegmentCalibrationSample[],
  currentTau: number,
  currentTaus: SegmentTaus,
): SegmentCalibrationResult {
  const calibrated = samples.filter((s) => s.segment !== "rule");
  const global = calibrateTauDelete(calibrated.slice(0, CALIBRATION_WINDOW), currentTau);
  const taus = {} as Record<CalibratedSegment, number | null>;
  const segments: SegmentCalibration[] = [];
  let changed = global.changed;
  for (const segment of CALIBRATED_SEGMENTS) {
    const current = currentTaus[segment];
    const r = calibrateTauDelete(
      calibrated.filter((s) => s.segment === segment),
      current ?? global.tauDelete,
    );
    const tau =
      r.outcome === "calibrated"
        ? r.tauDelete
        : r.outcome === "no_tau_meets_target"
          ? null
          : current === undefined
            ? global.tauDelete
            : current;
    taus[segment] = tau;
    if (tau !== current) changed = true;
    segments.push({
      segment,
      tauDelete: tau,
      outcome: r.outcome,
      deleteSuggestions: r.deleteSuggestions,
      // A paused segment reports its agreement at TAU_DELETE_MIN (the widest support), for the Insights note.
      precisionAtTau:
        r.outcome === "no_tau_meets_target" ? (r.points[0]?.precision ?? null) : r.precisionAtTau,
      points: r.points,
    });
  }
  return { global, segments, taus, changed };
}
