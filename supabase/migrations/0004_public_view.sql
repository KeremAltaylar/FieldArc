-- The only object an anonymous reader is ever granted. It reads the table as its owner, so
-- the table itself stays unreadable and every anonymous read passes through these rules.

create or replace view public.public_features
with (security_invoker = off) as
select
  f.id,
  f.place,
  f.kind,
  -- Points only. A route marked sensitive publishes as drawn: offsetting every vertex would
  -- either destroy the walk or leave the true path recoverable from its shape, so there is
  -- no useful middle. Decided 2026-09-10; a caution in the UI can come later if it matters.
  case
    when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
      then public.fuzz_point(f.geometry, f.id,
             coalesce((f.properties->>'fuzz_m')::double precision, 200))
    else f.geometry
  end as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end
    as properties,
  f.created_at
from public.features f
where f.deleted_at is null
  and (f.properties->>'published')::boolean is true;

grant select on public.public_features to anon, authenticated;
