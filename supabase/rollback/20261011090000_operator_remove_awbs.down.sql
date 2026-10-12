-- Rollback for 20261011090000_operator_remove_awbs.sql: removes the two command rules.
-- AWBs and uploads already removed are not restored (their audit entries remain).

delete from public.operator_command_rules where command in ('remove-order', 'import-delete');
