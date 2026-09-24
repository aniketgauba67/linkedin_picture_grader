import type { PixelFeatures } from './pixel-axes.js';
import { JPEG_QUALITY_FLOOR, faceCenterOffset } from './pixel-axes.js';
import { roundTo } from './composite.js';

/**
 * How much of the input the scorer could actually verify, 0-1.
 *
 * This is deliberately not a quality signal - a badly lit photo of a
 * square-on face is a confident 3, not an uncertain one. It drops only
 * when a measurement is less trustworthy than usual: no face to measure
 * the eyes on, several faces so the wrong one may have been picked, a head
 * turned far enough that the face box understates its size, or compression
 * heavy enough to corrupt the sharpness numbers.
 */
export interface ConfidenceInputs extends PixelFeatures {
  readonly yaw: number;
  readonly pitch: number;
}

export function computeConfidence(features: ConfidenceInputs): number {
  let confidence = 1;

  if (features.faceCount === 0) {
    // Nothing to anchor framing or eye sharpness to.
    confidence -= 0.45;
  } else if (features.faceCount > 1) {
    // `solo` will score this down anyway; the uncertainty is that the
    // measurements may describe the wrong face.
    confidence -= 0.25;
  }

  const offAxis = Math.max(Math.abs(features.yaw), Math.abs(features.pitch));
  if (offAxis > 35) {
    confidence -= 0.2;
  } else if (offAxis > 20) {
    confidence -= 0.1;
  }

  if (features.jpegQualityEstimate < JPEG_QUALITY_FLOOR) {
    confidence -= 0.15;
  }

  // A face crammed against an edge is usually a crop, and a crop hides
  // whatever was cropped out.
  if (features.faceCount > 0 && faceCenterOffset(features) > 0.35) {
    confidence -= 0.1;
  }

  return roundTo(Math.min(1, Math.max(0, confidence)), 2);
}
