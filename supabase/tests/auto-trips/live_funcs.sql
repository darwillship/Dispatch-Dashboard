CREATE OR REPLACE FUNCTION public.dispatch_task_stops_route_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_last timestamptz;
begin
  if new.status = 'done'
     and not exists (select 1 from public.dispatch_task_stops s where s.task_id = new.task_id and s.status <> 'done') then
    select s.gps_arrived_at into v_last from public.dispatch_task_stops s
      where s.task_id = new.task_id order by s.seq desc, s.id desc limit 1;
    update public.dispatch_tasks t
       set status = 'completed', completed_at = coalesce(t.completed_at, v_last, now())
     where t.id = new.task_id and t.status is distinct from 'completed';
  end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.dispatch_tasks_status_manual()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- updater writes always bump status_auto_at; nested updates (route-complete stop trigger) stay automatic
  if new.status is distinct from old.status
     and new.status_auto_at is not distinct from old.status_auto_at
     and old.status_source = 'auto_gps'
     and pg_trigger_depth() < 2 then
    new.status_source := 'manual';
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.dispatch_tasks_stamp_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.assigned_at is null and (new.assigned_driver_id is not null or new.vehicle_id is not null) then new.assigned_at := now(); end if;
  elsif (new.assigned_driver_id is not null and new.assigned_driver_id is distinct from old.assigned_driver_id)
     or (new.vehicle_id is not null and new.vehicle_id is distinct from old.vehicle_id) then
    new.assigned_at := now();
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.dispatch_task_stops_source_progress()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin
    if new.source_parts is null or new.status not in ('arrived','done') or new.status is not distinct from old.status then return null; end if;
    -- drop reached -> that original task is complete
    update public.dispatch_tasks t
       set status = 'completed', completed_at = coalesce(t.completed_at, new.gps_arrived_at, now())
     where t.id in (select (p->>'task_id')::bigint from jsonb_array_elements(new.source_parts) p where p->>'type' = 'delivery')
       and t.combined_into_task_id = new.task_id and t.status is distinct from 'completed';
    -- pickup reached -> that original task is under way
    update public.dispatch_tasks t
       set status = 'in_progress'
     where t.id in (select (p->>'task_id')::bigint from jsonb_array_elements(new.source_parts) p where p->>'type' = 'pickup')
       and t.combined_into_task_id = new.task_id and t.status in ('pending','assigned');
  exception when others then
    raise warning 'dispatch_task_stops_source_progress: %', sqlerrm;
  end;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.vzc_auto_status(p_task_id bigint, p_to text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r public.dispatch_tasks%rowtype;
  today date := (timezone('America/Chicago', now()))::date;
  protected bigint[] := array[52,58,61,78,98,107,117,140,161,162];
  n int;
begin
  if p_to is distinct from 'in_progress' and p_to is distinct from 'completed' then
    return 'ignored: bad target';
  end if;
  select * into r from public.dispatch_tasks where id = p_task_id for update;
  if not found then return 'ignored: missing'; end if;
  if r.id = any (protected) then return 'ignored: protected'; end if;
  if r.messenger_id is not null then return 'ignored: messenger'; end if;
  if r.combined_into_task_id is not null then return 'ignored: combined'; end if;
  if r.work_date is null or r.work_date < today then return 'ignored: past work_date'; end if;
  if r.status_source = 'manual' then return 'ignored: manual'; end if;
  if exists (
    select 1 from public.shift_reminders s
     where s.note ~ ('\[SHIFT-DRIVER task:' || p_task_id::text || ' (missed|refused)\]')
  ) then return 'ignored: missed/refused flag'; end if;
  if p_to = 'in_progress' then
    if r.status is distinct from 'assigned' then return 'ignored: from=' || coalesce(r.status,'null'); end if;
    update public.dispatch_tasks
       set status = 'in_progress', status_source = 'auto_gps', status_auto_at = clock_timestamp()
     where id = p_task_id and status = 'assigned' and messenger_id is null
       and (status_source is null or status_source = 'auto_gps');
    get diagnostics n = row_count;
    return case when n > 0 then 'updated → in_progress' else 'race: no row' end;
  end if;
  if coalesce(r.status,'') not in ('assigned','in_progress') then return 'ignored: from=' || coalesce(r.status,'null'); end if;
  update public.dispatch_tasks
     set status = 'completed',
         completed_at = coalesce(completed_at, p_completed_at, now()),
         status_source = 'auto_gps',
         status_auto_at = clock_timestamp()
   where id = p_task_id and status in ('assigned','in_progress') and messenger_id is null
     and (status_source is null or status_source = 'auto_gps');
  get diagnostics n = row_count;
  return case when n > 0 then 'updated → completed' else 'race: no row' end;
end $function$
;