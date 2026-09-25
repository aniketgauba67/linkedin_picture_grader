/**
 * V1 calibration of the four COMPUTED axes against human labels only.
 *
 * Everything here is a DEVELOPMENT CROSS-VALIDATION ESTIMATE. These 125
 * images have already influenced calibration experimentation in this
 * repository, so no number produced from them is an unbiased test
 * result and none of them may be reported as one.
 *
 * Three rules the code enforces rather than documents:
 *
 *   - targets are `source: 'human'` labels, never VLM predictions. The
 *     offline eight-axis experiment produces labels for these same four
 *     axes and they are not training targets here.
 *   - images with `eligible_for_product_scoring === false` are excluded
 *     from fitting. Eight seed images sit below the 200px product floor;
 *     they keep their labels and are simply not fitted on.
 *   - folds cut on `split_group`, so exact duplicates, near duplicates
 *     and shared source/creator stay on one side.
 *
 * Reusable for the larger human-labelled dataset expected later: it
 * takes a dataset root and a cohort, and everything else follows from
 * the manifest.
 */

import { agreement, kendallTau, spearman } from '@pps/eval';
import {
  framingRaw,
  framingScore,
  lightingRaw,
  lightingScore,
  resolutionScore,
  sharpnessScore,
  shorterEdge,
  WEIGHTS_V1,
  type PixelFeatures,
  type ValidatedPixelFeatures,
} from '@pps/scoring';

import { applyKnots, pava, toKnots, type Knot, type Observation } from './isotonic-fit.js';
import { loadDatasetFeature, loadHumanLabels, loadManifest } from './dataset.js';

export type ComputedAxis = 'sharpness' | 'lighting' | 'resolution' | 'framing';
export const COMPUTED_AXES: readonly ComputedAxis[] = [
  'sharpness',
  'lighting',
  'resolution',
  'framing',
];

export const SEED_COHORT = 'wikimedia_seed_125';

export interface PopulationRow {
  readonly imageId: string;
  readonly splitGroup: string;
  readonly features: PixelFeatures;
  readonly label: number;
}

export interface PopulationReport {
  readonly cohort: string;
  readonly totalSeedImages: number;
  readonly eligibleImages: number;
  readonly excludedImages: number;
  readonly exclusionReasons: Readonly<Record<string, number>>;
  readonly extractorVersions: Readonly<Record<string, number>>;
  readonly labelsPerAxis: Readonly<Record<string, number>>;
  readonly fittedRowsPerAxis: Readonly<Record<string, number>>;
  readonly labelDistribution: Readonly<Record<string, Readonly<Record<number, number>>>>;
  /** Images whose driving measurement is null for an axis. Never imputed. */
  readonly missingMeasurements: Readonly<Record<string, readonly string[]>>;
  readonly excludedImageIds: readonly string[];
}

/** The measurement each axis's candidate map runs over. Null means the
 *  measurement does not exist for that image; the row is dropped, never
 *  filled in. */
export function drivingScalar(axis: ComputedAxis, features: PixelFeatures): number | null {
  switch (axis) {
    case 'sharpness':
      // The basis the shipped scorer would use for this image. Fitting
      // over a different basis than production reads would calibrate a
      // path the product never takes.
      return features.eyeRegionMeasured ? features.sharpnessEyeRegion : features.sharpnessLaplacian;
    case 'lighting':
      return lightingRaw(features as ValidatedPixelFeatures, WEIGHTS_V1);
    case 'resolution':
      return shorterEdge(features);
    case 'framing':
      return framingRaw(features as ValidatedPixelFeatures, WEIGHTS_V1);
    default: {
      const unreachable: never = axis;
      throw new Error(`Unknown axis ${String(unreachable)}`);
    }
  }
}

/** What the shipped product scores this image today. */
export function currentPrediction(axis: ComputedAxis, features: PixelFeatures): number {
  const validated = features as ValidatedPixelFeatures;
  switch (axis) {
    case 'sharpness':
      return sharpnessScore(validated, WEIGHTS_V1);
    case 'lighting':
      return lightingScore(validated, WEIGHTS_V1);
    case 'resolution':
      return resolutionScore(validated, WEIGHTS_V1);
    case 'framing':
      return framingScore(validated, WEIGHTS_V1);
    default: {
      const unreachable: never = axis;
      throw new Error(`Unknown axis ${String(unreachable)}`);
    }
  }
}

export interface BuiltPopulation {
  readonly byAxis: ReadonlyMap<ComputedAxis, readonly PopulationRow[]>;
  readonly report: PopulationReport;
}

export function buildPopulation(root: string, cohort: string = SEED_COHORT): BuiltPopulation {
  const manifest = loadManifest(root).filter((row) => row.cohort === cohort);
  const labels = loadHumanLabels(root).filter((label) => label.cohort === cohort);

  const byId = new Map(manifest.map((row) => [row.image_id, row]));
  const eligible = manifest.filter((row) => row.eligible_for_product_scoring === true);
  const excluded = manifest.filter((row) => row.eligible_for_product_scoring !== true);

  const count = <T,>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
    return out;
  };

  const byAxis = new Map<ComputedAxis, PopulationRow[]>();
  const missing: Record<string, string[]> = {};
  const distribution: Record<string, Record<number, number>> = {};

  for (const axis of COMPUTED_AXES) {
    const rows: PopulationRow[] = [];
    const absent: string[] = [];
    const dist: Record<number, number> = {};

    for (const label of labels.filter((l) => l.axis === axis)) {
      dist[label.score] = (dist[label.score] ?? 0) + 1;
      const manifestRow = byId.get(label.image_id);
      if (manifestRow === undefined) continue;
      // Product calibration fits only on what the product would score.
      if (manifestRow.eligible_for_product_scoring !== true) continue;

      const features = loadDatasetFeature(root, manifestRow) as PixelFeatures;
      const x = drivingScalar(axis, features);
      if (x === null || !Number.isFinite(x)) {
        // Not imputed. A missing measurement is absent, and a row with
        // no measurement cannot inform a mapping from measurements.
        absent.push(label.image_id);
        continue;
      }
      rows.push({
        imageId: label.image_id,
        splitGroup: manifestRow.split_group,
        features,
        label: label.score,
      });
    }

    byAxis.set(axis, rows);
    missing[axis] = absent;
    distribution[axis] = dist;
  }

  return {
    byAxis,
    report: {
      cohort,
      totalSeedImages: manifest.length,
      eligibleImages: eligible.length,
      excludedImages: excluded.length,
      exclusionReasons: count(excluded, (row) => row.eligibility_reason ?? 'unknown'),
      extractorVersions: count(manifest, (row) => row.extractor_version ?? 'none'),
      labelsPerAxis: count(labels, (label) => label.axis),
      fittedRowsPerAxis: Object.fromEntries(
        [...byAxis].map(([axis, rows]) => [axis, rows.length]),
      ),
      labelDistribution: distribution,
      missingMeasurements: missing,
      excludedImageIds: excluded.map((row) => row.image_id).sort(),
    },
  };
}

/**
 * Deterministic group-aware folds.
 *
 * Groups are sorted by size descending then by id, and dealt to whichever
 * fold currently holds the fewest rows. No randomness and no seed: the
 * same population always produces the same folds, so two runs are
 * comparable and a reported number can be reproduced.
 *
 * Cutting on `split_group` is what keeps exact duplicates, near
 * duplicates and shared creators on one side. A row-level split would
 * put a near-duplicate of a training image in the test fold and report
 * the memorised answer as accuracy.
 */
export function assignFolds(rows: readonly PopulationRow[], k = 5): number[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const bucket = groups.get(row.splitGroup);
    if (bucket === undefined) groups.set(row.splitGroup, [index]);
    else bucket.push(index);
  });

  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );

  const folds = new Array<number>(rows.length).fill(0);
  const load = new Array<number>(k).fill(0);
  for (const [, indices] of ordered) {
    let smallest = 0;
    for (let f = 1; f < k; f += 1) if ((load[f] ?? 0) < (load[smallest] ?? 0)) smallest = f;
    for (const index of indices) folds[index] = smallest;
    load[smallest] = (load[smallest] ?? 0) + indices.length;
  }
  return folds;
}

export interface AxisMetrics {
  readonly n: number;
  readonly spearman: number | null;
  readonly kendall: number | null;
  readonly mae: number;
  readonly exact: number;
  readonly withinOne: number;
  readonly bias: number;
  /** predicted[human] -> count, both rounded to 1-5. */
  readonly confusion: readonly (readonly number[])[];
  readonly humanDistribution: Readonly<Record<number, number>>;
  readonly predictedDistribution: Readonly<Record<number, number>>;
}

const clampAxis = (value: number): number => Math.min(5, Math.max(1, value));

export function scoreMetrics(
  predicted: readonly number[],
  human: readonly number[],
): AxisMetrics {
  const rounded = predicted.map((p) => Math.round(clampAxis(p)));
  const sp = spearman(predicted, human);
  const kt = kendallTau(predicted, human);
  const ag = agreement(rounded, human);

  const confusion = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const humanDist: Record<number, number> = {};
  const predDist: Record<number, number> = {};
  for (let i = 0; i < rounded.length; i += 1) {
    const h = human[i] ?? 0;
    const p = rounded[i] ?? 0;
    humanDist[h] = (humanDist[h] ?? 0) + 1;
    predDist[p] = (predDist[p] ?? 0) + 1;
    const row = confusion[h - 1];
    if (row !== undefined && p >= 1 && p <= 5) row[p - 1] = (row[p - 1] ?? 0) + 1;
  }

  return {
    n: rounded.length,
    spearman: sp.ok ? sp.value : null,
    kendall: kt.ok ? kt.value : null,
    mae: 'ok' in ag ? Number.NaN : ag.mae,
    exact: 'ok' in ag ? Number.NaN : ag.exact,
    withinOne: 'ok' in ag ? Number.NaN : ag.withinOne,
    bias: 'ok' in ag ? Number.NaN : ag.bias,
    confusion,
    humanDistribution: humanDist,
    predictedDistribution: predDist,
  };
}

/**
 * Minimum labelled examples at a score before a fitted map may place a
 * knot for it.
 *
 * The sparse extremes are real: sharpness has one 5, resolution has one
 * 1 and one 5, framing has no 5 at all. A knot anchored on a single
 * photograph is that photograph's idiosyncrasies promoted to a product
 * rule, and it will not survive contact with the next dataset.
 */
export const MIN_EXAMPLES_FOR_KNOT = 5;

/**
 * An isotonic candidate fitted INSIDE a training fold.
 *
 * Monotone by construction, which is the right shape: every one of these
 * scalars is ordered in goodness. Levels with too few examples get no
 * knot of their own and are absorbed by the pooling, so a single
 * score-5 photograph cannot mint a score-5 region.
 */
export function fitIsotonic(train: readonly PopulationRow[], axis: ComputedAxis): readonly Knot[] {
  const counts = new Map<number, number>();
  for (const row of train) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  const supported = [1, 2, 3, 4, 5].filter(
    (level) => (counts.get(level) ?? 0) >= MIN_EXAMPLES_FOR_KNOT,
  );
  if (supported.length < 2) return [];

  const observations: Observation[] = train.map((row) => ({
    x: drivingScalar(axis, row.features) ?? 0,
    y: row.label,
  }));
  return toKnots(pava(observations), supported).knots;
}

export interface Comparison {
  readonly axis: ComputedAxis;
  readonly folds: number;
  readonly groups: number;
  readonly current: AxisMetrics;
  readonly candidate: AxisMetrics;
  /** Knots fitted on the whole eligible population, for reporting only. */
  readonly candidateKnotsFullFit: readonly Knot[];
  readonly foldSizes: readonly number[];
}

/**
 * Current versus candidate on IDENTICAL folds.
 *
 * The current mapping needs no fitting, so it is simply evaluated on the
 * same held-out rows. The candidate is refitted from scratch on each
 * training fold - fitting once on everything and scoring the folds would
 * be an in-sample number wearing a cross-validation label.
 */
export function compareAxis(
  rows: readonly PopulationRow[],
  axis: ComputedAxis,
  k = 5,
): Comparison {
  const folds = assignFolds(rows, k);
  const groups = new Set(rows.map((row) => row.splitGroup)).size;

  const currentPredicted: number[] = [];
  const candidatePredicted: number[] = [];
  const human: number[] = [];
  const foldSizes = new Array<number>(k).fill(0);

  for (let f = 0; f < k; f += 1) {
    const train = rows.filter((_, i) => folds[i] !== f);
    const test = rows.filter((_, i) => folds[i] === f);
    foldSizes[f] = test.length;
    if (test.length === 0) continue;

    const knots = fitIsotonic(train, axis);
    for (const row of test) {
      human.push(row.label);
      currentPredicted.push(currentPrediction(axis, row.features));
      const x = drivingScalar(axis, row.features) ?? 0;
      // No supportable knots means the candidate has nothing to say and
      // defers to the shipped mapping rather than inventing a constant.
      candidatePredicted.push(
        knots.length === 0 ? currentPrediction(axis, row.features) : applyKnots(x, knots),
      );
    }
  }

  return {
    axis,
    folds: k,
    groups,
    current: scoreMetrics(currentPredicted, human),
    candidate: scoreMetrics(candidatePredicted, human),
    candidateKnotsFullFit: fitIsotonic(rows, axis),
    foldSizes,
  };
}
