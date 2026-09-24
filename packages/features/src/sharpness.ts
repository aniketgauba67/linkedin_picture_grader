import type { LumaPlane } from './luma.js';
import { assertPlane, sampleAt } from './luma.js';

/**
 * Variance of the Laplacian - the standard no-reference focus measure.
 * A 4-neighbour discrete Laplacian is convolved over the luma plane and
 * the variance of the response is returned. High variance means lots of
 * high-frequency edge energy, which is what "in focus" looks like.
 *
 * The border ring is skipped rather than padded: padding invents edges and
 * inflates the variance of small images.
 */
export function laplacianVariance(plane: LumaPlane): number {
  assertPlane(plane);
  if (plane.width < 3 || plane.height < 3) {
    return 0;
  }

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < plane.height - 1; y += 1) {
    for (let x = 1; x < plane.width - 1; x += 1) {
      const response =
        4 * sampleAt(plane, x, y) -
        sampleAt(plane, x - 1, y) -
        sampleAt(plane, x + 1, y) -
        sampleAt(plane, x, y - 1) -
        sampleAt(plane, x, y + 1);
      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}
