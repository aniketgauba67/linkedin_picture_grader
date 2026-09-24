import { describe, expect, it } from 'vitest';

import {
  agreement,
  alphaVerdict,
  bias,
  exactAgreement,
  kendallTau,
  krippendorffAlpha,
  mae,
  pairwiseAccuracy,
  spearman,
  withinOne,
  type Metric,
  type Rating,
} from './metrics.js';

/** Every metric returns a union; a test that reads .value must narrow. */
function value(result: Metric): number {
  if (!result.ok) throw new Error(`expected a measurement, got: ${result.reason}`);
  return result.value;
}

function reason(result: Metric): string {
  if (result.ok) throw new Error(`expected insufficient data, got ${result.value}`);
  return result.reason;
}

/**
 * Krippendorff's own worked example, from "Computing Krippendorff's
 * Alpha-Reliability" (2011). Three observers, fifteen units, missing
 * ratings everywhere, including two units nobody rated.
 *
 *   Observer A: .  .  .  .  .  3  4  1  2  1  1  3  3  .  3
 *   Observer B: 1  .  2  1  3  3  4  3  .  .  .  .  .  .  .
 *   Observer C: .  .  2  1  3  4  4  .  2  1  1  3  3  .  4
 *
 * Transcription check: the published answers for this matrix are
 * nominal 0.691 and interval 0.811, and the reference implementation
 * returns 0.691358 and 0.810845 for the matrix as written below - so
 * the fixture is the example, not something near it. This function only
 * does ordinal, for which that same reference returns 0.806721.
 *
 * Cross-check: ordinal alpha was compared against the `krippendorff`
 * Python package over this example plus forty randomly generated rating
 * matrices (2-5 raters, 4-23 units, scales of 2-5, up to 40% missing).
 * All 41 agreed to within 4.4e-16.
 *
 * The expectation is the reference value, not ours. If this fails, the
 * implementation is wrong - do not edit the expectation.
 */
const KRIPPENDORFF_2011: readonly (readonly Rating[])[] = [
  [null, 1, null],
  [null, null, null],
  [null, 2, 2],
  [null, 1, 1],
  [null, 3, 3],
  [3, 3, 4],
  [4, 4, 4],
  [1, 3, null],
  [2, null, 2],
  [1, null, 1],
  [1, null, 1],
  [3, null, 3],
  [3, null, 3],
  [null, null, null],
  [3, null, 4],
];

describe('krippendorffAlpha', () => {
  it("reproduces Krippendorff's worked example at 0.806721", () => {
    expect(value(krippendorffAlpha(KRIPPENDORFF_2011, 'ordinal'))).toBeCloseTo(0.806721, 6);
  });

  it('matches a coincidence matrix computed by hand', () => {
    // Two raters, three units: [1,1], [2,2], [1,3].
    //
    // Coincidence matrix, weight 1/(m-1) = 1 throughout:
    //   o(1,1) = 2   o(2,2) = 2   o(1,3) = o(3,1) = 1
    // Marginals: n1 = 3, n2 = 2, n3 = 1, n = 6.
    //
    // Ordinal delta squared, (sum of the spanned marginals less half
    // of each endpoint), squared:
    //   d(1,2) = (3+2 - 2.5)^2  = 6.25
    //   d(1,3) = (3+2+1 - 2)^2  = 16
    //   d(2,3) = (2+1 - 1.5)^2  = 2.25
    //
    // Do numerator = 1*16 + 1*16                       = 32
    // De numerator = 2*(3*2*6.25 + 3*1*16 + 2*1*2.25)  = 180
    // alpha = 1 - (n-1)*(32/180) = 1 - 160/180 = 1/9.
    expect(
      value(
        krippendorffAlpha([
          [1, 1],
          [2, 2],
          [1, 3],
        ]),
      ),
    ).toBeCloseTo(1 / 9, 12);
  });

  it('gives 1 when every rater agrees on every unit', () => {
    expect(
      value(
        krippendorffAlpha([
          [1, 1, 1],
          [4, 4, 4],
          [2, 2, 2],
        ]),
      ),
    ).toBeCloseTo(1, 10);
  });

  it('goes negative when raters disagree worse than chance', () => {
    // Systematic inversion: each unit's raters sit at opposite ends.
    expect(
      value(
        krippendorffAlpha([
          [1, 5],
          [5, 1],
          [1, 5],
          [5, 1],
        ]),
      ),
    ).toBeLessThan(0);
  });

  it('drops units rated only once rather than scoring them as agreement', () => {
    const withSingletons = krippendorffAlpha([
      [1, 1, null],
      [4, 4, 4],
      [2, 2, 2],
      [5, null, null],
      [3, null, null],
    ]);
    const without = krippendorffAlpha([
      [1, 1, null],
      [4, 4, 4],
      [2, 2, 2],
    ]);
    expect(value(withSingletons)).toBeCloseTo(value(without), 10);
  });

  it('reports insufficient data rather than throwing on an empty set', () => {
    expect(reason(krippendorffAlpha([]))).toMatch(/two or more ratings/);
  });

  it('refuses to claim perfect reliability from a constant dataset', () => {
    // Do is zero here, but so is De: there was nothing to disagree
    // about, so 1.0 would be a claim the data cannot support.
    expect(reason(krippendorffAlpha([[3, 3, 3], [3, 3]]))).toMatch(/undefined/);
  });

  it('ignores NaN and Infinity in the ratings', () => {
    const clean = krippendorffAlpha([
      [1, 1, null],
      [4, 4, 4],
      [2, 2, 2],
    ]);
    const dirty = krippendorffAlpha([
      [1, 1, Number.NaN],
      [4, 4, 4],
      [2, 2, 2],
      [Number.POSITIVE_INFINITY, Number.NaN],
    ]);
    expect(value(dirty)).toBeCloseTo(value(clean), 10);
  });
});

describe('alphaVerdict', () => {
  it('gates on the conventional thresholds', () => {
    expect(alphaVerdict(0.815)).toBe('ship');
    expect(alphaVerdict(0.8)).toBe('ship');
    expect(alphaVerdict(0.72)).toBe('rewrite-anchors');
    expect(alphaVerdict(0.65)).toBe('rewrite-anchors');
    expect(alphaVerdict(0.4)).toBe('do-not-train');
  });
});

describe('spearman', () => {
  it('is 1 for an identical ordering and -1 for a reversed one', () => {
    expect(value(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]))).toBeCloseTo(1, 10);
    expect(value(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]))).toBeCloseTo(-1, 10);
  });

  it('averages tied ranks: sqrt(0.9) on the hand-computed fixture', () => {
    // a ranks to [1, 2.5, 2.5, 4], b to [1, 2, 3, 4].
    // cov 4.5, varA 4.5, varB 5 -> 4.5/sqrt(22.5) = sqrt(0.9).
    expect(value(spearman([1, 2, 2, 3], [1, 2, 3, 4]))).toBeCloseTo(Math.sqrt(0.9), 12);
  });

  it('reports insufficient data for a flat series or a length mismatch', () => {
    expect(reason(spearman([3, 3, 3], [1, 2, 3]))).toMatch(/no variance/);
    expect(reason(spearman([1, 2], [1, 2, 3]))).toMatch(/different lengths/);
    expect(reason(spearman([1], [1]))).toMatch(/two paired/);
  });
});

describe('kendallTau', () => {
  it('scores one swapped pair out of ten as 0.8', () => {
    expect(value(kendallTau([1, 2, 3, 4, 5], [1, 2, 3, 5, 4]))).toBeCloseTo(0.8, 12);
  });

  it('uses tau-b, so ties shrink the denominator rather than counting as errors', () => {
    // C=4, D=0, one pair tied in a, one tied in b.
    // sqrt((4+1)*(4+1)) = 5, so 4/5.
    expect(value(kendallTau([1, 1, 2, 3], [1, 2, 2, 3]))).toBeCloseTo(0.8, 12);
  });

  it('reports insufficient data when nothing is untied', () => {
    expect(reason(kendallTau([2, 2, 2], [4, 4, 4]))).toMatch(/untied/);
  });
});

describe('agreement', () => {
  const model = [3, 4, 5, 2];
  const human = [3, 5, 3, 2];

  it('splits exact, within-one, mae and signed bias', () => {
    const result = agreement(model, human);
    if ('ok' in result) throw new Error(result.reason);
    expect(result.exact).toBeCloseTo(0.5, 12);
    expect(result.withinOne).toBeCloseTo(0.75, 12);
    expect(result.mae).toBeCloseTo(0.75, 12);
    expect(result.bias).toBeCloseTo(0.25, 12);
    expect(result.n).toBe(4);
  });

  it('exposes each component as its own metric', () => {
    expect(value(exactAgreement(model, human))).toBeCloseTo(0.5, 12);
    expect(value(withinOne(model, human))).toBeCloseTo(0.75, 12);
    expect(value(mae(model, human))).toBeCloseTo(0.75, 12);
    expect(value(bias(model, human))).toBeCloseTo(0.25, 12);
  });

  it('separates a uniform offset from noise', () => {
    // Uniformly one point generous: mae 1, bias +1. Fixable by moving
    // an intercept, which is why the two are reported apart.
    const offset = agreement([2, 3, 4], [1, 2, 3]);
    if ('ok' in offset) throw new Error(offset.reason);
    expect(offset.mae).toBeCloseTo(1, 12);
    expect(offset.bias).toBeCloseTo(1, 12);

    // Same mae, no bias: errors cancel, and nothing about the scale
    // is wrong.
    const noise = agreement([2, 1, 4], [1, 2, 3]);
    if ('ok' in noise) throw new Error(noise.reason);
    expect(noise.mae).toBeCloseTo(1, 12);
    expect(noise.bias).toBeCloseTo(1 / 3, 12);
  });

  it('reports insufficient data on empty input rather than dividing by zero', () => {
    const empty = agreement([], []);
    if (!('ok' in empty)) throw new Error('expected insufficient');
    expect(empty.reason).toMatch(/no paired ratings/);
  });
});

describe('pairwiseAccuracy', () => {
  it('is 1 for a perfect ordering and 0 for a reversed one', () => {
    expect(value(pairwiseAccuracy([1, 2, 3], [4, 7, 9]))).toBeCloseTo(1, 12);
    expect(value(pairwiseAccuracy([1, 2, 3], [9, 7, 4]))).toBeCloseTo(0, 12);
  });

  it('gives half credit for a tie on a pair the reference ordered', () => {
    // (0,1) tied by the model -> 0.5, the other two correct -> 2.5/3.
    expect(value(pairwiseAccuracy([1, 1, 3], [1, 2, 3]))).toBeCloseTo(2.5 / 3, 12);
  });

  it('ignores a uniform offset, which is the whole point of it', () => {
    const truth = [1, 3, 5, 2, 4];
    const generous = truth.map((t) => t + 1.5);
    expect(value(pairwiseAccuracy(generous, truth))).toBeCloseTo(1, 12);

    // MSE would score that 2.25 per item while the ranking is perfect.
    const shuffled = [3, 1, 2, 5, 4];
    expect(value(pairwiseAccuracy(shuffled, truth))).toBeLessThan(1);
  });

  it('reports insufficient data when the reference ranks everything equally', () => {
    expect(reason(pairwiseAccuracy([1, 2, 3], [4, 4, 4]))).toMatch(/every item equally/);
    expect(reason(pairwiseAccuracy([1], [1]))).toMatch(/two items/);
  });
});
