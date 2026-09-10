/* Supabase clients for the tests.
   These live outside any *.test.mjs file on purpose: `node --test` treats every test file
   as its own run, so exporting helpers from a test file would re-register and re-run that
   file's tests inside every file that imported it. */
import { createClient } from "@supabase/supabase-js";

/* What a listener is: no key beyond the public one, no session. */
export const anon = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
               { auth: { persistSession: false } });

/* Bypasses RLS. Used to set a test up and to tear it down — never to prove access. */
export const service = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
               { auth: { persistSession: false } });
