-- Private bucket. Stage 1 deferred this deliberately: there was no bucket until there was an
-- upload path. A public bucket would serve an unpublished point's recording to anyone who
-- guessed the path, which is the same failure as the archive being readable before it is
-- published — the file IS the archive, not an illustration of it.

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
