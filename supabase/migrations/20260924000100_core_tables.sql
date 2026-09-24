-- Core tables: photos, their cached features, the assessments of them,
-- and the scores derived from both.
--
-- The rule this schema encodes: extraction is expensive and scoring is
-- not. `features` is written once per photo and keyed by content hash, so
-- re-uploading the same bytes reuses it. `scores` is derived and can be
-- thrown away and recomputed at any time.

create table public.photos (
  id uuid primary key default extensions.gen_random_uuid(),

  -- Nullable, despite being required for a live photo, because retention
  -- nulls it once the object is gone while keeping the row so the
  -- anonymous feature vector survives. The check below is what enforces
  -- "not null" for the part of the lifecycle where it means something.
  storage_path text,

  -- Null for anonymous uploads, and nulled again by retention.
  uploaded_by uuid references auth.users (id) on delete set null,

  -- Content hash. Unique PER UPLOADER, not globally: two people who
  -- upload the same image each get their own photo row. A globally
  -- unique hash would make the second uploader's insert collide with the
  -- first's row and hand them somebody else's photo.
  --
  -- Dedup of the expensive work happens in public.feature_cache instead,
  -- which is keyed by hash alone and holds nothing but anonymous numbers.
  sha256 text,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  deleted_at timestamptz null,

  -- Extraction lock. See public.claim_extraction.
  extraction_started_at timestamptz null,

  -- NULLS DISTINCT (the default) on purpose: an anonymous upload has no
  -- uploader to be unique against, so every anonymous upload gets its own
  -- row rather than collapsing into one shared row. Anonymous callers
  -- still skip re-extraction through the feature cache.
  constraint photos_one_per_uploader_and_hash unique (uploaded_by, sha256),

  constraint photos_live_rows_have_a_path check (
    deleted_at is not null or storage_path is not null
  ),
  -- A purged row is anonymous immediately. storage_path may outlive the
  -- purge by design: only the Storage API can delete the object, and SQL
  -- cannot call it, so the path has to survive long enough for the
  -- reclaim sweep to use it. See 20260924000400_retention.sql.
  constraint photos_purged_rows_are_anonymous check (
    deleted_at is null or (uploaded_by is null and sha256 is null)
  )
);

comment on column public.photos.sha256 is
  'Content hash. Unique per uploader. Cross-user dedup happens in feature_cache, which shares numbers but never rows.';
comment on column public.photos.extraction_started_at is
  'Extraction lock held by one worker. Stale after 2 minutes so a crashed extraction retries.';

-- The dedup cache: one row per (distinct image, extractor), shared by
-- everyone who uploads those exact bytes.
--
-- This is what makes re-uploading a known image cheap, and it is safe to
-- share because it holds nothing but the anonymous measurements - no
-- uploader, no storage path, no photo id. It is a pure cache: truncating
-- it costs re-extraction and nothing else.
create table public.feature_cache (
  sha256 text not null,
  extractor_version text not null,
  computed jsonb not null,
  clip_embedding extensions.vector(512),
  extracted_at timestamptz not null default now(),
  primary key (sha256, extractor_version)
);

comment on table public.feature_cache is
  'Hash-keyed ComputedFeatures, shared across uploaders. Anonymous by construction: it references no photo and no user.';

-- Sweeping entries left behind by a superseded extractor.
create index feature_cache_extractor_version_idx
  on public.feature_cache (extractor_version);

-- One row per photo. `photo_id` is the primary key, which is already the
-- unique constraint that stops a second extractor from doubling the row.
create table public.features (
  photo_id uuid primary key references public.photos (id) on delete cascade,
  computed jsonb not null,
  clip_embedding extensions.vector(512),
  extracted_at timestamptz not null default now(),
  -- Bump to invalidate the cache. A row whose version is behind the
  -- current extractor is re-extracted rather than scored.
  extractor_version text not null
);

comment on table public.features is
  'This photo''s ComputedFeatures. Copied from feature_cache on a hit. Survives retention so the corpus stays usable for retraining, independently of whether the cache is ever pruned.';

create table public.assessments (
  id uuid primary key default extensions.gen_random_uuid(),
  photo_id uuid not null references public.photos (id) on delete cascade,
  source text not null check (source in ('vlm', 'local', 'human')),
  axes jsonb not null,
  model text,
  created_at timestamptz not null default now(),

  -- NULLS NOT DISTINCT so that two rows from the same source with no
  -- model recorded collide instead of silently doubling. Without it
  -- Postgres treats every NULL model as unique and the constraint never
  -- fires on exactly the case it is there to catch.
  constraint assessments_one_per_source_and_model
    unique nulls not distinct (photo_id, source, model)
);

comment on table public.assessments is
  'Assessment documents for the four judged axes, one per (photo, source, model).';

create table public.scores (
  id uuid primary key default extensions.gen_random_uuid(),
  photo_id uuid not null references public.photos (id) on delete cascade,
  context text not null,
  score numeric(3, 1) not null check (score >= 1 and score <= 10),
  axis_scores jsonb not null,
  weights_version text not null,
  created_at timestamptz not null default now()
);

comment on table public.scores is
  'Append-only. Re-scoring under a new weights_version adds a row rather than replacing one, so scores are only ever compared within a version.';

create index features_extractor_version_idx
  on public.features (extractor_version);

create index assessments_photo_id_source_idx
  on public.assessments (photo_id, source);

-- Partial: the retention sweep only ever looks at rows it has not already
-- purged, so the index stays small as the purged set grows.
create index photos_expires_at_idx
  on public.photos (expires_at)
  where deleted_at is null;

create index scores_photo_id_created_at_idx
  on public.scores (photo_id, created_at desc);
