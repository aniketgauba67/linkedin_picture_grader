/**
 * The label-noise ceiling. The most important output in this package.
 *
 * A model cannot be more consistent with the labels than the labels are
 * with themselves. If two humans agree with each other 78% of the time,
 * then 78% is what "perfect" looks like, and the gap between 78% and
 * 100% is disagreement no model can resolve because there is no fact of
 * the matter in it.
 *
 * Which makes two mistakes visible that are otherwise invisible:
 *
 *   - Training past the ceiling. Accuracy keeps climbing, so the run
 *     looks like it is going well. It is fitting the noise in the label
 *     set, and every point gained that way is lost in production.
 *   - Reporting a number above the ceiling as a success. On a clean
 *     split it is not possible; getting one means the split leaked, or
 *     the "human agreement" figure was measured on different photos than
 *     the model accuracy.
 *
 * Both series print on one chart because the comparison is the point.
 * Model accuracy alone is a number with no scale attached.
 */

import { insufficient, type Insufficient } from './metrics.js';

export type CeilingVerdict = 'headroom' | 'at-ceiling' | 'above-ceiling';

export interface CeilingRow {
  readonly axis: string;
  /** How often two humans agree. The ceiling. */
  readonly humanAgreement: number;
  readonly modelAccuracy: number;
  /** Positive means there is still honest ground to gain. */
  readonly headroom: number;
  /** modelAccuracy as a fraction of what is achievable. */
  readonly fractionOfCeiling: number;
  readonly verdict: CeilingVerdict;
}

export interface CeilingReport {
  readonly rows: readonly CeilingRow[];
  /** Axes present in one input and not the other. */
  readonly unmatched: readonly string[];
  readonly margin: number;
}

/**
 * Default slack before "the model reached the ceiling" is believed.
 *
 * Two percentage points. Both figures are estimates from a few hundred
 * pairs at best, so a gap smaller than this is not a gap.
 */
export const DEFAULT_CEILING_MARGIN = 0.02;

export function ceilingVerdict(
  humanAgreement: number,
  modelAccuracy: number,
  margin: number = DEFAULT_CEILING_MARGIN,
): CeilingVerdict {
  if (modelAccuracy > humanAgreement + margin) return 'above-ceiling';
  if (modelAccuracy >= humanAgreement - margin) return 'at-ceiling';
  return 'headroom';
}

/**
 * `humanAgreement` and `modelAccuracy` must be the same statistic
 * measured the same way - pairwise accuracy against pairwise accuracy,
 * or exact agreement against exact agreement. Comparing a model's
 * pairwise accuracy to a human alpha produces a chart that means
 * nothing, and nothing in the numbers themselves reveals the mistake.
 */
export function reportCeiling(
  humanAgreement: Readonly<Record<string, number>>,
  modelAccuracy: Readonly<Record<string, number>>,
  margin: number = DEFAULT_CEILING_MARGIN,
): CeilingReport | Insufficient {
  const humanAxes = Object.keys(humanAgreement);
  const modelAxes = Object.keys(modelAccuracy);
  if (humanAxes.length === 0) return insufficient('no human agreement figures');
  if (modelAxes.length === 0) return insufficient('no model accuracy figures');

  const shared = humanAxes.filter((axis) => modelAxes.includes(axis)).sort();
  if (shared.length === 0) {
    return insufficient('no axis appears in both the human and the model figures');
  }

  const rows: CeilingRow[] = [];
  for (const axis of shared) {
    const human = humanAgreement[axis] ?? 0;
    const model = modelAccuracy[axis] ?? 0;
    rows.push({
      axis,
      humanAgreement: human,
      modelAccuracy: model,
      headroom: human - model,
      // A ceiling of zero means the humans never agreed; dividing by it
      // would report an infinite fraction of an achievable nothing.
      fractionOfCeiling: human === 0 ? 0 : model / human,
      verdict: ceilingVerdict(human, model, margin),
    });
  }

  const unmatched = [
    ...humanAxes.filter((a) => !modelAxes.includes(a)),
    ...modelAxes.filter((a) => !humanAxes.includes(a)),
  ].sort();

  return { rows, unmatched, margin };
}

const WIDTH = 40;

/** One line per axis: the model's bar, with the ceiling marked on it. */
function line(row: CeilingRow, labelWidth: number): string {
  const cells = new Array<string>(WIDTH).fill(' ');
  const clamp = (v: number): number => Math.max(0, Math.min(WIDTH - 1, Math.round(v * WIDTH)));
  const modelEnd = clamp(row.modelAccuracy);
  for (let i = 0; i < modelEnd; i += 1) cells[i] = '#';
  // The ceiling marker goes on last, so it is never hidden by the bar.
  cells[clamp(row.humanAgreement)] = '|';

  const note =
    row.verdict === 'above-ceiling'
      ? '  ! above the ceiling - check the split for leakage'
      : row.verdict === 'at-ceiling'
        ? '  at the ceiling - further gains are fitting noise'
        : `  ${(row.headroom * 100).toFixed(1)} points of headroom`;

  return `  ${row.axis.padEnd(labelWidth)} [${cells.join('')}] model ${(row.modelAccuracy * 100).toFixed(1)}% / ceiling ${(row.humanAgreement * 100).toFixed(1)}%${note}`;
}

export function renderCeiling(report: CeilingReport): string {
  const labelWidth = Math.max(...report.rows.map((r) => r.axis.length), 4);
  const lines = [
    'label-noise ceiling   # = model accuracy,  | = human agreement (the ceiling)',
    '',
  ];
  for (const row of report.rows) lines.push(line(row, labelWidth));
  lines.push('');

  const done = report.rows.filter((r) => r.verdict === 'at-ceiling').map((r) => r.axis);
  const suspicious = report.rows.filter((r) => r.verdict === 'above-ceiling').map((r) => r.axis);

  if (suspicious.length > 0) {
    lines.push(
      `  ! ${suspicious.join(', ')} scored above the ceiling. On a clean split that is not`,
      '    possible: either the split leaked, or the two figures were measured on',
      '    different photos. Do not report these numbers.',
    );
  }
  if (done.length > 0) {
    lines.push(`  ${done.join(', ')}: training is done. More accuracy here is fitted noise.`);
  }
  if (report.unmatched.length > 0) {
    lines.push(`  insufficient data for: ${report.unmatched.join(', ')} (present on one side only)`);
  }
  return lines.join('\n');
}
