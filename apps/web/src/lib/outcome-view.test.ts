import { describe, expect, it } from 'vitest';
import type { AnalysisOutcome, FullScoreResult, PartialReview } from '@pps/schema';
import { AnalysisOutcome as AnalysisOutcomeSchema, DeclineReason } from '@pps/schema';
import { AXES } from '@pps/scoring';
import { LOW_CONFIDENCE, declineCopy, toView } from './outcome-view.js';

const result: FullScoreResult = {
  score: 6.8,
  axes: {
    sharpness: 4,
    lighting: 3,
    resolution: 5,
    framing: 2,
    background: 4,
    attire: 3,
    expression: 4,
    solo: 5,
  },
  context: 'corporate',
  fixes: [{ axis: 'framing', severity: 'high', message: 'Move closer.' }],
  confidence: 0.95,
  weightsVersion: '2026-09-24.1',
  coverage: 'full',
};

const scored: AnalysisOutcome = { status: 'scored', result };

describe('toView on a scored outcome', () => {
  it('leads with the composite and names the context', () => {
    const view = toView(scored);
    expect(view.kind).toBe('scored');
    expect(view.headline).toBe('6.8 / 10');
    expect(view.detail).toContain('corporate');
  });

  it('lists every axis, weakest first', () => {
    const view = toView(scored);
    expect(view.rows).toHaveLength(AXES.length);
    expect(view.rows[0]?.axis).toBe('framing');
    expect(view.rows.map((row) => row.score)).toEqual(
      [...view.rows.map((row) => row.score)].sort((a, b) => a - b),
    );
  });

  it('passes the fixes through untouched', () => {
    expect(toView(scored).fixes).toEqual(result.fixes);
  });

  it('adds no caveat when the scorer was confident', () => {
    expect(toView(scored).caveat).toBeNull();
  });

  it('adds a caveat when it was not', () => {
    const uncertain: AnalysisOutcome = {
      status: 'scored',
      result: { ...result, confidence: LOW_CONFIDENCE - 0.01 },
    };
    expect(toView(uncertain).caveat).toContain('approximate');
  });
});

/** A decline retains measured evidence without exposing an overall number. */
const review: PartialReview = {
  context: 'corporate',
  fixes: result.fixes,
  confidence: 0.55,
  weightsVersion: result.weightsVersion,
  coverage: 'partial',
  axes: { sharpness: 5, lighting: 5, resolution: 5, framing: 1 },
};

describe('toView on a declined outcome', () => {
  it('shows measured axes without an overall profile-photo score', () => {
    const view = toView({
      status: 'declined',
      reason: 'no_face',
      message: 'No face was found in this image.',
      review,
    });
    expect(view.kind).toBe('declined');
    expect(view.score).toBeNull();
    expect(view.headline).toBe('Overall score unavailable');
    expect(view.rows.length).toBeGreaterThan(0);
  });

  it('names multiple faces as the reason to use a different photo', () => {
    const view = toView({
      status: 'declined', reason: 'multiple_faces',
      message: 'Multiple faces were detected in this photo. Choose a photo with one clearly visible person.',
      review,
    });
    expect(view.reason).toBe('multiple_faces');
    expect(view.score).toBeNull();
    expect(view.detail).toMatch(/Choose a photo with one clearly visible person/);
    expect(view.rows.map((row) => row.axis)).not.toContain('solo');
  });

  it('falls back to "Not scored" only when nothing was measured', () => {
    const view = toView({
      status: 'declined',
      reason: 'corrupt_file',
      message: 'Could not decode.',
    });
    expect(view.headline).toBe('Not scored');
    expect(view.rows).toEqual([]);
    expect(view.fixes).toEqual([]);
  });

  it('never renders a decline as a zero', () => {
    for (const view of [
      toView({ status: 'declined', reason: 'no_face', message: 'x', review }),
      toView({ status: 'declined', reason: 'corrupt_file', message: 'x' }),
    ]) {
      expect(view.headline).not.toBe('0.0 / 10');
      expect(view.kind).toBe('declined');
    }
  });

  it('shows only genuinely measured axes', () => {
    const view = toView({
      status: 'declined',
      reason: 'no_face',
      message: 'No face was found.',
      review,
    });
    expect(view.rows.find((row) => row.axis === 'framing')?.score).toBe(1);
    expect(view.rows.map((row) => row.axis)).not.toContain('background');
  });

  it('prefers the server message over the local fallback', () => {
    const view = toView({
      status: 'declined',
      reason: 'not_a_photo',
      message: 'This is a company logo.',
      review,
    });
    expect(view.detail).toBe('This is a company logo.');
  });

  it.each(DeclineReason.options)('has copy for %s', (reason) => {
    expect(declineCopy(reason).length).toBeGreaterThan(0);
    const view = toView(
      AnalysisOutcomeSchema.parse({
        status: 'declined',
        reason,
        message: ' ',
        // corrupt_file is the one reason that has no measured review.
        ...(reason === 'corrupt_file' ? {} : { review }),
      }),
    );
    expect(view.detail).toBe(declineCopy(reason));
  });

  it('says nothing about the person when declining a minor', () => {
    const banned = /child|kid|young|age|teen|minor looking|looks like/i;
    expect(declineCopy('apparent_minor')).not.toMatch(banned);
  });

  it('never offers a retake for apparent_minor - it is not a photo problem', () => {
    expect(declineCopy('apparent_minor')).not.toMatch(/retake|try again|upload another/i);
  });
});

describe('exhaustiveness', () => {
  it('handles every branch of the union without a default case', () => {
    const outcomes: AnalysisOutcome[] = [
      scored,
      { status: 'partial', review },
      { status: 'declined', reason: 'corrupt_file', message: 'Could not decode.' },
    ];
    expect(outcomes.map((outcome) => toView(outcome).kind)).toEqual(['scored', 'partial', 'declined']);
  });
});

/**
 * v8: the judge saying "no face" over a face the detector measured must
 * never reach the user as "No face found in this photo."
 *
 * The Edge scorer returns a score-free partial review with measured axes.
 */
describe('detector-vs-judge disagreement is not reported as a missing face', () => {
  const partial: AnalysisOutcome = {
    status: 'partial',
    review: {
      ...review,
      coverage: 'partial',
      axes: { sharpness: 4, lighting: 3, resolution: 5, framing: 2 },
      confidence: 0.8,
    },
  };

  it('renders as a partial review without an overall score', () => {
    const view = toView(partial);
    expect(view.kind).toBe('partial');
    expect(view.reason).toBeNull();
    expect(view.score).toBeNull();
    expect(view.headline).toBe('Overall score unavailable');
  });

  it('never claims no face was found', () => {
    const view = toView(partial);
    const text = `${view.headline} ${view.detail} ${view.caveat ?? ''}`;
    expect(text).not.toMatch(/no face/i);
  });

  it('says which part could not be verified', () => {
    expect(toView(partial).detail).toMatch(/presentation could not be verified/i);
  });

  it('can describe multiple raw detections without fabricating a solo score', () => {
    const view = toView(partial, 3);
    expect(view.detail).toContain('Multiple faces were detected in this photo.');
    expect(view.rows.map((row) => row.axis)).not.toContain('solo');
    expect(toView(partial, 1).detail).not.toContain('Multiple faces');
  });

  it('shows only the axes that were actually scored', () => {
    const view = toView(partial);
    const axes = [...view.rows.map((row) => row.axis)].sort();
    expect(axes).toEqual(['framing', 'lighting', 'resolution', 'sharpness']);
  });

  it('omits framing entirely when it could not be measured', () => {
    const noFraming: AnalysisOutcome = {
      status: 'partial',
      review: { ...review, axes: { sharpness: 4, lighting: 3, resolution: 5 } },
    };
    const view = toView(noFraming);
    expect(view.rows.map((row) => row.axis)).not.toContain('framing');
  });
});
