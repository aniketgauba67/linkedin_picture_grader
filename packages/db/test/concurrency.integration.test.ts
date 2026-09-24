import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  acquireSuiteLock,
  connect,
  databaseReachable,
  releaseSuiteLock,
  resetSchema,
  seedPhoto,
} from './harness.js';

/**
 * The claim has to hold against genuinely simultaneous callers, not just
 * sequential ones, so these run real concurrent connections against real
 * Postgres. Sequential tests would pass even with a broken
 * read-then-write implementation.
 */
const reachable = await databaseReachable();
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    '[db] PPS_TEST_DATABASE_URL is unset or unreachable - skipping migration integration tests.',
  );
}

suite('claim_extraction under concurrency', () => {
  let clients: pg.Client[] = [];

  beforeAll(async () => {
    // Serialise against the other integration file; both reset the schema.
    await acquireSuiteLock();
    await resetSchema();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    clients = [];
    await releaseSuiteLock();
  });

  async function openClients(count: number): Promise<pg.Client[]> {
    const opened = await Promise.all(
      Array.from({ length: count }, async () => {
        const client = connect();
        await client.connect();
        return client;
      }),
    );
    clients.push(...opened);
    return opened;
  }

  async function claim(client: pg.Client, photoId: string, staleAfter = '2 minutes') {
    const { rows } = await client.query<{ claim_extraction: boolean }>(
      'select public.claim_extraction($1, $2::interval)',
      [photoId, staleAfter],
    );
    return rows[0]?.claim_extraction ?? false;
  }

  it('gives exactly one winner when two callers race', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    // Fired together on separate connections: this is the real race.
    const results = await Promise.all([claim(a, photoId), claim(b, photoId)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(1);
  });

  it('gives exactly one winner when eight callers race', async () => {
    const opened = await openClients(9);
    const setup = opened[0];
    if (!setup) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    const results = await Promise.all(opened.slice(1).map((client) => claim(client, photoId)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('records the lock on the winning row only', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    await Promise.all([claim(a, photoId), claim(b, photoId)]);

    const { rows } = await setup.query<{ extraction_started_at: Date | null }>(
      'select extraction_started_at from public.photos where id = $1',
      [photoId],
    );
    expect(rows[0]?.extraction_started_at).toBeInstanceOf(Date);
  });

  it('keeps the loser locked out while the lock is fresh', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    expect(await claim(a, photoId)).toBe(true);
    expect(await claim(b, photoId)).toBe(false);
    expect(await claim(b, photoId)).toBe(false);
  });

  it('lets a later worker take over once the lock goes stale', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    expect(await claim(a, photoId)).toBe(true);
    // A crashed extraction leaves the lock set. A zero-length stale window
    // is the same test as waiting two minutes, without the two minutes.
    expect(await claim(b, photoId, '0 seconds')).toBe(true);
  });

  it('still yields one winner when stale claimants race to take over', async () => {
    const opened = await openClients(5);
    const setup = opened[0];
    if (!setup) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    await setup.query(
      "update public.photos set extraction_started_at = now() - interval '10 minutes' where id = $1",
      [photoId],
    );

    const results = await Promise.all(
      opened.slice(1).map((client) => claim(client, photoId, '2 minutes')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to claim a purged photo', async () => {
    const [setup, a] = await openClients(2);
    if (!setup || !a) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);
    await setup.query('select public.delete_photo($1)', [photoId]);

    expect(await claim(a, photoId)).toBe(false);
  });

  it('refuses to claim a photo that does not exist', async () => {
    const [, a] = await openClients(2);
    if (!a) throw new Error('could not open connections');
    expect(await claim(a, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('release_extraction lets the next worker in immediately', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    expect(await claim(a, photoId)).toBe(true);
    await a.query('select public.release_extraction($1)', [photoId]);
    expect(await claim(b, photoId)).toBe(true);
  });
});
