import { describe, expect, it } from 'vitest';
import type { ValidatedPixelFeatures } from './pixel-axes.js';
import type { JudgedScores } from './compute.js';
import { bandPenalty, framingRaw } from './compute.js';
import { WEIGHTS_V1 } from './weights/v1.js';
import { WeightsVersionError, composeScore, score } from './score.js';
import { CONTEXTS } from './weights.js';
import { AXES, COMPUTED_AXES } from './axes.js';

/** A photograph with nothing wrong with it. */
const GOOD = {
  width: 1600,
  height: 1600,
  sharpnessLaplacian: 800,
  sharpnessEyeRegion: 800,
  eyeRegionMeasured: true,
  jpegQualityEstimate: 95,
  exposureMean: 128,
  dynamicRange: 215,
  clippedHighlights: 0.001,
  clippedShadows: 0.001,
  faceAreaRatio: 0.3,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.02,
  faceCount: 1,
  extractorVersion: 'v5',
} as ValidatedPixelFeatures;

/** Soft, dark, tiny, and the subject is a speck in the corner. */
const BAD = {
  ...GOOD,
  sharpnessLaplacian: 5,
  sharpnessEyeRegion: 5,
  jpegQualityEstimate: 20,
  exposureMean: 25,
  dynamicRange: 30,
  clippedShadows: 0.35,
  width: 300,
  height: 300,
  faceAreaRatio: 0.02,
  faceCenterOffsetX: 0.4,
  faceCenterOffsetY: 0.35,
} as ValidatedPixelFeatures;

const judgedGood: JudgedScores = { background: 5, attire: 5, expression: 5, solo: 5 };
const judgedBad: JudgedScores = { background: 1, attire: 1, expression: 1, solo: 1 };

describe('score', () => {
  it('rates a known-good photograph 8 or better', () => {
    expect(score({ features: GOOD, judged: judgedGood }).score).toBeGreaterThanOrEqual(8);
  });

  it('rates a known-bad photograph 3 or worse', () => {
    expect(score({ features: BAD, judged: judgedBad }).score).toBeLessThanOrEqual(3);
  });

  it('is deterministic across 100 runs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(JSON.stringify(score({ features: GOOD, judged: judgedGood })));
    }
    expect(seen.size).toBe(1);
  });

  it.each(CONTEXTS)('stays inside 1-10 in %s', (context) => {
    expect(score({ features: BAD, judged: judgedBad, context }).score).toBeGreaterThanOrEqual(1);
    expect(score({ features: GOOD, judged: judgedGood, context }).score).toBeLessThanOrEqual(10);
  });

  it('throws when the weights were fitted against another extractor', () => {
    const stale = { ...GOOD, extractorVersion: 'v4' } as ValidatedPixelFeatures;
    expect(() => score({ features: stale, judged: judgedGood })).toThrow(WeightsVersionError);
  });

  it('names both versions in the mismatch, so the fix is obvious', () => {
    const stale = { ...GOOD, extractorVersion: 'v4' } as ValidatedPixelFeatures;
    try {
      score({ features: stale, judged: judgedGood });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WeightsVersionError);
      const e = error as WeightsVersionError;
      expect(e.featuresExtractorVersion).toBe('v4');
      expect(e.weightsCompatibleWith).toBe(WEIGHTS_V1.compatibleExtractorVersion);
      expect(e.message).toContain('v4');
    }
  });

  it('refuses a confidence outside 0-1 rather than passing it on', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      expect(() => score({ features: GOOD, judged: judgedGood, confidence: bad })).toThrow(
        RangeError,
      );
    }
  });
});

describe('the degraded path', () => {
  it('scores the four computed axes when the model declined', () => {
    const partial = score({ features: GOOD });
    expect(partial.coverage).toBe('partial');
    expect(Object.keys(partial.axes).sort()).toEqual([...COMPUTED_AXES].sort());
  });

  it('renormalises, so half the axes do not halve the score', () => {
    // Weights sum to 1 across eight axes. Without renormalising, four
    // good axes would report roughly half of what they earned.
    const partial = score({ features: GOOD });
    expect(partial.score).toBeGreaterThanOrEqual(8);
  });

  it('keeps confidence a number and puts the label in coverage', () => {
    const partial = score({ features: GOOD, confidence: 0.55 });
    expect(partial.confidence).toBe(0.55);
    expect(partial.coverage).toBe('partial');
  });

  it('marks a fully judged photograph as full coverage', () => {
    expect(score({ features: GOOD, judged: judgedGood }).coverage).toBe('full');
  });
});

describe('composeScore', () => {
  it('maps a straight 5 to 10 and a straight 1 to 1', () => {
    const all = (v: number) => Object.fromEntries(AXES.map((a) => [a, v]));
    expect(composeScore(all(5), 'corporate')).toBe(10);
    expect(composeScore(all(1), 'corporate')).toBe(1);
  });

  it('throws rather than dividing by zero when nothing contributed', () => {
    expect(() => composeScore({}, 'corporate')).toThrow(RangeError);
  });
});

describe('two-sided axes', () => {
  it('penalises a face that is too large, not only one that is too small', () => {
    // The bug an isotonic map cannot express: framing is NOT monotone in
    // faceAreaRatio, so the map runs over framingRaw instead.
    const ideal = framingRaw({ ...GOOD, faceAreaRatio: 0.3 }, WEIGHTS_V1);
    const tooSmall = framingRaw({ ...GOOD, faceAreaRatio: 0.08 }, WEIGHTS_V1);
    const tooLarge = framingRaw({ ...GOOD, faceAreaRatio: 0.75 }, WEIGHTS_V1);

    expect(ideal).toBeGreaterThan(tooSmall);
    expect(ideal).toBeGreaterThan(tooLarge);
  });

  it('charges nothing inside the ideal band', () => {
    const { idealRatioMin, idealRatioMax } = WEIGHTS_V1.framing;
    for (const ratio of [idealRatioMin, 0.3, idealRatioMax]) {
      expect(framingRaw({ ...GOOD, faceAreaRatio: ratio, faceCenterOffsetX: 0, faceCenterOffsetY: 0 }, WEIGHTS_V1)).toBe(1);
    }
  });

  it('penalises exposure on both sides, which was previously unused', () => {
    const dark = score({ features: { ...GOOD, exposureMean: 20 } as ValidatedPixelFeatures });
    const bright = score({ features: { ...GOOD, exposureMean: 245 } as ValidatedPixelFeatures });
    const middle = score({ features: GOOD });
    // axes is partial now - the degraded path carries only four - so
    // read through a helper that fails loudly if an axis is absent.
    const lighting = (r: { axes: Readonly<Partial<Record<string, number>>> }): number => {
      const v = r.axes['lighting'];
      if (v === undefined) throw new Error('lighting missing');
      return v;
    };
    expect(lighting(middle)).toBeGreaterThan(lighting(dark));
    expect(lighting(middle)).toBeGreaterThan(lighting(bright));
  });

  it('bandPenalty is zero inside the band and grows outside it', () => {
    expect(bandPenalty(5, 1, 10, 2)).toBe(0);
    expect(bandPenalty(0, 1, 10, 2)).toBeCloseTo(2);
    expect(bandPenalty(12, 1, 10, 2)).toBeCloseTo(4);
  });
});

describe('the sharpness basis is never coalesced', () => {
  it('scores a measured zero as 1 rather than falling back to the frame', () => {
    const flatEyes = {
      ...GOOD,
      sharpnessLaplacian: 5000,
      sharpnessEyeRegion: 0,
      eyeRegionMeasured: true,
    } as ValidatedPixelFeatures;
    expect(score({ features: flatEyes }).axes.sharpness).toBe(1);
  });

  it('falls back to the frame only when the eye region is unmeasurable', () => {
    const unmeasured = {
      ...GOOD,
      sharpnessLaplacian: 800,
      sharpnessEyeRegion: null,
      eyeRegionMeasured: false,
    } as ValidatedPixelFeatures;
    expect(score({ features: unmeasured }).axes.sharpness).toBe(5);
  });
});
