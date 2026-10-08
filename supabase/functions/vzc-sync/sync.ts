// vzc-sync / sync.ts — Verizon Connect Reveal client + database reads/writes around the pure logic in match.ts.
// Credentials come ONLY from Edge Function secrets (VZC_USERNAME / VZC_PASSWORD / VZC_APP_ID). Nothing secret is logged.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as M from "./match.ts";
import { geocodeAddress } from "./geocode.ts";

const API = "https://fim.api.us.fleetmatics.com";
const TOKEN_TTL_MS = 15 * 60_000;      // Reveal tokens last ~20 min; refresh at 15
const TRACK_REFRESH_MS = 15 * 60_000;  // refetch a parked truck's history at most every 15 min
const MAX_GEOCODES_PER_RUN = 15;
const WRITE_MAX_AGE_DAYS = 1;          // writes only for today + yesterday (CT); older dates are dry-run only
const LIVE_STATE: Record<string, string> = { Moving: "Moving", Idle: "Idle", Stop: "Engine off" };
const TASK_COLS = "id,title,status,task_type,work_date,scheduled_at,completed_at,assigned_driver_id,pickup_name,pickup_address,delivery_name,delivery_address,is_route,combined_into_task_id,gps_departed_at,gps_arrived_at,gps_left_destination_at,gps_vehicle_id,gps_source,gps_origin_engine_on_at,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_returned_base_at,gps_match_method,gps_match_distance_m";
const STOP_COLS = "id,task_id,seq,location_name,location_address,status,gps_arrived_at,gps_departed_at,gps_vehicle_id,gps_source,gps_engine_off_at,gps_engine_on_at,gps_idle_minutes,gps_engine_off_minutes,gps_match_method,gps_match_distance_m";

export interface SyncOptions { dryRun: boolean; dates?: string[]; vehicles?: string[]; source?: string }
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
  async get(path: string): Promise<{ status: number; body: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.token(attempt > 0);
      this.calls++;
      const r = await fetch(API + path, {
        headers: { Authorization: `Atmosphere atmosphere_app_id=${this.env.appId}, Bearer ${tok}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 401 && attempt === 0) { memToken = null; continue; }
      if (r.status === 204) return { status: 204, body: null };
      if (!r.ok) return { status: r.status, body: null };
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
  const summary: any = { ok: true, dry_run: opt.dryRun, source: opt.source ?? "manual", started_at: nowIso, warnings, vehicles: [], dates: [] };

  // 1) vehicles with a Reveal number
  const { data: vrows, error: verr } = await db.from("vehicles").select("id,name,vzc_vehicle_number").not("vzc_vehicle_number", "is", null).order("id");
  if (verr) throw new Error("read vehicles: " + verr.message);
  let vehicles = (vrows || []) as { id: number; name: string; vzc_vehicle_number: string }[];
  if (opt.vehicles?.length) { const want = opt.vehicles.map((s) => String(s).toLowerCase()); vehicles = vehicles.filter((v) => want.includes(String(v.id)) || want.includes(v.name.toLowerCase())); }
  const { data: liveRows } = await db.from("vehicle_live_location").select("vehicle_id,last_track_fetch_at,last_track_update_utc");
  const liveMeta = new Map((liveRows || []).map((r: any) => [r.vehicle_id, r]));

  // 2) live location for every truck
  const loc = new Map<number, { update: number | null; row: any }>();
  await pool(vehicles, 4, async (v) => {
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
  const { data: gc } = await db.from("geocode_cache").select("address_norm,lat,lon,status,geocoded_at");
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

  // 5) per date
  const trackCache = new Map<string, M.VehicleTrack>();
  for (const date of dates) {
    const dsum: any = { date, writes_allowed: !opt.dryRun && date >= writableFrom, open_tasks: 0, matched: [], unmatched: [], skipped: [], writes: 0, write_errors: [] };
    summary.dates.push(dsum);
    const winStart = M.ctMidnightUtc(date), winEnd = Math.min(Date.now(), M.ctMidnightUtc(addDays(date, 1)) + 12 * 3600e3);
    if (winEnd <= winStart) continue;

    const { data: trows, error: terr } = await db.from("dispatch_tasks").select(TASK_COLS).eq("work_date", date).order("id");
    if (terr) throw new Error("read tasks: " + terr.message);
    const { data: plan } = await db.rpc("driver_vehicle_for_date", { p_work_date: date });
    const planned = new Map<number, number | null>((plan || []).map((p: any) => [p.driver_id, p.vehicle_id]));
    const routeIds = (trows || []).filter((t: any) => t.is_route).map((t: any) => t.id);
    const { data: srows } = routeIds.length ? await db.from("dispatch_task_stops").select(STOP_COLS).in("task_id", routeIds).order("seq") : { data: [] as any[] };

    const targets: M.TaskTarget[] = [];
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
    if (!targets.length) continue;

    // trucks worth fetching: planned trucks of open tasks (or every truck if a task has none / other trucks allowed)
    const needAll = env.allowOtherTruck || targets.some((t) => !t.plannedVehicleId && !t.existing.gps_vehicle_id);
    const wanted = new Set<number>(targets.flatMap((t) => [t.plannedVehicleId, t.existing.gps_vehicle_id].filter(Boolean).map(Number)));
    const fetchFrom = winStart - 6 * 3600e3;
    const tracks: M.VehicleTrack[] = [];
    for (const v of vehicles) {
      if (!needAll && !wanted.has(v.id)) continue;
      const l = loc.get(v.id);
      if (!l?.update || l.update < fetchFrom) continue; // no GPS reports in this window
      const key = `${v.id}|${date}`;
      if (!trackCache.has(key)) {
        const meta: any = liveMeta.get(v.id);
        const unchanged = meta?.last_track_update_utc && l.update <= Date.parse(meta.last_track_update_utc) &&
          meta.last_track_fetch_at && Date.now() - Date.parse(meta.last_track_fetch_at) < TRACK_REFRESH_MS && !opt.dates?.length && opt.source === "pg_cron";
        if (unchanged) { dsum.skipped.push({ vehicle: v.name, why: "no new GPS since last run" }); continue; }
        const hist = await vzc.get(`/rad/v1/vehicles/${encNum(v.vzc_vehicle_number)}/status/history?startdatetimeutc=${fmtUtc(fetchFrom)}&enddatetimeutc=${fmtUtc(winEnd)}`);
        // segments (ignition on/off) return 24 h from the start time: one call for today, two for yesterday (morning only).
        // The 6 h look-back before midnight is covered by the history plots above.
        const segBodies: any[] = [];
        for (let s = winStart; s < winEnd; s += 24 * 3600e3) {
          const r = await vzc.get(`/rad/v1/vehicles/${encNum(v.vzc_vehicle_number)}/segments?startdateutc=${fmtUtc(s)}`);
          if (r.body) segBodies.push(...(Array.isArray(r.body) ? r.body : [r.body]));
        }
        if (hist.status >= 400) warnings.push(`${v.name}: history HTTP ${hist.status}`);
        const tl = M.buildTimeline(M.parsePlots(Array.isArray(hist.body) ? hist.body : []), M.parseSegments(segBodies), fetchFrom, winEnd);
        trackCache.set(key, { vehicleId: v.id, name: v.name, tl });
        if (!opt.dryRun) await db.from("vehicle_live_location").update({ last_track_fetch_at: nowIso, last_track_update_utc: new Date(l.update).toISOString() }).eq("vehicle_id", v.id);
      }
      tracks.push(trackCache.get(key)!);
    }
    if (!tracks.length) { dsum.note = "no truck GPS in this window"; continue; }

    const res = M.matchDay({ date, tasks: targets, vehicles: tracks, base, winStart, winEnd, allowOtherTruck: env.allowOtherTruck });
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
  }

  summary.api_calls = vzc.calls;
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
