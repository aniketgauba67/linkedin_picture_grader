/**
 * POST /api/extract
 *
 * Reuses expensive image features by verified content and completes the
 * current photo's assessment when eligible. A cache hit, an extraction
 * winner, and a claim loser all reach the same assessment stage.
 *
 * Download and verify the bytes before looking up their global cache
 * entry. The stored SHA is a client claim until that comparison passes.
 * A verified hit saves extraction, then associates the reused features
 * with this photo so Edge scoring can read them by photo_id.
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ImageDecodeError, extractAll, judgePhoto } from '@pps/features';
import {
  ACTIVE_VLM_MODEL,
  EXTRACTOR_VERSION,
  PersistedAssessmentResponse as PersistedAssessmentResponseSchema,
  assertFeaturesUsable,
  type ComputedFeatures,
  type MimeType,
  type PersistedAssessmentResponse,
} from '@pps/schema';
import {
  claimExtraction,
  getFeaturesByHash,
  upsertAssessment,
  releaseExtraction,
  upsertFeatures,
} from '@pps/db';

import { belowDimensionFloor, MIN_SHORTER_EDGE, UploadRejected, verifyBytes, verifyStoredMime } from '@/lib/guards';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { PHOTO_BUCKET, serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** How long to wait for whoever won the claim. */
const CLAIM_POLL_TIMEOUT_MS = 30_000;
const CLAIM_POLL_INTERVAL_MS = 750;

const Body = z.object({
  photoId: z.string().uuid(),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function unexpectedFailure(stage: string, error: unknown): NextResponse {
  console.error(`[api/extract] ${stage}`, error);
  return NextResponse.json({ error: 'Extraction failed.' }, { status: 500 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const limit = await checkRateLimit(clientIp(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: limit.reason },
      limit.unavailable
        ? { status: 503 }
        : { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'photoId must be a uuid.' }, { status: 400 });
  }
  const { photoId } = parsed.data;

  const client = serviceClient();

  const photo = await client
    .from('photos')
    .select('id,storage_path,sha256,deleted_at')
    .eq('id', photoId)
    .maybeSingle();

  if (photo.error !== null) {
    return unexpectedFailure('photo lookup', photo.error);
  }
  if (photo.data === null || photo.data.deleted_at !== null) {
    return NextResponse.json({ error: 'No such photo.' }, { status: 404 });
  }
  const { storage_path: storagePath, sha256: claimedSha256 } = photo.data;
  if (storagePath === null || claimedSha256 === null) {
    return NextResponse.json({ error: 'This photo has no uploaded bytes.' }, { status: 409 });
  }

  const download = await client.storage.from(PHOTO_BUCKET).download(storagePath);
  if (download.error !== null || download.data === null) {
    console.error('[api/extract] storage download', download.error ?? 'Storage returned no data');
    return NextResponse.json({ error: 'Could not read the uploaded file.' }, { status: 502 });
  }

  const bytes = new Uint8Array(await download.data.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  let detectedMime: MimeType;
  try {
    detectedMime = verifyBytes(bytes, claimedSha256, actualSha256);
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  const storedInfo = await client.storage.from(PHOTO_BUCKET).info(storagePath);
  if (storedInfo.error !== null || storedInfo.data === null) {
    console.error('[api/extract] storage metadata', storedInfo.error ?? 'Storage returned no metadata');
    return NextResponse.json({ error: 'Could not read stored file metadata.' }, { status: 502 });
  }
  try {
    verifyStoredMime(detectedMime, storedInfo.data.contentType);
    verifyStoredMime(detectedMime, storedInfo.data.metadata?.mimetype);
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  // The verified bytes, not the client claim, identify the cache entry.
  const cached = await getFeaturesByHash(client, actualSha256, EXTRACTOR_VERSION);
  if (cached !== null) {
    await upsertFeatures(client, {
      photoId,
      sha256: actualSha256,
      features: cached.features,
      extractorVersion: EXTRACTOR_VERSION,
    });
    return completePhotoAnalysis(client, photoId, cached.features, bytes, true);
  }

  // The claim uses the same verified content identity as feature_cache.
  const claimToken = await claimExtraction(client, photoId, actualSha256, EXTRACTOR_VERSION);
  if (claimToken === null) {
    const waited = await waitForFeatures(client, actualSha256);
    if (waited !== null) {
      await upsertFeatures(client, {
        photoId,
        sha256: actualSha256,
        features: waited,
        extractorVersion: EXTRACTOR_VERSION,
      });
      return completePhotoAnalysis(client, photoId, waited, bytes, true);
    }
    return NextResponse.json(
      { error: 'Extraction is already running for these image bytes and did not finish in time.' },
      { status: 504 },
    );
  }

  try {
    // Measure. extractAll normalises EXIF orientation before anything
    // reads pixels - rotate, then strip - so the measurements describe
    // the image as a viewer sees it.
    let features: ComputedFeatures;
    try {
      features = await extractAll(Buffer.from(bytes));
    } catch (error) {
      if (error instanceof ImageDecodeError) {
        return NextResponse.json(
          { error: 'This file could not be opened. Re-export it and upload it again.', code: 'corrupt_file' },
          { status: 422 },
        );
      }
      throw error;
    }
    assertFeaturesUsable(features);

    await upsertFeatures(client, {
      photoId,
      sha256: actualSha256,
      features,
      extractorVersion: features.extractorVersion,
    });

    return await completePhotoAnalysis(client, photoId, features, bytes, false);
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return unexpectedFailure('extraction', error);
  } finally {
    // A failed worker releases promptly; a crash is recovered by the lease.
    // The token prevents a stale worker from releasing its successor's claim.
    await releaseExtraction(client, actualSha256, EXTRACTOR_VERSION, claimToken).catch(() => undefined);
  }
}

function dimensionRejection(features: ComputedFeatures): NextResponse | null {
  if (!belowDimensionFloor(features.width, features.height)) return null;
  return NextResponse.json(
    {
      error: `Images must be at least ${MIN_SHORTER_EDGE}px on the shorter edge.`,
      code: 'below_dimension_floor',
    },
    { status: 422 },
  );
}

type Client = ReturnType<typeof serviceClient>;

/** Complete the per-photo assessment stage after any feature-availability path. */
async function completePhotoAnalysis(
  client: Client,
  photoId: string,
  features: ComputedFeatures,
  bytes: Uint8Array,
  featuresCached: boolean,
): Promise<NextResponse> {
  const tooSmall = dimensionRejection(features);
  if (tooSmall !== null) return tooSmall;

  // A no-face photo has computed evidence but no judged axes by design.
  if (features.faceCount === 0) {
    return NextResponse.json({
      photoId,
      features,
      extractorVersion: features.extractorVersion,
      featuresCached,
      assessment: null,
      judgeSkipped: 'no_face',
    });
  }

  let result: PersistedAssessmentResponse | null;
  try {
    result = await readAssessment(client, photoId);
  } catch (error) {
    // An uncertain database read is not evidence that the model must run.
    console.error('[api/extract] assessment lookup', error);
    return NextResponse.json({ error: 'Could not read this photo assessment.' }, { status: 502 });
  }

  if (result === null) {
    try {
      const outcome = await judgePhoto(Buffer.from(bytes));
      result = outcome.ok
        ? { status: 'assessed', assessment: outcome.assessment }
        : { status: 'declined', reason: outcome.reason, detail: '' };
      // Assessments are per photo and model, even when features came from
      // another photo's global cache entry.
      await upsertAssessment(client, {
        photoId,
        source: 'vlm',
        model: ACTIVE_VLM_MODEL,
        response: result,
      });
    } catch (error) {
      return unexpectedFailure('assessment', error);
    }
  }

  return NextResponse.json({
    photoId,
    features,
    extractorVersion: features.extractorVersion,
    featuresCached,
    assessment: result.status === 'assessed' ? result.assessment : null,
    declined: result.status === 'declined' ? result.reason : null,
  });
}

/** Poll for whoever won the claim to finish. */
async function waitForFeatures(
  client: Client,
  sha256: string,
  timeoutMs = CLAIM_POLL_TIMEOUT_MS,
): Promise<ComputedFeatures | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(CLAIM_POLL_INTERVAL_MS);
    const cached = await getFeaturesByHash(client, sha256, EXTRACTOR_VERSION);
    if (cached !== null) return cached.features;
  }
  return null;
}

async function readAssessment(client: Client, photoId: string): Promise<PersistedAssessmentResponse | null> {
  const row = await client
    .from('assessments')
    .select('axes')
    .eq('photo_id', photoId)
    .eq('source', 'vlm')
    .eq('model', ACTIVE_VLM_MODEL)
    .maybeSingle();
  if (row.error !== null) {
    throw new Error(`Failed to read assessment for ${photoId}: ${row.error.message}`);
  }
  return row.data === null ? null : PersistedAssessmentResponseSchema.parse(row.data.axes);
}
