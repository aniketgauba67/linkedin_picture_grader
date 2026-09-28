import { z } from 'zod';
import { AxisName, AxisScores, CompositeScore, JudgedAxisName, ScoreContext } from './axes.js';

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

const ResultEvidence = z.object({
  /** Framing may be absent when no primary face qualified. */
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
   * Identifies the hand-set weight table used for the arithmetic result.
   */
  weightsVersion: z.string().min(1),
  /**
   * Which axes contributed.
   *
   * `partial` means the vision model declined or was unavailable. The
   * scoring package may compute an intermediate composite from the
   * available axes, but the public partial review omits that number.
   */
  coverage: z.enum(['full', 'partial']),
});

function validateCoverage(value: z.infer<typeof ResultEvidence>, ctx: z.RefinementCtx): void {
  const present = Object.keys(value.axes);
  /**
   * `framing` can be absent at any coverage: since extractor v8 it exists
   * only when a face qualified as the subject. Coverage cannot promise
   * a measurement the pixels did not contain.
   */
  const required = (
    value.coverage === 'full'
      ? AxisName.options
      : (['sharpness', 'lighting', 'resolution', 'framing'] as const)
  ).filter((axis) => axis !== 'framing');

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
}

/** Arithmetic output. A partial composite is internal, not an overall profile-photo score. */
export const ScoreResult = ResultEvidence.extend({ score: CompositeScore }).superRefine(validateCoverage);

/** A public overall score requires the complete four-axis presentation assessment. */
export const FullScoreResult = ScoreResult.and(z.object({ coverage: z.literal('full') }));

/** Measured evidence when no presentation axis was reviewed. No composite crosses the API. */
export const PartialReview = ResultEvidence.extend({ coverage: z.literal('partial') })
  .strict()
  .superRefine((value, ctx) => {
    validateCoverage(value, ctx);
    for (const axis of JudgedAxisName.options) {
      if (value.axes[axis] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['axes', axis],
          message: `partial review cannot carry a judged ${axis} axis`,
        });
      }
    }
  });

export type FixSeverity = z.infer<typeof FixSeverity>;
export type Fix = z.infer<typeof Fix>;
export type ScoreResult = z.infer<typeof ScoreResult>;
export type FullScoreResult = z.infer<typeof FullScoreResult>;
export type PartialReview = z.infer<typeof PartialReview>;
