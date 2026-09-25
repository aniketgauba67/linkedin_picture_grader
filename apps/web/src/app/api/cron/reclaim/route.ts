/**
 * GET /api/cron/reclaim
 *
 * Phase 2 of retention, on a schedule. `expire_photos` runs in Postgres
 * on pg_cron and anonymises rows past `expires_at`, but it cannot delete
 * the image: Supabase refuses direct deletes on `storage.objects`, so
 * only the Storage API can, and only from a Node context holding the
 * service-role key. That is this route.
 *
 * Until this runs, an expired photograph is anonymous in the database
 * but its bytes are still in the bucket. The schedule is what turns
 * "anonymised" into "actually deleted", so a silent failure here is a
 * retention failure - hence the counts in the response and the single
 * greppable log line.
 *
 * Safe to run at any time and safe to run twice. It reclaims only rows
 * already marked deleted, never an active photograph, and it never
 * touches feature_cache - those rows are keyed by content hash, shared
 * across photos, and deliberately outlive any individual upload.
 */

import { NextResponse } from 'next/server';

import { reclaimExpiredStorage } from '@pps/db';

import { serviceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;
// Retention must observe the live table, never a cached render.
export const dynamic = 'force-dynamic';

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that
 * variable is set on the project. Without the variable the endpoint
 * would be open to anyone who guesses the path, so an unset secret
 * refuses rather than defaults to open.
 */
function authorised(request: Request): boolean {
  const secret = process.env['CRON_SECRET'];
  if (secret === undefined || secret === '') return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    // No detail: an unauthenticated caller learns nothing about whether
    // the secret is configured.
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  try {
    const summary = await reclaimExpiredStorage(serviceClient());

    // Counts only. Storage paths and photo ids stay out of the log.
    console.log(
      `[api/cron/reclaim] ok anonymised=${summary.anonymised} pending=${summary.pending} ` +
        `reclaimed=${summary.reclaimed} deferred=${summary.deferred}`,
    );

    // Deferred is not an error - the object is still there and the next
    // run retries it - but it must be visible, because a number that
    // never falls to zero means reclamation is stuck.
    if (summary.deferred > 0) {
      console.warn(`[api/cron/reclaim] deferred ${summary.deferred} object(s) still present after removal`);
    }

    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    // The whole error goes to the platform log, never to the caller.
    console.error('[api/cron/reclaim] failed', error);
    return NextResponse.json({ error: 'Reclamation failed.' }, { status: 500 });
  }
}
