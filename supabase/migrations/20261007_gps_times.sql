-- SHIFT Dispatch v3.7.0 — Verizon Connect Reveal GPS stop times on dispatch tasks.
-- Applied to project hqhfstosclasgwgxubip on 2026-10-07 as migration "dispatch_tasks_gps_times".
-- Additive only: new nullable columns + one index. No backfill; existing rows unchanged (all new columns NULL).
--
-- Written by the GPS bot (its Supabase connector runs as the owner role):
--   gps_departed_at, gps_arrived_at, gps_left_destination_at, gps_vehicle_id, gps_source, gps_updated_at
--   (the bot also sets status='completed' and completed_at = gps_arrived_at itself).
-- NEVER send gps_drive_minutes / gps_dwell_minutes: they are GENERATED ALWAYS columns (writes are rejected).

alter table public.dispatch_tasks
  add column if not exists gps_departed_at timestamptz,          -- left the origin / pickup
  add column if not exists gps_arrived_at timestamptz,           -- arrived at the destination / delivery
  add column if not exists gps_left_destination_at timestamptz,  -- left the destination
  add column if not exists gps_vehicle_id bigint references public.vehicles(id) on delete set null,
  add column if not exists gps_drive_minutes integer generated always as
    (round(extract(epoch from (gps_arrived_at - gps_departed_at)) / 60)::integer) stored,
  add column if not exists gps_dwell_minutes integer generated always as
    (round(extract(epoch from (gps_left_destination_at - gps_arrived_at)) / 60)::integer) stored,
  add column if not exists gps_source text,
  add column if not exists gps_updated_at timestamptz;

-- Default set AFTER the column exists so existing rows stay NULL (ADD COLUMN ... DEFAULT would fill every existing row).
alter table public.dispatch_tasks alter column gps_source set default 'verizon_reveal';

create index if not exists dispatch_tasks_gps_vehicle_idx on public.dispatch_tasks (gps_vehicle_id);

-- Permissions: unchanged. dispatch_tasks already has the "Allow dashboard access during testing" policy (ALL, true)
-- and table-level grants for anon/authenticated, so the new columns inherit the existing access. Nothing widened.
