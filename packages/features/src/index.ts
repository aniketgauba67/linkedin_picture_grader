/**
 * @pps/features - image feature extraction. Node only (sharp needs
 * libvips, onnxruntime-node needs a native addon), so this never runs in
 * a Supabase Edge Function.
 *
 * Extraction and scoring are separate on purpose: this package runs once
 * per image and writes a cached `ComputedFeatures` vector; @pps/scoring
 * runs on that cache.
 */
import type { ComputedFeatures } from '@pps/schema';
import { extractFeatures } from './extract.js';
import { getDetector, setDetector } from './face.js';
import { createScrfdDetector } from './scrfd.js';

export { ANALYSIS_EDGE, extractFeatures, toLumaPlane, toRgbPlane } from './extract.js';
export { ImageDecodeError, asDecodeError } from './errors.js';
export {
  EXTREME_ASPECT_RATIO,
  MAX_INPUT_PIXELS,
  describeSource,
  detectSourceFormat,
  isHeif,
  normalizeImage,
  normalizedPipeline,
  prepareImage,
  readExifOrientation,
} from './normalize.js';
export type { PreparedImage, SourceInfo } from './normalize.js';

export { laplacianVariance } from './sharpness.js';
export { lightingStats } from './lighting.js';
export type { LightingStats } from './lighting.js';
export { estimateJpegQuality } from './jpeg-quality.js';
export { framingMetrics } from './framing.js';
export type { FramingMetrics } from './framing.js';

export {
  AMBIGUOUS_SUBJECT_RATIO,
  AREA_TIE_TOLERANCE,
  MIN_FACE_AREA_RATIO,
  MIN_FACE_CONFIDENCE,
  assertFacesUsable,
  boxArea,
  detectFaces,
  eyeRegionOf,
  getDetector,
  primaryFace,
  qualifyingFaces,
  rollFrom,
  secondLargestFaceRatio,
  setDetector,
  yawFrom,
} from './face.js';
export type { Detector, FaceBox, FaceObservation, Keypoints } from './face.js';

export {
  DEFAULT_MODEL_PATH,
  SCRFD_INPUT,
  createScrfdDetector,
  decodeOutputs,
  nonMaximumSuppression,
  preprocess,
  resetScrfdSession,
} from './scrfd.js';
export type { ScrfdOptions } from './scrfd.js';

export { createOnnxDetector, decodeBoxes } from './onnx-detector.js';
export type { OnnxDetectorOptions } from './onnx-detector.js';

export { assertPlane, cropPlane, sampleAt } from './luma.js';
export type { LumaPlane, Region, RgbPlane } from './luma.js';

/**
 * The whole of extraction: normalise, measure, detect, merge.
 *
 * Registers the SCRFD detector on first use and leaves it registered, so
 * a warm Vercel instance pays the ~40ms graph load once rather than per
 * request. Pass a detector to `setDetector` beforehand to override it -
 * the tests inject boxes that way.
 */
export async function extractAll(image: Buffer): Promise<ComputedFeatures> {
  if (getDetector() === null) {
    setDetector(createScrfdDetector());
  }
  return extractFeatures(image);
}
