-- Database-boundary tests for operational writes, memberships and source files (OPER-2/4/5).
-- Run after all migrations on a disposable database. Synthetic users and data only.
-- Signed commits use a test key standing in for the Operator API server.
\set ON_ERROR_STOP on
set client_min_messages = warning;
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'), -- site A production SV
  ('00000000-0000-4000-8000-000000000002'), -- site A packer
  ('00000000-0000-4000-8000-000000000003'), -- site B production SV
  ('00000000-0000-4000-8000-000000000004'), -- all-sites management
  ('00000000-0000-4000-8000-000000000005'), -- site A revoked SV
  ('00000000-0000-4000-8000-000000000006'), -- site A stock-in SV
  ('00000000-0000-4000-8000-000000000007'), -- all-sites office admin
  ('00000000-0000-4000-8000-000000000008'), -- all-sites HR
  ('00000000-0000-4000-8000-000000000009'), -- site A stock-out SV
  ('00000000-0000-4000-8000-000000000010'); -- new hire (no membership yet)
insert into operator_private.server_keys (id, secret)
values ('commit', decode(repeat('ab', 32), 'hex'));
insert into public.operator_workspaces (id, site_id, name, state) values
  ('10000000-0000-4000-8000-00000000000a', 'site-a', 'Synthetic site A', $${
    "version":1,
    "batches":[{"id":"b1","code":"SYN-ADY-1","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"P1","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"P2","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"P3","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"P5","qty":null,"start":"","end":"","done":true,"qc":"not-recorded",
         "picHistory":[{"kind":"assignment","from":"","to":"P5","at":"t","reason":"plan"}]}]},
      {"id":"b-sent","code":"SYN-SENT","product":"cav","date":"2026-10-01","target":5,"actual":5,"sent":5,
       "transferredAt":"2026-10-01T05:00:00Z","transferPic":"F","steps":[]}],
    "cartons":[{"id":"c1","ref":"SYN-SENT","batchId":"b-sent","product":"cav","unit":"bottle","qty":5,"rack":"A","pic":"R","at":"t"}],
    "orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],
    "events":[{"id":"e1","entity":"b1","action":"Batch planned","detail":"orig","actor":"SV A","at":"t",
      "recorder":{"userId":"00000000-0000-4000-8000-000000000001"}}],
    "notes":[],"closedDays":[]}$$::jsonb),
  ('10000000-0000-4000-8000-00000000000b', 'site-b', 'Synthetic site B', default);
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope, active, revoked_at) values
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000001','production','SV A','site',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000002','packer','Packer A','site',true,null),
  ('10000000-0000-4000-8000-00000000000b','00000000-0000-4000-8000-000000000003','production','SV B','site',true,null),
  (null,'00000000-0000-4000-8000-000000000004','management','Mgmt','all-sites',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000005','production','Revoked','site',false,now()),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000006','intake','SI A','site',true,null),
  (null,'00000000-0000-4000-8000-000000000007','admin','Admin','all-sites',true,null),
  (null,'00000000-0000-4000-8000-000000000008','hr','HR','all-sites',true,null),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000009','outbound','SO A','site',true,null);

-- Signs like the API server (only when p_sign) and calls the RPC as p_uid. Returns the
-- outcome as JSON instead of raising, so each case can assert the exact result.
create function pg_temp.commit_as(
  p_uid uuid, p_ws uuid, p_command text, p_state jsonb, p_op uuid default gen_random_uuid(),
  p_rev integer default null, p_sign boolean default true, p_signer uuid default null,
  p_fingerprint text default null
) returns jsonb language plpgsql as $$
declare
  v_rev integer := coalesce(p_rev, (select revision from public.operator_workspaces where id = p_ws));
  v_text text := p_state::text;
  v_fp text := coalesce(p_fingerprint, encode(extensions.digest(p_command || v_text, 'sha256'), 'hex'));
  v_sig text;
  v_row record;
  v_result jsonb;
begin
  v_sig := case when p_sign then encode(extensions.hmac(convert_to(concat_ws(E'\n',
    'operator-commit-v1', p_ws::text, v_rev::text, coalesce(p_signer, p_uid)::text, p_op::text,
    p_command, v_fp, encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex')), 'UTF8'),
    (select secret from operator_private.server_keys where id = 'commit'), 'sha256'), 'hex')
    else repeat('0', 64) end;
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    select * into v_row from public.operator_commit_workspace(p_ws, v_rev, p_command, p_op, v_fp, v_text, v_sig);
    v_result := case when v_row is null then jsonb_build_object('ok', false, 'code', 'conflict')
      else jsonb_build_object('ok', true, 'revision', v_row.new_revision, 'replayed', v_row.replayed) end;
  exception when others then
    v_result := jsonb_build_object('ok', false, 'code', sqlstate, 'message', sqlerrm);
  end;
  execute 'reset role';
  return v_result;
end $$;
create function pg_temp.expect(p_result jsonb, p_code text, p_label text) returns void language plpgsql as $$
begin
  if (p_code = 'ok' and (p_result ->> 'ok')::boolean) or p_result ->> 'code' = p_code then return; end if;
  raise exception 'FAIL: % expected %, got %', p_label, p_code, p_result;
end $$;
create function pg_temp.state(p_ws uuid default '10000000-0000-4000-8000-00000000000a') returns jsonb
language sql as $$ select state from public.operator_workspaces where id = p_ws $$;
create function pg_temp.ev(p_id text, p_uid text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'entity', 'b1', 'action', 'test', 'detail', 'test',
    'actor', 'x', 'at', 't', 'recorder', jsonb_build_object('userId', p_uid)) $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.expect_denied(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then return;
  end;
  raise exception 'FAIL: % was not denied', p_label;
end $$;

\set A '''10000000-0000-4000-8000-00000000000a'''
\set B '''10000000-0000-4000-8000-00000000000b'''
\set SV '''00000000-0000-4000-8000-000000000001'''

-- 1. The reported bypass: an unsigned supervisor RPC that transfers an incomplete batch and
--    rewrites/forges audit history is rejected and changes nothing.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'transfer',
  jsonb_set(jsonb_set(pg_temp.state(), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"'),
    '{events}', jsonb_build_array(pg_temp.ev('e1', 'forged'))), p_sign => false),
  '42501', 'unsigned replacement state');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', pg_temp.state(),
  p_signer => '00000000-0000-4000-8000-000000000003'), '42501', 'signature issued for another user');
do $$ begin
  if (select revision from public.operator_workspaces where site_id = 'site-a') <> 0
  then raise exception 'FAIL: rejected commits changed the workspace'; end if;
end $$;

-- 2. Even with a valid server signature (e.g. a server bug), the database refuses
--    transitions that break history, attribution, custody, route or stock rules.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{events,0,detail}', '"rewritten"')), '23514', 'rewrite audit event');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{events}', (pg_temp.state() -> 'events') || jsonb_build_array(
    pg_temp.ev('e2', '00000000-0000-4000-8000-000000000006')))), '23514', 'forged recorder');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'transfer',
  jsonb_set(pg_temp.state(), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"')), '23514',
  'five-stage transfer without Hologram');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine',
  jsonb_set(pg_temp.state(), '{batches,0,steps,0,done}', 'false')), '23514', 'un-complete a stage');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'change-step-pic',
  jsonb_set(pg_temp.state(), '{batches,0,steps,4,picHistory}', '[]')), '23514', 'erase PIC history');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'step',
  jsonb_set(pg_temp.state(), '{batches,1,transferredAt}', '"2026-10-02T00:00:00Z"')), '23514',
  'rewrite transfer custody');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{batches}', (pg_temp.state() -> 'batches') - 1)), '23514', 'delete a batch');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :A, 'receive',
  jsonb_set(pg_temp.state(), '{cartons,0,qty}', '500')), '23514', 'rewrite received carton quantity');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000009', :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', '[{"id":"i1","cartonId":"c1","orderId":"o","qty":6,"pic":"x","at":"t"}]')),
  '23514', 'issue more than the carton holds');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine',
  jsonb_set(pg_temp.state(), '{cartons,0,rack}', '"Z"')), '42501', 'change outside command scope');

-- 3. Valid signed operations succeed; retries replay; reused IDs with different input fail.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine',
  jsonb_set(jsonb_set(jsonb_set(pg_temp.state(), '{batches,0,steps,3,pic}', '"P4"'),
    '{batches,0,steps,3,done}', 'true'), '{events}', (pg_temp.state() -> 'events') || jsonb_build_array(
    pg_temp.ev('e2', '00000000-0000-4000-8000-000000000001'))),
  p_op => '20000000-0000-4000-8000-000000000001'), 'ok', 'record Hologram completion');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'transfer',
  jsonb_set(pg_temp.state(), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"')), 'ok',
  'transfer once all five stages are recorded');
do $$
declare r jsonb;
begin
  -- Same operation, same input, stale revision (response lost): established result returned.
  r := pg_temp.commit_as('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-00000000000a',
    'machine', '{"irrelevant":true}', '20000000-0000-4000-8000-000000000001', 0,
    p_fingerprint => (select fingerprint from public.operator_commits
      where operation_id = '20000000-0000-4000-8000-000000000001'));
  if not (r ->> 'replayed')::boolean or (r ->> 'revision')::int <> 2 then
    raise exception 'FAIL: retry did not replay: %', r; end if;
  if (select count(*) from public.operator_commits) <> 2 then
    raise exception 'FAIL: retry created another commit'; end if;
end $$;
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine', pg_temp.state(),
  p_op => '20000000-0000-4000-8000-000000000001'), 'PT409', 'reused operation ID, new input');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine', pg_temp.state(), p_rev => 0), 'conflict',
  'stale revision');

-- 4. Roles and capabilities.
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'machine',
  pg_temp.state()), '42501', 'packer operational write');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'feedback',
  jsonb_set(pg_temp.state(), '{notes}', '[{"id":"n1","kind":"feedback","text":"Label printer jammed","role":"packer","at":"t","author":{"userId":"00000000-0000-4000-8000-000000000002"},"siteId":"site-a"}]')),
  'ok', 'packer feedback note');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'feedback',
  jsonb_set(pg_temp.state(), '{notes}', (pg_temp.state() -> 'notes') || '[{"id":"n2","text":"x","author":{"userId":"00000000-0000-4000-8000-000000000001"}}]')),
  '23514', 'feedback under another author');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'feedback',
  jsonb_set(pg_temp.state(), '{batches,0,code}', '"X"')), '42501', 'feedback used to edit batches');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :B, 'review',
  jsonb_set(pg_temp.state(:B), '{notes}', '[{"id":"n3","kind":"review","text":"Check","author":{"userId":"00000000-0000-4000-8000-000000000004"}}]')),
  'ok', 'all-sites management comment at site B');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :A, 'adjust',
  pg_temp.state()), '42501', 'management stock adjustment');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000007', :A, 'stage-correct',
  pg_temp.state()), '42501', 'office admin production correction');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000008', :A, 'batch',
  pg_temp.state()), '42501', 'HR operational write');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000003', :A, 'machine',
  pg_temp.state()), '42501', 'site B supervisor writing site A');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000005', :A, 'machine',
  pg_temp.state()), '42501', 'revoked supervisor');
select pg_temp.expect(pg_temp.commit_as(null, :A, 'machine', pg_temp.state()), '42501', 'anonymous');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'reset', pg_temp.state()), '42501', 'unknown command');

-- 5. Membership administration: scoped, audited, no self-promotion or escalation.
begin;
select pg_temp.as_user(:SV);
do $$ begin
  perform public.operator_grant_membership('10000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-000000000010', 'packer', 'New Packer', 'staff-new', 'New hire');
end $$;
select pg_temp.expect_denied($q$select public.operator_grant_membership('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000010', 'production', 'Promoted', null, 'x')$q$, 'SV grants a supervisor role');
select pg_temp.expect_denied($q$select public.operator_grant_membership('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'packer', 'Self', null, 'x')$q$, 'SV changes own access');
select pg_temp.expect_denied($q$select public.operator_grant_membership('10000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000010', 'packer', 'Other site', null, 'x')$q$, 'SV grants at another site');
select pg_temp.expect_denied($q$select public.operator_grant_membership(null, '00000000-0000-4000-8000-000000000010', 'management', 'Global', null, 'x', 'all-sites')$q$, 'SV grants all-sites access');
select pg_temp.expect_denied($q$select public.operator_grant_membership('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000006', 'packer', 'Demote peer', null, 'x')$q$, 'SV changes a peer supervisor');
select pg_temp.expect_denied($q$select public.operator_revoke_membership((select id from public.operator_memberships where user_id = '00000000-0000-4000-8000-000000000006'), 'x')$q$, 'SV revokes a peer supervisor');
select pg_temp.expect_denied($q$select public.operator_set_site_policy('10000000-0000-4000-8000-00000000000a', '{}', 'x')$q$, 'SV changes site policy');
select pg_temp.expect_denied($q$update public.operator_memberships set role = 'hr' where user_id = '00000000-0000-4000-8000-000000000001'$q$, 'direct self-promotion');
select pg_temp.expect_denied($q$insert into public.operator_membership_audit (action, actor_user, actor_role, reason) values ('grant', gen_random_uuid(), 'hr', 'forged')$q$, 'forged membership audit');
do $$ begin
  if (select count(*) from public.operator_memberships where user_id = '00000000-0000-4000-8000-000000000010' and role = 'packer') <> 1
  then raise exception 'FAIL: SV packer grant missing'; end if;
end $$;
commit;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000008');
do $$ begin
  perform public.operator_grant_membership(null, '00000000-0000-4000-8000-000000000010', 'management', 'Promoted', null, 'Role change approved', 'all-sites');
  perform public.operator_set_site_policy('10000000-0000-4000-8000-00000000000a',
    '{"management": ["sources.read", "feedback.post"]}', 'Site A reviews by email this quarter');
end $$;
select pg_temp.expect_denied($q$select public.operator_grant_membership(null, '00000000-0000-4000-8000-000000000008', 'hr', 'Self', null, 'x', 'all-sites')$q$, 'HR changes own access');
do $$ begin
  begin
    perform public.operator_set_site_policy('10000000-0000-4000-8000-00000000000a', '{"packer": ["stock.adjust"]}', 'x');
    raise exception 'FAIL: policy granted a capability outside the role ceiling';
  exception when invalid_parameter_value then null;
  end;
  if (select count(*) from public.operator_membership_audit) <> 3 then
    raise exception 'FAIL: expected 3 audit rows, got %', (select count(*) from public.operator_membership_audit); end if;
end $$;
commit;
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :A, 'review',
  jsonb_set(pg_temp.state(), '{notes}', (pg_temp.state() -> 'notes') || '[{"id":"n4","text":"x","author":{"userId":"00000000-0000-4000-8000-000000000004"}}]')),
  '42501', 'site policy removed management comments at site A');

-- 6. Operational source files: site/role scoped; cross-site only where explicit.
insert into storage.objects (bucket_id, name) values
  ('operator-sources', '10000000-0000-4000-8000-00000000000a/' || repeat('a', 64) || '.pdf');
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000007');
insert into storage.objects (bucket_id, name) values
  ('operator-sources', '10000000-0000-4000-8000-00000000000b/' || repeat('b', 64) || '.pdf');
commit;
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-sources', '10000000-0000-4000-8000-00000000000a/' || repeat('c', 64) || '.pdf')$q$, 'production SV upload');
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'operator-sources') then
    raise exception 'FAIL: production SV can read sources'; end if;
end $$;
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000009');
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'operator-sources') <> 1 then
    raise exception 'FAIL: site A stock-out should read exactly its site source'; end if;
end $$;
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-sources', '../' || repeat('d', 64) || '.pdf')$q$, 'path traversal upload');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000003');
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'operator-sources') then
    raise exception 'FAIL: site B production SV reads sources'; end if;
end $$;
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000007');
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'operator-sources') <> 2 then
    raise exception 'FAIL: all-sites admin should read both sites'; end if;
end $$;
rollback;

-- 7. No alternate table paths.
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied($q$update public.operator_workspaces set state = '{}'$q$, 'direct workspace update');
select pg_temp.expect_denied($q$insert into public.operator_commits values ('10000000-0000-4000-8000-00000000000a', gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'production', 'batch', repeat('a', 64), 9)$q$, 'forged commit record');
select pg_temp.expect_denied($q$update public.operator_command_rules set capability = 'feedback.post'$q$, 'rewrite command rules');
select pg_temp.expect_denied($q$select * from operator_private.server_keys$q$, 'read server key');
select pg_temp.expect_denied($q$update public.operator_workspaces set write_policy = '{}'$q$, 'direct policy change');
rollback;

select 'operator access tests passed' as result;
