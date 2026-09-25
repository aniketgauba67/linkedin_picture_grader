/** Eight-axis VLM judgments for offline dataset work only. Production scoring never imports this. */
import { createHash } from 'node:crypto';

import { OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT } from '@pps/features';
import { ACTIVE_VLM_MODEL, Assessment, JudgedAxis } from '@pps/schema';
import { z } from 'zod';

export const OFFLINE_RUBRIC_VERSION = 'offline-eight-v2';
export const OFFLINE_MODEL = ACTIVE_VLM_MODEL;
export const OFFLINE_AXES = [
  'sharpness', 'lighting', 'resolution', 'framing',
  'background', 'attire', 'expression', 'solo',
] as const;

/** Reuse the production method and semantic-axis anchors verbatim. */
const methodAt = SYSTEM_PROMPT.indexOf('## Method\n');
if (methodAt < 0) throw new Error('production semantic rubric marker is missing');
const productionMethodAndSemanticAxes = SYSTEM_PROMPT.slice(methodAt);

export const OFFLINE_SYSTEM_PROMPT = `You assess the PHOTOGRAPH for use as a professional profile photo, never the worth or characteristics of a person. Return only the structured result.

Do not score or infer attractiveness, intelligence, competence, employability, personality, age, race, ethnicity, religion, health, sexual orientation, political affiliation, socioeconomic status, gender, or any other personal trait. Evidence must describe only visible photographic properties. Refer to visible people only as "subject", "person", "other person", or "people". Never use man, woman, male, female, he, she, his, or her in evidence. Do not create demographic or identity labels.

Decline without scoring if there is no usable visible face, or if the input is not a photograph. Do not guess missing evidence. For a group photograph with a clear primary face, assess the photograph and use the most prominent visible face for technical axes; framing and solo consider the whole delivered image.

Use the same 1–5 concepts as the existing human computed-axis labels. Score the actual delivered image, not a hypothetical higher-resolution original. Adjacent-score ties go to the lower level. Keep technical axes separate: obstruction is not blur; blur is not low pixel count; attire and background do not change a framing score.

### SHARPNESS — visible facial/eye detail, focus and motion blur
1 — severe focus or motion blur; important facial detail cannot be resolved
2 — obvious blur or heavy softness/compression obscures important detail
3 — usable but visibly soft; detail is present with a clear sharpness weakness
4 — face and eyes are clear; only minor softness or compression is visible
5 — crisp important detail and accurate focus, with no visible blur or damaging compression

### LIGHTING — photographic illumination of the face
1 — severe under/overexposure, clipping, shadow or backlighting prevents a clear facial read
2 — substantial facial lighting problem; much detail is lost or unevenly illuminated
3 — face remains readable but exposure, harsh shadow or uneven light is noticeably weak
4 — face is clearly and naturally lit with only minor exposure or shadow issues
5 — balanced facial illumination with retained highlight/shadow detail and no distracting lighting defect

### RESOLUTION — usable pixel/detail resolution of this delivered image
Use the exact oriented width and height supplied with the image. Do not guess dimensions from its appearance, and do not assume an upscaled image contains true source detail. Judge visible pixel/detail sufficiency for a small profile avatar, separately from focus blur.
1 — 200–299 px shorter edge, or visibly pixelated/insufficient facial pixels for profile use
2 — 300–399 px shorter edge, or facial pixels remain noticeably limited
3 — 400–599 px shorter edge with adequate but modest usable facial detail
4 — 600–799 px shorter edge with good usable facial detail
5 — at least 800 px shorter edge with genuinely retained facial detail
If the nominal dimensions overstate usable detail because of upscaling or compression, choose the lower matching level.

### FRAMING — profile-photo crop and composition, without judging clothing or setting
1 — primary face is tiny, cut off, or ambiguously placed; crop is unusable as a profile avatar
2 — clearly poor crop: too wide/tight, far off-center, or substantial competing people/empty space
3 — usable crop with a noticeable face-size, centering, edge, or empty-space weakness
4 — effective face size and placement with only a minor compositional issue
5 — strong head-and-shoulders/profile crop with clear primary face, suitable space and balanced placement

${productionMethodAndSemanticAxes}`;

const OFFLINE_USER_PROMPT_TEMPLATE = 'Assess the delivered photograph on all eight axes. Its exact EXIF-oriented dimensions are {width} × {height} pixels. Write literal photographic evidence for each axis before its score.';
export const OFFLINE_USER_PROMPT = (width: number, height: number): string =>
  OFFLINE_USER_PROMPT_TEMPLATE.replace('{width}', String(width)).replace('{height}', String(height));

export const OfflineAssessment = Assessment.extend({
  sharpness: JudgedAxis,
  lighting: JudgedAxis,
  resolution: JudgedAxis,
  framing: JudgedAxis,
});
export type OfflineAssessment = z.infer<typeof OfflineAssessment>;

const OfflineDeclineReason = z.enum(['no_face', 'not_a_photo']);

export const OfflineWireResponse = z.strictObject({
  status: z.enum(['assessed', 'declined']),
  assessment: OfflineAssessment.nullable(),
  reason: OfflineDeclineReason.nullable(),
  detail: z.string().max(200).nullable(),
});

export const OfflineResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('assessed'), assessment: OfflineAssessment }),
  z.strictObject({ status: z.literal('declined'), reason: z.union([OfflineDeclineReason, z.literal('model_refusal')]),
    detail: z.string().max(200) }),
]);
export type OfflineResult = z.infer<typeof OfflineResult>;

const PERSONAL_TRAIT_WORDS = /\b(?:man|men|woman|women|male|female|boy|girl|he|she|his|her|hers|gentleman|lady|young|elderly|middle-aged|adult|child|teenager|age|race|ethnicity|religion|sexual orientation|political affiliation|socioeconomic status|attractive|intelligent|competent|employable)\b/i;

export function parseOfflineReply(text: string): OfflineResult {
  const wire = OfflineWireResponse.parse(JSON.parse(text) as unknown);
  if (wire.status === 'assessed' && wire.assessment !== null && wire.reason === null && wire.detail === null) {
    for (const axis of OFFLINE_AXES) {
      if (PERSONAL_TRAIT_WORDS.test(wire.assessment[axis].evidence)) {
        throw new TypeError(`offline ${axis} evidence names a personal trait`);
      }
    }
    return { status: 'assessed', assessment: wire.assessment };
  }
  if (wire.status === 'declined' && wire.assessment === null && wire.reason !== null) {
    if (PERSONAL_TRAIT_WORDS.test(wire.detail ?? '')) throw new TypeError('offline decline detail names a personal trait');
    return { status: 'declined', reason: wire.reason, detail: wire.detail ?? '' };
  }
  throw new TypeError('inconsistent offline rubric response');
}

const productionAxes = OUTPUT_JSON_SCHEMA.properties.assessment.properties;
const axisSchema = productionAxes.background;

/** Flat JSON Schema: the provider's supported subset rejects union oneOf. */
export const OFFLINE_OUTPUT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'assessment', 'reason', 'detail'],
  properties: {
    status: { type: 'string', enum: ['assessed', 'declined'] },
    assessment: {
      type: ['object', 'null'], additionalProperties: false,
      required: [...OFFLINE_AXES, 'framing_observation'],
      properties: {
        sharpness: axisSchema, lighting: axisSchema, resolution: axisSchema, framing: axisSchema,
        background: productionAxes.background, attire: productionAxes.attire,
        expression: productionAxes.expression, solo: productionAxes.solo,
        framing_observation: productionAxes.framing_observation,
      },
    },
    reason: { enum: ['no_face', 'not_a_photo', null] },
    detail: { type: ['string', 'null'] },
  },
} as const;

export const OFFLINE_RUBRIC_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify([OFFLINE_RUBRIC_VERSION, OFFLINE_SYSTEM_PROMPT,
    OFFLINE_USER_PROMPT_TEMPLATE, OFFLINE_OUTPUT_JSON_SCHEMA]))
  .digest('hex');
