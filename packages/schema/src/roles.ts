// Type-only: the roles table is keyed by the schema's field names, and
// nothing here reads the schema at runtime.
import type { ComputedFeatures } from './features.js';

/**
 * What every field in the feature vector is FOR.
 *
 * `exposureMean` was extracted, cached, versioned and shipped without a
 * single consumer - a two-sided lighting term that was simply absent
 * rather than wrong. Nothing caught it, because "is anyone reading this
 * field" was a question nobody was asked.
 *
 * So it is asked mechanically. Every field must declare a role, and the
 * test suite fails when one is added without one. Same principle as the
 * rubric lint: an invariant that depends on somebody remembering is not
 * an invariant.
 */
export type FeatureRole =
  /** Read at scoring time by the named axis or signal. */
  | 'axis'
  /** Training input only. Extracted and cached, never read when scoring. */
  | 'tier2'
  /** Recorded for provenance or debugging. Never affects a score. */
  | 'diagnostic'
  /**
   * Computed, cached, and read by nothing - with no decision yet about
   * whether it should be. A gap, named rather than hidden in one of the
   * categories above.
   */
  | 'gap';

export interface FeatureRoleEntry {
  readonly role: FeatureRole;
  /** For `axis`, which one. For the rest, why it exists. */
  readonly note: string;
}

export const FEATURE_ROLES: Readonly<
  Record<keyof typeof ComputedFeatures.shape, FeatureRoleEntry>
> = {
  // --- consumed by an axis -------------------------------------------
  sharpnessLaplacian: { role: 'axis', note: 'sharpness, frame basis' },
  sharpnessEyeRegion: { role: 'axis', note: 'sharpness, eye-region basis' },
  eyeRegionMeasured: { role: 'axis', note: 'sharpness: selects which basis and which map' },
  jpegQualityEstimate: { role: 'axis', note: 'sharpness penalty, and lowers confidence' },
  exposureMean: { role: 'axis', note: 'lighting: two-sided penalty around the ideal band' },
  clippedHighlights: { role: 'axis', note: 'lighting: unrecoverable highlight clipping' },
  clippedShadows: { role: 'axis', note: 'lighting: unrecoverable shadow clipping' },
  dynamicRange: { role: 'axis', note: 'lighting: drives the isotonic map' },
  width: { role: 'axis', note: 'resolution, via megapixels' },
  height: { role: 'axis', note: 'resolution, via megapixels' },
  faceAreaRatio: { role: 'axis', note: 'framing: two-sided band penalty in framingRaw' },
  faceCenterOffsetX: { role: 'axis', note: 'framing offset, and lowers confidence when extreme' },
  faceCenterOffsetY: { role: 'axis', note: 'framing offset, and lowers confidence when extreme' },
  faceCount: { role: 'axis', note: 'framing floor when zero; lowers confidence above one' },
  yaw: { role: 'axis', note: 'confidence: off-axis pose penalty' },
  pitch: { role: 'axis', note: 'confidence: off-axis pose penalty, null until a mesh model lands' },
  extractorVersion: { role: 'axis', note: 'score() refuses weights fitted against another extractor' },

  // --- training input only -------------------------------------------
  roll: {
    role: 'tier2',
    note: 'head tilt from the eye line. Distillation input; no axis reads it, and a tilted head is not itself a defect.',
  },
  eyeOpenness: {
    role: 'tier2',
    note: 'null until a mesh model provides it. Intended as an expression-distillation input, never a score.',
  },
  smileIntensity: {
    role: 'tier2',
    note: 'null until a mesh model provides it. Landmark measurement, not a judgement.',
  },

  // --- diagnostic -----------------------------------------------------
  sourceFormat: {
    role: 'diagnostic',
    note: 'provenance. Also the key for conditioning calibration: a HEIC upload is re-encoded by us, so its jpegQualityEstimate is not comparable to a real JPEG upload.',
  },
  isGrayscale: {
    role: 'diagnostic',
    note: 'no axis measures colour variance today, so there is nothing for it to switch off. Becomes an axis input the moment one does.',
  },

  // --- gaps: computed, cached, read by nothing ------------------------
  primaryFaceConfidence: {
    role: 'gap',
    note: 'a detector-uncertainty signal that computeConfidence does not read. Wiring it in would lower confidence on a marginal detection, which is what confidence is for.',
  },
  secondLargestFaceRatio: {
    role: 'gap',
    note: 'AMBIGUOUS_SUBJECT_RATIO exists and nothing compares against it. Prompt 5 specified that above 0.6 the UI should say the subject is ambiguous rather than pick one.',
  },
  aspectExtreme: {
    role: 'gap',
    note: 'Prompt 4 specified surfacing a panorama as a framing problem rather than letting it be mis-scored silently. Computed, never surfaced.',
  },
};

export const FEATURE_ROLE_FIELDS = Object.keys(FEATURE_ROLES) as readonly (
  keyof typeof ComputedFeatures.shape
)[];

/** Fields with no consumer and no decision. Non-empty on purpose. */
export function featureGaps(): readonly string[] {
  return FEATURE_ROLE_FIELDS.filter((field) => FEATURE_ROLES[field].role === 'gap');
}
