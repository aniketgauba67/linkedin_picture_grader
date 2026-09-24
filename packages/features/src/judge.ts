import Anthropic from '@anthropic-ai/sdk';
import type { Assessment, DeclineReason, RubricResponse } from '@pps/schema';
import { asDecodeError } from './errors.js';
import { MAX_TOKENS, RubricWireResponse, buildRequest, toRubricResponse } from './rubric.js';
import { normalizedPipeline, prepareImage } from './normalize.js';

/**
 * The vision-model half of scoring: the four judged axes.
 *
 * Two different events end in a decline and this keeps them apart:
 *
 *   status "declined"        the model looked and decided not to assess
 *   stop_reason "refusal"    the API declined to look at all
 *
 * The second arrives as an HTTP 200, not an error, so it is handled in
 * the success path. It is never retried: a refusal is a decision, and
 * asking again three times just bills three times for the same answer.
 */

/** Longest edge sent to the model. Matches the analysis plane. */
export const JUDGE_EDGE = 1024;

/** Quality for the JPEG that goes over the wire. */
export const JUDGE_JPEG_QUALITY = 88;

/** Attempts for genuinely transient failures. Refusals are not one. */
export const MAX_ATTEMPTS = 3;

/** First backoff step; doubles each attempt. */
export const BASE_BACKOFF_MS = 500;

/**
 * Raised on the single retry that follows a truncated reply. Retrying at
 * the same ceiling that just truncated would change nothing.
 */
export const TRUNCATION_RETRY_MAX_TOKENS = MAX_TOKENS * 2;

export type JudgeOutcome =
  | { readonly ok: true; readonly assessment: Assessment }
  | { readonly ok: false; readonly reason: DeclineReason };

/** Thrown only after every attempt has failed. A decline never throws. */
export class JudgeError extends Error {
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'JudgeError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

export interface JudgeOptions {
  readonly client?: Anthropic;
  readonly maxAttempts?: number;
  /** Injected in tests so backoff does not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called when tolerant parsing has to rescue a reply. See parseReply. */
  readonly onAnomaly?: (note: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downsizes to what the model needs. JPEG rather than the PNG the
 * measurement path uses: nothing downstream measures compression here,
 * and a 1024px PNG is several times the bytes for no benefit.
 */
export async function toJudgeImage(image: Buffer): Promise<string> {
  const { decodable } = await prepareImage(image);
  try {
    const jpeg = await normalizedPipeline(decodable)
      .resize({ width: JUDGE_EDGE, height: JUDGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JUDGE_JPEG_QUALITY })
      .toBuffer();
    return jpeg.toString('base64');
  } catch (error) {
    throw asDecodeError(error, 'Could not encode image for the judge');
  }
}

/**
 * Pulls a RubricResponse out of the reply text.
 *
 * The reply arrives in the FLAT wire shape (the API rejects `oneOf`),
 * so it is validated flat and then normalised back into the union.
 *
 * DEFENSIVE. With output_config.format the API constrains the shape
 * server-side, so fenced or prefaced JSON should be unreachable. The
 * stripping stays as depth, and `onAnomaly` fires when it is actually
 * needed - if that ever shows up in production it means the schema
 * constraint did not hold, which is worth knowing about.
 */
export function parseReply(
  text: string,
  onAnomaly?: (note: string) => void,
): RubricResponse {
  const direct = tryParse(text);
  if (direct !== null) {
    return toRubricResponse(RubricWireResponse.parse(direct));
  }

  const fenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const fromFence = tryParse(fenced);
  if (fromFence !== null) {
    onAnomaly?.('reply arrived inside a markdown fence despite the json_schema constraint');
    return toRubricResponse(RubricWireResponse.parse(fromFence));
  }

  const first = fenced.indexOf('{');
  const last = fenced.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const sliced = tryParse(fenced.slice(first, last + 1));
    if (sliced !== null) {
      onAnomaly?.('reply carried text around the JSON despite the json_schema constraint');
      return toRubricResponse(RubricWireResponse.parse(sliced));
    }
  }

  throw new SyntaxError('No JSON object found in the reply');
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

/**
 * Assesses the four judged axes.
 *
 * Returns rather than throws for every outcome the product expects: a
 * decline is a normal result, not an error. `JudgeError` is reserved for
 * a genuinely exhausted retry budget.
 */
export async function judgePhoto(
  image: Buffer,
  options: JudgeOptions = {},
): Promise<JudgeOutcome> {
  const client = options.client ?? new Anthropic();
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;

  const imageBase64 = await toJudgeImage(image);

  let maxTokens = MAX_TOKENS;
  let truncationRetried = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await client.messages.create(
        buildRequest({ imageBase64, maxTokens }) as never,
      );
    } catch (error) {
      // 429 and 5xx are worth another go; a 400 is a bug in the request
      // and will fail identically every time.
      if (!isRetryable(error) || attempt === maxAttempts) {
        throw new JudgeError(
          `Judge request failed: ${error instanceof Error ? error.message : String(error)}`,
          attempt,
          error,
        );
      }
      lastError = error;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    // The API declined to look. HTTP 200, one call, never retried.
    if (response.stop_reason === 'refusal') {
      return { ok: false, reason: 'model_refusal' };
    }

    // Truncated mid-JSON. Worth exactly one retry, at a higher ceiling -
    // retrying at the ceiling that just truncated changes nothing.
    if (response.stop_reason === 'max_tokens' && !truncationRetried) {
      truncationRetried = true;
      maxTokens = TRUNCATION_RETRY_MAX_TOKENS;
      continue;
    }

    try {
      const parsed = parseReply(textOf(response.content), options.onAnomaly);
      if (parsed.status === 'declined') {
        // The model looked and decided. Its reasons are a subset of
        // DeclineReason by construction.
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, assessment: parsed.assessment };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  throw new JudgeError(
    `Judge returned nothing valid after ${maxAttempts} attempts`,
    maxAttempts,
    lastError,
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) {
    return true;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return true;
  }
  if (error instanceof Anthropic.APIError) {
    return typeof error.status === 'number' && error.status >= 500;
  }
  return false;
}
