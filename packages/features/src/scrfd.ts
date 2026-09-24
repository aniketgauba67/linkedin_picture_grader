import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Detector, FaceObservation, Keypoints } from './face.js';
import type { RgbPlane } from './luma.js';

/**
 * SCRFD-500m, 5 keypoints, via onnxruntime-node.
 *
 * Chosen over MediaPipe after a spike: tasks-vision is a browser bundle
 * whose WASM loader wants a real DOM, and shimming it ends at
 * "ModuleFactory not set" - the fake script tag never executes the
 * loader. SCRFD is Node-native, needs no shim, and gives exactly the five
 * points Tier 1 consumes: two eyes (the eye band), nose (yaw), and two
 * mouth corners.
 */

/** Square input the graph is fed. SCRFD is fully convolutional. */
export const SCRFD_INPUT = 640;

/** Feature-map strides, and anchors per cell, as the 500m graph emits them. */
const STRIDES = [8, 16, 32] as const;
const ANCHORS_PER_CELL = 2;

const MODEL_FILE = 'models/det_500m.onnx';

/**
 * Where the weights are, across the two layouts that matter.
 *
 * Locally the package resolves them relative to its own dist/. Inside a
 * traced serverless bundle that relative walk lands nowhere, because the
 * function root is the monorepo root rather than the package. Candidates
 * are tried in order and the first that exists wins, so neither layout
 * has to know about the other.
 *
 * Whichever wins, the file only exists in a deployed bundle because
 * `outputFileTracingIncludes` names it - Next's tracer cannot see
 * through a path computed at runtime.
 */
export function resolveModelPath(): string {
  const candidates = [
    fileURLToPath(new URL(`../../../${MODEL_FILE}`, import.meta.url)),
    join(process.cwd(), MODEL_FILE),
    join(process.cwd(), '..', '..', MODEL_FILE),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) {
    return found;
  }
  // Nothing exists yet. Return the package-relative path so the error
  // from loadSession names somewhere a human recognises.
  return candidates[0] ?? MODEL_FILE;
}

/** @deprecated Prefer `resolveModelPath()`, which handles the bundle layout. */
export const DEFAULT_MODEL_PATH = fileURLToPath(
  new URL(`../../../${MODEL_FILE}`, import.meta.url),
);

export interface ScrfdOptions {
  readonly modelPath?: string;
  /** Detections below this are dropped before they reach selection. */
  readonly minConfidence?: number;
  readonly iouThreshold?: number;
}

interface OrtLike {
  InferenceSession: {
    create(path: string, options?: unknown): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
}

/**
 * Module-scope cache: one session per process, not per request. A warm
 * Vercel instance loads the graph once (~40ms) and reuses it.
 */
let sessionPromise: Promise<{ ort: OrtLike; session: OrtSession }> | null = null;

/**
 * Loads onnxruntime-node at runtime, out of the bundler's reach.
 *
 * `webpackIgnore` is required, not decorative. onnxruntime-node's
 * binding.js builds a require context over every platform's
 * `onnxruntime_binding.node`, so a bundler that follows the import tries
 * to parse a native addon as JavaScript and the build dies with
 * "Module parse failed: Unexpected character". The package is listed in
 * serverExternalPackages precisely so it is required from node_modules
 * at runtime instead.
 */
async function loadOnnxRuntime(): Promise<OrtLike> {
  const mod = await import(/* webpackIgnore: true */ 'onnxruntime-node');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CommonJS interop: the namespace may or may not carry a default, and the shape actually used is narrowed by OrtLike.
  const resolved = ((mod as any).default ?? mod) as OrtLike;
  return resolved;
}

async function loadSession(modelPath: string) {
  if (!existsSync(modelPath)) {
    throw new Error(
      `SCRFD model missing at ${modelPath}. It is stored in Git LFS: run ` +
        '`git lfs install && git lfs pull`, then `pnpm verify:models`.',
    );
  }
  const ort = await loadOnnxRuntime();
  const session = await ort.InferenceSession.create(modelPath, {
    graphOptimizationLevel: 'all',
  });
  return { ort, session };
}

/** Drops the cached session. Tests use this; production never needs it. */
export function resetScrfdSession(): void {
  sessionPromise = null;
}

interface Candidate {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  points: number[][];
}

/**
 * Letterboxes the plane into the square input the graph expects, scaling
 * by the longest edge and padding the remainder. Normalisation is
 * InsightFace's: RGB, (x - 127.5) / 128.
 */
export function preprocess(plane: RgbPlane): { tensor: Float32Array; scale: number } {
  const scale = Math.min(SCRFD_INPUT / plane.width, SCRFD_INPUT / plane.height);
  const w = Math.max(1, Math.round(plane.width * scale));
  const h = Math.max(1, Math.round(plane.height * scale));

  const plane2 = SCRFD_INPUT * SCRFD_INPUT;
  const tensor = new Float32Array(3 * plane2);
  // Padding is zero in tensor space, which is (127.5 - 127.5) / 128 = 0.
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(plane.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(plane.width - 1, Math.floor(x / scale));
      const src = (sy * plane.width + sx) * 3;
      const dst = y * SCRFD_INPUT + x;
      tensor[dst] = ((plane.data[src] ?? 0) - 127.5) / 128;
      tensor[plane2 + dst] = ((plane.data[src + 1] ?? 0) - 127.5) / 128;
      tensor[2 * plane2 + dst] = ((plane.data[src + 2] ?? 0) - 127.5) / 128;
    }
  }
  return { tensor, scale };
}

/**
 * Turns the nine output tensors into boxes and keypoints.
 *
 * Outputs arrive as scores, then bounding boxes, then keypoints, each in
 * stride order. Predictions are distances from the anchor centre in
 * stride units, so every value is multiplied back up by its stride.
 */
export function decodeOutputs(
  outputs: Record<string, { data: ArrayLike<number> }>,
  outputNames: readonly string[],
  minConfidence: number,
): Candidate[] {
  const found: Candidate[] = [];

  STRIDES.forEach((stride, i) => {
    const scoreName = outputNames[i];
    const boxName = outputNames[i + STRIDES.length];
    const kpsName = outputNames[i + STRIDES.length * 2];
    if (scoreName === undefined || boxName === undefined || kpsName === undefined) return;

    const scores = outputs[scoreName]?.data;
    const boxes = outputs[boxName]?.data;
    const kps = outputs[kpsName]?.data;
    if (scores === undefined || boxes === undefined || kps === undefined) return;

    const cells = SCRFD_INPUT / stride;
    for (let i2 = 0; i2 < scores.length; i2 += 1) {
      const score = scores[i2] ?? 0;
      if (score < minConfidence) continue;

      const cell = Math.floor(i2 / ANCHORS_PER_CELL);
      const cx = (cell % cells) * stride;
      const cy = Math.floor(cell / cells) * stride;

      const b = i2 * 4;
      const x1 = cx - (boxes[b] ?? 0) * stride;
      const y1 = cy - (boxes[b + 1] ?? 0) * stride;
      const x2 = cx + (boxes[b + 2] ?? 0) * stride;
      const y2 = cy + (boxes[b + 3] ?? 0) * stride;
      if (x2 <= x1 || y2 <= y1) continue;

      const points: number[][] = [];
      for (let k = 0; k < 5; k += 1) {
        points.push([
          cx + (kps[i2 * 10 + k * 2] ?? 0) * stride,
          cy + (kps[i2 * 10 + k * 2 + 1] ?? 0) * stride,
        ]);
      }
      found.push({ x1, y1, x2, y2, score, points });
    }
  });

  return found;
}

/** Greedy non-maximum suppression, highest score first. */
export function nonMaximumSuppression(
  candidates: readonly Candidate[],
  iouThreshold: number,
): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const overlaps = kept.some((k) => {
      const w = Math.max(0, Math.min(c.x2, k.x2) - Math.max(c.x1, k.x1));
      const h = Math.max(0, Math.min(c.y2, k.y2) - Math.max(c.y1, k.y1));
      const inter = w * h;
      const union = (c.x2 - c.x1) * (c.y2 - c.y1) + (k.x2 - k.x1) * (k.y2 - k.y1) - inter;
      return union > 0 && inter / union > iouThreshold;
    });
    if (!overlaps) kept.push(c);
  }
  return kept;
}

function toObservation(c: Candidate, scale: number): FaceObservation {
  const at = (i: number): readonly [number, number] => {
    const p = c.points[i] ?? [0, 0];
    return [(p[0] ?? 0) / scale, (p[1] ?? 0) / scale];
  };
  const keypoints: Keypoints = {
    leftEye: at(0),
    rightEye: at(1),
    nose: at(2),
    leftMouth: at(3),
    rightMouth: at(4),
  };
  return {
    box: {
      x: c.x1 / scale,
      y: c.y1 / scale,
      width: (c.x2 - c.x1) / scale,
      height: (c.y2 - c.y1) / scale,
      confidence: Math.min(1, Math.max(0, c.score)),
    },
    keypoints,
  };
}

export function createScrfdDetector(options: ScrfdOptions = {}): Detector {
  const modelPath = options.modelPath ?? resolveModelPath();
  const minConfidence = options.minConfidence ?? 0.5;
  const iouThreshold = options.iouThreshold ?? 0.4;

  return {
    async detect(plane: RgbPlane): Promise<readonly FaceObservation[]> {
      sessionPromise ??= loadSession(modelPath);
      const { ort, session } = await sessionPromise;

      const inputName = session.inputNames[0];
      if (inputName === undefined) {
        throw new Error(`SCRFD graph at ${modelPath} declares no inputs`);
      }

      const { tensor, scale } = preprocess(plane);
      const outputs = await session.run({
        [inputName]: new ort.Tensor('float32', tensor, [1, 3, SCRFD_INPUT, SCRFD_INPUT]),
      });

      const candidates = decodeOutputs(outputs, session.outputNames, minConfidence);
      return nonMaximumSuppression(candidates, iouThreshold).map((c) => toObservation(c, scale));
    },
  };
}
