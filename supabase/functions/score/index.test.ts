import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisOutcome } from '@pps/schema';

const PHOTO_ID = '11111111-1111-4111-8111-111111111111';
type Handler = (request: Request) => Promise<Response>;

const vector = {
  width: 1600,
  height: 1600,
  sharpnessLaplacian: 400,
  sharpnessEyeRegion: 480,
  eyeRegionMeasured: true,
  jpegQualityEstimate: 92,
  dynamicRange: 190,
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: true,
  exposureDelta: 10,
  clippedHighlights: 0.003,
  clippedShadows: 0.003,
  faceAreaRatio: 0.16,
  faceCenterOffsetX: 0.01,
  faceCenterOffsetY: -0.03,
  faceCount: 1,
  exposureMean: 128,
  extractorVersion: 'v7',
  yaw: 2,
  pitch: null,
  roll: 1,
  eyeOpenness: null,
  smileIntensity: null,
  primaryFaceConfidence: 0.91,
  secondLargestFaceRatio: null,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
};

const judgedAxis = (score: number) => ({ evidence: 'Visible detail in the photograph.', score });
const assessment = {
  status: 'assessed',
  assessment: {
    background: judgedAxis(4),
    attire: judgedAxis(4),
    expression: judgedAxis(4),
    solo: judgedAxis(5),
    framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
  },
};

function request(): Request {
  return new Request('http://localhost/functions/v1/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photoId: PHOTO_ID, context: 'corporate' }),
  });
}

async function setup(
  faceCount: number,
  storedAssessment: unknown | null,
  featureOverrides: Record<string, unknown> = {},
): Promise<{
  handler: Handler;
  calls: string[];
  inserts: Array<Record<string, unknown>>;
}> {
  const calls: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  let handler: Handler | undefined;
  vi.stubGlobal('Deno', {
    env: { get: (key: string) => key === 'SUPABASE_URL' ? 'https://db.example.test' : 'service-key' },
    serve: (callback: Handler) => { handler = callback; },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}?${url.searchParams}`);
    if (url.pathname.endsWith('/features')) {
      expect(url.searchParams.get('photo_id')).toBe(`eq.${PHOTO_ID}`);
      const computed = {
        ...vector,
        faceCount,
        ...(faceCount === 0 ? {
          sharpnessEyeRegion: null,
          eyeRegionMeasured: false,
          primaryFaceConfidence: null,
          faceAreaRatio: 0,
        } : {}),
        ...featureOverrides,
      };
      const response = Response.json([]);
      // Model the decoded PostgREST row directly so non-finite values can
      // exercise the Edge trust boundary even though JSON cannot encode them.
      vi.spyOn(response, 'json').mockResolvedValue([{ computed, extractor_version: 'v7' }]);
      return response;
    }
    if (url.pathname.endsWith('/assessments')) {
      expect(url.searchParams.get('photo_id')).toBe(`eq.${PHOTO_ID}`);
      expect(url.searchParams.get('source')).toBe('eq.vlm');
      expect(url.searchParams.get('model')).toBe('eq.claude-sonnet-5');
      return Response.json(storedAssessment === null ? [] : [{ axes: storedAssessment }]);
    }
    if (url.pathname.endsWith('/scores') && init?.method === 'POST') {
      inserts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected request to ${url}`);
  }));
  vi.resetModules();
  await import('./index.ts');
  if (handler === undefined) throw new Error('Deno.serve did not register a handler');
  return { handler, calls, inserts };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('Edge scoring on the current tables', () => {
  it('scores a face using the active VLM model and appends the score', async () => {
    const { handler, calls, inserts } = await setup(1, assessment);
    const response = await handler(request());
    expect(response.status).toBe(200);
    const outcome = AnalysisOutcome.parse(await response.json());
    expect(outcome.status).toBe('scored');
    if (outcome.status === 'scored') {
      expect(outcome.result.coverage).toBe('full');
      expect(outcome.result.axes.solo).toBe(5);
    }
    expect(calls.some((call) => call.includes('/features?'))).toBe(true);
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ photo_id: PHOTO_ID, context: 'corporate' });
  });

  it('scores a valid face with nullable measurements still absent', async () => {
    const { handler, inserts } = await setup(1, assessment, {
      sharpnessEyeRegion: null,
      eyeRegionMeasured: false,
      pitch: null,
      eyeOpenness: null,
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    const outcome = AnalysisOutcome.parse(await response.json());
    expect(outcome.status).toBe('scored');
    expect(inserts).toHaveLength(1);
  });

  it('returns a partial no-face decline for measured faceCount zero without requesting an assessment', async () => {
    const { handler, calls, inserts } = await setup(0, null);
    const response = await handler(request());
    expect(response.status).toBe(200);
    const outcome = AnalysisOutcome.parse(await response.json());
    expect(outcome.status).toBe('declined');
    if (outcome.status === 'declined') {
      expect(outcome.reason).toBe('no_face');
      expect(outcome.score?.coverage).toBe('partial');
      expect(outcome.score?.confidence).toBe(0.55);
      expect(outcome.score?.axes.sharpness).toBeDefined();
      expect(outcome.score?.axes.lighting).toBeDefined();
      expect(outcome.score?.axes.background).toBeUndefined();
      expect(outcome.score?.axes.attire).toBeUndefined();
      expect(outcome.score?.axes.expression).toBeUndefined();
      expect(outcome.score?.axes.solo).toBeUndefined();
    }
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(1);
  });

  it.each([
    ['missing required field', { exposureDelta: undefined }],
    ['non-finite NaN', { dynamicRange: Number.NaN }],
    ['non-finite Infinity', { faceExposureMean: Number.POSITIVE_INFINITY }],
    ['below-range value', { faceAreaRatio: -0.1 }],
    ['above-range value', { clippedHighlights: 1.1 }],
    ['invalid count', { faceCount: 1.5 }],
    ['invalid field outside the scoring subset', { eyeOpenness: 1.4 }],
    ['missing nullable field instead of explicit null', { pitch: undefined }],
    ['eye-region cross-field mismatch', { sharpnessEyeRegion: null, eyeRegionMeasured: true }],
  ])('rejects a persisted feature row with %s before scoring', async (_case, overrides) => {
    const { handler, calls, inserts } = await setup(1, assessment, overrides);
    const response = await handler(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Cached features are unusable',
      photoId: PHOTO_ID,
    });
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it('enforces the zero-face confidence cross-field invariant', async () => {
    const { handler, calls, inserts } = await setup(0, null, { primaryFaceConfidence: 0.91 });
    const response = await handler(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Cached features are unusable',
      photoId: PHOTO_ID,
    });
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it.each([
    ['199px width with a face', 199, 300, 1],
    ['199px height with a face', 300, 199, 1],
    ['199px width with no face', 199, 300, 0],
    ['199px height with no face', 300, 199, 0],
  ])('rejects %s before assessment lookup or scoring', async (_case, width, height, faceCount) => {
    const { handler, calls, inserts } = await setup(faceCount, null, { width, height });
    const response = await handler(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'Images must be at least 200px on the shorter edge.',
      code: 'below_dimension_floor',
      photoId: PHOTO_ID,
    });
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it.each([
    ['width', 200, 300],
    ['height', 300, 200],
  ])('scores a face at the exact 200px %s boundary', async (_case, width, height) => {
    const { handler, calls, inserts } = await setup(1, assessment, { width, height });
    const response = await handler(request());
    expect(response.status).toBe(200);
    const outcome = AnalysisOutcome.parse(await response.json());
    expect(outcome.status).toBe('scored');
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it('keeps an eligible 200px no-face image on the partial decline path', async () => {
    const { handler, calls, inserts } = await setup(0, null, { width: 200, height: 300 });
    const response = await handler(request());
    expect(response.status).toBe(200);
    const outcome = AnalysisOutcome.parse(await response.json());
    expect(outcome.status).toBe('declined');
    if (outcome.status === 'declined') {
      expect(outcome.reason).toBe('no_face');
      expect(outcome.score?.coverage).toBe('partial');
    }
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(1);
  });

  it('validates malformed dimensions before checking eligibility', async () => {
    const { handler, calls, inserts } = await setup(1, assessment, { width: 0, height: 300 });
    const response = await handler(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Cached features are unusable', photoId: PHOTO_ID });
    expect(calls.some((call) => call.includes('/assessments?'))).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it('reports a face with no VLM assessment as incomplete', async () => {
    const { handler, inserts } = await setup(1, null);
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'Assessment not recorded yet' });
    expect(inserts).toHaveLength(0);
  });
});

describe('CORS, so a browser can reach this at all', () => {
  // Found only by running the real page. Node's fetch does not enforce
  // CORS, so every script-level test passed while the browser got
  // "Failed to fetch" and never delivered the POST at all.
  it('answers the preflight instead of falling through to 405', async () => {
    const { handler } = await setup(1, assessment);
    const response = await handler(
      new Request('http://localhost/score', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3123',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,apikey,authorization',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('allows the headers Supabase Edge invocation actually sends', async () => {
    // A header missing from this list fails the preflight even when the
    // method is allowed, which is how this broke the first time.
    const { handler } = await setup(1, assessment);
    const response = await handler(new Request('http://localhost/score', { method: 'OPTIONS' }));
    const allowed = response.headers.get('access-control-allow-headers') ?? '';
    for (const header of ['authorization', 'apikey', 'content-type']) {
      expect(allowed, header).toContain(header);
    }
  });

  it('puts the headers on ordinary answers too, not only the preflight', async () => {
    const { handler } = await setup(1, assessment);
    const response = await handler(
      new Request('http://localhost/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photoId: 'not-a-uuid' }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('internal failures stay internal', () => {
  // This function answers unauthenticated browser callers by design, so
  // a raw PostgREST or zod message here is internal schema detail handed
  // to anyone who asks.
  it('does not return the underlying error text to the caller', async () => {
    const { handler } = await setup(1, assessment);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('relation "public.features" violates constraint features_pkey');
    }));
    const response = await handler(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toMatch(/relation|constraint|features_pkey/);
    expect(body.error).toBe('Scoring failed.');
  });

  it('still carries CORS headers on a sanitized failure', async () => {
    const { handler } = await setup(1, assessment);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    const response = await handler(request());
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
