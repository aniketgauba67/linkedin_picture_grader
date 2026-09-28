import { z } from 'zod';
import { FullScoreResult, PartialReview } from './result.js';

/**
 * Why an upload was not scored. All six are things real users will
 * upload, not bugs:
 *
 *   no_face         a logo, a landscape, a pet
 *   multiple_faces  more than one detected face; not a single-subject profile photo
 *   apparent_minor  a child's photo; we do not score these at all
 *   not_a_photo     a screenshot, an illustration, a slide
 *   model_refusal   the vision model declined to assess the image
 *   corrupt_file    the bytes did not decode
 */
export const DeclineReason = z.enum([
  'no_face',
  'multiple_faces',
  'apparent_minor',
  'not_a_photo',
  'model_refusal',
  'corrupt_file',
]);

export const ScoredOutcome = z.object({
  status: z.literal('scored'),
  result: FullScoreResult,
});

/** Pixels were measured, but no presentation axis was assessed. */
export const PartialOutcome = z.strictObject({
  status: z.literal('partial'),
  review: PartialReview,
});

export const DeclinedOutcome = z.strictObject({
  status: z.literal('declined'),
  reason: DeclineReason,
  /** Shown to the user. Explains the photo, never the person in it. */
  message: z.string().min(1).max(280),
  /**
   * A DECLINE IS A FINDING, NOT AN ABSENCE: measured axes and actionable
   * fixes remain available. A numeric composite is withheld when none
   * of the presentation axes were reviewed. ABSENT ONLY WHEN THERE ARE
   * NO USABLE FEATURES, as on corrupt_file.
   */
  review: PartialReview.optional(),
});

/**
 * Declining is a normal outcome, not an error. It is modelled as a branch
 * of the return type rather than a thrown exception precisely so that a
 * caller cannot forget it: there is no `.result` to reach for until
 * `status` has been narrowed.
 */
export const AnalysisOutcome = z
  .discriminatedUnion('status', [ScoredOutcome, PartialOutcome, DeclinedOutcome])
  /**
   * The invariant that makes the optional field safe to rely on: a
   * decline carries a review unless there was nothing to measure.
   *
   * Refined on the UNION rather than on DeclinedOutcome, because
   * `superRefine` returns a ZodEffects and `discriminatedUnion` only
   * accepts plain objects as members. Refining the member would compile
   * and then fail at runtime when the union is constructed.
   */
  .superRefine((value, ctx) => {
    if (value.status !== 'declined') return;

    if (value.reason === 'corrupt_file' && value.review !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review'],
        message: 'corrupt_file cannot carry a review: the bytes never decoded, so nothing was measured',
      });
      return;
    }
    if (value.reason !== 'corrupt_file' && value.review === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review'],
        message: `a "${value.reason}" decline must carry measured evidence when extraction succeeded`,
      });
    }
  });

export type DeclineReason = z.infer<typeof DeclineReason>;
export type ScoredOutcome = z.infer<typeof ScoredOutcome>;
export type PartialOutcome = z.infer<typeof PartialOutcome>;
export type DeclinedOutcome = z.infer<typeof DeclinedOutcome>;
export type AnalysisOutcome = z.infer<typeof AnalysisOutcome>;

export function isScored(outcome: AnalysisOutcome): outcome is ScoredOutcome {
  return outcome.status === 'scored';
}

export function isPartial(outcome: AnalysisOutcome): outcome is PartialOutcome {
  return outcome.status === 'partial';
}

export function isDeclined(outcome: AnalysisOutcome): outcome is DeclinedOutcome {
  return outcome.status === 'declined';
}

/**
 * Exhaustive match over the union. A partial review cannot accidentally
 * borrow the scored handler and display an intermediate composite.
 */
export function matchOutcome<T>(
  outcome: AnalysisOutcome,
  handlers: {
    scored: (result: ScoredOutcome['result']) => T;
    partial: (review: PartialOutcome['review']) => T;
    /**
     * `review` contains measured evidence, or is undefined when the
     * image could not be decoded.
     */
    declined: (
      reason: DeclineReason,
      message: string,
      review: DeclinedOutcome['review'],
    ) => T;
  },
): T {
  switch (outcome.status) {
    case 'scored':
      return handlers.scored(outcome.result);
    case 'partial':
      return handlers.partial(outcome.review);
    case 'declined':
      return handlers.declined(outcome.reason, outcome.message, outcome.review);
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unhandled analysis outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}
