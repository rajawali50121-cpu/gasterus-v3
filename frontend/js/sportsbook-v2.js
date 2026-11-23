import api from "./api.js";

const root=document.querySelector("#events");
const statusEl=document.querySelector("#feed-status");
const notice=document.querySelector("#notice");
const countEl=document.querySelector("#event-count");
const updatedEl=document.querySelector("#updated-at");
const refreshButton=document.querySelector("#refresh");
const slipRoot=document.querySelector("#slip-items");
const stakeInput=document.querySelector("#stake");
const placeButton=document.querySelector("#place-bet");
const betMessage=document.querySelector("#bet-message");
const selections=new Map();
let acceptanceEnabled=false;

function setStatus(state,label){statusEl.dataset.state=state;statusEl.querySelector("span").textContent=label;}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function selectionId(x){return [x.eventId,x.marketId,x.bookId,x.outcomeId].join(":");}
function renderSlip(){
  slipRoot.replaceChildren();
  if(!selections.size)slipRoot.append(el("div","empty","Pilih odds dari pertandingan untuk mulai membuat tiket."));
  for(const item of selections.values()){
    const row=el("div","slip-row");
    row.append(el("span","",item.label),el("b","",item.expectedOdds.toFixed(2)));
    const remove=el("button","slip-remove","Hapus");
    remove.type="button";remove.addEventListener("click",()=>{selections.delete(selectionId(item));renderSlip();});
    row.append(remove);slipRoot.append(row);
  }
  const stake=Number(stakeInput.value);
  placeButton.disabled=!acceptanceEnabled||!selections.size||!Number.isSafeInteger(stake)||stake<=0;
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
        const item=el("button","outcome");
        item.type="button";
        item.append(document.createTextNode((outcome.name||outcome.type||outcome.id||"Pilihan")+" "));
        item.append(el("b","",Number(outcome.oddsDecimal).toFixed(2)));
        const pick={eventId:event.id,marketId:market.id,bookId:book.id,outcomeId:outcome.id,expectedOdds:Number(outcome.oddsDecimal),label:[names.join(" vs "),market.name||market.id,outcome.name||outcome.type||outcome.id].join(" · ")};
        const key=selectionId(pick);
        item.classList.toggle("selected",selections.has(key));
        item.disabled=!outcome.id||!Number.isFinite(pick.expectedOdds)||pick.expectedOdds<=1;
        item.addEventListener("click",()=>{
          if(selections.has(key))selections.delete(key);else selections.set(key,pick);
          renderSlip();item.classList.toggle("selected",selections.has(key));
        });
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
async function load(){
  refreshButton.disabled=true;setStatus("loading","Memeriksa feed");
  try{
    const response=await fetch("/api/member/sportsbook/v2/events",{credentials:"same-origin",headers:{accept:"application/json"}});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload?.error?.message||payload?.message||"Feed belum tersedia.");
    const snapshot=payload.data||payload;
    const events=Array.isArray(snapshot.events)?snapshot.events:[];
    acceptanceEnabled=snapshot.betAcceptanceEnabled===true;
    root.replaceChildren();
    if(events.length)events.forEach(event=>root.append(renderEvent(event)));
    else root.append(el("div","empty","Belum ada pertandingan dengan data odds pada siklus ini."));
    countEl.textContent=events.length.toLocaleString("id-ID");
    updatedEl.textContent=snapshot.fetchedAt?new Date(snapshot.fetchedAt).toLocaleString("id-ID"):"—";
    const complete=snapshot.complete===true;
    setStatus(complete?"ready":"error",complete?"Feed tersinkron":"Feed parsial");
    notice.textContent=acceptanceEnabled
      ?"Taruhan aktif. Setiap pilihan divalidasi ulang langsung ke Sportradar saat tiket dikirim."
      :"Mode persiapan: slip dapat disusun, tetapi penerimaan taruhan belum diaktifkan oleh konfigurasi server.";
  }catch(error){
    root.replaceChildren(el("div","empty",error.message));
    countEl.textContent="—";updatedEl.textContent="—";setStatus("error","Feed tidak tersedia");
    notice.textContent="Tidak ada data odds aktif. Sistem tidak menggunakan data contoh atau fallback.";
  }finally{refreshButton.disabled=false;renderSlip();}
}
placeButton.addEventListener("click",async()=>{
  const stake=Number(stakeInput.value);
  if(!acceptanceEnabled||!selections.size||!Number.isSafeInteger(stake)||stake<=0)return;
  placeButton.disabled=true;betMessage.textContent="Memvalidasi odds Sportradar dan memproses transaksi…";
  try{
    const result=await api.post("/member/sportsbook/v2/tickets",{
      idempotencyKey:crypto.randomUUID(),stake,
      legs:[...selections.values()].map(({eventId,marketId,bookId,outcomeId,expectedOdds})=>({eventId,marketId,bookId,outcomeId,expectedOdds}))
    });
    const ticket=result.data?.ticket||result.ticket;
    betMessage.textContent=ticket?("Tiket "+ticket.invoice+" berhasil diterima. Status: "+ticket.status+"."):"Taruhan berhasil diproses.";
    selections.clear();renderSlip();
  }catch(error){betMessage.textContent=error.message||"Taruhan gagal diproses. Periksa saldo dan odds.";}
  finally{renderSlip();}
});
stakeInput.addEventListener("input",renderSlip);
refreshButton.addEventListener("click",load);
renderSlip();
load();
