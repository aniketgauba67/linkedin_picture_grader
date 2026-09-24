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

export const ScoreResult = z.object({
  score: CompositeScore,
  axes: AxisScores,
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
});

export type FixSeverity = z.infer<typeof FixSeverity>;
export type Fix = z.infer<typeof Fix>;
export type ScoreResult = z.infer<typeof ScoreResult>;
