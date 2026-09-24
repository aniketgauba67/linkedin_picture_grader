-- Minimal stand-in for the parts of a Supabase instance that the
-- migrations reference: the auth and storage schemas, the API roles, and
-- auth.uid().
--
-- This is a TEST FIXTURE, not a migration. It exists so the real
-- migrations can be applied unchanged to a bare Postgres in CI, where
-- `supabase start` needs Docker. It is never applied to a real project -
-- Supabase creates all of this itself.

create schema if not exists auth;
create schema if not exists storage;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase reads the uid out of the request JWT claims. The shim reads it
-- out of a GUC so a test can impersonate a user with set_config().
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

-- Hosted Supabase refuses direct writes to the storage tables: only the
-- Storage API may remove an object. A plain table here would let a
-- migration that deletes from storage.objects pass locally and fail in
-- production, which is exactly what happened once. The shim reproduces
-- the restriction so that can't recur.
create or replace function storage.refuse_direct_object_write()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.';
end;
$$;

drop trigger if exists refuse_direct_delete on storage.objects;
create trigger refuse_direct_delete
  before delete on storage.objects
  for each row execute function storage.refuse_direct_object_write();

grant usage on schema public, auth, storage to anon, authenticated, service_role;
