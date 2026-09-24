# Profile Photo Scorer

Scores a professional profile photo 1-10 with a per-axis breakdown and
specific, actionable fixes. See `CLAUDE.md` for the rules that govern the
scoring itself.

## Layout

```
apps/web            Next.js 15 App Router, TS strict, Tailwind -> Vercel
packages/scoring    Pure scoring. ZERO dependencies. Node + Deno + browser.
packages/features   Image feature extraction (sharp, onnxruntime-node). Node only.
packages/schema     zod schemas and the types inferred from them.
packages/db         Supabase client and generated database types.
supabase/           Migrations and Edge Functions (Deno).
training/           Distillation of the judged axes. Empty for now.
```

## Getting started

```bash
pnpm install
cp .env.example .env.local   # then fill it in
pnpm build
pnpm test
pnpm dev
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | `turbo run build` across every workspace, in dependency order |
| `pnpm dev` | Next.js dev server plus `tsc --watch` on the packages |
| `pnpm test` | vitest at the root, every workspace project in one run |
| `pnpm lint` | ESLint across every workspace |
| `pnpm typecheck` | `tsc --noEmit` across every workspace |

## The dependency rule that matters

`packages/scoring` has an empty `dependencies` object and must keep it. It
runs in three places - Node, Deno (Supabase Edge Functions, 20MB bundle and
a 2s CPU budget), and the browser - and a single dependency breaks two of
them. `packages/schema` depends on it, never the other way round.

## Database

Migrations live in `supabase/migrations/` and apply with `supabase start`
or `supabase db push`.

The integration tests apply those same migrations to a real Postgres and
assert what they built - including that two concurrent `claimExtraction`
calls produce exactly one winner. `supabase start` needs Docker, so for
machines and CI runners without it there is a bare-Postgres fallback:

```bash
brew install postgresql@17 pgvector pg_cron      # or the apt equivalents
pnpm --filter @pps/db db:start
export PPS_TEST_DATABASE_URL="postgresql://postgres@localhost:55432/pps_test"
pnpm test
pnpm --filter @pps/db db:stop
```

Without `PPS_TEST_DATABASE_URL` the integration suites skip and the rest
of the suite still runs. `packages/db/test/supabase-shim.sql` supplies the
`auth` and `storage` objects Supabase would otherwise create; it is a test
fixture and is never applied to a real project.

Regenerate `packages/db/src/database.types.ts` after every migration with
`pnpm --filter @pps/db gen:types` (Supabase CLI), or `gen:types:pg`, which
introspects `PPS_TEST_DATABASE_URL` directly and needs no Docker.

## Retention runs in two phases

Supabase refuses `delete from storage.objects` - only the Storage API may
remove an object - so SQL alone cannot finish a purge. Retention splits:

1. **`expire_photos`**, on pg_cron daily at 03:15 UTC, strips everything
   identifying (`uploaded_by`, `sha256`) and stamps `deleted_at`.
   `storage_path` deliberately survives: clearing it before the object is
   gone would lose the only pointer to the bytes and orphan them.
2. **`reclaimExpiredStorage`** in `@pps/db` deletes the objects through
   the Storage API and then clears the path.

**Both have to be scheduled.** Until step 2 runs, expired photos are
anonymous but their images are still stored. Point a Vercel cron at it
daily, shortly after the pg_cron sweep.

`deletePhoto` (the user-facing button) does the same two steps in one
call, object first.

## Dedup shares numbers, never rows

`photos.sha256` is unique **per uploader**, not globally. Two people who
upload the same image each get their own photo row; a globally unique
hash would make the second uploader's insert collide with the first's row
and hand them somebody else's photo.

The expensive work is still only done once. `feature_cache` is keyed by
`(sha256, extractor_version)` and holds nothing but the anonymous
measurements - no uploader, no photo id, no storage path - so it is safe
to share across accounts. `getFeaturesByHash` reads it; `upsertFeatures`
writes the photo's feature row and the cache entry in one transaction.

Anonymous uploads never collide at all: with no uploader to be unique
against, every one gets its own row. They still skip re-extraction
through the cache.

The cache is RLS-enabled with no policies, so only the service role
touches it - a caller who could read it could test whether an image they
already hold had been uploaded by somebody else. Retention leaves it
alone because it holds no user data; `pruneFeatureCache` is what bounds
it, dropping entries from superseded extractors.

## Declining is a normal outcome

Analysis returns an `AnalysisOutcome`, a discriminated union on `status`:
either `scored` with a `ScoreResult`, or `declined` with one of five
reasons. A logo, a landscape, and a child's photo are all things users
will upload, so a decline is a branch of the return type rather than a
thrown error - there is no `.result` to reach for until `status` has been
narrowed. `matchOutcome` in `@pps/schema` makes that exhaustive.

## Extraction and scoring are separate

Extraction runs once per image in a Vercel Node function (~800ms) and
caches a `ComputedFeatures` vector to Postgres. Every field of it is
`z.number().finite()`, and `assertFeaturesUsable` re-checks it at each
cache read: a NaN reaching the scorer does not throw, it produces a
plausible-looking wrong score. Scoring is a dot product over that
cache (~3ms) and runs in a Supabase Edge Function. Changing a threshold or
a weight re-scores cached vectors; it never re-reads a pixel.
