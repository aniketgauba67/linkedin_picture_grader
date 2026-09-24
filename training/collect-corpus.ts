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

import { extractAll, MAX_INPUT_PIXELS } from '@pps/features';
import { ComputedFeatures } from '@pps/schema';

import {
  appendRow,
  indexManifest,
  readManifest,
  PEXELS_LICENCE,
  type ManifestRow,
} from './manifest.js';
import { PexelsClient, PexelsError, pickSource, type PexelsPhoto } from './pexels.js';
import { planQuota, VARIANT_SHARES, type QuerySpec, type QuotaRow, type QueryVariant } from './queries.js';

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
  /** Which net caught it. A decode failure concentrated in one variant
   *  is a different problem from one scattered across all four. */
  readonly variant: QueryVariant;
  readonly stage: 'download' | 'extract' | 'validate';
  readonly reason: string;
}

/** What one query actually produced, against what it was asked for. */
export interface QueryOutcome {
  readonly query: string;
  readonly variant: QueryVariant;
  readonly target: number;
  /** Total in the manifest for this query, earlier runs included. */
  readonly have: number;
  /** Taken during this run alone. */
  readonly taken: number;
}

/**
 * The resolution actually collected, in megapixels.
 *
 * Printed every run, not just when something looks wrong. `resolution`
 * is a scored axis, so a corpus with no spread in it cannot train or
 * test that axis - and the failure is silent, which is why the numbers
 * go in the report rather than waiting for someone to ask.
 */
export interface ResolutionSpread {
  readonly n: number;
  readonly minMp: number;
  readonly p10Mp: number;
  readonly medianMp: number;
  readonly p90Mp: number;
  readonly maxMp: number;
  /** Distinct (width x height) pairs. One means a fixed-size re-encode. */
  readonly distinctSizes: number;
}

/** The rate-limit position as of the last API response. */
export interface QuotaReport {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly reset: number | null;
  readonly resetInSeconds: number | null;
}

export interface CollectSummary {
  readonly collected: number;
  readonly skippedAlreadyHave: number;
  readonly skippedDuplicateHash: number;
  readonly failures: readonly Failure[];
  readonly outcomes: readonly QueryOutcome[];
  readonly resolution: ResolutionSpread | null;
  /** Candidates skipped unread because the API said they were too big. */
  readonly skippedOversize: number;
  readonly quota: QuotaReport;
  readonly stoppedEarly: string | null;
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summariseResolution(
  pixels: readonly number[],
  sizes: ReadonlySet<string>,
): ResolutionSpread | null {
  if (pixels.length === 0) return null;
  const mp = [...pixels].map((p) => p / 1_000_000).sort((a, b) => a - b);
  return {
    n: mp.length,
    minMp: mp[0] ?? 0,
    p10Mp: percentile(mp, 0.1),
    medianMp: percentile(mp, 0.5),
    p90Mp: percentile(mp, 0.9),
    maxMp: mp[mp.length - 1] ?? 0,
    distinctSizes: sizes.size,
  };
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
  const takenPerQuery = new Map<string, number>();
  let collected = 0;
  let skippedAlreadyHave = 0;
  let skippedDuplicateHash = 0;
  let skippedOversize = 0;
  let stoppedEarly: string | null = null;

  // Measured on what actually decoded, not on what the API claimed.
  const measuredPixels: number[] = [];
  const measuredSizes = new Set<string>();
  for (const prior of existing.rows) {
    measuredPixels.push(prior.width * prior.height);
    measuredSizes.add(`${prior.width}x${prior.height}`);
  }

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
        onOversize: () => {
          skippedOversize += 1;
        },
        onMeasured: (width: number, height: number) => {
          measuredPixels.push(width * height);
          measuredSizes.add(`${width}x${height}`);
        },
      });
      collected += taken;
      perQuery.set(row.query, already + taken);
      takenPerQuery.set(row.query, taken);
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

  const outcomes: QueryOutcome[] = quota.map((row) => ({
    query: row.query,
    variant: row.variant,
    target: row.target,
    have: perQuery.get(row.query) ?? 0,
    taken: takenPerQuery.get(row.query) ?? 0,
  }));

  return {
    collected,
    skippedAlreadyHave,
    skippedDuplicateHash,
    skippedOversize,
    failures,
    outcomes,
    resolution: summariseResolution(measuredPixels, measuredSizes),
    quota: { ...client.quota, resetInSeconds: client.resetInSeconds },
    stoppedEarly,
  };
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
  readonly onOversize: () => void;
  readonly onMeasured: (width: number, height: number) => void;
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
      // Since PREFERRED_SIZES takes the original, some of these are
      // enormous - 1.6% of a 320-photo sample was over the ceiling, up
      // to 101.9MP. The search response already carries the dimensions,
      // so there is no reason to spend an 80MB download discovering that
      // our own decoder will refuse the file. NOT redundant with the
      // check inside prepareImage: that one protects the app, this one
      // protects the bandwidth, and neither can do the other's job.
      if (photo.width * photo.height > MAX_INPUT_PIXELS) {
        ctx.onOversize();
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
              variant: row.variant,
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
      variant: row.variant,
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
      variant: row.variant,
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
      variant: row.variant,
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
  ctx.onMeasured(features.width, features.height);
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

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

/**
 * The spread, per query and per variant, against the plan.
 *
 * A total that comes out right can still hide a variant that came up
 * short - and the BAD variant coming up short is the one failure that
 * matters, because it is the only source of the 1-3 range.
 */
function renderSpread(summary: CollectSummary): string[] {
  if (summary.outcomes.length === 0) return [];

  const lines = ['', 'spread achieved  (have / target, this run in brackets)', '-----------------------------------------------------'];
  const width = Math.max(...summary.outcomes.map((o) => o.query.length), 8);

  const variants = [...new Set(summary.outcomes.map((o) => o.variant))];
  let haveAll = 0;
  let targetAll = 0;

  for (const variant of variants) {
    const rows = summary.outcomes.filter((o) => o.variant === variant);
    const have = rows.reduce((s, r) => s + r.have, 0);
    const target = rows.reduce((s, r) => s + r.target, 0);
    haveAll += have;
    targetAll += target;

    lines.push(`  ${variant}`);
    for (const row of rows) {
      const short = row.have < row.target ? '  ! short' : '';
      lines.push(
        `    ${row.query.padEnd(width)} ${pad(row.have, 4)} / ${pad(row.target, 3)}  [+${row.taken}]${short}`,
      );
    }
    lines.push(`    ${'subtotal'.padEnd(width)} ${pad(have, 4)} / ${pad(target, 3)}`);
  }

  const pct = (n: number): string => (haveAll === 0 ? '  0.0%' : `${((n / haveAll) * 100).toFixed(1).padStart(5)}%`);
  lines.push('', `  ${'TOTAL'.padEnd(width + 2)} ${pad(haveAll, 4)} / ${pad(targetAll, 3)}`);
  lines.push('', '  variant shares achieved vs planned');
  for (const variant of variants) {
    const have = summary.outcomes.filter((o) => o.variant === variant).reduce((s, r) => s + r.have, 0);
    const planned = (VARIANT_SHARES[variant] ?? 0) * 100;
    lines.push(`    ${variant.padEnd(10)} ${pct(have)}  (planned ${planned.toFixed(1)}%)`);
  }
  return lines;
}

/**
 * Printed every run. A collapsed resolution axis is invisible in every
 * other number the report prints - the targets are met, nothing fails,
 * and the corpus is quietly untrainable on one of its eight axes.
 */
function renderResolution(spread: ResolutionSpread | null): string[] {
  if (spread === null) {
    return ['', 'resolution', '----------', '  insufficient data for the resolution spread (nothing collected)'];
  }
  const mp = (value: number): string => `${value.toFixed(2).padStart(7)} MP`;
  const lines = [
    '',
    'resolution  (as measured after decode, not as the API claimed)',
    '--------------------------------------------------------------',
    `  n              ${spread.n}`,
    `  min            ${mp(spread.minMp)}`,
    `  p10            ${mp(spread.p10Mp)}`,
    `  median         ${mp(spread.medianMp)}`,
    `  p90            ${mp(spread.p90Mp)}`,
    `  max            ${mp(spread.maxMp)}`,
    `  distinct sizes ${spread.distinctSizes}`,
  ];

  // A near-constant axis cannot be trained or tested, and the cause is
  // almost always a fixed-size CDN re-encode rather than a coincidence.
  const ratio = spread.minMp === 0 ? Infinity : spread.maxMp / spread.minMp;
  if (spread.distinctSizes <= 1) {
    lines.push('  ! every image is the same size - this is a fixed-size re-encode, not photographs');
  } else if (ratio < 2) {
    lines.push(
      `  ! the largest image is only ${ratio.toFixed(2)}x the smallest - too little spread to`,
      '    train or test the resolution axis. Check which src size is being downloaded.',
    );
  }
  return lines;
}

function renderQuota(quota: QuotaReport): string[] {
  if (quota.limit === null && quota.remaining === null) {
    return ['', 'rate limit', '----------', '  no API response carried rate-limit headers'];
  }
  const minutes = quota.resetInSeconds === null ? null : Math.round(quota.resetInSeconds / 60);
  return [
    '',
    'rate limit  (as of the last API response)',
    '-----------------------------------------',
    `  X-Ratelimit-Limit      ${quota.limit ?? '(absent)'}`,
    `  X-Ratelimit-Remaining  ${quota.remaining ?? '(absent)'}`,
    `  X-Ratelimit-Reset      ${quota.reset ?? '(absent)'}${minutes === null ? '' : `  (in ~${minutes}m)`}`,
  ];
}

export function renderSummary(summary: CollectSummary, total: number): string {
  const lines = [
    '',
    'summary',
    '-------',
    `  collected this run       ${summary.collected}`,
    // Not "already in the manifest": this also counts a photo returned
    // by a second query within the same run, which on a dry run is every
    // one of them.
    `  already seen             ${summary.skippedAlreadyHave}`,
    `  duplicate photographs    ${summary.skippedDuplicateHash}`,
    `  over the ${MAX_INPUT_PIXELS / 1_000_000}MP ceiling    ${summary.skippedOversize}  (never downloaded)`,
    `  failures                 ${summary.failures.length}`,
  ];

  const have = summary.outcomes.reduce((s, o) => s + o.have, 0);
  lines.push(`  manifest now holds       ${have} of ${total}`);

  lines.push(...renderSpread(summary));

  if (summary.failures.length > 0) {
    lines.push('', 'failures (reported, not skipped silently)', '-----------------------------------------');
    // Grouped by variant: a decode failure concentrated in one variant
    // is a rubric-shaped problem, one scattered across all four is not.
    const byVariant = new Map<QueryVariant, Failure[]>();
    for (const failure of summary.failures) {
      byVariant.set(failure.variant, [...(byVariant.get(failure.variant) ?? []), failure]);
    }
    for (const [variant, group] of byVariant) {
      lines.push(`  ${variant} (${group.length})`);
      for (const failure of group) {
        lines.push(`    [${failure.stage}] "${failure.query}"  ${failure.url}`);
        lines.push(`        ${failure.reason}`);
      }
    }
  }

  lines.push(...renderResolution(summary.resolution));
  lines.push(...renderQuota(summary.quota));

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
