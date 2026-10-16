// map-route — road distances / drive times for the Route planner on map.html. Public (verify_jwt = false).
// POST { "action": "route" | "table", "points": [[lat,lon], ...] }
//   route -> { provider, label, legs:[{m,s}], total:{m,s}, geometry:[[lat,lon],...] }      (m = metres, s = seconds)
//   table -> { provider, label, durations:[[s]], distances:[[m]] }
// Provider order: Mapbox (only if the MAPBOX_TOKEN secret is set) -> OSRM public demo (router.project-osrm.org) ->
//   straight line x 1.3 at 30 mph (clearly labelled). None of them uses live traffic.
// Politeness for the OSRM demo (policy: reasonable non-commercial use, max 1 request/s, no guarantees):
//   * results cached in public.route_cache for 7 days (same request = no call),
//   * at most 1 call per 1.1 s per worker and at most 40 new calls per 10 min overall, otherwise straight-line fallback,
//   * identified User-Agent. Points must be within 250 km of McCook and at most 25 per request.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const BASE = [41.80335, -87.83656], MAX_PTS = 25, MAX_KM = 250, MAX_NEW_10MIN = 40, GAP_MS = 1100, TTL_MS = 7 * 86400e3;
const UA = "SHIFT-Dispatch/1.0 (Darwill dispatch board; low volume, cached)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const km = (a: number[], b: number[]) => { const R = 6371, r = (x: number) => x * Math.PI / 180, dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const s = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
let lastCall = 0;
async function polite() { const w = lastCall + GAP_MS - Date.now(); if (w > 0) await sleep(w); lastCall = Date.now(); }
async function sha(s: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

// straight line x 1.3, 30 mph average
const SL = { factor: 1.3, mph: 30 };
function straight(action: string, P: number[][]) {
  const leg = (a: number[], b: number[]) => { const m = km(a, b) * 1000 * SL.factor; return { m: Math.round(m), s: Math.round(m / (SL.mph * 0.44704)) }; };
  const label = "Straight-line estimate (x1.3, 30 mph) — no road data, no live traffic";
  if (action === "table") { const d = P.map((a) => P.map((b) => leg(a, b))); return { provider: "straight", label, durations: d.map((r) => r.map((x) => x.s)), distances: d.map((r) => r.map((x) => x.m)) }; }
  const legs = P.slice(1).map((b, i) => leg(P[i], b));
  return { provider: "straight", label, legs, total: { m: legs.reduce((a, x) => a + x.m, 0), s: legs.reduce((a, x) => a + x.s, 0) }, geometry: P };
}
async function osrm(action: string, P: number[][]) {
  const c = P.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const u = action === "table" ? `https://router.project-osrm.org/table/v1/driving/${c}?annotations=duration,distance&generate_hints=false`
    : `https://router.project-osrm.org/route/v1/driving/${c}?overview=full&geometries=geojson&steps=false&generate_hints=false`;
  await polite();
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("osrm http " + r.status);
  const j = await r.json(); if (j.code !== "Ok") throw new Error("osrm " + j.code);
  const label = "Estimated by OSRM (OpenStreetMap roads) — no live traffic";
  if (action === "table") return { provider: "osrm", label, durations: j.durations.map((r: number[]) => r.map((x) => Math.round(x ?? 0))), distances: j.distances.map((r: number[]) => r.map((x) => Math.round(x ?? 0))) };
  const rt = j.routes[0];
  return { provider: "osrm", label, legs: rt.legs.map((l: any) => ({ m: Math.round(l.distance), s: Math.round(l.duration) })), total: { m: Math.round(rt.distance), s: Math.round(rt.duration) }, geometry: rt.geometry.coordinates.map((x: number[]) => [x[1], x[0]]) };
}
// Ready for later: set the MAPBOX_TOKEN secret to switch providers (driving profile; no traffic in the matrix).
async function mapbox(action: string, P: number[][], token: string) {
  const c = P.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const u = action === "table" ? `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${c}?annotations=duration,distance&access_token=${token}`
    : `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${c}?overview=full&geometries=geojson&access_token=${token}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("mapbox http " + r.status);
  const j = await r.json(); if (j.code !== "Ok") throw new Error("mapbox " + j.code);
  if (action === "table") return { provider: "mapbox", label: "Estimated by Mapbox (typical traffic)", durations: j.durations.map((r: number[]) => r.map((x) => Math.round(x ?? 0))), distances: j.distances.map((r: number[]) => r.map((x) => Math.round(x ?? 0))) };
  const rt = j.routes[0];
  return { provider: "mapbox", label: "Estimated by Mapbox (current traffic)", legs: rt.legs.map((l: any) => ({ m: Math.round(l.distance), s: Math.round(l.duration) })), total: { m: Math.round(rt.distance), s: Math.round(rt.duration) }, geometry: rt.geometry.coordinates.map((x: number[]) => [x[1], x[0]]) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let body: any = {}; try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const action = body?.action === "table" ? "table" : "route";
  const P: number[][] = (Array.isArray(body?.points) ? body.points : []).map((p: any) => [Number(p?.[0]), Number(p?.[1])]);
  if (P.length < 2 || P.length > MAX_PTS) return json(400, { error: `2 to ${MAX_PTS} points` });
  if (P.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || km(p, BASE) > MAX_KM)) return json(400, { error: `points must be within ${MAX_KM} km of McCook` });
  const token = Deno.env.get("MAPBOX_TOKEN") || "";
  const provider = token ? "mapbox" : "osrm";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const key = await sha(provider + "|" + action + "|" + P.map((p) => p[0].toFixed(5) + "," + p[1].toFixed(5)).join(";"));
  const { data: hit } = await db.from("route_cache").select("response,created_at").eq("key", key).maybeSingle();
  if (hit && Date.now() - Date.parse(hit.created_at) < TTL_MS) return json(200, { ...hit.response, cached: true });
  const { count } = await db.from("route_cache").select("key", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 600e3).toISOString());
  if (provider === "osrm" && (count || 0) >= MAX_NEW_10MIN) return json(200, { ...straight(action, P), note: "busy: OSRM limit for this 10 min reached" });
  try {
    const out = provider === "mapbox" ? await mapbox(action, P, token) : await osrm(action, P);
    await db.from("route_cache").upsert({ key, provider, action, points: P.length, response: out, created_at: new Date().toISOString() }, { onConflict: "key" });
    return json(200, { ...out, cached: false });
  } catch (e) {
    return json(200, { ...straight(action, P), note: "routing engine unavailable: " + String((e as Error).message || e).slice(0, 80) });
  }
});
