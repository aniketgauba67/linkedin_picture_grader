import { describe, expect, it } from 'vitest';

import { nestedCV, phashDedup, splitByCluster } from './split.js';

describe('splitByCluster', () => {
  // Six photos of three people. The split must cut between people.
  const items = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
  const people = ['ana', 'ana', 'ben', 'ben', 'cal', 'cal'];

  it('never puts one person on both sides', () => {
    const split = splitByCluster(items, people, 0.67);
    if ('ok' in split) throw new Error(split.reason);
    const overlap = split.trainClusters.filter((c) => split.testClusters.includes(c));
    expect(overlap).toEqual([]);
    expect([...split.train, ...split.test].sort()).toEqual(items.slice().sort());
  });

  it('is deterministic - the same input gives the same split every time', () => {
    const first = splitByCluster(items, people, 0.67);
    const second = splitByCluster(items, people, 0.67);
    expect(first).toEqual(second);
  });

  it('gets close to the requested ratio', () => {
    const many = Array.from({ length: 100 }, (_, i) => `photo-${i}`);
    const clusters = many.map((_, i) => `person-${Math.floor(i / 2)}`);
    const split = splitByCluster(many, clusters, 0.8);
    if ('ok' in split) throw new Error(split.reason);
    expect(split.achievedRatio).toBeGreaterThan(0.75);
    expect(split.achievedRatio).toBeLessThan(0.85);
  });

  it('refuses to split a single cluster rather than returning an empty test set', () => {
    const split = splitByCluster(['x', 'y'], ['ana', 'ana'], 0.5);
    if (!('ok' in split)) throw new Error('expected insufficient');
    expect(split.reason).toMatch(/at least two clusters/);
  });

  it('says so when one cluster is too big to leave anything on the other side', () => {
    // 99 photos of one person, one of another, asking for 80% train:
    // the big cluster takes train, the small one takes test. That works.
    const items99 = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const lopsided = items99.map((_, i) => (i === 0 ? 'solo' : 'crowd'));
    const split = splitByCluster(items99, lopsided, 0.8);
    if ('ok' in split) throw new Error(split.reason);
    expect(split.testClusters).toEqual(['solo']);
    expect(split.test).toHaveLength(1);
  });

  it('rejects a ratio that is not strictly inside 0 and 1', () => {
    for (const ratio of [0, 1, -0.5, 1.5, Number.NaN]) {
      const split = splitByCluster(items, people, ratio);
      if (!('ok' in split)) throw new Error(`expected insufficient for ${ratio}`);
      expect(split.reason).toMatch(/strictly between/);
    }
  });

  it('rejects mismatched lengths instead of silently truncating', () => {
    const split = splitByCluster(items, people.slice(0, 3), 0.5);
    if (!('ok' in split)) throw new Error('expected insufficient');
    expect(split.reason).toMatch(/different lengths/);
  });
});

describe('nestedCV', () => {
  const clusters = Array.from({ length: 20 }, (_, i) => `person-${i % 10}`);

  it('keeps every outer test fold disjoint from its own training set', () => {
    const folds = nestedCV(clusters, 5, 3);
    if ('ok' in folds) throw new Error(folds.reason);
    expect(folds).toHaveLength(5);
    for (const fold of folds) {
      const overlap = fold.test.filter((i) => fold.train.includes(i));
      expect(overlap).toEqual([]);
      expect(fold.train.length + fold.test.length).toBe(clusters.length);
    }
  });

  it('covers every item exactly once across the outer test folds', () => {
    const folds = nestedCV(clusters, 5, 3);
    if ('ok' in folds) throw new Error(folds.reason);
    const seen = folds.flatMap((f) => [...f.test]).sort((a, b) => a - b);
    expect(seen).toEqual(clusters.map((_, i) => i));
  });

  it('cuts the inner folds out of the outer training set only', () => {
    const folds = nestedCV(clusters, 5, 3);
    if ('ok' in folds) throw new Error(folds.reason);
    for (const fold of folds) {
      expect(fold.inner).toHaveLength(3);
      for (const inner of fold.inner) {
        // Nothing from the outer test set may appear in either half of
        // an inner fold - that is the leak nested CV exists to stop.
        expect(inner.fit.filter((i) => fold.test.includes(i))).toEqual([]);
        expect(inner.validate.filter((i) => fold.test.includes(i))).toEqual([]);
        expect(inner.fit.filter((i) => inner.validate.includes(i))).toEqual([]);
        expect(inner.fit.length + inner.validate.length).toBe(fold.train.length);
      }
    }
  });

  it('never splits a cluster across an outer fold boundary', () => {
    const folds = nestedCV(clusters, 5, 3);
    if ('ok' in folds) throw new Error(folds.reason);
    for (const fold of folds) {
      const testPeople = new Set(fold.test.map((i) => clusters[i]));
      const trainPeople = new Set(fold.train.map((i) => clusters[i]));
      for (const person of testPeople) expect(trainPeople.has(person)).toBe(false);
    }
  });

  it('refuses when there are not enough clusters for the fold counts', () => {
    const tooFew = nestedCV(['a', 'b', 'c'], 5, 3);
    if (!('ok' in tooFew)) throw new Error('expected insufficient');
    expect(tooFew.reason).toMatch(/at least 5 clusters/);

    // Enough for the outer loop - each outer training set has four
    // clusters - but not enough to cut five inner folds out of four.
    const noInner = nestedCV(['a', 'b', 'c', 'd', 'e'], 5, 5);
    if (!('ok' in noInner)) throw new Error('expected insufficient');
    expect(noInner.reason).toMatch(/nested CV/);
  });

  it('rejects fold counts below two', () => {
    for (const bad of [1, 0, -2, 2.5]) {
      const outer = nestedCV(clusters, bad, 3);
      const inner = nestedCV(clusters, 5, bad);
      if (!('ok' in outer) || !('ok' in inner)) throw new Error('expected insufficient');
      expect(outer.reason).toMatch(/kOuter/);
      expect(inner.reason).toMatch(/kInner/);
    }
  });
});

describe('phashDedup', () => {
  it('groups hashes within the hamming threshold and keeps the first', () => {
    //  0x00 vs 0x01 is 1 bit apart; 0xff is 8 bits from 0x00.
    const result = phashDedup(['00', '01', 'ff'], 1);
    if ('ok' in result) throw new Error(result.reason);
    expect(result.keep).toEqual([0, 2]);
    expect(result.groups).toEqual([[0, 1]]);
    expect(result.dropped).toBe(1);
  });

  it('is single-linkage: a~b and b~c makes all three one photograph', () => {
    // 0x00 -> 0x01 -> 0x03: each step one bit, ends two bits apart.
    const result = phashDedup(['00', '01', '03'], 1);
    if ('ok' in result) throw new Error(result.reason);
    expect(result.groups).toEqual([[0, 1, 2]]);
    expect(result.keep).toEqual([0]);
  });

  it('keeps everything at threshold 0 unless the hashes are identical', () => {
    const distinct = phashDedup(['00', '01', 'ff'], 0);
    if ('ok' in distinct) throw new Error(distinct.reason);
    expect(distinct.dropped).toBe(0);

    const identical = phashDedup(['abcd', 'ABCD'], 0);
    if ('ok' in identical) throw new Error(identical.reason);
    // Case is not a difference in the hash.
    expect(identical.groups).toEqual([[0, 1]]);
  });

  it('counts bits across the whole hash, not just the first nibble', () => {
    // 0f0f vs 0000: eight bits set.
    const result = phashDedup(['0f0f', '0000'], 7);
    if ('ok' in result) throw new Error(result.reason);
    expect(result.dropped).toBe(0);

    const merged = phashDedup(['0f0f', '0000'], 8);
    if ('ok' in merged) throw new Error(merged.reason);
    expect(merged.dropped).toBe(1);
  });

  it('reports bad input rather than comparing nonsense', () => {
    const empty = phashDedup([], 4);
    const ragged = phashDedup(['abcd', 'ab'], 4);
    const nonHex = phashDedup(['abcd', 'zzzz'], 4);
    const negative = phashDedup(['abcd'], -1);
    for (const result of [empty, ragged, nonHex, negative]) {
      if (!('ok' in result)) throw new Error('expected insufficient');
    }
    if (!('ok' in ragged)) throw new Error('unreachable');
    expect(ragged.reason).toMatch(/different lengths/);
    if (!('ok' in nonHex)) throw new Error('unreachable');
    expect(nonHex.reason).toMatch(/not a hex hash/);
    if (!('ok' in negative)) throw new Error('unreachable');
    expect(negative.reason).toMatch(/non-negative whole number/);
  });
});
