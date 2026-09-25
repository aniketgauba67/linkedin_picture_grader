import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizedPipeline } from '@pps/features';
import { ComputedFeatures } from '@pps/schema';
import type { ComputedFeatures as FeatureVector } from '@pps/schema';

import { loadManifest, processBatch, sha256, SourceImage } from './dataset.js';
import { gateAReport } from './offline-eval.js';
import { labelOfflineEight, loadOfflineLabel, OfflineVlmLabel } from './offline-label.js';
import { OFFLINE_MODEL, OFFLINE_RUBRIC_FINGERPRINT, OFFLINE_RUBRIC_VERSION,
  OfflineAssessment, type OfflineResult } from './offline-rubric.js';

const portrait = readFileSync(new URL('../packages/features/fixtures/portrait.jpg', import.meta.url));
const created: string[] = [];
function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), 'pps-offline-eight-'));
  created.push(path);
  return path;
}
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
function source(id: string, path: string) {
  return SourceImage.parse({ image_id: id, file_path: path, source: 'fixture', source_url: null,
    creator: null, license: 'fixture', license_url: null, dataset_role: 'development',
    cohort: 'wikimedia_seed_125', source_group: null, creator_group: null,
    declared_mime_type: 'image/jpeg' });
}
const axis = { score: 4, evidence: 'The visible photograph retains clear facial detail.' };
const assessed: OfflineResult = { status: 'assessed', assessment: OfflineAssessment.parse({
  sharpness: axis, lighting: axis, resolution: axis, framing: axis,
  background: axis, attire: axis, expression: axis, solo: axis,
  framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
}) };

describe('offline eight-axis batch', () => {
  it('separates human/VLM provenance, skips no-face and undersized images, and resumes', async () => {
    const root = temporary();
    const face = join(root, 'face.jpg'); const small = join(root, 'small.jpg');
    const noFace = join(root, 'no-face.jpg');
    writeFileSync(face, portrait);
    writeFileSync(small, await normalizedPipeline(portrait).resize(199, 250).jpeg().toBuffer());
    writeFileSync(noFace, await normalizedPipeline(portrait).resize(200, 250).jpeg().toBuffer());
    const out = join(root, 'dataset');
    const ingest = await processBatch([source('G001', face), source('B001', small), source('M001', noFace)], {
      root: out, extract: async (bytes) => {
        if (bytes.equals(readFileSync(small))) return features({ width: 199, height: 250 });
        if (bytes.equals(readFileSync(noFace))) return features({ width: 200, height: 250,
          faceCount: 0, faceAreaRatio: 0, sharpnessEyeRegion: null, eyeRegionMeasured: false,
          faceRegionMeasured: false, primaryFaceConfidence: null });
        return features();
      },
    });
    expect(ingest.failed).toBe(0);
    const humanPath = join(out, 'human-labels.jsonl');
    const humanRows = ['sharpness', 'lighting', 'resolution', 'framing'].map((name) => JSON.stringify({
      source: 'human', image_id: 'G001', axis: name, score: 3,
      cohort: 'wikimedia_seed_125', rater: 'original_seed_pass',
    })).join('\n') + '\n';
    writeFileSync(humanPath, humanRows);
    const judge = vi.fn(async () => assessed);
    const first = await labelOfflineEight(out, { cohort: 'wikimedia_seed_125', judge });
    expect(first).toMatchObject({ selected: 3, ineligibleSkipped: 1, noFaceSkipped: 1,
      requested: 1, assessed: 1, failed: 0 });
    expect(judge).toHaveBeenCalledOnce();
    const faceRow = loadManifest(out).find((row) => row.image_id === 'G001');
    expect(faceRow).toBeDefined();
    if (faceRow === undefined) throw new Error('missing fixture row');
    expect(loadOfflineLabel(out, faceRow)).toMatchObject({ source: 'vlm',
      task: 'offline_eight_axes', image_id: 'G001', sha256: sha256(portrait),
      model: OFFLINE_MODEL, rubric_version: OFFLINE_RUBRIC_VERSION,
      rubric_fingerprint: OFFLINE_RUBRIC_FINGERPRINT });
    expect(readFileSync(humanPath, 'utf8')).toBe(humanRows);
    const second = await labelOfflineEight(out, { cohort: 'wikimedia_seed_125', judge });
    expect(second).toMatchObject({ reused: 1, requested: 0, failed: 0 });
    expect(judge).toHaveBeenCalledOnce();
    const gate = gateAReport(out);
    expect(gate.excluded).toMatchObject({ below_dimension_floor: ['B001'], no_face: ['M001'] });
    expect(gate.axes.sharpness.paired_n).toBe(1);
  });

  it('does not reuse an old rubric identity or confuse a refusal with an assessment', async () => {
    const root = temporary(); const file = join(root, 'face.jpg'); writeFileSync(file, portrait);
    const out = join(root, 'dataset');
    await processBatch([source('G001', file)], { root: out, extract: async () => features() });
    const row = loadManifest(out)[0];
    if (row === undefined) throw new Error('missing fixture row');
    const oldIdentity = createHash('sha256').update(JSON.stringify([
      row.image_id, row.sha256, OFFLINE_MODEL, 'offline-eight-old', '0'.repeat(64),
    ])).digest('hex');
    const oldPath = join(out, 'offline-eight-assessments', `${oldIdentity}.json`);
    const old = OfflineVlmLabel.parse({ source: 'vlm', task: 'offline_eight_axes',
      image_id: row.image_id, sha256: row.sha256, model: OFFLINE_MODEL,
      rubric_version: 'offline-eight-old', rubric_fingerprint: '0'.repeat(64),
      result: assessed, created_at: new Date().toISOString() });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(out, 'offline-eight-assessments'), { recursive: true });
    writeFileSync(oldPath, JSON.stringify(old));
    const judge = vi.fn(async (): Promise<OfflineResult> =>
      ({ status: 'declined', reason: 'model_refusal', detail: '' }));
    const result = await labelOfflineEight(out, { cohort: 'wikimedia_seed_125', judge });
    expect(result).toMatchObject({ requested: 1, declined: 1, modelRefusals: 1 });
    expect(loadOfflineLabel(out, row)?.result).toEqual({ status: 'declined', reason: 'model_refusal', detail: '' });
    expect(existsSync(oldPath)).toBe(true);
  });
});
