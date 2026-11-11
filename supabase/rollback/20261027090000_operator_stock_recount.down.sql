-- Rollback for 20261027090000_operator_stock_recount.sql: removes the command rule. Recounts
-- already recorded stay in the document: the replaced counts keep `supersededBy` and the
-- application keeps showing them as versions of the current count.

delete from public.operator_command_rules where command = 'recount';
