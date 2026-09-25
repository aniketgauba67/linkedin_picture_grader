/**
 * Service-role Supabase client, server only.
 *
 * Bypasses RLS, which is why it is constructed per request in a route
 * rather than exported as a module singleton anything could import. The
 * routes are the only place that knows which photo a caller may see.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pps/db';

export const PHOTO_BUCKET = 'photos';

/** Signed upload URLs are short-lived: the client PUTs immediately. */
export const UPLOAD_URL_TTL_SECONDS = 120;

export function serviceClient(): SupabaseClient<Database> {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (url === undefined || url === '' || key === undefined || key === '') {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set');
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
