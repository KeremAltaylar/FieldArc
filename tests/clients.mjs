/* Supabase clients for the tests.
   These live outside any *.test.mjs file on purpose: `node --test` treats every test file
   as its own run, so exporting helpers from a test file would re-register and re-run that
   file's tests inside every file that imported it. */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

/* What a listener is: no key beyond the public one, no session. */
export const anon = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
               { auth: { persistSession: false } });

/* Bypasses RLS. Used to set a test up and to tear it down — never to prove access. */
export const service = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
               { auth: { persistSession: false } });

/* A direct SQL connection, for the questions PostgREST cannot be asked. Grants are one:
   `information_schema`, `pg_class.relacl` and `has_table_privilege()` are not reachable
   through the REST API at all, so a test that asserts what a role can reach has to open
   the same session-pooler connection tools/sql.mjs uses. Connects per call and closes in
   a finally — a test file that leaked a pooled connection would hang `node --test`. */
export async function sql(text, params = []) {
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  try {
    /* Only bind when there is something to bind: node-postgres switches to the extended
       protocol the moment a values array is present, and that protocol refuses text
       containing more than one statement — which the DDL probes below need. */
    const res = params.length ? await c.query(text, params) : await c.query(text);
    return res.rows;
  } finally {
    await c.end();
  }
}
