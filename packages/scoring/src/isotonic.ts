/**
 * Piecewise-linear interpolation over a monotone knot set.
 *
 * This is how a raw measurement becomes a 1-5 axis score. Knots are
 * `[measurement, score]` pairs in ascending measurement order; a value
 * between two knots interpolates linearly, and a value outside the range
 * clamps to the nearest end rather than extrapolating - extrapolation
 * off the end of a fitted map is how a very sharp photo ends up scoring
 * 7.
 *
 * ISOTONIC MEANS MONOTONE. An axis with a two-sided optimum - a value
 * that is bad when too low AND bad when too high - cannot be expressed
 * here. Reduce it to a one-sided "badness" scalar first and fit the map
 * over that. See framingRaw in pixel-axes.ts.
 */
export type Knot = readonly [measurement: number, score: number];

/** Thrown for a knot set that cannot define a map. */
export class KnotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnotError';
  }
}

export function assertKnots(knots: readonly Knot[]): void {
  if (knots.length < 2) {
    throw new KnotError(`A map needs at least two knots, got ${knots.length}`);
  }
  for (let i = 0; i < knots.length; i += 1) {
    const knot = knots[i];
    if (knot === undefined) {
      throw new KnotError(`Knot ${i} is missing`);
    }
    const [x, y] = knot;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new KnotError(`Knot ${i} is not finite: [${x}, ${y}]`);
    }
    if (i > 0) {
      const previous = knots[i - 1] as Knot;
      if (x <= previous[0]) {
        throw new KnotError(
          `Knots must ascend in measurement; knot ${i} (${x}) does not follow ${previous[0]}`,
        );
      }
    }
  }
}

/**
 * Maps a measurement onto the knot set.
 *
 * Throws on a non-finite input rather than returning one. A NaN that
 * survives this becomes a confident wrong score, which is the worst
 * failure this system has - the guard exists at every boundary for the
 * same reason.
 */
export function applyIsotonic(value: number, knots: readonly Knot[]): number {
  assertKnots(knots);

  if (!Number.isFinite(value)) {
    throw new KnotError(`Cannot map a non-finite measurement: ${String(value)}`);
  }

  const first = knots[0] as Knot;
  const last = knots[knots.length - 1] as Knot;

  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];

  for (let i = 1; i < knots.length; i += 1) {
    const [x1, y1] = knots[i] as Knot;
    if (value <= x1) {
      const [x0, y0] = knots[i - 1] as Knot;
      const span = x1 - x0;
      // assertKnots guarantees span > 0.
      return y0 + ((value - x0) / span) * (y1 - y0);
    }
  }

  return last[1];
}
