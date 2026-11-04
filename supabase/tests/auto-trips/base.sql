do $$ begin create role anon; exception when others then null; end $$;
do $$ begin create role authenticated; exception when others then null; end $$;
do $$ begin create role service_role; exception when others then null; end $$;
create table vehicles(id bigint primary key, name text);
create table drivers(id bigint primary key, name text, default_vehicle_id bigint);
create table driver_schedule(driver_id bigint, work_date date, vehicle_id bigint);
create table shift_reminders(id bigserial primary key, note text);
create table dispatch_tasks(id bigserial primary key, created_at timestamptz default now(), task_type text, title text, status text default 'planned', priority text default 'normal',
 scheduled_at timestamptz, pickup_name text, pickup_address text, delivery_name text, delivery_address text, job_client text, material text, pallet_qty int, instructions text,
 assigned_driver_id bigint, completed_at timestamptz, planning_stage text default 'ready', sort_order int default 0, work_date date default current_date,
 gps_departed_at timestamptz, gps_arrived_at timestamptz, gps_left_destination_at timestamptz, gps_vehicle_id bigint, gps_drive_minutes int, gps_dwell_minutes int,
 gps_source text default 'verizon_reveal', gps_updated_at timestamptz, combined_into_task_id bigint references dispatch_tasks(id) on delete set null, is_route boolean default false,
 gps_origin_engine_on_at timestamptz, gps_engine_off_at timestamptz, gps_engine_on_at timestamptz, gps_idle_minutes int, gps_engine_off_minutes int, gps_returned_base_at timestamptz,
 gps_match_method text, gps_match_distance_m int, status_source text check (status_source is null or status_source in ('auto_gps','manual')), status_auto_at timestamptz,
 vehicle_id bigint, messenger_id bigint, confirmation_number text, messenger_cost numeric, assigned_at timestamptz,
 constraint not_combined_into_self check (combined_into_task_id is distinct from id));
create table dispatch_task_stops(id bigserial primary key, created_at timestamptz default now(), task_id bigint references dispatch_tasks(id) on delete cascade, seq int, location_id bigint,
 location_name text, location_address text, stop_type text check (stop_type in ('pickup','delivery','both')), material text, pallet_qty int, notes text,
 status text default 'pending' check (status in ('pending','arrived','done')), gps_arrived_at timestamptz, gps_departed_at timestamptz, gps_vehicle_id bigint, gps_source text,
 gps_updated_at timestamptz, gps_dwell_minutes int, gps_engine_off_at timestamptz, gps_engine_on_at timestamptz, gps_idle_minutes int, gps_engine_off_minutes int,
 gps_match_method text, gps_match_distance_m int, source_task_ids bigint[], source_parts jsonb);
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
