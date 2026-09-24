/**
 * The image could not be decoded. Thrown instead of letting a raw sharp
 * error escape, so the API layer can return a clean `corrupt_file`
 * decline rather than a 500 - a truncated upload is a normal thing for a
 * user to do, not a server fault.
 */
export class ImageDecodeError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ImageDecodeError';
    this.cause = cause;
  }
}

/** Wraps anything sharp throws, preserving the original for logging. */
export function asDecodeError(error: unknown, context: string): ImageDecodeError {
  if (error instanceof ImageDecodeError) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ImageDecodeError(`${context}: ${detail}`, error);
}
