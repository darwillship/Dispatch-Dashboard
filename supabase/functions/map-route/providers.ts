// Routing providers for map-route (imported by index.ts; testable on its own).
export const BASE = [41.80335, -87.83656];
export const km = (a: number[], b: number[]) => { const R = 6371, r = (x: number) => x * Math.PI / 180, dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const s = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const UA = "SHIFT-Dispatch/1.0 (Darwill dispatch board; low volume, cached)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function polite() { const w = lastCall + 1100 - Date.now(); if (w > 0) await sleep(w); lastCall = Date.now(); }
const coordStr = (P: number[][]) => P.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
const SL = { factor: 1.3, mph: 30 };
export function straight(action: string, P: number[][]) {
  const leg = (a: number[], b: number[]) => { const m = km(a, b) * 1000 * SL.factor; return { m: Math.round(m), s: Math.round(m / (SL.mph * 0.44704)) }; };
  const label = "Straight-line estimate (x1.3, 30 mph) — no road data, no live traffic";
  if (action === "table") { const d = P.map((a) => P.map((b) => leg(a, b))); return { provider: "straight", traffic: false, label, durations: d.map((r) => r.map((x) => x.s)), distances: d.map((r) => r.map((x) => x.m)) }; }
  const legs = P.slice(1).map((b, i) => leg(P[i], b));
  return { provider: "straight", traffic: false, label, legs, total: { m: legs.reduce((a, x) => a + x.m, 0), s: legs.reduce((a, x) => a + x.s, 0) }, geometry: P };
}
export async function osrm(action: string, P: number[][]) {
  const c = coordStr(P);
  const u = action === "table" ? `https://router.project-osrm.org/table/v1/driving/${c}?annotations=duration,distance&generate_hints=false`
    : `https://router.project-osrm.org/route/v1/driving/${c}?overview=full&geometries=geojson&steps=false&generate_hints=false`;
  await polite();
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("osrm http " + r.status);
  const j = await r.json(); if (j.code !== "Ok") throw new Error("osrm " + j.code);
  const label = "Estimated by OSRM (OpenStreetMap roads) — no live traffic";
  if (action === "table") return { provider: "osrm", traffic: false, label, durations: j.durations.map((r: number[]) => r.map((x) => Math.round(x ?? 0))), distances: j.distances.map((r: number[]) => r.map((x) => Math.round(x ?? 0))) };
  const rt = j.routes[0];
  return { provider: "osrm", traffic: false, label, legs: rt.legs.map((l: any) => ({ m: Math.round(l.distance), s: Math.round(l.duration) })), total: { m: Math.round(rt.distance), s: Math.round(rt.duration) }, geometry: rt.geometry.coordinates.map((x: number[]) => [x[1], x[0]]) };
}
// Mapbox: Directions with the driving-traffic profile (live + typical traffic, up to 25 points).
// Matrix: driving-traffic allows at most 10 points, so larger "Best order" matrices use the driving profile (typical speeds).
export async function mapbox(action: string, P: number[][], token: string) {
  const c = coordStr(P), tq = `access_token=${encodeURIComponent(token)}`;
  const prof = action === "table" && P.length > 10 ? "driving" : "driving-traffic";
  const u = action === "table" ? `https://api.mapbox.com/directions-matrix/v1/mapbox/${prof}/${c}?annotations=duration,distance&${tq}`
    : `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${c}?overview=full&geometries=geojson&steps=false&${tq}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("mapbox http " + r.status);
  const j = await r.json(); if (j.code !== "Ok") throw new Error("mapbox " + j.code);
  const traffic = prof === "driving-traffic";
  const label = traffic ? "Mapbox — includes live traffic" : "Mapbox — typical traffic (no live traffic for more than 10 points)";
  if (action === "table") return { provider: "mapbox", traffic, label, durations: j.durations.map((r: number[]) => r.map((x) => Math.round(x ?? 0))), distances: (j.distances || j.durations).map((r: number[]) => r.map((x) => Math.round(x ?? 0))) };
  const rt = j.routes[0];
  return { provider: "mapbox", traffic: true, label: "Mapbox — includes live traffic", legs: rt.legs.map((l: any) => ({ m: Math.round(l.distance), s: Math.round(l.duration) })), total: { m: Math.round(rt.distance), s: Math.round(rt.duration) }, geometry: rt.geometry.coordinates.map((x: number[]) => [x[1], x[0]]) };
}
