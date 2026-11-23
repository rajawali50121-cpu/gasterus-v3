const root=document.querySelector("#events");
const statusEl=document.querySelector("#feed-status");
const notice=document.querySelector("#notice");
const countEl=document.querySelector("#event-count");
const updatedEl=document.querySelector("#updated-at");
const refreshButton=document.querySelector("#refresh");

function setStatus(state,label){statusEl.dataset.state=state;statusEl.querySelector("span").textContent=label;}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
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
        const item=el("span","outcome");
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
async function load(){
  refreshButton.disabled=true;setStatus("loading","Memeriksa feed");
  try{
    const response=await fetch("/api/member/sportsbook/v2/events",{credentials:"same-origin",headers:{accept:"application/json"}});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload?.error?.message||payload?.message||"Feed belum tersedia.");
    const snapshot=payload.data||payload;
    const events=Array.isArray(snapshot.events)?snapshot.events:[];
    root.replaceChildren();
    if(events.length)events.forEach(event=>root.append(renderEvent(event)));
    else root.append(el("div","empty","Belum ada pertandingan dengan data odds pada siklus ini."));
    countEl.textContent=events.length.toLocaleString("id-ID");
    updatedEl.textContent=snapshot.fetchedAt?new Date(snapshot.fetchedAt).toLocaleString("id-ID"):"—";
    const complete=snapshot.complete===true;
    setStatus(complete?"ready":"error",complete?"Feed tersinkron":"Feed parsial");
    notice.textContent=complete
      ?"Data berasal dari Sportradar Odds Comparison Prematch v2. Polling katalog dijadwalkan setiap 150 menit."
      :"Feed belum lengkap. Data parsial hanya untuk tampilan; penerimaan taruhan uang nyata belum diaktifkan.";
  }catch(error){
    root.replaceChildren(el("div","empty",error.message));
    countEl.textContent="—";updatedEl.textContent="—";setStatus("error","Feed tidak tersedia");
    notice.textContent="Tidak ada data odds aktif. Sistem tidak menggunakan data contoh atau fallback.";
  }finally{refreshButton.disabled=false;}
}
refreshButton.addEventListener("click",load);
load();
