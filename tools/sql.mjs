/* Applies SQL migrations to the Supabase project over a direct Postgres connection.

   Three doors were tried before this one, and the reasons matter because the next person
   will reach for them in the same order:

     `supabase db push` with the local stack — wants Docker, which this machine has not.
     `supabase db push` linked — wants the database password anyway, so it buys nothing.
     The Management API `/database/query` with a personal access token — runs every query
       in a READ-ONLY transaction. `create schema` comes back as 25006. That endpoint reads.

   So: DATABASE_URL, which is the connection string from Settings -> Database. It carries
   the password, it is scoped to this one project rather than to the whole account, and it
   is resettable in one click when the work is done.

   Idempotent twice over: every migration is written to be safely re-runnable (`create table
   if not exists`, `create or replace`), and a ledger records what has already been applied,
   so a normal run does nothing to a database that is already current.

   Usage:
     node --env-file=.env.local tools/sql.mjs                 apply every pending migration
     node --env-file=.env.local tools/sql.mjs path/to.sql     apply one file
     node --env-file=.env.local tools/sql.mjs --query "sql"   run one statement, print rows
*/
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL missing from .env.local.\n" +
    "Supabase dashboard -> Settings -> Database -> Connection string -> URI."
  );
}

const MIGRATIONS = "supabase/migrations";
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

/* One statement or a whole file — node-postgres sends multi-statement text as an implicit
   transaction, so a migration that fails halfway leaves nothing behind. */
async function run(sql) {
  const res = await client.query(sql);
  return Array.isArray(res) ? res.at(-1)?.rows ?? [] : res.rows ?? [];
}

try {
  const arg = process.argv[2];

  if (arg === "--query") {
    console.log(JSON.stringify(await run(process.argv[3]), null, 2));
  } else if (arg) {
    await run(readFileSync(arg, "utf8"));
    await run(
      `insert into private.migrations (name) values ($$${basename(arg)}$$)
       on conflict (name) do nothing;`
    );
    console.log(`applied ${basename(arg)}`);
  } else {
    await run(`create schema if not exists private;
               create table if not exists private.migrations (
                 name text primary key,
                 applied_at timestamptz not null default now()
               );`);
    const done = new Set((await run("select name from private.migrations")).map((r) => r.name));
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const pending = files.filter((f) => !done.has(f));

    if (!pending.length) {
      console.log(`nothing to apply — ${files.length} migrations already in place`);
    }
    for (const f of pending) {
      await run(readFileSync(join(MIGRATIONS, f), "utf8"));
      await run(`insert into private.migrations (name) values ($$${f}$$)
                 on conflict (name) do nothing;`);
      console.log(`applied ${f}`);
    }
  }
} finally {
  await client.end();
}
