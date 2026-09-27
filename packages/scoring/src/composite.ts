import type { AxisName, AxisScores } from './axes.js';
import {
  AXES,
  AXIS_MAX,
  AXIS_MIN,
  COMPOSITE_MAX,
  COMPOSITE_MIN,
  normalizeAxisScore,
} from './axes.js';
import type { AxisWeights, Context } from './weights.js';
import { DEFAULT_CONTEXT, weightsFor } from './weights.js';

/**
 * Composition arithmetic, kept separate from `score()` so the pieces can
 * be tested and reasoned about on their own.
 */

export interface AxisBreakdown {
  readonly axis: AxisName;
  readonly score: number;
  readonly weight: number;
  /** weight * score - what this axis put into the weighted mean. */
  readonly contribution: number;
  /**
   * Composite points still available on this axis, i.e. what taking it to
   * a 5 would add to the final 1-10. This is what ranks the fixes.
   */
  readonly headroom: number;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Maps the weighted axis mean (1-5) onto the reported composite (1-10). */
export function meanToComposite(mean: number): number {
  const span = (COMPOSITE_MAX - COMPOSITE_MIN) / (AXIS_MAX - AXIS_MIN);
  return COMPOSITE_MIN + (mean - AXIS_MIN) * span;
}

/**
 * Renormalises over the axes actually present, which since extractor v8
 * can exclude `framing` when no face qualified. With every axis present
 * the weights sum to 1 and this is the plain weighted mean it always
 * was; the divide only bites in the new case, and dividing by the weight
 * actually used is the same rule `composeScore` follows.
 */
export function weightedMean(scores: AxisScores, weights: AxisWeights): number {
  let total = 0;
  let weightSum = 0;
  for (const axis of AXES) {
    const value = scores[axis];
    if (value === undefined) continue;
    total += normalizeAxisScore(value) * weights[axis];
    weightSum += weights[axis];
  }
  return weightSum <= 0 ? 0 : total / weightSum;
}

/** Per-axis detail. Exported because the UI shows it; not part of ScoreResult. */
export function axisBreakdown(
  scores: AxisScores,
  context: Context = DEFAULT_CONTEXT,
): readonly AxisBreakdown[] {
  const weights = weightsFor(context);
  const compositeSpan = (COMPOSITE_MAX - COMPOSITE_MIN) / (AXIS_MAX - AXIS_MIN);

  // An absent axis is omitted rather than shown as a zero row: the UI
  // renders this list, and a framing row reading 0 would be the same
  // fabricated measurement in a different place.
  return AXES.flatMap((axis) => {
    const value = scores[axis];
    if (value === undefined) return [];
    const score = normalizeAxisScore(value);
    const weight = weights[axis];
    return [
      {
        axis,
        score,
        weight,
        contribution: roundTo(score * weight, 4),
        headroom: roundTo((AXIS_MAX - score) * weight * compositeSpan, 4),
      },
    ];
  });
}
