/**
 * Framing LEVEL calibration: same raw signal, better thresholds.
 *
 * framingRaw is not touched. The previous analysis found its ordering
 * useful (development CV Spearman ~0.76) and its levels systematically
 * high (mean bias ~+1.39), which is a threshold problem and nothing
 * else.
 *
 * WHAT THE DATA CAN AND CANNOT SUPPORT.
 *
 * Conditioned on the human label, framingRaw separates the bottom of
 * the scale and saturates at the top:
 *
 *   human 1  median 0.480
 *   human 2  IQR    0.603 - 0.730
 *   human 3  IQR    0.776 - 0.997
 *   human 4  p10 through max all 1.0000
 *
 * 22 of 117 eligible images sit at framingRaw EXACTLY 1.0, and they are
 * 10 human-3s and 10 human-4s. No threshold can separate two classes
 * that share one value, so the 3<->4 boundary is NOT data-supported. It
 * is preserved from product intent instead, and this module keeps the
 * two kinds of threshold visibly apart.
 *
 * Human 5 has zero examples, so the 4<->5 boundary is likewise
 * spec-preserved. Neither is inferred from data that does not exist.
 */

import type { Knot } from './isotonic-fit.js';
import { drivingScalar, type PopulationRow } from './calibrate-v1.js';

/** Boundaries the 125-image seed set can actually inform. */
export const DATA_SUPPORTED_BOUNDARIES = [1, 2] as const;
/** Boundaries preserved from product specification, not learned. */
export const SPEC_PRESERVED_BOUNDARIES = [3, 4] as const;

/**
 * The threshold separating `label <= k` from `label > k`, chosen to
 * maximise balanced accuracy on that one split.
 *
 * A decision stump on a single ordered measurement: the simplest thing
 * that can move a boundary, monotone by construction, and reported as a
 * number anyone can check against the distributions above. Balanced
 * rather than raw accuracy so that the larger class does not simply
 * swallow the boundary - which is how the previous PAVA candidate
 * collapsed everything onto one level.
 *
 * Candidate thresholds are midpoints between adjacent observed values,
 * so the result never sits exactly on a data point and a tie cannot
 * flip with floating point noise.
 */
export function fitBoundary(
  train: readonly PopulationRow[],
  boundary: number,
): number | null {
  const points = train
    .map((row) => ({ x: drivingScalar('framing', row.features), above: row.label > boundary }))
    .filter((p): p is { x: number; above: boolean } => p.x !== null && Number.isFinite(p.x));

  const below = points.filter((p) => !p.above);
  const above = points.filter((p) => p.above);
  // Nothing to separate: the boundary is unsupported in this fold.
  if (below.length === 0 || above.length === 0) return null;

  const values = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
  if (values.length < 2) return null;

  let best: { threshold: number; score: number } | null = null;
  for (let i = 0; i + 1 < values.length; i += 1) {
    const threshold = ((values[i] ?? 0) + (values[i + 1] ?? 0)) / 2;
    const trueBelow = below.filter((p) => p.x <= threshold).length / below.length;
    const trueAbove = above.filter((p) => p.x > threshold).length / above.length;
    const score = (trueBelow + trueAbove) / 2;
    // Strict improvement only, so the lowest qualifying threshold wins
    // and the choice is deterministic.
    if (best === null || score > best.score) best = { threshold, score };
  }
  return best?.threshold ?? null;
}

export interface LevelMapping {
  /** Ascending thresholds t1..t4; a value above t_k scores at least k+1. */
  readonly thresholds: readonly number[];
  readonly dataSupported: readonly number[];
  readonly specPreserved: readonly number[];
}

/** Scores a raw value against ordered thresholds. Monotone by
 *  construction: more thresholds passed is never a lower score. */
export function applyThresholds(raw: number, thresholds: readonly number[]): number {
  let score = 1;
  for (const threshold of thresholds) if (raw > threshold) score += 1;
  return Math.min(5, score);
}

/** Thresholds expressed as the knot table weights/v1.ts already uses,
 *  so an accepted candidate ships in the existing shape. */
export function thresholdsToKnots(thresholds: readonly number[]): readonly Knot[] {
  const knots: Knot[] = [[0, 1]];
  thresholds.forEach((threshold, index) => {
    knots.push([threshold, index + 2]);
  });
  return knots;
}

export interface CandidateSpec {
  readonly name: string;
  readonly description: string;
  /** Given a training fold, produce the mapping. */
  readonly fit: (train: readonly PopulationRow[]) => LevelMapping | null;
}

/** The shipped top thresholds, preserved rather than learned. */
export const SHIPPED_T3 = 0.78;
export const SHIPPED_T4 = 0.92;

/**
 * Shift the two supported boundaries, leave the spec top alone.
 *
 * The minimal change that can address the bias: nothing above human-3 is
 * touched, because nothing above human-3 is separable in this data.
 */
export const CANDIDATE_SHIFT_BOTTOM: CandidateSpec = {
  name: 'shift-bottom',
  description: 'fit 1<->2 and 2<->3 from data; keep shipped 3<->4 and 4<->5',
  fit: (train) => {
    const t1 = fitBoundary(train, 1);
    const t2 = fitBoundary(train, 2);
    if (t1 === null || t2 === null) return null;
    const ordered = enforceOrder([t1, t2, SHIPPED_T3, SHIPPED_T4]);
    return { thresholds: ordered, dataSupported: [ordered[0] ?? 0, ordered[1] ?? 0], specPreserved: [ordered[2] ?? 0, ordered[3] ?? 0] };
  },
};

/**
 * As above, but the top of the scale is re-anchored to the measurement's
 * own ceiling: only a framingRaw of 1.0 - a face inside the ideal band
 * with the centre offset inside tolerance - earns a 5.
 *
 * framingRaw cannot exceed 1.0 by construction, so this makes 5 the
 * reward for a perfect measurement rather than for merely a good one.
 */
export const CANDIDATE_SPEC_TOP: CandidateSpec = {
  name: 'spec-top',
  description: 'fit 1<->2 and 2<->3 from data; 3<->4 midway to the ceiling; 5 only at framingRaw 1.0',
  fit: (train) => {
    const t1 = fitBoundary(train, 1);
    const t2 = fitBoundary(train, 2);
    if (t1 === null || t2 === null) return null;
    const t3 = (t2 + 1) / 2;
    // Just below the ceiling so that 1.0 itself clears it and 5 stays
    // reachable; framingRaw is capped at 1.0 and cannot exceed it.
    const t4 = 0.9999;
    const ordered = enforceOrder([t1, t2, t3, t4]);
    return { thresholds: ordered, dataSupported: [ordered[0] ?? 0, ordered[1] ?? 0], specPreserved: [ordered[2] ?? 0, ordered[3] ?? 0] };
  },
};

/** Thresholds must ascend, or a score becomes unreachable silently. */
function enforceOrder(thresholds: readonly number[]): number[] {
  const out: number[] = [];
  for (const threshold of thresholds) {
    const previous = out[out.length - 1];
    out.push(previous === undefined ? threshold : Math.max(threshold, previous + 1e-6));
  }
  return out;
}

/**
 * Knots at each level's typical raw value, with a spec-preserved top.
 *
 * THE SHIPPED ARTIFACT INTERPOLATES. `applyIsotonic` reads the knot
 * table as a piecewise-linear curve, not as steps, so a threshold
 * fitted as a step boundary does not survive being written into it: a
 * value halfway between two knots scores halfway between two levels and
 * rounds up. Measured on the same folds, writing fitted step thresholds
 * into the knot format gave back roughly half the bias reduction
 * (bias +0.974 against the step form's +0.547). This candidate is
 * therefore fitted in the shape the artifact actually has.
 *
 * Knots 1-3 sit at the MEDIAN framingRaw of the photographs humans
 * labelled 1, 2 and 3 - "this is what a human-3 photograph measures" -
 * so interpolating between them is meaningful rather than incidental.
 *
 * Knots 4 and 5 are SPEC-PRESERVED, not learned, and the reason is in
 * the data: framingRaw saturates at 1.0, and 22 of 117 eligible images
 * sit at exactly 1.0 carrying ten human-3s and ten human-4s. Two
 * classes on one value cannot be separated by any threshold, so the
 * 3<->4 boundary is not learnable here, and human 5 has no examples at
 * all. Knot 5 is placed at the measurement ceiling - only framing the
 * measurement calls perfect earns a 5 - and knot 4 midway between the
 * human-3 median and that ceiling.
 *
 * Placing knot 4 at the human-4 median instead scores better on every
 * level metric (MAE 0.496 against 0.752) and makes level 5 UNREACHABLE,
 * because the human-4 median IS the ceiling. That trade is refused
 * deliberately: an axis that cannot award its top score is the failure
 * this repository has already shipped once and reverted.
 */
export const CANDIDATE_CLASS_MEDIAN: CandidateSpec = {
  name: 'class-median',
  description: 'knots 1-3 at each level median framingRaw; 4 and 5 spec-preserved at the ceiling',
  fit: (train) => {
    const medians: number[] = [];
    for (const level of [1, 2, 3]) {
      const values = train
        .filter((row) => row.label === level)
        .map((row) => drivingScalar('framing', row.features))
        .filter((x): x is number => x !== null && Number.isFinite(x))
        .sort((a, b) => a - b);
      if (values.length < MIN_EXAMPLES_FOR_LEVEL_KNOT) return null;
      const mid = Math.floor(values.length / 2);
      medians.push(
        values.length % 2 === 0 ? ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2 : (values[mid] ?? 0),
      );
    }
    const third = medians[2] ?? 0;
    // Spec, not data: midway to the ceiling, then the ceiling itself.
    const fourth = (third + FRAMING_RAW_CEILING) / 2;
    const ordered = enforceOrder([...medians, fourth, FRAMING_RAW_CEILING]);
    return {
      thresholds: ordered,
      dataSupported: ordered.slice(0, 3),
      specPreserved: ordered.slice(3),
    };
  },
};

/** framingRaw is 1/(1 + penalties) with penalties >= 0, so it cannot
 *  exceed 1. A perfect measurement is the most there is. */
export const FRAMING_RAW_CEILING = 1;

/** A level needs this many examples before its knot is placed from data. */
export const MIN_EXAMPLES_FOR_LEVEL_KNOT = 5;

/** The accepted mapping, as the knot table weights/v1.ts carries. */
export function mappingToKnots(mapping: LevelMapping): readonly Knot[] {
  return mapping.thresholds.map((x, index) => [x, index + 1] as Knot);
}

export const CANDIDATES: readonly CandidateSpec[] = [
  CANDIDATE_SHIFT_BOTTOM,
  CANDIDATE_SPEC_TOP,
  CANDIDATE_CLASS_MEDIAN,
];
