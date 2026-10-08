// vzc-sync — Verizon Connect Reveal → SHIFT Dispatch Dashboard GPS updater (Supabase Edge Function, verify_jwt = false).
//
// POST body (all optional): { "dry_run": true|false, "dates": ["YYYY-MM-DD"], "vehicles": ["Big Blue"], "recompute": true,
//   "assign_sim": { "ignore_trucks_of": [driver ids], "all_day": true } }   <- dry runs only: replay automatic truck assignment
//   dry_run defaults to TRUE — nothing is written unless the caller explicitly sends "dry_run": false.
//   recompute (dry runs only) ignores times already stored, to compare the matcher against filled-in days.
// Auth: header x-vzc-token must equal the Vault secret 'vzc_sync_invoke_token' (generated inside Postgres; pg_cron sends it
// via public.vzc_sync_invoke), or Authorization: Bearer <exact SUPABASE_SERVICE_ROLE_KEY>. Anything else → 401.
// Secrets (Supabase Dashboard → Edge Functions → Secrets): VZC_USERNAME, VZC_PASSWORD, VZC_APP_ID.
// Optional: VZC_EXCLUDE_DRIVER_IDS (comma list), VZC_ALLOW_OTHER_TRUCK ("1" = match trucks other than the planned one).
import { createClient } from "npm:@supabase/supabase-js@2";
import { logFailure, runSync, type Env } from "./sync.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });

const enc = new TextEncoder();
async function sameSecret(a: string, b: string): Promise<boolean> {
  // constant-time: compare fixed-length SHA-256 digests with an XOR accumulator (no early exit)
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length > 0 && b.length > 0;
}
let expected: { v: string; at: number } | null = null; // cached per isolate for 5 min (rotation is picked up after that)
async function expectedToken(url: string, key: string, force = false): Promise<string> {
  if (!force && expected && Date.now() - expected.at < 300_000) return expected.v;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("vzc_sync_expected_token"); // service_role-only SECURITY DEFINER rpc
  if (error) throw new Error("invoke token lookup failed");
  expected = { v: typeof data === "string" ? data : "", at: Date.now() };
  return expected.v;
}
async function authorized(req: Request, url: string, serviceKey: string): Promise<boolean> {
  const tok = req.headers.get("x-vzc-token") ?? "";
  if (tok) {
    if (await sameSecret(tok, await expectedToken(url, serviceKey))) return true;
    if (expected && Date.now() - expected.at > 30_000 && await sameSecret(tok, await expectedToken(url, serviceKey, true))) return true;
  }
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!bearer && !!serviceKey && await sameSecret(bearer, serviceKey); // exact service_role key only (no unsigned JWT trust)
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json(405, { ok: false, error: "use POST" });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  let ok = false;
  try { ok = await authorized(req, supabaseUrl, serviceKey); } catch { ok = false; }
  if (!ok) return json(401, { ok: false, error: "unauthorized" });
  const username = Deno.env.get("VZC_USERNAME")?.trim() ?? "", password = Deno.env.get("VZC_PASSWORD") ?? "";
  if (!username || !password) {
    return json(503, {
      ok: false, error: "missing VZC_USERNAME/VZC_PASSWORD",
      detail: "Set them in Supabase Dashboard → Edge Functions → Secrets (VZC_USERNAME, VZC_PASSWORD, VZC_APP_ID). Nothing was synced.",
      missing: [!username && "VZC_USERNAME", !password && "VZC_PASSWORD"].filter(Boolean),
    });
  }
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const dryRun = body?.dry_run !== false; // safe default
  const env: Env = {
    username, password,
    appId: Deno.env.get("VZC_APP_ID")?.trim() || "DarwillDispatchDashboard",
    supabaseUrl, serviceKey,
    excludeDrivers: (Deno.env.get("VZC_EXCLUDE_DRIVER_IDS") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
    allowOtherTruck: Deno.env.get("VZC_ALLOW_OTHER_TRUCK") === "1",
  };
  const dates = Array.isArray(body?.dates) ? body.dates.filter((d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined;
  try {
    const summary = await runSync(env, { dryRun, dates, vehicles: Array.isArray(body?.vehicles) ? body.vehicles : undefined, source: body?.source, recompute: dryRun && body?.recompute === true,
      assignSim: dryRun && body?.assign_sim && typeof body.assign_sim === "object" ? { ignoreTrucksOf: Array.isArray(body.assign_sim.ignore_trucks_of) ? body.assign_sim.ignore_trucks_of.map(Number) : [], allDay: body.assign_sim.all_day === true } : undefined });
    return json(200, { ok: true, summary });
  } catch (e) {
    let msg = String((e as Error)?.message ?? e);
    if (password.length >= 6) msg = msg.replaceAll(password, "***"); // belt and braces: never echo the password
    console.error("vzc-sync failed:", msg);
    await logFailure(env, dryRun, msg);
    return json(500, { ok: false, dry_run: dryRun, error: msg });
  }
});
