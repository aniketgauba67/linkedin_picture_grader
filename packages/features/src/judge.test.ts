import { beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Assessment } from '@pps/schema';
import { toRubricResponse } from './rubric.js';
import {
  JudgeError,
  TRUNCATION_RETRY_MAX_TOKENS,
  judgePhoto,
  parseReply,
  toJudgeImage,
} from './judge.js';
import { AssessmentSchema, MAX_TOKENS, MODEL, OUTPUT_JSON_SCHEMA, buildRequest } from './rubric.js';

/**
 * NO TEST HERE MAY REACH THE NETWORK. CI has no ANTHROPIC_API_KEY and
 * never will; the SDK is mocked in every case below and the guard makes
 * that enforced rather than trusted.
 */
describe('test environment', () => {
  it('has no ANTHROPIC_API_KEY, so a leaked real call cannot succeed', () => {
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});

const assessment: Assessment = {
  background: { evidence: 'plain grey wall with no objects on it', score: 4 },
  attire: { evidence: 'open collar button-down shirt, no jacket', score: 3 },
  expression: { evidence: 'eyes to camera, slight closed-mouth smile', score: 4 },
  solo: { evidence: 'one person in frame, no other limbs visible', score: 5 },
  framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
};

/** The FLAT wire shape the API actually returns - `oneOf` is rejected. */
const assessed = JSON.stringify({
  status: 'assessed',
  assessment,
  reason: null,
  detail: null,
});

/** A stand-in for the SDK. Every case drives it, nothing drives the network. */
function mockClient(replies: readonly unknown[]) {
  const create = vi.fn();
  for (const reply of replies) {
    if (reply instanceof Error) {
      create.mockRejectedValueOnce(reply);
    } else {
      create.mockResolvedValueOnce(reply);
    }
  }
  return { client: { messages: { create } } as never, create };
}

const reply = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text }],
});

const noSleep = async (): Promise<void> => undefined;

let photo: Buffer;
beforeAll(async () => {
  photo = await sharp({
    create: { width: 300, height: 400, channels: 3, background: { r: 120, g: 110, b: 100 } },
  })
    .jpeg()
    .toBuffer();
});

describe('buildRequest', () => {
  it('never sends an assistant prefill or a sampling parameter', () => {
    // Both return HTTP 400 on claude-sonnet-5. This asserts the banner in
    // rubric.ts rather than trusting anyone to read it.
    const request = buildRequest({ imageBase64: 'AAAA' }) as Record<string, unknown>;
    expect(request['temperature']).toBeUndefined();
    expect(request['top_p']).toBeUndefined();
    expect(request['top_k']).toBeUndefined();
    const messages = request['messages'] as { role: string }[];
    expect(messages.every((m) => m.role === 'user')).toBe(true);
  });

  it('constrains the output with a json_schema instead', () => {
    const request = buildRequest({ imageBase64: 'AAAA' }) as Record<string, unknown>;
    const output = request['output_config'] as Record<string, Record<string, unknown>>;
    expect(output['effort']).toBe('low');
    expect(output['format']?.['type']).toBe('json_schema');
    expect(output['format']?.['schema']).toBe(OUTPUT_JSON_SCHEMA);
  });

  it('uses the pinned model and token ceiling', () => {
    const request = buildRequest({ imageBase64: 'AAAA' }) as Record<string, unknown>;
    expect(request['model']).toBe(MODEL);
    expect(MODEL).toBe('claude-sonnet-5');
    expect(request['max_tokens']).toBe(MAX_TOKENS);
  });

  it('uses only the JSON Schema keywords the API actually accepts', () => {
    // Each of these was verified by a real 400 from the live API:
    //   oneOf            "Schema type 'oneOf' is not supported"
    //   minimum/maximum  "For 'integer' type, properties maximum, minimum
    //                     are not supported"
    // and a nullable type carrying an enum was rejected with
    //   "Enum value 'no_face' does not match declared type
    //    '['string', 'null']'"
    // so `reason` is a bare enum with no declared type.
    const serialized = JSON.stringify(OUTPUT_JSON_SCHEMA);
    for (const unsupported of ['oneOf', 'anyOf', 'allOf', 'minimum', 'maximum', 'minLength', 'maxLength']) {
      expect(serialized, `${unsupported} is rejected by the API`).not.toContain(unsupported);
    }
  });

  it('keeps content validation in zod, since the schema cannot express it', () => {
    // The schema constrains shape only; evidence length and score range
    // are enforced when the reply is parsed.
    expect(
      AssessmentSchema.safeParse({
        ...assessment,
        background: { evidence: 'busy', score: 2 },
      }).success,
    ).toBe(false);
  });

  it('forbids sibling keys at every level of the output schema', () => {
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const type = record['type'];
      const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
      if (isObject) {
        expect(record['additionalProperties']).toBe(false);
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(OUTPUT_JSON_SCHEMA);
  });
});

describe('toJudgeImage', () => {
  it('produces base64 JPEG within the judge edge', async () => {
    const base64 = await toJudgeImage(photo);
    const bytes = Buffer.from(base64, 'base64');
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
    expect(base64).not.toContain('\n');
  });
});

describe('judgePhoto', () => {
  it('returns the assessment for a well-formed reply', async () => {
    const { client, create } = mockClient([reply(assessed)]);
    const outcome = await judgePhoto(photo, { client, sleep: noSleep });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected an assessment');
    expect(outcome.assessment.background.score).toBe(4);
    expect(outcome.assessment.framing_observation.crop).toBe('head_and_shoulders');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('parses a fenced reply — DEFENSIVE, should be unreachable with structured outputs', async () => {
    const anomalies: string[] = [];
    const { client } = mockClient([reply('```json\n' + assessed + '\n```')]);
    const outcome = await judgePhoto(photo, {
      client,
      sleep: noSleep,
      onAnomaly: (note) => anomalies.push(note),
    });
    expect(outcome.ok).toBe(true);
    // If this ever fires in production the schema constraint did not hold.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatch(/fence/);
  });

  it('parses a reply with a preamble — DEFENSIVE, should be unreachable', async () => {
    const anomalies: string[] = [];
    const { client } = mockClient([reply(`Here is the assessment:\n${assessed}`)]);
    const outcome = await judgePhoto(photo, {
      client,
      sleep: noSleep,
      onAnomaly: (note) => anomalies.push(note),
    });
    expect(outcome.ok).toBe(true);
    expect(anomalies[0]).toMatch(/text around the JSON/);
  });

  it('retries malformed JSON and succeeds on the second call', async () => {
    const { client, create } = mockClient([reply('{ not json at all'), reply(assessed)]);
    const outcome = await judgePhoto(photo, { client, sleep: noSleep });
    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('treats a refusal as a decline and costs EXACTLY ONE call', async () => {
    // stop_reason "refusal" arrives on an HTTP 200, so it is handled in
    // the success path. Asking again would bill for the same answer.
    const { client, create } = mockClient([
      { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] },
      reply(assessed),
    ]);
    const outcome = await judgePhoto(photo, { client, sleep: noSleep });

    expect(outcome).toEqual({ ok: false, reason: 'model_refusal' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('returns apparent_minor without throwing, and without a retry', async () => {
    const declined = JSON.stringify({
      status: 'declined',
      assessment: null,
      reason: 'apparent_minor',
      detail: 'This service only assesses photographs of adults.',
    });
    const { client, create } = mockClient([reply(declined)]);
    const outcome = await judgePhoto(photo, { client, sleep: noSleep });

    expect(outcome).toEqual({ ok: false, reason: 'apparent_minor' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['no_face', 'not_a_photo'] as const)('maps a %s decline straight through', async (reason) => {
    const declined = JSON.stringify({
      status: 'declined',
      assessment: null,
      reason,
      detail: 'nothing to assess',
    });
    const { client } = mockClient([reply(declined)]);
    expect(await judgePhoto(photo, { client, sleep: noSleep })).toEqual({ ok: false, reason });
  });

  it('retries a truncated reply once, at a higher ceiling', async () => {
    const { client, create } = mockClient([
      reply('{"status":"assess', 'max_tokens'),
      reply(assessed),
    ]);
    const outcome = await judgePhoto(photo, { client, sleep: noSleep });

    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1]?.[0] as { max_tokens: number };
    expect(second.max_tokens).toBe(TRUNCATION_RETRY_MAX_TOKENS);
    expect(second.max_tokens).toBeGreaterThan(MAX_TOKENS);
  });

  it('recovers from a 429 and reports the backoff it waited', async () => {
    const waits: number[] = [];
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    Object.setPrototypeOf(rateLimited, (await import('@anthropic-ai/sdk')).default.RateLimitError.prototype);

    const { client, create } = mockClient([rateLimited, reply(assessed)]);
    const outcome = await judgePhoto(photo, {
      client,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([500]);
  });

  it('throws a typed JudgeError only after the budget is exhausted', async () => {
    const { client, create } = mockClient([
      reply('nonsense'),
      reply('still nonsense'),
      reply('nonsense again'),
    ]);
    await expect(judgePhoto(photo, { client, sleep: noSleep })).rejects.toBeInstanceOf(JudgeError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request the API rejected as malformed', async () => {
    // A 400 fails identically every time; retrying burns the budget.
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    const { client, create } = mockClient([badRequest, reply(assessed)]);
    await expect(judgePhoto(photo, { client, sleep: noSleep })).rejects.toBeInstanceOf(JudgeError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects a reply whose evidence is too thin to justify a score', async () => {
    const thin = JSON.stringify({
      status: 'assessed',
      assessment: { ...assessment, background: { evidence: 'busy', score: 2 } },
      reason: null,
      detail: null,
    });
    const { client } = mockClient([reply(thin), reply(thin), reply(thin)]);
    await expect(judgePhoto(photo, { client, sleep: noSleep })).rejects.toBeInstanceOf(JudgeError);
  });
});

describe('toRubricResponse', () => {
  it('rejects a wire reply whose branches contradict its status', () => {
    // Flattening loses the guarantee the union gave for free, so the
    // two halves are re-checked rather than assumed.
    expect(() =>
      toRubricResponse({ status: 'assessed', assessment: null, reason: null, detail: null }),
    ).toThrow(/no assessment/);
    expect(() =>
      toRubricResponse({ status: 'declined', assessment: null, reason: null, detail: 'x' }),
    ).toThrow(/no reason/);
  });

  it('normalises a flat reply back into the discriminated union', () => {
    const union = toRubricResponse({
      status: 'declined',
      assessment: null,
      reason: 'no_face',
      detail: 'nothing to assess',
    });
    expect(union).toEqual({ status: 'declined', reason: 'no_face', detail: 'nothing to assess' });
  });
});

describe('parseReply', () => {
  it('throws when there is no JSON at all', () => {
    expect(() => parseReply('I cannot help with that.')).toThrow(SyntaxError);
  });

  it('reports no anomaly on the happy path', () => {
    const anomalies: string[] = [];
    parseReply(assessed, (note) => anomalies.push(note));
    expect(anomalies).toEqual([]);
  });
});
