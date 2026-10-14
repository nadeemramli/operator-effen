-- Workspace capacity (follows 20261011090000_operator_remove_awbs.sql).
--
-- The live site reached the 2 MB document cap on 2026-10-14 with 830 open AWBs from four
-- days of uploads (about 400 a day), and every save on the site was refused. This is the
-- interim headroom while the per-AWB records move to their own tables
-- (docs/order-volume-plan-2026-10.md, work packages A to D):
--   * Both workspace tables accept a document up to 4,000,000 bytes of jsonb text (was
--     2,000,000). The API saves at most 3,600,000 bytes of compact JSON
--     (WORKSPACE_BYTES in apps/web/src/lib/draft.ts); jsonb text is about 7% larger. The
--     cap stays under the hosting platform's 4.5 MB function response limit, because every
--     load returns the whole document.
--   * One-time compaction: rows of released (confirmed) uploads drop their raw extraction
--     text (`original`), as import-release now does for every new release. Released
--     uploads are read-only and the source PDF pages stay in the operator-sources bucket.
--     Only `awbImports` changes; the append-only lists (events, issues, ...) are untouched.
--     The revision is not changed: every save reloads the latest state on the server.
-- Rollback: supabase/rollback/20261014090000_operator_workspace_capacity.down.sql.

alter table public.operator_workspaces
  drop constraint operator_workspaces_state_check,
  add constraint operator_workspaces_state_check
    check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 4000000);

alter table public.ui_draft_workspaces
  drop constraint ui_draft_workspaces_state_check,
  add constraint ui_draft_workspaces_state_check
    check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 4000000);

update public.operator_workspaces w
set state = jsonb_set(w.state, '{awbImports}', (
      select coalesce(jsonb_agg(
        case when coalesce(i ->> 'confirmedAt', '') <> '' and jsonb_typeof(i -> 'rows') = 'array'
          then jsonb_set(i, '{rows}', (
            select coalesce(jsonb_agg(
              case when jsonb_typeof(r) = 'object' then r || '{"original": ""}'::jsonb else r end
              order by n), '[]'::jsonb)
            from jsonb_array_elements(i -> 'rows') with ordinality x(r, n)))
          else i end
        order by m), '[]'::jsonb)
      from jsonb_array_elements(w.state -> 'awbImports') with ordinality y(i, m))),
    updated_at = now()
where jsonb_typeof(w.state -> 'awbImports') = 'array'
  and exists (
    select 1 from jsonb_array_elements(w.state -> 'awbImports') i,
      jsonb_array_elements(case when jsonb_typeof(i -> 'rows') = 'array' then i -> 'rows' else '[]' end) r
    where coalesce(i ->> 'confirmedAt', '') <> '' and coalesce(r ->> 'original', '') <> '');
