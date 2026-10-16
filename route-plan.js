/* SHIFT Route planner for map.html (v4.9.0; v4.9.1 Mapbox live-traffic labels).
   Source: a route task, one driver's open tasks, or tasks ticked in the Tasks tab -> ordered stop list.
   Reorder by drag (handle ≡, touch friendly) or ↑/↓; add / remove stops (planning only); start McCook; end McCook or last stop.
   Pickup-before-its-drop is checked (warning) and enforced by "Best order" (exact DP up to 13 movable stops, else greedy + 2-opt).
   Road distances / times come from the map-route edge function (OSRM demo now, Mapbox when the MAPBOX_TOKEN secret is set,
   straight line x1.3 fallback) — estimates, no live traffic.
   Writes: ONLY "Save order to route" (after a confirm): updates dispatch_task_stops.seq of the route's PENDING stops.
   Never inserts or deletes stops, never touches arrived/done stops or any other column. "Use this order" hands the order
   to the board's Combine preview (localStorage + index.html#combine=ids); nothing is created here. */
(function(){
const RFN="https://hqhfstosclasgwgxubip.supabase.co/functions/v1/map-route";
const RP=window.RP={src:"",stops:[],removed:[],start:null,endMode:"base",dwell:Number(localStorage.getItem("shift-rp-dwell")||15),res:null,busy:false,picked:new Set(),saved:[],baseKeys:"",msg:"",mounted:false,drag:null,seqN:0,fitDone:false};
const layer=L.layerGroup().addTo(map);
const nrm=a=>(a||"").toLowerCase().replace(/\b(ste|suite|unit)\b[^,]*/g,"").replace(/[^a-z0-9]/g,"");
const samePl=(a,b)=>(isBase(a)&&isBase(b))||(!!a&&nrm(a)===nrm(b));
const mi=m=>(m/1609.344),fmtMi=m=>{const x=mi(m);return (x<10?x.toFixed(1):Math.round(x))+" mi"};
const fmtT=s=>{const m=Math.round(s/60);return m<60?m+" min":Math.floor(m/60)+" h "+String(m%60).padStart(2,"0")+" min"};
const BASEP=()=>({name:"Darwill McCook",addr:"8701 47th St Ste C, McCook, IL 60525",lat:BASE.lat,lon:BASE.lon});
const llOf=s=>isBase(s.addr)?BASE:(s.lat!=null?s:ll(s.addr));
let K=0;const key=()=>"k"+(++K);
/* ---------- sources ---------- */
function sources(){const o=[];
  T.filter(t=>t.is_route&&t.status!=="completed").forEach(t=>o.push([`r:${t.id}`,`Route #${t.id} · ${t.title||t.pickup_name+" → "+t.delivery_name}`]));
  const by={};T.filter(t=>t.status!=="completed"&&!t.messenger_id&&t.assigned_driver_id).forEach(t=>{(by[t.assigned_driver_id]=by[t.assigned_driver_id]||[]).push(t)});
  Object.entries(by).forEach(([d,l])=>o.push([`d:${d}`,`${dName(d)||"Driver "+d}'s open tasks (${l.length})`]));
  o.push(["p:",`Tasks ticked in the Tasks tab (${RP.picked.size})`]);return o}
function tasksOf(src){if(src.startsWith("d:"))return T.filter(t=>t.status!=="completed"&&!t.messenger_id&&Number(t.assigned_driver_id)===Number(src.slice(2)));
  if(src.startsWith("p:"))return T.filter(t=>RP.picked.has(t.id));return []}
function build(){RP.seqN++;RP.removed=[];RP.res=null;RP.msg="";RP.fitDone=false;const src=RP.src;let stops=[];RP.start=BASEP();
  if(src.startsWith("r:")){const R=T.find(t=>t.id===Number(src.slice(2)));if(!R){RP.stops=[];return}
    RP.start={name:R.pickup_name||"Start",addr:R.pickup_address};
    stops=STOPS.filter(s=>Number(s.task_id)===R.id).sort((a,b)=>(a.seq||0)-(b.seq||0)||a.id-b.id).map(s=>({key:key(),stopId:s.id,seq:s.seq,name:s.location_name,addr:s.location_address,type:s.stop_type,status:s.status,locked:s.status!=="pending",
      parts:(Array.isArray(s.source_parts)?s.source_parts:[]).map(p=>({task_id:Number(p.task_id),type:p.type==="delivery"?"delivery":"pickup"}))}));
    const last=stops[stops.length-1];RP.endMode=last&&isBase(last.addr)?"base":stops.length&&stops.every(s=>s.type==="delivery")?"last":"base";
  }else{const list=tasksOf(src),fin=[];
    const add=(s)=>{const m=stops.find(x=>!x.locked&&x.type===s.type&&samePl(x.addr,s.addr));if(m){m.parts.push(...s.parts);return}stops.push(s)};
    list.forEach(t=>{if(t.is_route){STOPS.filter(s=>Number(s.task_id)===t.id&&s.status==="pending").sort((a,b)=>(a.seq||0)-(b.seq||0)).forEach(s=>(s.stop_type==="delivery"&&isBase(s.location_address)?x=>fin.push(x):add)({key:key(),name:s.location_name,addr:s.location_address,type:s.stop_type,parts:(Array.isArray(s.source_parts)&&s.source_parts.length?s.source_parts:[{task_id:t.id,type:s.stop_type==="delivery"?"delivery":"pickup"}]).map(p=>({task_id:Number(p.task_id),type:p.type==="delivery"?"delivery":"pickup"}))}));return}
      if(t.status!=="in_progress"&&!isBase(t.pickup_address))add({key:key(),name:t.pickup_name,addr:t.pickup_address,type:"pickup",parts:[{task_id:t.id,type:"pickup"}]});
      const d={key:key(),name:t.delivery_name,addr:t.delivery_address,type:"delivery",parts:[{task_id:t.id,type:"delivery"}]};if(isBase(t.delivery_address))fin.push(d);else add(d)});
    if(fin.length)stops.push({...fin[0],name:"Darwill McCook",parts:fin.flatMap(f=>f.parts)});RP.endMode="base";}
  RP.stops=stops;RP.baseKeys=stops.map(s=>s.key).join(",");coords(stops.map(s=>s.addr));}
/* structure: locked prefix (done/arrived), movable, forced last (McCook drop when ending at McCook) */
function parts3(){const act=RP.stops,locked=act.filter(s=>s.locked),mov=act.filter(s=>!s.locked);let last=null;
  if(RP.endMode==="base"){const i=mov.map(s=>isBase(s.addr)&&s.type==="delivery").lastIndexOf(true);if(i>=0)last=mov.splice(i,1)[0]}
  return {locked,mov,last}}
function ordered(){const {locked,mov,last}=parts3();return [...locked,...mov,...(last?[last]:[])]}
function setOrder(movKeys){const {locked,last}=parts3(),m=movKeys.map(k=>RP.stops.find(s=>s.key===k)).filter(Boolean);RP.stops=[...locked,...m,...(last?[last]:[])];RP.res=null;changed()}
function warnings(list){const w=[],loadedAtStart=new Set();
  list.forEach((s,i)=>s.parts.filter(p=>p.type==="delivery").forEach(p=>{const pi=list.findIndex(x=>x.parts.some(q=>q.task_id===p.task_id&&q.type==="pickup"));if(pi>i)w.push(`#${p.task_id} is dropped at stop ${i+1} before it is picked up at stop ${pi+1}`)}));return w}
/* ---------- routing ---------- */
async function callR(action,pts){const r=await fetch(RFN,{method:"POST",headers:{"Content-Type":"application/json",apikey:KEY,Authorization:"Bearer "+KEY},body:JSON.stringify({action,points:pts.map(p=>[p.lat,p.lon])})});const j=await r.json();if(j.error)throw new Error(j.error);return j}
function pathPts(){const list=ordered(),st=llOf(RP.start)||BASE,pts=[{...st,label:"Start"}];const missing=[];
  list.forEach((s,i)=>{const c=llOf(s);if(c)pts.push({lat:c.lat,lon:c.lon,i});else missing.push(s.name||s.addr)});
  const endBase=RP.endMode==="base"&&!(list.length&&isBase(list[list.length-1].addr));if(endBase)pts.push({...BASE,end:true});return {pts,missing,endBase}}
let tmr=null;function changed(){render();clearTimeout(tmr);tmr=setTimeout(route,350)}
async function route(){const {pts,missing,endBase}=pathPts(),n=++RP.seqN;RP.missing=missing;
  if(pts.length<2){RP.res=null;drawLayer();render();return}
  try{RP.busy=true;render();const r=await callR("route",pts);if(n!==RP.seqN)return;
    const legAt={};pts.slice(1).forEach((p,j)=>{legAt[p.end?"end":p.i]=r.legs[j]});RP.res={...r,legAt,endBase}}
  catch(e){RP.res=null;RP.msg="Routing failed: "+e.message}finally{if(n===RP.seqN){RP.busy=false;drawLayer();render()}}}
/* ---------- best order: TSP with precedence ---------- */
async function best(){const {locked,mov,last}=parts3();if(mov.length<2){RP.msg="Nothing to reorder.";return render()}
  const fromS=locked.length?locked[locked.length-1]:RP.start,from=llOf(fromS)||BASE,nodes=mov.filter(s=>llOf(s)),skipped=mov.filter(s=>!llOf(s));
  const to=last?llOf(last):RP.endMode==="base"?BASE:null;const pts=[from,...nodes.map(llOf),...(to?[to]:[])];
  if(pts.length>25){RP.msg="Too many stops for Best order (max 23).";return render()}
  RP.busy=true;RP.msg="Finding the best order…";render();let M;
  try{M=await callR("table",pts)}catch(e){RP.busy=false;RP.msg="Best order failed: "+e.message;return render()}
  const n=nodes.length,D=M.durations,cost=(a,b)=>D[a][b],endIdx=to?n+1:-1;
  const doneT=new Set([...locked].flatMap(s=>s.parts.filter(p=>p.type==="pickup").map(p=>p.task_id)));
  const pred=nodes.map((s,i)=>{let m=0;s.parts.filter(p=>p.type==="delivery"&&!doneT.has(p.task_id)).forEach(p=>nodes.forEach((x,j)=>{if(j!==i&&x.parts.some(q=>q.task_id===p.task_id&&q.type==="pickup"))m|=1<<j}));return m});
  let order=null;
  if(n<=13){const F=1<<n,INF=1e15,dp=new Float64Array(F*n).fill(INF),par=new Int16Array(F*n).fill(-1);
    for(let i=0;i<n;i++)if(!pred[i])dp[(1<<i)*n+i]=cost(0,i+1);
    for(let m=1;m<F;m++)for(let i=0;i<n;i++){const v=dp[m*n+i];if(v>=INF)continue;for(let j=0;j<n;j++){if(m&(1<<j)||(pred[j]&m)!==pred[j])continue;const mm=m|(1<<j),c=v+cost(i+1,j+1);if(c<dp[mm*n+j]){dp[mm*n+j]=c;par[mm*n+j]=i}}}
    let bi=-1,bv=INF;for(let i=0;i<n;i++){const v=dp[(F-1)*n+i]+(to?cost(i+1,endIdx):0);if(v<bv){bv=v;bi=i}}
    if(bi>=0){order=[];let m=F-1,i=bi;while(i>=0){order.unshift(i);const p=par[m*n+i];m&=~(1<<i);i=p}}}
  else{const ok=o=>o.every((x,k)=>(pred[x]&~o.slice(0,k).reduce((a,y)=>a|(1<<y),0))===0);
    const len=o=>o.reduce((a,x,k)=>a+cost(k?o[k-1]+1:0,x+1),0)+(to?cost(o[o.length-1]+1,endIdx):0);
    let o=[],left=new Set(nodes.map((_,i)=>i)),cur=0;while(left.size){let b=null;for(const j of left)if(o.every(()=>1)&&(pred[j]&~o.reduce((a,y)=>a|(1<<y),0))===0&&(b==null||cost(cur,j+1)<cost(cur,b+1)))b=j;if(b==null)b=[...left][0];o.push(b);left.delete(b);cur=b+1}
    let imp=true;while(imp){imp=false;for(let a=0;a<n-1;a++)for(let b=a+1;b<n;b++){const c=[...o.slice(0,a),...o.slice(a,b+1).reverse(),...o.slice(b+1)];if(ok(c)&&len(c)<len(o)-1){o=c;imp=true}}}order=o}
  RP.busy=false;if(!order){RP.msg="No order satisfies every pickup-before-drop rule — check the stops.";return render()}
  const before=mov.map(s=>s.key).join(",");setOrder([...order.map(i=>nodes[i].key),...skipped.map(s=>s.key)]);
  RP.msg=(before===parts3().mov.map(s=>s.key).join(",")?"Already in the best order":"Best order applied")+` (by ${M.provider==="straight"?"straight-line estimate":M.traffic?"drive time with live traffic":"drive time"}${n>13?", heuristic":""}).`+(skipped.length?" Stops without a map location were left at the end.":"");render()}
/* ---------- actions ---------- */
RP.move=(k,d)=>{const {mov}=parts3(),ks=mov.map(s=>s.key),i=ks.indexOf(k),j=i+d;if(i<0||j<0||j>=ks.length)return;[ks[i],ks[j]]=[ks[j],ks[i]];setOrder(ks)};
RP.remove=k=>{const s=RP.stops.find(x=>x.key===k);if(!s||s.locked)return;RP.stops=RP.stops.filter(x=>x!==s);RP.removed.push(s);changed()};
RP.restore=k=>{const s=RP.removed.find(x=>x.key===k);if(!s)return;RP.removed=RP.removed.filter(x=>x!==s);const {last}=parts3();const i=last?RP.stops.indexOf(last):RP.stops.length;RP.stops.splice(i,0,s);changed()};
RP.addStop=async v=>{if(!v)return;const [name,addr]=JSON.parse(v);const s={key:key(),name,addr,type:"delivery",parts:[],added:true};const {last}=parts3();const i=last?RP.stops.indexOf(last):RP.stops.length;RP.stops.splice(i,0,s);await coords([addr]);changed()};
RP.setSrc=v=>{RP.src=v;build();changed();fitPlan()};
RP.setEnd=v=>{RP.endMode=v;changed()};
RP.setDwell=v=>{RP.dwell=Math.max(0,Math.min(240,Number(v)||0));localStorage.setItem("shift-rp-dwell",RP.dwell);render()};
RP.best=best;RP.reset=()=>{build();changed()};
RP.togglePick=(id,on)=>{on?RP.picked.add(id):RP.picked.delete(id);if(RP.src==="p:"){build();changed()}};
RP.save=async()=>{const R=T.find(t=>t.id===Number(RP.src.slice(2)));if(!R||RP.removed.length||RP.stops.some(s=>s.added))return;
  const pend=RP.stops.filter(s=>!s.locked&&s.stopId),slotsRaw=pend.map(s=>s.seq).sort((a,b)=>a-b);
  const lockMax=Math.max(0,...RP.stops.filter(s=>s.locked).map(s=>s.seq||0));
  const slots=new Set(slotsRaw).size===slotsRaw.length?slotsRaw:pend.map((_,i)=>lockMax+1+i);
  const ch=pend.map((s,i)=>({s,seq:slots[i]})).filter(x=>x.seq!==x.s.seq);
  if(!ch.length){RP.msg="The route already has this order — nothing to save.";return render()}
  const w=warnings(ordered());
  if(!confirm(`Save this stop order to route #${R.id}?\n\n${pend.map((s,i)=>`${i+1+RP.stops.filter(x=>x.locked).length}. ${s.name}`).join("\n")}\n\nOnly the order of the ${pend.length} not-yet-reached stops changes (${ch.length} stop${ch.length>1?"s":""} move). Done / arrived stops and every stop detail stay as they are. Nothing is deleted.${w.length?"\n\n⚠ "+w.join("\n⚠ "):""}`))return;
  RP.busy=true;RP.msg="Saving…";render();const errs=[];
  for(const x of ch){const r=await db.from("dispatch_task_stops").update({seq:x.seq}).eq("id",x.s.stopId).eq("task_id",R.id).eq("status","pending");if(r.error)errs.push(r.error.message)}
  RP.busy=false;RP.msg=errs.length?"⚠ Some stops could not be saved: "+errs.join("; "):`✓ Saved the new order to route #${R.id}.`;
  if(!errs.length){const keep=RP.src;await refresh();RP.src=keep;build();changed()}else render()};
RP.use=()=>{const list=tasksOf(RP.src);if(list.length<2){RP.msg="Pick at least two tasks to combine.";return render()}
  localStorage.setItem("shift-route-plan",JSON.stringify({ids:list.map(t=>t.id),keys:ordered().map(s=>[...s.parts.map(p=>p.task_id+":"+p.type),"@"+(isBase(s.addr)?"base":nrm(s.addr))+":"+(s.type==="pickup"?"pickup":"delivery")]),at:Date.now()}));
  RP.msg="Order handed to the board — the Combine preview opens there with this order. Nothing is created until you press Create route.";render();
  window.open("index.html#combine="+list.map(t=>t.id).join(","),"shift-board")};
/* ---------- map layer ---------- */
function drawLayer(){layer.clearLayers();if(TAB!=="route")return;const list=ordered();
  if(RP.res&&RP.res.geometry)L.polyline(RP.res.geometry,{color:"#2f6fde",weight:5,opacity:.85,dashArray:RP.res.provider==="straight"?"8 8":null}).addTo(layer);
  list.forEach((s,i)=>{const c=llOf(s);if(!c)return;L.marker([c.lat,c.lon],{zIndexOffset:800,icon:L.divIcon({className:"",html:`<div class="rpn ${s.locked?"lk":""}">${i+1}</div>`,iconSize:[26,26],iconAnchor:[13,13]})}).bindTooltip(`${i+1}. ${esc(s.name||"")}`,{direction:"top",offset:[0,-12]}).addTo(layer)})}
function fitPlan(){const cs=[llOf(RP.start)||BASE,...RP.stops.map(llOf).filter(Boolean)];if(cs.length>1)map.fitBounds(cs.map(c=>[c.lat,c.lon]),{...pad(),maxZoom:13})}
RP.layerOn=on=>{if(on){drawLayer();if(!map.hasLayer(layer))layer.addTo(map)}else layer.clearLayers()};
/* ---------- panel ---------- */
const typeTag=s=>s.added?"added":s.type==="both"?"pickup + drop":s.type==="pickup"?"pickup":"drop";
function legTxt(l){return l?`<div class="rpleg">↳ ${fmtMi(l.m)} · ${fmtT(l.s)}</div>`:""}
function row(s,i,mode){const c=llOf(s),l=RP.res&&RP.res.legAt[i];const tasks=[...new Set(s.parts.map(p=>"#"+p.task_id))].join(", ");
  return `${legTxt(l)}<div class="rps ${mode}" data-k="${s.key}">${mode==="mov"?'<span class="rph" title="Drag to reorder">≡</span>':`<span class="rph off">${s.locked?"✓":"⚑"}</span>`}<span class="rpn sm ${s.locked?"lk":""}">${i+1}</span>
   <div class="mid"><div><b>${esc(s.name||"")}</b> <span class="rpt ${s.type}">${typeTag(s)}</span>${s.locked?` <span class="rpt lk">${esc(s.status)}</span>`:""}</div><div class="sb">${esc(s.addr||"")}${tasks?" · "+tasks:""}${c?"":' <span class="nogeo">· not on map yet</span>'}</div></div>
   ${mode==="mov"?`<button class="rpb" type="button" onclick="RP.move('${s.key}',-1)" aria-label="Move up">↑</button><button class="rpb" type="button" onclick="RP.move('${s.key}',1)" aria-label="Move down">↓</button><button class="rpb x" type="button" onclick="RP.remove('${s.key}')" aria-label="Remove">✕</button>`:mode==="last"?`<span class="sb" style="align-self:center">end</span>`:""}</div>`}
function html(){const src=sources(),{locked,mov,last}=parts3(),list=ordered(),w=warnings(list),r=RP.res;
  const isR=RP.src.startsWith("r:"),edited=RP.removed.length||RP.stops.some(s=>s.added);
  const known=[...new Map([...(RP.saved||[]).map(s=>[s.address,s.name]),...T.flatMap(t=>[[t.pickup_address,t.pickup_name],[t.delivery_address,t.delivery_name]])].filter(([a])=>a)).entries()];
  const dw=list.length*RP.dwell,tot=r?r.total.s+dw*60:null;
  return `<div class="rp"><label class="rpl">Plan<select id="rpSrc" onchange="RP.setSrc(this.value)"><option value="">— pick a route, a driver or ticked tasks —</option>${src.map(([v,l])=>`<option value="${v}" ${v===RP.src?"selected":""}>${esc(l)}</option>`).join("")}</select></label>
  ${!RP.src?'<div class="empty">Pick what to plan. Tick tasks in the Tasks tab to plan a new combined route.</div>':`
  <div class="rpstart"><span class="rph off">🏁</span><div class="mid"><b>Start: ${esc(RP.start.name||"")}</b><div class="sb">${esc(RP.start.addr||"")}</div></div></div>
  ${locked.map((s,i)=>row(s,i,"lk")).join("")}<div id="rpMov">${mov.map((s,i)=>row(s,locked.length+i,"mov")).join("")}</div>${last?row(last,list.length-1,"last"):""}
  ${RP.endMode==="base"&&r&&r.endBase?`${legTxt(r.legAt.end)}<div class="rpstart"><span class="rph off">🏠</span><div class="mid"><b>End: Darwill McCook</b></div></div>`:""}
  ${RP.removed.length?`<div class="sb" style="padding:6px 14px">Removed (planning only): ${RP.removed.map(s=>`<button class="rpb" style="width:auto;padding:0 8px" type="button" onclick="RP.restore('${s.key}')">↺ ${esc(s.name)}</button>`).join(" ")}</div>`:""}
  ${w.length?`<div class="rpw">⚠ ${w.map(esc).join("<br>⚠ ")}</div>`:""}
  <div class="rpopt"><label>End <select onchange="RP.setEnd(this.value)"><option value="base" ${RP.endMode==="base"?"selected":""}>Back at McCook</option><option value="last" ${RP.endMode==="last"?"selected":""}>At the last stop</option></select></label>
   <label>Stop time <input type="number" min="0" max="240" step="5" value="${RP.dwell}" onchange="RP.setDwell(this.value)" style="width:58px"> min</label>
   <select id="rpAdd" onchange="RP.addStop(this.value);this.value=''" style="max-width:100%"><option value="">+ Add a stop…</option>${known.map(([a,n])=>`<option value="${esc(JSON.stringify([n,a]))}">${esc(n||a)} — ${esc(a)}</option>`).join("")}</select></div>
  <div class="rptot">${r?`<div><b>${fmtMi(r.total.m)}</b> · <b>${fmtT(r.total.s)}</b> driving</div><div class="sb">+ ${list.length} stop${list.length===1?"":"s"} × ${RP.dwell} min = <b>${fmtT(tot)}</b> total</div><div class="rplab">${esc(r.label)}${r.cached?" · cached"+(r.provider==="mapbox"&&r.cached_at?" "+esc(clk(r.cached_at)):""):""}${r.note?" · fallback: "+esc(r.note):""}</div>`:RP.busy?'<div class="sb">Calculating…</div>':'<div class="sb">No route yet.</div>'}${RP.missing&&RP.missing.length?`<div class="nogeo" style="font-size:12px">Not on the map yet (left out of the miles): ${esc(RP.missing.join(", "))}</div>`:""}</div>
  <div class="rpact"><button class="rpbtn" type="button" onclick="RP.best()" ${RP.busy||mov.length<2?"disabled":""}>✨ Best order</button><button class="rpbtn g" type="button" onclick="RP.reset()">↺ Reset</button>
   ${isR?`<button class="rpbtn p" type="button" onclick="RP.save()" ${RP.busy||edited||!mov.length?"disabled":""} title="${edited?"Added / removed stops are planning only — edit stops on the board":""}">💾 Save order to route</button>`:`<button class="rpbtn p" type="button" onclick="RP.use()" ${tasksOf(RP.src).length<2?"disabled":""}>⛓ Use this order (Combine)</button>`}</div>
  ${edited&&isR?'<div class="sb" style="padding:0 14px">Added / removed stops are for planning only; Save is off. Change stops on the board.</div>':""}
  ${RP.msg?`<div class="rpmsg">${esc(RP.msg)}</div>`:""}`}
  <div class="foot">${RP.res&&RP.res.traffic?"Drive times from Mapbox include live traffic (still estimates).":"Estimated drive times with no live traffic."} Done / arrived stops are fixed. Save changes only the order of pending stops; nothing is deleted.</div></div>`}
function render(soft){const b=$("body");if(TAB!=="route"||RP.drag)return;const ae=document.activeElement;if(soft===true&&b.querySelector(".rp")&&ae&&b.contains(ae)&&/^(SELECT|INPUT)$/.test(ae.tagName))return;const sc=b.scrollTop;b.innerHTML=html();b.scrollTop=sc;wireDrag();drawLayer()}
RP.render=render;
RP.onData=async()=>{if(!RP.savedLoaded){RP.savedLoaded=true;const r=await db.from("saved_locations").select("name,address").order("name");RP.saved=r.data||[]}
  if(!RP.src)return;const fresh=RP.src.startsWith("r:")?STOPS.filter(s=>Number(s.task_id)===Number(RP.src.slice(2))).map(s=>s.id+":"+s.status+":"+s.seq).sort().join(","):"";
  if(RP.src.startsWith("r:")&&fresh!==RP.fresh){const pristine=RP.stops.map(s=>s.key).join(",")===RP.baseKeys&&!RP.removed.length;RP.fresh=fresh;if(pristine||!RP.stops.length){build();route()}}
  if(RP.res&&RP.missing&&RP.missing.length&&RP.stops.some(s=>llOf(s)))route()};
/* ---------- drag (pointer events: mouse + touch) ---------- */
function wireDrag(){const box=$("rpMov");if(!box)return;box.querySelectorAll(".rph").forEach(h=>{h.addEventListener("pointerdown",e=>{e.preventDefault();const el=h.closest(".rps");RP.drag={el};el.classList.add("dragging");
  const mv=ev=>{const y=ev.clientY,rows=[...box.querySelectorAll(".rps:not(.dragging)")];const nx=rows.find(r=>{const b=r.getBoundingClientRect();return y<b.top+b.height/2});
    const legOf=x=>x.previousElementSibling&&x.previousElementSibling.classList.contains("rpleg")?x.previousElementSibling:null;const lg=legOf(el);if(lg)lg.remove();
    if(nx){const t=legOf(nx)||nx;box.insertBefore(el,t)}else box.appendChild(el);const bd=$("body").getBoundingClientRect();if(y<bd.top+30)$("body").scrollTop-=12;if(y>bd.bottom-30)$("body").scrollTop+=12};
  const up=()=>{window.removeEventListener("pointermove",mv);window.removeEventListener("pointerup",up);window.removeEventListener("pointercancel",up);el.classList.remove("dragging");RP.drag=null;setOrder([...box.querySelectorAll(".rps")].map(r=>r.dataset.k))};
  window.addEventListener("pointermove",mv);window.addEventListener("pointerup",up);window.addEventListener("pointercancel",up)})})}
})();
