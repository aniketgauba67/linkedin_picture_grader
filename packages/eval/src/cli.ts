#!/usr/bin/env node
/**
 * pps-eval - does the scoring actually agree with people?
 *
 *   pnpm eval report    <labels.jsonl>
 *   pnpm eval agreement <a.jsonl> <b.jsonl>
 *   pnpm eval ceiling   <human.jsonl> <model.jsonl>
 *
 * Run on 40 labels long before it is run on 700, so every section that
 * cannot be computed prints "insufficient data for X" and the rest of
 * the report still comes out. The only non-zero exits are for a file
 * that cannot be read and a file with no usable records at all.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  agreement,
  alphaVerdict,
  kendallTau,
  krippendorffAlpha,
  pairwiseAccuracy,
  spearman,
  type Metric,
} from './metrics.js';
import { alignById, parseLabelsJsonl, ratingsByUnit, type LabelRecord } from './labels.js';
import { reportCeiling, renderCeiling } from './ceiling.js';
import {
  axisDistribution,
  compositeHistogram,
  confusionMatrix,
  renderConfusion,
  renderDistribution,
  renderHistogram,
  renderVariance,
  varianceContribution,
} from './report.js';

export interface CliResult {
  readonly code: number;
  readonly output: string;
}

export type ReadTextFile = (path: string) => string;

const USAGE = [
  'usage:',
  '  pps-eval report    <labels.jsonl>            distributions, histogram, variance',
  '  pps-eval agreement <a.jsonl> <b.jsonl>       alpha, correlation, confusion',
  '  pps-eval ceiling   <human.jsonl> <model.jsonl>   how much honest headroom is left',
  '',
  'jsonl record: {"id":"p1","clusterId":"person-3","rater":"ana",',
  '               "axes":{"background":4,"attire":3},"composite":7,"phash":"a1b2..."}',
].join('\n');

/** Every metric in this package returns a union; printing narrows it. */
function show(name: string, result: Metric, digits = 3): string {
  return result.ok
    ? `  ${name.padEnd(18)} ${result.value.toFixed(digits)}`
    : `  ${name.padEnd(18)} insufficient data for ${name} (${result.reason})`;
}

function section(title: string): string {
  return `\n${title}\n${'-'.repeat(title.length)}`;
}

interface Loaded {
  readonly records: readonly LabelRecord[];
  readonly notes: readonly string[];
}

function load(path: string, read: ReadTextFile, out: string[]): Loaded | null {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    out.push(`cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return null;
  }

  const parsed = parseLabelsJsonl(text);
  const notes: string[] = [`${path}: ${parsed.records.length} record(s), axes: ${parsed.axes.join(', ') || 'none'}`];
  // Skipped lines are reported, never silently dropped - a file that
  // half-parsed produces a report that looks complete and is not.
  for (const problem of parsed.problems.slice(0, 20)) notes.push(`  skipped ${problem}`);
  if (parsed.problems.length > 20) {
    notes.push(`  ...and ${parsed.problems.length - 20} more skipped line(s)`);
  }
  return { records: parsed.records, notes };
}

function axesOf(records: readonly LabelRecord[]): string[] {
  return [...new Set(records.flatMap((r) => Object.keys(r.axes)))].sort();
}

function commandReport(path: string, read: ReadTextFile): CliResult {
  const out: string[] = [];
  const loaded = load(path, read, out);
  if (loaded === null) return { code: 2, output: out.join('\n') };
  out.push(...loaded.notes);

  const { records } = loaded;
  if (records.length === 0) {
    out.push('', 'no usable records - nothing to report');
    return { code: 1, output: out.join('\n') };
  }

  const axes = axesOf(records);

  out.push(section('axis distributions'));
  for (const axis of axes) {
    const ratings = records.map((r) => r.axes[axis]).filter((v): v is number => v !== undefined);
    const distribution = axisDistribution(axis, ratings);
    out.push(
      'ok' in distribution
        ? `  insufficient data for ${axis} (${distribution.reason})`
        : renderDistribution(distribution),
    );
  }

  out.push(section('composite'));
  const composites = records
    .map((r) => r.composite)
    .filter((v): v is number => v !== undefined);
  const histogram = compositeHistogram(composites);
  out.push(
    'ok' in histogram
      ? `  insufficient data for the composite histogram (${histogram.reason})`
      : renderHistogram(histogram),
  );

  out.push(section('variance contribution'));
  // Equal weights, stated plainly. Reading the shipped weights would
  // make this package depend on @pps/scoring, and a report that silently
  // used the wrong weights would be worse than one that says which it
  // used.
  out.push(
    '  shares sum to 1 by construction.',
    '  weights: equal (1 per axis). This describes the label set, not the shipped composite.',
  );
  const complete = records.filter((r) => axes.every((a) => r.axes[a] !== undefined));
  if (complete.length < 2) {
    out.push(
      `  insufficient data for variance contribution (only ${complete.length} record(s) rate every axis)`,
    );
  } else {
    const byAxis: Record<string, number[]> = {};
    const weights: Record<string, number> = {};
    for (const axis of axes) {
      byAxis[axis] = complete.map((r) => r.axes[axis] ?? 0);
      weights[axis] = 1;
    }
    const shares = varianceContribution(byAxis, weights);
    out.push(
      'ok' in shares
        ? `  insufficient data for variance contribution (${shares.reason})`
        : renderVariance(shares, false),
    );
  }

  const raters = [...new Set(records.map((r) => r.rater ?? 'unnamed'))];
  if (raters.length > 1) {
    out.push(section('inter-rater agreement'));
    out.push(`  ${raters.length} raters: ${raters.sort().join(', ')}`);
    for (const axis of axes) {
      const alpha = krippendorffAlpha(ratingsByUnit(records, axis), 'ordinal');
      out.push(
        alpha.ok
          ? `  ${axis.padEnd(18)} alpha ${alpha.value.toFixed(3)}  ${alphaVerdict(alpha.value)}`
          : `  ${axis.padEnd(18)} insufficient data for alpha (${alpha.reason})`,
      );
    }
  } else {
    out.push(section('inter-rater agreement'));
    out.push('  insufficient data for alpha (one rater; set "rater" on each record to compare)');
  }

  return { code: 0, output: out.join('\n') };
}

function commandAgreement(pathA: string, pathB: string, read: ReadTextFile): CliResult {
  const out: string[] = [];
  const a = load(pathA, read, out);
  const b = load(pathB, read, out);
  if (a === null || b === null) return { code: 2, output: out.join('\n') };
  out.push(...a.notes, ...b.notes);

  const aligned = alignById(a.records, b.records);
  if (aligned.axes.length === 0) {
    out.push('', 'no id appears in both files with a shared axis - nothing to compare');
    return { code: 1, output: out.join('\n') };
  }
  if (aligned.onlyInA.length > 0 || aligned.onlyInB.length > 0) {
    out.push(
      `  ${aligned.onlyInA.length} id(s) only in ${pathA}, ${aligned.onlyInB.length} only in ${pathB} - both dropped`,
    );
  }

  for (const pair of aligned.axes) {
    out.push(section(`${pair.axis}  (n=${pair.ids.length})`));

    const scores = agreement(pair.a, pair.b);
    if ('ok' in scores) {
      out.push(`  insufficient data for ${pair.axis} (${scores.reason})`);
      continue;
    }
    out.push(
      `  n                  ${scores.n}`,
      `  exact              ${scores.exact.toFixed(3)}`,
      `  within one         ${scores.withinOne.toFixed(3)}`,
      `  mae                ${scores.mae.toFixed(3)}`,
      `  bias (b - a)       ${scores.bias >= 0 ? '+' : ''}${scores.bias.toFixed(3)}`,
    );
    out.push(show('spearman', spearman(pair.a, pair.b)));
    out.push(show('kendall tau-b', kendallTau(pair.a, pair.b)));
    out.push(show('pairwise accuracy', pairwiseAccuracy(pair.b, pair.a)));

    const units = pair.a.map((value, i) => [value, pair.b[i] ?? null]);
    const alpha = krippendorffAlpha(units, 'ordinal');
    out.push(
      alpha.ok
        ? `  ${'alpha'.padEnd(18)} ${alpha.value.toFixed(3)}  ${alphaVerdict(alpha.value)}`
        : `  ${'alpha'.padEnd(18)} insufficient data for alpha (${alpha.reason})`,
    );

    const confusion = confusionMatrix(pair.axis, pair.a, pair.b);
    out.push('ok' in confusion ? `  insufficient data for the confusion matrix (${confusion.reason})` : renderConfusion(confusion));
  }

  return { code: 0, output: out.join('\n') };
}

/** Pairwise accuracy of every rater against every other, averaged. */
function selfAgreement(
  records: readonly LabelRecord[],
  axis: string,
): { readonly value: number; readonly pairs: number } | null {
  const byRater = new Map<string, Map<string, number>>();
  for (const record of records) {
    const value = record.axes[axis];
    if (value === undefined) continue;
    const rater = record.rater ?? 'unnamed';
    const ratings = byRater.get(rater) ?? new Map<string, number>();
    ratings.set(record.id, value);
    byRater.set(rater, ratings);
  }

  const raters = [...byRater.keys()].sort();
  if (raters.length < 2) return null;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < raters.length; i += 1) {
    for (let j = i + 1; j < raters.length; j += 1) {
      const left = byRater.get(raters[i] ?? '');
      const right = byRater.get(raters[j] ?? '');
      if (left === undefined || right === undefined) continue;
      const ids = [...left.keys()].filter((id) => right.has(id)).sort();
      const result = pairwiseAccuracy(
        ids.map((id) => left.get(id) ?? 0),
        ids.map((id) => right.get(id) ?? 0),
      );
      if (!result.ok) continue;
      total += result.value;
      pairs += 1;
    }
  }
  return pairs === 0 ? null : { value: total / pairs, pairs };
}

/** The same statistic, model against each rater, averaged the same way. */
function modelAgreement(
  human: readonly LabelRecord[],
  model: readonly LabelRecord[],
  axis: string,
): number | null {
  const modelById = new Map<string, number>();
  for (const record of model) {
    const value = record.axes[axis];
    if (value !== undefined) modelById.set(record.id, value);
  }

  const byRater = new Map<string, Map<string, number>>();
  for (const record of human) {
    const value = record.axes[axis];
    if (value === undefined) continue;
    const rater = record.rater ?? 'unnamed';
    const ratings = byRater.get(rater) ?? new Map<string, number>();
    ratings.set(record.id, value);
    byRater.set(rater, ratings);
  }

  let total = 0;
  let pairs = 0;
  for (const ratings of byRater.values()) {
    const ids = [...ratings.keys()].filter((id) => modelById.has(id)).sort();
    const result = pairwiseAccuracy(
      ids.map((id) => modelById.get(id) ?? 0),
      ids.map((id) => ratings.get(id) ?? 0),
    );
    if (!result.ok) continue;
    total += result.value;
    pairs += 1;
  }
  return pairs === 0 ? null : total / pairs;
}

function commandCeiling(humanPath: string, modelPath: string, read: ReadTextFile): CliResult {
  const out: string[] = [];
  const human = load(humanPath, read, out);
  const model = load(modelPath, read, out);
  if (human === null || model === null) return { code: 2, output: out.join('\n') };
  out.push(...human.notes, ...model.notes);

  const raters = new Set(human.records.map((r) => r.rater ?? 'unnamed'));
  if (raters.size < 2) {
    out.push(
      '',
      'insufficient data for the ceiling: the human file has one rater.',
      'The ceiling IS the disagreement between raters, so it cannot be computed',
      'from a single opinion. Label a subset twice and set "rater" on each record.',
    );
    return { code: 1, output: out.join('\n') };
  }

  out.push(
    section('how these two numbers were measured'),
    '  Both are pairwise accuracy, which is the only way the comparison means',
    '  anything: how often does X reproduce a rater\'s ordering of two photos?',
    `  ceiling = every rater against every other (${raters.size} raters), averaged.`,
    '  model   = the model against each rater, averaged the same way.',
  );

  const axes = axesOf(human.records).filter((axis) => axesOf(model.records).includes(axis));
  const humanAgreement: Record<string, number> = {};
  const modelAccuracy: Record<string, number> = {};
  const skipped: string[] = [];

  for (const axis of axes) {
    const self = selfAgreement(human.records, axis);
    const against = modelAgreement(human.records, model.records, axis);
    if (self === null || against === null) {
      skipped.push(axis);
      continue;
    }
    humanAgreement[axis] = self.value;
    modelAccuracy[axis] = against;
  }

  const report = reportCeiling(humanAgreement, modelAccuracy);
  out.push('');
  if ('ok' in report) {
    out.push(`insufficient data for the ceiling (${report.reason})`);
    return { code: 1, output: out.join('\n') };
  }
  out.push(renderCeiling(report));
  if (skipped.length > 0) {
    out.push(`  insufficient data for: ${skipped.join(', ')} (no comparable pairs)`);
  }
  return { code: 0, output: out.join('\n') };
}

export function runCli(argv: readonly string[], read: ReadTextFile = defaultRead): CliResult {
  const [command, ...rest] = argv;
  switch (command) {
    case 'report':
      return rest.length === 1 && rest[0] !== undefined
        ? commandReport(rest[0], read)
        : { code: 2, output: USAGE };
    case 'agreement':
      return rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined
        ? commandAgreement(rest[0], rest[1], read)
        : { code: 2, output: USAGE };
    case 'ceiling':
      return rest.length === 2 && rest[0] !== undefined && rest[1] !== undefined
        ? commandCeiling(rest[0], rest[1], read)
        : { code: 2, output: USAGE };
    default:
      return { code: command === undefined || command === '--help' || command === '-h' ? 0 : 2, output: USAGE };
  }
}

function defaultRead(path: string): string {
  return readFileSync(path, 'utf8');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.code;
}
