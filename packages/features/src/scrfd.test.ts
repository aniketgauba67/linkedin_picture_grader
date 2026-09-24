import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { extractAll } from './index.js';
import { setDetector } from './face.js';
import { toRgbPlane } from './extract.js';
import { prepareImage } from './normalize.js';
import { createScrfdDetector, nonMaximumSuppression, preprocess } from './scrfd.js';

/**
 * Layer 2: proof that the model loads and fires.
 *
 * ONE committed fixture, pinned by hash. Everything about selection,
 * geometry and determinism is covered in face.test.ts with injected
 * boxes and no model at all - this file only answers "does the detector
 * actually detect".
 */
const FIXTURE = fileURLToPath(new URL('../fixtures/portrait.jpg', import.meta.url));
const FIXTURE_SHA256 = 'f427238ab472653bef8a553e83c98eabcc3fb24015bced6fdaafb669e413be46';

afterAll(() => {
  setDetector(null);
});

describe('the committed fixture', () => {
  it('is the file the tests were written against', () => {
    // A silently swapped fixture would make every assertion below
    // meaningless, so it is pinned rather than trusted.
    const bytes = readFileSync(FIXTURE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA256);
    expect(bytes.length).toBeLessThan(100 * 1024);
  });
});

describe('preprocess', () => {
  it('letterboxes to the square input and leaves padding at zero', () => {
    const plane = { data: new Uint8Array(40 * 20 * 3).fill(255), width: 40, height: 20 };
    const { tensor, scale } = preprocess(plane);
    expect(scale).toBeCloseTo(640 / 40);
    // Bottom-right of the square is padding: (127.5 - 127.5) / 128 = 0.
    expect(tensor[640 * 640 - 1]).toBe(0);
    expect(tensor[0]).toBeCloseTo((255 - 127.5) / 128);
  });

  it('never produces a non-finite value', () => {
    const { tensor } = preprocess({ data: new Uint8Array(9), width: 3, height: 1 });
    expect(tensor.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('nonMaximumSuppression', () => {
  const box = (x: number, score: number) => ({
    x1: x, y1: 0, x2: x + 100, y2: 100, score, points: [],
  });

  it('keeps the highest-scoring box of an overlapping pair', () => {
    const kept = nonMaximumSuppression([box(0, 0.6), box(10, 0.9)], 0.4);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.score).toBeCloseTo(0.9);
  });

  it('keeps boxes that do not overlap', () => {
    expect(nonMaximumSuppression([box(0, 0.9), box(500, 0.8)], 0.4)).toHaveLength(2);
  });
});

describe('SCRFD on a real photograph', () => {
  it('detects exactly one face, with landmarks', async () => {
    const detector = createScrfdDetector();
    const { decodable } = await prepareImage(readFileSync(FIXTURE));
    const rgb = await toRgbPlane(decodable);

    const faces = await detector.detect(rgb);
    expect(faces).toHaveLength(1);

    const found = faces[0];
    expect(found?.box.confidence).toBeGreaterThan(0.7);
    expect(found?.keypoints).not.toBeNull();

    const kp = found?.keypoints;
    if (kp === null || kp === undefined) throw new Error('expected keypoints');
    // Eyes above the nose, nose above the mouth. If the decode were
    // wrong these would be scrambled rather than merely imprecise.
    expect(kp.leftEye[1]).toBeLessThan(kp.nose[1]);
    expect(kp.nose[1]).toBeLessThan(kp.leftMouth[1]);
    expect(kp.leftEye[0]).toBeLessThan(kp.rightEye[0]);
  }, 30_000);

  it('returns boxes in the coordinate space of the plane it was given', async () => {
    const detector = createScrfdDetector();
    const { decodable } = await prepareImage(readFileSync(FIXTURE));
    const rgb = await toRgbPlane(decodable);
    const found = (await detector.detect(rgb))[0];

    // Same decode, same dimensions: no rescaling anywhere downstream.
    expect(found?.box.x).toBeGreaterThanOrEqual(0);
    expect(found?.box.y).toBeGreaterThanOrEqual(0);
    expect((found?.box.x ?? 0) + (found?.box.width ?? 0)).toBeLessThanOrEqual(rgb.width + 1);
    expect((found?.box.y ?? 0) + (found?.box.height ?? 0)).toBeLessThanOrEqual(rgb.height + 1);
  }, 30_000);

  it('is deterministic - the same image gives the same box every run', async () => {
    const detector = createScrfdDetector();
    const { decodable } = await prepareImage(readFileSync(FIXTURE));
    const rgb = await toRgbPlane(decodable);

    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push((await detector.detect(rgb))[0]?.box.x);
    }
    expect(new Set(runs).size).toBe(1);
  }, 60_000);
});

describe('extractAll', () => {
  it('produces a complete vector with the face fields populated', async () => {
    setDetector(null); // force extractAll to register the real detector
    const features = await extractAll(readFileSync(FIXTURE));

    expect(features.faceCount).toBe(1);
    expect(features.faceAreaRatio).toBeGreaterThan(0.05);
    expect(features.primaryFaceConfidence).toBeGreaterThan(0.7);
    expect(features.secondLargestFaceRatio).toBeNull();

    // Measured from the keypoints; a straight-on portrait is near zero.
    expect(Math.abs(features.yaw)).toBeLessThan(15);
    expect(Math.abs(features.roll)).toBeLessThan(15);

    // Unmeasurable from five points - null, never a fabricated zero.
    expect(features.pitch).toBeNull();
    expect(features.eyeOpenness).toBeNull();
    expect(features.smileIntensity).toBeNull();

    // With a face found, the eye band is real and sharpness uses it.
    expect(features.eyeRegionMeasured).toBe(true);
    expect(features.sharpnessEyeRegion).not.toBeNull();
  }, 30_000);
});
