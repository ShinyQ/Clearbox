import type { ActionKind, Ceiling } from "../model/actions.ts";
import {
  CALIBRATION_MIN_DELETE_SUGGESTIONS,
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
