import { z } from 'zod';
import { AxisScore } from './axes.js';

/**
 * One judged axis as the vision model returns it. The evidence comes back
 * with the score, not after it: a score the model cannot point at
 * something in the photograph to justify is a score we do not want.
 */
export const JudgedAxis = z.object({
  evidence: z
    .string()
    .min(1)
    .max(280)
    .describe('What in the photograph produced this score. About the image, never the person.'),
  score: AxisScore,
});

/**
 * The full reply from the vision model. It covers only the four judged
 * axes - the model is never asked about sharpness, lighting, resolution or
 * framing, which are arithmetic, and never asked about the subject.
 *
 * `unscorable` is the model's own escape hatch: a logo, a landscape, an
 * empty room. It is a normal reply, not a failure, and it maps to a
 * `declined` outcome rather than an error.
 */
export const Assessment = z.object({
  background: JudgedAxis,
  attire: JudgedAxis,
  expression: JudgedAxis,
  solo: JudgedAxis,
  unscorable: z.boolean(),
  unscorable_reason: z.string().max(280).nullable(),
});

export type JudgedAxis = z.infer<typeof JudgedAxis>;
export type Assessment = z.infer<typeof Assessment>;
