-- Manual rollback for 20261004090000_operator_memberships.sql. Not run by the CLI.
-- WARNING: deletes every operational workspace and membership. Export
-- public.operator_workspaces (state, revision) first and confirm the selected project.
-- The fictional ui_draft_workspaces sandbox is not affected. Application code that
-- expects memberships falls back to the preview sandbox when these objects are absent.
begin;
drop function if exists public.operator_commit_workspace(uuid, integer, jsonb);
drop function if exists public.operator_writable_keys(text, jsonb);
drop policy if exists "active members read their workspace" on public.operator_workspaces;
drop policy if exists "members read own memberships" on public.operator_memberships;
drop function if exists public.operator_active_role(uuid);
drop table if exists public.operator_memberships;
drop table if exists public.operator_workspaces;
commit;
