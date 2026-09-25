import { z } from 'zod';
import { AxisScore } from './axes.js';

/** Model used for VLM judging and for its per-photo assessment identity. */
export const ACTIVE_VLM_MODEL = 'claude-sonnet-5';

/**
 * What the vision model returns, and the single source of truth for that
 * shape.
 *
 * Every object here is strict, matching `additionalProperties: false` in
 * the rubric's JSON Schema. The two are the same contract expressed
 * twice - one enforced by the API, one by us - and a sibling key the
 * model invented should fail both, not be silently stripped by one. `packages/features/src/rubric.ts` re-exports these under the
 * names the prompt code uses rather than declaring a second copy.
 */

/**
 * One judged axis. The evidence comes back WITH the score, not after it:
 * a score the model cannot point at something in the photograph to
 * justify is a score we do not want.
 *
 * The lower bound is 10 characters because a one-word evidence string
 * ("busy") is the shape a model falls into when it is scoring first and
 * justifying afterwards - which is the failure this field exists to stop.
 */
export const JudgedAxis = z.strictObject({
  evidence: z
    .string()
    .min(10)
    .max(300)
    .describe('Literal description of what is in the photograph. No evaluation, no inference about the person.'),
  score: AxisScore,
});

/**
 * How much of the subject is in frame, observed rather than scored.
 *
 * This is not an axis. `framing` is computed from pixels by
 * @pps/features, and this is the model's independent read of the same
 * thing - useful as a cross-check and as a training signal, never as a
 * score.
 */
export const CropExtent = z.enum([
  'head_only',
  'head_and_shoulders',
  'upper_body',
  'full_body',
  'indeterminate',
]);

export const FramingObservation = z.strictObject({
  crop: CropExtent,
  face_roughly_centered: z.boolean(),
});

export const Assessment = z.strictObject({
  background: JudgedAxis,
  attire: JudgedAxis,
  expression: JudgedAxis,
  solo: JudgedAxis,
  framing_observation: FramingObservation,
});

/**
 * Why the model declined to assess, as an enum rather than prose.
 *
 * These map straight onto `DeclineReason` with nothing to flatten. The
 * previous shape - a boolean plus a free-text reason - forced every
 * decline through one bucket and threw away which kind it was.
 */
export const RubricDecline = z.enum(['no_face', 'apparent_minor', 'not_a_photo']);

export const AssessedResponse = z.strictObject({
  status: z.literal('assessed'),
  assessment: Assessment,
});

export const DeclinedResponse = z.strictObject({
  status: z.literal('declined'),
  reason: RubricDecline,
  /** One line for the user. About the image, never about the person. */
  detail: z.string().max(200),
});

/**
 * The model's reply: assessed, or declined having looked.
 *
 * Distinct from the API refusing to look at all, which arrives as
 * `stop_reason: "refusal"` on an HTTP 200 and maps to `model_refusal`.
 * Two different events that both end in a decline, and the judge keeps
 * them apart.
 */
export const RubricResponse = z.discriminatedUnion('status', [
  AssessedResponse,
  DeclinedResponse,
]);

/**
 * What may be stored after a VLM request. The rubric body can only give
 * RubricDecline reasons; an API refusal arrives separately as
 * `stop_reason: "refusal"` and is persisted so retries do not buy the
 * same refusal again. A decode failure never reaches this boundary.
 */
export const PersistedAssessmentResponse = z.discriminatedUnion('status', [
  AssessedResponse,
  DeclinedResponse.extend({
    reason: z.union([RubricDecline, z.literal('model_refusal')]),
  }),
]);

export type JudgedAxis = z.infer<typeof JudgedAxis>;
export type CropExtent = z.infer<typeof CropExtent>;
export type FramingObservation = z.infer<typeof FramingObservation>;
export type Assessment = z.infer<typeof Assessment>;
export type RubricDecline = z.infer<typeof RubricDecline>;
export type AssessedResponse = z.infer<typeof AssessedResponse>;
export type DeclinedResponse = z.infer<typeof DeclinedResponse>;
export type RubricResponse = z.infer<typeof RubricResponse>;
export type PersistedAssessmentResponse = z.infer<typeof PersistedAssessmentResponse>;

export function isAssessed(response: RubricResponse): response is AssessedResponse {
  return response.status === 'assessed';
}
