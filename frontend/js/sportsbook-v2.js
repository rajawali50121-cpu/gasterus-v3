import { api } from "./api.js";

const root=document.querySelector("#events");
const statusEl=document.querySelector("#feed-status");
const notice=document.querySelector("#notice");
const countEl=document.querySelector("#event-count");
const updatedEl=document.querySelector("#updated-at");
const refreshButton=document.querySelector("#refresh");
const betslip=document.querySelector("#betslip");
const stakeInput=document.querySelector("#bet-stake");
const submitBet=document.querySelector("#submit-bet");
const betslipStatus=document.querySelector("#betslip-status");
const ticketHistory=document.querySelector("#ticket-history");
const refreshTickets=document.querySelector("#refresh-tickets");
const selectedLegs=new Map();
const pendingTicketKeys=new Map();
const PENDING_TICKET_KEYS_STORAGE="gasterus_sportsbook_pending_ticket_keys_v1";
let betAcceptanceEnabled=false;

function getPendingTicketKey(fingerprint){
  if(pendingTicketKeys.has(fingerprint))return pendingTicketKeys.get(fingerprint);
  try{
    const stored=JSON.parse(sessionStorage.getItem(PENDING_TICKET_KEYS_STORAGE)||"{}");
    if(stored&&typeof stored==="object"&&typeof stored[fingerprint]==="string"){
      pendingTicketKeys.set(fingerprint,stored[fingerprint]);
      return stored[fingerprint];
    }
  }catch{}
  const key=crypto.randomUUID();
  pendingTicketKeys.set(fingerprint,key);
  try{
    const stored=JSON.parse(sessionStorage.getItem(PENDING_TICKET_KEYS_STORAGE)||"{}");
    const entries=stored&&typeof stored==="object"?stored:{};
    entries[fingerprint]=key;
    const keys=Object.keys(entries);
    for(const oldKey of keys.slice(0,Math.max(0,keys.length-10)))delete entries[oldKey];
    sessionStorage.setItem(PENDING_TICKET_KEYS_STORAGE,JSON.stringify(entries));
  }catch{}
  return key;
}

function clearPendingTicketKey(fingerprint){
  pendingTicketKeys.delete(fingerprint);
  try{
    const stored=JSON.parse(sessionStorage.getItem(PENDING_TICKET_KEYS_STORAGE)||"{}");
    if(stored&&typeof stored==="object"){
      delete stored[fingerprint];
      sessionStorage.setItem(PENDING_TICKET_KEYS_STORAGE,JSON.stringify(stored));
    }
  }catch{}
}

function setStatus(state,label){statusEl.dataset.state=state;statusEl.querySelector("span").textContent=label;}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function money(value){return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(value);}
function preview(){
  const stake=Number(stakeInput.value);
  const odds=[...selectedLegs.values()].map(leg=>Number(leg.expectedOdds));
  if(!Number.isSafeInteger(stake)||stake<=0||!odds.length)return null;
  const totalOdds=odds.reduce((total,value)=>total*value,1);
  const payout=Math.floor(stake*totalOdds);
  return {stake,totalOdds,payout};
}
function renderBetslip(){
  betslip.replaceChildren();
  const heading=el("h2","","Slip Taruhan");
  betslip.append(heading);
  const legs=[...selectedLegs.values()];
  if(!legs.length)betslip.append(el("p","betslip-empty","Pilih outcome yang memiliki tanda dapat dipasang untuk mulai."));
  for(const [index,leg] of legs.entries()){
    const row=el("div","slip-leg");
    const info=el("div","slip-leg-info");
    info.append(el("strong","",leg.eventLabel));
    info.append(el("span","",`${leg.selectionLabel} · ${leg.marketLabel} · ${leg.bookLabel}`));
    row.append(info);
    const price=el("b","",Number(leg.expectedOdds).toFixed(2));
    const remove=el("button","slip-remove","×");
    remove.type="button";remove.setAttribute("aria-label","Hapus pilihan");
    remove.addEventListener("click",()=>{selectedLegs.delete(leg.providerEventId);renderBetslip();});
    row.append(price,remove);betslip.append(row);
  }
  const summary=preview();
  const summaryEl=el("div","slip-summary");
  summaryEl.append(el("label","","Nominal taruhan (IDR)"));
  summaryEl.append(stakeInput);
  summaryEl.append(el("div","slip-total",`Total odds: ${summary?summary.totalOdds.toFixed(4):"—"}`));
  summaryEl.append(el("div","slip-total",`Potensi payout: ${summary?money(summary.payout):"—"}`));
  betslip.append(summaryEl);
  const loggedIn=Boolean(localStorage.getItem("gasterus_token"));
  submitBet.disabled=!betAcceptanceEnabled||!loggedIn||!legs.length||!summary;
  submitBet.textContent=loggedIn?"Pasang taruhan":"Login untuk bertaruh";
  if(!loggedIn)submitBet.onclick=()=>{window.location.href="/index.html";};
}
function toggleSelection(event,market,book,outcome){
  if(!betAcceptanceEnabled||outcome.bettable!==true)return;
  if(selectedLegs.has(event.id)){
    const old=selectedLegs.get(event.id);
    if(old.providerSelectionKey===outcome.selectionKey&&old.providerMarketKey===market.key&&old.providerBookId===book.id){
      selectedLegs.delete(event.id);
    }else{
      selectedLegs.set(event.id,makeLeg(event,market,book,outcome));
    }
  }else{
    if(selectedLegs.size>=10){betslipStatus.textContent="Maksimal 10 pertandingan dalam satu tiket.";return;}
    selectedLegs.set(event.id,makeLeg(event,market,book,outcome));
  }
  renderBetslip();
  syncSelectionButtons();
}
function syncSelectionButtons(){
  document.querySelectorAll(".outcome-select").forEach(button=>{
    const selected=selectedLegs.get(button.dataset.eventId);
    const active=Boolean(selected&&selected.providerMarketKey===button.dataset.marketKey&&
      selected.providerBookId===button.dataset.bookId&&selected.providerSelectionKey===button.dataset.selectionKey);
    button.classList.toggle("selected",active);
    button.dataset.selected=String(active);
  });
}
function makeLeg(event,market,book,outcome){
  return {
    providerEventId:event.id,
    providerMarketKey:market.key,
    providerBookId:book.id,
    providerSelectionKey:outcome.selectionKey,
    expectedOdds:String(outcome.oddsDecimal),
    eventLabel:[event.home,event.away].filter(Boolean).join(" vs ")||event.id,
    marketLabel:market.name||market.id,
    bookLabel:book.name||book.id,
    selectionLabel:outcome.name||outcome.type||outcome.id
  };
}
function renderEvent(event){
  const card=el("article","event");
  const top=el("div","event-top");
  const left=el("div");
  const names=[event.home,event.away].filter(Boolean);
  left.append(el("div","teams",names.length===2?names.join(" vs "):event.id));
  left.append(el("div","meta",event.competition||event.status||"Pertandingan"));
  top.append(left,el("div","kickoff",event.scheduled?new Date(event.scheduled).toLocaleString("id-ID",{dateStyle:"medium",timeStyle:"short"}):"Jadwal belum tersedia"));
  card.append(top);
  const markets=el("div","markets");
  for(const market of (event.markets||[]).slice(0,8)){
    const panel=el("div","market");
    panel.append(el("div","market-name",market.name||market.id));
    for(const book of (market.books||[]).slice(0,2)){
      panel.append(el("div","book",book.name||book.id));
      const outcomes=el("div","outcomes");
      for(const outcome of (book.outcomes||[])){
        const selectable=betAcceptanceEnabled&&outcome.bettable===true;
        const item=selectable?el("button","outcome outcome-select"):el("span","outcome");
        if(selectable){
          item.type="button";
          item.dataset.eventId=event.id;
          item.dataset.marketKey=market.key;
          item.dataset.bookId=book.id;
          item.dataset.selectionKey=outcome.selectionKey;
          const selected=selectedLegs.get(event.id);
          item.dataset.selected=String(Boolean(selected&&selected.providerSelectionKey===outcome.selectionKey&&selected.providerMarketKey===market.key&&selected.providerBookId===book.id));
          if(item.dataset.selected==="true")item.classList.add("selected");
          item.addEventListener("click",()=>toggleSelection(event,market,book,outcome));
        }
        item.append(document.createTextNode(outcome.name||outcome.type||outcome.id||"Pilihan"));
        item.append(el("b","",Number(outcome.oddsDecimal).toFixed(2)));
        outcomes.append(item);
      }
      panel.append(outcomes);
    }
    markets.append(panel);
  }
  if(!markets.childElementCount)markets.append(el("div","empty","Harga pasar belum tersedia."));
  card.append(markets);
  return card;
}
function renderTicket(ticket){
  const card=el("article","ticket-card");
  const header=el("div","ticket-head");
  header.append(el("strong","",ticket.invoice));
  const status=el("span",`ticket-status status-${String(ticket.status||"").toLowerCase()}`,ticket.status);
  header.append(status);
  if(ticket.review_required===true)header.append(el("span","ticket-status status-review","REVIEW"));
  card.append(header);
  if(ticket.review_required===true)card.append(el("div","ticket-review-note","Hasil pertandingan mengalami pembaruan dari provider dan sedang diperiksa operator. Tidak ada perubahan saldo otomatis selama pemeriksaan."));
  card.append(el("div","ticket-meta",`Dipasang ${new Date(ticket.accepted_at).toLocaleString("id-ID")} · Taruhan ${money(Number(ticket.stake))}`));
  card.append(el("div","ticket-meta",`Total odds ${Number(ticket.total_odds).toFixed(4)} · Potensi payout ${money(Number(ticket.potential_payout))}`));
  for(const leg of (ticket.legs||[])){
    const row=el("div","ticket-leg");
    const teams=[leg.home,leg.away].filter(Boolean).join(" vs ")||leg.eventId;
    row.append(el("strong","",teams));
    row.append(el("span","",`${leg.selection||leg.outcomeType||"Pilihan"} · ${leg.market||"Market"} · ${Number(leg.acceptedOdds).toFixed(2)} · ${leg.resultStatus}`));
    card.append(row);
  }
  return card;
}
async function loadTicketHistory(){
  if(!localStorage.getItem("gasterus_token")){
    ticketHistory.replaceChildren(el("p","betslip-empty","Login untuk melihat riwayat tiket sportsbook."));
    return;
  }
  refreshTickets.disabled=true;
  try{
    const response=await api.get("/member/sportsbook/v2/tickets?limit=10");
    const tickets=response.data?.tickets||[];
    ticketHistory.replaceChildren();
    if(!tickets.length)ticketHistory.append(el("p","betslip-empty","Belum ada tiket sportsbook."));
    else tickets.forEach(ticket=>ticketHistory.append(renderTicket(ticket)));
  }catch(error){
    ticketHistory.replaceChildren(el("p","betslip-empty",error.message||"Riwayat tiket belum dapat dimuat."));
  }finally{refreshTickets.disabled=false;}
}
async function submitTicket(){
  const summary=preview();
  if(!summary||!selectedLegs.size)return;
  if(!localStorage.getItem("gasterus_token")){window.location.href="/index.html";return;}
  submitBet.disabled=true;submitBet.textContent="Memverifikasi odds…";
  betslipStatus.textContent="Memeriksa harga pada snapshot tersimpan, status event/market, batas risiko dan saldo.";
  const requestPayload={
    stake:summary.stake,
    legs:[...selectedLegs.values()].map(({providerEventId,providerMarketKey,providerBookId,providerSelectionKey,expectedOdds})=>({
      providerEventId,providerMarketKey,providerBookId,providerSelectionKey,expectedOdds
    }))
  };
  const fingerprint=JSON.stringify(requestPayload);
  const idempotencyKey=getPendingTicketKey(fingerprint);
  try{
    const response=await api.post("/member/sportsbook/v2/tickets",{...requestPayload,idempotencyKey});
    const ticket=response.data||response;
    clearPendingTicketKey(fingerprint);
    betslipStatus.textContent=`Tiket ${ticket.invoice} diterima. Status: ${ticket.status}. Saldo setelah transaksi: ${money(ticket.balanceAfter)}.`;
    selectedLegs.clear();renderBetslip();await loadTicketHistory();
  }catch(error){
    betslipStatus.textContent=error.message||"Taruhan ditolak. Muat ulang odds dan coba lagi.";
  }finally{
    submitBet.disabled=false;
    renderBetslip();
  }
}
async function load(){
  refreshButton.disabled=true;setStatus("loading","Memeriksa feed");
  try{
    const response=await fetch("/api/public/sportsbook/v2/events",{credentials:"same-origin",headers:{accept:"application/json"}});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload?.error?.message||payload?.message||"Feed belum tersedia.");
    const snapshot=payload.data||payload;
    betAcceptanceEnabled=snapshot.betAcceptanceEnabled===true;
    const events=Array.isArray(snapshot.events)?snapshot.events:[];
    root.replaceChildren();
    if(events.length)events.forEach(event=>root.append(renderEvent(event)));
    else root.append(el("div","empty","Belum ada pertandingan dengan data odds pada siklus ini."));
    countEl.textContent=events.length.toLocaleString("id-ID");
    updatedEl.textContent=snapshot.fetchedAt?new Date(snapshot.fetchedAt).toLocaleString("id-ID"):"—";
    const complete=snapshot.complete===true
      && snapshot.quotaLimited!==true
      && snapshot.budgetLimited!==true
      && (!Array.isArray(snapshot.errors)||snapshot.errors.length===0);
    setStatus(complete?"ready":"error",complete?"Feed tersinkron":"Feed belum lengkap");
    notice.textContent=complete
      ?(betAcceptanceEnabled
        ?"Feed Sportradar tersinkron. Server mencocokkan harga dengan snapshot tersimpan dan memeriksa status event/market; ini bukan verifikasi real-time langsung ke provider."
        :"Odds tersedia untuk dilihat. Penerimaan taruhan masih terkunci sampai entitlement, kuota, settlement worker, mapping dan risk reserve siap.")
      :snapshot.quotaLimited
        ?"Feed belum lengkap karena batas kuota Sportradar. Snapshot parsial tidak dipublikasikan."
        :snapshot.budgetLimited
          ?"Feed belum lengkap karena anggaran request siklus tercapai. Snapshot parsial tidak dipublikasikan."
          :"Feed belum lengkap. Snapshot parsial tidak dianggap tersinkron dan taruhan tetap dinonaktifkan.";
    if(!betAcceptanceEnabled&&Array.isArray(snapshot.betAcceptanceReasons)&&snapshot.betAcceptanceReasons.length){
      notice.textContent+=` Alasan: ${snapshot.betAcceptanceReasons.join(", ")}.`;
    }
    renderBetslip();
    betslipStatus.textContent=betAcceptanceEnabled
      ?"Server memeriksa odds pada snapshot tersimpan sebelum transaksi; status provider real-time tidak dijamin oleh polling."
      :"Penerimaan taruhan belum memenuhi seluruh pemeriksaan keamanan.";
  }catch(error){
    root.replaceChildren(el("div","empty",error.message));
    countEl.textContent="—";updatedEl.textContent="—";setStatus("error","Feed tidak tersedia");
    notice.textContent="Tidak ada data odds aktif. Sistem tidak menggunakan data contoh atau fallback.";
    betAcceptanceEnabled=false;renderBetslip();
    betslipStatus.textContent="Feed tidak tersedia. Penerimaan taruhan tetap dinonaktifkan.";
  }finally{refreshButton.disabled=false;}
}
stakeInput.addEventListener("input",renderBetslip);
submitBet.addEventListener("click",submitTicket);
refreshButton.addEventListener("click",load);
refreshTickets.addEventListener("click",loadTicketHistory);
renderBetslip();
load();
loadTicketHistory();
