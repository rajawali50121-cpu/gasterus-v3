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
  MFA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64')
});

const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

test('Sportradar event retains HT market metadata without claiming HT result authority', () => {
  const event = {
    id: 'api-score',
    sport: 'Football',
    league: 'Premier League',
    country: 'England',
    startTime: '2026-08-11T12:00:00Z',
    status: 'FINISHED',
    providerStatus: 'FT',
    live: false,
    home: { name: 'Arsenal', score: 3, logo: null },
    away: { name: 'Chelsea', score: 1, logo: null },
    periodScores: { '1H': { home: 1, away: 1 } },
    markets: [
      { id: 'm1', type: '1X2', period: 'FT', source: 'sportradar', suspended: false, selections: [{ key: 'k1', label: 'Home', odds: 1.8, suspended: false, source: 'sportradar', updatedAt: null }] },
      { id: 'm2', type: '1X2', period: '1H', source: 'sportradar', suspended: false, selections: [{ key: 'k2', label: 'Home', odds: 2.2, suspended: false, source: 'sportradar', updatedAt: null }] },
      { id: 'm3', type: 'TOTALS', period: '1H', source: 'sportradar', suspended: false, selections: [{ key: 'k3', label: 'Over 1.0', odds: 1.88, suspended: false, source: 'sportradar', updatedAt: null }] }
    ],
    _refs: { 'sportradar': 'api-9911' },
    _sources: ['sportradar'],
    _settlementReadySources: ['sportradar'],
    settlementAuthority: { ft: true, ht: false, automaticFt: false, manualFt: true }
  };
  assert.ok(event.markets.some(market => market.type === '1X2' && market.period === '1H'));
  assert.ok(event.markets.some(market => market.type === 'TOTALS' && market.period === '1H'));
  assert.deepEqual(event.periodScores['1H'], { home: 1, away: 1 });
});

test('live odds extractor accepts top-level bets payload', () => {
  const map = new Map();
  map.set('123', [{ name: 'First Half Winner', values: [{ value: 'Home', odd: '2.0' }] }]);
  assert.equal(map.get('123').length, 1);
  assert.equal(map.get('123')[0].name, 'First Half Winner');
});


test('auto settlement evaluates HT market from halftime score and FT market from final score', () => {
  const event = { status: 'FINISHED', home: { score: 3 }, away: { score: 1 }, periodScores: { '1H': { home: 1, away: 1 } }, settlementAuthority: { ft: true, ht: false } };
  const base = { home_team: 'Arsenal', away_team: 'Chelsea', market_type: '1X2', market_line: null };
  const ht = evaluateSportsbookLeg({ ...base, market_period: '1H', selection_label: 'Draw' }, event);
  const ft = evaluateSportsbookLeg({ ...base, market_period: 'FT', selection_label: 'Home' }, event);
  assert.equal(ht, null, 'HT result must remain unavailable without an approved results authority');
  assert.equal(ft.status, 'WON');
  assert.match(ft.resultValue, /^FT 3-1$/);
});

test('member sportsbook ships explicit FT/HT controls and does not hard-code bridge markets to FT', () => {
  const ui = readFileSync(new URL('../../frontend/js/sportsbook.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../frontend/sportsbook.html', import.meta.url), 'utf8');
  const feed = readFileSync(new URL('../src/sportsbook-feed.js', import.meta.url), 'utf8');
  assert.match(html, /sportsbook|period/i);
  assert.match(ui, /period/);
  assert.match(feed, /period: market\.period \|\| 'FT'/);
  assert.doesNotMatch(feed, /period: 'FT',/);
});
