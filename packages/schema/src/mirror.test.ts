import { describe, expect, it } from 'vitest';
import type { Fix as ScoringFix, PixelFeatures, ScoreResultShape } from '@pps/scoring';
import { CONTEXTS, computeConfidence, score } from '@pps/scoring';
import type { ComputedFeatures } from './features.js';
import type { Fix, ScoreResult } from './result.js';
import { ScoreResult as ScoreResultSchema } from './result.js';
import { AxisScores } from './axes.js';
import { assertFeaturesUsable } from './features.js';

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
void _resultsMatch;
void _resultsMatchBack;
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
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
  exposureDelta: 4,
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
  primaryFaceConfidence: 0.91,
  secondLargestFaceRatio: null,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
  extractorVersion: 'v7',
};

const assessed = { background: 4, attire: 3, expression: 4, solo: 5 };

describe('scoring mirror', () => {
  it.each(CONTEXTS)('score() output parses as a ScoreResult in %s', (context) => {
    assertFeaturesUsable(features);
    const result = score({
      features,
      judged: assessed,
      context,
      confidence: computeConfidence({ ...features, yaw: features.yaw, pitch: features.pitch }),
    });
    expect(() => ScoreResultSchema.parse(result)).not.toThrow();
  });

  it('emits axis scores the AxisScores schema accepts', () => {
    assertFeaturesUsable(features);
    const result = score({ features, judged: assessed });
    expect(() => AxisScores.parse(result.axes)).not.toThrow();
  });

  it('marks the degraded path partial and still parses', () => {
    assertFeaturesUsable(features);
    const result = score({ features });
    expect(result.coverage).toBe('partial');
    // Only four axes contributed, so the full AxisScores shape does not
    // apply - but the ScoreResult schema must still accept the result.
    expect(() => ScoreResultSchema.parse(result)).not.toThrow();
  });

  it('emits a confidence inside the schema bounds for a faceless image', () => {
    const faceless: ComputedFeatures = {
      ...features,
      faceCount: 0,
      faceAreaRatio: 0,
      sharpnessEyeRegion: null,
      eyeRegionMeasured: false,
      primaryFaceConfidence: null,
    };
    assertFeaturesUsable(faceless);
    const result = score({
      features: faceless,
      judged: assessed,
      confidence: computeConfidence({ ...faceless, yaw: faceless.yaw, pitch: faceless.pitch }),
    });
    expect(ScoreResultSchema.parse(result).confidence).toBeLessThan(1);
  });

  it('emits fixes the Fix schema accepts, including the worst case', () => {
    const worst: ComputedFeatures = {
      ...features,
      sharpnessLaplacian: 1,
      sharpnessEyeRegion: 1,
      dynamicRange: 5,
      faceExposureMean: 118,
      faceClippedHighlights: 0.002,
      faceClippedShadows: 0.003,
      faceRegionMeasured: true,
      exposureDelta: 4,
      width: 200,
      height: 200,
      faceAreaRatio: 0.01,
    };
    assertFeaturesUsable(worst);
    const result = ScoreResultSchema.parse(
      score({ features: worst, judged: { background: 1, attire: 1, expression: 1, solo: 1 } }),
    );
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(4);
  });
});
