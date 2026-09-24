-- Retention, in two phases.
--
-- Supabase refuses `delete from storage.objects`: "Direct deletion from
-- storage tables is not allowed. Use the Storage API instead." SQL
-- therefore cannot remove an image, and a function that pretended
-- otherwise would fail on the hosted platform even though it works
-- against a bare Postgres.
--
-- So retention splits:
--
--   Phase 1, here, on pg_cron: strip everything that identifies the row -
--     uploaded_by and sha256 - and stamp deleted_at. This is the part
--     that has to happen on schedule, and SQL can do all of it.
--
--   Phase 2, in the application: delete the object through the Storage
--     API, then null storage_path. `reclaimExpiredStorage` in @pps/db
--     does both, and it must be scheduled too - until it runs, the image
--     is still in the bucket.
--
-- storage_path deliberately survives phase 1. Nulling it before the
-- object is gone would lose the only pointer to the bytes and orphan them
-- permanently.
--
-- What survives a purge: features, assessments, scores - anonymous
-- numbers that stay useful for retraining - and a photos row with no
-- uploader and no content hash.

create or replace function public.expire_photos(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  purged integer;
begin
  with due as (
    select id
      from public.photos
     where deleted_at is null
       and expires_at <= now()
     order by expires_at
     limit p_limit
     -- skip locked so two overlapping sweeps divide the work instead of
     -- blocking on each other.
     for update skip locked
  )
  update public.photos p
     set uploaded_by = null,
         sha256      = null,
         deleted_at  = now()
    from due
   where p.id = due.id;

  get diagnostics purged = row_count;
  return purged;
end;
$$;

comment on function public.expire_photos(integer) is
  'Phase 1 of retention: anonymises photos past expires_at. Does NOT delete the image - only the Storage API can, so reclaimExpiredStorage in @pps/db must be scheduled as well.';

-- The user-facing delete button.
--
-- The caller must have removed the object through the Storage API first;
-- `deletePhoto` in @pps/db does exactly that before calling this, which
-- is why this one is safe to null storage_path.
create or replace function public.delete_photo(p_photo_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted boolean;
begin
  update public.photos
     set storage_path = null,
         uploaded_by  = null,
         sha256       = null,
         deleted_at   = now()
   where id = p_photo_id
     and deleted_at is null
  returning true into deleted;

  return coalesce(deleted, false);
end;
$$;

-- Phase 2's bookkeeping: called once the Storage API has confirmed the
-- objects are gone.
create or replace function public.mark_storage_reclaimed(p_photo_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared integer;
begin
  update public.photos
     set storage_path = null
   where id = any(p_photo_ids)
     and deleted_at is not null;

  get diagnostics cleared = row_count;
  return cleared;
end;
$$;

revoke all on function public.expire_photos(integer) from public;
revoke all on function public.delete_photo(uuid) from public;
revoke all on function public.mark_storage_reclaimed(uuid[]) from public;
grant execute on function public.expire_photos(integer) to service_role;
grant execute on function public.delete_photo(uuid) to service_role;
grant execute on function public.mark_storage_reclaimed(uuid[]) to service_role;

-- Schedule phase 1.
--
-- Guarded because pg_cron is a Supabase-managed extension: it is present
-- on the hosted platform and in `supabase start`, but not on a bare
-- Postgres used for CI. The warning is deliberately loud - a silent skip
-- here means retention is not running.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise warning 'pg_cron is unavailable: photo retention is NOT scheduled. Run "select public.expire_photos();" from an external scheduler instead.';
    return;
  end if;

  execute 'create extension if not exists pg_cron';

  if exists (select 1 from cron.job where jobname = 'expire-photos-daily') then
    perform cron.unschedule('expire-photos-daily');
  end if;

  -- 03:15 UTC, off the top of the hour so it does not pile up with
  -- everything else scheduled on the hour.
  perform cron.schedule(
    'expire-photos-daily',
    '15 3 * * *',
    $job$select public.expire_photos();$job$
  );
end;
$$;
