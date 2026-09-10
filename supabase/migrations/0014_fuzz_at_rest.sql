-- The fuzzed position is computed once, when the row is written, instead of on every
-- anonymous read. That removes the last reason for `anon` to hold EXECUTE on the fuzz
-- function: the view now selects a column. A future change to the API's exposed schemas
-- therefore cannot reopen the oracle closed in 0006.
--
-- The radius expression below is NOT the brief's bare
--   greatest(coalesce(nullif(new.properties->>'fuzz_m', '')::double precision, 200), 25)
-- Measured directly: `nullif('about two hundred', '')::double precision` raises
-- 22P02 ("invalid input syntax for type double precision"), uncaught, inside a BEFORE
-- INSERT/UPDATE trigger — which fails the write outright instead of falling back. 0011
-- guarded exactly this case at read time so a malformed fuzz_m degrades to the 200 m
-- default rather than taking the row (then: the whole anonymous view) down. Moving the
-- computation to write time must not drop that guard, so the same numeric-text regex is
-- reused here. Every other line is the brief's SQL verbatim.

alter table public.features add column if not exists geometry_public jsonb;

create or replace function private.refresh_geometry_public()
returns trigger language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  if (new.properties->>'sensitive')::boolean is true and new.kind = 'point' then
    new.geometry_public := private.fuzz_point(
      new.geometry, new.id,
      greatest(
        coalesce(
          case
            when new.properties->>'fuzz_m' ~
                 '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
              then (new.properties->>'fuzz_m')::double precision
          end,
          200),
        25));
  else
    new.geometry_public := new.geometry;
  end if;
  return new;
end $$;

drop trigger if exists features_fuzz on public.features;
create trigger features_fuzz before insert or update on public.features
  for each row execute function private.refresh_geometry_public();

update public.features set geometry = geometry;   -- fires the trigger for existing rows

create or replace view public.public_features
with (security_invoker = off) as
select f.id, f.place, f.kind, f.geometry_public as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end as properties,
  f.created_at
from public.features f
where f.deleted_at is null and (f.properties->>'published')::boolean is true;

revoke all on public.public_features from anon, authenticated;
grant select on public.public_features to anon, authenticated;
revoke all on function private.fuzz_point(jsonb, uuid, double precision) from anon, authenticated;
