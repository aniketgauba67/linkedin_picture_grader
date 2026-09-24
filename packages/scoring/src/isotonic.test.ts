import { describe, expect, it } from 'vitest';
import type { Knot } from './isotonic.js';
import { KnotError, applyIsotonic, assertKnots } from './isotonic.js';

const RAMP: readonly Knot[] = [
  [0, 1],
  [10, 3],
  [20, 5],
];

describe('applyIsotonic', () => {
  it('returns the knot value at a knot', () => {
    expect(applyIsotonic(0, RAMP)).toBe(1);
    expect(applyIsotonic(10, RAMP)).toBe(3);
    expect(applyIsotonic(20, RAMP)).toBe(5);
  });

  it('interpolates linearly between knots', () => {
    expect(applyIsotonic(5, RAMP)).toBeCloseTo(2);
    expect(applyIsotonic(15, RAMP)).toBeCloseTo(4);
  });

  it('clamps below the first knot rather than extrapolating', () => {
    // Extrapolating off the end is how a very soft photo scores 0.4.
    expect(applyIsotonic(-1000, RAMP)).toBe(1);
  });

  it('clamps above the last knot rather than extrapolating', () => {
    expect(applyIsotonic(1e9, RAMP)).toBe(5);
  });

  it('handles an uneven knot spacing', () => {
    const uneven: readonly Knot[] = [
      [0, 1],
      [1, 4],
      [100, 5],
    ];
    expect(applyIsotonic(0.5, uneven)).toBeCloseTo(2.5);
    expect(applyIsotonic(50, uneven)).toBeCloseTo(4 + (49 / 99) * 1);
  });

  it('refuses a non-finite measurement instead of producing one', () => {
    // A NaN that survives here becomes a confident wrong score.
    expect(() => applyIsotonic(Number.NaN, RAMP)).toThrow(KnotError);
    expect(() => applyIsotonic(Number.POSITIVE_INFINITY, RAMP)).toThrow(KnotError);
  });
});

describe('assertKnots', () => {
  it('requires at least two knots', () => {
    expect(() => assertKnots([[0, 1]])).toThrow(/at least two/);
  });

  it('requires ascending measurements', () => {
    expect(() =>
      assertKnots([
        [10, 1],
        [5, 2],
      ]),
    ).toThrow(/ascend/);
  });

  it('rejects duplicate measurements, which would divide by zero', () => {
    expect(() =>
      assertKnots([
        [5, 1],
        [5, 3],
      ]),
    ).toThrow(/ascend/);
  });

  it('rejects a non-finite knot', () => {
    expect(() =>
      assertKnots([
        [0, 1],
        [Number.NaN, 5],
      ]),
    ).toThrow(/not finite/);
  });
});
