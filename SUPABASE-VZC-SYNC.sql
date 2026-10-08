-- SHIFT Dispatch v3.9.0 — Verizon Connect (Reveal / Fleetmatics REST) → Dispatch GPS updater.
-- Applied to project hqhfstosclasgwgxubip on 2026-10-08 as migration "vzc_gps_sync".
-- Additive only. NOT LIVE: no cron job is scheduled by this file (see "GO-LIVE" at the bottom).
-- Follow-up migrations (same day): "vzc_invoke_token" (random invoke token in Vault + verify_jwt=false function auth)
-- and "vzc_service_grants" (service_role table grants the function needs).
-- No credentials live here: VZC_USERNAME / VZC_PASSWORD / VZC_APP_ID are Edge Function secrets, and the
-- cron invoke token is generated inside Postgres (Vault) — nobody copies a key.

-- 0. Self-check: lock the dispatch tables, checksum every existing column, run the DDL, checksum again,
--    and abort (roll back everything) if a single existing value changed.
do $guard$
declare t_before text; t_after text; s_before text; s_after text; n_before bigint; n_after bigint;
begin
  lock table public.dispatch_tasks, public.dispatch_task_stops in share row exclusive mode;
  select count(*), md5(string_agg(row(id,created_at,task_type,title,status,priority,scheduled_at,pickup_name,pickup_address,
           delivery_name,delivery_address,job_client,material,pallet_qty,instructions,assigned_driver_id,completed_at,planning_stage,
           sort_order,work_date,gps_departed_at,gps_arrived_at,gps_left_destination_at,gps_vehicle_id,gps_drive_minutes,
           gps_dwell_minutes,gps_source,gps_updated_at,combined_into_task_id,is_route)::text,'|' order by id))
    into n_before, t_before from public.dispatch_tasks;
  select md5(coalesce(string_agg(row(id,created_at,task_id,seq,location_id,location_name,location_address,stop_type,material,
           pallet_qty,notes,status,gps_arrived_at,gps_departed_at,gps_vehicle_id,gps_source,gps_updated_at,gps_dwell_minutes)::text,
           '|' order by id),'')) into s_before from public.dispatch_task_stops;

  -- 1. per-task GPS detail (single tasks: origin → destination; route tasks use origin + return-to-base only)
  alter table public.dispatch_tasks
    add column if not exists gps_origin_engine_on_at timestamptz,   -- engine on at the origin before leaving
    add column if not exists gps_engine_off_at timestamptz,         -- engine off at the destination (Reveal's "arrived")
    add column if not exists gps_engine_on_at timestamptz,          -- engine on again at the destination
    add column if not exists gps_idle_minutes integer,              -- on site with engine running (stopped)
    add column if not exists gps_engine_off_minutes integer,        -- on site with engine off
    add column if not exists gps_returned_base_at timestamptz,      -- first arrival back at McCook after the job
    add column if not exists gps_match_method text,                 -- e.g. 'geofence:planned_truck', 'address:other_truck'
    add column if not exists gps_match_distance_m integer;          -- closest GPS point to the geocoded address

  -- 2. per-stop GPS detail for routes
  alter table public.dispatch_task_stops
    add column if not exists gps_engine_off_at timestamptz,
    add column if not exists gps_engine_on_at timestamptz,
    add column if not exists gps_idle_minutes integer,
    add column if not exists gps_engine_off_minutes integer,
    add column if not exists gps_match_method text,
    add column if not exists gps_match_distance_m integer;

  select count(*), md5(string_agg(row(id,created_at,task_type,title,status,priority,scheduled_at,pickup_name,pickup_address,
           delivery_name,delivery_address,job_client,material,pallet_qty,instructions,assigned_driver_id,completed_at,planning_stage,
           sort_order,work_date,gps_departed_at,gps_arrived_at,gps_left_destination_at,gps_vehicle_id,gps_drive_minutes,
           gps_dwell_minutes,gps_source,gps_updated_at,combined_into_task_id,is_route)::text,'|' order by id))
    into n_after, t_after from public.dispatch_tasks;
  select md5(coalesce(string_agg(row(id,created_at,task_id,seq,location_id,location_name,location_address,stop_type,material,
           pallet_qty,notes,status,gps_arrived_at,gps_departed_at,gps_vehicle_id,gps_source,gps_updated_at,gps_dwell_minutes)::text,
           '|' order by id),'')) into s_after from public.dispatch_task_stops;
  if n_before <> n_after or t_before <> t_after or s_before <> s_after then
    raise exception 'GUARD: existing dispatch data changed (tasks % -> %, stops % -> %) — rolled back', t_before, t_after, s_before, s_after;
  end if;
end $guard$;

-- 3. Reveal vehicle numbers (mapped by dashboard truck name; Reveal pads names/numbers with spaces — stored trimmed)
alter table public.vehicles add column if not exists vzc_vehicle_number text;
create unique index if not exists vehicles_vzc_vehicle_number_key on public.vehicles (vzc_vehicle_number) where vzc_vehicle_number is not null;
update public.vehicles v set vzc_vehicle_number = m.num
  from (values ('Big Blue','41128R'),('Big Gray','53608R'),('Frey','11060s'),('Hillside Van','HILLSIDE VAN'),
               ('McCook Van','145819D'),('Sterling','15650L'),('White Panel Truck','19176L')) as m(name, num)
 where v.name = m.name and v.vzc_vehicle_number is null;

-- 4. live truck location (one row per truck, written by vzc-sync; the dashboard reads it with the public key)
create table if not exists public.vehicle_live_location (
  vehicle_id bigint primary key references public.vehicles(id) on delete cascade,
  vzc_vehicle_number text,
  state text check (state in ('Moving','Idle','Engine off','Unknown')),
  raw_state text,                     -- Reveal DisplayState (Moving / Idle / Stop)
  address text,
  lat double precision,
  lon double precision,
  speed_mph numeric(5,1),
  heading text,
  reported_at timestamptz,            -- Reveal UpdateUTC (last GPS plot)
  updated_at timestamptz not null default now(),   -- last time vzc-sync refreshed this row
  last_track_fetch_at timestamptz,    -- internal: last segments/history fetch for matching
  last_track_update_utc timestamptz   -- internal: Reveal UpdateUTC at that fetch
);
alter table public.vehicle_live_location enable row level security;
revoke all on table public.vehicle_live_location from anon, authenticated;
grant select on table public.vehicle_live_location to anon, authenticated;
drop policy if exists "vehicle live location read" on public.vehicle_live_location;
create policy "vehicle live location read" on public.vehicle_live_location for select to anon, authenticated using (true);

-- 5. geocode cache (address → lat/lon, geocoded once). Source: US Census Geocoder, OpenStreetMap Nominatim fallback.
create table if not exists public.geocode_cache (
  address_norm text primary key,      -- normalized "house# street|city" key (see match.ts normalizeAddress)
  address text not null,
  lat double precision,
  lon double precision,
  status text not null default 'ok' check (status in ('ok','not_found','error')),
  source text,                        -- 'census' | 'nominatim' | 'manual'
  matched_address text,
  geocoded_at timestamptz not null default now()
);
alter table public.geocode_cache enable row level security;
revoke all on table public.geocode_cache from anon, authenticated;
grant select on table public.geocode_cache to anon, authenticated;
drop policy if exists "geocode cache read" on public.geocode_cache;
create policy "geocode cache read" on public.geocode_cache for select to anon, authenticated using (true);

-- 6. sync run log (no secrets; pruned to 14 days by the function)
create table if not exists public.vzc_sync_runs (
  id bigint generated by default as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null default true,
  ok boolean,
  api_calls integer,
  summary jsonb,
  error text
);
create index if not exists vzc_sync_runs_started_idx on public.vzc_sync_runs (started_at desc);
alter table public.vzc_sync_runs enable row level security;
revoke all on table public.vzc_sync_runs from anon, authenticated;
grant select on table public.vzc_sync_runs to anon, authenticated;
drop policy if exists "vzc sync runs read" on public.vzc_sync_runs;
create policy "vzc sync runs read" on public.vzc_sync_runs for select to anon, authenticated using (true);

-- 7. Verizon API token cache — service role only (no grants, deny-all policy for the public roles)
create table if not exists public.vzc_token (
  id smallint primary key default 1 check (id = 1),
  token text not null,
  fetched_at timestamptz not null default now()
);
alter table public.vzc_token enable row level security;
revoke all on table public.vzc_token from anon, authenticated;
drop policy if exists "vzc token no public access" on public.vzc_token;
create policy "vzc token no public access" on public.vzc_token for all to anon, authenticated using (false) with check (false);

-- 8. route-stop view: same columns as v3.8.0, new GPS detail appended at the end
create or replace view public.dispatch_route_stops_v with (security_invoker = true) as
select
  s.id as stop_id, s.task_id, s.seq,
  row_number() over w as stop_number,
  count(*) over (partition by s.task_id) as stop_count,
  s.stop_type, s.location_id, s.location_name, s.location_address, s.material, s.pallet_qty, s.notes, s.status,
  case when lag(s.id) over w is null then t.pickup_name else lag(s.location_name) over w end as prev_location_name,
  case when lag(s.id) over w is null then t.gps_departed_at else lag(s.gps_departed_at) over w end as prev_departed_at,
  s.gps_arrived_at, s.gps_departed_at,
  round(extract(epoch from (s.gps_arrived_at -
    case when lag(s.id) over w is null then t.gps_departed_at else lag(s.gps_departed_at) over w end)) / 60)::integer
    as leg_drive_minutes,
  s.gps_dwell_minutes,
  s.gps_vehicle_id, sv.name as gps_vehicle_name, s.gps_source, s.gps_updated_at,
  t.work_date, t.title as task_title, t.task_type, t.status as task_status, t.is_route, t.combined_into_task_id,
  t.scheduled_at, t.planning_stage, t.sort_order, t.completed_at as task_completed_at,
  t.pickup_name as origin_name, t.pickup_address as origin_address, t.gps_departed_at as origin_departed_at,
  t.assigned_driver_id as driver_id, d.name as driver_name,
  coalesce(ds.vehicle_id, d.default_vehicle_id) as vehicle_id, v.name as vehicle_name,
  -- v3.9.0 additions
  s.gps_engine_off_at, s.gps_engine_on_at, s.gps_idle_minutes, s.gps_engine_off_minutes,
  s.gps_match_method, s.gps_match_distance_m, t.gps_returned_base_at as task_returned_base_at
from public.dispatch_task_stops s
join public.dispatch_tasks t on t.id = s.task_id
left join public.drivers d on d.id = t.assigned_driver_id
left join public.driver_schedule ds on ds.driver_id = t.assigned_driver_id and ds.work_date = t.work_date
left join public.vehicles v on v.id = coalesce(ds.vehicle_id, d.default_vehicle_id)
left join public.vehicles sv on sv.id = s.gps_vehicle_id
window w as (partition by s.task_id order by s.seq, s.id);
revoke all on public.dispatch_route_stops_v from anon, authenticated;
grant select on public.dispatch_route_stops_v to anon, authenticated;

-- 9. scheduler plumbing (installed, NOT scheduled). pg_net does the HTTP call; pg_cron will run it once Jonathan says go.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ------------------------------------------------------------------------------------------------------------
-- Invoke auth (migration "vzc_invoke_token", 2026-10-08): pg_cron → vzc-sync is authenticated with a random token
-- that is generated INSIDE Postgres and kept in Vault as 'vzc_sync_invoke_token'. Nobody types, copies or sees it.
-- The function (deployed with verify_jwt = false) compares the x-vzc-token header against the Vault value
-- (constant-time) and answers 401 to anything else. Rotate: select vault.update_secret(id, encode(extensions.gen_random_bytes(32),'hex'))
-- from vault.secrets where name = 'vzc_sync_invoke_token';  (the function picks the new value up within 5 minutes)
do $tok$
begin
  if not exists (select 1 from vault.secrets where name = 'vzc_sync_invoke_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'vzc_sync_invoke_token',
                                'vzc-sync invoke token (generated in Postgres, never printed)');
  end if;
end $tok$;

-- Service-role-only lookup used by the Edge Function (its built-in SUPABASE_SERVICE_ROLE_KEY client).
create or replace function public.vzc_sync_expected_token()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vzc_sync_invoke_token' limit 1
$$;
revoke all on function public.vzc_sync_expected_token() from public, anon, authenticated;
grant execute on function public.vzc_sync_expected_token() to service_role;

-- pg_cron / SQL editor entry point. p_options is merged into the request body, e.g.
--   select public.vzc_sync_invoke(true, '{"dates":["2026-10-07"],"recompute":true}');
-- (dry_run always comes from p_dry_run; "recompute" is honoured only in dry runs).
drop function if exists public.vzc_sync_invoke(boolean);
create or replace function public.vzc_sync_invoke(p_dry_run boolean default false, p_options jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_tok text; v_id bigint;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'vzc_sync_invoke_token' limit 1;
  if v_tok is null then
    raise notice 'vzc_sync_invoke: Vault secret vzc_sync_invoke_token is missing — nothing called';
    return null;
  end if;
  select net.http_post(
    url := 'https://hqhfstosclasgwgxubip.supabase.co/functions/v1/vzc-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-vzc-token', v_tok),
    body := jsonb_build_object('source', 'pg_cron') || coalesce(p_options, '{}'::jsonb) || jsonb_build_object('dry_run', p_dry_run),
    timeout_milliseconds := 120000
  ) into v_id;
  return v_id;
end $$;
revoke all on function public.vzc_sync_invoke(boolean, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------------------
-- service_role grants (migration "vzc_service_grants", 2026-10-08): this project's default privileges did not give
-- service_role DML, so the function could not read route stops / planned trucks or write its own tables.
-- Least privilege, service_role only (anon/authenticated unchanged).
grant select, update on public.dispatch_task_stops to service_role;          -- read stops, fill empty GPS cols + forward-only status
grant select on public.driver_schedule, public.driver_weekly_schedule, public.driver_daily_vehicle to service_role;  -- planned truck lookup
grant execute on function public.driver_vehicle_for_date(date) to service_role;
grant select, insert, update on public.vehicle_live_location, public.geocode_cache, public.vzc_token to service_role;
grant select, insert, delete on public.vzc_sync_runs to service_role;         -- run log + 14-day prune

-- ============================================================================================================
-- GO-LIVE (do NOT run until Jonathan has reviewed the plan):
--   1) Edge Functions → Secrets: VZC_USERNAME, VZC_PASSWORD, VZC_APP_ID            (Jonathan, in the dashboard)
--      (no service key to copy any more — the invoke token above is created automatically)
--   2) Optional test (writes nothing):  select public.vzc_sync_invoke(true);
--        then: select status_code, content::json->'summary' from net._http_response order by id desc limit 1;
--   3) TURN ON (every 3 minutes, 24/7):
--        select cron.schedule('vzc-sync', '*/3 * * * *', $c$select public.vzc_sync_invoke()$c$);
--   Turn off:  select cron.unschedule('vzc-sync');
-- ============================================================================================================

-- ============================================================================================================
-- v3.10.0 — AUTOMATIC UNPLANNED STOPS (applied 2026-10-08 as migration "unplanned_stops"; additive only)
-- The vzc-sync updater writes here; the dashboard can only read rows and set review_status/reviewed_at.
-- ============================================================================================================
-- v3.10.0 — automatic UNPLANNED STOPS (additive: one new table + grants; no existing table/row/trigger is changed)
create table if not exists public.unplanned_stops (
  id                 bigint generated always as identity primary key,
  work_date          date        not null,
  vehicle_id         bigint      not null references public.vehicles(id),
  driver_id          bigint      references public.drivers(id) on delete set null,          -- null = truck-level (no driver could be inferred)
  task_id            bigint      references public.dispatch_tasks(id) on delete set null,   -- route or single task it happened during (null = driver/truck card)
  after_stop_id      bigint      references public.dispatch_task_stops(id) on delete set null, -- route stop it came after (null = right after the route start)
  arrived_at         timestamptz not null,   -- first stopped point
  engine_off_at      timestamptz,
  engine_on_at       timestamptz,
  departed_at        timestamptz,            -- first moving point ("left"); fills in later
  idle_minutes       integer,
  engine_off_minutes integer,
  location_name      text,                   -- saved/known location within ~250 m, else null
  address            text,                   -- Verizon address
  lat                double precision,
  lon                double precision,
  saved_location_id  bigint      references public.saved_locations(id) on delete set null,
  review_status      text        not null default 'pending' check (review_status in ('pending','kept','ignored')),
  reviewed_at        timestamptz,
  source             text        not null default 'vzc_auto',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint unplanned_stops_vehicle_arrived_key unique (vehicle_id, arrived_at)   -- reruns never duplicate
);
comment on table public.unplanned_stops is 'v3.10.0: stops a truck made that are not on any task (written by vzc-sync, only-fill-empty). Never counted for route completion.';
create index if not exists unplanned_stops_work_date_idx on public.unplanned_stops (work_date);
create index if not exists unplanned_stops_task_idx on public.unplanned_stops (task_id) where task_id is not null;

alter table public.unplanned_stops enable row level security;
drop policy if exists "unplanned stops read" on public.unplanned_stops;
create policy "unplanned stops read" on public.unplanned_stops for select to anon, authenticated using (true);
drop policy if exists "unplanned stops review" on public.unplanned_stops;
create policy "unplanned stops review" on public.unplanned_stops for update to anon, authenticated using (true) with check (true);

revoke all on public.unplanned_stops from anon, authenticated;
grant select on public.unplanned_stops to anon, authenticated;
grant update (review_status, reviewed_at) on public.unplanned_stops to anon, authenticated;   -- dashboard can only Keep/Ignore
grant select, insert, update on public.unplanned_stops to service_role;                     -- the updater
grant select on public.saved_locations to service_role;                                      -- naming stops after saved customers
