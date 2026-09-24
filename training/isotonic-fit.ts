/**
 * Monotone regression, and the reduction to a knot table.
 *
 * Separate from calibrate.ts so it can be tested against hand-computed
 * fixtures without a labels file or a feature lookup in the way.
 */

export interface Observation {
  /** The measurement, e.g. megapixels or Laplacian variance. */
  readonly x: number;
  /** The human label, 1-5. */
  readonly y: number;
}

export interface FittedPoint {
  readonly x: number;
  readonly y: number;
  /** How many observations were pooled into this level. */
  readonly weight: number;
}

/**
 * Pool Adjacent Violators.
 *
 * The maximum-likelihood monotone non-decreasing fit to the labels, and
 * the right shape here because every one of these axes is monotone in
 * goodness by construction: more usable luma span is never worse,
 * sharper is never worse. Axes with a two-sided optimum - framing, and
 * exposure inside lighting - are reduced to a one-sided badness scalar
 * BEFORE they reach this function, because a monotone fit cannot
 * represent "too much is also bad" and would silently flatten one side.
 *
 * Ties in x are averaged first. Leaving them in lets PAVA see a
 * violation that is really just two labellers disagreeing about the same
 * measurement, and it pools a wider neighbourhood than it needs to.
 */
export function pava(observations: readonly Observation[]): readonly FittedPoint[] {
  if (observations.length === 0) return [];

  const sorted = [...observations].sort((a, b) => a.x - b.x);
  const blocks: { x: number; sum: number; weight: number }[] = [];

  for (const point of sorted) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.x === point.x) {
      last.sum += point.y;
      last.weight += 1;
    } else {
      blocks.push({ x: point.x, sum: point.y, weight: 1 });
    }
  }

  // Merge any block whose mean falls below its predecessor's.
  let i = 1;
  while (i < blocks.length) {
    const previous = blocks[i - 1];
    const current = blocks[i];
    if (previous === undefined || current === undefined) break;
    if (previous.sum / previous.weight <= current.sum / current.weight) {
      i += 1;
      continue;
    }
    // Pooled block keeps the LARGER x: the fitted value applies from
    // here upward, and taking the smaller one would claim the score is
    // reached earlier than the data supports.
    previous.sum += current.sum;
    previous.weight += current.weight;
    previous.x = current.x;
    blocks.splice(i, 1);
    if (i > 1) i -= 1;
  }

  return blocks.map((block) => ({
    x: block.x,
    y: block.sum / block.weight,
    weight: block.weight,
  }));
}

export type Knot = readonly [measurement: number, score: number];

export interface KnotFit {
  readonly knots: readonly Knot[];
  /** The highest score the data actually supports. */
  readonly topScore: number;
  /** The measurement at which that score is first reached. */
  readonly topX: number;
  /** Levels the fit never reaches, e.g. [5] when nothing scored 5. */
  readonly unreachable: readonly number[];
  readonly fitted: readonly FittedPoint[];
}

/**
 * Reduce a monotone fit to knots at each integer score.
 *
 * For each level, the knot sits at the smallest measurement whose fitted
 * value reaches it. A level the fit never reaches gets NO knot, and is
 * reported in `unreachable` instead of being invented - applyIsotonic
 * clamps above the top knot, so a fabricated top knot does not fail
 * loudly, it just hands every large input a score nobody measured.
 */
export function toKnots(
  fitted: readonly FittedPoint[],
  levels: readonly number[] = [1, 2, 3, 4, 5],
): KnotFit {
  if (fitted.length === 0) {
    return { knots: [], topScore: 0, topX: 0, unreachable: [...levels], fitted };
  }

  const knots: Knot[] = [];
  const unreachable: number[] = [];
  const first = fitted[0];
  const last = fitted[fitted.length - 1];
  if (first === undefined || last === undefined) {
    return { knots: [], topScore: 0, topX: 0, unreachable: [...levels], fitted };
  }

  for (const level of levels) {
    if (level <= first.y) {
      // Already at or above this level at the smallest measurement seen.
      knots.push([first.x, level]);
      continue;
    }
    const crossing = fitted.find((point) => point.y >= level);
    if (crossing === undefined) {
      unreachable.push(level);
      continue;
    }
    knots.push([crossing.x, level]);
  }

  // Strictly increasing in x, or applyIsotonic cannot interpolate.
  const deduped: Knot[] = [];
  for (const knot of knots) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && knot[0] <= previous[0]) {
      // Two levels reached at the same measurement: keep the higher
      // score, since the data says both are satisfied there.
      deduped[deduped.length - 1] = [previous[0], knot[1]];
      continue;
    }
    deduped.push(knot);
  }

  const top = deduped[deduped.length - 1];
  return {
    knots: deduped,
    topScore: top?.[1] ?? 0,
    topX: top?.[0] ?? 0,
    unreachable,
    fitted,
  };
}

/** Piecewise-linear lookup with clamping, matching applyIsotonic. */
export function applyKnots(value: number, knots: readonly Knot[]): number {
  if (knots.length === 0) return 0;
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < knots.length; i += 1) {
    const lo = knots[i - 1];
    const hi = knots[i];
    if (lo === undefined || hi === undefined) continue;
    if (value <= hi[0]) {
      const span = hi[0] - lo[0];
      if (span === 0) return hi[1];
      return lo[1] + ((value - lo[0]) / span) * (hi[1] - lo[1]);
    }
  }
  return last[1];
}
