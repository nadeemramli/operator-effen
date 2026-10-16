-- Rollback for 20261019090000_operator_batch_cancel.sql: removes the two command rules.
-- Batches already cancelled or corrected keep those records (and their audit entries); an
-- application version without these commands shows a cancelled batch as an ordinary one.

delete from public.operator_command_rules where command in ('batch-cancel', 'batch-correct');
