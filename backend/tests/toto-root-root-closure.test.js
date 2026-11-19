import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_HIDDEN_TOTO_MARKETS, MEMBER_VISIBLE_TOTO_MARKET_COUNT } from '../src/toto-member-catalog.js';

// Secret statis (DATABASE_URL/REDIS_URL/dll) tidak tersedia pada fase build Railway;
// seed placeholder inert SEBELUM dynamic import modul yang grafnya menyentuh
// config.js (konvensi uji repo - lihat toto-collector.test.js).
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://user:pass@example.com/db',REDIS_URL:'redis://example.com:6379',MEMBER_PROXY_SECRET:'m'.repeat(48),ADMIN_PROXY_SECRET:'a'.repeat(48),OPS_INTERNAL_SECRET:'o'.repeat(48),SESSION_HMAC_KEY:'s'.repeat(48),API_KEY_PEPPER:'p'.repeat(48),7).toString('base64')});
const { parseObservation, MARKET_MAP } = await import('../src/toto-collector-core.js');

test('ROOT closure exposes the canonical TOTO markets to member catalog (VegasNet pools only)',()=>{
  assert.equal(MARKET_MAP.length,45);
  assert.equal(MEMBER_VISIBLE_TOTO_MARKET_COUNT,45);
  assert.equal(MEMBER_HIDDEN_TOTO_MARKETS.size,43);
});

test('ROOT closure snapshot-board finds a global date beyond shallow DOM wrappers',()=>{
  const filler=Array.from({length:48},(_,i)=>`<span>decor-${i}</span>`).join('');
  const html=`<h2>Hasil <span>Terakhir</span></h2>${filler}<div>19 Agustus 2026</div><div>WELLINGTON</div><b>4</b><b>9</b><b>6</b><b>9</b>`;
  const source={code:'cindototo',name:'Cindo',family:'cindototo',parser:'snapshot-board'};
  const o=parseObservation(html,'WELLINGTON',source);
  assert.equal(o?.drawDate,'2026-08-19');
  assert.equal(o?.result,'4969');
});

test('ROOT closure market-card captures close and result schedule in WIB',()=>{
  const html=`<div>Merida Mid</div><strong>8760</strong><div>Result: Rabu, 19 Agustus 2026</div><div>Tutup Pasaran:</div><b>00:30 WIB</b><div>Result Pasaran:</div><b>01:00 WIB</b>`;
  const source={code:'kingkonginfo',name:'Kingkong',family:'kingkongtoto-info.com',parser:'market-card'};
  const o=parseObservation(html,'Merida Mid',source);
  assert.equal(o?.result,'8760');
  assert.equal(o?.drawDate,'2026-08-19');
  assert.equal(o?.closeTime,'00:30:00');
  assert.equal(o?.resultTime,'01:00:00');
  assert.equal(o?.scheduleTimezone,'Asia/Jakarta');
});

test('ROOT closure official source can recover from HTTP failure using bounded rendered page',async()=>{
  Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://user:pass@example.com/db',REDIS_URL:'redis://example.com:6379',MEMBER_PROXY_SECRET:'m'.repeat(48),ADMIN_PROXY_SECRET:'a'.repeat(48),OPS_INTERNAL_SECRET:'o'.repeat(48),SESSION_HMAC_KEY:'s'.repeat(48),API_KEY_PEPPER:'p'.repeat(48),7).toString('base64')});
  const { collectOfficialTotoSources } = await import('../src/toto-official-source.js');
  const fetchImpl=async()=>{throw new Error('HTTP 403')};
  let rendered=0;
  const renderImpl=async source=>{
    rendered+=1;
    if(source.code==='official-singapore') return {...source,ok:true,html:'<div>Wed, 19 Aug 2026 | Draw No. 9999</div><div>1st Prize | 1234</div>',bytes:100,renderer:'TEST_RENDER'};
    return {...source,ok:false,html:'',error:'render unavailable'};
  };
  const results=await collectOfficialTotoSources(fetchImpl,renderImpl);
  assert.ok(rendered>=1);
  const sg=results.find(x=>x.code==='official-singapore');
  assert.equal(sg.ok,true);
  assert.equal(sg.parsedMarkets,1);
  assert.equal(sg.observations[0].slug,'singapore-pool');
  assert.equal(sg.observations[0].result,'1234');
});
