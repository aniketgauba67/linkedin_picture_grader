import { describe, expect, it } from 'vitest';
import type { Fix as ScoringFix, PixelFeatures, ScoreResultShape } from '@pps/scoring';
import { CONTEXTS, computeConfidence, scoreComputedAxes, scorePhoto } from '@pps/scoring';
import type { ComputedFeatures } from './features.js';
import type { Fix, ScoreResult } from './result.js';
import { ScoreResult as ScoreResultSchema } from './result.js';
import { AxisScores } from './axes.js';

/**
 * `@pps/scoring` keeps an empty `dependencies` object so it can run in
 * Deno and the browser, which means it cannot import zod and must mirror
 * these types structurally. This file is the seam that keeps the mirror
 * true: it fails at compile time if the shapes diverge and at run time if
 * the values do.
 */

// --- compile-time: the mirrors must be mutually assignable -------------

const _featuresAreAssignable: PixelFeatures = {} as ComputedFeatures;
const _fixesMatch: Fix = {} as ScoringFix;
const _fixesMatchBack: ScoringFix = {} as Fix;
const _resultsMatch: ScoreResult = {} as ScoreResultShape;
const _resultsMatchBack: ScoreResultShape = {} as ScoreResult;
void _featuresAreAssignable;
void _fixesMatch;
void _fixesMatchBack;
void _resultsMatch;
void _resultsMatchBack;

// --- run-time: what the scorer emits must satisfy the schema -----------

const features: ComputedFeatures = {
  sharpnessLaplacian: 260,
  sharpnessEyeRegion: 310,
  jpegQualityEstimate: 84,
  exposureMean: 130,
  clippedHighlights: 0.006,
  clippedShadows: 0.004,
  dynamicRange: 186,
  width: 1500,
  height: 1500,
  faceAreaRatio: 0.12,
  faceCenterOffsetX: 0.02,
  faceCenterOffsetY: -0.05,
  faceCount: 1,
  yaw: 4,
  pitch: -6,
  roll: 1.2,
  eyeOpenness: 0.78,
  smileIntensity: 0.33,
  eyeRegionMeasured: true,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
};

const assessed = { background: 4, attire: 3, expression: 4, solo: 5 };

describe('scoring mirror', () => {
  it.each(CONTEXTS)('scorePhoto output parses as a ScoreResult in %s', (context) => {
    const axes = AxisScores.parse({ ...scoreComputedAxes(features), ...assessed });
    const result = scorePhoto(axes, context, { confidence: computeConfidence(features) });
    expect(() => ScoreResultSchema.parse(result)).not.toThrow();
  });

  it('emits axis scores the AxisScores schema accepts', () => {
    expect(() => AxisScores.parse({ ...scoreComputedAxes(features), ...assessed })).not.toThrow();
  });

  it('emits a confidence inside the schema bounds even for a faceless image', () => {
    const faceless: ComputedFeatures = {
      ...features,
      faceCount: 0,
      faceAreaRatio: 0,
      sharpnessEyeRegion: null,
      eyeRegionMeasured: false,
    };
    const axes = AxisScores.parse({ ...scoreComputedAxes(faceless), ...assessed });
    const result = scorePhoto(axes, 'startup', { confidence: computeConfidence(faceless) });
    expect(ScoreResultSchema.parse(result).confidence).toBeLessThan(1);
  });

  it('emits fixes the Fix schema accepts, including the worst case', () => {
    const worst = AxisScores.parse({
      sharpness: 1,
      lighting: 1,
      resolution: 1,
      framing: 1,
      background: 1,
      attire: 1,
      expression: 1,
      solo: 1,
    });
    const result = ScoreResultSchema.parse(scorePhoto(worst, 'corporate'));
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.score).toBe(1);
  });
});
