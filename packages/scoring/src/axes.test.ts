import { describe, expect, it } from 'vitest';
import { AXES, AXIS_DESCRIPTIONS, COMPUTED_AXES, JUDGED_AXES, isAxis, normalizeAxisScore } from './axes.js';

describe('axes', () => {
  it('has exactly eight axes, four computed and four judged', () => {
    expect(COMPUTED_AXES).toHaveLength(4);
    expect(JUDGED_AXES).toHaveLength(4);
    expect(AXES).toHaveLength(8);
    expect(new Set(AXES).size).toBe(8);
  });

  it('describes every axis', () => {
    for (const axis of AXES) {
      expect(AXIS_DESCRIPTIONS[axis].length).toBeGreaterThan(0);
    }
  });

  it('recognises only real axes', () => {
    expect(isAxis('sharpness')).toBe(true);
    expect(isAxis('attractiveness')).toBe(false);
  });

  it('clamps and rounds scores into 1-5', () => {
    expect(normalizeAxisScore(3)).toBe(3);
    expect(normalizeAxisScore(3.4)).toBe(3);
    expect(normalizeAxisScore(3.5)).toBe(4);
    expect(normalizeAxisScore(-2)).toBe(1);
    expect(normalizeAxisScore(99)).toBe(5);
  });

  it('rejects non-finite scores instead of silently clamping them', () => {
    expect(() => normalizeAxisScore(Number.NaN)).toThrow(RangeError);
    expect(() => normalizeAxisScore(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
