import { describe, expect, it } from 'vitest';

import { ceilingVerdict, renderCeiling, reportCeiling } from './ceiling.js';

describe('ceilingVerdict', () => {
  it('leaves headroom while the model is clearly below human agreement', () => {
    expect(ceilingVerdict(0.78, 0.61)).toBe('headroom');
  });

  it('calls it done once the model is within the margin of the ceiling', () => {
    expect(ceilingVerdict(0.78, 0.77)).toBe('at-ceiling');
    expect(ceilingVerdict(0.78, 0.78)).toBe('at-ceiling');
    expect(ceilingVerdict(0.78, 0.8)).toBe('at-ceiling');
  });

  it('flags a score above the ceiling, which a clean split cannot produce', () => {
    expect(ceilingVerdict(0.78, 0.93)).toBe('above-ceiling');
  });

  it('respects a caller-supplied margin', () => {
    expect(ceilingVerdict(0.78, 0.7, 0.1)).toBe('at-ceiling');
    expect(ceilingVerdict(0.78, 0.7, 0.01)).toBe('headroom');
  });
});

describe('reportCeiling', () => {
  const human = { background: 0.81, attire: 0.74, expression: 0.62 };
  const model = { background: 0.66, attire: 0.735, expression: 0.88 };

  it('computes headroom and the fraction of the ceiling reached', () => {
    const report = reportCeiling(human, model);
    if ('ok' in report) throw new Error(report.reason);

    const background = report.rows.find((r) => r.axis === 'background');
    expect(background?.headroom).toBeCloseTo(0.15, 12);
    expect(background?.fractionOfCeiling).toBeCloseTo(0.66 / 0.81, 12);
    expect(background?.verdict).toBe('headroom');

    expect(report.rows.find((r) => r.axis === 'attire')?.verdict).toBe('at-ceiling');
    expect(report.rows.find((r) => r.axis === 'expression')?.verdict).toBe('above-ceiling');
  });

  it('never divides by a zero ceiling', () => {
    const report = reportCeiling({ solo: 0 }, { solo: 0.5 });
    if ('ok' in report) throw new Error(report.reason);
    expect(report.rows[0]?.fractionOfCeiling).toBe(0);
    expect(Number.isFinite(report.rows[0]?.fractionOfCeiling ?? Number.NaN)).toBe(true);
  });

  it('lists axes that appear on only one side instead of comparing them to nothing', () => {
    const report = reportCeiling({ a: 0.7, b: 0.7 }, { a: 0.6, c: 0.6 });
    if ('ok' in report) throw new Error(report.reason);
    expect(report.rows.map((r) => r.axis)).toEqual(['a']);
    expect(report.unmatched).toEqual(['b', 'c']);
  });

  it('reports insufficient data rather than throwing on empty or disjoint input', () => {
    const noHuman = reportCeiling({}, { a: 1 });
    if (!('ok' in noHuman)) throw new Error('expected insufficient');
    expect(noHuman.reason).toMatch(/no human agreement/);

    const noModel = reportCeiling({ a: 1 }, {});
    if (!('ok' in noModel)) throw new Error('expected insufficient');
    expect(noModel.reason).toMatch(/no model accuracy/);

    const disjoint = reportCeiling({ a: 1 }, { b: 1 });
    if (!('ok' in disjoint)) throw new Error('expected insufficient');
    expect(disjoint.reason).toMatch(/no axis appears in both/);
  });
});

describe('renderCeiling', () => {
  const report = reportCeiling(
    { background: 0.81, attire: 0.74, expression: 0.62 },
    { background: 0.66, attire: 0.735, expression: 0.88 },
  );

  it('prints both series on one chart', () => {
    if ('ok' in report) throw new Error(report.reason);
    const text = renderCeiling(report);
    expect(text).toMatch(/# = model accuracy/);
    expect(text).toMatch(/\| = human agreement/);
    for (const line of text.split('\n').filter((l) => l.includes('['))) {
      // Both marks share one axis, or the comparison is decoration.
      expect(line).toMatch(/\|/);
    }
  });

  it('puts the ceiling marker to the right of the bar when there is headroom', () => {
    if ('ok' in report) throw new Error(report.reason);
    const line = renderCeiling(report)
      .split('\n')
      .find((l) => l.startsWith('  background'));
    const chart = line?.slice(line.indexOf('[') + 1, line.indexOf(']')) ?? '';
    expect(chart.indexOf('|')).toBeGreaterThan(chart.lastIndexOf('#'));
  });

  it('tells you to stop on an axis that reached the ceiling', () => {
    if ('ok' in report) throw new Error(report.reason);
    expect(renderCeiling(report)).toMatch(/attire: training is done/);
  });

  it('refuses to congratulate a score above the ceiling', () => {
    if ('ok' in report) throw new Error(report.reason);
    const text = renderCeiling(report);
    expect(text).toMatch(/expression scored above the ceiling/);
    expect(text).toMatch(/Do not report these numbers/);
  });

  it('names the axes it could not chart', () => {
    const partial = reportCeiling({ a: 0.7, b: 0.7 }, { a: 0.6 });
    if ('ok' in partial) throw new Error(partial.reason);
    expect(renderCeiling(partial)).toMatch(/insufficient data for: b/);
  });
});
