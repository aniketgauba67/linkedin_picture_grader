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
  /**
   * The score the photograph earned anyway, capped for the decline.
   *
   * A DECLINE IS A FINDING, NOT AN ABSENCE, and this field is where that
   * stops being a slogan. `score()` caps the composite per reason - a
   * group of five caps at 2 - and that number is information the person
   * can act on. A bare "this looks like a group photo" tells them
   * nothing about how far off they are; "2.0, this looks like a group
   * photo" tells them it is not a near miss.
   *
   * ABSENT ONLY WHEN THERE ARE NO USABLE FEATURES. `corrupt_file` is the
   * case: the bytes never decoded, so there is nothing to have measured
   * and no honest number to report. Every other reason carries a score.
   *
   * Optional rather than a third status on purpose. The union's job is
   * to stop a caller reaching for `.result` without narrowing, and that
   * still holds: this is not `result`, it is a capped composite that
   * only exists on the declined branch.
   */
  score: ScoreResult.optional(),
});

/**
 * Declining is a normal outcome, not an error. It is modelled as a branch
 * of the return type rather than a thrown exception precisely so that a
 * caller cannot forget it: there is no `.result` to reach for until
 * `status` has been narrowed.
 */
export const AnalysisOutcome = z
  .discriminatedUnion('status', [ScoredOutcome, DeclinedOutcome])
  /**
   * The invariant that makes the optional field safe to rely on: a
   * decline carries a score unless there was nothing to measure.
   *
   * Refined on the UNION rather than on DeclinedOutcome, because
   * `superRefine` returns a ZodEffects and `discriminatedUnion` only
   * accepts plain objects as members. Refining the member would compile
   * and then fail at runtime when the union is constructed.
   */
  .superRefine((value, ctx) => {
    if (value.status !== 'declined') return;

    if (value.reason === 'corrupt_file' && value.score !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['score'],
        message: 'corrupt_file cannot carry a score: the bytes never decoded, so nothing was measured',
      });
      return;
    }
    if (value.reason !== 'corrupt_file' && value.score === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['score'],
        message: `a "${value.reason}" decline must carry its capped score - extraction ran, so there is a number, and dropping it leaves the user with nothing to act on`,
      });
    }
  });

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
    /**
     * `score` is the capped composite, or undefined when nothing could
     * be measured. It is a third positional argument rather than a
     * second handler so that every existing call site keeps compiling
     * while ignoring it - the ones that should show the number are the
     * ones that opt in.
     */
    declined: (
      reason: DeclineReason,
      message: string,
      score: DeclinedOutcome['score'],
    ) => T;
  },
): T {
  switch (outcome.status) {
    case 'scored':
      return handlers.scored(outcome.result);
    case 'declined':
      return handlers.declined(outcome.reason, outcome.message, outcome.score);
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unhandled analysis outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}
