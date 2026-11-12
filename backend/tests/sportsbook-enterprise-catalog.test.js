import test from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV:'test', DATABASE_URL:'postgresql://u:p@example.com/db', REDIS_URL:'redis://example.com:6379',
  MEMBER_PROXY_SECRET:'m'.repeat(48), ADMIN_PROXY_SECRET:'a'.repeat(48), OPS_INTERNAL_SECRET:'o'.repeat(48),
  SESSION_HMAC_KEY:'s'.repeat(48), API_KEY_PEPPER:'p'.repeat(48), MFA_ENCRYPTION_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),
  SHARP_API_PREFERRED_SPORTSBOOKS:'sbobet,pinnacle,bet365', SPORTSBOOK_ARTWORK_ENABLED:'true', SPORTSBOOK_ARTWORK_API_KEY:'123'
});
const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { enrichTeamArtwork, __teamArtwork } = await import('../src/sportsbook-team-artwork.js');

test('R6.9.0.14 prefers SBOBET when available and preserves broad soccer markets', () => {
  const base={event_id:'e1',event_uuid:'e1',sport:'soccer',league:'EPL',home_team:'Arsenal',away_team:'Chelsea',event_start_time:'2026-08-20T12:00:00Z',is_live:false,is_active:true,timestamp:'2026-08-17T10:00:00Z'};
  const rows=[];
  const add=(sportsbook,market_type,selection_type,selection,odds,line=null,market_name='')=>rows.push({...base,sportsbook,market_type,selection_type,selection,odds_decimal:odds,line,market_name});
  for(const book of ['pinnacle','sbobet']) { add(book,'moneyline_3way','home','Arsenal',1.9); add(book,'moneyline_3way','draw','Draw',3.4); add(book,'moneyline_3way','away','Chelsea',4.2); }
  add('sbobet','asian_handicap','home','Arsenal',1.91,-0.5); add('sbobet','asian_handicap','away','Chelsea',1.95,0.5);
  add('sbobet','goals_over_under','over','Over',1.9,2.5); add('sbobet','goals_over_under','under','Under',1.92,2.5);
  add('sbobet','both_teams_score','yes','Yes',1.8,null,'Both Teams To Score'); add('sbobet','both_teams_score','no','No',2.0,null,'Both Teams To Score');
  add('sbobet','double_chance','home_draw','1X',1.25); add('sbobet','double_chance','away_draw','X2',1.8); add('sbobet','double_chance','home_away','12',1.35);
  add('sbobet','draw_no_bet','home','Arsenal',1.4); add('sbobet','draw_no_bet','away','Chelsea',2.7);
  const [event]=__sportsbookProviders.normalizeSharpApiRows(rows);
  assert.ok(event._refs.sharpapiSportsbook.includes('sbobet'), 'SBOBET included');
  assert.ok(event._refs.sharpapiSportsbook.includes('pinnacle'), 'Pinnacle included');
  const types=new Set(event.markets.map(m=>m.type));
  for(const expected of ['1X2','HANDICAP','TOTALS','BTTS','DOUBLE_CHANCE','DRAW_NO_BET']) assert.ok(types.has(expected), expected);
});

test('R6.9.0.14 artwork enrichment attaches real provider crest metadata without affecting markets', async () => {
  __teamArtwork.cache.clear();
  const original=globalThis.fetch;
  globalThis.fetch=async url => ({ok:true,json:async()=>({teams:[{idTeam:'133604',strTeam:'Arsenal',strSport:'Soccer',strBadge:'https://img.example/arsenal.png',strCountry:'England'}]})});
  try {
    const events=[{id:'x',home:{name:'Arsenal',logo:null},away:{name:'Unknown United',logo:'https://existing/logo.png'},markets:[{id:'m'}],_refs:{},country:null}];
    const [event]=await enrichTeamArtwork(events);
    assert.equal(event.home.logo,'https://img.example/arsenal.png');
    assert.equal(event.away.logo,'https://existing/logo.png');
    assert.equal(event._refs['thesportsdb:home'],'133604');
    assert.equal(event.country,'England');
    assert.equal(event.markets.length,1);
  } finally { globalThis.fetch=original; }
});

test('artwork cache is bounded: expired and oldest entries are pruned, recent survive', () => {
  __teamArtwork.cache.clear();
  const now = Date.now();
  const max = __teamArtwork.MAX_CACHE_ENTRIES;
  // 1 entri basi (sudah expired) + max entri hidup
  __teamArtwork.rememberEntry('stale team', { logo: 'old' }, -1, now - 100_000);
  for (let i = 0; i < max; i++) __teamArtwork.rememberEntry(`team ${i}`, { logo: `l${i}` }, 3_600_000, now);
  __teamArtwork.rememberEntry('freshest team', { logo: 'fresh' }, 3_600_000, now);
  assert.ok(__teamArtwork.cache.size <= max, `cache must stay bounded, got ${__teamArtwork.cache.size}`);
  assert.equal(__teamArtwork.cache.has('stale team'), false, 'expired entry must be pruned first');
  assert.equal(__teamArtwork.cache.get('freshest team').value.logo, 'fresh', 'newest entry must survive');
  assert.equal(__teamArtwork.cache.get('team 0'), undefined, 'oldest live entry is evicted before newest');
  __teamArtwork.cache.clear();
});

test('R6.9.0.14 artwork lookup failure never blocks sportsbook odds', async () => {
  __teamArtwork.cache.clear();
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('network blocked')};
  try {
    const events=[{id:'x',home:{name:'A',logo:null},away:{name:'B',logo:null},markets:[{id:'m',selections:[{odds:1.9}]}],_refs:{}}];
    const [event]=await enrichTeamArtwork(events);
    assert.equal(event.home.logo,null);
    assert.equal(event.markets[0].selections[0].odds,1.9);
  } finally { globalThis.fetch=original; }
});
