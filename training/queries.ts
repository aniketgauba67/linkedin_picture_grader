/**
 * The query plan.
 *
 * Stock photography is the problem this file exists to work around. Every
 * search term a photographer tags is aspirational - nobody uploads an
 * image and labels it "blurry" or "bad headshot" - so a corpus pulled
 * from the obvious queries lands almost entirely in the 4-5 band and the
 * 1-3 range comes back empty. A scorer fitted on that has never seen the
 * thing it exists to detect.
 *
 * Hence the BAD variant: queries chosen to surface specific failure modes
 * rather than bad photographs in general. "car selfie" is a framing and
 * background failure. "group of friends photo" is a solo failure.
 * "person sunglasses" is an expression failure with the eyes removed.
 * Each one targets a defect an axis is supposed to catch.
 *
 * These are query terms, not labels. Nothing here is a score, and the
 * variant a photo arrived under says only which net caught it.
 */

export type QueryVariant = 'good' | 'mediocre' | 'bad' | 'edge';

export interface QuerySpec {
  readonly query: string;
  readonly variant: QueryVariant;
}

/** Share of the corpus each variant should hold. Sums to 1. */
export const VARIANT_SHARES: Readonly<Record<QueryVariant, number>> = {
  good: 0.3,
  mediocre: 0.3,
  bad: 0.3,
  edge: 0.1,
};

export const QUERIES: readonly QuerySpec[] = [
  { query: 'professional headshot', variant: 'good' },
  { query: 'corporate portrait', variant: 'good' },
  { query: 'business headshot', variant: 'good' },
  { query: 'linkedin profile photo', variant: 'good' },

  { query: 'casual portrait', variant: 'mediocre' },
  { query: 'outdoor portrait person', variant: 'mediocre' },
  { query: 'selfie person', variant: 'mediocre' },
  { query: 'person smiling casual', variant: 'mediocre' },

  { query: 'group of friends photo', variant: 'bad' },
  { query: 'person sunglasses', variant: 'bad' },
  { query: 'blurry motion person', variant: 'bad' },
  { query: 'party photo people', variant: 'bad' },
  { query: 'vacation photo person', variant: 'bad' },
  { query: 'car selfie', variant: 'bad' },

  { query: 'profile silhouette', variant: 'edge' },
  { query: 'person wearing hat', variant: 'edge' },
  { query: 'black and white portrait', variant: 'edge' },
];

export interface QuotaRow extends QuerySpec {
  readonly target: number;
}

/**
 * Split `total` across the queries by variant share, then evenly within
 * each variant with the remainder spread over the first few queries.
 *
 * Deterministic, and it sums to exactly `total` - a plan that quietly
 * asks for 149 or 151 makes the "done when 150" check meaningless.
 */
export function planQuota(total: number, queries: readonly QuerySpec[] = QUERIES): readonly QuotaRow[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`total must be a non-negative whole number, got ${total}`);
  }

  // Only variants that actually have a query can receive a budget, and
  // their shares are renormalised over what is present. Without this a
  // caller passing a partial query list gets a plan that quietly sums to
  // less than it asked for, and "150 collected" silently becomes 90.
  const variants = (Object.keys(VARIANT_SHARES) as QueryVariant[]).filter((variant) =>
    queries.some((q) => q.variant === variant),
  );
  if (variants.length === 0) return [];
  const shareTotal = variants.reduce((s, v) => s + (VARIANT_SHARES[v] ?? 0), 0);
  if (shareTotal === 0) return [];

  const perVariant = new Map<QueryVariant, number>();

  // Floor each share, then hand out what rounding lost, largest
  // fractional part first, so the shares stay as close as integers allow.
  let assigned = 0;
  const remainders: { variant: QueryVariant; fraction: number }[] = [];
  for (const variant of variants) {
    const exact = (total * (VARIANT_SHARES[variant] ?? 0)) / shareTotal;
    const floor = Math.floor(exact);
    perVariant.set(variant, floor);
    assigned += floor;
    remainders.push({ variant, fraction: exact - floor });
  }
  remainders.sort((a, b) => b.fraction - a.fraction || variants.indexOf(a.variant) - variants.indexOf(b.variant));
  for (let i = 0; assigned < total; i += 1) {
    const row = remainders[i % remainders.length];
    if (row === undefined) break;
    perVariant.set(row.variant, (perVariant.get(row.variant) ?? 0) + 1);
    assigned += 1;
  }

  const rows: QuotaRow[] = [];
  for (const variant of variants) {
    const members = queries.filter((q) => q.variant === variant);
    const budget = perVariant.get(variant) ?? 0;
    const base = Math.floor(budget / members.length);
    const extra = budget % members.length;
    members.forEach((spec, i) => {
      rows.push({ ...spec, target: base + (i < extra ? 1 : 0) });
    });
  }
  return rows;
}
