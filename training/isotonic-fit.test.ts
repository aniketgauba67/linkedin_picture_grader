import { describe, expect, it } from 'vitest';

import { applyKnots, pava, toKnots, type Observation } from './isotonic-fit.js';

const obs = (pairs: readonly (readonly [number, number])[]): Observation[] =>
  pairs.map(([x, y]) => ({ x, y }));

describe('pava', () => {
  it('leaves an already-monotone series alone', () => {
    const fitted = pava(obs([[1, 1], [2, 2], [3, 3], [4, 4]]));
    expect(fitted.map((f) => f.y)).toEqual([1, 2, 3, 4]);
    expect(fitted.map((f) => f.weight)).toEqual([1, 1, 1, 1]);
  });

  it('pools a violation into its mean, by hand', () => {
    // 3 then 1 violates monotonicity; pooled they average to 2.
    const fitted = pava(obs([[1, 1], [2, 3], [3, 1], [4, 4]]));
    expect(fitted.map((f) => f.y)).toEqual([1, 2, 4]);
    // The pooled block keeps the larger x: the value applies from 3 up.
    expect(fitted.map((f) => f.x)).toEqual([1, 3, 4]);
    expect(fitted[1]?.weight).toBe(2);
  });

  it('cascades a pool backwards when merging creates a new violation', () => {
    // 1,5,4,3 -> pooling 5,4 gives 4.5, still above 3; all three pool
    // to 4, which is above 1, so the result is [1, 4].
    const fitted = pava(obs([[1, 1], [2, 5], [3, 4], [4, 3]]));
    expect(fitted.map((f) => f.y)).toEqual([1, 4]);
    expect(fitted[1]?.weight).toBe(3);
  });

  it('averages ties in x before fitting, so labeller disagreement is not a violation', () => {
    const fitted = pava(obs([[1, 2], [1, 4], [2, 3]]));
    // The two labels at x=1 average to 3, which does not violate x=2.
    expect(fitted.map((f) => f.y)).toEqual([3, 3]);
    expect(fitted[0]?.weight).toBe(2);
  });

  it('is always non-decreasing, on a deliberately hostile series', () => {
    const fitted = pava(obs([[1, 5], [2, 1], [3, 5], [4, 1], [5, 5], [6, 1]]));
    const ys = fitted.map((point) => point.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('returns nothing for no observations', () => {
    expect(pava([])).toEqual([]);
  });
});

describe('toKnots', () => {
  it('puts each level at the smallest measurement that reaches it', () => {
    const fit = toKnots(pava(obs([[10, 1], [20, 2], [30, 3], [40, 4], [50, 5]])));
    expect(fit.knots).toEqual([[10, 1], [20, 2], [30, 3], [40, 4], [50, 5]]);
    expect(fit.unreachable).toEqual([]);
    expect(fit.topScore).toBe(5);
    expect(fit.topX).toBe(50);
  });

  it('reports a level the data never reaches instead of inventing a knot', () => {
    // Nothing scored above 3. A fabricated top knot at 5 would hand
    // every large measurement a score nobody ever assigned.
    const fit = toKnots(pava(obs([[10, 1], [20, 2], [30, 3]])));
    expect(fit.unreachable).toEqual([4, 5]);
    expect(fit.topScore).toBe(3);
    expect(fit.knots.map((k) => k[1])).toEqual([1, 2, 3]);
  });

  it('keeps the higher score when two levels are reached at one measurement', () => {
    const fit = toKnots(pava(obs([[10, 1], [20, 4]])));
    // Levels 2, 3 and 4 are all first satisfied at x=20.
    expect(fit.knots).toEqual([[10, 1], [20, 4]]);
  });

  it('is strictly increasing in x, which applyIsotonic requires', () => {
    const fit = toKnots(pava(obs([[5, 3], [5, 3], [9, 5], [9, 5]])));
    const xs = fit.knots.map(([x]) => x);
    expect(new Set(xs).size).toBe(xs.length);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('collapses levels below the smallest measurement onto it, keeping the true score', () => {
    // Levels 1, 2 and 3 are all first satisfied at x=100, so one knot
    // carries the score the data actually supports there.
    const fit = toKnots(pava(obs([[100, 3], [200, 5]])));
    expect(fit.knots[0]).toEqual([100, 3]);
    expect(fit.knots.at(-1)).toEqual([200, 5]);
  });

  it('bottom-knot clamping is the mirror of the top-knot problem', () => {
    // Nothing below 100 was ever labelled, so applyKnots hands a
    // measurement of zero the same 3 that 100 earned. Worth reporting
    // for any axis whose smallest labelled example scored well.
    const fit = toKnots(pava(obs([[100, 3], [200, 5]])));
    expect(applyKnots(0, fit.knots)).toBe(3);
    expect(fit.knots[0]?.[1]).toBeGreaterThan(1);
  });
});

describe('applyKnots', () => {
  const knots = [[0, 1], [10, 2], [20, 4]] as const;

  it('interpolates linearly between knots', () => {
    expect(applyKnots(5, knots)).toBeCloseTo(1.5, 12);
    expect(applyKnots(15, knots)).toBeCloseTo(3, 12);
  });

  it('clamps below the first knot and above the last', () => {
    expect(applyKnots(-100, knots)).toBe(1);
    expect(applyKnots(1e9, knots)).toBe(4);
  });

  it('clamping above the top knot is why an unreachable level matters', () => {
    // A map that tops out at 2 gives 2 to everything above it, forever.
    const capped = [[0, 1], [10, 2]] as const;
    expect(applyKnots(1_000_000, capped)).toBe(2);
  });
});
