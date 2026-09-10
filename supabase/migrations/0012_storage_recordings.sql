-- Private bucket. Stage 1 deferred this deliberately: there was no bucket until there was an
-- upload path. A public bucket would serve an unpublished point's recording to anyone who
-- guessed the path, which is the same failure as the archive being readable before it is
-- published — the file IS the archive, not an illustration of it.
--
-- Name collision note: this is storage.buckets.id/name 'recordings', unrelated to the
-- public.recordings TABLE created in 0002. Same word, different object — a bucket of audio
-- files versus a row-per-take metadata table. No functional overlap, but worth naming so
-- nobody goes looking for one when they mean the other.

insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- Setters read and write; nobody else touches it. Being merely authenticated is not enough —
-- public.is_setter() checks for a row in public.setters, which is what every other policy in
-- this project gates on. Listeners get their audio through a signed URL minted per request in
-- stage 3, so there is deliberately no anon policy here at all: the standing invariant is that
-- anon reaches exactly {public_features: SELECT} and nothing else.

drop policy if exists recordings_setter_read on storage.objects;
create policy recordings_setter_read on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and public.is_setter());

drop policy if exists recordings_setter_write on storage.objects;
create policy recordings_setter_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recordings' and public.is_setter());

drop policy if exists recordings_setter_update on storage.objects;
create policy recordings_setter_update on storage.objects
  for update to authenticated
  using (bucket_id = 'recordings' and public.is_setter());

-- DELETE is deliberately uncovered. There is no recordings_setter_delete policy and none
-- should be added: this project's deletes are soft everywhere — a feature is marked
-- deleted_at, never removed — and a recording that outlives its feature row is the safe
-- direction, not a leak. With RLS enabled and no policy for the command, `for delete` is
-- denied by default, so this is already correct as written.
--
-- The trap: supabase-js's `.storage.from(...).remove()` returns NO ERROR when RLS denies
-- the delete. The call resolves exactly as it would on success — no `.error`, a 200 — while
-- the object stays in the bucket untouched. This already fooled a verification check in this
-- project once: a probe asserted on the absence of an error, reported the delete as working,
-- and the file was still sitting in the bucket afterward. The next person who needs to
-- confirm a delete happened must check for the object's absence (list it, or try to download
-- it and expect a failure) — never trust `.remove()` returning without an `.error`.
