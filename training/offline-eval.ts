/** Read-only human/VLM agreement for the eligible seed cohort. No fitting. */
import { agreement, confusionMatrix, kendallTau, spearman } from '@pps/eval';

import { loadDatasetFeature, loadHumanLabels, loadManifest } from './dataset.js';
import { loadOfflineLabel } from './offline-label.js';
import type { OfflineAssessment } from './offline-rubric.js';

export const GATE_AXES = ['sharpness', 'lighting', 'resolution', 'framing'] as const;
export type GateAxis = (typeof GATE_AXES)[number];

export interface GatePair {
  readonly image_id: string;
  readonly human: number;
  readonly vlm: number;
  readonly evidence: string;
}

function distribution(values: readonly number[]): Record<string, number> {
  return Object.fromEntries([1, 2, 3, 4, 5].map((level) =>
    [String(level), values.filter((value) => value === level).length]));
}

export function compareGateAxis(axis: GateAxis, pairs: readonly GatePair[]) {
  const human = pairs.map((pair) => pair.human);
  const vlm = pairs.map((pair) => pair.vlm);
  const ranks = spearman(human, vlm);
  const tau = kendallTau(human, vlm);
  const absolute = agreement(vlm, human);
  const confusion = confusionMatrix(axis, human, vlm);
  return {
    paired_n: pairs.length,
    human_distribution: distribution(human),
    vlm_distribution: distribution(vlm),
    spearman: ranks.ok ? ranks.value : null,
    kendall_tau_b: tau.ok ? tau.value : null,
    mae: 'ok' in absolute ? null : absolute.mae,
    exact_agreement: 'ok' in absolute ? null : absolute.exact,
    within_one_agreement: 'ok' in absolute ? null : absolute.withinOne,
    mean_bias_vlm_minus_human: 'ok' in absolute ? null : absolute.bias,
    large_disagreement_count: pairs.filter((pair) => Math.abs(pair.vlm - pair.human) >= 2).length,
    confusion_matrix: 'ok' in confusion ? null : confusion.rows,
  };
}

export function gateAReport(root: string) {
  const seed = loadManifest(root).filter((row) => row.cohort === 'wikimedia_seed_125');
  const human = loadHumanLabels(root).filter((row) => row.source === 'human' &&
    row.cohort === 'wikimedia_seed_125' && GATE_AXES.some((axis) => axis === row.axis));
  const byKey = new Map<string, number>();
  for (const label of human) {
    const key = `${label.image_id}|${label.axis}`;
    if (byKey.has(key)) throw new Error(`ambiguous human seed label: ${key}`);
    byKey.set(key, label.score);
  }
  const excluded = { below_dimension_floor: [] as string[], no_face: [] as string[],
    assessment_missing: [] as string[], vlm_declined: [] as string[] };
  const pairs: Record<GateAxis, GatePair[]> = {
    sharpness: [], lighting: [], resolution: [], framing: [],
  };
  const declineReasons: Record<string, number> = {};
  for (const row of seed) {
    if (row.eligible_for_product_scoring !== true) {
      excluded.below_dimension_floor.push(row.image_id);
      continue;
    }
    const features = loadDatasetFeature(root, row);
    if (features.faceCount === 0) {
      excluded.no_face.push(row.image_id);
      continue;
    }
    const label = loadOfflineLabel(root, row);
    if (label === null) {
      excluded.assessment_missing.push(row.image_id);
      continue;
    }
    if (label.result.status === 'declined') {
      excluded.vlm_declined.push(row.image_id);
      declineReasons[label.result.reason] = (declineReasons[label.result.reason] ?? 0) + 1;
      continue;
    }
    const assessment: OfflineAssessment = label.result.assessment;
    for (const axis of GATE_AXES) {
      const humanScore = byKey.get(`${row.image_id}|${axis}`);
      if (humanScore === undefined) throw new Error(`missing human seed label: ${row.image_id}|${axis}`);
      pairs[axis].push({ image_id: row.image_id, human: humanScore,
        vlm: assessment[axis].score, evidence: assessment[axis].evidence });
    }
  }
  const disagreements = GATE_AXES.flatMap((axis) => pairs[axis]
    .filter((pair) => Math.abs(pair.vlm - pair.human) >= 2)
    .map((pair) => ({ image_id: pair.image_id, axis, human_score: pair.human,
      vlm_score: pair.vlm, difference: pair.vlm - pair.human, evidence: pair.evidence })))
    .sort((a, b) => a.image_id.localeCompare(b.image_id) || a.axis.localeCompare(b.axis));
  return {
    cohort: 'wikimedia_seed_125', seed_images: seed.length,
    eligible_face_images: seed.length - excluded.below_dimension_floor.length - excluded.no_face.length,
    excluded, decline_reasons: declineReasons,
    axes: {
      sharpness: compareGateAxis('sharpness', pairs.sharpness),
      lighting: compareGateAxis('lighting', pairs.lighting),
      resolution: compareGateAxis('resolution', pairs.resolution),
      framing: compareGateAxis('framing', pairs.framing),
    },
    disagreements,
  };
}
