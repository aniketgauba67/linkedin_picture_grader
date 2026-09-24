import { z } from 'zod';
import { ScoreResult } from './result.js';

/**
 * Why an upload was not scored. All five are things real users will
 * upload, not bugs:
 *
 *   no_face         a logo, a landscape, a pet
 *   apparent_minor  a child's photo; we do not score these at all
 *   not_a_photo     a screenshot, an illustration, a slide
 *   model_refusal   the vision model declined to assess the image
 *   corrupt_file    the bytes did not decode
 */
export const DeclineReason = z.enum([
  'no_face',
  'apparent_minor',
  'not_a_photo',
  'model_refusal',
  'corrupt_file',
]);

export const ScoredOutcome = z.object({
  status: z.literal('scored'),
  result: ScoreResult,
});

export const DeclinedOutcome = z.object({
  status: z.literal('declined'),
  reason: DeclineReason,
  /** Shown to the user. Explains the photo, never the person in it. */
  message: z.string().min(1).max(280),
});

/**
 * Declining is a normal outcome, not an error. It is modelled as a branch
 * of the return type rather than a thrown exception precisely so that a
 * caller cannot forget it: there is no `.result` to reach for until
 * `status` has been narrowed.
 */
export const AnalysisOutcome = z.discriminatedUnion('status', [ScoredOutcome, DeclinedOutcome]);

export type DeclineReason = z.infer<typeof DeclineReason>;
export type ScoredOutcome = z.infer<typeof ScoredOutcome>;
export type DeclinedOutcome = z.infer<typeof DeclinedOutcome>;
export type AnalysisOutcome = z.infer<typeof AnalysisOutcome>;

export function isScored(outcome: AnalysisOutcome): outcome is ScoredOutcome {
  return outcome.status === 'scored';
}

export function isDeclined(outcome: AnalysisOutcome): outcome is DeclinedOutcome {
  return outcome.status === 'declined';
}

/**
 * Exhaustive match over the union. Downstream code should reach for this
 * rather than an `if`: adding a third status turns every call site into a
 * compile error instead of a silently skipped branch.
 */
export function matchOutcome<T>(
  outcome: AnalysisOutcome,
  handlers: {
    scored: (result: ScoredOutcome['result']) => T;
    declined: (reason: DeclineReason, message: string) => T;
  },
): T {
  switch (outcome.status) {
    case 'scored':
      return handlers.scored(outcome.result);
    case 'declined':
      return handlers.declined(outcome.reason, outcome.message);
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unhandled analysis outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}
