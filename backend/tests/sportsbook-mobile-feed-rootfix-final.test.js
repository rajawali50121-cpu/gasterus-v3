import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectMemberMarkets } from '../src/sportsbook-member-projection.js';

function selection(key='A',odds=1.9,suspended=false){return {key,label:key,odds,line:null,suspended,priceVersion:'v1',provider:'SHOULD_NOT_LEAK'};}
function market(id,type,period,line,{mainLine=false,suspended=false,odds=1.9}={}){
  return {id,type,period,line,mainLine,suspended,label:`${type} ${period}`,provider:'SHOULD_NOT_LEAK',sourceMarketId:'SECRET',selections:[selection('HOME',odds,suspended),selection('AWAY',odds+0.1,suspended)]};
}

test('member snapshot projection retains every market line and FT/1H variation',()=>{
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
  const projected=projectMemberMarkets(markets);
  assert.equal(projected.length,markets.length);
  const keys=new Set(projected.map(x=>`${x.type}:${x.period}`));
  for(const key of ['1X2:FT','HANDICAP:FT','TOTALS:FT','1X2:1H','HANDICAP:1H','TOTALS:1H']) assert.ok(keys.has(key),`missing ${key}`);
  assert.equal(projected.filter(x=>x.type==='HANDICAP'&&x.period==='FT').length,31);
  assert.equal(projected.filter(x=>x.type==='TOTALS'&&x.period==='FT').length,31);
});


test('member event list and event detail both preserve all available markets',()=>{
  const feed=readFileSync(new URL('../src/sportsbook-feed.js',import.meta.url),'utf8');
  assert.match(feed,/function memberPublicEvent\(event\)[\s\S]*memberEventShape\(item, item\.markets \|\| \[\]\)/);
  assert.match(feed,/function memberPublicEventDetail\(event\)[\s\S]*memberEventShape\(item, item\.markets \|\| \[\]\)/);
  assert.match(feed,/event: applySportsbookTradingControls\(\[memberPublicEventDetail\(current\)\]/);
});

test('FINAL mobile frontend bootstraps REST snapshot and reconnects SSE with bounded backoff',()=>{
  const js=readFileSync(new URL('../../frontend/js/sportsbook.js',import.meta.url),'utf8');
  assert.match(js,/async function loadRestSnapshot\(\{ append = false \} = \{\}\)/);
  assert.match(js,/const payload = normalizeSnapshot\(json\?\.data \|\| json \|\| null\)/);
  assert.match(js,/const accepted = onSnapshot\(payload, \{ generation \}\)/);
  assert.match(js,/offset: String\(append \? nextPageOffset\(currentOffset, pageSize\) : 0\)/);
  assert.match(js,/offset: String\(currentOffset\)/);
  assert.doesNotMatch(js,/streamOffset/);
  assert.match(js,/function onSnapshot\(rawSnapshot, \{ generation = feedViewGeneration \} = \{\}\)/);
  assert.match(js,/shouldApplySnapshot\(feed, snapshot\)/);
  assert.match(js,/let streamActive = false/);
  assert.match(js,/event === 'ready'[\s\S]*streamActive = true;[\s\S]*connectionState\(hasFeedSnapshot, streamActive, feed\.source\?\.status\)/);
  // SSE adalah satu-satunya penulis realtime; REST hanya bootstrap 1x + darurat saat
  // SSE putus. TIDAK ada lagi polling berkala yang menimpa snapshot SSE (akar pola
  // 222↔5 di halaman member). Kontrak anti-hang yang berlaku: reconnect SSE dengan
  // backoff terbatas (tidak pernah retry storm / loop tanpa batas).
  assert.doesNotMatch(js,/setInterval\(\(\) => \{ if \(!streamClosed\) loadRestSnapshot\(\)/);
  assert.match(js,/await loadRestSnapshot\(\);/);
  assert.match(js,/backoff = Math\.min\(backoff \* 1\.6, 15000\)/);
  assert.match(js,/connectStream\(generation\)/);
});
