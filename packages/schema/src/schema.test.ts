import { describe, expect, it } from 'vitest';
import { AXES, CONTEXTS } from '@pps/scoring';
import {
  AxisName,
  AxisScore,
  AxisScores,
  ComputedAxisName,
  CompositeScore,
  JudgedAxisName,
  ScoreContext,
} from './axes.js';
import {
  BOOLEAN_FEATURE_FIELDS,
  ComputedFeatures,
  FEATURE_RULES,
  FeatureError,
  NUMERIC_FEATURE_FIELDS,
  STRING_FEATURE_FIELDS,
  assertFeaturesUsable,
} from './features.js';
import {
  Assessment,
  JudgedAxis,
  RubricDecline,
  RubricResponse,
  isAssessed,
} from './assessment.js';
import { Fix, FixSeverity, ScoreResult } from './result.js';
import { AnalysisOutcome, DeclineReason, isDeclined, isScored, matchOutcome } from './outcome.js';
import { MAX_UPLOAD_BYTES, UploadRequest } from './image.js';

/** A vector that every field-level test mutates one field of. */
const usable: ComputedFeatures = {
  sharpnessLaplacian: 420,
  sharpnessEyeRegion: 510,
  jpegQualityEstimate: 88,
  exposureMean: 124,
  clippedHighlights: 0.004,
  clippedShadows: 0.002,
  dynamicRange: 198,
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
  exposureDelta: 4,
  width: 1600,
  height: 1600,
  faceAreaRatio: 0.16,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.04,
  faceCount: 1,
  yaw: 3.5,
  pitch: -2.1,
  roll: 0.8,
  eyeOpenness: 0.82,
  smileIntensity: 0.41,
  eyeRegionMeasured: true,
  primaryFaceConfidence: 0.91,
  secondLargestFaceRatio: null,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
  extractorVersion: 'v6',
};

const validScores: AxisScores = {
  sharpness: 4,
  lighting: 4,
  resolution: 5,
  framing: 3,
  background: 4,
  attire: 3,
  expression: 4,
  solo: 5,
};

const judged = (score: number): JudgedAxis => ({
  evidence: 'plain grey wall behind the subject',
  score,
});

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

describe('AxisName', () => {
  it('is the same vocabulary as the zero-dependency @pps/scoring tuple', () => {
    // These two cannot import each other: @pps/scoring has an empty
    // `dependencies` object so it can run in Deno and the browser, which
    // rules out zod. This test is the seam that keeps them honest.
    expect([...AxisName.options].sort()).toEqual([...AXES].sort());
  });

  it('splits into four computed and four judged axes that partition the whole', () => {
    expect(ComputedAxisName.options).toHaveLength(4);
    expect(JudgedAxisName.options).toHaveLength(4);
    expect([...ComputedAxisName.options, ...JudgedAxisName.options].sort()).toEqual(
      [...AxisName.options].sort(),
    );
  });

  it('rejects an axis that would assess the person rather than the photo', () => {
    expect(AxisName.safeParse('attractiveness').success).toBe(false);
    expect(AxisName.safeParse('competence').success).toBe(false);
    expect(AxisName.safeParse('').success).toBe(false);
  });
});

describe('ScoreContext', () => {
  it('matches the hand-set contexts in @pps/scoring', () => {
    expect([...ScoreContext.options].sort()).toEqual([...CONTEXTS].sort());
  });

  it('rejects a context nobody hand-set weights for', () => {
    expect(ScoreContext.safeParse('law-firm').success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------

describe('AxisScore', () => {
  it('accepts the whole 1-5 range', () => {
    for (const score of [1, 2, 3, 4, 5]) {
      expect(AxisScore.parse(score)).toBe(score);
    }
  });

  it('rejects 0 - a detector with no signal must not leak one', () => {
    expect(AxisScore.safeParse(0).success).toBe(false);
  });

  it('rejects 6 - a rescale without a clamp must not leak one', () => {
    expect(AxisScore.safeParse(6).success).toBe(false);
  });

  it('rejects a non-integer, NaN and both infinities', () => {
    expect(AxisScore.safeParse(3.5).success).toBe(false);
    expect(AxisScore.safeParse(Number.NaN).success).toBe(false);
    expect(AxisScore.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(AxisScore.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });
});

describe('AxisScores', () => {
  it('accepts a complete set', () => {
    expect(AxisScores.parse(validScores)).toEqual(validScores);
  });

  it('rejects a missing axis', () => {
    const { solo: _solo, ...partial } = validScores;
    expect(AxisScores.safeParse(partial).success).toBe(false);
  });

  it.each([0, 6, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %p on a single axis',
    (bad) => {
      expect(AxisScores.safeParse({ ...validScores, framing: bad }).success).toBe(false);
    },
  );
});

describe('CompositeScore', () => {
  it('rejects values outside 1-10 and non-finite values', () => {
    expect(CompositeScore.safeParse(0.9).success).toBe(false);
    expect(CompositeScore.safeParse(10.1).success).toBe(false);
    expect(CompositeScore.safeParse(Number.NaN).success).toBe(false);
    expect(CompositeScore.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// ComputedFeatures - numeric safety
// ---------------------------------------------------------------------

describe('ComputedFeatures', () => {
  it('accepts a well-formed vector', () => {
    expect(ComputedFeatures.parse(usable)).toEqual(usable);
  });

  it('accounts for every declared field exactly once', () => {
    const covered = [
      ...NUMERIC_FEATURE_FIELDS,
      ...BOOLEAN_FEATURE_FIELDS,
      ...STRING_FEATURE_FIELDS,
    ].sort();
    expect(covered).toEqual(Object.keys(ComputedFeatures.shape).sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it.each(NUMERIC_FEATURE_FIELDS)('rejects NaN in %s', (field) => {
    expect(ComputedFeatures.safeParse({ ...usable, [field]: Number.NaN }).success).toBe(false);
  });

  it.each(NUMERIC_FEATURE_FIELDS)('rejects Infinity in %s', (field) => {
    expect(
      ComputedFeatures.safeParse({ ...usable, [field]: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(
      ComputedFeatures.safeParse({ ...usable, [field]: Number.NEGATIVE_INFINITY }).success,
    ).toBe(false);
  });

  it.each(NUMERIC_FEATURE_FIELDS)('rejects a string in %s', (field) => {
    expect(ComputedFeatures.safeParse({ ...usable, [field]: '1' }).success).toBe(false);
  });

  it('accepts null only on the fields documented as unmeasurable', () => {
    // Everything here means "could not be measured", never "measured as
    // zero". pitch, eyeOpenness and smileIntensity need a mesh model the
    // 5-point detector does not provide.
    const nullable = new Set([
      'sharpnessEyeRegion',
      'pitch',
      'eyeOpenness',
      'smileIntensity',
      'primaryFaceConfidence',
      'secondLargestFaceRatio',
    ]);
    for (const field of NUMERIC_FEATURE_FIELDS) {
      const patch: Record<string, unknown> = { ...usable, [field]: null };
      if (field === 'sharpnessEyeRegion') patch['eyeRegionMeasured'] = false;
      expect(
        ComputedFeatures.safeParse(patch).success,
        `${field} nullability`,
      ).toBe(nullable.has(field));
    }
  });

  it('keeps zero distinct from null on sharpnessEyeRegion', () => {
    // A black eye region genuinely measures zero. If zero and null were
    // the same value the scorer would fall back to the whole frame and
    // rescue exactly the photo this measurement exists to catch.
    const measuredZero = ComputedFeatures.parse({ ...usable, sharpnessEyeRegion: 0 });
    expect(measuredZero.sharpnessEyeRegion).toBe(0);
    expect(measuredZero.eyeRegionMeasured).toBe(true);
  });

  it.each(BOOLEAN_FEATURE_FIELDS)('requires %s to be a boolean', (field) => {
    expect(ComputedFeatures.safeParse({ ...usable, [field]: 'yes' }).success).toBe(false);
    expect(ComputedFeatures.safeParse({ ...usable, [field]: 1 }).success).toBe(false);
  });

  it('requires a non-empty sourceFormat', () => {
    expect(ComputedFeatures.safeParse({ ...usable, sourceFormat: '' }).success).toBe(false);
    expect(ComputedFeatures.parse({ ...usable, sourceFormat: 'heic' }).sourceFormat).toBe('heic');
  });

  it.each([...NUMERIC_FEATURE_FIELDS, ...BOOLEAN_FEATURE_FIELDS, ...STRING_FEATURE_FIELDS])('rejects a missing %s', (field) => {
    const partial: Record<string, unknown> = { ...usable };
    delete partial[field];
    expect(ComputedFeatures.safeParse(partial).success).toBe(false);
  });

  it('requires faceCount to be a non-negative integer', () => {
    expect(ComputedFeatures.safeParse({ ...usable, faceCount: 1.5 }).success).toBe(false);
    expect(ComputedFeatures.safeParse({ ...usable, faceCount: -1 }).success).toBe(false);
    expect(ComputedFeatures.parse({ ...usable, faceCount: 0 }).faceCount).toBe(0);
  });

  it('bounds ratios to 0-1 and luma to 0-255', () => {
    expect(ComputedFeatures.safeParse({ ...usable, clippedHighlights: 1.2 }).success).toBe(false);
    expect(ComputedFeatures.safeParse({ ...usable, faceAreaRatio: -0.1 }).success).toBe(false);
    expect(ComputedFeatures.safeParse({ ...usable, exposureMean: 256 }).success).toBe(false);
  });

  it('allows a signed face offset but bounds it to the frame', () => {
    expect(ComputedFeatures.parse({ ...usable, faceCenterOffsetY: -0.9 })).toBeTruthy();
    expect(ComputedFeatures.safeParse({ ...usable, faceCenterOffsetY: -1.1 }).success).toBe(false);
  });
});

describe('assertFeaturesUsable', () => {
  it('passes a well-formed vector', () => {
    expect(() => assertFeaturesUsable(usable)).not.toThrow();
  });

  it.each(NUMERIC_FEATURE_FIELDS)('throws a FeatureError naming %s when it is NaN', (field) => {
    const corrupt = { ...usable, [field]: Number.NaN };
    expect(() => assertFeaturesUsable(corrupt)).toThrow(FeatureError);
    try {
      assertFeaturesUsable(corrupt);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureError);
      expect((error as FeatureError).field).toBe(field);
      expect((error as FeatureError).message).toContain(field);
      expect((error as FeatureError).message).toContain('NaN');
    }
  });

  it('names the field when it is Infinity', () => {
    const corrupt = { ...usable, dynamicRange: Number.POSITIVE_INFINITY };
    expect(() => assertFeaturesUsable(corrupt)).toThrow(/dynamicRange/);
  });

  it('rejects a face confidence when no face was found', () => {
    // A face-derived measurement without a face means the detector and
    // the vector disagree about whether there was a subject at all.
    expect(() =>
      assertFeaturesUsable({ ...usable, faceCount: 0, primaryFaceConfidence: 0.9 }),
    ).toThrow(/primaryFaceConfidence/);
    expect(() =>
      assertFeaturesUsable({ ...usable, faceCount: 0, primaryFaceConfidence: null }),
    ).not.toThrow();
  });

  it('names the field when it is out of range', () => {
    expect(() => assertFeaturesUsable({ ...usable, eyeOpenness: 1.4 })).toThrow(
      /eyeOpenness.*\[0, 1\]/s,
    );
  });

  it('names the field when an integer field is fractional', () => {
    expect(() => assertFeaturesUsable({ ...usable, width: 1600.5 })).toThrow(/width.*integer/s);
  });

  it('rejects a value that arrived from JSON as a string', () => {
    const fromJson = { ...usable, exposureMean: '124' } as unknown as ComputedFeatures;
    expect(() => assertFeaturesUsable(fromJson)).toThrow(/exposureMean.*expected a number/s);
  });

  it.each(BOOLEAN_FEATURE_FIELDS)('names %s when it is not a boolean', (field) => {
    expect(() => assertFeaturesUsable({ ...usable, [field]: 'yes' })).toThrow(
      new RegExp(`${field}.*expected a boolean`, 's'),
    );
  });

  it.each(STRING_FEATURE_FIELDS)('names %s when it is empty', (field) => {
    expect(() => assertFeaturesUsable({ ...usable, [field]: '' })).toThrow(
      new RegExp(`${field}.*non-empty string`, 's'),
    );
  });

  it('accepts a null eye-region measurement when the flag agrees', () => {
    expect(() =>
      assertFeaturesUsable({ ...usable, sharpnessEyeRegion: null, eyeRegionMeasured: false }),
    ).not.toThrow();
  });

  it('rejects a flag that disagrees with the measurement, in both directions', () => {
    expect(() =>
      assertFeaturesUsable({ ...usable, sharpnessEyeRegion: null, eyeRegionMeasured: true }),
    ).toThrow(/eyeRegionMeasured/);
    expect(() =>
      assertFeaturesUsable({ ...usable, sharpnessEyeRegion: 12, eyeRegionMeasured: false }),
    ).toThrow(/eyeRegionMeasured/);
  });

  it('rejects null and a non-object at the root', () => {
    expect(() => assertFeaturesUsable(null as unknown as ComputedFeatures)).toThrow(FeatureError);
    expect(() => assertFeaturesUsable(7 as unknown as ComputedFeatures)).toThrow(/\(root\)/);
  });

  it('agrees with the schema on every field it guards', () => {
    for (const field of NUMERIC_FEATURE_FIELDS) {
      const rule = FEATURE_RULES[field];
      const belowMin = { ...usable, [field]: rule.min - 1 };
      expect(ComputedFeatures.safeParse(belowMin).success).toBe(false);
      expect(() => assertFeaturesUsable(belowMin)).toThrow(FeatureError);
    }
  });
});

// ---------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------

describe('JudgedAxis', () => {
  it('requires evidence alongside the score', () => {
    expect(JudgedAxis.safeParse({ score: 4 }).success).toBe(false);
    expect(JudgedAxis.safeParse({ evidence: '', score: 4 }).success).toBe(false);
  });

  it('rejects a score of 0 or 6', () => {
    expect(JudgedAxis.safeParse(judged(0)).success).toBe(false);
    expect(JudgedAxis.safeParse(judged(6)).success).toBe(false);
  });

  it('rejects evidence shorter than a real observation', () => {
    expect(JudgedAxis.safeParse({ evidence: 'busy', score: 2 }).success).toBe(false);
  });
});

describe('Assessment', () => {
  const complete = {
    background: judged(4),
    attire: judged(3),
    expression: judged(5),
    solo: judged(5),
    framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
  };

  it('accepts the four judged axes plus the framing observation', () => {
    expect(Assessment.parse(complete).framing_observation.crop).toBe('head_and_shoulders');
  });

  it('rejects a reply that tries to score a computed axis', () => {
    expect(Assessment.safeParse({ ...complete, sharpness: judged(2) }).success).toBe(false);
  });

  it('rejects a missing judged axis', () => {
    const { solo: _solo, ...partial } = complete;
    expect(Assessment.safeParse(partial).success).toBe(false);
  });

  it('rejects evidence too thin to justify a score', () => {
    // A one-word justification is what a model produces when it scores
    // first and explains afterwards, which is the failure the minimum
    // length exists to catch.
    expect(
      Assessment.safeParse({ ...complete, background: { evidence: 'busy', score: 2 } }).success,
    ).toBe(false);
  });

  it('rejects an unknown crop extent', () => {
    expect(
      Assessment.safeParse({
        ...complete,
        framing_observation: { crop: 'torso', face_roughly_centered: true },
      }).success,
    ).toBe(false);
  });
});

describe('RubricResponse', () => {
  const assessment = {
    background: judged(4),
    attire: judged(3),
    expression: judged(5),
    solo: judged(5),
    framing_observation: { crop: 'head_only', face_roughly_centered: false },
  };

  it('accepts the assessed branch', () => {
    const parsed = RubricResponse.parse({ status: 'assessed', assessment });
    expect(isAssessed(parsed)).toBe(true);
  });

  it('accepts a decline with a typed reason and no prose to flatten', () => {
    const parsed = RubricResponse.parse({
      status: 'declined',
      reason: 'apparent_minor',
      detail: 'This service only assesses photographs of adults.',
    });
    expect(isAssessed(parsed)).toBe(false);
    if (parsed.status !== 'declined') throw new Error('expected a decline');
    expect(parsed.reason).toBe('apparent_minor');
  });

  it.each(RubricDecline.options)('maps %s straight onto DeclineReason', (reason) => {
    // The rubric's reasons are a subset of DeclineReason by construction,
    // so a decline never needs translating.
    expect(DeclineReason.options).toContain(reason);
  });

  it('rejects a decline reason the rubric may not return', () => {
    // model_refusal comes from stop_reason, never from the model's body.
    expect(
      RubricResponse.safeParse({ status: 'declined', reason: 'model_refusal', detail: 'no' })
        .success,
    ).toBe(false);
    expect(
      RubricResponse.safeParse({ status: 'declined', reason: 'corrupt_file', detail: 'no' })
        .success,
    ).toBe(false);
  });

  it('rejects a branch carrying the other branch payload', () => {
    expect(RubricResponse.safeParse({ status: 'assessed', reason: 'no_face' }).success).toBe(false);
    expect(RubricResponse.safeParse({ status: 'declined', assessment }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(RubricResponse.safeParse({ status: 'maybe', assessment }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// ScoreResult and Fix
// ---------------------------------------------------------------------

describe('Fix', () => {
  it('accepts every severity', () => {
    for (const severity of FixSeverity.options) {
      expect(Fix.parse({ axis: 'framing', severity, message: 'Move closer.' })).toBeTruthy();
    }
  });

  it('rejects an unknown severity and an empty message', () => {
    expect(Fix.safeParse({ axis: 'framing', severity: 'critical', message: 'x' }).success).toBe(
      false,
    );
    expect(Fix.safeParse({ axis: 'framing', severity: 'high', message: '' }).success).toBe(false);
  });
});

describe('ScoreResult', () => {
  const result = {
    score: 7.4,
    axes: validScores,
    context: 'corporate',
    fixes: [{ axis: 'framing', severity: 'medium', message: 'Move closer.' }],
    confidence: 0.92,
    weightsVersion: '2026-09-24.1',
    coverage: 'full',
  };

  it('accepts a complete result', () => {
    expect(ScoreResult.parse(result).score).toBe(7.4);
  });

  it('accepts an empty fix list - a photo with nothing to fix', () => {
    expect(ScoreResult.parse({ ...result, fixes: [] }).fixes).toEqual([]);
  });

  it.each([0, 11, Number.NaN, Number.POSITIVE_INFINITY])('rejects a score of %p', (bad) => {
    expect(ScoreResult.safeParse({ ...result, score: bad }).success).toBe(false);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a confidence of %p',
    (bad) => {
      expect(ScoreResult.safeParse({ ...result, confidence: bad }).success).toBe(false);
    },
  );

  it('requires a non-empty weightsVersion', () => {
    expect(ScoreResult.safeParse({ ...result, weightsVersion: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// AnalysisOutcome
// ---------------------------------------------------------------------

describe('AnalysisOutcome', () => {
  const scored = {
    status: 'scored',
    result: {
      score: 7.4,
      axes: validScores,
      context: 'startup',
      fixes: [],
      confidence: 1,
      weightsVersion: '2026-09-24.1',
      coverage: 'full',
    },
  };

  const declined = {
    status: 'declined',
    reason: 'no_face',
    message: 'No face was found in this image.',
  };

  it('accepts both branches', () => {
    expect(isScored(AnalysisOutcome.parse(scored))).toBe(true);
    expect(isDeclined(AnalysisOutcome.parse(declined))).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(AnalysisOutcome.safeParse({ ...scored, status: 'error' }).success).toBe(false);
  });

  it('rejects a declined branch carrying a result instead of a reason', () => {
    expect(AnalysisOutcome.safeParse({ status: 'declined', result: scored.result }).success).toBe(
      false,
    );
  });

  it('rejects a scored branch with no result', () => {
    expect(AnalysisOutcome.safeParse({ status: 'scored' }).success).toBe(false);
  });

  it('rejects a decline reason outside the enum', () => {
    expect(AnalysisOutcome.safeParse({ ...declined, reason: 'ugly' }).success).toBe(false);
    expect(DeclineReason.options).toHaveLength(5);
  });

  it('requires a user-facing message on a decline', () => {
    expect(AnalysisOutcome.safeParse({ ...declined, message: '' }).success).toBe(false);
  });

  it('routes both branches through matchOutcome', () => {
    const describe_ = (outcome: AnalysisOutcome): string =>
      matchOutcome(outcome, {
        scored: (result) => `scored ${result.score}`,
        declined: (reason) => `declined ${reason}`,
      });

    expect(describe_(AnalysisOutcome.parse(scored))).toBe('scored 7.4');
    expect(describe_(AnalysisOutcome.parse(declined))).toBe('declined no_face');
  });
});

// ---------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------

describe('UploadRequest', () => {
  it('rejects uploads over the storage cap', () => {
    expect(
      UploadRequest.safeParse({
        filename: 'headshot.jpg',
        contentType: 'image/jpeg',
        byteSize: MAX_UPLOAD_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a format sharp is not configured to decode', () => {
    expect(
      UploadRequest.safeParse({
        filename: 'headshot.heic',
        contentType: 'image/heic',
        byteSize: 1024,
      }).success,
    ).toBe(false);
  });

  it('rejects a NaN byte size', () => {
    expect(
      UploadRequest.safeParse({
        filename: 'headshot.jpg',
        contentType: 'image/jpeg',
        byteSize: Number.NaN,
      }).success,
    ).toBe(false);
  });
});
