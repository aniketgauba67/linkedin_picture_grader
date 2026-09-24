import type { ComputedAxisName } from './axes.js';
import { AXIS_MAX, AXIS_MIN } from './axes.js';

/**
 * The structural subset of `@pps/schema`'s `ComputedFeatures` that scoring
 * actually reads.
 *
 * It is declared here rather than imported because this package must keep
 * an empty `dependencies` object - it runs in Deno and the browser, which
 * rules out zod. `ComputedFeatures` is a superset and is assignable to
 * this; `@pps/schema`'s test suite asserts that in both directions, so the
 * two cannot drift.
 */
export interface PixelFeatures {
  readonly width: number;
  readonly height: number;
  readonly sharpnessLaplacian: number;
  readonly sharpnessEyeRegion: number;
  readonly jpegQualityEstimate: number;
  readonly dynamicRange: number;
  readonly clippedHighlights: number;
  readonly clippedShadows: number;
  readonly faceAreaRatio: number;
  readonly faceCenterOffsetX: number;
  readonly faceCenterOffsetY: number;
  readonly faceCount: number;
}

/**
 * Hand-set thresholds, ascending. A measurement at or above
 * `thresholds[i]` scores at least `i + 2`.
 *
 * Unlike the context weights these are cheap to revise, because revising
 * them re-scores cached vectors without re-running extraction. That is the
 * whole point of keeping extraction and scoring separate.
 */
export const PIXEL_THRESHOLDS: Readonly<Record<ComputedAxisName, readonly number[]>> = {
  // Variance of the Laplacian. Below ~40 is visibly soft.
  sharpness: [40, 120, 300, 700],
  // Usable luma span out of 255; clipping is penalised separately.
  lighting: [80, 130, 170, 205],
  // Megapixels. LinkedIn renders at 400px, but crops need headroom.
  resolution: [0.15, 0.4, 1.0, 2.0],
  // Face box area as a fraction of the frame. Too small is the common failure.
  framing: [0.04, 0.08, 0.14, 0.2],
};

/** Below this, block artifacts fake edge energy and inflate sharpness. */
export const JPEG_QUALITY_FLOOR = 50;

/** Scores a measurement against an ascending threshold ladder. */
export function scoreAgainstThresholds(value: number, thresholds: readonly number[]): number {
  let score = AXIS_MIN;
  for (const threshold of thresholds) {
    if (value >= threshold) {
      score += 1;
    } else {
      break;
    }
  }
  return Math.min(AXIS_MAX, score);
}

/**
 * Sharpness is measured at the eyes when there is a face to measure. A
 * headshot can have a crisp collar and soft eyes, and the whole-frame
 * Laplacian cannot tell those apart; the eye region can.
 *
 * Heavy JPEG compression costs a point either way, because block edges
 * register as high-frequency energy and flatter both measurements.
 */
export function sharpnessScore(features: PixelFeatures): number {
  const measurement =
    features.faceCount > 0 && features.sharpnessEyeRegion > 0
      ? features.sharpnessEyeRegion
      : features.sharpnessLaplacian;

  const base = scoreAgainstThresholds(measurement, PIXEL_THRESHOLDS.sharpness);
  const penalty = features.jpegQualityEstimate < JPEG_QUALITY_FLOOR ? 1 : 0;
  return Math.max(AXIS_MIN, base - penalty);
}

/**
 * Dynamic range sets the ceiling; blown highlights and crushed shadows
 * pull it back down. Clipping is penalised harder than flatness because it
 * is unrecoverable - a flat photo can be graded, a clipped one cannot.
 */
export function lightingScore(features: PixelFeatures): number {
  const base = scoreAgainstThresholds(features.dynamicRange, PIXEL_THRESHOLDS.lighting);
  const clipping = features.clippedHighlights + features.clippedShadows;
  let penalty = 0;
  if (clipping > 0.02) penalty += 1;
  if (clipping > 0.08) penalty += 1;
  return Math.max(AXIS_MIN, base - penalty);
}

export function resolutionScore(features: PixelFeatures): number {
  const megapixels = (features.width * features.height) / 1_000_000;
  return scoreAgainstThresholds(megapixels, PIXEL_THRESHOLDS.resolution);
}

/** Magnitude of the signed face offset, as a fraction of the frame. */
export function faceCenterOffset(features: PixelFeatures): number {
  return Math.hypot(features.faceCenterOffsetX, features.faceCenterOffsetY);
}

/**
 * Framing is face size first, centring second. A well-composed headshot
 * sits slightly above centre, so only a clearly off-centre face is
 * penalised.
 */
export function framingScore(features: PixelFeatures): number {
  if (features.faceAreaRatio <= 0) {
    return AXIS_MIN;
  }
  const base = scoreAgainstThresholds(features.faceAreaRatio, PIXEL_THRESHOLDS.framing);
  const penalty = faceCenterOffset(features) > 0.25 ? 1 : 0;
  return Math.max(AXIS_MIN, base - penalty);
}

/**
 * Maps a cached feature vector onto the four exactly-computed axes. Pure
 * arithmetic over numbers that are already in Postgres - no image
 * decoding, which is what makes it safe inside an Edge Function.
 */
export function scoreComputedAxes(
  features: PixelFeatures,
): Readonly<Record<ComputedAxisName, number>> {
  return {
    sharpness: sharpnessScore(features),
    lighting: lightingScore(features),
    resolution: resolutionScore(features),
    framing: framingScore(features),
  };
}
