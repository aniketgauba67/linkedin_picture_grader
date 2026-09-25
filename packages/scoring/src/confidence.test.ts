import { describe, expect, it } from 'vitest';
import type { ConfidenceInputs } from './confidence.js';
import { computeConfidence, subjectDisagreement } from './confidence.js';

const certain: ConfidenceInputs = {
  width: 1600,
  height: 1600,
  sharpnessLaplacian: 400,
  sharpnessEyeRegion: 480,
  eyeRegionMeasured: true,
  jpegQualityEstimate: 92,
  dynamicRange: 190,
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
  clippedHighlights: 0.003,
  clippedShadows: 0.003,
  faceAreaRatio: 0.16,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.03,
  faceCount: 1,
  exposureMean: 128,
  extractorVersion: 'v7',
  yaw: 2,
  pitch: -3,
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

  it('computes the off-axis penalty over measured pose only', () => {
    // pitch is null until a mesh model ships. A fabricated 0 would make
    // max(|yaw|, |pitch|) silently yaw-only while looking like it used
    // both; null says so, and upgrades cleanly when pitch arrives.
    expect(computeConfidence({ ...certain, yaw: 2, pitch: null })).toBe(1);
    expect(computeConfidence({ ...certain, yaw: 50, pitch: null })).toBeCloseTo(0.8);
    // Once pitch exists it contributes without any other change.
    expect(computeConfidence({ ...certain, yaw: 2, pitch: 50 })).toBeCloseTo(0.8);
  });

  it('is unchanged when every pose component is unmeasurable', () => {
    expect(computeConfidence({ ...certain, yaw: 0, pitch: null })).toBe(1);
  });

  it('is not a quality signal - a badly lit square-on face is still certain', () => {
    expect(
      computeConfidence({ ...certain, dynamicRange: 20, clippedShadows: 0.4 }),
    ).toBe(1);
  });

  it('lowers confidence when the detector and the model disagree on subjects', () => {
    // Measurements report, judgments judge, disagreement lowers
    // confidence. faceCount never feeds the solo score itself.
    const crowd = { ...certain, faceCount: 3 };
    const withoutJudgement = computeConfidence(crowd);
    const contradicted = computeConfidence(crowd, { soloScore: 5 });
    expect(contradicted).toBeCloseTo(withoutJudgement - 0.2);
  });

  it('does not penalise agreement in either direction', () => {
    // Several faces, model says not solo: they agree.
    expect(computeConfidence({ ...certain, faceCount: 3 }, { soloScore: 2 })).toBeCloseTo(
      computeConfidence({ ...certain, faceCount: 3 }),
    );
    // One face, model says solo: they agree.
    expect(computeConfidence(certain, { soloScore: 5 })).toBe(1);
  });

  it('flags the disagreement itself, independent of scoring', () => {
    expect(subjectDisagreement(3, 5)).toBe(true);
    expect(subjectDisagreement(1, 2)).toBe(true);
    expect(subjectDisagreement(1, 5)).toBe(false);
    expect(subjectDisagreement(3, 1)).toBe(false);
  });

  it('stays within 0-1 when everything goes wrong at once', () => {
    const value = computeConfidence({
      ...certain,
      faceCount: 0,
      yaw: 90,
      pitch: 60,
      jpegQualityEstimate: 5,
      faceCenterOffsetX: 0.9,
    }, { soloScore: 5 });
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('an absent solo score is absent, not a default', () => {
  it('charges nothing when the judge never ran', () => {
    // null and undefined behave identically; null is what a caller
    // writes when it looked and there was nothing there.
    const noFace = { ...certain, faceCount: 0 };
    expect(computeConfidence(noFace, { soloScore: null })).toBe(
      computeConfidence(noFace, {}),
    );
  });

  it('keeps a measured zero distinct from a missing solo judgment', () => {
    // faceCount 0 is an actual detector measurement and incurs its 0.45
    // penalty. A missing solo judgment adds no disagreement penalty.
    // soloScore 1 is a real 1-5 judgment here only to reproduce the old
    // placeholder's effect; it must never stand in for an absent judgment.
    const noFace = { ...certain, faceCount: 0 };
    expect(computeConfidence(certain, { soloScore: null })).toBe(1);
    expect(computeConfidence(noFace, { soloScore: null })).toBe(0.55);
    expect(computeConfidence(noFace, { soloScore: 1 })).toBe(0.35);
  });

  it('still charges for a real disagreement', () => {
    // Five faces and the model calling it solo is a genuine conflict.
    const crowd = { ...certain, faceCount: 5 };
    expect(computeConfidence(crowd, { soloScore: 5 })).toBeLessThan(
      computeConfidence(crowd, { soloScore: null }),
    );
  });

  it('treats a null solo score the way it treats a null pitch', () => {
    // Both are "unmeasurable", and neither contributes a fabricated
    // value. This is the invariant the placeholder violated.
    const withNullPitch = computeConfidence({ ...certain, pitch: null }, { soloScore: null });
    const withBoth = computeConfidence({ ...certain, pitch: 4 }, { soloScore: null });
    expect(withNullPitch).toBe(withBoth);
  });
});
