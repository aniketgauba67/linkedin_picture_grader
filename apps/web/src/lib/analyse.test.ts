import { describe, expect, it, vi } from 'vitest';

import { analyse, AnalysisError, quickReject, type AnalyseDeps, type Stage } from './analyse';

const SHA = 'a'.repeat(64);
const PHOTO_ID = '11111111-2222-3333-4444-555555555555';

function fileOf(bytes = 1024, type = 'image/jpeg', name = 'photo.jpg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const features = {
  sharpnessLaplacian: 400, sharpnessEyeRegion: 350, eyeRegionMeasured: true,
  jpegQualityEstimate: 90, exposureMean: 120, clippedHighlights: 0.001, clippedShadows: 0.001,
  dynamicRange: 210, faceExposureMean: 118, faceClippedHighlights: 0.002, faceClippedShadows: 0.003,
  faceRegionMeasured: true, exposureDelta: 2, width: 1200, height: 1600, faceAreaRatio: 0.18,
  faceCenterOffsetX: 0, faceCenterOffsetY: 0, faceCount: 1, yaw: 2, roll: 0.5, pitch: null,
  eyeOpenness: null, smileIntensity: null, primaryFaceConfidence: 0.94, secondLargestFaceRatio: 0,
  isGrayscale: false, aspectExtreme: false, sourceFormat: 'jpeg', extractorVersion: 'v7',
};

/** Evidence strings are length-checked by the rubric schema. */
const ev = (what: string): string => `The photograph shows ${what} clearly.`;
const ASSESSMENT = {
  background: { evidence: ev('a plain wall behind the subject'), score: 4 },
  attire: { evidence: ev('a collared shirt'), score: 4 },
  expression: { evidence: ev('eye contact with the camera'), score: 4 },
  solo: { evidence: ev('one subject and no bystanders'), score: 5 },
  framing_observation: { crop: 'head_and_shoulders' as const, face_roughly_centered: true },
};

const scoreResult = {
  score: 7.4, axes: { sharpness: 4, lighting: 4, resolution: 5, framing: 3, background: 4, attire: 4, expression: 4, solo: 5 },
  context: 'corporate', fixes: [], confidence: 0.9, weightsVersion: '2026-09-24.2', coverage: 'full',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface RouteStubs {
  uploadUrl?: () => Response;
  put?: () => Response;
  extract?: () => Response;
  score?: () => Response;
}

function deps(stubs: RouteStubs = {}, stages: Stage[] = []): AnalyseDeps {
  return {
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'anon-key',
    sha256: async () => SHA,
    onStage: (stage) => stages.push(stage),
    fetch: (async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/api/upload-url')) {
        return (stubs.uploadUrl ?? (() =>
          json({ photoId: PHOTO_ID, storagePath: 'x.jpg', signedUrl: 'https://storage/upload', token: 't', expiresInSeconds: 120 })))();
      }
      if (target === 'https://storage/upload') {
        expect(init?.method).toBe('PUT');
        return (stubs.put ?? (() => new Response(null, { status: 200 })))();
      }
      if (target.endsWith('/api/extract')) {
        return (stubs.extract ?? (() =>
          json({ photoId: PHOTO_ID, features, extractorVersion: 'v7', featuresCached: false, assessment: ASSESSMENT, declined: null })))();
      }
      if (target.endsWith('/functions/v1/score')) {
        // The Edge function reads body.photoId and 400s on anything
        // else. Asserting it here is the only unit-level guard against
        // a parameter rename that a stubbed fetch would otherwise
        // happily accept.
        const sent: unknown = JSON.parse(String(init?.body ?? '{}'));
        expect(sent).toMatchObject({ photoId: PHOTO_ID });
        return (stubs.score ?? (() => json({ status: 'scored', result: scoreResult })))();
      }
      throw new Error(`unexpected fetch to ${target}`);
    }) as typeof globalThis.fetch,
  };
}

describe('quickReject', () => {
  it('saves a round trip on the obvious cases', () => {
    expect(quickReject(fileOf(0))).toMatch(/empty/);
    expect(quickReject(fileOf(11 * 1024 * 1024))).toMatch(/under 10MB/);
    expect(quickReject(fileOf(1024, 'application/pdf'))).toMatch(/JPEG, PNG or WebP/);
    expect(quickReject(fileOf())).toBeNull();
  });
});

describe('the happy path', () => {
  it('runs select -> authorize -> PUT -> extract -> score', async () => {
    const stages: Stage[] = [];
    const result = await analyse({ file: fileOf() }, deps({}, stages));
    expect(result.photoId).toBe(PHOTO_ID);
    expect(result.outcome.status).toBe('scored');
    expect(stages).toEqual(['hashing', 'uploading', 'analysing', 'scoring', 'done']);
  });

  it('uploads the original bytes unmodified', async () => {
    let body: unknown;
    const file = fileOf();
    const d = deps();
    const spy: typeof globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://storage/upload') body = init?.body;
      return d.fetch(url as string, init);
    };
    await analyse({ file }, { ...d, fetch: spy });
    // The File itself, not a canvas re-encode: the server re-hashes
    // these bytes and a mutation becomes a hash mismatch.
    expect(body).toBe(file);
  });

  it('parses the score through the shared schema, not a local interface', async () => {
    const result = await analyse({ file: fileOf() }, deps());
    if (result.outcome.status !== 'scored') throw new Error('expected a score');
    expect(result.outcome.result.score).toBe(7.4);
  });
});

describe('success outcomes that are not a plain score', () => {
  it('carries a no-face decline with its computed axes', async () => {
    const declined = {
      status: 'declined', reason: 'no_face', message: 'No face was found in this image.',
      score: { ...scoreResult, score: 2, coverage: 'partial', axes: { sharpness: 4, lighting: 4, resolution: 5, framing: 1 } },
    };
    const result = await analyse({ file: fileOf() }, deps({ score: () => json(declined) }));
    expect(result.outcome.status).toBe('declined');
    if (result.outcome.status !== 'declined') throw new Error('unreachable');
    expect(result.outcome.score?.score).toBe(2);
    // The four judged axes were never requested and must not appear.
    expect(Object.keys(result.outcome.score?.axes ?? {})).not.toContain('background');
  });

  it('accepts a decline that carries no score at all', async () => {
    const result = await analyse(
      { file: fileOf() },
      deps({ score: () => json({ status: 'declined', reason: 'corrupt_file', message: 'Could not decode.' }) }),
    );
    if (result.outcome.status !== 'declined') throw new Error('expected a decline');
    expect(result.outcome.score).toBeUndefined();
  });
});

describe('typed failures', () => {
  const failing = async (stubs: RouteStubs): Promise<AnalysisError> => {
    try {
      await analyse({ file: fileOf() }, deps(stubs));
    } catch (error) {
      if (error instanceof AnalysisError) return error;
      throw error;
    }
    throw new Error('expected a failure');
  };

  it('surfaces the route message for a rate limit, with its retry-after', async () => {
    const error = await failing({
      uploadUrl: () => json({ error: 'Too many uploads from this address. Try again later.' }, 429, { 'retry-after': '90' }),
    });
    expect(error.stage).toBe('authorize');
    expect(error.message).toMatch(/Too many uploads/);
    expect(error.retryAfterSeconds).toBe(90);
  });

  it.each([
    ['not_an_image', 415, 'That file is not a image/jpeg, image/png, image/webp image.'],
    ['hash_mismatch', 409, 'The uploaded bytes do not match the hash that was registered for them.'],
    ['too_small', 422, 'This image is too small to score.'],
  ])('surfaces the %s rejection from /api/extract', async (_code, status, message) => {
    const error = await failing({ extract: () => json({ error: message }, status) });
    expect(error.stage).toBe('extract');
    expect(error.message).toBe(message);
    // The bytes are in Storage, so this is resumable.
    expect(error.canResume).toBe(true);
    expect(error.photoId).toBe(PHOTO_ID);
  });

  it('treats a failed Storage PUT as NOT resumable', async () => {
    const error = await failing({ put: () => new Response(null, { status: 403 }) });
    expect(error.stage).toBe('upload');
    expect(error.canResume).toBe(false);
  });

  it('never leaks a non-JSON provider body', async () => {
    const error = await failing({
      extract: () => new Response('<html>nginx 502 Bad Gateway</html>', { status: 502 }),
    });
    expect(error.message).toBe('Could not analyse this photo.');
    expect(error.message).not.toMatch(/nginx|html/i);
  });

  it('surfaces a scoring failure as resumable', async () => {
    const error = await failing({ score: () => json({ error: 'Could not score this photo.' }, 503) });
    expect(error.stage).toBe('score');
    expect(error.canResume).toBe(true);
  });

  it('rejects an unsupported file before any network call', async () => {
    const fetchSpy = vi.fn();
    await expect(
      analyse({ file: fileOf(1024, 'image/gif') }, { ...deps(), fetch: fetchSpy as never }),
    ).rejects.toThrow(/JPEG, PNG or WebP/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('retry and idempotency', () => {
  it('resumes from the photoId without re-uploading the bytes', async () => {
    const seen: string[] = [];
    const base = deps();
    const spy: typeof globalThis.fetch = async (url, init) => {
      seen.push(String(url));
      return base.fetch(url as string, init);
    };
    const stages: Stage[] = [];
    await analyse(
      { file: fileOf(), resumePhotoId: PHOTO_ID },
      { ...base, fetch: spy, onStage: (s) => stages.push(s) },
    );
    expect(seen.some((u) => u.endsWith('/api/upload-url'))).toBe(false);
    expect(seen.some((u) => u === 'https://storage/upload')).toBe(false);
    expect(seen.some((u) => u.endsWith('/api/extract'))).toBe(true);
    // Hashing and uploading are skipped entirely on a resume.
    expect(stages).toEqual(['analysing', 'scoring', 'done']);
  });

  it('does not retry automatically - one attempt per call', async () => {
    let extractCalls = 0;
    await expect(
      analyse({ file: fileOf() }, deps({
        extract: () => {
          extractCalls += 1;
          return json({ error: 'Could not analyse this photo.' }, 500);
        },
      })),
    ).rejects.toThrow(AnalysisError);
    expect(extractCalls).toBe(1);
  });
});
