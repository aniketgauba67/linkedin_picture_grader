import type { AxisName } from './axes.js';
import { AXES, AXIS_MAX } from './axes.js';
import type { PixelFeatures } from './pixel-axes.js';
import type { Context } from './weights.js';
import { weightsFor } from './weights.js';
import { WEIGHTS_V1 } from './weights/v1.js';

export type FixSeverity = 'high' | 'medium' | 'low';

/** Mirrors @pps/schema's Fix. */
export interface Fix {
  readonly axis: AxisName;
  readonly severity: FixSeverity;
  readonly message: string;
}

export const SEVERITY_THRESHOLDS = { high: 0.9, medium: 0.35 } as const;

/** More than three instructions is a list, not advice. */
export const MAX_FIXES = 3;

export function severityFor(headroom: number): FixSeverity {
  if (headroom >= SEVERITY_THRESHOLDS.high) return 'high';
  if (headroom >= SEVERITY_THRESHOLDS.medium) return 'medium';
  return 'low';
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Writes one instruction per weak axis.
 *
 * NAMES THE ACTION, NOT THE PROBLEM, and quotes the measurement that
 * triggered it. "Framing is poor" tells the user what is wrong;
 * "Recrop to head-and-shoulders - your face fills 12% of the frame, aim
 * for 25-35%" tells them what to do. That difference is the whole
 * distance between a score and advice.
 *
 * Every line describes the photograph or an action the photographer can
 * take. None of them describes the person.
 */
function messageFor(axis: AxisName, features: PixelFeatures): string {
  const framing = WEIGHTS_V1.framing;
  const lighting = WEIGHTS_V1.lighting;

  switch (axis) {
    case 'framing': {
      if (features.faceCount === 0) {
        return 'Reframe so your face is clearly visible - no face was detected in this photo.';
      }
      const ratio = features.faceAreaRatio;
      const band = `${pct(framing.idealRatioMin)}-${pct(framing.idealRatioMax)}`;
      if (ratio < framing.idealRatioMin) {
        return `Recrop to head-and-shoulders - your face fills ${pct(ratio)} of the frame, aim for ${band}.`;
      }
      if (ratio > framing.idealRatioMax) {
        return `Step back or crop wider - your face fills ${pct(ratio)} of the frame, aim for ${band}.`;
      }
      const offset = Math.hypot(features.faceCenterOffsetX, features.faceCenterOffsetY);
      return `Recentre the crop - your face sits ${pct(offset)} of the frame off centre, keep it under ${pct(framing.offsetTolerance)}.`;
    }

    case 'sharpness': {
      if (features.jpegQualityEstimate < WEIGHTS_V1.jpegQualityFloor) {
        return 'Re-export at higher quality - compression artifacts are visible, which also makes the focus hard to judge.';
      }
      return features.eyeRegionMeasured
        ? 'Refocus on the eyes and hold the camera steadier - the eye region is softer than the rest of the frame.'
        : 'Refocus and steady the camera - tap to focus before the shutter fires, and use a faster shutter speed.';
    }

    case 'lighting': {
      const clipped = features.clippedHighlights + features.clippedShadows;
      if (clipped > lighting.clippingFullPenaltyAt) {
        return features.clippedHighlights >= features.clippedShadows
          ? `Reduce the exposure - ${pct(features.clippedHighlights)} of the frame is blown to pure white and cannot be recovered.`
          : `Add light on your face - ${pct(features.clippedShadows)} of the frame is crushed to pure black.`;
      }
      if (features.exposureMean < lighting.idealExposureMin) {
        return 'Face a window or add a light in front of you - the photo is underexposed.';
      }
      if (features.exposureMean > lighting.idealExposureMax) {
        return 'Move out of direct sun or reduce the exposure - the photo is overexposed.';
      }
      return 'Shoot facing a window - the light is flat, so the photo has little tonal range.';
    }

    case 'resolution': {
      const mp = ((features.width * features.height) / 1_000_000).toFixed(1);
      return `Reshoot at full resolution - this image is ${features.width}x${features.height} (${mp}MP), which leaves nothing to crop from.`;
    }

    case 'background':
      return 'Move to a plain wall, or step further from what is behind you so it falls out of focus.';

    case 'attire':
      return 'Dress one level more formally than this for the audience you picked.';

    case 'expression':
      return 'Look straight into the lens and let your expression settle before the shutter fires.';

    case 'solo':
      return 'Crop to one subject - a second person in frame makes it unclear who the photo is of.';

    default: {
      const unreachable: never = axis;
      throw new Error(`No fix copy for axis ${String(unreachable)}`);
    }
  }
}

/**
 * Ranks fixes by recoverable composite points rather than by raw score,
 * so a heavily weighted near-miss can outrank a lightly weighted
 * disaster. Ties break on axis order, which puts the exactly-computed
 * axes ahead of the model-judged ones.
 */
export function buildFixes(
  axes: Readonly<Partial<Record<AxisName, number>>>,
  features: PixelFeatures,
  context: Context,
  maxFixes: number = MAX_FIXES,
): Fix[] {
  const weights = weightsFor(context);
  const compositeSpan = 9 / 4;

  return AXES.filter((axis) => {
    const value = axes[axis];
    return value !== undefined && value < AXIS_MAX;
  })
    .map((axis) => ({
      axis,
      headroom: (AXIS_MAX - (axes[axis] as number)) * weights[axis] * compositeSpan,
    }))
    .filter((entry) => entry.headroom > 0)
    .sort((a, b) => b.headroom - a.headroom)
    .slice(0, Math.max(0, maxFixes))
    .map((entry) => ({
      axis: entry.axis,
      severity: severityFor(entry.headroom),
      message: messageFor(entry.axis, features),
    }));
}
