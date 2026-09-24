import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ComputedFeatures, FEATURE_FIELDS, assertFeaturesUsable } from '@pps/schema';
import { scoreComputedAxes } from '@pps/scoring';
import { extractFeatures, toLumaPlane } from './extract.js';
import type { FaceObservation } from './face.js';
import { setDetector } from './face.js';

afterEach(() => {
  setDetector(null);
});

function observation(overrides: Partial<FaceObservation> = {}): FaceObservation {
  return {
    box: { x: 256, y: 256, width: 512, height: 512, confidence: 0.95 },
    eyeRegion: null,
    yaw: 0,
    pitch: 0,
    roll: 0,
    eyeOpenness: 0.8,
    smileIntensity: 0.3,
    ...overrides,
  };
}

async function solid(width: number, height: number, rgb: [number, number, number]) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

async function noise(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    pixels[i] = seed % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('toLumaPlane', () => {
  it('downscales to the analysis edge and returns one byte per pixel', async () => {
    const plane = await toLumaPlane(await solid(2048, 1024, [10, 20, 30]));
    expect(plane.width).toBe(1024);
    expect(plane.height).toBe(512);
    expect(plane.data.length).toBe(plane.width * plane.height);
  });

  it('does not enlarge an image that is already small', async () => {
    const plane = await toLumaPlane(await solid(200, 200, [128, 128, 128]));
    expect(plane.width).toBe(200);
  });
});

describe('extractFeatures', () => {
  it('produces a vector that satisfies ComputedFeatures', async () => {
    const features = await extractFeatures(await noise(512, 512));
    expect(() => ComputedFeatures.parse(features)).not.toThrow();
    expect(() => assertFeaturesUsable(features)).not.toThrow();
  });

  it('emits a finite number for every declared field', async () => {
    const features = await extractFeatures(await noise(400, 400));
    for (const field of FEATURE_FIELDS) {
      expect(Number.isFinite(features[field])).toBe(true);
    }
  });

  it('reports the original dimensions, not the downscaled analysis plane', async () => {
    const features = await extractFeatures(await solid(1600, 1200, [90, 100, 110]));
    expect(features.width).toBe(1600);
    expect(features.height).toBe(1200);
  });

  it('measures a flat image as unsharp and clipped, noise as sharp', async () => {
    const flat = await extractFeatures(await solid(512, 512, [255, 255, 255]));
    expect(flat.sharpnessLaplacian).toBe(0);
    expect(flat.clippedHighlights).toBe(1);

    const grainy = await extractFeatures(await noise(512, 512));
    expect(grainy.sharpnessLaplacian).toBeGreaterThan(flat.sharpnessLaplacian);
  });

  it('records no face and floors framing when no detector is registered', async () => {
    const features = await extractFeatures(await noise(400, 400));
    expect(features.faceCount).toBe(0);
    expect(features.faceAreaRatio).toBe(0);
    expect(features.sharpnessEyeRegion).toBe(0);
    expect(scoreComputedAxes(features).framing).toBe(1);
  });

  it('measures eye-region sharpness only once a face locates the eyes', async () => {
    const image = await noise(2048, 2048);
    expect((await extractFeatures(image)).sharpnessEyeRegion).toBe(0);

    setDetector({ detect: async () => [observation()] });
    expect((await extractFeatures(image)).sharpnessEyeRegion).toBeGreaterThan(0);
  });

  it('reports framing as ratios of the frame, independent of resolution', async () => {
    setDetector({ detect: async () => [observation()] });
    const features = await extractFeatures(await noise(2048, 2048));
    // A 512px box on the 1024px analysis plane is a quarter of the frame,
    // centred, whatever the original image size was.
    expect(features.faceAreaRatio).toBeCloseTo(0.25);
    expect(features.faceCenterOffsetX).toBeCloseTo(0);
    expect(features.faceCenterOffsetY).toBeCloseTo(0);
    expect(features.faceCount).toBe(1);
  });

  it('carries head pose and landmark measurements through', async () => {
    setDetector({
      detect: async () => [observation({ yaw: 12.5, pitch: -4, roll: 2, eyeOpenness: 0.6 })],
    });
    const features = await extractFeatures(await noise(800, 800));
    expect(features.yaw).toBeCloseTo(12.5);
    expect(features.pitch).toBeCloseTo(-4);
    expect(features.eyeOpenness).toBeCloseTo(0.6);
  });

  it('counts every face, not just the one it measured', async () => {
    setDetector({
      detect: async () => [
        observation(),
        observation({ box: { x: 0, y: 0, width: 100, height: 100, confidence: 0.6 } }),
      ],
    });
    expect((await extractFeatures(await noise(1024, 1024))).faceCount).toBe(2);
  });

  it('measures the highest-confidence face when several are present', async () => {
    setDetector({
      detect: async () => [
        observation({ box: { x: 0, y: 0, width: 64, height: 64, confidence: 0.51 }, yaw: 40 }),
        observation({ yaw: 5 }),
      ],
    });
    expect((await extractFeatures(await noise(1024, 1024))).yaw).toBeCloseTo(5);
  });

  it('refuses to cache a NaN a detector produced', async () => {
    setDetector({ detect: async () => [observation({ yaw: Number.NaN })] });
    await expect(extractFeatures(await noise(512, 512))).rejects.toThrow();
  });

  it('clamps a detector that reports a box larger than the frame', async () => {
    setDetector({
      detect: async () => [
        observation({ box: { x: 0, y: 0, width: 99_999, height: 99_999, confidence: 0.9 } }),
      ],
    });
    const features = await extractFeatures(await noise(512, 512));
    expect(features.faceAreaRatio).toBe(1);
    expect(() => assertFeaturesUsable(features)).not.toThrow();
  });

  it('rejects a buffer that is not an image', async () => {
    await expect(extractFeatures(Buffer.from('not an image'))).rejects.toThrow();
  });
});
