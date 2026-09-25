/**
 * Smoke-tests a real Supabase project against the migrations.
 *
 * The integration suites in test/ run against a bare Postgres, which is
 * fast and needs no credentials but cannot reproduce the hosted
 * platform's own rules - it was a bare Postgres that let a migration
 * deleting from storage.objects pass while production refused it. This
 * exercises the deployed project end to end instead: RLS through the anon
 * key, the storage bucket, the extraction lock under real concurrency,
 * and both phases of retention.
 *
 * It creates one photo, then hard-deletes everything it made.
 *
 *   pnpm --filter @pps/db smoke
 *
 * Reads .env.local at the repo root. Prints no secrets.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));

let env;
try {
  env = Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  );
} catch {
  console.error(`Could not read ${envPath}. Copy .env.example and fill it in.`);
  process.exit(1);
}

for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) {
    console.error(`${key} is missing from .env.local`);
    process.exit(1);
  }
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log(`Smoke-testing ${url}\n`);

const tag = `smoketest-${Math.random().toString(36).slice(2, 10)}`;
const ok = (c) => (c ? 'PASS' : 'FAIL');
let failures = 0;
const check = (name, cond, note = '') => {
  if (!cond) failures += 1;
  console.log(`${ok(cond).padEnd(4)}  ${name}${note ? ` — ${note}` : ''}`);
};

// --- RLS: the anon key must not be able to read anything -------------
for (const table of ['photos', 'features', 'assessments', 'scores', 'feature_cache']) {
  const { data, error } = await anon.from(table).select('*').limit(1);
  check(`anon cannot read ${table}`, (data ?? []).length === 0, error ? error.code : 'empty');
}

// --- storage bucket ---------------------------------------------------
const buckets = await svc.storage.listBuckets();
const photos = (buckets.data ?? []).find((b) => b.id === 'photos');
check('photos bucket exists', photos !== undefined);
check('photos bucket is private', photos?.public === false);

// --- insert a photo ---------------------------------------------------
const ins = await svc.from('photos').insert({
  storage_path: `${tag}/a.jpg`, sha256: tag, uploaded_by: null,
}).select().single();
check('service role can insert a photo', ins.error === null, ins.error?.message ?? '');
const photoId = ins.data?.id;

// --- the extraction lock, on real Supabase ----------------------------
if (photoId) {
  const [a, b] = await Promise.all([
    svc.rpc('claim_extraction', { p_photo_id: photoId, p_sha256: tag, p_extractor_version: 'smoke-v1', p_stale_after: '2 minutes' }),
    svc.rpc('claim_extraction', { p_photo_id: photoId, p_sha256: tag, p_extractor_version: 'smoke-v1', p_stale_after: '2 minutes' }),
  ]);
  const winners = [a.data, b.data].filter((v) => typeof v === 'string').length;
  check('two concurrent claims produce exactly one winner', winners === 1, `winners=${winners}`);

  const stale = await svc.rpc('claim_extraction', { p_photo_id: photoId, p_sha256: tag, p_extractor_version: 'smoke-v1', p_stale_after: '0 seconds' });
  check('a stale lock can be taken over', typeof stale.data === 'string');

  // --- record_extraction writes both rows in one transaction ----------
  const computed = { sharpnessLaplacian: 400, faceCount: 1 };
  const rec = await svc.rpc('record_extraction', {
    p_photo_id: photoId, p_sha256: tag, p_computed: computed,
    p_extractor_version: 'smoke-v1', p_embedding: null,
  });
  check('record_extraction succeeds', rec.error === null, rec.error?.message ?? '');

  const feat = await svc.from('features').select('extractor_version').eq('photo_id', photoId).maybeSingle();
  check('photo feature row written', feat.data?.extractor_version === 'smoke-v1');

  const cache = await svc.from('feature_cache').select('sha256').eq('sha256', tag).maybeSingle();
  check('shared cache entry written', cache.data?.sha256 === tag);

  // --- unique constraints bite ----------------------------------------
  const dupA = await svc.from('assessments').insert({ photo_id: photoId, source: 'vlm', axes: {}, model: null });
  const dupB = await svc.from('assessments').insert({ photo_id: photoId, source: 'vlm', axes: {}, model: null });
  check('duplicate assessment rejected (NULLS NOT DISTINCT)', dupA.error === null && dupB.error?.code === '23505');

  const badSource = await svc.from('assessments').insert({ photo_id: photoId, source: 'vibes', axes: {} });
  check('unknown assessment source rejected', badSource.error !== null);

  const badScore = await svc.from('scores').insert({
    photo_id: photoId, context: 'corporate', score: 11, axis_scores: {}, weights_version: 'v1',
  });
  check('score above 10 rejected', badScore.error !== null);

  // --- retention --------------------------------------------------------
  const del = await svc.rpc('delete_photo', { p_photo_id: photoId });
  check('delete_photo purges the row', del.data === true, del.error?.message ?? '');

  const after = await svc.from('photos').select('storage_path, sha256, deleted_at').eq('id', photoId).maybeSingle();
  check('purged row keeps no path or hash', after.data?.storage_path === null && after.data?.sha256 === null);
  check('purged row is marked deleted', after.data?.deleted_at !== null);

  const keptFeatures = await svc.from('features').select('photo_id').eq('photo_id', photoId).maybeSingle();
  check('anonymous features survive the purge', keptFeatures.data !== null);

  const sweep = await svc.rpc('expire_photos', { p_limit: 10 });
  check('expire_photos runs', sweep.error === null, `purged=${sweep.data}`);
}

// --- clean up: hard delete everything this test created ----------------
if (photoId) await svc.from('photos').delete().eq('id', photoId);
await svc.from('feature_cache').delete().eq('sha256', tag);
const leftPhotos = await svc.from('photos').select('id').eq('id', photoId ?? '');
const leftCache = await svc.from('feature_cache').select('sha256').eq('sha256', tag);
check('cleaned up: no photo rows left', (leftPhotos.data ?? []).length === 0);
check('cleaned up: no cache rows left', (leftCache.data ?? []).length === 0);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
