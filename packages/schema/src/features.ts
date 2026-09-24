import { z } from 'zod';

/**
 * Bumped whenever the meaning of any field below changes. Stored as a
 * column next to the cached vector, not as a field of the vector, so an
 * older row is detected and re-extracted rather than silently mis-scored.
 */
export const FEATURE_VECTOR_VERSION = 7;

/**
 * The cache key for an extraction, derived from the version rather than
 * maintained alongside it. `features.extractor_version` and the
 * `feature_cache` primary key both use this, so a version bump
 * invalidates every cached vector automatically - there is no second
 * constant to forget.
 */
export const EXTRACTOR_VERSION = `v${FEATURE_VECTOR_VERSION}`;

/**
 * Everything measured from the image itself: sharp for the pixel
 * statistics, MediaPipe for the face landmarks and pose.
 *
 * Every measurement is `z.number().finite()`. This is not pedantry. A NaN
 * that reaches the scorer does not throw - it propagates through the
 * weighted sum and comes out as a plausible-looking number, which is the
 * worst failure this system can have. `.finite()` rejects NaN and both
 * infinities at the boundary instead.
 *
 * The non-numeric fields at the bottom describe the upload rather than
 * measure it, and are validated by kind in `assertFeaturesUsable`.
 */
export const ComputedFeatures = z.object({
  // --- sharpness -----------------------------------------------------
  /** Variance of the Laplacian over the whole luma plane. */
  sharpnessLaplacian: z.number().finite().nonnegative(),
  /**
   * The same measure restricted to the eye region. A headshot can have a
   * crisp sweater and soft eyes; this is the one that matters.
   *
   * `null` means UNMEASURABLE - no face was located, the eye box fell
   * outside the frame, or the crop was too small to convolve. It is not a
   * synonym for zero: a black or perfectly flat eye region genuinely has
   * zero Laplacian variance, and that photo should score sharpness 1.
   * Collapsing the two lets the full-frame fallback rescue exactly the
   * photo the eye-region measure exists to catch.
   */
  sharpnessEyeRegion: z.number().finite().nonnegative().nullable(),
  /**
   * Which basis `sharpnessEyeRegion` represents. Explicit rather than
   * inferred, because the scorer picks a different calibration map for
   * each and a sentinel cannot distinguish "unmeasurable" from "measured
   * as zero".
   */
  eyeRegionMeasured: z.boolean(),
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
  /**
   * Mean luma INSIDE THE FACE BOX, 0-255. The one the lighting axis
   * actually runs on.
   *
   * `exposureMean` above is the whole frame, and a backlit portrait
   * scores well on it while the face itself is unreadable - a bright
   * window fills the histogram and the subject is a silhouette. The
   * global figure is kept because it is still the right input for a
   * whole-image exposure judgement; it is simply not what a person means
   * when they say the lighting is bad on a portrait.
   */
  faceExposureMean: z.number().finite().min(0).max(255),
  /** Highlight clipping inside the face box, not across the frame. */
  faceClippedHighlights: z.number().finite().min(0).max(1),
  /** Shadow clipping inside the face box. */
  faceClippedShadows: z.number().finite().min(0).max(1),
  /**
   * Whether the three fields above came from a real detected face box,
   * or from the central-third fallback used when no face was found.
   *
   * Explicit rather than inferred from faceCount, exactly as
   * `eyeRegionMeasured` is: the fallback is a guess about where a face
   * probably is, and a score built on it deserves less confidence than
   * one built on a measurement.
   */
  faceRegionMeasured: z.boolean(),
  /**
   * `exposureMean - faceExposureMean`. The backlight signature.
   *
   * TIER 2: cached, never read at scoring time. A large positive value
   * is a bright frame around a dark face, which is exactly backlighting,
   * and it is the one directional signal available without new
   * measurement. Stored now rather than derived later so that revisiting
   * the lighting axis does not cost another re-extraction pass over
   * every image.
   *
   * Signed on purpose: negative means the face is brighter than its
   * surroundings, which is a different photograph - a flash portrait or
   * a spotlit subject - and collapsing the two with an absolute value
   * would throw away the distinction.
   */
  exposureDelta: z.number().finite().min(-255).max(255),

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
  /**
   * Head rotation in degrees. 0 is square to the lens.
   *
   * `yaw` and `roll` are derived from the five detected keypoints: roll
   * from the angle of the eye-to-eye line, yaw from the nose offset
   * against the eye midpoint.
   */
  yaw: z.number().finite().min(-180).max(180),
  roll: z.number().finite().min(-180).max(180),
  /**
   * `null` because five keypoints cannot recover it: pitch needs a
   * vertical reference the 5-point detector does not provide.
   *
   * Emitting 0 would be worse than emitting nothing. The off-axis
   * confidence penalty is a max over pose components, so a constant 0
   * contributes nothing while looking exactly like a measurement - the
   * penalty would silently become yaw-only with no way to tell. Null
   * says so out loud, and upgrades cleanly when a mesh model lands.
   */
  pitch: z.number().finite().min(-180).max(180).nullable(),
  /** 0 closed, 1 fully open. Null until a mesh model provides it. */
  eyeOpenness: z.number().finite().min(0).max(1).nullable(),
  /**
   * 0 neutral, 1 broad. Not a judgement, just a landmark measurement.
   * Null until a mesh model provides it.
   */
  smileIntensity: z.number().finite().min(0).max(1).nullable(),
  /**
   * Detector confidence for the face all the geometry describes, or null
   * when no face was selected.
   */
  primaryFaceConfidence: z.number().finite().min(0).max(1).nullable(),
  /**
   * Area of the second-largest qualifying face over the primary's, or
   * null when there is no second face. Above ~0.6 the subject is
   * genuinely ambiguous and the UI should say so rather than pick one.
   */
  secondLargestFaceRatio: z.number().finite().min(0).max(1).nullable(),

  // --- provenance and shape ------------------------------------------
  /**
   * The image carries no usable colour. Set from the original, before the
   * greyscale conversion extraction does for its own measurements, so it
   * describes the upload rather than the pipeline. The background and
   * lighting axes use it to skip colour variance.
   */
  isGrayscale: z.boolean(),
  /**
   * Longer edge more than 3x the shorter. Panoramas distort
   * faceAreaRatio badly, and this surfaces that as a framing problem
   * rather than letting it be mis-scored silently.
   */
  aspectExtreme: z.boolean(),
  /**
   * Container the bytes arrived in, captured BEFORE normalisation. An
   * iPhone upload reports "heic" even though extraction measured the
   * JPEG that heic-convert produced from it.
   */
  sourceFormat: z.string().min(1).max(32),
  /**
   * Which extractor produced this vector.
   *
   * Carried IN the vector, not only in the database column beside it, so
   * a vector in flight is self-describing. `score()` refuses to run when
   * this disagrees with the weights' compatibleExtractorVersion: the
   * numbers would mean something different from what the map was fitted
   * against, and the result would be confidently wrong.
   */
  extractorVersion: z.string().min(1).max(32),
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
  /** Null means "unmeasurable" and is permitted for this field only. */
  readonly nullable?: boolean;
}

/**
 * The same bounds the schema declares, in a form that can be walked at
 * runtime. Kept beside the schema so the two are edited together; the
 * test suite asserts every numeric schema key has a rule here.
 */
export const FEATURE_RULES: Readonly<Record<NumericFeatureField, FieldRule>> = {
  sharpnessLaplacian: { min: 0, max: Number.MAX_SAFE_INTEGER },
  sharpnessEyeRegion: { min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true },
  jpegQualityEstimate: { min: 0, max: 100 },
  exposureMean: { min: 0, max: 255 },
  clippedHighlights: { min: 0, max: 1 },
  clippedShadows: { min: 0, max: 1 },
  dynamicRange: { min: 0, max: 255 },
  faceExposureMean: { min: 0, max: 255 },
  faceClippedHighlights: { min: 0, max: 1 },
  faceClippedShadows: { min: 0, max: 1 },
  exposureDelta: { min: -255, max: 255 },
  width: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  height: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
  faceAreaRatio: { min: 0, max: 1 },
  faceCenterOffsetX: { min: -1, max: 1 },
  faceCenterOffsetY: { min: -1, max: 1 },
  faceCount: { min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
  yaw: { min: -180, max: 180 },
  roll: { min: -180, max: 180 },
  pitch: { min: -180, max: 180, nullable: true },
  eyeOpenness: { min: 0, max: 1, nullable: true },
  smileIntensity: { min: 0, max: 1, nullable: true },
  primaryFaceConfidence: { min: 0, max: 1, nullable: true },
  secondLargestFaceRatio: { min: 0, max: 1, nullable: true },
};

/** Fields holding a measurement. */
export type NumericFeatureField =
  | 'sharpnessLaplacian'
  | 'sharpnessEyeRegion'
  | 'jpegQualityEstimate'
  | 'exposureMean'
  | 'clippedHighlights'
  | 'clippedShadows'
  | 'dynamicRange'
  | 'faceExposureMean'
  | 'faceClippedHighlights'
  | 'faceClippedShadows'
  | 'exposureDelta'
  | 'width'
  | 'height'
  | 'faceAreaRatio'
  | 'faceCenterOffsetX'
  | 'faceCenterOffsetY'
  | 'faceCount'
  | 'yaw'
  | 'roll'
  | 'pitch'
  | 'eyeOpenness'
  | 'smileIntensity'
  | 'primaryFaceConfidence'
  | 'secondLargestFaceRatio';

export const NUMERIC_FEATURE_FIELDS = Object.keys(
  FEATURE_RULES,
) as readonly NumericFeatureField[];

/** Fields describing the upload rather than measuring it. */
export const BOOLEAN_FEATURE_FIELDS = [
  'eyeRegionMeasured',
  'faceRegionMeasured',
  'isGrayscale',
  'aspectExtreme',
] as const;

export const STRING_FEATURE_FIELDS = ['sourceFormat', 'extractorVersion'] as const;

/**
 * A feature vector that has been through `assertFeaturesUsable`.
 *
 * The brand exists so the guard is a COMPILE-TIME PROOF rather than a
 * convention: `score()` in @pps/scoring takes this type, and the only
 * way to obtain one is to run the assertion. That package keeps an empty
 * dependencies object and cannot import zod, so it mirrors this brand
 * structurally - a string literal rather than a unique symbol, which is
 * exactly what makes the mirror possible.
 *
 * Duplicating the validation inside @pps/scoring would be the other way
 * to solve this, and would give us two implementations of one contract.
 */
export type ValidatedFeatures = ComputedFeatures & {
  readonly __validated: 'assertFeaturesUsable';
};

export const FEATURE_FIELDS = [
  ...NUMERIC_FEATURE_FIELDS,
  ...BOOLEAN_FEATURE_FIELDS,
  ...STRING_FEATURE_FIELDS,
] as readonly ComputedFeatureField[];

/**
 * Call this at every boundary where features are read back from cache.
 *
 * `ComputedFeatures` is a compile-time claim; a row of JSONB out of
 * Postgres is not. Parsing with the schema would also work, but this is
 * the cheap path for the hot read: it throws a `FeatureError` naming the
 * offending field rather than a zod issue tree, and it is what the Edge
 * Function's 2s CPU budget can afford on every request.
 */
export function assertFeaturesUsable(f: ComputedFeatures): asserts f is ValidatedFeatures {
  if (f === null || typeof f !== 'object') {
    throw new FeatureError('(root)', f, 'expected an object of computed features');
  }

  const record = f as unknown as Record<string, unknown>;

  for (const field of NUMERIC_FEATURE_FIELDS) {
    const value = record[field];
    const rule = FEATURE_RULES[field];

    if (value === null) {
      if (rule.nullable === true) {
        // Null is the documented "unmeasurable" signal for this field.
        continue;
      }
      throw new FeatureError(field, value, 'expected a number');
    }
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

  for (const field of BOOLEAN_FEATURE_FIELDS) {
    if (typeof record[field] !== 'boolean') {
      throw new FeatureError(field, record[field], 'expected a boolean');
    }
  }

  for (const field of STRING_FEATURE_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value === '') {
      throw new FeatureError(field, value, 'expected a non-empty string');
    }
  }

  // A face-derived measurement without a face, or a face without its
  // confidence, means the detector and the vector disagree about whether
  // a subject was found.
  if (f.faceCount === 0 && f.primaryFaceConfidence !== null) {
    throw new FeatureError(
      'primaryFaceConfidence',
      f.primaryFaceConfidence,
      'is set although faceCount is 0',
    );
  }

  // The two sharpness fields have to agree, or the scorer cannot tell
  // which calibration map applies.
  if (f.eyeRegionMeasured !== (f.sharpnessEyeRegion !== null)) {
    throw new FeatureError(
      'eyeRegionMeasured',
      f.eyeRegionMeasured,
      `disagrees with sharpnessEyeRegion (${f.sharpnessEyeRegion === null ? 'null' : 'a number'})`,
    );
  }
}
