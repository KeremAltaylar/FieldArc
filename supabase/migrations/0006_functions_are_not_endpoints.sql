-- PostgREST exposes every function that lives in the `public` schema as an RPC endpoint.
-- fuzz_point was created there in 0003, which already revoked EXECUTE from anon and
-- authenticated by name — but is_setter, created in 0005, was not, and Supabase grants
-- EXECUTE on every newly created public-schema function directly to anon and authenticated
-- (a default-privileges rule, not merely the ordinary PUBLIC grant every function also
-- gets from Postgres itself) unless a migration explicitly revokes it. So anon could call
-- public.fuzz_point(g, id, radius) with any g it chose, subtract the result from the point
-- it already got back from public_features, and recover the exact offset — and therefore
-- the exact true coordinate, with zero error. The fix that actually matters is removing the
-- function from `public` entirely, so it is not a candidate endpoint in the first place;
-- the explicit revokes are a second line of defence, not the primary fix. (Verified by
-- querying pg_proc.proacl and has_function_privilege directly — the plain `revoke ... from
-- public` pseudo-role alone left anon's own explicit grant untouched; see the fix report.)

-- Guarded: the ledger normally guarantees single application, but this file was patched
-- and re-run by hand once during review (see the fix report). ALTER FUNCTION has no IF
-- EXISTS clause, and a plain ALTER errors the second time because the function is no
-- longer in `public` to find — so check first.
do $$
begin
  if to_regprocedure('public.fuzz_point(jsonb, uuid, double precision)') is not null then
    alter function public.fuzz_point(jsonb, uuid, double precision) set schema private;
  end if;
end $$;

-- Re-point the view at the relocated function. Identical column list and logic to 0004;
-- security_invoker stays off, so the view owner's rights govern the base relation
-- (public.features) and its RLS — a querying role never needs its own grant on the table.
-- That does NOT extend to a function called inside the view body: Postgres still checks
-- the *querying* role's own EXECUTE privilege on private.fuzz_point, regardless of
-- security_invoker. Verified directly: with anon holding no EXECUTE on private.fuzz_point,
-- `anon().from("public_features").select(...)` failed outright with "permission denied for
-- function fuzz_point" — the view was unusable for the exact readers it exists for. So both
-- anon and authenticated need EXECUTE on private.fuzz_point (below); what makes that safe,
-- unlike the public.fuzz_point grant this migration just removed, is that private is not an
-- API-exposed schema, so PostgREST has nothing to route a direct rpc('fuzz_point', ...)
-- call to. The schema move is the security boundary here, not the grant.
create or replace view public.public_features
with (security_invoker = off) as
select
  f.id,
  f.place,
  f.kind,
  case
    when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
      then private.fuzz_point(f.geometry, f.id,
             coalesce((f.properties->>'fuzz_m')::double precision, 200))
    else f.geometry
  end as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end
    as properties,
  f.created_at
from public.features f
where f.deleted_at is null
  and (f.properties->>'published')::boolean is true;

grant select on public.public_features to anon, authenticated;

-- Strip the PUBLIC pseudo-role grant first, then name exactly the two roles that need to
-- reach this function through the view — anon and authenticated, and nothing wider. Safe
-- because private is not exposed by PostgREST: there is no rpc('fuzz_point') route to hand
-- this grant to, only the view's own internal call (see the comment on the view above).
revoke all on function private.fuzz_point(jsonb, uuid, double precision) from public;
grant execute on function private.fuzz_point(jsonb, uuid, double precision)
  to anon, authenticated;

-- is_setter() stays in `public` — RLS policies reference it unqualified and it must remain
-- reachable to `authenticated` for those policies to evaluate at all. But it was created
-- with the same default grant fuzz_point had before 0003 stripped it: anon holds EXECUTE
-- directly (confirmed via pg_proc.proacl: "anon=X/postgres", not merely inherited through
-- PUBLIC), and PostgREST would serve it as an RPC anon could call directly — it only
-- returns a boolean, but a security-relevant one, and no boolean function should be a free
-- oracle for an anonymous caller. Revoking only from the PUBLIC pseudo-role leaves that
-- explicit anon grant standing, so anon is named here too, not just PUBLIC.
revoke all on function public.is_setter() from public, anon;
grant execute on function public.is_setter() to authenticated;
