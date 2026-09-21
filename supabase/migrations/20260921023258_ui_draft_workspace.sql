-- UI-testing sandbox only. No production inventory or staff records.
create table public.ui_draft_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 2000000),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
alter table public.ui_draft_workspaces enable row level security;
revoke all on public.ui_draft_workspaces from anon;
grant select, insert, update on public.ui_draft_workspaces to authenticated;
create policy "approved testers read own draft" on public.ui_draft_workspaces
for select to authenticated using (
  (select auth.uid()) = user_id and (select auth.jwt())->'app_metadata'->>'ui_draft_access' = 'true'
);
create policy "approved testers create own draft" on public.ui_draft_workspaces
for insert to authenticated with check (
  (select auth.uid()) = user_id and (select auth.jwt())->'app_metadata'->>'ui_draft_access' = 'true'
);
create policy "approved testers update own draft" on public.ui_draft_workspaces
for update to authenticated using (
  (select auth.uid()) = user_id and (select auth.jwt())->'app_metadata'->>'ui_draft_access' = 'true'
) with check (
  (select auth.uid()) = user_id and (select auth.jwt())->'app_metadata'->>'ui_draft_access' = 'true'
);
comment on table public.ui_draft_workspaces is 'Fictional UI testing state. Role switcher is a preview tool, not production authorization.';
