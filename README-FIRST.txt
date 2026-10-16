SHIFT Dispatch v4.3.2 (Oct 12, 2026): Messenger button visible on Plan & Prepare cards; Quick Delivery hidden from driver cards (drivers.is_messenger, record kept) and listed under Messengers; driver cards pack masonry-style; open ⋯ stays open through the 20 s auto-refresh.

SHIFT Dispatch v4.3.1 (Oct 12, 2026): ⋯ menus are floating popovers (fixed, kept inside the window, close on outside click / Esc). Bottom Trucks bar removed; truck status (In Service / Out / Repair) is in Driver Schedule → Truck Schedule. Driver-unknown stops = one expandable line at the bottom (only when there are some). Driver cards show "✓ N done today" and "📍 N detected stops" folds again.

SHIFT Dispatch v4.3.0 (Oct 12, 2026): simple board — one card per driver (big name + current truck with one dot: green moving / grey parked / red out of service). Everything else (address, live status, counts, shift, switch truck, truck pick, detected stops, done tasks) in the card ⋯ menu; task Edit/Delete/Messenger/driver in the task ⋯. Drop on a driver = driver + their current truck (moving -> In Progress). Bottom: Trucks line (trucks without driver / out of service, ⚙ status, Driver-unknown stops), Not working line, Messengers. Stats = one text line. No data/schema change.

SHIFT Dispatch v4.2.1 (Oct 12, 2026): layout fix — Plan & Prepare 300px + truck cards in a wrapping grid (min 280px each); driver picker full-width on its own line; single column under 900px.

SHIFT Dispatch v4.2.0 (Oct 12, 2026)
- Today's crew strip removed (availability: Driver Schedule -> Daily Overrides). "Driver, no truck yet" card only when needed.
- Ready to Assign column removed: one Plan & Prepare column; cards have Ready? Yes/No (planning_stage ready/brainstorm; old Ready to Assign tasks show Ready = Yes, listed first). Quick paste box moved above Plan & Prepare.
- Truck status (⚙ on each truck card): In Service / Out of Service / At Repair Shop + note + since date (table public.vehicle_status). Out-of-service trucks are greyed with a badge, refuse drops, no driver picker, no overlap / "No driver scheduled" warnings.
- Driver picker on each truck card: saves a Daily Override (driver_schedule.vehicle_id, vehicle_source=manual) for that date; warns if the driver is on another truck or someone else is scheduled on it.
- vzc-sync v12: detected stops of yesterday are saved too while the cron still covers yesterday (before noon) — fixes stops that start late evening and run past midnight never being saved. Dry runs add summary.dates[].stop_audit (every Verizon stop with its verdict).

SHIFT Dispatch v4.1.0 (Oct 12, 2026) — board cleanup
- Messenger button only on tasks still in Plan & Prepare / Ready to Assign (no driver, no truck).
- Driver names on truck cards bigger and bolder; the one on shift now is largest (green).
- Drag a task onto a truck that is driving right now (Verizon: Moving, report <= 10 min old, board on today) -> it goes straight to In Progress.
- Declutter: "Unassigned & drivers" replaced by a one-line "Today's crew" strip (availability dropdown kept; drop a task on a name to give it to that driver without a truck). A "Driver, no truck yet" card shows only when such tasks exist. Detected stops fold into one line per truck (tap to open). Zero counters hidden.
- Truck switch: "⇄ Switch truck" on the on-shift driver chip. Pick new truck + time; open tasks move; completed tasks and stops stay. Both cards show "switched at HH:MM"; Undo on the new card. Saved in public.truck_switches (never deleted; Undo sets active=false). vzc-sync splits the shift at the switch time; overlap with another scheduled driver shows a warning (not blocked) and stops in the overlap are Driver unknown.

SHIFT Dispatch v4.0.1 (Oct 12, 2026): a task without a time now shows "No time set" (grey) instead of an orange "ASAP" that looked like a priority. Priority was always saved correctly; the HIGH badge is the only urgency marker. Quick paste still turns the word ASAP/urgent/rush into High priority.

SHIFT Dispatch v4.0.0 (Oct 12, 2026)
====================================
Board = one card per truck (7 Verizon trucks): tasks, live Verizon status + location, the drivers scheduled on it
(green dot = on shift now), overlap warnings, and the day's automatically detected stops (separate; never count toward
completion). The horizontal Trucks strip, Keep / Ignore, "to review", "Show ignored" and the "Who started this truck?"
prompt are gone (review_status data is kept; previously ignored stops still show, marked "marked ignored earlier").
- Drag a task onto a truck -> dispatch_tasks.vehicle_id + assigned_driver_id (the driver scheduled on that truck;
  change it with the 👤 picker on the card). Tasks keep their stored truck; schedule changes never move them.
- "Unassigned & drivers": drivers on the board today (availability select), tasks with a driver but no truck.
- 🛵 Messenger on any card -> Assign to Messenger dialog (saved or new messenger, optional confirmation number and
  cost). Messenger tasks live in "Messengers": no truck, no GPS tracking, status set by hand (Assigned → In Progress → Completed).
- Driver Schedule → 🚛 Truck Schedule (new first tab): recurring shifts = driver + truck + weekdays + start/end (CT).
  Overnight shifts belong to their start day. Overlaps and gaps are flagged. Daily Overrides still win for their date
  (an override truck counts only if picked by a person; v3.11 "auto" picks are shown as "auto · not used").
  "Weekly Hours" (old Weekly Schedule) still feeds the Driver App.
- Detected stop -> ✎ Edit location name: saved team-wide in named_places (70 m radius, nearest place wins). Verizon
  address and times are kept on the stop.
- Driver of a stop = the ONE driver clearly scheduled on that truck at that moment (no 1-hour grace). Otherwise "Driver unknown".
- CSV: new columns Truck, Messenger, Confirmation Number, Messenger Cost.
Database (migration v400, additive): tables truck_schedules, messengers, named_places; dispatch_tasks.vehicle_id,
messenger_id, confirmation_number, messenger_cost; unplanned_stops.named_place_id. vzc_auto_status refuses messenger tasks.
GPS updater vzc-sync v10: strict schedule driver resolution, auto truck assignment retired, prefers the task's
vehicle_id, skips messenger tasks, names stops from named_places, never overwrites a stored stop driver.

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

v4.4.0 (Oct 12, 2026)
- New Trucks page (trucks.html, "Trucks" button in the board header): every truck with live status,
  speed, address, last report, current driver, service status (editable), today's tasks/done, detected stops.
  Refreshes every 30 s. Engine hours / odometer are not in the live Verizon feed, so they are not shown.
- Faster Verizon updates: new cron job "vzc-sync-live" refreshes live truck locations only (7 Verizon
  calls, about 1 s) in the two minutes between the normal 3-minute full sync. Truck positions now update
  every minute. Overlap guard: table vzc_sync_lock; a live run skips while a full run is going, and
  full runs never overlap each other.
- ROLLBACK: run   select cron.unschedule('vzc-sync-live');   (positions go back to every 3 min).
  The function change is harmless without that job; to fully revert, redeploy the v12 vzc-sync bundle.

v4.4.1 (Oct 13, 2026)
- ⋯ menus open on the first click/tap (the card's hover lift was hiding the floating menu).
- Plan & Prepare: Ready Yes = green, No = grey; ready cards get a green edge + READY badge right away.
  Messenger button sits on its own row.
- GPS auto-complete rules (vzc-sync v14): only GPS after the task was created AND assigned counts
  (new column dispatch_tasks.assigned_at, stamped by trigger when a driver/truck is set).
  DELIVERY = completed on arrival at the delivery address. PICKUP = completed on arrival back at McCook,
  only after the truck left the pickup address. No more "after-the-fact" matches.
  Rollback: redeploy the v13 bundle (assigned_at column is harmless if left).

v4.5.0 (Oct 13, 2026)
- ETAs (eta.js): In Progress tasks show "About N min to <place>" on the board and on trucks.html.
  Target: pickup address until the truck has left it, then McCook; delivery address; routes = next stop not done.
  Estimate = 5 min + straight-line km x 1.0 (x1.2 at 7-9 AM and 3-6 PM). No routing service or API key.
  Hidden when the truck's GPS is older than 10 min; "At <place>" when parked at the target or another known stop.
  Backtest on 13 real trips (Sep 20-Oct 13): median error ~7 min, 8 of 13 within 10 min.

v4.6.0 (Oct 13, 2026)
- Trucks page: every stop of the day under each truck (collapsible, newest first, day picker).
  A stop = the truck sat still 2+ minutes. Type Idle (engine on) or Engine off; location name from Named Places /
  saved locations / task addresses, else the Verizon address; category McCook base / Overnight spot / Task stop /
  Detected stop / Stop; driver = driver scheduled on that truck then.
- New table vehicle_stop_events (written by vzc-sync v16 during its normal track reads, no extra Verizon calls).
  Rows are never deleted: a stop that a later recompute merges away gets superseded_at.
  History starts Oct 13, 2026.

v4.7.0 (2026-10-15) — trucks come from pre-trips
- Driver cards show where the truck came from: "Pre-trip 6:52 AM" / "Set by hand" / "Scheduled" ("Scheduled, no pre-trip" when the driver has not done one yet).
- Rule (same in the board, trucks.html and the GPS updater, from DB function driver_truck_events):
  latest pre-trip today (a second pre-trip = truck switch) > a truck set by hand AFTER that pre-trip > Truck Schedule > none.
  Two drivers on one truck: the later one wins; the other driver's card says "truck taken by X at HH:MM".
  Overnight shifts keep the truck past midnight. A pre-trip up to 3 h before a shift gives the whole shift that truck.
- "Set truck by hand" (driver card ⋯ menu, and the truck card driver picker) replaces "Switch truck now" and the old pickers.
  It saves a Daily Override; not-started tasks with a fixed truck move with the driver. Old truck switches still count and can still be undone.
- When a pre-trip changes a driver's truck, their not-started tasks move with them automatically (DB trigger, logged in pretrip_task_moves);
  the task card shows "Moved to <truck> by pre-trip HH:MM".
- New page pretrips.html (header → Pre-trips): read-only list, filters, full checklist, print / save PDF.
- Old app truck names map to dashboard trucks only where certain (table vehicle_name_map). Unmapped: Sterling 65, Sterling 66, International, Freightliner, Semi-Truck.
Rollback: redeploy vzc-sync from /tmp/up16 (v4.6.0) and revert this commit; the new DB objects are additive and can stay.

v4.7.1 (2026-10-16) — pre-trips as exceptions
- Pre-trips page and Time Sheets → Pre-Trips tab show one row per pre-trip: driver, truck, time and either ✅ All OK or the Issues
  (only failed / needs-attention items, defects, driver remarks). Remarks that describe a problem while no defect is marked = amber "Check remarks".
- "Issues only" filter on both. Full DOT checklist only behind "View full pre-trip" (still Print / Save PDF).
- Driver cards: small "✅ Pre-trip OK" / "⚠ Pre-trip issues" badge (latest pre-trip that day) linking to the Pre-trips page.
- Rule lives in pretrip-exceptions.js. Read-only; pre-trips are never edited.

v4.8.0 (2026-10-16) — Map page (map.html, header → Map)
- Left: the same tasks as the board for the chosen day (same Supabase data, refresh every 20 s). Right: Leaflet + OpenStreetMap tiles.
  Pins per task: nA = start/pickup, nB = delivery (route stops n.1, n.2…), coloured by status, straight dashed line A→B.
  Click a task -> its pins light up / map zooms; click a pin -> the task lights up in the list. McCook base is one fixed marker.
- Live trucks from vehicle_live_location: name, driver (shared rule in truck-shared.js, also used by trucks.html), moving/idling/parked, last GPS report.
- "Closest truck" per open task = straight-line miles from the truck's last GPS point to the next stop. A hint, not drive time.
- Coordinates: edge function map-geocode (cache geocode_cache first; misses use the SAME geocoder as vzc-sync: US Census, then
  OSM Nominatim; max 4 per call, 1.1 s apart, max 30 new per 10 min; only addresses that are on a task/stop). Read-only page otherwise.
- Routing NOT built. Options for later:
  * OSRM public demo (router.project-osrm.org): free, no key, but "no heavy use", no SLA, may block — testing only.
  * OSRM self-hosted (Illinois extract): free software, ~2–4 GB RAM VM ≈ $10–25/month + upkeep; no key; car profile has no truck limits.
  * Mapbox Directions: key needed; 100,000 requests/month free, then about $2 per 1,000; has live-traffic profile.
  * Google Routes/Directions API: key + billing needed; about $5 per 1,000 basic requests ($10 with traffic), monthly free credit;
    note Google terms: Google results should be shown on a Google map, not on OSM tiles.
  * OSM tile server: fine for light office use with attribution; heavy use -> a tile provider (MapTiler/Stadia, free tiers with a key).

v4.8.1 (2026-10-16) — Combine into route: one return to McCook
- New option "Return to McCook once at the end" (on by default): every drop at McCook / the start location goes on ONE final
  return stop after the last pickup (listing each load and source task); a drop at a place that is also a later drop waits for it.
  Example #222, #220, #224 -> Start McCook; 1 Victor; 2 Federal pickup; 3 Envelopes Only pickup; 4 McCook return (#220 4 pal + #224 3 pal).
- Preview stops can be moved with ↑/↓ ("↺ Automatic order" resets); a drop placed before its own pickup is warned about.
- New stops store source_task_ids / source_parts (migration v481_route_stop_sources, additive). Trigger dispatch_task_stops_source_progress:
  when a stop is reached (arrived/done) its pickup parts set the original task In progress and its drop parts complete the original task.
  Routes made before v4.8.1 have no source_parts and are untouched. The route itself still completes when every stop is done.
