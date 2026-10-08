// vzc-sync / assign.ts (v3.11.0) — pure logic: who was driving a truck at a given moment, and automatic truck assignment.
// No database or network access here (sync.ts does the reads/writes), so it is fully unit-testable.
import type { Ev } from "./match.ts";

export const SHIFT_SLACK_BEFORE_MS = 60 * 60_000;  // drivers start up to 1 h before their scheduled start
export const SHIFT_SLACK_AFTER_MS = 60 * 60_000;   // ...and finish up to 1 h after their scheduled end
export const TIMESHEET_WINDOW_MS = 30 * 60_000;    // a Time Sheet clock-in / pre-trip naming the truck within 30 min of ignition wins
export const IGNITION_MIN_OFF_MS = 20 * 60_000;    // "truck turns on" = ignition after >= 20 min off, or first movement after >= 20 min still
export const AUTO_ASSIGN_LOOKBACK_MS = 3 * 3600_000; // live runs only act on ignitions from the last 3 h (no surprise back-filling)
const WORKING = new Set(["working", "messenger"]);

export interface DriverRow { id: number; name: string; active: boolean | null; default_vehicle_id: number | null }
export interface SchedRow { id?: number; driver_id: number; work_date: string; status: string | null; start_time: string | null; end_time: string | null; vehicle_id: number | null; vehicle_source?: string | null; auto_assigned_at?: string | null }
export interface WeeklyRow { driver_id: number; day_of_week: number; working: boolean | null; start_time: string | null; end_time: string | null }
export interface Shift {
  driverId: number; name: string; date: string; working: boolean;
  start: number | null; end: number | null;          // UTC ms (end on the next day for overnight shifts)
  timesFrom: "override" | "weekly" | null;           // where the shift times came from (null = no times anywhere)
  vehicleId: number | null; vehicleSource: "override" | "default" | null; auto: boolean;
  row: SchedRow | null; weekly: WeeklyRow | null; active: boolean;
}

// ---- CT clock helpers (DST-safe) ----
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function parts(t: number) { const o: Record<string, string> = {}; for (const p of fmt.formatToParts(new Date(t))) o[p.type] = p.value; return o; }
export function ctDate(t: number): string { const p = parts(t); return `${p.year}-${p.month}-${p.day}`; }
export const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
/** UTC ms of a CT wall-clock time on a CT date. */
export function ctAt(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  let guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`) + 6 * 3600e3; // CST guess
  for (let i = 0; i < 2; i++) {
    const p = parts(guess);
    const gotMin = (Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 60000 + Number(p.hour) * 60 + Number(p.minute);
    guess += ((h * 60 + (m || 0)) - gotMin) * 60000;
  }
  return guess;
}
export function ctClock(t: number | null | undefined): string {
  if (t == null) return "—";
  return new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
}

/** Effective shift per driver for one date: daily override row (Driver Schedule → Daily Overrides) else the weekly schedule.
 *  Times: override times, else weekly times for that weekday (an override row without times keeps the weekly times). */
export function shiftsFor(date: string, drivers: DriverRow[], sched: SchedRow[], weekly: WeeklyRow[]): Shift[] {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return drivers.map((d) => {
    const row = sched.find((r) => Number(r.driver_id) === Number(d.id) && String(r.work_date).slice(0, 10) === date) || null;
    const w = weekly.find((x) => Number(x.driver_id) === Number(d.id) && Number(x.day_of_week) === dow) || null;
    const working = row ? WORKING.has(String(row.status || "working").toLowerCase()) : !!w?.working;
    const st = row?.start_time || w?.start_time || null, en = row?.end_time || w?.end_time || null;
    const timesFrom = row?.start_time ? "override" : (st ? "weekly" : null);
    let start: number | null = null, end: number | null = null;
    if (st && en) { start = ctAt(date, st.slice(0, 5)); end = ctAt(date, en.slice(0, 5)); if (end <= start) end = ctAt(addDays(date, 1), en.slice(0, 5)); }
    const vehicleId = row?.vehicle_id != null ? Number(row.vehicle_id) : d.default_vehicle_id != null ? Number(d.default_vehicle_id) : null;
    const vehicleSource = row?.vehicle_id != null ? "override" : d.default_vehicle_id != null ? "default" : null;
    return { driverId: Number(d.id), name: d.name, date, working, start, end, timesFrom, vehicleId, vehicleSource, auto: row?.vehicle_source === "auto_gps" && row?.vehicle_id != null, row, weekly: w, active: d.active !== false } as Shift;
  });
}

/** Shift window with slack; a working driver without any times counts for the whole CT day. */
export function windowOf(s: Shift, slack = true): [number, number] {
  if (s.start == null || s.end == null) return [ctAt(s.date, "00:00"), ctAt(addDays(s.date, 1), "00:00")];
  return slack ? [s.start - SHIFT_SLACK_BEFORE_MS, s.end + SHIFT_SLACK_AFTER_MS] : [s.start, s.end];
}
export const covers = (s: Shift, t: number, slack = true) => { const [a, b] = windowOf(s, slack); return t >= a && t <= b; };

/** Do two shifts overlap in time (shift times without slack; no times = whole day)? */
export const overlaps = (a: Shift, b: Shift) => { const [a0, a1] = windowOf(a, false), [b0, b1] = windowOf(b, false); return a0 < b1 && b0 < a1; };

/** The truck a driver really has on that date: a default truck is "taken" when another working driver whose shift
 *  overlaps has it as a daily pick (Big Blue is the default of Juan 5 AM, Paul 2 PM and Angel, so a daily pick for
 *  Juan must not take it away from Paul's later shift). */
export function truckOf(s: Shift, all: Shift[]): number | null {
  if (s.vehicleId == null) return null;
  if (s.vehicleSource === "default" && all.some((o) => o.date === s.date && o.driverId !== s.driverId && o.working && o.vehicleSource === "override" && o.vehicleId === s.vehicleId && overlaps(o, s))) return null;
  return s.vehicleId;
}

export interface WhoResult { driverId: number; date: string; why: string }
/** Who had truck `vehicleId` at time `t`: working drivers whose truck is that truck and whose shift (±1 h) covers t.
 *  Shifts of the previous date are included, so a 9 PM–5:30 AM shift owns its after-midnight stops (work_date = shift date).
 *  Ties: a daily pick beats a default truck, then the shift without slack; still tied -> nobody (truck-level). */
export function whoHadTruck(vehicleId: number, t: number, shifts: Shift[], exclude: number[] = []): WhoResult | null {
  let c = shifts.filter((s) => s.working && s.active && !exclude.includes(s.driverId) && truckOf(s, shifts) === vehicleId && covers(s, t));
  if (c.length > 1) { const o = c.filter((s) => s.vehicleSource === "override"); if (o.length >= 1) c = o; }
  if (c.length > 1) { const strict = c.filter((s) => covers(s, t, false)); if (strict.length >= 1) c = strict; }
  if (c.length !== 1) return null;
  const s = c[0];
  return { driverId: s.driverId, date: s.date, why: `${s.name}: ${s.vehicleSource === "override" ? (s.auto ? "auto-assigned" : "daily") : "default"} truck, shift ${s.start != null ? ctClock(s.start) + "–" + ctClock(s.end) : "(no times, whole day)"} (${s.date})` };
}

// ---- automatic truck assignment ----
export interface Ignition { vehicleId: number; vehicleName: string; t: number }
/** Ignition-on events ("truck turns on"): segment ignition-on after >= 20 min off, or the first movement after >= 20 min still when
 *  the segment feed has nothing. */
export function ignitions(tl: Ev[], vehicleId: number, vehicleName: string): Ignition[] {
  const out: Ignition[] = [];
  // a) segment feed: ignition-on after >= 20 min off (the feed only covers from midnight; the evening before comes from plots)
  let lastOff: number | null = null;
  for (const e of tl) {
    if (e.kind === "off") lastOff = e.t;
    else if (e.kind === "on") {
      // first ignition in the feed (no "off" before it): a start if the truck had not been moving in the 20 min before
      const fresh = lastOff == null && !tl.some((p) => p.kind === "plot" && p.speed > 1 && p.t < e.t && e.t - p.t < IGNITION_MIN_OFF_MS) && !out.length;
      if ((lastOff != null && e.t - lastOff >= IGNITION_MIN_OFF_MS) || fresh) out.push({ vehicleId, vehicleName, t: e.t });
      lastOff = null;
    }
  }
  // b) history plots: first movement after >= 20 min standing still (covers the evening before midnight and trucks without segments)
  //    A parked truck with the engine off sends no plots, so silence counts as standing still: a gap of >= 20 min between plots,
  //    or no plots at all before the first one in the window (the window starts 6 h before midnight).
  let stillSince: number | null = null, prevT: number | null = null;
  for (const e of tl) {
    if (e.kind !== "plot") continue;
    const gap = prevT == null ? Infinity : e.t - prevT;
    if (e.speed <= 1) { if (stillSince == null) stillSince = gap >= IGNITION_MIN_OFF_MS ? (prevT ?? e.t - IGNITION_MIN_OFF_MS) : e.t; }
    else {
      const since = stillSince ?? (gap >= IGNITION_MIN_OFF_MS && prevT != null ? prevT : null);
      if (since != null && e.t - since >= IGNITION_MIN_OFF_MS && !out.some((o) => Math.abs(o.t - e.t) <= 15 * 60_000)) out.push({ vehicleId, vehicleName, t: e.t });
      stillSince = null;
    }
    prevT = e.t;
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface ClockIn { driverId: number; vehicleId: number; t: number; kind: "time sheet clock-in" | "pre-trip" }
/** Time Sheet vehicle text -> Reveal vehicle id (exact name, ignoring case/punctuation; or one name containing the other). Unknown names -> null. */
export function mapVehicleName(text: string | null | undefined, vehicles: { id: number; name: string }[]): number | null {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = n(text || "");
  if (q.length < 3) return null;
  const exact = vehicles.filter((v) => n(v.name) === q);
  if (exact.length === 1) return exact[0].id;
  if (q.length < 5) return null;
  const part = vehicles.filter((v) => n(v.name).length >= 5 && (q.includes(n(v.name)) || n(v.name).includes(q)));
  return part.length === 1 ? part[0].id : null;
}

export type Decision =
  | { action: "assign"; driverId: number; date: string; reason: string; candidates: number[] }
  | { action: "suggest"; date: string; candidates: number[]; reason: string }
  | { action: "none"; reason: string; candidates: number[] };

/** One ignition -> what to do. `shifts` = shifts of the ignition's CT date and the day before (overnight). */
export function decideAssign(ign: Ignition, shifts: Shift[], clockins: ClockIn[], exclude: number[] = []): Decision {
  const t = ign.t, v = ign.vehicleId;
  const onShift = shifts.filter((s) => s.working && s.active && !exclude.includes(s.driverId) && covers(s, t));
  const claimedBy = onShift.filter((s) => truckOf(s, shifts) === v);
  // 1) Time Sheet clock-in / pre-trip naming this truck within 30 min -> strongest signal
  const ts = clockins.filter((c) => c.vehicleId === v && Math.abs(c.t - t) <= TIMESHEET_WINDOW_MS && !exclude.includes(c.driverId));
  const tsDrivers = [...new Set(ts.map((c) => c.driverId))];
  if (tsDrivers.length === 1) {
    const d = tsDrivers[0];
    const mine = shifts.filter((s) => s.driverId === d).sort((a, b) => Number(covers(b, t)) - Number(covers(a, t)) || (a.date < b.date ? 1 : -1))[0];
    if (!mine) return { action: "none", reason: "time sheet names a driver who is not in the driver list", candidates: [d] };
    if (mine.vehicleId === v && truckOf(mine, shifts) === v) return { action: "none", reason: `${mine.name} already has this truck`, candidates: [d] };
    if (mine.vehicleSource === "override") return { action: "none", reason: `${mine.name} has a truck picked for this date — never overwritten`, candidates: [d] };
    const manualOther = claimedBy.filter((s) => s.driverId !== d && s.vehicleSource === "override");
    if (manualOther.length) return { action: "none", reason: `truck is picked for ${manualOther[0].name} for this date — never overwritten`, candidates: [d] };
    return { action: "assign", driverId: d, date: mine.date, reason: `${ts.find((c) => c.driverId === d)!.kind} for this truck at ${ctClock(ts.find((c) => c.driverId === d)!.t)}`, candidates: [d] };
  }
  // 2) already somebody's truck (daily pick or default) during this time -> nothing to do
  if (claimedBy.length) return { action: "none", reason: `already ${claimedBy.map((s) => s.name).join(" / ")}'s truck`, candidates: [] };
  // 3) scheduled, on-shift drivers without a truck
  const cand = onShift.filter((s) => truckOf(s, shifts) == null);
  const ids = [...new Set(cand.map((s) => s.driverId))].sort((a, b) => a - b);
  if (ids.length === 1) return { action: "assign", driverId: ids[0], date: cand[0].date, reason: `only on-shift driver without a truck (${cand[0].name}, ${cand[0].start != null ? ctClock(cand[0].start) + "–" + ctClock(cand[0].end) : "no shift times"})`, candidates: ids };
  if (ids.length > 1) return { action: "suggest", date: ctDate(t), candidates: ids, reason: `${ids.length} on-shift drivers without a truck: ${cand.map((s) => s.name).join(", ")}` };
  return { action: "none", reason: "no on-shift driver without a truck", candidates: [] };
}

/** Apply a decision to the in-memory shifts (so later ignitions in the same run see the truck as taken). */
export function applyAssign(shifts: Shift[], driverId: number, date: string, vehicleId: number) {
  for (const s of shifts) if (s.driverId === driverId && s.date === date) { s.vehicleId = vehicleId; s.vehicleSource = "override"; s.auto = true; }
}
