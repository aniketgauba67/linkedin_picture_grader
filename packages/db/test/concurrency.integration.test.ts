import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  acquireSuiteLock,
  connect,
  databaseReachable,
  releaseSuiteLock,
  resetSchema,
  seedPhoto as seedPhotoRaw,
} from './harness.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const VERSION = 'v7';

async function seedPhoto(client: pg.Client, sha256 = SHA_A): Promise<string> {
  return seedPhotoRaw(client, { sha256 });
}

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

  beforeEach(async () => {
    const client = connect();
    await client.connect();
    try {
      await client.query('truncate public.extraction_claims');
    } finally {
      await client.end();
    }
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

  async function claim(
    client: pg.Client,
    photoId: string,
    sha256 = SHA_A,
    version = VERSION,
    staleAfter = '2 minutes',
  ): Promise<string | null> {
    const { rows } = await client.query<{ claim_extraction: string | null }>(
      'select public.claim_extraction($1, $2, $3, $4::interval)',
      [photoId, sha256, version, staleAfter],
    );
    return rows[0]?.claim_extraction ?? null;
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

    const { rows } = await setup.query<{ owner_photo_id: string; claimed_at: Date }>(
      'select owner_photo_id, claimed_at from public.extraction_claims where sha256 = $1 and extractor_version = $2',
      [SHA_A, VERSION],
    );
    expect(rows[0]?.owner_photo_id).toBe(photoId);
    expect(rows[0]?.claimed_at).toBeInstanceOf(Date);
  });

  it('keeps the loser locked out while the lock is fresh', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    expect(await claim(a, photoId)).not.toBeNull();
    expect(await claim(b, photoId)).toBeNull();
    expect(await claim(b, photoId)).toBeNull();
  });

  it('lets a later worker take over once the lock goes stale', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    const firstToken = await claim(a, photoId);
    expect(firstToken).not.toBeNull();
    // A crashed extraction leaves the lease set. A zero-length stale window
    // is the same test as waiting two minutes, without the two minutes.
    const secondToken = await claim(b, photoId, SHA_A, VERSION, '0 seconds');
    expect(secondToken).not.toBeNull();
    expect(secondToken).not.toBe(firstToken);
  });

  it('still yields one winner when stale claimants race to take over', async () => {
    const opened = await openClients(5);
    const setup = opened[0];
    if (!setup) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    await claim(setup, photoId);
    await setup.query(
      "update public.extraction_claims set claimed_at = now() - interval '10 minutes' where sha256 = $1 and extractor_version = $2",
      [SHA_A, VERSION],
    );

    const results = await Promise.all(
      opened.slice(1).map((client) => claim(client, photoId, SHA_A, VERSION, '2 minutes')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to claim a purged photo', async () => {
    const [setup, a] = await openClients(2);
    if (!setup || !a) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);
    await setup.query('select public.delete_photo($1)', [photoId]);

    expect(await claim(a, photoId)).toBeNull();
  });

  it('refuses to claim a photo that does not exist', async () => {
    const [, a] = await openClients(2);
    if (!a) throw new Error('could not open connections');
    expect(await claim(a, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('release_extraction lets the next worker in immediately', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);

    const token = await claim(a, photoId);
    expect(token).not.toBeNull();
    await a.query('select public.release_extraction($1, $2, $3)', [SHA_A, VERSION, token]);
    expect(await claim(b, photoId)).not.toBeNull();
  });

  it('allows only one winner across two photo IDs with identical bytes', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoA = await seedPhoto(setup);
    const photoB = await seedPhoto(setup);
    const results = await Promise.all([claim(a, photoA), claim(b, photoB)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((token) => token === null)).toHaveLength(1);
  });

  it('allows different SHAs to claim independently', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoA = await seedPhoto(setup, SHA_A);
    const photoB = await seedPhoto(setup, SHA_B);
    const results = await Promise.all([
      claim(a, photoA, SHA_A), claim(b, photoB, SHA_B),
    ]);
    expect(results.every((token) => token !== null)).toBe(true);
  });

  it('allows different extractor versions to claim independently', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoA = await seedPhoto(setup);
    const photoB = await seedPhoto(setup);
    const results = await Promise.all([
      claim(a, photoA, SHA_A, 'v7'), claim(b, photoB, SHA_A, 'v8'),
    ]);
    expect(results.every((token) => token !== null)).toBe(true);
  });

  it('does not let an expired owner release its successor', async () => {
    const [setup, a, b] = await openClients(3);
    if (!setup || !a || !b) throw new Error('could not open connections');
    const photoA = await seedPhoto(setup);
    const photoB = await seedPhoto(setup);
    const oldToken = await claim(a, photoA);
    const newToken = await claim(b, photoB, SHA_A, VERSION, '0 seconds');
    expect(oldToken).not.toBeNull();
    expect(newToken).not.toBeNull();
    await a.query('select public.release_extraction($1, $2, $3)', [SHA_A, VERSION, oldToken]);
    expect(await claim(a, photoA)).toBeNull();
    const { rows } = await setup.query<{ claim_token: string }>(
      'select claim_token from public.extraction_claims where sha256 = $1 and extractor_version = $2',
      [SHA_A, VERSION],
    );
    expect(rows[0]?.claim_token).toBe(newToken);
  });

  it('refuses a claimed hash that does not match the photo row', async () => {
    const [setup, a] = await openClients(2);
    if (!setup || !a) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup, SHA_A);
    expect(await claim(a, photoId, SHA_B)).toBeNull();
  });

  it('does not claim after the cache was filled between lookup and claim', async () => {
    const [setup, a] = await openClients(2);
    if (!setup || !a) throw new Error('could not open connections');
    const photoId = await seedPhoto(setup);
    await setup.query(
      'insert into public.feature_cache (sha256, extractor_version, computed) values ($1, $2, $3)',
      [SHA_A, VERSION, '{}'],
    );
    expect(await claim(a, photoId)).toBeNull();
  });
});
