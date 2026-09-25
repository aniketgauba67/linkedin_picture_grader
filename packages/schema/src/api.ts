import { z } from 'zod';

import { ComputedFeatures } from './features.js';
import { Assessment } from './assessment.js';
import { DeclineReason } from './outcome.js';
import { MimeType } from './image.js';

/**
 * The HTTP contracts between the browser and the two Next.js routes.
 *
 * They live here rather than as interfaces in `apps/web` so that the
 * route and its caller cannot drift: the route parses its own response
 * shape in tests, and the client parses what it receives. A handwritten
 * client-side interface would compile happily against a response that
 * changed last week.
 *
 * Scoring has no contract here on purpose - the Edge scorer already
 * answers with `AnalysisOutcome`, which is the shared type it should be.
 */

export const UploadUrlRequest = z.object({
  filename: z.string().min(1).max(255),
  contentType: MimeType,
  /** Lowercase hex. The server re-computes and verifies it from the
   *  uploaded bytes; this is a claim, not a credential. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().finite().int().positive().optional(),
});

export const UploadUrlResponse = z.object({
  photoId: z.string().uuid(),
  storagePath: z.string().min(1),
  signedUrl: z.string().min(1),
  token: z.string().min(1),
  expiresInSeconds: z.number().finite().positive(),
});

/**
 * What `/api/extract` answers with once the bytes are in Storage.
 *
 * `assessment` and `declined` are both nullable and both meaningful:
 * a null assessment with `judgeSkipped: 'no_face'` is the deliberate
 * no-face path, where computed evidence exists and no semantic axes were
 * ever requested. That is not the same as a model decline, and the UI
 * must not render them identically.
 */
export const ExtractResponse = z.object({
  photoId: z.string().uuid(),
  features: ComputedFeatures,
  extractorVersion: z.string().min(1),
  featuresCached: z.boolean(),
  assessment: Assessment.nullable(),
  declined: DeclineReason.nullable().optional(),
  judgeSkipped: z.enum(['no_face', 'below_dimension_floor']).nullable().optional(),
});

/** Every route failure answers with this shape and nothing else - no
 *  stack, no database text, no provider payload. */
export const ApiError = z.object({
  error: z.string().min(1),
  code: z.string().min(1).optional(),
});

export type UploadUrlRequest = z.infer<typeof UploadUrlRequest>;
export type UploadUrlResponse = z.infer<typeof UploadUrlResponse>;
export type ExtractResponse = z.infer<typeof ExtractResponse>;
export type ApiError = z.infer<typeof ApiError>;
