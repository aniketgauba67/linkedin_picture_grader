/**
 * @pps/db - the Supabase client, the generated database types, and typed
 * query helpers.
 */
export {
  createBrowserClient,
  createBrowserClientFromEnv,
  createServiceClient,
  createServiceClientFromEnv,
} from './client.js';
export type { Client } from './client.js';

export { IMAGE_BUCKET, readBrowserEnv, readServiceEnv } from './env.js';
export type { BrowserEnv, ServiceEnv } from './env.js';

export {
  EXTRACTION_STALE_AFTER,
  claimExtraction,
  deletePhoto,
  getFeaturesByHash,
  getLatestScore,
  insertAssessment,
  insertPhoto,
  insertScore,
  pruneFeatureCache,
  reclaimExpiredStorage,
  releaseExtraction,
  upsertFeatures,
} from './queries.js';
export type {
  AssessmentSource,
  CachedFeatures,
  InsertAssessmentInput,
  InsertPhotoInput,
  InsertPhotoResult,
  Photo,
  Score,
  UpsertFeaturesInput,
} from './queries.js';

export type { Database, Inserts, Json, Tables, Updates } from './database.types.js';
