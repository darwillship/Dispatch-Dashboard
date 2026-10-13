/* v4.5.0 ETAs — "About N min to <place>" for In Progress tasks, from the truck's live Verizon location.
   No routing service: straight-line km × time-of-day factor (+5 min), tuned on real trips Sep 20–Oct 13. */
(function(){
const BASE={name:"McCook",lat:41.80335,lon:-87.83656};
const SUFFIX={street:"st",st:"st",avenue:"ave",ave:"ave",av:"ave",road:"rd",rd:"rd",drive:"dr",dr:"dr",boulevard:"blvd",blvd:"blvd",lane:"ln",ln:"ln",court:"ct",ct:"ct",parkway:"pkwy",pkwy:"pkwy",highway:"hwy",hwy:"hwy",place:"pl",pl:"pl",terrace:"ter",ter:"ter",circle:"cir",cir:"cir",trail:"trl",trl:"trl"};
const DIR={north:"n",south:"s",east:"e",west:"w",n:"n",s:"s",e:"e",w:"w"};
const UNIT_RE=/\b(ste|suite|unit|apt|bldg|building|dock|door|fl|floor|rm|room)\b.*$/,STATE_ZIP_RE=/\b(il|illinois|in|indiana|wi|wisconsin)\b|\b\d{5}(-\d{4})?\b/g;
function norm(a){if(!a)return"";const s=a.toLowerCase().replace(/\b(usa|united states)\b/g," ").replace(/[.#]/g," ").replace(/\s+/g," ");const parts=s.split(",").map(p=>p.trim()).filter(Boolean);let street=(parts[0]||"").replace(UNIT_RE,"").trim(),city="";
 for(let i=1;i<parts.length;i++){const p=parts[i].replace(STATE_ZIP_RE," ").replace(/\s+/g," ").trim();if(p&&!UNIT_RE.test(p)&&!/^[a-z]?\d+[a-z]?$/.test(p)){city=p;break}}
 const toks=street.split(" ").filter(Boolean).map(w=>SUFFIX[w]??DIR[w]??w);if(!/^\d+[a-z]?$/.test(toks[0]||""))return"";return toks.join(" ")+"|"+city}
const km=(a,b)=>{const R=6371,r=x=>x*Math.PI/180,dl=r(b.lat-a.lat),dn=r(b.lon-a.lon);const h=Math.sin(dl/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h))};
const ctHour=t=>Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",hour:"numeric",hourCycle:"h23"}).format(t));
/** minutes for a straight-line distance at time t (backtest: median error ~7 min, 8 of 13 trips within 10 min) */
function minutesFor(k,t){const h=ctHour(t),rush=(h>=7&&h<9)||(h>=15&&h<18);if(k<0.3)return 0;return 5+k*(rush?1.2:1.0)}
const S={geo:new Map(),geoAt:0,live:new Map(),stops:new Map(),at:0};
const isBaseAddr=a=>{const n=norm(a);return n.startsWith("8701 47th st|mccook")};
function place(name,addr){if(!addr)return null;if(isBaseAddr(addr))return{...BASE,name:"McCook"};const g=S.geo.get(addr)||S.geo.get(norm(addr));return g?{name:name||addr.split(",")[0],lat:g.lat,lon:g.lon}:{name:name||addr.split(",")[0],lat:null,lon:null}}
async function refresh(db,tasks){
  const now=Date.now();
  if(now-S.geoAt>10*60e3){const r=await db.from("geocode_cache").select("address,address_norm,lat,lon,status").eq("status","ok");if(!r.error){S.geo.clear();for(const g of r.data||[]){if(g.lat==null)continue;S.geo.set(g.address,g);S.geo.set(g.address_norm,g)}S.geoAt=now}}
  const l=await db.from("vehicle_live_location").select("vehicle_id,state,lat,lon,speed_mph,reported_at,address");if(!l.error){S.live.clear();for(const x of l.data||[])S.live.set(Number(x.vehicle_id),x)}
  const rids=(tasks||[]).filter(t=>t.is_route&&t.status==="in_progress").map(t=>t.id);
  if(rids.length){const s=await db.from("dispatch_task_stops").select("id,task_id,seq,status,location_name,location_address").in("task_id",rids).order("seq");if(!s.error){S.stops.clear();for(const x of s.data||[]){if(!S.stops.has(x.task_id))S.stops.set(x.task_id,[]);S.stops.get(x.task_id).push(x)}}}
  S.at=now;S.tasks=tasks||[];
}
/** the next place this task's truck is heading to */
function targetOf(t){
  if(t.is_route){const st=(S.stops.get(t.id)||[]).find(s=>s.status!=="done");return st?place(st.location_name,st.location_address):{...BASE}}
  const pickup=String(t.task_type||"").toLowerCase()==="pickup"||(isBaseAddr(t.delivery_address)&&!isBaseAddr(t.pickup_address));
  if(pickup){if(t.gps_departed_at)return{...BASE};return place(t.pickup_name,t.pickup_address)}
  return place(t.delivery_name,t.delivery_address);
}
/** {text,title} or null. Hidden when the truck data is older than 10 min. */
function forTask(t,nowMs){
  if(!t||t.status!=="in_progress"||t.messenger_id!=null)return null;
  const vid=Number(t.vehicle_id??t.gps_vehicle_id??0),lv=S.live.get(vid);if(!vid||!lv||lv.lat==null)return null;
  const now=nowMs||Date.now(),age=now-Date.parse(lv.reported_at);if(!(age>=0&&age<=10*60e3)&&!(age<0&&age>-5*60e3))return null;
  const tg=targetOf(t);if(!tg||tg.lat==null)return null;
  const here={lat:lv.lat,lon:lv.lon},d=km(here,tg),moving=/mov|driv/i.test(lv.state||"")||Number(lv.speed_mph)>3;
  if(d<0.25)return{text:"At "+tg.name,title:"Truck is at the next stop"};
  if(!moving){ // parked somewhere else: at a known stop of today's tasks?
    const cands=[];for(const x of S.tasks||[]){for(const [n,a] of [[x.pickup_name,x.pickup_address],[x.delivery_name,x.delivery_address]]){const p=place(n,a);if(p&&p.lat!=null)cands.push(p)}}
    for(const st of [...S.stops.values()].flat()){const p=place(st.location_name,st.location_address);if(p&&p.lat!=null)cands.push(p)}
    cands.push({...BASE});const at=cands.find(p=>km(here,p)<0.25);if(at)return{text:"At "+at.name,title:"Truck is parked here now; ETA resumes when it moves"};
  }
  const m=minutesFor(d,now),r=m<10?Math.max(1,Math.round(m)):Math.round(m/5)*5;
  return{text:`About ${r} min to ${tg.name}`,title:`Estimate from the truck's live location (${d.toFixed(1)} km straight line, ${Math.round(age/60e3)} min old). Usually within ~10 min.`};
}
window.SHIFT_ETA={refresh,forTask,minutesFor,norm,_S:S};
})();
