import { describe, expect, it } from 'vitest';

import { alignById, parseLabelsJsonl, ratingsByUnit } from './labels.js';

describe('parseLabelsJsonl', () => {
  it('reads a well-formed file', () => {
    const parsed = parseLabelsJsonl(
      [
        '{"id":"p1","clusterId":"ana","rater":"r1","axes":{"background":4,"attire":3},"composite":7}',
        '{"id":"p2","axes":{"background":2}}',
      ].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.axes).toEqual(['attire', 'background']);
    expect(parsed.records[0]?.clusterId).toBe('ana');
    expect(parsed.records[0]?.composite).toBe(7);
    // Absent, not present-and-undefined: exactOptionalPropertyTypes.
    expect('composite' in (parsed.records[1] ?? {})).toBe(false);
  });

  it('tolerates blank lines and trailing whitespace', () => {
    const parsed = parseLabelsJsonl('\n  {"id":"p1","axes":{"a":1}}  \n\n');
    expect(parsed.problems).toEqual([]);
    expect(parsed.records).toHaveLength(1);
  });

  it('keeps the good lines when one line is broken', () => {
    const parsed = parseLabelsJsonl(
      ['{"id":"p1","axes":{"a":1}}', '{"id":"p2",,,}', '{"id":"p3","axes":{"a":3}}'].join('\n'),
    );
    expect(parsed.records.map((r) => r.id)).toEqual(['p1', 'p3']);
    expect(parsed.problems).toEqual(['line 2: not valid JSON']);
  });

  it('names the trailing comma, which is what people actually type', () => {
    const parsed = parseLabelsJsonl('{"id":"p1","axes":{"a":1}},');
    expect(parsed.problems[0]).toMatch(/trailing comma/);
  });

  it('rejects a record rather than scoring a NaN', () => {
    const parsed = parseLabelsJsonl(
      [
        '{"id":"p1","axes":{"a":"four"}}',
        '{"id":"p2","axes":{}}',
        '{"id":"p3"}',
        '{"id":"","axes":{"a":1}}',
        '["not","an","object"]',
      ].join('\n'),
    );
    expect(parsed.records).toEqual([]);
    expect(parsed.problems).toEqual([
      'line 1 (p1): axes.a is not a finite number',
      'line 2 (p2): axes object is empty',
      'line 3 (p3): missing an axes object',
      'line 4: missing a non-empty string id',
      'line 5: expected an object',
    ]);
  });

  it('returns empty rather than throwing on an empty file', () => {
    const parsed = parseLabelsJsonl('');
    expect(parsed.records).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.axes).toEqual([]);
  });
});

describe('alignById', () => {
  const a = parseLabelsJsonl(
    ['{"id":"p1","axes":{"x":1,"y":2}}', '{"id":"p2","axes":{"x":3}}', '{"id":"only-a","axes":{"x":5}}'].join('\n'),
  ).records;
  const b = parseLabelsJsonl(
    ['{"id":"p2","axes":{"x":4}}', '{"id":"p1","axes":{"x":2,"y":5}}', '{"id":"only-b","axes":{"x":1}}'].join('\n'),
  ).records;

  it('pairs by id regardless of file order', () => {
    const aligned = alignById(a, b);
    const x = aligned.axes.find((axis) => axis.axis === 'x');
    expect(x?.ids).toEqual(['p1', 'p2']);
    expect(x?.a).toEqual([1, 3]);
    expect(x?.b).toEqual([2, 4]);
  });

  it('drops an axis one side never rated rather than pairing it with zero', () => {
    const aligned = alignById(a, b);
    const y = aligned.axes.find((axis) => axis.axis === 'y');
    expect(y?.ids).toEqual(['p1']);
    expect(y?.a).toEqual([2]);
    expect(y?.b).toEqual([5]);
  });

  it('reports the ids that appear on one side only', () => {
    const aligned = alignById(a, b);
    expect(aligned.onlyInA).toEqual(['only-a']);
    expect(aligned.onlyInB).toEqual(['only-b']);
  });

  it('returns no axes when nothing overlaps', () => {
    expect(alignById(a, []).axes).toEqual([]);
  });
});

describe('ratingsByUnit', () => {
  it('shapes ratings as units x raters with holes for what a rater never saw', () => {
    const records = parseLabelsJsonl(
      [
        '{"id":"p1","rater":"ana","axes":{"x":1}}',
        '{"id":"p1","rater":"ben","axes":{"x":2}}',
        '{"id":"p2","rater":"ana","axes":{"x":3}}',
      ].join('\n'),
    ).records;

    // Raters sort to [ana, ben]; p2 was never shown to ben.
    expect(ratingsByUnit(records, 'x')).toEqual([
      [1, 2],
      [3, null],
    ]);
  });

  it('skips records that do not rate the axis at all', () => {
    const records = parseLabelsJsonl(
      ['{"id":"p1","rater":"ana","axes":{"x":1}}', '{"id":"p2","rater":"ana","axes":{"y":4}}'].join('\n'),
    ).records;
    expect(ratingsByUnit(records, 'x')).toEqual([[1]]);
  });

  it('treats an unnamed rater as one rater, not as many', () => {
    const records = parseLabelsJsonl(
      ['{"id":"p1","axes":{"x":1}}', '{"id":"p2","axes":{"x":4}}'].join('\n'),
    ).records;
    expect(ratingsByUnit(records, 'x')).toEqual([[1], [4]]);
  });
});
