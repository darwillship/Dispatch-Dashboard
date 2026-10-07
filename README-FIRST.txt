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

Files: index.html, shift-features.js, timesheet-features.js, driver.html, sw.js, driver-manifest.webmanifest, icons/.
