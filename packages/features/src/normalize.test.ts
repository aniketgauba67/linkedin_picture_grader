import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ImageDecodeError } from './errors.js';
import {
  EXTREME_ASPECT_RATIO,
  describeSource,
  detectSourceFormat,
  isHeif,
  normalizeImage,
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
