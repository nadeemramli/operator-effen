-- Rollback for 20261028090000_operator_stock_add_recount.sql: restores the physical-count
-- `count` rule and the count-level `recount` rule of 20261027090000, and removes `stock-add`.
-- Added-stock and recount adjustments already recorded stay in the document and keep
-- counting in carton balances.

delete from public.operator_command_rules where command in ('stock-add', 'recount');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('count', 'stock.receive', '{counts,events}'),
  ('recount', 'stock.receive', '{counts,events}');
