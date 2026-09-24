import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { ImageDecodeError, asDecodeError } from './errors.js';

/**
 * Ceiling on decoded pixels. A 200KB PNG can expand to gigabytes, and a
 * file-size check does not catch it - the expansion happens during
 * decode, after the size test has already passed. sharp's own default is
 * ~268MP, which is far too generous for profile photos.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Longer edge more than this multiple of the shorter is a panorama. */
export const EXTREME_ASPECT_RATIO = 3;

/**
 * Mean per-pixel chroma below this counts as no usable colour. Small but
 * non-zero: JPEG chroma subsampling leaves a little colour noise in an
 * image that was greyscale before encoding.
 */
const GRAYSCALE_CHROMA_TOLERANCE = 2;

/** Downsample used for the colour test only. Cheap, and plenty for it. */
const CHROMA_PROBE_EDGE = 64;

/** EXIF orientations 5-8 are quarter turns, which swap width and height. */
const QUARTER_TURN_ORIENTATIONS = new Set([5, 6, 7, 8]);

/**
 * Reads the EXIF orientation tag, returning 1 when there is not one.
 *
 * This exists because heic-convert throws EXIF away. A real iPhone HEIC
 * carries its orientation there - an iPhone 13 photo tested against
 * Apple's own decoder came out vertically mirrored once the tag was
 * lost - and `.rotate()` has nothing to act on unless the tag is carried
 * across the conversion by hand.
 */
export async function readExifOrientation(buf: Buffer): Promise<number> {
  let exif: Buffer | undefined;
  try {
    exif = (await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).exif;
  } catch {
    return 1;
  }
  if (exif === undefined || exif.length < 12) {
    return 1;
  }

  // The blob may start with the "Exif\0\0" header, or straight at the
  // TIFF header. Find whichever byte order marker is present.
  let base = exif.indexOf(Buffer.from('II\x2a\x00', 'latin1'));
  if (base < 0) {
    base = exif.indexOf(Buffer.from('MM\x00\x2a', 'latin1'));
  }
  if (base < 0) {
    return 1;
  }

  const little = exif.toString('latin1', base, base + 2) === 'II';
  const u16 = (at: number): number => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const u32 = (at: number): number => (little ? exif.readUInt32LE(at) : exif.readUInt32BE(at));

  try {
    const ifd0 = base + u32(base + 4);
    const entries = u16(ifd0);
    for (let i = 0; i < entries; i += 1) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch {
    // A malformed EXIF block is not a reason to reject the image.
    return 1;
  }
  return 1;
}

export interface SourceInfo {
  /** Container the bytes arrived in, before any conversion. */
  readonly sourceFormat: string;
  readonly isGrayscale: boolean;
  readonly aspectExtreme: boolean;
  /** Dimensions of the original with EXIF rotation applied. */
  readonly width: number;
  readonly height: number;
}

/**
 * iPhone HEIC brands. Checked at bytes 4-12: an ISO base-media file
 * starts with a 4-byte box length, then "ftyp", then the brand.
 */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

export function isHeif(buf: Buffer): boolean {
  if (buf.length < 12) {
    return false;
  }
  if (buf.toString('latin1', 4, 8) !== 'ftyp') {
    return false;
  }
  return HEIF_BRANDS.includes(buf.toString('latin1', 8, 12));
}

/**
 * Converts HEIC/HEIF to JPEG.
 *
 * sharp reports `heif` input support, which makes it look like this is
 * unnecessary - but its bundled libheif has no HEVC codec, and an iPhone
 * HEIC is HEVC-coded. (AVIF is AV1-coded, which the same libheif does
 * handle, so AVIF works through sharp and HEIC does not.) Vercel's build
 * image does not add the codec either.
 *
 * Do not remove this in favour of sharp without decoding a real iPhone
 * file first. heic-convert carries a pure-JS decoder, which is why it
 * costs 1-3s on a 12MP image - the documented price of the fallback.
 * Most uploads never reach it: the browser converts with heic2any first
 * and this runs only when that fails.
 */
async function heifToJpeg(buf: Buffer): Promise<Buffer> {
  const orientation = await readExifOrientation(buf);

  let converted: Buffer;
  try {
    const output = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 });
    converted = Buffer.from(output);
  } catch (error) {
    throw asDecodeError(error, 'Could not decode HEIC image');
  }

  if (orientation === 1) {
    return converted;
  }

  // heic-convert drops EXIF and does not bake the orientation into the
  // pixels, so the tag is re-attached here and sharp's own `.rotate()`
  // applies it downstream. Delegating to sharp rather than composing
  // flip/flop/rotate by hand is deliberate: all eight orientations are
  // easy to get subtly wrong, and only one of them is testable against
  // the single reference photo available.
  try {
    return await sharp(converted, { limitInputPixels: MAX_INPUT_PIXELS })
      .withMetadata({ orientation })
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (error) {
    throw asDecodeError(error, 'Could not re-tag converted HEIC orientation');
  }
}

/**
 * The container the bytes arrived in, determined without decoding them.
 *
 * Separate from `prepareImage` on purpose: the format has to be captured
 * BEFORE any conversion, or every iPhone upload reports "jpeg" - the
 * format heic-convert produced - rather than what the user actually sent.
 * Magic bytes win over sharp's opinion for exactly that reason.
 */
export async function detectSourceFormat(buf: Buffer): Promise<string> {
  if (isHeif(buf)) {
    return 'heic';
  }
  try {
    const metadata = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return metadata.format ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface PreparedImage {
  /** Bytes sharp can decode: the original, or the JPEG heic-convert made. */
  readonly decodable: Buffer;
  readonly source: SourceInfo;
}

/**
 * The normalisation pipeline, as a sharp instance rather than an encoded
 * buffer.
 *
 * Returning a pipeline instead of bytes is what keeps extraction inside
 * its budget. Encoding a normalised 12MP PNG and decoding it again costs
 * ~600ms on its own - more than twice the entire budget - and buys
 * nothing, because the only consumer immediately downsamples it to a
 * 1024px luma plane. `normalizeImage` still exists for callers that want
 * the bytes; the measurement path composes onto this directly.
 */
export function normalizedPipeline(decodable: Buffer): sharp.Sharp {
  return sharp(decodable, {
    limitInputPixels: MAX_INPUT_PIXELS,
    // Frame 0 only. An animated GIF or WebP is scored as the still it
    // would show, not as a filmstrip of every frame side by side.
    animated: false,
  })
    .rotate() // EXIF orientation, before anything reads a dimension
    // Transparent regions make the background axis meaningless and skew
    // the luma histogram, so they become white.
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb') // CMYK and other spaces break the exposure math
    .removeAlpha();
}

/**
 * Decodes what needs decoding and reads what the upload *is*, once.
 *
 * Both flags describe the original: `sourceFormat` would read "jpeg" for
 * every iPhone photo if it were taken after conversion, and `isGrayscale`
 * would be true for everything if it were taken after extraction's own
 * greyscale pass. The HEIC conversion happens here so nothing downstream
 * pays for it twice.
 */
export async function prepareImage(buf: Buffer): Promise<PreparedImage> {
  if (buf.length === 0) {
    throw new ImageDecodeError('Image is empty');
  }

  // Captured first, from the original bytes, before any conversion.
  const sourceFormat = await detectSourceFormat(buf);
  const decodable = isHeif(buf) ? await heifToJpeg(buf) : buf;

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(decodable, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    throw asDecodeError(error, 'Could not read image metadata');
  }

  // EXIF orientations 5-8 rotate by a quarter turn, which swaps the
  // reported dimensions. `.rotate()` applies that downstream, so the
  // dimensions have to be swapped here to match what gets measured.
  const quarterTurned = QUARTER_TURN_ORIENTATIONS.has(metadata.orientation ?? 1);
  const width = (quarterTurned ? metadata.height : metadata.width) ?? 0;
  const height = (quarterTurned ? metadata.width : metadata.height) ?? 0;
  if (width <= 0 || height <= 0) {
    throw new ImageDecodeError('Image reported no usable dimensions');
  }

  const longer = Math.max(width, height);
  const shorter = Math.min(width, height);

  return {
    decodable,
    source: {
      sourceFormat,
      isGrayscale: await detectGrayscale(decodable, metadata),
      aspectExtreme: longer > shorter * EXTREME_ASPECT_RATIO,
      width,
      height,
    },
  };
}

/** Reads what the upload is, without holding on to the decoded bytes. */
export async function describeSource(buf: Buffer): Promise<SourceInfo> {
  return (await prepareImage(buf)).source;
}

/**
 * True when the image carries no usable colour.
 *
 * The colourspace is checked first because it is free, but it is not
 * sufficient: a greyscale photograph saved as 3-channel sRGB reports
 * `srgb` and still has nothing for a colour-variance measure to work
 * with. So a 64px probe measures mean per-pixel chroma as well - small
 * enough that sharp shrinks on load rather than decoding in full.
 */
async function detectGrayscale(buf: Buffer, metadata: sharp.Metadata): Promise<boolean> {
  if (metadata.space === 'b-w' || (metadata.channels ?? 3) < 3) {
    return true;
  }

  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .resize({ width: CHROMA_PROBE_EDGE, height: CHROMA_PROBE_EDGE, fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .toColorspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels < 3 || data.length === 0) {
      return true;
    }

    let chroma = 0;
    let pixels = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      pixels += 1;
    }
    return pixels === 0 || chroma / pixels <= GRAYSCALE_CHROMA_TOLERANCE;
  } catch {
    // The probe is an optimisation, not a gate. If it fails, assume the
    // image has colour and let the real decode report the problem.
    return false;
  }
}

/**
 * Puts an upload into the one shape every measurement assumes: 8-bit
 * sRGB, no alpha, no animation, decoded within a sane pixel budget, EXIF
 * rotation already applied.
 *
 * Returns PNG rather than JPEG so normalisation itself contributes no
 * compression artifacts to `jpegQualityEstimate`. Note that extraction
 * does NOT go through this - it composes onto `normalizedPipeline`
 * directly to avoid an encode it would only throw away.
 */
export async function normalizeImage(buf: Buffer): Promise<Buffer> {
  const { decodable } = await prepareImage(buf);
  try {
    return await normalizedPipeline(decodable).png().toBuffer();
  } catch (error) {
    throw asDecodeError(error, 'Could not decode image');
  }
}
