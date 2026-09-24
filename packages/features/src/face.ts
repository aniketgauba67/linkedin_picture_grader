import type { LumaPlane, Region } from './luma.js';

/**
 * A face box in the coordinates of the plane it was detected on.
 *
 * This is local to @pps/features on purpose: `ComputedFeatures` in
 * @pps/schema records `faceAreaRatio` and the signed centre offsets, not a
 * box, because the box is an extraction detail that scoring never needs.
 */
export interface FaceBox extends Region {
  readonly confidence: number;
}

/**
 * What a detector reports per face. The pose and landmark numbers come
 * from MediaPipe's face mesh; they are measurements of head geometry, not
 * judgements about the person, and they feed `confidence` and the
 * `expression` distillation in training/ rather than any axis directly.
 */
export interface FaceObservation {
  readonly box: FaceBox;
  /** Where to measure eye sharpness. Derived from the box when absent. */
  readonly eyeRegion: Region | null;
  /** Head rotation in degrees. 0 is square to the lens. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** 0 closed, 1 fully open. */
  readonly eyeOpenness: number;
  /** 0 neutral, 1 broad. */
  readonly smileIntensity: number;
}

export interface Detector {
  detect(plane: LumaPlane): Promise<readonly FaceObservation[]>;
}

/**
 * The model file lives under models/, which is gitignored - it is fetched
 * at build time, never committed. Until one is wired up, `detectFaces`
 * returns an empty list, framing floors, and confidence drops. That is the
 * correct conservative answer rather than a fabricated box.
 */
let cached: Detector | null = null;

/** Registered by the app at startup once a model path is configured. */
export function setDetector(detector: Detector | null): void {
  cached = detector;
}

export function getDetector(): Detector | null {
  return cached;
}

export async function detectFaces(plane: LumaPlane): Promise<readonly FaceObservation[]> {
  const detector = cached;
  if (detector === null) {
    return [];
  }
  return detector.detect(plane);
}

/** The subject of the photo: the highest-confidence face, if any. */
export function primaryFace(faces: readonly FaceObservation[]): FaceObservation | null {
  let best: FaceObservation | null = null;
  for (const face of faces) {
    if (best === null || face.box.confidence > best.box.confidence) {
      best = face;
    }
  }
  return best;
}

/**
 * Falls back to the upper third of the face box when the detector did not
 * give an explicit eye region. Eyes sit roughly 40% down a face box, so
 * the band from 22% to 52% covers them across most poses.
 */
export function eyeRegionOf(face: FaceObservation): Region {
  if (face.eyeRegion !== null) {
    return face.eyeRegion;
  }
  return {
    x: face.box.x,
    y: face.box.y + face.box.height * 0.22,
    width: face.box.width,
    height: face.box.height * 0.3,
  };
}
