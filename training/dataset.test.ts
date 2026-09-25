import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizedPipeline } from '@pps/features';
import { ACTIVE_VLM_MODEL, ComputedFeatures } from '@pps/schema';
import type { ComputedFeatures as FeatureVector } from '@pps/schema';

import { parseCsvObjects } from './csv.js';
import {
  assignDuplicateGroups, bootstrapExisting, DatasetImage, datasetReport, FeatureArtifact, hammingDistance,
  HumanLabel, loadHumanLabels, loadManifest, mergeHumanLabels, perceptualHash, processBatch,
  RUBRIC_FINGERPRINT, selectHumanCandidates, sha256, SourceImage, VlmLabel,
} from './dataset.js';

const created: string[] = [];
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'pps-dataset-'));
  created.push(root);
  return root;
}
afterEach(() => { for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true }); });

const portrait = readFileSync(new URL('../packages/features/fixtures/portrait.jpg', import.meta.url));
function features(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return ComputedFeatures.parse({
    sharpnessLaplacian: 200, sharpnessEyeRegion: 300, eyeRegionMeasured: true,
    jpegQualityEstimate: 90, exposureMean: 120, clippedHighlights: 0,
    clippedShadows: 0, dynamicRange: 200, faceExposureMean: 120,
    faceClippedHighlights: 0, faceClippedShadows: 0, faceRegionMeasured: true,
    exposureDelta: 0, width: 600, height: 750, faceAreaRatio: 0.15,
    faceCenterOffsetX: 0, faceCenterOffsetY: 0, faceCount: 1,
    yaw: 0, roll: 0, pitch: null, eyeOpenness: null, smileIntensity: null,
    primaryFaceConfidence: 0.9, secondLargestFaceRatio: null,
    isGrayscale: false, aspectExtreme: false, sourceFormat: 'jpeg', extractorVersion: 'v7',
    ...overrides,
  });
}
function source(id: string, path: string, role: 'development' | 'validation' | 'final_test' = 'development') {
  return SourceImage.parse({ image_id: id, file_path: path, source: 'fixture', source_url: null,
    creator: null, license: 'fixture licence', license_url: null, dataset_role: role,
    cohort: 'fixture', source_group: null, creator_group: null, declared_mime_type: 'image/jpeg' });
}
function image(id: string, hash: string, phash = '0000000000000000', role: 'development' | 'final_test' = 'development') {
  return DatasetImage.parse({ image_id: id, file_path: `images/${id}.jpg`, source: 'fixture',
    source_url: null, creator: null, license: 'fixture', license_url: null,
    sha256: hash, perceptual_hash: phash, dataset_role: role, cohort: 'fixture',
    source_group: null, creator_group: null, duplicate_of: null, split_group: id,
    width: 600, height: 750, mime_type: 'image/jpeg', extractor_version: 'v7',
    feature_status: 'ready', vlm_status: 'pending', human_label_status: 'none',
    eligible_for_product_scoring: true, eligibility_reason: null });
}
function assessed() {
  const axis = { evidence: 'Visible photographic details.', score: 4 };
  return { ok: true as const, assessment: { background: axis, attire: axis,
    expression: axis, solo: axis,
    framing_observation: { crop: 'head_and_shoulders' as const, face_roughly_centered: true } } };
}

describe('dataset provenance and split identity', () => {
  it('preserves the tracked 125 seed IDs with exactly four existing human labels each', () => {
    const rows = parseCsvObjects(readFileSync(new URL('../data/validation/calibration-labels.csv', import.meta.url), 'utf8'));
    const ids = new Set(rows.map((row) => row['filename']));
    expect(rows).toHaveLength(500);
    expect(ids.size).toBe(125);
    for (const id of ids) expect(rows.filter((row) => row['filename'] === id).map((row) => row['axis']).sort())
      .toEqual(['framing', 'lighting', 'resolution', 'sharpness']);
  });

  it('keeps human labels separate and refuses to overwrite a conflicting rating', () => {
    const human = HumanLabel.parse({ source: 'human', image_id: 'G001', axis: 'sharpness',
      score: 2, cohort: 'wikimedia_seed_125', rater: 'original' });
    expect(mergeHumanLabels([human], [human])).toEqual([human]);
    expect(() => mergeHumanLabels([human], [{ ...human, score: 3 }])).toThrow(/conflict/);
    expect(VlmLabel.safeParse(human).success).toBe(false);
    expect(HumanLabel.safeParse({ ...human, source: 'vlm' }).success).toBe(false);
  });

  it('groups exact and likely near duplicates, and rejects cross-role leakage', () => {
    const x = 'a'.repeat(64);
    const y = 'b'.repeat(64);
    const grouped = assignDuplicateGroups([image('A', x), image('B', x), image('C', y, '0000000000000001')]);
    expect(grouped.map((row) => row.split_group)).toEqual(['A', 'A', 'A']);
    expect(grouped.find((row) => row.image_id === 'B')?.duplicate_of).toBe('A');
    expect(() => assignDuplicateGroups([image('A', x), image('B', x, '0000000000000000', 'final_test')]))
      .toThrow(/cross-role/);
  });

  it('keeps a known creator group in one role even when image hashes differ', () => {
    const a = DatasetImage.parse({ ...image('A', 'a'.repeat(64), '0000000000000000'),
      creator_group: 'creator:ada' });
    const b = DatasetImage.parse({ ...image('B', 'b'.repeat(64), 'ffffffffffffffff', 'final_test'),
      creator_group: 'creator:ada' });
    expect(() => assignDuplicateGroups([a, b])).toThrow(/cross-role/);
  });

  it('computes the same perceptual hash after a resize', async () => {
    const resized = await normalizedPipeline(portrait).resize(300, 375).jpeg().toBuffer();
    const distance = hammingDistance(await perceptualHash(portrait), await perceptualHash(resized));
    expect(distance).toBeLessThanOrEqual(6);
  });

  it('imports seed and framing cohorts separately without changing source labels or images', async () => {
    const root = temporary();
    const validation = join(root, 'validation');
    for (const folder of ['GOOD', 'MEDIUM']) mkdirSync(join(validation, folder), { recursive: true });
    const second = await normalizedPipeline(portrait).resize(300, 375).jpeg().toBuffer();
    const third = await normalizedPipeline(portrait).resize(320, 400).jpeg().toBuffer();
    writeFileSync(join(validation, 'GOOD', 'G001.jpg'), portrait);
    writeFileSync(join(validation, 'MEDIUM', 'M001.jpg'), second);
    const pexelsFile = join(root, 'pexels.jpg'); writeFileSync(pexelsFile, third);
    const lookup = { 'G001.jpg': { folder: 'GOOD', sha256: sha256(portrait), features: features() },
      'M001.jpg': { folder: 'MEDIUM', sha256: sha256(second), features: features({ width: 300, height: 375 }) } };
    writeFileSync(join(validation, 'features.json'), JSON.stringify(lookup));
    const labelLines = ['filename,axis,score',
      ...['G001.jpg', 'M001.jpg'].flatMap((name) =>
        ['sharpness', 'lighting', 'resolution', 'framing'].map((axis) => `${name},${axis},3`))];
    const originalLabels = `${labelLines.join('\n')}\n`;
    writeFileSync(join(validation, 'calibration-labels.csv'), originalLabels);
    writeFileSync(join(validation, 'sources.csv'), 'image_id,source,source_page_url,creator,license,license_url\n' +
      'G001,Wikimedia Commons,https://example.org/g,Ada,CC0,https://example.org/license\n' +
      'M001,Wikimedia Commons,https://example.org/m,"Someone\nElse",CC0,https://example.org/license\n');
    const manifest = join(root, 'corpus.csv');
    writeFileSync(manifest, `sha256,url,file,photographer,licence\n${sha256(third)},https://example.org/p,${pexelsFile},Pat,Pexels License\n`);
    const vectors = join(root, 'corpus.jsonl');
    writeFileSync(vectors, `${JSON.stringify({ sha256: sha256(third), features: features({ width: 320, height: 400 }) })}\n`);
    const framing = join(root, 'framing.csv');
    writeFileSync(framing, `filename,axis,score\n${sha256(third)},framing,5\n`);
    const out = join(root, 'out');
    const config = { validationDir: validation, corpusManifest: manifest, corpusFeatures: vectors,
      framingLabels: framing, expectedSeedImages: 2, expectedFramingImages: 1 };
    expect(await bootstrapExisting(out, config)).toEqual({ seed: 2, framing: 1, labels: 9 });
    expect(await bootstrapExisting(out, config)).toEqual({ seed: 2, framing: 1, labels: 9 });
    expect(loadManifest(out)).toHaveLength(3);
    expect(loadManifest(out).map((row) => row.dataset_role)).toEqual(['development', 'development', 'development']);
    expect(loadHumanLabels(out).filter((row) => row.cohort === 'wikimedia_seed_125')).toHaveLength(8);
    expect(loadHumanLabels(out).filter((row) => row.cohort === 'pexels_framing_40')).toHaveLength(1);
    const candidates = selectHumanCandidates(out);
    expect(candidates).toEqual([expect.objectContaining({ image_id: `pexels:${sha256(third)}`,
      axes_to_label: ['sharpness', 'lighting', 'resolution'] })]);
    expect(readFileSync(join(validation, 'calibration-labels.csv'), 'utf8')).toBe(originalLabels);
    expect(sha256(readFileSync(join(validation, 'GOOD', 'G001.jpg')))).toBe(sha256(portrait));
  });
});

describe('offline batch stages', () => {
  it('marks 199 ineligible and 200 eligible; no face never calls the judge', async () => {
    const root = temporary();
    const a = join(root, 'a.jpg');
    const b = join(root, 'b.jpg');
    writeFileSync(a, await normalizedPipeline(portrait).resize(199, 250).jpeg().toBuffer());
    writeFileSync(b, await normalizedPipeline(portrait).resize(200, 250).jpeg().toBuffer());
    const extract = vi.fn(async (bytes: Buffer) => bytes.equals(readFileSync(a))
      ? features({ width: 199, height: 250, faceCount: 1 })
      : features({ width: 200, height: 250, faceCount: 0, faceAreaRatio: 0,
        sharpnessEyeRegion: null, eyeRegionMeasured: false, faceRegionMeasured: false,
        primaryFaceConfidence: null }));
    const judge = vi.fn(async () => assessed());
    const result = await processBatch([source('small', a), source('boundary', b)],
      { root: join(root, 'out'), withVlm: true, extract, judge });
    const rows = loadManifest(join(root, 'out'));
    expect(result.failed).toBe(0);
    expect(rows.find((row) => row.image_id === 'small')?.eligibility_reason).toBe('below_dimension_floor');
    expect(rows.find((row) => row.image_id === 'boundary')?.eligible_for_product_scoring).toBe(true);
    expect(rows.find((row) => row.image_id === 'boundary')?.vlm_status).toBe('skipped_no_face');
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'out', 'assessments'))).toBe(false);
  });

  it('reuses features by SHA and version, but assesses each photo independently and resumes', async () => {
    const root = temporary();
    const file = join(root, 'photo.jpg'); writeFileSync(file, portrait);
    const out = join(root, 'out');
    const extract = vi.fn(async () => features());
    const judge = vi.fn(async () => assessed());
    const first = await processBatch([source('A', file), source('B', file)],
      { root: out, withVlm: true, extract, judge, concurrency: 2 });
    expect(first.featureExtracted).toBe(1);
    expect(first.featureReused).toBe(1);
    expect(first.vlmRequested).toBe(2);
    expect(loadManifest(out)).toHaveLength(2);
    expect(loadManifest(out)[1]?.duplicate_of).toBe('A');
    const second = await processBatch([source('A', file), source('B', file)],
      { root: out, withVlm: true, extract, judge });
    expect(second.featureReused).toBe(2);
    expect(second.vlmReused).toBe(2);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(datasetReport(out)['vlm_axes']).toMatchObject({ background: { '4': 2 } });
  });

  it('does not accept a stale extractor-version artifact for the same SHA', async () => {
    const root = temporary(); const file = join(root, 'photo.jpg'); writeFileSync(file, portrait);
    const out = join(root, 'out'); const hash = sha256(portrait);
    const stale = join(out, 'features');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, `${hash}.v6.json`), JSON.stringify({ sha256: hash, extractor_version: 'v6', features: features() }));
    const extract = vi.fn(async () => features());
    const result = await processBatch([source('A', file)], { root: out, extract });
    expect(result.featureExtracted).toBe(1);
    expect(extract).toHaveBeenCalledOnce();
    expect(FeatureArtifact.parse(JSON.parse(readFileSync(join(stale, `${hash}.v7.json`), 'utf8'))).extractor_version).toBe('v7');
  });

  it('retries a failed VLM stage without re-extracting, and ignores an old model/rubric artifact', async () => {
    const root = temporary(); const file = join(root, 'photo.jpg'); writeFileSync(file, portrait);
    const out = join(root, 'out');
    const extract = vi.fn(async () => features());
    const failedJudge = vi.fn(async (): Promise<ReturnType<typeof assessed>> => { throw new Error('temporary provider failure'); });
    const first = await processBatch([source('A', file)], { root: out, withVlm: true, extract, judge: failedJudge });
    expect(first.failed).toBe(1);
    expect(loadManifest(out)[0]?.feature_status).toBe('ready');
    const oldRubric = '0'.repeat(64);
    const oldIdentity = createHash('sha256').update(JSON.stringify(['A', 'old-model', oldRubric])).digest('hex');
    const oldRubricIdentity = createHash('sha256').update(JSON.stringify(['A', ACTIVE_VLM_MODEL, oldRubric])).digest('hex');
    mkdirSync(join(out, 'assessments'), { recursive: true });
    writeFileSync(join(out, 'assessments', `${oldIdentity}.json`), JSON.stringify({ source: 'vlm', image_id: 'A',
      model: 'old-model', rubric_fingerprint: oldRubric, result: { status: 'assessed', assessment: assessed().assessment },
      created_at: new Date().toISOString() }));
    writeFileSync(join(out, 'assessments', `${oldRubricIdentity}.json`), JSON.stringify({ source: 'vlm', image_id: 'A',
      model: ACTIVE_VLM_MODEL, rubric_fingerprint: oldRubric,
      result: { status: 'assessed', assessment: assessed().assessment }, created_at: new Date().toISOString() }));
    const judge = vi.fn(async () => assessed());
    const retry = await processBatch([source('A', file)], { root: out, withVlm: true, extract, judge });
    expect(retry.featureReused).toBe(1);
    expect(retry.vlmRequested).toBe(1);
    expect(extract).toHaveBeenCalledOnce();
    expect(judge).toHaveBeenCalledOnce();
    expect(loadManifest(out)[0]?.vlm_status).toBe('assessed');
    expect(ACTIVE_VLM_MODEL).toBe('claude-sonnet-5');
    expect(RUBRIC_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists model refusal as a VLM decline without inventing four axis labels', async () => {
    const root = temporary(); const file = join(root, 'photo.jpg'); writeFileSync(file, portrait);
    const out = join(root, 'out');
    const judge = vi.fn(async () => ({ ok: false as const, reason: 'model_refusal' as const }));
    const first = await processBatch([source('A', file)], { root: out, withVlm: true,
      extract: async () => features(), judge });
    expect(first.declined).toBe(1);
    expect(loadManifest(out)[0]?.vlm_status).toBe('declined');
    expect(datasetReport(out)['vlm_axes']).toMatchObject({ solo: {} });
    const second = await processBatch([source('A', file)], { root: out, withVlm: true,
      extract: async () => features(), judge });
    expect(second.vlmReused).toBe(1);
    expect(judge).toHaveBeenCalledOnce();
  });

  it('records an individual failure and continues processing the rest of the batch', async () => {
    const root = temporary(); const first = join(root, 'first.jpg'); const second = join(root, 'second.jpg');
    writeFileSync(first, portrait);
    writeFileSync(second, await normalizedPipeline(portrait).resize(300, 375).jpeg().toBuffer());
    const extract = vi.fn(async (bytes: Buffer) => {
      if (bytes.equals(portrait)) throw new Error('fixture extraction failure');
      return features();
    });
    const summary = await processBatch([source('bad', first), source('good', second)],
      { root: join(root, 'out'), extract, concurrency: 2 });
    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(loadManifest(join(root, 'out')).find((row) => row.image_id === 'good')?.feature_status).toBe('ready');
    expect(readFileSync(join(root, 'out', 'failures.jsonl'), 'utf8')).toContain('fixture extraction failure');
    expect(selectHumanCandidates(join(root, 'out')).map((row) => row.image_id)).toContain('good');
  });

  it('rejects identical bytes crossing development and final_test in the real batch path', async () => {
    const root = temporary(); const file = join(root, 'photo.jpg'); writeFileSync(file, portrait);
    const extract = vi.fn(async () => features());
    const summary = await processBatch([source('dev', file), source('test', file, 'final_test')],
      { root: join(root, 'out'), extract, concurrency: 1 });
    expect(summary.failed).toBe(1);
    expect(loadManifest(join(root, 'out')).map((row) => row.image_id)).toEqual(['dev']);
  });
});
