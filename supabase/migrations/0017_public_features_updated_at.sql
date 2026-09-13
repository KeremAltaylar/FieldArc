-- The one new thing a downloaded place needs from the server: when a row last changed. 0014's
-- view exposes created_at but not updated_at, so nothing today lets a client tell "the archive
-- I downloaded" apart from "the archive as it is now" without refetching every row's full
-- content and diffing it by hand. updated_at is already maintained by features_touch (0001)
-- on every write; this migration only widens what the view selects, not what it computes.
--
-- Not sensitive: unlike geometry, "when a row last changed" carries no location information,
-- so it needs no fuzzing and no stripping alongside sensitive/fuzz_m.

create or replace view public.public_features
with (security_invoker = off) as
select f.id, f.place, f.kind, f.geometry_public as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end as properties,
  f.created_at, f.updated_at
from public.features f
where f.deleted_at is null and (f.properties->>'published')::boolean is true;

grant select on public.public_features to anon, authenticated;
