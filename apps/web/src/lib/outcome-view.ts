import type { AnalysisOutcome, DeclineReason, Fix, FullScoreResult, PartialReview } from '@pps/schema';
import { matchOutcome } from '@pps/schema';
import { AXIS_DESCRIPTIONS, type AxisName } from '@pps/scoring';

/**
 * What the result screen renders. All branches of `AnalysisOutcome`
 * collapse to this one shape, so the page has a single thing to draw and
 * cannot accidentally render a decline as a zero score.
 */
export interface OutcomeView {
  readonly kind: 'scored' | 'partial' | 'declined';
  readonly reason: DeclineReason | null;
  readonly score: number | null;
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
  // Only reached when the detector agrees: a contradicted no_face becomes
  // a partial review, not a finding that no face exists.
  no_face:
    'No face was found in this image. Upload a photo of yourself and it will be scored.',
  multiple_faces:
    'Multiple faces were detected in this photo. Choose a photo with one clearly visible person.',
  apparent_minor: 'This service only scores photos of adults.',
  not_a_photo:
    'This looks like a graphic rather than a photograph. Upload a camera photo instead.',
  model_refusal: 'This image could not be assessed. Try a different photo.',
  corrupt_file: 'This file could not be opened. Re-export it and upload it again.',
};

/** Below this, measured evidence or a complete score gets a confidence caveat. */
export const LOW_CONFIDENCE = 0.7;

/** `detectedFaceCount` is descriptive extraction evidence, never a solo score. */
export function toView(outcome: AnalysisOutcome, detectedFaceCount?: number): OutcomeView {
  return matchOutcome<OutcomeView>(outcome, {
    scored: (result) => ({
      kind: 'scored',
      reason: null,
      score: result.score,
      headline: `${result.score.toFixed(1)} / 10`,
      detail: `Scored for a ${result.context} audience.`,
      rows: axisRows(result),
      fixes: result.fixes,
      caveat: caveatFor(result.confidence, true),
    }),
    partial: (review) => ({
      kind: 'partial',
      reason: null,
      score: null,
      headline: 'Overall score unavailable',
      detail: 'We could measure this photo\'s image quality, but its presentation could not be verified for profile-photo use.' +
        (detectedFaceCount !== undefined && detectedFaceCount > 1
          ? ' Multiple faces were detected in this photo.'
          : ''),
      rows: axisRows(review),
      fixes: review.fixes,
      caveat: caveatFor(review.confidence, false),
    }),
    declined: (reason, message, review) => ({
      kind: 'declined',
      reason,
      score: null,
      headline: review === undefined ? 'Not scored' : 'Overall score unavailable',
      // The server's message wins when it has one; the table is the
      // fallback so a new reason never renders as an empty screen.
      detail: message.trim() === '' ? DECLINE_COPY[reason] : message,
      rows: review === undefined ? [] : axisRows(review),
      fixes: review?.fixes ?? [],
      caveat: review === undefined ? null : caveatFor(review.confidence, false),
    }),
  });
}

/**
 * Only the axes that actually contributed. On the degraded path the
 * judged four are absent, and showing them as blanks would imply we
 * looked and found nothing rather than that we did not look.
 */
export function axisRows(result: FullScoreResult | PartialReview): readonly AxisRow[] {
  const rows: AxisRow[] = [];
  for (const axis of Object.keys(result.axes) as AxisName[]) {
    const score = result.axes[axis];
    if (score === undefined) continue;
    rows.push({ axis, score, description: AXIS_DESCRIPTIONS[axis] });
  }
  return rows.sort((a, b) => a.score - b.score);
}

/**
 * A partial review has no overall score to call approximate. Its caveat
 * only qualifies the measurements that actually exist.
 */
function caveatFor(confidence: number, hasOverallScore: boolean): string | null {
  if (confidence >= LOW_CONFIDENCE) {
    return null;
  }
  return hasOverallScore
    ? 'Some measurements could not be verified in this image, so treat the score as approximate.'
    : 'Some measured image-quality details may be less certain in this photo.';
}

export function declineCopy(reason: DeclineReason): string {
  return DECLINE_COPY[reason];
}
