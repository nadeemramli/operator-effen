-- Recounting a sachet batch's finished boxes (follows
-- 20261024090000_operator_warehouse_count.sql).
--
-- Owner decision 2026-10-20: a fresh count of a batch's boxes replaces the total (350 counted,
-- 550 on recount: the total is 550), and the earlier total stays as a version.
--   * Command `recount-ady` (capability stock.adjust, scope {adjustments,events}), kept in
--     sync with apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares them).
--     The application records the difference as a recount adjustment (`kind: "recount"`,
--     `from`, `to`, PIC, recorder) on the batch's box carton(s); a lower recount is limited to
--     the boxes still on the racks. Adjustments are already append-only and count in the
--     carton balance, so the existing checks in assert_core_transition cover it.
-- Additive: no data changes; no function changes.
-- Rollback: supabase/rollback/20261025090000_operator_box_recount.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('recount-ady', 'stock.adjust', '{adjustments,events}');
