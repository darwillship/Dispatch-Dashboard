/* v4.7.1 pre-trip exceptions (read-only). One rule for pretrips.html, the Time Sheets panel and the driver-card badge.
 * Issues = failed / needs-attention checklist items, defects the driver listed, "defects" condition, and driver remarks.
 * Remarks that sound like a problem while no defect is marked -> amber "Check remarks". */
(function(){
  const OKR=new Set(["ok","pass","passed","good","yes","na","n/a","not applicable"]);
  const CLEAN=/^\s*(none|n\/?a|na|ok|okay|all ok|all good|good|fine|no issues?|no problems?|nothing|-+|\.+)\s*[.!]*\s*$/i;
  const PROBLEM=/\b(not\s+work\w*|n[o']t\s+work\w*|broken|broke|cracked?|crack|leak\w*|low|flat|damage\w*|dent\w*|missing|loose|needs?|replace\w*|burn(ed|t)?\s*out|out|won'?t|doesn'?t|does\s+not|isn'?t|not|fail\w*|bad|worn|noise|noisy|squeak\w*|grind\w*|warning|check\s+engine|issue\w*|problem\w*|light\s+on|stuck|torn|chipped|dead|weak|smoke|overheat\w*)\b/i;
  const norm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ");
  const stem=w=>w.replace(/(ing|es|s)$/,"");
  function relatedItem(p,remark){ // checklist item the remark talks about (e.g. "headlight" -> Headlights)
    const r=norm(remark).split(/\s+/).filter(w=>w.length>3).map(stem);
    return (p.checklist||[]).find(i=>norm(i.item).split(/\s+/).filter(w=>w.length>3).map(stem).some(w=>r.includes(w)))||null;
  }
  window.SHIFT_ptIssues=function(p){
    const items=[],cl=Array.isArray(p.checklist)?p.checklist:[];
    const failed=cl.filter(i=>i&&i.result!=null&&String(i.result).trim()!==""&&!OKR.has(String(i.result).trim().toLowerCase()));
    failed.forEach(i=>items.push({level:"red",kind:"item",text:`${i.group?i.group+": ":""}${i.item} — ${String(i.result).toLowerCase()==="attention"?"needs attention":i.result}`}));
    const named=new Set(failed.map(i=>norm(i.item)));
    (p.defects||[]).filter(Boolean).forEach(d=>{if(!named.has(norm(String(d).split(":").pop())))items.push({level:"red",kind:"defect",text:"Defect: "+d})});
    if(String(p.condition||"").toLowerCase()==="defects"&&!items.length)items.push({level:"red",kind:"condition",text:"Vehicle condition: defects noted (no item marked)"});
    const rm=String(p.comments||"").trim(),hasDef=items.some(x=>x.level==="red");
    let note=null;
    if(rm&&!CLEAN.test(rm)){
      if(hasDef)items.push({level:"note",kind:"remark",text:"Driver remarks: "+rm});
      else if(PROBLEM.test(rm)){const ri=relatedItem(p,rm);items.push({level:"amber",kind:"check",text:`Remarks: “${rm}” — no defect marked${ri&&OKR.has(String(ri.result||"").toLowerCase())?` (${ri.item} marked OK)`:""}`})}
      else note="Driver remarks: "+rm;
    }
    const sev=items.some(x=>x.level==="red")?"red":items.some(x=>x.level==="amber")?"amber":"ok";
    return {ok:sev==="ok",sev,items,note};
  };
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  /* compact cell: ✅ All OK  |  Issues list (only failed items + remarks) */
  window.SHIFT_ptIssuesHtml=function(p){
    const r=SHIFT_ptIssues(p);
    if(r.ok)return `<span class="pt-ok">✅ All OK</span>${r.note?`<div class="pt-note">${esc(r.note)}</div>`:""}`;
    return `<div class="pt-iss ${r.sev}"><b>${r.sev==="red"?"⚠ Issues":"⚠ Check remarks"}</b><ul>${r.items.map(i=>`<li class="${i.level}">${esc(i.text)}</li>`).join("")}</ul></div>`;
  };
  const css=`.pt-ok{color:#22a35a;font-weight:900;white-space:nowrap}.pt-note{font-size:11.5px;opacity:.75;margin-top:2px}
  .pt-iss b{font-weight:900}.pt-iss.red b{color:#e5484d}.pt-iss.amber b{color:#d99a1e}.pt-iss ul{margin:3px 0 0;padding-left:16px}.pt-iss li{margin:1px 0;font-size:12.5px}
  .pt-iss li.red{color:#e5484d;font-weight:800}.pt-iss li.amber{color:#d99a1e;font-weight:800}.pt-iss li.note{opacity:.85}
  .pt-badge{display:inline-block;margin:3px 0 0 4px;font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;text-decoration:none;border:1px solid transparent}
  .pt-badge.ok{background:rgba(34,160,90,.16);color:#1f8a4c}.pt-badge.red{background:rgba(229,72,77,.16);color:#e5484d}.pt-badge.amber{background:rgba(217,154,30,.18);color:#c98a10}`;
  const st=document.createElement("style");st.textContent=css;(document.head||document.documentElement).appendChild(st);
})();
