-- =====================================================================================================================
-- SHIFT Dispatch v4.10.0 — Auto trips (auto-combine, McCook return split, GPS self-correction, "set by hand"/"GPS" badges)
-- Run ONCE in the Supabase SQL editor BEFORE deploying vzc-sync v20 and BEFORE publishing the v4.10.0 board.
-- Safe to re-run (idempotent). Adds columns/functions only; changes no existing rows.
-- =====================================================================================================================

-- ---------- new columns ----------
alter table public.dispatch_tasks
  add column if not exists gps_since timestamptz,              -- GPS cutoff for this trip (earliest assignment of the combined tasks / McCook departure)
  add column if not exists gps_origin_arrived_at timestamptz,  -- truck reached the pickup (first stop) of a single task
  add column if not exists split_from_task_id bigint references public.dispatch_tasks(id) on delete set null,
  add column if not exists status_flag text,                   -- 'manual_complete_no_gps' = completed by hand, GPS never saw a visit
  add column if not exists combine_source text,                -- 'auto' (board auto-combine) | 'manual' (Combine button)
  add column if not exists no_auto_combine boolean not null default false;  -- set on Restore/Undo so auto-combine leaves it alone
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispatch_tasks_combine_source_chk') then
    alter table public.dispatch_tasks add constraint dispatch_tasks_combine_source_chk check (combine_source is null or combine_source in ('auto','manual'));
  end if;
end $$;

alter table public.dispatch_task_stops
  add column if not exists status_source text,                 -- 'auto_gps' | 'manual'
  add column if not exists status_auto_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispatch_task_stops_status_source_chk') then
    alter table public.dispatch_task_stops add constraint dispatch_task_stops_status_source_chk check (status_source is null or status_source in ('auto_gps','manual'));
  end if;
end $$;

-- ---------- helpers ----------
create or replace function public.shift_is_base_addr(a text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(a ~* '\m8701\s+(w\.?\s+)?47th\s+st' and a ~* 'mccook', false)
$$;

-- a stop status changed from the board (no status_auto_at bump) = set by hand
create or replace function public.dispatch_task_stops_status_manual() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status_auto_at is not distinct from old.status_auto_at then
    new.status_source := 'manual';
  end if;
  return new;
end $$;
drop trigger if exists dispatch_task_stops_status_manual on public.dispatch_task_stops;
create trigger dispatch_task_stops_status_manual before update of status on public.dispatch_task_stops
  for each row execute function public.dispatch_task_stops_status_manual();

-- all stops done -> route completed; now records WHO finished it (GPS or by hand) from the last stop's source
create or replace function public.dispatch_task_stops_route_complete() returns trigger
language plpgsql set search_path = '' as $$
declare v_last timestamptz;
begin
  if new.status = 'done'
     and not exists (select 1 from public.dispatch_task_stops s where s.task_id = new.task_id and s.status <> 'done') then
    select s.gps_arrived_at into v_last from public.dispatch_task_stops s
      where s.task_id = new.task_id order by s.seq desc, s.id desc limit 1;
    update public.dispatch_tasks t
       set status = 'completed', completed_at = coalesce(t.completed_at, v_last, now()),
           status_source = case when new.status_source in ('auto_gps','manual') then new.status_source else t.status_source end,
           status_auto_at = case when new.status_source = 'auto_gps' then clock_timestamp() else t.status_auto_at end
     where t.id = new.task_id and t.status is distinct from 'completed';
  end if;
  return null;
end $$;

-- stop reached -> its original tasks move on. v4.10.0: also originals of a route that was itself combined into this one,
-- and the source (GPS / by hand) is copied from the stop.
create or replace function public.dispatch_task_stops_source_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.source_parts is null or new.status not in ('arrived','done') or new.status is not distinct from old.status then return null; end if;
    update public.dispatch_tasks t
       set status = 'completed', completed_at = coalesce(t.completed_at, new.gps_arrived_at, now()),
           status_source = case when new.status_source in ('auto_gps','manual') then new.status_source else t.status_source end,
           status_auto_at = case when new.status_source = 'auto_gps' then clock_timestamp() else t.status_auto_at end
     where t.id in (select (p->>'task_id')::bigint from jsonb_array_elements(new.source_parts) p where p->>'type' = 'delivery')
       and (t.combined_into_task_id = new.task_id
            or t.combined_into_task_id in (select r.id from public.dispatch_tasks r where r.combined_into_task_id = new.task_id))
       and t.status is distinct from 'completed';
    update public.dispatch_tasks t
       set status = 'in_progress',
           status_source = case when new.status_source in ('auto_gps','manual') then new.status_source else t.status_source end,
           status_auto_at = case when new.status_source = 'auto_gps' then clock_timestamp() else t.status_auto_at end
     where t.id in (select (p->>'task_id')::bigint from jsonb_array_elements(new.source_parts) p where p->>'type' = 'pickup')
       and (t.combined_into_task_id = new.task_id
            or t.combined_into_task_id in (select r.id from public.dispatch_tasks r where r.combined_into_task_id = new.task_id))
       and t.status in ('pending','assigned');
  exception when others then
    raise warning 'dispatch_task_stops_source_progress: %', sqlerrm;
  end;
  return null;
end $$;

-- ---------- vzc_auto_status: + p_force (GPS proof may complete a task that was set back by hand; never reopens) ----------
drop function if exists public.vzc_auto_status(bigint, text, timestamptz);
create or replace function public.vzc_auto_status(p_task_id bigint, p_to text, p_completed_at timestamptz default null, p_force boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  r public.dispatch_tasks%rowtype;
  today date := (timezone('America/Chicago', now()))::date;
  protected bigint[] := array[52,58,61,78,98,107,117,140,161,162];
  n int;
  f boolean := coalesce(p_force, false) and p_to = 'completed';
begin
  if p_to is distinct from 'in_progress' and p_to is distinct from 'completed' then return 'ignored: bad target'; end if;
  select * into r from public.dispatch_tasks where id = p_task_id for update;
  if not found then return 'ignored: missing'; end if;
  if r.id = any (protected) then return 'ignored: protected'; end if;
  if r.messenger_id is not null then return 'ignored: messenger'; end if;
  if r.combined_into_task_id is not null then return 'ignored: combined'; end if;
  if r.work_date is null or r.work_date < today then return 'ignored: past work_date'; end if;
  if r.status_source = 'manual' and not f then return 'ignored: manual'; end if;
  if exists (select 1 from public.shift_reminders s
              where s.note ~ ('\[SHIFT-DRIVER task:' || p_task_id::text || ' (missed|refused)\]')) then
    return 'ignored: missed/refused flag';
  end if;
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
     set status = 'completed', completed_at = coalesce(completed_at, p_completed_at, now()),
         status_source = 'auto_gps', status_auto_at = clock_timestamp(), status_flag = null
   where id = p_task_id and status in ('assigned','in_progress') and messenger_id is null
     and (status_source is null or status_source = 'auto_gps' or f);
  get diagnostics n = row_count;
  return case when n > 0 then (case when f and r.status_source = 'manual' then 'updated → completed (GPS over hand-set)' else 'updated → completed' end) else 'race: no row' end;
end $$;
revoke all on function public.vzc_auto_status(bigint, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.vzc_auto_status(bigint, text, timestamptz, boolean) to service_role;

-- ---------- combine (board: Combine button AND auto-combine) ----------
-- p_task_ids: originals (singles and/or routes). p_route: route fields from the board. p_stops: ordered stops
-- [{location_id,location_name,location_address,stop_type,material,pallet_qty,notes,source_parts,from_stop_id?,final_return?}].
-- The route inherits the truck, the earliest GPS cutoff, and every pickup/drop the truck already made.
create or replace function public.shift_combine_tasks(p_task_ids bigint[], p_route jsonb, p_stops jsonb, p_source text default 'manual')
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  v_id bigint; v_n int; v_bad int; s jsonb; i int := 0; v_stop bigint; acc jsonb := '[]'::jsonb;
  v_vehicle bigint; v_gveh bigint; v_since timestamptz; v_inprog boolean; v_auto boolean;
  o public.dispatch_tasks%rowtype; fs public.dispatch_task_stops%rowtype;
  v_arr timestamptz; v_dep timestamptz; v_veh bigint; v_final boolean;
  src text := case when p_source = 'auto' then 'auto' else 'manual' end;
begin
  if coalesce(array_length(p_task_ids, 1), 0) < 2 then raise exception 'Pick at least two tasks.'; end if;
  perform 1 from public.dispatch_tasks where id = any (p_task_ids) order by id for update;
  select count(*), count(*) filter (where combined_into_task_id is not null
                                     or (src = 'auto' and (status in ('completed','pending') or messenger_id is not null or no_auto_combine)))
    into v_n, v_bad from public.dispatch_tasks where id = any (p_task_ids);
  if v_n <> (select count(distinct x) from unnest(p_task_ids) x) then raise exception 'A task is missing (deleted?) — reload the board.'; end if;
  if v_bad > 0 then raise exception 'A task is already in a route (or can''t be combined) — reload the board.'; end if;

  select (array_agg(vehicle_id order by assigned_at nulls last, id) filter (where vehicle_id is not null))[1],
         (array_agg(gps_vehicle_id order by id) filter (where gps_vehicle_id is not null))[1],
         min(coalesce(gps_since, greatest(created_at, coalesce(assigned_at, created_at)))),
         bool_or(status = 'in_progress'),
         bool_or(status = 'in_progress' and status_source = 'auto_gps')
    into v_vehicle, v_gveh, v_since, v_inprog, v_auto
    from public.dispatch_tasks where id = any (p_task_ids);
  select * into o from public.dispatch_tasks where id = nullif(p_route->>'origin_task_id','')::bigint and id = any (p_task_ids);

  insert into public.dispatch_tasks (task_type, title, status, priority, scheduled_at, pickup_name, pickup_address, delivery_name, delivery_address,
      job_client, material, pallet_qty, instructions, assigned_driver_id, planning_stage, sort_order, work_date, is_route, vehicle_id,
      gps_since, gps_vehicle_id, gps_departed_at, gps_origin_arrived_at, gps_origin_engine_on_at, status_source, status_auto_at, combine_source)
  values (p_route->>'task_type', p_route->>'title',
      case when v_inprog then 'in_progress' else coalesce(p_route->>'status', 'assigned') end,
      coalesce(p_route->>'priority', 'normal'), nullif(p_route->>'scheduled_at','')::timestamptz,
      p_route->>'pickup_name', p_route->>'pickup_address', p_route->>'delivery_name', p_route->>'delivery_address',
      p_route->>'job_client', p_route->>'material', nullif(p_route->>'pallet_qty','')::int, p_route->>'instructions',
      nullif(p_route->>'assigned_driver_id','')::bigint, coalesce(p_route->>'planning_stage', 'assigned'),
      coalesce(nullif(p_route->>'sort_order','')::int, 0), coalesce(nullif(p_route->>'work_date','')::date, current_date), true,
      coalesce(nullif(p_route->>'vehicle_id','')::bigint, v_vehicle), v_since, v_gveh,
      o.gps_departed_at, case when coalesce(o.is_route, false) then null else o.gps_origin_arrived_at end, o.gps_origin_engine_on_at,
      case when v_auto then 'auto_gps' when v_inprog then 'manual' end, case when v_auto then clock_timestamp() end, src)
  returning id into v_id;

  for s in select * from jsonb_array_elements(coalesce(p_stops, '[]'::jsonb)) loop
    i := i + 1;
    insert into public.dispatch_task_stops (task_id, seq, location_id, location_name, location_address, stop_type, material, pallet_qty, notes,
        source_task_ids, source_parts, status)
    values (v_id, i, nullif(s->>'location_id','')::bigint, s->>'location_name', s->>'location_address', coalesce(s->>'stop_type','delivery'),
        s->>'material', nullif(s->>'pallet_qty','')::int, s->>'notes',
        (select array_agg(distinct (q->>'task_id')::bigint) from jsonb_array_elements(coalesce(s->'source_parts','[]'::jsonb)) q),
        s->'source_parts', 'pending')
    returning id into v_stop;
    -- what the truck already did here (from the old route stop, or from the original single tasks)
    v_arr := null; v_dep := null; v_veh := null; fs := null;
    if nullif(s->>'from_stop_id','') is not null then
      select * into fs from public.dispatch_task_stops where id = (s->>'from_stop_id')::bigint
         and task_id in (select id from public.dispatch_tasks where id = any (p_task_ids));
      v_arr := fs.gps_arrived_at; v_dep := fs.gps_departed_at; v_veh := fs.gps_vehicle_id;
    else
      select x.arr, x.dep, x.veh into v_arr, v_dep, v_veh from (
        select case when q->>'type' = 'pickup' then coalesce(t.gps_origin_arrived_at, t.gps_departed_at) else t.gps_arrived_at end arr,
               case when q->>'type' = 'pickup' then t.gps_departed_at else t.gps_left_destination_at end dep,
               t.gps_vehicle_id veh
          from jsonb_array_elements(coalesce(s->'source_parts','[]'::jsonb)) q
          join public.dispatch_tasks t on t.id = (q->>'task_id')::bigint and t.id = any (p_task_ids) and not coalesce(t.is_route, false)
      ) x where x.arr is not null order by x.arr limit 1;
    end if;
    v_final := coalesce((s->>'final_return')::boolean, false) or (i = jsonb_array_length(p_stops) and public.shift_is_base_addr(s->>'location_address'));
    if v_arr is not null then
      acc := acc || jsonb_build_object('id', v_stop, 'arr', v_arr, 'dep', v_dep, 'veh', v_veh,
        'st', case when v_dep is not null or v_final then 'done' else 'arrived' end,
        'src', coalesce(fs.status_source, 'auto_gps'), 'm', coalesce(fs.gps_match_method, 'inherited:combine'));
    end if;
  end loop;

  -- originals now belong to the route (before stop statuses, so pickups/drops already made move them on)
  update public.dispatch_tasks set combined_into_task_id = v_id, combine_source = coalesce(combine_source, src) where id = any (p_task_ids);
  -- one statement: route-complete trigger sees every stop at once
  update public.dispatch_task_stops x
     set gps_arrived_at = r.arr, gps_departed_at = r.dep, gps_vehicle_id = r.veh, gps_source = 'verizon_reveal', gps_updated_at = now(),
         gps_match_method = r.m, status = r.st, status_source = r.src, status_auto_at = clock_timestamp()
    from jsonb_to_recordset(acc) as r(id bigint, arr timestamptz, dep timestamptz, veh bigint, st text, src text, m text)
   where x.id = r.id;
  return v_id;
end $$;
grant execute on function public.shift_combine_tasks(bigint[], jsonb, jsonb, text) to anon, authenticated, service_role;

-- Undo an AUTO-combined route that the truck has not started yet (otherwise use ↩ Restore on each task).
create or replace function public.shift_undo_auto_combine(p_route_id bigint) returns int
language plpgsql security invoker set search_path = '' as $$
declare r public.dispatch_tasks%rowtype; n int;
begin
  select * into r from public.dispatch_tasks where id = p_route_id for update;
  if not found or not coalesce(r.is_route, false) then raise exception 'Route #% not found.', p_route_id; end if;
  if r.combine_source is distinct from 'auto' then raise exception 'Route #% was not auto-combined — use ↩ Restore on its tasks.', p_route_id; end if;
  if r.status = 'completed' or r.gps_departed_at is not null
     or exists (select 1 from public.dispatch_task_stops where task_id = p_route_id and (gps_arrived_at is not null or status <> 'pending')) then
    raise exception 'GPS already has visits on route #% — use ↩ Restore on its tasks instead.', p_route_id;
  end if;
  update public.dispatch_tasks set combined_into_task_id = null, no_auto_combine = true where combined_into_task_id = p_route_id;
  get diagnostics n = row_count;
  delete from public.dispatch_task_stops where task_id = p_route_id;
  delete from public.dispatch_tasks where id = p_route_id;
  return n;
end $$;
grant execute on function public.shift_undo_auto_combine(bigint) to anon, authenticated, service_role;

-- ---------- McCook return split (called by vzc-sync v20 only) ----------
-- Truck came back to McCook between stops: close this trip at the McCook arrival and move the remaining stops to a new
-- trip that starts at McCook (GPS cutoff = McCook departure).
create or replace function public.vzc_split_trip(p_task_id bigint, p_move_stop_ids bigint[], p_base_arrived timestamptz,
                                                 p_base_departed timestamptz default null, p_vehicle_id bigint default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  r public.dispatch_tasks%rowtype; f public.dispatch_task_stops%rowtype;
  v_move bigint[]; v_new bigint; v_final_base boolean; v_keep jsonb; v_moveparts jsonb; v_close bigint; v_n int;
  v_first text; v_last text;
  today date := (timezone('America/Chicago', now()))::date;
  protected bigint[] := array[52,58,61,78,98,107,117,140,161,162];
  base_name constant text := 'Darwill McCook';
  base_addr constant text := '8701 47th St Ste C, McCook, IL 60525';
begin
  if p_base_arrived is null then return 'ignored: no McCook time'; end if;
  select * into r from public.dispatch_tasks where id = p_task_id for update;
  if not found then return 'ignored: missing'; end if;
  if not coalesce(r.is_route, false) then return 'ignored: not a route'; end if;
  if r.id = any (protected) then return 'ignored: protected'; end if;
  if r.combined_into_task_id is not null then return 'ignored: combined'; end if;
  if r.status = 'completed' then return 'ignored: completed'; end if;
  if r.work_date is null or r.work_date < today then return 'ignored: past work_date'; end if;

  select * into f from public.dispatch_task_stops where task_id = p_task_id order by seq desc, id desc limit 1;
  v_final_base := f.id is not null and public.shift_is_base_addr(f.location_address);
  select array_agg(id order by seq, id) into v_move from public.dispatch_task_stops
   where task_id = p_task_id and id = any (p_move_stop_ids) and status <> 'done'
     and not (v_final_base and id = f.id)
     and (gps_arrived_at is null or gps_arrived_at > p_base_arrived);
  if v_move is null then return 'ignored: nothing to move'; end if;
  if not exists (select 1 from public.dispatch_task_stops where task_id = p_task_id and not (id = any (v_move)) and not (v_final_base and id = f.id))
     and (r.gps_departed_at is null or public.shift_is_base_addr(r.pickup_address)) then
    return 'ignored: nothing finished before McCook';
  end if;

  insert into public.dispatch_tasks (task_type, title, status, priority, scheduled_at, pickup_name, pickup_address, delivery_name, delivery_address,
      job_client, material, instructions, assigned_driver_id, planning_stage, sort_order, work_date, is_route, vehicle_id,
      gps_since, gps_departed_at, gps_vehicle_id, split_from_task_id, combine_source)
  values (r.task_type, r.title, 'assigned', r.priority, r.scheduled_at, base_name, base_addr, r.delivery_name, r.delivery_address,
      r.job_client, r.material,
      'Next trip — truck returned to McCook at ' || to_char(p_base_arrived at time zone 'America/Chicago', 'FMHH12:MI AM') || ' (split from route #' || r.id || ').',
      r.assigned_driver_id, 'assigned', r.sort_order, r.work_date, true, coalesce(r.vehicle_id, p_vehicle_id),
      coalesce(p_base_departed, p_base_arrived), p_base_departed, coalesce(r.gps_vehicle_id, p_vehicle_id), r.id, r.combine_source)
  returning id into v_new;
  update public.dispatch_task_stops set task_id = v_new where id = any (v_move);

  if v_final_base then
    -- drops at McCook whose pickup moved to the new trip move with it; everything already on board stays on trip 1
    select coalesce(jsonb_agg(p) filter (where p->>'type' = 'delivery' and exists (
               select 1 from public.dispatch_task_stops s2, jsonb_array_elements(coalesce(s2.source_parts,'[]'::jsonb)) q
                where s2.task_id = v_new and q->>'type' = 'pickup' and q->>'task_id' = p->>'task_id')), '[]'::jsonb),
           coalesce(jsonb_agg(p) filter (where not (p->>'type' = 'delivery' and exists (
               select 1 from public.dispatch_task_stops s2, jsonb_array_elements(coalesce(s2.source_parts,'[]'::jsonb)) q
                where s2.task_id = v_new and q->>'type' = 'pickup' and q->>'task_id' = p->>'task_id'))), '[]'::jsonb)
      into v_moveparts, v_keep
      from jsonb_array_elements(coalesce(f.source_parts, '[]'::jsonb)) p;
    if jsonb_array_length(v_moveparts) > 0 then
      insert into public.dispatch_task_stops (task_id, seq, location_id, location_name, location_address, stop_type, material, pallet_qty, notes,
          source_task_ids, source_parts, status)
      values (v_new, 1000000, f.location_id, f.location_name, f.location_address, 'delivery', f.material,
          (select nullif(sum(coalesce((p->>'pallets')::int, 0)), 0) from jsonb_array_elements(v_moveparts) p), 'Return to McCook',
          (select array_agg(distinct (p->>'task_id')::bigint) from jsonb_array_elements(v_moveparts) p), v_moveparts, 'pending');
      update public.dispatch_task_stops
         set source_parts = v_keep,
             source_task_ids = (select array_agg(distinct (p->>'task_id')::bigint) from jsonb_array_elements(v_keep) p),
             pallet_qty = (select nullif(sum(coalesce((p->>'pallets')::int, 0)), 0) from jsonb_array_elements(v_keep) p)
       where id = f.id;
    end if;
    v_close := f.id;
  else
    insert into public.dispatch_task_stops (task_id, seq, location_name, location_address, stop_type, notes, status)
    values (p_task_id, coalesce(f.seq, 0) + 1, base_name, base_addr, 'delivery', 'Returned to McCook (trip split by GPS)', 'pending')
    returning id into v_close;
  end if;

  -- reseq the new trip
  update public.dispatch_task_stops s set seq = x.rn
    from (select id, row_number() over (order by seq, id) rn from public.dispatch_task_stops where task_id = v_new) x where s.id = x.id;
  select location_name into v_first from public.dispatch_task_stops where task_id = v_new order by seq limit 1;
  select location_name, count(*) over () into v_last, v_n from public.dispatch_task_stops where task_id = v_new order by seq desc limit 1;
  update public.dispatch_tasks set title = base_name || ' - ' || coalesce(v_last, '…') || ' (' || v_n || ' stop' || case when v_n = 1 then '' else 's' end || ')',
         delivery_name = v_last, delivery_address = (select location_address from public.dispatch_task_stops where task_id = v_new order by seq desc limit 1)
   where id = v_new;

  -- originals with a stop on the new trip follow it (so their pickup/drop there moves them on)
  update public.dispatch_tasks t set combined_into_task_id = v_new
   where t.combined_into_task_id = p_task_id
     and t.id in (select (q->>'task_id')::bigint from public.dispatch_task_stops s, jsonb_array_elements(coalesce(s.source_parts,'[]'::jsonb)) q where s.task_id = v_new);

  update public.dispatch_tasks set delivery_name = base_name, delivery_address = base_addr,
         gps_returned_base_at = coalesce(gps_returned_base_at, p_base_arrived)
   where id = p_task_id;
  -- close trip 1 at the McCook return (GPS) — triggers complete trip 1 and the drops made there
  update public.dispatch_task_stops
     set gps_arrived_at = coalesce(gps_arrived_at, p_base_arrived), gps_vehicle_id = coalesce(gps_vehicle_id, p_vehicle_id),
         gps_source = 'verizon_reveal', gps_updated_at = now(), gps_match_method = coalesce(gps_match_method, 'geofence:mccook_return'),
         status = 'done', status_source = 'auto_gps', status_auto_at = clock_timestamp()
   where id = v_close;
  return 'split → trip #' || v_new;
end $$;
revoke all on function public.vzc_split_trip(bigint, bigint[], timestamptz, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.vzc_split_trip(bigint, bigint[], timestamptz, timestamptz, bigint) to service_role;

-- ---------- route stops view: + who set each stop (appended columns only) ----------
create or replace view public.dispatch_route_stops_v as
 SELECT s.id AS stop_id, s.task_id, s.seq, row_number() OVER w AS stop_number, count(*) OVER (PARTITION BY s.task_id) AS stop_count,
    s.stop_type, s.location_id, s.location_name, s.location_address, s.material, s.pallet_qty, s.notes, s.status,
    CASE WHEN lag(s.id) OVER w IS NULL THEN t.pickup_name ELSE lag(s.location_name) OVER w END AS prev_location_name,
    CASE WHEN lag(s.id) OVER w IS NULL THEN t.gps_departed_at ELSE lag(s.gps_departed_at) OVER w END AS prev_departed_at,
    s.gps_arrived_at, s.gps_departed_at,
    round(EXTRACT(epoch FROM s.gps_arrived_at - CASE WHEN lag(s.id) OVER w IS NULL THEN t.gps_departed_at ELSE lag(s.gps_departed_at) OVER w END) / 60::numeric)::integer AS leg_drive_minutes,
    s.gps_dwell_minutes, s.gps_vehicle_id, sv.name AS gps_vehicle_name, s.gps_source, s.gps_updated_at,
    t.work_date, t.title AS task_title, t.task_type, t.status AS task_status, t.is_route, t.combined_into_task_id, t.scheduled_at,
    t.planning_stage, t.sort_order, t.completed_at AS task_completed_at, t.pickup_name AS origin_name, t.pickup_address AS origin_address,
    t.gps_departed_at AS origin_departed_at, t.assigned_driver_id AS driver_id, d.name AS driver_name,
    COALESCE(ds.vehicle_id, d.default_vehicle_id) AS vehicle_id, v.name AS vehicle_name,
    s.gps_engine_off_at, s.gps_engine_on_at, s.gps_idle_minutes, s.gps_engine_off_minutes, s.gps_match_method, s.gps_match_distance_m,
    t.gps_returned_base_at AS task_returned_base_at,
    s.status_source AS stop_status_source, s.status_auto_at AS stop_status_auto_at, s.source_parts
   FROM dispatch_task_stops s
     JOIN dispatch_tasks t ON t.id = s.task_id
     LEFT JOIN drivers d ON d.id = t.assigned_driver_id
     LEFT JOIN driver_schedule ds ON ds.driver_id = t.assigned_driver_id AND ds.work_date = t.work_date
     LEFT JOIN vehicles v ON v.id = COALESCE(ds.vehicle_id, d.default_vehicle_id)
     LEFT JOIN vehicles sv ON sv.id = s.gps_vehicle_id
  WINDOW w AS (PARTITION BY s.task_id ORDER BY s.seq, s.id);

notify pgrst, 'reload schema';
