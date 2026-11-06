import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://localhost:5432/sb_test',REDIS_URL:'redis://localhost:6379',MEMBER_PROXY_SECRET:'x'.repeat(48),ADMIN_PROXY_SECRET:'y'.repeat(48),OPS_INTERNAL_SECRET:'z'.repeat(48),SESSION_HMAC_KEY:'w'.repeat(48),API_KEY_PEPPER:'v'.repeat(48),MFA_ENCRYPTION_KEY_BASE64:Buffer.alloc(32,9).toString('base64'),SPORTMONKS_ENABLED:'false'});
const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');

function mkt(type, period, line=null){ return {id:`${type}:${period}:${line??''}`, type, period, line, selections:[{key:'h',odds:2.0}]}; }

test('HDP/OU/1X2 B1 termap ke period 1H/type benar (Sharp rows tiruan)', () => {
  const base={event_id:'e1',sport:'soccer',league:'L',home_team:'A',away_team:'B',event_start_time:'2026-11-06T10:00:00Z',is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:'2026-11-06T09:00:00Z',sportsbook:'draftkings'};
  const rows=[
    {...base,market_type:'1st_half_moneyline',market_segment:'1st_half',selection:'A',selection_type:'home',odds_decimal:2.1,line:null},
    {...base,market_type:'1st_half_moneyline',market_segment:'1st_half',selection:'Draw',selection_type:'draw',odds_decimal:2.0,line:null},
    {...base,market_type:'1st_half_moneyline',market_segment:'1st_half',selection:'B',selection_type:'away',odds_decimal:3.2,line:null},
    {...base,market_type:'point_spread',market_segment:'1st_half',selection:'A',selection_type:'home',odds_decimal:1.9,line:-0.5},
    {...base,market_type:'point_spread',market_segment:'1st_half',selection:'B',selection_type:'away',odds_decimal:1.9,line:0.5},
    {...base,market_type:'total_goals',market_segment:'1st_half',selection:'Over',selection_type:'over',odds_decimal:1.85,line:0.5},
    {...base,market_type:'total_goals',market_segment:'1st_half',selection:'Under',selection_type:'under',odds_decimal:1.95,line:0.5},
  ];
  const [ev]=__sportsbookProviders.normalizeSharpApiRows(rows);
  assert.ok(ev);
  const types=ev.markets.map(m=>`${m.type}:${m.period}`).sort();
  assert.ok(types.includes('1X2:1H'));
  assert.ok(types.includes('HANDICAP:1H'));
  assert.ok(types.includes('TOTALS:1H'));
});

test('event tanpa B1 tetap lolos (bukan dibuang karena B1 tidak ada)', () => {
  const base={event_id:'e2',sport:'soccer',league:'L',home_team:'A',away_team:'B',event_start_time:'2026-11-06T10:00:00Z',is_live:false,is_main_line:true,is_alternate_line:false,is_active:true,timestamp:'2026-11-06T09:00:00Z',sportsbook:'draftkings'};
  const rows=[
    {...base,market_type:'moneyline',market_segment:'full_game',selection:'A',selection_type:'home',odds_decimal:2.1,line:null},
    {...base,market_type:'moneyline',market_segment:'full_game',selection:'Draw',selection_type:'draw',odds_decimal:2.0,line:null},
    {...base,market_type:'moneyline',market_segment:'full_game',selection:'B',selection_type:'away',odds_decimal:3.2,line:null},
  ];
  const [ev]=__sportsbookProviders.normalizeSharpApiRows(rows);
  assert.ok(ev);
  assert.ok(ev.markets.some(m=>m.period==='FT'));
  assert.ok(!ev.markets.some(m=>m.period==='1H'));
});

test('capMarketsPerEvent asli menjaga 6 pasar inti, MAX_MARKETS_PER_EVENT, truncatedMarkets benar', async () => {
  const { __sportsbookFeed } = await import('../src/sportsbook-feed.js');
  const MAX = 24; // MAX_MARKETS_PER_EVENT (feed.js)
  const extras=[]; for(let i=0;i<40;i++) extras.push(mkt('OTHER','FT',i));
  const ev={id:'x',markets:[mkt('1X2','FT'),mkt('1X2','1H'),mkt('HANDICAP','FT'),mkt('HANDICAP','1H'),mkt('TOTALS','FT'),mkt('TOTALS','1H'),...extras]};
  const totalBefore = ev.markets.length;
  const [out]=__sportsbookFeed.capMarketsPerEvent([ev]);
  const keys=new Set(out.markets.map(m=>`${m.type}:${m.period}`));
  for(const k of ['1X2:FT','1X2:1H','HANDICAP:FT','HANDICAP:1H','TOTALS:FT','TOTALS:1H']) assert.ok(keys.has(k),'missing '+k);
  assert.equal(out.markets.length, MAX);
  assert.equal(out.marketCount, totalBefore);
  assert.equal(out.truncatedMarkets, totalBefore - MAX);
});
