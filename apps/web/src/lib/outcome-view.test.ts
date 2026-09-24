import { describe, expect, it } from 'vitest';
import type { AnalysisOutcome, ScoreResult } from '@pps/schema';
import { AnalysisOutcome as AnalysisOutcomeSchema, DeclineReason } from '@pps/schema';
import { AXES } from '@pps/scoring';
import { LOW_CONFIDENCE, declineCopy, toView } from './outcome-view.js';

const result: ScoreResult = {
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

/** The capped composite a decline carries, except on corrupt_file. */
const cappedScore = {
  ...scored.result,
  score: 2,
  coverage: 'partial' as const,
  axes: { sharpness: 5, lighting: 5, resolution: 5, framing: 1 },
};

describe('toView on a declined outcome', () => {
  it('shows the capped score, because a bare decline is not actionable', () => {
    const view = toView({
      status: 'declined',
      reason: 'no_face',
      message: 'No face was found in this image.',
      score: cappedScore,
    });
    expect(view.kind).toBe('declined');
    // "2.0 / 10" tells the person this is not a near miss. "Not scored"
    // tells them nothing they can act on.
    expect(view.headline).toBe('2.0 / 10');
    expect(view.rows.length).toBeGreaterThan(0);
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
      toView({ status: 'declined', reason: 'no_face', message: 'x', score: cappedScore }),
      toView({ status: 'declined', reason: 'corrupt_file', message: 'x' }),
    ]) {
      expect(view.headline).not.toBe('0.0 / 10');
      expect(view.kind).toBe('declined');
    }
  });

  it('shows the measured axes as the evidence behind the number', () => {
    const view = toView({
      status: 'declined',
      reason: 'no_face',
      message: 'No face was found.',
      score: cappedScore,
    });
    // framing floored to 1 by the decline; the rest genuinely measured.
    expect(view.rows.find((row) => row.axis === 'framing')?.score).toBe(1);
    expect(view.rows.map((row) => row.axis)).not.toContain('background');
  });

  it('prefers the server message over the local fallback', () => {
    const view = toView({
      status: 'declined',
      reason: 'not_a_photo',
      message: 'This is a company logo.',
      score: cappedScore,
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
        // corrupt_file is the one reason that must NOT carry a score.
        ...(reason === 'corrupt_file' ? {} : { score: cappedScore }),
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
  it('handles both branches of the union without a default case', () => {
    const outcomes: AnalysisOutcome[] = [
      scored,
      { status: 'declined', reason: 'corrupt_file', message: 'Could not decode.' },
    ];
    expect(outcomes.map((outcome) => toView(outcome).kind)).toEqual(['scored', 'declined']);
  });
});
