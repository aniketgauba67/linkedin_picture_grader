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

export function weightedMean(scores: AxisScores, weights: AxisWeights): number {
  let total = 0;
  for (const axis of AXES) {
    total += normalizeAxisScore(scores[axis]) * weights[axis];
  }
  return total;
}

/** Per-axis detail. Exported because the UI shows it; not part of ScoreResult. */
export function axisBreakdown(
  scores: AxisScores,
  context: Context = DEFAULT_CONTEXT,
): readonly AxisBreakdown[] {
  const weights = weightsFor(context);
  const compositeSpan = (COMPOSITE_MAX - COMPOSITE_MIN) / (AXIS_MAX - AXIS_MIN);

  return AXES.map((axis) => {
    const score = normalizeAxisScore(scores[axis]);
    const weight = weights[axis];
    return {
      axis,
      score,
      weight,
      contribution: roundTo(score * weight, 4),
      headroom: roundTo((AXIS_MAX - score) * weight * compositeSpan, 4),
    };
  });
}
