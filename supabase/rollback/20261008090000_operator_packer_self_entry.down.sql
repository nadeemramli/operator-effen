-- Manual rollback for 20261008090000_operator_packer_self_entry.sql. Not run by the CLI.
-- Run before 20261007090000_operator_factory_scope.down.sql. Confirm the selected project
-- first. Afterwards packers are view-only again and every packer PIN is deleted; supervisors
-- set new PINs if the migration is re-applied. Packer profiles and counts already recorded
-- stay in workspace state.
begin;
drop function public.operator_staff_pin_status(uuid);
drop function public.operator_verify_staff_pin(uuid, text, text);
drop function public.operator_set_staff_pin(uuid, text, text);
drop function operator_private.packer_profile_exists(uuid, text);
drop table operator_private.staff_pins;
delete from public.operator_command_rules
where command in ('pack-own', 'staff-profile-create', 'staff-profile-update');
delete from public.operator_role_capabilities
where role = 'packer' and capability = 'packing.record';
commit;
