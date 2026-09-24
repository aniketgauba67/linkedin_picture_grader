import type { ComputedFeatures } from '@pps/schema';
import { ComputedFeatures as ComputedFeaturesSchema } from '@pps/schema';
import type { LumaPlane } from './luma.js';
import { cropPlane } from './luma.js';
import { laplacianVariance } from './sharpness.js';
import { lightingStats } from './lighting.js';
import { estimateJpegQuality } from './jpeg-quality.js';
import { framingMetrics } from './framing.js';
import { detectFaces, eyeRegionOf, primaryFace } from './face.js';
import { normalizedPipeline, prepareImage } from './normalize.js';
import { asDecodeError } from './errors.js';

/**
 * Every measurement is taken on a luma plane whose longest edge is
 * exactly this, upscaling included.
 *
 * Laplacian variance is strongly scale-dependent, so a 400px image
 * measured at native size would sit on a different variance scale than a
 * downsampled 4000px one and the shared thresholds in @pps/scoring would
 * silently mean different things for each. Upscaling a small image
 * interpolates it, which makes it genuinely soft - so its low variance is
 * the correct answer rather than an artifact of the pipeline.
 *
 * This constant is part of the FEATURE_VECTOR_VERSION contract. Changing
 * it invalidates every cached vector and every calibrated knot.
 */
export const ANALYSIS_EDGE = 1024;

/** A crop smaller than this cannot be convolved by a 3x3 kernel. */
const MIN_CONVOLVABLE_EDGE = 3;

/**
 * The normalised image as a luma plane at the analysis scale. Composes
 * onto the normalisation pipeline rather than re-decoding an encoded
 * intermediate, which is what keeps extraction inside its budget.
 */
export async function toLumaPlane(image: Buffer): Promise<LumaPlane> {
  try {
    const { data, info } = await normalizedPipeline(image)
      .resize({
        width: ANALYSIS_EDGE,
        height: ANALYSIS_EDGE,
        fit: 'inside',
        // Deliberately NOT withoutEnlargement: see ANALYSIS_EDGE.
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch (error) {
    throw asDecodeError(error, 'Could not rasterise image for analysis');
  }
}

/** Keeps a finite value inside a range. NaN is left alone so parsing rejects it. */
function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? value : Math.min(max, Math.max(min, value));
}

/**
 * Measures the eye band, or reports that it could not be measured.
 *
 * Returns null - never 0 - when there is nothing to measure. Zero is a
 * real result: a black or perfectly flat eye region has zero Laplacian
 * variance and that photo should score sharpness 1. If the two were the
 * same value, the full-frame fallback would rescue exactly the photo this
 * measurement exists to catch.
 */
function measureEyeRegion(plane: LumaPlane, face: ReturnType<typeof primaryFace>): number | null {
  if (face === null) {
    return null;
  }
  const eyes = cropPlane(plane, eyeRegionOf(face));
  if (eyes === null || eyes.width < MIN_CONVOLVABLE_EDGE || eyes.height < MIN_CONVOLVABLE_EDGE) {
    return null;
  }
  return laplacianVariance(eyes);
}

/**
 * Runs once per image and caches to Postgres. Scoring never calls this:
 * it reads the cached vector and does a dot product. Retraining must
 * never require re-running extraction, so nothing here may depend on the
 * scoring thresholds or the context weights.
 *
 * Budget: under 300ms for already-decoded input. A HEIC upload pays a
 * documented one-time decode cost of 1-3s on top, because heic-convert
 * carries a pure-JS HEVC decoder - see normalize.ts.
 *
 * The result is parsed with `ComputedFeatures` before it is returned.
 * This is the write side of the cache and it is where a NaN gets caught;
 * once a bad number is in Postgres it scores as something plausible
 * forever.
 */
export async function extractFeatures(image: Buffer): Promise<ComputedFeatures> {
  // One pass: converts HEIC if needed, reads what the upload is before
  // anything rewrites it, and hands back bytes sharp can decode.
  const { decodable, source } = await prepareImage(image);
  const { width, height } = source;

  const plane = await toLumaPlane(decodable);
  const lighting = lightingStats(plane);
  const faces = await detectFaces(plane);
  const face = primaryFace(faces);

  const sharpnessEyeRegion = measureEyeRegion(plane, face);
  const framing = framingMetrics(face?.box ?? null, plane.width, plane.height);

  return ComputedFeaturesSchema.parse({
    sharpnessLaplacian: laplacianVariance(plane),
    sharpnessEyeRegion:
      sharpnessEyeRegion === null ? null : clamp(sharpnessEyeRegion, 0, Number.MAX_SAFE_INTEGER),
    eyeRegionMeasured: sharpnessEyeRegion !== null,
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

    isGrayscale: source.isGrayscale,
    aspectExtreme: source.aspectExtreme,
    sourceFormat: source.sourceFormat,
  });
}
