-- SHIFT Dispatch v4.10.0 — sign-in + RLS tightening. DRAFT. NOT APPLIED.
-- Apply only after: (1) Jonathan's own auth user exists and is added to dispatch_staff, (2) driver.html v4.10.0
-- (RPC-based) is live and drivers have reloaded, (3) the Driver Time Sheet app is switched to the same RPCs (phase 2).
-- Backup of the policies this replaces: /workspace/dispatch_review/rls_backup.sql (taken 2026-10-31).
-- No data rows are changed by this file.

begin;

-- 1) Dispatcher allowlist (an authenticated user is NOT enough: overs-team@ and any self-signup are also "authenticated").
create table if not exists public.dispatch_staff(
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text, created_at timestamptz not null default now());
alter table public.dispatch_staff enable row level security;
revoke all on public.dispatch_staff from anon, authenticated;
grant select on public.dispatch_staff to authenticated;
create policy dispatch_staff_self on public.dispatch_staff for select to authenticated using (user_id = auth.uid());

create or replace function public.is_dispatcher() returns boolean
language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.dispatch_staff where user_id = auth.uid()) $$;
revoke all on function public.is_dispatcher() from public, anon;
grant execute on function public.is_dispatcher() to authenticated;

-- 2) Dispatcher tables: drop the "public testing" policies, revoke anon, allow dispatchers only.
do $$
declare t text; p record;
begin
  foreach t in array array['dispatch_tasks','dispatch_task_stops','driver_schedule','driver_weekly_schedule','drivers',
    'messengers','named_places','saved_locations','shift_notes','shift_reminders','task_activity','truck_schedules',
    'truck_switches','unplanned_stops','vehicle_assignment_suggestions','vehicle_live_location','vehicle_name_map',
    'vehicle_status','vehicle_stop_events','vehicles','pretrip_task_moves','geocode_cache','vzc_sync_runs',
    'driver_live_status','driver_shifts','driver_activities','driver_pretrips']
  loop
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, trigger, references on public.%I from authenticated', t);
    execute format('create policy dispatcher_read on public.%I for select to authenticated using (public.is_dispatcher())', t);
  end loop;
  -- dispatcher writes (same tables the dashboard writes today)
  foreach t in array array['dispatch_tasks','dispatch_task_stops','driver_schedule','driver_weekly_schedule','messengers',
    'named_places','saved_locations','shift_notes','shift_reminders','task_activity','truck_schedules','truck_switches',
    'vehicle_status']
  loop
    execute format('create policy dispatcher_write on public.%I for all to authenticated using (public.is_dispatcher()) with check (public.is_dispatcher())', t);
  end loop;
  foreach t in array array['drivers','unplanned_stops','vehicle_assignment_suggestions'] loop
    execute format('create policy dispatcher_update on public.%I for update to authenticated using (public.is_dispatcher()) with check (public.is_dispatcher())', t);
  end loop;
end $$;
-- driver_pretrips stays immutable: no update/delete policy for anyone; existing guard triggers stay.
revoke update, delete on public.driver_pretrips from anon, authenticated;
revoke all on public.dispatch_route_stops_v, public.driver_daily_vehicle from anon;  -- security_invoker views

-- 3) Driver page / time sheet: narrow SECURITY DEFINER RPCs instead of open tables.
-- NOTE: drivers are not signed in, so a driver id is the only "identity". These RPCs limit what can be done
-- (own assigned stops, status only) but anyone with the link can still act as a driver id.
create or replace function public.driver_app_drivers() returns table(id bigint, name text, active boolean)
language sql stable security definer set search_path = public as
$$ select d.id, d.name, d.active from public.drivers d order by d.name $$;

create or replace function public.driver_app_tasks(p_driver_id bigint) returns setof public.dispatch_tasks
language sql stable security definer set search_path = public as
$$ select * from public.dispatch_tasks t where t.assigned_driver_id = p_driver_id
   and (t.status <> 'completed' or coalesce(t.work_date,(t.scheduled_at at time zone 'America/Chicago')::date) >= current_date - 7)
   order by t.sort_order $$;

create or replace function public.driver_app_schedule(p_driver_id bigint, p_day date) returns json
language sql stable security definer set search_path = public as
$$ select json_build_object(
     'daily',(select coalesce(json_agg(s),'[]') from public.driver_schedule s where s.driver_id=p_driver_id and s.work_date=p_day),
     'weekly',(select coalesce(json_agg(w),'[]') from public.driver_weekly_schedule w where w.driver_id=p_driver_id)) $$;

create or replace function public.driver_app_set_status(p_task_id bigint, p_driver_id bigint, p_status text) returns boolean
language plpgsql security definer set search_path = public as
$$ begin
  if p_status not in ('assigned','in_progress','completed') then raise exception 'bad status'; end if;
  update public.dispatch_tasks set status=p_status,
    completed_at = case when p_status='completed' then now() else null end
   where id=p_task_id and assigned_driver_id=p_driver_id;
  return found;
end $$;

create or replace function public.driver_app_flag(p_task_id bigint, p_driver_id bigint, p_kind text, p_reason text) returns void
language plpgsql security definer set search_path = public as
$$ declare t public.dispatch_tasks; dn text; begin
  if p_kind not in ('missed','refused') then raise exception 'bad kind'; end if;
  select * into t from public.dispatch_tasks where id=p_task_id and assigned_driver_id=p_driver_id;
  if not found then raise exception 'not your stop'; end if;
  select name into dn from public.drivers where id=p_driver_id;
  insert into public.shift_reminders(note,priority,due_at,completed)
  values (left(format('🚨 [SHIFT-DRIVER task:%s %s] %s reported %s: %s → %s%s', t.id, p_kind, dn, upper(p_kind),
          t.pickup_name, t.delivery_name, case when nullif(trim(p_reason),'') is not null then ' — '||trim(p_reason) else '' end),480),
          'high', now(), false);
end $$;

-- Time sheet app (phase 2, needs its code changed to call these instead of tables):
--   driver_app_vehicles() -> id,name,active,status,note ; driver_app_live(p_row jsonb) upsert driver_live_status ;
--   driver_app_submit(p_table text, p_row jsonb) -> insert-only for driver_pretrips (immutable), upsert for driver_shifts/driver_activities
--   restricted to the row's own driver_id. Until phase 2 ships, the three time-sheet tables would need anon insert/update/select
--   kept (as today) or the time sheet breaks.

revoke all on function public.driver_app_drivers(), public.driver_app_tasks(bigint), public.driver_app_schedule(bigint,date),
  public.driver_app_set_status(bigint,bigint,text), public.driver_app_flag(bigint,bigint,text,text) from public;
grant execute on function public.driver_app_drivers(), public.driver_app_tasks(bigint), public.driver_app_schedule(bigint,date),
  public.driver_app_set_status(bigint,bigint,text), public.driver_app_flag(bigint,bigint,text,text) to anon, authenticated;

-- Existing RPCs: driver_truck_events is SECURITY INVOKER, so it follows the new policies (dispatchers only).
-- rls_auto_enable() and pretrip_move_tasks() are SECURITY DEFINER and executable by anon today: revoke from anon.
revoke execute on function public.rls_auto_enable() from public, anon;
-- (pretrip_move_tasks is a trigger function; check before revoking.)

commit;
