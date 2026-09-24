import { describe, expect, it } from 'vitest';
import type { ConfidenceInputs } from './confidence.js';
import { computeConfidence } from './confidence.js';

const certain: ConfidenceInputs = {
  width: 1600,
  height: 1600,
  sharpnessLaplacian: 400,
  sharpnessEyeRegion: 480,
  jpegQualityEstimate: 92,
  dynamicRange: 190,
  clippedHighlights: 0.003,
  clippedShadows: 0.003,
  faceAreaRatio: 0.16,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.03,
  faceCount: 1,
  yaw: 2,
  pitch: -3,
  roll: 1,
};

describe('computeConfidence', () => {
  it('is 1 for a single square-on face in a clean file', () => {
    expect(computeConfidence(certain)).toBe(1);
  });

  it('drops hardest when there is no face to measure', () => {
    expect(computeConfidence({ ...certain, faceCount: 0 })).toBeCloseTo(0.55);
  });

  it('drops when several faces mean the wrong one may have been measured', () => {
    expect(computeConfidence({ ...certain, faceCount: 3 })).toBeCloseTo(0.75);
  });

  it('drops as the head turns away from the lens', () => {
    expect(computeConfidence({ ...certain, yaw: 25 })).toBeCloseTo(0.9);
    expect(computeConfidence({ ...certain, yaw: -50 })).toBeCloseTo(0.8);
  });

  it('drops when compression makes the sharpness numbers unreliable', () => {
    expect(computeConfidence({ ...certain, jpegQualityEstimate: 20 })).toBeCloseTo(0.85);
  });

  it('drops when the face is jammed against an edge, which usually means a crop', () => {
    expect(
      computeConfidence({ ...certain, faceCenterOffsetX: 0.4, faceCenterOffsetY: 0.2 }),
    ).toBeCloseTo(0.9);
  });

  it('is not a quality signal - a badly lit square-on face is still certain', () => {
    expect(
      computeConfidence({ ...certain, dynamicRange: 20, clippedShadows: 0.4 }),
    ).toBe(1);
  });

  it('stays within 0-1 when everything goes wrong at once', () => {
    const value = computeConfidence({
      ...certain,
      faceCount: 0,
      yaw: 90,
      pitch: 60,
      jpegQualityEstimate: 5,
      faceCenterOffsetX: 0.9,
    });
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});
