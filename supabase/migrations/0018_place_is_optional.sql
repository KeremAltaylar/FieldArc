-- supabase/migrations/0018_place_is_optional.sql
-- A point may belong to no park and no route (Kerem, 2026-09-20): "points that can be placed
-- without attaching to a park". Open world shows these anywhere; nothing else changes.
--
-- Deliberately only the constraint. public_features selects place as-is and needs no edit; the
-- fuzz trigger keys on properties->>'sensitive'; RLS never mentions place. A NULL place is
-- "belongs to nothing", which is why this is a nullable column rather than a 'world' sentinel:
-- a sentinel would join against the place catalogue and find nothing, in every query that
-- already treats place as a foreign key by convention.
alter table public.features alter column place drop not null;
