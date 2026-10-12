-- Manual rollback for 20261014090000_operator_order_records.sql. Not run by the CLI.
-- Run before 20261013090000_operator_events.down.sql. Confirm the selected project first.
-- Deploy the previous application build together with it if C2 or later has shipped: the
-- earlier build keeps orders, stock issues and sort counts in the workspace document.
-- Every site in tables mode is moved back with operator_private.move_orders_to_document
-- (orders, issues and sort counts in today's document shapes, newest first, carton
-- balances checked). If any site refuses (more than 1,000 AWBs or 2,000 issues, a document
-- over 1.8 MB, or archived issue rows), the whole rollback aborts and nothing changes:
-- export or trim first.
-- NOT restored: row versions, created_by / updated_by attribution, the recorder and
-- operation of each issue and sort count, the database's demand hashes (only the latest
-- current count per day and product gets a matching document fingerprint), the departures
-- feed, handover times (kept in the document as dispatchedAt), and the commit rows of
-- records-only operations (deleted: their changes were just moved into the documents and
-- their audit entries stay in operator_events, but a retry of such an operation is no
-- longer recognized as a replay).
begin;
do $$
begin
  perform operator_private.move_orders_to_document(w.id)
  from public.operator_workspaces w where w.order_store = 'tables';
end
$$;

-- Restore the commit function of 20261013090000_operator_events.sql (same signature, so
-- its grants are kept), with its comment.
create or replace function public.operator_commit_workspace(
  p_workspace uuid,
  p_expected_revision integer,
  p_command text,
  p_operation uuid,
  p_fingerprint text,
  p_state text,
  p_attestation text,
  p_import_effects text default null -- import effects
)
returns table (new_state jsonb, new_revision integer, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_factory text; -- factory scope
  v_rule public.operator_command_rules%rowtype;
  v_current public.operator_workspaces%rowtype;
  v_prior public.operator_commits%rowtype;
  v_secret bytea;
  v_message text;
  v_message_v1 text; -- accepted without effects during the rollout
  v_new jsonb;
  v_old jsonb; -- audit entries: the stored document without events
  v_stored jsonb; -- audit entries: what is stored, with an empty events list
  v_events jsonb; -- audit entries: the command's new entries
  v_effects jsonb; -- import effects
begin
  if v_uid is null then
    raise exception 'Sign in again before saving.' using errcode = '28000';
  end if;
  select * into v_current from public.operator_workspaces w where w.id = p_workspace for update;
  -- factory scope: role and factory are read in one statement, so from the same snapshot.
  select public.operator_active_role(p_workspace), operator_private.active_factory(p_workspace)
  into v_role, v_factory;
  if v_current.id is null or v_role is null then
    raise exception 'No active membership for this site.' using errcode = '42501';
  end if;
  -- A retried operation returns its established result without repeating effects.
  select * into v_prior from public.operator_commits c
  where c.workspace_id = p_workspace and c.operation_id = p_operation;
  if found then
    if v_prior.user_id is distinct from v_uid or v_prior.command is distinct from p_command
      or v_prior.fingerprint is distinct from p_fingerprint then
      raise exception 'This save ID was already used for a different change.' using errcode = 'PT409';
    end if;
    return query select (v_current.state - 'events') || '{"events": []}'::jsonb,
      v_current.revision, true;
    return;
  end if;
  select * into v_rule from public.operator_command_rules r where r.command = p_command;
  if not found then
    raise exception 'Unknown operational command.' using errcode = '42501';
  end if;
  if public.operator_has_capability(p_workspace, v_rule.capability) is not true then
    raise exception 'Your role at this site does not permit %.', v_rule.capability using errcode = '42501';
  end if;
  select k.secret into v_secret from operator_private.server_keys k where k.id = 'commit';
  if v_secret is null then
    raise exception 'Operational saving is not configured.' using errcode = '55000';
  end if;
  if (p_fingerprint ~ '^[0-9a-f]{64}$') is not true or p_operation is null
    or p_expected_revision is null or p_state is null then
    raise exception 'Invalid operation.' using errcode = '22023';
  end if;
  -- import effects: v2 message, with the exact effects text as its last line. A commit
  -- without effects is also accepted under the previous v1 message, so applying this
  -- migration and deploying the server that signs v2 need not happen in the same minute;
  -- effects are only ever accepted under v2.
  v_message := concat_ws(E'\n', 'operator-commit-v2', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to(coalesce(p_import_effects, ''), 'UTF8'), 'sha256'), 'hex'));
  v_message_v1 := concat_ws(E'\n', 'operator-commit-v1', p_workspace::text,
    p_expected_revision::text, v_uid::text, p_operation::text, p_command, p_fingerprint,
    encode(extensions.digest(convert_to(coalesce(p_state, ''), 'UTF8'), 'sha256'), 'hex'));
  if (lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message, 'UTF8'), v_secret, 'sha256'), 'hex')
    or (p_import_effects is null and lower(p_attestation) =
      encode(extensions.hmac(convert_to(v_message_v1, 'UTF8'), v_secret, 'sha256'), 'hex'))) is not true then
    raise exception 'This change was not validated by the Operator server.' using errcode = '42501';
  end if;
  begin
    v_new := p_state::jsonb;
    v_effects := p_import_effects::jsonb; -- import effects
  exception when others then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end;
  if (jsonb_typeof(v_new) = 'object') is not true then
    raise exception 'Invalid workspace state.' using errcode = '22023';
  end if;
  -- audit entries: the submitted `events` are this command's new entries. They leave the
  -- document and go to operator_events; both documents are compared without them.
  v_events := coalesce(v_new -> 'events', '[]'::jsonb);
  v_new := v_new - 'events';
  v_old := v_current.state - 'events';
  if v_events <> '[]'::jsonb and not ('events' = any (v_rule.state_keys)) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  if (v_new - v_rule.state_keys) is distinct from (v_old - v_rule.state_keys) then
    raise exception 'This change is outside the % command scope.', p_command using errcode = '42501';
  end if;
  perform operator_private.assert_factory_scope(v_old, v_new, v_factory); -- factory scope
  perform operator_private.assert_transition(v_old, v_new, v_uid);
  if v_current.revision is distinct from p_expected_revision then
    return;
  end if;
  v_stored := v_new || '{"events": []}'::jsonb; -- audit entries
  update public.operator_workspaces w
  set state = v_stored, revision = w.revision + 1, updated_at = now()
  where w.id = p_workspace;
  insert into public.operator_commits (workspace_id, operation_id, user_id, role, command,
    fingerprint, result_revision)
  values (p_workspace, p_operation, v_uid, v_role, p_command, p_fingerprint,
    v_current.revision + 1);
  -- audit entries: a document still holding entries (written before 20261013090000) hands
  -- them over as recorded; then the command's own entries, attributed to the caller.
  if jsonb_typeof(v_current.state -> 'events') = 'array'
    and v_current.state -> 'events' <> '[]'::jsonb then
    perform operator_private.backfill_events(p_workspace, v_current.state -> 'events');
  end if;
  perform operator_private.append_events(p_workspace, v_events, v_uid, p_command, p_operation);
  -- import effects: applied with the document update or not at all.
  perform operator_private.apply_import_effects(p_workspace, p_command, v_old, v_new,
    v_effects, v_uid);
  return query select v_stored, v_current.revision + 1, false;
end
$$;
comment on function public.operator_commit_workspace(uuid, integer, text, uuid, text, text, text, text) is
  'Commits a server-validated, signed transition for the signed-in member, with its upload effects; its audit entries go to operator_events. See 20261005090000, 20261012090000 and 20261013090000.';

drop function public.operator_commit_records(uuid, text, uuid, text, text, text, text);
drop function public.operator_orders_page(uuid, date, text, text, text, text, jsonb, text, integer);
drop function public.operator_orders_day(uuid, date);
drop function public.operator_orders_summary(uuid, date, boolean);
drop function public.operator_orders_trace(uuid, text, uuid, text, date, text);
drop function public.operator_orders_export(uuid, date, date, date, text);
drop function public.operator_packer_page(uuid, date);
drop function public.operator_packer_counts(uuid, date);
drop function operator_private.move_orders_to_tables(uuid);
drop function operator_private.move_orders_to_document(uuid);
drop function operator_private.legacy_order_problem(jsonb, uuid);
drop function operator_private.assert_order_family(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_order(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_edit_order(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_review_order(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_remove_order(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_split_order(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_assign(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_print(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_move_orders(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_pack(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_correct(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_dispatch(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_import_release(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_import_delete(uuid, text, jsonb, jsonb, uuid, text, jsonb);
drop function operator_private.assert_issue(uuid, text, jsonb, jsonb);
drop function operator_private.apply_issues(uuid, text, jsonb, uuid, uuid);
drop function operator_private.assert_sort_count(uuid, jsonb);
drop function operator_private.apply_sort_counts(uuid, jsonb, uuid, uuid);
drop function operator_private.apply_orders(uuid, text, jsonb, jsonb, jsonb, uuid);
drop function operator_private.assert_awb_reuse(uuid, uuid[]);
drop function operator_private.awb_reuse_allowed(public.operator_orders, public.operator_orders);
drop function operator_private.order_status_match(public.operator_orders, text);
drop function operator_private.order_issued(uuid, uuid);
drop function operator_private.assert_order_reader(uuid);
drop function operator_private.order_json(public.operator_orders);
drop function operator_private.day_marker(uuid, date);
drop function operator_private.table_balances(uuid);
drop function operator_private.carton_balance(uuid, text);
drop function operator_private.document_balances(jsonb);
drop function operator_private.document_fingerprint(uuid, date, text);
drop function operator_private.sort_count_current(uuid, date, text);
drop function operator_private.day_demand(uuid, date, text);
drop table public.operator_issues, public.operator_carton_issued, public.operator_sort_counts,
  public.operator_order_departures, public.operator_orders, public.operator_record_rules;
drop function operator_private.issues_append_only();
drop function operator_private.packer_session();
drop function operator_private.packer_session_profile(uuid, text);
drop function operator_private.order_reader_workspaces();
drop function operator_private.order_lines_valid(jsonb, text, integer, integer);
drop function operator_private.order_products(text, jsonb);
drop function operator_private.product_unit(text);
drop function operator_private.json_whole(jsonb, numeric, numeric);
drop function operator_private.try_date(text);

delete from public.operator_commits where result_revision is null;
alter table public.operator_commits drop constraint operator_commits_result;
alter table public.operator_commits drop column result;
alter table public.operator_commits alter column result_revision set not null;
alter table public.operator_workspaces drop column order_store;
commit;
