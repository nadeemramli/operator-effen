-- The sachet box count records the transfer itself (follows
-- 20261022090000_operator_optional_stages.sql).
--
-- Owner decision 2026-10-19: the warehouse counts boxes for batches production has not pressed
-- "Send to warehouse" for (the batches are physically there, with every warehouse stage
-- recorded). `receive-ady` and `stock-in-ady` now set `transferredAt` / `transferPic` on
-- such a batch at the receipt or count, so their scopes gain `batches`; the application requires the same factory gate as
-- production's transfer (mixing and filling with a PIC, legacy routes reviewed), and the
-- database transfer gate in assert_core_transition checks it independently for every newly
-- transferred batch, whichever command sets it. `wrapping-count` already carries `batches`.
-- Kept in sync with apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares
-- them; the rows are re-seeded so that test reads the new scopes).
-- Additive: no data changes; no function changes.
-- Rollback: supabase/rollback/20261023090000_operator_stock_in_sends.down.sql.

delete from public.operator_command_rules where command in ('receive-ady', 'stock-in-ady');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('receive-ady', 'stock.receive', '{batches,adypocideReceipts,events}'),
  ('stock-in-ady', 'stock.receive', '{batches,cartons,adypocideReceipts,events}');
