-- supabase/migrations/0013_created_by_backfill.sql
-- The 18 features migrated in stage 1 have created_by null, because stage 1 had no accounts.
-- The spec's setter surface shows created_by "so two setters can tell their work apart", and
-- an archive that is nobody's cannot do that. Attributes them to the earliest invited setter,
-- which is the person who actually made them, and touches nothing that already has an owner.
update public.features f
   set created_by = (select s.id from public.setters s order by s.invited_at asc limit 1)
 where f.created_by is null
   and exists (select 1 from public.setters);
