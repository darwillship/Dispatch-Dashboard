# SHIFT Driver App + Create-Task API — v3.4.0 (dashboard updated to v3.4.1)

> **v3.4.1:** Texting drivers and driver links were removed from the dashboard. The assign→notify panel (Text / Share / Copy / Email / Open driver page) and the **📱 Driver link** buttons on driver cards are gone. Drag-and-drop assignment is unchanged. `driver.html` and its files remain in the repo but are not linked from the dashboard UI. Section 2 below is kept for history only.

Live: https://darwillship.github.io/Dispatch-Dashboard/  ·  Driver page: https://darwillship.github.io/Dispatch-Dashboard/driver.html

No Supabase changes are required. Everything uses the existing tables and the same publishable key already in `index.html`.

## 1. Driver page (`driver.html`)
- Link per driver: `driver.html?d=<driver id>` (e.g. `?d=6` = Mark Baltazar). Opening `driver.html` with no id shows a "tap your name" list and the phone remembers the choice.
- Shows that driver's stops for today in the dispatcher's order: stop #, PICKUP / DELIVERY badge, scheduled time, pallets, pickup + delivery name/address with **Map** buttons, a pickup→delivery **Directions** link, job, material, notes, and the driver's scheduled start/end.
- Auto-refreshes every 20 s and whenever the phone screen comes back on. New stops get a **NEW** badge, a vibration, and a phone notification if the driver tapped **Turn on alerts**.
- Buttons per stop:
  - **Start / On my way** → `status = in_progress` (card turns amber on the dashboard).
  - **✓ DONE** → `status = completed`, `completed_at = now()` (card turns green and folds into "✓ N done today"). Includes a 7-second **Undo**.
  - **Missed / Refused** → asks "what happened?" and inserts a **high-priority row in `shift_reminders`** tagged `[SHIFT-DRIVER task:<id> missed|refused]`. The task itself is not changed.
- Every write is a single-row update guarded by `id` **and** `assigned_driver_id`, so a driver can only change their own stop.
- Install as an app: iPhone → Safari → Share → *Add to Home Screen*. Android → Chrome → ⋮ → *Install app*. (iPhone only allows notifications after it's added to the Home Screen, iOS 16.4+.)

## 2. Notify on assign (dashboard) — REMOVED in v3.4.1
Dragging a card onto a driver still does the assignment (no change to drag-and-drop). As soon as the drop saves, a panel pops up bottom-right with the message ready to send:
- **💬 Text** — opens Messages with the text filled in (stop type, time, pickup, delivery, Google Maps directions link, link to the driver page). Pre-fills the recipient if `drivers.phone` has a number.
- **📤 Share…** (phones/tablets), **📋 Copy**, **✉ Email**, **Open driver page**.
- Each driver card also has **📱 Driver link**, which sends that driver their full list for the day + link.

The driver page reads assignments straight from `dispatch_tasks`, so even without a text the stop is already waiting there when they open it.

## 3. Manager alerts (Missed / Refused)
- A red **🚨 Driver alerts** bar appears above the board with each open alert, plus an **Open** button for the task and a **Resolve** button (marks that one reminder complete).
- The task card gets a red **⚠ missed / refused** tag until it's resolved.
- The alerts also count in the existing **Reminders** badge. Click **🔔 Desktop alerts** to get a browser notification when a new one comes in while the dashboard is open.

## 4. Create-task API / chat hook (Ready to Assign)
Every method below creates: `planning_stage = "ready"`, `status = "pending"`, `assigned_driver_id = null`.

**Defaults**: if one side is missing it's **Darwill McCook** (8701 47th St Ste C, McCook) — that's the origin of 82 of the 112 routes so far. Type is inferred (from McCook = delivery, to McCook = pickup). Time is 8:00 AM on the work date. Priority is normal.

### a) Supabase REST insert (works today, from anywhere — Jarvis, Zapier, curl)
```bash
curl -X POST "https://hqhfstosclasgwgxubip.supabase.co/rest/v1/dispatch_tasks" \
  -H "apikey: sb_publishable_01rvOlUuiba6260MPA1g4A_5oFgpGCk" \
  -H "Authorization: Bearer sb_publishable_01rvOlUuiba6260MPA1g4A_5oFgpGCk" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{
    "work_date": "2026-10-06",
    "title": "Darwill McCook - ALG",
    "pickup_name": "Darwill McCook", "pickup_address": "8701 47th St Ste C, McCook, IL 60525",
    "delivery_name": "ALG", "delivery_address": "1053 N Schmidt Rd, Romeoville, IL 60446",
    "scheduled_at": "2026-10-06T14:00:00Z",
    "task_type": "delivery", "priority": "normal",
    "job_client": null, "material": null, "pallet_qty": 12, "instructions": null,
    "status": "pending", "planning_stage": "ready", "assigned_driver_id": null, "sort_order": 999
  }'
```
Required: `pickup_name`, `delivery_name` (+ addresses), `status`, `planning_stage`. `scheduled_at` is UTC ISO; `work_date` is the board day (YYYY-MM-DD, Chicago).

### b) Inside the dashboard (console / Jarvis browser automation)
```js
await SHIFT_createTask({ line: "ALG, 1053 N Schmidt Rd, Romeoville, IL 60446 @ 9am 12 pallets" });
await SHIFT_createTask({ line: "pickup from Federal Envelope 1:30pm" });
await SHIFT_createTask({ delivery_name: "ENRU", time: "10:00", work_date: "2026-10-06", priority: "high" });
SHIFT_buildTask({ line: "..." })   // preview the row without saving
```
Fields: `line` (free text) or any `dispatch_tasks` column, plus `time` ("HH:MM", local), `side` ("pickup"/"delivery" for `line`).
Line parsing understands: a leading `pickup from …` / `deliver to …`, `@ 9am` / `1:30pm`, `12 pallets` / `skids`, `urgent` / `asap` (= high priority), saved names ("fedex" → FedEx Freight), or `Name, street, city, ST zip`.

### c) URL hook
`https://darwillship.github.io/Dispatch-Dashboard/?createTask=<url-encoded JSON or one line>` — asks you to confirm, saves, then removes the parameter so a refresh can't add it twice.
Example: `?createTask=ALG%20%40%209am`

### d) Same-origin bridges
- `localStorage.setItem("shift-create-task", JSON.stringify({...}))` from another tab on the same site.
- `window.postMessage({type:"SHIFT_CREATE_TASK", task:{...}}, location.origin)` → replies with `SHIFT_TASK_CREATED` or `SHIFT_TASK_ERROR`.

### e) Edge Function (optional, not deployed)
`supabase/functions/create-task/index.ts` is a token-protected POST endpoint. You need the Supabase CLI and to set the `SHIFT_API_TOKEN` secret yourself (instructions are at the top of the file).

### f) Quick paste
- **Ready to Assign** column → "⚡ Paste address line + Enter" adds it right away with defaults.
- **+ Quick Task** modal → "Quick paste" fills the form so you can check it before you save.

## 5. Board changes
- Each driver card shows **⏱ scheduled start · N assigned · N in progress · N waiting on Done**. "Waiting on Done" = the scheduled time has passed and the stop isn't completed yet.
- Completed cards fold into **✓ N done today** under the driver's open stops.
- **⇅ Suggest order** groups the driver's open stops by delivery city. It ranks them by when similar routes usually got done in History (falling back to scheduled time) and estimates ETAs from the driver's start time. You can reorder with ↑/↓. **Nothing changes until you click Accept**, and accepting only changes `sort_order` for that driver's open stops.
- **One driver status**: the status dropdown on the driver card and Driver Schedule → Daily Overrides now save to the same row (`driver_schedule` for that date). **✎ Note** sets that row's note, which shows on the card. Pinned **Driver** notes whose subject matches a driver's name (e.g. "William V.") show on that driver's card when he's on the board. Changing the status dropdown no longer wipes the note.
- Location pickers have a search box. **Task Type** no longer defaults to shuttle: it starts blank ("Choose pickup or delivery…"), is required, and fills itself in when one side is Darwill.

## What Jonathan still needs to provide (for full automation)
| Need | Why | Where |
|---|---|---|
| Driver cell numbers | So **Text** fills in the recipient, and for future automatic SMS | `drivers.phone` column (already exists, all empty now) |
| SMS provider (Twilio etc.) + Edge Function | Sending texts automatically with no tap. Can't be done safely from a static GitHub Pages site | Supabase Edge Function secret |
| Web Push VAPID key pair + a sender (Edge Function) + a `push_subscriptions` table | Real background push when the driver page is closed. `sw.js` already handles `push` events | Supabase |
| Manager channel preference | Missed/Refused currently go to Reminders + the red alert bar on the dashboard. Say if you want SMS/email/Slack too | — |
| (Optional) run `SUPABASE-DRIVER-APP.sql` | Adds a `dispatch_events` audit log (assigned/started/done/missed/refused). The app turns it on by itself once the table exists | Supabase SQL editor |

**Security note:** like the rest of the dashboard, the driver page uses the public key, and Supabase is set to allow public access. Anyone who has a driver link could mark that driver's stops done. Before adding anything sensitive, set up Supabase Auth / per-driver tokens and tighter row-level security.
