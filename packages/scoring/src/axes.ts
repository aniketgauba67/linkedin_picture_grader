/**
 * The eight axes. Every one of them describes the PHOTOGRAPH and is
 * something the subject can change by retaking the photo. No axis may
 * assess attractiveness, competence, employability, age, race, or gender.
 */

/** Computed exactly from pixels by @pps/features. No model involved. */
export const COMPUTED_AXES = ['sharpness', 'lighting', 'resolution', 'framing'] as const;

/** Judged by a vision model, later distilled into a local model. */
export const JUDGED_AXES = ['background', 'attire', 'expression', 'solo'] as const;

export const AXES = [...COMPUTED_AXES, ...JUDGED_AXES] as const;

export type ComputedAxisName = (typeof COMPUTED_AXES)[number];
export type JudgedAxisName = (typeof JUDGED_AXES)[number];
export type AxisName = (typeof AXES)[number];

/** Every axis scores on an integer 1-5 scale. 1 is worst, 5 is best. */
export const AXIS_MIN = 1;
export const AXIS_MAX = 5;

/** The composite the user sees. */
export const COMPOSITE_MIN = 1;
export const COMPOSITE_MAX = 10;

export type AxisScores = Readonly<Record<AxisName, number>>;

/** What each axis measures, and what "5" means for it. */
export const AXIS_DESCRIPTIONS: Readonly<Record<AxisName, string>> = {
  sharpness: 'How in-focus the subject is, measured at the eyes when a face is found.',
  lighting: 'Exposure health: highlight and shadow clipping, and dynamic range.',
  resolution: 'Pixel dimensions available for the face region.',
  framing: 'How much of the frame the face fills, and how centred it is.',
  background: 'How clean and undistracting the background is.',
  attire: 'Formality LEVEL on a 1-5 scale. Not garment quality, not taste.',
  expression: 'Eye contact with the lens and natural, unforced affect.',
  solo: 'Whether there is exactly one clear subject in the frame.',
};

export function isAxis(value: string): value is AxisName {
  return (AXES as readonly string[]).includes(value);
}

/**
 * AxisName scores arrive from two very different places (arithmetic on a
 * feature vector, and a vision model's JSON) so they are validated rather
 * than trusted. Returns the value clamped and rounded into 1-5.
 */
export function normalizeAxisScore(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`AxisName score must be a finite number, received ${String(value)}`);
  }
  return Math.min(AXIS_MAX, Math.max(AXIS_MIN, Math.round(value)));
}
