-- The one new thing an anonymous reader can reach. Decided 2026-09-12: a direct policy
-- against public.public_features, not a signed URL minted by an edge function — the view
-- already IS the published-and-not-deleted predicate, security_invoker = off so it runs as
-- its owner regardless of who queries it, and anon already holds SELECT on it. Joining a
-- storage policy to it costs one migration; a signed URL would have cost a second runtime.
--
-- storage.foldername(name) splits an object's path on "/" and returns the segments before
-- the filename. Every recording path in this project — "<id>/take.wav" and
-- "<id>/hits/<slot>.<ext>" alike — begins with the feature id, so [1] is always it.

drop policy if exists recordings_anon_read_published on storage.objects;
create policy recordings_anon_read_published on storage.objects
  for select to anon
  using (
    bucket_id = 'recordings'
    and exists (
      select 1 from public.public_features f
      where f.id::text = (storage.foldername(name))[1]
    )
  );
