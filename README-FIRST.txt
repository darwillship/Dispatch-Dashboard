SHIFT Dispatch v3.12.0 (2026-10-08): GPS TIMES BELONG TO THE RIGHT TASK + AUTO STATUS + TIME OPTIONAL.
- Matching rule (vzc-sync v9): a task/stop only takes truck movement that starts at or after
  min(created_at - 10 min, scheduled time). A task typed in after the fact (no time, or a time at/before the visit) may take
  an earlier visit only if no other task/stop owns it. One physical visit (same truck, arrival within 3 min) has ONE owner -
  visits already saved on any task/stop that day count, so a filled route can no longer lend its stops to a new task.
  Typed (manual) GPS times still win.
- Auto status (single tasks): truck leaves the pickup -> In progress; truck reaches the delivery -> In progress; truck LEAVES the
  delivery -> Completed with completed_at = the arrival time (the driver keeps Missed/Refused for the whole visit). Deliveries to
  McCook complete on arrival. Routes: leaving the start -> In progress (completion still comes from the stops).
  Forward only (Assigned -> In progress -> Completed); never touches Pending/Planned, Completed, anything Missed/Refused
  (driver report, open or resolved), routes 52/58/61/78/98/107/117/140, combined 161/162, or past work dates.
  Auto changes show a small "auto" tag (cards, driver app "auto (GPS)", CSV "Status Source"). Any manual status change
  after an auto change (dashboard Start/Complete, driver Start/Done/Undo) flips it to manual and the updater stops for that task.
  DB: dispatch_tasks.status_source / status_auto_at, trigger dispatch_tasks_status_manual, rpc vzc_auto_status (service_role only).
- Task form: Date (defaults to today's board) + optional Time. Blank time = "ASAP" (scheduled_at stays empty). The ASAP button
  clears a time. Cards, driver app and CSV show ASAP; quick paste without "@ time" is ASAP too (was 8:00 AM).

SHIFT Dispatch v3.11.0 (2026-10-08): AUTOMATIC TRUCK ASSIGNMENT + unplanned stops follow the schedule.
- When a truck starts and exactly one scheduled, on-shift driver has no truck, the Verizon updater (vzc-sync) sets that driver's truck for the date. It shows a small "auto" badge on the driver card and in Driver Schedule -> Daily Overrides; changing the truck there makes it a manual pick, which is never overwritten.
- If two or more drivers fit, nothing is assigned. A blue strip asks "Big Blue started 5:02 AM. Juan or Jay?" - one click sets it, the X leaves it unassigned. One decision per truck per date, so it never asks again.
- A Time Sheet clock-in or pre-trip naming the truck within 30 minutes of the start wins (it must name a real truck, e.g. "McCook Van").
- Unplanned stops are re-checked every run: a stop with no driver (or a driver who no longer matches) moves to whoever had that truck on shift then, using shift times with a 1-hour grace (overnight shifts like Jay's 9:00 PM-5:30 AM keep their after-midnight stops, dated to the shift's day). Kept/Ignored is never touched.
- Only ignitions from the last 3 hours are auto-assigned, so turning this on never back-fills old days.

SHIFT Dispatch v3.10.0 (2026-10-08): AUTOMATIC UNPLANNED STOPS.
The Verizon updater (vzc-sync, every 3 min) now logs any stop where a truck sat with the engine OFF for 5+ minutes
away from McCook base, the truck's overnight spot and every planned task/stop that day. Saved in public.unplanned_stops
(name = saved location / built-in Darwill site within 250 m, else the Verizon address; arrived, engine off/on, left,
idle and engine-off minutes, truck). Board:
  - during a route  -> dashed amber row inside the route card, right after the stop it followed (time order)
  - during a single task -> dashed block at the bottom of that card (the task is NOT turned into a route)
  - otherwise -> "Unplanned activity" card in the driver column, or the truck list under the live fleet strip
  - "✓ Keep" / "✕ Ignore" on each row; ignored rows hide behind "Show ignored (n)".
Unplanned stops never block or count toward route completion. Tasks CSV gets "Unplanned" + "Unplanned Review"
columns and one extra row per unplanned stop. Tune the threshold in supabase/functions/vzc-sync/unplanned.ts
(UNPLANNED_MIN_OFF_MIN). Table SQL is at the end of SUPABASE-VZC-SYNC.sql.

SHIFT Dispatch v3.9.1 (2026-10-08): live truck chip shows the date when the last Verizon report is not from today (CT),
e.g. "⚫ Engine off since Wed 10/7, 11:45 AM" (same for "⚠ Moving · last GPS …"). Stale-flag logic unchanged.

SHIFT Dispatch v3.9.0 — Live truck status + automatic Verizon Connect GPS updater (built, NOT scheduled yet)

v3.9.0 (2026-10-08):
- Live truck chip next to each driver's truck ("🟢 Moving 34 mph", "🟡 Idle", "⚫ Engine off since 9:36 AM",
  "⚠ GPS feed paused"/"⚠ … · last GPS" when data is >10 min old, "📡 Waiting for GPS" until the updater runs),
  plus a "🛰 Trucks" strip under the toolbar with every truck's status and address. Read-only (live-features.js,
  table vehicle_live_location). Tooltips/CSV also show the new GPS detail: engine on at origin, engine off/on,
  engine-off vs idle minutes on site, back at McCook, match method/distance.
- Supabase Edge Function vzc-sync (supabase/functions/vzc-sync/, migration SUPABASE-VZC-SYNC.sql) reads Verizon Connect
  Reveal (Fleetmatics REST) and fills GPS times on today's (and before noon, yesterday's) tasks and route stops.
  It only fills columns that are still empty (manual values are never overwritten), never writes gps_drive_minutes /
  gps_dwell_minutes, skips combined originals, and changes only times + route-stop status (pending→arrived→done,
  forward only). Single-task status and stuck in_progress routes are never touched.
  dry_run is the default: only {"dry_run": false} (the cron invoke) writes.
- New columns: dispatch_tasks gps_origin_engine_on_at, gps_engine_off_at, gps_engine_on_at, gps_idle_minutes,
  gps_engine_off_minutes, gps_returned_base_at, gps_match_method, gps_match_distance_m; dispatch_task_stops
  gps_engine_off_at, gps_engine_on_at, gps_idle_minutes, gps_engine_off_minutes, gps_match_method, gps_match_distance_m;
  vehicles.vzc_vehicle_number. New tables: vehicle_live_location, geocode_cache, vzc_sync_runs, vzc_token (service only).
- Secrets (never in the repo/chat): Supabase Dashboard → Edge Functions → Secrets: VZC_USERNAME
  (REST_DarwillDispatchDashboard_6200@1185217.com), VZC_PASSWORD, VZC_APP_ID. Optional: VZC_EXCLUDE_DRIVER_IDS
  (comma list), VZC_ALLOW_OTHER_TRUCK=1. Until they are set the function answers 503 "missing VZC_USERNAME/VZC_PASSWORD".
- Invoke auth: the function runs with verify_jwt = false and only accepts header x-vzc-token equal to the Vault secret
  'vzc_sync_invoke_token' (64 hex chars generated inside Postgres — nobody copies or sees it), or the exact service_role
  key as Bearer. Everything else gets 401. public.vzc_sync_invoke() sends the token; it is not callable by anon/authenticated.
- Dry test (writes nothing):  select public.vzc_sync_invoke(true);   any date, ignoring stored times:
    select public.vzc_sync_invoke(true, '{"dates":["2026-10-07"],"recompute":true}');
  then: select status_code, content::json->'summary' from net._http_response order by id desc limit 1;
- Go live (NOT done yet): select cron.schedule('vzc-sync', '*/3 * * * *', $c$select public.vzc_sync_invoke()$c$);
  Stop: select cron.unschedule('vzc-sync');   (GO-LIVE block at the bottom of SUPABASE-VZC-SYNC.sql)
- Deploy (bundle keeps the upload small): deno bundle --minify --external 'npm:*' -o index.js supabase/functions/vzc-sync/index.ts
  then deploy index.js as the function's index.ts with verify_jwt OFF (the function checks x-vzc-token itself).

SHIFT Dispatch v3.8.0 — Multi-stop routes

v3.8.0 (2026-10-07):
- A task can be a ROUTE: its Pickup is the start, then any number of stops (table dispatch_task_stops, see SUPABASE-ROUTES.sql).
  Tasks without stops work exactly as before.
- Task create/edit: "+ Add stop" → stop list (saved/built-in or typed location, type pickup/delivery/both, material,
  pallets, notes). Reorder with drag ⋮⋮ or ↑/↓; ✕ removes a stop. The first "+ Add stop" keeps the Delivery as stop 1.
- "⛓ Combine into route" (toolbar): tap 2+ tasks in route order → Combine… → pick date/driver (truck follows Driver
  Schedule) → Create route. Stops are copied from each task's pickup + delivery; back-to-back visits to the same place
  merge; pickups at the start location load up front (checkbox). Originals are hidden (not deleted) — "Show combined"
  shows them with "↩ Restore".
- Route cards list the stops with GPS leg timings, e.g. "Federal Envelope 2:49–3:00 PM (51 min drive, 11 min on site)",
  and a status chip per stop (tap: pending → arrived → done). When every stop is done the route completes automatically
  (database trigger; completed_at = final stop's GPS arrival when known).
- Route History → Export tasks CSV: one row per stop for routes (normal tasks keep one row; stop columns are blank).
- GPS bot: per-stop times go to dispatch_task_stops (gps_arrived_at, gps_departed_at, gps_vehicle_id, gps_source,
  gps_updated_at, status); leg/dwell minutes come from view dispatch_route_stops_v. Route start departure stays on
  dispatch_tasks.gps_departed_at.

SHIFT Dispatch v3.7.0 — Verizon Connect Reveal GPS stop times

v3.7.0 (2026-10-07):
- dispatch_tasks has GPS columns written by the Darwill Verizon GPS bot (see SUPABASE-GPS-TIMES.sql):
  gps_departed_at, gps_arrived_at, gps_left_destination_at, gps_vehicle_id (-> vehicles), gps_source, gps_updated_at,
  plus generated gps_drive_minutes (arrived - departed) and gps_dwell_minutes (left destination - arrived).
- Task cards show "📍 Left 9:12 AM · Arrived 10:03 AM · 51 min drive · 21 min on site · Big Gray" (Central time);
  hover for full stamps. Edit Task shows the same line read-only (never saved by the form).
- Route History shows the GPS line per completed route and has "Export tasks CSV" (date range, all statuses, GPS columns in CT).
- Time Sheets → Activities CSV now includes the linked task's route and GPS columns.
- Dashboard writes to dispatch_tasks are partial updates of the fields they change, so they never overwrite gps_* values.
  Status / completed_at behavior is unchanged (the bot sets status='completed' and completed_at itself).

SHIFT Dispatch v3.6.0 — Trucks per driver (Verizon Connect Reveal names)

v3.6.0 (2026-10-07):
- vehicles now holds the 7 Reveal trucks: Big Blue, Big Gray, Frey, Hillside Van, McCook Van, Sterling, White Panel Truck.
- Driver Schedule → Weekly Schedule: "Default truck" per driver (saves immediately → drivers.default_vehicle_id).
- Driver Schedule → Daily Overrides: "Truck" per driver/date (→ driver_schedule.vehicle_id, saved with Save Overrides;
  picking a truck turns Override on for that date).
- Driver card header shows the truck for the board date ("🚛 Big Blue", tagged "this date" when it is a daily override).
- GPS bot lookup: view driver_daily_vehicle / function driver_vehicle_for_date(date) — see SUPABASE-TRUCKS.sql.

SHIFT Dispatch v3.5.0 — Driver Time Sheet integration

v3.5.0 (2026-10-07):
- Driver cards (today's board) show live activity from the Driver Time Sheet app, e.g. "🚚 Driving · 0:42",
  "🍽️ On lunch · 0:12", "⏳ Waiting – Dock busy · 0:08". Hidden when stale (>12 h) or when the driver is idle.
- Driver cards show "🕒 On since 6:58 AM · 5h 12m" while a time sheet shift is open, or
  "✓ Off the clock · worked 8h 32m" after End Shift.
- New "Time Sheets" button: shifts by date range with per-driver totals, activity drill-down,
  read-only printable pre-trip inspections, and CSV export (shifts, activities, pre-trips).
- All of this is read-only from the dashboard (timesheet-features.js performs no writes).
- Supabase: driver_live_status grants + new tables driver_shifts / driver_activities / driver_pretrips
  (see SUPABASE-TIMESHEETS.sql — already applied). Pre-trips are insert-only for the apps (DOT retention).


v3.4.1: Driver texting and driver links were REMOVED from the dashboard (no assign→Text/Share panel,
no "📱 Driver link" buttons). Drag-and-drop assignment works as before. driver.html stays in the repo but
is no longer linked from the dashboard.

No Supabase changes required (optional audit table: SUPABASE-DRIVER-APP.sql).

New in v3.4.0 (full details: DRIVER-APP.md):
- driver.html — phone page per driver (driver.html?d=<id>): stops, maps, Start / DONE / Missed / Refused.
- (Removed in v3.4.1) Dropping a task onto a driver used to pop a Text/Share/Copy message panel.
- DONE writes completed + completed_at, so the dashboard card turns green.
- Missed/Refused create a high-priority reminder and a red Driver Alerts bar on the dashboard.
- SHIFT_createTask(...) / ?createTask= / REST insert to drop jobs into Ready to Assign.
- Quick paste of one address line (Ready column + task modal).
- Driver cards: start time, assigned / in progress / waiting-on-Done counts; completed cards fold away.
- Suggest order (from History, only applied after you accept).
- Location search, Task Type no longer defaults to shuttle, one driver status field.

Files: index.html, shift-features.js, timesheet-features.js, truck-features.js, gps-features.js, routes-features.js, live-features.js, driver.html, sw.js, driver-manifest.webmanifest, icons/, supabase/functions/vzc-sync/ (Edge Function), SUPABASE-*.sql (migrations, incl. SUPABASE-VZC-SYNC.sql).
