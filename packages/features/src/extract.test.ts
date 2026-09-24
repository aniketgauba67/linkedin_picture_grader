import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  ComputedFeatures,
  NUMERIC_FEATURE_FIELDS,
  assertFeaturesUsable,
} from '@pps/schema';
import { WEIGHTS_V1, computeComputedAxes, sharpnessBasis, sharpnessScore } from '@pps/scoring';
import type { ValidatedPixelFeatures } from '@pps/scoring';
import { ANALYSIS_EDGE, extractFeatures, toLumaPlane } from './extract.js';
import { ImageDecodeError } from './errors.js';
import type { FaceObservation } from './face.js';
import { setDetector } from './face.js';

afterEach(() => {
  setDetector(null);
});

function observation(overrides: Partial<FaceObservation> = {}): FaceObservation {
  return {
    box: { x: 256, y: 256, width: 512, height: 512, confidence: 0.95 },
    keypoints: null,
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

  it('upscales a small image so every input is measured at one scale', async () => {
    // Deliberate: measuring a 200px image at native size would put it on
    // a different Laplacian variance scale than a downsampled 4000px one,
    // and the shared thresholds would quietly mean two different things.
    const plane = await toLumaPlane(await solid(200, 200, [128, 128, 128]));
    expect(plane.width).toBe(1024);
    expect(plane.height).toBe(1024);
  });
});

describe('extractFeatures', () => {
  it('produces a vector that satisfies ComputedFeatures', async () => {
    const features = await extractFeatures(await noise(512, 512));
    expect(() => ComputedFeatures.parse(features)).not.toThrow();
    expect(() => assertFeaturesUsable(features)).not.toThrow();
  });

  it('emits a finite number for every measurement, or a documented null', async () => {
    // With no detector registered there is no face, so every
    // face-derived field is legitimately absent. Nothing else may be.
    const unmeasurable = new Set([
      'sharpnessEyeRegion',
      'pitch',
      'eyeOpenness',
      'smileIntensity',
      'primaryFaceConfidence',
      'secondLargestFaceRatio',
    ]);
    const features = await extractFeatures(await noise(400, 400));
    for (const field of NUMERIC_FEATURE_FIELDS) {
      const value = features[field];
      if (value === null) {
        expect(unmeasurable.has(field), `${field} may not be null`).toBe(true);
        continue;
      }
      expect(Number.isFinite(value), `${field} is not finite`).toBe(true);
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

  it('reports the eye region as unmeasurable, not zero, with no detector', async () => {
    const features = await extractFeatures(await noise(400, 400));
    expect(features.faceCount).toBe(0);
    expect(features.faceAreaRatio).toBe(0);
    expect(features.sharpnessEyeRegion).toBeNull();
    expect(features.eyeRegionMeasured).toBe(false);
    expect(features.primaryFaceConfidence).toBeNull();
    expect(computeComputedAxes(features as unknown as ValidatedPixelFeatures, WEIGHTS_V1).framing).toBe(1);
  });

  it('measures eye-region sharpness only once a face locates the eyes', async () => {
    const image = await noise(2048, 2048);
    expect((await extractFeatures(image)).sharpnessEyeRegion).toBeNull();

    setDetector({ detect: async () => [observation()] });
    const measured = await extractFeatures(image);
    expect(measured.eyeRegionMeasured).toBe(true);
    expect(measured.sharpnessEyeRegion).toBeGreaterThan(0);
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

  it('derives pose from keypoints and leaves the rest null', async () => {
    setDetector({
      detect: async () => [
        observation({
          keypoints: {
            leftEye: [400, 380],
            rightEye: [500, 420],
            nose: [450, 470],
            leftMouth: [410, 530],
            rightMouth: [490, 530],
          },
        }),
      ],
    });
    const features = await extractFeatures(await noise(800, 800));
    expect(features.roll).toBeGreaterThan(15); // eye line tilted down-right
    expect(features.pitch).toBeNull();
    expect(features.eyeOpenness).toBeNull();
    expect(features.smileIntensity).toBeNull();
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

  it('measures the LARGEST face when several are present, not the most confident', async () => {
    // Confidence ordering is not stable across runs; box area is. This
    // is the rule that keeps framing deterministic.
    setDetector({
      detect: async () => [
        observation({ box: { x: 0, y: 0, width: 200, height: 200, confidence: 0.99 } }),
        observation({ box: { x: 300, y: 300, width: 500, height: 500, confidence: 0.55 } }),
      ],
    });
    const features = await extractFeatures(await noise(1024, 1024));
    // 500/1024 squared of the frame, so the big low-confidence box won.
    expect(features.faceAreaRatio).toBeCloseTo((500 * 500) / (1024 * 1024), 2);
    expect(features.primaryFaceConfidence).toBeCloseTo(0.55);
  });

  it('rejects a NaN from the detector loudly, rather than dropping the face', async () => {
    setDetector({
      detect: async () => [
        observation({ box: { x: 0, y: 0, width: Number.NaN, height: 400, confidence: 0.9 } }),
      ],
    });
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

  it('rejects a buffer that is not an image with a typed decode error', async () => {
    await expect(extractFeatures(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });

  it('carries the upload shape flags through', async () => {
    const grey = await sharp(await noise(300, 300)).greyscale().png().toBuffer();
    const features = await extractFeatures(grey);
    expect(features.sourceFormat).toBe('png');
    expect(features.isGrayscale).toBe(true);
    expect(features.aspectExtreme).toBe(false);
  });

  it('flags a panorama rather than silently mis-scoring its framing', async () => {
    const features = await extractFeatures(await noise(1500, 300));
    expect(features.aspectExtreme).toBe(true);
  });

  it('handles a 1x1 image without throwing and returns finite values', async () => {
    const features = await extractFeatures(await solid(1, 1, [128, 128, 128]));
    expect(features.width).toBe(1);
    expect(features.height).toBe(1);
    expect(() => assertFeaturesUsable(features)).not.toThrow();
    expect(features.sharpnessLaplacian).toBe(0);
    expect(Number.isNaN(features.dynamicRange)).toBe(false);
  });

  it('measures every input at the same scale, upscaling small images', async () => {
    // Without upscaling, a 400px image would be measured at native size
    // and sit on a different variance scale than a downsampled 4000px
    // one, silently breaking the shared thresholds.
    const small = await toLumaPlane(await noise(400, 400));
    const large = await toLumaPlane(await noise(2400, 2400));
    expect(Math.max(small.width, small.height)).toBe(ANALYSIS_EDGE);
    expect(Math.max(large.width, large.height)).toBe(ANALYSIS_EDGE);
  });

  it('scores a sharp image above the same image blurred', async () => {
    const source = await noise(1200, 1200);
    const blurred = await sharp(source).blur(4).png().toBuffer();
    const sharpFeatures = await extractFeatures(source);
    const blurredFeatures = await extractFeatures(blurred);
    expect(blurredFeatures.sharpnessLaplacian).toBeLessThan(sharpFeatures.sharpnessLaplacian);
  });

  it('reports a fully white image as clipped', async () => {
    const features = await extractFeatures(await solid(256, 256, [255, 255, 255]));
    expect(features.clippedHighlights).toBeCloseTo(1, 2);
  });

  it('reports a mid-gray image as flat, with no NaN anywhere', async () => {
    const features = await extractFeatures(await solid(256, 256, [128, 128, 128]));
    expect(features.dynamicRange).toBe(0);
    expect(() => assertFeaturesUsable(features)).not.toThrow();
  });
});

describe('sharpness basis', () => {
  /**
   * The measured path has to be a first-class tested path before any
   * model ships, so these inject a face box straight into the detector
   * interface rather than waiting on ONNX.
   */
  async function withFace(image: Buffer, box: FaceObservation['box']) {
    setDetector({ detect: async () => [observation({ box })] });
    return extractFeatures(image);
  }

  it('a black eye region measures 0 and stays measured - it must not fall back', async () => {
    // A face whose eye band is solid black. Zero is the honest answer and
    // the photo should score sharpness 1; the full-frame fallback would
    // rescue it, which inverts the whole point of the eye-region measure.
    const W = 1024;
    const pixels = Buffer.alloc(W * W * 3);
    let seed = 11;
    for (let i = 0; i < pixels.length; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      pixels[i] = seed % 256;
    }
    // Black out the band eyeRegionOf will crop: 22%-52% down the box.
    const box = { x: 0, y: 0, width: W, height: W, confidence: 0.95 };
    const top = Math.floor(W * 0.22);
    const bottom = Math.ceil(W * 0.52);
    pixels.fill(0, top * W * 3, bottom * W * 3);

    const image = await sharp(pixels, { raw: { width: W, height: W, channels: 3 } })
      .png()
      .toBuffer();

    const features = await withFace(image, box);

    expect(features.eyeRegionMeasured).toBe(true);
    expect(features.sharpnessEyeRegion).toBe(0);
    expect(features.sharpnessEyeRegion).not.toBeNull();
    // The frame is full of noise and would score 5 on the fallback.
    expect(features.sharpnessLaplacian).toBeGreaterThan(700);
    expect(sharpnessBasis(features)).toBe('eyeRegion');
    expect(sharpnessScore(features, WEIGHTS_V1)).toBe(1);
  });

  it('falls back to the frame only when the eye band is genuinely unmeasurable', async () => {
    const features = await extractFeatures(await noise(900, 900));
    expect(features.eyeRegionMeasured).toBe(false);
    expect(features.sharpnessEyeRegion).toBeNull();
    expect(sharpnessBasis(features)).toBe('frame');
    expect(sharpnessScore(features, WEIGHTS_V1)).toBeGreaterThan(1);
  });

  it('reports unmeasurable when the eye band falls outside the frame', async () => {
    const image = await noise(800, 800);
    const features = await withFace(image, {
      x: 5000,
      y: 5000,
      width: 100,
      height: 100,
      confidence: 0.9,
    });
    expect(features.eyeRegionMeasured).toBe(false);
    expect(features.sharpnessEyeRegion).toBeNull();
  });

  it('reports unmeasurable when the crop is too small to convolve', async () => {
    const image = await noise(800, 800);
    // 2px wide: narrower than the 3x3 kernel, so there is nothing to
    // convolve even though the box does overlap the frame.
    const features = await withFace(image, { x: 10, y: 10, width: 2, height: 6, confidence: 0.9 });
    expect(features.eyeRegionMeasured).toBe(false);
    expect(features.sharpnessEyeRegion).toBeNull();
  });

  it('keeps the flag and the value in agreement, which the guard enforces', async () => {
    const features = await extractFeatures(await noise(600, 600));
    expect(() => assertFeaturesUsable(features)).not.toThrow();
    expect(() =>
      assertFeaturesUsable({ ...features, eyeRegionMeasured: true }),
    ).toThrow(/eyeRegionMeasured/);
  });
});
