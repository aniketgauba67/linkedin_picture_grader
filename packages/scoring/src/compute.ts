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

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

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

  return clamp01(1 - (ratio + off));
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
  const base = applyIsotonic(features.dynamicRange, weights.maps.lighting);

  const { idealExposureMin, idealExposureMax, exposurePenaltyScale, clippingFullPenaltyAt } =
    weights.lighting;

  const exposure = bandPenalty(
    features.exposureMean,
    idealExposureMin,
    idealExposureMax,
    exposurePenaltyScale,
  );

  // Clipping is penalised harder than flatness because it is
  // unrecoverable: a flat photo can be graded, a clipped one cannot.
  const clipped = features.clippedHighlights + features.clippedShadows;
  const clipping = clippingFullPenaltyAt <= 0 ? 0 : clipped / clippingFullPenaltyAt;

  return clampAxis(base - exposure - clipping);
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

export function resolutionScore(features: PixelFeatures, weights: Weights): number {
  const megapixels = (features.width * features.height) / 1_000_000;
  return applyIsotonic(megapixels, weights.maps.resolution);
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
