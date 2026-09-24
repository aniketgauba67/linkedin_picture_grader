-- Recording an extraction.
--
-- Two writes belong together: this photo's feature row, and the
-- hash-keyed cache entry that lets the next upload of the same bytes skip
-- the work. Doing them in one function makes them one transaction, so
-- there is no window where a photo has features that nothing else can
-- reuse, or a cache entry for a photo that has none.

create or replace function public.record_extraction(
  p_photo_id uuid,
  p_sha256 text,
  p_computed jsonb,
  p_extractor_version text,
  -- Text rather than vector: PostgREST sends JSON, and pgvector's own
  -- text form casts cleanly here while a bare array does not.
  p_embedding text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  embedding extensions.vector(512) := nullif(p_embedding, '')::extensions.vector(512);
begin
  insert into public.features (photo_id, computed, clip_embedding, extractor_version, extracted_at)
  values (p_photo_id, p_computed, embedding, p_extractor_version, now())
  on conflict (photo_id) do update
    set computed          = excluded.computed,
        clip_embedding    = excluded.clip_embedding,
        extractor_version = excluded.extractor_version,
        extracted_at      = excluded.extracted_at;

  -- A purged photo has no hash left, and there is nothing to cache
  -- against. The per-photo row above is still the point of the call.
  if p_sha256 is null then
    return;
  end if;

  insert into public.feature_cache (sha256, extractor_version, computed, clip_embedding)
  values (p_sha256, p_extractor_version, p_computed, embedding)
  -- First writer wins. The measurements are a pure function of the bytes
  -- and the extractor version, so a second write would only rewrite
  -- identical values.
  on conflict (sha256, extractor_version) do nothing;
end;
$$;

comment on function public.record_extraction(uuid, text, jsonb, text, text) is
  'Writes a photo''s features and the shared hash-keyed cache entry in one transaction.';

-- The cache is unbounded otherwise: every extractor version leaves its
-- entries behind forever. Retention does not touch it - it holds no user
-- data - so this is how it stays bounded.
create or replace function public.prune_feature_cache(p_keep_version text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  pruned integer;
begin
  delete from public.feature_cache where extractor_version <> p_keep_version;
  get diagnostics pruned = row_count;
  return pruned;
end;
$$;

revoke all on function public.record_extraction(uuid, text, jsonb, text, text) from public;
revoke all on function public.prune_feature_cache(text) from public;
grant execute on function public.record_extraction(uuid, text, jsonb, text, text) to service_role;
grant execute on function public.prune_feature_cache(text) to service_role;
