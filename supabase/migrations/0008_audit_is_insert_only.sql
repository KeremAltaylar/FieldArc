-- `authenticated` could TRUNCATE the audit table, so the record of what a setter did was
-- erasable by that setter. 0002's comment, the spec's Authority section and the plan's
-- global constraints all say audit is insert-only for everyone; until this migration that
-- was true of rows and false of the table.
--
-- Cause, for the third time on this branch: Supabase sets
--   alter default privileges in schema public grant all on tables to anon, authenticated
-- so every table was born with `arwdDxtm` for both roles. 0005 answered that by ADDING the
-- grants it wanted and revoking only from anon. Measured before this migration:
--   features, setters, recordings, audit -> authenticated=arwdDxtm/postgres
-- TRUNCATE is the one that matters, because TRUNCATE is not subject to row-level security:
-- no policy on public.audit is consulted, so the append-only policy set in 0005 does not
-- see the statement at all. `truncate public.audit` and `truncate public.features` would
-- both have succeeded for any signed-in setter.
--
-- The fix is revoke-then-grant rather than a targeted `revoke truncate`: naming the one
-- privilege we noticed is what left the other holes. Re-issue exactly what 0005 intended
-- and nothing else. service_role is deliberately untouched — it is the trusted key.

revoke all on public.features   from authenticated;
revoke all on public.setters    from authenticated;
revoke all on public.recordings from authenticated;
revoke all on public.audit      from authenticated;
revoke all on sequence public.audit_id_seq from authenticated;

-- 0005's intent, stated once, in full.
grant select, insert, update, delete on public.features   to authenticated;
grant select, insert, update, delete on public.recordings to authenticated;
grant select                         on public.setters    to authenticated;
grant select, insert                 on public.audit      to authenticated;
grant usage, select on sequence public.audit_id_seq to authenticated;
