-- Extensions.
--
-- Supabase convention is to keep extensions out of `public` so they are
-- never exposed through PostgREST. `extensions` is already on the default
-- search_path for the API roles.

create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
