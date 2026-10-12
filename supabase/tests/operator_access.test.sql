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
  p_fingerprint text default null, p_effects jsonb default null, p_v1 boolean default false
) returns jsonb language plpgsql as $$
declare
  v_rev integer := coalesce(p_rev, (select revision from public.operator_workspaces where id = p_ws));
  v_text text := p_state::text;
  -- Upload effects (20261012090000) travel as exact text, signed on the message's last line.
  v_eff text := p_effects::text;
  v_fp text := coalesce(p_fingerprint, encode(extensions.digest(p_command || v_text, 'sha256'), 'hex'));
  v_sig text;
  v_row record;
  v_result jsonb;
begin
  -- p_v1 signs the pre-20261012090000 message (no effects line): accepted only without effects.
  v_sig := case when p_sign then encode(extensions.hmac(convert_to(concat_ws(E'\n',
    case when p_v1 then 'operator-commit-v1' else 'operator-commit-v2' end,
    p_ws::text, v_rev::text, coalesce(p_signer, p_uid)::text, p_op::text,
    p_command, v_fp, encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex'),
    case when p_v1 then null
      else encode(extensions.digest(convert_to(coalesce(v_eff, ''), 'UTF8'), 'sha256'), 'hex') end), 'UTF8'),
    (select secret from operator_private.server_keys where id = 'commit'), 'sha256'), 'hex')
    else repeat('0', 64) end;
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    select * into v_row from public.operator_commit_workspace(p_ws, v_rev, p_command, p_op, v_fp, v_text, v_sig, v_eff);
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
-- An audit entry as the app writes it. Since 20261013090000 the submitted state carries only
-- the command's new entries under `events`; the commit stores them in operator_events. The
-- readable name maps to a stable UUID (pg_temp.ev_id).
create function pg_temp.ev_id(p_id text) returns uuid language sql as $$ select md5('ev/' || p_id)::uuid $$;
create function pg_temp.ev(p_id text, p_uid text, p_entity text default 'b1') returns jsonb language sql as $$
  select jsonb_build_object('id', pg_temp.ev_id(p_id), 'entity', p_entity, 'action', 'test', 'detail', 'test',
    'actor', 'x', 'at', '2026-10-12T01:00:00.000Z', 'recorder', jsonb_build_object('userId', p_uid)) $$;
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
-- Site A was seeded with an audit entry in its document, as written before 20261013090000.
-- Move it the way that migration's backfill does (revision kept, so the cases below keep
-- their revision numbers); section 14 checks where it went.
do $$ begin
  perform operator_private.backfill_events(w.id, w.state -> 'events')
  from public.operator_workspaces w where w.site_id = 'site-a';
  update public.operator_workspaces set state = state || '{"events": []}' where site_id = 'site-a';
end $$;

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
-- Audit entries live in operator_events (20261013090000): a changed copy of a stored entry
-- and an entry under another user are refused by operator_private.append_events.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{events}', (select jsonb_build_array(jsonb_build_object('id', e.id,
    'entity', e.entity, 'action', e.action, 'detail', 'rewritten', 'actor', e.actor,
    'at', operator_private.iso(e.at), 'recorder', e.recorder))
    from public.operator_events e where e.detail = 'orig'))), '23514', 'rewrite audit event');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch',
  jsonb_set(pg_temp.state(), '{events}', jsonb_build_array(
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
    '{batches,0,steps,3,done}', 'true'), '{events}', jsonb_build_array(
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
    jsonb_build_array(pg_temp.ev('e-trip', :DRV, 'trip:t1')))),
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
  jsonb_set(pg_temp.state(), '{events}', jsonb_build_array(pg_temp.ev('e-pack', '00000000-0000-4000-8000-000000000002', 'o-pack')))),
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


-- 12. Removing AWBs and uploads (20261011090000; uploads in tables since 20261012090000).
--     Admin or the stock-out SV removes an order under the remove-order rule; only admin
--     deletes an upload (import-delete). Whatever the signature says, a removal can never take
--     recorded stock issues or audit entries along, and stays inside its state scope.
\set ADM '''00000000-0000-4000-8000-000000000007'''
\set MGMT '''00000000-0000-4000-8000-000000000004'''
\set SVB '''00000000-0000-4000-8000-000000000003'''
\set U1 '''30000000-0000-4000-8000-000000000001'''
\set R11 '''31000000-0000-4000-8000-000000000011'''
\set R12 '''31000000-0000-4000-8000-000000000012'''
create function pg_temp.ord(p_id text, p_import text default null, p_row text default null)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'awb', 'NVMY' || p_id, 'channel', 'Luxana', 'product', 'cav',
    'package', 'P', 'expected', 4, 'originalExpected', 4, 'actual', null, 'packer', '', 'labelPic', '',
    'printed', false, 'dispatched', false, 'handoverRef', '', 'date', '2026-10-06', 'note', '',
    'reviewState', 'confirmed')
    || case when p_import is null then '{}'::jsonb else jsonb_build_object('importId', p_import) end
    || case when p_row is null then '{}'::jsonb else jsonb_build_object('importRowId', p_row) end $$;
create function pg_temp.orders(p jsonb) returns jsonb language sql as $$ select jsonb_set(pg_temp.state(), '{orders}', p) $$;
-- Runs one statement as p_uid; returns {ok, result} or {ok: false, code, message}.
create function pg_temp.call_as(p_uid uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    execute p_sql into v;
    v := jsonb_build_object('ok', true, 'result', v);
  exception when others then
    v := jsonb_build_object('ok', false, 'code', sqlstate, 'message', sqlerrm);
  end;
  execute 'reset role';
  return v;
end $$;
-- A synthetic upload: p_files PDFs of p_pages pages each, stored under p_ws.
create function pg_temp.imp(p_id text, p_ws text default '10000000-0000-4000-8000-00000000000a',
  p_files integer default 1, p_pages integer default 2) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', 'Synthetic upload', 'date', '2026-10-12',
    'files', (select jsonb_agg(jsonb_build_object('id', h, 'name', 'synthetic.pdf',
      'path', p_ws || '/' || h || '.pdf', 'pages', p_pages, 'size', 1000))
      from (select lpad(to_hex(g), 64, 'a') as h from generate_series(1, p_files) g) x),
    'createdAt', '', 'updatedAt', '') $$;
create function pg_temp.lbl(p_id text, p_awb text, p_excluded boolean default false,
  p_original text default 'raw label text') returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'awb', p_awb, 'orderRef', 'REF-' || p_awb, 'channel', 'Luxana',
    'store', 'Synthetic store', 'courier', 'Ninja Van',
    'lines', '[{"sku":"cave04","product":"cav","packages":1,"units":4,"originalUnits":4,"canonical":"CAV-MY-PK31"}]'::jsonb,
    'sources', jsonb_build_array(jsonb_build_object('file', lpad('1', 64, 'a'), 'page', 1, 'method', 'text')),
    'warnings', '[]'::jsonb, 'reviewed', false,
    'reviewNote', case when p_excluded then 'Not our parcel' else '' end,
    'excluded', p_excluded, 'original', p_original) $$;
create function pg_temp.save_as(p_uid uuid, p_import jsonb, p_rows jsonb, p_expected text default null,
  p_ws uuid default '10000000-0000-4000-8000-00000000000a') returns jsonb language sql as $$
  select pg_temp.call_as(p_uid, format(
    'select public.operator_import_save(%L::uuid, %L::jsonb, %L::jsonb, %L::timestamptz)',
    p_ws, p_import, p_rows, p_expected)) $$;
create function pg_temp.receive_as(p_uid uuid, p_import text, p_pic text default 'SO A') returns jsonb
language sql as $$
  select pg_temp.call_as(p_uid, format(
    'select public.operator_import_receive(%L::uuid, %L::uuid, %L)',
    '10000000-0000-4000-8000-00000000000a', p_import, p_pic)) $$;
create function pg_temp.updated(p_import text) returns text language sql as $$
  select updated_at::text from public.operator_imports where id = p_import::uuid $$;

select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U1),
  jsonb_build_array(pg_temp.lbl(:R11, 'NVMYo1'), pg_temp.lbl(:R12, 'NVMYo2'))),
  'ok', 'admin saves an upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o1', :U1, :R11), pg_temp.ord('o2', :U1, :R12))),
  p_effects => jsonb_build_object('release', :U1)),
  'ok', 'admin releases two AWBs from the upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o3')))),
  'ok', 'admin enters a manual AWB');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o1', :U1, :R11), pg_temp.ord('o2', :U1, :R12)))),
  '42501', 'production SV removes an AWB');
select pg_temp.expect(pg_temp.commit_as(:MGMT, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o1', :U1, :R11), pg_temp.ord('o2', :U1, :R12)))),
  '42501', 'management removes an AWB');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.ord('o1', :U1, :R11), pg_temp.ord('o2', :U1, :R12))),
    '{events}', jsonb_build_array(pg_temp.ev('e-rm3', '00000000-0000-4000-8000-000000000007', 'o3')))),
  'ok', 'admin removes the manual AWB with an audit entry (no upload change)');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.ord('o2', :U1, :R12))), '{batches,0,code}', '"X"')),
  '42501', 'remove-order used to edit batches');
-- (Formerly "dropping audit entries": the document no longer holds them, 20261013090000.)
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  jsonb_set(pg_temp.state(), '{events}', jsonb_build_array(pg_temp.ev('e-rm-forged', :SV, 'o2')))),
  '23514', 'remove-order with an audit entry under another user');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'issue',
  jsonb_set(pg_temp.state(), '{issues}', (pg_temp.state() -> 'issues')
    || '[{"id":"i-o2","cartonId":"c1","orderId":"o2","qty":1,"pic":"SO","at":"t"}]')),
  'ok', 'stock issued to the second AWB');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  jsonb_set(pg_temp.orders(jsonb_build_array(pg_temp.ord('o1', :U1, :R11))), '{issues}',
    (select coalesce(jsonb_agg(i), '[]') from jsonb_array_elements(pg_temp.state() -> 'issues') i where i ->> 'orderId' <> 'o2'))),
  '42501', 'remove-order taking the stock issue with it (issues are outside its scope)');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o2', :U1, :R12)))),
  '23514', 'remove an uploaded AWB without marking its PDF label');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o2', :U1, :R12))),
  p_effects => jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'id', :R12, 'excluded', true, 'reviewNote', 'Removed: Cancelled')))),
  '23514', 'mark the label of an AWB that stays in the list');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  pg_temp.orders(jsonb_build_array(pg_temp.ord('o2', :U1, :R12))),
  p_effects => jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'id', :R11, 'excluded', true, 'reviewNote', 'Removed: Cancelled')))),
  'ok', 'stock-out SV removes an uploaded AWB and marks its label excluded');
do $$ begin
  if (select row(excluded, reviewed, released_order_id, review_note)::text from public.operator_import_rows
      where id = '31000000-0000-4000-8000-000000000011') <> '(t,t,,"Removed: Cancelled")'
    or (select released_order_id from public.operator_import_rows
      where id = '31000000-0000-4000-8000-000000000012') <> 'o2' then
    raise exception 'FAIL: expected the removed AWB''s label excluded and the other still released'; end if;
end $$;
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'import-delete', pg_temp.orders('[]'),
  p_effects => jsonb_build_object('delete', :U1, 'reason', 'Wrong day')),
  '42501', 'stock-out SV deletes an upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-delete', pg_temp.state(),
  p_effects => jsonb_build_object('delete', :U1, 'reason', 'Wrong day')),
  '23514', 'admin deletes an upload while its issued AWB is still listed');
do $$ begin
  if (select state -> 'orders' from public.operator_workspaces where site_id = 'site-a')
      <> jsonb_build_array(pg_temp.ord('o2', '30000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000012'))
    or not exists (select 1 from public.operator_workspaces w, jsonb_array_elements(w.state -> 'issues') i
      where w.site_id = 'site-a' and i ->> 'id' = 'i-o2')
    or (select deleted_at from public.operator_imports where id = '30000000-0000-4000-8000-000000000001') is not null
    or (select state ? 'awbImports' from public.operator_workspaces where site_id = 'site-a') then
    raise exception 'FAIL: expected only the issued AWB left, its stock issue kept and its upload kept'; end if;
end $$;

-- 13. Uploads in tables (20261012090000): saved and received through their own functions,
--     released and deleted only with a signed document command that carries the effect.
\set U2 '''30000000-0000-4000-8000-000000000002'''
\set U3 '''30000000-0000-4000-8000-000000000003'''
\set R21 '''31000000-0000-4000-8000-000000000021'''
\set R22 '''31000000-0000-4000-8000-000000000022'''
\set R23 '''31000000-0000-4000-8000-000000000023'''
\set R31 '''31000000-0000-4000-8000-000000000031'''
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U2), jsonb_build_array(
  pg_temp.lbl(:R21, 'NVMYU21', p_original => 'first read'), pg_temp.lbl(:R22, 'NVMYU22'),
  pg_temp.lbl(:R23, 'NVMYU23', true))), 'ok', 'admin saves an upload with three labels');
do $$ begin
  if (select string_agg(awb, ',' order by position) from public.operator_import_rows
      where import_id = '30000000-0000-4000-8000-000000000002') <> 'NVMYU21,NVMYU22,NVMYU23'
    or (select created_by from public.operator_imports where id = '30000000-0000-4000-8000-000000000002')
      <> '00000000-0000-4000-8000-000000000007' then
    raise exception 'FAIL: expected the rows in review order and the upload attributed to admin'; end if;
end $$;
select pg_temp.expect(pg_temp.save_as(:SO, pg_temp.imp(:U3), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31'))),
  '42501', 'stock-out SV saves an upload');
select pg_temp.expect(pg_temp.save_as(:SV, pg_temp.imp(:U3), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31'))),
  '42501', 'production SV saves an upload');
select pg_temp.expect(pg_temp.save_as(:MGMT, pg_temp.imp(:U3), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31'))),
  '42501', 'management saves an upload');
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied($q$insert into public.operator_imports (id, workspace_id, date) values (gen_random_uuid(), '10000000-0000-4000-8000-00000000000a', '2026-10-12')$q$, 'direct upload insert');
select pg_temp.expect_denied($q$update public.operator_import_rows set excluded = true$q$, 'direct label update');
rollback;
begin;
select pg_temp.as_user(:ADM);
select pg_temp.expect_denied($q$delete from public.operator_import_rows$q$, 'admin deletes labels directly');
rollback;
-- Reading: management (all sites, sources.read) reads site A; site B's supervisor does not.
select pg_temp.expect(pg_temp.call_as(:MGMT, format('select public.operator_import_list(%L)', :A)), 'ok', 'management lists site A uploads');
do $$
declare r jsonb := pg_temp.call_as('00000000-0000-4000-8000-000000000004',
  'select public.operator_import_list(''10000000-0000-4000-8000-00000000000a'')');
begin
  if jsonb_array_length(r -> 'result') <> 2
    or (select x -> 'counts' from jsonb_array_elements(r -> 'result') x where x ->> 'id' = '30000000-0000-4000-8000-000000000001')
      <> '{"rows": 2, "released": 1}' then
    raise exception 'FAIL: management list %', r; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000004',
    'select to_jsonb(count(*)) from public.operator_import_rows where import_id = ''30000000-0000-4000-8000-000000000002''');
  if r -> 'result' <> '3' then raise exception 'FAIL: management reads labels directly %', r; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000009',
    'select public.operator_import_get(''10000000-0000-4000-8000-00000000000a'', ''30000000-0000-4000-8000-000000000002'')');
  if jsonb_array_length(r -> 'result' -> 'rows') <> 3 or r -> 'result' -> 'rows' -> 0 ->> 'original' <> 'first read' then
    raise exception 'FAIL: stock-out opens the upload %', r; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000003',
    'select to_jsonb((select count(*) from public.operator_imports) + (select count(*) from public.operator_import_rows))');
  if r -> 'result' <> '0' then raise exception 'FAIL: site B supervisor reads site A uploads %', r; end if;
end $$;
select pg_temp.expect(pg_temp.call_as(:SVB, format('select public.operator_import_list(%L)', :A)), '42501', 'site B supervisor lists site A uploads');
select pg_temp.expect(pg_temp.call_as(:SVB, format('select public.operator_import_get(%L, %L)', :A, :U2)), '42501', 'site B supervisor opens a site A upload');
-- Limits and file paths.
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3, :B), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31'))),
  '23514', 'upload with a PDF stored under another site');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3, p_files => 11, p_pages => 1), '[]'),
  '23514', 'eleven PDFs in one upload');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3, p_files => 2, p_pages => 1251), '[]'),
  '23514', '2,502 pages in one upload');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3, p_files => 10, p_pages => 250),
  (select jsonb_agg(pg_temp.lbl(gen_random_uuid()::text, 'NVMYBIG' || g)) from generate_series(1, 1201) g)),
  '23514', '1,201 labels in one upload');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3, p_files => 10, p_pages => 250),
  (select jsonb_agg(pg_temp.lbl(gen_random_uuid()::text, 'NVMYBIG' || g)) from generate_series(1, 1200) g)),
  'ok', '1,200 labels on 2,500 pages in ten PDFs');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31')),
  pg_temp.updated(:U3)), 'ok', 'admin replaces the large draft with one label');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp('30000000-0000-4000-8000-000000000004'),
  jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31'))), '23514', 'label identifier reused from another upload');
-- Optimistic check: a stale review is refused; the current one replaces the rows but keeps
-- each existing label's first-read text.
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U2), jsonb_build_array(pg_temp.lbl(:R21, 'NVMYU21')),
  '2026-01-01T00:00:00Z'), '40001', 'stale review');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp('30000000-0000-4000-8000-000000000005'),
  jsonb_build_array(pg_temp.lbl(gen_random_uuid()::text, 'NVMYU51')), '2026-01-01T00:00:00Z'),
  '40001', 'review of an upload that was never saved');
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U2), jsonb_build_array(
  pg_temp.lbl(:R21, 'NVMYU21', p_original => 'tampered'), pg_temp.lbl(:R22, 'NVMYU22'),
  pg_temp.lbl(:R23, 'NVMYU23', true)), pg_temp.updated(:U2)), 'ok', 'current review saved');
do $$ begin
  if (select original from public.operator_import_rows where id = '31000000-0000-4000-8000-000000000021') <> 'first read' then
    raise exception 'FAIL: the first-read label text was replaced'; end if;
end $$;
-- Release: only with import-release, signed with the effects line, onto its own labels.
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o21', :U2, :R21)))),
  'ok', 'a manual entry with an upload reference and no effect changes no upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o22', :U2, :R22))),
  p_effects => jsonb_build_object('release', :U2)), '42501', 'release effects under another command');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o22', :U2, :R22))),
  p_effects => jsonb_build_object('release', :U2), p_v1 => true), '42501', 'signature without the effects line');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'order',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o21b'))), p_v1 => true),
  'ok', 'v1 signature still accepted without effects (rollout window)');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o22', :U2, :R22)))),
  '23514', 'release without its upload effect');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o22', :U2, :R22), pg_temp.ord('o23', :U2, :R23))),
  p_effects => jsonb_build_object('release', :U2)), '23514', 'release of an excluded label');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o22', :U2, :R22), pg_temp.ord('o24', :U2, :R22))),
  p_effects => jsonb_build_object('release', :U2)), '23514', 'two AWBs released from one label');
select pg_temp.expect(pg_temp.receive_as(:SO, :U2), '23514', 'stock-out receives an unconfirmed upload');
-- o21 was entered by hand with this upload's reference above; release the second label only.
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release',
  pg_temp.orders((select coalesce(jsonb_agg(o), '[]') from jsonb_array_elements(pg_temp.state() -> 'orders') o where o ->> 'id' <> 'o21')
    || jsonb_build_array(pg_temp.ord('o22', :U2, :R22))),
  p_effects => jsonb_build_object('release', :U2)), 'ok', 'admin releases the upload');
do $$ begin
  if (select string_agg(coalesce(released_order_id, '-'), ',' order by position) from public.operator_import_rows
      where import_id = '30000000-0000-4000-8000-000000000002') <> '-,o22,-'
    or (select confirmed_at from public.operator_imports where id = '30000000-0000-4000-8000-000000000002') is null then
    raise exception 'FAIL: expected o22 released from the second label and the upload confirmed'; end if;
end $$;
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U2), jsonb_build_array(pg_temp.lbl(:R21, 'NVMYU21')),
  pg_temp.updated(:U2)), '23514', 'a confirmed upload cannot be saved again');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-release', pg_temp.state(),
  p_effects => jsonb_build_object('release', :U2)), '23514', 'second release of the same upload');
-- Receive: stock-out, once, only after confirmation.
select pg_temp.expect(pg_temp.receive_as(:ADM, :U2), '42501', 'admin acknowledges receipt');
select pg_temp.expect(pg_temp.receive_as(:SO, :U2, ' '), '22023', 'receipt without a PIC');
select pg_temp.expect(pg_temp.receive_as(:SO, :U2), 'ok', 'stock-out acknowledges receipt');
select pg_temp.expect(pg_temp.receive_as(:SO, :U2), '23514', 'second acknowledgement');
do $$ begin
  if (select received_by || ':' || received_user from public.operator_imports where id = '30000000-0000-4000-8000-000000000002')
    <> 'SO A:00000000-0000-4000-8000-000000000009' then
    raise exception 'FAIL: receipt not recorded for stock-out'; end if;
end $$;
-- Row effects need a confirmed upload; delete effects soft-delete and hide the upload.
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'order',
  pg_temp.orders((pg_temp.state() -> 'orders') || jsonb_build_array(pg_temp.ord('o4')))),
  'ok', 'stock-out enters a manual AWB');
select pg_temp.expect(pg_temp.commit_as(:SO, :A, 'remove-order',
  pg_temp.orders((select coalesce(jsonb_agg(o), '[]') from jsonb_array_elements(pg_temp.state() -> 'orders') o where o ->> 'id' <> 'o4')),
  p_effects => jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
    'id', :R31, 'excluded', true, 'reviewNote', 'Removed: x')))),
  '23514', 'row effects on a draft upload');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'remove-order',
  pg_temp.orders((select coalesce(jsonb_agg(o), '[]') from jsonb_array_elements(pg_temp.state() -> 'orders') o where o ->> 'id' <> 'o4')),
  p_effects => jsonb_build_object('delete', :U3, 'reason', 'Duplicate')),
  '42501', 'delete effects under another command');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-delete', pg_temp.state(),
  p_effects => jsonb_build_object('delete', :U3, 'reason', ' ')), '22023', 'delete without a reason');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-delete', pg_temp.state(),
  p_effects => jsonb_build_object('delete', :U3, 'reason', 'Duplicate upload')), 'ok', 'admin deletes a draft upload');
do $$
declare r jsonb;
begin
  if (select deleted_reason from public.operator_imports where id = '30000000-0000-4000-8000-000000000003') <> 'Duplicate upload' then
    raise exception 'FAIL: upload not soft-deleted'; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000007',
    'select public.operator_import_get(''10000000-0000-4000-8000-00000000000a'', ''30000000-0000-4000-8000-000000000003'')');
  if r -> 'result' <> 'null' then raise exception 'FAIL: deleted upload still opens %', r; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000007',
    'select to_jsonb(count(*)) from public.operator_import_rows where import_id = ''30000000-0000-4000-8000-000000000003''');
  if r -> 'result' <> '0' then raise exception 'FAIL: deleted upload labels still readable %', r; end if;
  r := pg_temp.call_as('00000000-0000-4000-8000-000000000007',
    'select public.operator_import_list(''10000000-0000-4000-8000-00000000000a'')');
  if exists (select 1 from jsonb_array_elements(r -> 'result') x where x ->> 'id' = '30000000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: deleted upload still listed'; end if;
end $$;
select pg_temp.expect(pg_temp.save_as(:ADM, pg_temp.imp(:U3), jsonb_build_array(pg_temp.lbl(:R31, 'NVMYU31')),
  pg_temp.updated(:U3)), '23514', 'a deleted upload cannot be saved again');
select pg_temp.expect(pg_temp.commit_as(:ADM, :A, 'import-delete', pg_temp.state(),
  p_effects => jsonb_build_object('delete', :U3, 'reason', 'Again')), '23514', 'second delete');
do $$ begin
  if exists (select 1 from public.operator_command_rules where command in ('import-save', 'import-receive'))
    or exists (select 1 from public.operator_command_rules
      where command in ('import-release', 'import-delete', 'remove-order') and state_keys <> '{orders,events}') then
    raise exception 'FAIL: upload command rules'; end if;
end $$;

-- 14. Audit entries in operator_events (20261013090000): appended by the commit RPC from the
--     submitted entries, attributed to the caller, readable by the site's members only,
--     never written directly, never duplicated by a retried save.
do $$ begin
  -- The backfill moved site A's seeded entry as recorded.
  if (select string_agg(command || ':' || entity || ':' || (recorder ->> 'userId'), ',')
      from public.operator_events where workspace_id = '10000000-0000-4000-8000-00000000000a' and detail = 'orig')
    <> 'backfill:b1:00000000-0000-4000-8000-000000000001'
    or (select id from public.operator_events where detail = 'orig')
      <> operator_private.legacy_uuid('e1', 'event/10000000-0000-4000-8000-00000000000a') then
    raise exception 'FAIL: the seeded entry was not backfilled as recorded'; end if;
  -- Commits stored their entries, attributed to the caller, and the documents no longer hold any.
  if (select command || ':' || operation_id || ':' || (recorder ->> 'userId') from public.operator_events
      where id = pg_temp.ev_id('e2'))
    <> 'machine:20000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000001' then
    raise exception 'FAIL: the Hologram entry was not appended by its commit'; end if;
  if (select command || ':' || entity || ':' || (recorder ->> 'userId') from public.operator_events
      where id = pg_temp.ev_id('e-pack'))
    <> 'pack-own:o-pack:00000000-0000-4000-8000-000000000002' then
    raise exception 'FAIL: the packer''s own count entry does not carry the packer recorder'; end if;
  -- Committed documents keep an empty list (read by servers and tabs from before the change).
  if exists (select 1 from public.operator_workspaces where state -> 'events' <> '[]'::jsonb
      and site_id in ('site-a', 'site-b', 'site-w')) then
    raise exception 'FAIL: a committed document still holds audit entries'; end if;
end $$;
-- Reading: every active member of the site (packers included) reads its entries; another
-- site's supervisor, an outsider and anonymous callers read none.
do $$
declare
  v_all text := (select count(*)::text from public.operator_events
    where workspace_id = '10000000-0000-4000-8000-00000000000a');
  q text := 'select to_jsonb(count(*)) from public.operator_events where workspace_id = ''10000000-0000-4000-8000-00000000000a''';
  r jsonb;
begin
  if v_all::int < 5 then raise exception 'FAIL: expected at least 5 site A entries, got %', v_all; end if;
  foreach r in array array[
    pg_temp.call_as('00000000-0000-4000-8000-000000000001', q),  -- production SV
    pg_temp.call_as('00000000-0000-4000-8000-000000000002', q),  -- packer
    pg_temp.call_as('00000000-0000-4000-8000-000000000004', q)]  -- all-sites management
  loop
    if r -> 'result' <> to_jsonb(v_all::int) then raise exception 'FAIL: member reads % of % entries', r, v_all; end if;
  end loop;
  foreach r in array array[
    pg_temp.call_as('00000000-0000-4000-8000-000000000003', 'select to_jsonb(count(*)) from public.operator_events'),
    pg_temp.call_as('00000000-0000-4000-8000-000000000011', 'select to_jsonb(count(*)) from public.operator_events'),
    pg_temp.call_as('00000000-0000-4000-8000-000000000005', q)]  -- revoked SV
  loop
    if r -> 'result' <> '0' then raise exception 'FAIL: non-member reads entries %', r; end if;
  end loop;
  r := pg_temp.call_as(null, 'select to_jsonb(count(*)) from public.operator_events');
  if r ->> 'code' is distinct from '42501' then raise exception 'FAIL: anonymous read %', r; end if;
end $$;
-- Writing: nobody inserts, changes or deletes entries directly, not even the site's admin.
begin;
select pg_temp.as_user(:SV);
select pg_temp.expect_denied(format($q$insert into public.operator_events (id, workspace_id, entity, action, detail, actor, at, recorder, command, operation_id) values (gen_random_uuid(), %s, 'b1', 'x', 'x', 'x', now(), '{"userId": "00000000-0000-4000-8000-000000000001"}', 'batch', gen_random_uuid())$q$, :'A'), 'direct audit insert');
select pg_temp.expect_denied($q$update public.operator_events set detail = 'rewritten'$q$, 'direct audit update');
select pg_temp.expect_denied($q$delete from public.operator_events$q$, 'direct audit delete');
select pg_temp.expect_denied(format('select operator_private.append_events(%s, %L, %s, %L, gen_random_uuid())', :'A', jsonb_build_array(pg_temp.ev('e-direct', '00000000-0000-4000-8000-000000000001')), :'SV', 'batch'), 'calling the appender directly');
rollback;
begin;
select pg_temp.as_user(:ADM);
select pg_temp.expect_denied($q$delete from public.operator_events$q$, 'admin deletes audit entries');
rollback;
-- Order: the app stores newest first; the table numbers them oldest first.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-newer', :SV), pg_temp.ev('e-older', :SV)))), 'ok', 'two entries in one commit');
do $$ begin
  if (select seq from public.operator_events where id = pg_temp.ev_id('e-older'))
    >= (select seq from public.operator_events where id = pg_temp.ev_id('e-newer')) then
    raise exception 'FAIL: seq order is not chronological'; end if;
end $$;
-- A retried or rebased save that carries the same entry adds nothing; a changed copy is refused.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-newer', :SV), pg_temp.ev('e-retry', :SV)))), 'ok', 'rebased save repeating an entry');
do $$ begin
  if (select count(*) from public.operator_events where id = pg_temp.ev_id('e-newer')) <> 1
    or (select count(*) from public.operator_events where id = pg_temp.ev_id('e-retry')) <> 1 then
    raise exception 'FAIL: a repeated entry was stored twice or the new one is missing'; end if;
  if operator_private.append_events('10000000-0000-4000-8000-00000000000a',
      jsonb_build_array(pg_temp.ev('e-retry', '00000000-0000-4000-8000-000000000001'),
        pg_temp.ev('e-fresh', '00000000-0000-4000-8000-000000000001')),
      '00000000-0000-4000-8000-000000000001', 'batch', gen_random_uuid()) <> 1 then
    raise exception 'FAIL: the appender should report one new entry'; end if;
end $$;
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-newer', :SV) || '{"detail": "changed"}'))), '23514', 'changed copy of a stored entry');
select pg_temp.expect(pg_temp.commit_as(:SVB, :B, 'batch', jsonb_set(pg_temp.state(:B), '{events}',
  jsonb_build_array(pg_temp.ev('e-newer', :SV)))), '23514', 'site A entry claimed at site B');
-- Shape, scope and size.
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-bad-time', :SV) || '{"at": "t"}'))), '22023', 'entry without a valid time');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-bad-id', :SV) || '{"id": "e1"}'))), '22023', 'entry without a UUID');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-dup', :SV), pg_temp.ev('e-dup', :SV)))), '23514', 'duplicate entry identifiers');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  (select jsonb_agg(pg_temp.ev('e-many-' || g, '00000000-0000-4000-8000-000000000001')) from generate_series(1, 2001) g))),
  '23514', '2,001 entries in one change');
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000002', :A, 'feedback',
  jsonb_set(pg_temp.state(), '{events}', jsonb_build_array(pg_temp.ev('e-feedback', '00000000-0000-4000-8000-000000000002')))),
  '42501', 'feedback adding audit entries (outside its scope)');
select pg_temp.expect(pg_temp.commit_as(:SV, :A, 'batch', jsonb_set(pg_temp.state(), '{events}',
  jsonb_build_array(pg_temp.ev('e-rev', :SV))), p_rev => 0), 'conflict', 'stale revision appends nothing');
do $$ begin
  if exists (select 1 from public.operator_events where id in (pg_temp.ev_id('e-bad-time'),
      pg_temp.ev_id('e-dup'), pg_temp.ev_id('e-many-1'), pg_temp.ev_id('e-feedback'), pg_temp.ev_id('e-rev'))) then
    raise exception 'FAIL: a refused change left an audit entry'; end if;
end $$;
-- A document that still holds entries (written before 20261013090000) hands them over, as
-- recorded, on its next commit.
update public.operator_workspaces set state = state || jsonb_build_object('events', jsonb_build_array(
  jsonb_build_object('id', 'legacy-b', 'entity', 'workspace', 'action', 'Old entry', 'detail', 'kept',
    'actor', 'Someone', 'at', '2026-10-01T00:00:00.000Z')))
where site_id = 'site-b';
select pg_temp.expect(pg_temp.commit_as('00000000-0000-4000-8000-000000000004', :B, 'review',
  jsonb_set(jsonb_set(pg_temp.state(:B), '{notes}', (pg_temp.state(:B) -> 'notes')
    || '[{"id":"n14","kind":"review","text":"Check","author":{"userId":"00000000-0000-4000-8000-000000000004"}}]'),
    '{events}', jsonb_build_array(pg_temp.ev('e-review-b', '00000000-0000-4000-8000-000000000004', 'n14')))),
  'ok', 'commit at a site whose document still holds an entry');
do $$ begin
  if (select string_agg(command || ':' || detail, ',' order by seq) from public.operator_events
      where workspace_id = '10000000-0000-4000-8000-00000000000b') <> 'backfill:kept,review:test'
    or (select state -> 'events' from public.operator_workspaces where site_id = 'site-b') <> '[]'::jsonb then
    raise exception 'FAIL: the document''s entry was not handed over before the review entry'; end if;
end $$;

select 'operator access tests passed' as result;
