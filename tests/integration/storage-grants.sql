-- Grants a Supabase Postgres image applies to the storage schema (RLS still applies to
-- anon/authenticated). Run after the Storage API has migrated its schema.
grant usage on schema storage to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant all on all sequences in schema storage to anon, authenticated, service_role;
grant all on all functions in schema storage to anon, authenticated, service_role;
