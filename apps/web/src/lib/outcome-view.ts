import type { AnalysisOutcome, DeclineReason, Fix, ScoreResult } from '@pps/schema';
import { matchOutcome } from '@pps/schema';
import { AXIS_DESCRIPTIONS, type AxisName } from '@pps/scoring';

/**
 * What the result screen renders. Both branches of `AnalysisOutcome`
 * collapse to this one shape, so the page has a single thing to draw and
 * cannot accidentally render a decline as a zero score.
 */
export interface OutcomeView {
  readonly kind: 'scored' | 'declined';
  readonly headline: string;
  readonly detail: string;
  readonly rows: readonly AxisRow[];
  readonly fixes: readonly Fix[];
  /** Shown when the scorer could not verify much of what it measured. */
  readonly caveat: string | null;
}

export interface AxisRow {
  readonly axis: AxisName;
  readonly score: number;
  readonly description: string;
}

/**
 * User-facing copy for each decline. Every line talks about the image.
 * `apparent_minor` in particular says nothing about the person and offers
 * no workaround - it is the one outcome that is not a retake away.
 */
const DECLINE_COPY: Readonly<Record<DeclineReason, string>> = {
  no_face:
    'No face was found in this image. Upload a photo of yourself and it will be scored.',
  apparent_minor: 'This service only scores photos of adults.',
  not_a_photo:
    'This looks like a graphic rather than a photograph. Upload a camera photo instead.',
  model_refusal: 'This image could not be assessed. Try a different photo.',
  corrupt_file: 'This file could not be opened. Re-export it and upload it again.',
};

/** Below this, the score is shown with a caveat rather than on its own. */
export const LOW_CONFIDENCE = 0.7;

export function toView(outcome: AnalysisOutcome): OutcomeView {
  return matchOutcome<OutcomeView>(outcome, {
    scored: (result) => ({
      kind: 'scored',
      headline: `${result.score.toFixed(1)} / 10`,
      detail: `Scored for a ${result.context} audience.`,
      rows: axisRows(result),
      fixes: result.fixes,
      caveat: caveatFor(result),
    }),
    declined: (reason, message) => ({
      kind: 'declined',
      headline: 'Not scored',
      // The server's message wins when it has one; the table is the
      // fallback so a new reason never renders as an empty screen.
      detail: message.trim() === '' ? DECLINE_COPY[reason] : message,
      rows: [],
      fixes: [],
      caveat: null,
    }),
  });
}

/**
 * Only the axes that actually contributed. On the degraded path the
 * judged four are absent, and showing them as blanks would imply we
 * looked and found nothing rather than that we did not look.
 */
export function axisRows(result: ScoreResult): readonly AxisRow[] {
  const rows: AxisRow[] = [];
  for (const axis of Object.keys(result.axes) as AxisName[]) {
    const score = result.axes[axis];
    if (score === undefined) continue;
    rows.push({ axis, score, description: AXIS_DESCRIPTIONS[axis] });
  }
  return rows.sort((a, b) => a.score - b.score);
}

function caveatFor(result: ScoreResult): string | null {
  if (result.confidence >= LOW_CONFIDENCE) {
    return null;
  }
  return 'Some measurements could not be verified in this image, so treat the score as approximate.';
}

export function declineCopy(reason: DeclineReason): string {
  return DECLINE_COPY[reason];
}
