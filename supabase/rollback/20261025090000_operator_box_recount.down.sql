-- Rollback for 20261025090000_operator_box_recount.sql: removes the command rule. Recount
-- adjustments already recorded stay in the document and keep counting in carton balances.

delete from public.operator_command_rules where command = 'recount-ady';
