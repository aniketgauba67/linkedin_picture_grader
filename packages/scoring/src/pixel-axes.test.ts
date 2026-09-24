import { describe, expect, it } from 'vitest';
import type { PixelFeatures } from './pixel-axes.js';
import {
  JPEG_QUALITY_FLOOR,
  faceCenterOffset,
  framingScore,
  lightingScore,
  resolutionScore,
  scoreAgainstThresholds,
  scoreComputedAxes,
  sharpnessScore,
} from './pixel-axes.js';
import { COMPUTED_AXES } from './axes.js';

const baseline: PixelFeatures = {
  width: 1200,
  height: 1200,
  sharpnessLaplacian: 400,
  sharpnessEyeRegion: 400,
  jpegQualityEstimate: 90,
  dynamicRange: 180,
  clippedHighlights: 0.005,
  clippedShadows: 0.005,
  faceAreaRatio: 0.15,
  faceCenterOffsetX: 0.03,
  faceCenterOffsetY: -0.04,
  faceCount: 1,
};

describe('scoreAgainstThresholds', () => {
  it('returns 1 below the first threshold and 5 above the last', () => {
    expect(scoreAgainstThresholds(0, [10, 20, 30, 40])).toBe(1);
    expect(scoreAgainstThresholds(10, [10, 20, 30, 40])).toBe(2);
    expect(scoreAgainstThresholds(35, [10, 20, 30, 40])).toBe(4);
    expect(scoreAgainstThresholds(1000, [10, 20, 30, 40])).toBe(5);
  });

  it('never exceeds 5 even with a longer ladder', () => {
    expect(scoreAgainstThresholds(99, [1, 2, 3, 4, 5, 6])).toBe(5);
  });
});

describe('sharpnessScore', () => {
  it('measures at the eyes when a face was found', () => {
    // Crisp collar, soft eyes: the whole-frame number must not rescue it.
    const softEyes = sharpnessScore({
      ...baseline,
      sharpnessLaplacian: 900,
      sharpnessEyeRegion: 20,
    });
    expect(softEyes).toBe(1);
  });

  it('falls back to the whole frame when there is no face', () => {
    const noFace = sharpnessScore({
      ...baseline,
      faceCount: 0,
      sharpnessEyeRegion: 0,
      sharpnessLaplacian: 900,
    });
    expect(noFace).toBe(5);
  });

  it('costs a point when JPEG artifacts are faking the edge energy', () => {
    const clean = sharpnessScore({ ...baseline, jpegQualityEstimate: 95 });
    const crunchy = sharpnessScore({ ...baseline, jpegQualityEstimate: JPEG_QUALITY_FLOOR - 1 });
    expect(clean).toBe(4);
    expect(crunchy).toBe(3);
  });

  it('rises monotonically with eye-region sharpness', () => {
    const scores = [5, 60, 150, 400, 900].map((sharpnessEyeRegion) =>
      sharpnessScore({ ...baseline, sharpnessEyeRegion }),
    );
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(scores.at(-1)).toBe(5);
  });
});

describe('lightingScore', () => {
  it('penalises clipping on top of an otherwise good range', () => {
    expect(lightingScore({ ...baseline, dynamicRange: 210 })).toBe(5);
    expect(lightingScore({ ...baseline, dynamicRange: 210, clippedHighlights: 0.12 })).toBe(3);
  });

  it('never falls below the floor however bad the exposure', () => {
    expect(
      lightingScore({
        ...baseline,
        dynamicRange: 10,
        clippedHighlights: 0.5,
        clippedShadows: 0.4,
      }),
    ).toBe(1);
  });
});

describe('resolutionScore', () => {
  it('scores from pixel dimensions, not from file size', () => {
    expect(resolutionScore({ ...baseline, width: 200, height: 200 })).toBe(1);
    expect(resolutionScore({ ...baseline, width: 2000, height: 2000 })).toBe(5);
  });
});

describe('faceCenterOffset', () => {
  it('is the magnitude of the signed offsets', () => {
    expect(
      faceCenterOffset({ ...baseline, faceCenterOffsetX: 0.3, faceCenterOffsetY: -0.4 }),
    ).toBeCloseTo(0.5);
  });

  it('treats a face above centre the same as one below it', () => {
    const above = faceCenterOffset({ ...baseline, faceCenterOffsetX: 0, faceCenterOffsetY: 0.2 });
    const below = faceCenterOffset({ ...baseline, faceCenterOffsetX: 0, faceCenterOffsetY: -0.2 });
    expect(above).toBeCloseTo(below);
  });
});

describe('framingScore', () => {
  it('floors when no face was detected', () => {
    expect(framingScore({ ...baseline, faceAreaRatio: 0 })).toBe(1);
  });

  it('penalises a clearly off-centre face', () => {
    expect(framingScore({ ...baseline, faceAreaRatio: 0.22 })).toBe(5);
    expect(
      framingScore({
        ...baseline,
        faceAreaRatio: 0.22,
        faceCenterOffsetX: 0.3,
        faceCenterOffsetY: 0.3,
      }),
    ).toBe(4);
  });

  it('does not penalise the slight off-centre of a well-composed headshot', () => {
    expect(
      framingScore({ ...baseline, faceAreaRatio: 0.22, faceCenterOffsetY: 0.08 }),
    ).toBe(5);
  });
});

describe('scoreComputedAxes', () => {
  it('returns exactly the four computed axes, each 1-5', () => {
    const scores = scoreComputedAxes(baseline);
    expect(Object.keys(scores).sort()).toEqual([...COMPUTED_AXES].sort());
    for (const axis of COMPUTED_AXES) {
      expect(scores[axis]).toBeGreaterThanOrEqual(1);
      expect(scores[axis]).toBeLessThanOrEqual(5);
    }
  });

  it('does nothing but arithmetic - the same vector always scores the same', () => {
    expect(scoreComputedAxes(baseline)).toEqual(scoreComputedAxes({ ...baseline }));
  });
});
