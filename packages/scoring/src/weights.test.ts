import { describe, expect, it } from 'vitest';
import { AXES } from './axes.js';
import { CONTEXTS, CONTEXT_WEIGHTS, isContext, weightSum, weightsFor } from './weights.js';

describe('context weights', () => {
  it.each(CONTEXTS)('%s weights sum to 1', (context) => {
    expect(weightSum(CONTEXT_WEIGHTS[context])).toBeCloseTo(1, 10);
  });

  it.each(CONTEXTS)('%s covers every axis with a non-negative weight', (context) => {
    const weights = weightsFor(context);
    expect(Object.keys(weights).sort()).toEqual([...AXES].sort());
    for (const axis of AXES) {
      expect(weights[axis]).toBeGreaterThanOrEqual(0);
    }
  });

  it('weights attire lower for startup and creative than for corporate', () => {
    expect(CONTEXT_WEIGHTS.startup.attire).toBeLessThan(CONTEXT_WEIGHTS.corporate.attire);
    expect(CONTEXT_WEIGHTS.creative.attire).toBeLessThan(CONTEXT_WEIGHTS.corporate.attire);
  });

  it('recognises only real contexts', () => {
    expect(isContext('startup')).toBe(true);
    expect(isContext('banking')).toBe(false);
  });
});
