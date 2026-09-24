import { describe, expect, it } from 'vitest';

import {
  axisDistribution,
  compositeHistogram,
  confusionMatrix,
  renderConfusion,
  renderDistribution,
  renderHistogram,
  renderVariance,
  varianceContribution,
} from './report.js';

/** Twenty ratings, so the small-sample flag stays out of the way. */
function repeat(spec: Readonly<Record<number, number>>): number[] {
  const out: number[] = [];
  for (const [level, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i += 1) out.push(Number(level));
  }
  return out;
}

describe('axisDistribution', () => {
  it('counts levels and shares against a hand-made tally', () => {
    // 4+4+4+4+4 = 20 ratings, evenly spread.
    const flat = axisDistribution('background', repeat({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4 }));
    if ('ok' in flat) throw new Error(flat.reason);
    expect(flat.n).toBe(20);
    expect(flat.levels.map((l) => l.count)).toEqual([4, 4, 4, 4, 4]);
    expect(flat.levels.map((l) => l.share)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(flat.flags).toEqual([]);
    expect(flat.collapsed).toBe(false);
  });

  it('flags a collapsed axis, which carries no information whatever weight it gets', () => {
    // 16 of 20 at level 4 is 80%.
    const collapsed = axisDistribution('attire', repeat({ 3: 2, 4: 16, 5: 2 }));
    if ('ok' in collapsed) throw new Error(collapsed.reason);
    expect(collapsed.collapsed).toBe(true);
    expect(collapsed.flags.some((f) => /level 4 holds 80.0%/.test(f))).toBe(true);
    // Levels 1 and 2 are at zero, which is its own kind of problem.
    // Levels 3 and 5 sit at 10% each, which is unremarkable.
    expect(collapsed.flags.filter((f) => /not using it/.test(f))).toHaveLength(2);
  });

  it('flags a level raters never reach for', () => {
    // One 5 out of 20 is exactly 5%, which is not under the threshold.
    const edge = axisDistribution('solo', repeat({ 1: 5, 2: 5, 3: 5, 4: 4, 5: 1 }));
    if ('ok' in edge) throw new Error(edge.reason);
    expect(edge.flags).toEqual([]);

    // Drop it to one in 21 and it goes under.
    const rare = axisDistribution('solo', repeat({ 1: 5, 2: 5, 3: 5, 4: 5, 5: 1 }));
    if ('ok' in rare) throw new Error(rare.reason);
    expect(rare.flags.some((f) => /level 5 holds 4\.8% \(1\)/.test(f))).toBe(true);
  });

  it('marks a thin sample provisional instead of drawing conclusions from it', () => {
    const thin = axisDistribution('expression', [3, 3, 4]);
    if ('ok' in thin) throw new Error(thin.reason);
    expect(thin.provisional).toBe(true);
    expect(thin.flags.some((f) => /only 3 ratings/.test(f))).toBe(true);
  });

  it('counts off-scale ratings separately rather than binning them', () => {
    const odd = axisDistribution('lighting', [1, 2, 3, 7, 0]);
    if ('ok' in odd) throw new Error(odd.reason);
    expect(odd.n).toBe(3);
    expect(odd.offScale).toBe(2);
    expect(odd.flags.some((f) => /2 rating\(s\) were not one of 1\/2\/3\/4\/5/.test(f))).toBe(true);
  });

  it('reports insufficient data rather than throwing on nothing', () => {
    const none = axisDistribution('framing', []);
    if (!('ok' in none)) throw new Error('expected insufficient');
    expect(none.reason).toMatch(/no ratings for framing/);

    const allOff = axisDistribution('framing', [9, 9]);
    if (!('ok' in allOff)) throw new Error('expected insufficient');
    expect(allOff.reason).toMatch(/off the/);
  });

  it('renders a bar per level with the flags underneath', () => {
    const d = axisDistribution('attire', repeat({ 3: 2, 4: 16, 5: 2 }));
    if ('ok' in d) throw new Error(d.reason);
    const text = renderDistribution(d);
    expect(text.split('\n')[0]).toBe('attire  (n=20)');
    expect(text).toMatch(/level 4 holds 80\.0%/);
  });
});

describe('compositeHistogram', () => {
  it('buckets by the rounded score the user is shown', () => {
    const h = compositeHistogram([6.4, 6.6, 7.0, 7.49, 7.5]);
    if ('ok' in h) throw new Error(h.reason);
    expect(h.bins.find((b) => b.bin === 6)?.count).toBe(1);
    expect(h.bins.find((b) => b.bin === 7)?.count).toBe(3);
    expect(h.bins.find((b) => b.bin === 8)?.count).toBe(1);
    expect(h.n).toBe(5);
  });

  it('reports mean and sample standard deviation', () => {
    // 2, 4, 6: mean 4, sample variance ((4+0+4)/2) = 4, sd 2.
    const h = compositeHistogram([2, 4, 6]);
    if ('ok' in h) throw new Error(h.reason);
    expect(h.mean).toBeCloseTo(4, 12);
    expect(h.sd).toBeCloseTo(2, 12);
  });

  it('counts scores outside 1-10 rather than clamping them into a bin', () => {
    const h = compositeHistogram([5, 11, -2]);
    if ('ok' in h) throw new Error(h.reason);
    expect(h.outOfRange).toBe(2);
    expect(h.n).toBe(1);
  });

  it('reports insufficient data on an empty or all-invalid set', () => {
    const none = compositeHistogram([]);
    if (!('ok' in none)) throw new Error('expected insufficient');
    expect(none.reason).toMatch(/no composite scores/);

    const nan = compositeHistogram([Number.NaN, Number.POSITIVE_INFINITY]);
    if (!('ok' in nan)) throw new Error('expected insufficient');
  });

  it('renders ten bins', () => {
    const h = compositeHistogram([7, 7, 8]);
    if ('ok' in h) throw new Error(h.reason);
    expect(renderHistogram(h).split('\n')).toHaveLength(11);
  });
});

describe('varianceContribution', () => {
  it('attributes shares that sum to exactly one', () => {
    const shares = varianceContribution(
      {
        sharpness: [1, 2, 3, 4, 5],
        lighting: [2, 2, 3, 3, 4],
        attire: [5, 1, 4, 2, 3],
      },
      { sharpness: 0.5, lighting: 0.3, attire: 0.2 },
    );
    if ('ok' in shares) throw new Error(shares.reason);
    const total = shares.reduce((s, x) => s + x.share, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('calls a constant axis dead weight however large its weight', () => {
    const shares = varianceContribution(
      { moves: [1, 2, 3, 4, 5], frozen: [3, 3, 3, 3, 3] },
      { moves: 0.1, frozen: 0.9 },
    );
    if ('ok' in shares) throw new Error(shares.reason);
    const frozen = shares.find((s) => s.axis === 'frozen');
    expect(frozen?.share).toBeCloseTo(0, 12);
    expect(frozen?.deadWeight).toBe(true);
    expect(frozen?.weight).toBe(0.9);
    expect(shares.find((s) => s.axis === 'moves')?.share).toBeCloseTo(1, 12);
  });

  it('hand-computed: two identical axes at equal weight split the variance', () => {
    const shares = varianceContribution(
      { a: [1, 2, 3], b: [1, 2, 3] },
      { a: 0.5, b: 0.5 },
    );
    if ('ok' in shares) throw new Error(shares.reason);
    expect(shares.map((s) => s.share)).toEqual([0.5, 0.5]);
    // sd of 1,2,3 is 1.
    expect(shares[0]?.sd).toBeCloseTo(1, 12);
  });

  it('gives a negative share to an axis that cancels the composite', () => {
    // b runs against a, so it removes variance rather than adding it.
    const shares = varianceContribution(
      { a: [1, 2, 3, 4], b: [4, 3, 2, 1] },
      { a: 1, b: 0.5 },
    );
    if ('ok' in shares) throw new Error(shares.reason);
    expect(shares.find((s) => s.axis === 'b')?.share).toBeLessThan(0);
  });

  it('reports insufficient data instead of dividing by a zero variance', () => {
    const constant = varianceContribution({ a: [3, 3, 3] }, { a: 1 });
    if (!('ok' in constant)) throw new Error('expected insufficient');
    expect(constant.reason).toMatch(/nothing to attribute/);

    const ragged = varianceContribution({ a: [1, 2], b: [1] }, { a: 1, b: 1 });
    if (!('ok' in ragged)) throw new Error('expected insufficient');
    expect(ragged.reason).toMatch(/different numbers of ratings/);

    const tiny = varianceContribution({ a: [1] }, { a: 1 });
    if (!('ok' in tiny)) throw new Error('expected insufficient');
    expect(tiny.reason).toMatch(/at least two/);

    const unweighted = varianceContribution({ a: [1, 2] }, {});
    if (!('ok' in unweighted)) throw new Error('expected insufficient');
    expect(unweighted.reason).toMatch(/no weight given/);
  });

  it('renders one line per axis with the dead-weight marker', () => {
    const shares = varianceContribution(
      { moves: [1, 2, 3, 4, 5], frozen: [3, 3, 3, 3, 3] },
      { moves: 0.1, frozen: 0.9 },
    );
    if ('ok' in shares) throw new Error(shares.reason);
    expect(renderVariance(shares)).toMatch(/frozen.*dead weight/);
  });
});

describe('confusionMatrix', () => {
  it('puts humans on the rows and the model on the columns', () => {
    const c = confusionMatrix('solo', [1, 1, 2, 5], [1, 2, 2, 1]);
    if ('ok' in c) throw new Error(c.reason);
    expect(c.n).toBe(4);
    // Human 1 -> model 1 once, model 2 once.
    expect(c.rows[0]).toEqual([1, 1, 0, 0, 0]);
    // Human 2 -> model 2 once.
    expect(c.rows[1]).toEqual([0, 1, 0, 0, 0]);
    // Human 5 -> model 1: the badly wrong corner.
    expect(c.rows[4]).toEqual([1, 0, 0, 0, 0]);
  });

  it('skips off-scale pairs and says how many', () => {
    const c = confusionMatrix('solo', [1, 9], [1, 1]);
    if ('ok' in c) throw new Error(c.reason);
    expect(c.n).toBe(1);
    expect(c.offScale).toBe(1);
    expect(renderConfusion(c)).toMatch(/1 pair\(s\) were off the scale/);
  });

  it('reports insufficient data on mismatched or empty input', () => {
    const ragged = confusionMatrix('solo', [1, 2], [1]);
    if (!('ok' in ragged)) throw new Error('expected insufficient');
    expect(ragged.reason).toMatch(/different lengths/);

    const empty = confusionMatrix('solo', [], []);
    if (!('ok' in empty)) throw new Error('expected insufficient');
    expect(empty.reason).toMatch(/no paired ratings/);
  });
});
