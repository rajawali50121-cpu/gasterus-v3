'use strict';
const root=document.getElementById('events');
const statusEl=document.getElementById('feed-status');
const eventCount=document.getElementById('event-count');
const marketCount=document.getElementById('market-count');
const oddsCount=document.getElementById('odds-count');
const updatedAt=document.getElementById('updated-at');
const ageEl=document.getElementById('snapshot-age');
const notice=document.getElementById('notice');
const refresh=document.getElementById('refresh');
const number=n=>Number(n||0).toLocaleString('id-ID');
function node(tag,cls,value){const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=String(value);return n;}
function renderEvent(event){
 const card=node('article','event'),top=node('div','event-top'),left=node('div');
 const detail=event.event||event;const names=[detail.home,detail.away].filter(Boolean);
 left.append(node('div','teams',names.length===2?names.join(' vs '):detail.id||'Pertandingan'));
 left.append(node('div','meta',event.competition||detail.status||'Prematch'));
 top.append(left,node('div','kickoff',detail.scheduled?new Date(detail.scheduled).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'}):'Jadwal belum tersedia'));
 card.append(top);
 const markets=node('div','markets');
 for(const market of Array.isArray(event.markets)?event.markets:[]){
  const panel=node('div','market');panel.append(node('div','market-name',market.name||market.id||'Market'));
  for(const book of Array.isArray(market.books)?market.books:[]){
   panel.append(node('div','book',book.name||book.id||'Bookmaker'));
   const outcomes=node('div','outcomes');
   for(const outcome of Array.isArray(book.outcomes)?book.outcomes:[]){
    const item=node('span','outcome');item.append(document.createTextNode(outcome.name||outcome.type||outcome.id||'Pilihan'));
    const price=Number(outcome.oddsDecimal);item.append(node('b','',Number.isFinite(price)?price.toFixed(2):'—'));outcomes.append(item);
   }
   panel.append(outcomes);
  }
  markets.append(panel);
 }
 if(!markets.childElementCount)markets.append(node('div','empty','Harga pasar belum tersedia.'));
 card.append(markets);return card;
}
async function load(){
 refresh.disabled=true;statusEl.textContent='MEMERIKSA';
 try{
  const auth=await fetch('/api/owner/me',{credentials:'same-origin',headers:{accept:'application/json'}});
  if(!auth.ok){location.replace('index.html');return;}
  const response=await fetch('/api/owner/sportsbook/v2/events',{credentials:'same-origin',headers:{accept:'application/json','cache-control':'no-cache'}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload?.error?.message||payload?.message||'Snapshot worker belum tersedia.');
  const snapshot=payload.data||payload,events=Array.isArray(snapshot.events)?snapshot.events:[];
  root.replaceChildren(...(events.length?events.map(renderEvent):[node('div','empty','Snapshot tersedia tetapi belum berisi pertandingan.')]));
  let markets=0,odds=0;for(const event of events)for(const market of event.markets||[]){markets++;for(const book of market.books||[])odds+=(book.outcomes||[]).length;}
  eventCount.textContent=number(events.length);marketCount.textContent=number(markets);oddsCount.textContent=number(odds);
  updatedAt.textContent='Diperbarui: '+(snapshot.fetchedAt?new Date(snapshot.fetchedAt).toLocaleString('id-ID'):'—');
  ageEl.textContent='Umur snapshot: '+number(Math.floor((snapshot.ageMs||0)/60000))+' menit';
  const healthy=snapshot.complete===true&&snapshot.quotaLimited!==true&&snapshot.budgetLimited!==true&&(!Array.isArray(snapshot.errors)||snapshot.errors.length===0);
  statusEl.textContent=healthy?'SNAPSHOT LENGKAP':'SNAPSHOT TIDAK LENGKAP';statusEl.className=healthy?'status':'status error';
  notice.textContent='Worker snapshot · '+(snapshot.provider||'Sportradar Odds Comparison Prematch v2')+' · Read-only · Penerimaan taruhan: NONAKTIF'+(snapshot.feedWarning?' · '+snapshot.feedWarning:'');
 }catch(error){root.replaceChildren(node('div','empty',error.message));statusEl.textContent='TIDAK TERSEDIA';statusEl.className='status error';notice.textContent='Tidak ada data yang dipublikasikan. Periksa status worker dan koneksi Redis.';eventCount.textContent=marketCount.textContent=oddsCount.textContent='—';}
 finally{refresh.disabled=false;}
}
refresh.addEventListener('click',load);load();
