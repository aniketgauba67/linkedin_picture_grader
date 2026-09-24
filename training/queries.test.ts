import { describe, expect, it } from 'vitest';

import { planQuota, QUERIES, VARIANT_SHARES, type QueryVariant } from './queries.js';

function byVariant(rows: readonly { variant: QueryVariant; target: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.variant] = (out[row.variant] ?? 0) + row.target;
  return out;
}

describe('QUERIES', () => {
  it('covers the four variants the corpus needs', () => {
    expect(new Set(QUERIES.map((q) => q.variant))).toEqual(new Set(['good', 'mediocre', 'bad', 'edge']));
  });

  it('has no duplicate query strings', () => {
    expect(new Set(QUERIES.map((q) => q.query)).size).toBe(QUERIES.length);
  });

  it('shares sum to one', () => {
    const total = Object.values(VARIANT_SHARES).reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 12);
  });
});

describe('planQuota', () => {
  it('sums to exactly the total asked for', () => {
    for (const total of [0, 1, 7, 40, 150, 700, 999]) {
      const rows = planQuota(total);
      expect(rows.reduce((s, r) => s + r.target, 0)).toBe(total);
    }
  });

  it('splits 150 as 45/45/45/15', () => {
    expect(byVariant(planQuota(150))).toEqual({ good: 45, mediocre: 45, bad: 45, edge: 15 });
  });

  it('spreads a variant budget evenly across its queries', () => {
    const rows = planQuota(150);
    // 45 across four good queries: 12, 11, 11, 11.
    const good = rows.filter((r) => r.variant === 'good').map((r) => r.target);
    expect(good).toEqual([12, 11, 11, 11]);
    // 45 across six bad queries: 8, 8, 8, 7, 7, 7.
    const bad = rows.filter((r) => r.variant === 'bad').map((r) => r.target);
    expect(bad).toEqual([8, 8, 8, 7, 7, 7]);
    // 15 across three edge queries divides cleanly.
    expect(rows.filter((r) => r.variant === 'edge').map((r) => r.target)).toEqual([5, 5, 5]);
  });

  it('keeps the bad variant at a full 30% - the 1-3 range depends on it', () => {
    for (const total of [40, 150, 700]) {
      const shares = byVariant(planQuota(total));
      expect((shares['bad'] ?? 0) / total).toBeCloseTo(0.3, 2);
    }
  });

  it('is deterministic', () => {
    expect(planQuota(150)).toEqual(planQuota(150));
  });

  it('rejects a total that is not a whole number', () => {
    expect(() => planQuota(-1)).toThrow(RangeError);
    expect(() => planQuota(1.5)).toThrow(RangeError);
  });

  it('works on a custom query list', () => {
    const rows = planQuota(10, [
      { query: 'a', variant: 'good' },
      { query: 'b', variant: 'bad' },
    ]);
    // good 30% and bad 30% of ten, with the rounding remainder handed
    // out by largest fraction; nothing is lost.
    expect(rows.reduce((s, r) => s + r.target, 0)).toBe(10);
  });
});
