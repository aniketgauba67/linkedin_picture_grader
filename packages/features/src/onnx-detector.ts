import type { Detector, FaceBox, FaceObservation } from './face.js';
import type { RgbPlane } from './luma.js';

export interface OnnxDetectorOptions {
  /** Path to the .onnx graph. Lives under models/, which is gitignored. */
  readonly modelPath: string;
  /** Square input edge the graph expects. */
  readonly inputSize?: number;
  readonly minConfidence?: number;
}

/**
 * An ONNX-backed face detector. The session is built on first use and held
 * for the life of the process: under Fluid Compute a function instance is
 * reused across requests, so paying the graph-load cost once is the
 * difference between ~800ms and several seconds per extraction.
 *
 * onnxruntime-node is imported dynamically so that merely importing
 * @pps/features does not load a native addon - the Next.js build and the
 * pure-arithmetic tests both need that to stay cheap.
 */
export function createOnnxDetector(options: OnnxDetectorOptions): Detector {
  const inputSize = options.inputSize ?? 320;
  const minConfidence = options.minConfidence ?? 0.5;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onnxruntime-node's InferenceSession type is only available once the optional native addon is loaded; narrowing happens at the call boundary below.
  let session: Promise<any> | null = null;

  async function getSession(): Promise<{
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
    inputNames: readonly string[];
    outputNames: readonly string[];
  }> {
    session ??= import('onnxruntime-node').then((ort) =>
      ort.InferenceSession.create(options.modelPath, { graphOptimizationLevel: 'all' }),
    );
    return session;
  }

  return {
    async detect(plane: RgbPlane): Promise<readonly FaceObservation[]> {
      const active = await getSession();
      const ort = await import('onnxruntime-node');

      const tensorData = new Float32Array(inputSize * inputSize);
      const xScale = plane.width / inputSize;
      const yScale = plane.height / inputSize;
      for (let y = 0; y < inputSize; y += 1) {
        const sourceY = Math.min(plane.height - 1, Math.floor(y * yScale));
        for (let x = 0; x < inputSize; x += 1) {
          const sourceX = Math.min(plane.width - 1, Math.floor(x * xScale));
          const value = plane.data[sourceY * plane.width + sourceX] ?? 0;
          tensorData[y * inputSize + x] = value / 255;
        }
      }

      const inputName = active.inputNames[0];
      if (inputName === undefined) {
        throw new Error(`ONNX graph at ${options.modelPath} declares no inputs`);
      }

      const outputs = await active.run({
        [inputName]: new ort.Tensor('float32', tensorData, [1, 1, inputSize, inputSize]),
      });

      // Pose and landmark numbers come from the MediaPipe face-mesh graph,
      // which is a separate model. Until that is wired up they read 0,
      // which costs confidence rather than inventing a head angle.
      return decodeBoxes(outputs, active.outputNames, plane, inputSize, minConfidence).map(
        // No landmarks from this graph, so no eye band and no pose. The
        // consumers treat null as "unmeasurable" rather than zero.
        (box): FaceObservation => ({ box, keypoints: null }),
      );
    },
  };
}

/**
 * Decodes a flat [x, y, w, h, confidence] detection list in the graph's
 * input coordinates back into pixel coordinates on the analysis plane.
 */
export function decodeBoxes(
  outputs: Record<string, { data: ArrayLike<number> }>,
  outputNames: readonly string[],
  plane: RgbPlane,
  inputSize: number,
  minConfidence: number,
): readonly FaceBox[] {
  const outputName = outputNames[0];
  const tensor = outputName === undefined ? undefined : outputs[outputName];
  if (tensor === undefined) {
    return [];
  }

  const stride = 5;
  const xScale = plane.width / inputSize;
  const yScale = plane.height / inputSize;
  const boxes: FaceBox[] = [];

  for (let offset = 0; offset + stride <= tensor.data.length; offset += stride) {
    const confidence = tensor.data[offset + 4] ?? 0;
    if (confidence < minConfidence) {
      continue;
    }
    const width = (tensor.data[offset + 2] ?? 0) * xScale;
    const height = (tensor.data[offset + 3] ?? 0) * yScale;
    if (width <= 0 || height <= 0) {
      continue;
    }
    boxes.push({
      x: Math.max(0, (tensor.data[offset] ?? 0) * xScale),
      y: Math.max(0, (tensor.data[offset + 1] ?? 0) * yScale),
      width,
      height,
      confidence: Math.min(1, Math.max(0, confidence)),
    });
  }

  return boxes;
}
