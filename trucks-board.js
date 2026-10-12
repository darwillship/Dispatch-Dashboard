/* SHIFT Dispatch v4.0.0 — truck board.
   - One card per truck (vehicles table): its tasks, live Verizon status + location, scheduled drivers (on-shift one highlighted),
     overlap warnings, and the day's automatically detected stops (separate, never counted toward completion).
   - Drag a task onto a truck -> dispatch_tasks.vehicle_id (+ assigned_driver_id = the driver scheduled on that truck; changeable on the card).
   - "Unassigned" card: tasks with a driver but no truck, drivers on shift without a truck (drop onto them = old driver assign), availability.
   - Messengers section + "Assign to Messenger" dialog (messengers table; messenger_id, confirmation_number, messenger_cost). Manual status.
   - Truck Schedule tab in Driver Schedule (truck_schedules: driver, truck, weekdays, shift start/end; overnight = start day).
   - Detected stops: "Edit location name" -> named_places (team-wide, radius 70 m, nearest wins). Verizon address/times are kept.
   Driver at a moment = the ONE driver clearly scheduled on that truck then (no grace), else "Driver unknown". */
(function(){
const DOW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
let TS=[],TS_OK=false,SCHED2=[],NP=[],MSG=[];
window.SHIFT_v4={get truckSchedules(){return TS},get namedPlaces(){return NP},get messengers(){return MSG}};
const css=`
.truck-card .driver-head{align-items:flex-start}
.truck-name{font-size:16px;font-weight:900}
.truck-loc{font-size:11px;color:#8fa6ba;font-weight:600;margin-top:3px;max-width:330px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.truck-drivers{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px}
.tdrv{font-size:13px;font-weight:900;letter-spacing:.1px;border:1px solid #2b3d4f;border-radius:8px;padding:2px 7px;color:#9fb3c6;background:#111d2a}
.tdrv.on{border-color:#1f6b45;background:#0f2a1f;color:#7ee2a8;font-size:14.5px;padding:3px 9px}
.tdrv .tdrv-t{font-weight:700;font-size:11.5px;opacity:.85}
.tdrv-sw{font-size:10.5px;padding:1px 6px;margin-left:5px}
.truck-switch-note{font-size:11.5px;font-weight:800;color:#9fc7ff;background:#13243a;border:1px solid #2a4b72;border-radius:8px;padding:3px 7px;margin:4px 0;display:flex;justify-content:space-between;gap:6px;align-items:center}
.truck-stops>summary{cursor:pointer;list-style:none;font-size:11.5px;font-weight:900;color:#9fb3c6}
.truck-stops>summary::-webkit-details-marker{display:none}
.truck-stops[open]>summary{margin-bottom:4px}
.crew-strip{column-span:all;display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px;padding:8px 10px;border:1px solid #24405b;border-radius:12px;background:rgba(17,29,42,.6)}
.crew-strip .crew-title{font-size:12px;font-weight:900;color:#9fb3c6;margin-right:4px}
.crew-chip{display:flex;align-items:center;gap:6px;border:1px solid #2b3d4f;border-radius:10px;padding:3px 4px 3px 9px;font-size:12px;background:#111d2a}
.crew-chip b{font-size:13.5px;font-weight:900}
.crew-chip .crew-sub{color:#8fa6ba;font-weight:700;font-size:11px}
.crew-chip.off{opacity:.6}
.crew-chip.over{outline:2px dashed #4f8cff}
.crew-chip select{width:auto;padding:2px 4px;font-size:11px}
.driver-live span:empty{display:none}
.tdrv.on::before{content:"● ";}
.tdrv.none{border-style:dashed;color:#7e94a7;font-weight:700}
.truck-conflict{font-size:11px;font-weight:900;color:#ffb4b4;background:#3a1616;border:1px solid #7a2a2a;border-radius:8px;padding:3px 7px;margin:4px 0}
.truck-stops{margin-top:8px;border:1px dashed #34465c;border-radius:10px;padding:6px 8px;background:transparent}
.truck-stops .ts-title{font-size:11px;font-weight:900;color:#9fb3c6;margin-bottom:4px}
.ts-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:12px;padding:4px 0;border-top:1px solid #1d2c3b}
.ts-row:first-of-type{border-top:0}
.ts-name{font-weight:800;color:#dfe9f3}.ts-time{color:#9fb3c6;font-weight:700;white-space:nowrap}
.ts-sub{grid-column:1/-1;color:#7e94a7;font-size:11px}
.ts-unknown{color:#e2b36b;font-weight:800}
.ts-edit{font-size:10.5px;padding:1px 6px;margin-left:4px}
.task-driver-pick{display:flex;align-items:center;gap:5px;font-size:11px;color:#9fb3c6;font-weight:800;margin:4px 0 0}
.task-driver-pick select{width:auto;padding:3px 6px;font-size:11.5px}
.msg-badge{display:inline-block;font-size:11px;font-weight:900;border-radius:7px;padding:2px 7px;background:#2c2145;color:#d9c7ff;border:1px solid #5b4691;margin-top:4px}
.messenger-card .driver-name::before{content:"🛵 "}
.unassigned-card .driver-name::before{content:"📥 "}
.ua-driver{border:1px solid #24405b;border-radius:9px;padding:5px 7px;margin:5px 0;font-size:12px}
.ua-driver .ua-top{display:flex;justify-content:space-between;align-items:center;gap:6px}
.ua-driver .driver-routes{min-height:34px;margin-top:4px}
.ua-driver select{width:auto;padding:3px 6px;font-size:11.5px}
.msg-dialog{width:min(460px,100%)}
.msg-dialog label{display:block;font-size:12px;font-weight:800;margin:8px 0 3px;color:#9fb3c6}
.msg-dialog input,.msg-dialog select{width:100%}
.ts-editor-row{display:grid;grid-template-columns:minmax(120px,1.2fr) minmax(120px,1.1fr) auto 92px 92px auto auto;gap:6px;align-items:center;padding:6px 0;border-top:1px solid #1d2c3b}
.ts-days{display:flex;gap:2px;flex-wrap:wrap}.ts-days label{font-size:10.5px;font-weight:800;display:flex;align-items:center;gap:1px;padding:1px 3px;border:1px solid #2b3d4f;border-radius:6px;cursor:pointer}
.ts-days input{margin:0;width:auto}
.ts-editor-row select,.ts-editor-row input[type=time]{padding:5px 6px;font-size:12px;width:100%}
.ts-flags{font-size:11.5px;margin:8px 0;color:#ffb4b4;font-weight:800}
.ts-gap{font-size:11.5px;margin:6px 0;color:#e2b36b;font-weight:800}
@media(max-width:700px){.ts-editor-row{grid-template-columns:1fr 1fr}.ts-days{grid-column:1/-1}}
body.light-mode .crew-strip{background:#f6f9fc!important;border-color:#c9d8e6!important}body.light-mode .crew-chip{background:#fff!important;border-color:#c9d8e6!important}body.light-mode .truck-switch-note{background:#eaf2ff!important;color:#1d4f91!important;border-color:#b9d0f0!important}
body.light-mode .tdrv{background:#eef4fa!important;border-color:#c9d8e6!important;color:#3a5164!important}
body.light-mode .tdrv.on{background:#ecf8f1!important;border-color:#a9d9bd!important;color:#166534!important}
body.light-mode .truck-stops{border-color:#c9d8e6!important}body.light-mode .ts-name{color:#0d1824!important}
body.light-mode .ts-row{border-color:#e3ebf3!important}body.light-mode .truck-conflict{background:#fdecec!important;color:#9b1c1c!important;border-color:#f0b4b4!important}
body.light-mode .msg-badge{background:#f1ebff!important;color:#4a2d8f!important;border-color:#cdbdf1!important}
body.light-mode .truck-loc,body.light-mode .ts-sub{color:#5b7085!important}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

/* ---------- CT clock (DST-safe), same rules as vzc-sync/assign.ts ---------- */
const F=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const parts=t=>{let o={};for(const p of F.formatToParts(new Date(t)))o[p.type]=p.value;return o};
const ctDate=t=>{let p=parts(t);return `${p.year}-${p.month}-${p.day}`};
const addDays=(d,n)=>new Date(Date.parse(d+"T12:00:00Z")+n*864e5).toISOString().slice(0,10);
function ctAt(date,hhmm){let [h,m]=hhmm.split(":").map(Number);let g=Date.parse(`${date}T${String(h).padStart(2,"0")}:${String(m||0).padStart(2,"0")}:00Z`)+6*36e5;
  for(let i=0;i<2;i++){let p=parts(g);let got=(Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/6e4+Number(p.hour)*60+Number(p.minute);g+=((h*60+(m||0))-got)*6e4}return g}
const clk=v=>v==null?"":new Date(v).toLocaleTimeString("en-US",{timeZone:"America/Chicago",hour:"numeric",minute:"2-digit"});
window.SHIFT_ctAt=ctAt;

const vehicles=()=>(window.SHIFT_vehicles||[]);
const vName=id=>{let v=vehicles().find(x=>Number(x.id)===Number(id));return v?v.name:"Truck #"+id};
const dName=id=>{let d=(drivers||[]).find(x=>Number(x.id)===Number(id));return d?d.name:"Driver #"+id};
const WORKING=new Set(["working","messenger"]);

/* ---------- schedule resolution ---------- */
let SWS=[];
window.SHIFT_v4switches=()=>SWS;
/* v4.1.0: a truck switch splits the driver's shift at switched_at (before = old truck, after = new truck). */
function applySwitches(date,out){
  for(const w of SWS.filter(x=>String(x.work_date).slice(0,10)===date&&x.active!==false)){
    const at=Date.parse(w.switched_at);
    const i=out.findIndex(s=>s.driverId===Number(w.driver_id)&&s.working&&(s.start!=null?(at>s.start&&at<s.end):true));
    if(i<0)continue;const s=out[i];
    const noT=s.start==null,a0=noT?ctAt(date,"00:00"):s.start,b1=noT?ctAt(addDays(date,1),"00:00"):s.end;
    const A={...s,start:a0,end:at,noTimes:noT,vehicleId:w.from_vehicle_id!=null?Number(w.from_vehicle_id):s.vehicleId,switchOut:w};
    const B={...s,start:at,end:b1,noTimes:noT,vehicleId:Number(w.to_vehicle_id),vehicleSource:"switch",switchIn:w};
    out.splice(i,1,A,B);
  }
  return out;
}
function shiftsFor(date){
  const dow=new Date(date+"T12:00:00Z").getUTCDay(),out=[];
  const span=(s,e)=>{if(!s||!e)return [null,null];let a=ctAt(date,s.slice(0,5)),b=ctAt(date,e.slice(0,5));if(b<=a)b=ctAt(addDays(date,1),e.slice(0,5));return [a,b]};
  for(const d of (drivers||[])){
    const row=SCHED2.find(r=>Number(r.driver_id)===Number(d.id)&&String(r.work_date).slice(0,10)===date)||null;
    const base=TS.filter(r=>Number(r.driver_id)===Number(d.id)&&r.active!==false&&(r.days||[]).map(Number).includes(dow));
    const ovT=row&&row.vehicle_id!=null&&row.vehicle_source!=="auto_gps"?Number(row.vehicle_id):null;
    const mk=(working,s,e,veh,src,sid,from)=>{let [a,b]=working?span(s,e):[null,null];return {driverId:Number(d.id),name:d.name,date,working,start:a,end:b,vehicleId:veh,vehicleSource:veh!=null?src:null,schedId:sid,from,row}};
    if(row){
      if(!WORKING.has(String(row.status||"working").toLowerCase())){out.push(mk(false,null,null,null,null,null,"override"));continue}
      if(row.start_time&&row.end_time){let bv=[...new Set(base.map(b=>b.vehicle_id).filter(x=>x!=null).map(Number))];out.push(mk(true,row.start_time,row.end_time,ovT??(bv.length===1?bv[0]:null),ovT!=null?"override":"weekly",base.length===1?base[0].id:null,"override"));continue}
      if(base.length){for(const b of base)out.push(mk(true,b.start_time,b.end_time,ovT??(b.vehicle_id!=null?Number(b.vehicle_id):null),ovT!=null?"override":"weekly",b.id,"override"));continue}
      out.push(mk(true,null,null,ovT,"override",null,"override"));continue;
    }
    if(!base.length){out.push(mk(false,null,null,null,null,null,"weekly"));continue}
    for(const b of base)out.push(mk(true,b.start_time,b.end_time,b.vehicle_id!=null?Number(b.vehicle_id):null,"weekly",b.id,"weekly"));
  }
  return applySwitches(date,out);
}
const clear=s=>s.working&&s.start!=null&&s.end!=null&&!s.noTimes;
function overl(a,b){let w=s=>s.start!=null&&!s.noTimes?[s.start,s.end]:[ctAt(s.date,"00:00"),ctAt(addDays(s.date,1),"00:00")];let [a0,a1]=w(a),[b0,b1]=w(b);return a0<b1&&b0<a1}
function truckOf(s,all){if(s.vehicleId==null)return null;if(s.vehicleSource==="weekly"&&all.some(o=>o.date===s.date&&o.driverId!==s.driverId&&o.working&&o.vehicleSource==="override"&&o.vehicleId===s.vehicleId&&overl(o,s)))return null;return s.vehicleId}
function around(date){return [...shiftsFor(addDays(date,-1)),...shiftsFor(date)]}
let SH=[];  // shifts of boardDate-1 and boardDate
function whoAt(v,t,shifts=SH){
  const c=shifts.filter(s=>clear(s)&&truckOf(s,shifts)===Number(v)&&t>=s.start&&t<s.end);
  if(c.length!==1)return null;
  const s=c[0];
  if(shifts.some(o=>o!==s&&o.driverId===s.driverId&&clear(o)&&o.vehicleId!=null&&truckOf(o,shifts)!==Number(v)&&t>=o.start&&t<o.end))return null;
  return s;
}
window.SHIFT_whoAt=(v,t)=>whoAt(v,typeof t==="number"?t:Date.parse(t));
function plannedTruckFor(driverId,date,t){
  const mine=SH.filter(s=>s.driverId===Number(driverId)&&s.date===date&&s.working&&s.vehicleId!=null);
  if(t!=null){let hit=[...new Set(mine.filter(s=>s.start!=null&&t>=s.start&&t<s.end).map(s=>truckOf(s,SH)).filter(x=>x!=null))];if(hit.length===1)return hit[0]}
  const vs=[...new Set(mine.map(s=>truckOf(s,SH)).filter(x=>x!=null))];return vs.length===1?vs[0]:null;
}
function conflicts(date,shifts){
  const cs=shifts.filter(s=>s.date===date&&clear(s)&&truckOf(s,shifts)!=null),out=[];
  for(let i=0;i<cs.length;i++)for(let j=i+1;j<cs.length;j++){let a=cs[i],b=cs[j],f=Math.max(a.start,b.start),t=Math.min(a.end,b.end);if(f>=t)continue;
    let va=truckOf(a,shifts),vb=truckOf(b,shifts);
    if(va===vb&&a.driverId!==b.driverId)out.push({kind:"truck",v:[va],d:[a.driverId,b.driverId],text:`${a.name} and ${b.name} overlap on ${vName(va)} ${clk(f)}–${clk(t)}`});
    else if(a.driverId===b.driverId&&va!==vb)out.push({kind:"driver",v:[va,vb],d:[a.driverId],text:`${a.name} is on ${vName(va)} and ${vName(vb)} ${clk(f)}–${clk(t)}`});}
  return out;
}
window.SHIFT_truckConflicts=(date)=>conflicts(date||boardDate,around(date||boardDate));
window.SHIFT_shiftsFor=shiftsFor;

/* ---------- task → truck ---------- */
const isMsg=t=>t.messenger_id!=null;
function taskTruck(t){
  if(isMsg(t))return null;
  if(t.vehicle_id!=null)return Number(t.vehicle_id);
  if(t.assigned_driver_id){let p=plannedTruckFor(t.assigned_driver_id,boardDate,t.scheduled_at?Date.parse(t.scheduled_at):null);if(p!=null)return p}
  if(t.gps_vehicle_id!=null&&t.status==="completed")return Number(t.gps_vehicle_id);
  return null;
}
window.SHIFT_taskTruck=taskTruck;

/* ---------- named places (nearest within its radius) ---------- */
function hav(a,b,c,d){const R=6371000,r=x=>x*Math.PI/180;let dl=r(c-a),dn=r(d-b),s=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(s))}
function placeFor(u){if(u.lat==null||u.lon==null)return null;let best=null;for(const p of NP){if(p.active===false)continue;let d=hav(u.lat,u.lon,p.lat,p.lon);if(d<=(p.radius_m||70)&&(!best||d<best.d))best={p,d}}return best?best.p:null}
window.SHIFT_placeFor=placeFor;
const stopName=u=>{let p=placeFor(u);return p?p.name:(u.location_name||u.address||"Unknown spot")};
window.SHIFT_stopName=stopName;

/* ---------- data ---------- */
async function fetchV4(){
  const prev=addDays(boardDate,-1);
  try{
    const [a,b,c,d,e]=await Promise.all([db.from("truck_schedules").select("*").order("id"),db.from("driver_schedule").select("*").gte("work_date",prev).lte("work_date",boardDate),db.from("named_places").select("*").order("id"),db.from("messengers").select("*").order("company"),db.from("truck_switches").select("*").eq("active",true).gte("work_date",prev).lte("work_date",boardDate).order("switched_at")]);
    TS_OK=!a.error;TS=a.error?[]:(a.data||[]);if(a.error)console.warn("truck_schedules unavailable",a.error);
    SCHED2=b.error?[]:(b.data||[]);NP=c.error?[]:(c.data||[]);MSG=d.error?[]:(d.data||[]);SWS=e.error?[]:(e.data||[]);
  }catch(e){console.warn("v4 data unavailable",e)}
}
window.SHIFT_fetchV4=fetchV4;
const origLoad=window.load;
window.load=async function(...a){await fetchV4();return origLoad.apply(this,a)};

/* ---------- cards ---------- */
const origCard=window.taskCard;
window.compactStatusControl=function(t){
  if(!t.assigned_driver_id&&t.vehicle_id==null&&!isMsg(t))return "";
  if(t.status==="completed")return `<span class="route-done">✓ Complete</span>`;
  if(isMsg(t)){
    if(t.status==="in_progress")return `<button class="status-next complete" onclick="event.stopPropagation();setTaskStatus(${t.id},'completed')">✓ Completed</button>`;
    return `<button class="status-next start" onclick="event.stopPropagation();setTaskStatus(${t.id},'in_progress')">→ In Progress</button>`;
  }
  if(t.status==="in_progress")return `<button class="status-next complete" onclick="event.stopPropagation();setTaskStatus(${t.id},'completed')">✓ Complete</button>`;
  return `<button class="status-next start" onclick="event.stopPropagation();setTaskStatus(${t.id},'in_progress')">Start Route</button>`;
};
window.taskCard=function(t){
  let html=origCard.apply(this,arguments);
  try{
    let tp=document.createElement("template");tp.innerHTML=html;let card=tp.content.querySelector(".task");if(!card)return html;
    let flags=card.querySelector(".route-flags"),acts=card.querySelector(".task-actions");
    if(!t.assigned_driver_id&&(t.vehicle_id!=null||isMsg(t))&&flags&&!flags.querySelector(".route-status")){let st=(t.status||"assigned").toLowerCase();flags.insertAdjacentHTML("beforeend",`<span class="route-status ${esc(st)}">${esc(st.replace("_"," "))}</span>`)}
    if(isMsg(t)){
      let m=MSG.find(x=>Number(x.id)===Number(t.messenger_id));
      let bits=[m?(m.company+(m.contact_name?" · "+m.contact_name:"")):"Messenger"];if(t.confirmation_number)bits.push("#"+t.confirmation_number);if(t.messenger_cost!=null)bits.push("$"+Number(t.messenger_cost).toFixed(2));
      flags&&flags.insertAdjacentHTML("afterend",`<div class="msg-badge" title="Messenger delivery — no truck, no GPS tracking; set the status by hand">🛵 ${esc(bits.join(" · "))}</div>`);
      if(acts&&t.status!=="completed")acts.insertAdjacentHTML("beforeend",`<button class="mini" type="button" onclick="event.stopPropagation();SHIFT_openMessenger(${t.id})" title="Change messenger, confirmation number or cost">🛵 Edit</button><button class="mini" type="button" onclick="event.stopPropagation();SHIFT_unMessenger(${t.id})" title="Take it back from the messenger (back to Ready to Assign)">↩</button>`);
    }else if(t.status!=="completed"&&!t.combined_into_task_id&&!t.assigned_driver_id&&t.vehicle_id==null&&acts){
      acts.insertAdjacentHTML("beforeend",`<button class="mini" type="button" onclick="event.stopPropagation();SHIFT_openMessenger(${t.id})" title="Assign to Messenger (no truck, no GPS tracking)">🛵 Messenger</button>`);
    }
    let v=taskTruck(t);
    if(v!=null&&!isMsg(t)&&t.status!=="completed"&&!t.combined_into_task_id){
      let sched=[...new Set(SH.filter(s=>s.date===boardDate&&s.working&&truckOf(s,SH)===v).map(s=>s.driverId))];
      let ids=[...new Set([...sched,...(t.assigned_driver_id?[Number(t.assigned_driver_id)]:[])])];
      let opts=`<option value="">— no driver —</option>`+ids.map(id=>`<option value="${id}" ${Number(t.assigned_driver_id)===id?"selected":""}>${esc(dName(id))}${sched.includes(id)?"":" (not on this truck's schedule)"}</option>`).join("")+`<option value="other">Other driver…</option>`;
      card.querySelector(".route-footer")?.insertAdjacentHTML("beforebegin",`<div class="task-driver-pick" onclick="event.stopPropagation()" title="Driver for this task (the driver app shows it to this driver)">👤 <select onchange="SHIFT_setTaskDriver(${t.id},this.value)">${opts}</select>${t.vehicle_id==null?' <span class="src-tag" title="No truck saved on this task yet — shown under the truck its driver is scheduled on. Drag it onto a truck to save it.">by schedule</span>':""}</div>`);
    }
    return tp.innerHTML;
  }catch(e){console.warn("v4 card",e);return html}
};
window.SHIFT_setTaskDriver=async function(id,val){
  if(val==="other"){let names=(drivers||[]).map(d=>d.id+" = "+d.name).join("\n");let x=prompt("Driver number:\n"+names);if(!x)return render();val=x.trim()}
  let did=val?Number(val):null;if(val&&!(drivers||[]).some(d=>Number(d.id)===did)){alert("Unknown driver");return render()}
  let t=tasks.find(x=>x.id===id),was=t?Number(t.assigned_driver_id||0):0;
  let r=await db.from("dispatch_tasks").update({assigned_driver_id:did}).eq("id",id);
  if(r.error)return alert("Could not set the driver: "+r.error.message);
  await load();if(did&&was!==did&&typeof SHIFT_onAssigned==="function")SHIFT_onAssigned(id,did);
};

function liveBits(v){
  let i=typeof SHIFT_liveInfo==="function"?SHIFT_liveInfo(v):null;
  if(!i)return {chip:"",addr:""};
  return {chip:`<span class="live-chip ${i.cls}" title="${esc(i.tip)}">${esc(i.text)}</span>`,addr:i.address||""};
}
function stopsFor(v){
  let all=(typeof SHIFT_unplanned==="function"?SHIFT_unplanned():[])||[];
  return all.filter(u=>Number(u.vehicle_id)===Number(v)).sort((a,b)=>Date.parse(a.arrived_at)-Date.parse(b.arrived_at));
}
function stopRow(u){
  let p=placeFor(u),name=p?p.name:(u.location_name||u.address||"Unknown spot");
  let time=clk(u.arrived_at)+(u.departed_at?"–"+clk(u.departed_at):" – still there");
  let who=whoAt(u.vehicle_id,Date.parse(u.arrived_at));
  let sub=[];
  if((p||u.location_name)&&u.address)sub.push(u.address);
  let m=[];if(u.engine_off_minutes!=null)m.push(u.engine_off_minutes+" min engine off");if(u.idle_minutes)m.push(u.idle_minutes+" min idle");if(m.length)sub.push(m.join(", "));
  if(u.review_status==="ignored")sub.push("marked ignored earlier");
  let drv=who?`👤 ${esc(who.name)}`:`<span class="ts-unknown" title="No driver was clearly scheduled on this truck at ${esc(clk(u.arrived_at))} (Truck Schedule / Daily Overrides)">👤 Driver unknown</span>`;
  return `<div class="ts-row" data-up="${u.id}"><span class="ts-name">📍 ${esc(name)}<button type="button" class="mini ts-edit" onclick="SHIFT_editPlaceName(${u.id})" title="Edit location name — saved for the whole team; every truck's visit within ${p?p.radius_m:70} m shows it">✎ Edit location name</button></span><span class="ts-time">${esc(time)}</span><div class="ts-sub">${drv}${sub.length?" · "+esc(sub.join(" · ")):""}</div></div>`;
}
const isToday=()=>boardDate===ymd(new Date());
function truckCard(v){
  const vid=Number(v.id),now=Date.now();
  let mine=tasks.filter(t=>!t.combined_into_task_id||true).filter(t=>taskTruck(t)===vid&&!isMsg(t));
  let active=mine.filter(t=>t.status!=="completed").sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  let done=mine.filter(t=>t.status==="completed").sort((a,b)=>new Date(b.completed_at||0)-new Date(a.completed_at||0));
  let shifts=SH.filter(s=>s.working&&truckOf(s,SH)===vid&&(s.date===boardDate||(s.start!=null&&s.end>ctAt(boardDate,"00:00")))).sort((a,b)=>(a.start??0)-(b.start??0));
  let chips=shifts.map(s=>{let on=isToday()&&s.start!=null&&now>=s.start&&now<s.end;let t=s.noTimes?(s.switchIn?"from "+clk(s.start):"until "+clk(s.end)):s.start!=null?`${clk(s.start)}–${clk(s.end)}`:"no shift times";
    let tag=s.date!==boardDate?` (${DOW[new Date(s.date+"T12:00:00Z").getUTCDay()]} shift)`:"";let src=s.vehicleSource==="override"?" · today only":"";
    let swb=on&&isToday()&&!s.switchOut?`<button type="button" class="mini tdrv-sw" onclick="event.stopPropagation();SHIFT_openSwitch(${s.driverId},${vid})" title="${esc(s.name)} is changing trucks — move their open tasks to the new truck">⇄ Switch truck</button>`:"";
    return `<span class="tdrv ${on?"on":""}" title="${esc(s.name+": "+t+tag+(s.vehicleSource==="override"?" — Daily Override":s.vehicleSource==="switch"?" — truck switch":" — Truck Schedule")+(on?" — on shift now":""))}">${esc(s.name)} <span class="tdrv-t">${esc(t)}${esc(tag)}${esc(src)}</span>${swb}</span>`}).join("")||`<span class="tdrv none" onclick="openDriverSchedule()" title="No driver scheduled on this truck for this date — set it in Driver Schedule → Truck Schedule">No driver scheduled</span>`;
  let cf=conflicts(boardDate,SH).filter(c=>c.v.includes(vid)).map(c=>`<div class="truck-conflict" title="Two schedules overlap — stops in this time show Driver unknown until it is fixed (Driver Schedule)">⚠ ${esc(c.text)}</div>`).join("");
  let swn=SWS.filter(w=>String(w.work_date).slice(0,10)===boardDate&&(Number(w.to_vehicle_id)===vid||Number(w.from_vehicle_id)===vid)).map(w=>{let into=Number(w.to_vehicle_id)===vid;let n=(w.moved_task_ids||[]).length;
    return `<div class="truck-switch-note" title="${esc(n+" open task(s) moved"+(w.note?" — "+w.note:""))}"><span>⇄ ${esc(dName(Number(w.driver_id)))} ${into?"switched here from "+esc(vName(Number(w.from_vehicle_id)))+" at "+clk(w.switched_at):"switched to "+esc(vName(Number(w.to_vehicle_id)))+" at "+clk(w.switched_at)}</span>${into?`<button type="button" class="mini" onclick="SHIFT_undoSwitch(${w.id})" title="Undo this switch (moved tasks that are still open go back)">Undo</button>`:""}</div>`}).join("");
  let lb=liveBits(vid);
  let nProg=active.filter(t=>t.status==="in_progress").length,nAssigned=active.length-nProg,nWaiting=active.filter(t=>t.scheduled_at&&new Date(t.scheduled_at).getTime()<now).length;
  let stats=`<div class="driver-live"><span>${nAssigned?nAssigned+" assigned":""}</span><span class="lv-prog">${nProg?nProg+" in prog.":""}</span><span class="${nWaiting?"lv-wait":""}" title="Scheduled time has passed and the task is not Done">${nWaiting?nWaiting+" waiting on Done":""}</span></div>`;
  if(!active.length)stats="";
  let onNow=shifts.find(s=>isToday()&&s.start!=null&&now>=s.start&&now<s.end);
  let ts=onNow&&typeof SHIFT_tsDriverLines==="function"?SHIFT_tsDriverLines({id:onNow.driverId,name:onNow.name}):"";
  let foldKey="v"+vid,foldOpen=(window.SHIFT_openFolds||{})[foldKey]?"open":"";
  let fold=done.length?`<details class="done-fold" ${foldOpen} ontoggle="(window.SHIFT_openFolds=window.SHIFT_openFolds||{})['${foldKey}']=this.open"><summary>✓ ${done.length} done today</summary>${done.map(taskCard).join("")}</details>`:"";
  let ups=stopsFor(vid);
  let sk="s"+vid,sOpen=(window.SHIFT_openFolds||{})[sk]?"open":"";
  let upHtml=ups.length?`<details class="truck-stops" ${sOpen} ontoggle="(window.SHIFT_openFolds=window.SHIFT_openFolds||{})['${sk}']=this.open" title="Stops detected automatically from Verizon GPS that are not on any task. Recorded automatically; they never count toward completion."><summary>📍 ${ups.length} detected stop${ups.length>1?"s":""} · last ${esc(stopName(ups[ups.length-1]))} ${esc(clk(ups[ups.length-1].arrived_at))} <span class="muted">(tap to show)</span></summary>${ups.map(stopRow).join("")}</details>`:"";
  return `<section class="driver truck-card" data-vehicle="${vid}"><div class="driver-head"><div><span class="driver-name truck-name">🚛 ${esc(v.name)}</span> ${lb.chip}${lb.addr?`<div class="truck-loc" title="${esc(lb.addr)}">📍 ${esc(lb.addr)}</div>`:""}</div><div class="driver-head-tools"><span class="count" title="Active / total today">${active.length}${done.length?"/"+mine.length:""}</span></div></div><div class="truck-drivers">${chips}</div>${swn}${cf}${ts}${stats}<div class="driver-routes" data-truck="${vid}" data-drop-truck="${vid}">${active.length?active.map(taskCard).join(""):`<div class="empty">${done.length?"All done · drop a task here":"Drop a task here"}</div>`}${fold}</div>${upHtml}</section>`;
}
function crewStrip(){
  let dsToday=SH.filter(s=>s.date===boardDate);
  let ids=[...new Set((drivers||[]).filter(d=>typeof driverVisibleOnBoard!=="function"||driverVisibleOnBoard(d)).map(d=>Number(d.id)))];
  let chips=ids.map(id=>{
    let d=(drivers||[]).find(x=>Number(x.id)===id);if(!d)return "";
    let sch=effectiveDriverSchedule(id),my=dsToday.filter(s=>s.driverId===id&&s.working);
    let trucks=[...new Set(my.map(s=>truckOf(s,SH)).filter(x=>x!=null))];
    let times=[...new Set(my.filter(s=>s.start!=null&&!s.noTimes).map(s=>`${clk(s.start)}–${clk(s.end)}`))].join(", ");
    let sub=[trucks.length?trucks.map(vName).join(" → "):"no truck",times].filter(Boolean).join(" · ");
    let sel=`<select class="quick-availability" title="Driver status for this date (Daily Overrides)" onclick="event.stopPropagation()" onchange="quickAvailability(${id},this.value)">${[["working","Working"],["pto","PTO"],["call_off","Call Off"],["off","Off"],["messenger","Messenger"]].map(([k,l])=>`<option value="${k}" ${sch.status===k?"selected":""}>${l}</option>`).join("")}</select>`;
    let note=(typeof driverNotesFor==="function"?driverNotesFor(d):[]).map(n=>n.note).concat(sch.note?[sch.note]:[]);
    return `<span class="crew-chip ${my.length?"":"off"}" data-driver="${id}" data-drop-driver="${id}" title="${esc((note.length?"📝 "+note.join(" · ")+"\n":"")+"Drop a task here to give it to "+d.name+" without choosing a truck")}"><b>${esc(d.name)}</b>${note.length?"📝":""}<span class="crew-sub">${esc(sub)}</span>${sel}</span>`;
  }).join("");
  return `<div class="crew-strip"><span class="crew-title">👥 Today's crew</span>${chips||'<span class="muted">No drivers on the board for this date.</span>'}<button class="mini" type="button" onclick="openDriverSchedule();setTimeout(()=>SHIFT_showTruckTab&&SHIFT_showTruckTab(),60)" title="Who drives which truck, which days and hours">🚛 Truck Schedule</button></div>`;
}
/* tasks that have a driver but no truck (driver has no truck scheduled) — only shown when there are some */
function unassignedCard(){
  let noTruck=tasks.filter(t=>t.assigned_driver_id&&!isMsg(t)&&taskTruck(t)==null&&!t.combined_into_task_id);
  if(!noTruck.length)return "";
  let by={};noTruck.forEach(t=>(by[t.assigned_driver_id]=by[t.assigned_driver_id]||[]).push(t));
  let rows=Object.keys(by).map(id=>`<div class="ua-driver"><div class="ua-top"><b>${esc(dName(Number(id)))}</b><span class="muted" style="font-size:11px">no truck scheduled — drag onto a truck</span></div><div class="driver-routes" data-driver="${id}" data-drop-driver="${id}">${by[id].map(taskCard).join("")}</div></div>`).join("");
  return `<section class="driver unassigned-card"><div class="driver-head"><div><span class="driver-name">Driver, no truck yet</span><div class="driver-availability">These tasks have a driver but no truck. Drag each onto a truck.</div></div><div class="driver-head-tools"><span class="count">${noTruck.length}</span></div></div>${rows}</section>`;
}
function messengersCard(){
  let mt=tasks.filter(isMsg).filter(t=>!t.combined_into_task_id);
  let active=mt.filter(t=>t.status!=="completed"),done=mt.filter(t=>t.status==="completed");
  let fold=done.length?`<details class="done-fold"><summary>✓ ${done.length} done today</summary>${done.map(taskCard).join("")}</details>`:"";
  return `<section class="driver messenger-card"><div class="driver-head"><div><span class="driver-name">Messengers</span><div class="driver-availability">No truck schedule · no GPS tracking · status set by hand</div></div><div class="driver-head-tools"><span class="count">${active.length}${done.length?"/"+mt.length:""}</span></div></div><div class="driver-routes" data-messenger="1" data-drop-messenger="1">${active.length?active.map(taskCard).join(""):'<div class="empty">Drop a task here (or use 🛵 Messenger on a card)</div>'}${fold}</div></section>`;
}

window.render=function(){
  SH=around(boardDate);
  let free=t=>!t.assigned_driver_id&&t.vehicle_id==null&&!isMsg(t);
  let brain=tasks.filter(t=>free(t)&&(t.planning_stage||"ready")==="brainstorm"),ready=tasks.filter(t=>free(t)&&(t.planning_stage||"ready")!=="brainstorm");
  $("brainstorm").innerHTML=brain.length?brain.map(taskCard).join(""):'<div class="empty">Drop ideas here<br>Details can be incomplete.</div>';
  $("ready").innerHTML=ready.length?ready.map(taskCard).join(""):'<div class="empty">Drag planned work here<br>when it is ready to dispatch.</div>';
  $("brainCount").textContent=brain.length;$("readyCount").textContent=ready.length;
  let vs=vehicles().filter(v=>v.active!==false).slice().sort((a,b)=>Number(a.id)-Number(b.id));
  $("drivers").innerHTML=crewStrip()+unassignedCard()+vs.map(truckCard).join("")+messengersCard();
  ["fleetStrip","unplannedStrip","assignStrip"].forEach(id=>{let e=$(id);if(e)e.remove()});
  try{updateMetrics()}catch(_){}
  bindDrag();
};
window.updateMetrics=function(){let today=allTasks.filter(t=>!t.scheduled_at||ymd(t.scheduled_at)===ymd(new Date()));let on=t=>t.assigned_driver_id||t.vehicle_id!=null||isMsg(t);let completed=today.filter(t=>t.status==="completed").length;let active=today.filter(t=>on(t)&&t.status!=="completed").length;let assigned=new Set(today.filter(t=>on(t)&&t.status!=="completed").map(t=>isMsg(t)?"m"+t.messenger_id:t.vehicle_id!=null?"v"+t.vehicle_id:"d"+t.assigned_driver_id)).size;$("mActive").textContent=active;$("mDrivers").textContent=assigned;$("mTasks").textContent=today.length;$("mRate").textContent=today.length?Math.round(completed/today.length*100)+"%":"0%"};

/* ---------- drag & drop ---------- */
window.bindDrag=function(){
  document.querySelectorAll(".task").forEach(el=>{el.ondragstart=()=>{dragId=Number(el.dataset.id);el.classList.add("dragging")};el.ondragend=()=>{el.classList.remove("dragging");document.querySelectorAll(".over").forEach(x=>x.classList.remove("over"))}});
  document.querySelectorAll(".dropzone,.driver-routes,.crew-chip[data-driver]").forEach(z=>{z.ondragover=e=>{e.preventDefault();z.classList.add("over")};z.ondragleave=()=>z.classList.remove("over");z.ondrop=async e=>{e.preventDefault();z.classList.remove("over");if(!dragId)return;let target=e.target.closest(".task"),before=target?Number(target.dataset.id):null;await dropOn(z,dragId,before)}});
};
async function dropOn(z,id,before){
  if(z.dataset.truck)return moveTruck(id,Number(z.dataset.truck),before);
  if(z.dataset.messenger)return SHIFT_openMessenger(id);
  if(z.dataset.driver){let t=tasks.find(x=>x.id===id);if(t&&(t.vehicle_id!=null||isMsg(t))){let r=await db.from("dispatch_tasks").update({vehicle_id:null,messenger_id:null}).eq("id",id);if(r.error)return alert("Could not move: "+r.error.message)}return moveDriver(id,Number(z.dataset.driver),before)}
  if(z.dataset.stage){let t=tasks.find(x=>x.id===id);if(t&&(t.vehicle_id!=null||isMsg(t))){let r=await db.from("dispatch_tasks").update({vehicle_id:null,messenger_id:null}).eq("id",id);if(r.error)return alert("Could not move: "+r.error.message)}return moveStage(id,z.dataset.stage,before)}
}
window.SHIFT_dropOn=dropOn;
/** driver for a task put on truck v: keep its driver if scheduled on v that day; else the one on v at the task time / now; else the only driver on v. */
function driverForTruck(t,v){
  let on=SH.filter(s=>s.date===boardDate&&s.working&&truckOf(s,SH)===v);
  let ids=[...new Set(on.map(s=>s.driverId))];
  if(t.assigned_driver_id&&ids.includes(Number(t.assigned_driver_id)))return Number(t.assigned_driver_id);
  let at=t.scheduled_at?Date.parse(t.scheduled_at):(isToday()?Date.now():null);
  if(at!=null){let w=whoAt(v,at);if(w&&w.date===boardDate)return w.driverId;
    let next=on.filter(s=>s.start!=null&&s.end>at).sort((a,b)=>a.start-b.start)[0];if(next&&!t.scheduled_at)return next.driverId}
  if(ids.length===1)return ids[0];
  return t.assigned_driver_id?Number(t.assigned_driver_id):null;
}
/* v4.1.0: truck is driving right now = Verizon says Moving, report <= 10 min old, board shows today */
const MOVING_FRESH_MS=10*60*1000;
function truckMovingNow(v){
  if(!isToday())return false;
  let x=typeof SHIFT_liveRow==="function"?SHIFT_liveRow(v):null;if(!x||x.state!=="Moving")return false;
  let rep=x.reported_at?Date.parse(x.reported_at):NaN;return Number.isFinite(rep)&&Date.now()-rep<=MOVING_FRESH_MS;
}
window.SHIFT_truckMovingNow=truckMovingNow;
async function moveTruck(id,v,before){
  let t=tasks.find(x=>x.id===id);if(!t)return;
  const goLive=truckMovingNow(v)&&t.status!=="completed";
  let was=Number(t.assigned_driver_id||0),drv=driverForTruck(t,v);
  let list=tasks.filter(x=>x.id!==id&&taskTruck(x)===v&&!isMsg(x)&&x.status!=="completed").sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  let idx=before?list.findIndex(x=>x.id===before):list.length;if(idx<0)idx=list.length;list.splice(idx,0,t);
  for(let i=0;i<list.length;i++){
    let x=list[i],patch={sort_order:i};
    if(x.id===id)Object.assign(patch,{vehicle_id:v,messenger_id:null,assigned_driver_id:drv,planning_stage:"assigned",status:(x.status==="in_progress"||goLive)?"in_progress":"assigned"});
    let r=await db.from("dispatch_tasks").update(patch).eq("id",x.id);if(r.error){alert("Could not assign: "+r.error.message);break}
  }
  await load();
  if(goLive&&t.status!=="in_progress")toast(`${vName(v)} is driving now — task set to In Progress`);
  if(drv&&was!==drv&&typeof SHIFT_onAssigned==="function")SHIFT_onAssigned(id,drv);
}
window.SHIFT_moveTruck=moveTruck;
function toast(msg){let e=document.createElement("div");e.textContent=msg;e.style.cssText="position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#0f2a1f;color:#7ee2a8;border:1px solid #1f6b45;border-radius:10px;padding:8px 14px;font-weight:800;font-size:13px;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.35)";document.body.appendChild(e);setTimeout(()=>e.remove(),4500)}

/* ---------- v4.1.0: mid-day truck switch ---------- */
function swModal(){
  let m=$("swModal");if(m)return m;
  m=document.createElement("div");m.id="swModal";m.className="modal";
  m.innerHTML=`<div class="dialog msg-dialog" onclick="event.stopPropagation()"><h3 style="margin:0 0 6px">⇄ Switch truck</h3><div class="muted" id="swLabel" style="font-size:12px"></div>
  <label for="swTo">New truck</label><select id="swTo" onchange="SHIFT_swCheck()"></select>
  <label for="swAt">Switched at (CT)</label><input id="swAt" type="time" onchange="SHIFT_swCheck()">
  <div id="swTasks" style="font-size:12px;margin-top:8px"></div><div id="swWarn" class="ts-flags"></div>
  <label for="swNote">Note (optional)</label><input id="swNote" placeholder="e.g. Big Gray flat tire">
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button type="button" class="mini" onclick="SHIFT_closeSwitch()">Cancel</button><button type="button" class="btn primary" onclick="SHIFT_saveSwitch()">Switch</button></div><input type="hidden" id="swDrv"><input type="hidden" id="swFrom"></div>`;
  m.onclick=()=>SHIFT_closeSwitch();document.body.appendChild(m);return m;
}
const swOpenTasks=(d,from)=>tasks.filter(t=>!isMsg(t)&&t.status!=="completed"&&!t.combined_into_task_id&&Number(t.assigned_driver_id)===d&&taskTruck(t)===from);
window.SHIFT_openSwitch=function(d,from){
  let m=swModal();$("swDrv").value=d;$("swFrom").value=from;
  $("swLabel").textContent=`${dName(d)} is leaving ${vName(from)}.`;
  $("swTo").innerHTML=vehicles().filter(v=>v.active!==false&&Number(v.id)!==from).map(v=>`<option value="${v.id}">${esc(v.name)}</option>`).join("");
  let p=parts(Date.now());$("swAt").value=`${p.hour}:${p.minute}`;$("swNote").value="";SHIFT_swCheck();m.classList.add("show");
};
window.SHIFT_closeSwitch=function(){let m=$("swModal");if(m)m.classList.remove("show")};
window.SHIFT_swCheck=function(){
  let d=Number($("swDrv").value),from=Number($("swFrom").value),to=Number($("swTo").value),at=ctAt(boardDate,$("swAt").value||"00:00");
  let ts=swOpenTasks(d,from);
  $("swTasks").innerHTML=ts.length?`<b>${ts.length} open task${ts.length>1?"s":""} will move to the new truck:</b><br>`+ts.map(t=>"• "+esc((t.pickup_name||"")+" → "+(t.delivery_name||""))).join("<br>")+`<div class="muted">Completed tasks and stops already made stay on ${esc(vName(from))}.</div>`:`<span class="muted">No open tasks to move. Completed tasks and stops stay on ${esc(vName(from))}.</span>`;
  let others=SH.filter(s=>s.date===boardDate&&clear(s)&&s.driverId!==d&&truckOf(s,SH)===to&&s.end>at);
  $("swWarn").textContent=others.length?"⚠ "+others.map(s=>`${s.name} is also scheduled on ${vName(to)} ${clk(s.start)}–${clk(s.end)}`).join("; ")+". You can still switch; the board will show an overlap warning and stops in the overlap show Driver unknown until the schedule is fixed.":"";
};
window.SHIFT_saveSwitch=async function(){
  let d=Number($("swDrv").value),from=Number($("swFrom").value),to=Number($("swTo").value);
  if(!to||!$("swAt").value)return alert("Pick the new truck and the time.");
  let at=ctAt(boardDate,$("swAt").value),ts=swOpenTasks(d,from);
  let r=await db.from("truck_switches").insert({work_date:boardDate,driver_id:d,from_vehicle_id:from,to_vehicle_id:to,switched_at:new Date(at).toISOString(),moved_task_ids:ts.map(t=>t.id),note:$("swNote").value.trim()||null,created_by:"dashboard"});
  if(r.error)return alert("Could not save the switch: "+r.error.message);
  for(const t of ts){let u=await db.from("dispatch_tasks").update({vehicle_id:to}).eq("id",t.id);if(u.error){alert("Switch saved, but a task did not move: "+u.error.message);break}}
  SHIFT_closeSwitch();await load();toast(`${dName(d)} switched to ${vName(to)} at ${clk(at)}`);
};
window.SHIFT_undoSwitch=async function(id){
  let w=SWS.find(x=>Number(x.id)===Number(id));if(!w)return;
  if(!confirm(`Undo ${dName(Number(w.driver_id))}'s switch to ${vName(Number(w.to_vehicle_id))}? Moved tasks that are still open go back to ${vName(Number(w.from_vehicle_id))}.`))return;
  let r=await db.from("truck_switches").update({active:false}).eq("id",id);if(r.error)return alert("Could not undo: "+r.error.message);
  for(const tid of (w.moved_task_ids||[])){let t=tasks.find(x=>x.id===Number(tid));if(t&&t.status!=="completed"&&Number(t.vehicle_id)===Number(w.to_vehicle_id))await db.from("dispatch_tasks").update({vehicle_id:w.from_vehicle_id}).eq("id",t.id)}
  await load();
};
/* touch drag (index.html tdEnd only knows drivers/stages): handle truck + messenger targets first */
document.addEventListener("touchend",async e=>{
  if(typeof touchDrag==="undefined"||!touchDrag||!touchDrag.active)return;
  const t=e.changedTouches&&e.changedTouches[0];let z=t&&document.elementFromPoint(t.clientX,t.clientY);
  let zz=z&&z.closest("[data-drop-truck],[data-drop-messenger]");if(!zz)return;
  e.stopImmediatePropagation();
  const id=touchDrag.id,before=z.closest(".task[data-id]")?Number(z.closest(".task[data-id]").dataset.id):null;
  if(touchDrag.ghost)touchDrag.ghost.remove();try{tdClear()}catch(_){}touchDrag=null;
  try{await dropOn({dataset:{truck:zz.dataset.dropTruck,messenger:zz.dataset.dropMessenger}},id,before)}catch(err){console.error(err);alert("Could not move the task. Please try again.")}
},{capture:true,passive:true});

/* ---------- Assign to Messenger ---------- */
function msgModal(){
  let m=$("msgModal");if(m)return m;
  m=document.createElement("div");m.id="msgModal";m.className="modal";
  m.innerHTML=`<div class="dialog msg-dialog" onclick="event.stopPropagation()"><h3 style="margin:0 0 6px">🛵 Assign to Messenger</h3><div class="muted" id="msgTaskLabel" style="font-size:12px"></div>
  <label for="msgPick">Messenger</label><select id="msgPick" onchange="SHIFT_msgPickChanged()"></select>
  <div id="msgNew" style="display:none"><label for="msgCompany">Company</label><input id="msgCompany" placeholder="e.g. Quick Delivery"><label for="msgName">Name (optional)</label><input id="msgName" placeholder="Contact or courier name"><label for="msgPhone">Phone (optional)</label><input id="msgPhone"></div>
  <label for="msgConf">Confirmation number (optional)</label><input id="msgConf" autocomplete="off">
  <label for="msgCost">Cost (optional, $)</label><input id="msgCost" type="number" min="0" step="0.01" inputmode="decimal">
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button type="button" class="mini" onclick="SHIFT_closeMessenger()">Cancel</button><button type="button" class="btn primary" id="msgSave" onclick="SHIFT_saveMessenger()">Assign</button></div><input type="hidden" id="msgTaskId"></div>`;
  m.onclick=()=>SHIFT_closeMessenger();document.body.appendChild(m);return m;
}
window.SHIFT_msgPickChanged=function(){$("msgNew").style.display=$("msgPick").value==="new"?"block":"none"};
window.SHIFT_openMessenger=function(id){
  let t=tasks.find(x=>x.id===id)||allTasks.find(x=>x.id===id);if(!t)return;
  let m=msgModal();$("msgTaskId").value=id;$("msgTaskLabel").textContent=`${t.pickup_name||""} → ${t.delivery_name||""}`;
  let act=MSG.filter(x=>x.active!==false||Number(x.id)===Number(t.messenger_id));
  $("msgPick").innerHTML=act.map(x=>`<option value="${x.id}">${esc(x.company)}${x.contact_name?" · "+esc(x.contact_name):""}</option>`).join("")+`<option value="new">+ New messenger…</option>`;
  $("msgPick").value=t.messenger_id!=null?String(t.messenger_id):(act.length?String(act[0].id):"new");
  $("msgConf").value=t.confirmation_number||"";$("msgCost").value=t.messenger_cost??"";$("msgCompany").value="";$("msgName").value="";$("msgPhone").value="";
  $("msgSave").textContent=isMsg(t)?"Save":"Assign";SHIFT_msgPickChanged();m.classList.add("show");
};
window.SHIFT_closeMessenger=function(){let m=$("msgModal");if(m)m.classList.remove("show")};
window.SHIFT_saveMessenger=async function(){
  let id=Number($("msgTaskId").value),t=tasks.find(x=>x.id===id)||allTasks.find(x=>x.id===id);if(!t)return;
  let mid=$("msgPick").value;
  if(mid==="new"){let company=$("msgCompany").value.trim();if(!company)return alert("Enter the messenger company.");
    let r=await db.from("messengers").insert({company,contact_name:$("msgName").value.trim()||null,phone:$("msgPhone").value.trim()||null}).select("id").single();
    if(r.error)return alert("Could not save the messenger: "+r.error.message);mid=r.data.id}
  let cost=$("msgCost").value.trim();if(cost&&!(Number(cost)>=0))return alert("Cost must be a number.");
  let patch={messenger_id:Number(mid),confirmation_number:$("msgConf").value.trim()||null,messenger_cost:cost?Math.round(Number(cost)*100)/100:null};
  if(!isMsg(t))Object.assign(patch,{vehicle_id:null,assigned_driver_id:null,planning_stage:"assigned",status:t.status==="in_progress"?"in_progress":"assigned"});
  let r=await db.from("dispatch_tasks").update(patch).eq("id",id);
  if(r.error)return alert("Could not assign to the messenger: "+r.error.message);
  SHIFT_closeMessenger();await load();
};
window.SHIFT_unMessenger=async function(id){
  if(!confirm("Take this task back from the messenger? It goes back to Ready to Assign (confirmation number and cost are kept)."))return;
  let r=await db.from("dispatch_tasks").update({messenger_id:null,planning_stage:"ready",status:"pending",completed_at:null}).eq("id",id);
  if(r.error)return alert("Could not update: "+r.error.message);await load();
};

/* ---------- Edit location name (named_places, team-wide) ---------- */
window.SHIFT_editPlaceName=async function(upId){
  let u=((typeof SHIFT_unplanned==="function"?SHIFT_unplanned():[])||[]).find(x=>Number(x.id)===Number(upId));if(!u)return;
  if(u.lat==null||u.lon==null)return alert("This stop has no GPS position, so it can't be named.");
  let p=placeFor(u),cur=p?p.name:(u.location_name||"");
  let name=prompt(`Location name for everyone (any truck stopping within ${p?p.radius_m:70} m will show it).\nVerizon address stays: ${u.address||"—"}`,cur);
  if(name==null)return;name=name.trim();if(!name)return alert("Enter a name.");
  let r;
  if(p)r=await db.from("named_places").update({name,updated_at:new Date().toISOString()}).eq("id",p.id).select("*").single();
  else r=await db.from("named_places").insert({name,lat:u.lat,lon:u.lon,radius_m:70,address:u.address||null,created_by:"dashboard"}).select("*").single();
  if(r.error)return alert("Could not save the name: "+r.error.message);
  let i=NP.findIndex(x=>x.id===r.data.id);if(i>=0)NP[i]=r.data;else NP.push(r.data);
  render();
};

/* ---------- Truck Schedule tab (Driver Schedule dialog) ---------- */
let TSE=[];   // editor rows (copies)
function tsEditorHtml(){
  let dOpts=sel=>(drivers||[]).map(d=>`<option value="${d.id}" ${Number(sel)===Number(d.id)?"selected":""}>${esc(d.name)}</option>`).join("");
  let vOpts=sel=>`<option value="">— no truck —</option>`+vehicles().map(v=>`<option value="${v.id}" ${Number(sel)===Number(v.id)&&sel!=null?"selected":""}>${esc(v.name)}</option>`).join("");
  let rows=TSE.filter(r=>!r._deleted).map((r,i)=>`<div class="ts-editor-row" data-k="${r._k}">
    <select class="tse-driver" title="Driver">${dOpts(r.driver_id)}</select><select class="tse-truck" title="Truck">${vOpts(r.vehicle_id)}</select>
    <div class="ts-days">${[0,1,2,3,4,5,6].map(d=>`<label><input type="checkbox" class="tse-day" value="${d}" ${(r.days||[]).map(Number).includes(d)?"checked":""}>${DOW[d]}</label>`).join("")}</div>
    <input type="time" class="tse-start" value="${(r.start_time||"").slice(0,5)}" title="Shift start (CT)"><input type="time" class="tse-end" value="${(r.end_time||"").slice(0,5)}" title="Shift end (CT) — earlier than start = ends next day">
    <label style="font-size:11px;display:flex;gap:3px;align-items:center" title="Inactive rows are kept but ignored"><input type="checkbox" class="tse-active" ${r.active!==false?"checked":""} style="width:auto">on</label>
    <button type="button" class="mini danger" onclick="SHIFT_tseRemove('${r._k}')" title="Remove this shift">✕</button></div>`).join("");
  return `<div class="muted" style="font-size:12px;margin-bottom:6px">Recurring shifts: driver, truck, working days, start and end (CT). A shift that ends after midnight belongs to its start day. Several drivers can share a truck on different shifts. Daily Overrides (coverage, absences, truck changes) still win for their date. Changing a schedule never moves tasks that already have a truck.</div>
  <div id="tseFlags"></div>${rows||'<div class="empty">No shifts yet.</div>'}
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button type="button" class="mini" onclick="SHIFT_tseAdd()">+ Add shift</button><button type="button" class="btn primary" onclick="SHIFT_tseSave()">Save Truck Schedule</button><span id="tseSaved" class="truck-saved"></span></div>`;
}
function tseRead(){
  document.querySelectorAll("#truckSchedulePanel .ts-editor-row").forEach(el=>{let r=TSE.find(x=>x._k===el.dataset.k);if(!r)return;
    r.driver_id=Number(el.querySelector(".tse-driver").value);r.vehicle_id=el.querySelector(".tse-truck").value?Number(el.querySelector(".tse-truck").value):null;
    r.days=[...el.querySelectorAll(".tse-day:checked")].map(x=>Number(x.value));r.start_time=el.querySelector(".tse-start").value||null;r.end_time=el.querySelector(".tse-end").value||null;r.active=el.querySelector(".tse-active").checked});
}
function tseFlags(){
  let flags=[],gaps=[];
  let live=TSE.filter(r=>!r._deleted&&r.active!==false);
  for(let d=0;d<7;d++){let rs=live.filter(r=>(r.days||[]).includes(d)&&r.start_time&&r.end_time);
    let m=s=>{let [h,mm]=s.split(":").map(Number);return h*60+mm},span=r=>{let a=m(r.start_time),b=m(r.end_time);if(b<=a)b+=1440;return [a,b]};
    for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){let a=rs[i],b=rs[j],[a0,a1]=span(a),[b0,b1]=span(b);if(!(a0<b1&&b0<a1))continue;
      if(a.vehicle_id!=null&&a.vehicle_id===b.vehicle_id&&a.driver_id!==b.driver_id)flags.push(`${DOW[d]}: ${dName(a.driver_id)} and ${dName(b.driver_id)} overlap on ${vName(a.vehicle_id)}`);
      else if(a.driver_id===b.driver_id&&a.vehicle_id!=null&&b.vehicle_id!=null&&a.vehicle_id!==b.vehicle_id)flags.push(`${DOW[d]}: ${dName(a.driver_id)} is on ${vName(a.vehicle_id)} and ${vName(b.vehicle_id)} at the same time`)}}
  live.forEach(r=>{if(!r.start_time||!r.end_time)gaps.push(`${dName(r.driver_id)}: missing shift ${!r.start_time?"start":"end"} time`);if(r.vehicle_id==null)gaps.push(`${dName(r.driver_id)} (${(r.days||[]).map(d=>DOW[d]).join(" ")}): no truck`);if(!(r.days||[]).length)gaps.push(`${dName(r.driver_id)}: no working days ticked`)});
  let el=$("tseFlags");if(el)el.innerHTML=flags.map(f=>`<div class="ts-flags">⚠ ${esc(f)}</div>`).join("")+gaps.map(g=>`<div class="ts-gap">• ${esc(g)}</div>`).join("");
  return flags;
}
let tseK=0;
function tseRender(){let p=$("truckSchedulePanel");if(!p)return;p.innerHTML=tsEditorHtml();tseFlags();p.querySelectorAll("select,input").forEach(x=>x.addEventListener("change",()=>{tseRead();tseFlags()}))}
window.SHIFT_tseAdd=function(){tseRead();TSE.push({_k:"n"+(tseK++),id:null,driver_id:(drivers||[])[0]?.id,vehicle_id:null,days:[1,2,3,4,5],start_time:"07:00",end_time:"15:30",active:true});tseRender()};
window.SHIFT_tseRemove=function(k){tseRead();let r=TSE.find(x=>x._k===k);if(!r)return;if(r.id==null)TSE=TSE.filter(x=>x!==r);else r._deleted=true;tseRender()};
window.SHIFT_tseSave=async function(){
  tseRead();let flag=$("tseSaved");if(flag){flag.style.color="";flag.textContent="saving…"}
  for(const r of TSE){
    if(r._deleted){if(r.id!=null){let x=await db.from("truck_schedules").delete().eq("id",r.id);if(x.error)return alert("Could not remove a shift: "+x.error.message)}continue}
    let row={driver_id:r.driver_id,vehicle_id:r.vehicle_id,days:(r.days||[]).slice().sort(),start_time:r.start_time,end_time:r.end_time,active:r.active!==false,updated_at:new Date().toISOString()};
    let orig=TS.find(x=>x.id===r.id);
    if(orig&&orig.driver_id===row.driver_id&&(orig.vehicle_id??null)===row.vehicle_id&&JSON.stringify((orig.days||[]).map(Number).sort())===JSON.stringify(row.days)&&(orig.start_time||"").slice(0,5)===(row.start_time||"")&&(orig.end_time||"").slice(0,5)===(row.end_time||"")&&(orig.active!==false)===row.active)continue;
    let x=r.id!=null?await db.from("truck_schedules").update(row).eq("id",r.id):await db.from("truck_schedules").insert(row);
    if(x.error){if(flag){flag.style.color="#ff8e8e";flag.textContent="failed"}return alert("Could not save the truck schedule: "+x.error.message)}
  }
  await fetchV4();SHIFT_loadTruckTab();if(flag){let f=$("tseSaved");if(f)f.textContent="✓ saved"}try{render()}catch(_){}
};
window.SHIFT_loadTruckTab=function(){TSE=TS.map(r=>({...r,_k:"r"+r.id,days:(r.days||[]).map(Number)}));tseRender()};
function ensureTruckTab(){
  let tabs=document.querySelector(".schedule-tab")?.parentElement,panel=$("weeklySchedulePanel");
  if(!tabs||!panel||$("truckSchedulePanel"))return;
  let b=document.createElement("button");b.type="button";b.className="mini schedule-tab";b.dataset.tab="truck";b.textContent="🚛 Truck Schedule";b.onclick=()=>SHIFT_showTruckTab();tabs.insertBefore(b,tabs.firstChild);
  let p=document.createElement("div");p.id="truckSchedulePanel";p.style.display="none";panel.parentElement.insertBefore(p,panel);
}
window.SHIFT_showTruckTab=function(){ensureTruckTab();document.querySelectorAll(".schedule-tab").forEach(x=>x.classList.toggle("active",x.dataset.tab==="truck"));
  ["weeklySchedulePanel","overrideSchedulePanel"].forEach(id=>{let e=$(id);if(e)e.style.display="none"});let p=$("truckSchedulePanel");if(p)p.style.display="block";SHIFT_loadTruckTab()};
const origShowTab=window.showScheduleTab;
window.showScheduleTab=function(tab){ensureTruckTab();let p=$("truckSchedulePanel");if(p)p.style.display="none";return origShowTab.apply(this,arguments)};
const origOpenSched=window.openDriverSchedule;
window.openDriverSchedule=async function(...a){ensureTruckTab();let r=await origOpenSched.apply(this,a);SHIFT_showTruckTab();return r};
// after Daily Overrides save, refresh the v4 data (driver_schedule of yesterday + today)
const origSaveOv=window.saveDriverSchedule;
if(typeof origSaveOv==="function")window.saveDriverSchedule=async function(...a){let r=await origSaveOv.apply(this,a);await fetchV4();try{render()}catch(_){}return r};

/* Driver Schedule: trucks now come from the Truck Schedule (drivers.default_vehicle_id is kept but no longer used by the board/updater) */
const origOvSel=window.SHIFT_overrideTruckSelect;
if(typeof origOvSel==="function")window.SHIFT_overrideTruckSelect=function(d,r){
  let html=origOvSel.apply(this,arguments);if(!TS_OK)return html;
  let date=($("scheduleDate")&&$("scheduleDate").value)||boardDate,dow=new Date(date+"T12:00:00Z").getUTCDay();
  let names=[...new Set(TS.filter(x=>Number(x.driver_id)===Number(d.id)&&x.active!==false&&(x.days||[]).map(Number).includes(dow)).map(x=>x.vehicle_id).filter(x=>x!=null))].map(vName);
  html=html.replace(/<option value="">[^<]*<\/option>/,`<option value="">${esc(names.length?"Schedule ("+names.join(" / ")+")":"— no truck on schedule —")}</option>`);
  return html.replace(/<span class="auto-badge"[^>]*>auto<\/span>/,`<span class="auto-badge" title="Picked automatically by the v3.11 updater. Since v4.0.0 automatic picks are NOT used (the stop shows Driver unknown). Choose the truck here and Save Overrides to make it count.">auto · not used</span>`);
};
if(typeof window.SHIFT_defaultTruckSelect==="function")window.SHIFT_defaultTruckSelect=function(d){
  let rows=TS.filter(x=>Number(x.driver_id)===Number(d.id)&&x.active!==false),names=[...new Set(rows.map(x=>x.vehicle_id).filter(x=>x!=null))].map(vName);
  return `<span class="truck-pick" title="Trucks are set in Driver Schedule → Truck Schedule (v4.0.0)">🚛 ${esc(names.length?names.join(" / "):"no truck")} <button type="button" class="mini" onclick="SHIFT_showTruckTab()">Truck Schedule</button></span>`;
};

// first paint may have happened before this file loaded
fetchV4().then(()=>{try{render()}catch(e){console.warn("v4 render",e)}});
})();
