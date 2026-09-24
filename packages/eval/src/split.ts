/**
 * Splitting a labelled set without inflating the score you get back.
 *
 * Every function here is deterministic and takes no seed. A split that
 * moves between runs cannot be compared between runs, and a "best" model
 * chosen against a moving split is chosen against noise.
 */

import { insufficient, type Insufficient } from './metrics.js';

export interface Split<T> {
  readonly train: readonly T[];
  readonly test: readonly T[];
  /** Cluster ids on each side, so a caller can prove they are disjoint. */
  readonly trainClusters: readonly string[];
  readonly testClusters: readonly string[];
  /** What fraction of items actually landed in train. */
  readonly achievedRatio: number;
}

interface Cluster {
  readonly id: string;
  readonly members: number[];
}

/**
 * Group item indices by cluster, largest first, ties broken by id.
 * Deterministic ordering is the whole basis of a reproducible split.
 */
function clusterize(clusterIds: readonly string[]): Cluster[] {
  const byId = new Map<string, number[]>();
  for (let i = 0; i < clusterIds.length; i += 1) {
    const id = clusterIds[i];
    if (id === undefined) continue;
    const members = byId.get(id);
    if (members === undefined) byId.set(id, [i]);
    else members.push(i);
  }
  return [...byId.entries()]
    .map(([id, members]) => ({ id, members }))
    .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}

/**
 * Split by PERSON, not by image.
 *
 * Two photos of the same person are not near-duplicates - different
 * clothes, different room, different camera - so phashDedup will not
 * catch them. If they straddle the split, the test set contains a face
 * the model was fitted on, and the score comes back higher than anything
 * the model will do in production. Nothing about the run looks wrong.
 *
 * Greedy largest-first: each cluster goes to whichever side is furthest
 * below its target share, so one enormous cluster cannot swallow the
 * test set.
 */
export function splitByCluster<T>(
  items: readonly T[],
  clusterIds: readonly string[],
  ratio: number,
): Split<T> | Insufficient {
  if (items.length !== clusterIds.length) {
    return insufficient('items and clusterIds have different lengths');
  }
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    return insufficient('ratio must be strictly between 0 and 1');
  }

  const clusters = clusterize(clusterIds);
  if (clusters.length < 2) {
    // One cluster cannot be split without putting the same person on
    // both sides, which is the exact thing this function exists to
    // prevent. An empty test set would be worse than an error.
    return insufficient(`need at least two clusters to split, found ${clusters.length}`);
  }

  const total = items.length;
  const trainTarget = total * ratio;
  const testTarget = total * (1 - ratio);

  const trainIndices: number[] = [];
  const testIndices: number[] = [];
  const trainClusters: string[] = [];
  const testClusters: string[] = [];

  for (const cluster of clusters) {
    // Shortfall as a fraction of each side's target, so the comparison
    // is fair when the ratio is lopsided.
    const trainShort = (trainTarget - trainIndices.length) / trainTarget;
    const testShort = (testTarget - testIndices.length) / testTarget;
    if (trainShort >= testShort) {
      trainIndices.push(...cluster.members);
      trainClusters.push(cluster.id);
    } else {
      testIndices.push(...cluster.members);
      testClusters.push(cluster.id);
    }
  }

  // Greedy filling can starve a side when one cluster holds most of the
  // data. Say so rather than returning a split with nothing to test on.
  if (trainIndices.length === 0 || testIndices.length === 0) {
    return insufficient('one side of the split is empty; the clusters are too unbalanced');
  }

  const pick = (indices: readonly number[]): T[] => {
    const out: T[] = [];
    for (const i of indices) {
      const item = items[i];
      if (item !== undefined) out.push(item);
    }
    return out;
  };

  return {
    train: pick(trainIndices),
    test: pick(testIndices),
    trainClusters,
    testClusters,
    achievedRatio: trainIndices.length / total,
  };
}

export interface InnerFold {
  /** Indices to fit on. */
  readonly fit: readonly number[];
  /** Indices to pick hyperparameters against. */
  readonly validate: readonly number[];
}

export interface OuterFold {
  readonly train: readonly number[];
  readonly test: readonly number[];
  readonly inner: readonly InnerFold[];
}

/**
 * Nested cross-validation over clusters.
 *
 * The outer loop gives the honest estimate; the inner loop picks
 * hyperparameters. Doing both on the same folds inflates the reported
 * number by roughly 3-5 points, because the choice of hyperparameter has
 * already seen the data it is being scored against.
 *
 * Folds are cut on cluster boundaries for the same reason splitByCluster
 * is: an index split would put one person on both sides.
 */
export function nestedCV(
  clusterIds: readonly string[],
  kOuter: number,
  kInner: number,
): readonly OuterFold[] | Insufficient {
  if (!Number.isInteger(kOuter) || kOuter < 2) return insufficient('kOuter must be 2 or more');
  if (!Number.isInteger(kInner) || kInner < 2) return insufficient('kInner must be 2 or more');

  const clusters = clusterize(clusterIds);
  if (clusters.length < kOuter) {
    return insufficient(`need at least ${kOuter} clusters for ${kOuter} outer folds, found ${clusters.length}`);
  }
  // Every outer training set loses one fold and must still cut kInner
  // ways, so the requirement is stricter than kOuter alone.
  const smallestTrainFolds = clusters.length - Math.ceil(clusters.length / kOuter);
  if (smallestTrainFolds < kInner) {
    return insufficient(
      `need at least ${kOuter + kInner} clusters for ${kOuter}x${kInner} nested CV, found ${clusters.length}`,
    );
  }

  // Largest-first round robin keeps the folds close to equal in items,
  // not just equal in clusters.
  const assign = (group: readonly Cluster[], k: number): Cluster[][] => {
    const folds: Cluster[][] = Array.from({ length: k }, () => []);
    const sizes = new Array<number>(k).fill(0);
    for (const cluster of group) {
      let smallest = 0;
      for (let f = 1; f < k; f += 1) {
        if ((sizes[f] ?? 0) < (sizes[smallest] ?? 0)) smallest = f;
      }
      folds[smallest]?.push(cluster);
      sizes[smallest] = (sizes[smallest] ?? 0) + cluster.members.length;
    }
    return folds;
  };

  const members = (group: readonly Cluster[]): number[] =>
    group.flatMap((c) => c.members).sort((a, b) => a - b);

  const outerFolds = assign(clusters, kOuter);
  const out: OuterFold[] = [];

  for (let o = 0; o < kOuter; o += 1) {
    const testClusters = outerFolds[o] ?? [];
    const trainClusters = outerFolds.filter((_, i) => i !== o).flat();
    const innerFolds = assign(trainClusters, kInner);
    out.push({
      train: members(trainClusters),
      test: members(testClusters),
      inner: innerFolds.map((validateClusters, i) => ({
        fit: members(innerFolds.filter((_, j) => j !== i).flat()),
        validate: members(validateClusters),
      })),
    });
  }

  return out;
}

export interface DedupResult {
  /** Indices to keep: the lowest-indexed member of each group. */
  readonly keep: readonly number[];
  /** Every group with more than one member, keeper first. */
  readonly groups: readonly (readonly number[])[];
  readonly dropped: number;
}

function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number.parseInt(a[i] ?? '0', 16);
    const y = Number.parseInt(b[i] ?? '0', 16);
    let bits = x ^ y;
    while (bits !== 0) {
      distance += bits & 1;
      bits >>>= 1;
    }
  }
  return distance;
}

/**
 * Single-linkage grouping of perceptual hashes. Run this BEFORE any
 * split: a crop, a resave, or the same photo uploaded twice on either
 * side of the split is a memorised answer, not a prediction.
 *
 * Hashes are hex, all the same length. Single-linkage on purpose - if a
 * is a near-duplicate of b and b of c, all three are the same photograph
 * whatever the distance from a to c says.
 */
export function phashDedup(hashes: readonly string[], threshold: number): DedupResult | Insufficient {
  if (hashes.length === 0) return insufficient('no hashes to deduplicate');
  if (!Number.isInteger(threshold) || threshold < 0) {
    return insufficient('threshold must be a non-negative whole number of bits');
  }

  const width = hashes[0]?.length ?? 0;
  for (const hash of hashes) {
    if (hash.length !== width) return insufficient('hashes have different lengths');
    if (!/^[0-9a-fA-F]+$/.test(hash)) return insufficient(`"${hash}" is not a hex hash`);
  }

  const parent = hashes.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    let walk = i;
    while ((parent[walk] ?? walk) !== root) {
      const next = parent[walk] ?? walk;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  const lower = hashes.map((h) => h.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    for (let j = i + 1; j < lower.length; j += 1) {
      if (hammingDistance(lower[i] ?? '', lower[j] ?? '') > threshold) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < hashes.length; i += 1) {
    const root = find(i);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [i]);
    else group.push(i);
  }

  const groups = [...byRoot.values()].filter((g) => g.length > 1).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  const keep = [...byRoot.keys()].sort((a, b) => a - b);

  return { keep, groups, dropped: hashes.length - keep.length };
}
