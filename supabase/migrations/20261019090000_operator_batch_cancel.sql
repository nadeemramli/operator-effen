-- Cancelling a mistaken batch and correcting its work date (follows
-- 20261018090000_operator_issues.sql).
--
-- Two commands, kept in sync with apps/web/src/lib/capabilities.ts
-- (tests/capabilities.test.mjs compares them):
--   * `batch-cancel` (capability production.plan, scope {batches,events}): the production
--     supervisor cancels a batch planned or recorded by mistake, with a reason and a PIC.
--     The batch is never removed: it is marked cancelled, stays in history with its steps,
--     and its batch number stays reserved.
--   * `batch-correct` (capability production.plan, scope {batches,events}): the production
--     supervisor corrects the batch work date, with a reason and a PIC. The recorded steps
--     are kept; the change is appended to the batch's corrections and the audit log.
-- Both are refused by the application rules once the batch has left the factory (bottles
-- sent to fulfilment, sachets sent to the warehouse) or has a warehouse receipt or stock
-- carton. production.plan is the capability that already plans, records and sends batches
-- (batch, step, transfer), held by production supervisors only; stage.correct is shared
-- with stock-in, which does not own the batch. Factory-scoped supervisors stay inside their
-- factory (operator_private.assert_factory_scope checks every changed batch). The database
-- already refuses removing a batch or rewriting its code, product, custody, route or
-- revision history (operator_private.assert_core_transition).
-- Additive: no data changes.
-- Rollback: supabase/rollback/20261019090000_operator_batch_cancel.down.sql.

insert into public.operator_command_rules (command, capability, state_keys) values
  ('batch-cancel', 'production.plan', '{batches,events}'),
  ('batch-correct', 'production.plan', '{batches,events}');
