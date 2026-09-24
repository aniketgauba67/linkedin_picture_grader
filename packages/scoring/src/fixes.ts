import type { AxisName } from './axes.js';

export type FixSeverity = 'high' | 'medium' | 'low';

/** Mirrors `@pps/schema`'s `Fix`. See the note on `PixelFeatures`. */
export interface Fix {
  readonly axis: AxisName;
  readonly severity: FixSeverity;
  readonly message: string;
}

/**
 * Copy for each axis. Every line is an instruction for the next attempt at
 * the photograph. None of them says anything about the subject - that is
 * not a style preference, it is the rule the whole product is built on.
 */
export const FIX_MESSAGES: Readonly<Record<AxisName, string>> = {
  sharpness:
    'The shot is soft. Steady the camera, tap to focus on the eyes, and use a faster shutter.',
  lighting:
    'The exposure is fighting you. Face a window, keep the light in front of you, and avoid direct sun.',
  resolution:
    'There are not enough pixels to crop from. Shoot at full resolution and skip the digital zoom.',
  framing:
    'Fill more of the frame. Move closer so your head and shoulders take up most of the picture.',
  background:
    'The background is competing for attention. Find a plain wall or step further from what is behind you.',
  attire: 'Dress a level more formally than this for the context you picked.',
  expression:
    'Look straight into the lens and settle into a relaxed expression before the shutter fires.',
  solo: 'Crop to one subject. A second person in frame makes it unclear who the photo is of.',
};

/**
 * Severity buckets, in recoverable composite points. A single axis can
 * contribute at most (5 - 1) * 0.2 * 2.25 = 1.8 points, so 0.9 is roughly
 * half of the worst case one axis can cost.
 */
export const SEVERITY_THRESHOLDS = { high: 0.9, medium: 0.35 } as const;

/** More than three instructions is a list, not advice. */
export const MAX_FIXES = 3;

export function severityFor(headroom: number): FixSeverity {
  if (headroom >= SEVERITY_THRESHOLDS.high) return 'high';
  if (headroom >= SEVERITY_THRESHOLDS.medium) return 'medium';
  return 'low';
}
