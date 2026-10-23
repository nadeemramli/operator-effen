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
  ('00000000-0000-4000-8000-000000000010'), -- new hire (no membership yet)
  ('00000000-0000-4000-8000-000000000011'); -- authenticated outsider (never a member)
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
-- (The former "five-stage transfer without Hologram" refusal is allowed since 20261009090001:
-- transfer needs the factory stages only. Its replacement cases are in section 9.)
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
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'feedback', jsonb_set(pg_temp.state(), '{notes}',
  '[{"id":"n-stale","text":"stale","author":{"userId":"00000000-0000-4000-8000-000000000001"}}]'), p_rev => 0),
  'conflict', 'stale revision on a change to the document');
-- 20261017090000: a save that leaves the document as it is (only orders, or nothing) is not
-- checked against the document revision and does not bump it.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine', pg_temp.state(), p_rev => 0), 'ok',
  'stale revision, document unchanged');
do $$ begin
  if (select revision from public.operator_workspaces where site_id = 'site-a') <> 2 then
    raise exception 'FAIL: an unchanged document bumped the revision'; end if;
end $$;

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
-- Membership IDs are looked up with full privileges so denials are tested with real UUIDs.
select id as "PEER" from public.operator_memberships
where user_id = '00000000-0000-4000-8000-000000000006' \gset
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
select pg_temp.expect_denied(format('select public.operator_revoke_membership(%L, %L)', :'PEER', 'x'), 'SV revokes a peer supervisor (known UUID)');
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

-- 5b. Fail-closed revocation and grants: an authenticated outsider, a revoked supervisor,
--     another site's supervisor and all-sites management cannot revoke or grant site or
--     all-sites memberships, even with the membership UUID. Nothing changes; no audit row.
create temp table snapshot as
  select (select jsonb_agg(to_jsonb(m) order by m.id) from public.operator_memberships m) as members,
         (select count(*) from public.operator_membership_audit) as audits;
grant select on snapshot to authenticated;
do $$
declare
  callers uuid[] := array[
    '00000000-0000-4000-8000-000000000011',  -- outsider, no membership at all
    '00000000-0000-4000-8000-000000000005',  -- revoked site A supervisor
    '00000000-0000-4000-8000-000000000003',  -- site B supervisor
    '00000000-0000-4000-8000-000000000004']; -- all-sites management (not HR)
  targets uuid[];
  c uuid;
  t uuid;
  outcome text;
begin
  select array_agg(id) into targets from public.operator_memberships
  where user_id in ('00000000-0000-4000-8000-000000000002',   -- site A packer (site)
                    '00000000-0000-4000-8000-000000000006',   -- site A stock-in SV (site)
                    '00000000-0000-4000-8000-000000000008',   -- HR (all-sites)
                    '00000000-0000-4000-8000-000000000004');  -- management (all-sites)
  targets := targets || gen_random_uuid();                     -- unknown membership UUID
  foreach c in array callers loop
    foreach t in array targets loop
      perform set_config('request.jwt.claim.sub', c::text, true);
      execute 'set local role authenticated';
      begin
        perform public.operator_revoke_membership(t, 'probe');
        outcome := 'allowed';
      exception when others then outcome := sqlstate;
      end;
      execute 'reset role';
      if outcome <> '42501' then
        raise exception 'FAIL: % revoking % returned % (expected 42501)', c, t, outcome;
      end if;
    end loop;
    perform set_config('request.jwt.claim.sub', c::text, true);
    execute 'set local role authenticated';
    begin
      perform public.operator_grant_membership('10000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-000000000010', 'driver', 'Probe', null, 'probe');
      outcome := 'allowed';
    exception when others then outcome := sqlstate;
    end;
    execute 'reset role';
    if outcome <> '42501' then
      raise exception 'FAIL: % granting returned % (expected 42501)', c, outcome;
    end if;
  end loop;
  if (select jsonb_agg(to_jsonb(m) order by m.id) from public.operator_memberships m)
    is distinct from (select members from snapshot) then
    raise exception 'FAIL: memberships changed after denied calls';
  end if;
  if (select count(*) from public.operator_membership_audit) <> (select audits from snapshot) then
    raise exception 'FAIL: audit rows written for denied calls';
  end if;
end $$;
-- NULL arguments never authorize anything.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000008');
select pg_temp.expect_denied($q$select public.operator_revoke_membership(null, 'x')$q$, 'revoke NULL membership');
do $$ begin
  begin
    perform public.operator_grant_membership('10000000-0000-4000-8000-00000000000a', null, 'packer', 'x', null, 'x');
    raise exception 'FAIL: grant with NULL user succeeded';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.operator_set_site_policy('10000000-0000-4000-8000-00000000000a', null, 'x');
    raise exception 'FAIL: NULL site policy accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
rollback;
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'machine', pg_temp.state(),
  p_fingerprint => repeat('a', 64), p_sign => false), '42501', 'unsigned commit');
do $$
declare r jsonb;
begin
  -- Even correctly signed, a NULL expected revision is refused rather than skipping the check.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
  execute 'set local role authenticated';
  begin
    perform public.operator_commit_workspace('10000000-0000-4000-8000-00000000000a', null,
      'machine', gen_random_uuid(), repeat('a', 64), '{}', repeat('0', 64));
    r := '{"ok": true}';
  exception when others then r := jsonb_build_object('code', sqlstate);
  end;
  execute 'reset role';
  if r ->> 'code' is distinct from '22023' then raise exception 'FAIL: NULL revision -> %', r; end if;
end $$;
-- Invariants treat missing fields as violations (signed, so only the invariants decide).
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000009', :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', (pg_temp.state() -> 'issues') || '[{"id":"i-null","cartonId":"c1","orderId":"o"}]')),
  '23514', 'issue without quantity');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :A, 'receive',
  jsonb_set(pg_temp.state(), '{cartons}', (pg_temp.state() -> 'cartons') || '[{"id":"c-null","batchId":"b-sent","product":"cav","unit":"bottle"}]')),
  '23514', 'carton without quantity');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  pg_temp.state() #- '{batches,1,code}'), '23514', 'batch code removed');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{batches}', (pg_temp.state() -> 'batches') || jsonb_build_array(jsonb_build_object(
    'id', 'b-nostages', 'code', 'NOSTAGES', 'product', 'ady', 'sent', 0, 'route', jsonb_build_object('id', 'sachet-v2'),
    'transferredAt', '2026-10-04T00:00:00Z', 'steps', '[]'::jsonb)))), '23514', 'transfer with a route lacking stages');

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

-- 8. One driver role and driver trip logs (20261006090000). Drivers log only their own
--    trips; recorded values are fixed; photos stay in the driver's own folder.
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000012'), -- site A driver
  ('00000000-0000-4000-8000-000000000013'); -- site A second driver
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000012','driver','Driver A','site'),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000013','driver','Driver B','site');
do $$ begin
  begin
    insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope)
    values ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000010', 'assistant', 'Old role', 'site');
    raise exception 'FAIL: a separate assistant role was accepted';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.operator_role_capabilities where role = 'assistant')
    or exists (select 1 from public.operator_grantable_roles where grantable_role = 'assistant') then
    raise exception 'FAIL: assistant reference data remains';
  end if;
end $$;
\set DRV '''00000000-0000-4000-8000-000000000012'''
\set DRV2 '''00000000-0000-4000-8000-000000000013'''
create function pg_temp.trip(p_id text, p_uid text, p_extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('id', p_id, 'siteId', 'site-a', 'date', '2026-10-06', 'driver', 'Driver A',
    'assistant', 'Assistant A', 'pickupAt', '2026-10-06T01:00:00.000Z', 'recordedAt', '2026-10-06T01:01:00.000Z',
    'recordedBy', jsonb_build_object('userId', p_uid)) || p_extra $$;
create function pg_temp.with_trips(p_trips jsonb) returns jsonb language sql as $$
  select jsonb_set(pg_temp.state(), '{trips}', p_trips) $$;
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  jsonb_set(pg_temp.with_trips(jsonb_build_array(pg_temp.trip('t1', :DRV))), '{events}',
    (pg_temp.state() -> 'events') || jsonb_build_array(pg_temp.ev('e-trip', :DRV)))),
  'ok', 'driver logs own trip');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t2', :DRV2)))),
  '23514', 'driver logs a trip under another driver');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t3', '00000000-0000-4000-8000-000000000002')))),
  '42501', 'packer logs a trip');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t4', :SV)))),
  '42501', 'production SV logs a trip');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  jsonb_set(pg_temp.state(), '{batches,0,code}', '"X"')), '42501', 'trip used to edit batches');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t5', :DRV,
    '{"arriveAt": "2026-10-06T00:30:00.000Z"}')))), '23514', 'arrival before pickup');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t1', :DRV)))),
  '23514', 'duplicate trip id');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,pickupAt}', '"2026-10-06T00:00:00.000Z"')), '23514', 'rewrite pickup time');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,assistant}', '"Someone else"')), '23514', 'rewrite assistant name');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update', pg_temp.with_trips('[]')),
  '23514', 'remove a trip');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,driver}', '"Promoted"')), '23514', 'rewrite driver name');
select pg_temp.expect(pg_temp.commit_as(:DRV2, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,arriveAt}', '"2026-10-06T02:00:00.000Z"')), '23514',
  'another driver adds arrival');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,photo}', to_jsonb(:A || '/' || :DRV2 || '/' || repeat('e', 64) || '.jpg'))),
  '23514', 'photo from another driver''s folder');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,approved}', 'true')), '23514', 'unexpected field added to a trip');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(jsonb_set(pg_temp.state(), '{trips,0,arriveAt}', '"2026-10-06T02:00:00.000Z"'),
    '{trips,0,photo}', to_jsonb(:A || '/' || :DRV || '/' || repeat('e', 64) || '.jpg'))),
  'ok', 'driver adds arrival and photo to own trip');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-update',
  jsonb_set(pg_temp.state(), '{trips,0,arriveAt}', '"2026-10-06T03:00:00.000Z"')), '23514',
  'rewrite recorded arrival');
-- Photos: drivers write and read only their own folder; trips.read reads the site.
begin;
select pg_temp.as_user(:DRV);
insert into storage.objects (bucket_id, name) values
  ('operator-trip-photos', '10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000012/' || repeat('e', 64) || '.jpg');
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-trip-photos', '10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000013/' || repeat('f', 64) || '.jpg')$q$, 'driver uploads into another driver''s folder');
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-trip-photos', '10000000-0000-4000-8000-00000000000b/00000000-0000-4000-8000-000000000012/' || repeat('f', 64) || '.jpg')$q$, 'driver uploads at another site');
commit;
begin;
select pg_temp.as_user(:DRV2);
insert into storage.objects (bucket_id, name) values
  ('operator-trip-photos', '10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000013/' || repeat('d', 64) || '.jpg');
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'operator-trip-photos') <> 1 then
    raise exception 'FAIL: a driver reads another driver''s trip photos'; end if;
end $$;
commit;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000009');
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'operator-trip-photos') <> 2 then
    raise exception 'FAIL: site A stock-out should read every site A trip photo'; end if;
end $$;
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-trip-photos', '10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000009/' || repeat('c', 64) || '.jpg')$q$, 'stock-out SV uploads a trip photo');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000004');
do $$ begin
  -- Section 5 narrowed management at site A to sources.read and feedback.post.
  if exists (select 1 from storage.objects where bucket_id = 'operator-trip-photos') then
    raise exception 'FAIL: site policy narrowing did not hide trip photos from management'; end if;
end $$;
rollback;
begin;
select pg_temp.as_user(:SV);
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'operator-trip-photos') then
    raise exception 'FAIL: production SV reads trip photos'; end if;
end $$;
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');
select pg_temp.expect_denied($q$insert into storage.objects (bucket_id, name) values ('operator-trip-photos', '10000000-0000-4000-8000-00000000000a/00000000-0000-4000-8000-000000000002/' || repeat('c', 64) || '.jpg')$q$, 'packer uploads a trip photo');
rollback;

-- 9. Factory scope (20261007090000). A production supervisor limited to one factory cannot
--    change the other factory's batches (or, bottle-scoped, the sachet machine register),
--    even with a valid server signature. Unscoped supervisors keep both factories.
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000014'), -- site A production SV, sachet factory
  ('00000000-0000-4000-8000-000000000015'); -- site A production SV, bottle factory
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope, factory) values
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000014','production','SV Sachet','site','sachet'),
  ('10000000-0000-4000-8000-00000000000a','00000000-0000-4000-8000-000000000015','production','SV Bottle','site','bottle');
do $$ begin
  begin
    update public.operator_memberships set factory = 'sachet'
    where user_id = '00000000-0000-4000-8000-000000000006';
    raise exception 'FAIL: a stock-in membership was limited to a factory';
  exception when check_violation then null;
  end;
  begin
    update public.operator_memberships set factory = 'capsule'
    where user_id = '00000000-0000-4000-8000-000000000014';
    raise exception 'FAIL: an unknown factory was accepted';
  exception when check_violation then null;
  end;
end $$;
\set SACHET '''00000000-0000-4000-8000-000000000014'''
\set BOTTLE '''00000000-0000-4000-8000-000000000015'''
create function pg_temp.with_batch(p_batch jsonb) returns jsonb language sql as $$
  select jsonb_set(pg_temp.state(), '{batches}', jsonb_build_array(p_batch) || (pg_temp.state() -> 'batches')) $$;
create function pg_temp.new_batch(p_id text, p_product text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'code', upper(p_id), 'product', p_product, 'date', '2026-10-07',
    'siteId', 'site-a', 'target', 10, 'actual', 0, 'sent', 0, 'steps', '[]'::jsonb) $$;
-- b1 is the sachet (ady) batch, b-sent the bottle (cav) batch.
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'step',
  jsonb_set(pg_temp.state(), '{batches,1,target}', '6')), '42501', 'sachet SV changes a bottle batch');
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-cav', 'cav'))), '42501', 'sachet SV plans a bottle batch');
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-unknown', 'xyz'))), '42501', 'scoped SV plans an unknown product');
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-none', 'ady') - 'product')), '42501', 'scoped SV plans a batch without product');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'stage-correct',
  jsonb_set(pg_temp.state(), '{batches,0,target}', '1')), '42501', 'bottle SV changes a sachet batch');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-ady', 'ady'))), '42501', 'bottle SV plans a sachet batch');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'machine-create',
  jsonb_set(pg_temp.state(), '{machines}', '[{"id":"m1","siteId":"site-a","stage":"filling","name":"Filler 1","active":true,"history":[]}]')),
  '42501', 'bottle SV registers a sachet machine');
do $$ begin
  if (select revision from public.operator_workspaces where site_id = 'site-a')
    <> (select max(result_revision) from public.operator_commits
        where workspace_id = '10000000-0000-4000-8000-00000000000a') then
    raise exception 'FAIL: refused factory changes were saved'; end if;
end $$;
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-ady-1', 'ady'))), 'ok', 'sachet SV plans a sachet batch');
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'step',
  jsonb_set(pg_temp.state(), '{batches,0,target}', '12')), 'ok', 'sachet SV changes a sachet batch');
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'machine-create',
  jsonb_set(pg_temp.state(), '{machines}', '[{"id":"m1","siteId":"site-a","stage":"filling","name":"Filler 1","active":true,"history":[]}]')),
  'ok', 'sachet SV registers a sachet machine');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('f-cav-1', 'cav'))), 'ok', 'bottle SV plans a bottle batch');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'feedback',
  jsonb_set(pg_temp.state(), '{notes}', (pg_temp.state() -> 'notes') || '[{"id":"n-f","text":"x","author":{"userId":"00000000-0000-4000-8000-000000000015"}}]')),
  'ok', 'bottle SV posts feedback (no batch change)');
-- Unscoped supervisors are unchanged: both factories.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'step',
  jsonb_set(jsonb_set(pg_temp.state(), '{batches,0,target}', '11'), '{batches,1,target}', '13')),
  'ok', 'unscoped SV changes both factories');
-- Only HR sets the scope, only on an active production site membership, never their own;
-- each change is audited. Clearing the scope restores both factories.
select id as "SCOPED" from public.operator_memberships
where user_id = '00000000-0000-4000-8000-000000000014' \gset
select id as "STOCKIN" from public.operator_memberships
where user_id = '00000000-0000-4000-8000-000000000006' \gset
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied(format('select public.operator_set_membership_factory(%L, null, %L)', :'SCOPED', 'x'), 'production SV clears a factory scope');
rollback;
begin;
select pg_temp.as_user(:SACHET);
select pg_temp.expect_denied(format('select public.operator_set_membership_factory(%L, null, %L)', :'SCOPED', 'x'), 'scoped SV clears own factory scope');
select pg_temp.expect_denied($q$update public.operator_memberships set factory = null where user_id = '00000000-0000-4000-8000-000000000014'$q$, 'direct factory scope update');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000008');
select pg_temp.expect_denied(format('select public.operator_set_membership_factory(%L, %L, %L)', :'STOCKIN', 'sachet', 'x'), 'HR scopes a stock-in membership');
select pg_temp.expect_denied(format('select public.operator_set_membership_factory(%L, %L, %L)', gen_random_uuid(), 'sachet', 'x'), 'HR scopes an unknown membership');
do $$ begin
  begin
    perform public.operator_set_membership_factory(
      (select id from public.operator_memberships where user_id = '00000000-0000-4000-8000-000000000014'), 'capsule', 'x');
    raise exception 'FAIL: unknown factory accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.operator_set_membership_factory(
      (select id from public.operator_memberships where user_id = '00000000-0000-4000-8000-000000000014'), null, ' ');
    raise exception 'FAIL: factory change without a reason accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
create temp table audits_before as select count(*) as n from public.operator_membership_audit;
do $$ begin
  perform public.operator_set_membership_factory(
    (select id from public.operator_memberships where user_id = '00000000-0000-4000-8000-000000000014'), null,
    'Covering both factories this week');
end $$;
commit;
do $$ begin
  if (select count(*) from public.operator_membership_audit
      where action = 'change' and target_user = '00000000-0000-4000-8000-000000000014'
        and before ->> 'factory' = 'sachet' and after -> 'factory' = 'null'::jsonb) <> 1
    or (select count(*) from public.operator_membership_audit) <> (select n + 1 from audits_before) then
    raise exception 'FAIL: factory scope change not audited exactly once'; end if;
end $$;
do $$ begin
  if (select pg_temp.state() -> 'batches' -> 0 ->> 'product') <> 'cav' then
    raise exception 'FAIL: expected the bottle batch first'; end if;
end $$;
select pg_temp.expect(pg_temp.commit_as(:SACHET, :A, 'step',
  jsonb_set(pg_temp.state(), '{batches,0,target}', '7')), 'ok', 'cleared scope covers the bottle factory');

-- 20261008: packer profiles and PINs for the shared packer sign-in. PINs live only in
-- operator_private.staff_pins (bcrypt); the stock-out SV or HR sets them, packing.record
-- verifies them, five wrong PINs lock the profile, and nobody reads the hashes.
update public.operator_workspaces
set state = state || '{"staffProfiles":[
  {"id":"p-ali","name":"Synthetic Ali","role":"packer","active":true},
  {"id":"p-old","name":"Synthetic Old","role":"packer","active":false},
  {"id":"p-pic","name":"Synthetic PIC","role":"production"}]}'::jsonb
where site_id = 'site-a';
create function pg_temp.expect_text(p_actual text, p_expected text, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.expect_invalid(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when invalid_parameter_value then return;
  end;
  raise exception 'FAIL: % was not rejected', p_label;
end $$;
\set SO '''00000000-0000-4000-8000-000000000009'''
\set PK '''00000000-0000-4000-8000-000000000002'''
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-ali', '2468'), 'production SV sets a packer PIN');
rollback;
begin;
select pg_temp.as_user(:PK);
select pg_temp.expect_denied(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-ali', '2468'), 'packer sets a packer PIN');
select pg_temp.expect_denied(format('select * from public.operator_staff_pin_status(%s)', :'A'), 'packer reads PIN status');
select pg_temp.expect_denied('select * from operator_private.staff_pins', 'packer reads PIN hashes');
rollback;
begin;
select pg_temp.as_user(:SO);
select pg_temp.expect_invalid(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-ali', '12a4'), 'non-numeric PIN');
select pg_temp.expect_invalid(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-ali', '123'), 'three-digit PIN');
select pg_temp.expect_invalid(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-old', '2468'), 'PIN for an inactive profile');
select pg_temp.expect_invalid(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-pic', '2468'), 'PIN for a non-packer profile');
select pg_temp.expect_invalid(format('select public.operator_set_staff_pin(%s, %L, %L)', :'A', 'p-nobody', '2468'), 'PIN for an unknown profile');
select pg_temp.expect_denied(format('select public.operator_set_staff_pin(%s, %L, %L)', :'B', 'p-ali', '2468'), 'stock-out SV sets a PIN at another site');
select public.operator_set_staff_pin(:A, 'p-ali', '2468');
select pg_temp.expect_text((select count(*)::text from public.operator_staff_pin_status(:A) where profile_id = 'p-ali' and locked_until is null), '1', 'PIN status after set');
commit;
do $$ begin
  if (select pin_hash from operator_private.staff_pins where profile_id = 'p-ali') !~ '^\$2[abxy]\$'
    or exists (select 1 from operator_private.staff_pins where pin_hash like '%2468%') then
    raise exception 'FAIL: PIN not stored as a bcrypt hash'; end if;
  if (select state::text from public.operator_workspaces where site_id = 'site-a') like '%2468%' then
    raise exception 'FAIL: PIN leaked into workspace state'; end if;
end $$;
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied(format('select public.operator_verify_staff_pin(%s, %L, %L)', :'A', 'p-ali', '2468'), 'production SV checks a packer PIN');
rollback;
begin;
select pg_temp.as_user(:PK);
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '2468'), 'ok', 'right PIN');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-old', '2468'), 'unset', 'inactive profile');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-nobody', '2468'), 'unset', 'unknown profile');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '1111'), 'wrong', 'wrong PIN 1');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '1111'), 'wrong', 'wrong PIN 2');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', 'abcd'), 'wrong', 'wrong PIN 3');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', null), 'wrong', 'wrong PIN 4');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '1111'), 'locked', 'fifth wrong PIN locks');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '2468'), 'locked', 'right PIN while locked');
select pg_temp.expect_denied(format('select public.operator_verify_staff_pin(%s, %L, %L)', :'B', 'p-ali', '2468'), 'packer checks a PIN at another site');
commit;
begin;
select pg_temp.as_user(:SO);
select pg_temp.expect_text((select count(*)::text from public.operator_staff_pin_status(:A) where locked_until is not null), '1', 'lock visible to the supervisor');
select public.operator_set_staff_pin(:A, 'p-ali', '135790');
commit;
begin;
select pg_temp.as_user(:PK);
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '2468'), 'wrong', 'old PIN after reset');
select pg_temp.expect_text(public.operator_verify_staff_pin(:A, 'p-ali', '135790'), 'ok', 'new PIN clears the lock');
commit;
do $$ begin
  if (select failed_attempts from operator_private.staff_pins where profile_id = 'p-ali') <> 0 then
    raise exception 'FAIL: a right PIN did not reset the wrong-PIN count'; end if;
end $$;
-- All-sites HR can set a PIN; the packer's own count is a signed commit like any other.
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000008');
select public.operator_set_staff_pin(:A, 'p-ali', '9753');
commit;
select pg_temp.expect(pg_temp.commit_as(:PK, :A, 'pack-own',
  jsonb_set(pg_temp.state(), '{events}', (pg_temp.state() -> 'events') || jsonb_build_array(pg_temp.ev('e-pack', '00000000-0000-4000-8000-000000000002')))),
  'ok', 'packer commits a signed pack-own');
select pg_temp.expect(pg_temp.commit_as(:PK, :A, 'staff-profile-create',
  jsonb_set(pg_temp.state(), '{staffProfiles}', '[]')), '42501', 'packer changes packer profiles');
select pg_temp.expect(pg_temp.commit_as(:PK, :A, 'pack-own',
  jsonb_set(pg_temp.state(), '{staffProfiles}', '[]')), '42501', 'pack-own outside its scope');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'staff-profile-update',
  jsonb_set(pg_temp.state(), '{staffProfiles,0,name}', '"Synthetic Ali B"')), 'ok', 'stock-out SV renames a packer profile');

-- 9. Factory and warehouse stages (20261009090001). Transfer needs mixing and filling; a new
--    box carton of a batch with a route snapshot needs every route stage.
\set W '''10000000-0000-4000-8000-0000000000c1'''
insert into public.operator_workspaces (id, site_id, name, state) values
  (:W, 'site-w', 'Synthetic site W', $${
    "version":1,
    "batches":[{"id":"w1","code":"SYN-W-1","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"P1","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"}]}],
    "cartons":[],"adypocideReceipts":[],"orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],
    "events":[],"notes":[],"closedDays":[]}$$::jsonb);
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  (:W, '00000000-0000-4000-8000-000000000001', 'production', 'SV W', 'site'),
  (:W, '00000000-0000-4000-8000-000000000006', 'intake', 'SI W', 'site');
create function pg_temp.done(p_state jsonb, p_pos int, p_pic text) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(p_state, array['batches','0','steps',p_pos::text,'pic'], to_jsonb(p_pic)),
    array['batches','0','steps',p_pos::text,'done'], 'true') $$;
create function pg_temp.boxed(p_state jsonb) returns jsonb language sql as $$
  select jsonb_set(p_state, '{cartons}', '[{"id":"cw1","ref":"SYN-W-1","batchId":"w1","product":"ady","unit":"box","qty":40,"rack":"B","pic":"SI","at":"t"}]') $$;
select pg_temp.expect(pg_temp.commit_as(:SV, :W, 'transfer',
  jsonb_set(pg_temp.state(:W), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"')), '23514',
  'transfer without filling');
select pg_temp.expect(pg_temp.commit_as(:SV, :W, 'machine', pg_temp.done(pg_temp.state(:W), 1, 'P2')),
  'ok', 'production records filling');
select pg_temp.expect(pg_temp.commit_as(:SV, :W, 'transfer',
  jsonb_set(pg_temp.state(:W), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"')), 'ok',
  'transfer once mixing and filling are recorded (warehouse stages open)');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :W, 'stock-in-ady',
  pg_temp.boxed(pg_temp.state(:W))), '23514', 'box carton before warehouse stages');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :W, 'machine',
  pg_temp.done(pg_temp.done(pg_temp.state(:W), 2, 'P3'), 4, 'P5')), 'ok',
  'stock-in records batching and wrapping after transfer');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :W, 'stock-in-ady',
  pg_temp.boxed(pg_temp.state(:W))), '23514', 'box carton with Hologram still open');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :W, 'machine',
  pg_temp.done(pg_temp.state(:W), 3, 'P4')), 'ok', 'stock-in records Hologram');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :W, 'stock-in-ady',
  pg_temp.boxed(pg_temp.state(:W))), 'ok', 'box carton after all stages');
do $$ begin
  if not operator_private.factory_stage('mixing') or not operator_private.factory_stage('filling')
    or operator_private.factory_stage('batching') or operator_private.factory_stage('hologram')
    or operator_private.factory_stage('wrapping') then
    raise exception 'FAIL: factory_stage split'; end if;
end $$;

-- 9b. Optional stages (20261022090000). Hologram may be skipped with a reason by the
--     signed-in supervisor; a skipped optional stage satisfies the box-count gate. Required
--     stages cannot be skipped; a skip is only removed by a completion.
\set X '''10000000-0000-4000-8000-0000000000c2'''
insert into public.operator_workspaces (id, site_id, name, state) values
  (:X, 'site-x', 'Synthetic site X', $${
    "version":1,
    "batches":[{"id":"x1","code":"SYN-X-1","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "transferredAt":"2026-10-04T00:00:00Z","transferPic":"F",
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"P1","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"P2","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"P3","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"P5","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"}]},
      {"id":"x2","code":"SYN-X-2","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "transferredAt":"2026-10-04T00:00:00Z","transferPic":"F",
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"P1","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"P2","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"}]}],
    "cartons":[],"adypocideReceipts":[],"orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],
    "events":[],"notes":[],"closedDays":[]}$$::jsonb);
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  (:X, '00000000-0000-4000-8000-000000000001', 'production', 'SV X', 'site'),
  (:X, '00000000-0000-4000-8000-000000000006', 'intake', 'SI X', 'site');
create function pg_temp.skip(p_state jsonb, p_batch int, p_pos int, p_reason text, p_uid text) returns jsonb language sql as $$
  select jsonb_set(p_state, array['batches',p_batch::text,'steps',p_pos::text,'skipped'],
    jsonb_build_object('at', 't', 'reason', p_reason, 'recordedBy', jsonb_build_object('userId', p_uid))) $$;
create function pg_temp.boxed_x(p_state jsonb) returns jsonb language sql as $$
  select jsonb_set(p_state, '{cartons}', '[{"id":"cx1","ref":"SYN-X-1","batchId":"x1","product":"ady","unit":"box","qty":12,"rack":"B","pic":"SI","at":"t"}]') $$;
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stock-in-ady',
  pg_temp.boxed_x(pg_temp.state(:X))), '23514', 'box carton with Hologram neither recorded nor skipped');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  pg_temp.skip(pg_temp.state(:X), 1, 2, 'No batching this run', '00000000-0000-4000-8000-000000000006')),
  '23514', 'skip a required stage (batching)');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  pg_temp.skip(pg_temp.state(:X), 0, 3, 'No hologram for this product', '00000000-0000-4000-8000-000000000001')),
  '23514', 'skip attributed to another user');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  pg_temp.skip(pg_temp.state(:X), 0, 3, '', '00000000-0000-4000-8000-000000000006')),
  '23514', 'skip without a reason');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  jsonb_set(pg_temp.state(:X), '{batches,0,steps,3,skipped}', '"yes"')), '23514', 'skip that is not an object');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  pg_temp.skip(pg_temp.state(:X), 0, 3, 'No hologram for this product', '00000000-0000-4000-8000-000000000006')),
  'ok', 'stock-in skips Hologram with a reason');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stage-skip',
  pg_temp.state(:X) #- '{batches,0,steps,3,skipped}'), '23514', 'remove a skip without a completion');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'stock-in-ady',
  pg_temp.boxed_x(pg_temp.state(:X))), 'ok', 'box carton with Hologram skipped');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000001', :X, 'machine',
  jsonb_set(jsonb_set(pg_temp.state(:X) #- '{batches,0,steps,3,skipped}', '{batches,0,steps,3,pic}', '"P4"'),
    '{batches,0,steps,3,done}', 'true')), 'ok', 'a completion replaces the skip');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :X, 'wrapping-count',
  jsonb_set(pg_temp.skip(pg_temp.state(:X), 1, 3, 'No hologram', '00000000-0000-4000-8000-000000000006'),
    '{cartons}', (pg_temp.state(:X) -> 'cartons')
      || '[{"id":"cx2","ref":"SYN-X-2","batchId":"x2","product":"ady","unit":"box","qty":5,"rack":"B","pic":"SI","at":"t"}]')),
  '23514', 'wrapping-count with batching and wrapping still open');
do $$ begin
  if not operator_private.optional_stage('hologram') or operator_private.optional_stage('mixing')
    or operator_private.optional_stage('filling') or operator_private.optional_stage('batching')
    or operator_private.optional_stage('wrapping') then
    raise exception 'FAIL: optional_stage split'; end if;
end $$;

-- 9c. The receipt and the box count record the transfer (20261023090000). A sachet batch
--     production has not sent can be received or counted once mixing and filling have a PIC;
--     the database transfer gate still refuses it otherwise.
\set SI '''00000000-0000-4000-8000-000000000006'''
\set Y '''10000000-0000-4000-8000-0000000000c3'''
insert into public.operator_workspaces (id, site_id, name, state) values
  (:Y, 'site-y', 'Synthetic site Y', $${
    "version":1,
    "batches":[{"id":"y1","code":"SYN-Y-1","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"P1","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"P3","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"P4","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"P5","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"}]}],
    "cartons":[],"adypocideReceipts":[],"orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],
    "events":[],"notes":[],"closedDays":[]}$$::jsonb);
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  (:Y, '00000000-0000-4000-8000-000000000001', 'production', 'SV Y', 'site'),
  (:Y, '00000000-0000-4000-8000-000000000006', 'intake', 'SI Y', 'site');
create function pg_temp.sent_y(p_state jsonb) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(p_state, '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"'),
    '{batches,0,transferPic}', '"SI"') $$;
create function pg_temp.boxed_y(p_state jsonb) returns jsonb language sql as $$
  select jsonb_set(p_state, '{cartons}', '[{"id":"cy1","ref":"SYN-Y-1","batchId":"y1","product":"ady","unit":"box","qty":7,"rack":"B","pic":"SI","at":"t"}]') $$;
select pg_temp.expect(pg_temp.commit_as(:SI, :Y, 'stock-in-ady', pg_temp.boxed_y(pg_temp.sent_y(pg_temp.state(:Y)))),
  '23514', 'stock-in counts and sends a batch whose filling has no PIC');
select pg_temp.expect(pg_temp.commit_as(:SI, :Y, 'receive-ady',
  jsonb_set(pg_temp.sent_y(pg_temp.state(:Y)), '{adypocideReceipts}',
    '[{"id":"ry1","ref":"SYN-Y-1","batchId":"y1","pic":"SI","at":"t"}]')),
  '23514', 'stock-in receives and sends a batch whose filling has no PIC');
select pg_temp.expect(pg_temp.commit_as(:SV, :Y, 'machine', pg_temp.done(pg_temp.state(:Y), 1, 'P2')),
  'ok', 'production records filling');
select pg_temp.expect(pg_temp.commit_as(:SI, :Y, 'stock-in-ady', pg_temp.boxed_y(pg_temp.sent_y(pg_temp.state(:Y)))),
  'ok', 'stock-in counts the boxes and records the transfer in one commit');
do $$ begin
  if not exists (select 1 from jsonb_array_elements(pg_temp.state('10000000-0000-4000-8000-0000000000c3') -> 'batches') b
      where b ->> 'id' = 'y1' and b ->> 'transferredAt' = '2026-10-04T00:00:00Z' and b ->> 'transferPic' = 'SI') then
    raise exception 'FAIL: expected the batch marked as sent by the box count'; end if;
end $$;

-- 9d. The box count needs the warehouse stages only (20261024090000). A batch whose mixing
--     or filling has no PIC can be counted once batching, hologram (or its skip) and
--     wrapping are recorded; marking it as sent still needs the factory stages.
\set Z '''10000000-0000-4000-8000-0000000000c4'''
insert into public.operator_workspaces (id, site_id, name, state) values
  (:Z, 'site-z', 'Synthetic site Z', $${
    "version":1,
    "batches":[{"id":"z1","code":"SYN-Z-1","product":"ady","date":"2026-10-01","target":0,"actual":0,"sent":0,
      "route":{"id":"sachet-v2","stages":["mixing","filling","batching","hologram","wrapping"],"at":"t"},
      "steps":[
        {"sachetStage":"mixing","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"filling","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"batching","pic":"P3","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"},
        {"sachetStage":"hologram","pic":"","qty":null,"start":"","end":"","done":false,"qc":"not-recorded"},
        {"sachetStage":"wrapping","pic":"P5","qty":null,"start":"","end":"","done":true,"qc":"not-recorded"}]}],
    "cartons":[],"adypocideReceipts":[],"orders":[],"issues":[],"boxing":[],"counts":[],"adjustments":[],
    "events":[],"notes":[],"closedDays":[]}$$::jsonb);
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  (:Z, '00000000-0000-4000-8000-000000000006', 'intake', 'SI Z', 'site');
create function pg_temp.boxed_z(p_state jsonb) returns jsonb language sql as $$
  select jsonb_set(p_state, '{cartons}', '[{"id":"cz1","ref":"SYN-Z-1","batchId":"z1","product":"ady","unit":"box","qty":3,"rack":"B","pic":"SI","at":"t"}]') $$;
select pg_temp.expect(pg_temp.commit_as(:SI, :Z, 'stock-in-ady', pg_temp.boxed_z(pg_temp.state(:Z))),
  '23514', 'box carton with Hologram neither recorded nor skipped (factory stages open)');
select pg_temp.expect(pg_temp.commit_as(:SI, :Z, 'stage-skip',
  pg_temp.skip(pg_temp.state(:Z), 0, 3, 'No hologram', '00000000-0000-4000-8000-000000000006')),
  'ok', 'stock-in skips Hologram on an unsent batch');
select pg_temp.expect(pg_temp.commit_as(:SI, :Z, 'stock-in-ady',
  jsonb_set(pg_temp.boxed_z(pg_temp.state(:Z)), '{batches,0,transferredAt}', '"2026-10-04T00:00:00Z"')),
  '23514', 'the count marks the batch as sent while filling has no PIC');
select pg_temp.expect(pg_temp.commit_as(:SI, :Z, 'stock-in-ady', pg_temp.boxed_z(pg_temp.state(:Z))),
  'ok', 'box carton with the warehouse stages done and the factory stages open');

-- 9e. Box recounts (20261025090000): stock.adjust holders record a recount adjustment on a
--     box carton; the rule is scoped to adjustments and events.
select pg_temp.expect(pg_temp.commit_as(:SI, :X, 'recount-ady',
  jsonb_set(pg_temp.state(:X), '{adjustments}', coalesce(pg_temp.state(:X) -> 'adjustments', '[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('id', 'rc1', 'cartonId', 'cx1', 'delta', 200, 'reason', 'Recount: second count',
      'at', 't', 'kind', 'recount', 'from', 12, 'to', 212, 'pic', 'SI', 'recordedBy', jsonb_build_object('userId', :SI))))),
  'ok', 'stock-in records a recount adjustment');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000001', :X, 'recount-ady',
  jsonb_set(pg_temp.state(:X), '{adjustments}', (pg_temp.state(:X) -> 'adjustments')
    || jsonb_build_array(jsonb_build_object('id', 'rc2', 'cartonId', 'cx1', 'delta', 1, 'reason', 'Recount: x',
      'at', 't', 'kind', 'recount')))), '42501', 'production records a recount');
select pg_temp.expect(pg_temp.commit_as(:SI, :X, 'recount-ady',
  jsonb_set(pg_temp.state(:X), '{adjustments,0,delta}', '5')), '23514', 'rewrite an existing recount');
select pg_temp.expect(pg_temp.commit_as(:SI, :X, 'recount-ady',
  jsonb_set(pg_temp.state(:X), '{batches,0,code}', '"X"')), '42501', 'recount-ady used to edit batches');

-- 10. Stock returns (20261009090002): append-only, attributed, into an existing carton.
\set SI '''00000000-0000-4000-8000-000000000006'''
create function pg_temp.ret(p_id text, p_carton text, p_qty jsonb, p_uid text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'cartonId', p_carton, 'qty', p_qty, 'reason', 'Courier return',
    'pic', 'SI', 'at', 't', 'recordedBy', jsonb_build_object('userId', p_uid)) $$;
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', jsonb_build_array(pg_temp.ret('r1', 'cw1', '3', :SI)))),
  'ok', 'return to a carton');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', (pg_temp.state(:W) -> 'returns')
    || jsonb_build_array(pg_temp.ret('r2', 'cw1', '0', :SI)))), '23514', 'return with qty 0');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', (pg_temp.state(:W) -> 'returns')
    || jsonb_build_array(pg_temp.ret('r3', 'cw1', '1.5', :SI)))), '23514', 'return with a fractional qty');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns,0,qty}', '30')), '23514', 'rewrite an existing return');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', '[]')), '23514', 'remove an existing return');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', (pg_temp.state(:W) -> 'returns')
    || jsonb_build_array(pg_temp.ret('r4', 'no-such-carton', '1', :SI)))), '23514', 'return to an unknown carton');
select pg_temp.expect(pg_temp.commit_as(:SI, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', (pg_temp.state(:W) -> 'returns')
    || jsonb_build_array(pg_temp.ret('r5', 'cw1', '1', '00000000-0000-4000-8000-000000000001')))),
  '23514', 'return attributed to another user');
select pg_temp.expect(pg_temp.commit_as(:SV, :W, 'return',
  jsonb_set(pg_temp.state(:W), '{returns}', (pg_temp.state(:W) -> 'returns')
    || jsonb_build_array(pg_temp.ret('r6', 'cw1', '1', :SV)))), '42501', 'production SV records a return');
-- Returned units count in the balance: 40 boxed + 3 returned can be issued as 43, not 44.
insert into public.operator_memberships (workspace_id, user_id, role, display_name, scope) values
  (:W, '00000000-0000-4000-8000-000000000009', 'outbound', 'SO W', 'site');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000009', :W, 'issue',
  jsonb_set(pg_temp.state(:W), '{issues}', '[{"id":"iw1","cartonId":"cw1","orderId":"o","qty":44,"pic":"x","at":"t"}]')),
  '23514', 'issue more than received plus returned');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000009', :W, 'issue',
  jsonb_set(pg_temp.state(:W), '{issues}', '[{"id":"iw1","cartonId":"cw1","orderId":"o","qty":43,"pic":"x","at":"t"}]')),
  'ok', 'issue received plus returned');

-- 11. Trip drop-offs and assistants (20261009090003): drop-offs are appended only, by the
--     sign-in that logged the trip, each with a time not before pickup and its own photo.
create function pg_temp.drop(p_id text, p_uid text, p_at text default '2026-10-06T01:30:00.000Z',
  p_photo boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'at', p_at, 'recordedAt', '2026-10-06T01:31:00.000Z')
    || case when p_photo then jsonb_build_object('photo',
      '10000000-0000-4000-8000-00000000000a/' || p_uid || '/' || repeat('c', 64) || '.jpg') else '{}' end $$;
create function pg_temp.drops(p jsonb) returns jsonb language sql as $$
  select jsonb_set(pg_temp.state(), '{trips,0,dropoffs}', p) $$;
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  pg_temp.drops(jsonb_build_array(pg_temp.drop('d1', :DRV)))), 'ok', 'driver adds a drop-off to own trip');
select pg_temp.expect(pg_temp.commit_as(:DRV2, :A, 'trip-dropoff',
  pg_temp.drops((pg_temp.state() -> 'trips' -> 0 -> 'dropoffs') || jsonb_build_array(pg_temp.drop('d2', :DRV2)))),
  '23514', 'another sign-in adds a drop-off');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  jsonb_set(pg_temp.state(), '{trips,0,dropoffs,0,at}', '"2026-10-06T01:45:00.000Z"')),
  '23514', 'rewrite a recorded drop-off');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff', pg_temp.drops('[]')),
  '23514', 'remove a recorded drop-off');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  pg_temp.drops((pg_temp.state() -> 'trips' -> 0 -> 'dropoffs') || jsonb_build_array(pg_temp.drop('d3', :DRV, p_photo => false)))),
  '23514', 'drop-off without a photo');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  pg_temp.drops((pg_temp.state() -> 'trips' -> 0 -> 'dropoffs') || jsonb_build_array(pg_temp.drop('d4', :DRV2)))),
  '23514', 'drop-off photo in another account''s folder');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  pg_temp.drops((pg_temp.state() -> 'trips' -> 0 -> 'dropoffs') || jsonb_build_array(pg_temp.drop('d5', :DRV, '2026-10-06T00:30:00.000Z')))),
  '23514', 'drop-off before pickup');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip-dropoff',
  pg_temp.drops((pg_temp.state() -> 'trips' -> 0 -> 'dropoffs') || jsonb_build_array(pg_temp.drop('d6', :DRV, '2026-10-06T03:30:00.000Z')))),
  'ok', 'second drop-off after arrival');
select pg_temp.expect(pg_temp.commit_as(:DRV, :A, 'trip',
  pg_temp.with_trips((pg_temp.state() -> 'trips') || jsonb_build_array(pg_temp.trip('t-crew', :DRV,
    '{"assistants":["Assistant A","Assistant B"]}')))), 'ok', 'new trip with two assistants');
do $$ begin
  if jsonb_array_length((select state -> 'trips' -> 0 -> 'dropoffs' from public.operator_workspaces where site_id = 'site-a')) <> 2 then
    raise exception 'FAIL: expected two drop-offs on the trip'; end if;
end $$;

-- 12. Removing AWBs and uploads (20261011090000). Admin or the stock-out SV removes an
--     order under the remove-order rule; only admin deletes an upload (import-delete).
--     Whatever the signature says, a removal can never take recorded stock issues or audit
--     entries along, and stays inside its state scope.
\set ADM '''00000000-0000-4000-8000-000000000007'''
create function pg_temp.ord(p_id text, p_import text default null) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'awb', 'NVMY' || p_id, 'channel', 'Luxana', 'product', 'cav',
    'package', 'P', 'expected', 4, 'originalExpected', 4, 'actual', null, 'packer', '', 'labelPic', '',
    'printed', false, 'dispatched', false, 'handoverRef', '', 'date', '2026-10-06', 'note', '',
    'reviewState', 'confirmed')
    || case when p_import is null then '{}'::jsonb else jsonb_build_object('importId', p_import) end $$;
create function pg_temp.orders(p jsonb) returns jsonb language sql as $$ select jsonb_set(pg_temp.state(), '{orders}', p) $$;
-- Orders live in public.operator_orders (20261017090000): a command sends the orders it
-- changes as operations, each with the version it was based on (null for a new order).
create function pg_temp.put(p_order jsonb, p_expected integer default null) returns jsonb language sql as $$
  select jsonb_build_object('op', 'put', 'order', p_order, 'expected', p_expected) $$;
create function pg_temp.del(p_id text, p_expected integer) returns jsonb language sql as $$
  select jsonb_build_object('op', 'delete', 'id', p_id, 'expected', p_expected) $$;
create function pg_temp.order_ids() returns jsonb language sql as $$
  select coalesce(jsonb_agg(id order by id), '[]') from public.operator_orders
  where workspace_id = '10000000-0000-4000-8000-00000000000a' $$;
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-save',
  jsonb_set(pg_temp.state(), '{awbImports}', '[{"id":"imp1","name":"Synthetic upload","date":"2026-10-06","files":[],"rows":[],"createdAt":"t","updatedAt":"t"}]')),
  'ok', 'admin saves an upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o1', 'imp1')), pg_temp.put(pg_temp.ord('o2', 'imp1'))))),
  'ok', 'admin releases two AWBs from the upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o3'))))),
  'ok', 'admin enters a manual AWB');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.del('o3', 1)))),
  '42501', 'production SV removes an AWB');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.del('o3', 1)))),
  '42501', 'management removes an AWB');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.del('o3', 1))),
    '{events}', (pg_temp.state() -> 'events') || jsonb_build_array(pg_temp.ev('e-rm3', '00000000-0000-4000-8000-000000000007')))),
  'ok', 'admin removes the manual AWB with an audit entry');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.del('o2', 1))), '{batches,0,code}', '"X"')),
  '42501', 'remove-order used to edit batches');
-- Audit entries live in public.operator_events (20261015090000): a command cannot drop them
-- from the document, and nobody can change or delete them in the table.
do $$ begin
  if not exists (select 1 from public.operator_events where id = 'e-rm3'
      and body -> 'recorder' ->> 'userId' = '00000000-0000-4000-8000-000000000007')
    or (select state -> 'events' from public.operator_workspaces where site_id = 'site-a') <> '[]'::jsonb
    or not exists (select 1 from public.operator_imports where id = 'imp1') then
    raise exception 'FAIL: expected the audit entry and the upload in their tables, not the document'; end if;
end $$;
begin;
select pg_temp.as_user(:ADM);
select pg_temp.expect_denied('delete from public.operator_events', 'deleting audit entries');
select pg_temp.expect_denied($q$update public.operator_events set body = '{}'$q$, 'rewriting audit entries');
select pg_temp.expect_denied($q$insert into public.operator_events (workspace_id, id, entity, body)
  values ('10000000-0000-4000-8000-00000000000a', 'forged', 'b1', '{}')$q$, 'forging audit entries');
select pg_temp.expect_denied('delete from public.operator_imports', 'deleting uploads directly');
do $$ begin
  if not exists (select 1 from public.operator_events where id = 'e-rm3')
    or not exists (select 1 from public.operator_import_summaries where id = 'imp1' and (summary ->> 'rowCount')::int = 0) then
    raise exception 'FAIL: a member cannot read the site''s audit entries and uploads'; end if;
end $$;
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000011');
do $$ begin
  if exists (select 1 from public.operator_events) or exists (select 1 from public.operator_imports)
    or exists (select 1 from public.operator_import_summaries) then
    raise exception 'FAIL: a non-member reads audit entries or uploads'; end if;
end $$;
rollback;
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', (pg_temp.state() -> 'issues')
    || '[{"id":"i-o2","cartonId":"c1","orderId":"o2","qty":1,"pic":"SO","at":"t"}]')),
  'ok', 'stock issued to the second AWB');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.del('o2', 1))), '{issues}',
    (select coalesce(jsonb_agg(i), '[]') from jsonb_array_elements(pg_temp.state() -> 'issues') i where i ->> 'orderId' <> 'o2'))),
  '23514', 'removing an AWB that has a stock issue (20261018090000: it stays for traceability)');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'import-delete',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.del('o1', 1))), '{awbImports}', '[{"id":"imp1","deleted":true}]')),
  '42501', 'stock-out SV deletes an upload');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{awbImports}', '[{"id":"imp1","deleted":true}]')),
  '42501', 'a stock issue deleting an upload (uploads are outside its scope)');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-save',
  jsonb_set(pg_temp.state(), '{awbImports}', '[{"id":"imp2","rows":[]},{"id":"imp2","rows":[]}]')),
  '22023', 'two records for one upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-save',
  jsonb_set(pg_temp.state(), '{awbImports}', '[{"id":"imp2"}]')),
  '22023', 'an upload without label rows');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-delete',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.del('o1', 1))), '{awbImports}', '[{"id":"imp1","deleted":true}]')),
  'ok', 'admin deletes the upload and its untouched AWB');
do $$ begin
  if exists (select 1 from public.operator_imports where id = 'imp1')
    or pg_temp.order_ids() <> '["o2"]'::jsonb
    or (select state ? 'orders' from public.operator_workspaces where site_id = 'site-a')
    or not exists (select 1 from public.operator_issues where id = 'i-o2' and order_id = 'o2' and qty = 1)
    or (select state -> 'issues' from public.operator_workspaces where site_id = 'site-a') <> '[]'::jsonb then
    raise exception 'FAIL: expected the upload gone, only the issued AWB left and its stock issue kept'; end if;
end $$;

-- 12b. Orders in their own table (20261017090000): every change carries the version it was
--      based on, one active order per AWB, only order commands change orders, and a save
--      that touches only orders leaves the document and its revision alone.
select revision as "REV_ORD" from public.operator_workspaces where site_id = 'site-a' \gset
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'pack',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o2', 'imp1') || '{"actual": 4}', 1))), p_rev => 0),
  'ok', 'order-only save with an old document revision');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'pack',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o2', 'imp1') || '{"actual": 3}', 1)))),
  'conflict', 'a change based on an older version of the order');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o2', 'imp1'))))),
  'conflict', 'creating an order that already exists');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'pack',
  pg_temp.orders(jsonb_build_array(pg_temp.del('o2', 9)))),
  'conflict', 'removing an order with a stale version');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o9') || '{"awb": " nvmy o2 "}')))),
  '23505', 'a second order with the same AWB');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  pg_temp.orders(jsonb_build_array(pg_temp.put(pg_temp.ord('o2', 'imp1') || '{"actual": 1}', 2)))),
  '42501', 'a stock issue changing an order (orders are outside its scope)');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'pack',
  pg_temp.orders('[{"op": "put", "order": {"id": "o5"}}]')),
  '22023', 'an order without an AWB');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'pack',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o5')))),
  '22023', 'a plain order list instead of operations (an application that predates the table)');
do $$ begin
  if (select version from public.operator_orders where id = 'o2') <> 2
    or (select (doc ->> 'actual')::int from public.operator_orders where id = 'o2') <> 4
    or (select awb from public.operator_orders where id = 'o2') <> 'NVMYO2' then
    raise exception 'FAIL: expected o2 at version 2 with actual 4'; end if;
end $$;
select pg_temp.expect((select jsonb_build_object('ok', revision = :REV_ORD and not state ? 'orders')
  from public.operator_workspaces where site_id = 'site-a'), 'ok', 'order-only saves keep the document revision');
begin;
select pg_temp.as_user(:SV);
do $$ begin
  if (select count(*) from public.operator_orders_for('10000000-0000-4000-8000-00000000000a', p_awbs => '{NVMYO2}')) <> 1
    or (select count(*) from public.operator_orders_for('10000000-0000-4000-8000-00000000000a', p_dates => '{2026-10-06}')) <> 1 then
    raise exception 'FAIL: a member cannot look up the site''s orders'; end if;
end $$;
select pg_temp.expect_denied($q$update public.operator_orders set version = 1$q$, 'editing orders directly');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000011');
do $$ begin
  if exists (select 1 from public.operator_orders)
    or exists (select 1 from public.operator_orders_for('10000000-0000-4000-8000-00000000000a', p_ids => '{o2}')) then
    raise exception 'FAIL: a non-member reads orders'; end if;
end $$;
rollback;

-- 12c. Stock issues in their own table (20261018090000): the balance check counts the stored
--      issues, issues need an existing carton, and nobody edits issues directly.
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', '[{"id":"i-x4","cartonId":"c1","orderId":"o2","qty":4,"pic":"SO","at":"2026-10-01T02:00:00Z"}]')),
  'ok', 'issue the rest of the carton (4 of 5; 1 already stored)');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', '[{"id":"i-x5","cartonId":"c1","orderId":"o2","qty":1,"pic":"SO","at":"t"}]')),
  '23514', 'issue below zero counting stored issues');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', '[{"id":"i-x6","cartonId":"nope","orderId":"o2","qty":1,"pic":"SO","at":"t"}]')),
  '23514', 'issue from a carton that does not exist');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', '[{"id":"total:c1","cartonId":"c1","orderId":"o2","qty":1,"pic":"SO","at":"t"}]')),
  '23514', 'an issue posing as a stored total');
do $$ begin
  if (select sum(qty) from public.operator_issues where carton_id = 'c1') <> 5
    or (select state -> 'issues' from public.operator_workspaces where site_id = 'site-a') <> '[]'::jsonb
    or (select issue_day from public.operator_issues where id = 'i-x4') <> '2026-10-01' then
    raise exception 'FAIL: expected 5 issued from c1 in the table, none in the document'; end if;
end $$;
begin;
select pg_temp.as_user(:SO);
do $$ begin
  if (select qty from public.operator_issue_totals('10000000-0000-4000-8000-00000000000a', '2026-10-02')
      where carton_id = 'c1' and day is null) <> 4
    or (select sum(qty) from public.operator_issue_totals('10000000-0000-4000-8000-00000000000a', '2026-10-02')
      where carton_id = 'c1') <> 5
    or (select count(*) from public.operator_issue_totals('10000000-0000-4000-8000-00000000000a', '2000-01-01')
      where carton_id = 'c1' and day = '2026-10-01') <> 1
    or (select count(*) from public.operator_issues_for('10000000-0000-4000-8000-00000000000a', '{o2}')) <> 2
    or (select count(*) from public.operator_issues_for('10000000-0000-4000-8000-00000000000a', '{}', '{2026-10-06}')) <> 2
    or (select count(*) from public.operator_issues_for('10000000-0000-4000-8000-00000000000a', '{}', '{2026-10-07}')) <> 0 then
    raise exception 'FAIL: a member cannot read issue totals and order issues'; end if;
end $$;
select pg_temp.expect_denied($q$update public.operator_issues set qty = 1$q$, 'editing stock issues directly');
select pg_temp.expect_denied('delete from public.operator_issues', 'deleting stock issues directly');
rollback;
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000011');
do $$ begin
  if exists (select 1 from public.operator_issues)
    or exists (select 1 from public.operator_issue_totals('10000000-0000-4000-8000-00000000000a', '2026-01-01')) then
    raise exception 'FAIL: a non-member reads stock issues'; end if;
end $$;
rollback;
-- 12d. Cancelling a mistaken batch and correcting its work date (20261019090000). Only
--      production supervisors (production.plan) may, inside their factory scope; the batch
--      is marked cancelled or its date changed, never removed.
create function pg_temp.patch_batch(p_id text, p_patch jsonb, p_uid text) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(pg_temp.state(), '{batches}', (
      select jsonb_agg(case when b ->> 'id' = p_id then b || p_patch else b end order by n)
      from jsonb_array_elements(pg_temp.state() -> 'batches') with ordinality x(b, n))),
    '{events}', coalesce(pg_temp.state() -> 'events', '[]')
      || jsonb_build_array(pg_temp.ev('e-' || gen_random_uuid(), p_uid))) $$;
create function pg_temp.cancelled(p_uid text) returns jsonb language sql as $$
  select jsonb_build_object('cancelled', jsonb_build_object('at', '2026-10-16T08:00:00.000Z',
    'reason', 'Recorded with the wrong date', 'pic', 'SV', 'recordedBy', jsonb_build_object('userId', p_uid))) $$;
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('x-cav', 'cav'))), 'ok', 'plan a bottle batch to cancel');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  pg_temp.with_batch(pg_temp.new_batch('x-ady', 'ady'))), 'ok', 'plan a sachet batch to cancel');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :A, 'batch-cancel',
  pg_temp.patch_batch('x-cav', pg_temp.cancelled('00000000-0000-4000-8000-000000000006'),
    '00000000-0000-4000-8000-000000000006')), '42501', 'stock-in SV cancels a batch');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000006', :A, 'batch-correct',
  pg_temp.patch_batch('x-cav', '{"date": "2026-10-08"}', '00000000-0000-4000-8000-000000000006')),
  '42501', 'stock-in SV corrects a batch date');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'batch-cancel',
  pg_temp.patch_batch('x-cav', pg_temp.cancelled('00000000-0000-4000-8000-000000000009'),
    '00000000-0000-4000-8000-000000000009')), '42501', 'stock-out SV cancels a batch');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'batch-correct',
  pg_temp.patch_batch('x-cav', '{"date": "2026-10-08"}', '00000000-0000-4000-8000-000000000007')),
  '42501', 'office admin corrects a batch date');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :A, 'batch-cancel',
  pg_temp.patch_batch('x-cav', pg_temp.cancelled('00000000-0000-4000-8000-000000000004'),
    '00000000-0000-4000-8000-000000000004')), '42501', 'management cancels a batch');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'batch-cancel',
  pg_temp.patch_batch('x-cav', pg_temp.cancelled('00000000-0000-4000-8000-000000000002'),
    '00000000-0000-4000-8000-000000000002')), '42501', 'packer cancels a batch');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'batch-cancel',
  pg_temp.patch_batch('x-ady', pg_temp.cancelled('00000000-0000-4000-8000-000000000015'),
    '00000000-0000-4000-8000-000000000015')), '42501', 'bottle SV cancels a sachet batch');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch-cancel',
  jsonb_set(pg_temp.state(), '{batches}', (select jsonb_agg(b) from jsonb_array_elements(pg_temp.state() -> 'batches') b
    where b ->> 'id' <> 'x-cav'))), '23514', 'cancelling by removing the batch');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch-cancel',
  jsonb_set(pg_temp.patch_batch('x-cav', pg_temp.cancelled('00000000-0000-4000-8000-000000000001'),
    '00000000-0000-4000-8000-000000000001'), '{cartons,0,rack}', '"Z"')), '42501', 'batch-cancel changing a carton');
select pg_temp.expect(pg_temp.commit_as(:BOTTLE, :A, 'batch-correct',
  pg_temp.patch_batch('x-cav', '{"date": "2026-10-08", "version": 1}', '00000000-0000-4000-8000-000000000015')),
  'ok', 'bottle SV corrects a bottle batch date');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch-cancel',
  pg_temp.patch_batch('x-ady', pg_temp.cancelled('00000000-0000-4000-8000-000000000001') || '{"version": 1}',
    '00000000-0000-4000-8000-000000000001')), 'ok', 'production SV cancels a sachet batch');
do $$ begin
  if not exists (select 1 from jsonb_array_elements(pg_temp.state() -> 'batches') b
      where b ->> 'id' = 'x-cav' and b ->> 'date' = '2026-10-08')
    or not exists (select 1 from jsonb_array_elements(pg_temp.state() -> 'batches') b
      where b ->> 'id' = 'x-ady' and b -> 'cancelled' ->> 'reason' = 'Recorded with the wrong date') then
    raise exception 'FAIL: expected the corrected date and the cancelled batch kept in the document'; end if;
end $$;

-- 12e. Package SKU mappings (20261020090000; capability catalog.edit since 20261026090000).
--      Only the catalogue capability (the office admin and the stock-out SV) maps, edits,
--      retires or reactivates a SKU; the mappings are a top-level key that only these
--      commands and a release (which remembers hand-mapped SKUs) change, and the catalogue
--      commands change nothing else.
create function pg_temp.skus(p jsonb, p_event text default null,
  p_uid text default '00000000-0000-4000-8000-000000000007') returns jsonb language sql as $$
  select jsonb_set(jsonb_set(pg_temp.state(), '{skuAliases}', p), '{events}',
    (pg_temp.state() -> 'events') || case when p_event is null then '[]'::jsonb
      else jsonb_build_array(pg_temp.ev(p_event, p_uid)) end) $$;
create function pg_temp.sku(p_id text, p_active boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'sku', 'syn' || p_id, 'product', 'syn', 'units', 8,
    'canonical', 'SYN-' || upper(p_id), 'active', p_active, 'createdAt', 't', 'updatedAt', 't',
    'version', 1, 'history', '[]'::jsonb) $$;
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'sku-alias-save',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')), 'e-sku0', '00000000-0000-4000-8000-000000000009')),
  'ok', 'stock-out SV maps a package SKU');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'sku-alias-save',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')))), '42501', 'production SV maps a package SKU');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :A, 'sku-alias-save',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')))), '42501', 'management maps a package SKU');
select pg_temp.expect(pg_temp.commit_as(:PK, :A, 'sku-alias-retire',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')))), '42501', 'packer changes package SKUs');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'sku-alias-save',
  jsonb_set(pg_temp.skus(jsonb_build_array(pg_temp.sku('k1'))), '{batches,0,code}', '"X"')),
  '42501', 'sku-alias-save used to edit batches');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-save',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1'), pg_temp.sku('k2')))), '42501', 'an upload save changing package SKUs');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'sku-alias-save',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')), 'e-sku1')), 'ok', 'admin maps a package SKU');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'sku-alias-retire',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1', false)), 'e-sku2')), 'ok', 'admin retires the mapping');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'sku-alias-reactivate',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')), 'e-sku3')), 'ok', 'admin reactivates the mapping');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'sku-alias-retire',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1', false)), 'e-sku4', '00000000-0000-4000-8000-000000000009')),
  'ok', 'stock-out SV retires the mapping');
-- A release remembers the SKUs mapped by hand (20261026090000): its scope includes the
-- catalogue; a plain upload save still cannot touch it.
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')), 'e-sku5')), 'ok', 'a release remembering a package SKU');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'import-release',
  pg_temp.skus(jsonb_build_array(pg_temp.sku('k1')), 'e-sku6', '00000000-0000-4000-8000-000000000009')),
  '42501', 'stock-out SV releases an upload');
do $$ begin
  if (select state -> 'skuAliases' -> 0 ->> 'sku' from public.operator_workspaces where site_id = 'site-a')
      is distinct from 'synk1'
    or (select count(*) from public.operator_events
        where id in ('e-sku0', 'e-sku1', 'e-sku2', 'e-sku3', 'e-sku4', 'e-sku5')) <> 6 then
    raise exception 'FAIL: expected the mapping in the document and six audit entries'; end if;
end $$;

-- 13. Workspace capacity (20261014090000). A document up to 4,000,000 bytes of jsonb text
--     is stored; a larger one is refused by the table's check.
do $$
declare stored boolean := false;
begin
  begin
    update public.operator_workspaces
      set state = state || jsonb_build_object('pad', repeat('x', 3500000)) where site_id = 'site-a';
    stored := true;
    raise exception 'undo' using errcode = 'U0001';
  exception when sqlstate 'U0001' then null;
  end;
  if not stored then raise exception 'FAIL: a 3.5 MB document was refused'; end if;
  begin
    update public.operator_workspaces
      set state = state || jsonb_build_object('pad', repeat('x', 4100000)) where site_id = 'site-a';
    raise exception 'FAIL: a 4.1 MB document was accepted';
  exception when check_violation then null;
  end;
end $$;

-- 14. Order archive (20261016090000). Orders whose work date is more than 7 days ago (MYT)
--     move to public.operator_orders_archive; only an active member can trigger it, the
--     cutoff is fixed, and the move is recorded.
update public.operator_workspaces set state = jsonb_set(state, '{orders}', jsonb_build_array(
  pg_temp.ord('arch-old') || '{"date": "2000-01-01", "awb": " nvmy arch old "}',
  pg_temp.ord('arch-new') || jsonb_build_object('date',
    to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD'))))
where site_id = 'site-a';
select revision as "REV_BEFORE" from public.operator_workspaces where site_id = 'site-a' \gset
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000011');
select pg_temp.expect_denied($q$select public.operator_archive_orders('10000000-0000-4000-8000-00000000000a')$q$, 'a non-member archives orders');
rollback;
begin;
select pg_temp.as_user(:SV);
do $$ begin
  if public.operator_archive_orders('10000000-0000-4000-8000-00000000000a') <> 1 then
    raise exception 'FAIL: expected one order archived'; end if;
  if public.operator_archive_orders('10000000-0000-4000-8000-00000000000a') <> 0 then
    raise exception 'FAIL: a second run archived again'; end if;
  if not exists (select 1 from public.operator_orders_archive where id = 'arch-old' and awb = 'NVMYARCHOLD'
      and order_date = '2000-01-01') then
    raise exception 'FAIL: the old order is not readable in the archive'; end if;
end $$;
commit;
do $$ begin
  if (select jsonb_agg(o ->> 'id') from public.operator_workspaces w, jsonb_array_elements(w.state -> 'orders') o
      where w.site_id = 'site-a') <> '["arch-new"]'::jsonb then
    raise exception 'FAIL: expected only the recent order left in the document'; end if;
  if not exists (select 1 from public.operator_events where body ->> 'action' = 'Orders archived'
      and body -> 'recorder' ->> 'userId' = '00000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL: the archive move has no attributed audit entry'; end if;
end $$;
select pg_temp.expect((select jsonb_build_object('ok', revision = :REV_BEFORE + 1) from public.operator_workspaces
  where site_id = 'site-a'), 'ok', 'archiving bumps the revision once');
begin;
select pg_temp.as_user('00000000-0000-4000-8000-000000000011');
do $$ begin
  if exists (select 1 from public.operator_orders_archive) then
    raise exception 'FAIL: a non-member reads archived orders'; end if;
end $$;
select pg_temp.expect_denied($q$insert into public.operator_orders_archive (workspace_id, id, awb, doc)
  values ('10000000-0000-4000-8000-00000000000a', 'forged', 'X', '{}')$q$, 'writing the archive directly');
rollback;

select 'operator access tests passed' as result;
