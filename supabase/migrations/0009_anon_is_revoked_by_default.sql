-- The root cause, addressed as a rule instead of as a list.
--
-- Supabase ships with
--   alter default privileges in schema public grant all on tables      to anon, authenticated;
--   alter default privileges in schema public grant all on sequences   to anon, authenticated;
--   alter default privileges in schema public grant execute on functions to anon, authenticated;
-- (verified in pg_default_acl for owner `postgres`, schema `public`). So every object this
-- project creates in `public` is granted to `anon` at the moment it is created, before any
-- migration says a word. Every migration on this branch answered that the same way: name
-- the object, add the grant it wanted, never revoke what was already there. That approach
-- has now failed twice — the fuzz_point RPC oracle (0006) and a writable public_features
-- (0007) — and both times the object looked correct in the migration that created it.
--
-- So: flip the default, then sweep what the old default already handed out, then re-grant
-- the single thing anonymous readers are supposed to have. After this, a new object in
-- `public` is born unreachable by anon and stays that way until someone writes a grant, and
-- tests/grants.test.mjs fails loudly if anything is ever reachable again.
--
-- `authenticated` is deliberately NOT blanket-revoked: 0008 has just re-issued its explicit
-- grants and stage 2's setters depend on them. service_role is untouched.

alter default privileges in schema public revoke all     on tables    from anon;
alter default privileges in schema public revoke all     on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- Postgres itself grants EXECUTE on every new function to the PUBLIC pseudo-role, which anon
-- inherits. Revoking from `anon` alone leaves that standing — the same half-fix 0006 had to
-- correct by hand. A function that `authenticated` needs now gets an explicit grant, which is
-- the discipline this file exists to enforce.
--
-- No `in schema public` on this one, and that is not an oversight. A schema-scoped default
-- ACL is MERGED ADDITIVELY onto the built-in default, so a schema-scoped revoke of PUBLIC's
-- EXECUTE has no effect; only the database-wide entry replaces the built-in default. Both
-- forms were measured here: with the schema-scoped revoke in place, a freshly created
-- public function still came back `{=X/postgres,...}` and has_function_privilege('anon', …)
-- was true; with this database-wide form, the same function came back with no PUBLIC entry
-- and anon false. It applies to functions created by `postgres` (the role migrations run
-- as), in any schema — including `private`, where fuzz_point already holds the explicit
-- grants 0006 gave it.
alter default privileges revoke execute on functions from public;

-- The residue the old default already left behind, swept in one statement each rather than
-- object by object. Known at the time of writing: public.audit_id_seq carried anon=rwU, and
-- public.touch_updated_at() and public.rls_auto_enable() carried EXECUTE for anon (both via
-- an explicit anon grant and via PUBLIC). None of the three was routable by PostgREST today
-- — a sequence has no route and a trigger/event-trigger function is not callable as an RPC —
-- but "not routable today" is a property of Supabase's configuration, not of this schema.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;

-- Everything an anonymous listener is allowed to reach, in one line.
grant select on public.public_features to anon;
