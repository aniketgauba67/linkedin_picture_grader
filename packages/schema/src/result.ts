import { z } from 'zod';
import { AxisName, AxisScores, CompositeScore, ScoreContext } from './axes.js';

export const FixSeverity = z.enum(['high', 'medium', 'low']);

/**
 * One actionable fix. `message` is an instruction for the next attempt at
 * the photograph. Severity is how much composite the fix would recover,
 * bucketed - not how bad the axis score is, because a heavily weighted
 * near-miss is worth more than a lightly weighted disaster.
 */
export const Fix = z.object({
  axis: AxisName,
  severity: FixSeverity,
  message: z.string().min(1).max(280),
});

export const ScoreResult = z
  .object({
    score: CompositeScore,
    /**
     * Partial because the degraded path scores only the four computed
     * axes. The refinement below requires all eight when coverage is
     * `full`, so the guarantee is kept exactly where it applies rather
     * than being weakened for everyone.
     */
    axes: AxisScores.partial(),
    context: ScoreContext,
    fixes: z.array(Fix),
  /**
   * 0-1. How much of the input the scorer could actually verify. A single
   * square-on face at a usable resolution is 1; an off-axis face, several
   * faces, or heavy compression pulls it down.
   */
    confidence: z.number().finite().min(0).max(1),
  /**
   * Identifies the hand-set weight table that produced `score`, so two
   * scores are only ever compared when they were produced the same way.
   */
    weightsVersion: z.string().min(1),
  /**
   * Which axes contributed.
   *
   * `partial` means the vision model declined or was unavailable, so
   * only the four computed axes were scored and their weights were
   * renormalised over themselves. Deliberately separate from
   * `confidence`: one says how sure we are, the other says what we
   * looked at. Folding a label into the number would lose the number
   * exactly when it matters most.
   */
    coverage: z.enum(['full', 'partial']),
  })
  .superRefine((value, ctx) => {
    const present = Object.keys(value.axes);
    const required =
      value.coverage === 'full'
        ? AxisName.options
        : (['sharpness', 'lighting', 'resolution', 'framing'] as const);

    for (const axis of required) {
      if (value.axes[axis] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['axes', axis],
          message: `coverage "${value.coverage}" requires ${axis}`,
        });
      }
    }

    if (value.coverage === 'partial' && present.length === AxisName.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coverage'],
        message: 'coverage "partial" but every axis is present - use "full"',
      });
    }
  });

export type FixSeverity = z.infer<typeof FixSeverity>;
export type Fix = z.infer<typeof Fix>;
export type ScoreResult = z.infer<typeof ScoreResult>;
