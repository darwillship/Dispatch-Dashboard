// vzc-sync / match.ts — pure GPS → stop matching logic (no I/O). Used by the Edge Function and the offline tests.
// All times are epoch milliseconds (UTC). Speeds are km/h (as Reveal returns them).

export const MOVE_KMH = 5;            // a plot faster than this = the truck is moving
export const STILL_KMH = 1;           // a plot at/below this = stopped
export const MIN_STOP_MS = 120_000;   // a "visit" needs an engine-off or >= 2 min stopped (filters red lights / drive-bys)
export const DEFAULT_RADIUS_M = 250;  // geofence around a customer address (docks sit 50–200 m from the geocoded point)
export const BASE_RADIUS_M = 250;     // McCook yard
export const BASE_ADDRESS = "8701 47th St, McCook, IL 60525";
// Where the trucks actually park at McCook (median of Reveal engine-off points, Oct 2026). The street-address
// geocode is ~265 m away (front of the building), so the yard is pinned to the parking spot instead.
export const BASE_LAT = 41.80335, BASE_LON = -87.83656;
export const HOUSE_NO_TOLERANCE = 30; // "902 Carlow Dr" (where the truck stops) = "910 Carlow Dr" (the task) — same building complex
export const ANCHOR_MS = 20 * 60_000; // an existing (manual) time must be within 20 min of the visit we'd use
const JITTER_MERGE_MS = 3 * 60_000;   // re-join a visit split by a stray GPS point

export interface Plot { t: number; lat: number | null; lon: number | null; speed: number; addr?: string | null }
export interface Seg {
  start: number; end: number | null; complete: boolean;
  sLat: number | null; sLon: number | null; sAddr?: string | null;
  eLat: number | null; eLon: number | null; eAddr?: string | null;
  sPriv?: boolean; ePriv?: boolean;
}
export interface Ev { t: number; lat: number | null; lon: number | null; speed: number; kind: "off" | "on" | "plot"; norm: string; addr?: string | null; priv?: boolean }
export interface Place { key: string; label: string; address: string; lat: number | null; lon: number | null; norm: string; radius: number; isBase?: boolean }
export interface Visit {
  vehicleId: number; placeKey: string;
  arrived: number;            // first stopped point (speed 0 plot or engine off) inside the geofence
  engineOff: number | null;   // first ignition-off inside the visit (Reveal's "arrived")
  engineOn: number | null;    // last ignition-on inside the visit (after an engine-off)
  departed: number | null;    // started moving away (first moving plot after the last stopped point); null = still there
  offMinutes: number;         // engine-off time inside the visit
  idleMinutes: number | null; // stopped with engine running = (departed - arrived) - offMinutes
  distM: number | null;       // closest point to the address
  method: "geofence" | "address";
  clipped: boolean;           // the data window starts inside this visit (truck was already there)
  firstT: number; lastT: number;
}

// ---------- addresses ----------
const SUFFIX: Record<string, string> = {
  street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", road: "rd", rd: "rd", drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd", lane: "ln", ln: "ln", court: "ct", ct: "ct", parkway: "pkwy", pkwy: "pkwy",
  highway: "hwy", hwy: "hwy", place: "pl", pl: "pl", terrace: "ter", ter: "ter", circle: "cir", cir: "cir", trail: "trl", trl: "trl",
};
const DIR: Record<string, string> = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w" };
const UNIT_RE = /\b(ste|suite|unit|apt|bldg|building|dock|door|fl|floor|rm|room)\b.*$/;
const STATE_ZIP_RE = /\b(il|illinois|in|indiana|wi|wisconsin)\b|\b\d{5}(-\d{4})?\b/g;

/** "8701 47th St Ste C, McCook, IL 60525" and "8701 47th Street" + "McCook" both → "8701 47th st|mccook". "" if no house number. */
export function normalizeAddress(a: string | null | undefined): string {
  if (!a) return "";
  const s = a.toLowerCase().replace(/\b(usa|united states)\b/g, " ").replace(/[.#]/g, " ").replace(/\s+/g, " ");
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  let street = (parts[0] || "").replace(UNIT_RE, "").trim();
  let city = "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].replace(STATE_ZIP_RE, " ").replace(/\s+/g, " ").trim();
    if (p && !UNIT_RE.test(p) && !/^[a-z]?\d+[a-z]?$/.test(p)) { city = p; break; }
  }
  const toks = street.split(" ").filter(Boolean).map((w) => SUFFIX[w] ?? DIR[w] ?? w);
  if (!/^\d+[a-z]?$/.test(toks[0] || "")) return "";
  street = toks.join(" ");
  return `${street}|${city}`;
}
/** Same street + city, house numbers within HOUSE_NO_TOLERANCE. */
export function addrMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [sa, ca] = a.split("|"), [sb, cb] = b.split("|");
  if (ca && cb && ca !== cb) return false;
  if (sa === sb) return true;
  const ma = sa.match(/^(\d+)[a-z]? (.+)$/), mb = sb.match(/^(\d+)[a-z]? (.+)$/);
  return !!ma && !!mb && ma[2] === mb[2] && Math.abs(+ma[1] - +mb[1]) <= HOUSE_NO_TOLERANCE;
}
/** strip suite/unit for geocoders */
export function geocodeQuery(a: string): string {
  const parts = a.split(",").map((p) => p.trim());
  parts[0] = parts[0].replace(/\b(ste|suite|unit|apt|bldg|building|dock)\b.*$/i, "").trim();
  return parts.filter((p) => p && !/^(ste|suite|unit)\b/i.test(p)).join(", ");
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Reveal payload parsing ----------
export const utc = (s: string | null | undefined): number | null => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z") : null);
const locAddr = (l: any): string | null => (l ? [l.AddressLine1, l.Locality].filter(Boolean).join(", ") : null);

export function parsePlots(history: any[]): Plot[] {
  const seen = new Set<string>(), out: Plot[] = [];
  for (const r of history || []) {
    const t = utc(r.UpdateUtc ?? r.UpdateUTC);
    if (t == null || r.IsPrivate) continue;
    const k = `${t}|${r.Latitude}|${r.Longitude}|${r.Speed}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = r.Address ? (r.Address.AddressLine1?.includes(",") ? r.Address.AddressLine1 : locAddr(r.Address)) : null;
    out.push({ t, lat: r.Latitude ?? null, lon: r.Longitude ?? null, speed: Number(r.Speed) || 0, addr: a });
  }
  return out.sort((a, b) => a.t - b.t);
}
export function parseSegments(body: any): Seg[] {
  const out: Seg[] = [];
  for (const blk of Array.isArray(body) ? body : body ? [body] : []) {
    for (const s of blk.Segments || []) {
      const start = utc(s.StartDateUtc);
      if (start == null) continue;
      out.push({
        start, end: utc(s.EndDateUtc), complete: !!s.IsComplete,
        sLat: s.StartLocation?.Latitude ?? null, sLon: s.StartLocation?.Longitude ?? null, sAddr: s.StartLocationIsPrivate ? null : locAddr(s.StartLocation),
        eLat: s.EndLocation?.Latitude ?? null, eLon: s.EndLocation?.Longitude ?? null, eAddr: s.EndLocationIsPrivate ? null : locAddr(s.EndLocation),
        sPriv: !!s.StartLocationIsPrivate, ePriv: !!s.EndLocationIsPrivate,
      });
    }
  }
  const seen = new Set<number>();
  return out.filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true))).sort((a, b) => a.start - b.start);
}

/** Merge GPS plots and ignition on/off events into one time-ordered list, clipped to [from, to]. */
export function buildTimeline(plots: Plot[], segs: Seg[], from = -Infinity, to = Infinity): Ev[] {
  const ev: Ev[] = [];
  for (const p of plots) ev.push({ t: p.t, lat: p.lat, lon: p.lon, speed: p.speed, kind: "plot", norm: normalizeAddress(p.addr), addr: p.addr ?? null });
  for (const s of segs) {
    ev.push({ t: s.start, lat: s.sLat, lon: s.sLon, speed: 0, kind: "on", norm: normalizeAddress(s.sAddr), addr: s.sAddr ?? null, priv: !!s.sPriv });
    if (s.end != null && s.complete) ev.push({ t: s.end, lat: s.eLat, lon: s.eLon, speed: 0, kind: "off", norm: normalizeAddress(s.eAddr), addr: s.eAddr ?? null, priv: !!s.ePriv });
  }
  const rank = { off: 0, on: 1, plot: 2 } as const;
  return ev.filter((e) => e.t >= from && e.t <= to).sort((a, b) => a.t - b.t || rank[a.kind] - rank[b.kind]);
}

// ---------- visits ----------
export function insideTest(e: Ev, p: Place): { ok: boolean; d: number | null; m: "geofence" | "address" | null } {
  const d = p.lat != null && p.lon != null && e.lat != null && e.lon != null ? haversineM(e.lat, e.lon, p.lat, p.lon) : null;
  if (d != null && d <= p.radius) return { ok: true, d, m: "geofence" };
  if (p.norm && e.norm && addrMatch(p.norm, e.norm)) return { ok: true, d, m: "address" };
  return { ok: false, d, m: null };
}
export const still = (e: Ev) => e.kind !== "plot" || e.speed <= STILL_KMH;

/** All stops of one truck at one place (drive-bys excluded). */
export function computeVisits(tl: Ev[], place: Place, vehicleId: number): Visit[] {
  const tests = tl.map((e) => insideTest(e, place));
  // runs of consecutive inside events
  let runs: [number, number][] = [];
  for (let i = 0; i < tl.length; i++) {
    if (!tests[i].ok) continue;
    let j = i;
    while (j + 1 < tl.length && tests[j + 1].ok) j++;
    runs.push([i, j]);
    i = j;
  }
  // re-join runs split by a short stray excursion (GPS jitter while parked)
  const merged: [number, number][] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && tl[r[0]].t - tl[prev[1]].t <= JITTER_MERGE_MS &&
      tl.slice(prev[1] + 1, r[0]).every((e, k) => e.speed <= MOVE_KMH && (tests[prev[1] + 1 + k].d ?? Infinity) <= place.radius * 2)) {
      prev[1] = r[1];
    } else merged.push([r[0], r[1]]);
  }
  runs = merged;
  const out: Visit[] = [];
  for (const [i0, i1] of runs) {
    const idx: number[] = [];
    for (let k = i0; k <= i1; k++) if (still(tl[k])) idx.push(k);
    if (!idx.length) continue;
    const hasOff = idx.some((k) => tl[k].kind === "off");
    const stillSpan = tl[idx[idx.length - 1]].t - tl[idx[0]].t;
    const ended = i1 < tl.length - 1;
    // "stopped long enough": engine off, >= 2 min stopped, or the data simply ends with the truck stopped here
    if (!hasOff && stillSpan < MIN_STOP_MS && ended) continue;
    const arrived = tl[idx[0]].t;
    let engineOff: number | null = null, engineOn: number | null = null, offMs = 0, pendingOff: number | null = null;
    for (let k = i0; k <= i1; k++) {
      const e = tl[k];
      if (e.kind === "off") { if (engineOff == null) engineOff = e.t; if (pendingOff == null) pendingOff = e.t; }
      if (e.kind === "on" && pendingOff != null) { offMs += e.t - pendingOff; pendingOff = null; engineOn = e.t; }
    }
    const lastStill = idx[idx.length - 1];
    let departed: number | null = null;
    if (ended) {
      for (let k = lastStill + 1; k <= i1 + 1; k++) {
        const e = tl[k];
        if (e.kind === "plot" && e.speed > MOVE_KMH) { departed = e.t; break; }
        if (k === i1 + 1) departed = e.kind === "plot" ? e.t : (engineOn ?? tl[lastStill].t);
      }
    }
    const offMinutes = Math.round(offMs / 60000);
    let distM: number | null = null, method: "geofence" | "address" = "address";
    for (let k = i0; k <= i1; k++) {
      if (tests[k].m === "geofence") method = "geofence";
      if (tests[k].d != null) distM = distM == null ? tests[k].d! : Math.min(distM, tests[k].d!);
    }
    out.push({
      vehicleId, placeKey: place.key, arrived, engineOff, engineOn: pendingOff != null ? null : engineOn, departed,
      offMinutes, idleMinutes: departed != null ? Math.max(0, Math.round((departed - arrived) / 60000) - offMinutes) : null,
      distM: distM == null ? null : Math.round(distM), method, clipped: i0 === 0, firstT: tl[i0].t, lastT: tl[i1].t,
    });
  }
  return out;
}

// ---------- matching ----------
export interface StopTarget { id: number; seq: number; place: Place; status: string; existing: Record<string, any> }
export interface TaskTarget {
  id: number; kind: "single" | "route"; title: string; driverId: number | null; plannedVehicleId: number | null;
  origin: Place | null; dest: Place | null; stops: StopTarget[]; existing: Record<string, any>;
  completedAt: number | null; scheduledAt: number | null;
}
export interface VehicleTrack { vehicleId: number; name: string; tl: Ev[] }
export interface DayInput {
  date: string; tasks: TaskTarget[]; vehicles: VehicleTrack[]; base: Place; winStart: number; winEnd: number;
  /** false (default): a driver with a planned truck is only matched to that truck. Drivers without one can match any truck. */
  allowOtherTruck?: boolean;
}
export interface StopMatch { stopId: number; seq: number; visit: Visit | null; isFinalBase: boolean }
export interface TaskMatch {
  taskId: number; kind: "single" | "route"; vehicleId: number; vehicleName: string; planned: boolean; score: number;
  origin: Visit | null; dest: Visit | null; returnedBase: number | null; stops: StopMatch[]; method: string; distM: number | null;
}

const sameSpot = (a: Place | null, b: Place | null) =>
  !!a && !!b && ((a.norm && a.norm === b.norm) || (a.lat != null && b.lat != null && haversineM(a.lat, a.lon!, b.lat, b.lon!) < 60));
const toMs = (v: any): number | null => (v == null ? null : typeof v === "number" ? v : Date.parse(v));

export function matchDay(input: DayInput): { matches: TaskMatch[]; unmatched: { taskId: number; reason: string }[] } {
  const cache = new Map<string, Visit[]>();
  const visits = (v: VehicleTrack, p: Place) => {
    const k = `${v.vehicleId}|${p.key}`;
    if (!cache.has(k)) cache.set(k, computeVisits(v.tl, p, v.vehicleId));
    return cache.get(k)!;
  };
  const inWin = (x: Visit) => !x.clipped && x.arrived >= input.winStart && x.arrived <= input.winEnd;
  const used = new Set<string>();
  const useKey = (vid: number, x: Visit) => `${vid}|${x.placeKey}|${x.arrived}`;
  const firstBaseAfter = (v: VehicleTrack, t: number | null) =>
    t == null ? null : visits(v, input.base).find((b) => !b.clipped && b.arrived > t)?.arrived ?? null;
  const timeBonus = (task: TaskTarget, t: number) => {
    let s = 0;
    if (task.completedAt != null && t >= task.completedAt - 6 * 3600e3 && t <= task.completedAt + 20 * 60e3) s += 3;
    if (task.scheduledAt != null && Math.abs(t - task.scheduledAt) <= 4 * 3600e3) s += 1;
    return s;
  };
  const vehiclesFor = (task: TaskTarget) =>
    task.existing.gps_vehicle_id ? input.vehicles.filter((v) => v.vehicleId === Number(task.existing.gps_vehicle_id))
    : task.plannedVehicleId && !input.allowOtherTruck ? input.vehicles.filter((v) => v.vehicleId === task.plannedVehicleId)
    : input.vehicles;
  const matches: TaskMatch[] = [], unmatched: { taskId: number; reason: string }[] = [];

  // ---- routes first (more specific) ----
  for (const task of input.tasks.filter((t) => t.kind === "route")) {
    let best: TaskMatch | null = null;
    for (const v of vehiclesFor(task)) {
      const sv = task.stops.map((s) => visits(v, s.place).filter((x) => inWin(x) && !used.has(useKey(v.vehicleId, x))));
      for (let k = 0; k < Math.min(3, task.stops.length); k++) {
        for (const v1 of sv[k]) {
          const anchor = toMs(task.stops[k].existing.gps_arrived_at);
          if (anchor != null && Math.abs(v1.arrived - anchor) > ANCHOR_MS) continue;
          const chain: (Visit | null)[] = task.stops.map(() => null);
          chain[k] = v1;
          let cursor: number | null = v1.departed;
          for (let j = k + 1; j < task.stops.length && cursor != null; j++) {
            const a = toMs(task.stops[j].existing.gps_arrived_at);
            const nx = sv[j].find((x) => x.arrived > cursor! && x.arrived - cursor! < 8 * 3600e3 && (a == null || Math.abs(x.arrived - a) <= ANCHOR_MS));
            if (nx) { chain[j] = nx; cursor = nx.departed; }
          }
          const ov = task.origin ? [...visits(v, task.origin)].reverse().find((o) => o.departed != null && o.departed <= v1.arrived && o.departed >= input.winStart - 12 * 3600e3) ?? null : null;
          const n = chain.filter(Boolean).length;
          const planned = v.vehicleId === task.plannedVehicleId;
          const score = n * 3 + (planned ? 4 : 0) + (ov ? 2 : 0) + timeBonus(task, v1.arrived) - v1.arrived / 1e14;
          if (!best || score > best.score) {
            const last = task.stops[task.stops.length - 1];
            const lastV = chain[chain.length - 1];
            const finalBase = !!last && (last.place.isBase || sameSpot(last.place, input.base));
            const tail = [...chain].reverse().find(Boolean) as Visit;
            best = {
              taskId: task.id, kind: "route", vehicleId: v.vehicleId, vehicleName: v.name, planned, score,
              origin: ov, dest: null,
              returnedBase: finalBase ? (lastV?.arrived ?? null) : firstBaseAfter(v, tail.departed),
              stops: task.stops.map((s, i) => ({ stopId: s.id, seq: s.seq, visit: chain[i], isFinalBase: finalBase && i === task.stops.length - 1 })),
              method: `${v1.method}:${planned ? "planned_truck" : "other_truck"}`,
              distM: Math.max(...chain.filter(Boolean).map((x) => x!.distM ?? 0)),
            };
          }
        }
      }
    }
    if (best) { matches.push(best); best.stops.forEach((s) => s.visit && used.add(useKey(best!.vehicleId, s.visit))); }
    else unmatched.push({ taskId: task.id, reason: "no truck stopped at any stop of this route" });
  }

  // ---- single tasks: score every (truck, destination visit), then assign best-first; a visit is used once ----
  type Cand = { task: TaskTarget; v: VehicleTrack; dv: Visit; ov: Visit | null; score: number; planned: boolean };
  const cands: Cand[] = [];
  const singles = input.tasks.filter((t) => t.kind === "single");
  for (const task of singles) {
    if (!task.dest) continue;
    const exArr = toMs(task.existing.gps_arrived_at), exDep = toMs(task.existing.gps_departed_at);
    for (const v of vehiclesFor(task)) {
      const dvs = visits(v, task.dest).filter(inWin);
      const ovs = task.origin && !sameSpot(task.origin, task.dest) ? visits(v, task.origin).filter((o) => o.departed != null) : [];
      for (const dv of dvs) {
        if (exArr != null && Math.abs(dv.arrived - exArr) > ANCHOR_MS) continue;
        let ov = [...ovs].reverse().find((o) => o.departed! <= dv.arrived && o.departed! >= input.winStart - 12 * 3600e3) ?? null;
        // this destination stop must be the first one after leaving the origin
        if (ov && dvs.some((d2) => d2 !== dv && d2.arrived >= ov!.departed! && d2.arrived < dv.arrived)) ov = null;
        if (exDep != null && (!ov || Math.abs(ov.departed! - exDep) > ANCHOR_MS) && exArr == null) continue;
        const planned = v.vehicleId === task.plannedVehicleId;
        const score = (planned ? 4 : 0) + (ov ? 3 : 0) + timeBonus(task, dv.arrived) - dv.arrived / 1e14;
        cands.push({ task, v, dv, ov, score, planned });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const done = new Set<number>();
  for (const c of cands) {
    if (done.has(c.task.id) || used.has(useKey(c.v.vehicleId, c.dv))) continue;
    done.add(c.task.id);
    used.add(useKey(c.v.vehicleId, c.dv));
    const destIsBase = c.task.dest!.isBase || sameSpot(c.task.dest, input.base);
    matches.push({
      taskId: c.task.id, kind: "single", vehicleId: c.v.vehicleId, vehicleName: c.v.name, planned: c.planned, score: c.score,
      origin: c.ov, dest: c.dv, returnedBase: destIsBase ? c.dv.arrived : firstBaseAfter(c.v, c.dv.departed), stops: [],
      method: `${c.dv.method}:${c.planned ? "planned_truck" : "other_truck"}`, distM: c.dv.distM,
    });
  }
  for (const t of singles) if (!done.has(t.id)) unmatched.push({ taskId: t.id, reason: t.dest ? "no truck stopped at the delivery address in this window" : "no delivery address" });
  return { matches, unmatched };
}

// ---------- patches (only fields that are still NULL) ----------
export interface Patch { table: "dispatch_tasks" | "dispatch_task_stops"; id: number; set: Record<string, any>; nullCols: string[]; status?: { to: string; from: string[] } }
const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());

function onlyNull(existing: Record<string, any>, want: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(want)) if (v != null && existing[k] == null) out[k] = v;
  return out;
}
/** terminal = the trip ends here (destination is the McCook yard): record the arrival only, not when the truck next leaves. */
function visitFields(x: Visit, vehicleId: number, method: string, terminal = false) {
  const complete = x.departed != null && !terminal;
  return {
    gps_arrived_at: iso(x.arrived), gps_engine_off_at: iso(x.engineOff),
    gps_engine_on_at: complete ? iso(x.engineOn) : null,
    gps_idle_minutes: complete ? x.idleMinutes : null, gps_engine_off_minutes: complete ? x.offMinutes : null,
    gps_vehicle_id: vehicleId, gps_match_method: method, gps_match_distance_m: x.distM,
  };
}
export function buildPatches(m: TaskMatch, task: TaskTarget, nowIso: string): Patch[] {
  const out: Patch[] = [];
  const finish = (table: Patch["table"], id: number, existing: Record<string, any>, want: Record<string, any>, status?: Patch["status"]) => {
    const set = onlyNull(existing, want);
    if (!Object.keys(set).length && !status) return;
    const nullCols = Object.keys(set);
    if (nullCols.length) { if (existing.gps_source == null) set.gps_source = "verizon_reveal"; set.gps_updated_at = nowIso; }
    out.push({ table, id, set, nullCols, status });
  };
  const ex = task.existing;
  if (m.kind === "single") {
    const d = m.dest!, terminal = !!task.dest?.isBase;
    const want: Record<string, any> = {
      gps_departed_at: iso(m.origin?.departed), gps_origin_engine_on_at: iso(m.origin?.engineOn),
      ...visitFields(d, m.vehicleId, m.method, terminal), gps_left_destination_at: terminal ? null : iso(d.departed),
      gps_returned_base_at: iso(m.returnedBase),
    };
    finish("dispatch_tasks", task.id, ex, want);
  } else {
    finish("dispatch_tasks", task.id, ex, {
      gps_departed_at: iso(m.origin?.departed), gps_origin_engine_on_at: iso(m.origin?.engineOn),
      gps_returned_base_at: iso(m.returnedBase), gps_vehicle_id: m.vehicleId, gps_match_method: m.method,
    });
    for (const sm of m.stops) {
      if (!sm.visit) continue;
      const st = task.stops.find((s) => s.id === sm.stopId)!;
      const want = { ...visitFields(sm.visit, m.vehicleId, m.method, sm.isFinalBase), gps_departed_at: sm.isFinalBase ? null : iso(sm.visit.departed) };
      // v3.8.0 status rules: arrival → 'arrived', departure → 'done', final return to base → 'done' on arrival. Never backwards.
      const target = sm.visit.departed != null || sm.isFinalBase ? "done" : "arrived";
      let status: Patch["status"] | undefined;
      if (target === "done" && st.status !== "done") status = { to: "done", from: ["pending", "arrived"] };
      else if (target === "arrived" && st.status === "pending") status = { to: "arrived", from: ["pending"] };
      finish("dispatch_task_stops", st.id, st.existing, want, status);
    }
  }
  return out;
}

// ---------- Central-time helpers ----------
const ctParts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
export function ctYmd(t: number): string { const p = ctParts(t); return `${p.year}-${p.month}-${p.day}`; }
/** UTC instant of local midnight in Chicago for a YYYY-MM-DD date (DST-aware). */
export function ctMidnightUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, 6);
  for (let i = 0; i < 2; i++) {
    const p = ctParts(guess);
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += Date.UTC(y, m - 1, d) - wall;
  }
  return guess;
}
export function ctClock(t: number | null | undefined): string {
  return t == null ? "—" : new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// ---------- places ----------
export interface GeoRow { lat: number | null; lon: number | null; status: string }
export const BASE_NORM = normalizeAddress(BASE_ADDRESS);
export function cacheKey(address: string): string { return normalizeAddress(address) || address.toLowerCase().replace(/\s+/g, " ").trim(); }
/** A geofence for a task/stop address. The McCook yard always uses the pinned parking spot. */
export function makePlace(label: string, address: string | null, geo: GeoRow | null | undefined): Place | null {
  if (!address && !label) return null;
  const norm = normalizeAddress(address);
  const isBase = !!norm && norm === BASE_NORM;
  if (isBase) return { key: "base", label, address: address || BASE_ADDRESS, lat: BASE_LAT, lon: BASE_LON, norm, radius: BASE_RADIUS_M, isBase: true };
  const ok = geo && geo.status === "ok" && geo.lat != null && geo.lon != null;
  if (!ok && !norm) return null; // nothing to match on
  return { key: norm || label.toLowerCase(), label, address: address || "", lat: ok ? geo!.lat : null, lon: ok ? geo!.lon : null, norm, radius: DEFAULT_RADIUS_M };
}
