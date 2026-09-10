-- Two defects in one expression, both in `coalesce((f.properties->>'fuzz_m')::double
-- precision, 200)`:
--
--   fuzz_m: 0 — coalesce catches null and absence, not zero. A radius of 0 makes fuzz_point
--     return the true coordinate, rounded — while the view still stamps `fuzzed: true` on
--     the row. That is worse than publishing an open point: it publishes an exact position
--     under a label that asserts it is approximate. Floored at 25 m, so `sensitive` always
--     means moved.
--
--   fuzz_m: "about 200" — the cast is unguarded, and a cast error is not scoped to the row
--     that caused it. One malformed value takes down every anonymous read of every place,
--     which is the whole listener-facing surface. Guarded with a numeric-text test so a
--     value that is not a number falls back to the 200 m default (the safe direction: more
--     fuzz, not less) instead of raising.
--
-- The regex accepts what a JSON number renders as and what a numeric string renders as —
-- `properties->>'fuzz_m'` produces text either way, so one test covers both. A value that
-- fails it is treated as absent.
--
-- Column list, security_invoker setting and every other clause are identical to 0006. The
-- 0007 revoke/grant is re-issued at the bottom: `create or replace view` preserves the
-- existing ACL, so this is belt and braces rather than a repair — it makes the end state
-- correct no matter what order these files are applied in on a fresh database.

create or replace view public.public_features
with (security_invoker = off) as
select
  f.id,
  f.place,
  f.kind,
  case
    when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
      then private.fuzz_point(f.geometry, f.id,
             greatest(
               coalesce(
                 case
                   when f.properties->>'fuzz_m' ~
                        '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
                     then (f.properties->>'fuzz_m')::double precision
                 end,
                 200),
               25))
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

revoke all on public.public_features from anon, authenticated;
grant select on public.public_features to anon, authenticated;
