-- Rollback for 20261023090000_operator_stock_in_sends.sql: restores the 20261005090000 scopes
-- of `receive-ady` and `stock-in-ady` (no batches). Batches already marked as sent at a
-- receipt or box count keep that record; the restored application version refuses a
-- receipt or box count for an unsent batch again.

delete from public.operator_command_rules where command in ('receive-ady', 'stock-in-ady');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('receive-ady', 'stock.receive', '{adypocideReceipts,events}'),
  ('stock-in-ady', 'stock.receive', '{cartons,adypocideReceipts,events}');
