/**
 * The rule that stops two labelling passes being merged when they do
 * not agree.
 *
 * This exists because of a specific failure. Two framing passes were
 * each internally consistent - 0.628 and 0.815 against the same scalar -
 * and were merged, and the fit got worse rather than better. A
 * photograph one pass scored 3 sat at the same measurement as one the
 * other scored 5. They were anchored to different things: small faces
 * in thumbnails against portraits where faces are large, each labeller
 * grading relative to what was in front of them.
 *
 * Nothing in either pass looked wrong. The disagreement was only
 * visible between them, and it could not be measured, because the two
 * sets shared no images at all.
 *
 * So: overlap is mandatory, alpha is computed on it BEFORE anything is
 * fitted, and a low alpha blocks the merge rather than warning about
 * it. The cost of the rule is twenty images per pass. The cost of
 * skipping it was a week and a fit nobody could use.
 */

import { krippendorffAlpha, type Rating } from './metrics.js';
import { insufficient, type Insufficient } from './metrics.js';

/** Minimum images a new pass must re-label from the previous one. */
export const MIN_OVERLAP = 20;

/**
 * Below this, two passes are not measuring the same thing and merging
 * them corrupts both. Matches the axis go/no-go gate in alphaVerdict:
 * if a scale is not reliable enough to train an axis, it is not
 * reliable enough to merge into one either.
 */
export const MIN_MERGE_ALPHA = 0.65;

export interface LabelPass {
  readonly name: string;
  /** filename -> score, for one axis. */
  readonly labels: ReadonlyMap<string, number>;
}

export type MergeVerdict = 'merge' | 'rescale' | 'block';

export interface OverlapReport {
  readonly axis: string;
  readonly a: string;
  readonly b: string;
  readonly overlap: readonly string[];
  readonly alpha: number | null;
  /** Mean of (b - a) over the overlap: a constant offset is fixable. */
  readonly offset: number;
  /** Fraction of overlapping pairs the two passes order the same way. */
  readonly rankAgreement: number | null;
  readonly verdict: MergeVerdict;
  readonly reasons: readonly string[];
  /** Median of each pass over the overlap. Printed for a rescale so the
   *  shift is a pair of numbers rather than an adjective. */
  readonly medianA: number;
  readonly medianB: number;
}

/** Minimum characters in an --accept-offset reason. Same shape as the
 *  calibrator's --override-stop: getting past a gate costs an argument. */
export const MIN_ACCEPT_REASON = 30;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function pairsOf(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) out.push([i, j]);
  return out;
}

/**
 * Compare two passes on the images they share.
 *
 * `rescale` rather than `block` when the passes ORDER photographs the
 * same way but sit at different heights: that is a fixable offset, and
 * throwing the labels away would be the more expensive mistake. When
 * they disagree about the order there is nothing to rescale.
 */
export function comparePasses(axis: string, a: LabelPass, b: LabelPass): OverlapReport {
  const overlap = [...a.labels.keys()].filter((key) => b.labels.has(key)).sort();
  const reasons: string[] = [];

  const aScores = overlap.map((k) => a.labels.get(k) ?? 0);
  const bScores = overlap.map((k) => b.labels.get(k) ?? 0);

  const units: Rating[][] = overlap.map((_, i) => [aScores[i] ?? null, bScores[i] ?? null]);
  const alphaResult = overlap.length > 0 ? krippendorffAlpha(units, 'ordinal') : null;
  const alpha = alphaResult !== null && alphaResult.ok ? alphaResult.value : null;

  const offset =
    overlap.length === 0
      ? 0
      : bScores.reduce((s, v, i) => s + (v - (aScores[i] ?? 0)), 0) / overlap.length;

  let ordered = 0;
  let comparable = 0;
  for (const [i, j] of pairsOf(overlap.length)) {
    const da = (aScores[i] ?? 0) - (aScores[j] ?? 0);
    const db = (bScores[i] ?? 0) - (bScores[j] ?? 0);
    if (da === 0 || db === 0) continue;
    comparable += 1;
    if (Math.sign(da) === Math.sign(db)) ordered += 1;
  }
  const rankAgreement = comparable === 0 ? null : ordered / comparable;

  let verdict: MergeVerdict = 'merge';

  if (overlap.length < MIN_OVERLAP) {
    verdict = 'block';
    reasons.push(
      `only ${overlap.length} shared image(s); every pass must re-label at least ${MIN_OVERLAP} ` +
        'from the previous one, or the two scales cannot be compared at all',
    );
  }
  if (alpha === null) {
    if (overlap.length > 0) {
      verdict = 'block';
      reasons.push(
        `alpha is undefined on the overlap (${alphaResult !== null && !alphaResult.ok ? alphaResult.reason : 'no ratings'})`,
      );
    }
  } else if (alpha < MIN_MERGE_ALPHA) {
    // Same order, different height, is a rescale rather than a refusal.
    if (rankAgreement !== null && rankAgreement >= 0.8 && Math.abs(offset) >= 0.5) {
      verdict = verdict === 'block' ? 'block' : 'rescale';
      reasons.push(
        `alpha ${alpha.toFixed(3)} is below ${MIN_MERGE_ALPHA}, but the passes order ` +
          `${(rankAgreement * 100).toFixed(0)}% of pairs the same way with a mean offset of ` +
          `${offset >= 0 ? '+' : ''}${offset.toFixed(2)}. That is a shifted scale, not a different one.`,
      );
    } else {
      verdict = 'block';
      reasons.push(
        `alpha ${alpha.toFixed(3)} is below ${MIN_MERGE_ALPHA}. The two passes are not measuring ` +
          'the same thing and merging them corrupts both.',
      );
    }
  }

  return {
    axis,
    a: a.name,
    b: b.name,
    overlap,
    alpha,
    offset,
    rankAgreement,
    verdict,
    reasons,
    medianA: median(aScores),
    medianB: median(bScores),
  };
}

export function renderOverlap(report: OverlapReport): string {
  const lines = [
    '',
    `${report.axis}: ${report.a} vs ${report.b}`,
    '-'.repeat(60),
    `  shared images     ${report.overlap.length} (minimum ${MIN_OVERLAP})`,
    `  krippendorff a    ${report.alpha === null ? 'undefined' : report.alpha.toFixed(3)} (minimum ${MIN_MERGE_ALPHA})`,
    `  mean offset b-a   ${report.offset >= 0 ? '+' : ''}${report.offset.toFixed(2)}`,
    `  pair order agree  ${report.rankAgreement === null ? 'n/a' : `${(report.rankAgreement * 100).toFixed(0)}%`}`,
    `  verdict           ${report.verdict.toUpperCase()}`,
  ];
  for (const reason of report.reasons) lines.push(`  ! ${reason}`);

  if (report.verdict === 'rescale') {
    // Loud on purpose. A silent rescale becoming routine is how two
    // scales drift apart for good: each merge looks like a small
    // correction and nobody ever re-anchors.
    lines.push(
      '',
      '  ***  SCALE SHIFT  ***',
      `    ${report.a} median ${report.medianA.toFixed(2)}`,
      `    ${report.b} median ${report.medianB.toFixed(2)}`,
      `    shift ${report.offset >= 0 ? '+' : ''}${report.offset.toFixed(2)} points over ${report.overlap.length} shared images`,
      '    The two passes rank photographs the same way and score them at',
      '    different heights. That is recoverable by rescaling, but it is',
      '    not nothing: it means the raters were anchored differently and',
      '    will drift again on the next pass unless anchors are agreed.',
      `    Merging anyway requires --accept-offset "<why>" (${MIN_ACCEPT_REASON}+ chars).`,
    );
  }
  if (report.verdict === 'merge') {
    lines.push('  the passes agree; merging is safe');
  }
  return lines.join('\n');
}

export function parseAcceptOffset(argv: readonly string[]): string | null {
  const at = argv.indexOf('--accept-offset');
  if (at < 0) return null;
  const reason = (argv[at + 1] ?? '').trim();
  if (reason === '' || reason.startsWith('--')) {
    throw new Error('--accept-offset needs a reason string');
  }
  if (reason.length < MIN_ACCEPT_REASON) {
    throw new Error(
      `--accept-offset reason must be at least ${MIN_ACCEPT_REASON} characters; ` +
        'a rescale changes every label in one of the passes and the reason is the only record of why',
    );
  }
  return reason;
}

/**
 * Anchor images: the shared reference every labeller scores first.
 *
 * Overlap catches drift after the fact. Anchors are the cheaper half -
 * both passes calibrate against the same handful of photographs with
 * agreed scores before labelling anything else, so the scales start in
 * the same place instead of being reconciled afterwards.
 */
export interface AnchorCheck {
  readonly matched: number;
  readonly total: number;
  readonly mismatches: readonly { image: string; expected: number; got: number }[];
  readonly ok: boolean;
}

export function checkAnchors(
  anchors: ReadonlyMap<string, number>,
  pass: LabelPass,
  tolerance = 0,
): AnchorCheck | Insufficient {
  if (anchors.size === 0) return insufficient('no anchor images defined');

  const mismatches: { image: string; expected: number; got: number }[] = [];
  let matched = 0;
  let total = 0;
  for (const [image, expected] of anchors) {
    const got = pass.labels.get(image);
    if (got === undefined) continue;
    total += 1;
    if (Math.abs(got - expected) <= tolerance) matched += 1;
    else mismatches.push({ image, expected, got });
  }

  if (total === 0) return insufficient('the pass scored none of the anchor images');
  return { matched, total, mismatches, ok: mismatches.length === 0 };
}
