import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRow,
  headerLine,
  indexManifest,
  MANIFEST_COLUMNS,
  PEXELS_LICENCE,
  readManifest,
  splitCsvLine,
  toCsvLine,
  type ManifestRow,
} from './manifest.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pps-manifest-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  dirs.length = 0;
});

function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    sha256: 'a'.repeat(64),
    url: 'https://www.pexels.com/photo/example-12345/',
    sourceUrl: 'https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg',
    licence: PEXELS_LICENCE,
    photographer: 'Ada Lovelace',
    photographerUrl: 'https://www.pexels.com/@ada',
    query: 'professional headshot',
    queryVariant: 'good',
    width: 1880,
    height: 2820,
    file: 'data/images/aaa.jpg',
    ...overrides,
  };
}

describe('CSV escaping', () => {
  it('round-trips a plain row', () => {
    expect(splitCsvLine(toCsvLine(row()))).toEqual(
      MANIFEST_COLUMNS.map((c) => String(row()[c])),
    );
  });

  it('survives a photographer name with a comma', () => {
    const named = row({ photographer: 'Smith, John' });
    const fields = splitCsvLine(toCsvLine(named));
    expect(fields[MANIFEST_COLUMNS.indexOf('photographer')]).toBe('Smith, John');
    expect(fields).toHaveLength(MANIFEST_COLUMNS.length);
  });

  it('doubles an embedded quote and flattens a newline, so one row is one line', () => {
    const odd = row({ photographer: 'The "Real" Ada\nLovelace' });
    const line = toCsvLine(odd);
    expect(line).not.toContain('\n');
    expect(splitCsvLine(line)[MANIFEST_COLUMNS.indexOf('photographer')]).toBe(
      'The "Real" Ada Lovelace',
    );
  });

  it('writes the licence URL on every row, so the file stands alone', () => {
    expect(toCsvLine(row())).toContain('https://www.pexels.com/license/');
  });
});

describe('readManifest', () => {
  it('returns nothing for a file that does not exist', () => {
    expect(readManifest(join(tempDir(), 'nope.csv'))).toEqual({ rows: [], problems: [] });
  });

  it('reads back what appendRow wrote, header and all', () => {
    const path = join(tempDir(), 'sub', 'manifest.csv');
    appendRow(path, row());
    appendRow(path, row({ sha256: 'b'.repeat(64), query: 'car selfie', queryVariant: 'bad' }));

    const contents = readFileSync(path, 'utf8').split('\n');
    expect(contents[0]).toBe(headerLine());

    const loaded = readManifest(path);
    expect(loaded.problems).toEqual([]);
    expect(loaded.rows).toHaveLength(2);
    expect(loaded.rows[0]?.photographer).toBe('Ada Lovelace');
    expect(loaded.rows[1]?.queryVariant).toBe('bad');
    expect(loaded.rows[0]?.width).toBe(1880);
  });

  it('reports a malformed row rather than dropping it silently', () => {
    const path = join(tempDir(), 'manifest.csv');
    writeFileSync(path, `${headerLine()}\n${toCsvLine(row())}\nthree,short,fields\n`, 'utf8');

    const loaded = readManifest(path);
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.problems).toEqual(['line 3: expected 11 fields, found 3']);
  });

  it('reports a row whose dimensions are not numbers', () => {
    const path = join(tempDir(), 'manifest.csv');
    const broken = toCsvLine(row()).replace(',1880,', ',wide,');
    writeFileSync(path, `${headerLine()}\n${broken}\n`, 'utf8');
    expect(readManifest(path).problems[0]).toMatch(/width or height is not a number/);
  });

  it('survives an interrupted write - a half-line is a problem, not a crash', () => {
    const path = join(tempDir(), 'manifest.csv');
    writeFileSync(path, `${headerLine()}\n${toCsvLine(row())}\nabc,def`, 'utf8');
    const loaded = readManifest(path);
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.problems).toHaveLength(1);
  });
});

describe('indexManifest', () => {
  it('indexes both the page URL and the file URL, so resume catches either', () => {
    const index = indexManifest([row()]);
    expect(index.urls.has('https://www.pexels.com/photo/example-12345/')).toBe(true);
    expect(index.urls.has('https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg')).toBe(true);
    expect(index.hashes.has('a'.repeat(64))).toBe(true);
  });

  it('counts what each query already contributed, which is the resume budget', () => {
    const index = indexManifest([
      row(),
      row({ sha256: 'b'.repeat(64) }),
      row({ sha256: 'c'.repeat(64), query: 'car selfie', queryVariant: 'bad' }),
    ]);
    expect(index.perQuery.get('professional headshot')).toBe(2);
    expect(index.perQuery.get('car selfie')).toBe(1);
  });
});
