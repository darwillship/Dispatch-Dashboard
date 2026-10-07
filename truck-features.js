/* SHIFT Dispatch v3.6.0 — trucks per driver (names match Verizon Connect Reveal).
   - Driver Schedule → Weekly Schedule: "Default truck" per driver  -> drivers.default_vehicle_id (saves on change).
   - Driver Schedule → Daily Overrides: "Truck" per driver/date      -> driver_schedule.vehicle_id (saved with Save Overrides).
   - Driver card header shows the resolved truck for the board date.
   Rule (same as the driver_daily_vehicle view): coalesce(driver_schedule.vehicle_id for driver+date, drivers.default_vehicle_id).
   Writes: one drivers row (default_vehicle_id only) per change; driver_schedule rows only through the existing Save Overrides flow. */
(function(){
let VEH=[];window.SHIFT_vehicles=VEH;
const css=`
.driver-truck{display:inline-flex;gap:5px;align-items:center;margin-top:4px;font-size:11.5px;font-weight:900;color:#cfe3f6;background:#132233;border:1px solid #24405b;border-radius:7px;padding:2px 7px;cursor:pointer}
.driver-truck.none{color:#7e94a7;border-style:dashed;font-weight:700}
.weekly-driver-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 0 9px}
.weekly-driver-head h4{margin:0!important}
.truck-pick{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;color:#9fb3c6;white-space:nowrap}
.truck-pick select{width:auto;min-width:150px;padding:6px 8px;font-size:12px}
.truck-saved{font-size:10px;color:#6fd39a;font-weight:900;min-width:44px}
.schedule-vehicle{padding:8px 8px;font-size:12px}
@media(min-width:701px){.schedule-dialog{width:min(1000px,100%)!important}.schedule-row{grid-template-columns:minmax(130px,1.1fr) 108px 100px 100px minmax(130px,1.2fr) 170px auto!important}#overrideSchedulePanel .schedule-toolbar input[type=date]{width:auto}}
body.light-mode .driver-truck{background:#eef4fa!important;border-color:#c9d8e6!important;color:#1d3a55!important}
body.light-mode .driver-truck.none{color:#6b7f90!important}
body.light-mode .truck-pick{color:#3a5164}
`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);

function vName(id){let v=VEH.find(x=>Number(x.id)===Number(id));return v?v.name:null}
function options(selected,noneLabel){
  let sel=selected==null?null:Number(selected);
  let list=VEH.filter(v=>v.active!==false||Number(v.id)===sel);
  return `<option value="">${esc(noneLabel)}</option>`+list.map(v=>`<option value="${v.id}" ${Number(v.id)===sel?"selected":""}>${esc(v.name)}${v.active===false?" (inactive)":""}</option>`).join("");
}
async function fetchVehicles(){
  try{let r=await db.from("vehicles").select("id,name,active").order("name");if(!r.error){VEH.length=0;VEH.push(...(r.data||[]))}}catch(e){console.warn("vehicles unavailable",e)}
}
const origLoad=window.load;
window.load=async function(...a){await fetchVehicles();return origLoad.apply(this,a)};

/* resolved truck for a driver on the board date */
window.SHIFT_resolveTruck=function(driverId,date){
  date=date||boardDate;
  let ov=(driverSchedule||[]).find(x=>Number(x.driver_id)===Number(driverId)&&String(x.work_date).slice(0,10)===String(date).slice(0,10));
  if(ov&&ov.vehicle_id)return{id:Number(ov.vehicle_id),name:vName(ov.vehicle_id),source:"override"};
  let d=(drivers||[]).find(x=>Number(x.id)===Number(driverId));
  if(d&&d.default_vehicle_id)return{id:Number(d.default_vehicle_id),name:vName(d.default_vehicle_id),source:"default"};
  return null;
};
window.SHIFT_truckBadge=function(d){
  let t=SHIFT_resolveTruck(d.id);
  if(!t)return `<div class="driver-truck none" onclick="openDriverSchedule()" title="No truck set — pick a default truck or a daily truck in Driver Schedule">🚛 No truck</div>`;
  return `<div class="driver-truck" onclick="openDriverSchedule()" title="${t.source==="override"?"Daily truck for this date (Driver Schedule → Daily Overrides)":"Default truck (Driver Schedule → Weekly Schedule)"}">🚛 ${esc(t.name||("Vehicle #"+t.id))}${t.source==="override"?' <span class="src-tag">this date</span>':""}</div>`;
};

/* Weekly Schedule tab: default truck per driver (saves immediately) */
window.SHIFT_defaultTruckSelect=function(d){
  return `<label class="truck-pick">Default truck <select class="default-truck" data-driver-id="${d.id}" onchange="SHIFT_saveDefaultTruck(this)">${options(d.default_vehicle_id,"— none —")}</select><span class="truck-saved" id="truckSaved${d.id}"></span></label>`;
};
window.SHIFT_saveDefaultTruck=async function(sel){
  let id=Number(sel.dataset.driverId),val=sel.value?Number(sel.value):null,flag=$("truckSaved"+id);
  if(flag){flag.style.color="";flag.textContent="saving…"}
  let r=await db.from("drivers").update({default_vehicle_id:val}).eq("id",id);
  if(r.error){if(flag){flag.style.color="#ff8e8e";flag.textContent="failed"}return alert("Could not save default truck: "+r.error.message)}
  let d=drivers.find(x=>Number(x.id)===id);if(d)d.default_vehicle_id=val;
  if(flag)flag.textContent="✓ saved";
  try{render()}catch(_){}
};

/* Daily Overrides tab: per-date truck (stored on the driver_schedule row with the override) */
window.SHIFT_overrideTruckSelect=function(d,r){
  let def=vName(d.default_vehicle_id);
  return `<select class="schedule-vehicle" title="Truck for this date. Choosing a truck turns Override on for this driver/date.">${options(r?.vehicle_id??null,def?`Default (${def})`:"— none —")}</select>`;
};
document.addEventListener("change",e=>{
  if(!e.target.matches||!e.target.matches(".schedule-vehicle"))return;
  let row=e.target.closest(".schedule-row"),cb=row&&row.querySelector(".use-override");
  if(e.target.value&&cb&&!cb.checked)cb.checked=true;
});
window.SHIFT_overrideVehicleValue=function(el){let s=el.querySelector(".schedule-vehicle");if(!s)return undefined;return s.value?Number(s.value):null};

// first paint may have happened before this file loaded
fetchVehicles().then(()=>{try{render()}catch(_){}});
})();
