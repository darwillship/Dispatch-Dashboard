/* SHIFT Dispatch v3.5.0 — Driver Time Sheet integration (read-only).
   - Live activity line on each driver card (driver_live_status, written by the Driver Time Sheet app).
   - "On the clock" line from today's open driver_shifts.
   - Time Sheets modal: shifts by date range with per-driver totals, read-only/printable pre-trip viewer, CSV export.
   This file performs NO writes. It reuses globals from index.html (db, drivers, boardDate, ymd, esc, $, load, render). */
(function(){
const TS_STALE_MS=12*3600*1000;
const TS_ICON={"Driving":"🚚","Loading":"📦","Unloading":"📥","Waiting":"⏳","Fueling":"⛽","Lunch":"🍽️","Drop & Hook":"🔁","Vehicle issue":"🔧","Other":"•••","Pickup":"📦","Delivery":"📥"};
const TS={live:[],shifts:[],ok:false};
window.SHIFT_TS=TS;

const css=`
.ts-line{margin:7px 12px 0;padding:6px 9px;border-radius:8px;font-size:12px;font-weight:800;line-height:1.35;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.ts-line small{font-weight:600;opacity:.8}
.ts-live{background:rgba(255,194,61,.10);border:1px solid rgba(255,194,61,.35);color:#ffd27a}
.ts-live.lunch{background:rgba(120,180,255,.10);border-color:rgba(120,180,255,.35);color:#a9cdff}
.ts-clock{background:rgba(64,200,120,.10);border:1px solid rgba(64,200,120,.32);color:#8fe0b0}
.ts-clock.off{background:#132233;border-color:#213549;color:#9fb3c6}
.ts-modal .dialog{width:min(1180px,100%)}
.ts-body{padding:14px 20px 22px}
.ts-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:12px}
.ts-controls label{margin:0 0 4px}.ts-controls .f{min-width:140px}
.ts-tabs{display:flex;gap:6px;margin:6px 0 12px}.ts-tabs button{padding:8px 12px;border-radius:9px;background:#132233;color:#b8c8d8;font-weight:800;border:1px solid #213549}
.ts-tabs button.on{background:#1f4f7d;color:#fff;border-color:#2d6aa3}
.ts-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
.ts-table th{text-align:left;color:#8fa0b5;font-weight:800;padding:7px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
.ts-table td{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
.ts-table td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ts-table tr.ts-acts td{background:rgba(255,255,255,.02)}
.ts-pill{display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:900}
.ts-pill.open{background:rgba(64,200,120,.15);color:#8fe0b0}.ts-pill.completed{background:#1b2a3b;color:#aebed0}.ts-pill.discarded{background:rgba(255,100,100,.12);color:#ff9d9d}
.ts-pill.defects{background:rgba(255,100,100,.15);color:#ff9d9d}.ts-pill.ok{background:rgba(64,200,120,.15);color:#8fe0b0}
.ts-h{font-size:13px;font-weight:900;margin:6px 0 8px;color:#dce8f4}
.ts-empty{padding:18px;color:#8fa0b5}
.ts-note{color:#8fa0b5;font-size:11.5px;margin:0 0 10px}
.ts-scroll{overflow:auto}
body.light-mode .ts-live{background:#fff8e6!important;border-color:#f0d48a!important;color:#7a5600!important}
body.light-mode .ts-live.lunch{background:#eef5ff!important;border-color:#b8d3f5!important;color:#24508a!important}
body.light-mode .ts-clock{background:#eefaf3!important;border-color:#b5e3c7!important;color:#1d6b40!important}
body.light-mode .ts-clock.off{background:#f3f7fb!important;border-color:#d0dce7!important;color:#2b4052!important}
body.light-mode .ts-tabs button{background:#f3f7fb;color:#2b4052;border-color:#d0dce7}
body.light-mode .ts-tabs button.on{background:#1f4f7d;color:#fff}
body.light-mode .ts-h{color:#1d2f40}
body.light-mode .ts-table td{border-bottom-color:#e3eaf1}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

/* ---------- helpers ---------- */
function hm(min){min=Math.max(0,Math.round(Number(min)||0));return `${Math.floor(min/60)}:${String(min%60).padStart(2,"0")}`}
function hrs(min){min=Math.max(0,Math.round(Number(min)||0));let h=Math.floor(min/60),m=min%60;return h?`${h}h ${m}m`:`${m}m`}
function t12(v){return v?new Date(v).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):""}
function dt(v){if(!v)return "";let d=new Date(v);return `${ymd(d)} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`}
function minsSince(v){return v?Math.max(0,(Date.now()-new Date(v).getTime())/60000):0}
function isToday(){return boardDate===ymd(new Date())}
function shiftMinutes(s){if(s.shift_minutes!=null&&s.status!=="open")return Number(s.shift_minutes);let end=s.shift_end?new Date(s.shift_end).getTime():Date.now();return Math.max(0,(end-new Date(s.shift_start).getTime())/60000)}
function withTimeout(p,ms){return Promise.race([p,new Promise(r=>setTimeout(()=>r({error:{message:"timeout"}}),ms))])}
function driverName(id,fallback){let d=(drivers||[]).find(x=>Number(x.id)===Number(id));return d?d.name:(fallback||`Driver ${id}`)}

/* ---------- data for driver cards (runs on every load(), i.e. the existing 20 s refresh) ---------- */
async function tsFetch(){
  try{
    let today=ymd(new Date());
    let [lv,sh]=await Promise.all([
      withTimeout(db.from("driver_live_status").select("*"),6000),
      withTimeout(db.from("driver_shifts").select("id,driver_id,driver_name,work_date,status,shift_start,shift_end,shift_minutes,vehicle").eq("work_date",today).neq("status","discarded").order("shift_start",{ascending:false}),6000)
    ]);
    TS.live=lv.error?[]:(lv.data||[]);TS.shifts=sh.error?[]:(sh.data||[]);TS.ok=!lv.error||!sh.error;
  }catch(e){console.warn("Time sheet data unavailable",e)}
}
const origLoad=window.load;
window.load=async function(...a){await tsFetch();return origLoad.apply(this,a)};

window.SHIFT_tsLiveFor=function(driverId){
  let r=TS.live.find(x=>Number(x.driver_id)===Number(driverId));
  if(!r||!r.active||!r.activity_type)return null;
  let last=Math.max(new Date(r.updated_at||0).getTime(),new Date(r.started_at||0).getTime());
  if(!last||Date.now()-last>TS_STALE_MS)return null;
  return r;
};
window.SHIFT_tsDriverLines=function(d){
  if(!isToday())return "";
  let out="";
  let mine=TS.shifts.filter(s=>Number(s.driver_id)===Number(d.id));
  let open=mine.find(s=>s.status==="open");
  if(open)out+=`<div class="ts-line ts-clock" title="From the Driver Time Sheet app${open.vehicle?" · "+esc(open.vehicle):""}">🕒 On since ${esc(t12(open.shift_start))} · ${esc(hrs(minsSince(open.shift_start)))}</div>`;
  else{let done=mine.filter(s=>s.status==="completed");if(done.length){let tot=done.reduce((a,s)=>a+shiftMinutes(s),0),last=done[0];out+=`<div class="ts-line ts-clock off" title="Completed time sheet(s) today">✓ Off the clock · worked ${esc(hrs(tot))} <small>(${esc(t12(last.shift_start))}–${esc(t12(last.shift_end))})</small></div>`}}
  let r=window.SHIFT_tsLiveFor(d.id);
  if(r){
    let type=r.activity_type,el=hm(minsSince(r.started_at)),ico=TS_ICON[type]||"•";
    let label=type==="Lunch"?"On lunch":type==="Waiting"&&r.activity_notes?`Waiting – ${r.activity_notes}`:type;
    let extra=type==="Waiting"?"":(r.activity_notes?` – ${r.activity_notes}`:"");
    out+=`<div class="ts-line ts-live ${type==="Lunch"?"lunch":""}" title="Live from the Driver Time Sheet · updated ${esc(t12(r.updated_at))}">${ico} ${esc(label+extra)} · ${esc(el)}${r.activity_location?` <small>${esc(r.activity_location)}</small>`:""}</div>`;
  }
  return out;
};
// first paint may have happened before this file loaded
tsFetch().then(()=>{try{render()}catch(_){}});

/* ---------- Time Sheets modal ---------- */
const PT={shifts:[],pretrips:[],acts:{},tab:"shifts"};
function mondayOf(d){d=new Date(d);let k=(d.getDay()+6)%7;d.setDate(d.getDate()-k);return ymd(d)}
function buildModal(){
  if($("tsModal"))return;
  let m=document.createElement("div");m.className="modal history-modal ts-modal";m.id="tsModal";
  m.innerHTML=`<div class="dialog"><div class="dialog-head"><div><b>Time Sheets</b><div class="muted" style="font-size:12px;margin-top:3px">Driver shifts and DOT pre-trip inspections from the Driver Time Sheet app (read-only)</div></div><button class="close" onclick="SHIFT_closeTimeSheets()">×</button></div>
  <div class="ts-body"><div class="ts-controls"><div class="f"><label>From</label><input type="date" id="tsFrom"></div><div class="f"><label>To</label><input type="date" id="tsTo"></div><div class="f"><label>Driver</label><select id="tsDriver"><option value="">All drivers</option></select></div><button class="btn ghost" type="button" onclick="SHIFT_loadTimeSheets()">Load</button><button class="btn ghost" type="button" onclick="SHIFT_tsCsv('shifts')">⬇ Shifts CSV</button><button class="btn ghost" type="button" onclick="SHIFT_tsCsv('activities')">⬇ Activities CSV</button><button class="btn ghost" type="button" onclick="SHIFT_tsCsv('pretrips')">⬇ Pre-Trips CSV</button></div>
  <div class="ts-tabs"><button type="button" id="tsTabShifts" class="on" onclick="SHIFT_tsTab('shifts')">Shifts</button><button type="button" id="tsTabPretrips" onclick="SHIFT_tsTab('pretrips')">Pre-Trips</button></div>
  <div id="tsContent" class="ts-scroll"><div class="ts-empty">Loading…</div></div></div></div>`;
  m.onclick=e=>{if(e.target===m)SHIFT_closeTimeSheets()};
  document.body.appendChild(m);
}
window.SHIFT_openTimeSheets=function(){
  buildModal();
  if(!$("tsFrom").value){$("tsFrom").value=mondayOf(new Date());$("tsTo").value=ymd(new Date())}
  let sel=$("tsDriver"),cur=sel.value;sel.innerHTML='<option value="">All drivers</option>'+(drivers||[]).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join("");sel.value=cur;
  $("tsModal").classList.add("show");SHIFT_loadTimeSheets();
};
window.SHIFT_closeTimeSheets=function(){$("tsModal")?.classList.remove("show")};
window.SHIFT_tsTab=function(t){PT.tab=t;$("tsTabShifts").classList.toggle("on",t==="shifts");$("tsTabPretrips").classList.toggle("on",t==="pretrips");renderTs()};
window.SHIFT_loadTimeSheets=async function(){
  let from=$("tsFrom").value,to=$("tsTo").value,drv=$("tsDriver").value;
  if(!from||!to)return;
  $("tsContent").innerHTML='<div class="ts-empty">Loading…</div>';
  let qs=db.from("driver_shifts").select("*").gte("work_date",from).lte("work_date",to).order("work_date",{ascending:false}).order("shift_start",{ascending:false}).limit(2000);
  let qp=db.from("driver_pretrips").select("*").gte("work_date",from).lte("work_date",to).order("submitted_at",{ascending:false}).limit(2000);
  if(drv){qs=qs.eq("driver_id",Number(drv));qp=qp.eq("driver_id",Number(drv))}
  let [s,p]=await Promise.all([qs,qp]);
  if(s.error||p.error){$("tsContent").innerHTML=`<div class="ts-empty">Could not load time sheets: ${esc((s.error||p.error).message)}</div>`;return}
  PT.shifts=s.data||[];PT.pretrips=p.data||[];PT.acts={};renderTs();
};
function renderTs(){
  let host=$("tsContent");if(!host)return;
  if(PT.tab==="pretrips"){host.innerHTML=renderPretrips();return}
  let shifts=PT.shifts.filter(s=>s.status!=="discarded");
  if(!PT.shifts.length){host.innerHTML='<div class="ts-empty">No shifts recorded for this date range.</div>';return}
  let by={};
  shifts.forEach(s=>{let k=s.driver_id;let b=by[k]||(by[k]={name:driverName(s.driver_id,s.driver_name),n:0,shift:0,drive:0,prod:0,wait:0,lunch:0,open:0});b.n++;b.shift+=shiftMinutes(s);b.drive+=Number(s.driving_minutes)||0;b.prod+=Number(s.productive_minutes)||0;b.wait+=Number(s.waiting_minutes)||0;b.lunch+=Number(s.lunch_minutes)||0;if(s.status==="open")b.open++});
  let rows=Object.values(by).sort((a,b)=>a.name.localeCompare(b.name));
  let tot=rows.reduce((a,b)=>({n:a.n+b.n,shift:a.shift+b.shift,drive:a.drive+b.drive,prod:a.prod+b.prod,wait:a.wait+b.wait,lunch:a.lunch+b.lunch}),{n:0,shift:0,drive:0,prod:0,wait:0,lunch:0});
  let pct=(p,s)=>s?(p/s*100).toFixed(1)+"%":"—";
  let summary=`<div class="ts-h">Per-driver totals</div><div class="ts-note">Open shifts count time so far; driving/productive/waiting/lunch are filled in when the driver taps End Shift.</div><table class="ts-table"><thead><tr><th>Driver</th><th class="n">Shifts</th><th class="n">Hours</th><th class="n">Driving</th><th class="n">Productive</th><th class="n">Waiting</th><th class="n">Lunch</th><th class="n">Productivity</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${esc(b.name)}${b.open?` <span class="ts-pill open">${b.open} open</span>`:""}</td><td class="n">${b.n}</td><td class="n">${hm(b.shift)}</td><td class="n">${hm(b.drive)}</td><td class="n">${hm(b.prod)}</td><td class="n">${hm(b.wait)}</td><td class="n">${hm(b.lunch)}</td><td class="n">${pct(b.prod,b.shift)}</td></tr>`).join("")}<tr><td><b>All drivers</b></td><td class="n"><b>${tot.n}</b></td><td class="n"><b>${hm(tot.shift)}</b></td><td class="n"><b>${hm(tot.drive)}</b></td><td class="n"><b>${hm(tot.prod)}</b></td><td class="n"><b>${hm(tot.wait)}</b></td><td class="n"><b>${hm(tot.lunch)}</b></td><td class="n"><b>${pct(tot.prod,tot.shift)}</b></td></tr></tbody></table>`;
  let ptByShift={},ptByDevice={};PT.pretrips.forEach(p=>{if(p.shift_id)ptByShift[p.shift_id]=p;ptByDevice[p.device_pretrip_id]=p});
  let list=`<div class="ts-h">Shifts</div><table class="ts-table"><thead><tr><th>Date</th><th>Driver</th><th>Vehicle</th><th>Start</th><th>End</th><th>Status</th><th class="n">Shift</th><th class="n">Driving</th><th class="n">Productive</th><th class="n">Waiting</th><th class="n">Lunch</th><th class="n">Prod.</th><th>Pre-trip</th><th></th></tr></thead><tbody>${PT.shifts.map(s=>{
    let pt=ptByShift[s.id]||(s.pretrip_device_id&&ptByDevice[s.pretrip_device_id]);
    let ptCell=pt?`<button class="mini" type="button" onclick="SHIFT_viewPretrip(${pt.id})">${pt.condition==="defects"?"⚠ ":"✓ "}View</button>`:(s.pretrip_device_id?'<span class="muted" title="Pre-trip outside the selected range or still syncing">linked</span>':'<span class="muted">—</span>');
    let open=s.status==="open";
    return `<tr><td>${esc(s.work_date)}</td><td>${esc(driverName(s.driver_id,s.driver_name))}</td><td>${esc(s.vehicle||"")}${s.trailer?`<br><small class="muted">${esc(s.trailer)}</small>`:""}</td><td>${esc(t12(s.shift_start))}</td><td>${esc(t12(s.shift_end))}</td><td><span class="ts-pill ${esc(s.status)}">${esc(s.status)}</span></td><td class="n">${hm(shiftMinutes(s))}${open?"…":""}</td><td class="n">${open?"":hm(s.driving_minutes)}</td><td class="n">${open?"":hm(s.productive_minutes)}</td><td class="n">${open?"":hm(s.waiting_minutes)}</td><td class="n">${open?"":hm(s.lunch_minutes)}</td><td class="n">${s.productivity_pct!=null?esc(s.productivity_pct)+"%":""}</td><td>${ptCell}</td><td><button class="mini" type="button" onclick="SHIFT_tsToggleActs(${s.id})">${PT.acts[s.id]?"Hide":"Activities"}</button></td></tr>${PT.acts[s.id]?actsRow(s.id):""}`}).join("")}</tbody></table>`;
  host.innerHTML=summary+list;
}
function actsRow(id){
  let a=PT.acts[id];
  if(a==="loading")return '<tr class="ts-acts"><td colspan="14" class="muted">Loading activities…</td></tr>';
  if(!a.length)return '<tr class="ts-acts"><td colspan="14" class="muted">No activities synced for this shift yet.</td></tr>';
  return `<tr class="ts-acts"><td colspan="14"><table class="ts-table" style="margin:0"><thead><tr><th>Start</th><th>End</th><th class="n">Min</th><th>Activity</th><th>Location</th><th>Reason / detail</th><th>Notes</th><th>Route</th></tr></thead><tbody>${a.map(x=>`<tr><td>${esc(t12(x.started_at))}</td><td>${esc(t12(x.ended_at))}</td><td class="n">${x.minutes??""}</td><td>${TS_ICON[x.activity_type]||"•"} ${esc(x.activity_type)}</td><td>${esc(x.location||"")}${x.address?`<br><small class="muted">${esc(x.address)}</small>`:""}</td><td>${esc(x.reason||(x.detail&&x.detail.trailerAction)||"")}</td><td>${esc(x.notes||"")}</td><td>${x.dispatch_task_id?"#"+esc(x.dispatch_task_id):""}</td></tr>`).join("")}</tbody></table></td></tr>`;
}
window.SHIFT_tsToggleActs=async function(id){
  if(PT.acts[id]&&PT.acts[id]!=="loading"){delete PT.acts[id];renderTs();return}
  PT.acts[id]="loading";renderTs();
  let r=await db.from("driver_activities").select("*").eq("shift_id",id).order("started_at");
  PT.acts[id]=r.error?[]:(r.data||[]);renderTs();
};
function renderPretrips(){
  if(!PT.pretrips.length)return '<div class="ts-empty">No pre-trip inspections recorded for this date range.</div>';
  return `<div class="ts-note">Pre-trip inspections are stored permanently and cannot be edited or deleted from the apps.</div><table class="ts-table"><thead><tr><th>Date</th><th>Submitted</th><th>Driver</th><th>Vehicle</th><th>Odometer</th><th>Condition</th><th>Needs attention</th><th>Comments</th><th></th></tr></thead><tbody>${PT.pretrips.map(p=>`<tr><td>${esc(p.work_date)}</td><td>${esc(t12(p.submitted_at))}</td><td>${esc(p.driver_name)}</td><td>${esc(p.vehicle)}${p.trailer?`<br><small class="muted">${esc(p.trailer)}</small>`:""}</td><td>${esc(p.odometer)}</td><td><span class="ts-pill ${p.condition==="defects"?"defects":"ok"}">${p.condition==="defects"?"Defects":"Acceptable"}</span></td><td>${esc((p.defects||[]).join(", "))}</td><td>${esc(p.comments||"")}</td><td><button class="mini" type="button" onclick="SHIFT_viewPretrip(${p.id})">View / Print</button></td></tr>`).join("")}</tbody></table>`;
}
window.SHIFT_tsPretripHtml=function(p){
  let groups={};(p.checklist||[]).forEach(x=>{(groups[x.group]=groups[x.group]||[]).push(x)});
  let g=Object.entries(groups).map(([name,items])=>`<div class="grp"><h3>${esc(name)}</h3>${items.map(x=>`<div class="row"><span>${esc(x.item)}</span><span class="${x.result==="ok"?"ok":""}">${x.result==="ok"?"✓ OK":""}</span><span class="${x.result==="attention"?"bad":""}">${x.result==="attention"?"⚠ Needs Attention":""}</span></div>`).join("")}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pre-Trip Inspection — ${esc(p.driver_name)} — ${esc(p.work_date)}</title><style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:28px;font-size:13px}h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;font-weight:normal;color:#555;margin:0 0 16px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;border:1px solid #bbb;padding:12px;margin-bottom:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .grp h3{font-size:13px;margin:0 0 6px;border-bottom:1px solid #999;padding-bottom:3px}.row{display:grid;grid-template-columns:1fr 60px 130px;gap:6px;padding:3px 0;border-bottom:1px dotted #ccc}
  .ok{color:#0a6b2d;font-weight:bold}.bad{color:#b00020;font-weight:bold}.box{border:1px solid #bbb;padding:10px;margin-top:16px}.sig{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:30px}
  .sig .line{border-top:1px solid #333;padding-top:4px;color:#555;font-size:11px}.foot{margin-top:22px;color:#666;font-size:10.5px}.noprint{margin-bottom:16px}@media print{.noprint{display:none}body{margin:12mm}}
  </style></head><body><div class="noprint"><button onclick="print()">Print / Save PDF</button></div>
  <h1>Driver Pre-Trip Inspection</h1><h2>Vehicle Safety Inspection Record · Darwill</h2>
  <div class="meta"><div><b>Driver:</b> ${esc(p.driver_name)}</div><div><b>Vehicle:</b> ${esc(p.vehicle)}${p.trailer?" · "+esc(p.trailer):""}</div><div><b>Date:</b> ${esc(p.work_date)}</div><div><b>Inspection completed:</b> ${esc(new Date(p.submitted_at).toLocaleString())}</div><div><b>Odometer:</b> ${esc(p.odometer)}</div><div><b>Vehicle condition:</b> ${p.condition==="defects"?'<span class="bad">Defects noted – needs attention</span>':'<span class="ok">Acceptable</span>'}</div></div>
  <div class="grid">${g||"<p>No checklist data.</p>"}</div>
  <div class="box"><b>Needs attention:</b> ${esc((p.defects||[]).join(", ")||"None")}<br><br><b>Comments:</b><br>${esc(p.comments||"No comments.")}</div>
  <div class="sig"><div><div>${esc(p.signature_name)}</div><div class="line">Driver acknowledgment (typed name)</div></div><div><div>${esc(new Date(p.submitted_at).toLocaleDateString())}</div><div class="line">Date</div></div></div>
  <div class="foot">Record #${esc(p.id)} · received by office ${esc(new Date(p.created_at).toLocaleString())} · device id ${esc(p.device_pretrip_id)}${p.shift_id?" · shift #"+esc(p.shift_id):""}${p.app_version?" · app "+esc(p.app_version):""}. Read-only copy from SHIFT Dispatch.</div>
  </body></html>`;
};
window.SHIFT_viewPretrip=async function(id){
  let p=PT.pretrips.find(x=>Number(x.id)===Number(id));
  if(!p){let r=await db.from("driver_pretrips").select("*").eq("id",id).limit(1);p=r.data&&r.data[0];if(!p)return alert("Pre-trip not found.")}
  let w=window.open("","_blank");if(!w)return alert("Allow pop-ups to view and print the pre-trip.");
  w.document.open();w.document.write(SHIFT_tsPretripHtml(p));w.document.close();
};

/* ---------- CSV ---------- */
function csvDownload(name,rows){
  if(!rows.length)return alert("Nothing to export for this date range.");
  let h=Object.keys(rows[0]),q=v=>`"${String(v??"").replaceAll('"','""')}"`;
  let blob=new Blob(["\ufeff"+[h.map(q).join(","),...rows.map(r=>h.map(k=>q(r[k])).join(","))].join("\r\n")],{type:"text/csv"});
  let a=document.createElement("a"),u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
window.SHIFT_tsCsv=async function(kind){
  let from=$("tsFrom").value,to=$("tsTo").value,tag=`${from}_to_${to}`;
  if(kind==="shifts")return csvDownload(`shifts_${tag}.csv`,PT.shifts.map(s=>({Date:s.work_date,Driver:driverName(s.driver_id,s.driver_name),DriverID:s.driver_id,Vehicle:s.vehicle||"",Trailer:s.trailer||"",Status:s.status,ShiftStart:dt(s.shift_start),ShiftEnd:dt(s.shift_end),ShiftMinutes:Math.round(shiftMinutes(s)),DrivingMinutes:s.driving_minutes??"",ProductiveMinutes:s.productive_minutes??"",WaitingMinutes:s.waiting_minutes??"",LunchMinutes:s.lunch_minutes??"",NonproductiveMinutes:s.nonproductive_minutes??"",ProductivityPct:s.productivity_pct??"",Activities:s.activity_count??"",ShiftID:s.id,DeviceShiftID:s.device_shift_id})));
  if(kind==="pretrips"){
    let items=[];PT.pretrips.forEach(p=>(p.checklist||[]).forEach(x=>{let k=`${x.group}: ${x.item}`;if(!items.includes(k))items.push(k)}));
    return csvDownload(`pretrips_${tag}.csv`,PT.pretrips.map(p=>{let r={Date:p.work_date,Submitted:dt(p.submitted_at),ReceivedByOffice:dt(p.created_at),Driver:p.driver_name,DriverID:p.driver_id??"",Vehicle:p.vehicle,Trailer:p.trailer||"",Odometer:p.odometer,Condition:p.condition,NeedsAttention:(p.defects||[]).join("; "),Comments:p.comments||"",Signature:p.signature_name,ShiftID:p.shift_id??"",RecordID:p.id,DevicePretripID:p.device_pretrip_id};let m={};(p.checklist||[]).forEach(x=>m[`${x.group}: ${x.item}`]=x.result==="ok"?"OK":x.result==="attention"?"Needs Attention":"");items.forEach(k=>r[k]=m[k]||"");return r}));
  }
  if(kind==="activities"){
    let ids=PT.shifts.map(s=>s.id),all=[];
    for(let i=0;i<ids.length;i+=100){let r=await db.from("driver_activities").select("*").in("shift_id",ids.slice(i,i+100)).order("started_at");if(r.error)return alert("Could not load activities: "+r.error.message);all=all.concat(r.data||[])}
    let sh={};PT.shifts.forEach(s=>sh[s.id]=s);
    return csvDownload(`activities_${tag}.csv`,all.map(x=>({Date:sh[x.shift_id]?.work_date||ymd(x.started_at),Driver:driverName(x.driver_id,sh[x.shift_id]?.driver_name),ShiftID:x.shift_id,Activity:x.activity_type,Start:dt(x.started_at),End:dt(x.ended_at),Minutes:x.minutes??"",Location:x.location||"",Address:x.address||"",Reason:x.reason||"",Detail:x.detail?JSON.stringify(x.detail):"",Notes:x.notes||"",DispatchTaskID:x.dispatch_task_id??""})));
  }
};
})();
