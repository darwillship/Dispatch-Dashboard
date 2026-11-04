\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.ok(c boolean, msg text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'FAIL: %', msg; end if; raise notice 'PASS: %', msg; end $$;
-- today in CT
select set_config('t.d', (timezone('America/Chicago', now()))::date::text, false);
insert into vehicles values (4,'Big Blue'); insert into drivers values (7,'Mark',4);
-- 305: Canon -> McCook (8 pal), 306: Universal -> McCook. 306's pickup already seen by GPS (v4.10 single pickup partial)
insert into dispatch_tasks(id,task_type,title,status,pickup_name,pickup_address,delivery_name,delivery_address,pallet_qty,assigned_driver_id,vehicle_id,work_date,created_at,assigned_at,planning_stage)
values (305,'pickup','Canon → McCook','assigned','Canon','1 Canon Rd, Romeoville, IL','Darwill McCook','8701 47th St Ste C, McCook, IL 60525',8,7,4,current_setting('t.d')::date, now()-interval '3 hours', now()-interval '2 hours','assigned'),
       (306,'pickup','Universal → McCook','assigned','Universal','1 Universal Dr, Lemont, IL','Darwill McCook','8701 47th St Ste C, McCook, IL 60525',null,7,4,current_setting('t.d')::date, now()-interval '3 hours', now()-interval '2 hours','assigned');
update dispatch_tasks set assigned_at = now()-interval '2 hours' where id in (305,306);
-- sync marks 306 under way from GPS (pickup seen)
select vzc_auto_status(306,'in_progress');
update dispatch_tasks set gps_origin_arrived_at=now()-interval '100 min', gps_departed_at=now()-interval '90 min', gps_vehicle_id=4 where id=306;
select pg_temp.ok((select status_source='auto_gps' and status='in_progress' from dispatch_tasks where id=306), 'single 306 in_progress by GPS');

-- A. auto-combine as the board (anon), GPS order: 306 first
set role anon;
select shift_combine_tasks(array[306,305]::bigint[],
  '{"title":"Universal - Darwill McCook (2 stops)","task_type":"pickup","status":"assigned","assigned_driver_id":7,"planning_stage":"assigned","pickup_name":"Universal","pickup_address":"1 Universal Dr, Lemont, IL","delivery_name":"Darwill McCook","delivery_address":"8701 47th St Ste C, McCook, IL 60525","origin_task_id":306}'::jsonb,
  '[{"location_name":"Canon","location_address":"1 Canon Rd, Romeoville, IL","stop_type":"pickup","pallet_qty":8,"source_parts":[{"task_id":305,"type":"pickup","pallets":8}]},
    {"location_name":"Darwill McCook","location_address":"8701 47th St Ste C, McCook, IL 60525","stop_type":"delivery","final_return":true,"source_parts":[{"task_id":306,"type":"delivery"},{"task_id":305,"type":"delivery","pallets":8}]}]'::jsonb,'auto') as route \gset
reset role;
select pg_temp.ok((select vehicle_id=4 and is_route and combine_source='auto' and status='in_progress' and status_source='auto_gps'
   and gps_since=(select min(greatest(created_at,assigned_at)) from dispatch_tasks where id in (305,306))
   and gps_departed_at=(select gps_departed_at from dispatch_tasks where id=306) and gps_origin_arrived_at is not null from dispatch_tasks where id=:route),
  'combined route inherits truck, in_progress (GPS), earliest cutoff, pickup visit already seen');
select pg_temp.ok((select count(*)=2 and bool_and(combined_into_task_id=:route) from dispatch_tasks where id in (305,306)), 'originals marked combined');
-- B. sync: Canon visited and left (GPS) -> stop done auto; 305 under way
update dispatch_task_stops set status='done', gps_arrived_at=now()-interval '75 min', gps_departed_at=now()-interval '50 min', status_source='auto_gps', status_auto_at=now() where task_id=:route and seq=1;
select pg_temp.ok((select status='in_progress' and status_source='auto_gps' from dispatch_tasks where id=305), 'pickup at Canon (GPS) -> #305 in progress, source GPS');
-- C. dispatcher sets Canon back to pending by hand -> stop source manual
set role anon; update dispatch_task_stops set status='pending' where task_id=:route and seq=1; reset role;
select pg_temp.ok((select status_source='manual' from dispatch_task_stops where task_id=:route and seq=1), 'board change of a stop -> set by hand');
-- self-correction (sync): GPS shows it left -> done again, auto
update dispatch_task_stops set status='done', status_source='auto_gps', status_auto_at=clock_timestamp() where task_id=:route and seq=1 and status<>'done';
select pg_temp.ok((select status='done' and status_source='auto_gps' from dispatch_task_stops where task_id=:route and seq=1), 'self-correction puts GPS-proven stop back to done');
-- D. McCook arrival (GPS) -> route + both originals completed, source GPS
update dispatch_task_stops set status='done', gps_arrived_at=now()-interval '10 min', status_source='auto_gps', status_auto_at=clock_timestamp() where task_id=:route and seq=2;
select pg_temp.ok((select status='completed' and status_source='auto_gps' and completed_at is not null from dispatch_tasks where id=:route), 'route completed at McCook, source GPS');
select pg_temp.ok((select count(*)=2 and bool_and(status='completed' and status_source='auto_gps') from dispatch_tasks where id in (305,306)), 'both originals completed by GPS');

-- E. vzc_auto_status force vs manual
insert into dispatch_tasks(id,title,status,status_source,work_date,pickup_name,delivery_name) values (400,'manual set back','in_progress','manual',current_setting('t.d')::date,'A','B');
select pg_temp.ok(vzc_auto_status(400,'completed',now()) = 'ignored: manual', 'manual status respected without GPS proof');
select pg_temp.ok(vzc_auto_status(400,'completed',now(),true) like 'updated → completed%', 'GPS proof (force) completes a hand-set task');
insert into dispatch_tasks(id,title,status,status_source,work_date,completed_at) values (401,'manual complete','completed','manual',current_setting('t.d')::date,now());
select pg_temp.ok(vzc_auto_status(401,'in_progress',null,true) like 'ignored%', 'force never reopens a completed task');
set role anon;
do $$ begin perform vzc_auto_status(400,'completed'); raise exception 'anon could call vzc_auto_status'; exception when insufficient_privilege then raise notice 'PASS: anon cannot call vzc_auto_status'; end $$;
do $$ begin perform vzc_split_trip(1,array[1]::bigint[],now()); raise exception 'anon could call split'; exception when insufficient_privilege then raise notice 'PASS: anon cannot call vzc_split_trip'; end $$;
reset role;

-- F. McCook return split: route R: origin Hillside (left), stop B pickup (task 502), final McCook (drops 501 loaded at origin + 502)
insert into dispatch_tasks(id,task_type,title,status,pickup_name,pickup_address,delivery_name,delivery_address,assigned_driver_id,vehicle_id,work_date)
values (501,'pickup','Hillside → McCook','assigned','Darwill Hillside','11900 Roosevelt Rd, Hillside, IL 60162','Darwill McCook','8701 47th St Ste C, McCook, IL 60525',7,4,current_setting('t.d')::date),
       (502,'pickup','Bolingbrook → McCook','assigned','ENRU','1000 Windham Pkwy, Bolingbrook, IL 60490','Darwill McCook','8701 47th St Ste C, McCook, IL 60525',7,4,current_setting('t.d')::date);
select shift_combine_tasks(array[501,502]::bigint[],
  '{"title":"Hillside - Darwill McCook (2 stops)","task_type":"pickup","assigned_driver_id":7,"pickup_name":"Darwill Hillside","pickup_address":"11900 Roosevelt Rd, Hillside, IL 60162","origin_task_id":501}'::jsonb,
  '[{"location_name":"ENRU","location_address":"1000 Windham Pkwy, Bolingbrook, IL 60490","stop_type":"pickup","source_parts":[{"task_id":502,"type":"pickup","pallets":4}]},
    {"location_name":"Darwill McCook","location_address":"8701 47th St Ste C, McCook, IL 60525","stop_type":"delivery","final_return":true,"source_parts":[{"task_id":501,"type":"delivery","pallets":6},{"task_id":502,"type":"delivery","pallets":4}]}]'::jsonb,'manual') as r2 \gset
update dispatch_tasks set gps_departed_at=now()-interval '3 hours', status='in_progress', status_auto_at=clock_timestamp(), status_source='auto_gps' where id=:r2;
select id as b_stop from dispatch_task_stops where task_id=:r2 and seq=1 \gset
set role service_role;
select vzc_split_trip(:r2, array[:b_stop]::bigint[], now()-interval '150 min', now()-interval '120 min', 4) as res \gset
reset role;
select :'res';
select substring(:'res' from '#(\d+)')::bigint as t2 \gset
select pg_temp.ok((select status='completed' and status_source='auto_gps' and gps_returned_base_at is not null from dispatch_tasks where id=:r2), 'trip 1 closed at the McCook return (GPS)');
select pg_temp.ok((select status='completed' from dispatch_tasks where id=501), '#501 (loaded before McCook) completed at the return');
select pg_temp.ok((select status<>'completed' and combined_into_task_id=:t2 from dispatch_tasks where id=502), '#502 moved to the new trip, still open');
select pg_temp.ok((select pickup_name='Darwill McCook' and abs(extract(epoch from now()-interval '120 min'-gps_since))<60 and split_from_task_id=:r2 and vehicle_id=4 and assigned_driver_id=7 and status='assigned' from dispatch_tasks where id=:t2), 'new trip starts at McCook, cutoff = McCook departure, same driver/truck');
select pg_temp.ok((select string_agg(location_name||':'||seq||':'||status, ',' order by seq)='ENRU:1:pending,Darwill McCook:2:pending' from dispatch_task_stops where task_id=:t2), 'new trip stops: ENRU then McCook');
select pg_temp.ok((select jsonb_array_length(source_parts)=1 and source_parts->0->>'task_id'='501' from dispatch_task_stops where task_id=:r2 and seq=2), 'trip 1 McCook stop keeps only #501 drop');
-- new trip progresses
update dispatch_task_stops set status='done', gps_arrived_at=now(), status_source='auto_gps', status_auto_at=clock_timestamp() where task_id=:t2;
select pg_temp.ok((select status='completed' from dispatch_tasks where id in (502)) and (select status='completed' from dispatch_tasks where id=:t2), 'new trip + #502 complete at second McCook return');

-- G. undo auto-combine (untouched) and blocked undo (GPS seen)
insert into dispatch_tasks(id,title,status,work_date,pickup_name,pickup_address,delivery_name,delivery_address,assigned_driver_id,vehicle_id) values
 (601,'a','assigned',current_setting('t.d')::date,'X','x','Y','y',7,4),(602,'b','assigned',current_setting('t.d')::date,'Z','z','W','w',7,4);
set role anon;
select shift_combine_tasks(array[601,602]::bigint[],'{"title":"t","assigned_driver_id":7,"origin_task_id":601,"pickup_name":"X"}'::jsonb,
 '[{"location_name":"Y","location_address":"y","stop_type":"delivery","source_parts":[{"task_id":601,"type":"delivery"}]},{"location_name":"Z","location_address":"z","stop_type":"pickup","source_parts":[{"task_id":602,"type":"pickup"}]},{"location_name":"W","location_address":"w","stop_type":"delivery","source_parts":[{"task_id":602,"type":"delivery"}]}]'::jsonb,'auto') as r3 \gset
do $$ begin perform shift_combine_tasks(array[601,602]::bigint[],'{}'::jsonb,'[]'::jsonb,'auto'); raise exception 'double combine allowed'; exception when raise_exception then if sqlerrm like 'FAIL%' or sqlerrm like 'double%' then raise; end if; raise notice 'PASS: re-combining an already-combined task is refused'; end $$;
select pg_temp.ok(shift_undo_auto_combine(:r3)=2, 'undo auto-combine restores 2 tasks');
reset role;
select pg_temp.ok((select count(*)=2 and bool_and(combined_into_task_id is null and no_auto_combine) from dispatch_tasks where id in (601,602)) and not exists(select 1 from dispatch_tasks where id=:r3), 'originals back on the board, flagged no_auto_combine; empty auto route removed');
select pg_temp.ok((select count(*) from dispatch_route_stops_v where stop_status_source is not null) > 0, 'view exposes stop_status_source');
