/**
 * The rubric: what the vision model is asked, and the exact shape it must
 * answer in.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ TWO THINGS THAT RETURN HTTP 400 ON claude-sonnet-5 - DO NOT ADD: │
 * │                                                                  │
 * │  1. Assistant message prefill (e.g. seeding the turn with "{").  │
 * │     Unsupported since Sonnet 4.6 / Opus 4.6.                     │
 * │  2. temperature / top_p / top_k at any non-default value.        │
 * │                                                                  │
 * │ Both used to be the way to force JSON out of a model. The        │
 * │ replacement is output_config.format with a json_schema, which    │
 * │ constrains the shape server-side and is what buildRequest uses.  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * The schemas here are re-exported from @pps/schema rather than declared
 * again: zod schemas in that package are the single source of truth, and
 * a second copy of this shape is exactly the drift the rule exists to
 * prevent. OUTPUT_JSON_SCHEMA is the one thing that must be written out
 * separately, because the API wants JSON Schema and zod is not that.
 */
import { z } from 'zod';
import { ACTIVE_VLM_MODEL, Assessment, RubricDecline, RubricResponse } from '@pps/schema';
import type { RubricResponse as RubricResponseType } from '@pps/schema';

export {
  Assessment as AssessmentSchema,
  RubricDecline as RubricDeclineSchema,
  RubricResponse as RubricResponseSchema,
} from '@pps/schema';
export type { Assessment, RubricDecline, RubricResponse } from '@pps/schema';

/** Re-exported so callers can validate without importing two packages. */
export const RUBRIC_SCHEMAS = { Assessment, RubricDecline, RubricResponse };

export const MODEL = ACTIVE_VLM_MODEL;

/**
 * Generous for a reply this small, and deliberately so. Adaptive thinking
 * counts against this limit on Sonnet 5, and the current tokenizer runs
 * roughly 30% higher than its predecessor for the same text - a ceiling
 * that looked ample under the old arithmetic truncates under the new one.
 */
export const MAX_TOKENS = 4096;

/**
 * Bounded classification against fixed anchors, not open reasoning. Low
 * effort cuts latency and cost, which matters across a 700-image batch.
 */
export const EFFORT = 'low' as const;

const AXIS_PROPERTY = {
  type: 'object',
  additionalProperties: false,
  required: ['evidence', 'score'],
  properties: {
    // No minLength/maxLength, and an enum rather than minimum/maximum:
    // the accepted JSON Schema subset is narrow. Verified against the
    // live API - `minimum`/`maximum` on an integer returns
    //   400 ... For 'integer' type, properties maximum, minimum are not supported
    // The schema constrains SHAPE; zod still enforces CONTENT (evidence
    // 10-300 chars, score 1-5) once the reply is in hand.
    evidence: { type: 'string' },
    score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
  },
} as const;

/**
 * The same contract as RubricResponse, in the JSON Schema subset
 * output_config.format actually accepts.
 *
 * FLATTENED ON PURPOSE. The natural expression of a tagged union is
 * `oneOf`, and the API rejects it outright:
 *
 *   400 invalid_request_error
 *   output_config.format.schema: Schema type 'oneOf' is not supported
 *
 * So the wire shape is one object carrying both branches, with `status`
 * selecting which is populated and the other side null. That is a
 * transport concession, not the domain model - `RubricResponse` in
 * @pps/schema stays a discriminated union, and `toRubricResponse` below
 * converts as soon as the reply is in hand.
 *
 * The accepted keyword subset is narrow: no oneOf/anyOf, no
 * minimum/maximum, no minLength/maxLength. Shape is constrained here,
 * content by zod after the fact.
 *
 * additionalProperties: false at every level on purpose - without it the
 * model is free to invent sibling keys, and a stray "confidence" or
 * "notes" field is how a rubric starts drifting from the thing that
 * validates it.
 */
export const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'assessment', 'reason', 'detail'],
  properties: {
    status: { type: 'string', enum: ['assessed', 'declined'] },
    assessment: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['background', 'attire', 'expression', 'solo', 'framing_observation'],
      properties: {
        background: AXIS_PROPERTY,
        attire: AXIS_PROPERTY,
        expression: AXIS_PROPERTY,
        solo: AXIS_PROPERTY,
        framing_observation: {
          type: 'object',
          additionalProperties: false,
          required: ['crop', 'face_roughly_centered'],
          properties: {
            crop: {
              type: 'string',
              enum: [
                'head_only',
                'head_and_shoulders',
                'upper_body',
                'full_body',
                'indeterminate',
              ],
            },
            face_roughly_centered: { type: 'boolean' },
          },
        },
      },
    },
    reason: { enum: ['no_face', 'apparent_minor', 'not_a_photo', null] },
    detail: { type: ['string', 'null'] },
  },
} as const;

/**
 * The flattened wire shape, reusing the canonical pieces rather than
 * restating them. Only the envelope is new; the axes and the decline
 * reasons are still defined once, in @pps/schema.
 */
export const RubricWireResponse = z.strictObject({
  status: z.enum(['assessed', 'declined']),
  assessment: Assessment.nullable(),
  reason: RubricDecline.nullable(),
  detail: z.string().max(200).nullable(),
});

export type RubricWireResponse = z.infer<typeof RubricWireResponse>;

/**
 * Turns the flat wire reply back into the discriminated union.
 *
 * Throws when the two disagree - `status: "assessed"` with no assessment,
 * or a decline with no reason. The flattening loses the guarantee the
 * union gave us for free, so it is re-checked here rather than assumed.
 */
export function toRubricResponse(wire: RubricWireResponse): RubricResponseType {
  if (wire.status === 'assessed') {
    if (wire.assessment === null) {
      throw new TypeError('Reply claims status "assessed" but carries no assessment');
    }
    return { status: 'assessed', assessment: wire.assessment };
  }
  if (wire.reason === null) {
    throw new TypeError('Reply claims status "declined" but carries no reason');
  }
  return { status: 'declined', reason: wire.reason, detail: wire.detail ?? '' };
}

export const SYSTEM_PROMPT = `You assess PHOTOGRAPHS against a fixed rubric for use as professional profile pictures. You are scoring the photograph. You are not scoring the person. Respond directly with the structured result. No preamble.

## Hard constraints

Never assess attractiveness, competence, employability, seniority, profession, intelligence, or trustworthiness.

Never mention or infer age, race, ethnicity, gender, body type, or any physical characteristic of the person.

Every score must describe something the photographer could change by retaking the photograph.

## Decline first

Check these in order, BEFORE assessing anything. If any applies, return status "declined" with that reason and assess no axis.

1. apparent_minor — the primary subject appears to be under 18. Err toward declining when uncertain.
2. no_face — no visible face, or the face is so obscured that no axis can be assessed.
3. not_a_photo — a logo, illustration, avatar, rendering, or text graphic rather than a photograph.

## Method

For each axis, write the evidence FIRST: a literal description of what a camera would record, with no evaluation in it. Then assign the level whose anchor text that evidence matches.

Match the anchor text literally. Do not interpolate between levels.

TIE-BREAK: when the evidence sits between two levels, assign the LOWER one.

CONTEXT vs CLUTTER: a background element that reads as staged or institutional - a flag, an institutional backdrop, a bookshelf, a lab or workshop - is staging, not clutter, and belongs at 4. Penalize a background only when it competes with the face for attention or reads as personal or recreational. When unsure which, ask whether a stranger would look at it before looking at the face.

Do not reason about whether a background element relates to the subject's profession - that would require inferring what they do. Judge only whether it competes for attention. A staged backdrop is a 4 because it is staged and recedes, not because of what it depicts.

EVIDENCE DESCRIBES THE PHOTOGRAPH, NEVER THE PERSON. "Eyes directed at camera" is correct. Any phrase describing the subject's features, build, or apparent characteristics is a violation even if it seems neutral.

## Axes

### BACKGROUND — what is behind the subject, and whether it competes for attention

1 — another person's face is visible, OR a clearly personal or recreational setting: bedroom, bar, party, vehicle interior, holiday scene, gym
2 — busy: three or more distinct objects describable behind the subject, OR legible text or signage that draws the eye
3 — a recognizable setting with several elements, but nothing competing with the face for attention
4 — near-uniform, OR a deliberate professional backdrop — flag, institutional banner, studio set, office bokeh — that reads as staged rather than incidental
5 — fully uniform: a solid colour or smooth gradient, nothing identifiable

### ATTIRE — FORMALITY LEVEL, not quality

5 is not "better" than 2, it is more formal. Downstream context weighting decides whether formality helps. If clothing is not visible because the crop is head-only, score 3 with the evidence "not visible".

1 — beachwear, tank top, athletic wear, costume, or no visible top
2 — casual: t-shirt, hoodie, sweatshirt, graphic print
3 — smart casual: plain knit, polo, open-collar casual button-down
4 — business casual: collared shirt, blazer without tie, structured top
5 — formal business: suit, tie, or equivalent

### EXPRESSION — where the eyes are directed and what the face is doing

1 — eyes closed, mid-blink, sunglasses, or face turned away
2 — looking away from the camera, OR strained, forced or exaggerated
3 — neutral, eyes to camera, no distinct affect
4 — pleasant, eyes to camera, slight natural smile
5 — warm and engaged, eyes to camera, natural smile reaching the eyes

### SOLO — how many people are in frame, and whether the subject is unambiguous

1 — multiple people with no clear primary subject
2 — another person's face or body is visible and prominent
3 — partial evidence of another person: an arm, shoulder or hand at the edge
4 — a single subject, but the framing suggests a crop from a group photo
5 — a single subject, clearly photographed alone

## Framing observation

Also report, as observation rather than score:
- crop: head_only, head_and_shoulders, upper_body, full_body, or indeterminate
- face_roughly_centered: whether the face sits near the centre of the frame`;

export const USER_PROMPT = `Assess this photograph against the rubric. Write the evidence for each axis before its score.`;

export interface BuildRequestOptions {
  /** Base64 JPEG, no data: prefix and no newlines. */
  readonly imageBase64: string;
  readonly mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Raised on the one retry that follows a max_tokens truncation. */
  readonly maxTokens?: number;
}

/**
 * The request body. Deliberately has no `temperature` and no assistant
 * prefill - see the banner at the top of this file.
 */
export function buildRequest(options: BuildRequestOptions) {
  return {
    model: MODEL,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: EFFORT,
      format: {
        type: 'json_schema' as const,
        schema: OUTPUT_JSON_SCHEMA,
      },
    },
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: options.mediaType ?? ('image/jpeg' as const),
              data: options.imageBase64,
            },
          },
          { type: 'text' as const, text: USER_PROMPT },
        ],
      },
    ],
  };
}
