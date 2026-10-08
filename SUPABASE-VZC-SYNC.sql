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

-- v3.11.0 — automatic TRUCK ASSIGNMENT (additive: 2 columns + 1 trigger on driver_schedule, 1 new table, grants; no existing row is changed). Applied as migration "v311_truck_auto_assign" 2026-10-08.

-- 1. How a driver_schedule truck was chosen.
alter table public.driver_schedule add column if not exists vehicle_source text
  check (vehicle_source in ('auto_gps','manual'));
alter table public.driver_schedule add column if not exists auto_assigned_at timestamptz;
comment on column public.driver_schedule.vehicle_source is 'v3.11.0: auto_gps = set by vzc-sync from a truck ignition; manual = picked or cleared by dispatch. NULL on rows that predate this.';

-- 2. A truck change from the dashboard (which never sends vehicle_source) is a manual pick (clearing it too).
--    The updater sends vehicle_source = auto_gps itself; it may only fill an empty, non-manual slot.
create or replace function public.driver_schedule_vehicle_source()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    if new.vehicle_id is not null and new.vehicle_source is null then new.vehicle_source := 'manual'; end if;
    if new.vehicle_source is distinct from 'auto_gps' then new.auto_assigned_at := null; end if;
    return new;
  end if;
  if new.vehicle_source = 'auto_gps' and old.vehicle_source is distinct from 'auto_gps' then
    if old.vehicle_id is not null or old.vehicle_source = 'manual' then
      new.vehicle_id := old.vehicle_id; new.vehicle_source := old.vehicle_source; new.auto_assigned_at := old.auto_assigned_at;
    end if;
    return new;
  end if;
  if new.vehicle_id is distinct from old.vehicle_id and new.vehicle_source is not distinct from old.vehicle_source then
    new.vehicle_source := 'manual';
    new.auto_assigned_at := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists driver_schedule_vehicle_source_trg on public.driver_schedule;
create trigger driver_schedule_vehicle_source_trg
  before insert or update on public.driver_schedule
  for each row execute function public.driver_schedule_vehicle_source();

-- 3. One decision per truck per date: an auto-assignment, or a question for dispatch when 2+ drivers fit.
create table if not exists public.vehicle_assignment_suggestions (
  id                   bigint generated always as identity primary key,
  work_date            date   not null,
  vehicle_id           bigint not null references public.vehicles(id),
  ignition_at          timestamptz,
  candidate_driver_ids bigint[] not null default '{}',
  status               text   not null default 'pending' check (status in ('pending','auto_assigned','accepted','dismissed')),
  chosen_driver_id     bigint references public.drivers(id),
  reason               text,
  created_at           timestamptz not null default now(),
  resolved_at          timestamptz,
  constraint vehicle_assignment_suggestions_date_vehicle_key unique (work_date, vehicle_id)
);
comment on table public.vehicle_assignment_suggestions is 'v3.11.0: one row per truck per date. pending = dashboard asks who started it; auto_assigned = the only on-shift driver without a truck got it.';

alter table public.vehicle_assignment_suggestions enable row level security;
drop policy if exists "truck suggestions read" on public.vehicle_assignment_suggestions;
create policy "truck suggestions read" on public.vehicle_assignment_suggestions for select to anon, authenticated using (true);
drop policy if exists "truck suggestions resolve" on public.vehicle_assignment_suggestions;
create policy "truck suggestions resolve" on public.vehicle_assignment_suggestions for update to anon, authenticated using (true) with check (true);

revoke all on public.vehicle_assignment_suggestions from anon, authenticated;
grant select on public.vehicle_assignment_suggestions to anon, authenticated;
grant update (status, chosen_driver_id, resolved_at) on public.vehicle_assignment_suggestions to anon, authenticated;
grant select, insert, update on public.vehicle_assignment_suggestions to service_role;

-- 4. What the updater needs (this project's default privileges don't grant it).
grant select on public.driver_shifts, public.driver_pretrips to service_role;
grant insert (work_date, driver_id, status, start_time, end_time, note, vehicle_id, vehicle_source, auto_assigned_at) on public.driver_schedule to service_role;
grant update (vehicle_id, vehicle_source, auto_assigned_at) on public.driver_schedule to service_role;


-- ========== v3.12.0 auto GPS status (applied via apply_migration v312_auto_status) ==========
-- v3.12.0: auto GPS status + source so a later manual change wins.
-- status_source: null = never auto'd (updater may act); 'auto_gps' = updater wrote it (updater may advance);
-- 'manual' = a person (dashboard Start/Complete or driver Start/Done/Undo) overrode auto — updater never touches again.
alter table public.dispatch_tasks
  add column if not exists status_source text,
  add column if not exists status_auto_at timestamptz;
do $fn$ begin
  if not exists (select 1 from pg_constraint where conname = 'dispatch_tasks_status_source_chk') then
    alter table public.dispatch_tasks
      add constraint dispatch_tasks_status_source_chk
      check (status_source is null or status_source in ('auto_gps','manual'));
  end if;
end $fn$;
comment on column public.dispatch_tasks.status_source is 'null | auto_gps | manual — GPS updater only writes when null or auto_gps; a person setting status flips auto_gps → manual via trigger';
comment on column public.dispatch_tasks.status_auto_at is 'when the GPS updater last auto-wrote status (dashboard can show an "auto" hint)';

-- When status changes on an auto_gps row and the writer is not the updater (it always bumps status_auto_at), the row becomes manual.
-- Dashboard / driver only send {status[, completed_at]}, so auto → manual and they win forever.
create or replace function public.dispatch_tasks_status_manual()
returns trigger language plpgsql set search_path to '' as $fn$
begin
  -- updater writes always bump status_auto_at; nested updates (route-complete stop trigger) stay automatic
  if new.status is distinct from old.status
     and new.status_auto_at is not distinct from old.status_auto_at
     and old.status_source = 'auto_gps'
     and pg_trigger_depth() < 2 then
    new.status_source := 'manual';
  end if;
  return new;
end $fn$;
drop trigger if exists dispatch_tasks_status_manual on public.dispatch_tasks;
create trigger dispatch_tasks_status_manual
  before update of status on public.dispatch_tasks
  for each row execute function public.dispatch_tasks_status_manual();

-- Atomic auto-status write with every hard guard. Returns a short action string for the run log.
-- Never moves status backwards. Never touches protected ids, past work_dates, manual overrides,
-- or tasks the driver flagged Missed/Refused (any shift_reminders note, open or resolved).
create or replace function public.vzc_auto_status(p_task_id bigint, p_to text, p_completed_at timestamptz default null)
returns text language plpgsql security definer set search_path to '' as $fn$
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
     where id = p_task_id and status = 'assigned'
       and (status_source is null or status_source = 'auto_gps');
    get diagnostics n = row_count;
    return case when n > 0 then 'updated → in_progress' else 'race: no row' end;
  end if;
  -- completed
  if coalesce(r.status,'') not in ('assigned','in_progress') then return 'ignored: from=' || coalesce(r.status,'null'); end if;
  update public.dispatch_tasks
     set status = 'completed',
         completed_at = coalesce(completed_at, p_completed_at, now()),
         status_source = 'auto_gps',
         status_auto_at = clock_timestamp()
   where id = p_task_id and status in ('assigned','in_progress')
     and (status_source is null or status_source = 'auto_gps');
  get diagnostics n = row_count;
  return case when n > 0 then 'updated → completed' else 'race: no row' end;
end $fn$;
revoke all on function public.vzc_auto_status(bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.vzc_auto_status(bigint, text, timestamptz) to service_role;
