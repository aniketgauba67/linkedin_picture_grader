-- Extraction lock.
--
-- Two parallel /api/extract calls for the same photo must not both run the
-- VLM: that is a doubled bill and a duplicate assessment row. The claim is
-- a single UPDATE, which is what makes it safe. Under READ COMMITTED the
-- second caller blocks on the row lock, then re-evaluates its WHERE
-- against the row the winner just wrote, finds extraction_started_at set,
-- and matches nothing.
--
-- A caller that loses should poll for the features row, not start its own
-- extraction.

create or replace function public.claim_extraction(
  p_photo_id uuid,
  p_stale_after interval default interval '2 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  update public.photos
     set extraction_started_at = now()
   where id = p_photo_id
     and deleted_at is null
     and (
       extraction_started_at is null
       -- A crashed extraction leaves the lock set forever. After the
       -- stale window another worker is allowed to take it.
       or extraction_started_at < now() - p_stale_after
     )
  returning true into claimed;

  -- No row matched: somebody else holds the lock, or the photo is gone.
  return coalesce(claimed, false);
end;
$$;

comment on function public.claim_extraction(uuid, interval) is
  'Returns true if this caller now owns extraction for the photo, false if another worker holds it. Single-statement UPDATE, safe under concurrency.';

-- Releases the lock so a failed extraction can be retried immediately
-- rather than waiting out the stale window.
create or replace function public.release_extraction(p_photo_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.photos
     set extraction_started_at = null
   where id = p_photo_id;
$$;

revoke all on function public.claim_extraction(uuid, interval) from public;
revoke all on function public.release_extraction(uuid) from public;
grant execute on function public.claim_extraction(uuid, interval) to service_role;
grant execute on function public.release_extraction(uuid) to service_role;
