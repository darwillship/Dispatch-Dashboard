import { assert, assertEquals } from "jsr:@std/assert@1";
import * as M from "../match.ts";
import { track, ct } from "./timeline.ts";

const BASE = M.makePlace("Darwill McCook", "8701 47th St Ste C, McCook, IL 60525", null)!;
const A = M.makePlace("Stop A", "100 Alpha Rd, Bedford Park, IL 60638", { lat: 41.77, lon: -87.80, status: "ok" })!;
const B = M.makePlace("Stop B", "200 Beta Ave, Romeoville, IL 60446", { lat: 41.65, lon: -88.08, status: "ok" })!;
const ms = (s: string) => Date.parse(s);
const veh = (tl: M.Ev[]): M.VehicleTrack => ({ vehicleId: 4, name: "Big Blue", tl });
const day = (tasks: M.TaskTarget[], tl: M.Ev[], end: string): M.DayInput => ({ date: "2026-11-05", tasks, vehicles: [veh(tl)], base: BASE, winStart: M.ctMidnightUtc("2026-11-05"), winEnd: ms(end) });
const route = (stops: M.StopTarget[], extra: Partial<M.TaskTarget> = {}): M.TaskTarget => ({
  id: 10, kind: "route", title: "r", driverId: 7, plannedVehicleId: 4, vehicleLocked: true, origin: BASE, dest: BASE, completedAt: null,
  scheduledAt: null, createdAt: ms("2026-11-05T13:50:00Z"), assignedAt: ms("2026-11-05T13:50:00Z"), existing: {}, stops, ...extra,
});
// McCook → A → back to McCook (load) → B → McCook
const tl = track([
  { lat: BASE.lat!, lon: BASE.lon!, from: "2026-11-05T13:00:00Z", to: "2026-11-05T14:00:00Z" },
  { lat: A.lat!, lon: A.lon!, from: "2026-11-05T14:30:00Z", to: "2026-11-05T14:45:00Z" },
  { lat: BASE.lat!, lon: BASE.lon!, from: "2026-11-05T15:10:00Z", to: "2026-11-05T15:40:00Z" },
  { lat: B.lat!, lon: B.lon!, from: "2026-11-05T16:10:00Z", to: "2026-11-05T16:25:00Z" },
  { lat: BASE.lat!, lon: BASE.lon!, from: "2026-11-05T16:55:00Z", to: null },
], "2026-11-05T17:10:00Z");
const stops = (): M.StopTarget[] => [
  { id: 1, seq: 1, place: A, status: "pending", existing: {} },
  { id: 2, seq: 2, place: B, status: "pending", existing: {} },
  { id: 3, seq: 3, place: BASE, status: "pending", existing: {} },
];

Deno.test("back at McCook between stops → split: keep A, move B, cutoff = McCook departure", () => {
  const r = M.matchDay(day([route(stops())], tl, "2026-11-05T15:50:00Z"));
  const m = r.matches[0];
  assert(m.split, "split expected");
  assertEquals(m.split!.keepStopIds, [1]);
  assertEquals(m.split!.moveStopIds, [2]);
  assertEquals(ct(m.split!.baseArrived), "9:10:00 AM");
  assertEquals(ct(m.split!.baseDeparted), "9:40:00 AM");
  assertEquals(m.stops[2].visit, null, "final McCook stop is left to the split RPC");
  // the stop A is written as done
  const p = M.buildPatches(m, route(stops()), "x");
  assertEquals(p.find((x) => x.id === 1 && x.table === "dispatch_task_stops")?.status?.to, "done");
});

Deno.test("after the split the new trip (cutoff 9:40 AM) matches B and the second McCook return", () => {
  const t2 = route([{ id: 2, seq: 1, place: B, status: "pending", existing: {} }, { id: 4, seq: 2, place: BASE, status: "pending", existing: {} }],
    { id: 11, gpsSince: ms("2026-11-05T15:40:00Z"), existing: { gps_departed_at: "2026-11-05T15:40:00Z" } });
  const m = M.matchDay(day([t2], tl, "2026-11-05T17:10:00Z")).matches[0];
  assertEquals(m.split ?? null, null);
  assertEquals(ct(m.stops[0].visit?.arrived), "10:10:00 AM");
  assertEquals(ct(m.stops[1].visit?.arrived), "10:55:00 AM");
});

Deno.test("stops visited out of the planned order still match (GPS order wins)", () => {
  const rev: M.StopTarget[] = [{ id: 2, seq: 1, place: B, status: "pending", existing: {} }, { id: 1, seq: 2, place: A, status: "pending", existing: {} }, { id: 3, seq: 3, place: BASE, status: "pending", existing: {} }];
  const tl2 = track([
    { lat: BASE.lat!, lon: BASE.lon!, from: "2026-11-05T13:00:00Z", to: "2026-11-05T14:00:00Z" },
    { lat: A.lat!, lon: A.lon!, from: "2026-11-05T14:30:00Z", to: "2026-11-05T14:45:00Z" },
    { lat: B.lat!, lon: B.lon!, from: "2026-11-05T15:10:00Z", to: "2026-11-05T15:20:00Z" },
    { lat: BASE.lat!, lon: BASE.lon!, from: "2026-11-05T15:50:00Z", to: null },
  ], "2026-11-05T16:00:00Z");
  const m = M.matchDay(day([route(rev)], tl2, "2026-11-05T16:00:00Z")).matches[0];
  assertEquals(m.split ?? null, null);
  assert(m.stops.every((s) => s.visit), "all three stops matched");
  assertEquals(ct(m.returnedBase), "9:50:00 AM");
});

Deno.test("visits before the trip cutoff never count", () => {
  const m = M.matchDay(day([route(stops(), { gpsSince: ms("2026-11-05T15:00:00Z") })], tl, "2026-11-05T15:50:00Z")).matches[0];
  assertEquals(m?.stops[0].visit ?? null, null);
});

Deno.test("self-correction: GPS-proven stop back to done; final McCook arrival = done; never reopens", () => {
  const stopsBy = new Map<number, any[]>([[10, [
    { id: 1, seq: 1, status: "pending", gps_arrived_at: "x", gps_departed_at: "y", location_address: A.address },
    { id: 2, seq: 2, status: "arrived", gps_arrived_at: "x", gps_departed_at: null, location_address: B.address },
    { id: 3, seq: 3, status: "pending", gps_arrived_at: "z", location_address: BASE.address },
  ]]]);
  const fx = M.selfCorrections([{ id: 10, is_route: true, status: "in_progress" }], stopsBy);
  assertEquals(fx.stopDone.map((s) => s.id), [1, 3]);
});

Deno.test("flag: completed by hand with no GPS visit; cleared when GPS shows one; GPS completion not flagged", () => {
  const fx = M.selfCorrections([
    { id: 1, status: "completed", status_source: "manual" },
    { id: 2, status: "completed", status_source: null, gps_arrived_at: "x", status_flag: M.FLAG_MANUAL_NO_GPS },
    { id: 3, status: "completed", status_source: "auto_gps" },
    { id: 4, status: "completed", status_source: "manual", combined_into_task_id: 9 },
  ], new Map());
  assertEquals(fx.flags, [{ id: 1, flag: M.FLAG_MANUAL_NO_GPS }, { id: 2, flag: null }]);
});

Deno.test("GPS completion overrides a hand-set status (force); hand-set in_progress is otherwise left alone", () => {
  const base = { task_type: "delivery", pickup_address: BASE.address, delivery_address: A.address, created_at: "2026-11-05T13:00:00Z", status_source: "manual" };
  const c = M.autoStatusFor({ ...base, status: "assigned", gps_arrived_at: "2026-11-05T14:30:00Z" }, [])!;
  assertEquals(c.to, "completed"); assertEquals(c.force, true);
  assertEquals(M.autoStatusFor({ ...base, status: "assigned", gps_departed_at: "2026-11-05T14:00:00Z" }, []), null);
  assertEquals(M.autoStatusFor({ ...base, status: "completed", gps_arrived_at: "2026-11-05T14:30:00Z" }, []), null);
});
