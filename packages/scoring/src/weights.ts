import type { AxisName } from './axes.js';
import { AXES } from './axes.js';

/**
 * Hand-set context weights. These are product decisions, not parameters:
 * they are never learned, never fitted, and never tuned against outcome
 * data. Changing one is a deliberate editorial choice about what a given
 * audience cares about, and belongs in a reviewed commit.
 *
 * 2026-09-24.2 halved lighting - 0.16/0.15/0.20 down to 0.08/0.07/0.10.
 * Not a change of taste. The lighting axis is a clipping-and-exposure
 * sanity check that could not be validated against labelled data
 * (docs/calibration-notes.md), and an axis nobody can validate should
 * not vote like one that has been. The freed weight went to framing,
 * which now has a real held-out number, and to the judged axes - NOT to
 * sharpness, which is equally unvalidated and would have been the same
 * mistake in a different column.
 */
export const CONTEXTS = ['startup', 'corporate', 'creative'] as const;
export type Context = (typeof CONTEXTS)[number];

export const DEFAULT_CONTEXT: Context = 'corporate';

/**
 * Stamped onto every ScoreResult. Bump it whenever a number in
 * CONTEXT_WEIGHTS changes, so two scores are only ever compared when the
 * same table produced them.
 */
export const WEIGHTS_VERSION = '2026-09-24.2';

export type AxisWeights = Readonly<Record<AxisName, number>>;

export const CONTEXT_WEIGHTS: Readonly<Record<Context, AxisWeights>> = {
  // Startup: approachability and a clean frame beat formality outright.
  startup: {
    sharpness: 0.16,
    lighting: 0.08,
    resolution: 0.08,
    framing: 0.18,
    background: 0.16,
    attire: 0.04,
    expression: 0.2,
    solo: 0.1,
  },
  // Corporate: formality and a controlled background carry real weight.
  corporate: {
    sharpness: 0.16,
    lighting: 0.07,
    resolution: 0.09,
    framing: 0.18,
    background: 0.16,
    attire: 0.16,
    expression: 0.1,
    solo: 0.08,
  },
  // Creative: technical execution matters most; attire is nearly free.
  creative: {
    sharpness: 0.2,
    lighting: 0.1,
    resolution: 0.1,
    framing: 0.19,
    background: 0.13,
    attire: 0.02,
    expression: 0.16,
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
