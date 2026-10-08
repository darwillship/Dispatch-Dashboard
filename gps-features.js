/* SHIFT Dispatch v3.7.0 — Verizon Connect Reveal GPS stop times on tasks (written by the Darwill GPS bot).
   v3.9.0: tooltip/CSV also show the vzc-sync detail columns (engine off/on, idle, back at base, match method).
   - Task cards: "📍 Left 9:12 AM · Arrived 10:03 AM · 51 min drive · 21 min on site · Big Gray" (Central time).
   - Edit Task: the same line, read-only (not part of the form; never sent on save).
   - Route History: GPS line per completed route + "Export tasks CSV" (date range, all statuses, GPS columns).
   - Time Sheets → Activities CSV gets the linked task's GPS columns (see timesheet-features.js).
   READ-ONLY: this file performs no writes. Dashboard writes to dispatch_tasks are partial updates of the
   fields they change, so gps_* columns are never overwritten by the dashboard. */
(function(){
const TZ="America/Chicago";
const css=`
.route-gps{margin-top:6px;font-size:11.5px;font-weight:800;color:#9fe0b8;background:#0f2a1f;border:1px solid #1f4d37;border-radius:7px;padding:3px 7px;line-height:1.35}
.route-gps .gps-veh{color:#cfe3f6}
.gps-info{margin:0 0 12px;padding:9px 11px;border:1px solid #1f4d37;background:#0f2a1f;border-radius:10px;font-size:12.5px;color:#cfe9da}
.gps-info b{color:#9fe0b8}.gps-info .gps-sub{display:block;margin-top:4px;font-size:11px;color:#8fb3a1;font-weight:600}
.gps-info.none{border-style:dashed;border-color:#2b3d4f;background:transparent;color:#7e94a7}
.history-gps{grid-column:1/-1;font-size:11.5px;font-weight:700;color:#9fe0b8;margin-top:2px}
.task-export{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px;padding:9px 10px;border:1px solid #24405b;border-radius:10px;font-size:12px;font-weight:800;color:#9fb3c6}
.task-export input[type=date]{width:auto;padding:6px 8px;font-size:12px}
body.light-mode .route-gps,body.light-mode .gps-info{background:#ecf8f1!important;border-color:#a9d9bd!important;color:#14532d!important}
body.light-mode .route-gps .gps-veh{color:#1d3a55!important}body.light-mode .gps-info b,body.light-mode .history-gps{color:#166534!important}
body.light-mode .gps-info .gps-sub{color:#3f6b52!important}body.light-mode .task-export{border-color:#c9d8e6!important;color:#3a5164!important}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

const timeF=new Intl.DateTimeFormat("en-US",{timeZone:TZ,hour:"numeric",minute:"2-digit"});
const dayF=new Intl.DateTimeFormat("en-US",{timeZone:TZ,month:"short",day:"numeric"});
const ymdF=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
const hmF=new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
function ctYmd(v){return ymdF.format(new Date(v))}
function taskDate(t){return t.work_date?String(t.work_date).slice(0,10):t.scheduled_at?ctYmd(t.scheduled_at):null}
/* 9:12 AM — prefixed with the date when it is not the task's day (e.g. overnight or late updates) */
function ctTime(v,t){if(!v)return "";let d=new Date(v);if(isNaN(d))return "";let s=timeF.format(d);let td=t&&taskDate(t);return td&&ctYmd(d)!==td?dayF.format(d)+" "+s:s}
/* CSV stamp in Central time: 2026-10-07 09:12 */
function ctStamp(v){if(!v)return "";let d=new Date(v);if(isNaN(d))return "";return ymdF.format(d)+" "+hmF.format(d)}
function vehName(id){if(id==null)return "";let v=(window.SHIFT_vehicles||[]).find(x=>Number(x.id)===Number(id));return v?v.name:"Vehicle #"+id}
function hasGps(t){return !!(t&&(t.gps_departed_at||t.gps_arrived_at||t.gps_left_destination_at))}
function parts(t){
  let p=[];
  if(t.gps_departed_at)p.push("Left "+ctTime(t.gps_departed_at,t));
  if(t.gps_arrived_at)p.push("Arrived "+ctTime(t.gps_arrived_at,t));
  if(t.gps_drive_minutes!=null)p.push(t.gps_drive_minutes+" min drive");
  if(t.gps_dwell_minutes!=null)p.push(t.gps_dwell_minutes+" min on site"+(t.gps_idle_minutes?` (${t.gps_idle_minutes} idle)`:""));
  else if(t.gps_left_destination_at)p.push("Left site "+ctTime(t.gps_left_destination_at,t));
  return p;
}
function tip(t){
  let r=["Verizon Reveal GPS (Central time)"];
  if(t.gps_departed_at)r.push("Left origin: "+ctStamp(t.gps_departed_at));
  if(t.gps_arrived_at)r.push("Arrived: "+ctStamp(t.gps_arrived_at));
  if(t.gps_left_destination_at)r.push("Left destination: "+ctStamp(t.gps_left_destination_at));
  /* v3.9.0 detail from the vzc-sync updater */
  if(t.gps_origin_engine_on_at)r.push("Engine on at origin: "+ctStamp(t.gps_origin_engine_on_at));
  if(t.gps_engine_off_at)r.push("Engine off at destination: "+ctStamp(t.gps_engine_off_at));
  if(t.gps_engine_on_at)r.push("Engine on (leaving): "+ctStamp(t.gps_engine_on_at));
  if(t.gps_engine_off_minutes!=null||t.gps_idle_minutes!=null)r.push(`On site: ${t.gps_engine_off_minutes??"?"} min engine off, ${t.gps_idle_minutes??"?"} min idling`);
  if(t.gps_returned_base_at)r.push("Back at McCook: "+ctStamp(t.gps_returned_base_at));
  if(t.gps_match_method)r.push("Matched by: "+t.gps_match_method.replace(":"," / ").replace(/_/g," ")+(t.gps_match_distance_m!=null?` (${t.gps_match_distance_m} m)`:""));
  if(t.gps_vehicle_id!=null)r.push("Truck: "+vehName(t.gps_vehicle_id));
  if(t.gps_source)r.push("Source: "+t.gps_source);
  if(t.gps_updated_at)r.push("Updated: "+ctStamp(t.gps_updated_at));
  return r.join("\n");
}
window.SHIFT_gpsText=function(t){if(!hasGps(t))return "";let p=parts(t);if(t.gps_vehicle_id!=null)p.push(vehName(t.gps_vehicle_id));return "📍 "+p.join(" · ")};
window.SHIFT_gpsLine=function(t,cls){
  if(!hasGps(t))return "";
  let p=parts(t).map(esc);if(t.gps_vehicle_id!=null)p.push(`<span class="gps-veh">${esc(vehName(t.gps_vehicle_id))}</span>`);
  return `<div class="${cls||"route-gps"}" title="${esc(tip(t))}">📍 ${p.join(" · ")}</div>`;
};
/* shared helpers (v3.8.0: used by routes-features.js) */
window.SHIFT_ctStamp=ctStamp;window.SHIFT_ctClock=v=>v?timeF.format(new Date(v)):"";window.SHIFT_ctYmd=ctYmd;
/* CSV columns (also used by the Time Sheets activities export) */
window.SHIFT_gpsCsvFields=function(t){
  t=t||{};
  return {"GPS Left Origin (CT)":ctStamp(t.gps_departed_at),"GPS Arrived (CT)":ctStamp(t.gps_arrived_at),"GPS Left Destination (CT)":ctStamp(t.gps_left_destination_at),
    "GPS Drive Minutes":t.gps_drive_minutes??"","GPS On-Site Minutes":t.gps_dwell_minutes??"","GPS Truck":t.gps_vehicle_id!=null?vehName(t.gps_vehicle_id):"","GPS Vehicle ID":t.gps_vehicle_id??"",
    "GPS Source":t.gps_source||"","GPS Updated (CT)":ctStamp(t.gps_updated_at)};
};

/* v3.9.0: extra vzc-sync columns, appended at the END of the tasks CSV so existing column positions don't move */
window.SHIFT_gpsDetailCsvFields=function(t){
  t=t||{};
  return {"GPS Engine On at Origin (CT)":ctStamp(t.gps_origin_engine_on_at),"GPS Engine Off (CT)":ctStamp(t.gps_engine_off_at),"GPS Engine On (CT)":ctStamp(t.gps_engine_on_at),
    "GPS Engine-Off Minutes":t.gps_engine_off_minutes??"","GPS Idle Minutes":t.gps_idle_minutes??"","GPS Back at Base (CT)":ctStamp(t.gps_returned_base_at),
    "GPS Match Method":t.gps_match_method||"","GPS Match Distance (m)":t.gps_match_distance_m??""};
};

/* task cards */
const origCard=window.taskCard;
window.taskCard=function(t){
  let html=origCard.apply(this,arguments),g=t&&t.is_route?"":SHIFT_gpsLine(t);  /* routes show per-stop timings (routes-features.js) */
  if(!g)return html;
  let i=html.indexOf('<div class="route-flags">');
  return i<0?html.replace(/<\/article>\s*$/,g+"</article>"):html.slice(0,i)+g+html.slice(i);
};

/* Edit Task: read-only GPS block (a plain div, not a form field) */
function gpsBox(){let b=$("gpsInfo");if(!b){b=document.createElement("div");b.id="gpsInfo";b.className="gps-info hidden";let f=$("form");f.insertBefore(b,f.firstChild)}return b}
const origOpen=window.openTask;
window.openTask=function(){let r=origOpen.apply(this,arguments);let b=gpsBox();b.classList.add("hidden");b.innerHTML="";return r};
const origEdit=window.editTask;
window.editTask=function(id){
  let r=origEdit.apply(this,arguments);
  let t=(tasks||[]).find(x=>x.id===id)||(allTasks||[]).find(x=>x.id===id);
  if(t&&$("id").value==String(id)){
    let b=gpsBox();b.classList.remove("hidden");
    if(hasGps(t)){b.classList.remove("none");b.innerHTML=`<b>${esc(SHIFT_gpsText(t))}</b><span class="gps-sub">${esc(tip(t)).replace(/\n/g," · ")} — set by the GPS bot, read-only here</span>`}
    else{b.classList.add("none");b.textContent="📍 No GPS times yet (filled in automatically by the Verizon GPS bot)."}
  }
  return r;
};

/* Route History: GPS line per row + Export tasks CSV */
function histWhen(t){return t.completed_at||t.scheduled_at||t.created_at}
window.openHistory=function(){
  let done=allTasks.filter(t=>t.status==="completed").sort((a,b)=>new Date(histWhen(b))-new Date(histWhen(a)));
  $("historyList").innerHTML=done.length?done.map(t=>{let d=drivers.find(x=>Number(x.id)===Number(t.assigned_driver_id));return `<div class="history-row"><div class="history-date">${fmt(histWhen(t))}</div><div class="history-route">${esc(t.pickup_name)} → ${esc(t.delivery_name)}</div><div class="history-driver">${esc(d?.name||"Unassigned")}</div><div class="history-status">Completed</div>${SHIFT_gpsLine(t,"history-gps")}</div>`}).join(""):'<div class="empty">No completed routes yet.</div>';
  let bar=$("taskExportBar");
  if(!bar){
    bar=document.createElement("div");bar.id="taskExportBar";bar.className="task-export";
    let to=ctYmd(new Date()),from=new Date();from.setDate(from.getDate()-30);
    bar.innerHTML=`Tasks from <input type="date" id="taskExpFrom" value="${ctYmd(from)}"> to <input type="date" id="taskExpTo" value="${to}"> <button class="btn" type="button" onclick="SHIFT_exportTasksCsv()">Export tasks CSV</button><span class="muted" style="font-weight:600">all statuses · includes GPS times (CT)</span>`;
    $("historyList").parentNode.insertBefore(bar,$("historyList"));
  }
  $("historyModal").classList.add("show");
};
function csvDownload(name,rows){
  if(!rows.length)return alert("No tasks in this date range.");
  return SHIFT_csvDownload(name,rows);
}
window.SHIFT_csvDownload=function(name,rows){
  let h=Object.keys(rows[0]),q=v=>`"${String(v??"").replaceAll('"','""')}"`;
  let blob=new Blob(["\ufeff"+[h.map(q).join(","),...rows.map(r=>h.map(k=>q(r[k])).join(","))].join("\r\n")],{type:"text/csv"});
  let a=document.createElement("a"),u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
window.SHIFT_taskCsvRows=function(from,to){
  return (allTasks||[]).filter(t=>{let d=taskDate(t)||ctYmd(t.created_at);return (!from||d>=from)&&(!to||d<=to)})
    .sort((a,b)=>String(taskDate(a)).localeCompare(String(taskDate(b)))||Number(a.assigned_driver_id||0)-Number(b.assigned_driver_id||0)||Number(a.sort_order||0)-Number(b.sort_order||0))
    .map(t=>{let d=(drivers||[]).find(x=>Number(x.id)===Number(t.assigned_driver_id));
      return Object.assign({"Task ID":t.id,"Work Date":taskDate(t)||"",Type:t.task_type||"",Status:t.status||"",Stage:t.planning_stage||"",Priority:t.priority||"",Driver:d?d.name:"",
        Pickup:t.pickup_name||"","Pickup Address":t.pickup_address||"",Delivery:t.delivery_name||"","Delivery Address":t.delivery_address||"","Job / Client":t.job_client||"",Material:t.material||"",Pallets:t.pallet_qty??"",
        "Scheduled (CT)":ctStamp(t.scheduled_at),"Completed (CT)":ctStamp(t.completed_at)},SHIFT_gpsCsvFields(t),{Instructions:t.instructions||""},SHIFT_gpsDetailCsvFields(t))});
};
window.SHIFT_exportTasksCsv=function(){
  let from=$("taskExpFrom").value,to=$("taskExpTo").value;
  if(from&&to&&from>to)return alert("The start date is after the end date.");
  csvDownload(`tasks_${from||"start"}_to_${to||"end"}.csv`,SHIFT_taskCsvRows(from,to));
};

// first paint may have happened before this file loaded
try{render()}catch(_){}
})();
