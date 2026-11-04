/* v4.10.0 — Auto trips.
   When a driver has two or more open tasks today on the same truck, the board combines them into one route automatically
   (same as ⛓ Combine, made with source "auto"). The route inherits the truck, the GPS cutoff (earliest assignment) and any
   pickup/drop visits GPS already saw, so nothing is lost. Stops go in the order GPS saw them; the rest keep the plan order.
   ↩ Undo (toast) or ↩ Restore on a task puts it back and keeps it out of auto-combine.
   vzc-sync v20 then: splits the trip when the truck returns to McCook between stops (new trip from McCook), completes stops
   and trips from GPS, and flags a hand-completed task GPS never saw.  Turn off: ⚙ "Auto trips" button (per browser). */
(function(){
  const KEY="shift-auto-combine", PROTECTED=new Set([52,58,61,78,98,107,117,140,161,162]);
  const on=()=>localStorage.getItem(KEY)!=="0";
  const todayCT=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago"}).format(new Date());
  const ms=v=>v?Date.parse(v):null;
  let busy=false,lastTry={};

  function truckOf(t){if(t.vehicle_id)return Number(t.vehicle_id);const r=typeof SHIFT_resolveTruck==="function"&&t.assigned_driver_id?SHIFT_resolveTruck(Number(t.assigned_driver_id),boardDate):null;return r&&r.id?Number(r.id):null}
  function eligible(t){
    return t&&t.assigned_driver_id&&(t.status==="assigned"||t.status==="in_progress")&&!t.combined_into_task_id&&!t.messenger_id&&!t.no_auto_combine&&!PROTECTED.has(Number(t.id))
      &&String(t.work_date||"").slice(0,10)===boardDate;
  }
  /* earliest GPS sighting of a task (pickup reached / left, or a route stop) */
  function firstSeen(t){
    let xs=[ms(t.gps_origin_arrived_at),ms(t.gps_departed_at),ms(t.gps_arrived_at)];
    (STOPS_OF(t.id)).forEach(s=>xs.push(ms(s.gps_arrived_at)));
    xs=xs.filter(Boolean);return xs.length?Math.min(...xs):null;
  }
  function STOPS_OF(id){try{return (window.SHIFT_stopsOf?SHIFT_stopsOf(id):[])||[]}catch(e){return []}}
  /* when GPS already saw a stop, put it where it happened */
  function stopSeen(s,byId){
    if(s.from_stop_id){const st=Object.values(byId.stops).flat().find(x=>Number(x.stop_id)===Number(s.from_stop_id));if(st&&st.gps_arrived_at)return ms(st.gps_arrived_at)}
    let xs=s.parts.map(p=>{const t=byId.tasks[p.task_id];if(!t||t.is_route)return null;return p.type==="pickup"?ms(t.gps_origin_arrived_at)||ms(t.gps_departed_at):ms(t.gps_arrived_at)}).filter(Boolean);
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
    const groups={};
    (allTasks||[]).filter(eligible).forEach(t=>{const v=truckOf(t);if(!v)return;(groups[t.assigned_driver_id+"|"+v]=groups[t.assigned_driver_id+"|"+v]||[]).push(t)});
    let made=[];
    for(const [k,g] of Object.entries(groups)){
      if(g.length<2)continue;
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
  window.SHIFT_autoTrips={plan,eligible,autoCombine,firstSeen};
})();
