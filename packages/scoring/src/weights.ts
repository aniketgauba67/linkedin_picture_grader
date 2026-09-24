import type { AxisName } from './axes.js';
import { AXES } from './axes.js';

/**
 * Hand-set context weights. These are product decisions, not parameters:
 * they are never learned, never fitted, and never tuned against outcome
 * data. Changing one is a deliberate editorial choice about what a given
 * audience cares about, and belongs in a reviewed commit.
 */
export const CONTEXTS = ['startup', 'corporate', 'creative'] as const;
export type Context = (typeof CONTEXTS)[number];

export const DEFAULT_CONTEXT: Context = 'corporate';

/**
 * Stamped onto every ScoreResult. Bump it whenever a number in
 * CONTEXT_WEIGHTS changes, so two scores are only ever compared when the
 * same table produced them.
 */
export const WEIGHTS_VERSION = '2026-09-24.1';

export type AxisWeights = Readonly<Record<AxisName, number>>;

export const CONTEXT_WEIGHTS: Readonly<Record<Context, AxisWeights>> = {
  // Startup: approachability and a clean frame beat formality outright.
  startup: {
    sharpness: 0.16,
    lighting: 0.16,
    resolution: 0.08,
    framing: 0.14,
    background: 0.14,
    attire: 0.04,
    expression: 0.18,
    solo: 0.1,
  },
  // Corporate: formality and a controlled background carry real weight.
  corporate: {
    sharpness: 0.16,
    lighting: 0.15,
    resolution: 0.09,
    framing: 0.14,
    background: 0.14,
    attire: 0.14,
    expression: 0.1,
    solo: 0.08,
  },
  // Creative: technical execution matters most; attire is nearly free.
  creative: {
    sharpness: 0.2,
    lighting: 0.2,
    resolution: 0.1,
    framing: 0.14,
    background: 0.1,
    attire: 0.02,
    expression: 0.14,
    solo: 0.1,
  },
};

export function isContext(value: string): value is Context {
  return (CONTEXTS as readonly string[]).includes(value);
}

export function weightsFor(context: Context): AxisWeights {
  return CONTEXT_WEIGHTS[context];
}

/**
 * Guards the invariant that each weight set is a probability distribution
 * over the eight axes. Exported so the test suite - and anyone editing the
 * constants above - can assert it rather than eyeballing the numbers.
 */
export function weightSum(weights: AxisWeights): number {
  let total = 0;
  for (const axis of AXES) {
    total += weights[axis];
  }
  return total;
}
