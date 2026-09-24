#!/usr/bin/env node
/**
 * Builds the labelling corpus from Pexels.
 *
 *   PEXELS_API_KEY=... pnpm corpus            150 images, the default
 *   PEXELS_API_KEY=... pnpm corpus -- --total 700 --dry-run
 *
 * Resumable and idempotent. Re-running skips every URL already in the
 * manifest, so an interrupted run costs only what it had not finished.
 *
 * The expensive mistake this is shaped to avoid: paying a vision model to
 * label an image that extraction cannot read. Every image is run through
 * extractAll() the moment it lands, and a decode failure or a non-finite
 * measurement is reported and kept out of the manifest. Labelling is the
 * only irreversible spend in this pipeline, and it happens after this.
 *
 * Nothing here is a label. `queryVariant` records which net caught the
 * photo, not how good it is - "professional headshot" returns plenty of
 * badly lit photographs, and the scorer must be free to say so.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractAll } from '@pps/features';
import { ComputedFeatures } from '@pps/schema';

import {
  appendRow,
  indexManifest,
  readManifest,
  PEXELS_LICENCE,
  type ManifestRow,
} from './manifest.js';
import { PexelsClient, PexelsError, pickSource, type PexelsPhoto } from './pexels.js';
import { planQuota, type QuerySpec, type QuotaRow } from './queries.js';

export const DEFAULT_TOTAL = 150;
export const DATA_DIR = 'data';
export const IMAGE_DIR = join(DATA_DIR, 'images');
export const MANIFEST_PATH = join(DATA_DIR, 'manifest.csv');
/**
 * Feature vectors, written as they are computed.
 *
 * Not in the spec, and kept anyway: extraction is ~800ms an image and the
 * architecture rule is that retraining must never re-run it. Throwing
 * away 150 vectors we already computed, to recompute them next week,
 * would be the exact thing that rule forbids. Gitignored - it is derived
 * data, not provenance.
 */
export const FEATURES_PATH = join(DATA_DIR, 'features.jsonl');

/** Pexels returns at most 80 per page. */
const PAGE_SIZE = 80;
/** Somebody else's CDN. Polite, and fast enough for 150 files. */
const DOWNLOAD_CONCURRENCY = 4;

export interface Failure {
  readonly url: string;
  readonly query: string;
  readonly stage: 'download' | 'extract' | 'validate';
  readonly reason: string;
}

export interface CollectSummary {
  readonly collected: number;
  readonly skippedAlreadyHave: number;
  readonly skippedDuplicateHash: number;
  readonly failures: readonly Failure[];
  readonly perQuery: ReadonlyMap<string, number>;
  readonly stoppedEarly: string | null;
}

/** Non-finite numbers are what a broken decode looks like downstream: the
 *  vector parses, the score comes out, and it is nonsense. */
function nonFiniteFields(features: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(features)
    .filter(([, value]) => typeof value === 'number' && !Number.isFinite(value))
    .map(([field]) => field);
}

function extensionFor(sourceUrl: string): string {
  const match = /\.(jpe?g|png|webp)(?:\?|$)/i.exec(sourceUrl);
  return (match?.[1] ?? 'jpg').toLowerCase();
}

export interface CollectOptions {
  readonly total?: number;
  readonly dryRun?: boolean;
  readonly dataDir?: string;
  readonly queries?: readonly QuerySpec[];
  readonly log?: (line: string) => void;
}

export async function collect(client: PexelsClient, options: CollectOptions = {}): Promise<CollectSummary> {
  const total = options.total ?? DEFAULT_TOTAL;
  const dataDir = options.dataDir ?? DATA_DIR;
  const imageDir = join(dataDir, 'images');
  const manifestPath = join(dataDir, 'manifest.csv');
  const featuresPath = join(dataDir, 'features.jsonl');
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const existing = readManifest(manifestPath);
  for (const problem of existing.problems) {
    log(`  ! manifest ${problem}`);
  }
  const seen = indexManifest(existing.rows);
  const haveHashes = new Set(seen.hashes);
  const haveUrls = new Set(seen.urls);

  if (existing.rows.length > 0) {
    log(`resuming: ${existing.rows.length} row(s) already in ${manifestPath}`);
  }

  const quota = planQuota(total, options.queries);
  const failures: Failure[] = [];
  const perQuery = new Map<string, number>(seen.perQuery);
  let collected = 0;
  let skippedAlreadyHave = 0;
  let skippedDuplicateHash = 0;
  let stoppedEarly: string | null = null;

  if (!options.dryRun) {
    mkdirSync(imageDir, { recursive: true });
  }

  for (const row of quota) {
    if (stoppedEarly !== null) break;

    const already = perQuery.get(row.query) ?? 0;
    const wanted = row.target - already;
    if (wanted <= 0) {
      log(`${row.query} [${row.variant}] target ${row.target}, already have ${already} - skipping`);
      continue;
    }

    log(`${row.query} [${row.variant}] want ${wanted} more (target ${row.target})`);

    try {
      const taken = await collectForQuery(client, row, wanted, {
        dryRun: options.dryRun ?? false,
        imageDir,
        manifestPath,
        featuresPath,
        haveHashes,
        haveUrls,
        failures,
        log,
        onDuplicate: () => {
          skippedDuplicateHash += 1;
        },
        onAlreadyHave: () => {
          skippedAlreadyHave += 1;
        },
      });
      collected += taken;
      perQuery.set(row.query, already + taken);
    } catch (error) {
      if (error instanceof PexelsError && error.status === 429) {
        // Stop clean. The manifest already holds everything fetched so
        // far, so the next run picks up exactly here.
        stoppedEarly = error.message;
        break;
      }
      throw error;
    }

    if (client.exhausted) {
      stoppedEarly = `API quota nearly spent (${client.quota.remaining} left, resets in ${client.resetInSeconds ?? '?'}s). Re-run to continue.`;
    }
  }

  return { collected, skippedAlreadyHave, skippedDuplicateHash, failures, perQuery, stoppedEarly };
}

interface QueryContext {
  readonly dryRun: boolean;
  readonly imageDir: string;
  readonly manifestPath: string;
  readonly featuresPath: string;
  readonly haveHashes: Set<string>;
  readonly haveUrls: Set<string>;
  readonly failures: Failure[];
  readonly log: (line: string) => void;
  readonly onDuplicate: () => void;
  readonly onAlreadyHave: () => void;
}

async function collectForQuery(
  client: PexelsClient,
  row: QuotaRow,
  wanted: number,
  ctx: QueryContext,
): Promise<number> {
  let taken = 0;
  let page = 1;

  while (taken < wanted) {
    if (client.exhausted) break;

    const result = await client.search(row.query, PAGE_SIZE, page);
    if (result.photos.length === 0) {
      ctx.log(`  ${row.query}: no more results at page ${page}`);
      break;
    }

    // Filter before downloading: a photo already in the manifest costs
    // nothing to skip here and a download to skip later.
    const candidates = result.photos.filter((photo) => {
      const source = pickSource(photo);
      if (source === null) return false;
      if (ctx.haveUrls.has(photo.url) || ctx.haveUrls.has(source)) {
        ctx.onAlreadyHave();
        return false;
      }
      return true;
    });

    for (let i = 0; i < candidates.length && taken < wanted; i += DOWNLOAD_CONCURRENCY) {
      const batch = candidates.slice(i, i + DOWNLOAD_CONCURRENCY);
      const fetched = await Promise.all(
        batch.map(async (photo) => {
          const source = pickSource(photo);
          if (source === null) return null;
          try {
            return { photo, source, bytes: await client.download(source) };
          } catch (error) {
            ctx.failures.push({
              url: photo.url,
              query: row.query,
              stage: 'download',
              reason: error instanceof Error ? error.message : 'unknown download error',
            });
            return null;
          }
        }),
      );

      // Extraction is serial on purpose: it is CPU bound and the ONNX
      // session is a shared singleton.
      for (const item of fetched) {
        if (item === null || taken >= wanted) continue;
        const accepted = await ingest(item.photo, item.source, item.bytes, row, ctx);
        if (accepted) taken += 1;
      }
    }

    if (result.nextPage === null) break;
    page += 1;
  }

  return taken;
}

async function ingest(
  photo: PexelsPhoto,
  source: string,
  bytes: Buffer,
  row: QuotaRow,
  ctx: QueryContext,
): Promise<boolean> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Dedupe across every query, not just within one. Pexels returns the
  // same photograph for "corporate portrait" and "business headshot"
  // routinely, and a corpus that counts it twice is 150 images with 130
  // photographs in it.
  if (ctx.haveHashes.has(sha256)) {
    ctx.onDuplicate();
    return false;
  }

  let features;
  try {
    features = await extractAll(bytes);
  } catch (error) {
    ctx.failures.push({
      url: photo.url,
      query: row.query,
      stage: 'extract',
      reason: error instanceof Error ? error.message : 'unknown extraction error',
    });
    return false;
  }

  const nonFinite = nonFiniteFields(features as unknown as Record<string, unknown>);
  if (nonFinite.length > 0) {
    ctx.failures.push({
      url: photo.url,
      query: row.query,
      stage: 'validate',
      reason: `non-finite measurement in ${nonFinite.join(', ')}`,
    });
    return false;
  }

  const parsed = ComputedFeatures.safeParse(features);
  if (!parsed.success) {
    ctx.failures.push({
      url: photo.url,
      query: row.query,
      stage: 'validate',
      reason: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    });
    return false;
  }

  const file = join(ctx.imageDir, `${sha256}.${extensionFor(source)}`);
  const manifestRow: ManifestRow = {
    sha256,
    url: photo.url,
    sourceUrl: source,
    licence: PEXELS_LICENCE,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    query: row.query,
    queryVariant: row.variant,
    // As measured, not as the API claimed. Pexels reports the original's
    // dimensions; what matters is what extraction actually saw.
    width: features.width,
    height: features.height,
    file,
  };

  if (!ctx.dryRun) {
    writeFileSync(file, bytes);
    appendFileSync(ctx.featuresPath, `${JSON.stringify({ sha256, features })}\n`, 'utf8');
    appendRow(ctx.manifestPath, manifestRow);
  }

  ctx.haveHashes.add(sha256);
  ctx.haveUrls.add(photo.url);
  ctx.haveUrls.add(source);
  ctx.log(`  + ${sha256.slice(0, 12)} ${features.width}x${features.height} ${photo.photographer}`);
  return true;
}

export interface ParsedArgs {
  readonly total: number;
  readonly dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let total = DEFAULT_TOTAL;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--total') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`--total needs a positive whole number, got ${argv[i + 1] ?? '(nothing)'}`);
      }
      total = value;
      i += 1;
    }
  }
  return { total, dryRun };
}

export function renderSummary(summary: CollectSummary, total: number): string {
  const lines = [
    '',
    'summary',
    '-------',
    `  collected this run       ${summary.collected}`,
    `  already in the manifest  ${summary.skippedAlreadyHave}`,
    `  duplicate photographs    ${summary.skippedDuplicateHash}`,
    `  failures                 ${summary.failures.length}`,
  ];

  const have = [...summary.perQuery.values()].reduce((s, n) => s + n, 0);
  lines.push(`  manifest now holds       ${have} of ${total}`);

  if (summary.failures.length > 0) {
    lines.push('', 'failures (reported, not skipped silently)');
    for (const failure of summary.failures) {
      lines.push(`  [${failure.stage}] ${failure.url}`);
      lines.push(`      ${failure.reason}`);
    }
  }
  if (summary.stoppedEarly !== null) {
    lines.push('', `stopped early: ${summary.stoppedEarly}`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const key = process.env['PEXELS_API_KEY'] ?? '';
  if (key === '') {
    process.stderr.write(
      'PEXELS_API_KEY is not set.\n' +
        'Get a free key at https://www.pexels.com/api/ (no approval needed), then:\n' +
        '  PEXELS_API_KEY=... pnpm corpus\n',
    );
    return 2;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'bad arguments'}\n`);
    return 2;
  }

  const client = new PexelsClient(key);
  const summary = await collect(client, { total: args.total, dryRun: args.dryRun });
  process.stdout.write(`${renderSummary(summary, args.total)}\n`);

  // Non-zero on any failure. "extractAll succeeds on all of them" is the
  // done condition, so a run with three decode failures is not done and
  // must not look like it is.
  if (summary.failures.length > 0) return 1;
  if (summary.stoppedEarly !== null) return 3;
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('collect-corpus.js') ?? false;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
