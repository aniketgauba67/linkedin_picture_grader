/**
 * Agreement and correlation. Pure arithmetic, no dependencies.
 *
 * These answer "are the scores right", which nothing else in the test
 * suite does: every other test in this repo checks that the code does
 * what it says, not that what it says is correct.
 */

/** A rating that may be absent. Absent is not zero. */
export type Rating = number | null;

export interface Insufficient {
  readonly ok: false;
  readonly reason: string;
}

export interface Measured {
  readonly ok: true;
  readonly value: number;
}

export type Metric = Measured | Insufficient;

export const insufficient = (reason: string): Insufficient => ({ ok: false, reason });
export const measured = (value: number): Measured => ({ ok: true, value });

/** Every unordered pair, skipping holes so no index needs asserting. */
function pairs<T extends object>(items: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const left = items[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      const right = items[j];
      if (right === undefined) continue;
      out.push([left, right]);
    }
  }
  return out;
}

/** Paired observations, holes dropped. Callers length-check first. */
function zip(a: readonly number[], b: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) continue;
    out.push([x, y]);
  }
  return out;
}

/**
 * Krippendorff's alpha, ordinal.
 *
 * `ratings[unit][rater]`, with null for a rating that was never made -
 * the reason to reach for alpha over a simpler coefficient is that it
 * takes missing data and any number of raters without complaint.
 *
 * GET THIS WRONG AND EVERY DOWNSTREAM CONCLUSION IS WRONG. It is the
 * go/no-go on whether an axis is trainable at all, so metrics.test.ts
 * checks it against Krippendorff's own published worked example rather
 * than against whatever this function happens to return.
 *
 * alpha = 1 - (n-1) * (Do / De), both computed from the coincidence
 * matrix. The ordinal difference function weighs a disagreement by how
 * much of the observed distribution lies between the two values, so
 * 1-vs-2 on a crowded scale counts for less than 1-vs-2 on a sparse one.
 */
export function krippendorffAlpha(
  ratings: readonly (readonly Rating[])[],
  level: 'ordinal' = 'ordinal',
): Metric {
  void level;

  // A unit rated once is unpairable and contributes nothing. Dropping it
  // is not the same as scoring it as agreement, which is what happens if
  // you forget.
  const units = ratings
    .map((row) => row.filter((r): r is number => r !== null && Number.isFinite(r)))
    .filter((row) => row.length >= 2);

  if (units.length === 0) {
    return insufficient('no unit has two or more ratings');
  }

  const values = [...new Set(units.flat())].sort((a, b) => a - b);
  if (values.length < 2) {
    // Every rater gave the same value everywhere. De is zero and alpha
    // is undefined; reporting 1.0 would claim perfect reliability from a
    // dataset with no variance to disagree about.
    return insufficient('every rating is identical, so alpha is undefined');
  }

  const index = new Map(values.map((v, i) => [v, i]));
  const size = values.length;

  // Coincidence matrix, flat. A typed array both indexes without holes
  // and keeps the accumulation in one buffer.
  const coincidence = new Float64Array(size * size);
  for (const unit of units) {
    // 1/(m-1) so a heavily rated unit cannot dominate the matrix.
    const weight = 1 / (unit.length - 1);
    const counts = new Map<number, number>();
    for (const v of unit) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [a, countA] of counts) {
      const i = index.get(a) ?? 0;
      for (const [b, countB] of counts) {
        const j = index.get(b) ?? 0;
        // Ordered pairs drawn without replacement: a value seen twice
        // pairs with itself, a value seen once does not.
        const ordered = a === b ? countA * (countA - 1) : countA * countB;
        const cell = i * size + j;
        coincidence[cell] = (coincidence[cell] ?? 0) + ordered * weight;
      }
    }
  }

  const marginal = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    let row = 0;
    for (let j = 0; j < size; j += 1) row += coincidence[i * size + j] ?? 0;
    marginal[i] = row;
  }
  let n = 0;
  for (let i = 0; i < size; i += 1) n += marginal[i] ?? 0;
  if (n < 2) {
    return insufficient('fewer than two pairable ratings');
  }

  // Ordinal delta: the mass spanned between the two values, less half of
  // each endpoint, squared.
  const delta2 = (i: number, j: number): number => {
    if (i === j) return 0;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    let span = 0;
    for (let g = lo; g <= hi; g += 1) span += marginal[g] ?? 0;
    const corrected = span - ((marginal[lo] ?? 0) + (marginal[hi] ?? 0)) / 2;
    return corrected * corrected;
  };

  let observed = 0;
  let expected = 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      const d = delta2(i, j);
      observed += (coincidence[i * size + j] ?? 0) * d;
      expected += (marginal[i] ?? 0) * (marginal[j] ?? 0) * d;
    }
  }

  if (expected === 0) {
    return insufficient('expected disagreement is zero, so alpha is undefined');
  }

  return measured(1 - (n - 1) * (observed / expected));
}

/** What an alpha means for whether an axis can be trained at all. */
export type AlphaVerdict = 'ship' | 'rewrite-anchors' | 'do-not-train';

export function alphaVerdict(alpha: number): AlphaVerdict {
  if (alpha >= 0.8) return 'ship';
  if (alpha >= 0.65) return 'rewrite-anchors';
  return 'do-not-train';
}

/** Average ranks for ties, which on a 1-5 scale are the common case. */
function ranksOf(values: readonly number[]): number[] {
  const order = values
    .map((value, position) => ({ value, position }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);

  let i = 0;
  while (i < order.length) {
    const first = order[i];
    if (first === undefined) break;
    let j = i;
    for (;;) {
      const next = order[j + 1];
      if (next === undefined || next.value !== first.value) break;
      j += 1;
    }
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = order[k];
      if (entry !== undefined) ranks[entry.position] = shared;
    }
    i = j + 1;
  }
  return ranks;
}

function pearson(a: readonly number[], b: readonly number[]): Metric {
  const observations = zip(a, b);
  const n = observations.length;
  if (n < 2) return insufficient('need at least two paired observations');

  const meanA = observations.reduce((s, [x]) => s + x, 0) / n;
  const meanB = observations.reduce((s, [, y]) => s + y, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [x, y] of observations) {
    const dx = x - meanA;
    const dy = y - meanB;
    covariance += dx * dy;
    varianceA += dx * dx;
    varianceB += dy * dy;
  }
  if (varianceA === 0 || varianceB === 0) {
    return insufficient('one series has no variance, so correlation is undefined');
  }
  return measured(covariance / Math.sqrt(varianceA * varianceB));
}

/** Spearman's rho: Pearson over average-tied ranks. */
export function spearman(a: readonly number[], b: readonly number[]): Metric {
  if (a.length !== b.length) return insufficient('series have different lengths');
  if (a.length < 2) return insufficient('need at least two paired observations');
  return pearson(ranksOf(a), ranksOf(b));
}

/**
 * Kendall's tau-b. Tau-b rather than tau-a because a 1-5 scale produces
 * ties constantly, and tau-a treats a tie as a half-wrong answer.
 */
export function kendallTau(a: readonly number[], b: readonly number[]): Metric {
  if (a.length !== b.length) return insufficient('series have different lengths');
  if (a.length < 2) return insufficient('need at least two paired observations');

  let concordant = 0;
  let discordant = 0;
  let tiedA = 0;
  let tiedB = 0;

  for (const [left, right] of pairs(zip(a, b))) {
    const da = left[0] - right[0];
    const db = left[1] - right[1];
    if (da === 0 && db === 0) continue;
    if (da === 0) tiedA += 1;
    else if (db === 0) tiedB += 1;
    else if (Math.sign(da) === Math.sign(db)) concordant += 1;
    else discordant += 1;
  }

  const denominator = Math.sqrt(
    (concordant + discordant + tiedA) * (concordant + discordant + tiedB),
  );
  if (denominator === 0) return insufficient('no untied pairs to compare');
  return measured((concordant - discordant) / denominator);
}

export interface Agreement {
  readonly exact: number;
  readonly withinOne: number;
  readonly mae: number;
  /** Signed. Positive means the model scores higher than the human. */
  readonly bias: number;
  readonly n: number;
}

/**
 * Bias is reported separately from MAE on purpose. A model that is
 * uniformly half a point generous has a real MAE and a real bias, and
 * only the bias is fixable by moving an intercept.
 */
export function agreement(
  model: readonly number[],
  human: readonly number[],
): Agreement | Insufficient {
  if (model.length !== human.length) return insufficient('series have different lengths');
  const observations = zip(model, human);
  const n = observations.length;
  if (n === 0) return insufficient('no paired ratings');

  let exact = 0;
  let close = 0;
  let absolute = 0;
  let signed = 0;
  for (const [m, h] of observations) {
    const d = m - h;
    if (d === 0) exact += 1;
    if (Math.abs(d) <= 1) close += 1;
    absolute += Math.abs(d);
    signed += d;
  }
  return { exact: exact / n, withinOne: close / n, mae: absolute / n, bias: signed / n, n };
}

const component = (key: keyof Omit<Agreement, 'n'>) =>
  (model: readonly number[], human: readonly number[]): Metric => {
    const result = agreement(model, human);
    return 'ok' in result ? result : measured(result[key]);
  };

export const exactAgreement = component('exact');
export const withinOne = component('withinOne');
export const mae = component('mae');
export const bias = component('bias');

/**
 * Of the pairs the reference ranked strictly, the fraction this model
 * ranks the same way.
 *
 * THIS IS THE HEADLINE NUMBER, not MSE. The product exists to put a
 * better photograph above a worse one. Being uniformly half a point low
 * costs a user nothing and costs MSE a great deal, and a model that
 * nails the mean while shuffling the order is useless.
 *
 * Pairs the reference tied are excluded - they carry no ordering to
 * reproduce. A model tie on a pair the reference ordered scores half:
 * it is not wrong about the direction, it just failed to express one.
 */
export function pairwiseAccuracy(scores: readonly number[], truth: readonly number[]): Metric {
  if (scores.length !== truth.length) return insufficient('series have different lengths');
  if (scores.length < 2) return insufficient('need at least two items to form a pair');

  let comparable = 0;
  let correct = 0;
  for (const [left, right] of pairs(zip(scores, truth))) {
    const reference = left[1] - right[1];
    if (reference === 0) continue;
    comparable += 1;
    const predicted = left[0] - right[0];
    if (predicted === 0) correct += 0.5;
    else if (Math.sign(predicted) === Math.sign(reference)) correct += 1;
  }

  if (comparable === 0) return insufficient('the reference ranks every item equally');
  return measured(correct / comparable);
}
