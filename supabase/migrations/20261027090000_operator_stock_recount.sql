-- Recounting a stock carton's physical count (follows 20261025090000_operator_box_recount.sql).
--
-- Owner request 2026-11-11: a wrong figure keyed into "Count stock" (SYN0088) could not be
-- recounted; a second count left the wrong count open for review beside the right one.
--   * Command `recount` (capability stock.receive, scope {counts,events}), kept in sync with
--     apps/web/src/lib/capabilities.ts (tests/capabilities.test.mjs compares them). The
--     application appends a new count that carries `supersedes` (the count it replaces), the
--     reason, the counting PIC and the recorder, and marks the earlier count `supersededBy`.
--     The earlier count stays in the document as a version; its figures are never rewritten.
--     Counting still moves no stock: `adjust` applies the difference of the new count, and the
--     application refuses to adjust a count that was recounted.
--   * `count` itself is unchanged in the database; the application refuses a second count of
--     a carton whose current count is still awaiting review and offers the recount instead.
-- Additive: no data changes; no function changes. Counts are already inside the intake
-- scope, so the existing checks cover the command.
-- Rollback: supabase/rollback/20261027090000_operator_stock_recount.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('recount', 'stock.receive', '{counts,events}');
