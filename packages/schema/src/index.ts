/**
 * @pps/schema - the single source of truth for every shape that crosses a
 * boundary: browser to Vercel, Vercel to Postgres, Postgres to Supabase
 * Edge, and the vision model's replies.
 *
 * Types are inferred from the zod schemas here and re-exported under the
 * same name as the schema. No type in this repo is declared twice.
 */
export * from './axes.js';
export * from './features.js';
export { WeightsVersionError } from './errors.js';
export { FEATURE_ROLES, FEATURE_ROLE_FIELDS, featureGaps } from './roles.js';
export type { FeatureRole, FeatureRoleEntry } from './roles.js';
export * from './assessment.js';
export * from './result.js';
export * from './outcome.js';
export * from './image.js';
export * from './api.js';
