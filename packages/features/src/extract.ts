import sharp from 'sharp';
import type { ComputedFeatures } from '@pps/schema';
import { ComputedFeatures as ComputedFeaturesSchema } from '@pps/schema';
import type { LumaPlane } from './luma.js';
import { cropPlane } from './luma.js';
import { laplacianVariance } from './sharpness.js';
import { lightingStats } from './lighting.js';
import { estimateJpegQuality } from './jpeg-quality.js';
import { framingMetrics } from './framing.js';
import { detectFaces, eyeRegionOf, primaryFace } from './face.js';

/**
 * Measurements are taken on a downscaled luma plane. The absolute
 * Laplacian variance depends on this size, so the thresholds in
 * @pps/scoring are calibrated against it - changing it invalidates every
 * cached vector and needs a FEATURE_VECTOR_VERSION bump.
 */
export const ANALYSIS_EDGE = 1024;

export async function toLumaPlane(image: Buffer | Uint8Array): Promise<LumaPlane> {
  const { data, info } = await sharp(image)
    .rotate() // honour EXIF orientation before measuring anything
    .resize({ width: ANALYSIS_EDGE, height: ANALYSIS_EDGE, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Keeps a finite value inside a range. NaN is left alone so parsing rejects it. */
function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? value : Math.min(max, Math.max(min, value));
}

/**
 * Runs once per image (~800ms) and caches to Postgres. Scoring never calls
 * this: it reads the cached vector and does a dot product. Retraining must
 * never require re-running extraction, so nothing here may depend on the
 * scoring thresholds or the context weights.
 *
 * The result is parsed with `ComputedFeatures` before it is returned. This
 * is the write side of the cache and it is where a NaN gets caught - once
 * a bad number is in Postgres it will score as something plausible
 * forever.
 */
export async function extractFeatures(image: Buffer | Uint8Array): Promise<ComputedFeatures> {
  const metadata = await sharp(image).rotate().metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error('Could not read image dimensions');
  }

  const plane = await toLumaPlane(image);
  const lighting = lightingStats(plane);
  const faces = await detectFaces(plane);
  const face = primaryFace(faces);

  // Eye sharpness is the measurement that matters for a headshot, but it
  // only exists when there is a face to locate the eyes in.
  let sharpnessEyeRegion = 0;
  if (face !== null) {
    const eyes = cropPlane(plane, eyeRegionOf(face));
    if (eyes !== null) {
      sharpnessEyeRegion = laplacianVariance(eyes);
    }
  }

  const framing = framingMetrics(face?.box ?? null, plane.width, plane.height);

  return ComputedFeaturesSchema.parse({
    sharpnessLaplacian: laplacianVariance(plane),
    sharpnessEyeRegion,
    jpegQualityEstimate: estimateJpegQuality(plane),

    exposureMean: clamp(lighting.meanLuma, 0, 255),
    clippedHighlights: clamp(lighting.clippedHighlightRatio, 0, 1),
    clippedShadows: clamp(lighting.clippedShadowRatio, 0, 1),
    dynamicRange: clamp(lighting.dynamicRange, 0, 255),

    width,
    height,

    faceAreaRatio: clamp(framing.faceAreaRatio, 0, 1),
    faceCenterOffsetX: clamp(framing.faceCenterOffsetX, -1, 1),
    faceCenterOffsetY: clamp(framing.faceCenterOffsetY, -1, 1),
    faceCount: faces.length,

    yaw: clamp(face?.yaw ?? 0, -180, 180),
    pitch: clamp(face?.pitch ?? 0, -180, 180),
    roll: clamp(face?.roll ?? 0, -180, 180),
    eyeOpenness: clamp(face?.eyeOpenness ?? 0, 0, 1),
    smileIntensity: clamp(face?.smileIntensity ?? 0, 0, 1),
  });
}
