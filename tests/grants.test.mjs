/* What each role can reach, enumerated rather than sampled.
 *
 * Every other test in this suite asks "can anon do this particular thing?" — and every hole
 * this branch has shipped was a thing nobody thought to ask about: the fuzz_point RPC, then
 * UPDATE and DELETE through the view, then TRUNCATE on audit. All three were created by the
 * same Supabase default privilege (`alter default privileges in schema public grant all ...
 * to anon, authenticated`), and all three were invisible to a test that checks a list.
 *
 * So this file inverts the question: list everything anon can reach and assert the list is
 * exactly one entry. A new table, view, sequence or function that arrives with the default
 * grant attached fails here on the next run, whether or not anyone thought to test it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "./clients.mjs";

const TABLE_PRIVS = "('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')";

/* Effective privileges, not granted ones: has_table_privilege() also sees what a role
   inherits through the PUBLIC pseudo-role, which is exactly the half 0006 had to fix by
   hand after a plain `revoke ... from public` was assumed sufficient. */
const reachableTables = (role) => sql(`
  select c.relname, p.priv
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (values ${TABLE_PRIVS}) as p(priv)
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'm', 'p', 'f')
    and has_table_privilege('${role}', c.oid, p.priv)
  order by c.relname, p.priv`);

const reachableSequences = (role) => sql(`
  select c.relname, p.priv
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (values ('SELECT'), ('USAGE'), ('UPDATE')) as p(priv)
  where n.nspname = 'public'
    and c.relkind = 'S'
    and has_sequence_privilege('${role}', c.oid, p.priv)
  order by c.relname, p.priv`);

const flat = (rows) => rows.map((r) => `${r.relname}:${r.priv}`);

test("anon reaches exactly one object in schema public, with exactly one privilege", async () => {
  assert.deepEqual(flat(await reachableTables("anon")), ["public_features:SELECT"]);
});

test("the API's own view of anon's grants agrees", async () => {
  // The same claim through information_schema, which is what a reviewer reads. Kept
  // alongside the pg_class sweep because the two disagree when a grant arrives via
  // PUBLIC: this view would show nothing, has_table_privilege would show the access.
  const rows = await sql(`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'
    order by table_name, privilege_type`);
  assert.deepEqual(rows.map((r) => `${r.table_name}:${r.privilege_type}`),
                   ["public_features:SELECT"]);
});

test("anon reaches no sequence in schema public", async () => {
  // public.audit_id_seq carried anon=rwU until 0009 — not routable by PostgREST, but a
  // sequence a reader can call nextval() on is a row counter for a table it cannot read.
  assert.deepEqual(flat(await reachableSequences("anon")), []);
});

test("anon can execute no function in schema public", async () => {
  // PostgREST publishes every function in `public` as an RPC endpoint. This is the check
  // that would have caught the fuzz_point oracle on the commit that introduced it, and it
  // still catches touch_updated_at() and rls_auto_enable(), which held EXECUTE via PUBLIC.
  const rows = await sql(`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by p.proname`);
  assert.deepEqual(rows.map((r) => r.proname), []);
});

test("a table created in public after this point is not granted to anon", async () => {
  // The invariant itself, exercised rather than read: 0009 flipped the default privilege,
  // so this asserts what stage 2's first `create table` will actually get.
  await sql(`create table public.grants_probe (id int primary key, n bigserial)`);
  try {
    const tables = flat(await reachableTables("anon")).filter((s) => s.startsWith("grants_probe:"));
    const seqs = flat(await reachableSequences("anon")).filter((s) => s.startsWith("grants_probe"));
    assert.deepEqual(tables, [], "a new table was born readable by anon");
    assert.deepEqual(seqs, [], "a new sequence was born reachable by anon");
  } finally {
    await sql(`drop table if exists public.grants_probe`);
  }
});

test("a function created in public after this point is not executable by anon", async () => {
  await sql(`create function public.grants_probe_fn() returns int language sql as $$ select 1 $$`);
  try {
    const rows = await sql(`
      select has_function_privilege('anon', 'public.grants_probe_fn()', 'EXECUTE') as ok`);
    assert.equal(rows[0].ok, false, "a new function was born callable by anon as an RPC");
  } finally {
    await sql(`drop function if exists public.grants_probe_fn()`);
  }
});

test("authenticated holds exactly the four tables' intended privileges, and no TRUNCATE", async () => {
  // TRUNCATE is the one that matters and the one 0005 left behind: it is not subject to
  // row-level security, so `truncate public.audit` would never have met the append-only
  // policy — a setter could have erased the record of what they did, and `truncate
  // public.features` the archive itself.
  assert.deepEqual(flat(await reachableTables("authenticated")), [
    "audit:INSERT",
    "audit:SELECT",
    "features:DELETE",
    "features:INSERT",
    "features:SELECT",
    "features:UPDATE",
    "public_features:SELECT",
    "recordings:DELETE",
    "recordings:INSERT",
    "recordings:SELECT",
    "recordings:UPDATE",
    "setters:SELECT"
  ]);
});

test("authenticated can still reach the audit sequence, and only that sequence", async () => {
  // Revoking too much is the other way to break this: without usage on audit_id_seq an
  // append-only table cannot be appended to.
  assert.deepEqual(flat(await reachableSequences("authenticated")),
                   ["audit_id_seq:SELECT", "audit_id_seq:USAGE"]);
});

test("no default privilege in schema public hands anything to anon", async () => {
  // Scoped to the `postgres` role because that is who migrations connect as and therefore
  // who owns every object this project creates. Supabase's own supabase_admin defaults
  // still name anon and are not ours to change — nothing in this project is created by
  // that role, so they grant nothing here.
  const rows = await sql(`
    select d.defaclobjtype,
           case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
           a.privilege_type
    from pg_default_acl d, aclexplode(d.defaclacl) a
    where d.defaclrole = 'postgres'::regrole
      and d.defaclnamespace = 'public'::regnamespace
      and (a.grantee = 0 or a.grantee::regrole::text = 'anon')
    order by 1, 2, 3`);
  assert.deepEqual(rows, [], "an object created in public would be granted to anon at birth");
});
