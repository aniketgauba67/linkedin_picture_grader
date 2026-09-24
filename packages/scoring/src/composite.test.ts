import { describe, expect, it } from 'vitest';
import type { AxisScores } from './axes.js';
import { AXES } from './axes.js';
import { axisBreakdown, buildFixes, meanToComposite, scorePhoto, weightedMean } from './composite.js';
import { CONTEXTS, WEIGHTS_VERSION, weightsFor } from './weights.js';
import { FIX_MESSAGES, MAX_FIXES } from './fixes.js';

function uniform(score: number): AxisScores {
  return Object.fromEntries(AXES.map((axis) => [axis, score])) as unknown as AxisScores;
}

describe('meanToComposite', () => {
  it('maps the 1-5 axis mean onto the 1-10 composite', () => {
    expect(meanToComposite(1)).toBeCloseTo(1);
    expect(meanToComposite(3)).toBeCloseTo(5.5);
    expect(meanToComposite(5)).toBeCloseTo(10);
  });
});

describe('weightedMean', () => {
  it('returns the axis value when every axis agrees', () => {
    expect(weightedMean(uniform(4), weightsFor('corporate'))).toBeCloseTo(4);
  });
});

describe('axisBreakdown', () => {
  it('returns an entry for every axis', () => {
    expect(axisBreakdown(uniform(3)).map((entry) => entry.axis)).toEqual([...AXES]);
  });

  it('reports no headroom on a perfect photo', () => {
    expect(axisBreakdown(uniform(5)).every((entry) => entry.headroom === 0)).toBe(true);
  });
});

describe('buildFixes', () => {
  it('returns nothing for a perfect photo', () => {
    expect(buildFixes(axisBreakdown(uniform(5)))).toEqual([]);
  });

  it('caps the advice at three by default', () => {
    expect(buildFixes(axisBreakdown(uniform(1)))).toHaveLength(MAX_FIXES);
  });

  it('honours an explicit cap', () => {
    expect(buildFixes(axisBreakdown(uniform(2)), 8)).toHaveLength(8);
    expect(buildFixes(axisBreakdown(uniform(2)), 0)).toHaveLength(0);
  });

  it('grades severity by recoverable points, not by raw score', () => {
    // In `creative` attire is worth 0.02, so even a 1 there is a low fix.
    const fixes = buildFixes(axisBreakdown({ ...uniform(5), attire: 1 }, 'creative'), 8);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.axis).toBe('attire');
    expect(fixes[0]?.severity).toBe('low');
  });

  it('uses the shared copy, which never mentions the person', () => {
    const banned = /attractive|pretty|handsome|competent|employable|young|old/i;
    for (const fix of buildFixes(axisBreakdown(uniform(1)), 8)) {
      expect(fix.message).toBe(FIX_MESSAGES[fix.axis]);
      expect(fix.message).not.toMatch(banned);
    }
  });
});

describe('scorePhoto', () => {
  it.each(CONTEXTS)('bounds the composite to 1-10 in %s', (context) => {
    expect(scorePhoto(uniform(1), context).score).toBe(1);
    expect(scorePhoto(uniform(5), context).score).toBe(10);
  });

  it('returns every axis it was given, normalized', () => {
    expect(Object.keys(scorePhoto(uniform(3)).axes).sort()).toEqual([...AXES].sort());
  });

  it('stamps the weights version that produced the score', () => {
    expect(scorePhoto(uniform(3)).weightsVersion).toBe(WEIGHTS_VERSION);
  });

  it('defaults confidence to 1 and carries a supplied one through', () => {
    expect(scorePhoto(uniform(3)).confidence).toBe(1);
    expect(scorePhoto(uniform(3), 'startup', { confidence: 0.55 }).confidence).toBe(0.55);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a confidence of %p rather than passing it on',
    (bad) => {
      expect(() => scorePhoto(uniform(3), 'startup', { confidence: bad })).toThrow(RangeError);
    },
  );

  it('ranks the first fix by recoverable points', () => {
    // solo is a 1 but barely weighted in `creative`; sharpness is a 2 and
    // the heaviest axis there, so it is the fix worth making first.
    const result = scorePhoto({ ...uniform(5), sharpness: 2, solo: 1 }, 'creative');
    expect(result.fixes[0]?.axis).toBe('sharpness');
    expect(result.fixes.map((fix) => fix.axis)).toContain('solo');
  });

  it('is context sensitive: formal attire matters more to corporate', () => {
    const scores: AxisScores = { ...uniform(5), attire: 1 };
    expect(scorePhoto(scores, 'corporate').score).toBeLessThan(
      scorePhoto(scores, 'creative').score,
    );
  });

  it('clamps out-of-range input rather than producing an out-of-range composite', () => {
    const result = scorePhoto({ ...uniform(5), lighting: 40 });
    expect(result.score).toBe(10);
    expect(result.axes.lighting).toBe(5);
  });

  it('is pure - the same input always gives the same result', () => {
    expect(scorePhoto(uniform(3), 'startup')).toEqual(scorePhoto(uniform(3), 'startup'));
  });
});
