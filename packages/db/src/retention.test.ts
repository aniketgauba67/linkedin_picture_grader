/**
 * Phase 2 of retention: deleting the bytes and clearing the pointer.
 *
 * The case that matters most is the one that looks like success.
 * Supabase Storage does not fail a batch remove for a key it cannot
 * delete - the key is simply absent from the response, exactly as a key
 * that was never there would be. Clearing `storage_path` on that
 * evidence would mark an object reclaimed while it is still in the
 * bucket, and since the path is the only pointer to those bytes, they
 * would be orphaned beyond recovery. So these tests care less about the
 * happy path than about what the code does when Storage stays quiet.
 */
import { describe, expect, it } from 'vitest';
import { createFakeClient, type QueuedResult } from './fake-client.js';
import { reclaimExpiredStorage } from './queries.js';

const PHOTO_A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', storage_path: 'a.jpg' };
const PHOTO_B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', storage_path: 'b.jpg' };

/** expire_photos -> list pending -> storage.remove -> [probes] -> mark_storage_reclaimed */
function queue(...results: QueuedResult[]): QueuedResult[] {
  return results;
}

describe('reclaimExpiredStorage', () => {
  it('reclaims an expired photo and clears its path', async () => {
    const fake = createFakeClient(
      queue(
        { data: 1 }, // expire_photos anonymised one row
        { data: [PHOTO_A] }, // pending
        { data: [{ name: 'a.jpg' }] }, // storage confirmed the delete
        { data: 1 }, // mark_storage_reclaimed
      ),
    );

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 1, pending: 1, reclaimed: 1, deferred: 0 });
    expect(fake.removedPaths()).toEqual(['a.jpg']);
    expect(fake.calls.filter((c) => c.method === 'storage.info')).toHaveLength(0);
  });

  it('leaves a photo that is not yet expired alone', async () => {
    // expire_photos anonymised nothing, so nothing is pending.
    const fake = createFakeClient(queue({ data: 0 }, { data: [] }));

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 0, pending: 0, reclaimed: 0, deferred: 0 });
    expect(fake.removedPaths()).toEqual([]);
    // Nothing was marked reclaimed: the only rpc call was expire_photos.
    const rpcNames = fake.calls.filter((c) => c.method === 'rpc').map((c) => c.args[0]);
    expect(rpcNames).toEqual(['expire_photos']);
  });

  it('treats an already-missing object as reclaimed rather than failing', async () => {
    const fake = createFakeClient(
      queue(
        { data: 0 },
        { data: [PHOTO_A] },
        { data: [] }, // storage removed nothing - the object was already gone
        { error: { message: 'Object not found' } }, // probe confirms absence
        { data: 1 },
      ),
    );

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 0, pending: 1, reclaimed: 1, deferred: 0 });
    expect(fake.argsFor('rpc')).toBeDefined();
  });

  it('does NOT mark reclaimed an object that is still present', async () => {
    const fake = createFakeClient(
      queue(
        { data: 0 },
        { data: [PHOTO_A] },
        { data: [] }, // storage did not confirm - and did not error either
        { data: { name: 'a.jpg' } }, // probe: the object is STILL THERE
      ),
    );

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 0, pending: 1, reclaimed: 0, deferred: 1 });
    // The critical assertion: the path was never cleared, so the bytes
    // remain findable and the next run can retry them.
    const marked = fake.calls.filter((c) => c.method === 'rpc' && c.args[0] === 'mark_storage_reclaimed');
    expect(marked).toHaveLength(0);
  });

  it('clears only the confirmed path when one of two objects survives', async () => {
    const fake = createFakeClient(
      queue(
        { data: 0 },
        { data: [PHOTO_A, PHOTO_B] },
        { data: [{ name: 'a.jpg' }] }, // only A confirmed
        { data: { name: 'b.jpg' } }, // B is still present
        { data: 1 },
      ),
    );

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 0, pending: 2, reclaimed: 1, deferred: 1 });
    const marked = fake.calls.find((c) => c.method === 'rpc' && c.args[0] === 'mark_storage_reclaimed');
    expect(marked?.args[1]).toEqual({ p_photo_ids: [PHOTO_A.id] });
  });

  it('succeeds on a retry after the object is gone', async () => {
    // Second run over the same row: storage now confirms the delete.
    const fake = createFakeClient(
      queue({ data: 0 }, { data: [PHOTO_B] }, { data: [{ name: 'b.jpg' }] }, { data: 1 }),
    );

    const summary = await reclaimExpiredStorage(fake.client);

    expect(summary).toEqual({ anonymised: 0, pending: 1, reclaimed: 1, deferred: 0 });
  });

  it('never touches feature_cache, which is shared by content hash', async () => {
    const fake = createFakeClient(
      queue({ data: 1 }, { data: [PHOTO_A] }, { data: [{ name: 'a.jpg' }] }, { data: 1 }),
    );

    await reclaimExpiredStorage(fake.client);

    const tables = fake.calls.filter((c) => c.method === 'from').map((c) => c.args[0]);
    expect(tables).not.toContain('feature_cache');
    expect(tables).toEqual(['photos']);
    const rpcNames = fake.calls.filter((c) => c.method === 'rpc').map((c) => c.args[0]);
    expect(rpcNames).not.toContain('prune_feature_cache');
  });

  it('propagates a storage failure instead of clearing any path', async () => {
    const fake = createFakeClient(
      queue({ data: 0 }, { data: [PHOTO_A] }, { error: { message: 'bucket unavailable' } }),
    );

    await expect(reclaimExpiredStorage(fake.client)).rejects.toThrow(/bucket unavailable/);

    const marked = fake.calls.filter((c) => c.method === 'rpc' && c.args[0] === 'mark_storage_reclaimed');
    expect(marked).toHaveLength(0);
  });

  it('only ever considers rows already marked deleted', async () => {
    const fake = createFakeClient(queue({ data: 0 }, { data: [] }));

    await reclaimExpiredStorage(fake.client);

    // deleted_at is not null AND storage_path is not null - an active
    // photograph matches neither and can never be selected here.
    const notFilters = fake.calls.filter((c) => c.method === 'not').map((c) => c.args);
    expect(notFilters).toContainEqual(['deleted_at', 'is', null]);
    expect(notFilters).toContainEqual(['storage_path', 'is', null]);
  });
});
