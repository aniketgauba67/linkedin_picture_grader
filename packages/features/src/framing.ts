import type { Region } from './luma.js';

export interface FramingMetrics {
  /** Face box area over frame area, 0-1. */
  readonly faceAreaRatio: number;
  /**
   * Signed offset of the face centre from the frame centre, as a fraction
   * of the frame's width and height. Signed because direction matters:
   * slightly high is good composition, slightly low is not.
   */
  readonly faceCenterOffsetX: number;
  readonly faceCenterOffsetY: number;
}

export function framingMetrics(
  face: Region | null,
  width: number,
  height: number,
): FramingMetrics {
  if (width <= 0 || height <= 0) {
    throw new RangeError(`Frame must have positive dimensions, got ${width}x${height}`);
  }
  if (face === null) {
    return { faceAreaRatio: 0, faceCenterOffsetX: 0, faceCenterOffsetY: 0 };
  }

  const faceAreaRatio = Math.min(1, (face.width * face.height) / (width * height));

  return {
    faceAreaRatio,
    faceCenterOffsetX: (face.x + face.width / 2 - width / 2) / width,
    faceCenterOffsetY: (face.y + face.height / 2 - height / 2) / height,
  };
}
