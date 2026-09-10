-- private.config.fuzz_salt existed only as an instruction to a human (plan, Task 4, step 4;
-- ledger ruling of 2026-09-10). On a fresh database 0001-0009 apply cleanly and the schema
-- looks complete — and then the ENTIRE anonymous view raises "fuzz salt missing or too
-- short" the moment one sensitive point is published, because fuzz_point fails closed and
-- the view calls it inside a CASE that any published row can reach. A database that reports
-- itself fully migrated and serves nothing.
--
-- 32 random bytes, hex-encoded to 64 characters, generated in the database so the value
-- never passes through a shell, a transcript or a file. (An earlier salt was echoed by npm
-- into a tool transcript and had to be rotated; see the ledger. This is why it is generated
-- here.)
--
-- `on conflict do nothing` is load-bearing, not tidiness: the salt on an existing database
-- is the key that every already-published sensitive point's offset was derived from.
-- Overwriting it would silently move every one of them — a corruption that looks like
-- nothing, since a moved point is exactly what a reader expects to see.
--
-- gen_random_bytes lives in the `extensions` schema on Supabase (pgcrypto is installed
-- there, not in public), so it is schema-qualified rather than left to search_path.

insert into private.config (key, value)
select 'fuzz_salt', encode(extensions.gen_random_bytes(32), 'hex')
on conflict (key) do nothing;
