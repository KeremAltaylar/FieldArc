-- The anonymous view was writable, and that let a reader delete the archive and defeat the fuzz.
--
-- Supabase sets `alter default privileges in schema public grant all on tables to anon`, so
-- `public_features` was granted ALL to anon the moment it was created. 0004 and 0006 then each
-- added `grant select` and never revoked the rest. The view is auto-updatable (single FROM, no
-- DISTINCT or GROUP BY) and declares `security_invoker = off`, so a write through it executes
-- as the view owner — the table owner — and never meets the row-level security added in 0005.
--
-- Measured before this migration, with nothing but the public anon key:
--   UPDATE {kind: 'route'} -> ACCEPTED. The view fuzzes only `when sensitive and kind = 'point'`,
--     so the row then returned the TRUE coordinate at 0.00 m error, with `fuzzed: true` gone.
--   DELETE -> ACCEPTED, base row gone.
--
-- This is the second time default privileges have out-granted a migration; the first was the
-- fuzz_point RPC oracle closed in 0006. Naming objects one at a time is what keeps failing.
-- 0008 turns that into an invariant. This migration is the emergency half: shut the door.

revoke all on public.public_features from anon, authenticated;
grant select on public.public_features to anon, authenticated;
