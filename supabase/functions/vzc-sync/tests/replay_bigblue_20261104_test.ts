// Replay: Big Blue (VZC 41128R, vehicle_id 4) on 11/04/2026 against tasks #305 / #306 / route #308.
// Visits are the real ones read from Verizon Connect (UTC); task rows are the live values (read-only snapshot).
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as M from "../match.ts";
import { track, ct, type Halt } from "./timeline.ts";

const BASE = M.makePlace("Darwill McCook", "8701 47th St Ste C, McCook, IL 60525", null)!;
const CANON = M.makePlace("Canon USA", "10350 Beaudin Blvd Suite 400, Woodridge, IL. 60517", { lat: 41.697521311711, lon: -88.03628631587, status: "ok" })!;
const UNIV = M.makePlace("Universal Laminating", "910 Carlow Dr Ste A, Bolingbrook, IL 60490", { lat: 41.667140175165, lon: -88.131222884478, status: "ok" })!;
const HALTS: Halt[] = [
  { lat: 41.803275, lon: -87.836541, from: "2026-11-04T10:51:52Z", to: "2026-11-04T14:30:22Z", addr: "8701 47th St, McCook, IL 60525" },
  { lat: 41.666468, lon: -88.126802, from: "2026-11-04T14:58:50Z", to: "2026-11-04T15:08:04Z", addr: "902 Carlow Dr, Bolingbrook, IL 60490" },
  { lat: 41.680484, lon: -88.055123, from: "2026-11-04T15:18:34Z", to: "2026-11-04T15:20:04Z" },  // Romeoville (90 s — not a stop)
  { lat: 41.697006, lon: -88.038069, from: "2026-11-04T15:23:04Z", to: "2026-11-04T15:48:02Z" },
  { lat: 41.765578, lon: -87.897307, from: "2026-11-04T15:58:32Z", to: "2026-11-04T16:00:02Z" },  // Indian Head Park
  { lat: 41.778442, lon: -87.868413, from: "2026-11-04T16:03:02Z", to: "2026-11-04T16:04:53Z" },  // Countryside
  { lat: 41.802966, lon: -87.836579, from: "2026-11-04T16:10:53Z", to: null, addr: "8701 47th St, McCook, IL 60525" },  // back at McCook (still there)
];
const tl = track(HALTS, "2026-11-04T16:20:00Z");
// what the sync would have seen at an earlier moment (GPS only up to `end`)
const upTo = (end: string) => track(HALTS.filter((h) => h.from < end).map((h) => (h.to && h.to > end ? { ...h, to: null } : h)), end);
const VEH: M.VehicleTrack = { vehicleId: 4, name: "Big Blue", tl };
const day = (tasks: M.TaskTarget[], winEnd = "2026-11-04T16:20:00Z"): M.DayInput => ({
  date: "2026-11-04", tasks, vehicles: [winEnd === "2026-11-04T16:20:00Z" ? VEH : { ...VEH, tl: upTo(winEnd) }], base: BASE, winStart: M.ctMidnightUtc("2026-11-04"), winEnd: Date.parse(winEnd),
});
const ms = (s: string) => Date.parse(s);
const A305 = ms("2026-11-04T14:56:00.807Z"), A306 = ms("2026-11-04T14:56:03.419Z");
const C305 = ms("2026-11-04T14:05:42.782Z"), C306 = ms("2026-11-04T14:10:51.396Z");

Deno.test("route #308 as it is in the DB now → Universal done, McCook done, completes 10:10:53 AM CT, no split", () => {
  // v4.10.0 derives the trip cutoff from the originals: min(max(created, assigned)) of #305/#306 = 8:56:00 AM CT
  const gpsSince = Math.min(M.gpsGate(C305, A305)!, M.gpsGate(C306, A306)!);
  assertEquals(ct(gpsSince), "8:56:00 AM");
  const t308: M.TaskTarget = {
    id: 308, kind: "route", title: "Canon USA - Darwill McCook", driverId: 7, plannedVehicleId: 4, vehicleLocked: false,
    origin: CANON, dest: BASE, completedAt: null, scheduledAt: null,
    createdAt: ms("2026-11-04T16:03:32Z"), assignedAt: ms("2026-11-04T16:03:32Z"), gpsSince, memberIds: [305, 306],
    existing: { gps_departed_at: "2026-11-04T15:48:02Z", gps_vehicle_id: 4, task_type: "pickup" },
    stops: [
      { id: 52, seq: 1, place: UNIV, status: "pending", existing: {} },
      { id: 53, seq: 2, place: BASE, status: "done", existing: { gps_arrived_at: "2026-11-04T16:10:53Z", gps_vehicle_id: 4 } },
    ],
  };
  const r = M.matchDay(day([t308]));
  const m = r.matches.find((x) => x.taskId === 308)!;
  assert(m, "route matched");
  assertEquals(m.split ?? null, null);
  assertEquals(ct(m.origin?.arrived), "9:23:04 AM");
  assertEquals(ct(m.origin?.departed), "9:48:02 AM");
  assertEquals(ct(m.stops[0].visit?.arrived), "8:58:50 AM");
  assertEquals(ct(m.stops[0].visit?.departed), "9:08:04 AM");
  assertEquals(ct(m.stops[1].visit?.arrived), "10:10:53 AM");
  const p = M.buildPatches(m, t308, new Date().toISOString());
  const s52 = p.find((x) => x.table === "dispatch_task_stops" && x.id === 52)!;
  assertEquals(s52.status?.to, "done");
  // after the stop writes, every stop is done → GPS completes the route (force: also over a hand-set status)
  const dec = M.autoStatusFor({ is_route: true, status: "in_progress", status_source: null },
    [{ status: "done", gps_arrived_at: "2026-11-04T14:58:50Z" }, { status: "done", gps_arrived_at: "2026-11-04T16:10:53Z" }], m)!;
  assertEquals(dec.to, "completed");
  assertEquals(ct(dec.at), "10:10:53 AM");
  // without v4.10.0 (cutoff = route created 10:03:32 AM CT) Universal could never match — the bug Mark hit
  const old = M.matchDay(day([{ ...t308, gpsSince: null, memberIds: [] }]));
  assertEquals(old.matches.find((x) => x.taskId === 308)?.stops[0].visit ?? null, null);
});

Deno.test("auto-combined route made at assignment (8:56 AM) with no GPS yet: Canon start, Universal, McCook — any order", () => {
  const gpsSince = Math.min(M.gpsGate(C305, A305)!, M.gpsGate(C306, A306)!);
  const route: M.TaskTarget = {
    id: 900, kind: "route", title: "auto", driverId: 7, plannedVehicleId: 4, vehicleLocked: true, origin: CANON, dest: BASE,
    completedAt: null, scheduledAt: null, createdAt: ms("2026-11-04T14:57:00Z"), assignedAt: ms("2026-11-04T14:57:00Z"), gpsSince, memberIds: [305, 306],
    existing: { task_type: "pickup" },
    stops: [{ id: 1, seq: 1, place: UNIV, status: "pending", existing: {} }, { id: 2, seq: 2, place: BASE, status: "pending", existing: {} }],
  };
  // live at 9:30 AM CT: Universal done, Canon not yet → in progress, nothing at McCook
  const r1 = M.matchDay(day([route], "2026-11-04T15:30:00Z"));
  const m1 = r1.matches[0];
  assertEquals(ct(m1.stops[0].visit?.arrived), "8:58:50 AM");
  assertEquals(m1.stops[1].visit, null);
  assertEquals(m1.split ?? null, null);
  // end of the trip
  const r2 = M.matchDay(day([route]));
  const m2 = r2.matches[0];
  assertEquals(ct(m2.origin?.arrived), "9:23:04 AM");
  assertEquals(ct(m2.stops[1].visit?.arrived), "10:10:53 AM");
  assertEquals(ct(m2.returnedBase), "10:10:53 AM");
  assertEquals(m2.split ?? null, null);
});

Deno.test("singles #305/#306 before combining: pickup visits saved as soon as GPS sees them", () => {
  const single = (id: number, origin: M.Place, c: number, a: number): M.TaskTarget => ({
    id, kind: "single", title: "", driverId: 7, plannedVehicleId: 4, vehicleLocked: true, origin, dest: BASE, stops: [],
    completedAt: null, scheduledAt: null, createdAt: c, assignedAt: a, existing: { task_type: "pickup" },
  });
  const r = M.matchDay(day([single(305, CANON, C305, A305), single(306, UNIV, C306, A306)], "2026-11-04T15:50:00Z"));
  const m306 = r.matches.find((x) => x.taskId === 306)!, m305 = r.matches.find((x) => x.taskId === 305)!;
  assert(m306.partial && m305.partial);
  assertEquals(ct(m306.origin?.arrived), "8:58:50 AM");
  assertEquals(ct(m305.origin?.arrived), "9:23:04 AM");
  const p = M.buildPatches(m306, single(306, UNIV, C306, A306), "x")[0];
  assertEquals(p.set.gps_origin_arrived_at, "2026-11-04T14:58:50.000Z");
  assertEquals(p.set.gps_departed_at, "2026-11-04T15:08:04.000Z");
  // in progress from the pickup departure, not completed yet
  const d = M.autoStatusFor({ status: "assigned", task_type: "pickup", pickup_address: UNIV.address, delivery_address: BASE.address,
    created_at: new Date(C306).toISOString(), assigned_at: new Date(A306).toISOString(), gps_departed_at: p.set.gps_departed_at }, [], m306)!;
  assertEquals(d.to, "in_progress");
});
