-- "Count stock" adds to a carton; "Recount" resets it (follows
-- 20261027090000_operator_stock_recount.sql).
--
-- Owner decision 2026-11-11: on the racks, "Count stock" is how a further delivery is counted
-- onto a carton (the counted stock is added to the balance), and "Recount" is a total reset
-- (the balance becomes the counted total and the carton's earlier count entries leave the
-- stock-count list). Both are available on every bottle and capsule carton.
--   * Command `stock-add` (capability stock.receive, scope {adjustments,events}): the
--     application appends an adjustment with `kind: "add"`, `from`, `to`, PIC and recorder.
--   * Command `recount` re-scoped to capability stock.adjust and {adjustments,events}: the
--     application appends an adjustment with `kind: "recount"`, `from`, `to`, PIC and
--     recorder, exactly like `recount-ady` for a sachet batch. The count-level recount of
--     20261027090000 (scope {counts,events}) is replaced.
--   * The physical-count command `count` (scope {counts,events}) is removed. Counts already
--     recorded stay in the document; `adjust` still reviews a carton's latest one until a
--     recount of the carton retires it.
--   Kept in sync with apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs).
-- Additive for data and functions: adjustments are already append-only and count in the
-- carton balance, so the existing checks cover both commands.
-- Rollback: supabase/rollback/20261028090000_operator_stock_add_recount.down.sql.

delete from public.operator_command_rules where command in ('count', 'recount');
insert into public.operator_command_rules (command, capability, state_keys) values
  ('stock-add', 'stock.receive', '{adjustments,events}'),
  ('recount', 'stock.adjust', '{adjustments,events}');
