/**
 * Where data lives, and the wall between the two sets.
 *
 * data/images/     - the Pexels corpus. Training and calibration FIT
 *                    against this. It may be re-pulled, re-sampled,
 *                    augmented and overfitted; none of that costs
 *                    anything you cannot get back with another pull.
 *
 * data/validation/ - legacy directory name for 125 hand-labelled
 *                    Wikimedia images. These are DEVELOPMENT/CALIBRATION
 *                    seed data, not an untouched final test set. The
 *                    offline dataset importer reads them without changing
 *                    their bytes, labels or feature vectors.
 *
 * A future final_test must consist of newly sourced, pre-assigned images.
 * The guard below remains for the future VLM-distillation fit.ts: it
 * must not quietly import this legacy computed-axis seed set as VLM
 * training labels. Computed-axis calibrate.ts is intentionally a reader.
 *
 * So the rule is mechanical rather than remembered. assertNotValidation
 * throws at runtime, and fit-isolation.test.ts fails the build if a
 * fitting module so much as names this directory.
 */

export const CORPUS_DIR = 'data/images';
export const CORPUS_MANIFEST = 'data/manifest.csv';
export const CORPUS_FEATURES = 'data/features.jsonl';

export const VALIDATION_DIR = 'data/validation';
export const VALIDATION_FEATURES = 'data/validation/features.json';
export const VALIDATION_SOURCES = 'data/validation/sources.csv';

/** Explicit readers of the legacy seed directory; fit.ts stays excluded. */
export const VALIDATION_READERS: readonly string[] = [
  'extract-validation.ts',
  'calibrate.ts',
  'calibrate.test.ts',
  'dataset.ts',
  'dataset.test.ts',
  'paths.ts',
  'fit-isolation.test.ts',
];

export class ValidationLeakError extends Error {
  readonly path: string;

  constructor(path: string, context: string) {
    super(
      `${context} tried to read "${path}", which is inside ${VALIDATION_DIR}. ` +
        'This legacy development seed is prohibited for this fitting entry point. ' +
        'Use explicit, provenance-checked labels for the intended axis instead.',
    );
    this.name = 'ValidationLeakError';
    this.path = path;
  }
}

/**
 * Throw if `path` points inside the validation set.
 *
 * Call this at the top of anything that fits. Normalises separators and
 * resolves `..` first, so a path assembled from parts cannot walk in
 * sideways.
 */
export function assertNotValidation(path: string, context = 'This code'): void {
  const normalised = path.replace(/\\/g, '/');
  const segments: string[] = [];
  for (const part of normalised.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const resolved = segments.join('/');
  if (resolved === VALIDATION_DIR || resolved.startsWith(`${VALIDATION_DIR}/`)) {
    throw new ValidationLeakError(path, context);
  }
}
