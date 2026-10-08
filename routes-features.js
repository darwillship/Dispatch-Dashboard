/* SHIFT Dispatch v3.8.0 — MULTI-STOP ROUTES (see SUPABASE-ROUTES.sql).
   Model: a task is the route. Its Pickup is the START (origin); dispatch_task_stops are the stops after leaving
   it, in seq order. For route tasks the last stop is mirrored into delivery_name/address. Tasks without stops
   behave exactly as before.
   - Task create/edit: "+ Add stop", stops list (location, type, material, pallets, notes), drag ⋮⋮ or ↑/↓ to
     reorder (re-sequences seq), ✕ to remove.
   - "Combine into route": select 2+ tasks in route order → ONE new task whose stops are copied from each
     original's pickup/delivery. Originals get combined_into_task_id = new id, are hidden from the board
     ("Show combined" toggle) and are never deleted.
   - Cards: stops in order with GPS leg timings, tappable per-stop status chip (pending → arrived → done).
     When every stop is done the database trigger completes the route.
   - Route History "Export tasks CSV": one row per stop for route tasks (normal tasks unchanged).
   Writes are partial: dispatch_task_stops rows (never gps_* / generated columns) and the edited/combined
   dispatch_tasks fields only. */
(function(){
const css=`
.route-type.route{background:#2a1f4d;color:#cbb8ff;border-color:#4b3a85}
.route-stops{margin:6px 0 4px;display:flex;flex-direction:column;gap:3px;font-size:12px}
.rs-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;line-height:1.3}
.rs-origin{color:#9fb3c6;font-weight:800}
.rs-name{font-weight:800;color:#e6eef6}
.rs-time{color:#9fe0b8;font-weight:800;font-size:11.5px}
.rs-leg{flex-basis:100%;padding-left:24px;color:#8fb3a1;font-size:11px;font-weight:700}
.rs-chip{border:1px solid #2b3d4f;background:#132233;color:#9fb3c6;border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:900;cursor:pointer;min-width:62px;text-align:center}
.rs-chip.arrived{background:#3a2f0b;border-color:#7a6216;color:#ffd666}
.rs-chip.done{background:#0f2a1f;border-color:#1f4d37;color:#7ee2a8}
.rs-chip:disabled{cursor:default;opacity:.85}
.task.route-combined{opacity:.55;border-style:dashed!important}
.combined-tag{font-size:10.5px;font-weight:900;color:#cbb8ff;background:#2a1f4d;border-radius:6px;padding:2px 6px}
body.combine-mode article.task{cursor:copy}
body.combine-mode article.task.combine-pick{outline:3px solid #8b6cff;outline-offset:-2px}
.combine-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:999px;background:#8b6cff;color:#fff;font-weight:900;font-size:11px;margin-left:auto;margin-right:6px}
#combineBar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;display:none;gap:10px;align-items:center;background:#16213a;border:1px solid #4b3a85;border-radius:14px;padding:10px 14px;box-shadow:0 10px 30px #0008;font-size:13px;font-weight:800;color:#e6eef6;max-width:96vw;flex-wrap:wrap}
body.combine-mode #combineBar{display:flex}
#combineBar .cb-msg{color:#ffb4b4;font-size:12px}
.route-editor{border:1px solid #2b3d4f;border-radius:12px;padding:10px;margin-top:2px}
.route-editor .re-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:6px}
.route-editor .re-head label{margin:0}
.re-stop{display:grid;grid-template-columns:22px 22px minmax(0,2.3fr) minmax(0,1.15fr) minmax(0,1fr) minmax(0,.7fr) minmax(0,1fr) auto;gap:6px;align-items:center;padding:6px;border:1px solid #22344a;border-radius:10px;margin-bottom:6px;background:#0f1a28}
.re-stop.dragging{opacity:.45}
.re-stop.drop-before{box-shadow:0 -3px 0 #8b6cff}.re-stop.drop-after{box-shadow:0 3px 0 #8b6cff}
.re-grip{cursor:grab;color:#7e94a7;font-weight:900;text-align:center;user-select:none}
.re-num{font-weight:900;color:#cbb8ff;text-align:center}
.re-stop>*{min-width:0}
.re-stop input,.re-stop select{padding:6px 7px;font-size:12px;min-width:0;width:100%;box-sizing:border-box}
.re-custom{grid-column:3/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:6px}
.re-custom.hidden{display:none!important}
.re-btns{display:flex;gap:3px;align-items:center}
.re-btns button{padding:4px 7px;font-size:12px}
.re-meta{grid-column:3/-1;font-size:11px;color:#8fb3a1;font-weight:700}
.re-empty{font-size:12px;color:#7e94a7;padding:4px 2px 8px}
.combine-dialog{width:min(820px,100%)}
.cmb-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:10px 0}
.cmb-list .cmb-item{display:flex;gap:8px;align-items:center;padding:7px 9px;border:1px solid #22344a;border-radius:10px;margin-bottom:6px;font-size:12.5px}
.cmb-item .cmb-n{font-weight:900;color:#cbb8ff;min-width:18px}
.cmb-item .cmb-t{flex:1}
.cmb-preview{border:1px solid #22344a;border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.55;margin-top:6px}
.cmb-preview .cmb-type{font-size:10.5px;font-weight:900;color:#9fb3c6;text-transform:uppercase;margin-left:4px}
@media(max-width:700px){.re-stop{grid-template-columns:22px 22px 1fr 1fr}.re-stop .re-notes,.re-stop .re-mat{grid-column:3/-1}.cmb-grid{grid-template-columns:1fr}}
body.light-mode .rs-name{color:#0d1824!important}body.light-mode .rs-origin{color:#3a5164!important}
body.light-mode .rs-time,body.light-mode .rs-leg{color:#166534!important}
body.light-mode .rs-chip{background:#eef4fa!important;border-color:#c9d8e6!important;color:#3a5164!important}
body.light-mode .rs-chip.arrived{background:#fff6d6!important;border-color:#e3c35a!important;color:#7a5a00!important}
body.light-mode .rs-chip.done{background:#ecf8f1!important;border-color:#a9d9bd!important;color:#166534!important}
body.light-mode .re-stop{background:#f6f9fc!important;border-color:#d5e1ec!important}
body.light-mode #combineBar{background:#ffffff!important;color:#0d1824!important;border-color:#b9a8f0!important}
body.light-mode .route-type.route,body.light-mode .combined-tag{background:#efe9ff!important;color:#4b2fb3!important;border-color:#cbbcf5!important}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

let STOPS={};                       // task_id -> ordered stop rows from dispatch_route_stops_v (board date)
let showCombined=sessionStorage.getItem("shift-show-combined")==="1";
let combineMode=false,picked=[];
window.SHIFT_routeStops=id=>STOPS[id]||[];
const isRoute=t=>!!(t&&(t.is_route||(STOPS[t.id]||[]).length));
const clock=v=>typeof SHIFT_ctClock==="function"?SHIFT_ctClock(v):(v?new Date(v).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"");
const stamp=v=>typeof SHIFT_ctStamp==="function"?SHIFT_ctStamp(v):(v||"");
function range(a,b){
  if(a&&b){let x=clock(a),y=clock(b),sx=x.slice(-2),sy=y.slice(-2);return sx===sy?x.slice(0,-3)+"–"+y:x+"–"+y}
  if(a)return "arr "+clock(a);
  if(b)return "left "+clock(b);
  return "";
}
function legText(s){let p=[];if(s.leg_drive_minutes!=null)p.push(s.leg_drive_minutes+" min drive");if(s.gps_dwell_minutes!=null)p.push(s.gps_dwell_minutes+" min on site");return p.join(", ")}
/* one-line summary, e.g. "Darwill McCook 1:58 PM → Federal Envelope 2:49–3:00 PM (51 min drive, 11 min on site) → …" */
window.SHIFT_routeSummary=function(t){
  let st=STOPS[t.id]||[];
  let parts=[(t.pickup_name||"Start")+(t.gps_departed_at?" "+clock(t.gps_departed_at):"")];
  st.forEach(s=>{let r=range(s.gps_arrived_at,s.gps_departed_at),l=legText(s);parts.push(s.location_name+(r?" "+r:"")+(l?" ("+l+")":""))});
  return parts.join(" → ");
};

async function fetchStops(){
  try{
    let r=await db.from("dispatch_route_stops_v").select("*").eq("work_date",boardDate).order("task_id").order("seq").order("stop_id");
    if(r.error){console.warn("route stops unavailable",r.error);return}
    let m={};(r.data||[]).forEach(s=>(m[s.task_id]=m[s.task_id]||[]).push(s));STOPS=m;
  }catch(e){console.warn("route stops unavailable",e)}
}
async function fetchStopsFor(ids){
  let out={};ids=[...new Set(ids)].filter(Boolean);
  for(let i=0;i<ids.length;i+=100){
    let r=await db.from("dispatch_route_stops_v").select("*").in("task_id",ids.slice(i,i+100)).order("task_id").order("seq").order("stop_id");
    if(r.error)throw r.error;(r.data||[]).forEach(s=>(out[s.task_id]=out[s.task_id]||[]).push(s));
  }
  return out;
}
const origLoad=window.load;
window.load=async function(...a){await fetchStops();return origLoad.apply(this,a)};

/* combined originals: hidden from the active board + metrics unless "Show combined" is on */
const origRender=window.render;
window.render=function(){
  let n=(tasks||[]).filter(t=>t.combined_into_task_id).length;
  if(!showCombined)tasks=tasks.filter(t=>!t.combined_into_task_id);
  let b=$("combinedToggle");if(b){b.style.display=n||showCombined?"":"none";b.textContent=(showCombined?"Hide combined":"Show combined")+(n?` (${n})`:"")}
  return origRender.apply(this,arguments);
};
const origMetrics=window.updateMetrics;
window.updateMetrics=function(){let keep=allTasks;try{allTasks=allTasks.filter(t=>!t.combined_into_task_id);return origMetrics.apply(this,arguments)}finally{allTasks=keep}};
window.SHIFT_toggleCombined=function(){showCombined=!showCombined;sessionStorage.setItem("shift-show-combined",showCombined?"1":"0");load()};
window.SHIFT_uncombine=async function(id){
  if(!confirm("Put this task back on the board as its own task? (The route keeps its stops.)"))return;
  let r=await db.from("dispatch_tasks").update({combined_into_task_id:null}).eq("id",id);
  if(r.error)return alert("Could not restore task: "+r.error.message);
  await load();
};

/* ---------- cards ---------- */
const CHIP={pending:"○ Pending",arrived:"◐ Arrived",done:"✓ Done"};
function stopsHtml(t){
  let st=STOPS[t.id]||[];
  if(!st.length)return `<div class="route-stops"><div class="rs-row rs-origin">🏁 ${esc(t.pickup_name||"Start")}</div><div class="rs-row muted">Loading stops…</div></div>`;
  let rows=[`<div class="rs-row rs-origin"><span>🏁</span><span class="rs-name">${esc(t.pickup_name||"Start")}</span>${t.gps_departed_at?`<span class="rs-time">left ${esc(clock(t.gps_departed_at))}</span>`:""}</div>`];
  st.forEach(s=>{
    let r=range(s.gps_arrived_at,s.gps_departed_at),l=legText(s),k=CHIP[s.status]?s.status:"pending";
    rows.push(`<div class="rs-row"><button type="button" class="rs-chip ${k}" data-stop="${s.stop_id}" title="Tap to advance: pending → arrived → done" onclick="event.stopPropagation();SHIFT_advanceStop(${s.stop_id})">${CHIP[k]}</button><span class="rs-name">${esc(s.location_name||"Stop")}</span>${r?`<span class="rs-time">${esc(r)}</span>`:""}${l?`<div class="rs-leg">(${esc(l)})</div>`:""}</div>`);
  });
  return `<div class="route-stops" title="${esc(SHIFT_routeSummary(t))}">${rows.join("")}</div>`;
}
const origCard=window.taskCard;
window.taskCard=function(t){
  let html=origCard.apply(this,arguments);
  let cls=[];
  if(isRoute(t)){
    let n=(STOPS[t.id]||[]).length;
    html=html.replace(/<span class="route-type [^"]*">[^<]*<\/span>/,`<span class="route-type route">🔁 ROUTE${n?" · "+n+" stop"+(n===1?"":"s"):""}</span>`)
             .replace(/<div class="route">[\s\S]*?<\/div>/,`<div class="route">${esc(t.pickup_name||"Start")} → ${esc(t.delivery_name||"…")}</div>${stopsHtml(t)}`);
  }
  if(t.combined_into_task_id){
    cls.push("route-combined");
    html=html.replace('<div class="route-flags">',`<div class="route-flags"><span class="combined-tag">⛓ In route #${t.combined_into_task_id}</span><button class="mini" onclick="event.stopPropagation();SHIFT_uncombine(${t.id})">↩ Restore</button>`);
  }
  let pi=picked.indexOf(t.id);
  if(combineMode&&pi>=0){cls.push("combine-pick");html=html.replace('<span class="grip">',`<span class="combine-badge">${pi+1}</span><span class="grip">`)}
  if(cls.length)html=html.replace('class="task route-card-clean"',`class="task route-card-clean ${cls.join(" ")}"`);
  return html;
};
window.SHIFT_advanceStop=async function(stopId){
  let s=Object.values(STOPS).flat().find(x=>Number(x.stop_id)===Number(stopId));if(!s)return;
  let next=s.status==="pending"?"arrived":s.status==="arrived"?"done":"pending";
  if(next==="pending"&&!confirm(`Set "${s.location_name}" back to pending?`))return;
  document.querySelectorAll(`.rs-chip[data-stop="${stopId}"]`).forEach(b=>b.disabled=true);
  let r=await db.from("dispatch_task_stops").update({status:next}).eq("id",stopId);
  if(r.error){alert("Could not update stop: "+r.error.message)}
  await load();
};

/* ---------- task editor: stops ---------- */
function editorEl(){
  let ed=$("routeEditor");if(ed)return ed;
  ed=document.createElement("div");ed.id="routeEditor";ed.className="full route-editor";
  ed.innerHTML=`<div class="re-head"><label>Route stops</label><span class="muted" style="font-size:11px" id="routeHint">Optional. Add stops to make this a multi-stop route; Pickup is the start.</span></div><div id="routeStops"></div><button type="button" class="btn ghost" id="addStopBtn" onclick="SHIFT_addStop()">+ Add stop</button>`;
  let deliveryBox=$("delivery").closest(".grid > div");
  deliveryBox.parentNode.insertBefore(ed,deliveryBox.nextSibling);
  let list=ed.querySelector("#routeStops");
  list.addEventListener("dragover",e=>{let drag=list.querySelector(".re-stop.dragging");if(!drag)return;e.preventDefault();e.stopPropagation();let row=e.target.closest(".re-stop");list.querySelectorAll(".drop-before,.drop-after").forEach(x=>x.classList.remove("drop-before","drop-after"));if(!row||row===drag)return;let r=row.getBoundingClientRect();row.classList.add(e.clientY<r.top+r.height/2?"drop-before":"drop-after")});
  list.addEventListener("drop",e=>{let drag=list.querySelector(".re-stop.dragging");if(!drag)return;e.preventDefault();e.stopPropagation();let row=list.querySelector(".drop-before,.drop-after");if(row){row.classList.contains("drop-before")?row.before(drag):row.after(drag)}list.querySelectorAll(".drop-before,.drop-after").forEach(x=>x.classList.remove("drop-before","drop-after"));renumber()});
  return ed;
}
function locValue(name,address,locationId){
  if(locationId){let s=savedLocations.find(x=>Number(x.id)===Number(locationId));if(s)return "saved:"+s.id}
  let i=LOC.findIndex(x=>x[0]===name&&x[1]===address);if(i>=0)return "builtin:"+i;
  let s=savedLocations.find(x=>x.name===name&&x.address===address);if(s)return "saved:"+s.id;
  return name||address?"custom":"";
}
function stopRow(s){
  s=s||{};
  let el=document.createElement("div");el.className="re-stop";
  if(s.stop_id||s.id)el.dataset.stopId=s.stop_id||s.id;
  el.dataset.status=s.status||"pending";
  let gps=[];if(s.gps_arrived_at||s.gps_departed_at)gps.push("GPS "+range(s.gps_arrived_at,s.gps_departed_at));let l=legText(s);if(l)gps.push(l);
  el.innerHTML=`<span class="re-grip" draggable="true" title="Drag to reorder">⋮⋮</span><span class="re-num"></span>
  <select class="re-loc" title="Stop location">${options()}</select>
  <select class="re-type" title="Stop type"><option value="delivery">Delivery</option><option value="pickup">Pickup</option><option value="both">Pickup + Delivery</option></select>
  <input class="re-mat" placeholder="Material"><input class="re-pal" type="number" min="0" placeholder="Pallets">
  <input class="re-notes" placeholder="Notes">
  <span class="re-btns"><span class="rs-chip ${CHIP[s.status]?s.status:"pending"}" title="Stop status (tap the chip on the card to change)">${CHIP[s.status]||CHIP.pending}</span><button type="button" class="mini re-up" title="Move up">↑</button><button type="button" class="mini re-down" title="Move down">↓</button><button type="button" class="mini danger re-del" title="Remove stop">✕</button></span>
  <div class="re-custom hidden"><input class="re-name" placeholder="Location name"><input class="re-addr" placeholder="Full address"></div>
  ${gps.length?`<div class="re-meta">📍 ${esc(gps.join(" · "))} (GPS bot, read-only)</div>`:""}`;
  let sel=el.querySelector(".re-loc");sel.value=locValue(s.location_name,s.location_address,s.location_id);
  if(sel.value==="custom"){el.querySelector(".re-custom").classList.remove("hidden");el.querySelector(".re-name").value=s.location_name||"";el.querySelector(".re-addr").value=s.location_address||""}
  el.querySelector(".re-type").value=s.stop_type||"delivery";
  el.querySelector(".re-mat").value=s.material||"";el.querySelector(".re-pal").value=s.pallet_qty??"";el.querySelector(".re-notes").value=s.notes||"";
  sel.onchange=()=>el.querySelector(".re-custom").classList.toggle("hidden",sel.value!=="custom");
  el.querySelector(".re-up").onclick=()=>{if(el.previousElementSibling){el.previousElementSibling.before(el);renumber()}};
  el.querySelector(".re-down").onclick=()=>{if(el.nextElementSibling){el.nextElementSibling.after(el);renumber()}};
  el.querySelector(".re-del").onclick=()=>{el.remove();renumber()};
  let grip=el.querySelector(".re-grip");
  grip.addEventListener("dragstart",e=>{e.stopPropagation();el.classList.add("dragging");try{e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain","stop");e.dataTransfer.setDragImage(el,10,10)}catch(_){}});
  grip.addEventListener("dragend",e=>{e.stopPropagation();el.classList.remove("dragging");document.querySelectorAll(".drop-before,.drop-after").forEach(x=>x.classList.remove("drop-before","drop-after"));renumber()});
  return el;
}
function setDeliveryHidden(hide){
  let box=$("delivery").closest(".grid > div");box.style.display=hide?"none":"";
  ["delivery","deliveryCustomName","deliveryCustomAddress"].forEach(id=>$(id).required=false);
  if(!hide){$("delivery").required=true;toggleCustomLocation("delivery")}
  let lab=$("pickup").closest(".grid > div").querySelector("label");if(lab)lab.textContent=hide?"Start / Pickup *":"Pickup *";
  let hint=$("routeHint");if(hint)hint.textContent=hide?"Starts at the Pickup above, then runs these stops in order. Drag ⋮⋮ or use ↑/↓ to reorder.":"Optional. Add stops to make this a multi-stop route; Pickup is the start.";
}
function renumber(){
  let rows=[...document.querySelectorAll("#routeStops .re-stop")];
  rows.forEach((r,i)=>r.querySelector(".re-num").textContent=i+1);
  let list=$("routeStops");
  if(!rows.length){if(!list.querySelector(".re-empty"))list.innerHTML="";setDeliveryHidden(false)}else setDeliveryHidden(true);
  let b=$("addStopBtn");if(b)b.textContent=rows.length?"+ Add stop":"+ Add stop (make this a route)";
}
function fillEditor(stops){editorEl();let list=$("routeStops");list.innerHTML="";(stops||[]).forEach(s=>list.appendChild(stopRow(s)));renumber()}
window.SHIFT_addStop=function(){
  editorEl();let list=$("routeStops");
  if(!list.querySelector(".re-stop")){
    // first stop: keep the delivery already entered as stop 1
    let d=locationFromForm("delivery");
    if(d&&d[0]&&d[1])list.appendChild(stopRow({location_name:d[0],location_address:d[1],stop_type:"delivery",material:$("material").value||null,pallet_qty:$("pallets").value?Number($("pallets").value):null}));
  }
  let row=stopRow({stop_type:"delivery"});list.appendChild(row);renumber();
  row.querySelector(".re-loc").focus();
};
function readStops(){
  return [...document.querySelectorAll("#routeStops .re-stop")].map((el,i)=>{
    let v=el.querySelector(".re-loc").value,name="",address="",location_id=null;
    if(v.startsWith("builtin:")){let x=LOC[Number(v.split(":")[1])];name=x[0];address=x[1]}
    else if(v.startsWith("saved:")){let x=savedLocations.find(s=>String(s.id)===v.split(":")[1]);if(x){name=x.name;address=x.address;location_id=x.id}}
    else if(v==="custom"){name=el.querySelector(".re-name").value.trim();address=el.querySelector(".re-addr").value.trim()}
    let pal=el.querySelector(".re-pal").value;
    return {id:el.dataset.stopId?Number(el.dataset.stopId):null,seq:i+1,location_id,location_name:name||null,location_address:address||null,
      stop_type:el.querySelector(".re-type").value||"delivery",material:el.querySelector(".re-mat").value.trim()||null,
      pallet_qty:pal===""?null:Number(pal),notes:el.querySelector(".re-notes").value.trim()||null};
  });
}
const origOpen=window.openTask;
window.openTask=function(){let r=origOpen.apply(this,arguments);fillEditor([]);return r};
const origEdit=window.editTask;
window.editTask=function(id){
  let r=origEdit.apply(this,arguments);
  let t=(tasks||[]).find(x=>x.id===id)||(allTasks||[]).find(x=>x.id===id);
  if(t&&$("id").value==String(id)){
    fillEditor(STOPS[id]||[]);
    if(t.is_route&&!(STOPS[id]||[]).length)fetchStopsFor([id]).then(m=>{if($("id").value==String(id)&&!document.querySelector("#routeStops .re-stop")){STOPS[id]=m[id]||[];fillEditor(STOPS[id])}}).catch(e=>console.warn(e));
  }
  return r;
};

/* save: tasks without stops use the original handler unchanged */
const form=$("form"),origSubmit=form.onsubmit;
form.onsubmit=async function(e){
  let rows=readStops(),id=$("id").value?Number($("id").value):null;
  let t=id?(allTasks||[]).find(x=>x.id===id):null,wasRoute=!!(t&&isRoute(t));
  if(!rows.length){
    await origSubmit.call(this,e);
    if(id&&wasRoute){ // all stops removed in the editor → back to a normal one-way task
      let a=await db.from("dispatch_task_stops").delete().eq("task_id",id);
      let b=await db.from("dispatch_tasks").update({is_route:false}).eq("id",id);
      if(a.error||b.error)alert("Could not remove the route stops: "+(a.error||b.error).message);
      await load();
    }
    return;
  }
  e.preventDefault();
  let p=locationFromForm("pickup");
  if(!p||!p[0]||!p[1])return alert("Please choose the route start (Pickup) with a name and full address.");
  let bad=rows.findIndex(s=>!s.location_name||!s.location_address);
  if(bad>=0)return alert(`Stop ${bad+1}: choose a location (or type a name and full address).`);
  let locErr=null;try{await saveLocationIfRequested("pickup",p)}catch(err){locErr=err}
  let last=rows[rows.length-1],sv=$("scheduled").value;
  let payload={work_date:sv?sv.slice(0,10):boardDate,title:`${p[0]} - ${last.location_name} (${rows.length} stop${rows.length===1?"":"s"})`,
    pickup_name:p[0],pickup_address:p[1],delivery_name:last.location_name,delivery_address:last.location_address,
    scheduled_at:sv?new Date(sv).toISOString():null,priority:$("priority").value,job_client:$("job").value||null,material:$("material").value||null,
    pallet_qty:$("pallets").value?Number($("pallets").value):null,task_type:$("type").value,instructions:$("notes").value||null,is_route:true};
  let taskId=id;
  if(id){let r=await db.from("dispatch_tasks").update(payload).eq("id",id);if(r.error)return alert("Could not save route: "+r.error.message)}
  else{let r=await db.from("dispatch_tasks").insert({...payload,status:"pending",planning_stage:$("stage").value,sort_order:999}).select("id").single();if(r.error)return alert("Could not create route: "+r.error.message);taskId=r.data.id}
  let err=await syncStops(taskId,rows);
  closeTask();await load();
  if(err)alert("The route was saved, but some stops could not be saved:\n\n"+err);
  else if(locErr)alert("Route saved. The start location was not added to Saved Customers.\n\n"+(locErr.message||locErr));
};
async function syncStops(taskId,rows){
  let errs=[];
  let cur=await db.from("dispatch_task_stops").select("id").eq("task_id",taskId);
  if(cur.error)return cur.error.message;
  let keep=new Set(rows.filter(r=>r.id).map(r=>r.id)),gone=(cur.data||[]).map(x=>x.id).filter(x=>!keep.has(x));
  if(gone.length){let r=await db.from("dispatch_task_stops").delete().in("id",gone).eq("task_id",taskId);if(r.error)errs.push(r.error.message)}
  const fields=s=>({seq:s.seq,location_id:s.location_id,location_name:s.location_name,location_address:s.location_address,stop_type:s.stop_type,material:s.material,pallet_qty:s.pallet_qty,notes:s.notes});
  for(let s of rows.filter(r=>r.id)){let r=await db.from("dispatch_task_stops").update(fields(s)).eq("id",s.id).eq("task_id",taskId);if(r.error)errs.push(r.error.message)}
  let add=rows.filter(r=>!r.id).map(s=>({task_id:taskId,...fields(s)}));
  if(add.length){let r=await db.from("dispatch_task_stops").insert(add);if(r.error)errs.push(r.error.message)}
  return errs.join("\n");
}

/* ---------- combine into route ---------- */
function toolbarButtons(){
  let hist=document.querySelector('button[onclick="openHistory()"]');if(!hist||$("combineBtn"))return;
  hist.insertAdjacentHTML("beforebegin",`<button class="btn ghost" id="combineBtn" type="button" onclick="SHIFT_startCombine()" title="Combine into route: select 2+ tasks and merge them into one multi-stop route">⛓ Combine</button><button class="btn ghost" id="combinedToggle" type="button" onclick="SHIFT_toggleCombined()" style="display:none">Show combined</button>`);
  let bar=document.createElement("div");bar.id="combineBar";
  bar.innerHTML=`<span>⛓ Tap tasks in route order — <b id="cbCount">0</b> selected</span><span class="cb-msg" id="cbMsg"></span><button class="btn primary" type="button" id="cbGo" onclick="SHIFT_openCombine()">Combine…</button><button class="btn ghost" type="button" onclick="SHIFT_cancelCombine()">Cancel</button>`;
  document.body.appendChild(bar);
}
function cbUpdate(msg){$("cbCount").textContent=picked.length;$("cbGo").disabled=picked.length<2;$("cbMsg").textContent=msg||""}
window.SHIFT_startCombine=function(){combineMode=true;picked=[];document.body.classList.add("combine-mode");cbUpdate();render()};
window.SHIFT_cancelCombine=function(){combineMode=false;picked=[];document.body.classList.remove("combine-mode");let m=$("combineModal");if(m)m.classList.remove("show");render()};
document.addEventListener("click",e=>{
  if(!combineMode)return;
  let card=e.target.closest("article.task");if(!card||e.target.closest("#combineModal"))return;
  e.preventDefault();e.stopPropagation();
  let id=Number(card.dataset.id),t=(allTasks||[]).find(x=>x.id===id);if(!t)return;
  if(t.status==="completed")return cbUpdate("Completed tasks can't be combined.");
  if(t.combined_into_task_id)return cbUpdate("That task is already in a route.");
  let i=picked.indexOf(id);if(i>=0)picked.splice(i,1);else picked.push(id);
  cbUpdate();render();
},true);
const same=(a,b)=>(a.name||"").trim().toLowerCase()===(b.name||"").trim().toLowerCase()&&(a.addr||"").trim().toLowerCase()===(b.addr||"").trim().toLowerCase();
const uniqJoin=(arr,sep)=>[...new Set(arr.map(x=>(x??"").toString().trim()).filter(Boolean))].join(sep||"; ")||null;
/* stops copied in order from each original's pickup + delivery (or start + stops for a route);
   back-to-back visits to the same place merge into one stop ("both" when it is a pickup and a delivery) */
window.SHIFT_buildRoute=function(list,skipStartPickups){
  let seq=[];
  list.forEach(t=>{
    let lbl=`#${t.id}`;
    seq.push({name:t.pickup_name,addr:t.pickup_address,type:"pickup",material:t.material,pallets:t.pallet_qty,notes:null,src:lbl});
    let st=isRoute(t)?(STOPS[t.id]||[]):[];
    if(st.length)st.forEach(s=>seq.push({name:s.location_name,addr:s.location_address,location_id:s.location_id,type:s.stop_type,material:s.material,pallets:s.pallet_qty,notes:s.notes,src:lbl}));
    else seq.push({name:t.delivery_name,addr:t.delivery_address,type:"delivery",material:t.material,pallets:t.pallet_qty,notes:null,src:lbl});
  });
  let origin=seq.shift();
  if(skipStartPickups)seq=seq.filter(s=>!(s.type==="pickup"&&same(s,origin)));
  let out=[];
  seq.forEach(s=>{
    let last=out[out.length-1];
    if(!last&&same(s,origin)&&s.type==="pickup")return;          // pickup at the start = loaded at the origin
    if(last&&same(last,s)){
      if(last.type!==s.type)last.type="both";
      last.material=uniqJoin([last.material,s.material]);
      last.pallets=last.type==="both"?null:((last.pallets??0)+(s.pallets??0))||last.pallets||s.pallets||null;
      last.notes=uniqJoin([last.notes,s.notes]);last.srcs.push(s.src);last.parts.push(`${s.type} ${s.src}${s.pallets!=null?" ("+s.pallets+" pal)":""}`);
    }else out.push({...s,srcs:[s.src],parts:[`${s.type} ${s.src}${s.pallets!=null?" ("+s.pallets+" pal)":""}`]});
  });
  out.forEach(s=>{if(s.srcs.length>1)s.notes=uniqJoin([s.notes,"Combined: "+s.parts.join(", ")])});
  return {origin,stops:out};
};
function combineModal(){
  let m=$("combineModal");if(m)return m;
  m=document.createElement("div");m.className="modal";m.id="combineModal";
  m.innerHTML=`<div class="dialog combine-dialog"><div class="dialog-head"><div><b>Combine into route</b><div class="muted" style="font-size:12px;margin-top:3px">Creates ONE new route task. The originals are kept (hidden from the board, never deleted).</div></div><button class="close" type="button" onclick="SHIFT_closeCombine()">×</button></div>
  <div class="cmb-list" id="cmbList"></div>
  <div class="cmb-grid"><div><label>Date</label><input type="date" id="cmbDate"></div><div><label>Driver</label><select id="cmbDriver"></select></div><div><label>Truck</label><div id="cmbTruck" class="muted" style="padding:9px 2px;font-weight:800"></div></div></div>
  <label class="save-location" style="margin:0 0 6px"><input type="checkbox" id="cmbSkip" checked> Load pickups that are at the start location up front (no return trips to the start)</label>
  <div class="cmb-preview" id="cmbPreview"></div>
  <div class="form-actions"><button type="button" class="btn ghost" onclick="SHIFT_closeCombine()">Back</button><button type="button" class="btn primary" id="cmbCreate" onclick="SHIFT_createRoute()">Create route</button></div></div>`;
  m.onclick=e=>{if(e.target===m)SHIFT_closeCombine()};
  document.body.appendChild(m);
  m.querySelector("#cmbDriver").onchange=cmbRefresh;m.querySelector("#cmbDate").onchange=cmbRefresh;m.querySelector("#cmbSkip").onchange=cmbRefresh;
  return m;
}
function pickedTasks(){return picked.map(id=>(allTasks||[]).find(x=>x.id===id)).filter(Boolean)}
function cmbRefresh(){
  let list=pickedTasks();
  $("cmbList").innerHTML=list.map((t,i)=>`<div class="cmb-item"><span class="cmb-n">${i+1}</span><span class="cmb-t"><b>${esc(t.pickup_name)} → ${esc(t.delivery_name)}</b>${isRoute(t)?` <span class="combined-tag">route · ${(STOPS[t.id]||[]).length} stops</span>`:""}<br><span class="muted">#${t.id} · ${esc(t.task_type||"")} · ${esc((drivers.find(d=>Number(d.id)===Number(t.assigned_driver_id))||{}).name||"Unassigned")}${t.pallet_qty!=null?" · "+t.pallet_qty+" pallets":""}${t.job_client?" · "+esc(t.job_client):""}</span></span><button class="mini" type="button" onclick="SHIFT_cmbMove(${i},-1)" ${i?"":"disabled"}>↑</button><button class="mini" type="button" onclick="SHIFT_cmbMove(${i},1)" ${i<list.length-1?"":"disabled"}>↓</button><button class="mini danger" type="button" onclick="SHIFT_cmbMove(${i},0)">✕</button></div>`).join("");
  let dId=$("cmbDriver").value?Number($("cmbDriver").value):null,date=$("cmbDate").value;
  let tr=dId&&typeof SHIFT_resolveTruck==="function"?SHIFT_resolveTruck(dId,date):null;
  $("cmbTruck").innerHTML=dId?(tr?`🚛 ${esc(tr.name||"Vehicle #"+tr.id)} <span class="muted" style="font-weight:600">(${tr.source==="override"?"daily truck":"default truck"} — change in Driver Schedule)</span>`:'🚛 No truck set <span class="muted" style="font-weight:600">(pick one in Driver Schedule)</span>'):"—";
  let r=SHIFT_buildRoute(list,$("cmbSkip").checked);
  $("cmbPreview").innerHTML=list.length<2?'<span class="muted">Pick at least two tasks.</span>':`<div>🏁 <b>Start:</b> ${esc(r.origin.name)} <span class="muted">${esc(r.origin.addr||"")}</span></div>`+r.stops.map((s,i)=>`<div>${i+1}. <b>${esc(s.name)}</b><span class="cmb-type">${esc(s.type==="both"?"pickup + delivery":s.type)}</span> <span class="muted">${esc(s.addr||"")}${s.material?" · "+esc(s.material):""}${s.pallets!=null?" · "+s.pallets+" pal":""} · from ${esc(s.srcs.join(", "))}</span></div>`).join("");
  $("cmbCreate").disabled=list.length<2||!r.stops.length;
}
window.SHIFT_cmbMove=function(i,d){if(d===0)picked.splice(i,1);else{let j=i+d;[picked[i],picked[j]]=[picked[j],picked[i]]}cbUpdate();render();if(picked.length<2)return SHIFT_closeCombine();cmbRefresh()};
window.SHIFT_openCombine=function(){
  let list=pickedTasks();if(list.length<2)return cbUpdate("Pick at least two tasks.");
  let m=combineModal(),first=list[0];
  $("cmbDriver").innerHTML='<option value="">Unassigned</option>'+drivers.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join("");
  $("cmbDriver").value=first.assigned_driver_id?String(first.assigned_driver_id):"";
  $("cmbDate").value=String(first.work_date||boardDate).slice(0,10);
  cmbRefresh();m.classList.add("show");
};
window.SHIFT_closeCombine=function(){let m=$("combineModal");if(m)m.classList.remove("show")};
window.SHIFT_createRoute=async function(){
  let list=pickedTasks();if(list.length<2)return;
  let r=SHIFT_buildRoute(list,$("cmbSkip").checked);if(!r.stops.length)return alert("Nothing to route — every stop is the start location.");
  let btn=$("cmbCreate");btn.disabled=true;btn.textContent="Creating…";
  try{
    let first=list[0],date=$("cmbDate").value||boardDate,driver=$("cmbDriver").value?Number($("cmbDriver").value):null,last=r.stops[r.stops.length-1];
    let sched=list.map(t=>t.scheduled_at).filter(Boolean).sort()[0],scheduled_at=null;
    if(sched){let d=new Date(sched);scheduled_at=new Date(`${date}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`).toISOString()}
    let pallets=list.map(t=>t.pallet_qty).filter(x=>x!=null);
    let payload={work_date:date,title:`${r.origin.name} - ${last.name} (${r.stops.length} stop${r.stops.length===1?"":"s"})`,task_type:first.task_type||"delivery",
      status:driver?"assigned":"pending",planning_stage:driver?"assigned":(first.planning_stage==="brainstorm"?"brainstorm":"ready"),
      priority:list.some(t=>t.priority==="high")?"high":(first.priority||"normal"),scheduled_at,
      pickup_name:r.origin.name,pickup_address:r.origin.addr,delivery_name:last.name,delivery_address:last.addr,
      job_client:uniqJoin(list.map(t=>t.job_client)),material:uniqJoin(list.map(t=>t.material)),pallet_qty:pallets.length?pallets.reduce((a,b)=>a+b,0):null,
      instructions:[`Combined from tasks ${list.map(t=>"#"+t.id).join(", ")}.`,...list.filter(t=>t.instructions).map(t=>`#${t.id}: ${t.instructions}`)].join("\n"),
      assigned_driver_id:driver,sort_order:driver&&Number(first.assigned_driver_id)===driver?(first.sort_order||0):999,is_route:true};
    let ins=await db.from("dispatch_tasks").insert(payload).select("id").single();
    if(ins.error)throw new Error("Could not create the route: "+ins.error.message);
    let newId=ins.data.id;
    let stops=r.stops.map((s,i)=>({task_id:newId,seq:i+1,location_id:s.location_id||null,location_name:s.name||null,location_address:s.addr||null,stop_type:s.type,material:s.material||null,pallet_qty:s.pallets??null,notes:s.notes||null}));
    let si=await db.from("dispatch_task_stops").insert(stops);
    if(si.error){await db.from("dispatch_tasks").delete().eq("id",newId).eq("is_route",true);throw new Error("Could not save the stops (nothing was changed): "+si.error.message)}
    let up=await db.from("dispatch_tasks").update({combined_into_task_id:newId}).in("id",list.map(t=>t.id));
    if(up.error)alert(`Route #${newId} was created, but the original tasks could not be marked as combined: ${up.error.message}`);
    SHIFT_cancelCombine();await load();
  }catch(e){alert(e.message||e)}
  finally{btn.disabled=false;btn.textContent="Create route"}
};

/* ---------- Route History CSV: one row per stop for route tasks ---------- */
const STOP_COLS=["Is Route","Combined Into Task ID","Route Stop #","Route Stop Count","Stop Type","Stop Location","Stop Address","Stop Material","Stop Pallets","Stop Notes","Stop Status","Leg From","Stop Arrived (CT)","Stop Departed (CT)","Leg Drive Minutes","Stop On-Site Minutes","Stop GPS Truck","Planned Truck"];
window.SHIFT_exportTasksCsv=async function(){
  let from=$("taskExpFrom").value,to=$("taskExpTo").value;
  if(from&&to&&from>to)return alert("The start date is after the end date.");
  let rows=SHIFT_taskCsvRows(from,to);
  if(!rows.length)return alert("No tasks in this date range.");
  let byId={};(allTasks||[]).forEach(t=>byId[t.id]=t);
  let routeIds=rows.map(r=>byId[r["Task ID"]]).filter(t=>t&&t.is_route).map(t=>t.id),st={};
  if(routeIds.length){try{st=await fetchStopsFor(routeIds)}catch(e){return alert("Could not load route stops: "+(e.message||e))}}
  let out=[];
  rows.forEach(r=>{
    let t=byId[r["Task ID"]]||{},base={...r,"Is Route":t.is_route?"yes":"","Combined Into Task ID":t.combined_into_task_id??""};
    let s=t.is_route?(st[t.id]||[]):[];
    if(!s.length){let b={...base};STOP_COLS.slice(2).forEach(k=>b[k]="");out.push(b);return}
    s.forEach(x=>out.push({...base,"Route Stop #":x.stop_number,"Route Stop Count":x.stop_count,"Stop Type":x.stop_type,"Stop Location":x.location_name||"","Stop Address":x.location_address||"",
      "Stop Material":x.material||"","Stop Pallets":x.pallet_qty??"","Stop Notes":x.notes||"","Stop Status":x.status,"Leg From":x.prev_location_name||"",
      "Stop Arrived (CT)":stamp(x.gps_arrived_at),"Stop Departed (CT)":stamp(x.gps_departed_at),"Leg Drive Minutes":x.leg_drive_minutes??"","Stop On-Site Minutes":x.gps_dwell_minutes??"",
      "Stop GPS Truck":x.gps_vehicle_name||"","Planned Truck":x.vehicle_name||""}));
  });
  SHIFT_csvDownload(`tasks_${from||"start"}_to_${to||"end"}.csv`,out);
};

toolbarButtons();
// first paint may have happened before this file loaded
fetchStops().then(()=>{try{render()}catch(_){}});
})();
