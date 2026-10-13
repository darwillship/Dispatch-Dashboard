// vzc-sync / sync.ts — Verizon Connect Reveal client + database reads/writes around the pure logic in match.ts.
// Credentials come ONLY from Edge Function secrets (VZC_USERNAME / VZC_PASSWORD / VZC_APP_ID). Nothing secret is logged.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as M from "./match.ts";
import * as U from "./unplanned.ts";
import * as A from "./assign.ts";
import { geocodeAddress } from "./geocode.ts";

const API = "https://fim.api.us.fleetmatics.com";
const TOKEN_TTL_MS = 15 * 60_000;      // Reveal tokens last ~20 min; refresh at 15
const TRACK_REFRESH_MS = 15 * 60_000;  // refetch a parked truck's history at most every 15 min
const MAX_GEOCODES_PER_RUN = 15;
const UNPLANNED_REFRESH_MS = 9 * 60_000;  // trucks not on an open task: re-read their track at most every 9 min while moving
const UNPLANNED_SETTLE_MS = 7 * 60_000;   // ...and once more 7 min after their last report (so a fresh engine-off stop can reach 5 min)
const UP_COLS = ["driver_id", "task_id", "after_stop_id", "engine_off_at", "engine_on_at", "departed_at", "idle_minutes", "engine_off_minutes", "location_name", "address", "lat", "lon", "saved_location_id", "named_place_id"];
const WRITE_MAX_AGE_DAYS = 1;          // writes only for today + yesterday (CT); older dates are dry-run only
// v3.12.0 auto status: never touched by the updater (stuck in_progress routes + the combined pair). Also enforced in SQL (vzc_auto_status).
const AUTO_STATUS_PROTECTED = [52, 58, 61, 78, 98, 107, 117, 140, 161, 162];
const LIVE_STATE: Record<string, string> = { Moving: "Moving", Idle: "Idle", Stop: "Engine off" };
const TASK_COLS = "id,created_at,assigned_at,vehicle_id,messenger_id,title,status,task_type,work_date,scheduled_at,completed_at,assigned_driver_id,pickup_name,pickup_address,delivery_name,delivery_address,is_route,combined_into_task_id,gps_departed_at,gps_arrived_at,gps_left_destination_at,gps_vehicle_id,gps_source,gps_origin_engine_on_at,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_returned_base_at,gps_match_method,gps_match_distance_m";
const STOP_COLS = "id,task_id,seq,location_name,location_address,status,gps_arrived_at,gps_departed_at,gps_vehicle_id,gps_source,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_match_method,gps_match_distance_m";

export interface SyncOptions { liveOnly?: boolean; dryRun: boolean; dates?: string[]; vehicles?: string[]; source?: string; recompute?: boolean; assignSim?: { ignoreTrucksOf: number[]; allDay: boolean } }
export interface Env { username: string; password: string; appId: string; supabaseUrl: string; serviceKey: string; excludeDrivers: number[]; allowOtherTruck: boolean }

// ---------------- Verizon client ----------------
let memToken: { token: string; at: number } | null = null;
class Vzc {
  calls = 0;
  private inflight: Promise<string> | null = null;
  constructor(private env: Env, private db: SupabaseClient, private dryRun: boolean) {}
  private token(force = false): Promise<string> {
    if (!force && memToken && Date.now() - memToken.at < TOKEN_TTL_MS) return Promise.resolve(memToken.token);
    if (!this.inflight) this.inflight = this.fetchToken(force).finally(() => { this.inflight = null; });
    return this.inflight; // single-flight: parallel callers share one token request
  }
  private async fetchToken(force: boolean): Promise<string> {
    if (!force && memToken && Date.now() - memToken.at < TOKEN_TTL_MS) return memToken.token;
    if (!force) {
      const { data } = await this.db.from("vzc_token").select("token,fetched_at").eq("id", 1).maybeSingle();
      if (data && Date.now() - Date.parse(data.fetched_at) < TOKEN_TTL_MS) { memToken = { token: data.token, at: Date.parse(data.fetched_at) }; return data.token; }
    }
    this.calls++;
    const r = await fetch(`${API}/token`, {
      headers: { Authorization: "Basic " + btoa(`${this.env.username}:${this.env.password}`), Accept: "text/plain" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Verizon token request failed: HTTP ${r.status}${r.status === 401 ? " (check VZC_USERNAME / VZC_PASSWORD)" : ""}`);
    const tok = (await r.text()).trim().replace(/^"|"$/g, "");
    memToken = { token: tok, at: Date.now() };
    if (!this.dryRun) await this.db.from("vzc_token").upsert({ id: 1, token: tok, fetched_at: new Date().toISOString() });
    return tok;
  }
  errors: string[] = [];
  // Safe diagnostics for non-OK answers: status, path (no query), Verizon error headers, short body — token/password redacted.
  private async note(path: string, r: Response) {
    let txt = "";
    try { txt = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    if (this.errors.length >= 12) return;
    const hdr = ["x-error-detail-header", "x-mashery-error-code", "x-mashery-error-detail", "retry-after", "www-authenticate"]
      .map((h) => r.headers.get(h) ? `${h}=${r.headers.get(h)}` : "").filter(Boolean).join("; ");
    let msg = `HTTP ${r.status} ${path.replace(/\?.*/, "")} ${hdr} ${txt}`.replace(/\s+/g, " ").trim();
    if (memToken?.token && memToken.token.length >= 8) msg = msg.replaceAll(memToken.token, "***");
    if (this.env.password.length >= 6) msg = msg.replaceAll(this.env.password, "***");
    this.errors.push(msg.slice(0, 400));
  }
  async get(path: string): Promise<{ status: number; body: any }> {
    let renewed = false, force = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const tok = await this.token(force);
      force = false;
      this.calls++;
      const r = await fetch(API + path, {
        headers: { Authorization: `Atmosphere atmosphere_app_id=${this.env.appId}, Bearer ${tok}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 401 && !renewed) { await r.body?.cancel(); memToken = null; renewed = force = true; continue; }
      if ((r.status === 403 || r.status === 429) && attempt < 2) { await this.note(path, r); await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1))); continue; }
      if (r.status === 204) { await r.body?.cancel(); return { status: 204, body: null }; }
      if (!r.ok) { await this.note(path, r); return { status: r.status, body: null }; }
      return { status: r.status, body: await r.json() };
    }
    return { status: 401, body: null };
  }
}
const fmtUtc = (t: number) => new Date(t).toISOString().slice(0, 19);
const encNum = (n: string) => encodeURIComponent(n.trim());

// ---------------- helpers ----------------
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const locAddress = (a: any) => !a ? null : a.AddressLine1?.includes(",") ? a.AddressLine1.replace(/, USA$/, "") : [a.AddressLine1, a.Locality, a.AdministrativeArea].filter(Boolean).join(", ");
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);

// ---------------- main ----------------
/** v4.4.0 overlap guard: one full run at a time; the 1-minute live-only run skips while a full run holds the lock. */
export async function runSync(env: Env, opt: SyncOptions) {
  if (opt.dryRun) return runSyncInner(env, opt);
  const db = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } });
  const name = opt.liveOnly ? "live" : "full", holder = crypto.randomUUID();
  const lk = async (fn: string, args: any) => { const { data, error } = await db.rpc(fn, args); return error ? null : data; };
  if (opt.liveOnly && (await lk("vzc_is_locked", { p_name: "full" })) === true) return { ok: true, live_only: true, skipped: "full run in progress" };
  const got = await lk("vzc_try_lock", { p_name: name, p_secs: opt.liveOnly ? 50 : 170, p_holder: holder });
  if (got === false) {
    if (!opt.liveOnly) await db.from("vzc_sync_runs").insert({ started_at: new Date().toISOString(), finished_at: new Date().toISOString(), dry_run: false, ok: true, api_calls: 0, summary: { ok: true, skipped: "previous full run still running" } });
    return { ok: true, live_only: !!opt.liveOnly, skipped: "previous run still running" };
  }
  try { return await runSyncInner(env, opt); }
  finally { if (got === true) await lk("vzc_unlock", { p_name: name, p_holder: holder }); }
}
async function runSyncInner(env: Env, opt: SyncOptions) {
  const t0 = Date.now(), nowIso = new Date().toISOString();
  const db = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } });
  const vzc = new Vzc(env, db, opt.dryRun);
  const warnings: string[] = [];
  if (env.appId === "DarwillDispatchDashboard") warnings.push("VZC_APP_ID not set — using a placeholder app id");
  const summary: any = { ok: true, dry_run: opt.dryRun, recompute: !!opt.recompute, source: opt.source ?? "manual", started_at: nowIso, warnings, vehicles: [], dates: [] };

  // 1) vehicles with a Reveal number
  const { data: vrows, error: verr } = await db.from("vehicles").select("id,name,vzc_vehicle_number").not("vzc_vehicle_number", "is", null).order("id");
  if (verr) throw new Error("read vehicles: " + verr.message);
  let vehicles = (vrows || []) as { id: number; name: string; vzc_vehicle_number: string }[];
  if (opt.vehicles?.length) { const want = opt.vehicles.map((s) => String(s).toLowerCase()); vehicles = vehicles.filter((v) => want.includes(String(v.id)) || want.includes(v.name.toLowerCase())); }
  const { data: liveRows, error: lerr } = await db.from("vehicle_live_location").select("vehicle_id,last_track_fetch_at,last_track_update_utc");
  if (lerr) warnings.push("read vehicle_live_location: " + lerr.message);
  const liveMeta = new Map((liveRows || []).map((r: any) => [r.vehicle_id, r]));

  // 2) live location for every truck
  const loc = new Map<number, { update: number | null; row: any }>();
  await pool(vehicles, 2, async (v) => {   // 2 at a time: Verizon throttles bursts
    const r = await vzc.get(`/rad/v1/vehicles/${encNum(v.vzc_vehicle_number)}/location`);
    const b = r.body;
    const update = b ? M.utc(b.UpdateUTC) : null;
    const row = {
      vehicle_id: v.id, vzc_vehicle_number: v.vzc_vehicle_number,
      state: b ? (LIVE_STATE[b.DisplayState] ?? "Unknown") : "Unknown", raw_state: b?.DisplayState ?? `HTTP ${r.status}`,
      address: b?.IsPrivate ? "(private)" : locAddress(b?.Address), lat: b?.IsPrivate ? null : b?.Latitude ?? null, lon: b?.IsPrivate ? null : b?.Longitude ?? null,
      speed_mph: b ? Math.round((Number(b.Speed) || 0) * 0.621371 * 10) / 10 : null, heading: b?.Heading ?? null,
      reported_at: update ? new Date(update).toISOString() : null, updated_at: nowIso,
    };
    loc.set(v.id, { update, row });
    summary.vehicles.push({ id: v.id, name: v.name, state: row.state, address: row.address, speed_mph: row.speed_mph, reported_ct: M.ctClock(update), http: r.status });
  });
  if (!opt.dryRun) {
    const rows = [...loc.values()].map((x) => x.row);
    if (rows.length) { const { error } = await db.from("vehicle_live_location").upsert(rows, { onConflict: "vehicle_id" }); if (error) warnings.push("live upsert: " + error.message); }
  }

  // v4.4.0 fast path: live locations only (1 call per truck), no tracks / matching / stops
  if (opt.liveOnly) {
    summary.live_only = true; summary.api_calls = vzc.calls; summary.api_errors = vzc.errors; summary.ms = Date.now() - t0;
    summary.vehicles.sort((a: any, b: any) => a.id - b.id);
    if (!opt.dryRun) await db.from("vzc_sync_runs").insert({ started_at: nowIso, finished_at: new Date().toISOString(), dry_run: false, ok: true, api_calls: vzc.calls, summary: { ok: true, live_only: true, ms: summary.ms, api_calls: vzc.calls, api_errors: vzc.errors, warnings, http: summary.vehicles.map((v: any) => v.http) } });
    return summary;
  }

  // 3) which dates
  const today = M.ctYmd(Date.now());
  const ctHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const dates = opt.dates?.length ? [...new Set(opt.dates)].sort() : ctHour < 12 ? [addDays(today, -1), today] : [today];
  const writableFrom = addDays(today, -WRITE_MAX_AGE_DAYS);

  // 4) geocode cache
  const { data: gc, error: gerr } = await db.from("geocode_cache").select("address_norm,lat,lon,status,geocoded_at");
  if (gerr) warnings.push("read geocode_cache: " + gerr.message);
  const geo = new Map<string, any>((gc || []).map((g: any) => [g.address_norm, g]));
  let geocodedThisRun = 0;
  async function placeFor(label: string, address: string | null): Promise<M.Place | null> {
    if (!address) return null;
    const key = M.cacheKey(address);
    let g = geo.get(key);
    const stale = g && g.status !== "ok" && Date.now() - Date.parse(g.geocoded_at) > 7 * 86400e3;
    if ((!g || stale) && key !== "8701 47th st|mccook" && geocodedThisRun < MAX_GEOCODES_PER_RUN) {
      geocodedThisRun++;
      const r = await geocodeAddress(address);
      g = { address_norm: key, address, lat: r.lat, lon: r.lon, status: r.status, source: r.source, matched_address: r.matched, geocoded_at: nowIso };
      geo.set(key, g);
      if (!opt.dryRun && r.status !== "error") await db.from("geocode_cache").upsert(g, { onConflict: "address_norm" });
    }
    return M.makePlace(label, address, g);
  }
  const base = M.makePlace("Darwill McCook", M.BASE_ADDRESS, null)!;

  // driver roster + schedules (v3.11.0): who had which truck when (shift times, overnight shifts, daily picks, defaults)
  let roster: { drivers: A.DriverRow[]; weekly: A.WeeklyRow[]; sched: A.SchedRow[]; truck: A.TruckSchedRow[] | null; switches: A.SwitchRow[] } | null = null;
  async function loadRoster(fresh = false) {
    if (roster && !fresh) return roster;
    const lo = addDays(dates[0] < today ? dates[0] : today, -2), hi = addDays(today, 1);
    const [d, w, s, ts, sw] = await Promise.all([
      db.from("drivers").select("id,name,active,default_vehicle_id").order("id"),
      db.from("driver_weekly_schedule").select("driver_id,day_of_week,working,start_time,end_time"),
      db.from("driver_schedule").select("*").gte("work_date", lo).lte("work_date", hi),
      db.from("truck_schedules").select("id,driver_id,vehicle_id,days,start_time,end_time,active"),
      db.from("truck_switches").select("id,work_date,driver_id,from_vehicle_id,to_vehicle_id,switched_at,active").eq("active", true).gte("work_date", lo).lte("work_date", hi),
    ]);
    if (sw.error) warnings.push("read truck_switches (v4.1.0 migration missing? no mid-day switches): " + sw.error.message);
    if (ts.error) { warnings.push("read truck_schedules (v4.0.0 migration missing? using v3.11 rules): " + ts.error.message); summary.schedule_model = "v3.11 (weekly + default truck)"; }
    else summary.schedule_model = "v4.0.0 truck_schedules (strict, no grace)";
    if (d.error) throw new Error("read drivers: " + d.error.message);
    if (w.error) warnings.push("read driver_weekly_schedule: " + w.error.message);
    if (s.error) warnings.push("read driver_schedule: " + s.error.message);
    roster = { drivers: (d.data || []) as any, weekly: (w.data || []) as any, sched: (s.data || []) as any, truck: ts.error ? null : (ts.data || []) as any, switches: sw.error ? [] : (sw.data || []) as any };
    return roster;
  }
  /** shifts of `date` and the day before (overnight shifts own their after-midnight time) */
  async function shiftsAround(date: string, fresh = false): Promise<A.Shift[]> {
    const r = await loadRoster(fresh);
    const out = [...A.applySwitches(addDays(date, -1), A.shiftsFor(addDays(date, -1), r.drivers, r.sched, r.weekly, r.truck), r.switches), ...A.applySwitches(date, A.shiftsFor(date, r.drivers, r.sched, r.weekly, r.truck), r.switches)];
    if (opt.dryRun && opt.assignSim?.ignoreTrucksOf.length) for (const s of out) if (opt.assignSim.ignoreTrucksOf.includes(s.driverId)) { s.vehicleId = null; s.vehicleSource = null; s.auto = false; }
    return out;
  }
  const runMatches = new Map<string, M.TaskMatch[]>();

  // 5) unplanned stops (v3.10.0): today's date (or explicitly requested dates). Saved only once the table exists.
  // v4.2.0: also yesterday (the cron includes it before noon) so a stop that runs past midnight is still saved
  const upDates = new Set(dates.filter((d) => d === today || d === addDays(today, -1) || !!opt.dates?.length));
  let upTable = false;
  if (upDates.size) {
    const { error } = await db.from("unplanned_stops").select("id").limit(1);
    upTable = !error;
    if (error) summary.unplanned_note = "unplanned_stops table not created yet — detection only, nothing saved";
  }
  let named: U.NamedPlace[] | null = null;
  async function namedPlaces(): Promise<U.NamedPlace[]> {
    if (named) return named;
    named = [];
    const seen = new Set<string>();
    const add = async (name: string | null, address: string | null, savedId: number | null) => {
      if (!name || !address) return;
      const k = name.toLowerCase() + "|" + M.cacheKey(address);
      if (seen.has(k)) return;
      seen.add(k);
      const p = await placeFor(name, address);
      if (p && p.lat != null) named!.push({ name, address, place: p, savedId });
    };
    // v4.0.0: team-named places (dashboard "Edit location name"), matched within their own radius, nearest wins
    const { data: np, error: ne } = await db.from("named_places").select("id,name,lat,lon,radius_m,address,active").order("id");
    if (ne) warnings.push("read named_places: " + ne.message);
    for (const r of (np || []) as any[]) if (r.active !== false && r.lat != null && r.lon != null) {
      const p = M.makePlace(r.name, r.address || r.name, { status: "ok", lat: Number(r.lat), lon: Number(r.lon) } as any);
      if (p) named!.push({ name: r.name, address: r.address || "", place: { ...p, lat: Number(r.lat), lon: Number(r.lon) }, savedId: null, namedPlaceId: Number(r.id), radiusM: Number(r.radius_m) || 70 });
    }
    const { data: sl, error: se } = await db.from("saved_locations").select("id,name,address").order("id");
    if (se) warnings.push("read saved_locations: " + se.message);
    for (const r of (sl || []) as any[]) await add(r.name, r.address, r.id);
    for (const [n, a] of U.BUILTIN_LOCATIONS) await add(n, a, null);
    // names already used on tasks/stops (e.g. "Darwill Hillside")
    const { data: tn } = await db.from("dispatch_tasks").select("pickup_name,pickup_address,delivery_name,delivery_address").order("id", { ascending: false }).limit(500);
    for (const r of (tn || []) as any[]) { await add(r.pickup_name, r.pickup_address, null); await add(r.delivery_name, r.delivery_address, null); }
    const { data: sn } = await db.from("dispatch_task_stops").select("location_name,location_address").order("id", { ascending: false }).limit(500);
    for (const r of (sn || []) as any[]) await add(r.location_name, r.location_address, null);
    return named;
  }

  // 6) per date
  const trackCache = new Map<string, M.VehicleTrack>();
  let autoStatusMissing = false;   // set once vzc_auto_status is found missing (pre-migration) → report-only
  for (const date of dates) {
    const dsum: any = { date, writes_allowed: !opt.dryRun && date >= writableFrom, open_tasks: 0, matched: [], unmatched: [], skipped: [], writes: 0, write_errors: [] };
    summary.dates.push(dsum);
    const winStart = M.ctMidnightUtc(date), winEnd = Math.min(Date.now(), M.ctMidnightUtc(addDays(date, 1)) + 12 * 3600e3);
    if (winEnd <= winStart) continue;

    const { data: trows, error: terr } = await db.from("dispatch_tasks").select(TASK_COLS).eq("work_date", date).order("id");
    if (terr) throw new Error("read tasks: " + terr.message);
    // v4.0.0: planned truck = the task's stored vehicle_id, else the driver's scheduled truck (truck_schedules / Daily Overrides)
    const dayShifts = await shiftsAround(date);
    const plan = (await loadRoster()).drivers.map((d) => ({ driver_id: Number(d.id), vehicle_id: A.plannedTruckFor(Number(d.id), date, null, dayShifts),
      schedule_status: dayShifts.some((s) => s.driverId === Number(d.id) && s.date === date && s.working) ? "working" : "off" }));
    const plannedFor = (t: any): number | null => t.vehicle_id != null ? Number(t.vehicle_id)
      : t.assigned_driver_id != null ? A.plannedTruckFor(Number(t.assigned_driver_id), date, t.scheduled_at ? Date.parse(t.scheduled_at) : null, dayShifts) : null;
    if (date === today) { const vn = (id: number) => vehicles.find((x) => x.id === id)?.name || "truck #" + id; summary.schedule_conflicts = A.conflicts(dayShifts.filter((s) => s.date === date), vn).map((c) => c.text); }
    const routeIds = (trows || []).filter((t: any) => t.is_route).map((t: any) => t.id);
    const { data: srows, error: serr } = routeIds.length ? await db.from("dispatch_task_stops").select(STOP_COLS).in("task_id", routeIds).order("seq") : { data: [] as any[], error: null };
    if (serr) throw new Error("read route stops: " + serr.message);

    const targets: M.TaskTarget[] = [];
    if (opt.recompute && opt.dryRun) {   // compare mode: pretend nothing is stored yet (never used for writes)
      for (const t of (trows || []) as any[]) for (const c of Object.keys(t)) if (c.startsWith("gps_")) t[c] = null;
      for (const s of (srows || []) as any[]) { for (const c of Object.keys(s)) if (c.startsWith("gps_")) s[c] = null; s.status = "pending"; }
    }
    // v3.12.0: visits already stored on ANY task/stop of this date (filled ones too) are owned — one physical visit, one owner.
    const claimed: M.ClaimedVisit[] = [];
    for (const t of (trows || []) as any[]) {
      if (/cancel/i.test(t.status || "") || t.is_route) continue;
      if (t.gps_arrived_at && t.gps_vehicle_id != null) claimed.push({ vehicleId: Number(t.gps_vehicle_id), arrived: Date.parse(t.gps_arrived_at), ownerTaskId: t.id });
    }
    for (const st of (srows || []) as any[]) {
      if (st.gps_arrived_at && st.gps_vehicle_id != null) claimed.push({ vehicleId: Number(st.gps_vehicle_id), arrived: Date.parse(st.gps_arrived_at), ownerTaskId: st.task_id, ownerStopId: st.id });
    }
    for (const t of (trows || []) as any[]) {
      const skip = (why: string) => dsum.skipped.push({ task_id: t.id, why });
      if (t.combined_into_task_id) { skip("combined into route #" + t.combined_into_task_id); continue; }
      if (t.messenger_id != null) { skip("messenger — not tracked by GPS"); continue; }
      if (!t.assigned_driver_id && t.vehicle_id == null) { skip("unassigned"); continue; }
      if (t.assigned_driver_id && env.excludeDrivers.includes(Number(t.assigned_driver_id))) { skip("driver excluded (VZC_EXCLUDE_DRIVER_IDS)"); continue; }
      if (/cancel/i.test(t.status || "")) { skip("cancelled"); continue; }
      const origin = await placeFor(t.pickup_name || "origin", t.pickup_address);
      const stops: M.StopTarget[] = [];
      if (t.is_route) {
        for (const s of (srows || []).filter((s: any) => s.task_id === t.id)) {
          const p = await placeFor(s.location_name || "stop " + s.seq, s.location_address);
          if (p) stops.push({ id: s.id, seq: s.seq, place: p, status: s.status, existing: s });
        }
        if (!stops.length) { skip("route without matchable stops"); continue; }
      }
      const dest = t.is_route ? null : await placeFor(t.delivery_name || "destination", t.delivery_address);
      // anything still empty?
      const destBase = !!dest?.isBase;
      const open = t.is_route
        ? t.gps_departed_at == null || t.gps_returned_base_at == null || stops.some((s) => s.existing.gps_arrived_at == null || (s.existing.gps_departed_at == null && !s.place.isBase) || s.status !== "done")
        : t.gps_arrived_at == null || t.gps_departed_at == null || t.gps_returned_base_at == null || (!destBase && t.gps_left_destination_at == null);
      if (!open) { skip("already filled"); continue; }
      targets.push({
        id: t.id, kind: t.is_route ? "route" : "single", title: t.title, driverId: t.assigned_driver_id ?? null, plannedVehicleId: plannedFor(t),
        origin, dest, stops, existing: t, completedAt: t.completed_at ? Date.parse(t.completed_at) : null, scheduledAt: t.scheduled_at ? Date.parse(t.scheduled_at) : null,
        createdAt: t.created_at ? Date.parse(t.created_at) : null, assignedAt: t.assigned_at ? Date.parse(t.assigned_at) : null,
        vehicleLocked: t.vehicle_id != null,
        shiftWindows: t.assigned_driver_id ? dayShifts.filter((s) => s.driverId === Number(t.assigned_driver_id) && s.date === date && A.clear(s)).map((s) => [s.start!, s.end!] as [number, number]) : null,
      });
    }
    dsum.open_tasks = targets.length;
    const up = upDates.has(date);
    if (!targets.length && !up) { await autoStatus(date, dsum, (trows || []) as any[], (srows || []) as any[], []); continue; }

    // trucks worth fetching: planned trucks of open tasks (or every truck if a task has none / other trucks allowed)
    const needAll = env.allowOtherTruck || targets.some((t) => !t.plannedVehicleId && !t.existing.gps_vehicle_id);
    const wanted = new Set<number>(targets.flatMap((t) => [t.plannedVehicleId, t.existing.gps_vehicle_id].filter(Boolean).map(Number)));
    const fetchFrom = winStart - 6 * 3600e3;
    const tracks: M.VehicleTrack[] = [];
    for (const v of vehicles) {
      const forTasks = targets.length > 0 && (needAll || wanted.has(v.id));
      if (!forTasks && !up) continue;
      const l = loc.get(v.id);
      if (!l?.update || l.update < fetchFrom) continue; // no GPS reports in this window
      if (!forTasks && l.update < winStart) continue;   // unplanned check only: no GPS at all this day
      const key = `${v.id}|${date}`;
      if (!trackCache.has(key)) {
        const meta: any = liveMeta.get(v.id);
        const cron = !opt.dates?.length && opt.source === "pg_cron";
        const lastFetch = meta?.last_track_fetch_at ? Date.parse(meta.last_track_fetch_at) : null;
        const noNew = !!meta?.last_track_update_utc && l.update <= Date.parse(meta.last_track_update_utc);
        const unchanged = noNew && lastFetch != null && Date.now() - lastFetch < TRACK_REFRESH_MS && cron;
        if (forTasks && unchanged) { dsum.skipped.push({ vehicle: v.name, why: "no new GPS since last run" }); continue; }
        if (!forTasks && cron && lastFetch != null) {
          const why = noNew ? (lastFetch >= l.update + UNPLANNED_SETTLE_MS ? "parked, already checked for unplanned stops" : null)
            : (Date.now() - lastFetch < UNPLANNED_REFRESH_MS ? "unplanned-stop check runs every 9 min for trucks without open tasks" : null);
          if (why) { dsum.skipped.push({ vehicle: v.name, why }); continue; }
        }
        const hist = await vzc.get(`/rad/v1/vehicles/${encNum(v.vzc_vehicle_number)}/status/history?startdatetimeutc=${fmtUtc(fetchFrom)}&enddatetimeutc=${fmtUtc(winEnd)}`);
        // segments (ignition on/off) return 24 h from the start time: one call for today, two for yesterday (morning only).
        // The 6 h look-back before midnight is covered by the history plots above.
        const segBodies: any[] = [], segStatus: number[] = [];
        for (let s = winStart; s < winEnd; s += 24 * 3600e3) {
          const r = await vzc.get(`/rad/v1/vehicles/${encNum(v.vzc_vehicle_number)}/segments?startdateutc=${fmtUtc(s)}`);
          segStatus.push(r.status);
          if (r.body) segBodies.push(...(Array.isArray(r.body) ? r.body : [r.body]));
        }
        if (hist.status >= 400) warnings.push(`${v.name}: history HTTP ${hist.status}`);
        const vsum = summary.vehicles.find((x: any) => x.id === v.id);
        if (vsum) (vsum.tracks ??= []).push({ date, history_http: hist.status, plots: Array.isArray(hist.body) ? hist.body.length : 0, segments_http: segStatus, segments: segBodies.length });
        const tl = M.buildTimeline(M.parsePlots(Array.isArray(hist.body) ? hist.body : []), M.parseSegments(segBodies), fetchFrom, winEnd);
        trackCache.set(key, { vehicleId: v.id, name: v.name, tl });
        if (!opt.dryRun) await db.from("vehicle_live_location").update({ last_track_fetch_at: nowIso, last_track_update_utc: new Date(l.update).toISOString() }).eq("vehicle_id", v.id);
      }
      tracks.push(trackCache.get(key)!);
    }
    if (!tracks.length) { dsum.note = "no truck GPS in this window"; await autoStatus(date, dsum, (trows || []) as any[], (srows || []) as any[], []); continue; }

    const res = targets.length ? M.matchDay({ date, tasks: targets, vehicles: tracks, base, winStart, winEnd, allowOtherTruck: env.allowOtherTruck, claimed }) : { matches: [], unmatched: [] };
    runMatches.set(date, res.matches);
    dsum.unmatched = res.unmatched;
    for (const m of res.matches) {
      const task = targets.find((t) => t.id === m.taskId)!;
      const patches = M.buildPatches(m, task, nowIso);
      dsum.matched.push({
        task_id: m.taskId, title: task.title, truck: m.vehicleName, planned_truck: m.planned, method: m.method,
        fills: patches.map((p) => ({ table: p.table, id: p.id, status: p.status?.to, set: Object.fromEntries(Object.entries(p.set).filter(([k]) => k !== "gps_updated_at").map(([k, v]) => [k, typeof v === "string" && /_at$/.test(k) ? M.ctClock(Date.parse(v)) : v])) })),
      });
      if (!dsum.writes_allowed) continue;
      for (const p of patches) {
        if (p.nullCols.length) {
          let q = db.from(p.table).update(p.set, { count: "exact" }).eq("id", p.id);
          for (const c of p.nullCols) q = q.is(c, null);   // only-if-still-empty, enforced in the UPDATE itself
          const { error, count } = await q;
          if (error) dsum.write_errors.push(`${p.table} #${p.id}: ${error.message}`); else dsum.writes += count || 0;
        }
        if (p.status && p.table === "dispatch_task_stops") {   // forward-only stop status (v3.8.0 rules)
          const { error } = await db.from("dispatch_task_stops").update({ status: p.status.to }).eq("id", p.id).in("status", p.status.from);
          if (error) dsum.write_errors.push(`stop #${p.id} status: ${error.message}`);
        }
      }
    }
    await autoStatus(date, dsum, (trows || []) as any[], (srows || []) as any[], res.matches);
    if (up) {
      try { await unplannedForDate(date, dsum, tracks, res.matches, (trows || []) as any[], (srows || []) as any[], (plan || []) as any[], winStart, winEnd); }
      catch (e) { dsum.unplanned_error = String((e as Error)?.message || e).slice(0, 300); warnings.push("unplanned stops: " + dsum.unplanned_error); }
    }
  }

  // v3.12.0 auto status from GPS (forward-only). Singles: left origin → in_progress; arrived at destination → completed
  // (completed_at = arrival). Routes: left origin → in_progress (completion stays with the stop trigger). The SQL function
  // vzc_auto_status re-checks every guard atomically (protected ids, work_date >= today CT, status_source <> 'manual',
  // allowed from-status, no driver Missed/Refused report) and stamps status_source='auto_gps' + status_auto_at.
  async function autoStatus(date: string, dsum: any, trows: any[], srows: any[], matches: M.TaskMatch[]) {
    if (date < today) return;
    const byTask = new Map(matches.map((m) => [m.taskId, m]));
    const out: any[] = [];
    // status_source exists only after migration v312 — read it separately so a missing column never breaks the run
    const srcOf = new Map<number, string | null>();
    { const { data, error } = await db.from("dispatch_tasks").select("id,status_source").eq("work_date", date); if (!error) for (const r of (data || []) as any[]) srcOf.set(r.id, r.status_source); }
    for (const t0 of trows) {
      const t = { ...t0, status_source: srcOf.get(t0.id) ?? null };
      if (AUTO_STATUS_PROTECTED.includes(t.id) || t.combined_into_task_id || t.messenger_id != null || (!t.assigned_driver_id && t.vehicle_id == null)) continue;
      if (t.assigned_driver_id && env.excludeDrivers.includes(Number(t.assigned_driver_id))) continue;
      const dec = M.autoStatusFor(t, srows.filter((x) => x.task_id === t.id), byTask.get(t.id));
      if (!dec) continue;
      const st = String(t.status || ""), to = dec.to, at = dec.at;
      const row: any = { task_id: t.id, from: st, to, gps_time: M.ctClock(at), action: "would update (dry run)" };
      out.push(row);
      if (opt.dryRun || !dsum.writes_allowed) { if (!opt.dryRun) row.action = "not written (date not writable)"; continue; }
      if (autoStatusMissing) { row.action = "report only (vzc_auto_status not installed yet)"; continue; }
      const { data, error } = await db.rpc("vzc_auto_status", { p_task_id: t.id, p_to: to, p_completed_at: to === "completed" ? new Date(at!).toISOString() : null });
      if (error) {
        if (/vzc_auto_status|PGRST202|does not exist|schema cache/i.test(error.message + " " + (error as any).code)) { autoStatusMissing = true; row.action = "report only (vzc_auto_status not installed yet)"; summary.auto_status_note = "migration v312_auto_status not applied — auto status is report-only"; }
        else { row.action = "error"; dsum.write_errors.push(`auto status #${t.id}: ${error.message}`); }
      } else row.action = String(data);
    }
    if (out.length) dsum.auto_status = out;
  }

  async function stopEvents(tr: M.VehicleTrack, judged: U.Judged[], shifts: any[], dayStart: number, dayEnd: number, date: string, canWrite: boolean, dsum: any) {
    const STOP_EVENT_MIN_MIN = 2;
    const v = tr.vehicleId, named = await namedPlaces();
    const cat: Record<string, string> = { base: "McCook base", home: "Overnight spot", planned: "Task stop", unplanned: "Detected stop", idle: "Stop", short: "Stop", private: "Private", clipped: "Stop", other_day: "Stop" };
    const rows: Record<string, any>[] = [];
    for (const c of judged) {
      const end = c.departed ?? null;
      if (c.arrived >= dayEnd || (end != null && end < dayStart)) continue;      // not on this day
      if (c.stillMinutes < STOP_EVENT_MIN_MIN) continue;
      let category = cat[c.verdict] || "Stop";
      if (c.verdict === "clipped" || c.verdict === "other_day") category = c.arrived < dayStart ? "Overnight spot" : "Stop";
      const nm = c.priv ? null : U.nameFor(c, named);
      const who = A.whoHadTruck(v, Math.max(c.arrived, dayStart), shifts, env.excludeDrivers);
      // parked overnight (started before midnight): the engine-off event is before the data we fetch, so it would look like idling
      const overnight = c.arrived < dayStart;
      if (overnight) { category = "Overnight spot"; }
      rows.push({
        vehicle_id: v, work_date: date, started_at: new Date(c.arrived).toISOString(), ended_at: end != null ? new Date(end).toISOString() : null,
        still_minutes: c.stillMinutes, engine_off_minutes: overnight ? c.stillMinutes : c.offMinutes, idle_minutes: overnight ? 0 : end != null ? c.idleMinutes : Math.max(0, c.stillMinutes - c.offMinutes),
        kind: overnight || c.offMinutes >= 1 ? "engine_off" : "idle", category: !overnight && c.verdict === "planned" && c.planned ? "Task stop" : category,
        location_name: c.priv ? "Private" : (nm?.name || (c.verdict === "planned" && c.planned) || (c.verdict === "base" ? "Darwill McCook" : null) || null),
        address: c.priv ? null : ((c.addr ?? nm?.address ?? "").replace(/, USA$/, "") || null), lat: c.priv ? null : c.lat, lon: c.priv ? null : c.lon,
        driver_id: who?.driverId ?? null, source: "vzc_auto", superseded_at: null, updated_at: nowIso,
      });
    }
    const out = (dsum.stop_events ||= { trucks: [] as any[], writes: 0 });
    out.trucks.push({ truck: tr.name, stops: rows.length });
    if (opt.dryRun) { (out.sample ||= []).push(...rows.slice(-3).map((r) => ({ truck: tr.name, at: M.ctClock(Date.parse(r.started_at)), end: r.ended_at ? M.ctClock(Date.parse(r.ended_at)) : "ongoing", kind: r.kind, cat: r.category, name: r.location_name, min: r.still_minutes }))); return; }
    if (!canWrite) return;
    if (rows.length) {
      const { error } = await db.from("vehicle_stop_events").upsert(rows, { onConflict: "vehicle_id,started_at" });
      if (error) { out.error = error.message; return; }
      out.writes += rows.length;
    }
    // a stop that a later, fuller track no longer has (merged / re-split) is marked superseded, never deleted
    const keep = rows.map((r) => r.started_at);
    let q = db.from("vehicle_stop_events").update({ superseded_at: nowIso }).eq("vehicle_id", v).eq("work_date", date).is("superseded_at", null);
    if (keep.length) q = q.not("started_at", "in", `(${keep.map((k) => `"${k}"`).join(",")})`);
    const { error: se } = await q;
    if (se) out.error = se.message;
  }

  async function unplannedForDate(date: string, dsum: any, tracks: M.VehicleTrack[], matches: M.TaskMatch[], trows: any[], srows: any[], plan: any[], winStart: number, winEnd: number) {
    const dayStart = winStart, dayEnd = M.ctMidnightUtc(addDays(date, 1));
    const ms = (v: any) => (v == null ? null : Date.parse(v));
    const live = trows.filter((t) => !/cancel/i.test(t.status || "") && t.messenger_id == null);
    const byTaskMatch = new Map(matches.map((m) => [m.taskId, m]));
    const vehOf = (t: any): number | null => byTaskMatch.get(t.id)?.vehicleId ?? (t.gps_vehicle_id != null ? Number(t.gps_vehicle_id) : null);
    const plannedTruck = new Map<number, number | null>(plan.map((p: any) => [p.driver_id, p.vehicle_id]));
    const working = (p: any) => !["off", "pto", "call_off"].includes(String(p.schedule_status || "").toLowerCase());
    const placesOf = new Map<number, M.Place[]>();
    for (const t of live) {
      const ps: (M.Place | null)[] = [await placeFor(t.pickup_name || "origin", t.pickup_address)];
      if (!t.is_route) ps.push(await placeFor(t.delivery_name || "destination", t.delivery_address));
      for (const s of srows.filter((s) => s.task_id === t.id)) ps.push(await placeFor(s.location_name || "stop", s.location_address));
      placesOf.set(t.id, ps.filter(Boolean) as M.Place[]);
    }
    let existing: any[] = [];
    if (upTable) {
      // by time, not work_date: re-attribution may move an overnight stop to the shift's date (v3.11.0)
      const { data, error } = await db.from("unplanned_stops").select("*").gte("arrived_at", new Date(winStart - 12 * 3600e3).toISOString()).lt("arrived_at", new Date(dayEnd + 12 * 3600e3).toISOString());
      if (error) throw new Error("read unplanned_stops: " + error.message);
      existing = data || [];
    }
    dsum.unplanned = []; dsum.unplanned_idle = []; dsum.unplanned_checked = []; dsum.unplanned_writes = 0;
    const canWrite = dsum.writes_allowed && upTable;
    const shifts = await shiftsAround(date);
    for (const tr of tracks) {
      const v = tr.vehicleId;
      const schedDrivers = plan.filter((p: any) => p.vehicle_id === v && working(p)).map((p: any) => Number(p.driver_id));
      const related = live.filter((t) => vehOf(t) === v || Number(t.vehicle_id) === v || (!t.assigned_driver_id && t.vehicle_id == null) ||
        (t.assigned_driver_id && (plannedTruck.get(t.assigned_driver_id) === v || schedDrivers.includes(Number(t.assigned_driver_id)))));
      const planned = related.flatMap((t) => placesOf.get(t.id) || []);
      // what this truck was working on (stored GPS times + this run's matches); combined originals are hidden, so never attach to them
      const spans: U.TaskSpan[] = [];
      for (const t of live.filter((t) => vehOf(t) === v && !t.combined_into_task_id)) {
        const m = byTaskMatch.get(t.id);
        const dep = ms(t.gps_departed_at) ?? m?.origin?.departed ?? null;
        const ret = ms(t.gps_returned_base_at) ?? m?.returnedBase ?? null;
        const anchors: (number | null)[] = [dep];
        const stops: U.TaskSpan["stops"] = [];
        if (t.is_route) {
          for (const s of srows.filter((s) => s.task_id === t.id)) {
            const sv = m?.stops.find((x) => x.stopId === s.id)?.visit;
            const a = ms(s.gps_arrived_at) ?? sv?.arrived ?? null, d = ms(s.gps_departed_at) ?? sv?.departed ?? null;
            anchors.push(a, d);
            stops.push({ id: s.id, seq: s.seq, t: a });
          }
        } else {
          anchors.push(ms(t.gps_arrived_at) ?? m?.dest?.arrived ?? null, ms(t.gps_left_destination_at) ?? m?.dest?.departed ?? null);
        }
        const an = anchors.filter((x): x is number => x != null);
        if (!an.length) continue;
        spans.push({ taskId: t.id, kind: t.is_route ? "route" : "single", driverId: t.assigned_driver_id ?? null, start: dep ?? Math.min(...an), end: ret ?? ms(t.completed_at), anchors: an, stops });
      }
      const baseArr = M.computeVisits(tr.tl, base, v).filter((x) => !x.clipped).map((x) => x.arrived);
      const home = U.homePlace(tr.tl, dayStart);
      const judged = U.detectStops({ tl: tr.tl, now: winEnd, dayStart, dayEnd, base, home, planned });
      // v4.6.0: every stop/idle >= STOP_EVENT_MIN_MIN for the Trucks page (vehicle_stop_events; rows never deleted)
      try { await stopEvents(tr, judged, shifts, dayStart, dayEnd, date, canWrite, dsum); }
      catch (e) { const msg = String((e as Error)?.message || e).slice(0, 200); (dsum.stop_events ||= {}).error = msg; warnings.push("stop events: " + msg); }
      const counts: Record<string, number> = {};
      for (const c of judged) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      dsum.unplanned_checked.push({ truck: tr.name, home: home?.address || null, stops: counts });
      if (opt.dryRun) (dsum.stop_audit ||= []).push(...judged.map((c) => ({ truck: tr.name, v, arrived: M.ctClock(c.arrived), left: M.ctClock(c.departed), off_min: c.offMinutes, still_min: c.stillMinutes, verdict: c.verdict, planned: c.planned || null, addr: c.addr || null })));
      for (const c of judged.filter((c) => c.verdict === "idle")) dsum.unplanned_idle.push({ truck: tr.name, address: c.addr, arrived: M.ctClock(c.arrived), left: M.ctClock(c.departed), still_min: c.stillMinutes });
      const truckDrivers = [...new Set(live.filter((t) => vehOf(t) === v && t.assigned_driver_id).map((t) => Number(t.assigned_driver_id)))];
      for (const c of judged.filter((c) => c.verdict === "unplanned")) {
        const at = U.attachStop(c.arrived, spans, baseArr);
        const task = at.taskId != null ? live.find((t) => t.id === at.taskId) : null;
        // v4.0.0 driver: ONLY the driver clearly scheduled on this truck at that moment (no grace, no guessing); else null = "Driver unknown"
        void task; void truckDrivers;
        const who = A.whoHadTruck(v, c.arrived, shifts, env.excludeDrivers);
        const driverId: number | null = who?.driverId ?? null;
        const workDate = who ? who.date : date;
        if (driverId != null && env.excludeDrivers.includes(Number(driverId))) continue;
        const nm = U.nameFor(c, await namedPlaces());
        const done = c.departed != null;
        const row: Record<string, any> = {
          work_date: workDate, vehicle_id: v, driver_id: driverId, task_id: at.taskId, after_stop_id: at.afterStopId,
          arrived_at: new Date(c.arrived).toISOString(), engine_off_at: c.engineOff != null ? new Date(c.engineOff).toISOString() : null,
          engine_on_at: done && c.engineOn != null ? new Date(c.engineOn).toISOString() : null, departed_at: done ? new Date(c.departed!).toISOString() : null,
          idle_minutes: done ? c.idleMinutes : null, engine_off_minutes: done ? c.offMinutes : null,
          location_name: nm?.name ?? null, address: (c.addr ?? nm?.address ?? "").replace(/, USA$/, "") || null, lat: c.lat, lon: c.lon, saved_location_id: nm?.savedId ?? null, named_place_id: nm?.namedPlaceId ?? null, source: "vzc_auto",
        };
        const ex = existing.find((e) => Number(e.vehicle_id) === v && Math.abs(Date.parse(e.arrived_at) - c.arrived) <= U.UNPLANNED_MATCH_MS);
        const set: Record<string, any> = {};
        if (ex) for (const k of UP_COLS) if (row[k] != null && ex[k] == null) set[k] = row[k];
        const action = ex ? (Object.keys(set).length ? "update" : "unchanged") : "insert";
        dsum.unplanned.push({
          truck: tr.name, driver_id: driverId, attach: at.kind, task_id: at.taskId, after_stop_id: at.afterStopId,
          name: row.location_name, address: row.address, arrived: M.ctClock(c.arrived), engine_off: M.ctClock(c.engineOff), engine_on: M.ctClock(done ? c.engineOn : null),
          left: M.ctClock(c.departed), off_min: c.offMinutes, idle_min: c.idleMinutes, ongoing: !done, action: canWrite ? action : `${action} (not saved)`, id: ex?.id ?? null,
        });
        if (!canWrite || action === "unchanged") continue;
        if (ex) {
          let q = db.from("unplanned_stops").update({ ...set, updated_at: nowIso }, { count: "exact" }).eq("id", ex.id);
          for (const k of Object.keys(set)) q = q.is(k, null);   // only-if-still-empty, enforced in the UPDATE itself
          const { error, count } = await q;
          if (error) dsum.write_errors.push(`unplanned #${ex.id}: ${error.message}`); else dsum.unplanned_writes += count || 0;
        } else {
          const { data, error } = await db.from("unplanned_stops").upsert(row, { onConflict: "vehicle_id,arrived_at", ignoreDuplicates: true }).select("id");
          if (error) dsum.write_errors.push(`unplanned insert ${tr.name} ${M.ctClock(c.arrived)}: ${error.message}`);
          else { dsum.unplanned_writes += (data || []).length; if (data?.[0]) existing.push({ ...row, id: data[0].id }); }
        }
      }
    }
  }

  // 7) automatic truck assignment (v3.11.0) — needs this run's tracks; then 8) re-attribution of unplanned stops (database only)
  // writes need the v3.11.0 migration (vehicle_assignment_suggestions + driver_schedule.vehicle_source); before that: report only
  let reportOnly = opt.dryRun;
  if (upDates.has(today) && upTable) {
    const { error: ge } = await db.from("vehicle_assignment_suggestions").select("id").limit(1);
    if (ge) { reportOnly = true; summary.v311_note = "v3.11.0 migration not applied yet — truck auto-assign and re-attribution are report-only"; }
  }
  if (upDates.has(today) && upTable) {
    summary.assign = { retired: "v4.0.0 — trucks come from the truck schedule; the updater no longer assigns trucks or writes driver_schedule" };
    if (false) try { await autoAssign(); } catch (e) { summary.assign_error = String((e as Error)?.message || e).slice(0, 300); warnings.push("auto truck assignment: " + summary.assign_error); }
    try { await reattribute(); } catch (e) { summary.reattribute_error = String((e as Error)?.message || e).slice(0, 300); warnings.push("unplanned re-attribution: " + summary.reattribute_error); }
  }

  async function autoAssign() {
    const sim = opt.dryRun ? opt.assignSim : undefined;
    const out: any = { decisions: [], writes: 0, write_errors: [] as string[], simulated: !!sim, report_only: reportOnly };
    summary.assign = out;
    const tracksToday = [...trackCache.entries()].filter(([k]) => k.endsWith("|" + today)).map(([, tr]) => tr);
    const ign = tracksToday.flatMap((tr) => A.ignitions(tr.tl, tr.vehicleId, tr.name))
      .filter((i) => (sim?.allDay ? i.t >= M.ctMidnightUtc(addDays(today, -1)) : i.t >= Date.now() - A.AUTO_ASSIGN_LOOKBACK_MS))
      .sort((a, b) => a.t - b.t);
    out.ignitions = ign.length;
    if (!ign.length) return;
    const shifts = await shiftsAround(today, true);
    // Time Sheet clock-ins / pre-trips (vehicle names are free text; only names that map to a Reveal truck count)
    const lo = addDays(today, -1);
    const [sh, pt] = await Promise.all([
      db.from("driver_shifts").select("driver_id,vehicle,started_at_device,created_at,work_date").gte("work_date", lo),
      db.from("driver_pretrips").select("driver_id,vehicle,submitted_at,created_at,work_date").gte("work_date", lo),
    ]);
    if (sh.error) warnings.push("read driver_shifts: " + sh.error.message);
    if (pt.error) warnings.push("read driver_pretrips: " + pt.error.message);
    const clockins: A.ClockIn[] = [];
    const unmapped = new Set<string>();
    for (const r of (sh.data || []) as any[]) { const vid = A.mapVehicleName(r.vehicle, vehicles); const t = Date.parse(r.started_at_device || r.created_at); if (vid != null && r.driver_id != null && t) clockins.push({ driverId: Number(r.driver_id), vehicleId: vid, t, kind: "time sheet clock-in" }); else if (r.vehicle) unmapped.add(r.vehicle); }
    for (const r of (pt.data || []) as any[]) { const vid = A.mapVehicleName(r.vehicle, vehicles); const t = Date.parse(r.submitted_at || r.created_at); if (vid != null && r.driver_id != null && t) clockins.push({ driverId: Number(r.driver_id), vehicleId: vid, t, kind: "pre-trip" }); else if (r.vehicle) unmapped.add(r.vehicle); }
    if (unmapped.size) out.unmapped_time_sheet_vehicles = [...unmapped];
    const { data: logRows } = reportOnly && summary.v311_note ? { data: [] as any[] } : await db.from("vehicle_assignment_suggestions").select("work_date,vehicle_id,status").gte("work_date", addDays(today, -1));
    const decided = new Set((logRows || []).map((r: any) => `${r.work_date}|${r.vehicle_id}`));
    const nameOf = (id: number) => roster!.drivers.find((d) => Number(d.id) === id)?.name || `driver #${id}`;
    for (const i of ign) {
      const cal = A.ctDate(i.t);
      const sh2 = shifts.filter((s) => s.date === cal || s.date === addDays(cal, -1));
      const d = A.decideAssign(i, sh2, clockins, env.excludeDrivers);
      const rec: any = { truck: i.vehicleName, ignition: A.ctClock(i.t), ignition_date: cal, action: d.action, reason: d.reason, candidates: d.candidates.map(nameOf) };
      out.decisions.push(rec);
      if (d.action === "none") continue;
      const key = `${d.date}|${i.vehicleId}`;
      if (decided.has(key) && !sim) { rec.action += " (skipped: already decided for this truck/date)"; continue; }
      decided.add(key);
      if (d.action === "assign") {
        rec.driver = nameOf(d.driverId); rec.date = d.date;
        A.applyAssign(shifts, d.driverId, d.date, i.vehicleId);
        if (reportOnly) { rec.action += " (report only, not saved)"; continue; }
        const s = shifts.find((x) => x.driverId === d.driverId && x.date === d.date)!;
        let ok = false;
        if (s.row?.id != null) {
          const { error, count } = await db.from("driver_schedule").update({ vehicle_id: i.vehicleId, vehicle_source: "auto_gps", auto_assigned_at: nowIso }, { count: "exact" }).eq("id", s.row.id).is("vehicle_id", null);
          if (error) out.write_errors.push(`schedule #${s.row.id}: ${error.message}`); else ok = (count || 0) > 0;
        } else {
          const w = s.weekly;   // same as picking a daily truck in Driver Schedule: the override row keeps the weekly status/times
          const { data, error } = await db.from("driver_schedule").upsert({ work_date: d.date, driver_id: d.driverId, status: "working", start_time: w?.start_time ?? null, end_time: w?.end_time ?? null, note: null, vehicle_id: i.vehicleId, vehicle_source: "auto_gps", auto_assigned_at: nowIso }, { onConflict: "work_date,driver_id", ignoreDuplicates: true }).select("id");
          if (error) out.write_errors.push(`schedule insert ${nameOf(d.driverId)} ${d.date}: ${error.message}`); else ok = (data || []).length > 0;
        }
        rec.saved = ok;
        if (ok) {
          out.writes++;
          await db.from("vehicle_assignment_suggestions").upsert({ work_date: d.date, vehicle_id: i.vehicleId, ignition_at: new Date(i.t).toISOString(), candidate_driver_ids: d.candidates, status: "auto_assigned", chosen_driver_id: d.driverId, reason: d.reason, resolved_at: nowIso }, { onConflict: "work_date,vehicle_id", ignoreDuplicates: true });
        }
      } else if (d.action === "suggest") {
        if (reportOnly) { rec.action += " (report only, not saved)"; continue; }
        const { error } = await db.from("vehicle_assignment_suggestions").upsert({ work_date: d.date, vehicle_id: i.vehicleId, ignition_at: new Date(i.t).toISOString(), candidate_driver_ids: d.candidates, status: "pending", reason: d.reason }, { onConflict: "work_date,vehicle_id", ignoreDuplicates: true });
        if (error) out.write_errors.push(`suggestion ${i.vehicleName}: ${error.message}`); else out.writes++;
      }
    }
  }

  /** Re-attribution: unplanned stops whose driver is empty or no longer matches the schedule move to the right driver
   *  (and onto that driver's task/route when the truck was working one). review_status is never touched. */
  async function reattribute() {
    const out: any = { moved: [], checked: 0, write_errors: [] as string[], report_only: reportOnly };
    summary.reattribute = out;
    const from = addDays(today, -1);
    const { data: rows, error } = await db.from("unplanned_stops").select("*").gte("arrived_at", new Date(M.ctMidnightUtc(from)).toISOString()).order("arrived_at");
    if (error) throw new Error("read unplanned_stops: " + error.message);
    if (!rows?.length) return;
    await loadRoster(true);
    const shiftCache = new Map<string, A.Shift[]>();
    const shiftsAt = async (cal: string) => { if (!shiftCache.has(cal)) shiftCache.set(cal, await shiftsAround(cal)); return shiftCache.get(cal)!; };
    const days = [addDays(from, -1), from, today];
    const { data: trows, error: te } = await db.from("dispatch_tasks").select(TASK_COLS).in("work_date", days);
    if (te) throw new Error("read tasks: " + te.message);
    const routeIds = (trows || []).filter((t: any) => t.is_route).map((t: any) => t.id);
    const { data: srows } = routeIds.length ? await db.from("dispatch_task_stops").select(STOP_COLS).in("task_id", routeIds).order("seq") : { data: [] as any[] };
    const live = ((trows || []) as any[]).filter((t) => !/cancel/i.test(t.status || ""));
    const ms = (x: any) => (x == null ? null : Date.parse(x));
    const vehOf = (t: any): number | null => (runMatches.get(t.work_date) || []).find((m) => m.taskId === t.id)?.vehicleId ?? (t.gps_vehicle_id != null ? Number(t.gps_vehicle_id) : null);
    const spansFor = (v: number, date: string): U.TaskSpan[] => {
      const res: U.TaskSpan[] = [];
      for (const t of live.filter((t) => t.work_date === date && vehOf(t) === v && !t.combined_into_task_id)) {
        const m = (runMatches.get(date) || []).find((x) => x.taskId === t.id);
        const dep = ms(t.gps_departed_at) ?? m?.origin?.departed ?? null, ret = ms(t.gps_returned_base_at) ?? m?.returnedBase ?? null;
        const anchors: (number | null)[] = [dep]; const stops: U.TaskSpan["stops"] = [];
        if (t.is_route) for (const s of (srows || []).filter((s: any) => s.task_id === t.id)) {
          const sv = m?.stops.find((x) => x.stopId === s.id)?.visit;
          const a = ms(s.gps_arrived_at) ?? sv?.arrived ?? null, d = ms(s.gps_departed_at) ?? sv?.departed ?? null;
          anchors.push(a, d); stops.push({ id: s.id, seq: s.seq, t: a });
        } else anchors.push(ms(t.gps_arrived_at) ?? m?.dest?.arrived ?? null, ms(t.gps_left_destination_at) ?? m?.dest?.departed ?? null);
        const an = anchors.filter((x): x is number => x != null);
        if (an.length) res.push({ taskId: t.id, kind: t.is_route ? "route" : "single", driverId: t.assigned_driver_id ?? null, start: dep ?? Math.min(...an), end: ret ?? ms(t.completed_at), anchors: an, stops });
      }
      return res;
    };
    const nameOf = (id: number | null) => id == null ? "(no driver — truck list)" : roster!.drivers.find((d) => Number(d.id) === id)?.name || `driver #${id}`;
    const vName = (id: number) => vehicles.find((x) => x.id === Number(id))?.name || `truck #${id}`;
    // v4.0.0: fill-only. A stop without a driver gets the driver clearly scheduled on that truck at that moment; a stop that
    // already has a driver is never changed (disagreements are only reported). Nothing is guessed.
    void spansFor;
    out.disagree = [];
    for (const r of rows as any[]) {
      out.checked++;
      const v = Number(r.vehicle_id), t = Date.parse(r.arrived_at), cal = A.ctDate(t);
      const cur = r.driver_id != null ? Number(r.driver_id) : null;
      const who = A.whoHadTruck(v, t, await shiftsAt(cal), env.excludeDrivers);
      if (cur != null) { if (who?.driverId !== cur) out.disagree.push({ id: r.id, truck: vName(v), arrived: A.ctClock(t), stored: nameOf(cur), schedule_says: who ? nameOf(who.driverId) : "Driver unknown" }); continue; }
      if (!who) continue;
      const set: Record<string, any> = { driver_id: who.driverId, work_date: who.date, updated_at: nowIso };
      out.moved.push({ id: r.id, truck: vName(v), arrived: A.ctClock(t), to: nameOf(who.driverId), work_date: who.date, why: who.why });
      if (reportOnly) continue;
      const { error: ue } = await db.from("unplanned_stops").update(set, { count: "exact" }).eq("id", r.id).is("driver_id", null);
      if (ue) out.write_errors.push(`unplanned #${r.id}: ${ue.message}`);
    }
  }

  summary.vehicles.sort((a: any, b: any) => a.id - b.id);
  summary.api_calls = vzc.calls;
  summary.api_errors = vzc.errors;
  summary.geocoded = geocodedThisRun;
  summary.ms = Date.now() - t0;
  if (!opt.dryRun) {
    await db.from("vzc_sync_runs").insert({ started_at: nowIso, finished_at: new Date().toISOString(), dry_run: false, ok: true, api_calls: vzc.calls, summary });
    await db.from("vzc_sync_runs").delete().lt("started_at", new Date(Date.now() - 14 * 86400e3).toISOString());
  }
  return summary;
}

export async function logFailure(env: Env, dryRun: boolean, error: string) {
  if (dryRun) return;
  try {
    const db = createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } });
    await db.from("vzc_sync_runs").insert({ finished_at: new Date().toISOString(), dry_run: false, ok: false, error: error.slice(0, 2000) });
  } catch { /* ignore */ }
}
