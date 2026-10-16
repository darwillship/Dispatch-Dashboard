/* truck-shared.js (v4.8.0) — driver ↔ truck at time T, shared by trucks.html and map.html. Same rules as the board
 * (trucks-board.js) and vzc-sync: pre-trip > hand-set after it > Truck Schedule; later pre-trip wins. Needs global D =
 * {drivers, sched, ts, sw, te, teOk}. Classic script: its top-level names are shared with the page script. */
const F=new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
const parts=t=>{let o={};for(const p of F.formatToParts(new Date(t)))o[p.type]=p.value;return o};
const ctDate=t=>{let p=parts(t);return `${p.year}-${p.month}-${p.day}`};
function ctAt(date,hhmm){let [h,m]=hhmm.split(":").map(Number);let g=Date.parse(`${date}T${String(h).padStart(2,"0")}:${String(m||0).padStart(2,"0")}:00Z`);for(let i=0;i<3;i++){let p=parts(g);let a=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);let want=Date.parse(`${date}T${String(h).padStart(2,"0")}:${String(m||0).padStart(2,"0")}:00Z`);g+=want-a}return g}
const addDays=(d,n)=>{let x=new Date(d+"T12:00:00Z");x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const clk=t=>t?new Date(t).toLocaleTimeString("en-US",{timeZone:"America/Chicago",hour:"numeric",minute:"2-digit"}):"";
const when=t=>{if(!t)return "—";let d=ctDate(t)===ctDate(Date.now())?"":new Date(t).toLocaleDateString("en-US",{timeZone:"America/Chicago",weekday:"short",month:"numeric",day:"numeric"})+" ";let m=Math.round((Date.now()-Date.parse(t))/60000);return d+clk(t)+(m<120?` (${m<1?"just now":m+" min ago"})`:"")};
const WORKING=new Set(["working","messenger"]),SVC={in_service:"In Service",out_of_service:"Out of Service",repair_shop:"At Repair Shop"};
let D={};
/* same rules as the board (trucks-board.js): daily override > weekly truck schedule; a switch splits the shift; only ONE clearly scheduled driver counts */
function shiftsFor(date){const dow=new Date(date+"T12:00:00Z").getUTCDay(),out=[];
  const span=(s,e)=>{if(!s||!e)return [null,null];let a=ctAt(date,s.slice(0,5)),b=ctAt(date,e.slice(0,5));if(b<=a)b=ctAt(addDays(date,1),e.slice(0,5));return [a,b]};
  for(const d of D.drivers){if(d.is_messenger)continue;
    const row=D.sched.find(r=>Number(r.driver_id)===d.id&&String(r.work_date).slice(0,10)===date)||null;
    const base=D.ts.filter(r=>Number(r.driver_id)===d.id&&r.active!==false&&(r.days||[]).map(Number).includes(dow));
    const ovT=row&&row.vehicle_id!=null&&row.vehicle_source!=="auto_gps"&&!(D.teOk&&row.vehicle_set_at)?Number(row.vehicle_id):null;
    const mk=(s,e,v,src)=>{let [a,b]=span(s,e);return {driverId:d.id,name:d.name,date,working:true,start:a,end:b,vehicleId:v,src,vehicleSource:v!=null?src:null}};
    if(row){if(!WORKING.has(String(row.status||"working")))continue;
      if(row.start_time&&row.end_time){let bv=[...new Set(base.map(b=>b.vehicle_id).filter(x=>x!=null).map(Number))];out.push(mk(row.start_time,row.end_time,ovT??(bv.length===1?bv[0]:null),ovT!=null?"override":"weekly"));continue}
      for(const b of base)out.push(mk(b.start_time,b.end_time,ovT??(b.vehicle_id!=null?Number(b.vehicle_id):null),ovT!=null?"override":"weekly"));continue}
    for(const b of base)out.push(mk(b.start_time,b.end_time,b.vehicle_id!=null?Number(b.vehicle_id):null,"weekly"));}
  if(D.teOk)return applyTruckEvents(date,out,D.te).filter(s=>s.start!=null).map(s=>({...s,src:s.vehicleSource||"weekly"}));
  for(const w of D.sw.filter(x=>String(x.work_date).slice(0,10)===date)){const at=Date.parse(w.switched_at);const i=out.findIndex(s=>s.driverId===Number(w.driver_id)&&s.start!=null&&at>s.start&&at<s.end);if(i<0)continue;const s=out[i];
    out.splice(i,1,{...s,end:at,vehicleId:w.from_vehicle_id!=null?Number(w.from_vehicle_id):s.vehicleId},{...s,start:at,vehicleId:Number(w.to_vehicle_id),src:"switch"})}
  return out}
/* v4.7.0: same pre-trip / hand-set rules as the board (trucks-board.js applyTruckEvents, copied verbatim) */
const PRETRIP_LEAD_MS=3*3600e3,PRETRIP_DEFAULT_MS=12*3600e3;
function applyTruckEvents(date,out,events){
  const evs=(events||[]).filter(e=>String(e.work_date).slice(0,10)===date&&e.at).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const dayA=ctAt(date,"00:00"),dayB=ctAt(addDays(date,1),"00:00");
  const win=s=>(s.start==null||s.noTimes?[dayA,dayB]:[s.start,s.end]);
  for(const e of evs){
    const did=Number(e.driver_id),v=e.vehicle_id!=null?Number(e.vehicle_id):null;
    let at=Date.parse(e.at);if(e.kind!=="pretrip")at=Math.min(Math.max(at,dayA),dayB-1);
    const tag={evKind:e.kind,evAt:at,evRef:e.ref_id??null,evText:e.vehicle_text??null};
    if(e.kind==="pretrip")for(const s of out)if(s.driverId===did&&s.date===date){if(s.pretripAt==null){s.pretripAt=at;s.pretripText=e.vehicle_text||null;s.pretripVid=v}}
    if(v==null)continue;
    const mine=out.map((s,i)=>[s,i]).filter(([s])=>s.driverId===did&&s.date===date&&s.working);
    let hit=mine.find(([s])=>{const [a,b]=win(s);return at>=a&&at<b});
    if(!hit)hit=mine.filter(([s])=>s.start!=null&&!s.noTimes&&s.start>at&&(e.kind!=="pretrip"||s.start-at<=PRETRIP_LEAD_MS)).sort((x,y)=>x[0].start-y[0].start)[0];
    if(!hit&&e.kind!=="pretrip")continue;
    if(!hit){
      const d=(D.drivers||[]).find(x=>Number(x.id)===did);
      const end=e.shift_end?Date.parse(e.shift_end):at+PRETRIP_DEFAULT_MS;
      const base=(mine[0]&&mine[0][0])||out.find(s=>s.driverId===did&&s.date===date)||{};
      out.push({...base,driverId:did,name:base.name||(d&&d.name)||"Driver "+did,date,working:true,start:at,end,timesFrom:"pretrip",vehicleId:v,vehicleSource:e.kind,row:base.row??null,noTimes:false,pretripAt:base.pretripAt??(e.kind==="pretrip"?at:null),...tag});
    }else{
      const [s,i]=hit,[a,b]=win(s);
      if(at<=a){Object.assign(s,{vehicleId:v,vehicleSource:e.kind,...tag});if(e.kind==="pretrip"&&!s.noTimes&&s.start!=null&&at<s.start)s.start=at}
      else out.splice(i,1,{...s,start:a,end:at,noTimes:false},{...s,start:at,end:b,noTimes:false,vehicleId:v,vehicleSource:e.kind,...tag});
      for(const s2 of out)if(s2.driverId===did&&s2.date===date&&s2.working&&s2.start!=null&&s2.start>=b&&!s2.evKind)Object.assign(s2,{vehicleId:v,vehicleSource:e.kind,...tag});
    }
    for(let k=out.length-1;k>=0;k--){
      const o=out[k];
      if(o.driverId===did||!o.working||o.vehicleId!==v)continue;
      if((o.evAt??-Infinity)>=at)continue;
      const [a,b]=win(o);if(b<=at)continue;
      const taken={takenBy:did,takenAt:at,takenKind:e.kind,takenVid:v};
      if(a>=at)Object.assign(o,{vehicleId:null,vehicleSource:null,...taken});
      else out.splice(k,1,{...o,start:a,end:at,noTimes:false},{...o,start:at,end:b,noTimes:false,vehicleId:null,vehicleSource:null,...taken});
    }
  }
  return out;
}
const truckSource=s=>s.vehicleId==null?"none":s.vehicleSource==="pretrip"?"pretrip":["hand","override","switch"].includes(s.vehicleSource)?"hand":"scheduled";
const truckOf=(s,all)=>{if(s.vehicleId==null)return null;if(s.src==="weekly"&&all.some(o=>o.driverId!==s.driverId&&["override","pretrip","hand"].includes(o.src)&&o.vehicleId===s.vehicleId&&o.start!=null&&s.start!=null&&o.start<s.end&&s.start<o.end))return null;return s.vehicleId};
function driverNow(v,SH){const t=Date.now();const c=SH.filter(s=>s.start!=null&&truckOf(s,SH)===v&&t>=s.start&&t<s.end);if(c.length===1)return {name:c[0].name,until:c[0].end,how:truckSource(c[0])==="pretrip"?"pre-trip "+clk(c[0].evAt):truckSource(c[0])==="hand"?"set by hand":"scheduled"};if(c.length>1)return {name:"⚠ "+c.map(x=>x.name).join(" + ")+" (overlap)"};
  const next=SH.filter(s=>s.start!=null&&truckOf(s,SH)===v&&s.start>t).sort((a,b)=>a.start-b.start)[0];return next?{name:null,next:next.name+" at "+clk(next.start)}:null}
