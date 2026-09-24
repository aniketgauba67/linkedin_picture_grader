import type { AxisName, AxisScores } from './axes.js';
import { AXIS_MAX, AXIS_MIN } from './axes.js';
import type { PixelFeatures, ValidatedPixelFeatures } from './pixel-axes.js';
import { applyIsotonic } from './isotonic.js';
import type { Weights } from './weights/v1.js';

/**
 * Turning a cached feature vector into eight 1-5 axis scores.
 *
 * Two of these axes have a TWO-SIDED optimum and are therefore NOT
 * isotonic in their raw measurement. Each is reduced to a one-sided
 * scalar first, and the calibrated map runs over that. Prompt 11 must
 * fit them the same way or it will silently lose the upper penalty.
 */


/** The four judged axes, as the model scored them. */
export interface JudgedScores {
  readonly background: number;
  readonly attire: number;
  readonly expression: number;
  readonly solo: number;
}

/**
 * How far outside a band a value sits, scaled. Zero inside the band.
 *
 * This is the shape every two-sided axis needs: an isotonic map is
 * monotone by construction and cannot say "bad when too low AND bad when
 * too high", so the two-sidedness is resolved here and the map sees only
 * a distance.
 */
export function bandPenalty(
  value: number,
  min: number,
  max: number,
  scale: number,
): number {
  if (value < min) return (min - value) * scale;
  if (value > max) return (value - max) * scale;
  return 0;
}

/**
 * Framing as a single one-sided scalar: 1 is ideal, 0 is worst.
 *
 * A face can be too large as well as too small, and can sit off centre
 * in any direction, so neither input is monotone in quality. Both become
 * penalties, and the calibrated framing map runs over the result.
 *
 * FIT THE FRAMING MAP OVER THIS VALUE, never over faceAreaRatio.
 */
export function framingRaw(features: PixelFeatures, weights: Weights): number {
  if (features.faceCount === 0 || features.faceAreaRatio <= 0) {
    return 0;
  }
  const { idealRatioMin, idealRatioMax, offsetTolerance, ratioPenaltyScale, offsetPenaltyScale } =
    weights.framing;

  const ratio = bandPenalty(features.faceAreaRatio, idealRatioMin, idealRatioMax, ratioPenaltyScale);
  const offset = Math.hypot(features.faceCenterOffsetX, features.faceCenterOffsetY);
  const off = bandPenalty(offset, 0, offsetTolerance, offsetPenaltyScale);

  // `1 / (1 + penalty)`, NOT `clamp01(1 - penalty)`.
  //
  // The subtract-and-clamp form saturates: once the penalties sum past
  // 1 every photograph reads exactly 0, and on the 125-image
  // calibration set that was 53 of them - 42% of the data piled on one
  // value, carrying human labels from 1 to 4. A monotone fit cannot
  // separate points that share an x, so the framing map topped out at 2
  // and no amount of relabelling would have moved it.
  //
  // The reciprocal is strictly decreasing over the whole unbounded
  // penalty range, so "badly cropped" and "catastrophically cropped"
  // stay distinguishable however bad they get, while the output stays
  // in (0, 1] and the map keeps the domain it already had. The penalty
  // terms themselves are never clamped; only the final axis score is.
  return 1 / (1 + ratio + off);
}

/**
 * Lighting as a single one-sided scalar: 1 is ideal, approaching 0 is
 * worst. Same shape as framingRaw, and for the same reason.
 *
 * Runs on the FACE, not the frame. A backlit portrait has a healthy
 * frame histogram - the window behind the subject fills it - while the
 * face is a silhouette, so the whole-frame figures said the lighting was
 * fine on exactly the photographs where it is worst. Fitted against
 * human labels, the frame-based scalar produced a map with no monotone
 * relationship to the labels at all: a single knot, one constant output
 * for every input.
 *
 * Exposure is two-sided - too dark and too bright are both wrong - so it
 * becomes a band penalty before the map sees it. Clipping is monotone in
 * badness and adds directly.
 *
 * FIT THE LIGHTING MAP OVER THIS VALUE, never over dynamicRange.
 */
export function lightingRaw(features: PixelFeatures, weights: Weights): number {
  const { idealExposureMin, idealExposureMax, exposurePenaltyScale, clippingFullPenaltyAt } =
    weights.lighting;

  const exposure = bandPenalty(
    features.faceExposureMean,
    idealExposureMin,
    idealExposureMax,
    exposurePenaltyScale,
  );

  // Clipping on the face is unrecoverable in a way flatness is not: a
  // flat portrait can be graded, blown cheeks cannot be un-blown.
  const clipped = features.faceClippedHighlights + features.faceClippedShadows;
  const clipping = clippingFullPenaltyAt <= 0 ? 0 : clipped / clippingFullPenaltyAt;

  return 1 / (1 + exposure + clipping);
}

/**
 * Lighting, likewise reduced before the map sees it.
 *
 * Dynamic range is genuinely monotone - more usable span is better - so
 * it drives the map directly. Exposure is NOT: a photograph can be
 * over-exposed as well as under-exposed, and mean luma has an ideal
 * middle. It was previously unused, which meant the two-sided term was
 * simply absent rather than wrong. Clipping is monotone in badness.
 */
export function lightingScore(features: PixelFeatures, weights: Weights): number {
  return clampAxis(applyIsotonic(lightingRaw(features, weights), weights.maps.lighting));
}

export function sharpnessScore(features: PixelFeatures, weights: Weights): number {
  // Null means UNMEASURABLE, never "measured as zero". A flat eye region
  // really does measure zero and must score 1 on its own map rather than
  // falling back to a frame that may be perfectly sharp.
  const measured = features.eyeRegionMeasured && features.sharpnessEyeRegion !== null;
  const base = measured
    ? applyIsotonic(features.sharpnessEyeRegion as number, weights.maps.sharpnessEyeRegion)
    : applyIsotonic(features.sharpnessLaplacian, weights.maps.sharpnessFrame);

  // Block artifacts fake edge energy, so a heavily compressed photo
  // reads sharper than it is.
  const penalty = features.jpegQualityEstimate < weights.jpegQualityFloor ? 1 : 0;
  return clampAxis(base - penalty);
}

/**
 * The shorter edge in pixels, which is what a square avatar crop is
 * limited by. A 4000x400 panorama has 1.6 megapixels and 400 usable
 * pixels; megapixels flatter it and the shorter edge does not.
 */
export function shorterEdge(features: PixelFeatures): number {
  return Math.min(features.width, features.height);
}

/**
 * Resolution, from the shorter edge against LinkedIn's published spec.
 *
 * NOT FITTED, and deliberately so - see the knot table in weights/v1.ts.
 * The requirement is a published number, not a matter of taste, and the
 * one attempt to fit it produced a map that could never award 5 because
 * no labelled photograph was large enough to earn one.
 */
export function resolutionScore(features: PixelFeatures, weights: Weights): number {
  return applyIsotonic(shorterEdge(features), weights.maps.resolution);
}

export function framingScore(features: PixelFeatures, weights: Weights): number {
  return applyIsotonic(framingRaw(features, weights), weights.maps.framing);
}

function clampAxis(value: number): number {
  return Math.min(AXIS_MAX, Math.max(AXIS_MIN, value));
}

/** Which basis sharpness used. Exported for the calibration step. */
export function sharpnessBasis(features: PixelFeatures): 'eyeRegion' | 'frame' {
  return features.eyeRegionMeasured && features.sharpnessEyeRegion !== null
    ? 'eyeRegion'
    : 'frame';
}

export type ComputedAxisScores = Readonly<Record<'sharpness' | 'lighting' | 'resolution' | 'framing', number>>;

/** The four axes that come from pixels. No model involved. */
export function computeComputedAxes(
  features: ValidatedPixelFeatures,
  weights: Weights,
): ComputedAxisScores {
  return {
    sharpness: sharpnessScore(features, weights),
    lighting: lightingScore(features, weights),
    resolution: resolutionScore(features, weights),
    framing: framingScore(features, weights),
  };
}

/**
 * All eight axes. Scores are left as real numbers here; rounding happens
 * once, at the composition step, so intermediate precision is not thrown
 * away four times over.
 */
export function computeAxisScores(
  features: ValidatedPixelFeatures,
  judged: JudgedScores,
  weights: Weights,
): AxisScores {
  const computed = computeComputedAxes(features, weights);
  const all: Record<AxisName, number> = {
    ...computed,
    background: judged.background,
    attire: judged.attire,
    expression: judged.expression,
    solo: judged.solo,
  };
  return all;
}
