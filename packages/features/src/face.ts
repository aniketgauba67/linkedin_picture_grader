import type { LumaPlane, Region, RgbPlane } from './luma.js';

/**
 * A face box in the coordinates of the plane it was detected on.
 *
 * Local to @pps/features on purpose: `ComputedFeatures` records
 * `faceAreaRatio` and the signed centre offsets, not a box, because the
 * box is an extraction detail that scoring never needs.
 */
export interface FaceBox extends Region {
  readonly confidence: number;
}

/** The five points SCRFD returns, in its order. */
export interface Keypoints {
  readonly leftEye: readonly [number, number];
  readonly rightEye: readonly [number, number];
  readonly nose: readonly [number, number];
  readonly leftMouth: readonly [number, number];
  readonly rightMouth: readonly [number, number];
}

export interface FaceObservation {
  readonly box: FaceBox;
  /** Null when the detector returned no landmarks. */
  readonly keypoints: Keypoints | null;
}

export interface Detector {
  detect(plane: RgbPlane): Promise<readonly FaceObservation[]>;
}

/** Detections below this are not considered as the subject. */
export const MIN_FACE_CONFIDENCE = 0.5;

/** Nor are detections smaller than this fraction of the frame. */
export const MIN_FACE_AREA_RATIO = 0.01;

/** Boxes within this much of each other in area count as tied. */
export const AREA_TIE_TOLERANCE = 0.05;

/**
 * Above this, the second face is close enough in size that the subject is
 * genuinely ambiguous and the UI should say so rather than pick one.
 */
export const AMBIGUOUS_SUBJECT_RATIO = 0.6;

let cached: Detector | null = null;

/** Registered once per process; see scrfd.ts for the real one. */
export function setDetector(detector: Detector | null): void {
  cached = detector;
}

export function getDetector(): Detector | null {
  return cached;
}

export async function detectFaces(plane: RgbPlane): Promise<readonly FaceObservation[]> {
  const detector = cached;
  if (detector === null) {
    return [];
  }
  return detector.detect(plane);
}

/**
 * Rejects a detection carrying a non-finite number.
 *
 * Without this a NaN box is silently dropped by the area filter, because
 * every comparison against NaN is false - so a broken detector would
 * report "no face found" on every photograph and look like a content
 * problem rather than a bug. Same doctrine as the feature vector: a
 * measurement is either real or absent, never quietly wrong.
 */
export function assertFacesUsable(faces: readonly FaceObservation[]): void {
  faces.forEach((face, i) => {
    const values: number[] = [
      face.box.x,
      face.box.y,
      face.box.width,
      face.box.height,
      face.box.confidence,
    ];
    if (face.keypoints !== null) {
      for (const point of Object.values(face.keypoints)) {
        values.push(point[0], point[1]);
      }
    }
    for (const value of values) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`Detector returned a non-finite value on face ${i}`);
      }
    }
  });
}

export function boxArea(box: Region): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/**
 * Detections big enough and confident enough to be the subject.
 *
 * Bystanders are excluded from SELECTION only. They still appear in
 * `faceCount`, which reports what is in the frame without editorialising
 * about it.
 */
export function qualifyingFaces(
  faces: readonly FaceObservation[],
  frameWidth: number,
  frameHeight: number,
): readonly FaceObservation[] {
  const frame = Math.max(1, frameWidth * frameHeight);
  return faces.filter(
    (face) =>
      face.box.confidence >= MIN_FACE_CONFIDENCE &&
      boxArea(face.box) / frame >= MIN_FACE_AREA_RATIO,
  );
}

function distanceToCentre(box: Region, width: number, height: number): number {
  const dx = box.x + box.width / 2 - width / 2;
  const dy = box.y + box.height / 2 - height / 2;
  return Math.hypot(dx, dy);
}

/**
 * The subject: LARGEST BOUNDING BOX WINS.
 *
 * Not highest confidence. Confidence ordering is not stable across runs
 * on the same image, which makes every framing measurement
 * non-deterministic - the bug this rule exists to prevent.
 *
 * Boxes whose areas are within 5% of the largest count as tied, and the
 * tie goes to the one nearest the centre of the frame. That is also
 * deterministic, and it matches what a person means by "the subject".
 */
export function primaryFace(
  faces: readonly FaceObservation[],
  frameWidth: number,
  frameHeight: number,
): FaceObservation | null {
  const qualifying = qualifyingFaces(faces, frameWidth, frameHeight);
  if (qualifying.length === 0) {
    return null;
  }

  const largest = Math.max(...qualifying.map((face) => boxArea(face.box)));
  const tied = qualifying.filter(
    (face) => boxArea(face.box) >= largest * (1 - AREA_TIE_TOLERANCE),
  );

  let best = tied[0] as FaceObservation;
  let bestDistance = distanceToCentre(best.box, frameWidth, frameHeight);
  for (const face of tied.slice(1)) {
    const distance = distanceToCentre(face.box, frameWidth, frameHeight);
    if (distance < bestDistance) {
      best = face;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Area of the second-largest qualifying face over the primary's, or null
 * when there is only one.
 */
export function secondLargestFaceRatio(
  faces: readonly FaceObservation[],
  frameWidth: number,
  frameHeight: number,
): number | null {
  const areas = qualifyingFaces(faces, frameWidth, frameHeight)
    .map((face) => boxArea(face.box))
    .sort((a, b) => b - a);
  const [first, second] = areas;
  if (first === undefined || second === undefined || first <= 0) {
    return null;
  }
  return Math.min(1, second / first);
}

/**
 * The eye band, straight from the two detected eye points.
 *
 * Derived from the landmarks rather than guessed from the box: the band
 * is centred on the eye line and given a margin proportional to the
 * inter-ocular distance, so it tracks the eyes through roll and scale.
 * Falls back to a fixed fraction of the box only when the detector gave
 * no landmarks at all.
 */
export function eyeRegionOf(face: FaceObservation): Region {
  const points = face.keypoints;
  if (points === null) {
    return {
      x: face.box.x,
      y: face.box.y + face.box.height * 0.22,
      width: face.box.width,
      height: face.box.height * 0.3,
    };
  }

  const [lx, ly] = points.leftEye;
  const [rx, ry] = points.rightEye;
  const interocular = Math.max(1, Math.hypot(rx - lx, ry - ly));
  const margin = interocular * 0.45;

  const left = Math.min(lx, rx) - margin;
  const right = Math.max(lx, rx) + margin;
  const centreY = (ly + ry) / 2;

  return {
    x: left,
    y: centreY - margin,
    width: right - left,
    height: margin * 2,
  };
}

/** Head tilt, from the angle of the eye-to-eye line. Degrees, + is clockwise. */
export function rollFrom(points: Keypoints): number {
  const [lx, ly] = points.leftEye;
  const [rx, ry] = points.rightEye;
  return (Math.atan2(ry - ly, rx - lx) * 180) / Math.PI;
}

/**
 * Head turn, estimated from how far the nose sits from the midpoint
 * between the eyes, as a fraction of the inter-ocular distance.
 *
 * An approximation, not a projection: it is monotone in true yaw and
 * good enough for the off-axis confidence penalty, which is all that
 * reads it. The 70-degree scale maps a full nose-past-the-eye offset to
 * roughly a profile view.
 */
export function yawFrom(points: Keypoints): number {
  const [lx, ly] = points.leftEye;
  const [rx, ry] = points.rightEye;
  const interocular = Math.max(1, Math.hypot(rx - lx, ry - ly));
  const midX = (lx + rx) / 2;
  const midY = (ly + ry) / 2;

  // Project the nose offset onto the eye line, so roll does not leak in.
  const ux = (rx - lx) / interocular;
  const uy = (ry - ly) / interocular;
  const offset = (points.nose[0] - midX) * ux + (points.nose[1] - midY) * uy;

  return Math.max(-90, Math.min(90, (offset / interocular) * 70));
}

export type { LumaPlane };
