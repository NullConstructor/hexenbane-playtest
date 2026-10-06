-- Test-only: recreates the Supabase roles and default grants on a plain PostgreSQL server so
-- the migration and security checks can run without the Supabase CLI. Never run this on a
-- real Supabase project (the roles already exist there).
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants everything on new public tables to the API roles by default; RLS and the
-- migration's revokes are what keep data private. Reproduce that so the test is honest.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
