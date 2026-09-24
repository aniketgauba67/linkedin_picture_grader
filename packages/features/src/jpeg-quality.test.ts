import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { LumaPlane } from './luma.js';
import { estimateJpegQuality } from './jpeg-quality.js';

function build(width: number, height: number, fill: (x: number, y: number) => number): LumaPlane {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = fill(x, y);
    }
  }
  return { data, width, height };
}

function noise(width: number, height: number): LumaPlane {
  let seed = 7;
  return build(width, height, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 256;
  });
}

/** A photo-ish plate: smooth gradients, which is what JPEG blocks show on. */
const PLATE_EDGE = 384;

function plate() {
  const rgb = Buffer.alloc(PLATE_EDGE * PLATE_EDGE * 3);
  for (let y = 0; y < PLATE_EDGE; y += 1) {
    for (let x = 0; x < PLATE_EDGE; x += 1) {
      const value =
        110 + 60 * Math.sin(x / 40) * Math.cos(y / 55) + 30 * Math.sin((x + y) / 17);
      const clamped = Math.max(0, Math.min(255, Math.round(value)));
      const i = (y * PLATE_EDGE + x) * 3;
      rgb[i] = clamped;
      rgb[i + 1] = clamped;
      rgb[i + 2] = clamped;
    }
  }
  return sharp(rgb, { raw: { width: PLATE_EDGE, height: PLATE_EDGE, channels: 3 } });
}

async function planeOf(buffer: Buffer): Promise<LumaPlane> {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

async function qualityAt(jpegQuality: number): Promise<number> {
  return estimateJpegQuality(await planeOf(await plate().jpeg({ quality: jpegQuality }).toBuffer()));
}

describe('estimateJpegQuality on real JPEGs', () => {
  it('reads a lossless PNG as uncompressed', async () => {
    expect(estimateJpegQuality(await planeOf(await plate().png().toBuffer()))).toBeGreaterThan(95);
  });

  it('is monotone in the encoder quality it was given', async () => {
    const measured = await Promise.all([90, 75, 50, 20].map(qualityAt));
    expect(measured).toEqual([...measured].sort((a, b) => b - a));
  });

  it('leaves a high-quality JPEG unpenalised', async () => {
    expect(await qualityAt(90)).toBeGreaterThan(90);
  });

  it('drives a badly compressed JPEG toward the floor', async () => {
    expect(await qualityAt(10)).toBeLessThan(30);
  });

  it('stays inside 0-100 across the whole encoder range', async () => {
    for (const quality of [100, 80, 40, 5]) {
      const measured = await qualityAt(quality);
      expect(Number.isNaN(measured)).toBe(false);
      expect(measured).toBeGreaterThanOrEqual(0);
      expect(measured).toBeLessThanOrEqual(100);
    }
  });
});

describe('estimateJpegQuality edge cases', () => {
  it('reads a flat image as 100 - no block structure means no evidence', () => {
    expect(estimateJpegQuality(build(64, 64, () => 128))).toBe(100);
  });

  it('reads unstructured noise as uncompressed', () => {
    expect(estimateJpegQuality(noise(64, 64))).toBeGreaterThan(90);
  });

  it('floors an image whose variation sits entirely on the block grid', () => {
    const blocky = build(64, 64, (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) * 200);
    expect(estimateJpegQuality(blocky)).toBe(0);
  });

  it('returns 100 for a plane too small to have a block grid', () => {
    expect(estimateJpegQuality(build(8, 8, () => 40))).toBe(100);
  });

  it('never returns NaN, including on fully black and fully white planes', () => {
    for (const plane of [build(64, 64, () => 0), build(64, 64, () => 255)]) {
      expect(Number.isNaN(estimateJpegQuality(plane))).toBe(false);
    }
  });
});
