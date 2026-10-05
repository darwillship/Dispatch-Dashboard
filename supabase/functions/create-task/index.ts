// SHIFT Dispatch — OPTIONAL Supabase Edge Function stub: POST a job into "Ready to Assign".
// NOT deployed. To use:  supabase functions deploy create-task
//   then set secrets:    supabase secrets set SHIFT_API_TOKEN=<pick-a-long-random-string>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase at runtime.
// Call:
//   curl -X POST https://hqhfstosclasgwgxubip.supabase.co/functions/v1/create-task \
//     -H "Authorization: Bearer <SHIFT_API_TOKEN>" -H "Content-Type: application/json" \
//     -d '{"delivery_name":"ALG","delivery_address":"1053 N Schmidt Rd, Romeoville, IL 60446","time":"09:00"}'
import { createClient } from "npm:@supabase/supabase-js@2";

const HOME = { name: "Darwill McCook", address: "8701 47th St Ste C, McCook, IL 60525" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const token = Deno.env.get("SHIFT_API_TOKEN");
  if (!token || req.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const pickup_name = b.pickup_name || HOME.name, pickup_address = b.pickup_address || (b.pickup_name ? null : HOME.address);
  const delivery_name = b.delivery_name || HOME.name, delivery_address = b.delivery_address || (b.delivery_name ? null : HOME.address);
  if (pickup_name === HOME.name && delivery_name === HOME.name) return new Response("Need pickup or delivery", { status: 400 });
  const work_date = b.work_date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  // "time" is Chicago local (HH:MM). Work out Chicago's UTC offset for that date (handles CST/CDT).
  const local = `${work_date}T${b.time || "08:00"}:00`;
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${work_date}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value || "GMT-6"; // e.g. "GMT-5"
  const hours = Number(tzName.replace("GMT", "")) || -6;
  const offset = `${hours < 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}:00`;
  const scheduled_at = b.scheduled_at || new Date(local + offset).toISOString();

  const row = {
    work_date, title: `${pickup_name} - ${delivery_name}`, pickup_name, pickup_address, delivery_name, delivery_address,
    scheduled_at, priority: b.priority || "normal", job_client: b.job_client || null, material: b.material || null,
    pallet_qty: b.pallet_qty ?? null, instructions: b.instructions || null,
    task_type: b.task_type || (pickup_name === HOME.name ? "delivery" : "pickup"),
    status: "pending", planning_stage: "ready", assigned_driver_id: null, sort_order: 999,
  };
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await db.from("dispatch_tasks").insert(row).select().single();
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  return new Response(JSON.stringify({ ok: true, task: data }), { headers: { "Content-Type": "application/json" } });
});
