// vzc-sync / geocode.ts — address → lat/lon. US Census Geocoder first (free, no key), OSM Nominatim as fallback.
import { geocodeQuery, normalizeAddress } from "./match.ts";

export interface Geo { status: "ok" | "not_found" | "error"; lat: number | null; lon: number | null; source: string; matched: string | null }
const UA = "DarwillDispatch-vzc-sync/1.0 (darwillshipping7@gmail.com)";

async function census(q: string, signal?: AbortSignal): Promise<Geo | null> {
  const u = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(q);
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal });
  if (!r.ok) throw new Error(`census http ${r.status}`);
  const j = await r.json();
  const m = j?.result?.addressMatches?.[0];
  if (!m) return null;
  return { status: "ok", lat: m.coordinates.y, lon: m.coordinates.x, source: "census", matched: m.matchedAddress ?? null };
}
async function nominatim(q: string, signal?: AbortSignal): Promise<Geo | null> {
  // bounded to greater Chicagoland so a city-less address can't land in another state
  const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=us&viewbox=-89.2,42.7,-87.2,41.1&bounded=1&q=" + encodeURIComponent(q);
  const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal });
  if (!r.ok) throw new Error(`nominatim http ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  const a = j[0].address || {};
  // only accept house-level results; a bare street point can be a kilometre off
  const matched = a.house_number && a.road ? `${a.house_number} ${a.road}, ${a.city || a.town || a.village || a.hamlet || ""}` : null;
  if (!matched) return { status: "ok", lat: Number(j[0].lat), lon: Number(j[0].lon), source: "nominatim", matched: "(street-level) " + (j[0].display_name ?? "") };
  return { status: "ok", lat: Number(j[0].lat), lon: Number(j[0].lon), source: "nominatim", matched };
}

/** Census sometimes "fixes" an address to the wrong side of town (1525 W Lake St → 1525 E Lake St). Reject a match whose
 *  house number differs or whose street direction contradicts the one we asked for. */
export function plausibleMatch(asked: string, matched: string | null): boolean {
  if (!matched) return true;
  if (matched.startsWith("(street-level)")) return false;
  const a = normalizeAddress(asked).split("|")[0].split(" "), m = normalizeAddress(matched).split("|")[0].split(" ");
  if (!a[0] || !m[0]) return true;
  if (a[0] !== m[0]) return false;
  const dirs = ["n", "s", "e", "w"];
  if (dirs.includes(a[1]) && dirs.includes(m[1]) && a[1] !== m[1]) return false;
  return true;
}

export async function geocodeAddress(address: string, timeoutMs = 10000): Promise<Geo> {
  const q = geocodeQuery(address);
  let lastErr: string | null = null, suspect: Geo | null = null;
  for (const fn of [census, nominatim]) {
    try {
      const g = await fn(q, AbortSignal.timeout(timeoutMs));
      if (g && plausibleMatch(address, g.matched)) return g;
      if (g && !suspect) suspect = { ...g, source: g.source + ":unverified" };
    } catch (e) { lastErr = String((e as Error).message || e); }
  }
  // Unverified result: keep it for diagnostics but without coordinates → no geofence; matching falls back to the
  // street address Reveal reports for each GPS point (which is exact for these stops).
  if (suspect) return { status: "not_found", lat: null, lon: null, source: suspect.source, matched: suspect.matched };
  return { status: lastErr ? "error" : "not_found", lat: null, lon: null, source: lastErr ? `error:${lastErr}`.slice(0, 120) : "census+nominatim", matched: null };
}
