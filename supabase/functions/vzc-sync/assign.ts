// vzc-sync / assign.ts (v4.0.0) — pure logic: who was driving a truck at a given moment.
// v4.0.0: trucks come from truck_schedules (driver + truck + weekdays + shift times) and Daily Overrides (driver_schedule).
// Strict: a moment belongs to a driver only inside a clearly scheduled shift (start AND end times, no grace). Anything else is
// "Driver unknown" (null) — never guessed. Automatic truck assignment (decideAssign) is retired; the code stays for reference/tests.
// No database or network access here (sync.ts does the reads/writes), so it is fully unit-testable.
import type { Ev } from "./match.ts";

export const SHIFT_SLACK_BEFORE_MS = 0;  // v4.0.0: no grace (was 1 h in v3.11)
export const SHIFT_SLACK_AFTER_MS = 0;
export const TIMESHEET_WINDOW_MS = 30 * 60_000;    // a Time Sheet clock-in / pre-trip naming the truck within 30 min of ignition wins
export const IGNITION_MIN_OFF_MS = 20 * 60_000;    // "truck turns on" = ignition after >= 20 min off, or first movement after >= 20 min still
export const AUTO_ASSIGN_LOOKBACK_MS = 3 * 3600_000; // live runs only act on ignitions from the last 3 h (no surprise back-filling)
const WORKING = new Set(["working", "messenger"]);

export interface DriverRow { id: number; name: string; active: boolean | null; default_vehicle_id: number | null }
export interface SchedRow { id?: number; driver_id: number; work_date: string; status: string | null; start_time: string | null; end_time: string | null; vehicle_id: number | null; vehicle_source?: string | null; auto_assigned_at?: string | null }
export interface TruckSchedRow { id: number; driver_id: number; vehicle_id: number | null; days: number[] | null; start_time: string | null; end_time: string | null; active: boolean | null }
export interface WeeklyRow { driver_id: number; day_of_week: number; working: boolean | null; start_time: string | null; end_time: string | null }
export interface Shift {
  driverId: number; name: string; date: string; working: boolean;
  start: number | null; end: number | null;          // UTC ms (end on the next day for overnight shifts)
  timesFrom: "override" | "weekly" | null;           // where the shift times came from (null = no times anywhere)
  vehicleId: number | null; vehicleSource: "override" | "default" | "weekly" | "switch" | "pretrip" | "hand" | null; auto: boolean;
  row: SchedRow | null; weekly: WeeklyRow | null; active: boolean; schedId?: number | null;
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

/** Effective shifts for one date (a shift belongs to its START date in CT; end <= start = ends next day).
 *  v4.0.0 (truckSched given): Daily Override row for driver+date replaces the weekly truck schedule for that driver/date:
 *   - status off/pto/call_off -> not working;
 *   - times: override times, else the weekly rows' times; truck: override truck (a v3.11 "auto_gps" pick is NOT trusted), else weekly truck.
 *  Without truckSched (pre-v4 database): the v3.11 rules (weekly times + daily pick / drivers.default_vehicle_id). */
export function shiftsFor(date: string, drivers: DriverRow[], sched: SchedRow[], weekly: WeeklyRow[], truckSched?: TruckSchedRow[] | null): Shift[] {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  const span = (st: string | null, en: string | null): [number | null, number | null] => {
    if (!st || !en) return [null, null];
    const a = ctAt(date, st.slice(0, 5)); let b = ctAt(date, en.slice(0, 5)); if (b <= a) b = ctAt(addDays(date, 1), en.slice(0, 5));
    return [a, b];
  };
  const out: Shift[] = [];
  for (const d of drivers) {
    const row = sched.find((r) => Number(r.driver_id) === Number(d.id) && String(r.work_date).slice(0, 10) === date) || null;
    const w = weekly.find((x) => Number(x.driver_id) === Number(d.id) && Number(x.day_of_week) === dow) || null;
    const active = d.active !== false;
    if (truckSched) {
      const base = truckSched.filter((r) => Number(r.driver_id) === Number(d.id) && r.active !== false && (r.days || []).map(Number).includes(dow));
      const ovTruck = row && row.vehicle_id != null && row.vehicle_source !== "auto_gps" ? Number(row.vehicle_id) : null;
      const mk = (working: boolean, st: string | null, en: string | null, timesFrom: Shift["timesFrom"], vehicleId: number | null, vehicleSource: Shift["vehicleSource"], schedId: number | null): Shift => {
        const [start, end] = working ? span(st, en) : [null, null];
        return { driverId: Number(d.id), name: d.name, date, working, start, end, timesFrom: start != null ? timesFrom : null, vehicleId, vehicleSource: vehicleId != null ? vehicleSource : null, auto: false, row, weekly: w, active, schedId };
      };
      if (row) {
        const working = WORKING.has(String(row.status || "working").toLowerCase());
        if (!working) { out.push(mk(false, null, null, null, null, null, null)); continue; }
        if (row.start_time && row.end_time) { const bv = [...new Set(base.map((b) => b.vehicle_id).filter((x) => x != null).map(Number))]; out.push(mk(true, row.start_time, row.end_time, "override", ovTruck ?? (bv.length === 1 ? bv[0] : null), ovTruck != null ? "override" : "weekly", base.length === 1 ? base[0].id : null)); continue; }
        if (base.length) { for (const b of base) out.push(mk(true, b.start_time, b.end_time, "weekly", ovTruck ?? (b.vehicle_id != null ? Number(b.vehicle_id) : null), ovTruck != null ? "override" : "weekly", b.id)); continue; }
        out.push(mk(true, null, null, null, ovTruck, "override", null)); continue;
      }
      if (!base.length) { out.push(mk(false, null, null, null, null, null, null)); continue; }
      for (const b of base) out.push(mk(true, b.start_time, b.end_time, "weekly", b.vehicle_id != null ? Number(b.vehicle_id) : null, "weekly", b.id));
      continue;
    }
    const working = row ? WORKING.has(String(row.status || "working").toLowerCase()) : !!w?.working;
    const st = row?.start_time || w?.start_time || null, en = row?.end_time || w?.end_time || null;
    const timesFrom = row?.start_time ? "override" : (st ? "weekly" : null);
    const [start, end] = span(st, en);
    const vehicleId = row?.vehicle_id != null ? Number(row.vehicle_id) : d.default_vehicle_id != null ? Number(d.default_vehicle_id) : null;
    const vehicleSource = row?.vehicle_id != null ? "override" : d.default_vehicle_id != null ? "default" : null;
    out.push({ driverId: Number(d.id), name: d.name, date, working, start, end, timesFrom, vehicleId, vehicleSource, auto: row?.vehicle_source === "auto_gps" && row?.vehicle_id != null, row, weekly: w, active } as Shift);
  }
  return out;
}

/** v4.1.0 truck switch (public.truck_switches): split the driver's shift at switched_at — before = old truck, after = new truck. */
export interface SwitchRow { id: number; work_date: string; driver_id: number; from_vehicle_id: number | null; to_vehicle_id: number; switched_at: string; active?: boolean }
export function applySwitches(date: string, out: Shift[], switches?: SwitchRow[] | null): Shift[] {
  for (const w of (switches || []).filter((x) => String(x.work_date).slice(0, 10) === date && x.active !== false).sort((a, b) => Date.parse(a.switched_at) - Date.parse(b.switched_at))) {
    const at = Date.parse(w.switched_at);
    const i = out.findIndex((s) => s.driverId === Number(w.driver_id) && s.working && (s.start != null ? at > s.start && at < s.end! : true));
    if (i < 0) continue;
    const s = out[i], noT = s.start == null;
    const a0 = noT ? ctAt(date, "00:00") : s.start!, b1 = noT ? ctAt(addDays(date, 1), "00:00") : s.end!;
    const A = { ...s, start: a0, end: at, noTimes: noT, vehicleId: w.from_vehicle_id != null ? Number(w.from_vehicle_id) : s.vehicleId } as Shift;
    const B = { ...s, start: at, end: b1, noTimes: noT, vehicleId: Number(w.to_vehicle_id), vehicleSource: "switch" } as Shift;
    out.splice(i, 1, A, B);
  }
  return out;
}

/** Shift window with slack; a working driver without any times counts for the whole CT day. */
export function windowOf(s: Shift, slack = true): [number, number] {
  if (s.start == null || s.end == null || (s as any).noTimes) return [ctAt(s.date, "00:00"), ctAt(addDays(s.date, 1), "00:00")];
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
  if ((s.vehicleSource === "default" || s.vehicleSource === "weekly") && all.some((o) => o.date === s.date && o.driverId !== s.driverId && o.working && ["override", "pretrip", "hand"].includes(String(o.vehicleSource)) && o.vehicleId === s.vehicleId && overlaps(o, s))) return null;
  return s.vehicleId;
}

export interface WhoResult { driverId: number; date: string; why: string }
/** "Clearly scheduled": working, active, start AND end times. */
export const clear = (s: Shift) => s.working && s.active && s.start != null && s.end != null && !(s as any).noTimes;
/** v4.0.0 strict: who had truck `vehicleId` at time `t` = the ONE driver whose clearly scheduled shift on that truck covers t
 *  (no grace). Shifts of the previous date are included, so a 9 PM–5:30 AM shift owns its after-midnight stops (work_date = start date).
 *  Two drivers on the truck at that moment, or that driver also on another truck at that moment -> null ("Driver unknown"). */
export function whoHadTruck(vehicleId: number, t: number, shifts: Shift[], exclude: number[] = []): WhoResult | null {
  const c = shifts.filter((s) => clear(s) && !exclude.includes(s.driverId) && truckOf(s, shifts) === vehicleId && t >= s.start! && t < s.end!);
  if (c.length !== 1) return null;
  const s = c[0];
  if (shifts.some((o) => o !== s && o.driverId === s.driverId && clear(o) && o.vehicleId != null && truckOf(o, shifts) !== vehicleId && t >= o.start! && t < o.end!)) return null;
  return { driverId: s.driverId, date: s.date, why: `${s.name}: ${s.vehicleSource === "override" ? "daily" : s.vehicleSource === "switch" ? "truck switch" : s.vehicleSource === "weekly" ? "weekly schedule" : "default"} truck, shift ${ctClock(s.start)}–${ctClock(s.end)} (${s.date})` };
}

/** The truck a driver is planned on for a date: the shift covering `t` (if given), else the driver's single truck that date; else null. */
export function plannedTruckFor(driverId: number, date: string, t: number | null, shifts: Shift[]): number | null {
  const mine = shifts.filter((s) => s.driverId === Number(driverId) && s.date === date && s.working && s.vehicleId != null);
  if (t != null) { const hit = mine.filter((s) => s.start != null && t >= s.start && t < s.end!).map((s) => truckOf(s, shifts)).filter((x) => x != null); if (new Set(hit).size === 1) return hit[0]!; }
  const vs = [...new Set(mine.map((s) => truckOf(s, shifts)).filter((x) => x != null))];
  return vs.length === 1 ? vs[0]! : null;
}

export interface Conflict { kind: "truck" | "driver"; date: string; vehicleIds: number[]; driverIds: number[]; from: number; to: number; text: string }
/** Overlaps among clearly scheduled shifts: one truck with two drivers at the same time, or one driver on two trucks. */
export function conflicts(shifts: Shift[], vName: (id: number) => string = (id) => "truck #" + id): Conflict[] {
  const cs = shifts.filter((s) => clear(s) && truckOf(s, shifts) != null), out: Conflict[] = [];
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j]; const from = Math.max(a.start!, b.start!), to = Math.min(a.end!, b.end!);
    if (from >= to) continue;
    if (a.vehicleId === b.vehicleId && a.driverId !== b.driverId) out.push({ kind: "truck", date: a.date, vehicleIds: [a.vehicleId!], driverIds: [a.driverId, b.driverId], from, to, text: `${vName(a.vehicleId!)}: ${a.name} and ${b.name} overlap ${ctClock(from)}–${ctClock(to)}` });
    else if (a.driverId === b.driverId && a.vehicleId !== b.vehicleId) out.push({ kind: "driver", date: a.date, vehicleIds: [a.vehicleId!, b.vehicleId!], driverIds: [a.driverId], from, to, text: `${a.name} is on ${vName(a.vehicleId!)} and ${vName(b.vehicleId!)} ${ctClock(from)}–${ctClock(to)}` });
  }
  return out;
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
    if (["override", "pretrip", "hand"].includes(String(mine.vehicleSource))) return { action: "none", reason: `${mine.name} has a truck picked for this date — never overwritten`, candidates: [d] };
    const manualOther = claimedBy.filter((s) => s.driverId !== d && ["override", "pretrip", "hand"].includes(String(s.vehicleSource)));
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

/* ---------- v4.7.0 pre-trip decides the truck ----------
 * Events come from the shared database function public.driver_truck_events(from, to):
 *   pretrip (time sheet app, at submit time), hand (Set truck by hand on the dashboard, at the time it was set),
 *   switch (older manual truck switches). Applied in time order, so the LATEST one wins:
 *   - inside a shift: the shift is split at that time (before = old truck, after = new truck)
 *   - up to 3 h before a shift starts: the whole shift gets that truck (the shift starts at the pre-trip)
 *   - a pre-trip with no scheduled shift: the driver is working from the pre-trip until the app shift ends (else 12 h)
 *   - two drivers on one truck: the later event wins; the earlier driver loses the truck from then on (takenBy)
 * The SAME code runs in the dashboard (trucks-board.js applyTruckEvents) — keep them in sync. */
export interface TruckEvent { kind: "pretrip" | "hand" | "switch"; driver_id: number; work_date: string; vehicle_id: number | null; at: string; vehicle_text?: string | null; ref_id?: number | null; shift_end?: string | null }
export const PRETRIP_LEAD_MS = 3 * 3600e3, PRETRIP_DEFAULT_MS = 12 * 3600e3;
export function applyTruckEvents(date: string, out: Shift[], events: TruckEvent[] | null | undefined, drivers?: DriverRow[]): Shift[] {
  const evs = (events || []).filter((e) => String(e.work_date).slice(0, 10) === date && e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const dayA = ctAt(date, "00:00"), dayB = ctAt(addDays(date, 1), "00:00");
  const win = (s: any): [number, number] => (s.start == null || s.noTimes ? [dayA, dayB] : [s.start, s.end]);
  for (const e of evs) {
    const did = Number(e.driver_id), v = e.vehicle_id != null ? Number(e.vehicle_id) : null;
    // a hand-set / switch saved before or after its work day (planning ahead, fixing a past day) counts for the whole day
    let at = Date.parse(e.at); if (e.kind !== "pretrip") at = Math.min(Math.max(at, dayA), dayB - 1);
    const tag = { evKind: e.kind, evAt: at, evRef: e.ref_id ?? null, evText: e.vehicle_text ?? null };
    if (e.kind === "pretrip") for (const s of out as any[]) if (s.driverId === did && s.date === date) s.pretripAt ??= at;   // "pre-trip done today"
    if (v == null) continue;                                     // truck name not matched: recorded, truck unchanged
    const mine = (out as any[]).map((s, i) => [s, i] as [any, number]).filter(([s]) => s.driverId === did && s.date === date && s.working);
    let hit = mine.find(([s]) => { const [a, b] = win(s); return at >= a && at < b; });
    if (!hit) hit = mine.filter(([s]) => s.start != null && !s.noTimes && s.start > at && (e.kind !== "pretrip" || s.start - at <= PRETRIP_LEAD_MS)).sort((x, y) => x[0].start - y[0].start)[0];
    if (!hit && e.kind !== "pretrip") continue;                 // only a pre-trip can start a shift; a hand-set without a shift stays the Daily Override
    if (!hit) {
      const d = (drivers || []).find((x) => Number(x.id) === did);
      const end = e.shift_end ? Date.parse(e.shift_end) : at + PRETRIP_DEFAULT_MS;
      const base: any = mine[0]?.[0] || (out as any[]).find((s) => s.driverId === did && s.date === date) || {};
      out.push({ ...base, driverId: did, name: base.name || d?.name || "Driver " + did, date, working: true, start: at, end, timesFrom: "pretrip", vehicleId: v, vehicleSource: e.kind, auto: false, row: base.row ?? null, weekly: base.weekly ?? null, active: base.active ?? true, noTimes: false, ...tag } as any);
    } else {
      const [s, i] = hit, [a, b] = win(s);
      if (at <= a) { Object.assign(s, { vehicleId: v, vehicleSource: e.kind, ...tag }); if (e.kind === "pretrip" && !s.noTimes && s.start != null && at < s.start) s.start = at; }
      else out.splice(i, 1, { ...s, start: a, end: at, noTimes: false }, { ...s, start: at, end: b, noTimes: false, vehicleId: v, vehicleSource: e.kind, ...tag });
      // later shifts of the same driver that day follow the new truck
      for (const s2 of out as any[]) if (s2.driverId === did && s2.date === date && s2.working && s2.start != null && s2.start >= b && !s2.evKind) Object.assign(s2, { vehicleId: v, vehicleSource: e.kind, ...tag });
    }
    // later wins: anyone else holding this truck (by an older decision) loses it from `at`
    for (let k = out.length - 1; k >= 0; k--) {
      const o: any = out[k];
      if (o.driverId === did || !o.working || o.vehicleId !== v) continue;
      if ((o.evAt ?? -Infinity) >= at) continue;
      const [a, b] = win(o);
      if (b <= at) continue;
      const taken = { takenBy: did, takenAt: at, takenKind: e.kind };
      if (a >= at) Object.assign(o, { vehicleId: null, vehicleSource: null, ...taken });
      else out.splice(k, 1, { ...o, start: a, end: at, noTimes: false }, { ...o, start: at, end: b, noTimes: false, vehicleId: null, vehicleSource: null, ...taken });
    }
  }
  return out;
}
/** Where a shift's truck came from, for labels: pretrip / hand / scheduled / none. */
export function truckSource(s: any): "pretrip" | "hand" | "scheduled" | "none" {
  if (s.vehicleId == null) return "none";
  if (s.vehicleSource === "pretrip") return "pretrip";
  if (s.vehicleSource === "hand" || s.vehicleSource === "override" || s.vehicleSource === "switch") return "hand";
  return "scheduled";
}
