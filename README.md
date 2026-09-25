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

## CI and branch protection

`.github/workflows/ci.yml` runs on every pull request and on pushes to
`main`: install with `--frozen-lockfile`, then build, lint, typecheck,
test.

**Enable `build, lint, typecheck, test` as a required status check** on
`main` (Settings → Branches → Branch protection rules). Until that is
switched on the workflow reports failures but nothing stops a merge.

`pnpm typecheck` is the step worth protecting. Every package typechecks
through its `tsconfig.test.json`, which includes the test files - and
that is the only thing keeping the compile-time assertions in
`packages/schema/src/mirror.test.ts` honest. Those assertions are what
stop `@pps/scoring`'s dependency-free mirror types drifting from the zod
schemas. They silently did nothing for several commits because the build
tsconfig excluded test files from the program.

CI deliberately does not set `PPS_TEST_DATABASE_URL` or `PPS_TEST_HEIC`,
so the migration and HEIC suites skip rather than fail. A pull request
from a fork gets a green run without needing any secret.

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

## Native dependency sizing (read before changing install config)

Two separate traps, both of which only appear on the Linux build machine:

**1. GPU execution providers.** `onnxruntime-node`'s postinstall reads a
platform-keyed manifest. Every platform requires `[]` *except*
`linux/x64`, which defaults to `["cuda12"]` and downloads
`Microsoft.ML.OnnxRuntime.Gpu.Linux` from nuget - CUDA and TensorRT
`.so` files. There is no GPU on Vercel; SCRFD runs on the CPU binaries
already inside the npm package. The repo `.npmrc` sets
`onnxruntime-node-install=skip` (and the deprecated `-install-cuda=skip`,
since package.json allows `^1.20.1`). **That file is load-bearing - do
not delete it as redundant defaults.**

⚠️ **Any Dockerfile or build context that runs `pnpm install` must copy
`.npmrc` in first**, or the setting silently does not apply and the GPU
providers come back.

**2. Cross-platform binaries.** The npm package ships prebuilt binaries
for *all* platforms in one tarball - 287MB, of which win32 is 133MB of
DirectML/dxcompiler DLLs. A Vercel function needs only linux/x64 (~46MB).
`outputFileTracingExcludes` in `apps/web/next.config.ts` drops the rest,
which is the difference between ~49MB and ~288MB against the 250MB
function limit.

CI asserts no `libonnxruntime_providers_*` lands on disk. That assertion
runs on `ubuntu-latest`, which is the only place the problem is
reproducible.

## The face detector model is in Git LFS

`models/det_500m.onnx` is SCRFD-500m (2.4MB, 5 keypoints), stored through
Git LFS and pinned by SHA-256 in `models/manifest.json`. `postinstall`
verifies the hash, which is what turns an unresolved LFS pointer into a
clear message at install rather than an opaque ONNX parse error at
runtime.

`.gitignore` still excludes `models/` wholesale - the rule exists to keep
the training corpus out. This one path is allowed back explicitly,
because a pinned weight file that is required to build is a different
thing from training images.

```bash
git lfs install && git lfs pull   # after a fresh clone
pnpm verify:models
```

**Vercel does not fetch LFS objects by default.** Enable Git LFS in the
project's Git settings. `scripts/check-lfs.mjs` runs on install and fails
the build with instructions if it was missed - that failure otherwise
only shows up on deploy.

MediaPipe was evaluated first and rejected: `@mediapipe/tasks-vision` is
a browser bundle whose WASM loader needs a real DOM, and shimming it ends
at `ModuleFactory not set`. SCRFD runs natively in Node with no shim.

## HEIC needs a real file to test

`packages/features` handles iPhone HEIC through `heic-convert`, because
sharp's bundled libheif has no HEVC codec - it parses the header happily
and then fails on the actual decode. AVIF is AV1-coded and does work
through sharp, so the two must not be conflated.

heic-convert also strips EXIF without baking the orientation into the
pixels, so the orientation tag is read from the original and re-applied
by hand. Verified against Apple's own decoder: without it, an iPhone 13
photo came out vertically mirrored.

None of that can be tested hermetically - sharp cannot encode HEVC, so a
fixture cannot be generated, and the repo never commits images. Point
`PPS_TEST_HEIC` at a real iPhone photo to run those assertions:

```bash
PPS_TEST_HEIC=~/Desktop/IMG_0918.HEIC pnpm --filter @pps/features test
```

They skip otherwise. Budget on a 12MP HEIC: ~1.2s and ~750MB peak RSS,
against a 300ms budget for already-decoded input.

## Dedup shares numbers, never rows

`photos.sha256` is unique **per uploader**, not globally. Two people who
upload the same image each get their own photo row; a globally unique
hash would make the second uploader's insert collide with the first's row
and hand them somebody else's photo.

Expensive feature extraction is reused across matching uploads.
`feature_cache` is keyed by `(sha256, extractor_version)` and holds
nothing but the anonymous
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
thrown error. Non-corrupt declines can carry the score earned by the
photograph, including measured axes; `corrupt_file` has no score because
nothing was measured. `matchOutcome` in `@pps/schema` makes handling
the branches exhaustive.

## Extraction and scoring are separate

Extraction runs once per image in a Vercel Node function (~800ms) and
caches a `ComputedFeatures` vector to Postgres. Numeric measurements
are finite and range-checked; some explicitly permit `null` when they
were not measurable. `assertFeaturesUsable` re-checks cached vectors:
a NaN reaching the scorer does not throw, it produces a plausible-looking
wrong score. Scoring is a dot product over that
cache (~3ms) and runs in a Supabase Edge Function. Changing a threshold or
a weight re-scores cached vectors; it never re-reads a pixel.
