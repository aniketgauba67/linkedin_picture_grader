import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';
import type { BrowserEnv, ServiceEnv } from './env.js';
import { readBrowserEnv, readServiceEnv } from './env.js';

export type Client = SupabaseClient<Database>;

/**
 * Anon-key client. Safe in the browser: RLS is what protects the data, not
 * the key. Uploads go browser -> Storage directly through a signed URL, so
 * this client is also what performs the upload - images never travel
 * through a Vercel route, which caps request bodies at 4.5MB.
 */
export function createBrowserClient(env: BrowserEnv): Client {
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

/**
 * Service-role client. Bypasses RLS, so it must only ever be constructed
 * on the server - in a Vercel Node function or an Edge Function.
 */
export function createServiceClient(env: ServiceEnv): Client {
  return createClient<Database>(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createBrowserClientFromEnv(source: Record<string, string | undefined>): Client {
  return createBrowserClient(readBrowserEnv(source));
}

export function createServiceClientFromEnv(source: Record<string, string | undefined>): Client {
  return createServiceClient(readServiceEnv(source));
}
