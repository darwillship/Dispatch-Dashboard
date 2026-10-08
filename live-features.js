/* SHIFT Dispatch v3.9.0 — live truck location chips (Verizon Connect Reveal → vzc-sync Edge Function).
   - Driver card truck badge gets a live chip: "🟢 Moving 34 mph", "🟡 Idle", "⚫ Engine off since 3:46 PM".
   - Fleet strip under the toolbar: every Reveal truck with its live state and street address.
   - "📡 Waiting for GPS" until the vzc-sync updater has written vehicle_live_location (it is NOT scheduled yet).
   - Stale warning when a Moving/Idle truck hasn't reported for 10+ min or the updater hasn't run for 10+ min.
   READ-ONLY: this file only reads public.vehicle_live_location (SELECT-only for the public key). It writes nothing. */
(function(){
const STALE_MS=10*60*1000;
const css=`
.live-chip{display:inline-flex;gap:4px;align-items:center;margin:4px 0 0 6px;font-size:11px;font-weight:900;border-radius:7px;padding:2px 7px;border:1px solid #2b3d4f;background:#132233;color:#9fb3c6;vertical-align:middle;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.live-chip.moving{background:#0f2a1f;border-color:#1f6b45;color:#7ee2a8}
.live-chip.idle{background:#3a2f0b;border-color:#7a6216;color:#ffd666}
.live-chip.off{background:#1a2230;border-color:#34465c;color:#b7c6d6}
.live-chip.stale{background:#3a1616;border-color:#7a2a2a;color:#ffb4b4}
.live-chip.wait{border-style:dashed;color:#7e94a7;font-weight:700}
#fleetStrip{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px;padding:7px 9px;border:1px solid #24405b;border-radius:12px;font-size:12px}
#fleetStrip .fs-title{font-weight:900;color:#9fb3c6;margin-right:4px}
#fleetStrip .fs-truck{display:inline-flex;gap:5px;align-items:center;border:1px solid #22344a;border-radius:9px;padding:3px 8px;max-width:100%}
#fleetStrip .fs-name{font-weight:900;color:#e6eef6}
#fleetStrip .fs-addr{color:#8fa6ba;font-size:11px;font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fleetStrip .live-chip{margin:0}
#fleetStrip .fs-upd{margin-left:auto;color:#7e94a7;font-size:10.5px;font-weight:700}
body.light-mode .live-chip{background:#eef4fa!important;border-color:#c9d8e6!important;color:#3a5164!important}
body.light-mode .live-chip.moving{background:#ecf8f1!important;border-color:#a9d9bd!important;color:#166534!important}
body.light-mode .live-chip.idle{background:#fff6d6!important;border-color:#e3c35a!important;color:#7a5a00!important}
body.light-mode .live-chip.stale{background:#fdecec!important;border-color:#f0b4b4!important;color:#9b1c1c!important}
body.light-mode #fleetStrip{border-color:#c9d8e6!important}body.light-mode #fleetStrip .fs-name{color:#0d1824!important}
body.light-mode #fleetStrip .fs-addr,body.light-mode #fleetStrip .fs-title{color:#3a5164!important}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

let LIVE=new Map(),loaded=false,lastErr=null;
window.SHIFT_live=LIVE;
const clock=v=>typeof SHIFT_ctClock==="function"?SHIFT_ctClock(v):(v?new Date(v).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"");
const stamp=v=>typeof SHIFT_ctStamp==="function"?SHIFT_ctStamp(v):(v||"");
async function fetchLive(){
  try{
    let r=await db.from("vehicle_live_location").select("vehicle_id,state,raw_state,address,speed_mph,heading,reported_at,updated_at");
    if(r.error){lastErr=r.error.message;return}
    LIVE.clear();(r.data||[]).forEach(x=>LIVE.set(Number(x.vehicle_id),x));loaded=true;lastErr=null;
  }catch(e){lastErr=String(e&&e.message||e)}
}
window.SHIFT_fetchLive=fetchLive;
function vName(id){let v=(window.SHIFT_vehicles||[]).find(x=>Number(x.id)===Number(id));return v?v.name:"Vehicle #"+id}
/* {cls,text,tip} for one truck */
function liveInfo(vid,now){
  now=now||Date.now();
  let x=LIVE.get(Number(vid));
  if(!x)return {cls:"wait",text:"📡 Waiting for GPS",tip:LIVE.size?"No live data for this truck from Verizon Connect yet.":"Live truck locations appear once the Verizon Connect updater (vzc-sync) is turned on."};
  let rep=x.reported_at?Date.parse(x.reported_at):null,upd=x.updated_at?Date.parse(x.updated_at):null;
  let active=x.state==="Moving"||x.state==="Idle";
  let stale=(active&&(!rep||now-rep>STALE_MS))||(!upd||now-upd>STALE_MS);
  let tip=[`Verizon Connect: ${x.state}${x.raw_state&&x.raw_state!==x.state?" ("+x.raw_state+")":""}`];
  if(x.address)tip.push("Near "+x.address);
  if(x.speed_mph!=null&&x.state==="Moving")tip.push(`${x.speed_mph} mph${x.heading&&x.heading!=="Unknown"?" heading "+x.heading:""}`);
  if(rep)tip.push("Last GPS report: "+stamp(rep)+" CT");
  if(upd)tip.push("Updated by vzc-sync: "+stamp(upd)+" CT");
  let text;
  if(x.state==="Moving")text=`🟢 Moving${x.speed_mph!=null?" "+Math.round(x.speed_mph)+" mph":""}`;
  else if(x.state==="Idle")text="🟡 Idle";
  else if(x.state==="Engine off")text="⚫ Engine off"+(rep?" since "+clock(rep):"");
  else text="❔ No signal";
  let cls=x.state==="Moving"?"moving":x.state==="Idle"?"idle":"off";
  if(stale){cls="stale";text="⚠ "+(upd&&now-upd>STALE_MS?"GPS feed paused":`${x.state} · last GPS ${rep?clock(rep):"?"}`);tip.unshift(upd&&now-upd>STALE_MS?"The updater has not run for 10+ minutes — data may be old.":"This truck has not reported for 10+ minutes.")}
  return {cls,text,tip:tip.join("\n"),address:x.address||""};
}
window.SHIFT_liveInfo=liveInfo;
window.SHIFT_liveChip=function(vid){let i=liveInfo(vid);return `<span class="live-chip ${i.cls}" title="${esc(i.tip)}">${esc(i.text)}</span>`};

/* driver card: append the live chip to the resolved truck badge */
const origBadge=window.SHIFT_truckBadge;
if(typeof origBadge==="function"){
  window.SHIFT_truckBadge=function(d){
    let html=origBadge.apply(this,arguments),t=typeof SHIFT_resolveTruck==="function"?SHIFT_resolveTruck(d.id):null;
    return t?html+SHIFT_liveChip(t.id):html;
  };
}

/* fleet strip under the toolbar */
function renderFleet(){
  let bar=document.querySelector(".toolbar");if(!bar)return;
  let el=$("fleetStrip");
  if(!el){el=document.createElement("div");el.id="fleetStrip";bar.insertAdjacentElement("afterend",el)}
  if(!LIVE.size){
    el.innerHTML=`<span class="fs-title">🛰 Trucks</span><span class="live-chip wait" title="${esc(lastErr?"Live locations unavailable: "+lastErr:"The Verizon Connect updater (vzc-sync) is built but not turned on yet.")}">📡 Waiting for GPS — live truck locations appear once the Verizon updater is on</span>`;
    return;
  }
  let now=Date.now(),rows=[...LIVE.values()].sort((a,b)=>vName(a.vehicle_id).localeCompare(vName(b.vehicle_id)));
  let newest=Math.max(...rows.map(r=>r.updated_at?Date.parse(r.updated_at):0));
  el.innerHTML=`<span class="fs-title">🛰 Trucks</span>`+rows.map(r=>{let i=liveInfo(r.vehicle_id,now);
    return `<span class="fs-truck" title="${esc(i.tip)}"><span class="fs-name">${esc(vName(r.vehicle_id))}</span><span class="live-chip ${i.cls}">${esc(i.text)}</span>${i.address?`<span class="fs-addr">${esc(i.address)}</span>`:""}</span>`}).join("")+
    (newest?`<span class="fs-upd">updated ${esc(clock(newest))} CT</span>`:"");
}
window.SHIFT_renderFleet=renderFleet;

const origLoad=window.load;
window.load=async function(...a){await fetchLive();return origLoad.apply(this,a)};
const origRender=window.render;
window.render=function(...a){let r=origRender.apply(this,a);try{renderFleet()}catch(e){console.warn("fleet strip",e)}return r};

// first paint may have happened before this file loaded
fetchLive().then(()=>{try{render()}catch(_){}});
})();
