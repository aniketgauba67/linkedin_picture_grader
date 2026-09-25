-- One lease per reusable feature-cache identity. A photo row is an upload,
-- not the unit of expensive extraction work.
create table public.extraction_claims (
  sha256 text not null,
  extractor_version text not null,
  owner_photo_id uuid not null references public.photos (id) on delete cascade,
  claim_token uuid not null,
  claimed_at timestamptz not null,
  primary key (sha256, extractor_version)
);

alter table public.extraction_claims enable row level security;

-- The token fences an expired worker: its eventual release cannot delete
-- a newer worker's lease for the same content.
create function public.claim_extraction(
  p_photo_id uuid,
  p_sha256 text,
  p_extractor_version text,
  p_stale_after interval default interval '2 minutes'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token uuid;
begin
  if not exists (
    select 1 from public.photos
     where id = p_photo_id and deleted_at is null and sha256 = p_sha256
  ) or exists (
    select 1 from public.feature_cache
     where sha256 = p_sha256 and extractor_version = p_extractor_version
  ) then
    return null;
  end if;

  insert into public.extraction_claims
    (sha256, extractor_version, owner_photo_id, claim_token, claimed_at)
  values
    (p_sha256, p_extractor_version, p_photo_id, extensions.gen_random_uuid(), clock_timestamp())
  on conflict (sha256, extractor_version) do update
    set owner_photo_id = excluded.owner_photo_id,
        claim_token = excluded.claim_token,
        claimed_at = excluded.claimed_at
    where extraction_claims.claimed_at < clock_timestamp() - p_stale_after
  returning claim_token into token;

  -- A previous worker can fill the cache and release its lease between
  -- the first cache check and this insert. Check again after acquiring.
  if token is not null and exists (
    select 1 from public.feature_cache
     where sha256 = p_sha256 and extractor_version = p_extractor_version
  ) then
    delete from public.extraction_claims
     where sha256 = p_sha256
       and extractor_version = p_extractor_version
       and claim_token = token;
    return null;
  end if;

  return token;
end;
$$;

create function public.release_extraction(
  p_sha256 text,
  p_extractor_version text,
  p_claim_token uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.extraction_claims
   where sha256 = p_sha256
     and extractor_version = p_extractor_version
     and claim_token = p_claim_token;
$$;

drop function public.claim_extraction(uuid, interval);
drop function public.release_extraction(uuid);

revoke all on table public.extraction_claims from public;
revoke all on function public.claim_extraction(uuid, text, text, interval) from public;
revoke all on function public.release_extraction(text, text, uuid) from public;
grant execute on function public.claim_extraction(uuid, text, text, interval) to service_role;
grant execute on function public.release_extraction(text, text, uuid) to service_role;

comment on table public.extraction_claims is
  'Expiring extraction leases keyed exactly like feature_cache. Claim tokens prevent stale workers releasing successors.';

comment on column public.photos.extraction_started_at is
  'Legacy photo-scoped lease; no longer used by claim_extraction.';
