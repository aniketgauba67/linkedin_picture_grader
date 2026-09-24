import { describe, expect, it } from 'vitest';
import type { ValidatedPixelFeatures } from './pixel-axes.js';
import type { JudgedScores } from './compute.js';
import { bandPenalty, framingRaw, lightingRaw, resolutionScore } from './compute.js';
import { WEIGHTS_V1 } from './weights/v1.js';
import { WeightsVersionError, composeScore, meanToComposite, score } from './score.js';
import { CONTEXTS, DEFAULT_CONTEXT, weightsFor } from './weights.js';
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
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
  clippedHighlights: 0.001,
  clippedShadows: 0.001,
  faceAreaRatio: 0.3,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.02,
  faceCount: 1,
  extractorVersion: 'v7',
} as ValidatedPixelFeatures;

/** Soft, dark, tiny, and the subject is a speck in the corner. */
const BAD = {
  ...GOOD,
  sharpnessLaplacian: 5,
  sharpnessEyeRegion: 5,
  jpegQualityEstimate: 20,
  exposureMean: 25,
  dynamicRange: 30,
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
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
    //
    // Asserted as a RELATIONSHIP, not against a magic number: the
    // fitted framing map caps at 2, so the absolute value moves
    // whenever a map is refitted and a hardcoded threshold would keep
    // failing for reasons that have nothing to do with renormalising.
    const partial = score({ features: GOOD });
    const weights = weightsFor(DEFAULT_CONTEXT);

    let weighted = 0;
    let used = 0;
    for (const axis of COMPUTED_AXES) {
      const value = partial.axes[axis];
      if (value === undefined) throw new Error(`${axis} missing from the degraded path`);
      weighted += value * weights[axis];
      used += weights[axis];
    }
    // Renormalised: divided by the weight actually used, not by 1.
    // meanToComposite, not a hand-rolled *2 - the 1-5 axis scale maps
    // onto 1-10 by 1 + (mean - 1) * 2.25, and writing that out again
    // here would be a second copy to get wrong.
    const expected = meanToComposite(weighted / used);
    expect(partial.score).toBeCloseTo(expected, 1);

    // And the point of renormalising: without it, four present axes
    // would be divided by the full eight-axis weight and report less.
    expect(expected).toBeGreaterThan(meanToComposite(weighted));
  });

  it('caps a perfectly framed photograph at framing 2, which is the fitted ceiling', () => {
    // Not a bug. The framing map was fitted on labels that never
    // reached 4 or 5, so it is valid to 2 and extrapolates above -
    // recorded in weights/v1.ts and docs/calibration-notes.md. This
    // test exists so that the day it is refitted, the change in
    // product behaviour is visible rather than silent.
    const ideal = { ...GOOD, faceAreaRatio: 0.3, faceCenterOffsetX: 0, faceCenterOffsetY: 0 };
    expect(framingRaw(ideal as ValidatedPixelFeatures, WEIGHTS_V1)).toBe(1);
    const partial = score({ features: ideal as ValidatedPixelFeatures });
    expect(partial.axes['framing']).toBe(2);
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

  it('penalises FACE exposure on both sides, not whole-frame exposure', () => {
    // faceExposureMean, not exposureMean: a backlit portrait has a
    // healthy frame histogram and an unreadable face, and the axis has
    // to score the face.
    const dark = score({ features: { ...GOOD, faceExposureMean: 20 } as ValidatedPixelFeatures });
    const bright = score({ features: { ...GOOD, faceExposureMean: 245 } as ValidatedPixelFeatures });
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

    // The whole-frame figure must NOT move the axis any more. This is
    // the backlit case: frame says fine, face says silhouette.
    const backlit = score({
      features: { ...GOOD, exposureMean: 200, faceExposureMean: 30 } as ValidatedPixelFeatures,
    });
    expect(lighting(backlit)).toBeLessThan(lighting(middle));
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

describe('framingRaw saturation', () => {
  // The bug this replaced: clamp01(1 - (ratio + off)) returned exactly 0
  // for every photograph past a point, and 53 of 125 calibration images
  // landed there carrying human labels from 1 to 4.
  const off = (x: number): ValidatedPixelFeatures =>
    ({ ...GOOD, faceAreaRatio: 0.3, faceCenterOffsetX: x, faceCenterOffsetY: 0 }) as ValidatedPixelFeatures;

  it('keeps badly cropped and catastrophically cropped apart', () => {
    const bad = framingRaw(off(0.6), WEIGHTS_V1);
    const worse = framingRaw(off(1.2), WEIGHTS_V1);
    const awful = framingRaw(off(4), WEIGHTS_V1);
    expect(bad).toBeGreaterThan(worse);
    expect(worse).toBeGreaterThan(awful);
    expect(awful).toBeGreaterThan(0);
  });

  it('never saturates, however extreme the penalty', () => {
    const extreme = framingRaw(off(1000), WEIGHTS_V1);
    expect(extreme).toBeGreaterThan(0);
    expect(Number.isFinite(extreme)).toBe(true);
  });

  it('still returns exactly 1 for ideal framing and 0 for no face', () => {
    expect(framingRaw(off(0), WEIGHTS_V1)).toBe(1);
    expect(framingRaw({ ...GOOD, faceCount: 0 } as ValidatedPixelFeatures, WEIGHTS_V1)).toBe(0);
  });

  it('is monotone decreasing in the penalty across a wide sweep', () => {
    const values = [0, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4].map((x) => framingRaw(off(x), WEIGHTS_V1));
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('lightingRaw', () => {
  const face = (exposure: number, clip = 0): ValidatedPixelFeatures =>
    ({
      ...GOOD,
      faceExposureMean: exposure,
      faceClippedHighlights: clip,
      faceClippedShadows: 0,
    }) as ValidatedPixelFeatures;

  it('is two-sided: too dark and too bright both cost', () => {
    const { idealExposureMin, idealExposureMax } = WEIGHTS_V1.lighting;
    const middle = lightingRaw(face((idealExposureMin + idealExposureMax) / 2), WEIGHTS_V1);
    expect(middle).toBe(1);
    expect(lightingRaw(face(20), WEIGHTS_V1)).toBeLessThan(middle);
    expect(lightingRaw(face(250), WEIGHTS_V1)).toBeLessThan(middle);
  });

  it('reads the face, not the frame - the backlit case', () => {
    const backlit = { ...face(30), exposureMean: 200 } as ValidatedPixelFeatures;
    const evenlyLit = { ...face(130), exposureMean: 200 } as ValidatedPixelFeatures;
    expect(lightingRaw(backlit, WEIGHTS_V1)).toBeLessThan(lightingRaw(evenlyLit, WEIGHTS_V1));
  });

  it('charges for clipping on the face', () => {
    expect(lightingRaw(face(130, 0.2), WEIGHTS_V1)).toBeLessThan(lightingRaw(face(130, 0), WEIGHTS_V1));
  });

  it('never saturates and stays inside (0, 1]', () => {
    for (const exposure of [0, 1, 128, 254, 255]) {
      const value = lightingRaw(face(exposure, 1), WEIGHTS_V1);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('resolution from the shorter edge', () => {
  const at = (w: number, h: number): ValidatedPixelFeatures =>
    ({ ...GOOD, width: w, height: h }) as ValidatedPixelFeatures;

  it('follows LinkedIn published spec points', () => {
    expect(resolutionScore(at(400, 400), WEIGHTS_V1)).toBeCloseTo(3, 6);
    expect(resolutionScore(at(800, 800), WEIGHTS_V1)).toBeCloseTo(5, 6);
    expect(resolutionScore(at(200, 200), WEIGHTS_V1)).toBeCloseTo(1, 6);
  });

  it('awards 5 above the recommendation rather than capping lower', () => {
    // The fitted map could never reach 5; this is why it was replaced.
    expect(resolutionScore(at(4000, 3000), WEIGHTS_V1)).toBeCloseTo(5, 6);
    expect(resolutionScore(at(8000, 6000), WEIGHTS_V1)).toBeCloseTo(5, 6);
  });

  it('is limited by the short side, not by megapixels', () => {
    // 4000x400 is 1.6MP and useless for a square avatar crop.
    expect(resolutionScore(at(4000, 400), WEIGHTS_V1)).toBeCloseTo(3, 6);
    expect(resolutionScore(at(4000, 400), WEIGHTS_V1)).toBeLessThan(
      resolutionScore(at(900, 900), WEIGHTS_V1),
    );
  });
});
