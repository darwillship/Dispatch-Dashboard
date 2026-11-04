-- v4.10.1 scenario for SUPABASE-V4101-NESTED-ROUTES.sql (run from the repo root against a scratch Postgres: psql -f tests/nested-routes-scenario.sql).
-- Expected: #310 stays in_progress after #307, completes 12:44:43 PM CT after #309; outer #312 untouched.
create table public.dispatch_tasks (id bigint primary key, status text, is_route boolean default false, combined_into_task_id bigint, completed_at timestamptz, status_source text, status_auto_at timestamptz);
\i SUPABASE-V4101-NESTED-ROUTES.sql
\i SUPABASE-V4101-NESTED-ROUTES.sql
insert into public.dispatch_tasks values (312,'in_progress',true,null,null,'manual',null),(310,'in_progress',true,312,null,'manual',null),
 (307,'in_progress',false,310,null,null,null),(309,'in_progress',false,310,null,null,null),(311,'in_progress',false,312,null,null,null);
update public.dispatch_tasks set status='completed', completed_at='2026-11-04 18:44:43+00', status_source='auto_gps' where id=307;
select id,status from public.dispatch_tasks where id=310;  -- still in_progress
update public.dispatch_tasks set status='completed', completed_at='2026-11-04 18:44:43+00', status_source='auto_gps' where id=309;
select id,status,completed_at,status_source from public.dispatch_tasks where id in (310,312) order by id;  -- 310 completed, 312 untouched
update public.dispatch_tasks set status='completed' where id=311;
select id,status from public.dispatch_tasks where id=312; -- outer route untouched (no combined_into)
