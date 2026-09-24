/**
 * data/manifest.csv - the provenance record, and the resume state.
 *
 * This is the one file under data/ that IS committed. It holds no
 * pixels: it says where every image came from, under what licence, who
 * took it, and what query surfaced it. A corpus without it is a folder
 * of images nobody can prove the rights to.
 *
 * It is also how the collector resumes. Rows are keyed twice - by URL, so
 * a re-run does not re-download, and by sha256, so the same photograph
 * reached through two different queries is stored once.
 *
 * CSV is written by hand because the alternative is a dependency, and the
 * escaping rules for the four fields that can contain a comma are eleven
 * lines. Anything a spreadsheet would mangle gets quoted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { QueryVariant } from './queries.js';

export interface ManifestRow {
  readonly sha256: string;
  /** The Pexels page for the photo, which is where the licence lives. */
  readonly url: string;
  /** The file actually fetched, so a re-download is reproducible. */
  readonly sourceUrl: string;
  readonly licence: string;
  readonly photographer: string;
  readonly photographerUrl: string;
  readonly query: string;
  readonly queryVariant: QueryVariant;
  /** As measured by extraction, not as claimed by the API. */
  readonly width: number;
  readonly height: number;
  readonly file: string;
}

export const MANIFEST_COLUMNS: readonly (keyof ManifestRow)[] = [
  'sha256',
  'url',
  'sourceUrl',
  'licence',
  'photographer',
  'photographerUrl',
  'query',
  'queryVariant',
  'width',
  'height',
  'file',
];

/** Every Pexels photo carries the same licence; recorded per row so the
 *  manifest stands alone if the corpus ever mixes sources. */
export const PEXELS_LICENCE = 'Pexels License (https://www.pexels.com/license/)';

/**
 * Quote what needs quoting, and flatten newlines to spaces first.
 *
 * `readManifest` splits on newlines before parsing fields, so a real
 * embedded newline would produce a file this module cannot read back -
 * a manifest that only writes is worse than one that rejects the
 * character. A photographer name does not need line breaks.
 */
function escape(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

export function toCsvLine(row: ManifestRow): string {
  return MANIFEST_COLUMNS.map((column) => escape(String(row[column]))).join(',');
}

export function headerLine(): string {
  return MANIFEST_COLUMNS.join(',');
}

/** Split one CSV line, honouring quotes and doubled quotes inside them. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char ?? '';
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char ?? '';
    }
  }
  fields.push(current);
  return fields;
}

export interface LoadedManifest {
  readonly rows: readonly ManifestRow[];
  /** Lines that did not parse, so a corrupt row is never silently lost. */
  readonly problems: readonly string[];
}

export function readManifest(path: string): LoadedManifest {
  if (!existsSync(path)) return { rows: [], problems: [] };

  const lines = readFileSync(path, 'utf8').split('\n');
  const rows: ManifestRow[] = [];
  const problems: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (i === 0 && line.startsWith('sha256,')) continue;

    const fields = splitCsvLine(line);
    if (fields.length !== MANIFEST_COLUMNS.length) {
      problems.push(`line ${i + 1}: expected ${MANIFEST_COLUMNS.length} fields, found ${fields.length}`);
      continue;
    }
    const value = (column: keyof ManifestRow): string =>
      fields[MANIFEST_COLUMNS.indexOf(column)] ?? '';

    const width = Number(value('width'));
    const height = Number(value('height'));
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      problems.push(`line ${i + 1}: width or height is not a number`);
      continue;
    }

    rows.push({
      sha256: value('sha256'),
      url: value('url'),
      sourceUrl: value('sourceUrl'),
      licence: value('licence'),
      photographer: value('photographer'),
      photographerUrl: value('photographerUrl'),
      query: value('query'),
      queryVariant: value('queryVariant') as QueryVariant,
      width,
      height,
      file: value('file'),
    });
  }

  return { rows, problems };
}

/**
 * Append one row and flush. Appending per image rather than writing the
 * whole file at the end is deliberate: a run interrupted at image 97
 * keeps its 96 rows, and the next run skips them.
 */
export function appendRow(path: string, row: ManifestRow): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, `${headerLine()}\n`, 'utf8');
  }
  appendFileSync(path, `${toCsvLine(row)}\n`, 'utf8');
}

export interface SeenIndex {
  readonly urls: ReadonlySet<string>;
  readonly hashes: ReadonlySet<string>;
  readonly perQuery: ReadonlyMap<string, number>;
}

export function indexManifest(rows: readonly ManifestRow[]): SeenIndex {
  const urls = new Set<string>();
  const hashes = new Set<string>();
  const perQuery = new Map<string, number>();
  for (const row of rows) {
    urls.add(row.url);
    urls.add(row.sourceUrl);
    hashes.add(row.sha256);
    perQuery.set(row.query, (perQuery.get(row.query) ?? 0) + 1);
  }
  return { urls, hashes, perQuery };
}
