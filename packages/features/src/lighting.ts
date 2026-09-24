import type { LumaPlane } from './luma.js';
import { assertPlane } from './luma.js';

export interface LightingStats {
  readonly meanLuma: number;
  /** Usable span between the 1st and 99th luma percentiles, 0-255. */
  readonly dynamicRange: number;
  readonly clippedHighlightRatio: number;
  readonly clippedShadowRatio: number;
  readonly histogram: readonly number[];
}

/** A pixel at or above this is blown; at or below the other it is crushed. */
const HIGHLIGHT_CLIP = 250;
const SHADOW_CLIP = 5;

/** Percentiles, not min/max: one stuck pixel should not define the range. */
const LOW_PERCENTILE = 0.01;
const HIGH_PERCENTILE = 0.99;

export function lightingStats(plane: LumaPlane): LightingStats {
  assertPlane(plane);

  const histogram = new Array<number>(256).fill(0);
  let total = 0;

  for (const value of plane.data) {
    histogram[value] = (histogram[value] ?? 0) + 1;
    total += value;
  }

  const pixels = plane.data.length;
  const lowTarget = pixels * LOW_PERCENTILE;
  const highTarget = pixels * HIGH_PERCENTILE;

  let cumulative = 0;
  let low = 0;
  let high = 255;
  let lowFound = false;

  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value] ?? 0;
    if (!lowFound && cumulative >= lowTarget) {
      low = value;
      lowFound = true;
    }
    if (cumulative >= highTarget) {
      high = value;
      break;
    }
  }

  let clippedHighlights = 0;
  for (let value = HIGHLIGHT_CLIP; value < 256; value += 1) {
    clippedHighlights += histogram[value] ?? 0;
  }
  let clippedShadows = 0;
  for (let value = 0; value <= SHADOW_CLIP; value += 1) {
    clippedShadows += histogram[value] ?? 0;
  }

  return {
    meanLuma: total / pixels,
    dynamicRange: Math.max(0, high - low),
    clippedHighlightRatio: clippedHighlights / pixels,
    clippedShadowRatio: clippedShadows / pixels,
    histogram,
  };
}
