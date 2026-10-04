-- Access tests for OPER-2 (run against a disposable database after all migrations).
-- Synthetic users only. Each block raises on failure.
\set ON_ERROR_STOP on
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'), -- site A production SV
  ('00000000-0000-4000-8000-000000000002'), -- site A packer
  ('00000000-0000-4000-8000-000000000003'), -- site B production SV
  ('00000000-0000-4000-8000-000000000004'), -- site A management
  ('00000000-0000-4000-8000-000000000005'), -- site A revoked SV
  ('00000000-0000-4000-8000-000000000006'), -- site A stock-in SV
  ('00000000-0000-4000-8000-000000000007'); -- site A office admin
insert into public.operator_workspaces (id, site_id, name) values
  ('10000000-0000-4000-8000-00000000000a', 'site-a', 'Synthetic site A'),
  ('10000000-0000-4000-8000-00000000000b', 'site-b', 'Synthetic site B');
insert into public.operator_memberships (workspace_id, user_id, role, display_name, active, revoked_at) values
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000001','production','SV A',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000002','packer','Packer A',true,null),
  ('10000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-000000000003','production','SV B',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000004','management','Mgmt A',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000005','production','Revoked',false,now()),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000006','intake','SI A',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000007','admin','Admin A',true,null);

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.expect_denied(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'FAIL: % was not denied', p_label;
end $$;

-- 1. Production SV commits a batch change in their own site.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from public.operator_commit_workspace(
    '10000000-0000-4000-8000-00000000000a', 0,
    (select state from public.operator_workspaces) || '{"batches":[{"id":"b1"}]}'::jsonb);
  if r.new_revision is distinct from 1 then raise exception 'FAIL: SV commit returned %', r.new_revision; end if;
end $$;
-- Stale revision returns no row (conflict), state unchanged.
do $$
begin
  if exists (select 1 from public.operator_commit_workspace(
      '10000000-0000-4000-8000-00000000000a', 0, '{"batches":[]}'::jsonb || (select state - 'batches' from public.operator_workspaces)))
  then raise exception 'FAIL: stale revision was accepted'; end if;
end $$;
commit;

-- 2. Packer, management (exception off) and revoked SV cannot commit.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, (select state from public.operator_workspaces))$q$, 'packer commit');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000004');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, (select state from public.operator_workspaces) || '{"notes":[{"id":"n"}]}')$q$, 'management commit');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000005');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, '{}'::jsonb)$q$, 'revoked SV commit');
do $$ begin
  if exists (select 1 from public.operator_workspaces) then raise exception 'FAIL: revoked member can read workspace'; end if;
end $$;
rollback;

-- 3. Site B SV cannot read or mutate site A.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000003');
do $$ begin
  if exists (select 1 from public.operator_workspaces where site_id = 'site-a')
  then raise exception 'FAIL: cross-site read'; end if;
end $$;
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, '{"batches":[]}'::jsonb)$q$, 'cross-site commit');
rollback;

-- 4. Alternate database paths: direct table writes are denied for every role.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000001');
select pg_temp.expect_denied($q$update public.operator_workspaces set state = '{}'$q$, 'direct workspace update');
select pg_temp.expect_denied($q$insert into public.operator_memberships (workspace_id,user_id,role,display_name) values ('10000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-000000000001','production','Self-granted')$q$, 'self-granted membership');
select pg_temp.expect_denied($q$update public.operator_memberships set role = 'admin'$q$, 'membership role escalation');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');
select pg_temp.expect_denied($q$update public.operator_workspaces set state = '{}'$q$, 'packer direct update');
rollback;
begin;
set local role anon;
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, '{}'::jsonb)$q$, 'anonymous commit');
rollback;

-- 5. Role scope: production cannot change stock cartons; stock-in can edit batches (OPER-5).
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000001');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1, (select state from public.operator_workspaces) || '{"cartons":[{"id":"c","qty":999}]}')$q$, 'production writing cartons');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000006');
do $$ declare r record; begin
  select * into r from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 1,
    (select state from public.operator_workspaces) || '{"batches":[{"id":"b1","steps":[{"pic":"P"}]}]}'::jsonb);
  if r.new_revision is distinct from 2 then raise exception 'FAIL: stock-in batch edit %', r.new_revision; end if;
end $$;
commit;

-- 6. Office-admin exception is explicit and scoped.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000007');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 2, (select state from public.operator_workspaces) || '{"orders":[{"id":"o"}]}')$q$, 'admin import with exception off');
rollback;
update public.operator_workspaces set write_policy = '{"admin_imports": true}' where site_id = 'site-a';
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000007');
select pg_temp.expect_denied($q$select * from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 2, (select state from public.operator_workspaces) || '{"batches":[]}')$q$, 'admin writing production records');
do $$ declare r record; begin
  select * into r from public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', 2,
    (select state from public.operator_workspaces) || '{"orders":[{"id":"o"}]}'::jsonb);
  if r.new_revision is distinct from 3 then raise exception 'FAIL: admin exception commit %', r.new_revision; end if;
end $$;
commit;

-- 7. Members read only their own membership rows.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');
do $$ begin
  if (select count(*) from public.operator_memberships) <> 1 then raise exception 'FAIL: membership rows visible to packer'; end if;
end $$;
rollback;

select 'operator access tests passed' as result;
