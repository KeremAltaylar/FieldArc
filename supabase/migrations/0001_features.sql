-- The app already speaks GeoJSON and already carries a route's patch inside its
-- properties. Storing that shape verbatim makes migration a copy and keeps one format
-- in one place; re-modelling it would buy nothing and cost a translation layer.

create table if not exists public.features (
  id          uuid primary key default gen_random_uuid(),
  place       text not null,
  kind        text not null check (kind in ('point', 'route')),
  geometry    jsonb not null,
  properties  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Every listener read is "this place, published, not deleted".
create index if not exists features_place_idx
  on public.features (place) where deleted_at is null;

create index if not exists features_published_idx
  on public.features (place)
  where deleted_at is null and (properties->>'published')::boolean is true;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists features_touch on public.features;
create trigger features_touch before update on public.features
  for each row execute function public.touch_updated_at();
