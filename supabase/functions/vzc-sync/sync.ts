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
const UP_COLS = ["driver_id", "task_id", "after_stop_id", "engine_off_at", "engine_on_at", "departed_at", "idle_minutes", "engine_off_minutes", "location_name", "address", "lat", "lon", "saved_location_id"];
const WRITE_MAX_AGE_DAYS = 1;          // writes only for today + yesterday (CT); older dates are dry-run only
const LIVE_STATE: Record<string, string> = { Moving: "Moving", Idle: "Idle", Stop: "Engine off" };
const TASK_COLS = "id,title,status,task_type,work_date,scheduled_at,completed_at,assigned_driver_id,pickup_name,pickup_address,delivery_name,delivery_address,is_route,combined_into_task_id,gps_departed_at,gps_arrived_at,gps_left_destination_at,gps_vehicle_id,gps_source,gps_origin_engine_on_at,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_returned_base_at,gps_match_method,gps_match_distance_m";
const STOP_COLS = "id,task_id,seq,location_name,location_address,status,gps_arrived_at,gps_departed_at,gps_vehicle_id,gps_source,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_match_method,gps_match_distance_m";

export interface SyncOptions { dryRun: boolean; dates?: string[]; vehicles?: string[]; source?: string; recompute?: boolean; assignSim?: { ignoreTrucksOf: number[]; allDay: boolean } }
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
export async function runSync(env: Env, opt: SyncOptions) {
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
  let roster: { drivers: A.DriverRow[]; weekly: A.WeeklyRow[]; sched: A.SchedRow[] } | null = null;
  async function loadRoster(fresh = false) {
    if (roster && !fresh) return roster;
    const lo = addDays(dates[0] < today ? dates[0] : today, -2), hi = addDays(today, 1);
    const [d, w, s] = await Promise.all([
      db.from("drivers").select("id,name,active,default_vehicle_id").order("id"),
      db.from("driver_weekly_schedule").select("driver_id,day_of_week,working,start_time,end_time"),
      db.from("driver_schedule").select("*").gte("work_date", lo).lte("work_date", hi),
    ]);
    if (d.error) throw new Error("read drivers: " + d.error.message);
    if (w.error) warnings.push("read driver_weekly_schedule: " + w.error.message);
    if (s.error) warnings.push("read driver_schedule: " + s.error.message);
    roster = { drivers: (d.data || []) as any, weekly: (w.data || []) as any, sched: (s.data || []) as any };
    return roster;
  }
  /** shifts of `date` and the day before (overnight shifts own their after-midnight time) */
  async function shiftsAround(date: string, fresh = false): Promise<A.Shift[]> {
    const r = await loadRoster(fresh);
    const out = [...A.shiftsFor(addDays(date, -1), r.drivers, r.sched, r.weekly), ...A.shiftsFor(date, r.drivers, r.sched, r.weekly)];
    if (opt.dryRun && opt.assignSim?.ignoreTrucksOf.length) for (const s of out) if (opt.assignSim.ignoreTrucksOf.includes(s.driverId)) { s.vehicleId = null; s.vehicleSource = null; s.auto = false; }
    return out;
  }
  const runMatches = new Map<string, M.TaskMatch[]>();

  // 5) unplanned stops (v3.10.0): today's date (or explicitly requested dates). Saved only once the table exists.
  const upDates = new Set(dates.filter((d) => d === today || !!opt.dates?.length));
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
  for (const date of dates) {
    const dsum: any = { date, writes_allowed: !opt.dryRun && date >= writableFrom, open_tasks: 0, matched: [], unmatched: [], skipped: [], writes: 0, write_errors: [] };
    summary.dates.push(dsum);
    const winStart = M.ctMidnightUtc(date), winEnd = Math.min(Date.now(), M.ctMidnightUtc(addDays(date, 1)) + 12 * 3600e3);
    if (winEnd <= winStart) continue;

    const { data: trows, error: terr } = await db.from("dispatch_tasks").select(TASK_COLS).eq("work_date", date).order("id");
    if (terr) throw new Error("read tasks: " + terr.message);
    const { data: plan, error: perr } = await db.rpc("driver_vehicle_for_date", { p_work_date: date });
    if (perr) warnings.push("planned trucks (driver_vehicle_for_date): " + perr.message);
    const planned = new Map<number, number | null>((plan || []).map((p: any) => [p.driver_id, p.vehicle_id]));
    const routeIds = (trows || []).filter((t: any) => t.is_route).map((t: any) => t.id);
    const { data: srows, error: serr } = routeIds.length ? await db.from("dispatch_task_stops").select(STOP_COLS).in("task_id", routeIds).order("seq") : { data: [] as any[], error: null };
    if (serr) throw new Error("read route stops: " + serr.message);

    const targets: M.TaskTarget[] = [];
    if (opt.recompute && opt.dryRun) {   // compare mode: pretend nothing is stored yet (never used for writes)
      for (const t of (trows || []) as any[]) for (const c of Object.keys(t)) if (c.startsWith("gps_")) t[c] = null;
      for (const s of (srows || []) as any[]) { for (const c of Object.keys(s)) if (c.startsWith("gps_")) s[c] = null; s.status = "pending"; }
    }
    for (const t of (trows || []) as any[]) {
      const skip = (why: string) => dsum.skipped.push({ task_id: t.id, why });
      if (t.combined_into_task_id) { skip("combined into route #" + t.combined_into_task_id); continue; }
      if (!t.assigned_driver_id) { skip("unassigned"); continue; }
      if (env.excludeDrivers.includes(Number(t.assigned_driver_id))) { skip("driver excluded (VZC_EXCLUDE_DRIVER_IDS)"); continue; }
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
        id: t.id, kind: t.is_route ? "route" : "single", title: t.title, driverId: t.assigned_driver_id, plannedVehicleId: planned.get(t.assigned_driver_id) ?? null,
        origin, dest, stops, existing: t, completedAt: t.completed_at ? Date.parse(t.completed_at) : null, scheduledAt: t.scheduled_at ? Date.parse(t.scheduled_at) : null,
      });
    }
    dsum.open_tasks = targets.length;
    const up = upDates.has(date);
    if (!targets.length && !up) continue;

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
    if (!tracks.length) { dsum.note = "no truck GPS in this window"; continue; }

    const res = targets.length ? M.matchDay({ date, tasks: targets, vehicles: tracks, base, winStart, winEnd, allowOtherTruck: env.allowOtherTruck }) : { matches: [], unmatched: [] };
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
    if (up) {
      try { await unplannedForDate(date, dsum, tracks, res.matches, (trows || []) as any[], (srows || []) as any[], (plan || []) as any[], winStart, winEnd); }
      catch (e) { dsum.unplanned_error = String((e as Error)?.message || e).slice(0, 300); warnings.push("unplanned stops: " + dsum.unplanned_error); }
    }
  }

  async function unplannedForDate(date: string, dsum: any, tracks: M.VehicleTrack[], matches: M.TaskMatch[], trows: any[], srows: any[], plan: any[], winStart: number, winEnd: number) {
    const dayStart = winStart, dayEnd = M.ctMidnightUtc(addDays(date, 1));
    const ms = (v: any) => (v == null ? null : Date.parse(v));
    const live = trows.filter((t) => !/cancel/i.test(t.status || ""));
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
      const related = live.filter((t) => vehOf(t) === v || !t.assigned_driver_id ||
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
      const counts: Record<string, number> = {};
      for (const c of judged) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      dsum.unplanned_checked.push({ truck: tr.name, home: home?.address || null, stops: counts });
      for (const c of judged.filter((c) => c.verdict === "idle")) dsum.unplanned_idle.push({ truck: tr.name, address: c.addr, arrived: M.ctClock(c.arrived), left: M.ctClock(c.departed), still_min: c.stillMinutes });
      const truckDrivers = [...new Set(live.filter((t) => vehOf(t) === v && t.assigned_driver_id).map((t) => Number(t.assigned_driver_id)))];
      for (const c of judged.filter((c) => c.verdict === "unplanned")) {
        const at = U.attachStop(c.arrived, spans, baseArr);
        const task = at.taskId != null ? live.find((t) => t.id === at.taskId) : null;
        // driver: the task's driver, else whoever had this truck on their shift then (schedule + shift times), else the one driver with tasks on it
        const who = A.whoHadTruck(v, c.arrived, shifts, env.excludeDrivers);
        let driverId: number | null = task?.assigned_driver_id ?? who?.driverId ?? null;
        if (driverId == null && truckDrivers.length === 1) { const s = shifts.find((x) => x.driverId === truckDrivers[0] && x.date === date); if (!s || A.covers(s, c.arrived)) driverId = truckDrivers[0]; }
        const workDate = !task && who && who.driverId === driverId ? who.date : date;
        if (driverId != null && env.excludeDrivers.includes(Number(driverId))) continue;
        const nm = U.nameFor(c, await namedPlaces());
        const done = c.departed != null;
        const row: Record<string, any> = {
          work_date: workDate, vehicle_id: v, driver_id: driverId, task_id: at.taskId, after_stop_id: at.afterStopId,
          arrived_at: new Date(c.arrived).toISOString(), engine_off_at: c.engineOff != null ? new Date(c.engineOff).toISOString() : null,
          engine_on_at: done && c.engineOn != null ? new Date(c.engineOn).toISOString() : null, departed_at: done ? new Date(c.departed!).toISOString() : null,
          idle_minutes: done ? c.idleMinutes : null, engine_off_minutes: done ? c.offMinutes : null,
          location_name: nm?.name ?? null, address: (c.addr ?? nm?.address ?? "").replace(/, USA$/, "") || null, lat: c.lat, lon: c.lon, saved_location_id: nm?.savedId ?? null, source: "vzc_auto",
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
    try { await autoAssign(); } catch (e) { summary.assign_error = String((e as Error)?.message || e).slice(0, 300); warnings.push("auto truck assignment: " + summary.assign_error); }
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
    for (const r of rows as any[]) {
      out.checked++;
      const v = Number(r.vehicle_id), t = Date.parse(r.arrived_at), cal = A.ctDate(t);
      const cur = r.driver_id != null ? Number(r.driver_id) : null;
      const task = r.task_id != null ? live.find((x) => x.id === r.task_id) : null;
      if (task && !task.combined_into_task_id && task.assigned_driver_id != null && Number(task.assigned_driver_id) === cur) continue;  // on its driver's task: keep
      const sh = await shiftsAt(cal);
      const who = A.whoHadTruck(v, t, sh, env.excludeDrivers);
      let want: number | null = who?.driverId ?? null;
      let date = who ? who.date : cal;
      const at = U.attachStop(t, [...spansFor(v, cal), ...(date !== cal ? spansFor(v, date) : [])], []);
      const atTask = at.taskId != null ? live.find((x) => x.id === at.taskId) : null;
      if (atTask?.assigned_driver_id != null && !env.excludeDrivers.includes(Number(atTask.assigned_driver_id))) { want = Number(atTask.assigned_driver_id); date = atTask.work_date; }
      if (want == null && cur != null && live.some((x) => x.work_date === cal && vehOf(x) === v && Number(x.assigned_driver_id) === cur)) continue; // driver with tasks on that truck that day
      if (want === cur && date === r.work_date) continue;
      const set: Record<string, any> = { driver_id: want, task_id: atTask ? at.taskId : null, after_stop_id: atTask ? at.afterStopId : null, work_date: date, updated_at: nowIso };
      const rec = { id: r.id, truck: vName(v), arrived: A.ctClock(t), from: nameOf(cur), to: nameOf(want), work_date: date, task_id: set.task_id, why: atTask ? `on ${atTask.is_route ? "route" : "task"} #${atTask.id}` : who?.why ?? "nobody had this truck on shift then" };
      out.moved.push(rec);
      if (reportOnly) continue;
      let q = db.from("unplanned_stops").update(set, { count: "exact" }).eq("id", r.id);
      q = cur == null ? q.is("driver_id", null) : q.eq("driver_id", cur);   // only if nobody changed it meanwhile
      const { error: ue } = await q;
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
