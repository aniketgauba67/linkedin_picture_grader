import { describe, expect, it } from 'vitest';

import { runCli, type ReadTextFile } from './cli.js';

/** The CLI takes its reader as an argument, so no test touches a disk. */
function files(map: Readonly<Record<string, string>>): ReadTextFile {
  return (path: string) => {
    const content = map[path];
    if (content === undefined) throw new Error('ENOENT: no such file or directory');
    return content;
  };
}

function jsonl(records: readonly unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/** Forty labels, two raters, the size this actually runs on first. */
function labelSet(rater: string, skew = 0): unknown[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `p${i}`,
    clusterId: `person-${Math.floor(i / 2)}`,
    rater,
    axes: {
      background: 1 + ((i + skew) % 5),
      attire: 1 + ((i * 2 + skew) % 5),
      solo: 5,
    },
    composite: 1 + (i % 10),
  }));
}

describe('runCli', () => {
  it('prints usage and exits clean with no arguments', () => {
    const result = runCli([], files({}));
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/pps-eval report/);
  });

  it('exits 2 on an unknown command or a wrong argument count', () => {
    expect(runCli(['nonsense'], files({})).code).toBe(2);
    expect(runCli(['report'], files({})).code).toBe(2);
    expect(runCli(['agreement', 'a.jsonl'], files({})).code).toBe(2);
    expect(runCli(['ceiling', 'a.jsonl'], files({})).code).toBe(2);
  });

  it('exits 2 and names the file it could not read', () => {
    const result = runCli(['report', 'missing.jsonl'], files({}));
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/cannot read missing\.jsonl/);
  });
});

describe('runCli report', () => {
  it('reports distributions, the histogram and variance on 40 labels', () => {
    const result = runCli(
      ['report', 'labels.jsonl'],
      files({ 'labels.jsonl': jsonl(labelSet('ana')) }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/labels\.jsonl: 40 record\(s\)/);
    expect(result.output).toMatch(/axis distributions/);
    // solo is 5 on every photo: collapsed, and it should say so.
    expect(result.output).toMatch(/level 5 holds 100\.0% of ratings/);
    expect(result.output).toMatch(/composite/);
    expect(result.output).toMatch(/variance contribution/);
    expect(result.output).toMatch(/weights: equal/);
    // A constant axis contributes nothing however it is weighted.
    expect(result.output).toMatch(/solo.*dead weight/);
  });

  it('says insufficient data for alpha when the file has one rater', () => {
    const result = runCli(
      ['report', 'labels.jsonl'],
      files({ 'labels.jsonl': jsonl(labelSet('ana')) }),
    );
    expect(result.output).toMatch(/insufficient data for alpha \(one rater/);
  });

  it('computes alpha per axis when the file has two', () => {
    const result = runCli(
      ['report', 'labels.jsonl'],
      files({ 'labels.jsonl': jsonl([...labelSet('ana'), ...labelSet('ben', 1)]) }),
    );
    expect(result.output).toMatch(/2 raters: ana, ben/);
    expect(result.output).toMatch(/background\s+alpha -?\d\.\d{3}\s+(ship|rewrite-anchors|do-not-train)/);
  });

  it('prints each section as insufficient rather than throwing on one thin record', () => {
    const result = runCli(
      ['report', 'labels.jsonl'],
      files({ 'labels.jsonl': jsonl([{ id: 'p1', axes: { background: 4 } }]) }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/only 1 ratings/);
    expect(result.output).toMatch(/insufficient data for the composite histogram/);
    expect(result.output).toMatch(/insufficient data for variance contribution/);
  });

  it('reports the skipped lines instead of quietly halving the sample', () => {
    const result = runCli(
      ['report', 'labels.jsonl'],
      files({ 'labels.jsonl': `${jsonl(labelSet('ana'))}\n{"id":"broken"` }),
    );
    expect(result.output).toMatch(/skipped line 41: not valid JSON/);
  });

  it('exits 1 when nothing in the file parsed', () => {
    const result = runCli(['report', 'labels.jsonl'], files({ 'labels.jsonl': 'garbage\n' }));
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no usable records/);
  });
});

describe('runCli agreement', () => {
  const a = jsonl(labelSet('ana'));
  const b = jsonl(labelSet('ben', 1));

  it('prints agreement, correlation, alpha and a confusion matrix per axis', () => {
    const result = runCli(['agreement', 'a.jsonl', 'b.jsonl'], files({ 'a.jsonl': a, 'b.jsonl': b }));
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/exact\s+\d\.\d{3}/);
    expect(result.output).toMatch(/within one\s+\d\.\d{3}/);
    expect(result.output).toMatch(/mae\s+\d\.\d{3}/);
    expect(result.output).toMatch(/bias \(b - a\)\s+[+-]\d\.\d{3}/);
    expect(result.output).toMatch(/spearman/);
    expect(result.output).toMatch(/kendall tau-b/);
    expect(result.output).toMatch(/pairwise accuracy/);
    expect(result.output).toMatch(/human \(rows\) vs model \(columns\)/);
  });

  it('is exact when a file is compared with itself', () => {
    const result = runCli(['agreement', 'a.jsonl', 'same.jsonl'], files({ 'a.jsonl': a, 'same.jsonl': a }));
    expect(result.output).toMatch(/exact\s+1\.000/);
    expect(result.output).toMatch(/mae\s+0\.000/);
  });

  it('says how many ids it had to drop', () => {
    const shortB = jsonl(labelSet('ben').slice(0, 30));
    const result = runCli(['agreement', 'a.jsonl', 'b.jsonl'], files({ 'a.jsonl': a, 'b.jsonl': shortB }));
    expect(result.output).toMatch(/10 id\(s\) only in a\.jsonl/);
  });

  it('exits 1 when the two files share no ids', () => {
    const other = jsonl([{ id: 'zzz', axes: { background: 1 } }]);
    const result = runCli(['agreement', 'a.jsonl', 'b.jsonl'], files({ 'a.jsonl': a, 'b.jsonl': other }));
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no id appears in both files/);
  });
});

describe('runCli ceiling', () => {
  const human = jsonl([...labelSet('ana'), ...labelSet('ben', 1)]);
  const model = jsonl(labelSet('model', 2));

  it('charts the model against the ceiling', () => {
    const result = runCli(
      ['ceiling', 'human.jsonl', 'model.jsonl'],
      files({ 'human.jsonl': human, 'model.jsonl': model }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/# = model accuracy/);
    expect(result.output).toMatch(/\| = human agreement/);
    expect(result.output).toMatch(/ceiling = every rater against every other \(2 raters\)/);
  });

  it('states that both numbers are the same statistic, because otherwise the chart lies', () => {
    const result = runCli(
      ['ceiling', 'human.jsonl', 'model.jsonl'],
      files({ 'human.jsonl': human, 'model.jsonl': model }),
    );
    expect(result.output).toMatch(/Both are pairwise accuracy/);
  });

  it('refuses to invent a ceiling from a single rater', () => {
    const result = runCli(
      ['ceiling', 'human.jsonl', 'model.jsonl'],
      files({ 'human.jsonl': jsonl(labelSet('ana')), 'model.jsonl': model }),
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/the human file has one rater/);
    expect(result.output).toMatch(/Label a subset twice/);
  });

  it('names the axes the model never rated rather than charting them at zero', () => {
    const partial = jsonl(
      labelSet('model', 2).map((r) => {
        const record = r as { id: string; axes: Record<string, number> };
        return { id: record.id, axes: { background: record.axes['background'] ?? 1 } };
      }),
    );
    const result = runCli(
      ['ceiling', 'human.jsonl', 'model.jsonl'],
      files({ 'human.jsonl': human, 'model.jsonl': partial }),
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/background/);
    expect(result.output).not.toMatch(/\battire\s+\[/);
  });
});

describe('runCli overlap', () => {
  const withOverlap = (n: number, f: (s: number) => number) => {
    const older: unknown[] = [];
    const newer: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const score = (i % 5) + 1;
      older.push({ id: `p${i}`, axes: { framing: score } });
      newer.push({ id: `p${i}`, axes: { framing: f(score) } });
    }
    return { 'old.jsonl': jsonl(older), 'new.jsonl': jsonl(newer) };
  };

  it('exits 0 when the two passes agree', () => {
    const result = runCli(['overlap', 'old.jsonl', 'new.jsonl'], files(withOverlap(25, (s) => s)));
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Every axis agrees/);
  });

  it('exits 2 and refuses the merge when the passes disagree on order', () => {
    const result = runCli(['overlap', 'old.jsonl', 'new.jsonl'], files(withOverlap(30, (s) => 6 - s)));
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/BLOCKED on 1 axis/);
    expect(result.output).toMatch(/Do not merge these passes/);
  });

  it('exits 2 when the passes share no images at all', () => {
    const a = jsonl(Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, axes: { framing: (i % 5) + 1 } })));
    const b = jsonl(Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, axes: { framing: (i % 5) + 1 } })));
    const result = runCli(['overlap', 'old.jsonl', 'new.jsonl'], files({ 'old.jsonl': a, 'new.jsonl': b }));
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/shared images\s+0/);
  });

  it('refuses a scale shift until it is explicitly acknowledged', () => {
    const result = runCli(
      ['overlap', 'old.jsonl', 'new.jsonl'],
      files(withOverlap(30, (s) => Math.max(1, s - 2))),
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/SCALE SHIFT/);
    expect(result.output).toMatch(/--accept-offset/);
  });

  it('prints both medians and the shift, not just an adjective', () => {
    const result = runCli(
      ['overlap', 'old.jsonl', 'new.jsonl'],
      files(withOverlap(30, (s) => Math.max(1, s - 2))),
    );
    expect(result.output).toMatch(/old\.jsonl median \d\.\d{2}/);
    expect(result.output).toMatch(/new\.jsonl median \d\.\d{2}/);
    expect(result.output).toMatch(/shift -\d\.\d{2} points over 30 shared images/);
  });

  it('proceeds at exit 1 once the shift is acknowledged with a reason', () => {
    const result = runCli(
      [
        'overlap',
        'old.jsonl',
        'new.jsonl',
        '--accept-offset',
        'Second pass anchored low against a thumbnail corpus; rescaling by the median shift.',
      ],
      files(withOverlap(30, (s) => Math.max(1, s - 2))),
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/SCALE SHIFT on framing, ACCEPTED/);
    expect(result.output).toMatch(/agree anchor scores before the next pass/);
  });

  it('rejects an acknowledgement too short to be an argument', () => {
    const result = runCli(
      ['overlap', 'old.jsonl', 'new.jsonl', '--accept-offset', 'fine'],
      files(withOverlap(30, (s) => Math.max(1, s - 2))),
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/at least 30 characters/);
  });

  it('does not let --accept-offset past a genuine block', () => {
    // Disagreeing rank order is not a shift and cannot be rescaled.
    const result = runCli(
      [
        'overlap',
        'old.jsonl',
        'new.jsonl',
        '--accept-offset',
        'I would like to merge these two passes regardless of what the check says.',
      ],
      files(withOverlap(30, (s) => 6 - s)),
    );
    expect(result.code).toBe(2);
    expect(result.output).toMatch(/BLOCKED/);
  });

  it('is listed in the usage, so it cannot be missed', () => {
    expect(runCli([], files({})).output).toMatch(/overlap.*MUST PASS BEFORE MERGING/);
  });
});
