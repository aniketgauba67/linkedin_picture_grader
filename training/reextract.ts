#!/usr/bin/env node
/**
 * Re-runs extraction over the images already on disk and rewrites
 * data/features.jsonl.
 *
 * Exists because a feature-vector version bump strands the cache. The
 * images do not change, the measurements do, and re-running the
 * collector will not help: it is resumable by design, so every URL is
 * already in the manifest and it fetches nothing.
 *
 * Cached vectors at one version while the extractor is at another is a
 * drift that produces a confusing bug rather than a loud one - score()
 * refuses weights fitted against a different extractor, but nothing
 * stops a training script reading a stale vector and quietly fitting
 * against measurements that no longer exist.
 *
 * Reads the manifest, never the network. Usage: pnpm reextract
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { extractAll } from '@pps/features';
import { ComputedFeatures, EXTRACTOR_VERSION } from '@pps/schema';

import { readManifest } from './manifest.js';
import { assertNotValidation, CORPUS_FEATURES, CORPUS_MANIFEST } from './paths.js';

export interface ReextractFailure {
  readonly sha256: string;
  readonly file: string;
  readonly reason: string;
}

export interface ReextractResult {
  readonly extracted: number;
  readonly failures: readonly ReextractFailure[];
  readonly versions: ReadonlyMap<string, number>;
}

export async function reextract(
  manifestPath: string = CORPUS_MANIFEST,
  featuresPath: string = CORPUS_FEATURES,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<ReextractResult> {
  // The corpus is what gets fitted against, so this must never be
  // pointed at the validation set - not even by a typo in an argument.
  assertNotValidation(manifestPath, 'reextract');
  assertNotValidation(featuresPath, 'reextract');

  const rows = readManifest(manifestPath).rows;
  log(`re-extracting ${rows.length} image(s) at ${EXTRACTOR_VERSION}`);

  const lines: string[] = [];
  const failures: ReextractFailure[] = [];
  const versions = new Map<string, number>();

  for (const row of rows) {
    assertNotValidation(row.file, 'reextract');
    let bytes: Buffer;
    try {
      bytes = readFileSync(row.file);
    } catch (error) {
      failures.push({
        sha256: row.sha256,
        file: row.file,
        reason: error instanceof Error ? error.message : 'unreadable',
      });
      continue;
    }

    try {
      const features = await extractAll(bytes);
      const parsed = ComputedFeatures.safeParse(features);
      if (!parsed.success) {
        failures.push({
          sha256: row.sha256,
          file: row.file,
          reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        continue;
      }
      versions.set(features.extractorVersion, (versions.get(features.extractorVersion) ?? 0) + 1);
      lines.push(JSON.stringify({ sha256: row.sha256, features }));
    } catch (error) {
      failures.push({
        sha256: row.sha256,
        file: row.file,
        reason: error instanceof Error ? error.message : 'unknown extraction error',
      });
    }
  }

  // Written only once every image is through, so an interrupted run
  // leaves the old cache intact rather than a half-replaced one.
  if (failures.length === 0) {
    writeFileSync(featuresPath, `${lines.join('\n')}\n`, 'utf8');
  }

  return { extracted: lines.length, failures, versions };
}

export function renderReport(result: ReextractResult, featuresPath: string): string {
  const lines = [
    '',
    're-extraction',
    '-------------',
    `  extracted  ${result.extracted}`,
    `  failed     ${result.failures.length}`,
  ];
  for (const [version, count] of [...result.versions].sort()) {
    lines.push(`  ${version}: ${count}`);
  }
  for (const failure of result.failures) {
    lines.push(`  ! ${failure.file}`, `      ${failure.reason}`);
  }
  lines.push(
    '',
    result.failures.length === 0
      ? `wrote ${featuresPath}`
      : `NOT written: ${featuresPath} still holds the previous vectors`,
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  const result = await reextract();
  process.stdout.write(`${renderReport(result, CORPUS_FEATURES)}\n`);
  return result.failures.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1]?.endsWith('reextract.js') ?? false;
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
