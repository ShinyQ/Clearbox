import { describe, expect, it } from "vitest";
import { calibrateTauDelete, type CalibrationSample } from "../../src/calibration/calibration.ts";
import type { ActionKind } from "../../src/model/actions.ts";

function samples(
  n: number,
  pDelete: number | null,
  ownerAction: ActionKind,
  margin: number | null = 0.5,
): CalibrationSample[] {
  return Array.from({ length: n }, () => ({ pDelete, margin, ceiling: "delete" as const, ownerAction }));
}

describe("calibrateTauDelete", () => {
  it("returns insufficient_data below 50 delete suggestions at tau 0.80", () => {
    const result = calibrateTauDelete([...samples(49, 0.9, "delete"), ...samples(100, 0.5, "keep")], 0.85);
    expect(result).toEqual({
      tauDelete: 0.85,
      changed: false,
      outcome: "insufficient_data",
      deleteSuggestions: 49,
      precisionAtTau: null,
      points: [],
    });
  });

  it("ignores samples without pDelete or margin, and samples under the delete margin", () => {
    const result = calibrateTauDelete(
      [
        ...samples(30, 0.9, "delete"),
        ...samples(30, null, "delete"),
        ...samples(30, 0.9, "delete", null),
        ...samples(30, 0.9, "delete", 0.19),
      ],
      0.8,
    );
    expect(result.outcome).toBe("insufficient_data");
    expect(result.deleteSuggestions).toBe(30);
  });

  it("evaluates every tau from 0.80 to 0.99 in ascending order", () => {
    const result = calibrateTauDelete(samples(60, 0.9, "delete"), 0.8);
    expect(result.points.map((p) => p.tau)).toEqual([
      0.8, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96,
      0.97, 0.98, 0.99,
    ]);
    expect(result.points[10]).toEqual({ tau: 0.9, support: 60, precision: 1 });
    expect(result.points[11]).toEqual({ tau: 0.91, support: 0, precision: null });
  });

  it("picks the smallest tau meeting support >= 20 and precision >= 0.98", () => {
    const data = [
      ...samples(50, 0.82, "delete"),
      ...samples(10, 0.82, "keep"),
      ...samples(30, 0.95, "delete"),
    ];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.outcome).toBe("calibrated");
    expect(result.tauDelete).toBe(0.83);
    expect(result.changed).toBe(true);
    expect(result.deleteSuggestions).toBe(90);
    expect(result.precisionAtTau).toBe(1);
    expect(result.points[0]?.precision).toBeCloseTo(80 / 90, 9);
  });

  it("accepts precision exactly 0.98", () => {
    const data = [...samples(49, 0.9, "delete"), ...samples(1, 0.9, "archive")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.tauDelete).toBe(0.8);
    expect(result.precisionAtTau).toBeCloseTo(0.98, 9);
    expect(result.changed).toBe(false);
  });

  it("requires at least 20 supporting labels", () => {
    const data = [...samples(40, 0.85, "keep"), ...samples(19, 0.97, "delete")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result.outcome).toBe("no_tau_meets_target");
    expect(result.tauDelete).toBe(0.99);
  });

  it("falls back to 0.99 with the precision at 0.99 when no tau qualifies", () => {
    const data = [...samples(40, 0.995, "keep"), ...samples(20, 0.995, "delete")];
    const result = calibrateTauDelete(data, 0.8);
    expect(result).toMatchObject({ tauDelete: 0.99, outcome: "no_tau_meets_target", changed: true });
    expect(result.precisionAtTau).toBeCloseTo(20 / 60, 9);
  });

  it("never returns a tau outside [0.80, 0.99]", () => {
    for (const p of [0.5, 0.8, 0.9, 1]) {
      const result = calibrateTauDelete(samples(100, p, "delete"), 0.9);
      expect(result.tauDelete).toBeGreaterThanOrEqual(0.8);
      expect(result.tauDelete).toBeLessThanOrEqual(0.99);
    }
  });
});
