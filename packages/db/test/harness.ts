import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Integration harness for the real migrations.
 *
 * `supabase start` needs Docker, which CI does not always have, so these
 * tests run against any Postgres that has pgvector available. The
 * migrations are applied unchanged; `supabase-shim.sql` supplies the auth
 * and storage objects that Supabase would otherwise create.
 *
 * Point PPS_TEST_DATABASE_URL at a database to enable them. Without it the
 * integration suites skip and the unit suites still run.
 */
export const TEST_DATABASE_URL = process.env['PPS_TEST_DATABASE_URL'] ?? '';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SHIM = fileURLToPath(new URL('./supabase-shim.sql', import.meta.url));

export async function databaseReachable(): Promise<boolean> {
  if (TEST_DATABASE_URL === '') {
    return false;
  }
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => `${MIGRATIONS_DIR}/${name}`);
}

/** Drops and rebuilds the public schema from the migrations. */
export async function resetSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists storage cascade');
    await client.query('drop schema if exists auth cascade');
    await client.query('create schema public');

    for (const file of [SHIM, ...migrationFiles()]) {
      await client.query(readFileSync(file, 'utf8'));
    }
  } finally {
    await client.end();
  }
}

export function connect(): pg.Client {
  return new pg.Client({ connectionString: TEST_DATABASE_URL });
}

/**
 * Every integration file rebuilds the schema, and vitest runs files in
 * parallel, so they have to take turns. A session-level advisory lock is
 * the simplest thing that works: it is held by one connection, released
 * when that connection goes away, and needs no coordination outside the
 * database.
 */
const SUITE_LOCK_KEY = 8_090_124;

let lockHolder: pg.Client | null = null;

export async function acquireSuiteLock(): Promise<void> {
  const client = connect();
  await client.connect();
  await client.query('select pg_advisory_lock($1)', [SUITE_LOCK_KEY]);
  lockHolder = client;
}

export async function releaseSuiteLock(): Promise<void> {
  const client = lockHolder;
  lockHolder = null;
  if (client === null) {
    return;
  }
  // Ending the session drops the lock; the explicit unlock keeps the
  // intent readable and makes a leak obvious in the logs.
  await client.query('select pg_advisory_unlock($1)', [SUITE_LOCK_KEY]).catch(() => undefined);
  await client.end().catch(() => undefined);
}

/** Creates a user row so a photo can be attributed to somebody. */
export async function seedUser(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into auth.users (id, email)
     values (gen_random_uuid(), $1) returning id`,
    [`${Math.random().toString(36).slice(2)}@example.test`],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('seedUser inserted no row');
  }
  return id;
}

/** Inserts a photo directly, bypassing the helpers under test. */
export async function seedPhoto(
  client: pg.Client,
  overrides: { sha256?: string; expiresInDays?: number; uploadedBy?: string | null } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.photos (storage_path, sha256, uploaded_by, expires_at)
     values ($1, $2, $3, now() + ($4::numeric * interval '1 day'))
     returning id`,
    [
      `anon/${Math.random().toString(36).slice(2)}.jpg`,
      overrides.sha256 ?? Math.random().toString(36).slice(2),
      overrides.uploadedBy ?? null,
      overrides.expiresInDays ?? 30,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('seedPhoto inserted no row');
  }
  return id;
}
