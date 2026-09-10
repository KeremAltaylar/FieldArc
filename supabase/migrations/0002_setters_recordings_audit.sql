create table if not exists public.setters (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null,
  invited_at  timestamptz not null default now()
);

-- One row per attached file. `peaks` is the ~200-point waveform summary the B1 envelope
-- bridge already reads as a control curve, so it must survive the move to a server.
create table if not exists public.recordings (
  id            uuid primary key default gen_random_uuid(),
  feature_id    uuid not null references public.features (id) on delete cascade,
  storage_path  text not null unique,
  mime          text not null,
  bytes         bigint not null check (bytes > 0),
  duration_s    double precision,
  peaks         jsonb,
  descriptors   jsonb,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists recordings_feature_idx on public.recordings (feature_id);

-- Append-only by construction as well as by policy: no update or delete policy is ever
-- written for this table, so even a setter cannot revise the record of what they did.
create table if not exists public.audit (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  setter_id  uuid references auth.users (id) on delete set null,
  action     text not null check (action in
               ('sign_in', 'create', 'update', 'delete', 'publish', 'unpublish')),
  target_id  text,
  detail     jsonb not null default '{}'::jsonb
);

create index if not exists audit_at_idx on public.audit (at desc);
