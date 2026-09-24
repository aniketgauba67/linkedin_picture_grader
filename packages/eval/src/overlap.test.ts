import { describe, expect, it } from 'vitest';

import {
  checkAnchors,
  comparePasses,
  MIN_MERGE_ALPHA,
  MIN_OVERLAP,
  renderOverlap,
  type LabelPass,
} from './overlap.js';

const pass = (name: string, entries: readonly (readonly [string, number])[]): LabelPass => ({
  name,
  labels: new Map(entries),
});

/** n images both passes rated, with `f` mapping one score to the other. */
function shared(n: number, f: (score: number, i: number) => number): [LabelPass, LabelPass] {
  const a: [string, number][] = [];
  const b: [string, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const score = (i % 5) + 1;
    a.push([`img${i}`, score]);
    b.push([`img${i}`, f(score, i)]);
  }
  return [pass('older', a), pass('newer', b)];
}

describe('comparePasses', () => {
  it('merges two passes that agree', () => {
    const [a, b] = shared(25, (s) => s);
    const report = comparePasses('framing', a, b);
    expect(report.verdict).toBe('merge');
    expect(report.overlap).toHaveLength(25);
    expect(report.alpha ?? 0).toBeGreaterThan(MIN_MERGE_ALPHA);
    expect(report.reasons).toEqual([]);
  });

  it('blocks when the passes share too few images to compare at all', () => {
    const [a, b] = shared(MIN_OVERLAP - 1, (s) => s);
    const report = comparePasses('framing', a, b);
    expect(report.verdict).toBe('block');
    expect(report.reasons.some((r) => new RegExp(`at least ${MIN_OVERLAP}`).test(r))).toBe(true);
  });

  it('blocks when the passes share NO images - the failure this exists for', () => {
    const a = pass('older', [['x1', 3], ['x2', 4]]);
    const b = pass('newer', [['y1', 3], ['y2', 4]]);
    const report = comparePasses('framing', a, b);
    expect(report.overlap).toEqual([]);
    expect(report.verdict).toBe('block');
    // Alpha cannot be computed, which is precisely why it must block
    // rather than warn: there is no number to look at and decide.
    expect(report.alpha).toBeNull();
  });

  it('calls a consistent offset a rescale, not a refusal', () => {
    // Same ordering, two points lower throughout. Recoverable.
    const [a, b] = shared(30, (s) => Math.max(1, s - 2));
    const report = comparePasses('framing', a, b);
    expect(report.rankAgreement).toBe(1);
    expect(report.offset).toBeLessThan(-0.5);
    expect(report.verdict).toBe('rescale');
    expect(report.reasons.some((r) => /shifted scale, not a different one/.test(r))).toBe(true);
  });

  it('blocks when the passes disagree about the ORDER', () => {
    // Reversed: nothing to rescale, the passes mean different things.
    const [a, b] = shared(30, (s) => 6 - s);
    const report = comparePasses('framing', a, b);
    expect(report.rankAgreement).toBe(0);
    expect(report.verdict).toBe('block');
    expect(report.reasons.some((r) => /not measuring the same thing/.test(r))).toBe(true);
  });

  it('reports the mean offset in the direction b - a', () => {
    const [a, b] = shared(25, (s) => s + 1);
    expect(comparePasses('framing', a, b).offset).toBeCloseTo(1, 10);
  });

  it('renders a verdict a human can act on', () => {
    const [a, b] = shared(30, (s) => 6 - s);
    const text = renderOverlap(comparePasses('framing', a, b));
    expect(text).toMatch(/verdict\s+BLOCK/);
    expect(text).toMatch(/krippendorff a/);
    expect(text).toMatch(/shared images\s+30/);
  });
});

describe('checkAnchors', () => {
  const anchors = new Map([['a1', 5], ['a2', 3], ['a3', 1]]);

  it('passes a labeller who matches every anchor', () => {
    const result = checkAnchors(anchors, pass('new', [['a1', 5], ['a2', 3], ['a3', 1], ['x', 4]]));
    // `matched` discriminates; `ok` does not - Insufficient carries
    // `ok: false` and AnchorCheck carries `ok: boolean`, so `'ok' in x`
    // is true for both and narrows nothing.
    if (!('matched' in result)) throw new Error('expected a check');
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(3);
  });

  it('names every anchor the labeller got wrong', () => {
    const result = checkAnchors(anchors, pass('new', [['a1', 3], ['a2', 3], ['a3', 1]]));
    if (!('mismatches' in result)) throw new Error('expected a check');
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ image: 'a1', expected: 5, got: 3 }]);
  });

  it('allows a tolerance, because adjacent scores are a judgement call', () => {
    const result = checkAnchors(anchors, pass('new', [['a1', 4], ['a2', 3], ['a3', 2]]), 1);
    if (!('matched' in result)) throw new Error('expected a check');
    expect(result.ok).toBe(true);
  });

  it('reports insufficient data rather than passing an unanchored labeller', () => {
    const none = checkAnchors(anchors, pass('new', [['x', 4]]));
    if (!('reason' in none)) throw new Error('expected insufficient');
    expect(none.reason).toMatch(/none of the anchor images/);

    const empty = checkAnchors(new Map(), pass('new', [['a1', 5]]));
    if (!('reason' in empty)) throw new Error('expected insufficient');
    expect(empty.reason).toMatch(/no anchor images/);
  });
});
