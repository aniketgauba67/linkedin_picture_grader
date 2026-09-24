import type { Assessment, ComputedFeatures, ScoreContext, ScoreResult } from '@pps/schema';
import {
  Assessment as AssessmentSchema,
  ComputedFeatures as ComputedFeaturesSchema,
  EXTRACTOR_VERSION,
  assertFeaturesUsable,
} from '@pps/schema';
import type { Client } from './client.js';
import { IMAGE_BUCKET } from './env.js';
import type { Tables } from './database.types.js';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/** How long a held extraction lock stays valid before another worker may take it. */
export const EXTRACTION_STALE_AFTER = '2 minutes';

export type Photo = Tables<'photos'>;
export type Assessment_ = Tables<'assessments'>;
export type Score = Tables<'scores'>;

export type AssessmentSource = 'vlm' | 'local' | 'human';

export interface InsertPhotoInput {
  readonly storagePath: string;
  /** Content hash. Two uploads of the same bytes resolve to one photo. */
  readonly sha256: string;
  /** Null for anonymous uploads. */
  readonly uploadedBy?: string | null;
}

export interface InsertPhotoResult {
  readonly photo: Photo;
  /**
   * True when these exact bytes were already known. The caller should skip
   * extraction and read the cached features instead.
   */
  readonly deduped: boolean;
}

/**
 * Records an upload.
 *
 * `photos.sha256` is unique per uploader, so the same person re-uploading
 * the same bytes resolves to their existing row, and two different people
 * uploading the same image each get their own. A unique violation here
 * therefore always means "this uploader already has this image", never
 * "somebody else does" - which is what makes returning the existing row
 * safe.
 *
 * Anonymous uploads never collide at all: with no uploader to be unique
 * against, the constraint's NULL semantics leave every one of them
 * distinct. They still skip re-extraction through `getFeaturesByHash`.
 */
export async function insertPhoto(
  client: Client,
  input: InsertPhotoInput,
): Promise<InsertPhotoResult> {
  const uploadedBy = input.uploadedBy ?? null;

  const { data, error } = await client
    .from('photos')
    .insert({
      storage_path: input.storagePath,
      sha256: input.sha256,
      uploaded_by: uploadedBy,
    })
    .select()
    .single();

  if (error === null) {
    return { photo: data, deduped: false };
  }

  if (error.code !== UNIQUE_VIOLATION) {
    throw new Error(`Failed to insert photo: ${error.message}`);
  }

  if (uploadedBy === null) {
    // An anonymous insert cannot collide on (uploaded_by, sha256), so a
    // unique violation here is some other constraint and re-reading would
    // be guessing.
    throw new Error(`Failed to insert anonymous photo: ${error.message}`);
  }

  // This uploader already has these bytes. Scoped to them, so this can
  // never hand back another account's row.
  const existing = await client
    .from('photos')
    .select()
    .eq('uploaded_by', uploadedBy)
    .eq('sha256', input.sha256)
    .is('deleted_at', null)
    .maybeSingle();

  if (existing.error !== null) {
    throw new Error(`Failed to read deduplicated photo: ${existing.error.message}`);
  }
  if (existing.data === null) {
    throw new Error(
      `Photo with hash ${input.sha256} collided on insert but no live row of this uploader's matched`,
    );
  }
  return { photo: existing.data, deduped: true };
}

export interface CachedFeatures {
  readonly sha256: string;
  /** Defaults to EXTRACTOR_VERSION, which is derived from the schema version. */
  readonly extractorVersion?: string;
  readonly features: ComputedFeatures;
}

/**
 * The dedup read: given a content hash, returns features already
 * extracted from those exact bytes, by anyone.
 *
 * This reads `feature_cache`, which is keyed by hash alone and holds only
 * anonymous measurements - no uploader, no photo id, no storage path. It
 * is the one thing shared across accounts, and sharing it leaks nothing
 * that identifies whose image it was.
 *
 * The extractor version is part of the key, so a vector produced by an
 * older extractor simply misses and the photo is re-extracted.
 */
export async function getFeaturesByHash(
  client: Client,
  sha256: string,
  extractorVersion: string = EXTRACTOR_VERSION,
): Promise<CachedFeatures | null> {
  const { data, error } = await client
    .from('feature_cache')
    .select('computed')
    .eq('sha256', sha256)
    .eq('extractor_version', extractorVersion)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`Failed to read the feature cache: ${error.message}`);
  }
  if (data === null) {
    return null;
  }

  // JSONB out of Postgres is unverified. A NaN that gets past here does
  // not throw downstream - it scores as something plausible.
  const features = ComputedFeaturesSchema.parse(data.computed);
  assertFeaturesUsable(features);
  return { sha256, extractorVersion, features };
}

export interface UpsertFeaturesInput {
  readonly photoId: string;
  readonly features: ComputedFeatures;
  /** Defaults to EXTRACTOR_VERSION, which is derived from the schema version. */
  readonly extractorVersion?: string;
  /**
   * Content hash, so the extraction lands in the shared cache too. Pass
   * null only for a photo whose hash has already been stripped by
   * retention; the per-photo row is still written.
   */
  readonly sha256: string | null;
  /** CLIP embedding, 512 dimensions. Optional until the model is wired up. */
  readonly embedding?: readonly number[] | null;
}

/**
 * Records an extraction: this photo's feature row and the shared
 * hash-keyed cache entry, in one transaction.
 *
 * The two are written together deliberately. Splitting them leaves a
 * window where a photo has features that no later upload can reuse, which
 * is the exact cost the cache exists to avoid.
 */
export async function upsertFeatures(client: Client, input: UpsertFeaturesInput): Promise<void> {
  assertFeaturesUsable(input.features);

  if (input.embedding != null && input.embedding.length !== 512) {
    throw new RangeError(
      `clip_embedding must have 512 dimensions, received ${input.embedding.length}`,
    );
  }

  const { error } = await client.rpc('record_extraction', {
    p_photo_id: input.photoId,
    p_sha256: input.sha256,
    p_computed: input.features,
    p_extractor_version: input.extractorVersion ?? EXTRACTOR_VERSION,
    // pgvector accepts its text form; a bare JSON array does not cast.
    p_embedding: input.embedding == null ? null : `[${input.embedding.join(',')}]`,
  });

  if (error !== null) {
    throw new Error(`Failed to record extraction for ${input.photoId}: ${error.message}`);
  }
}

/**
 * Drops cache entries left behind by superseded extractors.
 *
 * Retention never touches `feature_cache` because it holds no user data,
 * so this is the only thing that bounds it. Safe to run any time: a miss
 * costs one re-extraction.
 */
export async function pruneFeatureCache(
  client: Client,
  keepExtractorVersion: string = EXTRACTOR_VERSION,
): Promise<number> {
  const { data, error } = await client.rpc('prune_feature_cache', {
    p_keep_version: keepExtractorVersion,
  });

  if (error !== null) {
    throw new Error(`Failed to prune the feature cache: ${error.message}`);
  }
  return data ?? 0;
}

export interface InsertAssessmentInput {
  readonly photoId: string;
  readonly source: AssessmentSource;
  readonly assessment: Assessment;
  /** Null for `human`. Part of the uniqueness key either way. */
  readonly model?: string | null;
}

/**
 * Records one assessment. The unique constraint on
 * (photo_id, source, model) is NULLS NOT DISTINCT, so a duplicate raises
 * rather than quietly doubling the row - which is the whole point of
 * holding the extraction lock in the first place.
 */
export async function insertAssessment(
  client: Client,
  input: InsertAssessmentInput,
): Promise<Assessment_> {
  const axes = AssessmentSchema.parse(input.assessment);

  const { data, error } = await client
    .from('assessments')
    .insert({
      photo_id: input.photoId,
      source: input.source,
      axes,
      model: input.model ?? null,
    })
    .select()
    .single();

  if (error !== null) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new Error(
        `An assessment already exists for photo ${input.photoId} from ${input.source}` +
          `${input.model == null ? '' : ` (${input.model})`}. ` +
          'Two workers extracted the same photo; check the extraction lock.',
      );
    }
    throw new Error(`Failed to insert assessment: ${error.message}`);
  }
  return data;
}

/**
 * Appends a score. Never updates: re-scoring under a new weights_version
 * adds a row, so two scores are only ever compared within a version.
 */
export async function insertScore(
  client: Client,
  photoId: string,
  result: ScoreResult,
): Promise<Score> {
  const { data, error } = await client
    .from('scores')
    .insert({
      photo_id: photoId,
      context: result.context,
      score: result.score,
      axis_scores: result.axes,
      weights_version: result.weightsVersion,
    })
    .select()
    .single();

  if (error !== null) {
    throw new Error(`Failed to insert score: ${error.message}`);
  }
  return data;
}

export async function getLatestScore(
  client: Client,
  photoId: string,
  context: ScoreContext,
): Promise<Score | null> {
  const { data, error } = await client
    .from('scores')
    .select()
    .eq('photo_id', photoId)
    .eq('context', context)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`Failed to read score: ${error.message}`);
  }
  return data;
}

/**
 * Takes the extraction lock for a photo.
 *
 * Returns true if this caller now owns extraction, false if another worker
 * holds it. **A caller that gets false must not start its own extraction**
 * - it should poll for the features row. Running the VLM twice is a
 * doubled bill and a duplicate assessment row.
 *
 * The lock goes stale after two minutes so a crashed extraction retries.
 */
export async function claimExtraction(
  client: Client,
  photoId: string,
  staleAfter: string = EXTRACTION_STALE_AFTER,
): Promise<boolean> {
  const { data, error } = await client.rpc('claim_extraction', {
    p_photo_id: photoId,
    p_stale_after: staleAfter,
  });

  if (error !== null) {
    throw new Error(`Failed to claim extraction for ${photoId}: ${error.message}`);
  }
  return data === true;
}

/** Hands the lock back so a failed extraction retries without waiting. */
export async function releaseExtraction(client: Client, photoId: string): Promise<void> {
  const { error } = await client.rpc('release_extraction', { p_photo_id: photoId });
  if (error !== null) {
    throw new Error(`Failed to release extraction for ${photoId}: ${error.message}`);
  }
}

/**
 * The user-facing delete button.
 *
 * Removes the image and strips the row of everything identifying it, while
 * leaving the anonymous feature vector behind for retraining.
 *
 * The Storage object is removed through the Storage API rather than by
 * deleting the `storage.objects` row, because deleting the row only drops
 * the metadata - the bytes stay in the bucket backend. The SQL function
 * deletes the row too, so this is idempotent either way.
 */
export async function deletePhoto(client: Client, photoId: string): Promise<boolean> {
  const photo = await client
    .from('photos')
    .select('storage_path')
    .eq('id', photoId)
    .is('deleted_at', null)
    .maybeSingle();

  if (photo.error !== null) {
    throw new Error(`Failed to read photo ${photoId} for deletion: ${photo.error.message}`);
  }
  if (photo.data === null) {
    // Already gone, or never existed. Deleting twice is not an error.
    return false;
  }

  if (photo.data.storage_path !== null) {
    const removal = await client.storage.from(IMAGE_BUCKET).remove([photo.data.storage_path]);
    if (removal.error !== null) {
      throw new Error(`Failed to remove stored image: ${removal.error.message}`);
    }
  }

  const { data, error } = await client.rpc('delete_photo', { p_photo_id: photoId });
  if (error !== null) {
    throw new Error(`Failed to delete photo ${photoId}: ${error.message}`);
  }
  return data === true;
}

/**
 * Phase 2 of retention: the part SQL cannot do.
 *
 * `expire_photos` anonymises rows on schedule but leaves the image in the
 * bucket, because Supabase refuses direct deletes on `storage.objects` -
 * only the Storage API may remove an object. This runs that API, then
 * clears the path.
 *
 * **This has to be scheduled too.** Until it runs, expired photos are
 * anonymous but their bytes are still stored. A Vercel cron hitting it
 * daily, shortly after the 03:15 UTC pg_cron sweep, is the intended
 * pairing.
 *
 * Order matters: the object goes first, and `storage_path` is only
 * cleared once Storage has confirmed. Clearing it first would lose the
 * one pointer to the bytes and orphan them permanently.
 */
export async function reclaimExpiredStorage(client: Client, limit = 500): Promise<number> {
  // Catch up on anything the scheduled sweep has not anonymised yet, so
  // this works standalone if pg_cron is unavailable.
  const swept = await client.rpc('expire_photos', { p_limit: limit });
  if (swept.error !== null) {
    throw new Error(`Failed to anonymise expired photos: ${swept.error.message}`);
  }

  const { data, error } = await client
    .from('photos')
    .select('id, storage_path')
    .not('deleted_at', 'is', null)
    .not('storage_path', 'is', null)
    .limit(limit);

  if (error !== null) {
    throw new Error(`Failed to list photos awaiting storage reclaim: ${error.message}`);
  }

  const pending = (data ?? []).filter(
    (row): row is { id: string; storage_path: string } => row.storage_path !== null,
  );
  if (pending.length === 0) {
    return 0;
  }

  const removal = await client.storage
    .from(IMAGE_BUCKET)
    .remove(pending.map((row) => row.storage_path));
  if (removal.error !== null) {
    throw new Error(`Failed to remove expired images: ${removal.error.message}`);
  }

  const cleared = await client.rpc('mark_storage_reclaimed', {
    p_photo_ids: pending.map((row) => row.id),
  });
  if (cleared.error !== null) {
    throw new Error(`Removed the images but could not clear their paths: ${cleared.error.message}`);
  }

  return cleared.data ?? 0;
}
