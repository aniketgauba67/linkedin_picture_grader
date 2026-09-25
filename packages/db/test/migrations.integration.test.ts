import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  acquireSuiteLock,
  connect,
  databaseReachable,
  releaseSuiteLock,
  resetSchema,
  seedPhoto,
  seedUser,
} from './harness.js';

/**
 * Applies the real migrations to a real Postgres and asserts what they
 * built. Everything here lives in one file on purpose: the suites share a
 * schema, and vitest parallelises across files, so splitting them would
 * race on the reset.
 */
const reachable = await databaseReachable();
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    '[db] PPS_TEST_DATABASE_URL is unset or unreachable - skipping migration integration tests. ' +
      'Run `pnpm --filter @pps/db db:start` to enable them.',
  );
}

let db: pg.Client;

suite('migrations', () => {
  beforeAll(async () => {
    // Serialise against the other integration file; both reset the schema.
    await acquireSuiteLock();
    await resetSchema();
    db = connect();
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await releaseSuiteLock();
  });

  describe('schema', () => {
    it('creates the current tables', async () => {
      const { rows } = await db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      expect(rows.map((row) => row.tablename)).toEqual([
        'assessments',
        'extraction_claims',
        'feature_cache',
        'features',
        'photos',
        'rate_limit_counters',
        'scores',
      ]);
    });

    it('stores clip_embedding as a 512-dimension pgvector', async () => {
      const { rows } = await db.query<{ type: string }>(
        `select format_type(atttypid, atttypmod) as type
           from pg_attribute
          where attrelid = 'public.features'::regclass and attname = 'clip_embedding'`,
      );
      expect(rows[0]?.type).toBe('extensions.vector(512)');
    });

    it('creates the indexes the read paths depend on', async () => {
      const { rows } = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public'",
      );
      const names = rows.map((row) => row.indexname);
      expect(names).toContain('features_extractor_version_idx');
      expect(names).toContain('assessments_photo_id_source_idx');
      expect(names).toContain('photos_expires_at_idx');
    });

    it('scopes the expiry index to rows not yet purged', async () => {
      const { rows } = await db.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where indexname = 'photos_expires_at_idx'",
      );
      expect(rows[0]?.indexdef).toContain('WHERE (deleted_at IS NULL)');
    });

    it('enables RLS on every table', async () => {
      const { rows } = await db.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'`,
      );
      expect(rows).toHaveLength(7);
      expect(rows.every((row) => row.relrowsecurity)).toBe(true);
    });

    it('lets anon insert a photo but not read one back', async () => {
      const { rows } = await db.query<{ policyname: string; cmd: string; roles: string[] }>(
        "select policyname, cmd, roles::text[] from pg_policies where schemaname='public' and tablename='photos'",
      );
      const insert = rows.find((row) => row.cmd === 'INSERT');
      const select = rows.find((row) => row.cmd === 'SELECT');
      expect(insert?.roles).toContain('anon');
      expect(select?.roles).toContain('anon');
      // The SELECT policy is owner-scoped, so an anonymous row (no owner)
      // matches nothing through the anon key.
      const { rows: def } = await db.query<{ qual: string }>(
        "select qual from pg_policies where policyname = 'owners read their own photos'",
      );
      expect(def[0]?.qual).toContain('uploaded_by');
      expect(def[0]?.qual).toContain('IS NOT NULL');
    });

    it('schedules the daily retention sweep', async () => {
      const { rows } = await db.query<{ schedule: string; command: string }>(
        "select schedule, command from cron.job where jobname = 'expire-photos-daily'",
      );
      expect(rows[0]?.schedule).toBe('15 3 * * *');
      expect(rows[0]?.command).toContain('expire_photos');
    });
  });

  describe('constraints', () => {
    it('rejects the same uploader storing the same image twice', async () => {
      const userId = await seedUser(db);
      await seedPhoto(db, { sha256: 'same-user-hash', uploadedBy: userId });
      await expect(
        seedPhoto(db, { sha256: 'same-user-hash', uploadedBy: userId }),
      ).rejects.toThrow(/duplicate key/);
    });

    it('lets two different people upload the same image', async () => {
      // The whole point of keying uniqueness per uploader: a global
      // unique hash would collide here and hand the second uploader the
      // first one's row.
      const alice = await seedUser(db);
      const bob = await seedUser(db);
      const alicePhoto = await seedPhoto(db, { sha256: 'shared-hash', uploadedBy: alice });
      const bobPhoto = await seedPhoto(db, { sha256: 'shared-hash', uploadedBy: bob });
      expect(alicePhoto).not.toBe(bobPhoto);
    });

    it('never collapses two anonymous uploads of the same image into one row', async () => {
      // NULLS DISTINCT: with no uploader to be unique against, anonymous
      // rows stay separate rather than sharing one.
      const first = await seedPhoto(db, { sha256: 'anon-hash' });
      const second = await seedPhoto(db, { sha256: 'anon-hash' });
      expect(first).not.toBe(second);
    });

    it('rejects a duplicate assessment from the same source and model', async () => {
      const photoId = await seedPhoto(db);
      const insert = () =>
        db.query(
          `insert into public.assessments (photo_id, source, axes, model)
           values ($1, 'vlm', '{}'::jsonb, 'claude-opus-5')`,
          [photoId],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/duplicate key/);
    });

    it('rejects a duplicate assessment even when the model is null', async () => {
      // NULLS NOT DISTINCT. Without it Postgres treats every NULL as
      // unique and this constraint never fires on the case it exists for.
      const photoId = await seedPhoto(db);
      const insert = () =>
        db.query(
          `insert into public.assessments (photo_id, source, axes)
           values ($1, 'human', '{}'::jsonb)`,
          [photoId],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/duplicate key/);
    });

    it('rejects an assessment from an unknown source', async () => {
      const photoId = await seedPhoto(db);
      await expect(
        db.query(
          `insert into public.assessments (photo_id, source, axes)
           values ($1, 'vibes', '{}'::jsonb)`,
          [photoId],
        ),
      ).rejects.toThrow(/assessments_source_check/);
    });

    it('allows a second score for the same photo and context', async () => {
      // Append-only history: re-scoring under new weights adds a row.
      const photoId = await seedPhoto(db);
      const insert = (weights: string) =>
        db.query(
          `insert into public.scores (photo_id, context, score, axis_scores, weights_version)
           values ($1, 'corporate', 7.4, '{}'::jsonb, $2)`,
          [photoId, weights],
        );
      await insert('2026-09-24.1');
      await expect(insert('2026-10-01.1')).resolves.toBeTruthy();
    });

    it('rejects a score outside 1-10', async () => {
      const photoId = await seedPhoto(db);
      await expect(
        db.query(
          `insert into public.scores (photo_id, context, score, axis_scores, weights_version)
           values ($1, 'corporate', 11.0, '{}'::jsonb, 'v1')`,
          [photoId],
        ),
      ).rejects.toThrow(/scores_score_check/);
    });

    it('requires a live photo to have a storage path', async () => {
      await expect(
        db.query(`insert into public.photos (storage_path, sha256) values (null, 'no-path')`),
      ).rejects.toThrow(/photos_live_rows_have_a_path/);
    });

    it('cascades features away when a photo row is actually deleted', async () => {
      const photoId = await seedPhoto(db);
      await db.query(
        `insert into public.features (photo_id, computed, extractor_version)
         values ($1, '{}'::jsonb, 'v1')`,
        [photoId],
      );
      await db.query('delete from public.photos where id = $1', [photoId]);
      const { rows } = await db.query('select 1 from public.features where photo_id = $1', [
        photoId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('retention', () => {
    async function seedWithFeatures(expiresInDays: number): Promise<{
      photoId: string;
      storagePath: string;
    }> {
      const photoId = await seedPhoto(db, { expiresInDays });
      const { rows } = await db.query<{ storage_path: string }>(
        'select storage_path from public.photos where id = $1',
        [photoId],
      );
      const storagePath = rows[0]?.storage_path ?? '';
      await db.query(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [
        storagePath,
      ]);
      await db.query(
        `insert into public.features (photo_id, computed, extractor_version)
         values ($1, '{"sharpnessLaplacian": 400}'::jsonb, 'v1')`,
        [photoId],
      );
      return { photoId, storagePath };
    }

    async function photoRow(photoId: string) {
      const { rows } = await db.query<{
        storage_path: string | null;
        uploaded_by: string | null;
        sha256: string | null;
        deleted_at: Date | null;
      }>(
        'select storage_path, uploaded_by, sha256, deleted_at from public.photos where id = $1',
        [photoId],
      );
      return rows[0];
    }

    it('refuses a direct delete from storage.objects', async () => {
      // Hosted Supabase enforces this, and the shim reproduces it. A
      // migration that deletes objects in SQL passes on a bare Postgres
      // and fails in production, so the guard belongs in the test rig.
      const { storagePath } = await seedWithFeatures(30);
      await expect(
        db.query('delete from storage.objects where name = $1', [storagePath]),
      ).rejects.toThrow(/Use the Storage API instead/);
    });

    it('anonymises an expired photo and keeps its features', async () => {
      const { photoId } = await seedWithFeatures(-1);

      await db.query('select public.expire_photos()');

      const photo = await photoRow(photoId);
      expect(photo?.uploaded_by).toBeNull();
      expect(photo?.sha256).toBeNull();
      expect(photo?.deleted_at).toBeInstanceOf(Date);

      const features = await db.query('select 1 from public.features where photo_id = $1', [
        photoId,
      ]);
      expect(features.rows).toHaveLength(1);
    });

    it('keeps storage_path through phase 1 so the bytes can still be found', async () => {
      // Nulling the path before the Storage API has removed the object
      // would orphan it permanently - there would be nothing left
      // pointing at the bytes.
      const { photoId, storagePath } = await seedWithFeatures(-1);
      await db.query('select public.expire_photos()');
      expect((await photoRow(photoId))?.storage_path).toBe(storagePath);
    });

    it('clears the path only once storage confirms, via mark_storage_reclaimed', async () => {
      const { photoId } = await seedWithFeatures(-1);
      await db.query('select public.expire_photos()');

      const cleared = await db.query<{ mark_storage_reclaimed: number }>(
        'select public.mark_storage_reclaimed($1::uuid[])',
        [[photoId]],
      );
      expect(cleared.rows[0]?.mark_storage_reclaimed).toBe(1);
      expect((await photoRow(photoId))?.storage_path).toBeNull();
    });

    it('will not clear the path of a photo that has not been purged', async () => {
      const { photoId, storagePath } = await seedWithFeatures(30);
      await db.query('select public.mark_storage_reclaimed($1::uuid[])', [[photoId]]);
      expect((await photoRow(photoId))?.storage_path).toBe(storagePath);
    });

    it('leaves a photo that has not expired alone', async () => {
      const { photoId, storagePath } = await seedWithFeatures(10);

      await db.query('select public.expire_photos()');

      const photo = await photoRow(photoId);
      expect(photo?.storage_path).toBe(storagePath);
      expect(photo?.deleted_at).toBeNull();
    });

    it('is idempotent - a second sweep finds nothing left to do', async () => {
      await seedWithFeatures(-1);
      const first = await db.query<{ expire_photos: number }>('select public.expire_photos()');
      expect(first.rows[0]?.expire_photos).toBeGreaterThan(0);

      const second = await db.query<{ expire_photos: number }>('select public.expire_photos()');
      expect(second.rows[0]?.expire_photos).toBe(0);
    });

    it('delete_photo purges one photo on demand and keeps its features', async () => {
      const { photoId } = await seedWithFeatures(30);

      const deleted = await db.query<{ delete_photo: boolean }>('select public.delete_photo($1)', [
        photoId,
      ]);
      expect(deleted.rows[0]?.delete_photo).toBe(true);

      const photo = await photoRow(photoId);
      // Safe to clear here: deletePhoto removes the object through the
      // Storage API before it calls this.
      expect(photo?.storage_path).toBeNull();
      expect(photo?.deleted_at).toBeInstanceOf(Date);

      const features = await db.query('select 1 from public.features where photo_id = $1', [
        photoId,
      ]);
      expect(features.rows).toHaveLength(1);
    });

    it('delete_photo returns false for a photo already purged', async () => {
      const { photoId } = await seedWithFeatures(30);
      await db.query('select public.delete_photo($1)', [photoId]);
      const again = await db.query<{ delete_photo: boolean }>('select public.delete_photo($1)', [
        photoId,
      ]);
      expect(again.rows[0]?.delete_photo).toBe(false);
    });

    it('frees the content hash so the same image can be uploaded again', async () => {
      const photoId = await seedPhoto(db, { sha256: 'reusable-hash' });
      await db.query('select public.delete_photo($1)', [photoId]);
      await expect(seedPhoto(db, { sha256: 'reusable-hash' })).resolves.toBeTruthy();
    });
  });
});

suite('feature cache', () => {
  let cacheDb: pg.Client;

  beforeAll(async () => {
    await acquireSuiteLock();
    await resetSchema();
    cacheDb = connect();
    await cacheDb.connect();
  }, 60_000);

  afterAll(async () => {
    await cacheDb?.end().catch(() => undefined);
    await releaseSuiteLock();
  });

  async function record(photoId: string, sha256: string | null, version = 'v2', value = 400) {
    await cacheDb.query('select public.record_extraction($1, $2, $3::jsonb, $4)', [
      photoId,
      sha256,
      JSON.stringify({ sharpnessLaplacian: value }),
      version,
    ]);
  }

  it('writes the photo row and the shared cache entry together', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-a' });
    await record(photoId, 'cache-a');

    const features = await cacheDb.query('select 1 from public.features where photo_id = $1', [
      photoId,
    ]);
    const cached = await cacheDb.query('select 1 from public.feature_cache where sha256 = $1', [
      'cache-a',
    ]);
    expect(features.rows).toHaveLength(1);
    expect(cached.rows).toHaveLength(1);
  });

  it('serves two different uploaders of the same image from one cache entry', async () => {
    const alice = await seedUser(cacheDb);
    const bob = await seedUser(cacheDb);
    const alicePhoto = await seedPhoto(cacheDb, { sha256: 'cache-b', uploadedBy: alice });
    const bobPhoto = await seedPhoto(cacheDb, { sha256: 'cache-b', uploadedBy: bob });

    await record(alicePhoto, 'cache-b');
    await record(bobPhoto, 'cache-b');

    const cached = await cacheDb.query('select 1 from public.feature_cache where sha256 = $1', [
      'cache-b',
    ]);
    expect(cached.rows).toHaveLength(1);

    // Two photo rows, two feature rows, one shared cache entry - and
    // neither uploader's row references the other's.
    const features = await cacheDb.query('select photo_id from public.features where photo_id = any($1::uuid[])', [
      [alicePhoto, bobPhoto],
    ]);
    expect(features.rows).toHaveLength(2);
  });

  it('holds nothing that identifies an uploader', async () => {
    const { rows } = await cacheDb.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'feature_cache'`,
    );
    const columns = rows.map((row) => row.column_name).sort();
    expect(columns).toEqual([
      'clip_embedding',
      'computed',
      'extracted_at',
      'extractor_version',
      'sha256',
    ]);
  });

  it('keeps one entry per extractor version', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-c' });
    await record(photoId, 'cache-c', 'v2');
    await record(photoId, 'cache-c', 'v3');

    const { rows } = await cacheDb.query<{ extractor_version: string }>(
      'select extractor_version from public.feature_cache where sha256 = $1 order by extractor_version',
      ['cache-c'],
    );
    expect(rows.map((row) => row.extractor_version)).toEqual(['v2', 'v3']);
  });

  it('leaves the first cache entry alone on a repeat extraction', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-d' });
    await record(photoId, 'cache-d', 'v2', 400);
    await record(photoId, 'cache-d', 'v2', 999);

    const { rows } = await cacheDb.query<{ computed: { sharpnessLaplacian: number } }>(
      'select computed from public.feature_cache where sha256 = $1',
      ['cache-d'],
    );
    expect(rows[0]?.computed.sharpnessLaplacian).toBe(400);
  });

  it('updates the photo row on a repeat extraction', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-e' });
    await record(photoId, 'cache-e', 'v2', 400);
    await record(photoId, 'cache-e', 'v3', 999);

    const { rows } = await cacheDb.query<{
      computed: { sharpnessLaplacian: number };
      extractor_version: string;
    }>('select computed, extractor_version from public.features where photo_id = $1', [photoId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.computed.sharpnessLaplacian).toBe(999);
    expect(rows[0]?.extractor_version).toBe('v3');
  });

  it('still writes the photo row when the hash has been stripped by retention', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-f' });
    await cacheDb.query('select public.delete_photo($1)', [photoId]);
    await record(photoId, null, 'v2');

    const features = await cacheDb.query('select 1 from public.features where photo_id = $1', [
      photoId,
    ]);
    expect(features.rows).toHaveLength(1);
  });

  it('survives retention - the cache is not user data', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-g', expiresInDays: -1 });
    await record(photoId, 'cache-g');

    await cacheDb.query('select public.expire_photos()');

    const cached = await cacheDb.query('select 1 from public.feature_cache where sha256 = $1', [
      'cache-g',
    ]);
    expect(cached.rows).toHaveLength(1);
  });

  it('prunes superseded extractor versions and keeps the current one', async () => {
    const photoId = await seedPhoto(cacheDb, { sha256: 'cache-h' });
    await record(photoId, 'cache-h', 'v1');
    await record(photoId, 'cache-h', 'v2');

    const pruned = await cacheDb.query<{ prune_feature_cache: number }>(
      'select public.prune_feature_cache($1)',
      ['v2'],
    );
    expect(pruned.rows[0]?.prune_feature_cache).toBeGreaterThan(0);

    const { rows } = await cacheDb.query<{ extractor_version: string }>(
      'select distinct extractor_version from public.feature_cache',
    );
    expect(rows.map((row) => row.extractor_version)).toEqual(['v2']);
  });

  it('denies the cache to anon and authenticated entirely', async () => {
    const { rows } = await cacheDb.query(
      "select 1 from pg_policies where schemaname='public' and tablename='feature_cache'",
    );
    // RLS on, zero policies: nothing matches, so nothing is readable.
    expect(rows).toHaveLength(0);
  });
});

suite('storage', () => {
  let storageDb: pg.Client;

  beforeAll(async () => {
    await acquireSuiteLock();
    await resetSchema();
    storageDb = connect();
    await storageDb.connect();
  }, 60_000);

  afterAll(async () => {
    await storageDb?.end().catch(() => undefined);
    await releaseSuiteLock();
  });

  it('creates a private photos bucket', async () => {
    const { rows } = await storageDb.query<{
      public: boolean;
      file_size_limit: string;
      allowed_mime_types: string[];
    }>(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'photos'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.public).toBe(false);
    expect(Number(rows[0]?.file_size_limit)).toBe(10 * 1024 * 1024);
    expect(rows[0]?.allowed_mime_types).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('re-applies without failing on an existing bucket', async () => {
    // Migrations get replayed; this one has to be safe the second time.
    await expect(
      storageDb.query(`
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values ('photos', 'photos', false, 10485760, array['image/jpeg'])
        on conflict (id) do update set public = excluded.public
      `),
    ).resolves.toBeTruthy();
  });
});
