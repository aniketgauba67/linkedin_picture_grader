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
import { DEFAULT_CONTEXT, WEIGHTS_VERSION, weightsFor } from './weights.js';
import type { Fix } from './fixes.js';
import { FIX_MESSAGES, MAX_FIXES, severityFor } from './fixes.js';

export interface AxisBreakdown {
  readonly axis: AxisName;
  /** The axis score, 1-5. */
  readonly score: number;
  /** This axis's weight in the active context. */
  readonly weight: number;
  /** weight * score - what this axis put into the weighted mean. */
  readonly contribution: number;
  /**
   * Composite points still available on this axis, i.e. what taking it to
   * a 5 would add to the final 1-10. This is what ranks the fixes.
   */
  readonly headroom: number;
}

/**
 * Mirrors `@pps/schema`'s `ScoreResult` exactly. It is declared here
 * rather than imported because this package must keep an empty
 * `dependencies` object; `@pps/schema`'s test suite parses the output of
 * `scorePhoto` with the real schema, so the two cannot drift.
 */
export interface ScoreResultShape {
  readonly score: number;
  readonly axes: Readonly<Record<AxisName, number>>;
  readonly context: Context;
  readonly fixes: readonly Fix[];
  readonly confidence: number;
  readonly weightsVersion: string;
}

export interface ScoreOptions {
  /** 0-1, from `computeConfidence`. Defaults to 1. */
  readonly confidence?: number;
  /** Defaults to `MAX_FIXES`. */
  readonly maxFixes?: number;
}

/** Maps the weighted axis mean (1-5) onto the reported composite (1-10). */
export function meanToComposite(mean: number): number {
  const span = (COMPOSITE_MAX - COMPOSITE_MIN) / (AXIS_MAX - AXIS_MIN);
  return COMPOSITE_MIN + (mean - AXIS_MIN) * span;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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

/**
 * Ranks fixes by recoverable composite points rather than by raw score, so
 * a heavily weighted near-miss can outrank a lightly weighted disaster.
 * Ties break on axis order, which puts the exactly-computed axes ahead of
 * the model-judged ones: "your photo is soft" is concrete, "your
 * background is cluttered" is a judgement call.
 */
export function buildFixes(
  breakdown: readonly AxisBreakdown[],
  maxFixes: number = MAX_FIXES,
): readonly Fix[] {
  return breakdown
    .filter((entry) => entry.score < AXIS_MAX && entry.headroom > 0)
    .slice()
    .sort((a, b) => b.headroom - a.headroom)
    .slice(0, Math.max(0, maxFixes))
    .map((entry) => ({
      axis: entry.axis,
      severity: severityFor(entry.headroom),
      message: FIX_MESSAGES[entry.axis],
    }));
}

/**
 * The whole of scoring: a dot product over a cached feature-derived axis
 * vector. It does no I/O, decodes no images, and allocates a handful of
 * small objects. This is what runs inside the Edge Function's 2s CPU
 * budget, and it is roughly 3ms.
 */
export function scorePhoto(
  scores: AxisScores,
  context: Context = DEFAULT_CONTEXT,
  options: ScoreOptions = {},
): ScoreResultShape {
  const weights = weightsFor(context);
  const axes: Record<AxisName, number> = Object.create(null) as Record<AxisName, number>;
  for (const axis of AXES) {
    axes[axis] = normalizeAxisScore(scores[axis]);
  }

  const breakdown = axisBreakdown(axes, context);
  const confidence = options.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be a finite number in [0, 1], received ${confidence}`);
  }

  return {
    score: roundTo(meanToComposite(weightedMean(axes, weights)), 1),
    axes,
    context,
    fixes: buildFixes(breakdown, options.maxFixes ?? MAX_FIXES),
    confidence,
    weightsVersion: WEIGHTS_VERSION,
  };
}
