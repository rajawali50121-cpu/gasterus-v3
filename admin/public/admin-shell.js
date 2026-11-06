window.AdminShell=(()=>{
  const groups=[
    ['OPERASI',[['dashboard.html','dashboard','Overview'],['members.html','users','Members'],['compliance.html','shield','Compliance'],['support.html','support','Support Cases']]],
    ['KEUANGAN',[['payments.html','card','Payments'],['money-integrity.html','ledger','Money Integrity'],['reconciliation.html','reconcile','Reconciliation'],['reports.html','report','Reports']]],
    ['TRADING & RISK',[['sportsbook-control.html','football','Sportsbook Desk'],['bets.html','ticket','Betting'],['lottery-control.html','number','Lottery Risk'],['risk.html','risk','Risk & Fraud']]],
    ['KONTEN & SISTEM',[['content.html','content','CMS & Promo'],['approvals.html','approval','Approvals'],['security.html','lock','Security'],['settings.html','settings','Settings']]]
  ];
  const flat=groups.flatMap(([,items])=>items);
  const ICON_FALLBACK='<span class="nav-dot"></span>';
  function navHtml(active){
    return groups.map(([title,items])=>`<div class="nav-title">${title}</div>${items.map(([href,ico,label])=>{
      const known=flat.some(([h,i])=>h===href&&i===ico);
      return `<a class="nav-link ${active===href?'active':''}" href="${href}"><span class="nav-icon ui-icon-host" data-ui-icon="${ico}" aria-hidden="true">${known?'':ICON_FALLBACK}</span><span class="nav-label">${label}</span></a>`;
    }).join('')}`).join('');
  }
  function mount(active,title,subtitle='Enterprise Back Office'){
    const body=document.body;const existing=[...body.children];const app=document.createElement('div');app.className='app';
    const side=document.createElement('aside');side.className='sidebar';side.innerHTML=`<div class="brand">SBOTOTO<small>ENTERPRISE CONTROL</small></div>${navHtml(active)}<div class="sidebar-footer">Admin Portal • MFA protected<br>RBAC • Audit trail • Four-eyes approval</div>`;
    const main=document.createElement('main');main.className='main';const top=document.createElement('header');top.className='topbar';top.innerHTML=`<div><h1>${title}</h1><small>${subtitle}</small></div><div class="top-actions"><span id="shellClock" title="Waktu server (lokal browser)">--:--:--</span><span class="badge" id="adminRole">SECURE</span><button class="btn" id="globalLogout">KELUAR</button></div>`;const content=document.createElement('section');content.className='content';existing.forEach(n=>content.appendChild(n));main.append(top,content);app.append(side,main);body.appendChild(app);
    const clock=document.getElementById('shellClock');
    if(clock){const tick=()=>{clock.textContent=new Date().toLocaleString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit',day:'2-digit',month:'short'})};tick();setInterval(tick,1000);}
    return{content};
  }
  async function auth(){const me=await ASEAN_API.request('/admin-api/owner/me');ASEAN_API.csrf=me.csrfToken;const badge=document.getElementById('adminRole');if(badge)badge.textContent=(me.roles||[]).join(' • ')||'ADMIN';const logout=document.getElementById('globalLogout');if(logout)logout.onclick=async()=>{await ASEAN_API.request('/admin-api/owner/logout',{method:'POST',body:'{}'}).catch(()=>{});location.href='index.html'};return me;}
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date=v=>v?new Date(v).toLocaleString('id-ID'):'-';
  return{mount,auth,esc,date};
})();
/* R6.94 premium design layer — injected once for every shell page. */
(()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='enterprise-ui-r6940.css?v=r6940-enterprise-control';document.head.appendChild(link);const activate=()=>document.body?.classList.add('enterprise-r6940');if(document.body)activate();else document.addEventListener('DOMContentLoaded',activate,{once:true});})();
