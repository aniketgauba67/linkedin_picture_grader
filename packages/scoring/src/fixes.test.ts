import { describe, expect, it } from 'vitest';
import type { PixelFeatures } from './pixel-axes.js';
import { AXES } from './axes.js';
import { MAX_FIXES, buildFixes } from './fixes.js';

const FEATURES: PixelFeatures = {
  width: 1600,
  height: 1600,
  sharpnessLaplacian: 300,
  sharpnessEyeRegion: 300,
  eyeRegionMeasured: true,
  jpegQualityEstimate: 90,
  exposureMean: 128,
  dynamicRange: 200,
  clippedHighlights: 0.001,
  clippedShadows: 0.001,
  faceAreaRatio: 0.12,
  faceCenterOffsetX: 0.02,
  faceCenterOffsetY: 0.02,
  faceCount: 1,
  extractorVersion: 'v5',
};

const axesAt = (value: number) => Object.fromEntries(AXES.map((a) => [a, value]));

describe('buildFixes', () => {
  it('returns nothing for a photograph with nothing to fix', () => {
    expect(buildFixes(axesAt(5), FEATURES, 'corporate')).toEqual([]);
  });

  it('produces at least one fix for every axis scored 2', () => {
    // Every axis must be able to say something actionable.
    for (const axis of AXES) {
      const fixes = buildFixes({ ...axesAt(5), [axis]: 2 }, FEATURES, 'corporate', 8);
      expect(fixes.map((f) => f.axis), `${axis} produced no fix`).toContain(axis);
      const fix = fixes.find((f) => f.axis === axis);
      expect(fix?.message.length, `${axis} message is empty`).toBeGreaterThan(20);
    }
  });

  it('names the action and quotes the measurement', () => {
    // "Framing is poor" is a diagnosis. This is advice.
    const [fix] = buildFixes({ ...axesAt(5), framing: 2 }, FEATURES, 'corporate');
    expect(fix?.message).toContain('12%');
    expect(fix?.message).toContain('25%-35%');
    expect(fix?.message).toMatch(/^Recrop/);
  });

  it('tells a subject who fills too much of the frame to step back', () => {
    const large = { ...FEATURES, faceAreaRatio: 0.7 };
    const [fix] = buildFixes({ ...axesAt(5), framing: 2 }, large, 'corporate');
    expect(fix?.message).toMatch(/Step back|crop wider/);
    expect(fix?.message).toContain('70%');
  });

  it('distinguishes blown highlights from crushed shadows', () => {
    const blown = { ...FEATURES, clippedHighlights: 0.3 };
    const crushed = { ...FEATURES, clippedShadows: 0.3 };
    expect(buildFixes({ ...axesAt(5), lighting: 2 }, blown, 'corporate')[0]?.message).toMatch(
      /Reduce the exposure/,
    );
    expect(buildFixes({ ...axesAt(5), lighting: 2 }, crushed, 'corporate')[0]?.message).toMatch(
      /Add light/,
    );
  });

  it('quotes the actual resolution', () => {
    const small = { ...FEATURES, width: 320, height: 240 };
    const [fix] = buildFixes({ ...axesAt(5), resolution: 2 }, small, 'corporate');
    expect(fix?.message).toContain('320x240');
  });

  it('blames compression rather than focus when artifacts are the cause', () => {
    const crunchy = { ...FEATURES, jpegQualityEstimate: 20 };
    const [fix] = buildFixes({ ...axesAt(5), sharpness: 2 }, crunchy, 'corporate');
    expect(fix?.message).toMatch(/Re-export at higher quality/);
  });

  it('caps the advice at three by default', () => {
    expect(buildFixes(axesAt(1), FEATURES, 'corporate')).toHaveLength(MAX_FIXES);
  });

  it('ranks by recoverable points, not by raw score', () => {
    // In `creative` attire is worth 0.02, so even a 1 there is the last
    // thing worth saying.
    const fixes = buildFixes({ ...axesAt(5), attire: 1, sharpness: 4 }, FEATURES, 'creative', 8);
    expect(fixes[0]?.axis).toBe('sharpness');
  });

  it('never mentions the person, only the photograph or an action', () => {
    // Word boundaries matter: without them "old" matches "hold the
    // camera steadier", which is advice about the photographer's hands.
    const banned = /\b(attractive|pretty|handsome|competent|employable|young|old)\b|your face looks/i;
    for (const fix of buildFixes(axesAt(1), FEATURES, 'corporate', 8)) {
      expect(fix.message, fix.axis).not.toMatch(banned);
    }
  });

  it('skips axes that are absent on the degraded path', () => {
    const computedOnly = { sharpness: 2, lighting: 2, resolution: 2, framing: 2 };
    const fixes = buildFixes(computedOnly, FEATURES, 'corporate', 8);
    expect(fixes.every((f) => ['sharpness', 'lighting', 'resolution', 'framing'].includes(f.axis))).toBe(true);
  });
});
