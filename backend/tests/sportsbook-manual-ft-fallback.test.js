import test from 'node:test';
import assert from 'node:assert/strict';

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
  SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED: 'false'
});

const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { eventSettlementAuthority, settlementAuthoritySummary } = await import('../src/sportsbook-settlement-authority.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

function sharpRows({ live = false } = {}) {
  const base = {
    event_id: live ? 'sharp-live-manual' : 'sharp-pre-manual', sport: 'soccer', league: 'epl',
    home_team: 'Arsenal', away_team: 'Chelsea', event_start_time: '2026-08-18T19:00:00Z',
    sportsbook: 'book-a', is_main_line: true, is_active: true, is_live: live
  };
  return [
    { ...base, id:'ft-h', market_type:'moneyline', market_segment:'full_game', selection:'Arsenal', selection_type:'home', odds_decimal:1.9 },
    { ...base, id:'ft-d', market_type:'moneyline', market_segment:'full_game', selection:'Draw', selection_type:'draw', odds_decimal:3.4 },
    { ...base, id:'ft-a', market_type:'moneyline', market_segment:'full_game', selection:'Chelsea', selection_type:'away', odds_decimal:4.1 },
    { ...base, id:'ht-h', market_type:'1st_half', market_segment:'1st_half', selection:'Arsenal', selection_type:'home', odds_decimal:2.2 },
    { ...base, id:'ht-d', market_type:'1st_half', market_segment:'1st_half', selection:'Draw', selection_type:'draw', odds_decimal:2.0 },
    { ...base, id:'ht-a', market_type:'1st_half', market_segment:'1st_half', selection:'Chelsea', selection_type:'away', odds_decimal:4.0 }
  ];
}

function healthySharpEvent(options = {}) {
  const event = __sportsbookProviders.normalizeSharpApiRows(sharpRows(options))[0];
  event._settlementReadySources = ['sharpapi'];
  return event;
}

test('R6.9.0.12 healthy prematch SharpAPI prices get explicit manual FT settlement guarantee', () => {
  const [event] = __sportsbookProviders.mergeProviderEvents(
    [{ provider:'sharpapi', events:[healthySharpEvent()] }],
    { enabled: true }
  );
  assert.ok(event._settlementReadySources.includes('manual-ops'));
  assert.equal(event._settlementMode, 'MANUAL_FT_FALLBACK');
  assert.ok(event.markets.some(market => market.period === 'FT' && !market.suspended));
  assert.ok(event.markets.filter(market => market.period === '1H').every(market => market.suspended));

  const authority = eventSettlementAuthority(event);
  assert.equal(authority.ft, true);
  assert.equal(authority.ht, false);
  assert.equal(authority.automaticFt, false);
  assert.equal(authority.manualFt, true);
  assert.equal(authority.mode, 'MANUAL_FALLBACK');
});

test('R6.9.0.12 manual FT fallback never unlocks SharpAPI-only live betting', () => {
  const [event] = __sportsbookProviders.mergeProviderEvents(
    [{ provider:'sharpapi', events:[healthySharpEvent({ live:true })] }],
    { enabled: true }
  );
  assert.ok(!event._settlementReadySources.includes('manual-ops'));
  assert.ok(event.markets.every(market => market.suspended));
  const authority = eventSettlementAuthority(event);
  assert.equal(authority.ft, false);
  assert.equal(authority.ht, false);
});

test('R6.9.0.12 manual guarantee cannot fabricate an automatic score/result', () => {
  const event = {
    id:'manual-result-guard', status:'SCHEDULED', providerStatus:'NS', live:false,
    home:{name:'Arsenal',score:null}, away:{name:'Chelsea',score:null}, periodScores:{},
    settlementAuthority:{ft:true,ht:false,manualFt:true,mode:'MANUAL_FALLBACK',sources:['sharpapi','manual-ops']}
  };
  const leg = { market_period:'FT', market_type:'1X2', selection_label:'Arsenal', home_team:'Arsenal', away_team:'Chelsea', market_line:null };
  assert.equal(evaluateSportsbookLeg(leg, event), null);
});

test('R6.9.0.12 settlement summary distinguishes automatic and manual FT authority', () => {
  const summary = settlementAuthoritySummary([
    {_settlementReadySources:['sharpapi','manual-ops']},
    {_settlementReadySources:['public-market']},
    {_settlementReadySources:['sharpapi']}
  ]);
  assert.equal(summary.ftEvents, 2);
  assert.equal(summary.automaticFtEvents, 1);
  assert.equal(summary.manualFtEvents, 1);
  assert.deepEqual(new Set(summary.modes), new Set(['MANUAL_FALLBACK','AUTOMATIC']));
});
