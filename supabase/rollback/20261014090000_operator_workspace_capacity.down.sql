-- Rollback for 20261014090000_operator_workspace_capacity.sql: restores the 2,000,000-byte
-- document cap on both workspace tables. The constraint is added NOT VALID so a site already
-- above 2 MB does not block the rollback, but every later save to such a site fails until
-- its document is back under the cap. Deploy the application version with the matching
-- 1,800,000-byte limit first. Raw extraction text removed from released uploads is not
-- restored; the source PDFs remain in storage.

alter table public.operator_workspaces
  drop constraint operator_workspaces_state_check,
  add constraint operator_workspaces_state_check
    check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 2000000) not valid;

alter table public.ui_draft_workspaces
  drop constraint ui_draft_workspaces_state_check,
  add constraint ui_draft_workspaces_state_check
    check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 2000000) not valid;
