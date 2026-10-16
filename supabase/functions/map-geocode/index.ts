// map-geocode — coordinates for the Map page (map.html). Public (verify_jwt = false), read-mostly.
// POST { "addresses": ["..."], "dry_run": true|false }  ->  { "results": { "<address>": { lat, lon, status, source } } }
// * Only addresses that appear on a dispatch task, route stop or saved location (v2) are looked up (anything else is ignored) — the page can't be
//   used as a free geocoder.
// * Cache first (geocode_cache, same keys as vzc-sync). Misses: SAME method as vzc-sync (geocode.ts: US Census, then OSM
//   Nominatim bounded to Chicagoland), at most 4 per call, 1.1 s apart, and at most 30 new lookups per 10 min overall
//   (Nominatim policy: <= 1 request/s, identified User-Agent, results cached). A not-found is cached and retried after 7 days.
// * Writes only new/stale rows into geocode_cache (never overwrites an ok row). dry_run = look up, write nothing.
import { createClient } from "npm:@supabase/supabase-js@2";
import { geocodeAddress } from "../vzc-sync/geocode.ts";
import { cacheKey, BASE_NORM, BASE_LAT, BASE_LON } from "../vzc-sync/match.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const MAX_IN = 60, MAX_NEW_PER_CALL = 4, MAX_NEW_PER_10MIN = 30, GAP_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: "bad json" }); }
  const dry = body?.dry_run === true;
  const asked = [...new Set((Array.isArray(body?.addresses) ? body.addresses : []).filter((a: unknown) => typeof a === "string" && a.trim().length > 4 && a.length < 300).map((a: string) => a.trim()))].slice(0, MAX_IN) as string[];
  if (!asked.length) return json(200, { results: {}, geocoded: 0 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // only addresses that are really on a task / stop
  const [t1, t2, t3, t4] = await Promise.all([
    db.from("dispatch_tasks").select("pickup_address").in("pickup_address", asked),
    db.from("dispatch_tasks").select("delivery_address").in("delivery_address", asked),
    db.from("dispatch_task_stops").select("location_address").in("location_address", asked),
    db.from("saved_locations").select("address").in("address", asked),
  ]);
  if (t1.error || t2.error || t3.error || t4.error) return json(500, { error: "lookup failed" });
  const known = new Set<string>([...(t1.data || []).map((r: any) => r.pickup_address), ...(t2.data || []).map((r: any) => r.delivery_address), ...(t3.data || []).map((r: any) => r.location_address), ...(t4.data || []).map((r: any) => r.address)]);
  const addrs = asked.filter((a) => known.has(a));
  const keys = new Map(addrs.map((a) => [a, cacheKey(a)]));
  const { data: gc, error: ge } = await db.from("geocode_cache").select("address_norm,lat,lon,status,source,geocoded_at").in("address_norm", [...new Set(keys.values())]);
  if (ge) return json(500, { error: "cache read failed" });
  const cache = new Map((gc || []).map((g: any) => [g.address_norm, g]));
  const since = new Date(Date.now() - 600e3).toISOString();
  const { count } = await db.from("geocode_cache").select("address_norm", { count: "exact", head: true }).gte("geocoded_at", since);
  let budget = Math.max(0, Math.min(MAX_NEW_PER_CALL, MAX_NEW_PER_10MIN - (count || 0))), done = 0;
  const results: Record<string, unknown> = {};
  for (const a of addrs) {
    const k = keys.get(a)!;
    if (k === BASE_NORM) { results[a] = { lat: BASE_LAT, lon: BASE_LON, status: "ok", source: "base" }; continue; }
    let g: any = cache.get(k);
    const stale = g && g.status !== "ok" && Date.now() - Date.parse(g.geocoded_at) > 7 * 86400e3;
    if ((!g || stale) && budget > 0) {
      if (done) await sleep(GAP_MS);
      budget--; done++;
      const r = await geocodeAddress(a);
      g = { address_norm: k, address: a, lat: r.lat, lon: r.lon, status: r.status, source: r.source, matched_address: r.matched, geocoded_at: new Date().toISOString() };
      cache.set(k, g);
      if (!dry && r.status !== "error") await db.from("geocode_cache").upsert(g, { onConflict: "address_norm" });
    }
    results[a] = g ? { lat: g.status === "ok" ? g.lat : null, lon: g.status === "ok" ? g.lon : null, status: g.status, source: g.source } : { lat: null, lon: null, status: "pending", source: null };
  }
  return json(200, { results, geocoded: done, ignored: asked.length - addrs.length, dry_run: dry });
});
