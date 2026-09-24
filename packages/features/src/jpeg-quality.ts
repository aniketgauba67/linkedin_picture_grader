import type { LumaPlane } from './luma.js';
import { assertPlane, sampleAt } from './luma.js';

/** JPEG works on 8x8 blocks, so its artifacts land on an 8-pixel grid. */
const BLOCK = 8;

/**
 * Scales blockiness into the 0-100 range. Calibrated by re-encoding test
 * plates through libjpeg across its whole quality range: this puts a
 * lossless source and q95 near 100, q75 near 86, q50 near 66, and drives
 * q10 to 0.
 */
const BLOCKINESS_SCALE = 26;

/**
 * Estimates JPEG quality from block-boundary energy.
 *
 * A JPEG quantises each 8x8 block independently, so at low quality the
 * luma steps at every eighth column and row. Comparing the mean absolute
 * horizontal difference *on* that grid against the mean *off* it gives a
 * ratio that rises as quality falls. This matters because those step edges
 * register as high-frequency energy and inflate the sharpness measure -
 * a heavily compressed photo can read as sharper than it is.
 *
 * The number is an artifact-severity indicator on a 0-100 scale, not a
 * recovery of the encoder's quality setting - it cannot be, since the
 * original is gone. It is monotone in real JPEG quality, which is all the
 * sharpness penalty needs.
 *
 * Returns 100 for a flat image: there is no block structure to find, so
 * there is no evidence of compression. Never returns NaN - a NaN here
 * would reach the scorer and produce a plausible wrong answer.
 */
export function estimateJpegQuality(plane: LumaPlane): number {
  assertPlane(plane);
  if (plane.width < BLOCK * 2 || plane.height < BLOCK * 2) {
    return 100;
  }

  let boundarySum = 0;
  let boundaryCount = 0;
  let interiorSum = 0;
  let interiorCount = 0;

  for (let y = 0; y < plane.height; y += 1) {
    for (let x = 1; x < plane.width; x += 1) {
      const delta = Math.abs(sampleAt(plane, x, y) - sampleAt(plane, x - 1, y));
      if (x % BLOCK === 0) {
        boundarySum += delta;
        boundaryCount += 1;
      } else {
        interiorSum += delta;
        interiorCount += 1;
      }
    }
  }

  if (boundaryCount === 0 || interiorCount === 0) {
    return 100;
  }

  const interior = interiorSum / interiorCount;
  const boundary = boundarySum / boundaryCount;

  if (interior <= 0) {
    // No detail inside the blocks. Either the image is flat, which is an
    // absence of evidence rather than evidence of compression, or all the
    // variation sits exactly on the block grid, which is as compressed as
    // an image gets.
    return boundary <= 0 ? 100 : 0;
  }

  const blockiness = boundary / interior;
  const quality = 100 - Math.max(0, blockiness - 1) * BLOCKINESS_SCALE;
  return Math.min(100, Math.max(0, quality));
}
