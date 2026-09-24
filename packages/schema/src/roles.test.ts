import { describe, expect, it } from 'vitest';
import { ComputedFeatures } from './features.js';
import { FEATURE_ROLES, FEATURE_ROLE_FIELDS, featureGaps } from './roles.js';

/**
 * Makes "is anyone reading this field" a mechanical question.
 *
 * exposureMean was extracted, cached, versioned and shipped with no
 * consumer - a two-sided lighting term that was absent rather than
 * wrong. Nothing caught it because nothing asked.
 */
describe('every feature has a declared role', () => {
  it('covers exactly the fields ComputedFeatures declares', () => {
    // A new field with no role fails here, which is the point.
    expect([...FEATURE_ROLE_FIELDS].sort()).toEqual(Object.keys(ComputedFeatures.shape).sort());
  });

  it('gives every field a non-empty note', () => {
    for (const field of FEATURE_ROLE_FIELDS) {
      expect(FEATURE_ROLES[field].note.length, `${field} has no note`).toBeGreaterThan(20);
    }
  });

  it('names an axis or signal for every field classified as axis', () => {
    const axisWords = /sharpness|lighting|resolution|framing|confidence|score\(\)/;
    for (const field of FEATURE_ROLE_FIELDS) {
      if (FEATURE_ROLES[field].role !== 'axis') continue;
      expect(FEATURE_ROLES[field].note, `${field} does not say which axis reads it`).toMatch(
        axisWords,
      );
    }
  });

  it('keeps the known gaps visible rather than filed under diagnostic', () => {
    // These are the fields in exposureMean's old position: computed,
    // cached, read by nothing, with no decision taken. Named so they
    // cannot quietly become "diagnostic" and stop being a question.
    expect([...featureGaps()].sort()).toEqual([
      'aspectExtreme',
      'primaryFaceConfidence',
      'secondLargestFaceRatio',
    ]);
  });

  it('records what wiring each gap up would change', () => {
    for (const field of featureGaps()) {
      const note = FEATURE_ROLES[field as keyof typeof FEATURE_ROLES].note;
      expect(note.length, `${field} does not say what consuming it would change`).toBeGreaterThan(
        60,
      );
    }
  });
});
