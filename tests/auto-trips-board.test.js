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
var db={rpc:async(n,a)=>{rpcCalls.push([n,a]);return {data:999,error:null}},from:()=>({select:()=>({eq:()=>({order:()=>({order:()=>({order:async()=>({data:[],error:null})})})})})})};`,ctx);
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
})();
