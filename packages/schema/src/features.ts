import { z } from 'zod';

/**
 * Bumped whenever the meaning of any field below changes. Stored as a
 * column next to the cached vector, not as a field of the vector, so an
 * older row is detected and re-extracted rather than silently mis-scored.
 */
export const FEATURE_VECTOR_VERSION = 2;

/**
 * Everything measured from the image itself: sharp for the pixel
 * statistics, MediaPipe for the face landmarks and pose.
 *
 * Every field is `z.number().finite()`. This is not pedantry. A NaN that
 * reaches the scorer does not throw - it propagates through the weighted
 * sum and comes out as a plausible-looking number, which is the worst
 * failure this system can have. `.finite()` rejects NaN and both
 * infinities at the boundary instead.
 */
export const ComputedFeatures = z.object({
  // --- sharpness -----------------------------------------------------
  /** Variance of the Laplacian over the whole luma plane. */
  sharpnessLaplacian: z.number().finite().nonnegative(),
  /**
   * The same measure restricted to the eye region. A headshot can have a
   * crisp sweater and soft eyes; this is the one that matters.
   * 0 when no face was located.
   */
  sharpnessEyeRegion: z.number().finite().nonnegative(),
  /**
   * 0-100 estimate of JPEG quality, from 8x8 block-boundary energy. Heavy
   * compression fakes edge energy, so a low value here means the
   * sharpness numbers above are less trustworthy.
   */
  jpegQualityEstimate: z.number().finite().min(0).max(100),

  // --- lighting ------------------------------------------------------
  /** Mean luma, 0-255. */
  exposureMean: z.number().finite().min(0).max(255),
  /** Fraction of pixels at or above the highlight clipping point. */
  clippedHighlights: z.number().finite().min(0).max(1),
  /** Fraction of pixels at or below the shadow clipping point. */
  clippedShadows: z.number().finite().min(0).max(1),
  /** Usable luma span between the 1st and 99th percentiles, 0-255. */
  dynamicRange: z.number().finite().min(0).max(255),

  // --- resolution ----------------------------------------------------
  /** Pixel dimensions of the original image, EXIF rotation applied. */
  width: z.number().finite().int().positive(),
  height: z.number().finite().int().positive(),

  // --- framing -------------------------------------------------------
  /** Face box area over frame area. */
  faceAreaRatio: z.number().finite().min(0).max(1),
  /**
   * Signed offset of the face centre from the frame centre, as a fraction
   * of the frame's width and height. Signed because direction matters:
   * slightly high is good composition, slightly low is not.
   */
  faceCenterOffsetX: z.number().finite().min(-1).max(1),
  faceCenterOffsetY: z.number().finite().min(-1).max(1),
  faceCount: z.number().finite().int().nonnegative(),

  // --- head pose and landmarks (MediaPipe) ---------------------------
  /** Head rotation in degrees. 0 is square to the lens. */
  yaw: z.number().finite().min(-180).max(180),
  pitch: z.number().finite().min(-180).max(180),
  roll: z.number().finite().min(-180).max(180),
  /** 0 closed, 1 fully open. */
  eyeOpenness: z.number().finite().min(0).max(1),
  /** 0 neutral, 1 broad. Not a judgement, just a landmark measurement. */
  smileIntensity: z.number().finite().min(0).max(1),
});

export type ComputedFeatures = z.infer<typeof ComputedFeatures>;
export type ComputedFeatureField = keyof ComputedFeatures;

/** Thrown by `assertFeaturesUsable`, naming the field that is unusable. */
export class FeatureError extends Error {
  readonly field: ComputedFeatureField | '(root)';
  readonly value: unknown;

  constructor(field: ComputedFeatureField | '(root)', value: unknown, reason: string) {
    super(`Unusable feature "${field}": ${reason} (received ${describe(value)})`);
    this.name = 'FeatureError';
    this.field = field;
    this.value = value;
  }
}

function describe(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN' : String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `${typeof value} ${JSON.stringify(value) ?? ''}`.trim();
}

interface FieldRule {
  readonly min: number;
  readonly max: number;
  readonly int?: boolean;
}

/**
 * The same bounds the schema declares, in a form that can be walked at
 * runtime. Kept beside the schema so the two are edited together; the test
 * suite asserts every schema key has a rule here.
 */
export const FEATURE_RULES: Readonly<Record<ComputedFeatureField, FieldRule>> = {
  sharpnessLaplacian: { min: 0, max: Number.MAX_SAFE_INTEGER },
  sharpnessEyeRegion: { min: 0, max: Number.MAX_SAFE_INTEGER },
  jpegQualityEstimate: { min: 0, max: 100 },
  exposureMean: { min: 0, max: 255 },
  clippedHighlights: { min: 0, max: 1 },
  clippedShadows: { min: 0, max: 1 },
  dynamicRange: { min: 0, max: 255 },
  width: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  height: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  faceAreaRatio: { min: 0, max: 1 },
  faceCenterOffsetX: { min: -1, max: 1 },
  faceCenterOffsetY: { min: -1, max: 1 },
  faceCount: { min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
  yaw: { min: -180, max: 180 },
  pitch: { min: -180, max: 180 },
  roll: { min: -180, max: 180 },
  eyeOpenness: { min: 0, max: 1 },
  smileIntensity: { min: 0, max: 1 },
};

export const FEATURE_FIELDS = Object.keys(FEATURE_RULES) as readonly ComputedFeatureField[];

/**
 * Call this at every boundary where features are read back from cache.
 *
 * `ComputedFeatures` is a compile-time claim; a row of JSONB out of
 * Postgres is not. Parsing with the schema would also work, but this is
 * the cheap path for the hot read: it throws a `FeatureError` naming the
 * offending field rather than a zod issue tree, and it is what the Edge
 * Function's 2s CPU budget can afford on every request.
 */
export function assertFeaturesUsable(f: ComputedFeatures): void {
  if (f === null || typeof f !== 'object') {
    throw new FeatureError('(root)', f, 'expected an object of computed features');
  }

  const record = f as unknown as Record<string, unknown>;

  for (const field of FEATURE_FIELDS) {
    const value = record[field];
    const rule = FEATURE_RULES[field];

    if (typeof value !== 'number') {
      throw new FeatureError(field, value, 'expected a number');
    }
    if (Number.isNaN(value)) {
      throw new FeatureError(field, value, 'is NaN');
    }
    if (!Number.isFinite(value)) {
      throw new FeatureError(field, value, 'is not finite');
    }
    if (rule.int === true && !Number.isInteger(value)) {
      throw new FeatureError(field, value, 'must be an integer');
    }
    if (value < rule.min || value > rule.max) {
      throw new FeatureError(field, value, `must be within [${rule.min}, ${rule.max}]`);
    }
  }
}
