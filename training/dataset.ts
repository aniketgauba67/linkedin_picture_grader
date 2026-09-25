#!/usr/bin/env node
/** Offline dataset preparation. No production route imports this module. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { extractAll, judgePhoto, MODEL, normalizedPipeline, prepareImage, OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT, USER_PROMPT } from '@pps/features';
import type { JudgeOutcome } from '@pps/features';
import { belowDimensionFloor, ComputedFeatures, EXTRACTOR_VERSION, MAX_UPLOAD_BYTES, PersistedAssessmentResponse } from '@pps/schema';
import type { ComputedFeatures as FeatureVector } from '@pps/schema';
import { framingRaw, lightingRaw, WEIGHTS_V1 } from '@pps/scoring';
import { z } from 'zod';

import { parseCsvObjects } from './csv.js';

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Role = z.enum(['development', 'validation', 'final_test']);
const HumanAxis = z.enum(['sharpness', 'lighting', 'resolution', 'framing', 'background', 'attire', 'expression', 'solo']);
const COMPUTED_LABEL_AXES = ['sharpness', 'lighting', 'resolution', 'framing'] as const;
const Mime = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const FeatureStatus = z.enum(['pending', 'ready', 'failed']);
const VlmStatus = z.enum(['pending', 'assessed', 'declined', 'skipped_no_face', 'skipped_ineligible', 'failed']);

export const SourceImage = z.strictObject({
  image_id: z.string().min(1),
  file_path: z.string().min(1).optional(),
  download_url: z.string().url().optional(),
  source: z.string().min(1),
  source_url: z.string().url().nullable(),
  creator: z.string().nullable(),
  license: z.string().min(1),
  license_url: z.string().url().nullable(),
  dataset_role: Role,
  cohort: z.string().min(1),
  source_group: z.string().nullable(),
  creator_group: z.string().nullable(),
  declared_mime_type: Mime.nullable(),
}).refine((value) => value.file_path !== undefined || value.download_url !== undefined, {
  message: 'file_path or download_url is required',
});
export type SourceImage = z.infer<typeof SourceImage>;

export const DatasetImage = z.strictObject({
  image_id: z.string().min(1),
  file_path: z.string().min(1), // relative to the dataset directory
  source: z.string().min(1),
  source_url: z.string().url().nullable(),
  creator: z.string().nullable(),
  license: z.string().min(1),
  license_url: z.string().url().nullable(),
  sha256: Sha,
  perceptual_hash: z.string().regex(/^[a-f0-9]{16}$/),
  dataset_role: Role,
  cohort: z.string().min(1),
  source_group: z.string().nullable(),
  creator_group: z.string().nullable(),
  duplicate_of: z.string().nullable(),
  /** Exact/near variants and known common source/creator stay in one split. */
  split_group: z.string().min(1),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  mime_type: Mime,
  extractor_version: z.string().min(1).nullable(),
  feature_status: FeatureStatus,
  vlm_status: VlmStatus,
  human_label_status: z.enum(['none', 'partial', 'complete']),
  eligible_for_product_scoring: z.boolean().nullable(),
  eligibility_reason: z.enum(['below_dimension_floor', 'features_unavailable']).nullable(),
});
export type DatasetImage = z.infer<typeof DatasetImage>;

export const FeatureArtifact = z.strictObject({
  sha256: Sha,
  extractor_version: z.string().min(1),
  features: ComputedFeatures,
});
export type FeatureArtifact = z.infer<typeof FeatureArtifact>;

/** Human ratings remain separate from VLM predictions, including future judged-axis audits. */
export const HumanLabel = z.strictObject({
  source: z.literal('human'),
  image_id: z.string().min(1),
  axis: HumanAxis,
  score: z.number().int().min(1).max(5),
  cohort: z.string().min(1),
  rater: z.string().min(1),
});
export type HumanLabel = z.infer<typeof HumanLabel>;

export const VlmLabel = z.strictObject({
  source: z.literal('vlm'),
  image_id: z.string().min(1),
  model: z.string().min(1),
  rubric_fingerprint: Sha,
  result: PersistedAssessmentResponse,
  created_at: z.string().datetime(),
});
export type VlmLabel = z.infer<typeof VlmLabel>;

/** Reserved for later score evaluation; computed scores are never human ground truth. */
export const ComputedScore = z.strictObject({
  source: z.literal('computed'),
  image_id: z.string().min(1),
  weights_version: z.string().min(1),
  context: z.enum(['startup', 'corporate', 'creative']),
  score: z.number().finite().min(1).max(10),
});

export const RUBRIC_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify([SYSTEM_PROMPT, USER_PROMPT, OUTPUT_JSON_SCHEMA]))
  .digest('hex');

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sniffMime(bytes: Buffer): z.infer<typeof Mime> {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new TypeError('unsupported image signature');
}

/** Difference hash over EXIF-oriented pixels; 64 bits, stable across exact resizes. */
export async function perceptualHash(bytes: Buffer): Promise<string> {
  const { decodable } = await prepareImage(bytes);
  const { data, info } = await normalizedPipeline(decodable)
    .resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) throw new Error('invalid dHash plane');
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      hash = (hash << 1n) | (Number((data[y * 9 + x] ?? 0) > (data[y * 9 + x + 1] ?? 0)) ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

export function hammingDistance(left: string, right: string): number {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (bits > 0n) { count += Number(bits & 1n); bits >>= 1n; }
  return count;
}

/** Conservative review flag, not an identity claim or deletion rule. */
export const NEAR_DUPLICATE_DISTANCE = 6;

function sameGroup(left: DatasetImage, right: DatasetImage): boolean {
  return left.sha256 === right.sha256 ||
    hammingDistance(left.perceptual_hash, right.perceptual_hash) <= NEAR_DUPLICATE_DISTANCE ||
    (left.source_group !== null && left.source_group === right.source_group) ||
    (left.creator_group !== null && left.creator_group === right.creator_group);
}

/** Connected components make transitive variants stay in one role. */
export function assignDuplicateGroups(rows: readonly DatasetImage[]): DatasetImage[] {
  const parents = rows.map((_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parents[at] !== at) at = parents[at] ?? at;
    return at;
  };
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const left = rows[i];
      const right = rows[j];
      if (left !== undefined && right !== undefined && sameGroup(left, right)) parents[root(i)] = root(j);
    }
  }
  const groups = new Map<number, DatasetImage[]>();
  rows.forEach((row, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  const groupName = new Map<string, string>();
  for (const members of groups.values()) {
    const roles = new Set(members.map((row) => row.dataset_role));
    if (roles.size > 1) throw new Error(`cross-role duplicate/source/creator group: ${members.map((row) => row.image_id).join(', ')}`);
    const representative = members.map((row) => row.image_id).sort()[0] ?? '';
    for (const member of members) groupName.set(member.image_id, representative);
  }
  const firstBySha = new Map<string, string>();
  return [...rows].sort((a, b) => a.image_id.localeCompare(b.image_id)).map((row) => {
    const prior = firstBySha.get(row.sha256) ?? null;
    if (prior === null) firstBySha.set(row.sha256, row.image_id);
    return { ...row, duplicate_of: prior, split_group: groupName.get(row.image_id) ?? row.image_id };
  });
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, path);
}

function readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => schema.parse(JSON.parse(line) as unknown));
}

function writeJsonl<T>(path: string, rows: readonly T[]): void {
  atomicWrite(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length > 0 ? '\n' : ''}`);
}

function manifestPath(root: string): string { return join(root, 'manifest.jsonl'); }
function humanPath(root: string): string { return join(root, 'human-labels.jsonl'); }
function featurePath(root: string, sha: string, version = EXTRACTOR_VERSION): string {
  return join(root, 'features', `${sha}.${version}.json`);
}
function assessmentPath(root: string, imageId: string, model = MODEL, rubric = RUBRIC_FINGERPRINT): string {
  return join(root, 'assessments', `${sha256(Buffer.from(JSON.stringify([imageId, model, rubric])))}.json`);
}

export function loadManifest(root: string): DatasetImage[] {
  const rows = readJsonl(manifestPath(root), DatasetImage);
  if (new Set(rows.map((row) => row.image_id)).size !== rows.length) throw new Error('duplicate image_id in dataset manifest');
  return assignDuplicateGroups(rows);
}

function saveManifest(root: string, rows: readonly DatasetImage[]): DatasetImage[] {
  const grouped = assignDuplicateGroups(rows);
  writeJsonl(manifestPath(root), grouped);
  return grouped;
}

function appendGrouped(root: string, rows: readonly DatasetImage[], incoming: DatasetImage): DatasetImage[] {
  const related = rows.filter((row) => sameGroup(row, incoming));
  if (related.some((row) => row.dataset_role !== incoming.dataset_role)) {
    throw new Error(`cross-role duplicate/source/creator group: ${incoming.image_id}`);
  }
  const mergedGroups = new Set(related.map((row) => row.split_group));
  const representative = [incoming.image_id, ...related.map((row) => row.split_group)].sort()[0] ?? incoming.image_id;
  const duplicateOf = rows.find((row) => row.sha256 === incoming.sha256)?.image_id ?? null;
  const next = rows.map((row) => mergedGroups.has(row.split_group)
    ? { ...row, split_group: representative } : row);
  next.push({ ...incoming, duplicate_of: duplicateOf, split_group: representative });
  next.sort((a, b) => a.image_id.localeCompare(b.image_id));
  writeJsonl(manifestPath(root), next);
  return next;
}

function loadFeature(root: string, sha: string): FeatureArtifact | null {
  const path = featurePath(root, sha);
  if (!existsSync(path)) return null;
  const record = FeatureArtifact.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (record.sha256 !== sha || record.extractor_version !== EXTRACTOR_VERSION ||
      record.features.extractorVersion !== EXTRACTOR_VERSION) throw new Error('feature cache identity/version mismatch');
  return record;
}

/** Offline labelers consume only a verified vector from the active extractor. */
export function loadDatasetFeature(root: string, row: DatasetImage): FeatureVector {
  if (row.feature_status !== 'ready' || row.extractor_version !== EXTRACTOR_VERSION) {
    throw new Error(`current extracted features unavailable for ${row.image_id}`);
  }
  const artifact = loadFeature(root, row.sha256);
  if (artifact === null) throw new Error(`feature artifact missing for ${row.image_id}`);
  return artifact.features;
}

function saveFeature(root: string, sha: string, features: FeatureVector): void {
  if (features.extractorVersion !== EXTRACTOR_VERSION) throw new Error('incompatible extractor version');
  const record = FeatureArtifact.parse({ sha256: sha, extractor_version: EXTRACTOR_VERSION, features });
  atomicWrite(featurePath(root, sha), `${JSON.stringify(record)}\n`);
}

function loadAssessment(root: string, imageId: string): VlmLabel | null {
  const path = assessmentPath(root, imageId);
  if (!existsSync(path)) return null;
  const record = VlmLabel.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (record.image_id !== imageId || record.model !== MODEL || record.rubric_fingerprint !== RUBRIC_FINGERPRINT) {
    throw new Error('VLM cache identity mismatch');
  }
  return record;
}

function saveAssessment(root: string, imageId: string, outcome: JudgeOutcome): VlmLabel {
  const result = outcome.ok
    ? { status: 'assessed' as const, assessment: outcome.assessment }
    : { status: 'declined' as const, reason: outcome.reason, detail: '' };
  const record = VlmLabel.parse({ source: 'vlm', image_id: imageId, model: MODEL,
    rubric_fingerprint: RUBRIC_FINGERPRINT, result, created_at: new Date().toISOString() });
  atomicWrite(assessmentPath(root, imageId), `${JSON.stringify(record)}\n`);
  return record;
}

export function mergeHumanLabels(existing: readonly HumanLabel[], additions: readonly HumanLabel[]): HumanLabel[] {
  const byKey = new Map(existing.map((row) => [`${row.image_id}|${row.axis}|${row.cohort}|${row.rater}`, row]));
  for (const row of additions) {
    const parsed = HumanLabel.parse(row);
    const key = `${parsed.image_id}|${parsed.axis}|${parsed.cohort}|${parsed.rater}`;
    const prior = byKey.get(key);
    if (prior !== undefined && prior.score !== parsed.score) throw new Error(`human label conflict at ${key}`);
    byKey.set(key, parsed);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.image_id}|${a.axis}|${a.cohort}`.localeCompare(`${b.image_id}|${b.axis}|${b.cohort}`));
}

function saveHumanLabels(root: string, additions: readonly HumanLabel[]): void {
  const existing = readJsonl(humanPath(root), HumanLabel);
  writeJsonl(humanPath(root), mergeHumanLabels(existing, additions));
}

export function loadHumanLabels(root: string): HumanLabel[] { return readJsonl(humanPath(root), HumanLabel); }

function mimeFromFormat(format: string): z.infer<typeof Mime> {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  throw new Error(`unsupported existing source format: ${format}`);
}

function rowFromFeature(root: string, source: Omit<SourceImage, 'file_path' | 'download_url' | 'declared_mime_type'>,
  file: string, sha: string, phash: string, features: FeatureVector, human: 'none' | 'partial' | 'complete'): DatasetImage {
  const eligible = !belowDimensionFloor(features.width, features.height);
  return DatasetImage.parse({ ...source, file_path: relative(root, resolve(file)), sha256: sha,
    perceptual_hash: phash, duplicate_of: null, split_group: source.image_id,
    width: features.width, height: features.height, mime_type: mimeFromFormat(features.sourceFormat),
    extractor_version: features.extractorVersion, feature_status: 'ready',
    vlm_status: !eligible ? 'skipped_ineligible' : features.faceCount === 0 ? 'skipped_no_face' : 'pending',
    human_label_status: human, eligible_for_product_scoring: eligible,
    eligibility_reason: eligible ? null : 'below_dimension_floor' });
}

function creatorGroup(creator: string | null): string | null {
  if (creator === null || /^\s*(unknown|not stated|no(t)? known|anonymous|n\/?a|none|-)\b/i.test(creator)) return null;
  return `creator:${creator.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

function sourceFields(source: SourceImage): Pick<DatasetImage,
  'image_id' | 'source' | 'source_url' | 'creator' | 'license' | 'license_url' |
  'dataset_role' | 'cohort' | 'source_group' | 'creator_group'> {
  return { image_id: source.image_id, source: source.source, source_url: source.source_url,
    creator: source.creator, license: source.license, license_url: source.license_url,
    dataset_role: source.dataset_role, cohort: source.cohort,
    source_group: source.source_group ?? source.source_url,
    creator_group: source.creator_group ?? creatorGroup(source.creator) };
}

export interface BootstrapPaths {
  readonly validationDir?: string;
  readonly corpusManifest?: string;
  readonly corpusFeatures?: string;
  readonly framingLabels?: string;
  /** Fixture-only overrides; the CLI always requires the real 125/40 cohorts. */
  readonly expectedSeedImages?: number;
  readonly expectedFramingImages?: number;
}

/** Copy metadata and cached vectors; never rewrite the original bytes or labels. */
export async function bootstrapExisting(root: string, paths: BootstrapPaths = {}): Promise<{ seed: number; framing: number; labels: number }> {
  const validationDir = paths.validationDir ?? 'data/validation';
  const corpusManifest = paths.corpusManifest ?? 'data/manifest.csv';
  const corpusFeatures = paths.corpusFeatures ?? 'data/features.jsonl';
  const framingLabels = paths.framingLabels ?? 'data/corpus-framing-labels.csv';
  const lookup = JSON.parse(readFileSync(join(validationDir, 'features.json'), 'utf8')) as unknown;
  const entries = z.record(z.strictObject({ folder: z.enum(['GOOD', 'MEDIUM', 'BAD']), sha256: Sha, features: ComputedFeatures })).parse(lookup);
  const labels = parseCsvObjects(readFileSync(join(validationDir, 'calibration-labels.csv'), 'utf8'));
  const sources = new Map(parseCsvObjects(readFileSync(join(validationDir, 'sources.csv'), 'utf8'))
    .map((row) => [row['image_id'], row]));
  const expectedSeed = paths.expectedSeedImages ?? 125;
  const expectedFraming = paths.expectedFramingImages ?? 40;
  if (Object.keys(entries).length !== expectedSeed || labels.length !== expectedSeed * 4 || sources.size !== expectedSeed) {
    throw new Error(`seed dataset is not the expected ${expectedSeed} images / ${expectedSeed * 4} labels`);
  }

  const additions: DatasetImage[] = [];
  const human: HumanLabel[] = [];
  for (const [filename, entry] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const imageId = filename.replace(/\.jpg$/i, '');
    const source = sources.get(imageId);
    if (source === undefined) throw new Error(`missing seed source: ${imageId}`);
    const file = resolve(validationDir, entry.folder, filename);
    const bytes = readFileSync(file);
    if (sha256(bytes) !== entry.sha256) throw new Error(`seed image SHA mismatch: ${imageId}`);
    if (entry.features.extractorVersion !== EXTRACTOR_VERSION) throw new Error(`stale seed features: ${imageId}`);
    const sourceUrl = source['source_page_url'] ?? '';
    additions.push(rowFromFeature(root, {
      image_id: imageId, source: source['source'] ?? 'Wikimedia Commons', source_url: sourceUrl || null,
      creator: source['creator'] || null, license: source['license'] ?? '', license_url: source['license_url'] || null,
      dataset_role: 'development', cohort: 'wikimedia_seed_125', source_group: sourceUrl || null,
      creator_group: creatorGroup(source['creator'] || null),
    }, file, entry.sha256, await perceptualHash(bytes), entry.features, 'complete'));
    if (loadFeature(root, entry.sha256) === null) saveFeature(root, entry.sha256, entry.features);
  }
  for (const row of labels) {
    const filename = row['filename'] ?? '';
    const imageId = filename.replace(/\.jpg$/i, '');
    if (!entries[filename]) throw new Error(`seed label without image: ${filename}`);
    human.push(HumanLabel.parse({ source: 'human', image_id: imageId, axis: row['axis'],
      score: Number(row['score']), cohort: 'wikimedia_seed_125', rater: 'original_seed_pass' }));
  }
  if (new Set(human.map((row) => `${row.image_id}|${row.axis}`)).size !== expectedSeed * 4) throw new Error('duplicate or missing seed axis labels');

  const corpusRows = parseCsvObjects(readFileSync(corpusManifest, 'utf8'));
  const corpusBySha = new Map(corpusRows.map((row) => [row['sha256'], row]));
  const vectors = new Map<string, FeatureVector>();
  for (const line of readFileSync(corpusFeatures, 'utf8').split('\n').filter(Boolean)) {
    const parsed = FeatureArtifact.omit({ extractor_version: true }).parse(JSON.parse(line) as unknown);
    vectors.set(parsed.sha256, parsed.features);
  }
  const framing = parseCsvObjects(readFileSync(framingLabels, 'utf8'));
  if (framing.length !== expectedFraming) throw new Error(`framing cohort is not the expected ${expectedFraming} labels`);
  for (const label of framing) {
    const sha = Sha.parse(label['filename']);
    const source = corpusBySha.get(sha);
    const features = vectors.get(sha);
    if (source === undefined || features === undefined) throw new Error(`framing cohort missing source/features: ${sha}`);
    if (features.extractorVersion !== EXTRACTOR_VERSION) throw new Error(`stale framing cohort features: ${sha}`);
    const file = resolve(source['file'] ?? '');
    const bytes = readFileSync(file);
    if (sha256(bytes) !== sha) throw new Error(`framing cohort SHA mismatch: ${sha}`);
    const imageId = `pexels:${sha}`;
    const sourceUrl = source['url'] ?? '';
    additions.push(rowFromFeature(root, {
      image_id: imageId, source: 'Pexels', source_url: sourceUrl || null,
      creator: source['photographer'] || null, license: source['licence'] ?? '',
      license_url: 'https://www.pexels.com/license/', dataset_role: 'development',
      cohort: 'pexels_framing_40', source_group: sourceUrl || null,
      creator_group: creatorGroup(source['photographer'] || null),
    }, file, sha, await perceptualHash(bytes), features, 'partial'));
    if (loadFeature(root, sha) === null) saveFeature(root, sha, features);
    human.push(HumanLabel.parse({ source: 'human', image_id: imageId, axis: 'framing',
      score: Number(label['score']), cohort: 'pexels_framing_40', rater: 'original_framing_pass' }));
  }

  const current = loadManifest(root);
  const byId = new Map(current.map((row) => [row.image_id, row]));
  for (const row of additions) {
    const prior = byId.get(row.image_id);
    if (prior !== undefined && (prior.sha256 !== row.sha256 || prior.dataset_role !== row.dataset_role || prior.cohort !== row.cohort)) {
      throw new Error(`seed identity changed: ${row.image_id}`);
    }
    if (prior === undefined) byId.set(row.image_id, row);
  }
  saveHumanLabels(root, human);
  saveManifest(root, [...byId.values()]);
  return { seed: expectedSeed, framing: expectedFraming, labels: human.length };
}

export interface BatchSummary {
  processed: number;
  featureReused: number;
  featureExtracted: number;
  vlmReused: number;
  vlmRequested: number;
  noFaceSkipped: number;
  declined: number;
  failed: number;
}

export interface BatchOptions {
  readonly root: string;
  readonly sourceBase?: string;
  readonly allowDownload?: boolean;
  readonly withVlm?: boolean;
  readonly concurrency?: number;
  readonly vlmConcurrency?: number;
  /** Injection is for fixture tests; production uses the canonical implementations. */
  readonly extract?: (bytes: Buffer) => Promise<FeatureVector>;
  readonly judge?: (bytes: Buffer) => Promise<JudgeOutcome>;
}

function bounded(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new RangeError('concurrency must be 1–8');
  return n;
}

function semaphore(capacity: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= capacity) await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
    try { return await work(); }
    finally { active -= 1; waiters.shift()?.(); }
  };
}

async function readInput(source: SourceImage, base: string, allowDownload: boolean): Promise<Buffer> {
  if (source.file_path !== undefined) return readFileSync(resolve(base, source.file_path));
  if (!allowDownload || source.download_url === undefined) throw new Error('remote download requires --allow-download');
  if (!source.download_url.startsWith('https://')) throw new Error('only HTTPS downloads are allowed');
  const response = await fetch(source.download_url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') ?? '0');
  if (declaredSize > MAX_UPLOAD_BYTES) throw new Error('image exceeds upload size limit');
  if (response.body === null) throw new Error('download returned no body');
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new Error('image exceeds upload size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function appendFailure(root: string, imageId: string, stage: string, error: unknown): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'failures.jsonl'), `${JSON.stringify({ image_id: imageId, stage,
    message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })}\n`);
}

/** The manifest is the index; feature and assessment artifacts have separate identities. */
export async function processBatch(sources: readonly SourceImage[], options: BatchOptions): Promise<BatchSummary> {
  const root = resolve(options.root);
  const base = resolve(options.sourceBase ?? '.');
  const extract = options.extract ?? extractAll;
  const judge = options.judge ?? judgePhoto;
  const withVlm = options.withVlm ?? false;
  const concurrency = bounded(options.concurrency, 2);
  const withVlmPermit = semaphore(bounded(options.vlmConcurrency, 1));
  if (new Set(sources.map((row) => row.image_id)).size !== sources.length) throw new Error('duplicate image_id in source batch');
  let rows = loadManifest(root);
  const inFlightFeatures = new Map<string, Promise<FeatureVector>>();
  const summary: BatchSummary = { processed: 0, featureReused: 0, featureExtracted: 0,
    vlmReused: 0, vlmRequested: 0, noFaceSkipped: 0, declined: 0, failed: 0 };
  const update = (row: DatasetImage): void => {
    const existing = rows.find((candidate) => candidate.image_id === row.image_id);
    if (existing === undefined) {
      rows = appendGrouped(root, rows, row);
      return;
    }
    if (existing.sha256 !== row.sha256 || existing.dataset_role !== row.dataset_role ||
        existing.source_group !== row.source_group || existing.creator_group !== row.creator_group) {
      throw new Error(`existing dataset identity changed: ${row.image_id}`);
    }
    rows = rows.map((candidate) => candidate.image_id === row.image_id
      ? { ...row, duplicate_of: existing.duplicate_of, split_group: existing.split_group }
      : candidate);
    writeJsonl(manifestPath(root), rows);
  };

  const runOne = async (source: SourceImage): Promise<void> => {
    summary.processed += 1;
    let stage = 'input';
    try {
      const bytes = await readInput(source, base, options.allowDownload ?? false);
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('image exceeds upload size limit');
      const mime = sniffMime(bytes);
      if (source.declared_mime_type !== null && source.declared_mime_type !== mime) throw new Error('declared/detected MIME mismatch');
      const sha = sha256(bytes);
      const phash = await perceptualHash(bytes);
      const prior = rows.find((row) => row.image_id === source.image_id);
      const metadata = sourceFields(source);
      if (prior !== undefined && (prior.sha256 !== sha || prior.dataset_role !== source.dataset_role ||
          prior.cohort !== source.cohort || prior.source_group !== metadata.source_group ||
          prior.creator_group !== metadata.creator_group)) {
        throw new Error('existing image identity/role differs from source');
      }
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
      const stored = join(root, 'images', `${sha}.${extension}`);
      const row = prior ?? DatasetImage.parse({ ...metadata, file_path: relative(root, stored), sha256: sha,
        perceptual_hash: phash, duplicate_of: null, split_group: source.image_id,
        width: null, height: null, mime_type: mime, extractor_version: null,
        feature_status: 'pending', vlm_status: 'pending', human_label_status: 'none',
        eligible_for_product_scoring: null, eligibility_reason: 'features_unavailable' });
      if (prior === undefined) update(row); // rejects cross-role exact/near/source/creator leakage before work
      if (!existsSync(stored)) { mkdirSync(dirname(stored), { recursive: true }); writeFileSync(stored, bytes); }
      else if (sha256(readFileSync(stored)) !== sha) throw new Error('stored dataset image SHA mismatch');

      stage = 'features';
      let artifact = loadFeature(root, sha);
      let features: FeatureVector;
      if (artifact !== null) {
        features = artifact.features;
        summary.featureReused += 1;
      } else {
        let pending = inFlightFeatures.get(sha);
        if (pending === undefined) {
          pending = extract(bytes).then((vector) => {
            const valid = ComputedFeatures.parse(vector);
            saveFeature(root, sha, valid);
            summary.featureExtracted += 1;
            return valid;
          }).finally(() => inFlightFeatures.delete(sha));
          inFlightFeatures.set(sha, pending);
        } else {
          summary.featureReused += 1;
        }
        features = await pending;
        artifact = loadFeature(root, sha);
        if (artifact === null) throw new Error('feature artifact disappeared after extraction');
      }
      const eligible = !belowDimensionFloor(features.width, features.height);
      const indexed = rows.find((candidate) => candidate.image_id === source.image_id) ?? row;
      let current = DatasetImage.parse({ ...indexed, width: features.width, height: features.height,
        extractor_version: EXTRACTOR_VERSION, feature_status: 'ready',
        eligible_for_product_scoring: eligible,
        eligibility_reason: eligible ? null : 'below_dimension_floor',
        vlm_status: !eligible ? 'skipped_ineligible' : features.faceCount === 0 ? 'skipped_no_face' : indexed.vlm_status });
      update(current);
      if (!eligible) return;
      if (features.faceCount === 0) { summary.noFaceSkipped += 1; return; }
      if (!withVlm) return;

      stage = 'vlm';
      let assessment = loadAssessment(root, source.image_id);
      if (assessment === null) {
        const outcome = await withVlmPermit(async () => { summary.vlmRequested += 1; return judge(bytes); });
        assessment = saveAssessment(root, source.image_id, outcome);
      } else {
        summary.vlmReused += 1;
      }
      current = DatasetImage.parse({ ...current, vlm_status: assessment.result.status === 'assessed' ? 'assessed' : 'declined' });
      if (assessment.result.status === 'declined') summary.declined += 1;
      update(current);
    } catch (error) {
      summary.failed += 1;
      appendFailure(root, source.image_id, stage, error);
      const row = rows.find((candidate) => candidate.image_id === source.image_id);
      if (row !== undefined && stage === 'features') update(DatasetImage.parse({ ...row, feature_status: 'failed' }));
      if (row !== undefined && stage === 'vlm') update(DatasetImage.parse({ ...row, vlm_status: 'failed' }));
    }
  };

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    while (cursor < sources.length) {
      const source = sources[cursor];
      cursor += 1;
      if (source !== undefined) await runOne(source);
    }
  }));
  return summary;
}

function count(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function distribution(values: readonly number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
  return { n: sorted.length, min: sorted[0] ?? 0, p10: at(0.1), p25: at(0.25),
    median: at(0.5), p75: at(0.75), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0 };
}

function featureFor(root: string, row: DatasetImage): FeatureVector | null {
  if (row.feature_status !== 'ready') return null;
  return loadFeature(root, row.sha256)?.features ?? null;
}

/** Read-only inventory; nulls are excluded and the reported n exposes coverage. */
export function datasetReport(root: string): Record<string, unknown> {
  const rows = loadManifest(root);
  const features = rows.map((row) => featureFor(root, row));
  const groups = count(rows.map((row) => row.split_group));
  const nearPairs: Array<{ image_ids: readonly [string, string]; distance: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const left = rows[i];
      const right = rows[j];
      if (left === undefined || right === undefined || left.sha256 === right.sha256) continue;
      const distance = hammingDistance(left.perceptual_hash, right.perceptual_hash);
      if (distance <= NEAR_DUPLICATE_DISTANCE) {
        nearPairs.push({ image_ids: [right.image_id, left.image_id], distance });
      }
    }
  }
  const measure = (read: (features: FeatureVector) => number | null): Record<string, number> | null => {
    const values: number[] = [];
    for (const entry of features) {
      if (entry === null) continue;
      const value = read(entry);
      if (value !== null) values.push(value);
    }
    return distribution(values);
  };
  const judgments: Record<string, Record<string, number>> = {};
  for (const axis of ['background', 'attire', 'expression', 'solo'] as const) {
    const scores: string[] = [];
    for (const row of rows) {
      const assessment = loadAssessment(root, row.image_id);
      if (assessment?.result.status === 'assessed') scores.push(String(assessment.result.assessment[axis].score));
    }
    judgments[axis] = count(scores);
  }
  return {
    images: rows.length,
    source: count(rows.map((row) => row.source)),
    cohort: count(rows.map((row) => row.cohort)),
    dataset_role: count(rows.map((row) => row.dataset_role)),
    eligibility: count(rows.map((row) => row.eligible_for_product_scoring === null ? 'unknown' :
      row.eligible_for_product_scoring ? 'eligible' : row.eligibility_reason ?? 'ineligible')),
    feature_status: count(rows.map((row) => row.feature_status)),
    vlm_status: count(rows.map((row) => row.vlm_status)),
    exact_duplicates: rows.filter((row) => row.duplicate_of !== null).length,
    split_groups_with_multiple_images: Object.fromEntries(Object.entries(groups).filter(([, n]) => n > 1)),
    likely_near_duplicate_pairs: nearPairs,
    measurements: {
      width: measure((f) => f.width), height: measure((f) => f.height),
      shorter_edge: measure((f) => Math.min(f.width, f.height)),
      face_count: measure((f) => f.faceCount), face_area_ratio: measure((f) => f.faceAreaRatio),
      face_center_offset_x: measure((f) => f.faceCenterOffsetX),
      face_center_offset_y: measure((f) => f.faceCenterOffsetY),
      sharpness_laplacian: measure((f) => f.sharpnessLaplacian),
      sharpness_eye_region: measure((f) => f.sharpnessEyeRegion),
      face_exposure_mean: measure((f) => f.faceExposureMean),
      face_clipped_highlights: measure((f) => f.faceClippedHighlights),
      face_clipped_shadows: measure((f) => f.faceClippedShadows),
      framing_raw: measure((f) => framingRaw(f, WEIGHTS_V1)),
      lighting_raw: measure((f) => lightingRaw(f, WEIGHTS_V1)),
    },
    vlm_axes: judgments,
  };
}

export interface LabelCandidate {
  readonly image_id: string;
  readonly axes_to_label: readonly (typeof COMPUTED_LABEL_AXES)[number][];
  readonly coverage_priority: number;
  readonly reasons: readonly string[];
}

/** Selects only review candidates; it never writes or guesses a human label. */
export function selectHumanCandidates(root: string, limit = 100): LabelCandidate[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be positive');
  const labels = new Map<string, Set<string>>();
  for (const label of loadHumanLabels(root)) {
    if (!COMPUTED_LABEL_AXES.some((axis) => axis === label.axis)) continue;
    const axes = labels.get(label.image_id) ?? new Set<string>();
    axes.add(label.axis);
    labels.set(label.image_id, axes);
  }
  const items = loadManifest(root).filter((row) => row.dataset_role === 'development' &&
    row.feature_status === 'ready')
    .map((row) => ({ row, features: featureFor(root, row) }))
    .filter((item): item is { row: DatasetImage; features: FeatureVector } => item.features !== null);
  const dimensions = [
    { name: 'sharpness', read: (f: FeatureVector): number => Math.log1p(f.sharpnessEyeRegion ?? f.sharpnessLaplacian) },
    { name: 'lighting', read: (f: FeatureVector): number => lightingRaw(f, WEIGHTS_V1) },
    { name: 'resolution', read: (f: FeatureVector): number => Math.log1p(Math.min(f.width, f.height)) },
    { name: 'framing', read: (f: FeatureVector): number => framingRaw(f, WEIGHTS_V1) },
  ];
  const values = dimensions.map((dimension) => items.map((item) => dimension.read(item.features)));
  const bins = values.map((series) => {
    const low = Math.min(...series);
    const high = Math.max(...series);
    return series.map((value) => high === low ? 0 : Math.min(7, Math.floor(((value - low) / (high - low)) * 8)));
  });
  const labeledFrequencies = bins.map((series, at) => count(series.flatMap((bucket, index) => {
    const item = items[index];
    const axis = dimensions[at]?.name;
    return item !== undefined && axis !== undefined && labels.get(item.row.image_id)?.has(axis)
      ? [String(bucket)] : [];
  })));
  const candidates = items.map(({ row, features }, index) => {
    const axesToLabel = COMPUTED_LABEL_AXES.filter((axis) => !labels.get(row.image_id)?.has(axis));
    if (axesToLabel.length === 0) return null;
    const reasons: string[] = [];
    let priority = 0;
    dimensions.forEach((dimension, at) => {
      if (!axesToLabel.some((axis) => axis === dimension.name)) return;
      const bucket = bins[at]?.[index] ?? 0;
      priority += 1 / (1 + (labeledFrequencies[at]?.[String(bucket)] ?? 0));
      if (bucket === 0) reasons.push(`low ${dimension.name}`);
      if (bucket === 7) reasons.push(`high ${dimension.name}`);
    });
    if (features.faceCount === 0) reasons.push('no face');
    if (features.faceCount > 1) reasons.push('multiple faces');
    if (row.eligible_for_product_scoring === false) reasons.push('below product dimension floor');
    return { image_id: row.image_id, axes_to_label: axesToLabel, coverage_priority: priority, reasons,
      group: row.split_group };
  }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => b.coverage_priority - a.coverage_priority || a.image_id.localeCompare(b.image_id));
  const selected: LabelCandidate[] = [];
  const groups = new Set<string>();
  for (const candidate of candidates) {
    if (groups.has(candidate.group)) continue;
    groups.add(candidate.group);
    selected.push({ image_id: candidate.image_id, axes_to_label: candidate.axes_to_label,
      coverage_priority: candidate.coverage_priority,
      reasons: candidate.reasons });
    if (selected.length >= limit) break;
  }
  return selected;
}

function option(args: readonly string[], name: string, fallback?: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

export async function datasetMain(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (command === undefined || !['bootstrap', 'ingest', 'report', 'candidates'].includes(command)) {
    process.stdout.write('usage: dataset <bootstrap|ingest|report|candidates> --out <dataset-dir> [--source <source.jsonl>] [--vlm] [--allow-download]\n');
    return 2;
  }
  const root = option(args, '--out', 'data/dataset-v1');
  if (command === 'bootstrap') {
    process.stdout.write(`${JSON.stringify(await bootstrapExisting(root))}\n`);
  } else if (command === 'ingest') {
    const sourcePath = resolve(option(args, '--source'));
    const sources = readJsonl(sourcePath, SourceImage);
    const summary = await processBatch(sources, { root, sourceBase: dirname(sourcePath),
      withVlm: args.includes('--vlm'), allowDownload: args.includes('--allow-download'),
      concurrency: Number(option(args, '--concurrency', '2')),
      vlmConcurrency: Number(option(args, '--vlm-concurrency', '1')) });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.failed > 0) return 1;
  } else if (command === 'report') {
    process.stdout.write(`${JSON.stringify(datasetReport(root), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(selectHumanCandidates(root, Number(option(args, '--limit', '100'))), null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1]?.endsWith('/dataset.js')) {
  datasetMain(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
