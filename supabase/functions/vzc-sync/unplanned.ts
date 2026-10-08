// v3.10.0 — automatic UNPLANNED STOPS. Pure functions (no I/O) so they can be tested offline.
// A truck that sits somewhere with the engine off for >= UNPLANNED_MIN_OFF_MIN minutes, away from the McCook yard,
// away from where it spent the night, and away from every planned place of its driver/truck that day, is logged.
import { BASE_RADIUS_M, Ev, haversineM, insideTest, MOVE_KMH, Place, still } from "./match.ts";

export const UNPLANNED_MIN_OFF_MIN = 5;      // engine-off minutes before a stop is logged (config)
export const UNPLANNED_CLUSTER_M = 300;      // a stop = still points within this distance of where the truck first stopped
export const UNPLANNED_MERGE_MS = 10 * 60_000; // re-join one stop split by a short reposition (same lot)
export const UNPLANNED_MERGE_M = 200;
export const UNPLANNED_NAME_M = 250;         // use a saved/known location name if the stop is this close
export const UNPLANNED_IDLE_REPORT_MIN = 10; // engine-running stops this long are only REPORTED in the run summary (not logged)
export const UNPLANNED_MATCH_MS = 3 * 60_000; // an existing row within ±3 min of the arrival is the same stop

export interface StopCluster {
  i0: number; i1: number;
  arrived: number;              // first stopped point
  engineOff: number | null;     // first ignition-off
  engineOn: number | null;      // last ignition-on after an off (null while still off)
  departed: number | null;      // first moving point after the last stopped point (null = still there)
  offMinutes: number;           // engine-off minutes, including an ongoing engine-off up to "now"
  idleMinutes: number | null;   // stopped with the engine running (only once departed)
  stillMinutes: number;         // first to last stopped point (or to now when ongoing)
  lat: number | null; lon: number | null; addr: string | null; norm: string; priv: boolean;
}
export type Verdict = "unplanned" | "clipped" | "other_day" | "private" | "base" | "home" | "planned" | "short" | "idle";
export interface Judged extends StopCluster { verdict: Verdict; planned?: string }

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Every place where the truck sat still (engine on or off), in time order. */
export function stopClusters(tl: Ev[], now: number): StopCluster[] {
  const raw: [number, number][] = [];
  for (let i = 0; i < tl.length; i++) {
    if (!still(tl[i])) continue;
    let anchor: Ev | null = tl[i].lat != null ? tl[i] : null, j = i;
    for (let k = i + 1; k < tl.length; k++) {
      const f = tl[k];
      if (f.kind === "plot" && f.speed > MOVE_KMH) break;
      if (f.lat != null && f.lon != null) {
        if (!anchor) anchor = f;
        else if (haversineM(anchor.lat!, anchor.lon!, f.lat, f.lon) > UNPLANNED_CLUSTER_M) break;
      }
      j = k;
    }
    raw.push([i, j]);
    i = j;
  }
  const build = (i0: number, i1: number): StopCluster => {
    const idx: number[] = [];
    for (let k = i0; k <= i1; k++) if (still(tl[k])) idx.push(k);
    const lastStill = idx[idx.length - 1];
    let engineOff: number | null = null, engineOn: number | null = null, offMs = 0, pendingOff: number | null = null;
    for (let k = i0; k <= i1; k++) {
      const e = tl[k];
      if (e.kind === "off") { if (engineOff == null) engineOff = e.t; if (pendingOff == null) pendingOff = e.t; }
      if (e.kind === "on" && pendingOff != null) { offMs += e.t - pendingOff; pendingOff = null; engineOn = e.t; }
    }
    let departed: number | null = null;
    if (i1 < tl.length - 1) {
      for (let k = lastStill + 1; k <= i1 + 1; k++) {
        const e = tl[k];
        if (e.kind === "plot" && e.speed > MOVE_KMH) { departed = e.t; break; }
        if (k === i1 + 1) departed = e.t;
      }
    }
    if (pendingOff != null) offMs += (departed ?? now) - pendingOff;   // still off (ongoing) or moved without an "on" event
    const arrived = tl[idx[0]].t;
    const offMinutes = Math.round(offMs / 60000);
    const pts = idx.map((k) => tl[k]).filter((e) => e.lat != null && e.lon != null);
    const addrs = new Map<string, number>();
    for (let k = i0; k <= i1; k++) { const a = tl[k].addr; if (a) addrs.set(a, (addrs.get(a) || 0) + (tl[k].kind === "plot" ? 1 : 2)); }
    const addr = [...addrs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const normOf = tl.slice(i0, i1 + 1).find((e) => e.addr === addr)?.norm ?? "";
    return {
      i0, i1, arrived, engineOff, engineOn: pendingOff != null ? null : engineOn, departed, offMinutes,
      idleMinutes: departed != null ? Math.max(0, Math.round((departed - arrived) / 60000) - offMinutes) : null,
      stillMinutes: Math.round(((departed ?? (i1 === tl.length - 1 ? now : tl[lastStill].t)) - arrived) / 60000),
      lat: median(pts.map((e) => e.lat!)), lon: median(pts.map((e) => e.lon!)), addr, norm: normOf,
      priv: tl.slice(i0, i1 + 1).some((e) => e.priv),
    };
  };
  // merge a stop split by a short move inside the same lot
  const merged: [number, number][] = [];
  for (const r of raw) {
    const p = merged[merged.length - 1];
    if (p) {
      const a = build(p[0], p[1]), b = build(r[0], r[1]);
      const gap = tl[r[0]].t - tl[p[1]].t;
      const near = a.lat != null && b.lat != null && haversineM(a.lat, a.lon!, b.lat, b.lon!) <= UNPLANNED_MERGE_M;
      if (gap <= UNPLANNED_MERGE_MS && near) { p[1] = r[1]; continue; }
    }
    merged.push([r[0], r[1]]);
  }
  return merged.map(([a, b]) => build(a, b));
}

/** Where the truck spent the night (its last position before the day starts, else its first position of the day). */
export function homePlace(tl: Ev[], dayStart: number): Place | null {
  const pos = tl.filter((e) => e.lat != null && e.lon != null);
  const before = pos.filter((e) => e.t < dayStart);
  const e = before.length ? before[before.length - 1] : pos[0];
  if (!e) return null;
  return { key: "home", label: "overnight spot", address: e.addr || "", lat: e.lat, lon: e.lon, norm: e.norm, radius: BASE_RADIUS_M };
}

export interface DetectInput {
  tl: Ev[]; now: number; dayStart: number; dayEnd: number;
  base: Place; home: Place | null; planned: Place[]; minOffMin?: number;
}
/** Judge every stop of one truck for one day. */
export function detectStops(inp: DetectInput): Judged[] {
  const minOff = inp.minOffMin ?? UNPLANNED_MIN_OFF_MIN;
  const out: Judged[] = [];
  for (const c of stopClusters(inp.tl, inp.now)) {
    const evs = inp.tl.slice(c.i0, c.i1 + 1);
    const inside = (p: Place) => evs.some((e) => insideTest(e, p).ok) ||
      (c.lat != null && p.lat != null && haversineM(c.lat, c.lon!, p.lat, p.lon!) <= p.radius);
    let verdict: Verdict, planned: string | undefined;
    if (c.arrived < inp.dayStart || c.arrived >= inp.dayEnd) verdict = c.i0 === 0 || c.arrived < inp.dayStart ? "clipped" : "other_day";
    else if (c.i0 === 0) verdict = "clipped";                 // already stopped when the data starts
    else if (c.priv) verdict = "private";
    else if (inside(inp.base)) verdict = "base";
    else if (inp.home && inside(inp.home)) verdict = "home";
    else if ((planned = inp.planned.find(inside)?.label) != null) verdict = "planned";
    else if (c.offMinutes >= minOff) verdict = "unplanned";
    else verdict = c.stillMinutes >= UNPLANNED_IDLE_REPORT_MIN && c.offMinutes === 0 ? "idle" : "short";
    out.push({ ...c, verdict, planned });
  }
  return out;
}

// ---------- attach to a route / single task / driver ----------
export interface TaskSpan {
  taskId: number; kind: "single" | "route"; driverId: number | null;
  start: number | null;          // left the origin (or first known time)
  end: number | null;            // returned to base / completed (null = still open)
  anchors: number[];             // every known time on this task (origin left, stop/dest arrive/leave)
  stops: { id: number; seq: number; t: number | null }[]; // route stops with the time the truck got there
}
export interface Attach { taskId: number | null; afterStopId: number | null; kind: "route" | "single" | "driver" }
/** The task the truck was working on when it stopped: last anchor before the arrival, no yard return in between, task not over. */
export function attachStop(arrived: number, spans: TaskSpan[], baseArrivals: number[]): Attach {
  let best: { s: TaskSpan; last: number } | null = null;
  for (const s of spans) {
    const before = s.anchors.filter((t) => t <= arrived);
    if (!before.length || (s.start != null && arrived < s.start)) continue;
    if (s.end != null && arrived > s.end) continue;
    const last = Math.max(...before);
    if (baseArrivals.some((b) => b > last && b < arrived)) continue;   // went back to the yard first
    if (!best || last > best.last) best = { s, last };
  }
  if (!best) return { taskId: null, afterStopId: null, kind: "driver" };
  if (best.s.kind === "single") return { taskId: best.s.taskId, afterStopId: null, kind: "single" };
  const prev = best.s.stops.filter((x) => x.t != null && x.t <= arrived).sort((a, b) => b.t! - a.t! || b.seq - a.seq)[0];
  return { taskId: best.s.taskId, afterStopId: prev?.id ?? null, kind: "route" };
}

// ---------- naming ----------
/** Built-in locations of the dashboard (index.html LOC) — used only to NAME an unplanned stop. */
export const BUILTIN_LOCATIONS: [string, string][] = [["ALG", "1053 N Schmidt Rd, Romeoville, IL 60446"], ["ENRU", "1000 Windham Pkwy, Bolingbrook, IL 60490"], ["Darwill Hillside", "11900 Roosevelt Rd, Hillside, IL 60162"], ["Darwill McCook", "8701 47th St Ste C, McCook, IL 60525"], ["South Suburban Post Office", "6801 W 73rd St, Bedford Park, IL 60499"], ["Fox Valley Post Office", "3900 Gabrielle Ln, Aurora, IL 60598"], ["Carol Stream Post Office", "550 E Fullerton Ave, Carol Stream, IL 60188"], ["Worth Post Office", "11114 S Harlem Ave, Worth, IL 60482"], ["Bolingbrook Post Office", "105 Canterbury Ln, Bolingbrook, IL 60440"], ["Darwill Oakbrook Tower Terrace", "1 Tower Ln, Oakbrook Terrace, IL 60181"], ["Envelopes Only", "2000 S Park Ave, Streamwood, IL 60107"], ["Federal Envelope", "608 Country Club Dr, Bensenville, IL 60106"], ["Universal Laminating", "910 Carlow Dr Ste A, Bolingbrook, IL 60490"], ["Platinum Converting", "1560 W Stearns Rd, Bartlett, IL 60103"], ["Victor Envelope", "301 Arthur Ct, Bensenville, IL 60106"], ["Supremex Naperville", "1500 Shore Rd, Naperville, IL 60563"], ["Supremex Chicago", "4114 S Peoria St, Chicago, IL 60609"], ["MSI", "1501 Morse Ave, Elk Grove Village, IL 60007"], ["Palatine Post Office", "1300 E Northwest Hwy, Palatine, IL 60095"]];
export interface NamedPlace { name: string; address: string; place: Place; savedId: number | null }
export function nameFor(c: { lat: number | null; lon: number | null; norm: string }, named: NamedPlace[]): NamedPlace | null {
  let best: { n: NamedPlace; d: number } | null = null;
  for (const n of named) {
    const p = n.place;
    let d: number | null = null;
    if (c.lat != null && p.lat != null) d = haversineM(c.lat, c.lon!, p.lat, p.lon!);
    const addrHit = !!(c.norm && p.norm && c.norm === p.norm);
    if (addrHit) d = Math.min(d ?? 0, 0);
    if (d == null || d > UNPLANNED_NAME_M) continue;
    // saved customers win ties
    const score = d - (n.savedId != null ? 1 : 0);
    if (!best || score < best.d) best = { n, d: score };
  }
  return best?.n ?? null;
}
