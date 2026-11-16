-- Rollback for 20261116090000_operator_usage.sql: removes the usage report, the usage log
-- and its table. The screen-view and refused-save counters are deleted with the table;
-- export public.operator_usage_daily first if they are still wanted. Saved actions stay in
-- public.operator_commits. Deploy the application without /api/usage calls first, or
-- they fail quietly (the screens do not depend on them).

drop function if exists public.operator_usage_report(uuid, date);
drop function if exists public.operator_log_usage(uuid, text, text, text);
drop function if exists operator_private.usage_view(text);
drop table if exists public.operator_usage_daily;
