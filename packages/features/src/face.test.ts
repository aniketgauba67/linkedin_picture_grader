import { describe, expect, it } from 'vitest';
import type { FaceObservation, Keypoints } from './face.js';
import {
  AMBIGUOUS_SUBJECT_RATIO,
  MIN_FACE_AREA_RATIO,
  MIN_FACE_CONFIDENCE,
  boxArea,
  eyeRegionOf,
  primaryFace,
  qualifyingFaces,
  rollFrom,
  secondLargestFaceRatio,
  yawFrom,
} from './face.js';

/**
 * Layer 1: selection, geometry and determinism, all from injected boxes.
 * No model, no image, no network - this is the bulk of the coverage and
 * it runs in milliseconds.
 */
const FRAME = 1024;

function face(
  x: number,
  y: number,
  size: number,
  confidence = 0.9,
  keypoints: Keypoints | null = null,
): FaceObservation {
  return { box: { x, y, width: size, height: size, confidence }, keypoints };
}

function points(overrides: Partial<Keypoints> = {}): Keypoints {
  return {
    leftEye: [400, 400],
    rightEye: [500, 400],
    nose: [450, 460],
    leftMouth: [410, 520],
    rightMouth: [490, 520],
    ...overrides,
  };
}

describe('qualifyingFaces', () => {
  it('drops low-confidence detections from selection', () => {
    const faces = [face(0, 0, 300, MIN_FACE_CONFIDENCE - 0.01), face(400, 400, 300, 0.9)];
    expect(qualifyingFaces(faces, FRAME, FRAME)).toHaveLength(1);
  });

  it('drops bystanders too small to be the subject', () => {
    // 1% of a 1024x1024 frame is a ~102px box; 60px is well under.
    const faces = [face(0, 0, 60), face(400, 400, 300)];
    const qualifying = qualifyingFaces(faces, FRAME, FRAME);
    expect(qualifying).toHaveLength(1);
    expect(qualifying[0]?.box.width).toBe(300);
  });

  it('puts the area boundary exactly where it is documented', () => {
    const edge = Math.sqrt(MIN_FACE_AREA_RATIO * FRAME * FRAME);
    expect(qualifyingFaces([face(0, 0, edge + 1)], FRAME, FRAME)).toHaveLength(1);
    expect(qualifyingFaces([face(0, 0, edge - 1)], FRAME, FRAME)).toHaveLength(0);
  });
});

describe('primaryFace', () => {
  it('picks the largest box, not the most confident one', () => {
    // The rule that makes framing deterministic. Confidence ordering is
    // not stable across runs; box area is.
    const small = face(0, 0, 200, 0.99);
    const large = face(400, 400, 500, 0.55);
    expect(primaryFace([small, large], FRAME, FRAME)?.box.width).toBe(500);
  });

  it('is deterministic across 20 runs with shuffled input', () => {
    const faces = [
      face(10, 10, 220, 0.97),
      face(300, 300, 480, 0.61),
      face(700, 50, 240, 0.88),
      face(120, 600, 300, 0.75),
    ];
    const picked = new Set<number>();
    for (let run = 0; run < 20; run += 1) {
      const shuffled = [...faces].sort(() => Math.random() - 0.5);
      picked.add(primaryFace(shuffled, FRAME, FRAME)?.box.width ?? -1);
    }
    expect([...picked]).toEqual([480]);
  });

  it('breaks a tie within 5% by distance to the centre', () => {
    // 200^2 / 204^2 = 0.96, inside the 5% tolerance, so the tie-break
    // decides - and it decides on geometry, which is reproducible.
    const centred = face(412, 412, 200);
    const cornered = face(0, 0, 204);
    expect(primaryFace([cornered, centred], FRAME, FRAME)?.box.x).toBe(412);
  });

  it('does not treat a clearly larger box as a tie', () => {
    const centred = face(412, 412, 200);
    const bigger = face(0, 0, 280); // ~96% larger by area
    expect(primaryFace([centred, bigger], FRAME, FRAME)?.box.x).toBe(0);
  });

  it('is deterministic on an exact tie', () => {
    const a = face(100, 100, 200);
    const b = face(700, 700, 200);
    const first = primaryFace([a, b], FRAME, FRAME);
    for (let run = 0; run < 20; run += 1) {
      expect(primaryFace([b, a], FRAME, FRAME)?.box.x).toBe(first?.box.x);
    }
  });

  it('returns null when nothing qualifies', () => {
    expect(primaryFace([], FRAME, FRAME)).toBeNull();
    expect(primaryFace([face(0, 0, 40)], FRAME, FRAME)).toBeNull();
    expect(primaryFace([face(0, 0, 400, 0.2)], FRAME, FRAME)).toBeNull();
  });

  it('ignores bystanders when choosing, even numerous ones', () => {
    const subject = face(400, 400, 300);
    const crowd = Array.from({ length: 8 }, (_, i) => face(i * 50, 0, 50, 0.95));
    expect(primaryFace([...crowd, subject], FRAME, FRAME)?.box.width).toBe(300);
  });
});

describe('secondLargestFaceRatio', () => {
  it('is null for a single subject', () => {
    expect(secondLargestFaceRatio([face(400, 400, 300)], FRAME, FRAME)).toBeNull();
  });

  it('is null when the only other face is a bystander', () => {
    expect(secondLargestFaceRatio([face(400, 400, 300), face(0, 0, 40)], FRAME, FRAME)).toBeNull();
  });

  it('reports the area ratio of the runner-up', () => {
    const ratio = secondLargestFaceRatio([face(0, 0, 400), face(500, 500, 200)], FRAME, FRAME);
    expect(ratio).toBeCloseTo(0.25); // (200^2) / (400^2)
  });

  it('crosses the ambiguity threshold when two subjects are comparable', () => {
    const ratio = secondLargestFaceRatio([face(0, 0, 400), face(500, 500, 360)], FRAME, FRAME);
    expect(ratio).toBeGreaterThan(AMBIGUOUS_SUBJECT_RATIO);
  });
});

describe('eyeRegionOf', () => {
  it('derives the band from the two eye points', () => {
    const region = eyeRegionOf(face(300, 300, 400, 0.9, points()));
    // Centred on the eye line, with a margin set by interocular distance.
    expect(region.y + region.height / 2).toBeCloseTo(400);
    expect(region.x).toBeLessThan(400);
    expect(region.x + region.width).toBeGreaterThan(500);
  });

  it('tracks the eyes through roll', () => {
    const tilted = points({ leftEye: [400, 380], rightEye: [500, 420] });
    const region = eyeRegionOf(face(300, 300, 400, 0.9, tilted));
    expect(region.y + region.height / 2).toBeCloseTo(400);
  });

  it('scales with the face, not with the frame', () => {
    const near = eyeRegionOf(face(0, 0, 400, 0.9, points()));
    const far = eyeRegionOf(
      face(0, 0, 200, 0.9, points({ leftEye: [400, 400], rightEye: [450, 400] })),
    );
    expect(far.width).toBeLessThan(near.width);
  });

  it('falls back to a fraction of the box when there are no landmarks', () => {
    const region = eyeRegionOf(face(100, 200, 400));
    expect(region.x).toBe(100);
    expect(region.width).toBe(400);
    expect(region.y).toBeCloseTo(200 + 400 * 0.22);
  });
});

describe('pose from keypoints', () => {
  it('reads level eyes as no roll', () => {
    expect(rollFrom(points())).toBeCloseTo(0, 5);
  });

  it('reads a tilted head as roll, with sign', () => {
    expect(rollFrom(points({ leftEye: [400, 380], rightEye: [500, 420] }))).toBeGreaterThan(15);
    expect(rollFrom(points({ leftEye: [400, 420], rightEye: [500, 380] }))).toBeLessThan(-15);
  });

  it('reads a centred nose as no yaw', () => {
    expect(yawFrom(points())).toBeCloseTo(0, 5);
  });

  it('reads a nose off the eye midpoint as yaw, with sign', () => {
    expect(yawFrom(points({ nose: [490, 460] }))).toBeGreaterThan(10);
    expect(yawFrom(points({ nose: [410, 460] }))).toBeLessThan(-10);
  });

  it('does not let roll leak into yaw', () => {
    // A head tilted but still facing the lens: the nose stays on the
    // perpendicular bisector of the eye line, so yaw stays near zero.
    const tilted = points({ leftEye: [400, 380], rightEye: [500, 420], nose: [430, 440] });
    expect(Math.abs(yawFrom(tilted))).toBeLessThan(12);
  });

  it('stays inside the documented bounds', () => {
    const extreme = points({ nose: [10_000, 460] });
    expect(yawFrom(extreme)).toBeLessThanOrEqual(90);
    expect(yawFrom(points({ nose: [-10_000, 460] }))).toBeGreaterThanOrEqual(-90);
  });
});

describe('boxArea', () => {
  it('never goes negative on a degenerate box', () => {
    expect(boxArea({ x: 0, y: 0, width: -5, height: 10 })).toBe(0);
  });
});
