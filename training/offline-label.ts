/** Resumable, per-image eight-axis VLM labels. Separate from production assessments. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { DatasetImage, loadDatasetFeature, loadManifest, sha256 } from './dataset.js';
import { judgeOfflineEight } from './offline-judge.js';
import { OFFLINE_MODEL, OFFLINE_RUBRIC_FINGERPRINT, OFFLINE_RUBRIC_VERSION,
  OfflineResult, type OfflineResult as OfflineResultType } from './offline-rubric.js';

export const OfflineVlmLabel = z.strictObject({
  source: z.literal('vlm'),
  task: z.literal('offline_eight_axes'),
  image_id: z.string().min(1),
  sha256: DatasetImage.shape.sha256,
  model: z.string().min(1),
  rubric_version: z.string().min(1),
  rubric_fingerprint: DatasetImage.shape.sha256,
  result: OfflineResult,
  created_at: z.string().datetime(),
});
export type OfflineVlmLabel = z.infer<typeof OfflineVlmLabel>;

export function offlineLabelPath(root: string, row: DatasetImage): string {
  const identity = createHash('sha256').update(JSON.stringify([
    row.image_id, row.sha256, OFFLINE_MODEL, OFFLINE_RUBRIC_VERSION, OFFLINE_RUBRIC_FINGERPRINT,
  ])).digest('hex');
  return join(root, 'offline-eight-assessments', `${identity}.json`);
}

export function loadOfflineLabel(root: string, row: DatasetImage): OfflineVlmLabel | null {
  const path = offlineLabelPath(root, row);
  if (!existsSync(path)) return null;
  const label = OfflineVlmLabel.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (label.image_id !== row.image_id || label.sha256 !== row.sha256 || label.model !== OFFLINE_MODEL ||
      label.rubric_version !== OFFLINE_RUBRIC_VERSION || label.rubric_fingerprint !== OFFLINE_RUBRIC_FINGERPRINT) {
    throw new Error(`offline VLM label identity mismatch for ${row.image_id}`);
  }
  return label;
}

function saveOfflineLabel(root: string, row: DatasetImage, result: OfflineResultType): void {
  const label = OfflineVlmLabel.parse({ source: 'vlm', task: 'offline_eight_axes',
    image_id: row.image_id, sha256: row.sha256, model: OFFLINE_MODEL,
    rubric_version: OFFLINE_RUBRIC_VERSION, rubric_fingerprint: OFFLINE_RUBRIC_FINGERPRINT,
    result, created_at: new Date().toISOString() });
  const path = offlineLabelPath(root, row);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(label)}\n`);
  renameSync(temporary, path);
}

export interface OfflineLabelSummary {
  selected: number;
  eligible: number;
  ineligibleSkipped: number;
  noFaceSkipped: number;
  reused: number;
  requested: number;
  assessed: number;
  declined: number;
  modelRefusals: number;
  deferred: number;
  failed: number;
}

export interface OfflineLabelOptions {
  readonly cohort?: string;
  readonly concurrency?: number;
  readonly maxNewCalls?: number;
  readonly judge?: (bytes: Buffer, width: number, height: number) => Promise<OfflineResultType>;
  readonly onProgress?: (imageId: string, state: string) => void;
}

/** One writer process at a time, as with the Step 13 JSONL dataset importer. */
export async function labelOfflineEight(rootPath: string, options: OfflineLabelOptions = {}): Promise<OfflineLabelSummary> {
  const root = resolve(rootPath);
  const concurrency = options.concurrency ?? 1;
  const maxNewCalls = options.maxNewCalls ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError('concurrency must be 1–8');
  if (!Number.isSafeInteger(maxNewCalls) || maxNewCalls < 0) throw new RangeError('maxNewCalls must be nonnegative');
  const judge = options.judge ?? judgeOfflineEight;
  const rows = loadManifest(root).filter((row) => row.dataset_role === 'development' &&
    (options.cohort === undefined || row.cohort === options.cohort));
  const summary: OfflineLabelSummary = { selected: rows.length, eligible: 0, ineligibleSkipped: 0,
    noFaceSkipped: 0, reused: 0, requested: 0, assessed: 0, declined: 0,
    modelRefusals: 0, deferred: 0, failed: 0 };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      if (row === undefined) continue;
      try {
        if (row.eligible_for_product_scoring !== true) {
          summary.ineligibleSkipped += 1;
          options.onProgress?.(row.image_id, 'ineligible');
          continue;
        }
        const features = loadDatasetFeature(root, row);
        summary.eligible += 1;
        if (features.faceCount === 0) {
          summary.noFaceSkipped += 1;
          options.onProgress?.(row.image_id, 'no_face');
          continue;
        }
        const cached = loadOfflineLabel(root, row);
        if (cached !== null) {
          summary.reused += 1;
          if (cached.result.status === 'assessed') summary.assessed += 1;
          else {
            summary.declined += 1;
            if (cached.result.reason === 'model_refusal') summary.modelRefusals += 1;
          }
          options.onProgress?.(row.image_id, 'reused');
          continue;
        }
        if (summary.requested >= maxNewCalls) {
          summary.deferred += 1;
          continue;
        }
        summary.requested += 1;
        const bytes = readFileSync(resolve(root, row.file_path));
        if (sha256(bytes) !== row.sha256) throw new Error('dataset image SHA mismatch');
        const result = OfflineResult.parse(await judge(bytes, features.width, features.height));
        saveOfflineLabel(root, row, result);
        if (result.status === 'assessed') summary.assessed += 1;
        else {
          summary.declined += 1;
          if (result.reason === 'model_refusal') summary.modelRefusals += 1;
        }
        options.onProgress?.(row.image_id, result.status);
      } catch (error) {
        summary.failed += 1;
        mkdirSync(root, { recursive: true });
        appendFileSync(join(root, 'offline-eight-failures.jsonl'), `${JSON.stringify({
          image_id: row.image_id, at: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        })}\n`);
        options.onProgress?.(row.image_id, 'failed');
      }
    }
  }));
  return summary;
}
