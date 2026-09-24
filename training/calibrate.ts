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

import { readFileSync, writeFileSync } from 'node:fs';

import { spearman } from '@pps/eval';
import { framingRaw, WEIGHTS_V1, type PixelFeatures, type ValidatedPixelFeatures } from '@pps/scoring';

import { applyKnots, pava, toKnots, type Knot, type KnotFit, type Observation } from './isotonic-fit.js';
import { VALIDATION_FEATURES } from './paths.js';

export const LABELS_PATH = 'data/validation/calibration-labels.csv';
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
  },
  {
    name: 'lighting',
    labelAxis: 'lighting',
    unit: 'dynamic range (luma span of 255)',
    measure: (f) => f.dynamicRange,
    scaleInvariant: true,
  },
  {
    name: 'resolution',
    labelAxis: 'resolution',
    unit: 'megapixels',
    measure: (f) => (f.width * f.height) / 1_000_000,
    scaleInvariant: false,
  },
  {
    name: 'framing',
    labelAxis: 'framing',
    // Over framingRaw, never over faceAreaRatio: framing has a two-sided
    // optimum and a monotone fit cannot represent one.
    unit: 'framingRaw (1 = ideal)',
    measure: (f) => framingRaw(f as ValidatedPixelFeatures, WEIGHTS_V1),
    scaleInvariant: true,
  },
];

export interface LabelRow {
  readonly filename: string;
  readonly axis: string;
  readonly score: number;
}

/** Minimal CSV read: these files are machine-written, but quoted. */
export function parseLabels(text: string): readonly LabelRow[] {
  const unquote = (value: string): string => value.trim().replace(/^"(.*)"$/s, '$1');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',').map(unquote);
  const columns = {
    filename: header.indexOf('filename'),
    axis: header.indexOf('axis'),
    score: header.indexOf('score'),
  };
  if (columns.filename < 0 || columns.axis < 0 || columns.score < 0) {
    throw new Error(`labels CSV needs filename, axis and score columns; found ${header.join(', ')}`);
  }

  const rows: LabelRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split(',').map(unquote);
    const score = Number(fields[columns.score]);
    if (!Number.isFinite(score)) {
      throw new Error(`non-numeric score in row: ${line}`);
    }
    rows.push({
      filename: fields[columns.filename] ?? '',
      axis: fields[columns.axis] ?? '',
      score,
    });
  }
  return rows;
}

export interface AxisReport {
  readonly spec: AxisSpec;
  readonly n: number;
  readonly fit: KnotFit;
  readonly levelCounts: ReadonlyMap<number, number>;
  readonly thinLevels: readonly number[];
  /** Fitted against the same labels it was trained on. Flatters. */
  readonly spearmanInSample: number | null;
  /** 5-fold: each image scored by a map fitted without it. */
  readonly spearmanCrossValidated: number | null;
  readonly warnings: readonly string[];
}

function fitAxis(spec: AxisSpec, observations: readonly Observation[]): AxisReport {
  const fit = toKnots(pava(observations));

  const levelCounts = new Map<number, number>();
  for (const o of observations) levelCounts.set(o.y, (levelCounts.get(o.y) ?? 0) + 1);
  const thinLevels = [1, 2, 3, 4, 5].filter(
    (level) => (levelCounts.get(level) ?? 0) < MIN_EXAMPLES_PER_LEVEL,
  );

  const predicted = observations.map((o) => applyKnots(o.x, fit.knots));
  const actual = observations.map((o) => o.y);
  const inSample = spearman(predicted, actual);

  // 5-fold. Every image is a different photograph of a different person,
  // so a plain fold split does not straddle a subject the way the Pexels
  // corpus would - there is nothing to cluster on.
  const folds = 5;
  const cvPredicted: number[] = [];
  const cvActual: number[] = [];
  for (let f = 0; f < folds; f += 1) {
    const train = observations.filter((_, i) => i % folds !== f);
    const test = observations.filter((_, i) => i % folds === f);
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
): Calibration {
  const byFileAxis = new Map<string, number>();
  for (const row of labels) byFileAxis.set(`${row.filename}|${row.axis}`, row.score);

  const skipped: string[] = [];
  const axes: AxisReport[] = [];

  for (const spec of AXES) {
    const observations: Observation[] = [];
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
    }
    axes.push(fitAxis(spec, observations));
  }

  return { axes, skipped };
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
    lines.push(
      '',
      `${report.spec.name}   n=${report.n}`,
      '-'.repeat(60),
      `  spearman (in-sample)        ${inSample === null ? 'n/a' : inSample.toFixed(3)}`,
      `  spearman (5-fold CV)        ${cv === null ? 'n/a' : cv.toFixed(3)}   <- the honest one`,
      `  label counts 1..5           ${[1, 2, 3, 4, 5].map((l) => report.levelCounts.get(l) ?? 0).join('  ')}`,
      `  top knot                    ${report.fit.topX.toFixed(4)} ${report.spec.unit} -> ${report.fit.topScore.toFixed(2)}`,
    );
    lines.push(...renderKnotTable(report));
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join('\n');
}

/** The fitted maps, in the shape weights/v1.ts declares. */
export function toAxisMaps(calibration: Calibration): Record<string, readonly Knot[]> {
  const maps: Record<string, readonly Knot[]> = {};
  for (const report of calibration.axes) maps[report.spec.name] = report.fit.knots;
  return maps;
}

function main(): number {
  const lookupRaw: unknown = JSON.parse(readFileSync(VALIDATION_FEATURES, 'utf8'));
  const lookup = lookupRaw as Record<string, { features: PixelFeatures }>;
  const labels = parseLabels(readFileSync(LABELS_PATH, 'utf8'));

  process.stdout.write(
    `calibrating against ${Object.keys(lookup).length} images and ${labels.length} labels\n`,
  );

  const calibration = calibrate(lookup, labels);
  process.stdout.write(`${renderReport(calibration)}\n`);

  if (calibration.skipped.length > 0) {
    process.stdout.write(`\n! ${calibration.skipped.length} image/axis pair(s) had no label\n`);
  }

  const blockers = calibration.axes.filter((a) => a.warnings.some((w) => w.startsWith('STOP:')));
  if (blockers.length > 0) {
    process.stderr.write(
      `\nNOT writing ${WEIGHTS_PATH}: ${blockers.map((b) => b.spec.name).join(', ')} would cap real inputs.\n`,
    );
    return 2;
  }

  if (process.argv.includes('--write')) {
    const maps = toAxisMaps(calibration);
    writeFileSync(
      'data/validation/fitted-maps.json',
      `${JSON.stringify(maps, null, 1)}\n`,
      'utf8',
    );
    process.stdout.write('\nwrote data/validation/fitted-maps.json\n');
  } else {
    process.stdout.write('\n(dry run - pass --write to emit the fitted maps)\n');
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
