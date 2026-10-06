/* SHIFT Dispatch v3.4.1 — driver app hooks (no driver texting/links from the dashboard), create-task API, live driver board, suggest order, quick paste.
   Loaded after the main inline script in index.html; reuses its globals (db, tasks, allTasks, drivers, boardDate, LOC, savedLocations, load, render…).
   Production-safety rule: this file only performs single-row writes (one task / one reminder / one schedule row) or new inserts. No bulk clears. */
(function(){
const SHIFT_VERSION="v3.4.1";
window.SHIFT_VERSION=SHIFT_VERSION;
const HOME=["Darwill McCook","8701 47th St Ste C, McCook, IL 60525"]; // most common origin in History (82 of 112 routes)
const ALERT_RE=/\[SHIFT-DRIVER task:(\d+) (missed|refused)\]/;
let driverAlerts=[],eventsTable=null;

/* ---------- styles ---------- */
const css=`
.shift-version{font-size:10px;color:#6f8396;margin-left:8px;font-weight:800}
.driver-live{display:flex;flex-wrap:wrap;gap:5px;padding:7px 12px 0;font-size:11px;font-weight:800;color:#9fb3c6}
.driver-live span{background:#132233;border:1px solid #213549;border-radius:7px;padding:3px 7px}
.driver-live .lv-prog{color:#ffd34d}.driver-live .lv-wait{color:#ff9c9c;border-color:#6b2328;background:#2a1214}
.driver-tools-row{display:flex;flex-wrap:wrap;gap:5px;padding:7px 12px 0}.driver-tools-row .mini{padding:5px 8px}
.driver-status-note{margin:7px 12px 0;padding:6px 9px;border-radius:8px;background:#1a2532;border:1px solid #2a3b4d;color:#d6e2ee;font-size:12px;line-height:1.35}
.driver-status-note.pinned{cursor:pointer;border-left:3px solid #ffb020}
.src-tag{font-size:9px;font-weight:900;text-transform:uppercase;background:#1d3045;color:#8fc5ff;border-radius:5px;padding:1px 5px;margin-left:4px}
details.done-fold{margin-top:6px;border-top:1px dashed #2a3b4d;padding-top:6px}
details.done-fold summary{cursor:pointer;color:#69df91;font-weight:900;font-size:12px;padding:4px 2px;list-style:none}
details.done-fold summary::-webkit-details-marker{display:none}
details.done-fold summary:before{content:"▸ "}details.done-fold[open] summary:before{content:"▾ "}
.driver-flag{display:inline-block;font-size:9px;font-weight:950;text-transform:uppercase;padding:3px 6px;border-radius:6px;background:rgba(239,83,80,.18);color:#ff9c9c;border:1px solid rgba(239,83,80,.4);margin-left:4px}
.task.has-driver-flag{border-left-color:#ef5350!important;box-shadow:0 0 0 1px rgba(239,83,80,.45)!important}
.driver-alerts{margin:0 0 14px;border:1px solid #6b2328;background:#1c0f12;border-radius:14px;padding:10px 12px;display:none}
.driver-alerts.show{display:block}.driver-alerts h4{margin:0 0 8px;font-size:14px;color:#ffb3b3}
.driver-alert-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:7px 0;border-top:1px solid rgba(239,83,80,.2);font-size:13px}
.driver-alert-row:first-of-type{border-top:0}.driver-alert-row small{color:#c79a9a;display:block}
.quick-paste{display:flex;gap:8px}.quick-paste input{flex:1}
.loc-search{margin-bottom:6px;padding:8px 10px!important;font-size:12px!important}
.ready-paste{display:flex;gap:6px;margin:0 0 10px}.ready-paste input{flex:1;padding:8px 10px;font-size:12px}.ready-paste button{padding:8px 10px}
.suggest-list{padding:6px 20px 4px}.suggest-row{display:grid;grid-template-columns:34px 1fr 80px auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
.suggest-row .n{font-weight:1000;color:#8fc5ff}.suggest-row small{display:block;color:#8fa0b5;font-size:11px}.suggest-row .eta{font-weight:900;color:#dce8f4}
.suggest-why{padding:0 20px 8px;color:#8fa0b5;font-size:12px}
body.light-mode .driver-live span{background:#f3f7fb!important;border-color:#d0dce7!important;color:#2b4052!important}
body.light-mode .driver-live .lv-wait{background:#fff0f0!important;color:#b42f2f!important;border-color:#efb8b8!important}
body.light-mode .driver-status-note{background:#f7fafc!important;border-color:#d0dce7!important;color:#24384a!important}
body.light-mode .driver-alerts{background:#fff4f4!important;border-color:#efb8b8!important}
body.light-mode .driver-alerts h4{color:#a12a2a!important}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

/* ---------- small helpers ---------- */
function driverById(id){return drivers.find(d=>Number(d.id)===Number(id))}
function tm(v){return v?new Date(v).toLocaleString([],{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Time TBD"}
async function probeEvents(){if(eventsTable!==null)return eventsTable;try{let r=await db.from("dispatch_events").select("id").limit(1);eventsTable=!r.error}catch(_){eventsTable=false}return eventsTable}
async function logEvent(taskId,driverId,event,detail){try{if(!(await probeEvents()))return;await db.from("dispatch_events").insert({task_id:taskId,driver_id:driverId,event,detail:detail||null})}catch(_){}}

/* ---------- version label ---------- */
function versionLabel(){let c=$("conn");if(c&&!document.querySelector(".shift-version")){let v=document.createElement("span");v.className="shift-version";v.textContent=SHIFT_VERSION;c.after(v)}}

/* ---------- after assign (v3.4.1: no notify panel / driver texting from the dashboard) ---------- */
window.SHIFT_onAssigned=function(taskId,driverId){
 let t=tasks.find(x=>x.id===taskId)||allTasks.find(x=>x.id===taskId),d=driverById(driverId);if(!t||!d)return;
 logEvent(t.id,d.id,"assigned",{scheduled_at:t.scheduled_at||null});
};

/* ---------- driver alerts (Missed / Refused → manager) ---------- */
function alertBox(){let b=$("driverAlerts");if(!b){b=document.createElement("section");b.id="driverAlerts";b.className="driver-alerts";let board=document.querySelector(".board");board.parentNode.insertBefore(b,board)}return b}
async function loadDriverAlerts(){
 let r=await db.from("shift_reminders").select("*").eq("completed",false).like("note","%[SHIFT-DRIVER task:%").order("created_at",{ascending:false});
 if(r.error){driverAlerts=[];return}
 driverAlerts=r.data||[];
 let seenKey="shift-mgr-alerts-seen",seen=new Set(JSON.parse(localStorage.getItem(seenKey)||"[]"));
 let fresh=driverAlerts.filter(a=>!seen.has(a.id));
 if(fresh.length&&localStorage.getItem(seenKey)!==null){
   let a=fresh[0],txt=(a.note||"").replace(ALERT_RE,"").replace(/^🚨\s*/,"").trim();
   if("Notification" in window&&Notification.permission==="granted"){try{new Notification("🚨 SHIFT driver alert",{body:txt,icon:"icons/icon-192.png",tag:"shift-alert-"+a.id})}catch(_){}}
 }
 driverAlerts.forEach(a=>seen.add(a.id));localStorage.setItem(seenKey,JSON.stringify([...seen].slice(-500)));
 renderAlerts();
}
function renderAlerts(){
 let b=alertBox();
 let perm=("Notification" in window)&&Notification.permission==="default"?`<button class="mini" type="button" onclick="SHIFT_enableManagerAlerts()">🔔 Desktop alerts</button>`:"";
 if(!driverAlerts.length){b.classList.remove("show");b.innerHTML="";return}
 b.classList.add("show");
 b.innerHTML=`<h4>🚨 Driver alerts (${driverAlerts.length}) ${perm}</h4>`+driverAlerts.map(a=>{let m=(a.note||"").match(ALERT_RE)||[],txt=(a.note||"").replace(ALERT_RE,"").replace(/^🚨\s*/,"").trim();return `<div class="driver-alert-row"><div>${esc(txt)}<small>${new Date(a.created_at).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</small></div><div style="display:flex;gap:6px">${m[1]&&tasks.find(t=>t.id===Number(m[1]))?`<button class="mini" onclick="editTask(${Number(m[1])})">Open</button>`:""}<button class="mini" onclick="SHIFT_resolveAlert(${a.id})">Resolve</button></div></div>`}).join("");
}
window.SHIFT_enableManagerAlerts=async function(){try{await Notification.requestPermission()}catch(_){}renderAlerts()};
window.SHIFT_resolveAlert=async function(id){
 let {error}=await db.from("shift_reminders").update({completed:true,completed_at:new Date().toISOString()}).eq("id",id);
 if(error)return alert(error.message);
 await loadDriverAlerts();decorate();if(typeof loadReminders==="function")loadReminders();
};
function decorate(){
 document.querySelectorAll(".task[data-id]").forEach(el=>{
  let id=Number(el.dataset.id),a=driverAlerts.find(x=>Number((x.note||"").match(ALERT_RE)?.[1])===id);
  el.classList.toggle("has-driver-flag",!!a);
  let flags=el.querySelector(".route-flags"),old=el.querySelector(".driver-flag");if(old)old.remove();
  if(a&&flags){let k=(a.note.match(ALERT_RE)||[])[2]||"flag";flags.insertAdjacentHTML("beforeend",`<span class="driver-flag" title="${esc(a.note)}">⚠ ${esc(k)}</span>`)}
 });
 addReadyPaste();
}

/* ---------- driver notes merged onto the driver card ---------- */
function nameTokens(s){return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(Boolean)}
function noteMatchesDriver(n,d){
 let sub=nameTokens(n.subject),nm=nameTokens(d.name);if(!sub.length||!nm.length)return false;
 return sub.every((tk,i)=>nm[i]&&nm[i].startsWith(tk));
}
window.driverNotesFor=function(d){
 if(typeof shiftNotes==="undefined")return [];
 return shiftNotes.filter(n=>n.category==="driver"&&(typeof noteActive!=="function"||noteActive(n))&&noteMatchesDriver(n,d));
};
window.SHIFT_editDriverStatusNote=async function(driverId){
 let d=driverById(driverId),sch=effectiveDriverSchedule(driverId);
 let v=prompt(`Status note for ${d?.name} on ${boardDate} (shows on their card; same as Driver Schedule → Daily Overrides):`,sch.note||"");
 if(v===null)return;
 let payload={work_date:boardDate,driver_id:Number(driverId),status:sch.status||"working",start_time:sch.start_time||null,end_time:sch.end_time||null,note:v.trim()||null};
 let r=await db.from("driver_schedule").upsert(payload,{onConflict:"work_date,driver_id"});
 if(r.error)return alert(r.error.message);
 await load();
};

/* ---------- quick paste / create-task API ---------- */
function allKnownLocations(){return LOC.map((x,i)=>({key:"builtin:"+i,name:x[0],address:x[1]})).concat((savedLocations||[]).map(x=>({key:"saved:"+x.id,name:x.name,address:x.address})))}
function norm(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"")}
function findLocation(text){
 let n=norm(text);if(!n)return null;let all=allKnownLocations();
 return all.find(l=>norm(l.name)===n)||all.find(l=>norm(l.address)===n)||all.find(l=>n.length>=8&&norm(l.address).startsWith(n.slice(0,Math.max(8,Math.min(n.length,18)))))||all.find(l=>n.length>=3&&norm(l.name).startsWith(n))||all.find(l=>n.length>=4&&norm(l.name).includes(n))||null;
}
function parseLine(line){
 let s=String(line||"").trim(),out={};
 let m=s.match(/^(pick\s*-?\s*up|pu)\b\s*(from|at|@|:)?\s*/i);if(m){out.side="pickup";s=s.slice(m[0].length)}
 else if((m=s.match(/^(deliver(y)?|drop(\s*off)?|dl)\b\s*(to|at|@|:)?\s*/i))){out.side="delivery";s=s.slice(m[0].length)}
 m=s.match(/\b(\d{1,3})\s*(pallets?|plts?|skids?)\b/i);if(m){out.pallet_qty=Number(m[1]);s=s.replace(m[0],"")}
 m=s.match(/(?:^|\s)(?:@|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)||s.match(/\b(\d{1,2})(?::(\d{2}))\s*(am|pm)?\b/i)||s.match(/\b(\d{1,2})\s*(am|pm)\b/i);
 if(m){let h=Number(m[1]),mi=Number(m[2]&&!/am|pm/i.test(m[2])?m[2]:0),ap=(m[3]||(/am|pm/i.test(m[2]||"")?m[2]:"")||"").toLowerCase();if(ap==="pm"&&h<12)h+=12;if(ap==="am"&&h===12)h=0;if(!ap&&h<6)h+=12;if(h<24){out.time=String(h).padStart(2,"0")+":"+String(mi).padStart(2,"0");s=s.replace(m[0]," ")}}
 if(/\b(urgent|asap|rush|high)\b/i.test(s)){out.priority="high";s=s.replace(/\b(urgent|asap|rush|high priority|high)\b/ig,"")}
 s=s.replace(/\s{2,}/g," ").replace(/^[\s,–—-]+|[\s,–—-]+$/g,"");
 let known=findLocation(s);
 if(known){out.name=known.name;out.address=known.address;return out}
 let parts=s.split(",").map(x=>x.trim()).filter(Boolean);
 if(parts.length>1&&!/^\d/.test(parts[0])){out.name=parts[0];out.address=parts.slice(1).join(", ")}
 else if(parts.length){out.address=parts.join(", ");out.name=parts[0]}
 let k2=out.address&&findLocation(out.address);if(k2){out.name=k2.name;out.address=k2.address}
 return out;
}
window.SHIFT_parseLine=parseLine;
function resolveSide(name,address){
 if(name&&address)return [name,address];
 let k=findLocation(name||address);if(k)return [k.name,k.address];
 if(name||address)return [name||address,address||""];
 return null;
}
function localIso(date,time){return new Date(`${date}T${time||"08:00"}:00`).toISOString()}
window.SHIFT_buildTask=function(input){
 let i=typeof input==="string"?{line:input}:{...(input||{})};
 if(i.line){let p=parseLine(i.line);let side=i.side||p.side||(i.task_type==="pickup"?"pickup":"delivery");
  if(side==="pickup"){i.pickup_name=i.pickup_name||p.name;i.pickup_address=i.pickup_address||p.address}else{i.delivery_name=i.delivery_name||p.name;i.delivery_address=i.delivery_address||p.address}
  if(i.pallet_qty==null&&p.pallet_qty!=null)i.pallet_qty=p.pallet_qty;if(!i.time&&p.time)i.time=p.time;if(!i.priority&&p.priority)i.priority=p.priority;if(!i.task_type&&side==="pickup")i.task_type="pickup"}
 let pu=resolveSide(i.pickup_name,i.pickup_address),de=resolveSide(i.delivery_name,i.delivery_address);
 if(!pu&&!de)throw new Error("Need at least a pickup or delivery (name or address).");
 if(!pu)pu=HOME.slice();if(!de)de=HOME.slice();
 let type=i.task_type||(norm(pu[0])===norm(HOME[0])?"delivery":norm(de[0])===norm(HOME[0])?"pickup":"delivery");
 let today=ymd(new Date());
 let sched=i.scheduled_at?new Date(i.scheduled_at).toISOString():null;
 let work=i.work_date||(sched?ymd(sched):today);
 if(!sched)sched=localIso(work,i.time||"08:00");
 return {work_date:work,title:pu[0]+" - "+de[0],pickup_name:pu[0],pickup_address:pu[1]||null,delivery_name:de[0],delivery_address:de[1]||null,scheduled_at:sched,priority:["high","low","normal"].includes(i.priority)?i.priority:"normal",job_client:i.job_client||null,material:i.material||null,pallet_qty:i.pallet_qty!=null&&i.pallet_qty!==""?Number(i.pallet_qty):null,task_type:type,instructions:i.instructions||null,status:"pending",planning_stage:"ready",assigned_driver_id:null,sort_order:999};
};
window.SHIFT_createTask=async function(input){
 let row=SHIFT_buildTask(input);
 let r=await db.from("dispatch_tasks").insert(row).select().single();
 if(r.error){console.error("SHIFT_createTask",r.error);throw r.error}
 logEvent(r.data.id,null,"created",{via:(input&&input.via)||"api"});
 await load();
 return r.data;
};
// bridge 1: URL  ?createTask=<json or one address line>
async function urlBridge(){
 let u=new URL(location.href),raw=u.searchParams.get("createTask");if(!raw)return;
 u.searchParams.delete("createTask");history.replaceState(null,"",u);
 let key="shift-created-"+raw,done=JSON.parse(localStorage.getItem("shift-created-keys")||"[]");
 if(done.includes(key)){console.info("createTask link already used");return}
 let input;try{input=JSON.parse(raw)}catch(_){input={line:raw}}
 let preview;try{preview=SHIFT_buildTask(input)}catch(e){return alert("Could not read task: "+e.message)}
 if(!confirm(`Add to Ready to Assign?\n\n${preview.task_type.toUpperCase()} · ${preview.pickup_name} → ${preview.delivery_name}\n${tm(preview.scheduled_at)}`))return;
 try{await SHIFT_createTask({...input,via:"url"});done.push(key);localStorage.setItem("shift-created-keys",JSON.stringify(done.slice(-200)))}catch(e){alert("Could not create task: "+(e.message||e))}
}
// bridge 2: another tab / extension writes localStorage "shift-create-task"
window.addEventListener("storage",async e=>{if(e.key!=="shift-create-task"||!e.newValue)return;try{let v=JSON.parse(e.newValue);await SHIFT_createTask({...v,via:"storage"});localStorage.removeItem("shift-create-task")}catch(err){console.error(err)}});
// bridge 3: window.postMessage({type:"SHIFT_CREATE_TASK",task:{...}}) from same origin
window.addEventListener("message",async e=>{if(e.origin!==location.origin||!e.data||e.data.type!=="SHIFT_CREATE_TASK")return;try{let row=await SHIFT_createTask({...e.data.task,via:"postMessage"});e.source&&e.source.postMessage({type:"SHIFT_TASK_CREATED",id:row.id},e.origin)}catch(err){e.source&&e.source.postMessage({type:"SHIFT_TASK_ERROR",error:String(err.message||err)},e.origin)}});

/* quick paste inside the task modal */
function setPicker(which,name,address){
 let k=findLocation(name)||findLocation(address);
 let sel=$(which);if(!sel)return;
 if(k&&norm(k.name)===norm(name||k.name)){sel.innerHTML=options();sel.value=k.key}
 else{sel.innerHTML=options();sel.value="custom";$(which+"CustomName").value=name||"";$(which+"CustomAddress").value=address||""}
 toggleCustomLocation(which);
}
window.SHIFT_fillFromPaste=function(){
 let line=$("quickPaste").value.trim();if(!line)return;
 let t;try{t=SHIFT_buildTask({line,work_date:boardDate})}catch(e){return alert(e.message)}
 setPicker("pickup",t.pickup_name,t.pickup_address);setPicker("delivery",t.delivery_name,t.delivery_address);
 $("type").value=t.task_type;$("priority").value=t.priority;if(t.pallet_qty!=null)$("pallets").value=t.pallet_qty;
 let d=new Date(t.scheduled_at);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());$("scheduled").value=d.toISOString().slice(0,16);
 typeTouched=true;
};
/* one-line paste box at the top of Ready to Assign */
function addReadyPaste(){
 let lane=$("ready");if(!lane||$("readyPaste"))return;
 let w=document.createElement("form");w.className="ready-paste";w.id="readyPaste";
 w.innerHTML=`<input id="readyPasteInput" placeholder="⚡ Paste address line + Enter" autocomplete="off"><button class="mini" type="submit">Add</button>`;
 lane.parentNode.insertBefore(w,lane);
 w.onsubmit=async e=>{e.preventDefault();let v=$("readyPasteInput").value.trim();if(!v)return;try{await SHIFT_createTask({line:v,work_date:boardDate,via:"ready-paste"});$("readyPasteInput").value=""}catch(err){alert("Could not add: "+(err.message||err))}};
}

/* typeahead on location pickers + neutral task-type inference */
let typeTouched=false;
function filterPicker(which){
 let q=norm($(which+"Search").value),sel=$(which),cur=sel.value;
 let tmp=document.createElement("select");tmp.innerHTML=options();
 if(q){[...tmp.querySelectorAll("option")].forEach(o=>{if(o.value===""||o.value==="custom")return;if(!norm(o.textContent).includes(q)&&!norm(locAddr(o.value)).includes(q))o.remove()});tmp.querySelectorAll("optgroup").forEach(g=>{if(!g.children.length)g.remove()})}
 sel.innerHTML=tmp.innerHTML;
 let opts=[...sel.options].filter(o=>o.value&&o.value!=="custom");
 if([...sel.options].some(o=>o.value===cur)&&cur)sel.value=cur;else if(q&&opts.length)sel.value=opts[0].value;else sel.value="";
 toggleCustomLocation(which);inferType();
}
function locAddr(v){if(v.startsWith("builtin:"))return LOC[Number(v.split(":")[1])]?.[1]||"";if(v.startsWith("saved:")){let x=savedLocations.find(s=>String(s.id)===v.split(":")[1]);return x?x.address:""}return ""}
function inferType(){
 if(typeTouched||$("id").value)return;let p=locationFromForm("pickup"),d=locationFromForm("delivery");
 if(p&&norm(p[0])===norm(HOME[0])||p&&/darwill/i.test(p[0]))$("type").value="delivery";
 else if(d&&(norm(d[0])===norm(HOME[0])||/darwill/i.test(d[0])))$("type").value="pickup";
}
["pickup","delivery"].forEach(w=>{let s=$(w+"Search");if(!s)return;s.addEventListener("input",()=>filterPicker(w));s.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$(w).focus()}});$(w).addEventListener("change",inferType)});
$("type")?.addEventListener("change",()=>typeTouched=true);
$("quickPaste")?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();SHIFT_fillFromPaste()}});
const _openTask=openTask;openTask=function(stage){typeTouched=false;_openTask(stage);if($("pickupSearch"))$("pickupSearch").value="";if($("deliverySearch"))$("deliverySearch").value=""};

/* ---------- suggest order (never auto-applies) ---------- */
function cityOf(addr){let p=String(addr||"").split(",").map(x=>x.trim());return (p.length>=3?p[p.length-2]:p[1]||p[0]||"").toLowerCase()}
function minutesOfDay(v){let d=new Date(v);return d.getHours()*60+d.getMinutes()}
function historyStats(){
 let done=allTasks.filter(t=>t.status==="completed"&&t.completed_at);
 let byRoute={},byCity={},gaps={};
 done.forEach(t=>{let rk=norm(t.pickup_name)+">"+norm(t.delivery_name),ck=cityOf(t.delivery_address);(byRoute[rk]=byRoute[rk]||[]).push(minutesOfDay(t.completed_at));(byCity[ck]=byCity[ck]||[]).push(minutesOfDay(t.completed_at))});
 // typical minutes between consecutive completions per driver/day → per-route duration estimate
 let groups={};done.forEach(t=>{let k=t.assigned_driver_id+"|"+ymd(t.completed_at);(groups[k]=groups[k]||[]).push(t)});
 Object.values(groups).forEach(list=>{list.sort((a,b)=>new Date(a.completed_at)-new Date(b.completed_at));for(let i=1;i<list.length;i++){let g=(new Date(list[i].completed_at)-new Date(list[i-1].completed_at))/60000;if(g>10&&g<240){let rk=norm(list[i].pickup_name)+">"+norm(list[i].delivery_name);(gaps[rk]=gaps[rk]||[]).push(g)}}});
 const med=a=>{if(!a||!a.length)return null;let s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]};
 return {route:k=>med(byRoute[k]),city:k=>med(byCity[k]),dur:k=>med(gaps[k]),n:done.length};
}
window.SHIFT_suggestOrder=function(driverId){
 let d=driverById(driverId),sch=effectiveDriverSchedule(driverId);
 let active=tasks.filter(t=>Number(t.assigned_driver_id)===Number(driverId)&&t.status!=="completed");
 if(active.length<2)return alert("Need at least 2 open stops to suggest an order.");
 let H=historyStats();
 let startMin=sch.start_time?(Number(sch.start_time.slice(0,2))*60+Number(sch.start_time.slice(3,5))):420;
 let scored=active.map(t=>{let rk=norm(t.pickup_name)+">"+norm(t.delivery_name),ck=cityOf(t.delivery_address);
  let hist=H.route(rk)??H.city(ck);let sched=t.scheduled_at?minutesOfDay(t.scheduled_at):null;
  let anchor=t.status==="in_progress"?-1:(hist??sched??9999);
  return {t,rk,ck,hist,sched,anchor,dur:H.dur(rk)??60}});
 // cluster by delivery city: cluster anchor = earliest anchor in the cluster
 let clusters={};scored.forEach(x=>{(clusters[x.ck]=clusters[x.ck]||[]).push(x)});
 let ordered=Object.values(clusters).map(c=>({c:c.sort((a,b)=>a.anchor-b.anchor||(a.sched??9999)-(b.sched??9999)),a:Math.min(...c.map(x=>x.anchor))})).sort((x,y)=>x.a-y.a).flatMap(x=>x.c);
 openSuggest(d,startMin,ordered,H.n);
};
let suggestState=null;
function fmtMin(m){m=Math.round(m);let h=Math.floor(m/60)%24,mi=m%60;return `${h%12||12}:${String(mi).padStart(2,"0")} ${h>=12?"PM":"AM"}`}
function openSuggest(d,startMin,ordered,n){
 suggestState={d,startMin,ordered,n};
 let m=$("suggestModal");if(!m){m=document.createElement("div");m.className="modal";m.id="suggestModal";m.onclick=e=>{if(e.target===m)m.classList.remove("show")};document.body.appendChild(m)}
 drawSuggest();m.classList.add("show");
}
function drawSuggest(){
 let {d,startMin,ordered,n}=suggestState,clock=startMin;
 let current=[...ordered].sort((a,b)=>(a.t.sort_order||0)-(b.t.sort_order||0)).map(x=>x.t.id).join(",");
 let rows=ordered.map((x,i)=>{let eta=clock;clock+=x.dur;return `<div class="suggest-row"><span class="n">${i+1}</span><div><b>${esc(x.t.pickup_name)} → ${esc(x.t.delivery_name)}</b><small>${esc(x.ck||"—")} · ${x.hist!=null?"usually done ~"+fmtMin(x.hist):"no history"}${x.sched!=null?" · scheduled "+fmtMin(x.sched):""}${x.t.status==="in_progress"?" · in progress":""}</small></div><span class="eta" title="Rough ETA from start time + typical gaps">~${fmtMin(eta)}</span><span><button class="mini" onclick="SHIFT_moveSuggest(${i},-1)" ${i===0?"disabled":""}>↑</button> <button class="mini" onclick="SHIFT_moveSuggest(${i},1)" ${i===ordered.length-1?"disabled":""}>↓</button></span></div>`}).join("");
 let same=ordered.map(x=>x.t.id).join(",")===current;
 $("suggestModal").innerHTML=`<div class="dialog"><div class="dialog-head"><div><b>Suggested order · ${esc(d.name)}</b><div class="muted" style="font-size:12px;margin-top:3px">From ${n} completed routes in History, grouped by delivery area, starting ${fmtMin(startMin)}. Nothing changes until you accept.</div></div><button class="close" onclick="$('suggestModal').classList.remove('show')">×</button></div><div class="suggest-list">${rows}</div><div class="suggest-why">${same?"This matches the current order.":"Tweak with ↑/↓, then accept to reorder this driver’s column."}</div><div class="form-actions" style="padding:0 20px 18px"><button class="btn ghost" onclick="$('suggestModal').classList.remove('show')">Keep current</button><button class="btn primary" onclick="SHIFT_acceptSuggest()">Accept order</button></div></div>`;
}
window.SHIFT_moveSuggest=function(i,dir){let o=suggestState.ordered,j=i+dir;if(j<0||j>=o.length)return;[o[i],o[j]]=[o[j],o[i]];drawSuggest()};
window.SHIFT_acceptSuggest=async function(){
 let o=suggestState.ordered;
 // only sort_order changes, only for this driver's open stops (same write the drag-reorder already does)
 for(let i=0;i<o.length;i++){let r=await db.from("dispatch_tasks").update({sort_order:i}).eq("id",o[i].t.id).eq("assigned_driver_id",suggestState.d.id);if(r.error){alert(r.error.message);break}}
 $("suggestModal").classList.remove("show");await load();
};

/* ---------- wrap core functions ---------- */
const _render=render;render=function(){_render();decorate();try{renderNotesPreview()}catch(_){}};
const _load=load;load=async function(){await _load();await loadDriverAlerts();decorate()};
if(typeof loadNotes==="function"){const _ln=loadNotes;loadNotes=async function(){await _ln();render()}}
if(typeof renderNotesPreview==="function"){
 const _rnp=renderNotesPreview;
 renderNotesPreview=function(){
  // driver-specific notes now live on the driver card; keep the strip for everything else
  let keep=shiftNotes;let onBoard=drivers.filter(d=>{try{return driverVisibleOnBoard(d)}catch(_){return false}});shiftNotes=shiftNotes.filter(n=>!(n.category==="driver"&&onBoard.some(d=>noteMatchesDriver(n,d))));
  try{_rnp()}finally{shiftNotes=keep}
 };
}
versionLabel();
setTimeout(()=>{loadDriverAlerts().then(decorate);urlBridge()},900);
console.info(`SHIFT ${SHIFT_VERSION} ready. Create a task: SHIFT_createTask({line:"ALG, 1053 N Schmidt Rd, Romeoville, IL 60446 @ 9am"})`);
})();
