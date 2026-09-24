-- Storage.
--
-- One private bucket. Images go browser -> Storage directly through a
-- signed upload URL minted server-side by the service role; they never
-- pass through a Vercel route, which caps request bodies at 4.5MB.
--
-- There are deliberately NO policies on storage.objects. Supabase enables
-- RLS on it with none by default, which denies anon and authenticated
-- outright, and that is what we want: a signed URL carries its own
-- authorisation, so the upload needs no policy. It is also the only thing
-- that works for anonymous uploads, which have no auth.uid() for an
-- owner-scoped policy to match on.
--
-- Reads go the same way: `createSignedUrl` from the service role, in the
-- API route that already knows which photo the caller is allowed to see.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'photos',
  'photos',
  false,
  -- Matches MAX_UPLOAD_BYTES in @pps/schema.
  10 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
