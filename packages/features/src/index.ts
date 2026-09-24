/**
 * @pps/features - image feature extraction. Node only (sharp needs
 * libvips, onnxruntime-node needs a native addon), so this never runs in a
 * Supabase Edge Function.
 *
 * Extraction and scoring are separate on purpose: this package runs once
 * per image and writes a cached `ComputedFeatures` vector; @pps/scoring
 * runs on that cache.
 */
export { ANALYSIS_EDGE, extractFeatures, toLumaPlane } from './extract.js';
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
export { detectFaces, eyeRegionOf, getDetector, primaryFace, setDetector } from './face.js';
export type { Detector, FaceBox, FaceObservation } from './face.js';
export { createOnnxDetector, decodeBoxes } from './onnx-detector.js';
export type { OnnxDetectorOptions } from './onnx-detector.js';
export { assertPlane, cropPlane, sampleAt } from './luma.js';
export type { LumaPlane, Region } from './luma.js';
