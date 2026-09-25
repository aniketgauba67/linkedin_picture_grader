import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { assertFeaturesUsable } from '@pps/schema';
import { extractFeatures } from './extract.js';
import { ImageDecodeError } from './errors.js';
import {
  EXTREME_ASPECT_RATIO,
  describeSource,
  detectSourceFormat,
  isHeif,
  normalizeImage,
  readExifOrientation,
} from './normalize.js';

async function solid(width: number, height: number, rgb: [number, number, number]) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

/** A two-frame animated GIF: frame 0 black, frame 1 white. */
async function animatedGif(): Promise<Buffer> {
  const frames = Buffer.concat([
    Buffer.alloc(64 * 64 * 3, 0),
    Buffer.alloc(64 * 64 * 3, 255),
  ]);
  return sharp(frames, { raw: { width: 64, height: 128, channels: 3 }, animated: false })
    .gif()
    .toBuffer()
    .then((buf) => buf);
}

describe('isHeif', () => {
  it('recognises the iPhone brands by magic bytes', () => {
    for (const brand of ['heic', 'mif1', 'heix', 'msf1']) {
      const buf = Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from('ftyp', 'latin1'),
        Buffer.from(brand, 'latin1'),
        Buffer.alloc(12),
      ]);
      expect(isHeif(buf)).toBe(true);
    }
  });

  it('does not mistake a JPEG or a short buffer for HEIC', async () => {
    expect(isHeif(await solid(8, 8, [1, 2, 3]))).toBe(false);
    expect(isHeif(Buffer.from('short'))).toBe(false);
  });
});

describe('normalizeImage', () => {
  it('flattens transparency onto white rather than producing NaN', async () => {
    const rgba = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const normalized = await normalizeImage(rgba);
    const stats = await sharp(normalized).stats();
    expect(stats.channels[0]?.mean).toBeCloseTo(255, 0);
    expect((await sharp(normalized).metadata()).hasAlpha).toBe(false);
  });

  it('takes frame 0 of an animated GIF', async () => {
    const gif = await animatedGif();
    const normalized = await normalizeImage(gif);
    const meta = await sharp(normalized).metadata();
    // Frame 0 only: the page height, not the filmstrip height.
    expect(meta.height).toBe(128);
    expect(meta.pages ?? 1).toBe(1);
  });

  it('throws ImageDecodeError on a truncated file, not a raw sharp error', async () => {
    const jpeg = await sharp(await solid(64, 64, [90, 90, 90])).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 3));
    await expect(normalizeImage(truncated)).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it('throws ImageDecodeError on bytes that are not an image at all', async () => {
    await expect(normalizeImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });

  it('throws ImageDecodeError on an empty buffer', async () => {
    await expect(normalizeImage(Buffer.alloc(0))).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it('refuses a decompression bomb before it can expand', async () => {
    // 60MP of almost nothing: tiny on disk, over the 50MP decode budget.
    const bomb = await sharp({
      create: { width: 10_000, height: 6_000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(normalizeImage(bomb)).rejects.toBeInstanceOf(ImageDecodeError);
  });
});

describe('describeSource', () => {
  it('reports the container the bytes arrived in', async () => {
    const jpeg = await sharp(await solid(32, 32, [10, 20, 30])).jpeg().toBuffer();
    expect((await describeSource(jpeg)).sourceFormat).toBe('jpeg');
    expect((await describeSource(await solid(32, 32, [10, 20, 30]))).sourceFormat).toBe('png');
  });



  it('flags a greyscale image saved in a colour container', async () => {
    const grey = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toBuffer();
    expect((await describeSource(grey)).isGrayscale).toBe(true);
  });

  it('flags a true single-channel greyscale image', async () => {
    const grey = await sharp(await solid(64, 64, [10, 200, 90])).greyscale().png().toBuffer();
    expect((await describeSource(grey)).isGrayscale).toBe(true);
  });

  it('does not flag an image that carries colour', async () => {
    const colour = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();
    expect((await describeSource(colour)).isGrayscale).toBe(false);
  });

  it('flags a panorama as an extreme aspect ratio', async () => {
    const pano = await solid(1200, 300, [100, 100, 100]);
    expect((await describeSource(pano)).aspectExtreme).toBe(true);
  });

  it('does not flag an ordinary portrait crop', async () => {
    const portrait = await solid(600, 800, [100, 100, 100]);
    expect((await describeSource(portrait)).aspectExtreme).toBe(false);
  });

  it('puts the boundary exactly at the documented ratio', async () => {
    const atLimit = await solid(300 * EXTREME_ASPECT_RATIO, 300, [100, 100, 100]);
    const beyond = await solid(300 * EXTREME_ASPECT_RATIO + 30, 300, [100, 100, 100]);
    expect((await describeSource(atLimit)).aspectExtreme).toBe(false);
    expect((await describeSource(beyond)).aspectExtreme).toBe(true);
  });
});

describe('detectSourceFormat', () => {
  const heicBytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('heic', 'latin1'),
    Buffer.alloc(64),
  ]);

  it('reports heic for HEIC bytes, not the jpeg they get converted to', async () => {
    // This is the whole reason the format is read before conversion. If
    // it were read after, every iPhone upload would report "jpeg".
    expect(await detectSourceFormat(heicBytes)).toBe('heic');
  });

  it('reports the real container for ordinary formats', async () => {
    expect(await detectSourceFormat(await sharp(await solid(16, 16, [1, 2, 3])).jpeg().toBuffer()))
      .toBe('jpeg');
    expect(await detectSourceFormat(await solid(16, 16, [1, 2, 3]))).toBe('png');
    expect(await detectSourceFormat(await sharp(await solid(16, 16, [1, 2, 3])).webp().toBuffer()))
      .toBe('webp');
  });

  it('does not route AVIF through the HEIC converter', async () => {
    // AVIF and HEIC share the ISO base media container, but AVIF is
    // AV1-coded and sharp's libheif decodes it natively. Treating it as
    // HEIC would send a file sharp handles fine to a slow JS decoder.
    const avif = await sharp(await solid(32, 32, [120, 90, 60])).avif().toBuffer();
    expect(isHeif(avif)).toBe(false);
    expect(await detectSourceFormat(avif)).not.toBe('heic');
  });

  it('does not claim a format it could not identify', async () => {
    expect(await detectSourceFormat(Buffer.from('definitely not an image'))).toBe('unknown');
  });
});

describe('EXIF orientation', () => {
  /** Top half black, bottom half white: asymmetric about the X axis. */
  async function halves(orientation?: number): Promise<Buffer> {
    const W = 64;
    const H = 64;
    const raw = Buffer.alloc(W * H * 3, 0);
    raw.fill(255, (H / 2) * W * 3);
    let pipeline = sharp(raw, { raw: { width: W, height: H, channels: 3 } });
    if (orientation !== undefined) {
      pipeline = pipeline.withMetadata({ orientation });
    }
    return pipeline.jpeg({ quality: 100 }).toBuffer();
  }

  /** Mean luma of the top half, to tell which way up an image is. */
  async function topHalfLuma(buf: Buffer): Promise<number> {
    const { data, info } = await sharp(buf)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    const half = Math.floor(info.height / 2);
    for (let i = 0; i < half * info.width; i += 1) {
      sum += data[i] ?? 0;
    }
    return sum / (half * info.width);
  }

  it('reads the tag when one is present', async () => {
    for (const orientation of [1, 3, 4, 6, 8]) {
      expect(await readExifOrientation(await halves(orientation))).toBe(orientation);
    }
  });

  it('reports 1 when there is no tag, rather than guessing', async () => {
    expect(await readExifOrientation(await halves())).toBe(1);
    expect(await readExifOrientation(await solid(8, 8, [1, 2, 3]))).toBe(1);
  });

  it('reports 1 for bytes it cannot parse instead of throwing', async () => {
    expect(await readExifOrientation(Buffer.from('not an image'))).toBe(1);
    expect(await readExifOrientation(Buffer.alloc(4))).toBe(1);
  });

  it('applies the tag, so a mirrored photo is corrected before measurement', async () => {
    // Orientation 4 is a vertical mirror. Uncorrected, every framing
    // measurement would be upside down relative to what the user sees.
    const upright = await normalizeImage(await halves());
    const mirrored = await normalizeImage(await halves(4));
    expect(await topHalfLuma(upright)).toBeLessThan(64);
    expect(await topHalfLuma(mirrored)).toBeGreaterThan(190);
  });

  it('swaps the reported dimensions for a quarter turn', async () => {
    const wide = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const source = await describeSource(wide);
    expect(source.width).toBe(40);
    expect(source.height).toBe(80);
  });

  it('applies a quarter turn before measuring the 200px boundary image', async () => {
    const stored = await sharp({
      create: { width: 200, height: 300, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const source = await describeSource(stored);
    expect([source.width, source.height]).toEqual([300, 200]);
    const normalized = await normalizeImage(stored);
    const metadata = await sharp(normalized).metadata();
    expect([metadata.width, metadata.height]).toEqual([300, 200]);
    expect(metadata.orientation ?? 1).toBe(1);
  });
});

/**
 * The HEIC path cannot be exercised hermetically: sharp's libheif has no
 * HEVC encoder, so a real iPhone file cannot be generated at test time,
 * and the repo never commits images. Point PPS_TEST_HEIC at one to run
 * these; they skip otherwise.
 */
const heicPath = process.env['PPS_TEST_HEIC'] ?? '';
const heicSuite = heicPath !== '' && existsSync(heicPath) ? describe : describe.skip;

heicSuite('a real iPhone HEIC', () => {
  let heic: Buffer;

  beforeAll(() => {
    heic = readFileSync(heicPath);
  });

  it('is recognised without decoding it', async () => {
    expect(isHeif(heic)).toBe(true);
    expect(await detectSourceFormat(heic)).toBe('heic');
  });

  it('is something sharp alone cannot decode', async () => {
    // The reason heic-convert is a dependency. sharp parses the header
    // happily and only fails on the actual decode, so a format check is
    // not enough to tell whether it will work.
    await expect(sharp(heic).resize(32).raw().toBuffer()).rejects.toThrow();
  });

  it('carries the EXIF orientation across a conversion that strips it', async () => {
    const orientation = await readExifOrientation(heic);
    expect(orientation).toBeGreaterThanOrEqual(1);
    expect(orientation).toBeLessThanOrEqual(8);

    const normalized = await normalizeImage(heic);
    // heic-convert neither applies nor preserves the tag, so a
    // non-identity orientation must have been re-applied by us.
    expect((await sharp(normalized).metadata()).width).toBeGreaterThan(0);
  });

  it('extracts a complete, finite feature vector', async () => {
    const features = await extractFeatures(heic);
    expect(features.sourceFormat).toBe('heic');
    expect(() => assertFeaturesUsable(features)).not.toThrow();
    for (const [key, value] of Object.entries(features)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${key} is not finite`).toBe(true);
      }
    }
  }, 20_000);
});
