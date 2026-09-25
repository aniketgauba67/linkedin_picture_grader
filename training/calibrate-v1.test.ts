import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assignFolds,
  buildPopulation,
  compareAxis,
  COMPUTED_AXES,
  drivingScalar,
  fitIsotonic,
  MIN_EXAMPLES_FOR_KNOT,
  scoreMetrics,
  SEED_COHORT,
  type PopulationRow,
} from './calibrate-v1.js';
import { loadHumanLabels, loadManifest } from './dataset.js';

/**
 * Resolved from this file, NOT from cwd. `pnpm test` at the repo root
 * and `pnpm --filter @pps/training test` run with different working
 * directories, and a cwd-relative dataset path silently resolves to a
 * directory that does not exist in one of them - every population comes
 * back empty and the assertions pass vacuously.
 */
const ROOT = fileURLToPath(new URL('../data/dataset-v1', import.meta.url));

/** The eight seed images below the 200px product floor. */
const BELOW_FLOOR = ['B016', 'B028', 'B036', 'G009', 'G027', 'G035', 'M030', 'M031'];

describe('eligibility filtering', () => {
  const { byAxis, report } = buildPopulation(ROOT);

  it('fits only on images the product would actually score', () => {
    expect(report.totalSeedImages).toBe(125);
    expect(report.eligibleImages).toBe(117);
    expect(report.excludedImages).toBe(8);
    expect(report.exclusionReasons['below_dimension_floor']).toBe(8);
  });

  it('excludes exactly the known below-floor images, and does not delete them', () => {
    expect([...report.excludedImageIds]).toEqual(BELOW_FLOOR);
    // Still present in the manifest, still carrying their labels.
    const manifest = loadManifest(ROOT);
    const labels = loadHumanLabels(ROOT);
    for (const id of BELOW_FLOOR) {
      expect(manifest.some((row) => row.image_id === id), id).toBe(true);
      expect(labels.some((label) => label.image_id === id), id).toBe(true);
    }
  });

  it('keeps below-floor images out of every axis population', () => {
    for (const axis of COMPUTED_AXES) {
      const ids = new Set((byAxis.get(axis) ?? []).map((row) => row.imageId));
      for (const id of BELOW_FLOOR) expect(ids.has(id), `${axis}/${id}`).toBe(false);
    }
  });

  it('never imputes a missing measurement', () => {
    // Nothing is missing today; the guarantee is that a missing driving
    // scalar drops the row rather than becoming a number.
    for (const axis of COMPUTED_AXES) {
      const fitted = report.fittedRowsPerAxis[axis] ?? 0;
      const missing = report.missingMeasurements[axis]?.length ?? 0;
      expect(fitted + missing).toBe(report.eligibleImages);
    }
  });
});

describe('human targets only', () => {
  it('fits against human labels and nothing else', () => {
    const labels = loadHumanLabels(ROOT);
    // HumanLabel is a `source: 'human'` literal, so a VLM row cannot
    // parse into this list at all. The offline eight-axis experiment
    // writes VlmLabel, which is a different type and a different file.
    expect(labels.every((label) => label.source === 'human')).toBe(true);
    expect(labels.length).toBeGreaterThan(0);
  });

  it('never reads the offline eight-axis assessments', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./calibrate-v1.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/offline-/);
    expect(source).not.toMatch(/VlmLabel|loadVlmLabels|offline_eight/);
  });

  it('keeps the separate framing cohort out of the seed population', () => {
    const { byAxis } = buildPopulation(ROOT, SEED_COHORT);
    const framing = byAxis.get('framing') ?? [];
    const seedIds = new Set(
      loadManifest(ROOT)
        .filter((row) => row.cohort === SEED_COHORT)
        .map((row) => row.image_id),
    );
    // 40 Pexels framing labels exist and none of them are here: the two
    // passes were measured on different scales and merging them made a
    // monotone fit worse, not better.
    expect(framing.length).toBe(117);
    expect(framing.every((row) => seedIds.has(row.imageId))).toBe(true);
  });
});

describe('group-aware deterministic folds', () => {
  const rows: PopulationRow[] = [
    { imageId: 'a', splitGroup: 'g1', features: {} as never, label: 1 },
    { imageId: 'b', splitGroup: 'g1', features: {} as never, label: 2 },
    { imageId: 'c', splitGroup: 'g2', features: {} as never, label: 3 },
    { imageId: 'd', splitGroup: 'g3', features: {} as never, label: 4 },
    { imageId: 'e', splitGroup: 'g3', features: {} as never, label: 5 },
    { imageId: 'f', splitGroup: 'g4', features: {} as never, label: 1 },
  ];

  it('keeps every member of a split group in one fold', () => {
    const folds = assignFolds(rows, 3);
    const byGroup = new Map<string, Set<number>>();
    rows.forEach((row, i) => {
      const set = byGroup.get(row.splitGroup) ?? new Set<number>();
      set.add(folds[i] ?? -1);
      byGroup.set(row.splitGroup, set);
    });
    for (const [group, assigned] of byGroup) expect(assigned.size, group).toBe(1);
  });

  it('is deterministic - the same population gives the same folds', () => {
    expect(assignFolds(rows, 3)).toEqual(assignFolds(rows, 3));
    // And not dependent on input order within a group.
    const reordered = [...rows].reverse();
    const a = new Map(rows.map((r, i) => [r.imageId, assignFolds(rows, 3)[i]]));
    const b = new Map(reordered.map((r, i) => [r.imageId, assignFolds(reordered, 3)[i]]));
    for (const row of rows) expect(a.get(row.imageId)).toBe(b.get(row.imageId));
  });

  it('holds the real seed groups together', () => {
    const { byAxis } = buildPopulation(ROOT);
    const population = byAxis.get('framing') ?? [];
    const folds = assignFolds(population, 5);
    const seen = new Map<string, number>();
    population.forEach((row, i) => {
      const fold = folds[i] ?? -1;
      const previous = seen.get(row.splitGroup);
      if (previous === undefined) seen.set(row.splitGroup, fold);
      else expect(fold, row.splitGroup).toBe(previous);
    });
    expect(seen.size).toBe(110);
  });
});

describe('sparse-class safety', () => {
  it('refuses to anchor a knot on too few examples', () => {
    const rows: PopulationRow[] = Array.from({ length: 30 }, (_, i) => ({
      imageId: `x${i}`,
      splitGroup: `g${i}`,
      features: { width: 100 + i * 10, height: 100 + i * 10 } as never,
      // One single score-5 example, the sharpness situation exactly.
      label: i === 29 ? 5 : ((i % 3) + 1),
    }));
    const knots = fitIsotonic(rows, 'resolution');
    // No knot may exist for a level with one example.
    expect(knots.every(([, level]) => level !== 5)).toBe(true);
  });

  it('returns no knots at all rather than a one-level map', () => {
    const rows: PopulationRow[] = Array.from({ length: 4 }, (_, i) => ({
      imageId: `x${i}`,
      splitGroup: `g${i}`,
      features: { width: 300, height: 300 } as never,
      label: 3,
    }));
    expect(fitIsotonic(rows, 'resolution')).toEqual([]);
  });

  it('documents the threshold it enforces', () => {
    expect(MIN_EXAMPLES_FOR_KNOT).toBeGreaterThanOrEqual(5);
  });
});

describe('same-fold comparison', () => {
  it('scores current and candidate on identical held-out rows', () => {
    const { byAxis } = buildPopulation(ROOT);
    const rows = byAxis.get('resolution') ?? [];
    const comparison = compareAxis(rows, 'resolution', 5);
    expect(comparison.current.n).toBe(comparison.candidate.n);
    expect(comparison.current.n).toBe(rows.length);
    expect(comparison.foldSizes.reduce((s, n) => s + n, 0)).toBe(rows.length);
    // Same human labels behind both.
    expect(comparison.current.humanDistribution).toEqual(comparison.candidate.humanDistribution);
  });

  it('is reproducible run to run', () => {
    const { byAxis } = buildPopulation(ROOT);
    const rows = byAxis.get('framing') ?? [];
    expect(compareAxis(rows, 'framing', 5).candidate).toEqual(
      compareAxis(rows, 'framing', 5).candidate,
    );
  });
});

describe('driving scalars', () => {
  it('uses the basis the shipped scorer would use for sharpness', () => {
    const measured = { eyeRegionMeasured: true, sharpnessEyeRegion: 42, sharpnessLaplacian: 999 };
    const unmeasured = { eyeRegionMeasured: false, sharpnessEyeRegion: null, sharpnessLaplacian: 999 };
    expect(drivingScalar('sharpness', measured as never)).toBe(42);
    expect(drivingScalar('sharpness', unmeasured as never)).toBe(999);
  });

  it('returns null rather than a stand-in when the measurement is absent', () => {
    const absent = { eyeRegionMeasured: true, sharpnessEyeRegion: null, sharpnessLaplacian: 999 };
    expect(drivingScalar('sharpness', absent as never)).toBeNull();
  });
});

describe('scoreMetrics', () => {
  it('reports a perfect predictor as perfect', () => {
    const m = scoreMetrics([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
    expect(m.spearman).toBeCloseTo(1, 10);
    expect(m.exact).toBe(1);
    expect(m.mae).toBe(0);
    expect(m.bias).toBe(0);
  });

  it('keeps predictions inside 1-5 when it rounds them', () => {
    const m = scoreMetrics([-3, 9], [1, 5]);
    expect(m.predictedDistribution[1]).toBe(1);
    expect(m.predictedDistribution[5]).toBe(1);
  });
});
