-- Manual rollback for 20261005090000_operator_trusted_commands.sql. Not run by the CLI.
-- Run before 20261004090000_operator_memberships.down.sql. Confirm the selected project and
-- export operator_commits / operator_membership_audit first: both are audit evidence.
-- After this rollback no operational write path exists (the unsafe replacement-state RPC
-- is intentionally NOT restored); members can read but not save until re-applied.
-- Operational source PDFs in the operator-sources bucket are not deleted here: remove them
-- through the Storage API after export if the bucket itself must go.
begin;
drop policy if exists "site importers upload operational sources" on storage.objects;
drop policy if exists "authorized colleagues read operational sources" on storage.objects;
drop function if exists public.operator_source_access(text, text);
drop function if exists public.operator_grant_membership(uuid, uuid, text, text, text, text, text);
drop function if exists public.operator_revoke_membership(uuid, text);
drop function if exists public.operator_set_site_policy(uuid, jsonb, text);
drop policy if exists "membership administrators read managed rows" on public.operator_memberships;
drop table if exists public.operator_membership_audit;
drop function if exists public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text);
drop table if exists public.operator_commits;
drop schema if exists operator_private cascade;
drop function if exists public.operator_has_capability(uuid, text);
drop function if exists public.operator_capabilities(uuid);
drop table if exists public.operator_role_capabilities, public.operator_command_rules,
  public.operator_grantable_roles;
-- Restore the earlier site-only membership shape. All-sites and HR memberships cannot be
-- represented there and are removed (they are listed in the exported audit).
delete from public.operator_memberships where scope = 'all-sites' or role = 'hr';
drop index if exists public.operator_memberships_all_sites_user;
alter table public.operator_memberships drop constraint operator_memberships_scope_shape;
alter table public.operator_memberships drop column scope, drop column granted_by,
  drop column updated_at;
alter table public.operator_memberships alter column workspace_id set not null;
alter table public.operator_memberships drop constraint operator_memberships_role_check;
alter table public.operator_memberships add constraint operator_memberships_role_check
  check (role in ('production', 'intake', 'outbound', 'admin', 'management', 'packer',
    'driver', 'assistant'));
create or replace function public.operator_active_role(p_workspace uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.operator_memberships m
  where m.workspace_id = p_workspace and m.user_id = (select auth.uid())
    and m.active and m.revoked_at is null
$$;
commit;
