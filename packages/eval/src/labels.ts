/**
 * Reading a labels file without throwing.
 *
 * This runs on 40 hand-made labels long before it runs on 700, and a
 * half-typed line in a file someone is still writing must not take the
 * whole report down. Every problem is collected and reported; nothing
 * here throws.
 *
 * The parser is deliberately schema-agnostic about axis names: it
 * reports the axes it found rather than checking them against
 * @pps/schema. A typo shows up as an axis with one rating, which the
 * report makes obvious, and the tool stays usable on a file of
 * experimental axes that the schema has never heard of.
 */

export interface LabelRecord {
  readonly id: string;
  /** The person, when known. Splits cut here, not on id. */
  readonly clusterId?: string;
  /** Who produced this rating. Agreement needs to tell raters apart. */
  readonly rater?: string;
  readonly axes: Readonly<Record<string, number>>;
  readonly composite?: number;
  readonly phash?: string;
}

export interface ParsedLabels {
  readonly records: readonly LabelRecord[];
  /** One line per rejected line, naming the line number and the reason. */
  readonly problems: readonly string[];
  readonly axes: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLabelsJsonl(text: string): ParsedLabels {
  const records: LabelRecord[] = [];
  const problems: string[] = [];
  const axes = new Set<string>();

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '') continue;
    // A trailing comma from a hand-edited file is the single most common
    // mistake; say so instead of "Unexpected token".
    const line = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push(`line ${line}: not valid JSON${raw.endsWith(',') ? ' (trailing comma)' : ''}`);
      continue;
    }

    if (!isObject(parsed)) {
      problems.push(`line ${line}: expected an object`);
      continue;
    }

    const id = parsed['id'];
    if (typeof id !== 'string' || id === '') {
      problems.push(`line ${line}: missing a non-empty string id`);
      continue;
    }

    const rawAxes = parsed['axes'];
    if (!isObject(rawAxes)) {
      problems.push(`line ${line} (${id}): missing an axes object`);
      continue;
    }

    const cleanAxes: Record<string, number> = {};
    let bad = false;
    for (const [axis, value] of Object.entries(rawAxes)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`line ${line} (${id}): axes.${axis} is not a finite number`);
        bad = true;
        continue;
      }
      cleanAxes[axis] = value;
      axes.add(axis);
    }
    if (bad) continue;
    if (Object.keys(cleanAxes).length === 0) {
      problems.push(`line ${line} (${id}): axes object is empty`);
      continue;
    }

    const clusterId = parsed['clusterId'];
    const rater = parsed['rater'];
    const composite = parsed['composite'];
    const phash = parsed['phash'];

    // exactOptionalPropertyTypes: an explicit `undefined` is not the
    // same as an absent key, so each optional is spread in or left out.
    records.push({
      id,
      axes: cleanAxes,
      ...(typeof clusterId === 'string' && clusterId !== '' ? { clusterId } : {}),
      ...(typeof rater === 'string' && rater !== '' ? { rater } : {}),
      ...(typeof composite === 'number' && Number.isFinite(composite) ? { composite } : {}),
      ...(typeof phash === 'string' && phash !== '' ? { phash } : {}),
    });
  }

  return { records, problems, axes: [...axes].sort() };
}

/** Ratings for one axis, aligned across two files by id. Ids missing
 *  from either side are dropped and counted, never treated as zero. */
export interface AlignedAxis {
  readonly axis: string;
  readonly ids: readonly string[];
  readonly a: readonly number[];
  readonly b: readonly number[];
}

export interface Alignment {
  readonly axes: readonly AlignedAxis[];
  readonly onlyInA: readonly string[];
  readonly onlyInB: readonly string[];
}

export function alignById(
  a: readonly LabelRecord[],
  b: readonly LabelRecord[],
): Alignment {
  const indexB = new Map(b.map((r) => [r.id, r]));
  const indexA = new Map(a.map((r) => [r.id, r]));

  const shared = a.filter((r) => indexB.has(r.id));
  const axisNames = [...new Set(shared.flatMap((r) => Object.keys(r.axes)))].sort();

  const axes: AlignedAxis[] = [];
  for (const axis of axisNames) {
    const ids: string[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (const record of shared) {
      const other = indexB.get(record.id);
      const x = record.axes[axis];
      const y = other?.axes[axis];
      if (x === undefined || y === undefined) continue;
      ids.push(record.id);
      left.push(x);
      right.push(y);
    }
    if (ids.length > 0) axes.push({ axis, ids, a: left, b: right });
  }

  return {
    axes,
    onlyInA: a.filter((r) => !indexB.has(r.id)).map((r) => r.id),
    onlyInB: b.filter((r) => !indexA.has(r.id)).map((r) => r.id),
  };
}

/** Ratings grouped as units x raters, which is what alpha wants. A unit
 *  keeps a hole for a rater who never saw it. */
export function ratingsByUnit(
  records: readonly LabelRecord[],
  axis: string,
): readonly (readonly (number | null)[])[] {
  const raters = [...new Set(records.map((r) => r.rater ?? 'unnamed'))].sort();
  const byUnit = new Map<string, Map<string, number>>();
  for (const record of records) {
    const value = record.axes[axis];
    if (value === undefined) continue;
    const unit = byUnit.get(record.id) ?? new Map<string, number>();
    unit.set(record.rater ?? 'unnamed', value);
    byUnit.set(record.id, unit);
  }
  return [...byUnit.keys()]
    .sort()
    .map((id) => raters.map((rater) => byUnit.get(id)?.get(rater) ?? null));
}
