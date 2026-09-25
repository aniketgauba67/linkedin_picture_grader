import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { MODEL, SYSTEM_PROMPT } from '@pps/features';

import { buildOfflineRequest, judgeOfflineEight } from './offline-judge.js';
import { compareGateAxis } from './offline-eval.js';
import { OFFLINE_AXES, OFFLINE_MODEL, OFFLINE_RUBRIC_FINGERPRINT, OFFLINE_RUBRIC_VERSION,
  OFFLINE_SYSTEM_PROMPT, OfflineAssessment, parseOfflineReply } from './offline-rubric.js';

const portrait = readFileSync(new URL('../packages/features/fixtures/portrait.jpg', import.meta.url));
const axis = { score: 3, evidence: 'Visible photographic detail remains readable.' };
const assessment = OfflineAssessment.parse({
  sharpness: axis, lighting: axis, resolution: axis, framing: axis,
  background: axis, attire: axis, expression: axis, solo: axis,
  framing_observation: { crop: 'head_and_shoulders', face_roughly_centered: true },
});

describe('offline eight-axis rubric', () => {
  it('keeps the production semantic anchors while adding four offline-only axes', () => {
    expect(OFFLINE_AXES).toHaveLength(8);
    expect(OFFLINE_SYSTEM_PROMPT).toContain(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('## Method\n')));
    expect(OFFLINE_SYSTEM_PROMPT).toContain('### SHARPNESS');
    expect(OFFLINE_SYSTEM_PROMPT).not.toContain('apparent_minor');
    expect(OFFLINE_MODEL).toBe(MODEL);
    expect(OFFLINE_RUBRIC_VERSION).toBe('offline-eight-v2');
    expect(OFFLINE_RUBRIC_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sends exact oriented dimensions and rejects inconsistent or invented output', () => {
    const request = buildOfflineRequest('base64', 640, 800);
    expect(request.messages[0]?.content[1]?.text).toContain('640 × 800');
    expect(request.output_config.format.schema.properties.assessment.required).toContain('sharpness');
    expect(parseOfflineReply(JSON.stringify({ status: 'assessed', assessment, reason: null, detail: null })))
      .toEqual({ status: 'assessed', assessment });
    expect(() => parseOfflineReply(JSON.stringify({ status: 'assessed', assessment: null,
      reason: null, detail: null }))).toThrow();
    expect(() => parseOfflineReply(JSON.stringify({ status: 'assessed', assessment: { ...assessment, age: 30 },
      reason: null, detail: null }))).toThrow();
    expect(() => parseOfflineReply(JSON.stringify({ status: 'assessed',
      assessment: { ...assessment, attire: { score: 4, evidence: 'A man wears a dark jacket over a white shirt.' } },
      reason: null, detail: null }))).toThrow(/personal trait/);
  });

  it('preserves API refusal as a decline without fabricating axis scores', async () => {
    const send = vi.fn(async () => ({ stop_reason: 'refusal', content: [] }));
    expect(await judgeOfflineEight(portrait, 600, 750, { send })).toEqual({
      status: 'declined', reason: 'model_refusal', detail: '',
    });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('Gate A arithmetic', () => {
  it('reports per-axis distributions, signed bias and all large disagreements', () => {
    const pairs = [
      { image_id: 'A', human: 1, vlm: 1, evidence: 'Visible detail.' },
      { image_id: 'B', human: 2, vlm: 3, evidence: 'Visible detail.' },
      { image_id: 'C', human: 3, vlm: 5, evidence: 'Visible detail.' },
      { image_id: 'D', human: 4, vlm: 4, evidence: 'Visible detail.' },
      { image_id: 'E', human: 5, vlm: 5, evidence: 'Visible detail.' },
    ];
    const report = compareGateAxis('sharpness', pairs);
    expect(report.paired_n).toBe(5);
    expect(report.human_distribution).toEqual({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 });
    expect(report.vlm_distribution).toEqual({ '1': 1, '2': 0, '3': 1, '4': 1, '5': 2 });
    expect(report.mae).toBe(0.6);
    expect(report.mean_bias_vlm_minus_human).toBe(0.6);
    expect(report.large_disagreement_count).toBe(1);
    expect(report.confusion_matrix?.[2]?.[4]).toBe(1);
  });
});
