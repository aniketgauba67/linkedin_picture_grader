import type { AxisName, AxisScores } from './axes.js';
import { AXES, AXIS_MAX, AXIS_MIN, COMPOSITE_MAX, COMPOSITE_MIN, COMPUTED_AXES } from './axes.js';
import type { Context } from './weights.js';
import { DEFAULT_CONTEXT, weightsFor } from './weights.js';
import type { ValidatedPixelFeatures } from './pixel-axes.js';
import type { JudgedScores } from './compute.js';
import { computeAxisScores, computeComputedAxes } from './compute.js';
import type { Weights } from './weights/v1.js';
import { WEIGHTS_V1 } from './weights/v1.js';
import { buildFixes } from './fixes.js';
import type { Fix } from './fixes.js';
import { roundTo } from './composite.js';
export { axisBreakdown, weightedMean } from './composite.js';
export type { AxisBreakdown } from './composite.js';

/**
 * Mirrors @pps/schema's WeightsVersionError. Declared here rather than
 * imported for the usual reason: this package keeps an empty
 * dependencies object.
 */
export class WeightsVersionError extends Error {
  readonly featuresExtractorVersion: string;
  readonly weightsCompatibleWith: string;

  constructor(featuresExtractorVersion: string, weightsCompatibleWith: string) {
    super(
      `Weights were fitted against extractor ${weightsCompatibleWith}, ` +
        `but these features came from ${featuresExtractorVersion}. ` +
        'Re-extract, or load weights fitted against this extractor.',
    );
    this.name = 'WeightsVersionError';
    this.featuresExtractorVersion = featuresExtractorVersion;
    this.weightsCompatibleWith = weightsCompatibleWith;
  }
}

export type Coverage = 'full' | 'partial';

/** Mirrors @pps/schema's ScoreResult. */
export interface ScoreResultShape {
  readonly score: number;
  /**
   * Partial: the degraded path carries only the four computed axes.
   *
   * Written with an explicit `| undefined` rather than `Partial<>`
   * because this repo runs exactOptionalPropertyTypes, and zod's
   * `.partial()` emits `?: number | undefined`. Without the explicit
   * union the two shapes are not assignable and the mirror breaks.
   */
  readonly axes: { readonly [K in AxisName]?: number | undefined };
  readonly context: Context;
  readonly fixes: Fix[];
  readonly confidence: number;
  readonly weightsVersion: string;
  readonly coverage: Coverage;
}

export interface ScoreOptions {
  readonly confidence?: number;
  readonly maxFixes?: number;
}

/** Maps a weighted axis mean (1-5) onto the reported composite (1-10). */
export function meanToComposite(mean: number): number {
  const span = (COMPOSITE_MAX - COMPOSITE_MIN) / (AXIS_MAX - AXIS_MIN);
  return COMPOSITE_MIN + (mean - AXIS_MIN) * span;
}

/**
 * Weighted mean over whichever axes are present, renormalised so the
 * weights still sum to 1 across them.
 *
 * Renormalising is what makes the degraded path honest: scoring four
 * axes against weights that were meant to cover eight would quietly
 * report a number roughly half what it should be.
 */
export function composeScore(
  axes: Readonly<Partial<Record<AxisName, number>>>,
  context: Context,
): number {
  const weights = weightsFor(context);
  let total = 0;
  let weightSum = 0;

  for (const axis of AXES) {
    const value = axes[axis];
    if (value === undefined) continue;
    total += value * weights[axis];
    weightSum += weights[axis];
  }

  if (weightSum <= 0) {
    throw new RangeError('No axes contributed to the score');
  }
  return roundTo(meanToComposite(total / weightSum), 1);
}

export interface ScoreInput {
  readonly features: ValidatedPixelFeatures;
  /**
   * Absent when the vision model declined or was unavailable. The four
   * computed axes are still valid, so half a score with an honest label
   * beats no score.
   */
  readonly judged?: JudgedScores | undefined;
  readonly context?: Context;
  readonly weights?: Weights;
  readonly confidence?: number;
  readonly maxFixes?: number;
}

/**
 * The whole of scoring: arithmetic over a cached feature vector.
 *
 * `features` is BRANDED - the only way to obtain a ValidatedPixelFeatures
 * is to have run `assertFeaturesUsable` from @pps/schema. That guard
 * cannot live here, because this package has no dependencies, so the
 * type system carries the proof instead of a comment asking nicely.
 */
export function score(input: ScoreInput): ScoreResultShape {
  const weights = input.weights ?? WEIGHTS_V1;
  const context = input.context ?? DEFAULT_CONTEXT;

  if (input.features.extractorVersion !== weights.compatibleExtractorVersion) {
    throw new WeightsVersionError(
      input.features.extractorVersion,
      weights.compatibleExtractorVersion,
    );
  }

  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(`confidence must be a finite number in [0, 1], received ${confidence}`);
  }

  const judged = input.judged;
  const coverage: Coverage = judged === undefined ? 'partial' : 'full';

  const axes: Record<AxisName, number> | Partial<Record<AxisName, number>> =
    judged === undefined
      ? computeComputedAxes(input.features, weights)
      : computeAxisScores(input.features, judged, weights);

  const rounded: Partial<Record<AxisName, number>> = {};
  for (const axis of AXES) {
    const value = (axes as Partial<Record<AxisName, number>>)[axis];
    if (value === undefined) continue;
    rounded[axis] = Math.min(AXIS_MAX, Math.max(AXIS_MIN, Math.round(value)));
  }

  return {
    score: composeScore(rounded, context),
    axes: rounded,
    context,
    fixes: buildFixes(rounded, input.features, context, input.maxFixes),
    confidence,
    weightsVersion: weights.version,
    coverage,
  };
}

export { COMPUTED_AXES };
export type { AxisScores };
