-- Manual rollback for 20261006090000_operator_driver_trips.sql. Not run by the CLI.
-- Run before 20261005090000_operator_trusted_commands.down.sql. Confirm the selected project
-- and export operational state first: trip records stay in the workspace JSON but can no
-- longer be added to. Memberships converted from 'assistant' remain 'driver' memberships.
-- Trip photos in operator-trip-photos / trip-draft-photos are not deleted here: remove them
-- through the Storage API after export if the buckets themselves must go.
begin;
drop policy if exists "drivers upload own trip photos" on storage.objects;
drop policy if exists "drivers and reviewers read trip photos" on storage.objects;
drop policy if exists "testers upload own trip photos" on storage.objects;
drop policy if exists "testers read own trip photos" on storage.objects;
drop function if exists public.operator_trip_photo_access(text, boolean);
drop function operator_private.assert_transition(jsonb, jsonb, uuid);
drop function operator_private.assert_trip_transition(jsonb, jsonb, uuid);
alter function operator_private.assert_core_transition(jsonb, jsonb, uuid)
  rename to assert_transition;
delete from public.operator_command_rules where command in ('trip', 'trip-update');
delete from public.operator_role_capabilities where capability in ('trips.log', 'trips.read');
alter table public.operator_memberships drop constraint operator_memberships_role_check;
alter table public.operator_memberships add constraint operator_memberships_role_check
  check (role in ('production', 'intake', 'outbound', 'admin', 'hr', 'management',
                  'packer', 'driver', 'assistant'));
insert into public.operator_role_capabilities (role, capability) values ('assistant', 'feedback.post');
insert into public.operator_grantable_roles (grantor_role, grantable_role)
select g, 'assistant' from unnest(array['hr', 'production', 'intake', 'outbound']) g;
commit;
