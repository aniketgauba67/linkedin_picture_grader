import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * extractAll is mocked in every test here. The real one loads libvips and
 * an ONNX graph, and this file is about the collector's bookkeeping - the
 * extractor has its own suite. Nothing here touches the network either:
 * the client is handed a fetch.
 */
const extractAll = vi.hoisted(() => vi.fn());
// MAX_INPUT_PIXELS is re-exported at its real value: the pre-filter is
// part of what these tests cover, so mocking it to something convenient
// would test a ceiling the program does not have.
vi.mock('@pps/features', () => ({ extractAll, MAX_INPUT_PIXELS: 50_000_000 }));

const { collect, parseArgs, renderSummary } = await import('./collect-corpus.js');
const { PexelsClient } = await import('./pexels.js');
const { readManifest } = await import('./manifest.js');
import type { PexelsPhoto } from './pexels.js';

/** A feature vector that passes ComputedFeatures. */
function features(width = 1880, height = 2820): Record<string, unknown> {
  return {
    sharpnessLaplacian: 420.5,
    sharpnessEyeRegion: 380.1,
    eyeRegionMeasured: true,
    jpegQualityEstimate: 88,
    exposureMean: 122.4,
    clippedHighlights: 0.004,
    clippedShadows: 0.002,
    dynamicRange: 214,
    width,
    height,
    faceAreaRatio: 0.18,
    faceCenterOffsetX: 0.01,
    faceCenterOffsetY: -0.04,
    faceCount: 1,
    yaw: 2.1,
    roll: 0.5,
    pitch: null,
    eyeOpenness: null,
    smileIntensity: null,
    primaryFaceConfidence: 0.94,
    secondLargestFaceRatio: 0,
    isGrayscale: false,
    aspectExtreme: false,
    sourceFormat: 'jpeg',
    extractorVersion: 'v5',
  };
}

function photo(id: number): PexelsPhoto {
  return {
    id,
    width: 4000,
    height: 6000,
    url: `https://www.pexels.com/photo/example-${id}/`,
    photographer: `Photographer ${id}`,
    photographer_url: `https://www.pexels.com/@p${id}`,
    src: { large2x: `https://images.pexels.com/photos/${id}/large2x.jpeg` },
  };
}

/**
 * A fake Pexels. Each search returns `perQuery` distinct photos, and each
 * download returns bytes unique to its id, so sha256 differs per photo.
 */
function fakeApi(options: { perQuery?: number; sharedPhotoIds?: readonly number[] } = {}) {
  const perQuery = options.perQuery ?? 20;
  const calls = { searches: 0, downloads: 0 };
  let nextId = 1000;

  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.startsWith('https://api.pexels.com')) {
      calls.searches += 1;
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
      if (page > 1) return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      const photos = [
        ...(options.sharedPhotoIds ?? []).map(photo),
        ...Array.from({ length: perQuery }, () => photo((nextId += 1))),
      ];
      return new Response(JSON.stringify({ photos }), { status: 200 });
    }
    calls.downloads += 1;
    const id = /photos\/(\d+)\//.exec(url)?.[1] ?? '0';
    return new Response(new TextEncoder().encode(`image-bytes-${id}`), { status: 200 });
  };

  return { fetchImpl, calls };
}

function tempData(): string {
  return mkdtempSync(join(tmpdir(), 'pps-corpus-'));
}

const QUERIES_SMALL = [
  { query: 'professional headshot', variant: 'good' as const },
  { query: 'car selfie', variant: 'bad' as const },
];

beforeEach(() => {
  extractAll.mockReset();
  extractAll.mockImplementation(async () => features());
});

describe('collect', () => {
  it('collects the requested total and writes a manifest row for each', async () => {
    const dataDir = tempData();
    const { fetchImpl } = fakeApi();
    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 10,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.collected).toBe(10);
    expect(summary.failures).toEqual([]);

    // The spread and the quota come out of the run itself, not a fixture.
    expect(summary.outcomes.map((o) => [o.query, o.have, o.target])).toEqual([
      ['professional headshot', 5, 5],
      ['car selfie', 5, 5],
    ]);
    expect(summary.quota.remaining).toBeNull();

    const manifest = readManifest(join(dataDir, 'manifest.csv'));
    expect(manifest.problems).toEqual([]);
    expect(manifest.rows).toHaveLength(10);
    expect(new Set(manifest.rows.map((r) => r.sha256)).size).toBe(10);
  });

  it('records the dimensions extraction measured, not the ones the API claimed', async () => {
    const dataDir = tempData();
    // The API says 4000x6000 for every photo; extraction says otherwise.
    extractAll.mockImplementation(async () => features(1200, 1600));
    const { fetchImpl } = fakeApi();
    await collect(new PexelsClient('k', fetchImpl), {
      total: 4,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    const rows = readManifest(join(dataDir, 'manifest.csv')).rows;
    expect(rows.every((r) => r.width === 1200 && r.height === 1600)).toBe(true);
  });

  it('writes the image and its feature vector, so extraction is never re-run', async () => {
    const dataDir = tempData();
    const { fetchImpl } = fakeApi();
    await collect(new PexelsClient('k', fetchImpl), {
      total: 2,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    const rows = readManifest(join(dataDir, 'manifest.csv')).rows;
    for (const row of rows) expect(existsSync(row.file)).toBe(true);

    const vectors = readFileSync(join(dataDir, 'features.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sha256: string });
    expect(vectors).toHaveLength(2);
    expect(new Set(vectors.map((v) => v.sha256))).toEqual(new Set(rows.map((r) => r.sha256)));
  });

  it('records the licence and the photographer on every row', async () => {
    const dataDir = tempData();
    const { fetchImpl } = fakeApi();
    await collect(new PexelsClient('k', fetchImpl), {
      total: 2,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    for (const row of readManifest(join(dataDir, 'manifest.csv')).rows) {
      expect(row.licence).toContain('pexels.com/license');
      expect(row.photographer).toMatch(/^Photographer /);
      expect(row.photographerUrl).toContain('pexels.com/@');
    }
  });

  it('takes a photo returned by two queries once, without re-downloading it', async () => {
    const dataDir = tempData();
    // Photo 777 comes back for both queries. The URL index catches it
    // before the download, which is the cheap half of dedupe.
    const shared = fakeApi({ sharedPhotoIds: [777] });
    const summary = await collect(new PexelsClient('k', shared.fetchImpl), {
      total: 10,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    const rows = readManifest(join(dataDir, 'manifest.csv')).rows;
    expect(new Set(rows.map((r) => r.sha256)).size).toBe(rows.length);
    expect(rows.filter((r) => r.url.includes('example-777'))).toHaveLength(1);
    expect(summary.skippedAlreadyHave).toBeGreaterThan(0);
  });

  it('catches a re-upload: different URLs, identical bytes', async () => {
    const dataDir = tempData();
    // Two distinct photo ids whose files are byte-for-byte the same, which
    // the URL index cannot see and only the sha256 catches.
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith('https://api.pexels.com')) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        if (page > 1) return new Response(JSON.stringify({ photos: [] }), { status: 200 });
        return new Response(JSON.stringify({ photos: [photo(1), photo(2)] }), { status: 200 });
      }
      return new Response(new TextEncoder().encode('the same photograph twice'), { status: 200 });
    };

    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 2,
      dataDir,
      queries: [{ query: 'professional headshot', variant: 'good' }],
      log: () => {},
    });

    expect(summary.skippedDuplicateHash).toBe(1);
    expect(readManifest(join(dataDir, 'manifest.csv')).rows).toHaveLength(1);
  });

  it('resumes: a second run re-downloads nothing', async () => {
    const dataDir = tempData();
    const first = fakeApi();
    await collect(new PexelsClient('k', first.fetchImpl), {
      total: 6,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    const downloadsFirst = first.calls.downloads;
    expect(downloadsFirst).toBeGreaterThan(0);

    const second = fakeApi();
    const summary = await collect(new PexelsClient('k', second.fetchImpl), {
      total: 6,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.collected).toBe(0);
    expect(second.calls.downloads).toBe(0);
    // It should not even have searched: the per-query targets are met.
    expect(second.calls.searches).toBe(0);
    expect(readManifest(join(dataDir, 'manifest.csv')).rows).toHaveLength(6);
  });

  it('resumes a partial run and collects only the shortfall', async () => {
    const dataDir = tempData();
    await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 4,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 10,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    expect(summary.collected).toBe(6);
    expect(readManifest(join(dataDir, 'manifest.csv')).rows).toHaveLength(10);
  });

  it('reports a decode failure and keeps it out of the manifest', async () => {
    const dataDir = tempData();
    let call = 0;
    extractAll.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('Could not read image metadata');
      return features();
    });

    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 4,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.stage).toBe('extract');
    expect(summary.failures[0]?.reason).toMatch(/Could not read image metadata/);
    // The failure is reported, and the target is still met from elsewhere.
    expect(summary.collected).toBe(4);
    expect(readManifest(join(dataDir, 'manifest.csv')).rows).toHaveLength(4);
  });

  it('reports a NaN measurement rather than writing a plausible-looking wrong vector', async () => {
    const dataDir = tempData();
    let call = 0;
    extractAll.mockImplementation(async () => {
      call += 1;
      return call === 1 ? { ...features(), exposureMean: Number.NaN } : features();
    });

    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 2,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.failures[0]?.stage).toBe('validate');
    expect(summary.failures[0]?.reason).toMatch(/non-finite measurement in exposureMean/);
  });

  it('reports a vector that does not satisfy the schema', async () => {
    const dataDir = tempData();
    let call = 0;
    extractAll.mockImplementation(async () => {
      call += 1;
      const vector = features();
      if (call === 1) delete vector['extractorVersion'];
      return vector;
    });

    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 2,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    expect(summary.failures[0]?.stage).toBe('validate');
    expect(summary.failures[0]?.reason).toMatch(/extractorVersion/);
  });

  it('never downloads a candidate the API says is over the 50MP ceiling', async () => {
    const dataDir = tempData();
    const downloadedIds: number[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith('https://api.pexels.com')) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        if (page > 1) return new Response(JSON.stringify({ photos: [] }), { status: 200 });
        return new Response(
          JSON.stringify({
            photos: [
              // 101.9MP, the real maximum seen in a 320-photo sample.
              { ...photo(1), width: 8244, height: 12366 },
              { ...photo(2), width: 4000, height: 6000 },
              { ...photo(3), width: 3000, height: 4000 },
            ],
          }),
          { status: 200 },
        );
      }
      downloadedIds.push(Number(/photos\/(\d+)\//.exec(url)?.[1]));
      return new Response(new TextEncoder().encode(`bytes-${downloadedIds.length}`), { status: 200 });
    };

    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 2,
      dataDir,
      queries: [{ query: 'professional headshot', variant: 'good' }],
      log: () => {},
    });

    expect(summary.skippedOversize).toBe(1);
    // The point of the pre-filter: the bytes were never fetched.
    expect(downloadedIds).not.toContain(1);
    expect(summary.collected).toBe(2);
    expect(summary.failures).toEqual([]);
  });

  it('measures the resolution spread from what decoded, not what the API claimed', async () => {
    const dataDir = tempData();
    const sizes = [
      [3000, 4000],
      [2000, 3000],
      [1500, 2000],
      [4000, 6000],
    ];
    let call = 0;
    extractAll.mockImplementation(async () => {
      const [w, h] = sizes[call % sizes.length] ?? [1, 1];
      call += 1;
      return features(w, h);
    });

    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 4,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.resolution?.n).toBe(4);
    expect(summary.resolution?.distinctSizes).toBe(4);
    expect(summary.resolution?.minMp).toBeCloseTo(3, 6);
    expect(summary.resolution?.maxMp).toBeCloseTo(24, 6);
  });

  it('carries the spread across a resume, counting rows from the earlier run', async () => {
    const dataDir = tempData();
    extractAll.mockImplementation(async () => features(2000, 3000));
    await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 2,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    extractAll.mockImplementation(async () => features(4000, 6000));
    const second = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 6,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    // Two 6MP from the first run plus four 24MP from this one.
    expect(second.resolution?.n).toBe(6);
    expect(second.resolution?.minMp).toBeCloseTo(6, 6);
    expect(second.resolution?.maxMp).toBeCloseTo(24, 6);
  });

  it('reports a failed download and does not count it', async () => {
    const dataDir = tempData();
    let downloads = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.startsWith('https://api.pexels.com')) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        if (page > 1) return new Response(JSON.stringify({ photos: [] }), { status: 200 });
        return new Response(
          JSON.stringify({ photos: [photo(1), photo(2), photo(3)] }),
          { status: 200 },
        );
      }
      downloads += 1;
      if (downloads === 1) return new Response('gone', { status: 404 });
      return new Response(new TextEncoder().encode(`bytes-${downloads}`), { status: 200 });
    };

    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 2,
      dataDir,
      queries: [{ query: 'professional headshot', variant: 'good' }],
      log: () => {},
    });
    expect(summary.failures.some((f) => f.stage === 'download')).toBe(true);
  });

  it('stops clean when the quota runs out, leaving a resumable manifest', async () => {
    const dataDir = tempData();
    const base = fakeApi({ perQuery: 2 });
    const fetchImpl = async (url: string): Promise<Response> => {
      const response = await base.fetchImpl(url);
      if (!url.startsWith('https://api.pexels.com')) return response;
      return new Response(await response.text(), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '9999999999' },
      });
    };

    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 50,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });

    expect(summary.stoppedEarly).toMatch(/quota nearly spent/);
    expect(summary.collected).toBeLessThan(50);
    // Whatever it did fetch is on disk and readable.
    expect(readManifest(join(dataDir, 'manifest.csv')).rows).toHaveLength(summary.collected);
  });

  it('stops clean on a 429 rather than hammering the API', async () => {
    const dataDir = tempData();
    const fetchImpl = async (url: string): Promise<Response> =>
      url.startsWith('https://api.pexels.com')
        ? new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset': '9999999999' } })
        : new Response(new Uint8Array([1]), { status: 200 });

    const summary = await collect(new PexelsClient('k', fetchImpl), {
      total: 10,
      dataDir,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    expect(summary.stoppedEarly).toMatch(/rate limit/);
    expect(summary.collected).toBe(0);
  });

  it('writes nothing on a dry run', async () => {
    const dataDir = tempData();
    const summary = await collect(new PexelsClient('k', fakeApi().fetchImpl), {
      total: 4,
      dataDir,
      dryRun: true,
      queries: QUERIES_SMALL,
      log: () => {},
    });
    expect(summary.collected).toBe(4);
    expect(existsSync(join(dataDir, 'manifest.csv'))).toBe(false);
    expect(existsSync(join(dataDir, 'images'))).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to 150, the batch size the pipeline is verified on first', () => {
    expect(parseArgs([])).toEqual({ total: 150, dryRun: false });
  });

  it('reads --total and --dry-run', () => {
    expect(parseArgs(['--total', '700'])).toEqual({ total: 700, dryRun: false });
    expect(parseArgs(['--dry-run', '--total', '40'])).toEqual({ total: 40, dryRun: true });
  });

  it('rejects a total that is not a positive whole number', () => {
    expect(() => parseArgs(['--total', 'lots'])).toThrow(RangeError);
    expect(() => parseArgs(['--total', '0'])).toThrow(RangeError);
    expect(() => parseArgs(['--total'])).toThrow(RangeError);
  });
});

describe('renderSummary', () => {
  const sample = {
    collected: 3,
    skippedAlreadyHave: 1,
    skippedDuplicateHash: 2,
    failures: [
      {
        url: 'https://x/1',
        query: 'car selfie',
        variant: 'bad' as const,
        stage: 'extract' as const,
        reason: 'bad decode',
      },
    ],
    outcomes: [
      { query: 'professional headshot', variant: 'good' as const, target: 12, have: 12, taken: 2 },
      { query: 'car selfie', variant: 'bad' as const, target: 8, have: 3, taken: 1 },
    ],
    skippedOversize: 4,
    resolution: {
      n: 15,
      minMp: 5.02,
      p10Mp: 8.91,
      medianMp: 22.41,
      p90Mp: 30.06,
      maxMp: 47.5,
      distinctSizes: 14,
    },
    quota: { limit: 200, remaining: 173, reset: 1774000000, resetInSeconds: 2400 },
    stoppedEarly: null,
  };

  it('prints every failure rather than a count, and says which variant it came from', () => {
    const text = renderSummary(sample, 150);
    expect(text).toMatch(/\[extract\] "car selfie"\s+https:\/\/x\/1/);
    expect(text).toMatch(/bad decode/);
    expect(text).toMatch(/^ {2}bad \(1\)$/m);
    expect(text).toMatch(/manifest now holds\s+15 of 150/);
  });

  it('prints the spread per query against its target, and flags a shortfall', () => {
    const text = renderSummary(sample, 150);
    expect(text).toMatch(/professional headshot\s+12 \/\s+12\s+\[\+2\]/);
    // car selfie got 3 of 8, which must not pass unremarked.
    expect(text).toMatch(/car selfie\s+3 \/\s+8\s+\[\+1\]\s+! short/);
    expect(text).toMatch(/TOTAL\s+15 \/\s+20/);
  });

  it('prints the achieved variant shares against the planned ones', () => {
    const text = renderSummary(sample, 150);
    expect(text).toMatch(/good\s+80\.0%\s+\(planned 30\.0%\)/);
    expect(text).toMatch(/bad\s+20\.0%\s+\(planned 30\.0%\)/);
  });

  it('prints the resolution spread as megapixels, every run', () => {
    const text = renderSummary(sample, 150);
    expect(text).toMatch(/min\s+5\.02 MP/);
    expect(text).toMatch(/p10\s+8\.91 MP/);
    expect(text).toMatch(/median\s+22\.41 MP/);
    expect(text).toMatch(/p90\s+30\.06 MP/);
    expect(text).toMatch(/max\s+47\.50 MP/);
    expect(text).toMatch(/distinct sizes 14/);
    // Healthy spread: no warning.
    expect(text).not.toMatch(/too little spread/);
  });

  it('flags a corpus where every image is the same size', () => {
    const text = renderSummary(
      {
        ...sample,
        resolution: { n: 150, minMp: 1.13, p10Mp: 1.13, medianMp: 1.13, p90Mp: 1.13, maxMp: 1.13, distinctSizes: 1 },
      },
      150,
    );
    expect(text).toMatch(/every image is the same size/);
  });

  it('flags a spread too narrow to train the resolution axis', () => {
    // The large2x corpus: 0.95-1.35MP, thirty distinct sizes, and still
    // useless - distinctSizes alone would have called this healthy.
    const text = renderSummary(
      {
        ...sample,
        resolution: { n: 150, minMp: 0.95, p10Mp: 1.04, medianMp: 1.13, p90Mp: 1.27, maxMp: 1.35, distinctSizes: 30 },
      },
      150,
    );
    expect(text).toMatch(/only 1\.42x the smallest/);
    expect(text).toMatch(/train or test the resolution axis/);
  });

  it('counts the oversized candidates it never downloaded', () => {
    expect(renderSummary(sample, 150)).toMatch(/over the 50MP ceiling\s+4\s+\(never downloaded\)/);
  });

  it('says so when nothing was collected at all', () => {
    expect(renderSummary({ ...sample, resolution: null }, 150)).toMatch(
      /insufficient data for the resolution spread/,
    );
  });

  it('prints the rate-limit headroom from the last response', () => {
    const text = renderSummary(sample, 150);
    expect(text).toMatch(/X-Ratelimit-Limit\s+200/);
    expect(text).toMatch(/X-Ratelimit-Remaining\s+173/);
    expect(text).toMatch(/X-Ratelimit-Reset\s+1774000000\s+\(in ~40m\)/);
  });

  it('says so when no response carried rate-limit headers', () => {
    const text = renderSummary(
      { ...sample, quota: { limit: null, remaining: null, reset: null, resetInSeconds: null } },
      150,
    );
    expect(text).toMatch(/no API response carried rate-limit headers/);
  });
});
