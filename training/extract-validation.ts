#!/usr/bin/env node
/**
 * Runs extraction over the 125 hand-labelled validation photographs and
 * writes a flat filename -> ComputedFeatures lookup for calibrate.ts.
 *
 * This is the ONLY writer of data/validation/features.json, and one of
 * the few modules allowed to read data/validation at all - see
 * VALIDATION_READERS in paths.ts and the test that enforces it.
 *
 * Two checks run before anything is written, because both failures are
 * silent otherwise:
 *
 *   - sha256 against the Pexels corpus. An image in both sets means the
 *     thing being measured has been trained on, and every number the
 *     validation set produces afterwards is inflated by an unknown
 *     amount with nothing to indicate it.
 *   - a decode pass over all 125. A file that cannot be read is worth
 *     finding now rather than as a hole in the middle of calibration.
 *
 * Usage: pnpm validate:extract
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractAll } from '@pps/features';
import { ComputedFeatures, type ComputedFeatures as Features } from '@pps/schema';

import { readManifest } from './manifest.js';
import { CORPUS_MANIFEST, VALIDATION_DIR, VALIDATION_FEATURES } from './paths.js';

export const LABEL_DIRS = ['GOOD', 'MEDIUM', 'BAD'] as const;
export type LabelDir = (typeof LABEL_DIRS)[number];

export interface ValidationEntry {
  /** Bare filename, no path: "G001.jpg". This is the join key that
   *  calibrate.ts matches against the hand-label CSV. */
  readonly filename: string;
  readonly folder: LabelDir;
  readonly sha256: string;
  readonly features: Features;
}

export interface ExtractionFailure {
  readonly filename: string;
  readonly folder: LabelDir;
  readonly stage: 'decode' | 'validate';
  readonly reason: string;
}

export interface ValidationExtraction {
  readonly entries: readonly ValidationEntry[];
  readonly failures: readonly ExtractionFailure[];
  /** Filenames whose bytes also appear in the Pexels corpus. Must be
   *  empty; a single entry invalidates the whole set. */
  readonly corpusCollisions: readonly { filename: string; sha256: string; corpusUrl: string }[];
  /** Filenames that are byte-identical to another validation image. */
  readonly internalDuplicates: readonly { filename: string; duplicateOf: string }[];
}

function nonFiniteFields(features: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(features)
    .filter(([, value]) => typeof value === 'number' && !Number.isFinite(value))
    .map(([field]) => field);
}

export async function extractValidationSet(
  root: string = VALIDATION_DIR,
  manifestPath: string = CORPUS_MANIFEST,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<ValidationExtraction> {
  const corpus = new Map(readManifest(manifestPath).rows.map((row) => [row.sha256, row.url]));

  const entries: ValidationEntry[] = [];
  const failures: ExtractionFailure[] = [];
  const corpusCollisions: { filename: string; sha256: string; corpusUrl: string }[] = [];
  const internalDuplicates: { filename: string; duplicateOf: string }[] = [];
  const seen = new Map<string, string>();

  for (const folder of LABEL_DIRS) {
    const dir = join(root, folder);
    const files = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.jpg'))
      .sort();
    log(`${folder}: ${files.length} file(s)`);

    for (const filename of files) {
      const bytes = readFileSync(join(dir, filename));
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const corpusUrl = corpus.get(sha256);
      if (corpusUrl !== undefined) {
        corpusCollisions.push({ filename, sha256, corpusUrl });
      }
      const priorFilename = seen.get(sha256);
      if (priorFilename !== undefined) {
        internalDuplicates.push({ filename, duplicateOf: priorFilename });
      } else {
        seen.set(sha256, filename);
      }

      let features: Features;
      try {
        features = await extractAll(bytes);
      } catch (error) {
        failures.push({
          filename,
          folder,
          stage: 'decode',
          reason: error instanceof Error ? error.message : 'unknown decode error',
        });
        continue;
      }

      const nonFinite = nonFiniteFields(features as unknown as Record<string, unknown>);
      if (nonFinite.length > 0) {
        failures.push({
          filename,
          folder,
          stage: 'validate',
          reason: `non-finite measurement in ${nonFinite.join(', ')}`,
        });
        continue;
      }
      const parsed = ComputedFeatures.safeParse(features);
      if (!parsed.success) {
        failures.push({
          filename,
          folder,
          stage: 'validate',
          reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        continue;
      }

      entries.push({ filename, folder, sha256, features });
    }
  }

  return { entries, failures, corpusCollisions, internalDuplicates };
}

/**
 * The lookup calibrate.ts reads: a flat object keyed by bare filename.
 *
 * The WHOLE feature vector is written, not just the twelve fields the
 * four calibrated axes read today. Extraction is the expensive half and
 * re-running it to add a field nobody thought of is exactly the coupling
 * the extract/score split exists to prevent.
 */
export function toLookup(entries: readonly ValidationEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of [...entries].sort((a, b) => (a.filename < b.filename ? -1 : 1))) {
    out[entry.filename] = {
      folder: entry.folder,
      sha256: entry.sha256,
      features: entry.features,
    };
  }
  return out;
}

export function renderReport(result: ValidationExtraction): string {
  const lines = [
    '',
    'validation extraction',
    '---------------------',
    `  succeeded  ${result.entries.length}`,
    `  failed     ${result.failures.length}`,
  ];

  if (result.failures.length > 0) {
    lines.push('', 'failures by filename');
    for (const failure of result.failures) {
      lines.push(`  ${failure.folder}/${failure.filename}  [${failure.stage}]`);
      lines.push(`      ${failure.reason}`);
    }
  }

  lines.push(
    '',
    'disjointness against the Pexels corpus',
    '--------------------------------------',
    `  sha256 collisions   ${result.corpusCollisions.length}`,
  );
  for (const collision of result.corpusCollisions) {
    lines.push(`  ! ${collision.filename} is byte-identical to ${collision.corpusUrl}`);
  }
  if (result.corpusCollisions.length > 0) {
    lines.push(
      '  ! These sets must be disjoint. An image in both means the model is being',
      '    measured on something it was fitted against, and every number this set',
      '    produces afterwards is inflated with nothing to show for it.',
    );
  }
  lines.push(`  duplicates within the set  ${result.internalDuplicates.length}`);
  for (const duplicate of result.internalDuplicates) {
    lines.push(`  ! ${duplicate.filename} is byte-identical to ${duplicate.duplicateOf}`);
  }

  const folders = new Map<string, number>();
  for (const entry of result.entries) folders.set(entry.folder, (folders.get(entry.folder) ?? 0) + 1);
  lines.push('', 'per folder');
  for (const folder of LABEL_DIRS) lines.push(`  ${folder.padEnd(8)} ${folders.get(folder) ?? 0}`);

  return lines.join('\n');
}

async function main(): Promise<number> {
  const result = await extractValidationSet();
  process.stdout.write(`${renderReport(result)}\n`);

  if (result.corpusCollisions.length > 0) {
    process.stderr.write('\nRefusing to write the lookup: the two sets are not disjoint.\n');
    return 2;
  }
  if (result.failures.length > 0) {
    process.stderr.write('\nRefusing to write the lookup: not every image extracted.\n');
    return 1;
  }

  writeFileSync(VALIDATION_FEATURES, `${JSON.stringify(toLookup(result.entries), null, 1)}\n`, 'utf8');
  process.stdout.write(`\nwrote ${VALIDATION_FEATURES} (${result.entries.length} entries)\n`);
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('extract-validation.js') ?? false;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    });
}
