SHIFT Dispatch v3.4.0 — Driver App + Done flow

No Supabase changes required (optional audit table: SUPABASE-DRIVER-APP.sql).

New in v3.4.0 (full details: DRIVER-APP.md):
- driver.html — phone page per driver (driver.html?d=<id>): stops, maps, Start / DONE / Missed / Refused.
- Dropping a task onto a driver pops a ready-to-send Text/Share/Copy message with map + driver-page link.
- DONE writes completed + completed_at, so the dashboard card turns green.
- Missed/Refused create a high-priority reminder and a red Driver Alerts bar on the dashboard.
- SHIFT_createTask(...) / ?createTask= / REST insert to drop jobs into Ready to Assign.
- Quick paste of one address line (Ready column + task modal).
- Driver cards: start time, assigned / in progress / waiting-on-Done counts; completed cards fold away.
- Suggest order (from History, only applied after you accept).
- Location search, Task Type no longer defaults to shuttle, one driver status field.

Files: index.html, shift-features.js, driver.html, sw.js, driver-manifest.webmanifest, icons/.
