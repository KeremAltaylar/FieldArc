-- Anonymous readers get exactly one object: public_features. Everything else is closed, and
-- closed by default rather than by a policy that could be edited into openness.

alter table public.features   enable row level security;
alter table public.setters    enable row level security;
alter table public.recordings enable row level security;
alter table public.audit      enable row level security;

revoke all on public.features   from anon;
revoke all on public.setters    from anon;
revoke all on public.recordings from anon;
revoke all on public.audit      from anon;

grant select, insert, update, delete on public.features   to authenticated;
grant select, insert, update, delete on public.recordings to authenticated;
grant select                        on public.setters     to authenticated;
grant select, insert                on public.audit       to authenticated;
grant usage, select on sequence public.audit_id_seq to authenticated;

-- A setter is anyone with a row in setters. Being authenticated is not enough on its own,
-- so a stray account cannot write to the archive.
create or replace function public.is_setter()
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (select 1 from public.setters s where s.id = auth.uid());
$$;

drop policy if exists features_setter_all on public.features;
create policy features_setter_all on public.features
  for all to authenticated
  using (public.is_setter()) with check (public.is_setter());

drop policy if exists recordings_setter_all on public.recordings;
create policy recordings_setter_all on public.recordings
  for all to authenticated
  using (public.is_setter()) with check (public.is_setter());

drop policy if exists setters_read on public.setters;
create policy setters_read on public.setters
  for select to authenticated using (public.is_setter());

-- Insert and select only. No update policy and no delete policy exists, so both are refused
-- for every role: the record of what was done cannot be revised by the person who did it.
drop policy if exists audit_insert on public.audit;
create policy audit_insert on public.audit
  for insert to authenticated with check (setter_id = auth.uid() and public.is_setter());

drop policy if exists audit_read on public.audit;
create policy audit_read on public.audit
  for select to authenticated using (public.is_setter());
