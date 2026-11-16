import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@example.com/db',
  REDIS_URL: 'redis://example.com:6379',
  MEMBER_PROXY_SECRET: 'm'.repeat(48),
  ADMIN_PROXY_SECRET: 'a'.repeat(48),
  OPS_INTERNAL_SECRET: 'o'.repeat(48),
  SESSION_HMAC_KEY: 's'.repeat(48),
  API_KEY_PEPPER: 'p'.repeat(48),
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
  SHARP_API_MAIN_LINES_ONLY: 'false'
});

const { __sportsbookTradingPolicy, sportsbookTradingScopeKey } = await import('../src/sportsbook-trading-policy.js');
const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');

test('HF6 Phase 2 trading policy inherits event/market/selection stops and strictest stake', () => {
  const controls = [
    { id:'1', scopeKey:'EVENT:e1', scopeType:'EVENT', eventId:'e1', marketId:null, selectionId:null, suspended:false, maxStake:50000, maxLiability:900000, version:2 },
    { id:'2', scopeKey:'MARKET:e1:m1', scopeType:'MARKET', eventId:'e1', marketId:'m1', selectionId:null, suspended:false, maxStake:25000, maxLiability:400000, version:3 },
    { id:'3', scopeKey:'SELECTION:e1:m1:s1', scopeType:'SELECTION', eventId:'e1', marketId:'m1', selectionId:'s1', suspended:true, maxStake:10000, maxLiability:120000, version:4 }
  ];
  const policy = __sportsbookTradingPolicy.tradingPolicyFromControls(controls,{eventId:'e1',marketId:'m1',selectionId:'s1'});
  assert.equal(policy.suspended,true);
  assert.equal(policy.maxStake,10000);
  assert.equal(policy.eventMaxLiability,900000);
  assert.equal(policy.marketMaxLiability,400000);
  assert.equal(policy.selectionMaxLiability,120000);
  assert.match(policy.versionToken,/EVENT:e1@2/);
  assert.match(policy.versionToken,/SELECTION:e1:m1:s1@4/);
});

test('HF6 Phase 2 scope keys are deterministic and reject malformed scope', () => {
  assert.equal(sportsbookTradingScopeKey({scopeType:'EVENT',eventId:'e1'}),'EVENT:e1');
  assert.equal(sportsbookTradingScopeKey({scopeType:'MARKET',eventId:'e1',marketId:'m1'}),'MARKET:e1:m1');
  assert.equal(sportsbookTradingScopeKey({scopeType:'SELECTION',eventId:'e1',marketId:'m1',selectionId:'s1'}),'SELECTION:e1:m1:s1');
  assert.throws(()=>sportsbookTradingScopeKey({scopeType:'MARKET',eventId:'e1'}),error=>error.code==='SPORTSBOOK_TRADING_SCOPE_INVALID');
});

test('HF6 Phase 2 operator stop overlays member-visible market without inventing prices', () => {
  const events=[{id:'e1',markets:[{id:'m1',suspended:false,selections:[{key:'s1',odds:1.91,suspended:false},{key:'s2',odds:1.95,suspended:false}]}]}];
  const controls=[{id:'1',scopeKey:'SELECTION:e1:m1:s1',scopeType:'SELECTION',eventId:'e1',marketId:'m1',selectionId:'s1',suspended:true,maxStake:null,maxLiability:null,version:1}];
  const [event]=__sportsbookTradingPolicy.applySportsbookTradingControls(events,controls);
  assert.equal(event.markets[0].selections[0].suspended,true);
  assert.equal(event.markets[0].selections[0].odds,1.91);
  assert.equal(event.markets[0].selections[1].suspended,false);
});

test('HF6 Phase 2 acceptance path enforces operator controls before ledger debit', () => {
  const betting=readFileSync(new URL('../src/sportsbook-betting.js',import.meta.url),'utf8');
  const feed=readFileSync(new URL('../src/sportsbook-feed.js',import.meta.url),'utf8');
  const migration=readFileSync(new URL('../migrations/012_sportsbook_trading_controls.sql',import.meta.url),'utf8');
  assert.match(feed,/SPORTSBOOK_OPERATOR_SUSPENDED/);
  assert.match(betting,/assertTradingStakeLimit\(freshLegs, calculation\.totalStake\)/);
  assert.ok(betting.indexOf('assertTradingStakeLimit(freshLegs') < betting.indexOf('postTransfer(client'), 'final trading control gate must run before wallet debit');
  assert.match(betting,/eventMaxLiability/);
  assert.match(betting,/marketMaxLiability/);
  assert.match(betting,/selectionMaxLiability/);
  assert.match(migration,/sportsbook_trading_control_history/);
  assert.match(migration,/scope_type IN \('EVENT','MARKET','SELECTION'\)/);
});
