// vzc-sync — Verizon Connect Reveal → SHIFT Dispatch Dashboard GPS updater (Supabase Edge Function, verify_jwt = true).
//
// POST body (all optional): { "dry_run": true|false, "dates": ["YYYY-MM-DD"], "vehicles": ["Big Blue"] }
//   dry_run defaults to TRUE — nothing is written unless the caller explicitly sends "dry_run": false.
// Caller must present the project's service_role key (pg_cron does this via the Vault secret in public.vzc_sync_invoke).
// Secrets (Supabase Dashboard → Edge Functions → Secrets): VZC_USERNAME, VZC_PASSWORD, VZC_APP_ID.
// Optional: VZC_EXCLUDE_DRIVER_IDS (comma list), VZC_ALLOW_OTHER_TRUCK ("1" = match trucks other than the planned one).
import { logFailure, runSync, type Env } from "./sync.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });

function roleOf(jwt: string): string | null {
  try {
    const p = jwt.split(".")[1];
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4))).role ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json(405, { ok: false, error: "use POST" });
  const username = Deno.env.get("VZC_USERNAME")?.trim() ?? "", password = Deno.env.get("VZC_PASSWORD") ?? "";
  if (!username || !password) {
    return json(503, {
      ok: false, error: "missing VZC_USERNAME/VZC_PASSWORD",
      detail: "Set them in Supabase Dashboard → Edge Functions → Secrets (VZC_USERNAME, VZC_PASSWORD, VZC_APP_ID). Nothing was synced.",
      missing: [!username && "VZC_USERNAME", !password && "VZC_PASSWORD"].filter(Boolean),
    });
  }
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  // verify_jwt = true already rejected unsigned/forged tokens; here we additionally require the service role.
  if (!bearer || (bearer !== serviceKey && roleOf(bearer) !== "service_role")) {
    return json(403, { ok: false, error: "forbidden: vzc-sync must be called with the service role key (pg_cron / SQL editor)" });
  }
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const dryRun = body?.dry_run !== false; // safe default
  const env: Env = {
    username, password,
    appId: Deno.env.get("VZC_APP_ID")?.trim() || "DarwillDispatchDashboard",
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "", serviceKey,
    excludeDrivers: (Deno.env.get("VZC_EXCLUDE_DRIVER_IDS") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
    allowOtherTruck: Deno.env.get("VZC_ALLOW_OTHER_TRUCK") === "1",
  };
  const dates = Array.isArray(body?.dates) ? body.dates.filter((d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined;
  try {
    const summary = await runSync(env, { dryRun, dates, vehicles: Array.isArray(body?.vehicles) ? body.vehicles : undefined, source: body?.source });
    return json(200, { ok: true, summary });
  } catch (e) {
    let msg = String((e as Error)?.message ?? e);
    if (password.length >= 6) msg = msg.replaceAll(password, "***"); // belt and braces: never echo the password
    console.error("vzc-sync failed:", msg);
    await logFailure(env, dryRun, msg);
    return json(500, { ok: false, dry_run: dryRun, error: msg });
  }
});
