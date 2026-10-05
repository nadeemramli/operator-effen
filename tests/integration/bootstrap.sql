-- Minimal platform roles a Supabase Postgres image provides, for a local real-component
-- stack (GoTrue, PostgREST, Storage API). Never run against a Supabase project.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login createrole;
create role supabase_storage_admin login createrole bypassrls;
grant anon, authenticated, service_role to supabase_storage_admin;
create schema auth authorization supabase_auth_admin;
create schema extensions;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role, supabase_auth_admin, supabase_storage_admin;
grant usage on schema public to anon, authenticated, service_role;
grant create on database postgres to supabase_storage_admin, supabase_auth_admin;
alter database postgres set search_path = "$user", public, extensions;
alter role supabase_auth_admin set search_path = auth;
alter role supabase_storage_admin set search_path = storage;
