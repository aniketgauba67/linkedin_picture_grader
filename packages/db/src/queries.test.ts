import { describe, expect, it } from 'vitest';
import type { ComputedFeatures, RubricResponse, ScoreResult } from '@pps/schema';
import { createFakeClient } from './fake-client.js';
import {
  claimExtraction,
  deletePhoto,
  getFeaturesByHash,
  insertAssessment,
  insertPhoto,
  insertScore,
  pruneFeatureCache,
  upsertFeatures,
} from './queries.js';

const features: ComputedFeatures = {
  sharpnessLaplacian: 260,
  sharpnessEyeRegion: 310,
  jpegQualityEstimate: 84,
  exposureMean: 130,
  clippedHighlights: 0.006,
  clippedShadows: 0.004,
  dynamicRange: 186,
  width: 1500,
  height: 1500,
  faceAreaRatio: 0.12,
  faceCenterOffsetX: 0.02,
  faceCenterOffsetY: -0.05,
  faceCount: 1,
  yaw: 4,
  pitch: -6,
  roll: 1.2,
  eyeOpenness: 0.78,
  smileIntensity: 0.33,
  eyeRegionMeasured: true,
  primaryFaceConfidence: 0.9,
  secondLargestFaceRatio: null,
  isGrayscale: false,
  aspectExtreme: false,
  sourceFormat: 'jpeg',
  extractorVersion: 'v5',
};

const assessed: RubricResponse = {
  status: 'assessed',
  assessment: {
    background: { evidence: 'plain grey wall behind the subject', score: 4 },
    attire: { evidence: 'open collar button-down shirt', score: 3 },
    expression: { evidence: 'eyes to the lens, slight smile', score: 4 },
    solo: { evidence: 'one person in frame, nobody else', score: 5 },
    framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
  },
};

const scoreResult: ScoreResult = {
  score: 7.4,
  axes: {
    sharpness: 4,
    lighting: 4,
    resolution: 5,
    framing: 3,
    background: 4,
    attire: 3,
    expression: 4,
    solo: 5,
  },
  context: 'corporate',
  fixes: [],
  confidence: 0.95,
  weightsVersion: '2026-09-24.1',
  coverage: 'full',
};

const photoRow = { id: 'photo-1', storage_path: 'anon/a.jpg', sha256: 'hash-1' };

describe('insertPhoto', () => {
  it('returns the inserted row', async () => {
    const fake = createFakeClient([{ data: photoRow }]);
    const result = await insertPhoto(fake.client, {
      storagePath: 'anon/a.jpg',
      sha256: 'hash-1',
    });
    expect(result.deduped).toBe(false);
    expect(result.photo.id).toBe('photo-1');
  });

  it('defaults uploaded_by to null for an anonymous upload', async () => {
    const fake = createFakeClient([{ data: photoRow }]);
    await insertPhoto(fake.client, { storagePath: 'anon/a.jpg', sha256: 'hash-1' });
    expect(fake.argsFor('insert')?.[0]).toMatchObject({ uploaded_by: null });
  });

  it('returns the uploader own earlier row when they re-upload the same bytes', async () => {
    const fake = createFakeClient([
      { error: { message: 'duplicate key', code: '23505' } },
      { data: { ...photoRow, uploaded_by: 'user-1' } },
    ]);
    const result = await insertPhoto(fake.client, {
      storagePath: 'u/b.jpg',
      sha256: 'hash-1',
      uploadedBy: 'user-1',
    });
    expect(result.deduped).toBe(true);
    expect(result.photo.id).toBe('photo-1');
  });

  it('scopes the dedup read to the uploader, so it cannot return another account row', async () => {
    const fake = createFakeClient([
      { error: { message: 'duplicate key', code: '23505' } },
      { data: { ...photoRow, uploaded_by: 'user-1' } },
    ]);
    await insertPhoto(fake.client, {
      storagePath: 'u/b.jpg',
      sha256: 'hash-1',
      uploadedBy: 'user-1',
    });
    const filters = fake.calls.filter((call) => call.method === 'eq').map((call) => call.args);
    expect(filters).toContainEqual(['uploaded_by', 'user-1']);
    expect(filters).toContainEqual(['sha256', 'hash-1']);
  });

  it('does not re-read on a unique violation from an anonymous insert', async () => {
    // Anonymous rows cannot collide on (uploaded_by, sha256), so a
    // violation here is some other constraint and re-reading would be
    // guessing at which row was meant.
    const fake = createFakeClient([{ error: { message: 'duplicate key', code: '23505' } }]);
    await expect(
      insertPhoto(fake.client, { storagePath: 'anon/a.jpg', sha256: 'hash-1' }),
    ).rejects.toThrow(/anonymous photo/);
    expect(fake.calls.filter((call) => call.method === 'from')).toHaveLength(1);
  });

  it('rethrows an error that is not a unique violation', async () => {
    const fake = createFakeClient([{ error: { message: 'connection lost', code: '08006' } }]);
    await expect(
      insertPhoto(fake.client, { storagePath: 'anon/a.jpg', sha256: 'hash-1' }),
    ).rejects.toThrow(/connection lost/);
  });

  it('throws when the collided row cannot be read back', async () => {
    const fake = createFakeClient([
      { error: { message: 'duplicate key', code: '23505' } },
      { data: null },
    ]);
    await expect(
      insertPhoto(fake.client, {
        storagePath: 'u/a.jpg',
        sha256: 'hash-1',
        uploadedBy: 'user-1',
      }),
    ).rejects.toThrow(/collided on insert/);
  });
});

describe('getFeaturesByHash', () => {
  it('returns cached features for known bytes', async () => {
    const fake = createFakeClient([{ data: { computed: features } }]);
    const cached = await getFeaturesByHash(fake.client, 'hash-1', 'v4');
    expect(cached?.features.width).toBe(1500);
    expect(cached?.sha256).toBe('hash-1');
  });

  it('reads the shared cache, not anybody photo rows', async () => {
    const fake = createFakeClient([{ data: { computed: features } }]);
    await getFeaturesByHash(fake.client, 'hash-1', 'v4');
    expect(fake.argsFor('from')).toEqual(['feature_cache']);
    expect(fake.calls.some((call) => call.args[0] === 'photos')).toBe(false);
  });

  it('returns null when the hash is unknown', async () => {
    const fake = createFakeClient([{ data: null }]);
    expect(await getFeaturesByHash(fake.client, 'nope', 'v2')).toBeNull();
  });

  it('keys on the extractor version it was asked for', async () => {
    const fake = createFakeClient([{ data: null }]);
    await getFeaturesByHash(fake.client, 'hash-1', 'v7');
    const filters = fake.calls.filter((call) => call.method === 'eq').map((call) => call.args);
    expect(filters).toContainEqual(['extractor_version', 'v7']);
  });

  it('refuses a cached vector whose sharpness basis flag disagrees', async () => {
    // A vector that claims the eye region was measured while carrying no
    // measurement would send the scorer to the wrong calibration map.
    const inconsistent = { ...features, sharpnessEyeRegion: null, eyeRegionMeasured: true };
    const fake = createFakeClient([{ data: { computed: inconsistent } }]);
    await expect(getFeaturesByHash(fake.client, 'hash-1', 'v4')).rejects.toThrow(
      /eyeRegionMeasured/,
    );
  });

  it('accepts a cached vector with an unmeasurable eye region', async () => {
    const unmeasured = { ...features, sharpnessEyeRegion: null, eyeRegionMeasured: false };
    const fake = createFakeClient([{ data: { computed: unmeasured } }]);
    const cached = await getFeaturesByHash(fake.client, 'hash-1', 'v4');
    expect(cached?.features.sharpnessEyeRegion).toBeNull();
    expect(cached?.features.eyeRegionMeasured).toBe(false);
  });

  it('refuses a cached vector carrying a NaN', async () => {
    const corrupt = { ...features, dynamicRange: Number.NaN };
    const fake = createFakeClient([{ data: { computed: corrupt } }]);
    await expect(getFeaturesByHash(fake.client, 'hash-1', 'v4')).rejects.toThrow();
  });
});

describe('upsertFeatures', () => {
  it('records the photo row and the cache entry in one call', async () => {
    const fake = createFakeClient([{ error: null }]);
    await upsertFeatures(fake.client, {
      photoId: 'photo-1',
      sha256: 'hash-1',
      features,
      extractorVersion: 'v4',
    });
    expect(fake.argsFor('rpc')).toEqual([
      'record_extraction',
      {
        p_photo_id: 'photo-1',
        p_sha256: 'hash-1',
        p_computed: features,
        p_extractor_version: 'v4',
        p_embedding: null,
      },
    ]);
  });

  it('still writes the photo row for a photo whose hash retention stripped', async () => {
    const fake = createFakeClient([{ error: null }]);
    await upsertFeatures(fake.client, {
      photoId: 'photo-1',
      sha256: null,
      features,
      extractorVersion: 'v4',
    });
    const args = fake.argsFor('rpc')?.[1] as { p_sha256: string | null };
    expect(args.p_sha256).toBeNull();
  });

  it('encodes an embedding in pgvector text form', async () => {
    const fake = createFakeClient([{ error: null }]);
    await upsertFeatures(fake.client, {
      photoId: 'photo-1',
      sha256: 'hash-1',
      features,
      extractorVersion: 'v4',
      embedding: Array.from({ length: 512 }, (_, i) => i / 512),
    });
    const args = fake.argsFor('rpc')?.[1] as { p_embedding: string };
    expect(args.p_embedding.startsWith('[0,')).toBe(true);
    expect(args.p_embedding.endsWith(']')).toBe(true);
  });

  it('rejects an embedding of the wrong width', async () => {
    const fake = createFakeClient([{ error: null }]);
    await expect(
      upsertFeatures(fake.client, {
        photoId: 'photo-1',
        sha256: 'hash-1',
        features,
        extractorVersion: 'v4',
        embedding: [1, 2, 3],
      }),
    ).rejects.toThrow(/512 dimensions/);
  });

  it('refuses to cache an unusable vector', async () => {
    const fake = createFakeClient([{ error: null }]);
    await expect(
      upsertFeatures(fake.client, {
        photoId: 'photo-1',
        sha256: 'hash-1',
        features: { ...features, faceCount: Number.POSITIVE_INFINITY },
        extractorVersion: 'v4',
      }),
    ).rejects.toThrow(/faceCount/);
  });
});

describe('pruneFeatureCache', () => {
  it('keeps the current extractor version and reports what it dropped', async () => {
    const fake = createFakeClient([{ data: 12 }]);
    expect(await pruneFeatureCache(fake.client, 'v4')).toBe(12);
    expect(fake.argsFor('rpc')).toEqual(['prune_feature_cache', { p_keep_version: 'v4' }]);
  });

  it('throws rather than reporting a phantom zero', async () => {
    const fake = createFakeClient([{ error: { message: 'permission denied' } }]);
    await expect(pruneFeatureCache(fake.client, 'v4')).rejects.toThrow(/permission denied/);
  });
});

describe('insertAssessment', () => {
  it('validates the assessment before writing it', async () => {
    const fake = createFakeClient([{ data: { id: 'a1' } }]);
    await insertAssessment(fake.client, {
      photoId: 'photo-1',
      source: 'vlm',
      response: assessed,
      model: 'claude-opus-5',
    });
    expect(fake.argsFor('insert')?.[0]).toMatchObject({ source: 'vlm', model: 'claude-opus-5' });
  });

  it('rejects an assessment with an out-of-range score', async () => {
    const fake = createFakeClient([{ data: { id: 'a1' } }]);
    await expect(
      insertAssessment(fake.client, {
        photoId: 'photo-1',
        source: 'vlm',
        response: {
          status: 'assessed',
          assessment: {
            ...assessed.assessment,
            solo: { evidence: 'one person in frame, nobody else', score: 6 },
          },
        } as RubricResponse,
      }),
    ).rejects.toThrow();
  });

  it('explains a duplicate as a failed extraction lock, not a database error', async () => {
    const fake = createFakeClient([{ error: { message: 'duplicate key', code: '23505' } }]);
    await expect(
      insertAssessment(fake.client, { photoId: 'photo-1', source: 'vlm', response: assessed }),
    ).rejects.toThrow(/extraction lock/);
  });
});

describe('insertScore', () => {
  it('records the weights version alongside the score', async () => {
    const fake = createFakeClient([{ data: { id: 's1' } }]);
    await insertScore(fake.client, 'photo-1', scoreResult);
    expect(fake.argsFor('insert')?.[0]).toMatchObject({
      score: 7.4,
      context: 'corporate',
      weights_version: '2026-09-24.1',
    });
  });
});

describe('claimExtraction', () => {
  it('reports the winner', async () => {
    const fake = createFakeClient([{ data: true }]);
    expect(await claimExtraction(fake.client, 'photo-1')).toBe(true);
  });

  it('reports the loser', async () => {
    const fake = createFakeClient([{ data: false }]);
    expect(await claimExtraction(fake.client, 'photo-1')).toBe(false);
  });

  it('treats a null reply as a loss rather than a win', async () => {
    const fake = createFakeClient([{ data: null }]);
    expect(await claimExtraction(fake.client, 'photo-1')).toBe(false);
  });

  it('passes the two-minute stale window by default', async () => {
    const fake = createFakeClient([{ data: true }]);
    await claimExtraction(fake.client, 'photo-1');
    expect(fake.argsFor('rpc')).toEqual([
      'claim_extraction',
      { p_photo_id: 'photo-1', p_stale_after: '2 minutes' },
    ]);
  });

  it('throws rather than guessing when the lock cannot be taken', async () => {
    const fake = createFakeClient([{ error: { message: 'deadlock detected' } }]);
    await expect(claimExtraction(fake.client, 'photo-1')).rejects.toThrow(/deadlock detected/);
  });
});

describe('deletePhoto', () => {
  it('removes the stored object before stripping the row', async () => {
    const fake = createFakeClient([
      { data: { storage_path: 'anon/a.jpg' } },
      { error: null },
      { data: true },
    ]);
    expect(await deletePhoto(fake.client, 'photo-1')).toBe(true);
    expect(fake.removedPaths()).toEqual(['anon/a.jpg']);

    const order = fake.calls.map((call) => call.method);
    expect(order.indexOf('storage.remove')).toBeLessThan(order.indexOf('rpc'));
  });

  it('is a no-op for a photo already purged', async () => {
    const fake = createFakeClient([{ data: null }]);
    expect(await deletePhoto(fake.client, 'photo-1')).toBe(false);
    expect(fake.removedPaths()).toEqual([]);
  });

  it('does not strip the row when the object could not be removed', async () => {
    const fake = createFakeClient([
      { data: { storage_path: 'anon/a.jpg' } },
      { error: { message: 'storage unavailable' } },
    ]);
    await expect(deletePhoto(fake.client, 'photo-1')).rejects.toThrow(/storage unavailable/);
    expect(fake.calls.some((call) => call.method === 'rpc')).toBe(false);
  });
});
