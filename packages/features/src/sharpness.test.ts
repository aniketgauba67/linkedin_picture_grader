import { describe, expect, it } from 'vitest';
import type { LumaPlane } from './luma.js';
import { laplacianVariance } from './sharpness.js';

function plane(width: number, height: number, fill: (x: number, y: number) => number): LumaPlane {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = fill(x, y);
    }
  }
  return { data, width, height };
}

describe('laplacianVariance', () => {
  it('is zero on a flat field - no edges, no focus energy', () => {
    expect(laplacianVariance(plane(32, 32, () => 128))).toBe(0);
  });

  it('is zero on a linear gradient, which a Laplacian cancels', () => {
    expect(laplacianVariance(plane(32, 32, (x) => Math.min(255, x * 4)))).toBeCloseTo(0, 6);
  });

  it('is large on a hard checkerboard', () => {
    const checker = plane(32, 32, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    expect(laplacianVariance(checker)).toBeGreaterThan(10_000);
  });

  it('ranks a sharp edge above a blurred one', () => {
    const sharp = plane(64, 64, (x) => (x < 32 ? 40 : 215));
    const blurred = plane(64, 64, (x) => {
      const t = Math.min(1, Math.max(0, (x - 24) / 16));
      return Math.round(40 + t * 175);
    });
    expect(laplacianVariance(sharp)).toBeGreaterThan(laplacianVariance(blurred));
  });

  it('returns 0 rather than throwing on a plane too small to convolve', () => {
    expect(laplacianVariance(plane(2, 2, () => 100))).toBe(0);
  });

  it('rejects a plane whose data length disagrees with its dimensions', () => {
    expect(() => laplacianVariance({ data: new Uint8Array(3), width: 4, height: 4 })).toThrow(
      RangeError,
    );
  });
});
