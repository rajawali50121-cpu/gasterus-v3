import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compactMemberMarkets, paginateMemberEvents, projectMemberMarkets } from '../src/sportsbook-member-projection.js';

function selection(key='A',odds=1.9,suspended=false){return {key,label:key,odds,line:null,suspended,priceVersion:'v1',provider:'SHOULD_NOT_LEAK'};}
function market(id,type,period,line,{mainLine=false,suspended=false,odds=1.9}={}){
  return {id,type,period,line,mainLine,suspended,label:`${type} ${period}`,provider:'SHOULD_NOT_LEAK',sourceMarketId:'SECRET',selections:[selection('HOME',odds,suspended),selection('AWAY',odds+0.1,suspended)]};
}

test('member sportsbook list projection preserves every market and line',()=>{
  const markets=[];
  markets.push(market('1x2-ft','1X2','FT',null,{mainLine:true}));
  markets.push(market('1x2-1h','1X2','1H',null,{mainLine:true}));
  for(let i=-15;i<=15;i+=1){
    markets.push(market(`h-ft-${i}`,'HANDICAP','FT',i/4,{mainLine:i===0}));
    markets.push(market(`t-ft-${i}`,'TOTALS','FT',2.5+i/4,{mainLine:i===0}));
    markets.push(market(`h-1h-${i}`,'HANDICAP','1H',i/4,{mainLine:i===0}));
    markets.push(market(`t-1h-${i}`,'TOTALS','1H',1.5+i/4,{mainLine:i===0}));
  }
  for(const type of ['BTTS','DOUBLE_CHANCE','DRAW_NO_BET','TEAM_TOTAL','ODD_EVEN','HT_FT','CORRECT_SCORE','BET_BUILDER']) markets.push(market(type,type,'FT',null,{mainLine:true}));
  const projected=compactMemberMarkets(markets);
  assert.equal(projected.length,markets.length);
  assert.deepEqual(projected.map(x=>x.id),markets.map(x=>x.id));
  assert.equal(projected.filter(x=>x.type==='HANDICAP'&&x.period==='FT').length,31);
  assert.equal(projected.filter(x=>x.type==='TOTALS'&&x.period==='FT').length,31);
});

test('member event pagination uses stable 30-event cursors without skips or duplicates',()=>{
  const events=Array.from({length:67},(_,i)=>({id:String(i).padStart(3,'0'),startTime:new Date(Date.UTC(2026,0,1,0,i)).toISOString()}));
  const pages=[];
  let cursor='';
  do {
    const page=paginateMemberEvents(events,{cursor,revision:'feed-r1',filters:{sport:'Football',q:'alpha'}});
    pages.push(page.events);
    cursor=page.nextCursor||'';
  } while(cursor);
  const flattened=pages.flat();
  assert.deepEqual(pages.map(page=>page.length),[30,30,7]);
  assert.equal(new Set(flattened.map(event=>event.id)).size,events.length);
  assert.deepEqual(flattened.map(event=>event.id),events.map(event=>event.id));
  const first=paginateMemberEvents(events,{revision:'feed-r1',filters:{sport:'Football',q:'alpha'}});
  assert.throws(()=>paginateMemberEvents(events,{cursor:first.nextCursor,revision:'feed-r2',filters:{sport:'Football',q:'alpha'}}),error=>error.code==='SPORTSBOOK_CURSOR_STALE');
  assert.throws(()=>paginateMemberEvents(events,{cursor:first.nextCursor,revision:'feed-r1',filters:{sport:'Tennis',q:'alpha'}}),error=>error.code==='SPORTSBOOK_CURSOR_INVALID');
});

test('FINAL mobile member market projection strips provider/source telemetry',()=>{
  const output=projectMemberMarkets([market('m1','1X2','FT',null,{mainLine:true})]);
  assert.equal(output.length,1);
  assert.equal('provider' in output[0],false);
  assert.equal('sourceMarketId' in output[0],false);
  assert.equal('provider' in output[0].selections[0],false);
  assert.deepEqual(Object.keys(output[0].selections[0]).sort(),['key','label','line','odds','priceVersion','suspended'].sort());
});

test('member sportsbook list and event detail both retain all provider markets',()=>{
  const feed=readFileSync(new URL('../src/sportsbook-feed.js',import.meta.url),'utf8');
  assert.match(feed,/function memberPublicEvent\(event\)[\s\S]*compactMemberMarkets\(item\.markets \|\| \[\]\)/);
  assert.match(feed,/function memberPublicEventDetail\(event\)[\s\S]*memberEventShape\(item, item\.markets \|\| \[\]\)/);
  assert.match(feed,/event: applySportsbookTradingControls\(\[memberPublicEventDetail\(current\)\]/);
});

test('FINAL mobile frontend bootstraps REST snapshot and reconnects SSE with bounded backoff',()=>{
  const js=readFileSync(new URL('../../frontend/js/sportsbook.js',import.meta.url),'utf8');
  assert.match(js,/async function loadRestSnapshot\(\)/);
  // SSE adalah satu-satunya penulis realtime; REST hanya bootstrap 1x + darurat saat
  // SSE putus. TIDAK ada lagi polling berkala yang menimpa snapshot SSE (akar pola
  // 222↔5 di halaman member). Kontrak anti-hang yang berlaku: reconnect SSE dengan
  // backoff terbatas (tidak pernah retry storm / loop tanpa batas).
  assert.doesNotMatch(js,/setInterval\(\(\) => \{ if \(!streamClosed\) loadRestSnapshot\(\)/);
  assert.match(js,/await loadRestSnapshot\(\);/);
  assert.match(js,/backoff = Math\.min\(backoff \* 1\.6, 15000\)/);
  assert.match(js,/connectStream\(\)/);
  assert.match(js,/async function loadMoreEvents\(\)/);
  assert.match(js,/sb-load-more/);
  assert.match(js,/function renderAccordionMarketRows\(e\)\s*\{[\s\S]*\(e\.markets \|\| \[\]\)/);
  assert.match(js,/m\.suspended \|\| !s/);
  assert.doesNotMatch(js,/Jumlah Tendangan Sudut - Handicap Babak Penuh/);
});
