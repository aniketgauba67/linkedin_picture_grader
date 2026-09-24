import type { PixelFeatures } from './pixel-axes.js';
import { JPEG_QUALITY_FLOOR, faceCenterOffset } from './pixel-axes.js';
import { roundTo } from './composite.js';

/**
 * How much of the input the scorer could actually verify, 0-1.
 *
 * Deliberately not a quality signal - a badly lit photo of a square-on
 * face is a confident 3, not an uncertain one. It drops only when a
 * measurement is less trustworthy than usual, or when two subsystems
 * that should agree do not.
 */
export interface ConfidenceInputs extends PixelFeatures {
  /** Degrees off-axis, from the detected keypoints. */
  readonly yaw: number;
  /**
   * Null when unmeasurable. Five keypoints cannot recover pitch, so it
   * is null today and the off-axis penalty is honestly yaw-only. When a
   * mesh model lands this starts contributing with no other change.
   */
  readonly pitch: number | null;
}

export interface ConfidenceContext {
  /**
   * The vision model's `solo` score, 1-5, when one has been recorded.
   *
   * `solo` is judged, `faceCount` is measured. They are never combined
   * into a score - that would be two systems grading one axis - but when
   * they contradict each other, one of them is wrong and the result
   * deserves less trust.
   */
  readonly soloScore?: number;
}

/** How much a measurement disagreement costs. */
const DISAGREEMENT_PENALTY = 0.2;

/**
 * True when the detector and the vision model tell different stories
 * about how many subjects are in the frame.
 *
 * Free to compute and genuinely informative: faceCount 3 with solo
 * scored 5 means either the detector found bystanders that do not
 * matter, or the model missed people who do.
 */
export function subjectDisagreement(faceCount: number, soloScore: number): boolean {
  const measuredSolo = faceCount <= 1;
  const judgedSolo = soloScore >= 4;
  return measuredSolo !== judgedSolo;
}

export function computeConfidence(
  features: ConfidenceInputs,
  context: ConfidenceContext = {},
): number {
  let confidence = 1;

  if (features.faceCount === 0) {
    // Nothing to anchor framing or eye sharpness to.
    confidence -= 0.45;
  } else if (features.faceCount > 1) {
    // The uncertainty here is that the measurements may describe the
    // wrong face - NOT that the photo is less solo. The solo axis is
    // judged by the vision model and this never touches it.
    confidence -= 0.25;
  }

  // Over the components that were actually measured. A null pitch
  // contributes nothing rather than contributing a fabricated zero.
  const pose = [features.yaw, features.pitch].filter(
    (value): value is number => value !== null,
  );
  const offAxis = pose.length === 0 ? 0 : Math.max(...pose.map(Math.abs));
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

  if (
    context.soloScore !== undefined &&
    subjectDisagreement(features.faceCount, context.soloScore)
  ) {
    confidence -= DISAGREEMENT_PENALTY;
  }

  return roundTo(Math.min(1, Math.max(0, confidence)), 2);
}
