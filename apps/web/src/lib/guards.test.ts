import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  belowDimensionFloor,
  MIN_SHORTER_EDGE,
  sniffMime,
  verifyBytes,
  verifyStoredMime,
} from './guards';

const FORMATS = [
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
] as const;

describe('image input guards', () => {
  it.each(FORMATS)('detects valid %s bytes as %s', async (format, mime) => {
    const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#808080' } })
      .toFormat(format).toBuffer();
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(sniffMime(bytes)).toBe(mime);
    expect(verifyBytes(bytes, digest, digest)).toBe(mime);
    expect(() => verifyStoredMime(mime, `${mime.toUpperCase()}; charset=binary`)).not.toThrow();
  });

  it('rejects an unknown signature and a declared/detected mismatch', async () => {
    expect(sniffMime(Buffer.from('GIF89a'))).toBeNull();
    expect(() => verifyStoredMime('image/png', 'image/jpeg')).toThrowError(
      expect.objectContaining({ code: 'mime_mismatch', status: 415 }),
    );
    expect(() => verifyStoredMime('image/jpeg', 'image/jpg')).toThrowError(
      expect.objectContaining({ code: 'mime_mismatch', status: 415 }),
    );
  });

  it('keeps the shorter-edge boundary at 200px', () => {
    expect(MIN_SHORTER_EDGE).toBe(200);
    expect(belowDimensionFloor(199, 300)).toBe(true);
    expect(belowDimensionFloor(200, 300)).toBe(false);
    expect(belowDimensionFloor(300, 200)).toBe(false);
  });
});
