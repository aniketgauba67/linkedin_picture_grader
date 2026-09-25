#!/usr/bin/env node
/**
 * Fits the isotonic maps for the four COMPUTED axes against the 125
 * hand-labelled photographs, and reports what the fit can and cannot
 * support.
 *
 * WHAT THIS SET IS AND IS NOT. These 125 images are the calibration set
 * for sharpness, lighting, resolution and framing. Fitting here means
 * they are no longer a held-out measurement of those four axes: a
 * correlation computed on the same labels the knots were fitted to is an
 * in-sample number and it always flatters. So both are reported - the
 * in-sample figure because it is what was asked for, and a k-fold
 * cross-validated figure beside it because that is the one that
 * estimates behaviour on a photograph the fit has not seen. Where they
 * disagree, the cross-validated one is right.
 *
 * The set stays off-limits to training/fit.ts, which fits the distilled
 * VLM axes against the Pexels corpus - see paths.ts.
 *
 * Usage: pnpm calibrate [--write]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { spearman } from '@pps/eval';
import {
  framingRaw,
  lightingRaw,
  WEIGHTS_V1,
  type PixelFeatures,
  type ValidatedPixelFeatures,
} from '@pps/scoring';

import { applyKnots, pava, toKnots, type Knot, type KnotFit, type Observation } from './isotonic-fit.js';
import { parseCsvObjects, parseCsvRecords } from './csv.js';
import { readManifest } from './manifest.js';
import {
  CORPUS_FEATURES,
  CORPUS_MANIFEST,
  VALIDATION_FEATURES,
  VALIDATION_SOURCES,
} from './paths.js';

export const LABELS_PATH = 'data/validation/calibration-labels.csv';
/**
 * Framing top-up labelled from the Pexels corpus.
 *
 * Stratified on purpose - roughly 12/12/8/8 across scores 5/4/3/2 - not
 * picked for being well framed. Anchoring only the top of the scale
 * leaves 2-4 sparse and produces a cliff in the fit, which is the same
 * shape of mistake as the label ceiling it is meant to cure.
 *
 * Labelled BY EYE FROM CONTACT SHEETS BEFORE framingRaw was computed
 * for any of them. Labelling against the measurement is circular: the
 * fit would reproduce the scalar rather than the judgement, and the
 * correlation would look excellent and mean nothing.
 */
export const CORPUS_FRAMING_LABELS = 'data/corpus-framing-labels.csv';
export const WEIGHTS_PATH = 'packages/scoring/src/weights/v1.ts';

/** Below this an axis level cannot anchor a knot with any confidence. */
export const MIN_EXAMPLES_PER_LEVEL = 5;

/**
 * A fitted map whose top knot sits below this is refusing to award a
 * good score to anything, however good. Worth stopping for: isotonic
 * maps clamp above the top knot, so every input larger than the biggest
 * labelled example inherits that score forever.
 */
export const TOP_KNOT_FLOOR = 4;

export type AxisName = 'sharpnessFrame' | 'sharpnessEyeRegion' | 'lighting' | 'resolution' | 'framing';

export interface AxisSpec {
  readonly name: AxisName;
  /** The hand-label column this map is fitted against. */
  readonly labelAxis: 'sharpness' | 'lighting' | 'resolution' | 'framing';
  readonly unit: string;
  /** The measurement this map runs over, or null to exclude the image. */
  readonly measure: (features: PixelFeatures) => number | null;
  /**
   * Whether this map is fitted at all.
   *
   * Two axes are deliberately not: resolution is a published LinkedIn
   * requirement rather than a matter of taste, and sharpness has no
   * corpus with the range to fit it - Commons thumbnails at a median
   * 0.15MP cannot separate sharp from blurred. Their distributions are
   * still printed, because a scalar nobody checks is how the lighting
   * collapse went unnoticed in the first place.
   */
  readonly fitted: boolean;
  /** Why, when `fitted` is false. */
  readonly notFittedBecause?: string;
  /**
   * Whether the measurement is computed on the normalised 1024px
   * analysis plane, and so does not move with the source resolution.
   *
   * Recorded for the report, NOT as an exemption from the top-knot
   * check. Scale invariance and label-ceiling clamping are unrelated
   * problems and only the first one is about scale.
   */
  readonly scaleInvariant: boolean;
}

export const AXES: readonly AxisSpec[] = [
  {
    name: 'sharpnessEyeRegion',
    labelAxis: 'sharpness',
    unit: 'Laplacian variance (eye region)',
    // Only images where a face was found and the eye crop was large
    // enough to convolve. Fitted independently of the frame map so that
    // one cannot drag the other.
    measure: (f) => (f.eyeRegionMeasured ? f.sharpnessEyeRegion : null),
    scaleInvariant: true,
    fitted: false,
    notFittedBecause:
      'CV Spearman 0.248 and topped out at 3 on this set. Needs native-resolution photographs spanning genuinely sharp to genuinely blurred, which is the Pexels corpus, not Commons thumbnails.',
  },
  {
    name: 'sharpnessFrame',
    labelAxis: 'sharpness',
    unit: 'Laplacian variance (whole frame)',
    // The fallback basis, fitted ONLY on the images that actually use
    // it. Fitting it on all 125 would tune the no-face fallback using
    // photographs that never take it.
    measure: (f) => (f.eyeRegionMeasured ? null : f.sharpnessLaplacian),
    scaleInvariant: true,
    fitted: false,
    notFittedBecause:
      'CV Spearman -0.005 on 20 images. No signal at all. Same corpus problem as the eye-region map.',
  },
  {
    name: 'lighting',
    labelAxis: 'lighting',
    // Over lightingRaw, never over dynamicRange. The frame-based scalar
    // produced a single-knot fit - one constant for every input -
    // because a backlit portrait has a healthy frame histogram and an
    // unreadable face, and the labellers were judging the face.
    unit: 'lightingRaw (1 = ideal)',
    measure: (f) => lightingRaw(f as ValidatedPixelFeatures, WEIGHTS_V1),
    scaleInvariant: true,
    fitted: false,
    notFittedBecause:
      'REJECTED, not deferred. Mean facial exposure was tested against all 125 labels: frame exposure correlates -0.070, face exposure +0.188, and the best two-sided band over every centre from 60 to 180 reaches 0.335 held-out - at centre 130, which is where the shipped band already sits. The band ships as a clipping-and-exposure sanity check, not a lighting quality model. Lighting quality needs directional features. See docs/calibration-notes.md.',
  },
  {
    name: 'resolution',
    labelAxis: 'resolution',
    unit: 'shorter edge (px)',
    measure: (f) => Math.min(f.width, f.height),
    scaleInvariant: false,
    fitted: false,
    notFittedBecause:
      "LinkedIn publishes the requirement - 400x400 minimum, 800x800 recommended - so the map is spec-derived. Fitting it here produced a map that could never award 5, capping every real upload at 4.",
  },
  {
    name: 'framing',
    labelAxis: 'framing',
    // Over framingRaw, never over faceAreaRatio: framing has a two-sided
    // optimum and a monotone fit cannot represent one.
    unit: 'framingRaw (1 = ideal)',
    measure: (f) => framingRaw(f as ValidatedPixelFeatures, WEIGHTS_V1),
    scaleInvariant: true,
    fitted: true,
  },
];

export interface LabelRow {
  readonly filename: string;
  readonly axis: string;
  readonly score: number;
}

/** Read labels with the same quoted-record rules as source metadata. */
export function parseLabels(text: string): readonly LabelRow[] {
  const [header = [], ...records] = parseCsvRecords(text);
  const columns = {
    filename: header.indexOf('filename'),
    axis: header.indexOf('axis'),
    score: header.indexOf('score'),
  };
  if (columns.filename < 0 || columns.axis < 0 || columns.score < 0) {
    throw new Error(`labels CSV needs filename, axis and score columns; found ${header.join(', ')}`);
  }

  const rows: LabelRow[] = [];
  for (const [index, fields] of records.entries()) {
    if (fields.length !== header.length) {
      throw new SyntaxError(`labels CSV record ${index + 2} has ${fields.length} fields; expected ${header.length}`);
    }
    const score = Number(fields[columns.score]);
    if (!Number.isFinite(score)) {
      throw new Error(`non-numeric score in row ${index + 2}`);
    }
    rows.push({
      filename: fields[columns.filename] ?? '',
      axis: fields[columns.axis] ?? '',
      score,
    });
  }
  return rows;
}

/**
 * What the raw scalar looks like before anything is fitted to it.
 *
 * Printed for EVERY axis on EVERY run, fitted or not. A pile-up on one
 * value is unfittable - a monotone fit cannot separate points sharing an
 * x - and it is invisible in a correlation, a knot table, or any other
 * number the report prints. framingRaw had 53 of 125 images at exactly
 * 0, carrying labels from 1 to 4, and nothing in the previous report
 * said so.
 */
export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
  readonly distinct: number;
  /** The most common single value, and how much of the data sits on it. */
  readonly modeValue: number;
  readonly modeShare: number;
}

/** Above this share on one value, the scalar cannot be fitted. */
export const MAX_MODE_SHARE = 0.1;

export function describe(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let modeValue = 0;
  let modeCount = 0;
  for (const [value, count] of counts) {
    if (count > modeCount) {
      modeValue = value;
      modeCount = count;
    }
  }

  return {
    n: values.length,
    min: sorted[0] ?? 0,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: sorted[sorted.length - 1] ?? 0,
    distinct: counts.size,
    modeValue,
    modeShare: modeCount / values.length,
  };
}

export interface AxisReport {
  readonly spec: AxisSpec;
  readonly n: number;
  readonly distribution: Distribution | null;
  readonly fit: KnotFit;
  readonly levelCounts: ReadonlyMap<number, number>;
  readonly thinLevels: readonly number[];
  /** Fitted against the same labels it was trained on. Flatters. */
  readonly spearmanInSample: number | null;
  /** 5-fold: each image scored by a map fitted without it. */
  readonly spearmanCrossValidated: number | null;
  readonly warnings: readonly string[];
}

function fitAxis(
  spec: AxisSpec,
  observations: readonly Observation[],
  clusters: readonly string[],
): AxisReport {
  const fit = toKnots(pava(observations));
  const distribution = describe(observations.map((o) => o.x));

  const levelCounts = new Map<number, number>();
  for (const o of observations) levelCounts.set(o.y, (levelCounts.get(o.y) ?? 0) + 1);
  const thinLevels = [1, 2, 3, 4, 5].filter(
    (level) => (levelCounts.get(level) ?? 0) < MIN_EXAMPLES_PER_LEVEL,
  );

  const predicted = observations.map((o) => applyKnots(o.x, fit.knots));
  const actual = observations.map((o) => o.y);
  const inSample = spearman(predicted, actual);

  // Cluster-held-out folds. Photographs by the same credited creator go
  // to the same side: a shared photographer means shared equipment,
  // lighting and often the same session, and splitting them across the
  // fold lets the map memorise a look rather than learn the axis.
  // Images with no named creator are each their own cluster - "Unknown
  // author" is missing data, not a shared identity, and pooling them
  // would invent a cluster of six unrelated photographs.
  const folds = 5;
  const uniqueClusters = [...new Set(clusters)].sort();
  const foldOf = new Map<string, number>();
  uniqueClusters.forEach((cluster, index) => foldOf.set(cluster, index % folds));

  const cvPredicted: number[] = [];
  const cvActual: number[] = [];
  for (let f = 0; f < folds; f += 1) {
    const train: Observation[] = [];
    const test: Observation[] = [];
    observations.forEach((o, i) => {
      const cluster = clusters[i] ?? String(i);
      if (foldOf.get(cluster) === f) test.push(o);
      else train.push(o);
    });
    if (train.length < 2 || test.length === 0) continue;
    const foldKnots = toKnots(pava(train)).knots;
    if (foldKnots.length === 0) continue;
    for (const o of test) {
      cvPredicted.push(applyKnots(o.x, foldKnots));
      cvActual.push(o.y);
    }
  }
  const crossValidated = spearman(cvPredicted, cvActual);

  const warnings: string[] = [];
  if (distribution !== null && distribution.modeShare > MAX_MODE_SHARE) {
    warnings.push(
      `${(distribution.modeShare * 100).toFixed(1)}% of images sit on the single value ` +
        `${distribution.modeValue.toFixed(4)}. A monotone fit cannot separate points that share ` +
        'an x, so that share of the data carries no information however it is labelled.',
    );
  }
  if (observations.length < 30) {
    warnings.push(`only ${observations.length} images use this map; the knots are weakly anchored`);
  }
  for (const level of thinLevels) {
    const count = levelCounts.get(level) ?? 0;
    warnings.push(
      count === 0
        ? `NO example scored ${level}, so this map can never output ${level}`
        : `only ${count} example(s) scored ${level}, below the ${MIN_EXAMPLES_PER_LEVEL} needed to anchor a knot`,
    );
  }
  for (const level of fit.unreachable) {
    warnings.push(`the fit never reaches ${level}; no knot was invented for it`);
  }
  // The top-knot check applies to EVERY axis, scale-invariant or not.
  //
  // Scale invariance says the measurement does not move when the source
  // resolution does. It says nothing about whether the labels reached
  // the top of the scale, and that is the failure that actually bites:
  // if no photograph in the set was labelled 4 or 5 on an axis, the
  // fitted map tops out below 4 and clamps every input above its last
  // knot to that value - permanently, for every real user, on an axis
  // whose measurement was never the problem. framing failed exactly
  // this way here while being perfectly scale-invariant.
  if (fit.topScore < TOP_KNOT_FLOOR) {
    warnings.push(
      `STOP: top knot is ${fit.topX.toFixed(4)} ${spec.unit} scoring ${fit.topScore.toFixed(2)}, ` +
        `below the floor of ${TOP_KNOT_FLOOR}. Isotonic maps clamp above the top knot, so every ` +
        'larger input would be capped there no matter how good the photograph is.',
    );
  }
  if (fit.knots.length < 2) {
    warnings.push(
      'STOP: the fit collapsed to a single knot, so this map returns one constant for every ' +
        'input. The measurement has no monotone relationship with the labels on this set.',
    );
  }
  const cvValue = crossValidated.ok ? crossValidated.value : null;
  if (cvValue !== null && cvValue < 0.3) {
    warnings.push(
      `STOP: cross-validated Spearman is ${cvValue.toFixed(3)}. The map does not predict the ` +
        'labels on photographs it has not seen, so shipping it would be shipping noise.',
    );
  }
  const bottom = fit.knots[0];
  if (bottom !== undefined && bottom[1] > 1.5) {
    warnings.push(
      `bottom knot is ${bottom[0].toFixed(3)} ${spec.unit} scoring ${bottom[1].toFixed(2)}; ` +
        'anything smaller clamps to that rather than scoring 1',
    );
  }

  return {
    spec,
    n: observations.length,
    distribution,
    fit,
    levelCounts,
    thinLevels,
    spearmanInSample: inSample.ok ? inSample.value : null,
    spearmanCrossValidated: crossValidated.ok ? crossValidated.value : null,
    warnings,
  };
}

export interface Calibration {
  readonly axes: readonly AxisReport[];
  readonly skipped: readonly string[];
}

export function calibrate(
  lookup: Record<string, { features: PixelFeatures }>,
  labels: readonly LabelRow[],
  clusterOf: ReadonlyMap<string, string> = new Map(),
): Calibration {
  const byFileAxis = new Map<string, number>();
  for (const row of labels) byFileAxis.set(`${row.filename}|${row.axis}`, row.score);

  const skipped: string[] = [];
  const axes: AxisReport[] = [];

  for (const spec of AXES) {
    const observations: Observation[] = [];
    const clusters: string[] = [];
    for (const [filename, entry] of Object.entries(lookup)) {
      const score = byFileAxis.get(`${filename}|${spec.labelAxis}`);
      if (score === undefined) {
        const key = `${filename}|${spec.labelAxis}`;
        if (!skipped.includes(key)) skipped.push(key);
        continue;
      }
      const x = spec.measure(entry.features);
      if (x === null || !Number.isFinite(x)) continue;
      observations.push({ x, y: score });
      // No known cluster means the image is its own cluster.
      clusters.push(clusterOf.get(filename) ?? filename);
    }
    axes.push(fitAxis(spec, observations, clusters));
  }

  return { axes, skipped };
}

/**
 * Cluster key per image: the credited creator when that creator has more
 * than one photograph in the set, otherwise the filename.
 *
 * Placeholders are not identities. "Unknown author" appears four times
 * and "Not stated on source page" twice; pooling those would invent a
 * cluster out of six unrelated photographs and hold them out together
 * for no reason.
 */
export function clustersFromSources(csv: string): Map<string, string> {
  // Prefix match, not exact: the real file says "Unknown author" and
  // "Not stated on source page", and an exact match silently treats
  // both as real shared identities.
  const placeholders = /^\s*(unknown|not stated|no(t)? known|anonymous|n\/?a|none|-)\s*/i;
  const rows = parseCsvObjects(csv)
    .map((record) => ({
      image: (record['image_id'] ?? '').trim(),
      creator: (record['creator'] ?? '').trim(),
    }))
    .filter((record) => record.image !== '');

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (placeholders.test(row.creator)) continue;
    counts.set(row.creator, (counts.get(row.creator) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const row of rows) {
    const shared = !placeholders.test(row.creator) && (counts.get(row.creator) ?? 0) > 1;
    // sources.csv keys on image_id ("G001"); the lookup keys on the
    // filename ("G001.jpg").
    out.set(`${row.image}.jpg`, shared ? `creator:${row.creator}` : `image:${row.image}`);
  }
  return out;
}

function renderKnotTable(report: AxisReport): string[] {
  const lines = [`  knots (${report.spec.unit} -> score)`];
  for (const [x, score] of report.fit.knots) {
    lines.push(`    ${x.toFixed(4).padStart(12)}  ->  ${score.toFixed(2)}`);
  }
  if (report.fit.knots.length === 0) lines.push('    (none - no usable observations)');
  return lines;
}

export function renderReport(calibration: Calibration): string {
  const lines: string[] = [];

  for (const report of calibration.axes) {
    const inSample = report.spearmanInSample;
    const cv = report.spearmanCrossValidated;
    const status = report.spec.fitted ? 'FITTED' : 'not fitted';
    lines.push('', `${report.spec.name}   n=${report.n}   [${status}]`, '-'.repeat(68));

    const d = report.distribution;
    if (d === null) {
      lines.push('  distribution                (no observations)');
    } else {
      lines.push(
        `  ${report.spec.unit}`,
        `    min ${d.min.toFixed(4)}   p25 ${d.p25.toFixed(4)}   median ${d.median.toFixed(4)}` +
          `   p75 ${d.p75.toFixed(4)}   max ${d.max.toFixed(4)}`,
        `    distinct ${d.distinct} of ${d.n}   most common value ${d.modeValue.toFixed(4)} ` +
          `holds ${(d.modeShare * 100).toFixed(1)}%`,
      );
    }

    lines.push(
      `  label counts 1..5           ${[1, 2, 3, 4, 5].map((l) => report.levelCounts.get(l) ?? 0).join('  ')}`,
    );

    if (report.spec.fitted) {
      lines.push(
        `  spearman (in-sample)        ${inSample === null ? 'n/a' : inSample.toFixed(3)}`,
        `  spearman (cluster-held-out) ${cv === null ? 'n/a' : cv.toFixed(3)}   <- the honest one`,
        `  top knot                    ${report.fit.topX.toFixed(4)} -> ${report.fit.topScore.toFixed(2)}` +
          `${report.fit.topScore < TOP_KNOT_FLOOR ? '   CLAMPS LOW' : ''}`,
      );
      lines.push(...renderKnotTable(report));
      for (const warning of report.warnings) lines.push(`  ! ${warning}`);
    } else {
      lines.push(`  not fitted: ${report.spec.notFittedBecause ?? 'no reason recorded'}`);
      // Distribution warnings still print for an unfitted axis - a
      // pile-up is worth knowing about before anyone tries again.
      for (const warning of report.warnings.filter((w) => /sit on the single value/.test(w))) {
        lines.push(`  ! ${warning}`);
      }
    }
  }

  return lines.join('\n');
}

/** The fitted maps, in the shape weights/v1.ts declares. */
export function toAxisMaps(calibration: Calibration): Record<string, readonly Knot[]> {
  const maps: Record<string, readonly Knot[]> = {};
  for (const report of calibration.axes) maps[report.spec.name] = report.fit.knots;
  return maps;
}

/**
 * Parses `--override-stop "<reason>"`.
 *
 * The stop rule is not weakened by this: every STOP still fires, still
 * prints, and still says what it would cost. The flag only provides a
 * documented way past one, and it demands a reason long enough to be an
 * argument rather than a shrug - which then gets written next to the
 * knots it excused, where the next person reads it before trusting them.
 */
export const MIN_OVERRIDE_REASON = 30;

export function parseOverride(argv: readonly string[]): string | null {
  const at = argv.indexOf('--override-stop');
  if (at < 0) return null;
  const reason = (argv[at + 1] ?? '').trim();
  if (reason === '' || reason.startsWith('--')) {
    throw new Error('--override-stop needs a reason string');
  }
  if (reason.length < MIN_OVERRIDE_REASON) {
    throw new Error(
      `--override-stop reason must be at least ${MIN_OVERRIDE_REASON} characters; ` +
        'it is recorded in the weights file and read by whoever inherits these knots',
    );
  }
  return reason;
}

/**
 * Folds in the Pexels framing top-up.
 *
 * Two sets, one fit, and the reason it is legitimate to merge them is
 * that framingRaw is a geometric ratio - face box against frame - with
 * no dependence on resolution, sensor or subject. The same cannot be
 * said of sharpness, which is why no equivalent merge exists there.
 *
 * Corpus images cluster on photographer from the manifest, exactly as
 * the validation images cluster on credited creator, so the held-out
 * split still cuts on who took the photograph.
 */
function mergeCorpusFraming(
  lookup: Record<string, { features: PixelFeatures }>,
  labels: readonly LabelRow[],
  clusters: Map<string, string>,
  log: (line: string) => void,
): { lookup: Record<string, { features: PixelFeatures }>; labels: readonly LabelRow[] } {
  if (!existsSync(CORPUS_FRAMING_LABELS) || !existsSync(CORPUS_FEATURES)) {
    log('no corpus framing top-up found; fitting on the validation set alone');
    return { lookup, labels };
  }

  const vectors = new Map<string, PixelFeatures>();
  for (const line of readFileSync(CORPUS_FEATURES, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { sha256: string; features: PixelFeatures };
    vectors.set(row.sha256, row.features);
  }
  const photographer = new Map(
    readManifest(CORPUS_MANIFEST).rows.map((r) => [r.sha256, r.photographer]),
  );

  const merged = { ...lookup };
  const extra: LabelRow[] = [];
  let missing = 0;
  for (const row of parseLabels(readFileSync(CORPUS_FRAMING_LABELS, 'utf8'))) {
    const features = vectors.get(row.filename);
    if (features === undefined) {
      missing += 1;
      continue;
    }
    merged[row.filename] = { features };
    extra.push(row);
    const credited = photographer.get(row.filename) ?? '';
    clusters.set(row.filename, credited === '' ? `image:${row.filename}` : `creator:${credited}`);
  }

  log(
    `corpus framing top-up: ${extra.length} label(s) merged` +
      (missing > 0 ? `, ${missing} with no cached vector` : ''),
  );
  return { lookup: merged, labels: [...labels, ...extra] };
}

function main(): number {
  const lookupRaw: unknown = JSON.parse(readFileSync(VALIDATION_FEATURES, 'utf8'));
  let lookup = lookupRaw as Record<string, { features: PixelFeatures }>;
  let labels = parseLabels(readFileSync(LABELS_PATH, 'utf8'));
  const clusters = clustersFromSources(readFileSync(VALIDATION_SOURCES, 'utf8'));

  const merged = mergeCorpusFraming(lookup, labels, clusters, (line) =>
    process.stdout.write(`${line}\n`),
  );
  lookup = merged.lookup;
  labels = merged.labels;
  const sharedClusters = new Set(
    [...clusters.values()].filter((c) => c.startsWith('creator:')),
  ).size;

  process.stdout.write(
    `calibrating against ${Object.keys(lookup).length} images and ${labels.length} labels\n` +
      `holding out by cluster: ${new Set(clusters.values()).size} clusters, ` +
      `${sharedClusters} of them a creator with more than one photograph\n`,
  );

  const calibration = calibrate(lookup, labels, clusters);
  process.stdout.write(`${renderReport(calibration)}\n`);

  if (calibration.skipped.length > 0) {
    process.stdout.write(`\n! ${calibration.skipped.length} image/axis pair(s) had no label\n`);
  }

  // Only a FITTED axis can block: resolution is spec-derived and
  // sharpness is deliberately left provisional, so neither is a
  // candidate for writing and neither can stop the run.
  const blockers = calibration.axes.filter(
    (a) => a.spec.fitted && a.warnings.some((w) => w.startsWith('STOP:')),
  );

  let override: string | null;
  try {
    override = parseOverride(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\n${error instanceof Error ? error.message : 'bad override'}\n`);
    return 2;
  }

  if (blockers.length > 0 && override === null) {
    process.stderr.write(
      `\nNOT writing: ${blockers.map((b) => b.spec.name).join(', ')} would cap real inputs.\n` +
        'If that is a considered decision rather than an oversight, re-run with\n' +
        '  --override-stop "<why this is acceptable>"\n' +
        `and the reason is recorded alongside the knots in ${WEIGHTS_PATH}.\n`,
    );
    return 2;
  }

  if (!process.argv.includes('--write')) {
    process.stdout.write('\n(dry run - pass --write to emit the fitted maps)\n');
    return 0;
  }

  const fitted = calibration.axes.filter((a) => a.spec.fitted);
  const maps: Record<string, unknown> = {};
  for (const report of fitted) {
    maps[report.spec.name] = {
      knots: report.fit.knots,
      unit: report.spec.unit,
      n: report.n,
      spearmanHeldOut: report.spearmanCrossValidated,
      topScore: report.fit.topScore,
      // Every STOP that was overridden travels with the knots. A knot
      // table without its caveats is how a map valid to 2 gets treated
      // as valid to 5.
      overriddenStops: report.warnings.filter((w) => w.startsWith('STOP:')),
      override,
    };
  }

  writeFileSync('data/validation/fitted-maps.json', `${JSON.stringify(maps, null, 1)}\n`, 'utf8');
  process.stdout.write('\nwrote data/validation/fitted-maps.json\n');

  if (override !== null && blockers.length > 0) {
    process.stdout.write(
      `\nOVERRIDDEN for ${blockers.map((b) => b.spec.name).join(', ')}:\n  "${override}"\n` +
        `Record that reason in ${WEIGHTS_PATH} beside the knots it excused.\n`,
    );
  }
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('calibrate.js') ?? false;
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
