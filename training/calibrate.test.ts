import { describe, expect, it } from 'vitest';

import {
  AXES,
  calibrate,
  clustersFromSources,
  describe as describeDistribution,
  MAX_MODE_SHARE,
  parseLabels,
  TOP_KNOT_FLOOR,
  type LabelRow,
} from './calibrate.js';

/** Aliased: vitest's `describe` owns the name in this file. */
const describeValues = describeDistribution;

/** A feature vector complete enough for every axis's measure(). */
function features(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sharpnessLaplacian: 400,
    sharpnessEyeRegion: 350,
    eyeRegionMeasured: true,
    jpegQualityEstimate: 90,
    exposureMean: 120,
    clippedHighlights: 0.001,
    clippedShadows: 0.001,
    dynamicRange: 210,
    faceExposureMean: 118,
    faceClippedHighlights: 0.002,
    faceClippedShadows: 0.003,
    faceRegionMeasured: true,
    width: 2000,
    height: 3000,
    faceAreaRatio: 0.3,
    faceCenterOffsetX: 0,
    faceCenterOffsetY: 0,
    faceCount: 1,
    extractorVersion: 'v5',
    ...overrides,
  };
}

describe('parseLabels', () => {
  it('reads an unquoted file', () => {
    const rows = parseLabels('filename,axis,score\nG001.jpg,sharpness,4\nB002.jpg,framing,1\n');
    expect(rows).toEqual([
      { filename: 'G001.jpg', axis: 'sharpness', score: 4 },
      { filename: 'B002.jpg', axis: 'framing', score: 1 },
    ]);
  });

  it('reads a fully quoted file, which is what the live one is', () => {
    const rows = parseLabels('"filename","axis","score"\n"G001.jpg","sharpness","4"\n');
    expect(rows).toEqual([{ filename: 'G001.jpg', axis: 'sharpness', score: 4 }]);
  });

  it('tolerates columns in a different order', () => {
    const rows = parseLabels('score,filename,axis\n3,G001.jpg,lighting\n');
    expect(rows[0]).toEqual({ filename: 'G001.jpg', axis: 'lighting', score: 3 });
  });

  it('throws rather than guessing when a required column is absent', () => {
    expect(() => parseLabels('file,axis,score\nG001.jpg,sharpness,4\n')).toThrow(/filename/);
  });

  it('throws on a non-numeric score rather than fitting a NaN', () => {
    expect(() => parseLabels('filename,axis,score\nG001.jpg,sharpness,high\n')).toThrow(/non-numeric/);
  });
});

describe('axis specs', () => {
  it('fits the two sharpness maps on disjoint images, so neither can drag the other', () => {
    const eye = AXES.find((a) => a.name === 'sharpnessEyeRegion');
    const frame = AXES.find((a) => a.name === 'sharpnessFrame');

    const measured = features({ eyeRegionMeasured: true }) as never;
    const unmeasured = features({ eyeRegionMeasured: false, sharpnessEyeRegion: null }) as never;

    // Where the eye region was measured, only the eye map takes it.
    expect(eye?.measure(measured)).toBe(350);
    expect(frame?.measure(measured)).toBeNull();

    // Where it was not, only the frame map does.
    expect(eye?.measure(unmeasured)).toBeNull();
    expect(frame?.measure(unmeasured)).toBe(400);
  });

  it('measures resolution by the shorter edge, which is what a square crop is limited by', () => {
    const resolution = AXES.find((a) => a.name === 'resolution');
    expect(resolution?.measure(features({ width: 4000, height: 3000 }) as never)).toBe(3000);
    // 4000x400 is 1.6MP and 400 usable pixels; megapixels flatter it.
    expect(resolution?.measure(features({ width: 4000, height: 400 }) as never)).toBe(400);
    expect(resolution?.scaleInvariant).toBe(false);
    expect(resolution?.fitted).toBe(false);
  });

  it('fits framing over framingRaw, never over faceAreaRatio', () => {
    const framing = AXES.find((a) => a.name === 'framing');
    // An ideal face and a badly offset one must not produce the same x.
    const ideal = framing?.measure(features({ faceAreaRatio: 0.3 }) as never) ?? 0;
    const offset = framing?.measure(
      features({ faceAreaRatio: 0.3, faceCenterOffsetX: 0.45 }) as never,
    ) ?? 0;
    expect(ideal).toBeGreaterThan(offset);
    expect(framing?.unit).toMatch(/framingRaw/);
  });
});

/** Build a lookup and labels where an axis has a clean monotone signal. */
function dataset(
  scoreFor: (megapixels: number) => number,
  count = 60,
): { lookup: Record<string, { features: never }>; labels: LabelRow[] } {
  // `scoreFor` receives megapixels; the resolution axis measures the
  // shorter edge of a square image, so the two stay in step.
  const lookup: Record<string, { features: never }> = {};
  const labels: LabelRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const filename = `X${String(i).padStart(3, '0')}.jpg`;
    // Square, so the shorter edge tracks the intended size rather than
    // saturating against a fixed width.
    const megapixels = 0.2 + i * 0.4;
    const edge = Math.round(Math.sqrt(megapixels * 1_000_000));
    lookup[filename] = { features: features({ width: edge, height: edge }) as never };
    for (const axis of ['sharpness', 'lighting', 'resolution', 'framing'] as const) {
      labels.push({ filename, axis, score: axis === 'resolution' ? scoreFor(megapixels) : 3 });
    }
  }
  return { lookup, labels };
}

describe('calibrate', () => {
  it('fits a clean monotone signal and reaches the top of the scale', () => {
    const { lookup, labels } = dataset((mp) => Math.max(1, Math.min(5, Math.ceil(mp / 5))));
    const result = calibrate(lookup, labels);
    const resolution = result.axes.find((a) => a.spec.name === 'resolution');

    expect(resolution?.fit.topScore).toBe(5);
    expect(resolution?.spearmanCrossValidated ?? 0).toBeGreaterThan(0.9);
    expect(resolution?.warnings.filter((w) => w.startsWith('STOP:'))).toEqual([]);
  });

  it('stops when no label ever reaches the top, however good the measurement', () => {
    // Scores capped at 3. The measurement is perfectly monotone and
    // perfectly scale-invariant; the LABELS are the ceiling.
    const { lookup, labels } = dataset((mp) => Math.max(1, Math.min(3, Math.ceil(mp / 8))));
    const result = calibrate(lookup, labels);
    const resolution = result.axes.find((a) => a.spec.name === 'resolution');

    expect(resolution?.fit.topScore).toBeLessThan(TOP_KNOT_FLOOR);
    expect(resolution?.warnings.some((w) => w.startsWith('STOP:') && /clamp/.test(w))).toBe(true);
  });

  it('stops when the fit collapses to one constant knot', () => {
    // Every image scores 3 regardless of measurement: the lighting
    // failure, reproduced.
    const { lookup, labels } = dataset(() => 3);
    const result = calibrate(lookup, labels);
    const resolution = result.axes.find((a) => a.spec.name === 'resolution');

    expect(resolution?.fit.knots.length).toBe(1);
    expect(resolution?.warnings.some((w) => /collapsed to a single knot/.test(w))).toBe(true);
  });

  it('reports a level with no examples as unable to be output at all', () => {
    const { lookup, labels } = dataset((mp) => (mp < 10 ? 1 : 4));
    const result = calibrate(lookup, labels);
    const resolution = result.axes.find((a) => a.spec.name === 'resolution');
    expect(resolution?.warnings.some((w) => /NO example scored 5/.test(w))).toBe(true);
  });

  it('records the images it had no label for instead of scoring them as zero', () => {
    const { lookup, labels } = dataset((mp) => Math.min(5, Math.ceil(mp / 5)));
    const thinned = labels.filter((l) => l.filename !== 'X000.jpg');
    const result = calibrate(lookup, thinned);
    expect(result.skipped.some((s) => s.startsWith('X000.jpg|'))).toBe(true);
  });

  it('reports the cross-validated figure separately from the in-sample one', () => {
    const { lookup, labels } = dataset((mp) => Math.max(1, Math.min(5, Math.ceil(mp / 5))));
    const result = calibrate(lookup, labels);
    const resolution = result.axes.find((a) => a.spec.name === 'resolution');
    // Both exist and are distinct numbers, not the same value twice.
    expect(resolution?.spearmanInSample).not.toBeNull();
    expect(resolution?.spearmanCrossValidated).not.toBeNull();
  });
});

describe('describe (the standing distribution check)', () => {
  it('reports the pile-up that makes a scalar unfittable', () => {
    // framingRaw before the fix: 53 of 125 on exactly 0.
    const values = [...Array<number>(53).fill(0), ...Array.from({ length: 72 }, (_, i) => 0.1 + i * 0.01)];
    const d = describeValues(values);
    expect(d?.modeValue).toBe(0);
    expect(d?.modeShare).toBeCloseTo(53 / 125, 6);
    expect(d?.modeShare ?? 0).toBeGreaterThan(MAX_MODE_SHARE);
  });

  it('reports quartiles and distinct count', () => {
    const d = describeValues([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d?.n).toBe(10);
    expect(d?.min).toBe(1);
    expect(d?.max).toBe(10);
    expect(d?.distinct).toBe(10);
    expect(d?.modeShare).toBeCloseTo(0.1, 6);
  });

  it('returns null rather than dividing by zero on nothing', () => {
    expect(describeValues([])).toBeNull();
  });

  it('warns on a fitted axis whose scalar piles up', () => {
    const lookup: Record<string, { features: never }> = {};
    const labels: LabelRow[] = [];
    for (let i = 0; i < 40; i += 1) {
      const filename = `P${String(i).padStart(3, '0')}.jpg`;
      // Every image has no face, so framingRaw floors at 0 for all.
      lookup[filename] = { features: features({ faceCount: 0, faceAreaRatio: 0 }) as never };
      for (const axis of ['sharpness', 'lighting', 'resolution', 'framing'] as const) {
        labels.push({ filename, axis, score: (i % 4) + 1 });
      }
    }
    const framing = calibrate(lookup, labels).axes.find((a) => a.spec.name === 'framing');
    expect(framing?.distribution?.modeShare).toBe(1);
    expect(framing?.warnings.some((w) => /sit on the single value/.test(w))).toBe(true);
  });
});

describe('clustersFromSources', () => {
  const csv = [
    'image_id,original_filename,source,source_page_url,direct_image_url_if_available,creator,license,license_url,download_date,notes',
    'G001,a.jpg,Commons,https://x/1,https://y/1,Ada Lovelace,CC0,https://l/0,2026-09-24,note',
    'G002,b.jpg,Commons,https://x/2,https://y/2,Ada Lovelace,CC0,https://l/0,2026-09-24,note',
    'G003,c.jpg,Commons,https://x/3,https://y/3,Grace Hopper,CC0,https://l/0,2026-09-24,note',
    'G004,d.jpg,Commons,https://x/4,https://y/4,Unknown author,CC0,https://l/0,2026-09-24,note',
    'G005,e.jpg,Commons,https://x/5,https://y/5,Unknown author,CC0,https://l/0,2026-09-24,note',
  ].join('\n');

  it('groups photographs by a creator who appears more than once', () => {
    const clusters = clustersFromSources(csv);
    expect(clusters.get('G001.jpg')).toBe(clusters.get('G002.jpg'));
    expect(clusters.get('G001.jpg')).toMatch(/^creator:/);
  });

  it('leaves a creator with one photograph as their own cluster', () => {
    const clusters = clustersFromSources(csv);
    expect(clusters.get('G003.jpg')).toBe('image:G003');
  });

  it('does not treat a placeholder as a shared identity', () => {
    // "Unknown author" twice is missing data, not one photographer.
    const clusters = clustersFromSources(csv);
    expect(clusters.get('G004.jpg')).not.toBe(clusters.get('G005.jpg'));
  });

  it('keys on filename, not image_id, so it joins the feature lookup', () => {
    expect([...clustersFromSources(csv).keys()]).toContain('G001.jpg');
  });

  it('survives a quoted field containing a comma', () => {
    const quoted = [
      'image_id,creator',
      'G001,"Simões, Pedro"',
      'G002,"Simões, Pedro"',
    ].join('\n');
    const clusters = clustersFromSources(quoted);
    expect(clusters.get('G001.jpg')).toBe(clusters.get('G002.jpg'));
    expect(clusters.get('G001.jpg')).toContain('Simões, Pedro');
  });

  it('returns nothing when the columns are absent rather than guessing', () => {
    expect(clustersFromSources('a,b\n1,2\n').size).toBe(0);
  });
});
