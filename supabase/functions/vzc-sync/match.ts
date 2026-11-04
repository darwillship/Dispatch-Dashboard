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
  completedAt: number | null; scheduledAt: number | null; createdAt: number | null; assignedAt?: number | null;
  /** v4.0.0: the assigned driver's clearly scheduled shift windows (UTC ms). An after-the-fact match must start inside one. */
  shiftWindows?: [number, number][] | null;
  /** v4.0.0: dispatch_tasks.vehicle_id is set — match ONLY this truck (beats gps_vehicle_id and the schedule). */
  vehicleLocked?: boolean;
  /** v4.10.0: trip GPS cutoff (dispatch_tasks.gps_since). Set when tasks are combined (earliest assignment of the
   *  originals) or when a trip is split at a McCook return (the McCook departure). Wins over created/assigned. */
  gpsSince?: number | null;
  /** v4.10.0: ids of the original tasks combined into this route. Their stored visits are not "someone else's". */
  memberIds?: number[];
  /** v4.10.1: created/assigned times of the ORIGINAL tasks of a combined route (nested routes flattened). The route's
   *  window starts at the earliest late-assignment gate of these (see lateAssignGate), never later than gps_since. */
  members?: { createdAt: number | null; assignedAt: number | null }[];
}
/** A destination (or stop) visit already recorded in the DB — used so a filled task's visit can't be re-claimed by a later open task. */
export interface ClaimedVisit { vehicleId: number; arrived: number; ownerTaskId: number; ownerStopId?: number | null }
export interface VehicleTrack { vehicleId: number; name: string; tl: Ev[] }
export interface DayInput {
  date: string; tasks: TaskTarget[]; vehicles: VehicleTrack[]; base: Place; winStart: number; winEnd: number;
  /** false (default): a driver with a planned truck is only matched to that truck. Drivers without one can match any truck. */
  allowOtherTruck?: boolean;
  /** Visits already stored on tasks/stops for this date (including filled/skipped ones). Same vehicle + arrived within CLAIM_MS = same physical visit. */
  claimed?: ClaimedVisit[];
}
export interface StopMatch { stopId: number; seq: number; visit: Visit | null; isFinalBase: boolean }
/** v4.10.0: the truck came back to McCook after finishing some stops while others are still open → close the trip there. */
export interface TripSplit { baseArrived: number; baseDeparted: number | null; keepStopIds: number[]; moveStopIds: number[] }
export interface TaskMatch {
  taskId: number; kind: "single" | "route"; vehicleId: number; vehicleName: string; planned: boolean; score: number;
  origin: Visit | null; dest: Visit | null; returnedBase: number | null; stops: StopMatch[]; method: string; distM: number | null;
  /** v4.10.0: single task where only the pickup visit has been seen so far (dest is null). */
  partial?: boolean;
  split?: TripSplit | null;
  /** v4.10.1: the GPS window start actually used for this task on this truck. */
  gate?: number | null;
  /** v4.10.1: the origin is the McCook yard (its "arrival" is clamped to the window start — the truck may have sat there overnight). */
  originBase?: boolean;
}

const sameSpot = (a: Place | null, b: Place | null) =>
  !!a && !!b && ((a.norm && a.norm === b.norm) || (a.lat != null && b.lat != null && haversineM(a.lat, a.lon!, b.lat, b.lon!) < 60));
const toMs = (v: any): number | null => (v == null ? null : typeof v === "number" ? v : Date.parse(v));

/** Grace before created_at: a trip that left ~10 min before the dispatcher typed it still counts as "fresh". */
export const CREATED_GRACE_MS = 10 * 60_000;
/** Same vehicle + arrival within this window = one physical visit (blocks double-claims across tasks). */
export const CLAIM_MS = 3 * 60_000;

/** Earliest epoch a trip may start for this task: min(created_at − grace, scheduled_at if set and earlier). Null = no gate. */
export function earliestTripStart(task: TaskTarget): number | null {
  let e: number | null = task.createdAt != null ? task.createdAt - CREATED_GRACE_MS : null;
  if (task.scheduledAt != null && (e == null || task.scheduledAt < e)) e = task.scheduledAt;
  return e;
}
/** v4.4.1: only GPS at/after this counts toward completing a task = max(created_at, assigned_at). */
export function gpsGate(createdAt: number | null | undefined, assignedAt: number | null | undefined): number | null {
  const xs = [createdAt, assignedAt].filter((x): x is number => x != null && !isNaN(x));
  return xs.length ? Math.max(...xs) : null;
}
/** v4.10.0: the trip cutoff — gps_since when set (combined/split trips), else max(created_at, assigned_at). */
export function taskGate(task: Pick<TaskTarget, "gpsSince" | "createdAt" | "assignedAt">): number | null {
  return task.gpsSince != null && !isNaN(task.gpsSince) ? task.gpsSince : gpsGate(task.createdAt, task.assignedAt);
}
/**
 * v4.10.1 late assignment: a task assigned after it was created starts its GPS window at the end of the truck's previous
 * trip = the truck's last McCook departure at/before the assignment (same day), instead of at the assignment time.
 * Never before created_at. Unchanged when there is no such departure, when the truck was sitting at McCook at the
 * assignment time (nothing happened yet), or when the task was assigned as it was created.
 */
export function lateAssignGate(createdAt: number | null | undefined, assignedAt: number | null | undefined,
  baseVisits: { arrived: number; departed: number | null }[], dayStart: number): number | null {
  const g = gpsGate(createdAt, assignedAt);
  if (g == null || assignedAt == null || isNaN(assignedAt) || createdAt == null || isNaN(createdAt) || assignedAt <= createdAt) return g;
  if (baseVisits.some((b) => b.arrived <= assignedAt && (b.departed == null || b.departed > assignedAt))) return g; // at McCook when assigned
  const deps = baseVisits.map((b) => b.departed).filter((d): d is number => d != null && d <= assignedAt && d >= dayStart);
  if (!deps.length) return g;
  return Math.max(createdAt, Math.max(...deps));
}
/** v4.4.1: pickup = goods come back to McCook (task_type pickup, or destination is the yard and the origin is not). */
export function isPickupTask(taskType: any, destIsBase: boolean, originIsBase: boolean): boolean {
  return String(taskType || "").toLowerCase() === "pickup" || (destIsBase && !originIsBase);
}
/** Origin departure when known, else destination/stop arrival. */
export function tripStartMs(originDeparted: number | null | undefined, arrived: number): number {
  return originDeparted != null ? originDeparted : arrived;
}

export function matchDay(input: DayInput): { matches: TaskMatch[]; unmatched: { taskId: number; reason: string }[] } {
  const cache = new Map<string, Visit[]>();
  const visits = (v: VehicleTrack, p: Place) => {
    const k = `${v.vehicleId}|${p.key}`;
    if (!cache.has(k)) cache.set(k, computeVisits(v.tl, p, v.vehicleId));
    return cache.get(k)!;
  };
  const inWin = (x: Visit) => !x.clipped && x.arrived >= input.winStart && x.arrived <= input.winEnd;
  /** v4.10.1: window start for this task on this truck — late assignments reach back to the truck's last McCook departure.
   *  Routes: earliest gate of their original tasks, never later than the stored gps_since. Split trips (no originals): gps_since. */
  const gateFor = (task: TaskTarget, v: VehicleTrack): number | null => {
    const stored = task.gpsSince != null && !isNaN(task.gpsSince) ? task.gpsSince : null;
    const bv = visits(v, input.base);
    const xs = (task.members?.length ? task.members : task.kind === "single" && stored == null ? [{ createdAt: task.createdAt, assignedAt: task.assignedAt ?? null }] : [])
      .map((m) => lateAssignGate(m.createdAt, m.assignedAt, bv, input.winStart)).filter((x): x is number => x != null);
    const late = xs.length ? Math.min(...xs) : null;
    if (stored != null) return late != null ? Math.min(stored, late) : stored;
    return late ?? taskGate(task);
  };
  const used = new Set<string>();
  const useKey = (vid: number, x: Visit) => `${vid}|${x.placeKey}|${x.arrived}`;
  /** True when another task/stop already owns this physical visit (DB claim or this-run claim). */
  const runClaims: ClaimedVisit[] = [];   // claims made earlier in this run (routes first, then singles best-first)
  const members = new Map<number, Set<number>>();
  for (const t of input.tasks) if (t.memberIds?.length) members.set(t.id, new Set(t.memberIds));
  const claimedByOther = (vid: number, arrived: number, selfTaskId: number) =>
    [...(input.claimed || []), ...runClaims].some((c) => c.ownerTaskId !== selfTaskId && !members.get(selfTaskId)?.has(c.ownerTaskId) && c.vehicleId === vid && Math.abs(c.arrived - arrived) <= CLAIM_MS);
  /**
   * Time gate (v3.12.0): prefer trips that start at/after earliestTripStart.
   * After-the-fact entry (whole visit ended before created_at − grace): allow only when unclaimed, with a score penalty.
   * Manual anchors (existing gps_* within ANCHOR_MS) skip the gate so a typed time still wins.
   */
  const timeOk = (task: TaskTarget, v: VehicleTrack, dv: Visit, hasManualAnchor: boolean): { ok: boolean; afterFact: boolean } => {
    // v4.4.1: no more "after-the-fact" matches. The destination arrival (and for pickups the pickup departure)
    // must be at/after the window start (v4.10.1: gateFor). Typed (manual) anchors still win.
    if (hasManualAnchor) return { ok: true, afterFact: false };
    const gate = gateFor(task, v);
    if (gate != null && dv.arrived < gate) return { ok: false, afterFact: false };
    if (task.scheduledAt == null || gate == null) return { ok: true, afterFact: false };
    return { ok: true, afterFact: false };
  };
  const firstBaseAfter = (v: VehicleTrack, t: number | null) =>
    t == null ? null : visits(v, input.base).find((b) => !b.clipped && b.arrived > t)?.arrived ?? null;
  const timeBonus = (task: TaskTarget, t: number) => {
    let s = 0;
    if (task.completedAt != null && t >= task.completedAt - 6 * 3600e3 && t <= task.completedAt + 20 * 60e3) s += 3;
    if (task.scheduledAt != null && Math.abs(t - task.scheduledAt) <= 4 * 3600e3) s += 1;
    return s;
  };
  const vehiclesFor = (task: TaskTarget) =>
    task.vehicleLocked && task.plannedVehicleId ? input.vehicles.filter((v) => v.vehicleId === task.plannedVehicleId)
    : task.existing.gps_vehicle_id ? input.vehicles.filter((v) => v.vehicleId === Number(task.existing.gps_vehicle_id))
    : task.plannedVehicleId && !input.allowOtherTruck ? input.vehicles.filter((v) => v.vehicleId === task.plannedVehicleId)
    : input.vehicles;
  const matches: TaskMatch[] = [], unmatched: { taskId: number; reason: string }[] = [];

  // ---- routes first (more specific) ----
  // v4.10.0: stops may be visited in ANY order (the real GPS order wins); only visits at/after the trip cutoff count
  // (gps_since, else max(created_at, assigned_at)); typed/stored times still anchor within ANCHOR_MS.
  // A return to McCook after some stops are finished while others are still open = the trip ends there (split).
  for (const task of input.tasks.filter((t) => t.kind === "route")) {
    const n = task.stops.length;
    const last = task.stops[n - 1];
    const finalBase = !!last && (!!last.place.isBase || sameSpot(last.place, input.base));
    const work = task.stops.map((_, i) => i).filter((i) => !(finalBase && i === n - 1));
    const oBase = !!task.origin && (!!task.origin.isBase || sameSpot(task.origin, input.base));
    const exDep = toMs(task.existing.gps_departed_at);
    const finalAnchor = finalBase ? toMs(last.existing.gps_arrived_at) : null;
    let best: TaskMatch | null = null;
    for (const v of vehiclesFor(task)) {
      const gate = gateFor(task, v);
      const taken = new Set<string>();
      const free = (x: Visit) => !used.has(useKey(v.vehicleId, x)) && !taken.has(useKey(v.vehicleId, x)) && !claimedByOther(v.vehicleId, x.arrived, task.id);
      const ok = (x: Visit, anchor: number | null) => inWin(x) && free(x) &&
        (anchor != null ? Math.abs(x.arrived - anchor) <= ANCHOR_MS : gate == null || x.arrived >= gate);
      const chain: (Visit | null)[] = task.stops.map(() => null);
      for (const i of work) {
        const anchor = toMs(task.stops[i].existing.gps_arrived_at);
        const cs = visits(v, task.stops[i].place).filter((x) => ok(x, anchor));
        const pick = anchor != null ? cs.sort((p, q) => Math.abs(p.arrived - anchor) - Math.abs(q.arrived - anchor))[0] : cs[0];
        if (pick) { chain[i] = pick; taken.add(useKey(v.vehicleId, pick)); }
      }
      const arrivals = work.filter((i) => chain[i]).map((i) => chain[i]!.arrived);
      const firstStop = arrivals.length ? Math.min(...arrivals) : Infinity;
      let ov: Visit | null = null;
      if (task.origin) {
        const ovs = visits(v, task.origin).filter((o) => o.departed != null && !taken.has(useKey(v.vehicleId, o)));
        if (exDep != null) ov = ovs.find((o) => Math.abs(o.departed! - exDep) <= ANCHOR_MS) ?? null;
        else if (oBase) {
          // left the yard: last departure before the first stop (or, with nothing visited yet, after the cutoff)
          ov = [...ovs].reverse().find((o) => o.departed! <= firstStop && o.departed! >= input.winStart - 12 * 3600e3 &&
            (firstStop !== Infinity ? (task.gpsSince == null || o.departed! >= task.gpsSince - CLAIM_MS) : gate == null || o.departed! >= gate)) ?? null;
        } else ov = ovs.find((o) => inWin(o) && (gate == null || o.arrived >= gate)) ?? null; // the start is a pickup: any order, after the cutoff
        if (ov && !oBase) taken.add(useKey(v.vehicleId, ov));
      }
      const visited = work.filter((i) => chain[i]);
      if (!visited.length && !ov) continue;
      // back at McCook after finishing something on this trip?
      const finished = [...visited.map((i) => chain[i]!.departed), ov && !oBase ? ov.departed : null].filter((x): x is number => x != null);
      const firstDone = finished.length ? Math.min(...finished) : null;
      let back: Visit | null = null;
      if (finalAnchor != null) back = visits(v, input.base).find((b) => Math.abs(b.arrived - finalAnchor) <= ANCHOR_MS && free(b)) ?? null;
      else if (firstDone != null) back = visits(v, input.base).find((b) => !b.clipped && b.arrived > firstDone && free(b) && !taken.has(useKey(v.vehicleId, b))) ?? null;
      let split: TripSplit | null = null, ret: Visit | null = null;
      if (back) {
        const after = work.filter((i) => !chain[i] || chain[i]!.arrived > back!.arrived);
        if (!after.length || finalAnchor != null) ret = back;
        else {
          ret = back;
          split = {
            baseArrived: back.arrived, baseDeparted: back.departed,
            keepStopIds: work.filter((i) => !after.includes(i)).map((i) => task.stops[i].id),
            moveStopIds: after.map((i) => task.stops[i].id),
          };
          for (const i of after) chain[i] = null; // those visits belong to the next trip (matched there with its own cutoff)
        }
      }
      if (finalBase && ret && !split) chain[n - 1] = ret;
      const nv = chain.filter(Boolean).length;
      const firstT = Math.min(firstStop, ov?.arrived ?? Infinity);
      const planned = v.vehicleId === task.plannedVehicleId;
      const score = nv * 3 + (planned ? 4 : 0) + (ov ? 2 : 0) + timeBonus(task, firstT) - firstT / 1e14;
      if (!best || score > best.score) {
        const any = (chain.find(Boolean) ?? ov)!;
        const ds = chain.filter(Boolean).map((x) => x!.distM ?? 0);
        best = {
          taskId: task.id, kind: "route", vehicleId: v.vehicleId, vehicleName: v.name, planned, score,
          origin: ov, dest: null, returnedBase: ret?.arrived ?? null, split, gate, originBase: oBase,
          stops: task.stops.map((s, i) => ({ stopId: s.id, seq: s.seq, visit: chain[i], isFinalBase: finalBase && i === n - 1 })),
          method: `${any.method}:${planned ? "planned_truck" : "other_truck"}`,
          distM: ds.length ? Math.max(...ds) : ov?.distM ?? null,
        };
      }
    }
    if (best) {
      matches.push(best);
      best.stops.forEach((s) => { if (s.visit) { used.add(useKey(best!.vehicleId, s.visit)); runClaims.push({ vehicleId: best!.vehicleId, arrived: s.visit.arrived, ownerTaskId: task.id, ownerStopId: s.stopId }); } });
    }
    else unmatched.push({ taskId: task.id, reason: "no truck stopped at any stop of this route" });
  }

  // ---- single tasks: score every (truck, destination visit), then assign best-first; a visit is used once ----
  type Cand = { task: TaskTarget; v: VehicleTrack; dv: Visit; ov: Visit | null; score: number; planned: boolean; gate: number | null; oBase: boolean };
  const cands: Cand[] = [];
  const singles = input.tasks.filter((t) => t.kind === "single");
  for (const task of singles) {
    if (!task.dest) continue;
    const exArr = toMs(task.existing.gps_arrived_at), exDep = toMs(task.existing.gps_departed_at);
    const oBase = !!task.origin && (!!task.origin.isBase || sameSpot(task.origin, input.base));
    for (const v of vehiclesFor(task)) {
      const g = gateFor(task, v);
      const dvs = visits(v, task.dest).filter(inWin);
      const ovs = task.origin && !sameSpot(task.origin, task.dest) ? visits(v, task.origin).filter((o) => o.departed != null) : [];
      for (const dv of dvs) {
        if (used.has(useKey(v.vehicleId, dv)) || claimedByOther(v.vehicleId, dv.arrived, task.id)) continue;
        if (exArr != null && Math.abs(dv.arrived - exArr) > ANCHOR_MS) continue;
        // v4.10.1: a pickup only counts as reached at/after the window start (McCook: the truck may have been parked there before it)
        let ov = [...ovs].reverse().find((o) => o.departed! <= dv.arrived && o.departed! >= input.winStart - 12 * 3600e3 &&
          (oBase || exDep != null || g == null || o.arrived >= g)) ?? null;
        // this destination stop must be the first one after leaving the origin
        if (ov && dvs.some((d2) => d2 !== dv && d2.arrived >= ov!.departed! && d2.arrived < dv.arrived)) ov = null;
        if (exDep != null && (!ov || Math.abs(ov.departed! - exDep) > ANCHOR_MS) && exArr == null) continue;
        const gate = timeOk(task, v, dv, exArr != null || exDep != null);
        if (!gate.ok) continue;
        {
          const dBase = !!task.dest.isBase || sameSpot(task.dest, input.base);
          if (isPickupTask(task.existing.task_type, dBase, oBase) && exArr == null) {
            if (!ov || ov.departed == null || (g != null && ov.departed < g)) continue;   // never "returned to base" without visiting the pickup first
          }
        }
        const planned = v.vehicleId === task.plannedVehicleId;
        const score = (planned ? 4 : 0) + (ov ? 3 : 0) + timeBonus(task, dv.arrived) - (gate.afterFact ? 5 : 0) - dv.arrived / 1e14;
        cands.push({ task, v, dv, ov, score, planned, gate: g, oBase });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const done = new Set<number>();
  for (const c of cands) {
    if (done.has(c.task.id) || used.has(useKey(c.v.vehicleId, c.dv)) || claimedByOther(c.v.vehicleId, c.dv.arrived, c.task.id)) continue;
    done.add(c.task.id);
    used.add(useKey(c.v.vehicleId, c.dv));
    runClaims.push({ vehicleId: c.v.vehicleId, arrived: c.dv.arrived, ownerTaskId: c.task.id });
    const destIsBase = c.task.dest!.isBase || sameSpot(c.task.dest, input.base);
    matches.push({
      taskId: c.task.id, kind: "single", vehicleId: c.v.vehicleId, vehicleName: c.v.name, planned: c.planned, score: c.score,
      origin: c.ov, dest: c.dv, returnedBase: destIsBase ? c.dv.arrived : firstBaseAfter(c.v, c.dv.departed), stops: [],
      method: `${c.dv.method}:${c.planned ? "planned_truck" : "other_truck"}`, distM: c.dv.distM, gate: c.gate, originBase: c.oBase,
    });
  }
  // v4.10.0: pickup seen, delivery not yet → record the pickup visit now (gps_origin_arrived_at / gps_departed_at).
  for (const t of singles) {
    if (done.has(t.id) || !t.origin || t.origin.isBase || sameSpot(t.origin, input.base) || sameSpot(t.origin, t.dest)) continue;
    if (toMs(t.existing.gps_arrived_at) != null) continue;
    const exDep = toMs(t.existing.gps_departed_at), exOA = toMs(t.existing.gps_origin_arrived_at);
    let bp: TaskMatch | null = null;
    for (const v of vehiclesFor(t)) {
      const g = gateFor(t, v);
      const ov = visits(v, t.origin).find((o) => inWin(o) &&
        (exOA != null ? Math.abs(o.arrived - exOA) <= ANCHOR_MS : exDep != null ? o.departed != null && Math.abs(o.departed - exDep) <= ANCHOR_MS : g == null || o.arrived >= g));
      if (!ov) continue;
      const planned = v.vehicleId === t.plannedVehicleId;
      const score = (planned ? 4 : 0) - ov.arrived / 1e14;
      if (!bp || score > bp.score) bp = {
        taskId: t.id, kind: "single", vehicleId: v.vehicleId, vehicleName: v.name, planned, score, origin: ov, dest: null,
        returnedBase: null, stops: [], method: `${ov.method}:pickup_seen:${planned ? "planned_truck" : "other_truck"}`, distM: ov.distM, partial: true, gate: g, originBase: false,
      };
    }
    if (bp) { matches.push(bp); done.add(t.id); }
  }
  for (const t of singles) if (!done.has(t.id)) unmatched.push({ taskId: t.id, reason: t.dest ? "no truck stopped at the delivery address in this window" : "no delivery address" });
  return { matches, unmatched };
}

// ---------- auto status (v3.12.0, forward-only) ----------
/** Statuses the updater may move forward from. Everything else (pending/planned, completed, missed, refused, cancelled…) is left alone. */
export const AUTO_FROM: Record<"in_progress" | "completed", string[]> = { in_progress: ["assigned"], completed: ["assigned", "in_progress"] };
/**
 * What GPS says the status should be. Single: arrived at destination and left again → completed (at = arrival);
 * at the destination now or left origin → in_progress.
 * Route: left origin (or reached any stop) → in_progress; route completion stays with the stop trigger.
 * Stored gps_* values win over this run's match. Null = nothing to do. status_source 'manual' = hands off.
 */
export function autoStatusFor(t: Record<string, any>, stopRows: Record<string, any>[], m?: TaskMatch | null, now = Date.now()): { to: "in_progress" | "completed"; at: number; force?: boolean } | null {
  // v4.10.0 self-correction: GPS proof of completion wins even over a status set by hand (force = the RPC may override
  // status_source 'manual'). Forward-only: a completed task is never reopened.
  const manual = t.status_source === "manual";
  const st = String(t.status || "");
  const ms = (v: any) => (v == null ? null : Date.parse(v));
  const firstOf = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => x != null).sort((a, b) => a - b)[0] ?? null;
  if (t.is_route) {
    if (stopRows.length && stopRows.every((x) => x.status === "done") && AUTO_FROM.completed.includes(st)) {
      const arr = stopRows.map((x) => ms(x.gps_arrived_at)).filter((x): x is number => x != null);
      return { to: "completed", at: arr.length ? Math.max(...arr) : now, force: true };
    }
    if (manual) return null;
    const left = ms(t.gps_departed_at) ?? m?.origin?.departed ?? firstOf(stopRows.map((x) => ms(x.gps_arrived_at))) ?? firstOf((m?.stops || []).map((x) => x.visit?.arrived));
    return left != null && AUTO_FROM.in_progress.includes(st) ? { to: "in_progress", at: left } : null;
  }
  const arr = ms(t.gps_arrived_at) ?? m?.dest?.arrived ?? null;
  // v4.4.1 rules. Only GPS at/after the trip cutoff counts (gps_since, else max(created_at, assigned_at)).
  //  DELIVERY: completed on geofence arrival at the delivery address (completed_at = arrival).
  //  PICKUP:   completed on arrival back at McCook, after the truck left the pickup address (both after the gate).
  const gate = m?.gate ?? ms(t.gps_since) ?? gpsGate(ms(t.created_at), ms(t.assigned_at));   // v4.10.1: the matcher's window start wins
  const okT = (x: number | null) => x != null && (gate == null || x >= gate);
  const terminal = normalizeAddress(t.delivery_address) === BASE_NORM;
  const originBase = normalizeAddress(t.pickup_address) === BASE_NORM;
  const pickup = isPickupTask(t.task_type, terminal, originBase);
  const dep = ms(t.gps_departed_at) ?? m?.origin?.departed ?? null;
  if (okT(arr) && (!pickup || (okT(dep) && dep! <= arr!))) return AUTO_FROM.completed.includes(st) ? { to: "completed", at: arr!, force: manual } : null;
  if (manual) return null;
  if (okT(dep)) return AUTO_FROM.in_progress.includes(st) ? { to: "in_progress", at: dep! } : null;
  return null;
}

// ---------- self-correction from stored times (v4.10.0) ----------
export const FLAG_MANUAL_NO_GPS = "manual_complete_no_gps";
const isBaseAddr = (a: any) => normalizeAddress(a) === BASE_NORM;
/**
 * Runs on every sync from what is already stored (no GPS needed):
 *  - a stop with a stored GPS departure (or the final McCook return with an arrival) is 'done', even if someone set it back;
 *  - a completed task with no GPS visit at all gets the flag "Complete by hand, no GPS visit" (cleared once GPS shows one).
 * Never reopens anything.
 */
export function selfCorrections(tasks: Record<string, any>[], stopsByTask: Map<number, Record<string, any>[]>):
  { stopDone: { id: number; taskId: number }[]; flags: { id: number; flag: string | null }[] } {
  const stopDone: { id: number; taskId: number }[] = [], flags: { id: number; flag: string | null }[] = [];
  for (const t of tasks) {
    if (t.combined_into_task_id || t.messenger_id) continue;
    const st = [...(stopsByTask.get(Number(t.id)) || [])].sort((a, b) => a.seq - b.seq || a.id - b.id);
    if (t.is_route) {
      st.forEach((s, i) => {
        const finalBase = i === st.length - 1 && isBaseAddr(s.location_address);
        if (s.status !== "done" && (s.gps_departed_at != null || (finalBase && s.gps_arrived_at != null))) stopDone.push({ id: Number(s.id), taskId: Number(t.id) });
      });
    }
    if (String(t.status) === "completed" || t.status_flag != null) {
      const evidence = t.is_route ? st.some((s) => s.gps_arrived_at != null) || t.gps_departed_at != null
        : t.gps_arrived_at != null || t.gps_departed_at != null || t.gps_origin_arrived_at != null;
      const want = String(t.status) === "completed" && !evidence && t.status_source !== "auto_gps" ? FLAG_MANUAL_NO_GPS : null;
      if ((t.status_flag ?? null) !== want && (t.status_flag == null || t.status_flag === FLAG_MANUAL_NO_GPS)) flags.push({ id: Number(t.id), flag: want });
    }
  }
  return { stopDone, flags };
}

// ---------- patches (only fields that are still NULL) ----------
export interface Patch { table: "dispatch_tasks" | "dispatch_task_stops"; id: number; set: Record<string, any>; nullCols: string[]; status?: { to: string; from: string[] };
  /** v4.10.1: move dispatch_tasks.gps_since EARLIER to this ISO time (late assignment); written only if empty or later. */
  since?: string }
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
  // v4.10.1: McCook origin — the truck may have been parked there overnight; the trip starts no earlier than the window start
  const oArr = (o: Visit | null | undefined) => (o == null ? null : m.originBase && m.gate != null ? Math.max(o.arrived, m.gate) : o.arrived);
  // v4.10.1: keep the late-assignment window start on the task so status checks and later runs use it
  {
    const def = gpsGate(task.createdAt, task.assignedAt ?? null), cur = task.gpsSince ?? null;
    if (m.gate != null && (cur != null ? m.gate < cur : def != null && m.gate < def)) out.push({ table: "dispatch_tasks", id: task.id, set: {}, nullCols: [], since: iso(m.gate)! });
  }
  if (m.kind === "single" && !m.dest) {
    // v4.10.0: pickup seen, delivery not yet
    finish("dispatch_tasks", task.id, ex, {
      gps_origin_arrived_at: iso(oArr(m.origin)), gps_departed_at: iso(m.origin?.departed), gps_origin_engine_on_at: iso(m.origin?.engineOn),
      gps_vehicle_id: m.vehicleId, gps_match_method: m.method,
    });
  } else if (m.kind === "single") {
    const d = m.dest!, terminal = !!task.dest?.isBase;
    const want: Record<string, any> = {
      gps_origin_arrived_at: iso(oArr(m.origin)), gps_departed_at: iso(m.origin?.departed), gps_origin_engine_on_at: iso(m.origin?.engineOn),
      ...visitFields(d, m.vehicleId, m.method, terminal), gps_left_destination_at: terminal ? null : iso(d.departed),
      gps_returned_base_at: iso(m.returnedBase),
    };
    finish("dispatch_tasks", task.id, ex, want);
  } else {
    finish("dispatch_tasks", task.id, ex, {
      gps_origin_arrived_at: iso(oArr(m.origin)), gps_departed_at: iso(m.origin?.departed), gps_origin_engine_on_at: iso(m.origin?.engineOn),
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
