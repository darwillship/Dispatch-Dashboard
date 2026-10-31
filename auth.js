/* SHIFT Dispatch sign-in gate (v4.10.0, DRAFT — not deployed until the RLS step is approved).
   Load right after supabase-js on every dispatcher page (index, trucks, map, pre-trips).
   - One shared Supabase client per page (createClient is wrapped), so the page's own `db` sends the signed-in user's JWT.
   - No session -> full-screen sign-in (email + password, or "email me a sign-in link"). Accounts are never created here
     (signInWithOtp uses shouldCreateUser:false); a dispatcher account is made in Supabase Studio and listed in public.dispatch_staff.
   - Signed in but not in dispatch_staff -> "No dispatcher access" with Sign out.
   - Driver pages (driver.html) and the Driver Time Sheet app do NOT load this file. */
(function(){
  const URL0="https://hqhfstosclasgwgxubip.supabase.co";
  if(!window.supabase||!window.supabase.createClient){console.error("auth.js: supabase-js not loaded");return}
  const orig=window.supabase.createClient.bind(window.supabase);
  let shared=null;
  window.supabase.createClient=function(url,key,opts){
    if(String(url).replace(/\/$/,"")!==URL0)return orig(url,key,opts);
    if(!shared)shared=orig(url,key,Object.assign({},opts||{},{auth:Object.assign({persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},(opts&&opts.auth)||{})}));
    return shared;
  };
  const css=`#shiftAuth{position:fixed;inset:0;z-index:99999;background:#08111a;display:flex;align-items:center;justify-content:center;padding:16px;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8f0f7}
#shiftAuth form{width:100%;max-width:360px;background:#0f1a26;border:1px solid #24384c;border-radius:14px;padding:22px}
#shiftAuth h2{margin:0 0 4px;font-size:20px}#shiftAuth p{margin:0 0 14px;color:#8fa6ba;font-size:13px}
#shiftAuth label{display:block;font-weight:700;font-size:12.5px;margin:10px 0 4px}
#shiftAuth input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:10px 12px;border-radius:9px;border:1px solid #24384c;background:#08111a;color:#e8f0f7}
#shiftAuth button{width:100%;margin-top:14px;font:inherit;font-weight:800;padding:10px;border-radius:9px;border:1px solid #2f6db3;background:#1d4f86;color:#fff;cursor:pointer}
#shiftAuth button.link{background:transparent;border-color:#24384c;color:#cfe0ee;margin-top:8px}
#shiftAuth .msg{min-height:18px;margin-top:10px;font-size:12.5px;color:#f2c14e}
#shiftSignOut{position:fixed;right:10px;bottom:10px;z-index:9999;font:700 12px system-ui,sans-serif;color:#cfe0ee;background:#14263a;border:1px solid #24384c;border-radius:9px;padding:5px 10px;cursor:pointer;opacity:.85}`;
  function el(h){const d=document.createElement("div");d.innerHTML=h;return d.firstElementChild}
  function ready(f){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",f):f()}
  function showGate(mode,email){
    ready(()=>{
      if(!document.getElementById("shiftAuthCss")){const s=document.createElement("style");s.id="shiftAuthCss";s.textContent=css;document.head.appendChild(s)}
      document.getElementById("shiftAuth")?.remove();
      const g=el(mode==="denied"
        ?`<div id="shiftAuth"><form onsubmit="return false"><h2>SHIFT Dispatch</h2><p>Signed in as <b></b>, but this account has no dispatcher access. Ask the shipping manager to add it.</p><button type="button" id="saOut">Sign out</button></form></div>`
        :`<div id="shiftAuth"><form id="saForm" autocomplete="on"><h2>SHIFT Dispatch</h2><p>Sign in to see the dispatch board.</p>
          <label for="saEmail">Email</label><input id="saEmail" type="email" autocomplete="username" required>
          <label for="saPw">Password</label><input id="saPw" type="password" autocomplete="current-password">
          <button type="submit">Sign in</button><button type="button" class="link" id="saLink">Email me a sign-in link</button>
          <div class="msg" id="saMsg" role="status"></div></form></div>`);
      document.body.appendChild(g);document.documentElement.style.overflow="hidden";
      if(mode==="denied"){g.querySelector("b").textContent=email||"";g.querySelector("#saOut").onclick=signOut;return}
      const msg=t=>{g.querySelector("#saMsg").textContent=t};
      g.querySelector("#saForm").onsubmit=async e=>{e.preventDefault();const em=g.querySelector("#saEmail").value.trim(),pw=g.querySelector("#saPw").value;
        if(!pw){msg("Enter your password, or use “Email me a sign-in link”.");return}
        msg("Signing in…");const {error}=await client().auth.signInWithPassword({email:em,password:pw});
        if(error){msg(error.message||"Sign-in failed.");return} location.reload()};
      g.querySelector("#saLink").onclick=async()=>{const em=g.querySelector("#saEmail").value.trim();if(!em){msg("Enter your email first.");return}
        msg("Sending…");const {error}=await client().auth.signInWithOtp({email:em,options:{shouldCreateUser:false,emailRedirectTo:location.href.split("#")[0]}});
        msg(error?(error.message||"Could not send the link."):"Check your email for the sign-in link.")};
      setTimeout(()=>g.querySelector("#saEmail")?.focus(),50);
    });
  }
  function client(){return shared}
  async function signOut(){try{await client().auth.signOut()}catch(_){}location.reload()}
  window.SHIFT_signOut=signOut;
  async function check(){
    const c=client();const {data:{session}}=await c.auth.getSession();
    if(!session){showGate("signin");return}
    const r=await c.rpc("is_dispatcher");
    if(r.error||r.data!==true){showGate("denied",session.user?.email);return}
    window.SHIFT_user=session.user;
    ready(()=>{if(!document.getElementById("shiftSignOut")){const s=document.createElement("style");s.id="shiftAuthCss";s.textContent=css;document.head.appendChild(s);
      const b=el(`<button id="shiftSignOut" title="Signed in as ${String(session.user.email||"").replace(/[<>&"]/g,"")}">Sign out</button>`);b.onclick=signOut;document.body.appendChild(b)}});
    c.auth.onAuthStateChange(ev=>{if(ev==="SIGNED_OUT")showGate("signin")});
  }
  window.SHIFT_authReady=new Promise(res=>{const go=()=>{if(shared){check().finally(res)}else setTimeout(go,30)};go()});
})();
