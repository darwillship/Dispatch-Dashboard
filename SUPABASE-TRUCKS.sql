-- SHIFT Dispatch v3.6.0 — trucks per driver (for matching dispatch stops to Verizon Connect Reveal GPS history).
-- Applied to project hqhfstosclasgwgxubip on 2026-10-07 as migration "driver_trucks_reveal".
-- Additive only: no rows deleted, dispatch_tasks untouched, no driver/vehicle assignments seeded (all NULL).
--
-- Resolution rule (driver -> truck on a work date):
--   vehicle_id = coalesce(driver_schedule.vehicle_id  [row for that driver + work_date],
--                         drivers.default_vehicle_id)
--   source     = 'override' when the driver_schedule row supplies it, 'default' when the driver default does, NULL if neither.

-- ---------- 1. vehicles: exactly the 7 Reveal trucks ----------
-- Columns insurance_expiration / registration_expiration / safety_inspection_expiration / active already existed (reused).
alter table public.vehicles add column if not exists insurance_expiration date;
alter table public.vehicles add column if not exists safety_inspection_expiration date;
alter table public.vehicles add column if not exists registration_expiration date;
alter table public.vehicles add column if not exists active boolean default true;

-- keep the existing McCook Van row (id 1)
update public.vehicles set active = true, insurance_expiration = date '2027-10-01',
       registration_expiration = date '2026-10-31', safety_inspection_expiration = null
 where id = 1 and name = 'McCook Van';

insert into public.vehicles (name, storage_folder, active, insurance_expiration, safety_inspection_expiration, registration_expiration)
select v.name, v.folder, true, date '2027-10-01', v.safety, v.reg
from (values
  ('Big Blue',          'big-blue',          date '2027-02-19', date '2027-06-30'),
  ('Big Gray',          'big-gray',          date '2027-04-20', date '2027-06-30'),
  ('Frey',              'frey',              date '2027-02-12', date '2027-06-30'),
  ('Hillside Van',      'hillside-van',      null::date,        date '2026-10-31'),
  ('Sterling',          'sterling',          date '2027-02-25', date '2027-06-30'),
  ('White Panel Truck', 'white-panel-truck', date '2027-03-02', date '2027-06-30')
) as v(name, folder, safety, reg)
where not exists (select 1 from public.vehicles x where x.name = v.name);

alter table public.vehicles add constraint vehicles_name_key unique (name);  -- names must match Reveal exactly

-- ---------- 2. assignment columns ----------
alter table public.drivers add column if not exists default_vehicle_id bigint
  references public.vehicles(id) on delete set null;
alter table public.driver_schedule add column if not exists vehicle_id bigint
  references public.vehicles(id) on delete set null;
create index if not exists drivers_default_vehicle_idx on public.drivers (default_vehicle_id);
create index if not exists driver_schedule_vehicle_idx on public.driver_schedule (vehicle_id);
create index if not exists driver_schedule_driver_idx on public.driver_schedule (driver_id);

-- drivers: the dashboard (public key) may update ONLY default_vehicle_id.
revoke update on table public.drivers from anon, authenticated;
grant update (default_vehicle_id) on table public.drivers to anon, authenticated;
drop policy if exists "drivers default truck update" on public.drivers;
create policy "drivers default truck update" on public.drivers
  for update to anon, authenticated using (true) with check (true);
-- driver_schedule: already writable by the dashboard ("driver schedule public testing"); the new column inherits that.
-- vehicles: read-only for the apps ("Allow dashboard to read vehicles" SELECT policy); explicit select grant:
grant select on table public.vehicles to anon, authenticated;

-- ---------- 3. lookup for the GPS bot ----------
-- Function: any date.
create or replace function public.driver_vehicle_for_date(p_work_date date)
returns table (driver_id bigint, driver_name text, driver_active boolean, work_date date,
               vehicle_id bigint, vehicle_name text, vehicle_source text, schedule_status text)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.name, d.active, p_work_date,
         coalesce(ds.vehicle_id, d.default_vehicle_id),
         v.name,
         case when ds.vehicle_id is not null then 'override'
              when d.default_vehicle_id is not null then 'default' end,
         coalesce(ds.status, case when w.working then 'working' else 'off' end)
  from public.drivers d
  left join public.driver_schedule ds on ds.driver_id = d.id and ds.work_date = p_work_date
  left join public.driver_weekly_schedule w on w.driver_id = d.id and w.day_of_week = extract(dow from p_work_date)::int
  left join public.vehicles v on v.id = coalesce(ds.vehicle_id, d.default_vehicle_id)
$$;
revoke execute on function public.driver_vehicle_for_date(date) from public;
grant execute on function public.driver_vehicle_for_date(date) to anon, authenticated;

-- View: one row per driver per date from 2026-01-01 through today + 60 days (always filter on work_date).
create or replace view public.driver_daily_vehicle with (security_invoker = true) as
select d.id as driver_id, d.name as driver_name, d.active as driver_active, g.day::date as work_date,
       coalesce(ds.vehicle_id, d.default_vehicle_id) as vehicle_id,
       v.name as vehicle_name,
       case when ds.vehicle_id is not null then 'override'
            when d.default_vehicle_id is not null then 'default' end as vehicle_source,
       coalesce(ds.status, case when w.working then 'working' else 'off' end) as schedule_status
from generate_series(date '2026-01-01', current_date + 60, interval '1 day') as g(day)
cross join public.drivers d
left join public.driver_schedule ds on ds.driver_id = d.id and ds.work_date = g.day::date
left join public.driver_weekly_schedule w on w.driver_id = d.id and w.day_of_week = extract(dow from g.day)::int
left join public.vehicles v on v.id = coalesce(ds.vehicle_id, d.default_vehicle_id);
grant select on public.driver_daily_vehicle to anon, authenticated;
