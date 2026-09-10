-- `sensitive` used to fuzz a position in the client, which is a promise the client makes to
-- itself: if the true coordinate reaches the browser, the flag is decoration and a den is
-- one devtools panel away. The offset is computed here and the truth never leaves.
--
-- Stable, because an offset re-rolled per request averages out to the true point over
-- repeated reads. Salted with a secret the reader does not have, because an offset derived
-- from the id alone can be recomputed by anyone holding the id — which is every reader.

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.config (
  key    text primary key,
  value  text not null
);

create or replace function public.fuzz_point(g jsonb, fid uuid, radius_m double precision)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  salt text;
  h    bigint;
  ang  double precision;
  r    double precision;
  lon  double precision;
  lat  double precision;
begin
  if g->>'type' <> 'Point' then
    return null;   -- callers must not publish a fuzzed non-point; see the view
  end if;

  select value into salt from private.config where key = 'fuzz_salt';
  if salt is null or length(salt) < 16 then
    -- Failing closed. An error here hides a position; a fallback would expose one.
    raise exception 'fuzz salt missing or too short';
  end if;

  h   := abs(hashtextextended(fid::text || salt, 0));
  ang := ((h % 36000)::double precision / 36000.0) * 2 * pi();
  -- sqrt so the offset is uniform over the disc rather than crowding the centre, which
  -- would make the true point the most likely guess.
  r   := sqrt((((h / 36000) % 100000))::double precision / 100000.0) * radius_m;

  lon := (g->'coordinates'->>0)::double precision;
  lat := (g->'coordinates'->>1)::double precision;

  return jsonb_build_object(
    'type', 'Point',
    'coordinates', jsonb_build_array(
      round((lon + (r * sin(ang)) / (111320.0 * cos(radians(lat))))::numeric, 6),
      round((lat + (r * cos(ang)) / 111320.0)::numeric, 6)
    )
  );
end $$;

revoke all on function public.fuzz_point(jsonb, uuid, double precision) from anon, authenticated;
