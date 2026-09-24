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

describe('toView on a declined outcome', () => {
  it('renders a decline as its own thing, never as a zero score', () => {
    const view = toView({
      status: 'declined',
      reason: 'no_face',
      message: 'No face was found in this image.',
    });
    expect(view.kind).toBe('declined');
    expect(view.headline).toBe('Not scored');
    expect(view.rows).toEqual([]);
    expect(view.fixes).toEqual([]);
    expect(view.headline).not.toContain('0');
  });

  it('prefers the server message over the local fallback', () => {
    const view = toView({
      status: 'declined',
      reason: 'not_a_photo',
      message: 'This is a company logo.',
    });
    expect(view.detail).toBe('This is a company logo.');
  });

  it.each(DeclineReason.options)('has copy for %s', (reason) => {
    expect(declineCopy(reason).length).toBeGreaterThan(0);
    const view = toView(AnalysisOutcomeSchema.parse({ status: 'declined', reason, message: ' ' }));
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
