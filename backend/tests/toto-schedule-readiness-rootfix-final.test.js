import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Secret statis (DATABASE_URL/REDIS_URL/dll) tidak tersedia pada fase build Railway;
// seed placeholder inert SEBELUM dynamic import modul yang grafnya menyentuh
// config.js (konvensi uji repo - lihat toto-collector.test.js).
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://user:pass@example.com/db',REDIS_URL:'redis://example.com:6379',MEMBER_PROXY_SECRET:'m'.repeat(48),ADMIN_PROXY_SECRET:'a'.repeat(48),OPS_INTERNAL_SECRET:'o'.repeat(48),SESSION_HMAC_KEY:'s'.repeat(48),API_KEY_PEPPER:'p'.repeat(48),7).toString('base64')});
const { resolveDecision, scheduleEvidence } = await import('../src/toto-collector-core.js');

const htmlA=`<div>Merida Mid</div><strong>3311</strong><div>Result: Rabu, 19 Agustus 2026</div><div>Tutup Pasaran:</div><b>00:30 WIB</b><div>Result Pasaran:</div><b>01:00 WIB</b>`;
const htmlB=`<section><h3>Merida Mid</h3><span>3311</span><p>Result: Rabu, 19 Agustus 2026</p><p>Tutup Pasaran: 00:30 WIB</p><p>Result Pasaran: 01:00 WIB</p></section>`;

test('FINAL TOTO schedule evidence requires distinct source-family quorum',()=>{
  const mapping={slug:'merida-mid-pool',name:'Merida Mid',sources:{a:['Merida Mid'],b:['Merida Mid']}};
  const decision=resolveDecision(mapping,[
    {code:'a',name:'Board A',family:'family-a',ok:true,parser:'market-card',html:htmlA},
    {code:'b',name:'Board B',family:'family-b',ok:true,parser:'market-card',html:htmlB}
  ]);
  assert.equal(decision.status,'VERIFIED');
  assert.equal(decision.schedule?.status,'VERIFIED');
  assert.equal(decision.schedule?.closeTime,'00:30:00');
  assert.equal(decision.schedule?.resultTime,'01:00:00');
  assert.equal(decision.schedule?.timezone,'Asia/Jakarta');
  assert.equal(decision.schedule?.sourceFamilies.length,2);
});

test('FINAL TOTO one schedule source stays OBSERVED and is never promoted to schedule quorum',()=>{
  const evidence=scheduleEvidence([{source:'a',sourceName:'A',sourceFamily:'one-family',result:'3311',drawDate:'2026-08-19',closeTime:'00:30:00',resultTime:'01:00:00',scheduleTimezone:'Asia/Jakarta'}],{result:'3311',drawDate:'2026-08-19'});
  assert.equal(evidence.status,'OBSERVED');
  assert.equal(evidence.sourceFamilies.length,1);
});

test('FINAL TOTO collector preserves schedule evidence but does not fabricate OPEN windows',()=>{
  const collector=readFileSync(new URL('../src/toto-collector.js',import.meta.url),'utf8');
  assert.match(collector,/schedule: consensusDecisions\[index\]\?\.schedule \|\| null/);
  assert.match(collector,/scheduleReadiness/);
  assert.doesNotMatch(collector,/SET betting_status='OPEN'/);
  assert.doesNotMatch(collector,/betting_status='OPEN',betting_period/);
});

test('FINAL TOTO member readiness exposes the exact blocking reason instead of generic failure',()=>{
  const markets=readFileSync(new URL('../src/markets.js',import.meta.url),'utf8');
  const member=readFileSync(new URL('../../frontend/js/market-play.js',import.meta.url),'utf8');
  assert.match(markets,/function bettingReadinessReason/);
  for(const code of ['RESULT_AUTHORITY_NOT_READY','BETTING_NOT_OPEN','BETTING_PERIOD_NOT_READY','BETTING_CLOSE_NOT_READY','BETTING_CLOSED']) assert.match(markets,new RegExp(code));
  assert.match(member,/bettingStatus|bettingReady|readinessReason/);
});
