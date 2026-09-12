-- A sensitive point's recording is not anon-readable at all.
--
-- 0015 keyed anon's one new reach to a feature being PUBLISHED and stopped there. But a field
-- recorder writes metadata into the file itself: BWF `bext` and iXML chunks routinely carry GPS
-- coordinates, and this codebase already reads those chunks (recordingTime() in index.html pulls
-- the originator and timestamp out of them). So a published sensitive point whose audio anon can
-- download hands over the true coordinate inside the file — which defeats the entire apparatus
-- built to hide it: the offset computed at rest (0014), the `sensitive`/`fuzz_m` strip in the
-- view, the oracle closed in 0006. None of it matters if the WAV says where it was recorded.
--
-- Real stripping — parsing arbitrary WAV/BWF/iXML chunk trees and rewriting them without
-- corrupting the audio — is a follow-up, deliberately NOT attempted here. It is the kind of
-- parser that fails quietly on the one recorder nobody tested, and a quiet failure leaks exactly
-- the coordinate it was written to protect. Until it exists the conservative default stands: a
-- sensitive point has no anon-audio path at all. A listener still SEES it, fuzzed, as before; they
-- simply do not hear it. Silence is a safe failure. A leaked coordinate is not.
--
-- WHY THE PREDICATE READS THE VIEW AND NOT public.features, which is where the real `sensitive`
-- flag lives. Measured, not assumed: an RLS policy expression is evaluated with the privileges of
-- the QUERYING role, not the policy owner's — unlike a `security_invoker = off` view, which is
-- why 0015's join against public.public_features works at all. A first draft of this policy put
-- `exists (select 1 from public.features ...)` in the USING clause and every anon download failed
-- outright with `permission denied for table features` (403 AccessDenied), including the published
-- non-sensitive case 0015 exists to allow. anon holds no SELECT on that table (0009) and must not
-- be given one; it holds no USAGE on `private` either, so a definer view or function there would
-- need a new grant as well. The plan's Global Constraints allow `anon` exactly ONE new reach this
-- stage, already spent on this policy — so this migration adds no grant and no object, and works
-- with what anon already has: SELECT on public.public_features.
--
-- `properties->>'fuzzed'` is the marker 0014's view writes for precisely the rows whose position
-- is being hidden: `when sensitive and kind = 'point'`. It is written by the view and by nothing
-- else, and tests/fuzz.test.mjs already pins both halves of it (a sensitive point carries
-- `fuzzed: true`; a sensitive route does not). It is load-bearing here, so a future change to the
-- view's properties expression has to come back to this policy.
--
-- A sensitive ROUTE's recording therefore stays readable, and that is deliberate rather than
-- overlooked: 0004 decided a route marked sensitive publishes as drawn, because offsetting every
-- vertex would either destroy the walk or leave the true path recoverable from its shape. Its
-- geometry is already public in full, so there is no hidden coordinate for its file's metadata to
-- give away. `sensitive` on a route buys a caution in the UI, not a concealed position.
--
-- `published` still comes from the view, unchanged: it already IS the
-- published-and-not-soft-deleted predicate, so unpublishing a feature revokes access to its audio
-- on the very next request.

drop policy if exists recordings_anon_read_published on storage.objects;
create policy recordings_anon_read_published on storage.objects
  for select to anon
  using (
    bucket_id = 'recordings'
    and exists (
      select 1 from public.public_features f
      where f.id::text = (storage.foldername(name))[1]
        and (f.properties->>'fuzzed')::boolean is not true
    )
  );
