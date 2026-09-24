/**
 * Reporting. Every function returns data; rendering is separate, so the
 * numbers can be asserted in a test without parsing ASCII art.
 *
 * Nothing here throws. On thin or empty data it returns an Insufficient
 * with a reason the CLI prints as "insufficient data for X" - this gets
 * run on 40 labels before it is ever run on 700.
 */

import { insufficient, type Insufficient } from './metrics.js';

export const DEFAULT_LEVELS: readonly number[] = [1, 2, 3, 4, 5];

/** Below this, a distribution is noise and its flags are meaningless. */
export const MIN_RATINGS_FOR_DISTRIBUTION = 20;

/** A level this rare, or this dominant, means the axis carries little. */
export const RARE_LEVEL_SHARE = 0.05;
export const DOMINANT_LEVEL_SHARE = 0.6;

export interface LevelShare {
  readonly level: number;
  readonly count: number;
  readonly share: number;
}

export interface AxisDistribution {
  readonly axis: string;
  readonly n: number;
  readonly levels: readonly LevelShare[];
  readonly flags: readonly string[];
  /** True when one level holds more than DOMINANT_LEVEL_SHARE. */
  readonly collapsed: boolean;
  /** Ratings that were not one of the expected levels. */
  readonly offScale: number;
  /** True when n is too small for the flags to mean anything. */
  readonly provisional: boolean;
}

/**
 * An axis whose ratings pile onto one level carries no information: it
 * cannot separate a good photograph from a bad one no matter what weight
 * it is given. That is a rubric problem, not a weights problem, so it is
 * worth seeing before any fitting starts.
 */
export function axisDistribution(
  axis: string,
  ratings: readonly number[],
  levels: readonly number[] = DEFAULT_LEVELS,
): AxisDistribution | Insufficient {
  if (ratings.length === 0) return insufficient(`no ratings for ${axis}`);
  if (levels.length === 0) return insufficient('no levels to bucket into');

  const counts = new Map<number, number>(levels.map((l) => [l, 0]));
  let offScale = 0;
  for (const rating of ratings) {
    const current = counts.get(rating);
    if (current === undefined) offScale += 1;
    else counts.set(rating, current + 1);
  }

  const n = ratings.length - offScale;
  if (n === 0) return insufficient(`every rating for ${axis} is off the ${levels.join('/')} scale`);

  const shares: LevelShare[] = levels.map((level) => {
    const count = counts.get(level) ?? 0;
    return { level, count, share: count / n };
  });

  const provisional = n < MIN_RATINGS_FOR_DISTRIBUTION;
  const flags: string[] = [];
  for (const { level, share, count } of shares) {
    if (share > DOMINANT_LEVEL_SHARE) {
      flags.push(
        `level ${level} holds ${(share * 100).toFixed(1)}% of ratings - the axis is close to constant`,
      );
    } else if (share < RARE_LEVEL_SHARE) {
      flags.push(
        `level ${level} holds ${(share * 100).toFixed(1)}% (${count}) - raters are not using it`,
      );
    }
  }
  if (offScale > 0) {
    flags.push(`${offScale} rating(s) were not one of ${levels.join('/')}`);
  }
  if (provisional) {
    flags.push(
      `only ${n} ratings; under ${MIN_RATINGS_FOR_DISTRIBUTION} the flags above are noise, not evidence`,
    );
  }

  return {
    axis,
    n,
    levels: shares,
    flags,
    collapsed: shares.some((s) => s.share > DOMINANT_LEVEL_SHARE),
    offScale,
    provisional,
  };
}

export interface HistogramBin {
  readonly bin: number;
  readonly count: number;
  readonly share: number;
}

export interface Histogram {
  readonly bins: readonly HistogramBin[];
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
  readonly outOfRange: number;
}

/**
 * The composite, bucketed to the 1-10 the user is shown. A product that
 * gives four fifths of its uploads a 7 has not told anyone anything.
 */
export function compositeHistogram(scores: readonly number[]): Histogram | Insufficient {
  const usable = scores.filter((s) => Number.isFinite(s));
  if (usable.length === 0) return insufficient('no composite scores');

  const counts = new Map<number, number>();
  for (let b = 1; b <= 10; b += 1) counts.set(b, 0);
  let outOfRange = 0;
  for (const score of usable) {
    // The displayed score is the rounded one, so bucket the way the user
    // sees it rather than by floor.
    const bin = Math.round(score);
    if (bin < 1 || bin > 10) {
      outOfRange += 1;
      continue;
    }
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }

  const n = usable.length - outOfRange;
  if (n === 0) return insufficient('every composite score is outside 1-10');

  const mean = usable.reduce((s, x) => s + x, 0) / usable.length;
  const variance =
    usable.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(usable.length - 1, 1);

  const bins: HistogramBin[] = [];
  for (let b = 1; b <= 10; b += 1) {
    const count = counts.get(b) ?? 0;
    bins.push({ bin: b, count, share: count / n });
  }

  return { bins, n, mean, sd: Math.sqrt(variance), outOfRange };
}

export interface VarianceShare {
  readonly axis: string;
  readonly weight: number;
  /** Fraction of the composite's variance this axis accounts for. */
  readonly share: number;
  /** Standard deviation of the axis itself, before weighting. */
  readonly sd: number;
  readonly deadWeight: boolean;
}

/** Below this share an axis is not moving the score enough to matter. */
export const DEAD_WEIGHT_SHARE = 0.02;

/**
 * Exact variance decomposition: var(S) = sum over axes of
 * cov(w_a * x_a, S), so the shares sum to 1 with no residual.
 *
 * An axis with a large weight and a near-zero share is dead weight - it
 * is either constant, or perfectly cancelled by another axis. Either way
 * it is not doing what its weight claims, and that is invisible in the
 * weights file.
 */
export function varianceContribution(
  axisRatings: Readonly<Record<string, readonly number[]>>,
  weights: Readonly<Record<string, number>>,
): readonly VarianceShare[] | Insufficient {
  const axes = Object.keys(axisRatings).sort();
  if (axes.length === 0) return insufficient('no axes to decompose');

  const lengths = new Set(axes.map((a) => axisRatings[a]?.length ?? 0));
  if (lengths.size !== 1) return insufficient('axes have different numbers of ratings');
  const n = [...lengths][0] ?? 0;
  if (n < 2) return insufficient('need at least two scored photos to have any variance');

  for (const axis of axes) {
    if (weights[axis] === undefined) return insufficient(`no weight given for axis ${axis}`);
  }

  const composite = new Array<number>(n).fill(0);
  for (const axis of axes) {
    const weight = weights[axis] ?? 0;
    const ratings = axisRatings[axis] ?? [];
    for (let i = 0; i < n; i += 1) composite[i] = (composite[i] ?? 0) + weight * (ratings[i] ?? 0);
  }

  const meanOf = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const meanS = meanOf(composite);
  let varS = 0;
  for (const s of composite) varS += (s - meanS) * (s - meanS);
  varS /= n - 1;

  if (varS === 0) {
    return insufficient('the composite is constant across every photo, so there is nothing to attribute');
  }

  const out: VarianceShare[] = [];
  for (const axis of axes) {
    const weight = weights[axis] ?? 0;
    const ratings = axisRatings[axis] ?? [];
    const meanA = meanOf(ratings);
    let covariance = 0;
    let varianceA = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = (ratings[i] ?? 0) - meanA;
      covariance += weight * dx * ((composite[i] ?? 0) - meanS);
      varianceA += dx * dx;
    }
    covariance /= n - 1;
    const share = covariance / varS;
    out.push({
      axis,
      weight,
      share,
      sd: Math.sqrt(varianceA / (n - 1)),
      deadWeight: Math.abs(share) < DEAD_WEIGHT_SHARE,
    });
  }

  return out.sort((a, b) => b.share - a.share);
}

export interface Confusion {
  readonly axis: string;
  readonly levels: readonly number[];
  /** rows[humanLevel][modelLevel] */
  readonly rows: readonly (readonly number[])[];
  readonly n: number;
  readonly offScale: number;
}

export function confusionMatrix(
  axis: string,
  human: readonly number[],
  model: readonly number[],
  levels: readonly number[] = DEFAULT_LEVELS,
): Confusion | Insufficient {
  if (human.length !== model.length) return insufficient(`${axis}: series have different lengths`);
  if (human.length === 0) return insufficient(`no paired ratings for ${axis}`);

  const position = new Map(levels.map((l, i) => [l, i]));
  const rows = levels.map(() => new Array<number>(levels.length).fill(0));
  let offScale = 0;
  let n = 0;

  for (let i = 0; i < human.length; i += 1) {
    const h = position.get(human[i] ?? Number.NaN);
    const m = position.get(model[i] ?? Number.NaN);
    if (h === undefined || m === undefined) {
      offScale += 1;
      continue;
    }
    const row = rows[h];
    if (row === undefined) continue;
    row[m] = (row[m] ?? 0) + 1;
    n += 1;
  }

  if (n === 0) return insufficient(`every pair for ${axis} is off the ${levels.join('/')} scale`);
  return { axis, levels, rows, n, offScale };
}

/* Rendering. Fixed-width, no colour, no dependencies. */

const BAR = '#';

function bar(share: number, width = 30): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return BAR.repeat(filled).padEnd(width, '.');
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1).padStart(5)}%`;
}

export function renderDistribution(d: AxisDistribution): string {
  const lines = [`${d.axis}  (n=${d.n}${d.provisional ? ', provisional' : ''})`];
  for (const level of d.levels) {
    lines.push(`  ${level.level}  ${bar(level.share)} ${pct(level.share)}  ${level.count}`);
  }
  for (const flag of d.flags) lines.push(`  ! ${flag}`);
  return lines.join('\n');
}

export function renderHistogram(h: Histogram): string {
  const lines = [`composite  (n=${h.n}, mean ${h.mean.toFixed(2)}, sd ${h.sd.toFixed(2)})`];
  for (const b of h.bins) {
    lines.push(`  ${String(b.bin).padStart(2)}  ${bar(b.share)} ${pct(b.share)}  ${b.count}`);
  }
  if (h.outOfRange > 0) lines.push(`  ! ${h.outOfRange} score(s) fell outside 1-10`);
  return lines.join('\n');
}

/** `includeHeader` is false when the caller has already titled the
 *  section, which the CLI has. */
export function renderVariance(shares: readonly VarianceShare[], includeHeader = true): string {
  const lines = includeHeader ? ['variance contribution  (shares sum to 1 by construction)'] : [];
  const width = Math.max(...shares.map((s) => s.axis.length), 4);
  for (const s of shares) {
    lines.push(
      `  ${s.axis.padEnd(width)}  weight ${s.weight.toFixed(3)}  sd ${s.sd.toFixed(2)}  ${bar(Math.max(s.share, 0), 20)} ${pct(s.share)}${s.deadWeight ? '  ! dead weight' : ''}`,
    );
  }
  return lines.join('\n');
}

export function renderConfusion(c: Confusion): string {
  const cell = (value: number | string): string => String(value).padStart(5);
  const lines = [`${c.axis}  human (rows) vs model (columns), n=${c.n}`];
  lines.push(`       ${c.levels.map(cell).join('')}`);
  for (let i = 0; i < c.levels.length; i += 1) {
    const row = c.rows[i] ?? [];
    lines.push(`  ${cell(c.levels[i] ?? '?')}${row.map(cell).join('')}`);
  }
  if (c.offScale > 0) lines.push(`  ! ${c.offScale} pair(s) were off the scale`);
  return lines.join('\n');
}
