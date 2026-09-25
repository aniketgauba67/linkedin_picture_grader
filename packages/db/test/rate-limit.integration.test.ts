import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  acquireSuiteLock,
  connect,
  databaseReachable,
  releaseSuiteLock,
  resetSchema,
} from './harness.js';

const reachable = await databaseReachable();
const suite = reachable ? describe : describe.skip;
const IP_A = 'a'.repeat(64);
const IP_B = 'b'.repeat(64);

interface Decision {
  allowed: boolean;
  bucket: 'ip' | 'global' | null;
  retryAfterSeconds: number;
}

suite('shared rate-limit RPC', () => {
  let db: pg.Client;

  beforeAll(async () => {
    await acquireSuiteLock();
    await resetSchema();
    db = connect();
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await releaseSuiteLock();
  });

  beforeEach(async () => {
    await db.query('delete from public.rate_limit_counters');
  });

  async function consume(
    client: pg.Client,
    ip: string,
    perIp = 2,
    global = 20,
  ): Promise<Decision> {
    const { rows } = await client.query<{ decision: Decision }>(
      'select public.consume_rate_limit($1, $2, $3, 3600) as decision',
      [ip, perIp, global],
    );
    const decision = rows[0]?.decision;
    if (decision === undefined) throw new Error('RPC returned no row');
    return decision;
  }

  it('allows the configured per-IP count, then rejects with a retry delay', async () => {
    expect((await consume(db, IP_A)).allowed).toBe(true);
    expect((await consume(db, IP_A)).allowed).toBe(true);
    expect(await consume(db, IP_A)).toMatchObject({
      allowed: false, bucket: 'ip', retryAfterSeconds: expect.any(Number),
    });
    const { rows } = await db.query<{ count: number }>(
      "select count from public.rate_limit_counters where scope = 'ip' and subject = $1",
      [IP_A],
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('keeps independent IP allowances without consuming global capacity on denial', async () => {
    await consume(db, IP_A);
    await consume(db, IP_A);
    expect((await consume(db, IP_A)).bucket).toBe('ip');
    expect((await consume(db, IP_B)).allowed).toBe(true);
    const { rows } = await db.query<{ count: number }>(
      "select count from public.rate_limit_counters where scope = 'global'",
    );
    expect(rows[0]?.count).toBe(3);
  });

  it('enforces one global allowance across different IPs', async () => {
    expect((await consume(db, IP_A, 20, 2)).allowed).toBe(true);
    expect((await consume(db, IP_B, 20, 2)).allowed).toBe(true);
    expect(await consume(db, 'c'.repeat(64), 20, 2)).toMatchObject({
      allowed: false, bucket: 'global', retryAfterSeconds: expect.any(Number),
    });
    const { rows } = await db.query<{ count: number }>(
      "select count from public.rate_limit_counters where scope = 'global'",
    );
    expect(rows[0]?.count).toBe(2);
  });

  it('atomically admits only the per-IP allowance under concurrent requests', async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const client = connect();
      await client.connect();
      return client;
    }));
    try {
      const decisions = await Promise.all(clients.map((client) => consume(client, IP_A, 2, 20)));
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(2);
      expect(decisions.filter((decision) => decision.bucket === 'ip')).toHaveLength(10);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('atomically admits only the global allowance across concurrent IPs', async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const client = connect();
      await client.connect();
      return client;
    }));
    try {
      const decisions = await Promise.all(clients.map((client, index) =>
        consume(client, index.toString(16).padStart(64, '0'), 20, 3)));
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
      expect(decisions.filter((decision) => decision.bucket === 'global')).toHaveLength(9);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('starts a new window after the previous one expires', async () => {
    await consume(db, IP_A, 1, 1);
    await db.query("update public.rate_limit_counters set reset_at = now() - interval '1 second'");
    expect((await consume(db, IP_A, 1, 1)).allowed).toBe(true);
    const { rows } = await db.query<{ count: number }>(
      'select count from public.rate_limit_counters',
    );
    expect(rows.map((row) => row.count)).toEqual([1, 1]);
  });

  it('keeps the counter table private and schedules indexed cleanup', async () => {
    const { rows } = await db.query<{
      anonExecute: boolean; serviceExecute: boolean; anonUpdate: boolean; rls: boolean;
    }>(`
      select
        has_function_privilege('anon', 'public.consume_rate_limit(text, integer, integer, integer)', 'EXECUTE') as "anonExecute",
        has_function_privilege('service_role', 'public.consume_rate_limit(text, integer, integer, integer)', 'EXECUTE') as "serviceExecute",
        has_table_privilege('anon', 'public.rate_limit_counters', 'UPDATE') as "anonUpdate",
        (select relrowsecurity from pg_class where oid = 'public.rate_limit_counters'::regclass) as rls
    `);
    expect(rows[0]).toEqual({ anonExecute: false, serviceExecute: true, anonUpdate: false, rls: true });
    const scheduled = await db.query<{ schedule: string }>(
      "select schedule from cron.job where jobname = 'prune-rate-limit-counters-hourly'",
    );
    expect(scheduled.rows[0]?.schedule).toBe('17 * * * *');
    await consume(db, IP_A);
    await db.query("update public.rate_limit_counters set reset_at = now() - interval '2 hours'");
    const removed = await db.query<{ removed: number }>(
      'select public.prune_rate_limit_counters() as removed',
    );
    expect(removed.rows[0]?.removed).toBe(2);
  });
});
