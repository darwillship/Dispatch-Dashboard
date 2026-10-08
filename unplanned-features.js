/* SHIFT Dispatch v3.11.0 — automatic UNPLANNED STOPS (since v3.10.0).
   Rows come from public.unplanned_stops (written by the Verizon updater, vzc-sync). The dashboard only reads them
   and lets the dispatcher ✓ Keep / ✕ Ignore (it can update review_status + reviewed_at, nothing else).
   - stop during a route  → dashed row inside the route card, right after the stop it came after
   - stop during/after a single task → block at the bottom of that card (the task stays a single task)
   - anything else → "Unplanned activity" card in the driver's column, or the truck list under the fleet strip
   Unplanned stops never count toward route completion. */
(function(){
const css=`
.up-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:3px 0;padding:4px 7px;border:1.5px dashed #e0a526;border-radius:9px;background:rgba(224,165,38,.09);font-size:12px;line-height:1.3}
.up-row .up-tag{font-weight:900;color:#f2b84b;font-size:10.5px;letter-spacing:.02em;text-transform:uppercase}
.up-row .up-name{font-weight:800;color:#f6e7c8}
.up-row .up-time{color:#d9c39a;font-weight:700}
.up-row .up-sub{flex-basis:100%;color:#b8a888;font-size:11px}
.up-row .up-actions{margin-left:auto;display:inline-flex;gap:4px}
.up-row .up-actions .mini{padding:2px 7px;font-size:11px}
.up-row.up-kept{border-style:solid;border-color:#3fa66b;background:rgba(63,166,107,.10)}
.up-row.up-kept .up-tag{color:#5fd08f}
.up-row.up-ignored{opacity:.55;border-color:#6b7785;background:transparent}
.up-row.up-ignored .up-tag{color:#9aa6b2}
.up-block{margin-top:6px}
.up-card{margin:6px 0;padding:6px 8px;border:1.5px dashed #e0a526;border-radius:12px}
.up-card-title{font-weight:900;color:#f2b84b;font-size:12px;margin-bottom:2px}
#unplannedStrip{margin:0 0 10px;padding:7px 9px;border:1.5px dashed #e0a526;border-radius:12px;font-size:12px}
#unplannedStrip .us-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#unplannedStrip .us-title{font-weight:900;color:#f2b84b}
#unplannedStrip .us-truck{margin-top:5px;font-weight:800;color:#e6eef6}
body.light-mode .up-row{background:#fff6e3!important;border-color:#c98a0c!important}
body.light-mode .up-row .up-name{color:#3b2a06!important}body.light-mode .up-row .up-time{color:#6b5320!important}body.light-mode .up-row .up-sub{color:#6d5f45!important}
body.light-mode .up-row .up-tag,body.light-mode .up-card-title,body.light-mode #unplannedStrip .us-title{color:#a46c00!important}
body.light-mode .up-row.up-kept{background:#e9f7ef!important;border-color:#2f8a56!important}body.light-mode .up-row.up-ignored{background:transparent!important}
body.light-mode #unplannedStrip .us-truck{color:#0d1824!important}
#assignStrip{margin:0 0 10px;padding:7px 9px;border:1.5px solid #3d7ec2;border-radius:12px;font-size:12.5px;background:rgba(61,126,194,.08)}
#assignStrip .as-title{font-weight:900;color:#9fd0ff;margin-bottom:3px}
#assignStrip .as-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0;font-weight:800;color:#e6eef6}
#assignStrip .as-row .mini{padding:3px 9px;font-size:12px;font-weight:900}
body.light-mode #assignStrip{background:#eef5fc!important;border-color:#2f6eae!important}
body.light-mode #assignStrip .as-title{color:#1a4f86!important}body.light-mode #assignStrip .as-row{color:#0d1824!important}`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

let UP=[],PLACE=new Map(),showIgnored=sessionStorage.getItem("shift-up-ignored")==="1";
window.SHIFT_unplanned=()=>UP;
const clk=v=>v?(typeof SHIFT_ctClock==="function"?SHIFT_ctClock(v):new Date(v).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})):"";
const stamp=v=>typeof SHIFT_ctStamp==="function"?SHIFT_ctStamp(v):(v||"");
const vName=id=>{let v=(window.SHIFT_vehicles||[]).find(x=>Number(x.id)===Number(id));return v?v.name:"Truck #"+id};
const dName=id=>{let d=(typeof drivers!=="undefined"?drivers:[]).find(x=>Number(x.id)===Number(id));return d?d.name:""};
const visible=u=>showIgnored||u.review_status!=="ignored";
const mins=(a,b)=>a&&b?Math.max(0,Math.round((Date.parse(b)-Date.parse(a))/60000)):null;

async function fetchUP(){
  try{let r=await db.from("unplanned_stops").select("*").eq("work_date",boardDate).order("arrived_at");
    if(r.error){console.warn("unplanned stops unavailable",r.error);UP=[];return}UP=r.data||[]}
  catch(e){console.warn("unplanned stops unavailable",e);UP=[]}
}
window.SHIFT_fetchUnplanned=fetchUP;

function rowHtml(u,showTruck){
  let name=u.location_name||u.address||"Unknown spot",k=u.review_status||"pending";
  let time=clk(u.arrived_at)+(u.departed_at?"–"+clk(u.departed_at):" – still there");
  let sub=[];
  if(u.location_name&&u.address)sub.push(u.address);
  if(u.engine_off_at)sub.push((u.departed_at?"engine off ":"engine off since ")+clk(u.engine_off_at)+(u.engine_on_at?", on "+clk(u.engine_on_at):""));
  let m=[];if(u.engine_off_minutes!=null)m.push(u.engine_off_minutes+" min engine off");if(u.idle_minutes)m.push(u.idle_minutes+" min idle");
  if(m.length)sub.push(m.join(", "));
  if(showTruck)sub.push(vName(u.vehicle_id));
  let tag=k==="kept"?"✓ Kept stop":k==="ignored"?"Ignored":"⚠ Unplanned";
  let btn=(s,l,c)=>`<button type="button" class="mini ${c}" onclick="event.stopPropagation();SHIFT_upReview(${u.id},'${s}')">${l}</button>`;
  let acts=(k!=="kept"?btn("kept","✓ Keep","up-keep"):"")+(k!=="ignored"?btn("ignored","✕ Ignore","up-ignore"):"");
  return `<div class="up-row up-${k}" data-up="${u.id}" title="Unplanned stop detected from Verizon GPS (not on any task). Keep = it was a real stop; Ignore = hide it."><span class="up-tag">${tag}</span><span class="up-name">${esc(name)}</span><span class="up-time">${esc(time)}</span><span class="up-actions">${acts}</span>${sub.length?`<div class="up-sub">${esc(sub.join(" · "))}</div>`:""}</div>`;
}
window.SHIFT_upRowHtml=rowHtml;

/* where each row shows up on the board */
function computePlacement(){
  PLACE=new Map();
  let board=new Map((tasks||[]).filter(t=>!t.combined_into_task_id).map(t=>[Number(t.id),t]));
  let vis=new Set((typeof drivers!=="undefined"?drivers:[]).filter(d=>typeof driverVisibleOnBoard!=="function"||driverVisibleOnBoard(d)).map(d=>Number(d.id)));
  for(let u of UP){
    if(!visible(u))continue;
    let t=u.task_id!=null?board.get(Number(u.task_id)):null;
    if(t)PLACE.set(u.id,"task");
    else if(u.driver_id!=null&&vis.has(Number(u.driver_id)))PLACE.set(u.id,"driver");
    else PLACE.set(u.id,"truck");
  }
}
const parse=html=>{let tp=document.createElement("template");tp.innerHTML=html;return tp};
const origCard=window.taskCard;
window.taskCard=function(t){
  let html=origCard.apply(this,arguments);
  let mine=UP.filter(u=>PLACE.get(u.id)==="task"&&Number(u.task_id)===Number(t.id));
  if(!mine.length)return html;
  try{
    let tp=parse(html),card=tp.content.querySelector(".task");if(!card)return html;
    let box=t.is_route?card.querySelector(".route-stops"):null;
    if(box&&!box.querySelector(".muted")){
      let after=new Map();
      for(let u of mine){
        let anchor=after.get(u.after_stop_id??"start");
        if(!anchor)anchor=u.after_stop_id!=null?box.querySelector(`.rs-chip[data-stop="${u.after_stop_id}"]`)?.closest(".rs-row"):box.querySelector(".rs-origin");
        let el=parse(rowHtml(u)).content.firstElementChild;
        if(anchor)anchor.after(el);else box.appendChild(el);
        after.set(u.after_stop_id??"start",el);
      }
    }else{
      let b=document.createElement("div");b.className="up-block";b.innerHTML=mine.map(u=>rowHtml(u)).join("");card.appendChild(b);
    }
    return tp.innerHTML;
  }catch(e){console.warn("unplanned row",e);return html}
};
const origCol=window.driverColumn;
window.driverColumn=function(d){
  let html=origCol.apply(this,arguments);
  let mine=UP.filter(u=>PLACE.get(u.id)==="driver"&&Number(u.driver_id)===Number(d.id));
  if(!mine.length)return html;
  try{
    let tp=parse(html),zone=tp.content.querySelector(".driver-routes");if(!zone)return html;
    let c=document.createElement("div");c.className="up-card";
    c.innerHTML=`<div class="up-card-title">⚠ Unplanned activity</div>`+mine.map(u=>rowHtml(u,true)).join("");
    let fold=zone.querySelector("details.done-fold");fold?zone.insertBefore(c,fold):zone.appendChild(c);
    return tp.innerHTML;
  }catch(e){console.warn("unplanned card",e);return html}
};
function renderStrip(){
  let el=$("unplannedStrip");
  if(!UP.length){if(el)el.remove();return}
  if(!el){el=document.createElement("div");el.id="unplannedStrip";let at=$("fleetStrip")||document.querySelector(".toolbar");if(!at)return;at.insertAdjacentElement("afterend",el)}
  let ign=UP.filter(u=>u.review_status==="ignored").length,pend=UP.filter(u=>(u.review_status||"pending")==="pending").length;
  let truck=UP.filter(u=>PLACE.get(u.id)==="truck"),by=new Map();
  truck.forEach(u=>{let k=u.vehicle_id;(by.get(k)||by.set(k,[]).get(k)).push(u)});
  el.innerHTML=`<div class="us-head"><span class="us-title">⚠ Unplanned stops today: ${UP.length-ign}${pend?` · ${pend} to review`:""}</span>`+
    (ign?`<button type="button" class="mini" id="upToggleIgnored" onclick="SHIFT_upToggleIgnored()">${showIgnored?"Hide ignored":"Show ignored"} (${ign})</button>`:"")+`</div>`+
    [...by.entries()].map(([v,rows])=>`<div class="us-truck">🚚 ${esc(vName(v))}${rows[0].driver_id!=null&&dName(rows[0].driver_id)?" · "+esc(dName(rows[0].driver_id)):" · no driver on schedule"}</div>`+rows.map(u=>rowHtml(u)).join("")).join("");
}
window.SHIFT_upToggleIgnored=function(){showIgnored=!showIgnored;sessionStorage.setItem("shift-up-ignored",showIgnored?"1":"0");render()};
window.SHIFT_upReview=async function(id,status){
  let u=UP.find(x=>x.id===id);if(!u)return;
  let when=new Date().toISOString();
  let r=await db.from("unplanned_stops").update({review_status:status,reviewed_at:when}).eq("id",id);
  if(r.error)return alert("Could not save: "+r.error.message);
  u.review_status=status;u.reviewed_at=when;render();
};
const origRender=window.render;
/* v3.11.0: "Big Blue started 5:02 AM. Juan or Jay?" — one click sets the daily truck (manual pick) */
let SUG=[];
async function fetchSuggestions(){
  try{let r=await db.from("vehicle_assignment_suggestions").select("*").eq("work_date",boardDate).eq("status","pending");
    if(r.error){console.warn("truck suggestions unavailable",r.error);SUG=[];return}SUG=r.data||[]}catch(e){console.warn("truck suggestions unavailable",e);SUG=[]}}
function renderAssignStrip(){
  let el=$("assignStrip");
  if(!SUG.length){if(el)el.remove();return}
  if(!el){el=document.createElement("div");el.id="assignStrip";let up=$("unplannedStrip"),at=$("fleetStrip")||document.querySelector(".toolbar");if(up)up.insertAdjacentElement("beforebegin",el);else if(at)at.insertAdjacentElement("afterend",el);else return}
  el.innerHTML=`<div class="as-title">Who started this truck?</div>`+SUG.map(g=>{
    let btns=(g.candidate_driver_ids||[]).map(id=>`<button type="button" class="mini" onclick="SHIFT_assignPick(${g.id},${Number(id)})">${esc(dName(id)||("Driver #"+id))}</button>`).join("");
    return `<div class="as-row">🚛 ${esc(vName(g.vehicle_id))} started ${esc(clk(g.ignition_at))}. ${btns} <button type="button" class="mini" onclick="SHIFT_assignDismiss(${g.id})" title="Leave it unassigned">✕</button></div>`;
  }).join("");
}
window.SHIFT_assignPick=async function(sugId,driverId){
  let g=SUG.find(x=>x.id===sugId);if(!g)return;
  let sch=typeof effectiveDriverSchedule==="function"?effectiveDriverSchedule(driverId):null;
  let on=sch&&(sch.status==="working"||sch.status==="messenger");
  let payload={work_date:boardDate,driver_id:Number(driverId),status:on?sch.status:"working",start_time:on&&sch.start_time||null,end_time:on&&sch.end_time||null,note:sch&&sch.source==="override"?(sch.note||null):null,vehicle_id:Number(g.vehicle_id)};
  let r=await db.from("driver_schedule").upsert(payload,{onConflict:"work_date,driver_id"});
  if(r.error)return alert("Could not set the truck: "+r.error.message);
  let u=await db.from("vehicle_assignment_suggestions").update({status:"accepted",chosen_driver_id:Number(driverId),resolved_at:new Date().toISOString()}).eq("id",sugId);
  if(u.error)return alert("Truck saved, but the prompt could not be cleared: "+u.error.message);
  await load();
};
window.SHIFT_assignDismiss=async function(sugId){
  let r=await db.from("vehicle_assignment_suggestions").update({status:"dismissed",resolved_at:new Date().toISOString()}).eq("id",sugId);
  if(r.error)return alert("Could not dismiss: "+r.error.message);
  SUG=SUG.filter(x=>x.id!==sugId);render();
};

window.render=function(...a){computePlacement();let r=origRender.apply(this,a);try{renderStrip()}catch(e){console.warn("unplanned strip",e)}try{renderAssignStrip()}catch(e){console.warn("assign strip",e)}return r};
const origLoad=window.load;
window.load=async function(...a){await Promise.all([fetchUP(),fetchSuggestions()]);return origLoad.apply(this,a)};

/* Tasks CSV: unplanned stops become extra rows (Unplanned = yes) next to the route stop / task they belong to */
window.SHIFT_unplannedCsv=async function(out,from,to,byId){
  let q=db.from("unplanned_stops").select("*").order("work_date").order("arrived_at").limit(5000);
  if(from)q=q.gte("work_date",from);if(to)q=q.lte("work_date",to);
  let r=await q;if(r.error)throw r.error;
  let rows=(r.data||[]).slice().sort((a,b)=>String(a.work_date).localeCompare(String(b.work_date))||Date.parse(a.arrived_at)-Date.parse(b.arrived_at));
  out.forEach(o=>{o["Unplanned"]="";o["Unplanned Review"]=""});
  if(!rows.length)return out;
  let cols=out.length?Object.keys(out[0]):["Task ID","Work Date","Driver","Is Route","Route Stop #","Stop Type","Stop Location","Stop Address","Stop Status","Stop Arrived (CT)","Stop Departed (CT)","Stop On-Site Minutes","Stop GPS Truck","Stop Engine Off (CT)","Stop Engine On (CT)","Stop Engine-Off Minutes","Stop Idle Minutes","Stop Match Method","Unplanned","Unplanned Review"];
  let stopNo=new Map(),ids=[...new Set(rows.map(u=>u.after_stop_id).filter(x=>x!=null))];
  if(ids.length){let s=await db.from("dispatch_route_stops_v").select("stop_id,stop_number").in("stop_id",ids);(s.data||[]).forEach(x=>stopNo.set(x.stop_id,x.stop_number))}
  const STOPK=new Set(["Is Route","Combined Into Task ID","Route Stop #","Route Stop Count","Stop Type","Stop Location","Stop Address","Stop Material","Stop Pallets","Stop Notes","Stop Status","Leg From","Stop Arrived (CT)","Stop Departed (CT)","Leg Drive Minutes","Stop On-Site Minutes","Stop GPS Truck","Planned Truck","Stop Engine Off (CT)","Stop Engine On (CT)","Stop Engine-Off Minutes","Stop Idle Minutes","Stop Match Method","Stop Match Distance (m)","Unplanned","Unplanned Review"]);
  for(let u of rows){
    let row={};cols.forEach(c=>row[c]="");
    let t=u.task_id!=null?byId[u.task_id]:null,base=t?out.find(o=>Number(o["Task ID"])===Number(u.task_id)):null;
    if(base)for(let c of cols)if(!STOPK.has(c))row[c]=base[c];
    Object.assign(row,{"Work Date":u.work_date,"Driver":dName(u.driver_id)||(base?base.Driver:""),"Is Route":t&&t.is_route?"yes":"","Route Stop #":"","Stop Type":"unplanned",
      "Stop Location":u.location_name||"","Stop Address":u.address||"","Stop Status":u.review_status,"Stop Arrived (CT)":stamp(u.arrived_at),"Stop Departed (CT)":stamp(u.departed_at),
      "Stop On-Site Minutes":mins(u.arrived_at,u.departed_at)??"","Stop GPS Truck":vName(u.vehicle_id),"Stop Engine Off (CT)":stamp(u.engine_off_at),"Stop Engine On (CT)":stamp(u.engine_on_at),
      "Stop Engine-Off Minutes":u.engine_off_minutes??"","Stop Idle Minutes":u.idle_minutes??"","Stop Match Method":u.source||"vzc_auto","Unplanned":"yes","Unplanned Review":u.review_status});
    row["Task ID"]=base?u.task_id:"";
    // position: after the route stop it followed / after its task / at the end of its date
    let idx=-1;
    if(base){
      let mineIdx=out.map((o,i)=>[o,i]).filter(([o])=>Number(o["Task ID"])===Number(u.task_id));
      if(t.is_route){
        let n=u.after_stop_id!=null?stopNo.get(u.after_stop_id):null;
        let hit=n!=null?mineIdx.filter(([o])=>Number(o["Route Stop #"])===Number(n)).pop():null;
        if(hit)idx=hit[1];else if(u.after_stop_id==null)idx=mineIdx[0][1]-1;else idx=mineIdx[mineIdx.length-1][1];
        while(idx+1<out.length&&out[idx+1]["Unplanned"]==="yes"&&Number(out[idx+1]["Task ID"])===Number(u.task_id))idx++;
      }else idx=mineIdx[mineIdx.length-1][1];
    }else{
      let same=out.map((o,i)=>[o,i]).filter(([o])=>String(o["Work Date"])<=String(u.work_date));
      idx=same.length?same[same.length-1][1]:-1;
    }
    out.splice(idx+1,0,row);
  }
  return out;
};

Promise.all([fetchUP(),fetchSuggestions()]).then(()=>{try{render()}catch(_){}});
})();
