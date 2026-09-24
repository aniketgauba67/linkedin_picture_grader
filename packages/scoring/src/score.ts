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

/**
 * Mirror of @pps/schema's DeclineReason. Structural, not imported: this
 * package has no dependencies. A test asserts the two lists match.
 */
export type DeclineReason =
  | 'no_face'
  | 'apparent_minor'
  | 'not_a_photo'
  | 'model_refusal'
  | 'corrupt_file';

/**
 * The most a photograph can score once the judge has declined for a
 * given reason.
 *
 * A DECLINE IS A FINDING, NOT MISSING DATA. That distinction is the
 * whole point of this table. Without it a decline merely removed the
 * four judged axes, the composite renormalised over the four computed
 * ones, and a photograph of five people at a party scored 7.6 out of 10
 * because it happened to be sharp, well lit and high resolution - which
 * it was. The axis that exists to catch exactly that photograph, `solo`,
 * is judged rather than computed, so declining is precisely what stops
 * it from firing.
 *
 * `model_refusal` is the one reason that carries no information about
 * the photograph - the model declined to answer, which says nothing
 * about the image - so it caps at the neutral midpoint rather than low.
 */
export const DECLINE_SCORE_CAP: Readonly<Record<DeclineReason, number>> = {
  // Nothing to be a profile photograph of.
  no_face: 2,
  // Not scoreable, and not a judgement about the photograph's quality.
  apparent_minor: 1,
  // A screenshot or an illustration is not a profile photograph at all.
  not_a_photo: 2,
  // The model would not answer. That is about the model, not the photo.
  model_refusal: 5.5,
  corrupt_file: 1,
};

/**
 * Confidence multiplier applied when the detector and the judge
 * disagree about whether there is a face.
 *
 * They are independent observers of the same question, so a conflict is
 * information in its own right - the same reasoning that already lowers
 * confidence when `faceCount` and the `solo` score disagree.
 */
export const DETECTOR_JUDGE_CONFLICT_CONFIDENCE = 0.4;

export interface ScoreInput {
  readonly features: ValidatedPixelFeatures;
  /**
   * Absent when the vision model declined or was unavailable. The four
   * computed axes are still valid, so half a score with an honest label
   * beats no score.
   */
  readonly judged?: JudgedScores | undefined;
  /**
   * Why the judge declined, when it did.
   *
   * Pass this whenever `judged` is absent BECAUSE of a decline rather
   * than because the model was never called. Omitting it is not a
   * silent downgrade to a lower score - it is a silent upgrade to a
   * higher one, because the cap never applies.
   */
  readonly declined?: DeclineReason | undefined;
  readonly context?: Context;
  readonly weights?: Weights;
  readonly confidence?: number;
  readonly maxFixes?: number;
}

/** True when the judge saw no face and the detector found one anyway. */
export function detectorJudgeConflict(
  features: ValidatedPixelFeatures,
  declined: DeclineReason | undefined,
): boolean {
  return declined === 'no_face' && features.faceCount > 0;
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
  const declined = input.declined;
  const coverage: Coverage = judged === undefined ? 'partial' : 'full';

  // A conflict between two independent observers of the same question
  // is information, and the run that produced it deserves less trust.
  const conflict = detectorJudgeConflict(input.features, declined);

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

  // A decline that says something about the PHOTOGRAPH floors the axis
  // it is about, so the fix list names the real problem rather than
  // whichever computed axis happened to score lowest.
  if (declined === 'no_face' && rounded.framing !== undefined) {
    rounded.framing = AXIS_MIN;
  }

  const composed = composeScore(rounded, context);
  const cap = declined === undefined ? COMPOSITE_MAX : DECLINE_SCORE_CAP[declined];

  return {
    // The cap is applied to the COMPOSITE, after renormalising, because
    // renormalising is exactly the step that let a declined photograph
    // score well: it divides by the weight actually used, so removing
    // four axes raises the remaining four rather than lowering the
    // total. Capping the axes instead would leave that intact.
    score: Math.min(composed, cap),
    axes: rounded,
    context,
    fixes: buildFixes(rounded, input.features, context, input.maxFixes),
    confidence: conflict ? confidence * DETECTOR_JUDGE_CONFLICT_CONFIDENCE : confidence,
    weightsVersion: weights.version,
    coverage,
  };
}

export { COMPUTED_AXES };
export type { AxisScores };
