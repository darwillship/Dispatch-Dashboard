// v4.10.1 replay: Big Blue (vehicle 4) 11/04/2026 late morning/afternoon — tasks #307, #309, #310, #311, #312.
// Visits = the real Verizon Connect stop events (vehicle_stop_events, UTC). #307/#309 were created in the morning but
// assigned at 12:43 PM CT, AFTER Big Blue had already picked both up (11:35 AM / 12:00 PM) on the trip that left McCook
// at 10:37:53 AM. v4.10.0 started their GPS window at 12:43 PM and so never saw those pickups.
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as M from "../match.ts";
import { track, ct, type Halt } from "./timeline.ts";

const g = (lat: number, lon: number) => ({ lat, lon, status: "ok" });
const BASE = M.makePlace("Darwill McCook", "8701 47th St Ste C, McCook, IL 60525", null)!;
const FED = M.makePlace("Federal Envelope", "608 Country Club Dr, Bensenville, IL 60106", g(41.973406, -87.954731))!;
const ADDV = M.makePlace("Add Value 2 Print LLC", "737 N Central Ave, Wood Dale, IL 60191", g(41.977004, -87.970547))!;
const ALG = M.makePlace("ALG", "1053 N Schmidt Rd, Romeoville, IL 60446", g(41.664701, -88.084967))!;
const UNIV = M.makePlace("Universal Laminating", "910 Carlow Dr Ste A, Bolingbrook, IL 60490", g(41.666468, -88.126802))!;
const MC = "8701 47th St, McCook, IL 60525";
const HALTS: Halt[] = [
  { lat: 41.803275, lon: -87.836541, from: "2026-11-04T10:51:52Z", to: "2026-11-04T14:30:22Z", addr: MC },
  { lat: 41.666468, lon: -88.126802, from: "2026-11-04T14:58:50Z", to: "2026-11-04T15:08:04Z" },   // Universal
  { lat: 41.697006, lon: -88.038069, from: "2026-11-04T15:23:04Z", to: "2026-11-04T15:48:02Z" },   // Canon
  { lat: 41.802966, lon: -87.836579, from: "2026-11-04T16:10:53Z", to: "2026-11-04T16:37:53Z", addr: MC },  // McCook — trip after #308 starts 10:37:53 AM
  { lat: 41.863508, lon: -87.914371, from: "2026-11-04T16:54:23Z", to: "2026-11-04T17:18:11Z" },   // Hillside yard
  { lat: 41.905328, lon: -87.964811, from: "2026-11-04T17:28:25Z", to: "2026-11-04T17:29:55Z" },   // Elmhurst (90 s)
  { lat: 41.973406, lon: -87.954731, from: "2026-11-04T17:35:55Z", to: "2026-11-04T17:57:38Z" },   // Federal Envelope
  { lat: 41.977004, lon: -87.970547, from: "2026-11-04T18:00:38Z", to: "2026-11-04T18:10:51Z" },   // Add Value
  { lat: 41.890462, lon: -87.962123, from: "2026-11-04T18:21:21Z", to: "2026-11-04T18:23:43Z" },   // Elmhurst
  { lat: 41.832437, lon: -87.955920, from: "2026-11-04T18:28:13Z", to: "2026-11-04T18:29:43Z" },   // Oak Brook (90 s)
  { lat: 41.803301, lon: -87.836559, from: "2026-11-04T18:44:43Z", to: "2026-11-04T20:22:08Z", addr: MC },  // McCook drop-off
  { lat: 41.671698, lon: -88.086752, from: "2026-11-04T20:46:08Z", to: "2026-11-04T20:47:38Z" },   // Bolingbrook (90 s)
  { lat: 41.664701, lon: -88.084967, from: "2026-11-04T20:48:08Z", to: "2026-11-04T21:43:17Z" },   // ALG
  { lat: 41.684084, lon: -88.067566, from: "2026-11-04T21:48:54Z", to: "2026-11-04T21:50:24Z" },
];
const END = "2026-11-04T22:00:00Z";
const VEH: M.VehicleTrack = { vehicleId: 4, name: "Big Blue", tl: track(HALTS, END) };
const day = (tasks: M.TaskTarget[]): M.DayInput => ({ date: "2026-11-04", tasks, vehicles: [VEH], base: BASE, winStart: M.ctMidnightUtc("2026-11-04"), winEnd: Date.parse(END) });
const ms = (s: string) => Date.parse(s);
// live task rows (created / assigned, UTC)
const T = {
  307: { c: ms("2026-11-04T15:26:47.342Z"), a: ms("2026-11-04T18:43:04.842Z") },
  309: { c: ms("2026-11-04T16:06:46.108Z"), a: ms("2026-11-04T18:43:07.033Z") },
  311: { c: ms("2026-11-04T19:14:47.054Z"), a: ms("2026-11-04T19:14:51.710Z") },
};
const bv = () => [{ arrived: ms("2026-11-04T10:51:52Z"), departed: ms("2026-11-04T14:30:22Z") }, { arrived: ms("2026-11-04T16:10:53Z"), departed: ms("2026-11-04T16:37:53Z") },
  { arrived: ms("2026-11-04T18:44:43Z"), departed: ms("2026-11-04T20:22:08Z") }];
const single = (id: number, type: string, origin: M.Place, dest: M.Place, c: number, a: number): M.TaskTarget => ({
  id, kind: "single", title: "", driverId: 6, plannedVehicleId: 4, vehicleLocked: true, origin, dest, stops: [],
  completedAt: null, scheduledAt: null, createdAt: c, assignedAt: a, existing: { task_type: type },
});

Deno.test("lateAssignGate: late same-day assignment reaches back to the truck's last McCook departure", () => {
  const d0 = M.ctMidnightUtc("2026-11-04");
  assertEquals(ct(M.lateAssignGate(T[307].c, T[307].a, bv(), d0)), "10:37:53 AM");   // was 12:43:04 PM
  assertEquals(ct(M.lateAssignGate(T[309].c, T[309].a, bv(), d0)), "10:37:53 AM");
  // assigned while the truck sits at McCook → nothing happened yet → assignment time (unchanged)
  assertEquals(ct(M.lateAssignGate(T[311].c, T[311].a, bv(), d0)), "1:14:51 PM");
  // assigned the moment it was created → unchanged
  assertEquals(M.lateAssignGate(T[307].a, T[307].a, bv(), d0), T[307].a);
  // never before the task existed: created 10:50 AM, assigned 12:43 PM → 10:50 AM
  const c = ms("2026-11-04T16:50:00Z");
  assertEquals(M.lateAssignGate(c, T[307].a, bv(), d0), c);
  // no McCook departure yet today → unchanged
  assertEquals(M.lateAssignGate(T[307].c, T[307].a, [], d0), T[307].a);
});

Deno.test("single #309 (as it was before combining): Add Value pickup 12:00 PM, McCook drop-off 12:44 PM", () => {
  // (#307's row has Federal Envelope as BOTH pickup and delivery, so as a single it has no separate pickup visit; its
  // Federal Envelope visit is checked as the origin of route #312 below.)
  const r = M.matchDay(day([single(307, "pickup", FED, FED, T[307].c, T[307].a), single(309, "pickup", ADDV, BASE, T[309].c, T[309].a)]));
  const m309 = r.matches.find((x) => x.taskId === 309)!;
  assert(m309, "#309 matched");
  assertEquals(ct(m309.gate), "10:37:53 AM");
  assertEquals(ct(m309.origin?.arrived), "12:00:38 PM");
  assertEquals(ct(m309.origin?.departed), "12:10:51 PM");
  assertEquals(ct(m309.dest?.arrived), "12:44:43 PM");
  const t309 = single(309, "pickup", ADDV, BASE, T[309].c, T[309].a);
  const ps = M.buildPatches(m309, t309, "x");
  assertEquals(ps.find((p) => p.since)?.since, "2026-11-04T16:37:53.000Z");   // gps_since saved → 10:37:53 AM
  const d = M.autoStatusFor({ status: "in_progress", task_type: "pickup", pickup_address: ADDV.address, delivery_address: BASE.address,
    created_at: new Date(T[309].c).toISOString(), assigned_at: new Date(T[309].a).toISOString(),
    gps_departed_at: "2026-11-04T18:10:51Z", gps_arrived_at: "2026-11-04T18:44:43Z" }, [], m309)!;
  assertEquals(d.to, "completed");
  assertEquals(ct(d.at), "12:44:43 PM");
  // v4.10.0 behaviour (window = assignment 12:43 PM): Federal Envelope is never seen
  const old = M.matchDay(day([{ ...t309, gpsSince: T[309].a }]));
  assertEquals(old.matches.find((x) => x.taskId === 309)?.origin ?? null, null);
});

Deno.test("route #312 (Federal → Add Value → McCook drop → McCook pickup → ALG) as saved at 1:14 PM, gps_since 12:43 PM", () => {
  const t312: M.TaskTarget = {
    id: 312, kind: "route", title: "Federal Envelope - Darwill McCook (4 stops)", driverId: 6, plannedVehicleId: 4, vehicleLocked: true,
    origin: FED, dest: BASE, completedAt: null, scheduledAt: null, createdAt: ms("2026-11-04T19:14:52Z"), assignedAt: ms("2026-11-04T19:14:52Z"),
    gpsSince: T[307].a, memberIds: [310, 311],
    members: [{ createdAt: T[307].c, assignedAt: T[307].a }, { createdAt: T[309].c, assignedAt: T[309].a }, { createdAt: T[311].c, assignedAt: T[311].a }],
    existing: { task_type: "pickup" },
    stops: [
      { id: 56, seq: 1, place: ADDV, status: "pending", existing: {} },
      { id: 59, seq: 2, place: BASE, status: "pending", existing: {} },
      { id: 57, seq: 3, place: BASE, status: "pending", existing: {} },
      { id: 58, seq: 4, place: ALG, status: "pending", existing: {} },
    ],
  };
  const m = M.matchDay(day([t312])).matches.find((x) => x.taskId === 312)!;
  assert(m, "route matched");
  assertEquals(ct(m.gate), "10:37:53 AM");
  assertEquals(ct(m.origin?.arrived), "11:35:55 AM");
  assertEquals(ct(m.origin?.departed), "11:57:38 AM");
  const at = (id: number) => ct(m.stops.find((s) => s.stopId === id)?.visit?.arrived);
  assertEquals(at(56), "12:00:38 PM");
  assertEquals(at(59), "12:44:43 PM");
  assertEquals(at(58), "2:48:08 PM");
  assertEquals(m.split ?? null, null);   // McCook is a planned stop (drop-off) here, not a return between trips
  const ps = M.buildPatches(m, t312, "x");
  assertEquals(ps.find((p) => p.since)?.since, "2026-11-04T16:37:53.000Z");
  // without the late-assignment rule the route never sees Federal Envelope / Add Value
  const old = M.matchDay(day([{ ...t312, members: undefined }])).matches.find((x) => x.taskId === 312);
  assertEquals(old?.stops.find((s) => s.stopId === 56)?.visit ?? null, null);
});

Deno.test("pickup gate: a pickup place visited BEFORE the window start does not count", () => {
  // Universal visited 8:58 AM; a Universal → McCook pickup created and assigned 11:00 AM must not use that visit
  const t = single(901, "pickup", UNIV, BASE, ms("2026-11-04T17:00:00Z"), ms("2026-11-04T17:00:00Z"));
  const r = M.matchDay(day([t]));
  const m = r.matches.find((x) => x.taskId === 901);
  assert(!m || m.origin == null || m.origin.arrived >= ms("2026-11-04T17:00:00Z"), "8:58 AM Universal visit must not count");
  assert(!m || m.dest == null, "never 'arrived at McCook' without the pickup");
});

Deno.test("McCook origin: #311 (McCook → ALG, assigned 1:14 PM while parked) starts at the window, not the 12:44 PM arrival", () => {
  const t311 = single(311, "delivery", BASE, ALG, T[311].c, T[311].a);
  const m = M.matchDay(day([t311])).matches.find((x) => x.taskId === 311)!;
  assert(m, "matched");
  assert(m.originBase);
  assertEquals(ct(m.origin?.departed), "2:22:08 PM");
  assertEquals(ct(m.dest?.arrived), "2:48:08 PM");
  const p = M.buildPatches(m, t311, "x").find((x) => x.nullCols.length)!;
  assertEquals(ct(Date.parse(p.set.gps_origin_arrived_at)), "1:14:51 PM");   // clamped to the window start
});
