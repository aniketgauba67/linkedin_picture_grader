import { z } from 'zod';

/**
 * The eight axes. This enum is the single source of truth for the axis
 * vocabulary; nothing downstream may redeclare it.
 *
 * `@pps/scoring` carries a parallel `AXES` tuple because that package has
 * an empty `dependencies` object by construction - it runs in Deno and the
 * browser and cannot import zod. The two are held in lockstep by a parity
 * test in this package rather than by an import. Adding an axis means
 * editing both, and the test fails until you do.
 */
export const AxisName = z.enum([
  'sharpness',
  'lighting',
  'resolution',
  'framing',
  'background',
  'attire',
  'expression',
  'solo',
]);

/** Computed exactly from pixels. No model involved. */
export const ComputedAxisName = AxisName.extract([
  'sharpness',
  'lighting',
  'resolution',
  'framing',
]);

/** Judged by a vision model, later distilled into a local model. */
export const JudgedAxisName = AxisName.extract([
  'background',
  'attire',
  'expression',
  'solo',
]);

export const ScoreContext = z.enum(['startup', 'corporate', 'creative']);

/**
 * Every axis is an integer 1-5. 0 and 6 are the two mistakes worth naming:
 * a 0 usually means "no signal" leaked out of a detector as a score, and a
 * 6 usually means someone rescaled without clamping.
 */
export const AxisScore = z
  .number()
  .int()
  .min(1)
  .max(5)
  .describe('Integer 1-5. 1 is worst, 5 is best.');

export const AxisScores = z.object({
  sharpness: AxisScore,
  lighting: AxisScore,
  resolution: AxisScore,
  framing: AxisScore,
  background: AxisScore,
  attire: AxisScore,
  expression: AxisScore,
  solo: AxisScore,
});

/** The composite the user sees. One decimal place. */
export const CompositeScore = z
  .number()
  .finite()
  .min(1)
  .max(10)
  .describe('The 1-10 number shown to the user.');

export type AxisName = z.infer<typeof AxisName>;
export type ComputedAxisName = z.infer<typeof ComputedAxisName>;
export type JudgedAxisName = z.infer<typeof JudgedAxisName>;
export type ScoreContext = z.infer<typeof ScoreContext>;
export type AxisScore = z.infer<typeof AxisScore>;
export type AxisScores = z.infer<typeof AxisScores>;
export type CompositeScore = z.infer<typeof CompositeScore>;
