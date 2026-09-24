/**
 * Where data lives, and the wall between the two sets.
 *
 * data/images/     - the Pexels corpus. Training and calibration FIT
 *                    against this. It may be re-pulled, re-sampled,
 *                    augmented and overfitted; none of that costs
 *                    anything you cannot get back with another pull.
 *
 * data/validation/ - 125 hand-labelled Wikimedia photographs. READ-ONLY
 *                    for measurement. Never fitted against, never tuned
 *                    on, never used to pick a hyperparameter, a knot, a
 *                    threshold or a weight.
 *
 * The distinction is not tidiness. A held-out set is only held out until
 * the first time someone looks at it and changes something - after that
 * it reports the number you tuned towards, and it reports it with total
 * confidence and no visible sign of the leak. There is no way to detect
 * this after the fact and no way to undo it: once a fit has seen these
 * 125 images, the only honest fix is 125 new hand-labelled images.
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

/** Modules allowed to read the validation set. Fitting is not on it. */
export const VALIDATION_READERS: readonly string[] = [
  'extract-validation.ts',
  'calibrate.ts',
  'paths.ts',
  'fit-isolation.test.ts',
];

export class ValidationLeakError extends Error {
  readonly path: string;

  constructor(path: string, context: string) {
    super(
      `${context} tried to read "${path}", which is inside ${VALIDATION_DIR}. ` +
        'The validation set is measured against, never fitted against. If a fit ' +
        'has already read it, the set is burned and no amount of re-running ' +
        'recovers it - it needs replacing with new hand-labelled images.',
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
