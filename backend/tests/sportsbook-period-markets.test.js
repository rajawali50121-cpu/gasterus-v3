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

const { __sportsbookProviders } = await import('../src/sportsbook-providers.js');
const { evaluateSportsbookLeg } = await import('../src/sportsbook-result-evaluator.js');

test('provider merger keeps HT priced market bettable only when API-Sports result source is attached', () => {
  const oddsEvent = {
    id: 'odds-safety', sport: 'Football', league: 'Premier League', country: 'England', startTime: '2026-08-11T12:00:00Z', status: 'SCHEDULED', live: false,
    home: { name: 'Arsenal', score: null, logo: null }, away: { name: 'Chelsea', score: null, logo: null },
    markets: [{ id: 'm', type: '1X2', period: '1H', source: 'book-a', suspended: true, selections: [{ key: 'k', label: 'Home', odds: 2.2, suspended: false, source: 'book-a', updatedAt: null }] }],
    _refs: {}, _sources: ['sharpapi']
  };
  const withoutScoreProvider = __sportsbookProviders.mergeProviderEvents([{ events: [oddsEvent] }]);
  assert.equal(withoutScoreProvider[0].markets[0].suspended, true);

  const apiEvent = __sportsbookProviders.normalizeApiSportsFixture({
    fixture: { id: 9911, date: '2026-08-11T12:00:00Z', status: { short: 'NS' } },
    league: { name: 'Premier League', country: 'England' },
    teams: { home: { name: 'Arsenal' }, away: { name: 'Chelsea' } }, goals: { home: null, away: null }, score: { halftime: { home: null, away: null } }
  });
  const withScoreProvider = __sportsbookProviders.mergeProviderEvents([{ events: [oddsEvent] }, { events: [apiEvent] }]);
  assert.equal(withScoreProvider[0].markets[0].suspended, false);
  assert.ok(withScoreProvider[0]._sources.includes('api-sports'));
});

test('auto settlement evaluates HT market from halftime score and FT market from final score', () => {
  const event = { status: 'FINISHED', home: { score: 3 }, away: { score: 1 }, periodScores: { '1H': { home: 1, away: 1 } } };
  const base = { home_team: 'Arsenal', away_team: 'Chelsea', market_type: '1X2', market_line: null };
  const ht = evaluateSportsbookLeg({ ...base, market_period: '1H', selection_label: 'Draw' }, event);
  const ft = evaluateSportsbookLeg({ ...base, market_period: 'FT', selection_label: 'Home' }, event);
  assert.equal(ht.status, 'WON');
  assert.match(ht.resultValue, /^HT 1-1$/);
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
