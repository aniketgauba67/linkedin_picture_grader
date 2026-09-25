/**
 * The checks every upload passes before it costs anything.
 *
 * Ordered by what they protect. Rate limits come first because they are
 * the only thing standing between a scripted client and the bill; MIME
 * sniffing and the dimension floor come before the VLM call because that
 * call is the expensive step and a landscape photograph of a building
 * should never reach it.
 */

import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  MIN_IMAGE_SHORT_EDGE_PX,
  belowDimensionFloor,
  type MimeType,
} from '@pps/schema';

export { MIN_IMAGE_SHORT_EDGE_PX as MIN_SHORTER_EDGE, belowDimensionFloor };

/**
 * Magic bytes, not the declared Content-Type.
 *
 * The client tells us what it is uploading and the client can be wrong
 * or lying. Storage enforces its own allowed_mime_types on the declared
 * value, which stops an honest mistake and not a deliberate one, so the
 * bytes get checked here against what they actually are.
 */
export function sniffMime(bytes: Uint8Array): MimeType | null {
  const at = (i: number): number => bytes[i] ?? -1;

  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => at(i) === byte)) return 'image/png';

  // WebP: "RIFF" ???? "WEBP". The size field between them is not fixed,
  // so a naive prefix match on "RIFF" alone would also accept a WAV.
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (riff.every((byte, i) => at(i) === byte) && webp.every((byte, i) => at(8 + i) === byte)) {
    return 'image/webp';
  }

  return null;
}

export class UploadRejected extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'UploadRejected';
    this.code = code;
    this.status = status;
  }
}

/**
 * Checks the bytes are what they claim to be, and are worth measuring.
 *
 * `claimedSha256` is verified rather than trusted: the hash decides
 * which cached feature vector a photograph gets, so a client that sends
 * someone else's hash would be handed someone else's measurements. It is
 * the one field where being wrong is worse than being absent.
 */
export function verifyBytes(
  bytes: Uint8Array,
  claimedSha256: string,
  actualSha256: string,
): MimeType {
  if (bytes.length === 0) {
    throw new UploadRejected('empty', 'The uploaded file is empty.');
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      'too_large',
      `Images must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`,
      413,
    );
  }
  if (actualSha256 !== claimedSha256) {
    throw new UploadRejected(
      'hash_mismatch',
      'The uploaded bytes do not match the hash that was registered for them.',
      409,
    );
  }

  const sniffed = sniffMime(bytes);
  if (sniffed === null) {
    throw new UploadRejected(
      'not_an_image',
      `That file is not a ${ACCEPTED_MIME_TYPES.join(', ')} image.`,
      415,
    );
  }
  return sniffed;
}

/** Compare Storage's declared type with the byte signature, not the path. */
export function verifyStoredMime(detected: MimeType, declared: string | null | undefined): void {
  if (declared === null || declared === undefined || declared.trim() === '') return;
  // Storage may add parameters or change case; the upload schema accepts
  // only the three canonical MIME names, so no new aliases are introduced.
  const canonical = declared.split(';', 1)[0]?.trim().toLowerCase();
  if (canonical !== detected) {
    throw new UploadRejected(
      'mime_mismatch',
      'The uploaded file type does not match its declared image type.',
      415,
    );
  }
}
