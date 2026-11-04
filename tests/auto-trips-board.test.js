// Board smoke test for auto-trips.js (node tests/auto-trips-board.test.js). Stubs the DOM and Supabase; no network.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');process.chdir(path.join(__dirname,'..'));
const el=()=>new Proxy(function(){},{get:(t,k)=>k==='classList'?{add(){},remove(){},toggle(){},contains:()=>false}:k==='style'?{}:k==='value'?'':k==='checked'?true:el(),apply:()=>el(),set:()=>true});
const rpcCalls=[];
const ctx={console,Intl,Date,JSON,Math,Set,Map,Object,Array,Number,String,Promise,setTimeout:()=>0,
  localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>null,setItem(){}},location:{hash:"",pathname:"",search:""},history:{replaceState(){}},
  document:{readyState:"complete",getElementById:id=>id==="autoTripsBtn"||id==="combineModal"?null:{onsubmit:null,value:"",checked:true,style:{},classList:{add(){},remove(){},toggle(){},contains:()=>false},insertAdjacentHTML(){},addEventListener(){},closest:()=>({insertAdjacentElement(){},parentNode:{insertBefore(){}}}),querySelector:()=>null,querySelectorAll:()=>[],appendChild(){},set innerHTML(v){},textContent:""},querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({classList:{add(){}},style:{},set innerHTML(v){this.h=v},querySelector:()=>({}),remove(){}}),body:{classList:{contains:()=>false,add(){},remove(){}},appendChild(){}},head:{appendChild(){}}},
  addEventListener(){},confirm:()=>true,alert:m=>console.log("ALERT",m)};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(`var $=id=>document.getElementById(id),esc=s=>String(s??"");var boardDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago"}).format(new Date());
var tasks=[],allTasks=[],drivers=[{id:7,name:"Mark"}];window.load=async function(){};window.render=function(){};window.updateMetrics=function(){};window.taskCard=function(){return ""};
var EVENTS=[];var db={rpc:async(n,a)=>{rpcCalls.push([n,a]);return {data:999,error:null}},from:t=>t==="vehicle_stop_events"
  ?({select:()=>({eq:()=>({eq:()=>({is:()=>({order:async()=>({data:EVENTS,error:null})})})})})})
  :({select:()=>({eq:()=>({order:()=>({order:()=>({order:async()=>({data:[],error:null})})})})})})};`,ctx);
ctx.rpcCalls=rpcCalls;
vm.runInContext(fs.readFileSync('routes-features.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('auto-trips.js','utf8'),ctx);
const today=vm.runInContext('boardDate',ctx);
const base={status:"assigned",assigned_driver_id:7,vehicle_id:4,work_date:today,delivery_name:"Darwill McCook",delivery_address:"8701 47th St Ste C, McCook, IL 60525",task_type:"pickup"};
vm.runInContext(`allTasks=${JSON.stringify([
 {...base,id:305,pickup_name:"Canon USA",pickup_address:"10350 Beaudin Blvd Suite 400, Woodridge, IL. 60517",pallet_qty:8,assigned_at:"2026-11-04T14:56:00Z",gps_origin_arrived_at:"2026-11-04T15:23:04Z",status:"in_progress"},
 {...base,id:306,pickup_name:"Universal Laminating",pickup_address:"910 Carlow Dr Ste A, Bolingbrook, IL 60490",assigned_at:"2026-11-04T14:56:03Z",gps_origin_arrived_at:"2026-11-04T14:58:50Z",gps_departed_at:"2026-11-04T15:08:04Z",status:"in_progress"},
 {...base,id:400,assigned_driver_id:9,pickup_name:"X",pickup_address:"1 X St"},
 {...base,id:401,pickup_name:"Y",pickup_address:"1 Y St",vehicle_id:5}])}`,ctx);
// Big Blue 11/04/2026 stop events (vehicle_stop_events, UTC)
const EV=[["10:51:52","14:30:22","McCook base","8701 47th St, McCook, IL 60525"],["14:58:50","15:08:04","Task stop","910 Carlow Dr, Bolingbrook, IL 60490"],
 ["15:23:04","15:48:02","Task stop","10350 Beaudin Blvd, Woodridge, IL 60517"],["16:10:53","16:37:53","McCook base","8701 47th St, McCook, IL 60525"],
 ["16:54:23","17:18:11","Overnight spot","11900 Roosevelt Rd, Hillside, IL 60162"],["17:35:55","17:57:38","Task stop","608 Country Club Dr, Bensenville, IL 60106"],
 ["18:00:38","18:10:51","Task stop","737 N Central Ave, Wood Dale, IL 60191"],["18:21:21","18:23:43","Stop","598 St Charles Rd, Elmhurst, IL 60126"],
 ["18:44:43","20:22:08","McCook base","8701 47th St, McCook, IL 60525"],["20:47:38","21:43:17","Task stop","1053 N Schmidt Rd, Romeoville, IL 60446"]]
 .map(([a,d,c,addr])=>({started_at:"2026-11-04T"+a+"Z",ended_at:"2026-11-04T"+d+"Z",category:c,address:addr}));
const upTo=t=>EV.filter(e=>e.started_at<t).map(e=>e.ended_at>t?{...e,ended_at:null}:e);
vm.runInContext(`EVENTS=${JSON.stringify(upTo("2026-11-04T15:50:00Z"))}`,ctx);
(async()=>{
  await ctx.load();
  console.log("rpc calls:",rpcCalls.length);
  const [n,a]=rpcCalls[0];
  console.log(n,a.p_source,"tasks",a.p_task_ids,"origin",a.p_route.pickup_name,"origin_task",a.p_route.origin_task_id,"veh",a.p_route.vehicle_id);
  a.p_stops.forEach(s=>console.log(" stop",s.seq,s.location_name,s.stop_type,"final",s.final_return,JSON.stringify(s.source_parts.map(p=>p.task_id+":"+p.type))));
  assert.equal(rpcCalls.length,1,"one auto route (Mark, truck 4); other driver / other truck left alone");
  assert.equal(n,"shift_combine_tasks");assert.equal(a.p_source,"auto");
  assert.deepEqual([...a.p_task_ids],[306,305],"GPS order: Universal seen 8:58 AM, Canon 9:23 AM");
  assert.equal(a.p_route.origin_task_id,306);assert.equal(a.p_route.vehicle_id,4);
  assert.deepEqual(a.p_stops.map(s=>s.location_name),["Canon USA","Darwill McCook"]);
  assert.equal(a.p_stops[1].final_return,true);
  await ctx.load(); console.log("rpc calls after second load (no repeat):",rpcCalls.length);assert.equal(rpcCalls.length,1);console.log("PASS auto-trips board smoke test");
  // ---- v4.10.1 replay: Big Blue afternoon ----
  const AT=vm.runInContext("SHIFT_autoTrips",ctx);
  const pm=[
   {...base,id:307,pickup_name:"Federal Envelope",pickup_address:"608 Country Club Dr, Bensenville, IL 60106",delivery_name:"Federal Envelope",delivery_address:"608 Country Club Dr, Bensenville, IL 60106",created_at:"2026-11-04T15:26:47Z",assigned_at:"2026-11-04T18:43:04Z"},
   {...base,id:309,pickup_name:"Add Value 2 Print LLC",pickup_address:"737 N Central Ave, Wood Dale, IL 60191",created_at:"2026-11-04T16:06:46Z",assigned_at:"2026-11-04T18:43:07Z"},
   {...base,id:311,task_type:"delivery",pickup_name:"Darwill McCook",pickup_address:"8701 47th St Ste C, McCook, IL 60525",delivery_name:"ALG",delivery_address:"1053 N Schmidt Rd, Romeoville, IL 60446",created_at:"2026-11-04T19:14:47Z",assigned_at:"2026-11-04T19:14:51Z"}];
  const ct=t=>new Date(t).toLocaleTimeString("en-US",{timeZone:"America/Chicago"});
  // late assignment: window = Big Blue's McCook departure 10:37:53 AM, not the 12:43 PM assignment
  assert.equal(ct(AT.gateOf(pm[0],upTo("2026-11-04T19:20:00Z").map(e=>({...e,a:Date.parse(e.started_at),d:e.ended_at?Date.parse(e.ended_at):null})))),"10:37:53 AM");
  assert(AT.sameAddr("910 Carlow Dr Ste A, Bolingbrook","902 Carlow Dr, Bolingbrook")&&!AT.sameAddr("910 Carlow Dr","1910 Carlow Dr"));
  // (1) at 1:15 PM: #307/#309 were finished by the 12:44 PM McCook return → earlier trip; #311 alone → nothing combined
  vm.runInContext(`EVENTS=${JSON.stringify(upTo("2026-11-04T19:15:00Z"))};allTasks=${JSON.stringify(pm)}`,ctx);
  rpcCalls.length=0;await ctx.load();
  assert.equal(rpcCalls.length,0,"no route mixing the finished trip (#307, #309) with #311");
  // (2) at 12:43 PM (truck still out, Add Value done 12:10 PM): #307 + #309 combine, stops in the order the truck went
  vm.runInContext(`EVENTS=${JSON.stringify(upTo("2026-11-04T18:43:30Z"))};allTasks=${JSON.stringify(pm.slice(0,2))}`,ctx);
  rpcCalls.length=0;await ctx.load();
  assert.equal(rpcCalls.length,1);
  const b=rpcCalls[0][1];
  console.log("12:43 PM route:",b.p_task_ids,b.p_route.pickup_name,"→",b.p_stops.map(s=>s.location_name).join(" → "));
  assert.deepEqual([...b.p_task_ids],[307,309],"Federal Envelope (11:35 AM) before Add Value (12:00 PM)");
  assert.equal(b.p_route.pickup_name,"Federal Envelope");
  assert.equal(b.p_stops[0].location_name,"Add Value 2 Print LLC");
  // (3) no stop events at all (VZC down): v4.10.0 behaviour — plan order, combine
  vm.runInContext(`EVENTS=[];allTasks=${JSON.stringify(pm)}`,ctx);
  rpcCalls.length=0;await ctx.load();
  assert.equal(rpcCalls.length,1);
  console.log("PASS v4.10.1 late-assignment / McCook-split replay");
})().catch(e=>{console.error(e);process.exit(1)});
