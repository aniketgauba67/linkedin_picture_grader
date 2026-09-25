import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ImageDecodeError, normalizeImage } from '@pps/features';
import type * as FeaturesModule from '@pps/features';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assessment, ComputedFeatures, PersistedAssessmentResponse } from '@pps/schema';

const mocks = vi.hoisted(() => ({
  extractAll: vi.fn(),
  judgePhoto: vi.fn(),
  getFeaturesByHash: vi.fn(),
  upsertFeatures: vi.fn(),
  claimExtraction: vi.fn(),
  releaseExtraction: vi.fn(),
  upsertAssessment: vi.fn(),
  insertPhoto: vi.fn(),
  serviceClient: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('@pps/features', async (importOriginal) => ({
  ...(await importOriginal<typeof FeaturesModule>()),
  extractAll: mocks.extractAll,
  judgePhoto: mocks.judgePhoto,
}));
vi.mock('@pps/db', () => ({
  getFeaturesByHash: mocks.getFeaturesByHash,
  upsertFeatures: mocks.upsertFeatures,
  claimExtraction: mocks.claimExtraction,
  releaseExtraction: mocks.releaseExtraction,
  upsertAssessment: mocks.upsertAssessment,
  insertPhoto: mocks.insertPhoto,
}));

vi.mock('@/lib/supabase', () => ({
  PHOTO_BUCKET: 'photos',
  UPLOAD_URL_TTL_SECONDS: 120,
  serviceClient: mocks.serviceClient,
}));

import { POST as extract } from './route';
import { POST as uploadUrl } from '../upload-url/route';

const PHOTO_A = '11111111-1111-4111-8111-111111111111';
const PHOTO_B = '22222222-2222-4222-8222-222222222222';
const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
const SHA = createHash('sha256').update(BYTES).digest('hex');

const features: ComputedFeatures = {
  sharpnessLaplacian: 260,
  sharpnessEyeRegion: null,
  eyeRegionMeasured: false,
  jpegQualityEstimate: 84,
  exposureMean: 130,
  clippedHighlights: 0.006,
  clippedShadows: 0.004,
  dynamicRange: 186,
  faceExposureMean: 118,
  faceClippedHighlights: 0.002,
  faceClippedShadows: 0.003,
  faceRegionMeasured: false,
  exposureDelta: 4,
  width: 1500,
  height: 1500,
  faceAreaRatio: 0,
  faceCenterOffsetX: 0,
  faceCenterOffsetY: 0,
  faceCount: 0,
  yaw: 0,
  pitch: null,
  roll: 0,
  eyeOpenness: 0,
  smileIntensity: 0,
  primaryFaceConfidence: null,
  secondLargestFaceRatio: null,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
  extractorVersion: 'v7',
};

const faceFeatures: ComputedFeatures = {
  ...features,
  faceCount: 1,
  faceAreaRatio: 0.12,
  primaryFaceConfidence: 0.9,
  sharpnessEyeRegion: 310,
  eyeRegionMeasured: true,
  faceRegionMeasured: true,
};

const judgedAssessment: Assessment = {
  background: { score: 4, evidence: 'A plain wall is visible behind the face.' },
  attire: { score: 4, evidence: 'A dark jacket is visible in the photograph.' },
  expression: { score: 4, evidence: 'The face has a relaxed expression.' },
  solo: { score: 5, evidence: 'Only one person is visible in the frame.' },
  framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
};

const photos = new Map<string, { id: string; storage_path: string; sha256: string; deleted_at: null }>();
const stored = new Map<string, Uint8Array>();
const storedMime = new Map<string, string | null>();
const storedMetadataMime = new Map<string, string | null>();
const globalFeatures = new Map<string, ComputedFeatures>();
const photoFeatures = new Map<string, ComputedFeatures>();
const assessments = new Map<string, PersistedAssessmentResponse>();
const assessmentReads: Array<Record<string, string>> = [];
let assessmentReadError: { message: string } | null = null;
let photoReadError: { message: string } | null = null;
let storageDownloadError: { message: string } | null = null;

function assessmentKey(photoId: string, model: string): string {
  return `${photoId}:vlm:${model}`;
}

function query(data: unknown, error: { message: string } | null = null): object {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data, error }),
  };
  return chain;
}

function register(photoId: string, bytes: Uint8Array, claimedSha = SHA, declaredMime: string | null = 'image/jpeg'): void {
  const path = `${photoId}.jpg`;
  photos.set(photoId, { id: photoId, storage_path: path, sha256: claimedSha, deleted_at: null });
  stored.set(path, bytes);
  storedMime.set(path, declaredMime);
  storedMetadataMime.set(path, declaredMime);
}

function request(photoId: string): Request {
  return new Request('http://localhost/api/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify({ photoId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  mocks.consumeRateLimit.mockReturnValue({
    abortSignal: async () => ({
      data: { allowed: true, bucket: null, retryAfterSeconds: 0 },
      error: null,
    }),
  });
  photos.clear();
  stored.clear();
  storedMime.clear();
  storedMetadataMime.clear();
  globalFeatures.clear();
  photoFeatures.clear();
  assessments.clear();
  assessmentReads.length = 0;
  assessmentReadError = null;
  photoReadError = null;
  storageDownloadError = null;
  mocks.judgePhoto.mockResolvedValue({ ok: true, assessment: judgedAssessment });
  mocks.upsertAssessment.mockImplementation(async (_client: unknown, input: {
    photoId: string; source: 'vlm'; model: string; response: PersistedAssessmentResponse;
  }) => {
    assessments.set(assessmentKey(input.photoId, input.model), input.response);
  });
  mocks.serviceClient.mockReturnValue({
    rpc: mocks.consumeRateLimit,
    from: (table: string) => {
      if (table === 'photos') {
        const chain = {
          select: () => chain,
          eq: (_column: string, id: string) => query(photos.get(id) ?? null, photoReadError),
        };
        return chain;
      }
      if (table === 'assessments') {
        const filters: Record<string, string> = {};
        const chain = {
          select: () => chain,
          eq: (column: string, value: string) => {
            filters[column] = value;
            return chain;
          },
          maybeSingle: async () => {
            assessmentReads.push({ ...filters });
            if (assessmentReadError !== null) return { data: null, error: assessmentReadError };
            const result = assessments.get(assessmentKey(filters['photo_id'] ?? '', filters['model'] ?? ''));
            return { data: result === undefined ? null : { axes: result }, error: null };
          },
        };
        return chain;
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: {
      from: () => ({
        download: async (path: string) => ({
          data: { arrayBuffer: async () => Uint8Array.from(stored.get(path) ?? []).buffer },
          error: storageDownloadError,
        }),
        info: async (path: string) => ({
          data: {
            contentType: storedMime.get(path) ?? undefined,
            metadata: storedMetadataMime.get(path) === null
              ? null
              : { mimetype: storedMetadataMime.get(path) },
          },
          error: null,
        }),
        createSignedUploadUrl: async () => ({ data: { signedUrl: 'https://storage.example/upload', token: 'token' }, error: null }),
      }),
    },
  });
  mocks.getFeaturesByHash.mockImplementation(async (_client: unknown, sha: string, version: string) => {
    const cached = globalFeatures.get(`${sha}:${version}`);
    return cached === undefined ? null : { sha256: sha, extractorVersion: version, features: cached };
  });
  mocks.upsertFeatures.mockImplementation(async (_client: unknown, input: {
    photoId: string; sha256: string; features: ComputedFeatures; extractorVersion: string;
  }) => {
    photoFeatures.set(input.photoId, input.features);
    globalFeatures.set(`${input.sha256}:${input.extractorVersion}`, input.features);
  });
  mocks.claimExtraction.mockResolvedValue('claim-token');
  mocks.releaseExtraction.mockResolvedValue(undefined);
  mocks.extractAll.mockResolvedValue(features);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('unexpected extraction failures', () => {
  it('does not expose a photo database error', async () => {
    register(PHOTO_A, BYTES);
    photoReadError = { message: 'private database connection detail' };
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Extraction failed.' });
    expect(console.error).toHaveBeenCalledWith('[api/extract] photo lookup', photoReadError);
    expect(mocks.extractAll).not.toHaveBeenCalled();
  });

  it('does not expose a Storage download error', async () => {
    register(PHOTO_A, BYTES);
    storageDownloadError = { message: 'private Storage bucket detail' };
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not read the uploaded file.' });
    expect(console.error).toHaveBeenCalledWith('[api/extract] storage download', storageDownloadError);
    expect(mocks.extractAll).not.toHaveBeenCalled();
  });
});

describe('verified SHA and feature cache', () => {
  it('reuses current cached features and associates them with this photo', async () => {
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, features);
    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ photoId: PHOTO_B, featuresCached: true });
    expect(mocks.getFeaturesByHash).toHaveBeenCalledWith(expect.anything(), SHA, 'v7');
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.claimExtraction).not.toHaveBeenCalled();
    expect(mocks.upsertFeatures).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ photoId: PHOTO_B, sha256: SHA }));
    expect(photoFeatures.get(PHOTO_B)).toEqual(features);
  });

  it('judges a new photo with a face after reusing another photo\'s features', async () => {
    register(PHOTO_A, BYTES);
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, faceFeatures);
    photoFeatures.set(PHOTO_A, faceFeatures);

    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      photoId: PHOTO_B,
      featuresCached: true,
      assessment: judgedAssessment,
      declined: null,
    });
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).toHaveBeenCalledOnce();
    expect(mocks.upsertAssessment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      photoId: PHOTO_B, source: 'vlm', model: 'claude-sonnet-5',
    }));
    expect(assessments.has(assessmentKey(PHOTO_A, 'claude-sonnet-5'))).toBe(false);
    expect(assessments.get(assessmentKey(PHOTO_B, 'claude-sonnet-5'))).toEqual({
      status: 'assessed', assessment: judgedAssessment,
    });
    expect(assessmentReads).toEqual([{
      photo_id: PHOTO_B, source: 'vlm', model: 'claude-sonnet-5',
    }]);
  });

  it('reuses this photo\'s existing active-model assessment on a cache hit', async () => {
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, faceFeatures);
    assessments.set(assessmentKey(PHOTO_B, 'claude-sonnet-5'), {
      status: 'assessed', assessment: judgedAssessment,
    });

    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      featuresCached: true, assessment: judgedAssessment, declined: null,
    });
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    expect(mocks.upsertAssessment).not.toHaveBeenCalled();
  });

  it('does not reuse an assessment from a different model', async () => {
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, faceFeatures);
    assessments.set(assessmentKey(PHOTO_B, 'older-model'), {
      status: 'assessed', assessment: judgedAssessment,
    });

    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(200);
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).toHaveBeenCalledOnce();
    expect(assessments.has(assessmentKey(PHOTO_B, 'older-model'))).toBe(true);
    expect(assessments.has(assessmentKey(PHOTO_B, 'claude-sonnet-5'))).toBe(true);
    expect(assessmentReads).toEqual([{
      photo_id: PHOTO_B, source: 'vlm', model: 'claude-sonnet-5',
    }]);
  });

  it('skips the judge for a no-face global cache hit', async () => {
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, features);
    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      featuresCached: true, assessment: null, judgeSkipped: 'no_face',
    });
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    expect(assessmentReads).toHaveLength(0);
  });

  it('fails on an uncertain assessment read without calling the judge', async () => {
    register(PHOTO_B, BYTES);
    globalFeatures.set(`${SHA}:v7`, faceFeatures);
    assessmentReadError = { message: 'database unavailable' };
    const response = await extract(request(PHOTO_B));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not read this photo assessment.' });
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    expect(mocks.upsertAssessment).not.toHaveBeenCalled();
  });

  it('extracts a verified cache miss and persists both feature identities', async () => {
    register(PHOTO_A, BYTES);
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ photoId: PHOTO_A, featuresCached: false });
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.claimExtraction).toHaveBeenCalledWith(expect.anything(), PHOTO_A, SHA, 'v7');
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), SHA, 'v7', 'claim-token');
    expect(photoFeatures.get(PHOTO_A)).toEqual(features);
    expect(globalFeatures.get(`${SHA}:v7`)).toEqual(features);
  });

  it('rejects a false SHA claim before cache access or extraction', async () => {
    const claimed = 'a'.repeat(64);
    register(PHOTO_A, BYTES, claimed);
    globalFeatures.set(`${claimed}:v7`, features);
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'hash_mismatch' });
    expect(mocks.getFeaturesByHash).not.toHaveBeenCalled();
    expect(mocks.claimExtraction).not.toHaveBeenCalled();
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.upsertFeatures).not.toHaveBeenCalled();
  });

  it('does not reuse a stale extractor version', async () => {
    register(PHOTO_A, BYTES);
    globalFeatures.set(`${SHA}:v6`, features);
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ featuresCached: false });
    expect(mocks.getFeaturesByHash).toHaveBeenCalledWith(expect.anything(), SHA, 'v7');
    expect(mocks.extractAll).toHaveBeenCalledOnce();
  });

  it('keeps separate photo rows for two sequential uploads of the same bytes', async () => {
    register(PHOTO_A, BYTES);
    register(PHOTO_B, BYTES);
    const first = await extract(request(PHOTO_A));
    const second = await extract(request(PHOTO_B));
    expect((await first.json()).featuresCached).toBe(false);
    expect((await second.json()).featuresCached).toBe(true);
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(photoFeatures.get(PHOTO_A)).toEqual(features);
    expect(photoFeatures.get(PHOTO_B)).toEqual(features);
    expect(photoFeatures.size).toBe(2);
  });

  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const)('accepts valid %s bytes declared as %s', async (format, mime) => {
    const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .toFormat(format).toBuffer();
    const digest = createHash('sha256').update(bytes).digest('hex');
    register(PHOTO_A, bytes, digest, mime);
    mocks.extractAll.mockResolvedValue({ ...features, sourceFormat: format });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(mocks.extractAll).toHaveBeenCalledWith(Buffer.from(bytes));
    expect(mocks.getFeaturesByHash).toHaveBeenCalledWith(expect.anything(), digest, 'v7');
  });

  it('rejects an unsupported signature before extraction or judging', async () => {
    const bytes = Buffer.from('GIF89a followed by non-image bytes');
    register(PHOTO_A, bytes, createHash('sha256').update(bytes).digest('hex'));
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'not_an_image' });
    expect(mocks.getFeaturesByHash).not.toHaveBeenCalled();
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
  });

  it('rejects a stored MIME that disagrees with the actual PNG bytes', async () => {
    const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .png().toBuffer();
    register(PHOTO_A, bytes, createHash('sha256').update(bytes).digest('hex'), 'image/jpeg');
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'mime_mismatch' });
    expect(mocks.getFeaturesByHash).not.toHaveBeenCalled();
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
  });

  it('also rejects contradictory Storage metadata MIME', async () => {
    const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .jpeg().toBuffer();
    register(PHOTO_A, bytes, createHash('sha256').update(bytes).digest('hex'), 'image/jpeg');
    storedMetadataMime.set(`${PHOTO_A}.jpg`, 'image/png');
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: 'mime_mismatch' });
    expect(mocks.extractAll).not.toHaveBeenCalled();
  });

  it('normalizes case and parameters on the stored canonical JPEG MIME', async () => {
    const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .jpeg().toBuffer();
    register(PHOTO_A, bytes, createHash('sha256').update(bytes).digest('hex'), 'IMAGE/JPEG; charset=binary');
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
  });

  it('rejects a 199px shorter edge before VLM, including on a cache hit', async () => {
    const small = { ...features, width: 199, height: 300, faceCount: 1 };
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockResolvedValue(small);
    const first = await extract(request(PHOTO_A));
    expect(first.status).toBe(422);
    expect(await first.json()).toMatchObject({ code: 'below_dimension_floor' });
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    const second = await extract(request(PHOTO_A));
    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({ code: 'below_dimension_floor' });
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
  });

  it('accepts exactly 200px on the shorter edge and still skips VLM for no face', async () => {
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockResolvedValue({ ...features, width: 200, height: 300, faceCount: 0 });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ judgeSkipped: 'no_face', assessment: null });
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
  });

  it('hashes the original EXIF-tagged bytes while using oriented dimensions', async () => {
    const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#808080' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const originalSha = createHash('sha256').update(bytes).digest('hex');
    register(PHOTO_A, bytes, originalSha);
    mocks.extractAll.mockResolvedValue({ ...features, width: 300, height: 200, faceCount: 0 });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(mocks.extractAll).toHaveBeenCalledWith(Buffer.from(bytes));
    expect(mocks.getFeaturesByHash).toHaveBeenCalledWith(expect.anything(), originalSha, 'v7');
    expect(mocks.claimExtraction).toHaveBeenCalledWith(expect.anything(), PHOTO_A, originalSha, 'v7');
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
  });

  it('persists model_refusal as a VLM result without judged axes', async () => {
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockResolvedValue({
      ...features,
      faceCount: 1,
      faceAreaRatio: 0.12,
      primaryFaceConfidence: 0.9,
      sharpnessEyeRegion: 310,
      eyeRegionMeasured: true,
      faceRegionMeasured: true,
    });
    mocks.judgePhoto.mockResolvedValue({ ok: false, reason: 'model_refusal' });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ declined: 'model_refusal', assessment: null });
    expect(mocks.upsertAssessment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      photoId: PHOTO_A,
      source: 'vlm',
      response: { status: 'declined', reason: 'model_refusal', detail: '' },
    }));
  });

  it('returns corrupt_file without a score or assessment after a plausible JPEG fails decoding', async () => {
    const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } })
      .jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 3));
    register(PHOTO_A, truncated, createHash('sha256').update(truncated).digest('hex'));
    await expect(normalizeImage(truncated)).rejects.toBeInstanceOf(ImageDecodeError);
    mocks.extractAll.mockImplementation(async (image: Buffer) => {
      await normalizeImage(image);
      return features;
    });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: 'This file could not be opened. Re-export it and upload it again.',
      code: 'corrupt_file',
    });
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    expect(mocks.upsertAssessment).not.toHaveBeenCalled();
    expect(mocks.upsertFeatures).not.toHaveBeenCalled();
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), createHash('sha256').update(truncated).digest('hex'), 'v7', 'claim-token');
  });

  it('registers the upload claim without reporting an unverified cache hit', async () => {
    mocks.insertPhoto.mockResolvedValue({ photo: { id: PHOTO_A }, deduped: false });
    const response = await uploadUrl(new Request('http://localhost/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ filename: 'portrait.jpg', contentType: 'image/jpeg', sha256: SHA }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.photoId).toBe(PHOTO_A);
    expect(body.signedUrl).toBe('https://storage.example/upload');
    expect(body).not.toHaveProperty('featuresCached');
    expect(mocks.getFeaturesByHash).not.toHaveBeenCalled();
    expect(mocks.insertPhoto).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sha256: SHA }));
  });

  it('returns 429 and Retry-After for a per-IP limit', async () => {
    register(PHOTO_A, BYTES);
    mocks.consumeRateLimit.mockReturnValue({
      abortSignal: async () => ({ data: { allowed: false, bucket: 'ip', retryAfterSeconds: 42 }, error: null }),
    });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(await response.json()).toEqual({ error: 'Too many uploads from this address. Try again later.' });
    expect(mocks.extractAll).not.toHaveBeenCalled();
  });

  it('returns 429 and Retry-After for the shared global limit', async () => {
    register(PHOTO_A, BYTES);
    mocks.consumeRateLimit.mockReturnValue({
      abortSignal: async () => ({ data: { allowed: false, bucket: 'global', retryAfterSeconds: 25 }, error: null }),
    });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('25');
    expect(await response.json()).toEqual({ error: 'This service is at capacity. Try again shortly.' });
    expect(mocks.extractAll).not.toHaveBeenCalled();
  });

  it('fails closed on a limiter RPC error before extraction or judging', async () => {
    register(PHOTO_A, BYTES);
    mocks.consumeRateLimit.mockReturnValue({
      abortSignal: async () => ({ data: null, error: { message: 'database unavailable' } }),
    });
    const response = await extract(request(PHOTO_A));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    expect(mocks.getFeaturesByHash).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed limiter reply and blocks upload registration too', async () => {
    register(PHOTO_A, BYTES);
    mocks.consumeRateLimit.mockReturnValue({
      abortSignal: async () => ({ data: { allowed: true, bucket: 'ip', retryAfterSeconds: 0 }, error: null }),
    });
    const extraction = await extract(request(PHOTO_A));
    expect(extraction.status).toBe(503);
    expect(mocks.extractAll).not.toHaveBeenCalled();
    expect(mocks.judgePhoto).not.toHaveBeenCalled();
    const upload = await uploadUrl(new Request('http://localhost/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ filename: 'portrait.jpg', contentType: 'image/jpeg', sha256: SHA }),
    }));
    expect(upload.status).toBe(503);
    expect(mocks.insertPhoto).not.toHaveBeenCalled();
  });
});

describe('concurrent extraction for a verified cache identity', () => {
  async function runConcurrent(
    photoA: string,
    photoB: string,
    measuredFeatures: ComputedFeatures = features,
  ): Promise<void> {
    register(photoA, BYTES);
    register(photoB, BYTES);
    const claims = new Set<string>();
    mocks.claimExtraction.mockImplementation(async (_client: unknown, _photoId: string, sha: string, version: string) => {
      const key = `${sha}:${version}`;
      if (claims.has(key)) return null;
      claims.add(key);
      return 'owner-token';
    });
    mocks.releaseExtraction.mockImplementation(async (_client: unknown, sha: string, version: string) => {
      claims.delete(`${sha}:${version}`);
    });
    let finishExtraction: ((result: ComputedFeatures) => void) | undefined;
    mocks.extractAll.mockImplementation(() => new Promise<ComputedFeatures>((resolve) => {
      finishExtraction = resolve;
    }));

    const winner = extract(request(photoA));
    await vi.waitFor(() => expect(mocks.extractAll).toHaveBeenCalledOnce());
    const loser = extract(request(photoB));
    await vi.waitFor(() => expect(mocks.claimExtraction).toHaveBeenCalledTimes(2));
    expect(mocks.claimExtraction).toHaveBeenNthCalledWith(1, expect.anything(), photoA, SHA, 'v7');
    expect(mocks.claimExtraction).toHaveBeenNthCalledWith(2, expect.anything(), photoB, SHA, 'v7');
    if (finishExtraction === undefined) throw new Error('extractor did not start');
    finishExtraction(measuredFeatures);

    const [winnerResponse, loserResponse] = await Promise.all([winner, loser]);
    expect(winnerResponse.status).toBe(200);
    expect(loserResponse.status).toBe(200);
    expect(await winnerResponse.json()).toMatchObject({ featuresCached: false });
    expect(await loserResponse.json()).toMatchObject({ featuresCached: true });
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(photoFeatures.get(photoA)).toEqual(measuredFeatures);
    expect(photoFeatures.get(photoB)).toEqual(measuredFeatures);
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), SHA, 'v7', 'owner-token');
  }

  it('lets two attempts for one photo share one extraction', async () => {
    await runConcurrent(PHOTO_A, PHOTO_A);
  });

  it('lets different photo IDs with the same verified bytes share one extraction', async () => {
    await runConcurrent(PHOTO_A, PHOTO_B);
    expect(photoFeatures.size).toBe(2);
  });

  it('judges each photo after one cross-photo extraction', async () => {
    await runConcurrent(PHOTO_A, PHOTO_B, faceFeatures);
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.judgePhoto).toHaveBeenCalledTimes(2);
    expect(assessments.get(assessmentKey(PHOTO_A, 'claude-sonnet-5'))).toEqual({
      status: 'assessed', assessment: judgedAssessment,
    });
    expect(assessments.get(assessmentKey(PHOTO_B, 'claude-sonnet-5'))).toEqual({
      status: 'assessed', assessment: judgedAssessment,
    });
  });

  it('holds the winning claim until its assessment finishes', async () => {
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockResolvedValue(faceFeatures);
    let finishJudgment: ((result: { ok: true; assessment: Assessment }) => void) | undefined;
    mocks.judgePhoto.mockImplementation(() => new Promise<{ ok: true; assessment: Assessment }>((resolve) => {
      finishJudgment = resolve;
    }));

    const pending = extract(request(PHOTO_A));
    await vi.waitFor(() => expect(mocks.judgePhoto).toHaveBeenCalledOnce());
    expect(mocks.releaseExtraction).not.toHaveBeenCalled();
    if (finishJudgment === undefined) throw new Error('judge did not start');
    finishJudgment({ ok: true, assessment: judgedAssessment });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), SHA, 'v7', 'claim-token');
  });

  it('retries the VLM after features were cached but the first judgment failed', async () => {
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockResolvedValue(faceFeatures);
    mocks.judgePhoto.mockRejectedValueOnce(new Error('VLM unavailable'));

    const first = await extract(request(PHOTO_A));
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: 'Extraction failed.' });
    expect(photoFeatures.get(PHOTO_A)).toEqual(faceFeatures);
    expect(globalFeatures.get(`${SHA}:v7`)).toEqual(faceFeatures);
    expect(assessments.size).toBe(0);
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), SHA, 'v7', 'claim-token');

    const retry = await extract(request(PHOTO_A));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ featuresCached: true, assessment: judgedAssessment });
    expect(mocks.extractAll).toHaveBeenCalledOnce();
    expect(mocks.judgePhoto).toHaveBeenCalledTimes(2);
    expect(assessments.has(assessmentKey(PHOTO_A, 'claude-sonnet-5'))).toBe(true);
  });

  it('releases a failed winner so a later request can retry', async () => {
    register(PHOTO_A, BYTES);
    mocks.extractAll.mockRejectedValueOnce(new Error('private Sharp decoder detail'));
    const failure = await extract(request(PHOTO_A));
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: 'Extraction failed.' });
    expect(console.error).toHaveBeenCalledWith(
      '[api/extract] extraction',
      expect.objectContaining({ message: 'private Sharp decoder detail' }),
    );
    expect(mocks.releaseExtraction).toHaveBeenCalledWith(expect.anything(), SHA, 'v7', 'claim-token');
    const retry = await extract(request(PHOTO_A));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ featuresCached: false });
    expect(mocks.extractAll).toHaveBeenCalledTimes(2);
  });

  it('times out after 30 seconds without starting duplicate extraction', async () => {
    vi.useFakeTimers();
    try {
      register(PHOTO_B, BYTES);
      mocks.claimExtraction.mockResolvedValue(null);
      const pending = extract(request(PHOTO_B));
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(mocks.extractAll).not.toHaveBeenCalled();
      expect(mocks.releaseExtraction).not.toHaveBeenCalled();
      expect(photoFeatures.has(PHOTO_B)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
