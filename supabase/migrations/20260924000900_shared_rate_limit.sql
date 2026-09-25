-- Shared, one-hour counters for upload registration and extraction.
-- The IP key is an HMAC made server-side; raw addresses never reach this table.
create table public.rate_limit_counters (
  scope text not null check (scope in ('global', 'ip')),
  subject text not null,
  count integer not null check (count >= 0),
  reset_at timestamptz not null,
  primary key (scope, subject)
);

create index rate_limit_counters_reset_at_idx
  on public.rate_limit_counters (reset_at);

alter table public.rate_limit_counters enable row level security;
revoke all on table public.rate_limit_counters from public;

-- Lock global first, then IP, for every caller. This serializes decisions
-- across Vercel instances and avoids deadlocks. Neither count is incremented
-- when either limit denies the request.
create function public.consume_rate_limit(
  p_ip_hash text,
  p_per_ip_limit integer,
  p_global_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  global_count integer;
  global_reset_at timestamptz;
  ip_count integer;
  ip_reset_at timestamptz;
  at_time timestamptz;
  next_reset_at timestamptz;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_per_ip_limit is null or p_per_ip_limit < 1
     or p_global_limit is null or p_global_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'Invalid rate-limit configuration';
  end if;

  insert into public.rate_limit_counters (scope, subject, count, reset_at)
  values ('global', 'all', 0, clock_timestamp() + make_interval(secs => p_window_seconds))
  on conflict do nothing;

  select count, reset_at into global_count, global_reset_at
    from public.rate_limit_counters
   where scope = 'global' and subject = 'all'
   for update;

  at_time := clock_timestamp();
  if global_reset_at > at_time and global_count >= p_global_limit then
    return jsonb_build_object(
      'allowed', false, 'bucket', 'global',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from global_reset_at - at_time))::integer)
    );
  end if;

  insert into public.rate_limit_counters (scope, subject, count, reset_at)
  values ('ip', p_ip_hash, 0, clock_timestamp() + make_interval(secs => p_window_seconds))
  on conflict do nothing;

  select count, reset_at into ip_count, ip_reset_at
    from public.rate_limit_counters
   where scope = 'ip' and subject = p_ip_hash
   for update;

  at_time := clock_timestamp();
  if ip_reset_at > at_time and ip_count >= p_per_ip_limit then
    return jsonb_build_object(
      'allowed', false, 'bucket', 'ip',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from ip_reset_at - at_time))::integer)
    );
  end if;

  next_reset_at := at_time + make_interval(secs => p_window_seconds);
  update public.rate_limit_counters
     set count = case when reset_at <= at_time then 1 else count + 1 end,
         reset_at = case when reset_at <= at_time then next_reset_at else reset_at end
   where scope = 'global' and subject = 'all';

  update public.rate_limit_counters
     set count = case when reset_at <= at_time then 1 else count + 1 end,
         reset_at = case when reset_at <= at_time then next_reset_at else reset_at end
   where scope = 'ip' and subject = p_ip_hash;

  return jsonb_build_object('allowed', true, 'bucket', null, 'retryAfterSeconds', 0);
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer, integer) to service_role;

-- An indexed, hourly sweep removes counters after their windows end. No
-- request scans the table for cleanup. At most 500 new IP buckets per hour
-- can be consumed under the global limit.
create function public.prune_rate_limit_counters()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.rate_limit_counters
   where reset_at < clock_timestamp() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_rate_limit_counters() from public;
grant execute on function public.prune_rate_limit_counters() to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise warning 'pg_cron is unavailable: rate-limit counter cleanup is NOT scheduled.';
    return;
  end if;

  execute 'create extension if not exists pg_cron';
  if exists (select 1 from cron.job where jobname = 'prune-rate-limit-counters-hourly') then
    perform cron.unschedule('prune-rate-limit-counters-hourly');
  end if;
  perform cron.schedule(
    'prune-rate-limit-counters-hourly',
    '17 * * * *',
    $job$select public.prune_rate_limit_counters();$job$
  );
end;
$$;
