// map-route — road distances / drive times for the Route planner on map.html. Public (verify_jwt = false).
// POST { "action": "route" | "table", "points": [[lat,lon], ...] }
//   route -> { provider, traffic, label, legs:[{m,s}], total:{m,s}, geometry:[[lat,lon],...] }      (m = metres, s = seconds)
//   table -> { provider, traffic, label, durations:[[s]], distances:[[m]] }
// v2 (v4.9.1): provider chain Mapbox driving-traffic (when the MAPBOX_TOKEN secret is set) -> OSRM public demo -> straight
//   line x1.3 at 30 mph; a fallback answer carries a "note" saying why. Cache (public.route_cache) key includes the provider, so
//   old OSRM rows are never returned once Mapbox is on. TTL: Mapbox (live traffic) 15 min, OSRM 7 days. Fallback answers
//   are not cached.
// OSRM demo politeness: max 1 call / 1.1 s per worker, max 40 new OSRM calls / 10 min overall, identified User-Agent.
// Points must be within 250 km of McCook and at most 25 per request.
import { createClient } from "npm:@supabase/supabase-js@2";
import { BASE, km, straight, osrm, mapbox } from "./providers.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const MAX_PTS = 25, MAX_KM = 250, MAX_OSRM_10MIN = 40, TTL = { mapbox: 15 * 60e3, osrm: 7 * 86400e3 } as Record<string, number>;
async function sha(s: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let body: any = {}; try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const action = body?.action === "table" ? "table" : "route";
  const P: number[][] = (Array.isArray(body?.points) ? body.points : []).map((p: any) => [Number(p?.[0]), Number(p?.[1])]);
  if (P.length < 2 || P.length > MAX_PTS) return json(400, { error: `2 to ${MAX_PTS} points` });
  if (P.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || km(p, BASE) > MAX_KM)) return json(400, { error: `points must be within ${MAX_KM} km of McCook` });
  const token = Deno.env.get("MAPBOX_TOKEN") || "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const pk = P.map((p) => p[0].toFixed(5) + "," + p[1].toFixed(5)).join(";");
  const chain = token ? ["mapbox", "osrm"] : ["osrm"];
  const why: string[] = [];
  for (const provider of chain) {
    const key = await sha(provider + "|" + action + "|" + pk);
    const { data: hit } = await db.from("route_cache").select("response,created_at").eq("key", key).maybeSingle();
    if (hit && Date.now() - Date.parse(hit.created_at) < TTL[provider]) return json(200, { ...hit.response, cached: true, cached_at: hit.created_at, ...(why.length ? { note: why.join("; ") } : {}) });
    if (provider === "osrm") {
      const { count } = await db.from("route_cache").select("key", { count: "exact", head: true }).eq("provider", "osrm").gte("created_at", new Date(Date.now() - 600e3).toISOString());
      if ((count || 0) >= MAX_OSRM_10MIN) { why.push("OSRM limit for this 10 min reached"); continue; }
    }
    try {
      const out = provider === "mapbox" ? await mapbox(action, P, token) : await osrm(action, P);
      await db.from("route_cache").upsert({ key, provider, action, points: P.length, response: out, created_at: new Date().toISOString() }, { onConflict: "key" });
      return json(200, { ...out, cached: false, ...(why.length ? { note: why.join("; ") } : {}) });
    } catch (e) { why.push(`${provider === "mapbox" ? "Mapbox" : "OSRM"} unavailable (${String((e as Error).message || e).slice(0, 60)})`); }
  }
  return json(200, { ...straight(action, P), note: why.join("; ") || "no routing engine" });
});
