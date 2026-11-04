/* v4.10.0 — Auto trips.
   When a driver has two or more open tasks today on the same truck, the board combines them into one route automatically
   (same as ⛓ Combine, made with source "auto"). The route inherits the truck, the GPS cutoff (earliest assignment) and any
   pickup/drop visits GPS already saw, so nothing is lost. Stops go in the order GPS saw them; the rest keep the plan order.
   ↩ Undo (toast) or ↩ Restore on a task puts it back and keeps it out of auto-combine.
   v4.10.1: stops are ordered by the truck's ACTUAL recorded visits (vehicle_stop_events, from each task's window start —
   a late assignment reaches back to the truck's last McCook departure), and a McCook return splits the trip: tasks the
   truck already finished before returning to McCook belong to that earlier trip and are not combined with newer work.
   vzc-sync v20 then: splits the trip when the truck returns to McCook between stops (new trip from McCook), completes stops
   and trips from GPS, and flags a hand-completed task GPS never saw.  Turn off: ⚙ "Auto trips" button (per browser). */
(function(){
  const KEY="shift-auto-combine", PROTECTED=new Set([52,58,61,78,98,107,117,140,161,162]);
  const on=()=>localStorage.getItem(KEY)!=="0";
  const todayCT=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago"}).format(new Date());
  const ms=v=>v?Date.parse(v):null;
  let busy=false,lastTry={};
  /* ---- v4.10.1: the truck's real visits ---- */
  const EV={};                                                                   // vehicle_id → stop events (boardDate)
  const BASE_RX=/8701\s+47th/i;
  const isBaseAddr=a=>BASE_RX.test(String(a||""));
  const SUF={street:"st",st:"st",avenue:"ave",ave:"ave",av:"ave",drive:"dr",dr:"dr",road:"rd",rd:"rd",boulevard:"blvd",blvd:"blvd",parkway:"pkwy",pkwy:"pkwy",lane:"ln",ln:"ln",court:"ct",ct:"ct",place:"pl",pl:"pl",highway:"hwy",hwy:"hwy",north:"n",n:"n",south:"s",s:"s",east:"e",e:"e",west:"w",w:"w"};
  function addrKey(a){                                                            // "910 Carlow Dr Ste A, Bolingbrook" → {num:910, street:"carlow dr"}
    const m=String(a||"").toLowerCase().split(",")[0].replace(/\b(ste|suite|unit|#)\b.*$/,"").replace(/[.#]/g," ").trim().match(/^(\d+)\s+(.+)$/);
    if(!m)return null;const w=m[2].split(/\s+/).filter(Boolean).map(x=>SUF[x]||x);
    return {num:Number(m[1]),street:w.filter(x=>!["n","s","e","w"].includes(x)).join(" ")};
  }
  function sameAddr(a,b){const x=addrKey(a),y=addrKey(b);return !!(x&&y&&x.street===y.street&&Math.abs(x.num-y.num)<=30)}
  const evBase=e=>e.category==="McCook base"||isBaseAddr(e.address);
  const evAt=(e,addr)=>isBaseAddr(addr)?evBase(e):!evBase(e)&&sameAddr(e.address,addr);
  async function loadEvents(v){
    if(EV[v]&&EV[v].date===boardDate)return EV[v].list;
    let list=[];
    try{const r=await db.from("vehicle_stop_events").select("started_at,ended_at,category,location_name,address").eq("vehicle_id",v).eq("work_date",boardDate).is("superseded_at",null).order("started_at");
      if(!r.error)list=(r.data||[]).map(e=>({...e,a:ms(e.started_at),d:ms(e.ended_at)})).filter(e=>e.a!=null)}catch(e){list=[]}
    EV[v]={date:boardDate,at:Date.now(),list};return list;
  }
  /* same rule as vzc-sync lateAssignGate: assigned after it was created → window starts at the truck's last McCook departure (not before created) */
  function gateOf(t,evs){
    if(t.gps_since)return ms(t.gps_since);
    const c=ms(t.created_at),a=ms(t.assigned_at),g=c!=null&&a!=null?Math.max(c,a):(a??c);
    if(g==null||c==null||a==null||a<=c)return g;
    const base=evs.filter(evBase);
    if(base.some(e=>e.a<=a&&(e.d==null||e.d>a)))return g;                        // parked at McCook when assigned
    const deps=base.map(e=>e.d).filter(d=>d!=null&&d<=a);
    return deps.length?Math.max(c,Math.max(...deps)):g;
  }
  /* first visit to the pickup at/after the window start, then the first drop-off visit after it; fin = trip leg finished */
  function visitsOf(t,evs){
    const g=gateOf(t,evs)??0;
    const pu=t.pickup_address&&!sameAddr(t.pickup_address,t.delivery_address)?evs.find(e=>e.a>=g&&evAt(e,t.pickup_address))||null:null;
    const from=pu?(pu.d??pu.a):g;
    const de=t.delivery_address?evs.find(e=>e.a>=from&&(pu?e!==pu:true)&&evAt(e,t.delivery_address))||null:null;
    const needPu=t.pickup_address&&!isBaseAddr(t.pickup_address)&&!sameAddr(t.pickup_address,t.delivery_address);
    const fin=de&&(!needPu||pu)?(isBaseAddr(t.delivery_address)?de.a:(de.d??null)):null;
    return {gate:g,pu:pu&&!isBaseAddr(t.pickup_address)?pu.a:null,de:de?de.a:null,fin};
  }
  /* v4.10.1: split at a McCook return — keep only the tasks of the CURRENT trip (not finished before the last McCook return) */
  function currentTrip(list,evs){
    if(!evs.length)return {list,done:[]};
    const V=Object.fromEntries(list.map(t=>[t.id,visitsOf(t,evs)]));
    const lastReturn=Math.max(-1,...evs.filter(evBase).map(e=>e.a));
    const done=list.filter(t=>{const f=V[t.id].fin;return f!=null&&lastReturn>=f});
    return {list:list.filter(t=>!done.includes(t)),done,V};
  }

  function truckOf(t){if(t.vehicle_id)return Number(t.vehicle_id);const r=typeof SHIFT_resolveTruck==="function"&&t.assigned_driver_id?SHIFT_resolveTruck(Number(t.assigned_driver_id),boardDate):null;return r&&r.id?Number(r.id):null}
  function eligible(t){
    return t&&t.assigned_driver_id&&(t.status==="assigned"||t.status==="in_progress")&&!t.combined_into_task_id&&!t.messenger_id&&!t.no_auto_combine&&!PROTECTED.has(Number(t.id))
      &&String(t.work_date||"").slice(0,10)===boardDate;
  }
  /* earliest GPS sighting of a task (pickup reached / left, or a route stop) */
  let SEEN={};                                                                    // v4.10.1: task id → {pu,de} from the truck's stop events
  function firstSeen(t){
    let xs=[ms(t.gps_origin_arrived_at),ms(t.gps_departed_at),ms(t.gps_arrived_at)];
    if(SEEN[t.id])xs.push(SEEN[t.id].pu,SEEN[t.id].de);
    (STOPS_OF(t.id)).forEach(s=>xs.push(ms(s.gps_arrived_at)));
    xs=xs.filter(Boolean);return xs.length?Math.min(...xs):null;
  }
  function STOPS_OF(id){try{return (window.SHIFT_stopsOf?SHIFT_stopsOf(id):[])||[]}catch(e){return []}}
  /* when GPS already saw a stop, put it where it happened */
  function stopSeen(s,byId){
    if(s.from_stop_id){const st=Object.values(byId.stops).flat().find(x=>Number(x.stop_id)===Number(s.from_stop_id));if(st&&st.gps_arrived_at)return ms(st.gps_arrived_at)}
    let xs=s.parts.map(p=>{const t=byId.tasks[p.task_id];if(!t||t.is_route)return null;const sv=SEEN[t.id]||{};
      return p.type==="pickup"?ms(t.gps_origin_arrived_at)||ms(t.gps_departed_at)||sv.pu||null:ms(t.gps_arrived_at)||sv.de||null}).filter(Boolean);
    return xs.length?Math.min(...xs):null;
  }
  function plan(list){
    list=[...list].sort((a,b)=>(firstSeen(a)??9e15)-(firstSeen(b)??9e15)||(ms(a.scheduled_at)??9e15)-(ms(b.scheduled_at)??9e15)||(ms(a.assigned_at)??9e15)-(ms(b.assigned_at)??9e15)||a.id-b.id);
    let r=SHIFT_buildRoute(list,true,true,null);
    const byId={tasks:Object.fromEntries(list.map(t=>[t.id,t])),stops:Object.fromEntries(list.map(t=>[t.id,STOPS_OF(t.id)]))};
    const seen=r.stops.map((s,i)=>[i,s.finalReturn?null:stopSeen(s,byId)]);
    const order=[...seen.filter(x=>x[1]!=null).sort((a,b)=>a[1]-b[1]),...seen.filter(x=>x[1]==null)].map(x=>x[0]);
    if(order.some((k,i)=>k!==i))r=SHIFT_buildRoute(list,true,true,order);
    return {list,r};
  }
  function payloadFor(list,r){
    const first=list[0],last=r.stops[r.stops.length-1],pallets=list.map(t=>t.pallet_qty).filter(x=>x!=null);
    const uniq=a=>[...new Set(a.map(x=>(x??"").toString().trim()).filter(Boolean))].join("; ")||null;
    return {work_date:boardDate,title:`${r.origin.name} - ${last.name} (${r.stops.length} stop${r.stops.length===1?"":"s"})`,task_type:first.task_type||"delivery",
      status:"assigned",planning_stage:"assigned",priority:list.some(t=>t.priority==="high")?"high":(first.priority||"normal"),
      scheduled_at:list.map(t=>t.scheduled_at).filter(Boolean).sort()[0]||null,
      pickup_name:r.origin.name,pickup_address:r.origin.addr,delivery_name:last.name,delivery_address:last.addr,
      job_client:uniq(list.map(t=>t.job_client)),material:uniq(list.map(t=>t.material)),pallet_qty:pallets.length?pallets.reduce((a,b)=>a+b,0):null,
      instructions:[`Auto-combined from tasks ${list.map(t=>"#"+t.id).join(", ")} (same driver and truck).`,...list.filter(t=>t.instructions).map(t=>`#${t.id}: ${t.instructions}`)].join("\n"),
      assigned_driver_id:Number(first.assigned_driver_id),sort_order:Math.min(...list.map(t=>t.sort_order||0)),vehicle_id:truckOf(first),is_route:true};
  }
  async function autoCombine(){
    if(!on()||boardDate!==todayCT()||typeof SHIFT_buildRoute!=="function"||typeof SHIFT_saveRoute!=="function")return false;
    if(document.body.classList.contains("combine-mode"))return false;          // dispatcher is combining by hand
    for(const k in EV)delete EV[k];                                            // fresh stop events on every board load
    const groups={};
    (allTasks||[]).filter(eligible).forEach(t=>{const v=truckOf(t);if(!v)return;(groups[t.assigned_driver_id+"|"+v]=groups[t.assigned_driver_id+"|"+v]||[]).push(t)});
    let made=[];
    for(const [k,g] of Object.entries(groups)){
      if(g.length<2)continue;
      const evs=await loadEvents(Number(k.split("|")[1]));
      const cur=currentTrip(g,evs);
      if(cur.V)for(const [id,v] of Object.entries(cur.V))SEEN[id]=v;
      if(cur.list.length<2)continue;                                             // the earlier trip is finished; nothing new to combine yet
      g.splice(0,g.length,...cur.list);
      const sig=g.map(t=>t.id).sort((a,b)=>a-b).join(",");
      if(lastTry[k]===sig)continue;lastTry[k]=sig;                               // one try per set of tasks (no loop on a refusal)
      const {list,r}=plan(g);
      if(!r.stops.length||r.warn.length)continue;                               // a drop before its pickup: leave it to the dispatcher
      try{made.push([await SHIFT_saveRoute(list,r,payloadFor(list,r),"auto",list[0].id),list])}
      catch(e){console.warn("auto-combine skipped",k,e.message||e)}
    }
    made.forEach(([id,list])=>notify(id,list));
    return made.length>0;
  }
  function notify(id,list){
    const d=(drivers.find(x=>Number(x.id)===Number(list[0].assigned_driver_id))||{}).name||"driver";
    let el=document.createElement("div");el.className="auto-trip-toast";
    el.innerHTML=`⛓ ${esc(d)}: tasks ${list.map(t=>"#"+t.id).join(", ")} combined into route #${id} <button class="mini" type="button">↩ Undo</button>`;
    el.querySelector("button").onclick=async()=>{const r=await db.rpc("shift_undo_auto_combine",{p_route_id:id});if(r.error)alert(r.error.message);el.remove();load()};
    document.body.appendChild(el);setTimeout(()=>el.remove(),15000);
  }
  const origLoad=window.load;
  window.load=async function(...a){
    const out=await origLoad.apply(this,a);
    if(!busy){busy=true;let again=false;try{again=await autoCombine()}finally{busy=false}if(again)return origLoad.apply(this,a)}
    return out;
  };
  window.SHIFT_toggleAutoTrips=function(){localStorage.setItem(KEY,on()?"0":"1");btn();if(on())load()};
  function btn(){const b=document.getElementById("autoTripsBtn");if(b){b.textContent=on()?"⛓ Auto trips: on":"⛓ Auto trips: off";b.classList.toggle("off",!on())}}
  function addBtn(){const c=document.getElementById("combineBtn");if(!c||document.getElementById("autoTripsBtn"))return;
    c.insertAdjacentHTML("afterend",`<button class="btn ghost" id="autoTripsBtn" type="button" onclick="SHIFT_toggleAutoTrips()" title="Combine a driver's open tasks on the same truck into one route automatically (today's board)."></button>`);btn()}
  document.readyState==="loading"?document.addEventListener("DOMContentLoaded",addBtn):addBtn();setTimeout(addBtn,1500);
  window.SHIFT_autoTrips={plan,eligible,autoCombine,firstSeen,gateOf,visitsOf,currentTrip,sameAddr,_seen:v=>{SEEN=v||{}}};
})();
