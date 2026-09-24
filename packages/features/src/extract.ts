import type { ComputedFeatures } from '@pps/schema';
import { ComputedFeatures as ComputedFeaturesSchema, EXTRACTOR_VERSION } from '@pps/schema';
import type { LumaPlane, Region, RgbPlane } from './luma.js';
import { cropPlane } from './luma.js';
import { laplacianVariance } from './sharpness.js';
import { lightingStats } from './lighting.js';
import { estimateJpegQuality } from './jpeg-quality.js';
import { framingMetrics } from './framing.js';
import {
  assertFacesUsable,
  detectFaces,
  eyeRegionOf,
  primaryFace,
  rollFrom,
  secondLargestFaceRatio,
  yawFrom,
} from './face.js';
import type { FaceObservation } from './face.js';
import type sharp from 'sharp';
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

/** The analysis-scale resize, shared by both planes so they agree exactly. */
function toAnalysisScale(image: Buffer): sharp.Sharp {
  return normalizedPipeline(image).resize({
    width: ANALYSIS_EDGE,
    height: ANALYSIS_EDGE,
    fit: 'inside',
    // Deliberately NOT withoutEnlargement: see ANALYSIS_EDGE.
  });
}

/**
 * The normalised image as a luma plane at the analysis scale. Composes
 * onto the normalisation pipeline rather than re-decoding an encoded
 * intermediate, which is what keeps extraction inside its budget.
 */
export async function toLumaPlane(image: Buffer): Promise<LumaPlane> {
  try {
    const { data, info } = await toAnalysisScale(image)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch (error) {
    throw asDecodeError(error, 'Could not rasterise image for analysis');
  }
}

/**
 * The same image as colour, at the same dimensions.
 *
 * The detector needs colour - face models lose accuracy on greyscale -
 * but it must see exactly the frame the measurements were taken on, or
 * every box it returns would need rescaling and the two would drift.
 */
export async function toRgbPlane(image: Buffer): Promise<RgbPlane> {
  try {
    const { data, info } = await toAnalysisScale(image)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch (error) {
    throw asDecodeError(error, 'Could not rasterise image for detection');
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
function measureEyeRegion(plane: LumaPlane, face: FaceObservation | null): number | null {
  if (face === null) {
    return null;
  }
  const eyes = cropPlane(plane, eyeRegionOf(face));
  if (eyes === null || eyes.width < MIN_CONVOLVABLE_EDGE || eyes.height < MIN_CONVOLVABLE_EDGE) {
    return null;
  }
  return laplacianVariance(eyes);
}

/** The face box is where the subject is; this is where we guess it is
 *  when no face was found. Central third, which is where a portrait's
 *  subject sits far more often than not. */
export function centralThird(width: number, height: number): Region {
  return {
    x: width / 3,
    y: height / 3,
    width: width / 3,
    height: height / 3,
  };
}

export interface FaceLighting {
  readonly faceExposureMean: number;
  readonly faceClippedHighlights: number;
  readonly faceClippedShadows: number;
  readonly faceRegionMeasured: boolean;
}

/**
 * Lighting measured on the SUBJECT rather than the frame.
 *
 * The same statistics as the whole-frame pass, over a crop. A backlit
 * portrait is the case that matters: a bright window fills the frame
 * histogram with a healthy span and a good mean, while the face itself
 * is a silhouette. Measuring the frame says the lighting is fine.
 *
 * Falls back to the central third when there is no face box, and says
 * which happened - a guess about where a face probably is should not be
 * indistinguishable from a measurement.
 */
export function faceLighting(plane: LumaPlane, face: FaceObservation | null): FaceLighting {
  const measured = face !== null;
  const region = measured ? face.box : centralThird(plane.width, plane.height);
  const crop = cropPlane(plane, region);

  // A crop can come back null or degenerate for a box that fell outside
  // the frame. Falling back to the whole plane keeps the field finite
  // and honest rather than emitting a zero that reads as "pitch black".
  const target = crop === null || crop.width === 0 || crop.height === 0 ? plane : crop;
  const stats = lightingStats(target);

  return {
    faceExposureMean: clamp(stats.meanLuma, 0, 255),
    faceClippedHighlights: clamp(stats.clippedHighlightRatio, 0, 1),
    faceClippedShadows: clamp(stats.clippedShadowRatio, 0, 1),
    faceRegionMeasured: measured && crop !== null,
  };
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

  // One decode, two planes at identical dimensions: luma for the pixel
  // measures, RGB for the detector. A box from the detector is therefore
  // usable by framing.ts and eyeRegionOf with no rescaling at all.
  const [plane, rgb] = await Promise.all([toLumaPlane(decodable), toRgbPlane(decodable)]);

  const lighting = lightingStats(plane);
  const faces = await detectFaces(rgb);
  assertFacesUsable(faces);
  const face = primaryFace(faces, plane.width, plane.height);
  const faceExposure = faceLighting(plane, face);
  const points = face?.keypoints ?? null;

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
    ...faceExposure,
    // Signed, and clamped to the representable range rather than to
    // zero: the sign is the whole signal.
    exposureDelta: clamp(lighting.meanLuma - faceExposure.faceExposureMean, -255, 255),

    width,
    height,

    faceAreaRatio: clamp(framing.faceAreaRatio, 0, 1),
    faceCenterOffsetX: clamp(framing.faceCenterOffsetX, -1, 1),
    faceCenterOffsetY: clamp(framing.faceCenterOffsetY, -1, 1),
    faceCount: faces.length,

    // Measured from the five keypoints.
    yaw: points === null ? 0 : clamp(yawFrom(points), -180, 180),
    roll: points === null ? 0 : clamp(rollFrom(points), -180, 180),

    // Null, not 0: five points cannot recover pitch, and a mesh model is
    // what will provide these. A fabricated zero would read as a
    // measurement and silently neuter the off-axis confidence penalty.
    pitch: null,
    eyeOpenness: null,
    smileIntensity: null,

    primaryFaceConfidence: face === null ? null : clamp(face.box.confidence, 0, 1),
    secondLargestFaceRatio: secondLargestFaceRatio(faces, plane.width, plane.height),

    extractorVersion: EXTRACTOR_VERSION,
    isGrayscale: source.isGrayscale,
    aspectExtreme: source.aspectExtreme,
    sourceFormat: source.sourceFormat,
  });
}
