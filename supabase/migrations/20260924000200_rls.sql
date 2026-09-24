-- Row level security.
--
-- The service role bypasses all of this; it is what the extractor, the
-- scorer and the retention sweep run as. These policies govern the anon
-- and authenticated keys, which is to say the browser.

alter table public.photos enable row level security;
alter table public.features enable row level security;
alter table public.feature_cache enable row level security;
alter table public.assessments enable row level security;
alter table public.scores enable row level security;

-- Anyone may upload, signed in or not. The check stops a caller from
-- attributing an upload to somebody else: either it is anonymous, or it
-- is theirs.
create policy "callers may upload their own photos"
  on public.photos for insert
  to anon, authenticated
  with check (uploaded_by is null or uploaded_by = (select auth.uid()));

-- Owners read their own rows and nobody else's.
--
-- An anonymous upload has no owner, so `uploaded_by = auth.uid()` is
-- never true for it and it is unreadable through the anon key. That is
-- deliberate: a row nobody owns is a row nobody can prove is theirs.
-- Anonymous results are returned by the API route that already holds the
-- photo id, using the service role.
create policy "owners read their own photos"
  on public.photos for select
  to anon, authenticated
  using (uploaded_by is not null and uploaded_by = (select auth.uid()));

create policy "owners delete their own photos"
  on public.photos for delete
  to anon, authenticated
  using (uploaded_by is not null and uploaded_by = (select auth.uid()));

-- public.feature_cache gets RLS and no policies at all, which denies
-- every anon and authenticated request. It is keyed by content hash, so a
-- caller who could read it could test whether an image they already hold
-- has been uploaded by somebody else. Only the service role touches it.

-- Derived tables are readable only through a photo the caller owns, and
-- are never writable from the browser: extraction, assessment and scoring
-- all run server-side under the service role.
create policy "owners read features for their photos"
  on public.features for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.photos p
      where p.id = features.photo_id
        and p.uploaded_by is not null
        and p.uploaded_by = (select auth.uid())
    )
  );

create policy "owners read assessments for their photos"
  on public.assessments for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.photos p
      where p.id = assessments.photo_id
        and p.uploaded_by is not null
        and p.uploaded_by = (select auth.uid())
    )
  );

create policy "owners read scores for their photos"
  on public.scores for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.photos p
      where p.id = scores.photo_id
        and p.uploaded_by is not null
        and p.uploaded_by = (select auth.uid())
    )
  );
