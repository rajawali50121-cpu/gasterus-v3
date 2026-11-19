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

});

const { mergeProviderEvents } = await import('../src/sportsbook-feed-utils.js');
const { eventSettlementAuthority, settlementAuthoritySummary } = await import('../src/sportsbook-settlement-authority.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

function market(period = 'FT', id = `market-${period}`, source = 'sportradar') {
  return {
    id,
    key: `1x2-${period}`,
    type: '1X2',
    label: '1X2',
    period,
    line: null,
    source,
    suspended: false,
    updatedAt: '2026-11-19T00:00:00.000Z',
    selections: [
      { key: `home-${period}`, label: 'Home', odds: 1.91, source, suspended: false },
      { key: `draw-${period}`, label: 'Draw', odds: 3.2, source, suspended: false },
      { key: `away-${period}`, label: 'Away', odds: 4.1, source, suspended: false }
    ]
  };
}

function event({ live = false, status = 'SCHEDULED', markets = [market('FT'), market('1H')] } = {}) {
  return {
    id: 'sr-event-1',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-11-20T19:00:00.000Z',
    status,
    live,
    home: { name: 'Arsenal', score: null, logo: null },
    away: { name: 'Chelsea', score: null, logo: null },
    markets,
    _refs: { sportradar: 'sr:sport_event:123' },
    _sources: ['sportradar'],
    _settlementReadySources: ['sportradar']
  };
}

test('healthy Sportradar prematch FT prices get operator settlement only; HT stays suspended', () => {
  const [merged] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [event()]
  }], { enabled: true });
  assert.deepEqual(merged._settlementReadySources, ['sportradar', 'manual-ops']);
  assert.equal(merged.markets.find(item => item.period === 'FT').suspended, false);
  assert.equal(merged.markets.find(item => item.period === '1H').suspended, true);
  const authority = eventSettlementAuthority(merged);
  assert.equal(authority.ft, true);
  assert.equal(authority.ht, false);
  assert.equal(authority.automaticFt, false);
  assert.equal(authority.manualFt, true);
});

test('manual FT authority cannot unlock HT/FT combo markets without HT authority', () => {
  const htFt = market('HT_FT', 'market-HT_FT');
  htFt.type = 'HT_FT';
  const [merged] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [event({ markets: [market('FT'), htFt] })]
  }], { enabled: true });
  assert.equal(merged.markets.find(item => item.period === 'FT').suspended, false);
  assert.equal(merged.markets.find(item => item.period === 'HT_FT').suspended, true);
});

test('Sportradar odds alone never become an automatic results authority', () => {
  const authority = eventSettlementAuthority({
    _sources: ['sportradar'],
    _settlementReadySources: ['sportradar']
  });
  assert.equal(authority.ft, false);
  assert.equal(authority.ht, false);
  assert.equal(authority.automaticFt, false);
  assert.equal(authority.mode, 'NONE');
});

test('manual FT settlement fallback cannot unlock live markets', () => {
  const [merged] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [event({ live: true, status: 'LIVE' })]
  }], { enabled: true });
  assert.deepEqual(merged._settlementReadySources, ['sportradar']);
  assert.ok(merged.markets.every(item => item.suspended));
});

test('duplicate Sportradar fixture records preserve distinct bookmaker market prices', () => {
  const first = event({ markets: [market('FT', 'market-book-a')] });
  const second = event({ markets: [market('FT', 'market-book-b')] });
  second.markets[0].bookmaker = 'Book B';
  const [merged] = mergeProviderEvents([{
    provider: 'sportradar',
    enabled: true,
    events: [first, second]
  }], { enabled: true });
  assert.equal(merged.markets.length, 2);
});

test('manual settlement cannot fabricate automatic scores or HT authority', () => {
  const ftLeg = { market_period: 'FT', selection_label: 'Home', home_team: 'Arsenal', away_team: 'Chelsea', market_type: '1X2' };
  const htLeg = { market_period: '1H', selection_label: 'Home', home_team: 'Arsenal', away_team: 'Chelsea', market_type: '1X2' };
  const result = { status: 'FINISHED', homeScore: 2, awayScore: 0 };
  const manual = eventSettlementAuthority({
    _sources: ['sportradar', 'manual-ops'],
    _settlementReadySources: ['sportradar', 'manual-ops']
  });
  assert.equal(evaluateSportsbookLeg(ftLeg, { ...result, settlementAuthority: manual }), null, 'manual FT authority cannot be used by automatic settlement');
  assert.equal(evaluateSportsbookLeg(htLeg, { ...result, settlementAuthority: manual }), null);
});

test('settlement summary exposes manual FT but never automatic or HT authority', () => {
  const summary = settlementAuthoritySummary([{
    _sources: ['sportradar', 'manual-ops'],
    _settlementReadySources: ['sportradar', 'manual-ops']
  }]);
  assert.equal(summary.ftEvents, 1);
  assert.equal(summary.htEvents, 0);
  assert.equal(summary.automaticFtEvents, 0);
  assert.equal(summary.manualFtEvents, 1);
});
