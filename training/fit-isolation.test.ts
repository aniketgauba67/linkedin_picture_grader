import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assertNotValidation,
  ValidationLeakError,
  VALIDATION_DIR,
  VALIDATION_READERS,
} from './paths.js';

/**
 * The wall around the legacy seed directory, enforced two ways.
 *
 * The 125 images are now explicitly development/calibration seed data,
 * not a final test. The future VLM-distillation fit.ts still must not
 * quietly read their computed-axis labels as its own training labels.
 *
 * So: a runtime guard for code that takes a path, and a static scan for
 * code that hardcodes one. Neither catches everything alone. A fit that
 * builds "data/" + userInput slips past the scan; a fit with the literal
 * string in it slips past a guard nobody called.
 */
describe('assertNotValidation', () => {
  it('throws on the validation directory and anything under it', () => {
    expect(() => assertNotValidation(VALIDATION_DIR)).toThrow(ValidationLeakError);
    expect(() => assertNotValidation(`${VALIDATION_DIR}/GOOD/G001.jpg`)).toThrow(ValidationLeakError);
    expect(() => assertNotValidation(`${VALIDATION_DIR}/features.json`)).toThrow(ValidationLeakError);
  });

  it('allows the corpus', () => {
    expect(() => assertNotValidation('data/images/abc.jpg')).not.toThrow();
    expect(() => assertNotValidation('data/manifest.csv')).not.toThrow();
    expect(() => assertNotValidation('data/features.jsonl')).not.toThrow();
  });

  it('is not fooled by a path that walks in sideways', () => {
    // Each of these resolves inside the validation set. A naive
    // startsWith check passes every one of them.
    for (const sneaky of [
      './data/validation/GOOD/G001.jpg',
      'data/images/../validation/GOOD/G001.jpg',
      'data//validation//features.json',
      'data/./validation/labels.csv',
      'data\\validation\\GOOD\\G001.jpg',
    ]) {
      expect(() => assertNotValidation(sneaky), sneaky).toThrow(ValidationLeakError);
    }
  });

  it('does not fire on a directory that merely starts with the same letters', () => {
    expect(() => assertNotValidation('data/validation-notes.md')).not.toThrow();
    expect(() => assertNotValidation('data/validationx/a.jpg')).not.toThrow();
  });

  it('names the file and the prohibited fitting boundary', () => {
    try {
      assertNotValidation(`${VALIDATION_DIR}/GOOD/G001.jpg`, 'fit.ts');
      throw new Error('expected a throw');
    } catch (error) {
      if (!(error instanceof ValidationLeakError)) throw error;
      expect(error.message).toContain('fit.ts');
      expect(error.message).toContain('G001.jpg');
      expect(error.message).toMatch(/prohibited for this fitting entry point/);
    }
  });
});

describe('no fitting module reads the validation set', () => {
  // Resolved from this file, NOT from cwd. `pnpm test` at the repo root
  // and `pnpm --filter @pps/training test` run with different working
  // directories, and a cwd-relative scan silently reads the wrong
  // directory in one of them - it finds no fitting modules and passes.
  // The vacuity check below is what caught that.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(here)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));

  it('finds the training sources, so this test cannot pass vacuously', () => {
    expect(sources.length).toBeGreaterThan(4);
    expect(sources.map((s) => s.name)).toContain('paths.ts');
  });

  it('lets only the allowlisted readers name the validation directory', () => {
    const offenders = sources
      .filter((source) => !VALIDATION_READERS.includes(source.name))
      // The path appears in paths.ts as a constant; everyone else must
      // import it, and importing it is not the same as reading it.
      .filter((source) => source.text.includes(VALIDATION_DIR))
      .map((source) => source.name);

    expect(
      offenders,
      `these modules name ${VALIDATION_DIR} without being in VALIDATION_READERS: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps fit.ts off the allowlist, whether or not it exists yet', () => {
    // fit.ts does not exist today. When it does, this is what stops it
    // being quietly added to VALIDATION_READERS because "just this once,
    // to check the numbers".
    expect(VALIDATION_READERS).not.toContain('fit.ts');
    expect(VALIDATION_READERS.some((name) => /fit/i.test(name) && name !== 'fit-isolation.test.ts')).toBe(
      false,
    );
  });

  it('fails if fit.ts ever reads the validation set', () => {
    const fit = sources.find((source) => source.name === 'fit.ts');
    if (fit === undefined) return; // Not written yet; the checks above hold the line.
    expect(fit.text).not.toContain(VALIDATION_DIR);
    expect(fit.text).not.toMatch(/validation/i);
  });
});
